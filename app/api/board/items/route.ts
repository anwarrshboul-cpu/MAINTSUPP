import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  itemActivity,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
} from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { nextReference, resolveBoard } from "../../../lib/board-registry";
import { getColumnType, normaliseCellValue } from "../../../lib/column-types";
import { chunkIds, selectInChunks } from "../../../lib/sql-batching";

export const dynamic = "force-dynamic";

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  // Every catch in this route funnelled into a bare 503 with no trace of what
  // failed, which is how a missing table survived to "verified". The message
  // stays generic for the caller; the cause goes to the log.
  if (error) console.error("[/api/board/items]", error);
  return Response.json({ error: "Board items are temporarily unavailable." }, { status: 503 });
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function recordActivity(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  boardKey: string,
  requestId: string,
  actorName: string,
  action: string,
  columnKey?: string,
  before?: string | null,
  after?: string | null,
) {
  await db.insert(itemActivity).values({
    id: newId("act"),
    organisationId: orgId,
    boardId: boardKey,
    requestId,
    actorName,
    action,
    columnKey: columnKey ?? null,
    valueBefore: before ?? null,
    valueAfter: after ?? null,
  });
}

/** GET /api/board/items — items for a board, grouped, with their cells. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const board = await resolveBoard(db, orgId, url.searchParams.get("board") ?? undefined);
    const includeArchived = url.searchParams.get("archived") === "true";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const cursor = Number(url.searchParams.get("cursor")) || 0;

    const conditions = [
      eq(maintenanceRequests.organisationId, orgId),
      /*
       * Stage 23. Archived and deleted are different states and this is the one
       * read that already knew it: `?archived=true` deliberately widens the
       * first filter, and must NOT widen this one. Archiving is reversible from
       * the Archive screen and the row is still on the board; a binned job is
       * off the board entirely and comes back through Trash.
       */
      isNull(maintenanceRequests.deletedAt),
    ];
    if (!includeArchived) conditions.push(eq(maintenanceRequests.archived, false));

    const rows = await db
      .select()
      .from(maintenanceRequests)
      .where(and(...conditions))
      .orderBy(asc(maintenanceRequests.createdAt))
      .limit(limit)
      .offset(cursor);

    const ids = rows.map((row) => row.id);

    // Chunked: one `IN` list of 500 ids exceeds D1's bound-variable limit, and
    // this route defaults to a 100-item page with a 500 maximum.
    const cells = await selectInChunks(ids, (chunk) =>
      db
        .select()
        .from(maintenanceBoardCells)
        .where(
          and(
            eq(maintenanceBoardCells.organisationId, orgId),
            inArray(maintenanceBoardCells.requestId, chunk),
          ),
        ),
    );

    const placements = await selectInChunks(ids, (chunk) =>
      db
        .select()
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            inArray(maintenanceGroupItems.requestId, chunk),
          ),
        ),
    );

    const cellsByItem = new Map<string, Record<string, string>>();
    for (const cell of cells) {
      const bucket = cellsByItem.get(cell.requestId) ?? {};
      bucket[cell.columnId] = cell.value;
      cellsByItem.set(cell.requestId, bucket);
    }
    const groupByItem = new Map(placements.map((p) => [p.requestId, p.groupId]));

    return Response.json({
      board,
      items: rows.map((row) => ({
        id: row.id,
        reference: row.reference,
        title: row.title,
        parentId: row.parentId,
        archived: row.archived,
        groupId: groupByItem.get(row.id) ?? null,
        status: row.status,
        priority: row.priority,
        // Fields the alternative views need. Kanban groups by status, calendar
        // needs dates, chart needs category and cost, gallery needs counts.
        siteId: row.siteId,
        category: row.category,
        engineer: row.engineer,
        tier: row.tier,
        contractor: row.contractor,
        assignee: row.assignee,
        requestedAt: row.requestedAt,
        dueAt: row.dueAt,
        completedAt: row.completedAt,
        nextUpdateAt: row.nextUpdateAt,
        cost: row.cost,
        attachmentCount: row.attachmentCount,
        commentCount: row.commentCount,
        cells: cellsByItem.get(row.id) ?? {},
      })),
      nextCursor: rows.length === limit ? cursor + limit : null,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/board/items — create, duplicate, or add a sub-item. O5, O9, O11. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const body = await request.json().catch(() => ({}));
    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);
    const who = actor.displayName || "Workspace";

    // O9 — duplicate an existing item.
    if (body.intent === "duplicate") {
      const sourceId = text(body.id, 64);
      const [source] = await db
        .select()
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, sourceId),
            eq(maintenanceRequests.organisationId, orgId),
            // Stage 23 — a job in the bin cannot be duplicated. Restore it first.
            isNull(maintenanceRequests.deletedAt),
          ),
        );
      if (!source) return bad("Item not found.", 404);

      const id = newId("req");
      const reference = await nextReference(db, orgId, board.id);
      await db.insert(maintenanceRequests).values({
        ...source,
        id,
        reference,
        title: `${source.title} (copy)`,
        archived: false,
        archivedAt: null,
        // Evidence is never copied — a duplicated job must earn its own photos.
        attachmentCount: 0,
        issueAttachmentCount: 0,
        completedAttachmentCount: 0,
        generalAttachmentCount: 0,
        commentCount: 0,
        publicUploadTokenHash: null,
        publicUploadTokenExpiresAt: null,
      });

      if (body.includeCells !== false) {
        const cells = await db
          .select()
          .from(maintenanceBoardCells)
          .where(
            and(
              eq(maintenanceBoardCells.organisationId, orgId),
              eq(maintenanceBoardCells.requestId, sourceId),
            ),
          );
        for (const cell of cells) {
          await db.insert(maintenanceBoardCells).values({
            ...cell,
            id: newId("cell"),
            requestId: id,
          });
        }
      }

      const [placement] = await db
        .select()
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            eq(maintenanceGroupItems.requestId, sourceId),
          ),
        );
      if (placement) {
        await db.insert(maintenanceGroupItems).values({
          ...placement,
          requestId: id,
        });
      }

      await recordActivity(db, orgId, board.key, id, who, "duplicated", undefined, sourceId, id);
      return Response.json({ id, reference }, { status: 201 });
    }

    const title = text(body.title, 200);
    if (!title) return bad("A job title is required.");

    // A job always belongs to a site — reporting, compliance and the site
    // detail page all depend on it, so an unassigned job is not allowed.
    const siteId = text(body.siteId, 64);
    if (!siteId) return bad("A site is required.");

    const groupId = text(body.groupId, 64);
    if (groupId) {
      const [group] = await db
        .select({ id: maintenanceGroups.id })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
            // Stage 23 — nothing may be filed into a group that is in the bin.
            isNull(maintenanceGroups.deletedAt),
          ),
        );
      if (!group) return bad("Group not found.", 404);
    }

    // O11 — a sub-item is a request whose parent is another request.
    const parentId = text(body.parentId, 64) || null;
    if (parentId) {
      const [parent] = await db
        .select({ id: maintenanceRequests.id })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, parentId),
            eq(maintenanceRequests.organisationId, orgId),
            // Stage 23 — no new sub-items under a job that is in the bin.
            isNull(maintenanceRequests.deletedAt),
          ),
        );
      if (!parent) return bad("Parent item not found.", 404);
    }

    const id = newId("req");
    const reference = await nextReference(db, orgId, board.id);

    await db.insert(maintenanceRequests).values({
      id,
      organisationId: orgId,
      reference,
      title,
      parentId,
      description: text(body.description, 4000),
      siteId,
      source: "board",
      status: text(body.status, 80) || "Pending Approval",
      priority: text(body.priority, 40) || "Medium",
      stage: "Incoming",
      // Non-null columns inherited from the original request table. They are
      // filled in through the board's own cells once the item exists.
      category: text(body.category, 80),
      location: text(body.location, 240),
      requester: text(body.requester, 120),
      contact: text(body.contact, 40),
      engineer: text(body.engineer, 80),
    });

    if (groupId) {
      const [tail] = await db
        .select({ maxPosition: sql<number>`COALESCE(MAX(${maintenanceGroupItems.position}), -1)` })
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            eq(maintenanceGroupItems.groupId, groupId),
          ),
        );
      await db.insert(maintenanceGroupItems).values({
        requestId: id,
        organisationId: orgId,
        boardId: board.key,
        groupId,
        position: Number(tail?.maxPosition ?? -1) + 1,
      });
    }

    await recordActivity(db, orgId, board.key, id, who, "created");

    // The full row, not just its id. A caller that has just created an item —
    // the subitem editor, for one — has to render it immediately, and three
    // fields is not enough to draw a row without refetching the whole board.
    const [created] = await db
      .select()
      .from(maintenanceRequests)
      .where(
        and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.organisationId, orgId)),
      );

    return Response.json({ id, reference, title, item: created ?? null }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * PATCH /api/board/items — edit cells, move between groups, batch update.
 * O6, O7, O8, O12.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const body = await request.json().catch(() => ({}));
    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);
    const who = actor.displayName || "Workspace";

    // O6 — set a cell value, validated through the column type registry.
    if (body.intent === "cell") {
      const requestId = text(body.itemId, 64);
      const columnId = text(body.columnId, 64);
      if (!requestId || !columnId) return bad("An item and a column are both required.");

      const [column] = await db
        .select()
        .from(maintenanceBoardColumns)
        .where(
          and(
            eq(maintenanceBoardColumns.id, columnId),
            eq(maintenanceBoardColumns.organisationId, orgId),
          ),
        );
      if (!column) return bad("Column not found.", 404);

      const definition = getColumnType(column.type);
      if (!definition) return bad(`Column type "${column.type}" is not known.`, 409);
      if (definition.readOnly) {
        return bad(`${column.title} is calculated and cannot be edited.`, 409);
      }

      const value = normaliseCellValue(column.type, body.value);
      if (value === null) {
        return bad(`That value is not valid for a ${definition.label} column.`);
      }
      if (column.required && !value) {
        return bad(`${column.title} is required.`);
      }

      const [existing] = await db
        .select()
        .from(maintenanceBoardCells)
        .where(
          and(
            eq(maintenanceBoardCells.organisationId, orgId),
            eq(maintenanceBoardCells.requestId, requestId),
            eq(maintenanceBoardCells.columnId, columnId),
          ),
        );

      if (existing) {
        if (existing.value === value) return Response.json({ ok: true, unchanged: true });
        await db
          .update(maintenanceBoardCells)
          .set({ value, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(maintenanceBoardCells.id, existing.id));
      } else {
        await db.insert(maintenanceBoardCells).values({
          id: newId("cell"),
          organisationId: orgId,
          boardId: board.key,
          requestId,
          columnId,
          value,
        });
      }

      await recordActivity(
        db, orgId, board.key, requestId, who, "changed",
        column.key, existing?.value ?? null, value,
      );
      return Response.json({ ok: true, value });
    }

    // O7 — move items between or within groups.
    if (body.intent === "move") {
      const groupId = text(body.groupId, 64);
      const itemIds: string[] = Array.isArray(body.itemIds)
        ? body.itemIds.map((v: unknown) => text(v, 64)).filter(Boolean)
        : [];
      if (!groupId || !itemIds.length) return bad("A group and at least one item are required.");

      const [group] = await db
        .select({ id: maintenanceGroups.id })
        .from(maintenanceGroups)
        .where(
          and(
            eq(maintenanceGroups.id, groupId),
            eq(maintenanceGroups.organisationId, orgId),
            // Stage 23 — nothing may be filed into a group that is in the bin.
            isNull(maintenanceGroups.deletedAt),
          ),
        );
      if (!group) return bad("Group not found.", 404);

      const [tail] = await db
        .select({ maxPosition: sql<number>`COALESCE(MAX(${maintenanceGroupItems.position}), -1)` })
        .from(maintenanceGroupItems)
        .where(
          and(
            eq(maintenanceGroupItems.organisationId, orgId),
            eq(maintenanceGroupItems.groupId, groupId),
          ),
        );
      let position = Number(tail?.maxPosition ?? -1);

      for (const itemId of itemIds) {
        position += 1;
        const [placement] = await db
          .select()
          .from(maintenanceGroupItems)
          .where(
            and(
              eq(maintenanceGroupItems.organisationId, orgId),
              eq(maintenanceGroupItems.requestId, itemId),
            ),
          );
        if (placement) {
          await db
            .update(maintenanceGroupItems)
            .set({ groupId, position, updatedAt: sql`CURRENT_TIMESTAMP` })
            .where(
              and(
                eq(maintenanceGroupItems.organisationId, orgId),
                eq(maintenanceGroupItems.requestId, itemId),
              ),
            );
        } else {
          await db.insert(maintenanceGroupItems).values({
            requestId: itemId,
            organisationId: orgId,
            boardId: board.key,
            groupId,
            position,
          });
        }
        await recordActivity(db, orgId, board.key, itemId, who, "moved", undefined, null, groupId);
      }
      return Response.json({ ok: true, moved: itemIds.length });
    }

    // O8 / O12 — batch status change, or archive and restore.
    const itemIds: string[] = Array.isArray(body.itemIds)
      ? body.itemIds.map((v: unknown) => text(v, 64)).filter(Boolean)
      : [text(body.id, 64)].filter(Boolean);
    if (!itemIds.length) return bad("At least one item is required.");

    const patch: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
    let action = "updated";

    if (typeof body.archived === "boolean") {
      patch.archived = body.archived;
      patch.archivedAt = body.archived ? sql`CURRENT_TIMESTAMP` : null;
      action = body.archived ? "archived" : "restored";
    }
    if (typeof body.status === "string") patch.status = text(body.status, 80);
    if (typeof body.priority === "string") patch.priority = text(body.priority, 40);
    if (typeof body.assignee === "string") patch.assignee = text(body.assignee, 120);
    if (typeof body.title === "string") {
      const title = text(body.title, 200);
      if (!title) return bad("Title cannot be empty.");
      patch.title = title;
    }

    // Chunked — a batch update from "select all" on a large board otherwise
    // exceeds D1's bound-variable limit.
    for (const chunk of chunkIds(itemIds)) {
      await db
        .update(maintenanceRequests)
        .set(patch)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            inArray(maintenanceRequests.id, chunk),
          ),
        );
    }

    for (const itemId of itemIds) {
      await recordActivity(db, orgId, board.key, itemId, who, action);
    }

    return Response.json({ ok: true, updated: itemIds.length });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * DELETE /api/board/items?id=…
 *
 * Deletion is refused. Jobs carry compliance evidence and an audit trail, so an
 * item is archived instead — reversible, and nothing is lost.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 64);
    if (!id) return bad("An item id is required.");

    const [existing] = await db
      .select({ id: maintenanceRequests.id, reference: maintenanceRequests.reference })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, id),
          eq(maintenanceRequests.organisationId, orgId),
          // Stage 23 — a job already in the bin is not found here.
          isNull(maintenanceRequests.deletedAt),
        ),
      );
    if (!existing) return bad("Item not found.", 404);

    await db
      .update(maintenanceRequests)
      .set({ archived: true, archivedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.organisationId, orgId)),
      );

    const board = await resolveBoard(db, orgId);
    await recordActivity(db, orgId, board.key, id, actor.displayName || "Workspace", "archived");

    return Response.json({
      ok: true,
      archived: true,
      message: `${existing.reference ?? "The job"} was archived rather than deleted, so its evidence and history remain.`,
    });
  } catch (error) {
    return unavailable(error);
  }
}
