import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  itemActivity,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  sites,
} from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { isBoardNotFound, nextReference, resolveBoard } from "../../../lib/board-registry";
import { dateDecorationValue } from "../../../lib/board-cell-values";
import type { BoardColumnType } from "../../../lib/types";
import {
  automationContext,
  cellChangedEvent,
  dispatchAutomationEvents,
  itemCreatedEvent,
  itemMovedEvent,
  requestFieldEvents,
} from "../../../lib/automations";
import { getColumnType, normaliseCellValue } from "../../../lib/column-types";
import { chunkIds, selectInChunks } from "../../../lib/sql-batching";
import { isUnassignedSite, unassignedSiteId } from "../../../lib/site-reference";

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
  // A request for a board that does not exist is a 404, not an outage. Without
  // this it funnelled into the 503 below, telling a browser to retry a request
  // no retry can fix. See `BoardNotFoundError`.
  if (isBoardNotFound(error)) {
    return Response.json({ error: error.message }, { status: 404 });
  }
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
    // Clamped from BOTH ends: SQLite reads `LIMIT -5` as "no limit", so an
    // unfloored value let `?limit=-5` bypass the 500-row cap. A negative
    // OFFSET happens to be read as zero, but that is driver leniency, not a
    // contract — clamp rather than rely on it.
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
    const cursor = Math.max(Number(url.searchParams.get("cursor")) || 0, 0);

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
      /*
       * THE BOARD THE CALLER ASKED FOR — which this read used to resolve and
       * then throw away.
       *
       * `resolveBoard` above ran, validated `?board=`, and its result reached
       * the response envelope and nothing else: no condition here named a
       * board, and there is no board column on `maintenance_requests` to name.
       * So `?board=store-documentation` answered with the organisation's ENTIRE
       * job list — 32 maintenance jobs on this dev workspace — and every
       * alternative view built on this route (kanban, calendar, chart, gallery)
       * drew the maintenance board's rows while claiming to draw the
       * documentation board's. Not a tenant leak; the organisation filter was
       * always intact. Worse in one respect: plausible wrong data rather than
       * an error.
       *
       * Placement is what decides a request's board — see the long note in
       * `ensureBoardState` (app/api/board/route.ts:936-956) — so the filter has
       * to go through `maintenance_group_items`, which is also how
       * `boardPayload` scopes its own item list.
       *
       * A SUBQUERY RATHER THAN A JOIN OR A TWO-STEP `IN` LIST, for two reasons.
       * A join would change the shape drizzle returns for `.select()` and force
       * every one of the twenty field reads below to be rewritten, which is a
       * much larger diff than the defect. Reading the placed ids first and
       * passing them as an `IN` list would blow D1's bound-variable budget on a
       * real board — 744 rows against a cap the `chunkIds` helper puts at 90 —
       * and chunking cannot be reconciled with the LIMIT/OFFSET paging this
       * route promises. Two bound parameters, applied BEFORE the limit, so a
       * page is a page of this board's items and `nextCursor` still means
       * something.
       *
       * It also answers "unplaced" correctly by construction: a request with no
       * placement row is on no board, so it belongs in no board's answer. The
       * question asked here is "which board is this request on", which is what
       * the request_id primary key can answer — NOT "is this request placed on
       * board X", the narrower question whose board-scoped form caused the
       * 31 discarded INSERTs that note records.
       */
      inArray(
        maintenanceRequests.id,
        db
          .select({ requestId: maintenanceGroupItems.requestId })
          .from(maintenanceGroupItems)
          .where(
            and(
              eq(maintenanceGroupItems.organisationId, orgId),
              eq(maintenanceGroupItems.boardId, board.key),
            ),
          ),
      ),
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
    // `?? {}` because a body of literal `null` PARSES — the catch never fires,
    // and every `body.x` below would throw straight into the 503 catch.
    const body = (await request.json().catch(() => null)) ?? {};
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
      await dispatchAutomationEvents(automationContext(guard.scope, request), [
        itemCreatedEvent(board.key, id, source.parentId ?? null, placement?.groupId ?? null),
      ]);
      return Response.json({ id, reference }, { status: 201 });
    }

    const title = text(body.title, 200);
    if (!title) return bad("A job title is required.");

    /*
     * The site, which a job may legitimately not have.
     *
     * This refused an absent site outright. That was right while `site_id` was
     * NOT NULL — except that what a board-created row actually carried was the
     * literal "site-unassigned", a sentinel referencing no row in any table,
     * admitted by an exemption this very block had to carry. A subitem inherits
     * its parent's site, so once a parent can honestly have none — a website
     * report naming a store nobody recognises — refusing an absent site would
     * make that job impossible to add a subitem to.
     *
     * So absence is absence. A site that IS named must be one THIS organisation
     * owns: `siteId` was only length-checked, so a caller could file a job in
     * their own tenant against another tenant's site id, or an invented one,
     * and every site-joined report and compliance count would then be reading
     * across a tenant boundary.
     */
    const rawSiteId = text(body.siteId, 64);
    /*
     * Rows created before `site_id` could be null carry the sentinel, and a
     * subitem raised from one hands it straight back here. It references no
     * site in any tenant, so it is read as the absence it always meant rather
     * than 404ing the operator mid-gesture. It is also still what a database
     * that cannot hold NULL is given to write.
     */
    const siteId = isUnassignedSite(rawSiteId) ? unassignedSiteId() : rawSiteId;
    if (siteId && !isUnassignedSite(siteId)) {
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.organisationId, orgId)));
      if (!site) return bad("Site not found.", 404);
    }

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

    // A subitem when `parentId` is set — the engine tells the two apart.
    await dispatchAutomationEvents(automationContext(guard.scope, request), [
      itemCreatedEvent(board.key, id, parentId, groupId || null),
    ]);

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
    // `?? {}` because a body of literal `null` PARSES — the catch never fires,
    // and every `body.x` below would throw straight into the 503 catch.
    const body = (await request.json().catch(() => null)) ?? {};
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
            isNull(maintenanceBoardColumns.deletedAt),
          ),
        );
      if (!column) return bad("Column not found.", 404);

      /*
       * The item must exist in THIS organisation. The column above was always
       * org-scoped, but `requestId` went straight into the insert below, so a
       * well-formed foreign or invented id was answered 200 and left an orphan
       * cell behind — proven against the running server. `parentId` rides along
       * for the automation event, which used to re-query it after the write.
       */
      const [workOrder] = await db
        .select({
          id: maintenanceRequests.id,
          parentId: maintenanceRequests.parentId,
        })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, requestId),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .limit(1);
      if (!workOrder) return bad("Item not found.", 404);

      let value: string;
      if (column.system) {
        /*
         * A SYSTEM COLUMN IS A FIELD ON THE JOB, NOT A CELL — the rule
         * `PATCH /api/board`'s update_cell already enforces. This route
         * accepted any value for one, storing a cell that shadowed the field
         * without setting it: a contractor written here showed on the board
         * while `request.contractor` stayed null everywhere else. Only the
         * date decoration — marker and time of day, never a date — may be
         * stored, exactly as on the board route.
         */
        let decoration: string | null;
        try {
          decoration = dateDecorationValue(column.type as BoardColumnType, body.value);
        } catch (error) {
          return bad(error instanceof Error ? error.message : "Enter a valid value.");
        }
        if (decoration === null) {
          return bad(
            "That column is a field on the job. Use PATCH /api/maintenance with { id, fields } so every other screen sees the change.",
          );
        }
        value = decoration;
      } else {
        const definition = getColumnType(column.type);
        if (!definition) return bad(`Column type "${column.type}" is not known.`, 409);
        if (definition.readOnly) {
          return bad(`${column.title} is calculated and cannot be edited.`, 409);
        }
        const normalised = normaliseCellValue(column.type, body.value);
        if (normalised === null) {
          return bad(`That value is not valid for a ${definition.label} column.`);
        }
        value = normalised;
        if (column.required && !value) {
          return bad(`${column.title} is required.`);
        }
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
      /*
       * Named by column KEY for a system column and by id for a custom one —
       * the same handles the automation builder offers, so a rule on "Status"
       * matches whether the change came through here or through the board.
       * `workOrder` was resolved before the write, so no second query here.
       */
      const event = cellChangedEvent(
        board.key,
        requestId,
        workOrder.parentId ?? null,
        column.system ? column.key : column.id,
        column.type,
        existing?.value ?? "",
        value,
      );
      // Rules may have written cells this request never named — see the note
      // on the same response in /api/board's update_cell.
      const ran = event
        ? await dispatchAutomationEvents(automationContext(guard.scope, request), [event])
        : 0;
      return Response.json({ ok: true, value, ...(ran > 0 ? { automationsRan: ran } : {}) });
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
      await dispatchAutomationEvents(
        automationContext(guard.scope, request),
        itemIds.map((itemId) => itemMovedEvent(board.key, itemId, null, groupId)),
      );
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

    // Read before writing, so each column that moved can be named to the
    // automation engine afterwards. Bounded by the batch, like the write.
    const beforeRows = new Map<string, typeof maintenanceRequests.$inferSelect>();
    for (const chunk of chunkIds(itemIds)) {
      const rows = await db
        .select()
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            inArray(maintenanceRequests.id, chunk),
          ),
        );
      for (const row of rows) beforeRows.set(row.id, row);
    }

    // Chunked — a batch update from "select all" on a large board otherwise
    // exceeds D1's bound-variable limit.
    const afterRows: Array<typeof maintenanceRequests.$inferSelect> = [];
    for (const chunk of chunkIds(itemIds)) {
      const rows = await db
        .update(maintenanceRequests)
        .set(patch)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            inArray(maintenanceRequests.id, chunk),
          ),
        )
        .returning();
      afterRows.push(...rows);
    }

    /*
     * ACTIVITY FOLLOWS WHAT CHANGED, NOT WHAT WAS ASKED FOR.
     *
     * This iterated `itemIds`. The UPDATE above is organisation-scoped and
     * every id that missed it is absent from `afterRows` — so a foreign,
     * invented or binned id wrote nothing to `maintenance_requests` and still
     * filed an `item_activity` row into the CALLER's organisation, naming a
     * request id that organisation does not own. An audit trail that records
     * edits which did not happen is worse than one that records none: it is the
     * record somebody reaches for when they want to know what was changed.
     *
     * `afterRows` is the same list the automation dispatch immediately below
     * already maps over, so this makes all three statements — the write, the
     * trail and the events — agree about what happened.
     */
    for (const row of afterRows) {
      await recordActivity(db, orgId, board.key, row.id, who, action);
    }

    await dispatchAutomationEvents(
      automationContext(guard.scope, request),
      afterRows.flatMap((row) => requestFieldEvents(board.key, beforeRows.get(row.id), row)),
    );

    /*
     * THE COUNT OF ROWS WRITTEN, NOT THE COUNT OF IDS SENT.
     *
     * `updated: itemIds.length` answered `{ ok: true, updated: 1 }` to a PATCH
     * naming a row in another organisation — measured: a cross-tenant rename to
     * "HIJACKED-BY-ORG2" was refused by the `organisationId` predicate, wrote
     * nothing, and was reported as having worked. Nothing leaked and nothing
     * moved; the ANSWER was the defect, and it is the shape of defect a caller
     * cannot detect. A board that shows a rename which never reached the
     * database is telling its user something false and will keep telling them
     * until they reload.
     *
     * It is also wrong for the ordinary case: a mixed batch where half the ids
     * are already in the bin reported every one of them as saved.
     */
    return Response.json({ ok: true, updated: afterRows.length });
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
