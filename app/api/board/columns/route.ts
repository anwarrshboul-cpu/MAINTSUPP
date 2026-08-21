import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { maintenanceBoardCells, maintenanceBoardColumns } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { resolveBoard } from "../../../lib/board-registry";
import {
  canConvert,
  getColumnType,
  isColumnType,
  listColumnTypes,
  summariesFor,
} from "../../../lib/column-types";

export const dynamic = "force-dynamic";

function text(value: unknown, max = 120) {
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
  return Response.json({ error: "Board columns are temporarily unavailable." }, { status: 503 });
}

function newId() {
  return `col_${crypto.randomUUID().replace(/-/g, "")}`;
}

function keyFrom(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `column_${Date.now()}`
  );
}

/** GET /api/board/columns — columns for a board, plus the available types. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const board = await resolveBoard(db, orgId, url.searchParams.get("board") ?? undefined);

    const rows = await db
      .select()
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, board.key),
        ),
      )
      .orderBy(asc(maintenanceBoardColumns.position));

    return Response.json({
      board,
      columns: rows.map((row) => ({
        id: row.id,
        key: row.key,
        title: row.title,
        type: row.type,
        position: row.position,
        width: row.width,
        visible: row.visible,
        pinned: row.pinned,
        required: row.required,
        summary: row.summary,
        optionSetKey: row.optionSetKey,
        description: row.description,
        system: row.system,
        settings: JSON.parse(row.settings || "{}"),
        summaries: summariesFor(row.type),
      })),
      types: listColumnTypes().map((type) => ({
        key: type.key,
        label: type.label,
        group: type.group,
        readOnly: type.readOnly,
        usesOptionSet: type.usesOptionSet,
        describe: type.describe,
      })),
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/board/columns — add a column. N5. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = await request.json().catch(() => ({}));

    const title = text(body.title, 80);
    const type = text(body.type, 40);
    if (!title) return bad("A column title is required.");
    if (!isColumnType(type)) return bad(`"${type}" is not a known column type.`);

    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);
    const definition = getColumnType(type);

    if (definition?.usesOptionSet && !text(body.optionSetKey, 48)) {
      return bad(`A ${definition.label} column needs an option set to draw its choices from.`);
    }

    let key = keyFrom(title);
    const existing = await db
      .select({ key: maintenanceBoardColumns.key })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, board.key),
        ),
      );
    const taken = new Set(existing.map((row) => row.key));
    let suffix = 2;
    while (taken.has(key)) key = `${keyFrom(title)}_${suffix++}`;

    const [tail] = await db
      .select({ maxPosition: sql<number>`COALESCE(MAX(${maintenanceBoardColumns.position}), -1)` })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, board.key),
        ),
      );

    const id = newId();
    await db.insert(maintenanceBoardColumns).values({
      id,
      organisationId: orgId,
      boardId: board.key,
      key,
      title,
      type,
      position: Number(tail?.maxPosition ?? -1) + 1,
      width: Number(body.width) > 0 ? Math.min(Number(body.width), 640) : 160,
      settings: JSON.stringify(body.settings ?? {}),
      optionSetKey: text(body.optionSetKey, 48) || null,
      description: text(body.description, 240) || null,
      required: Boolean(body.required),
      system: false,
    });

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor: guard.scope.actor, identityEmail: guard.scope.identityEmail, session: guard.scope.session }),
      action: "board.column_created",
      entityType: "maintenance_board_column",
      entityId: id,
      summary: `Added the "${title}" ${type} column to ${board.key}.`,
      detail: { board: board.key, key, title, type },
      request,
    });

    return Response.json({ id, key, title, type }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * PATCH /api/board/columns — rename, resize, reorder, hide, pin, convert type.
 * N6, N8, N9, N10.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = await request.json().catch(() => ({}));

    // Bulk reorder — [{ id, position }]
    if (Array.isArray(body.order)) {
      /*
       * The order BEFORE, read once, so the audit event can say what actually
       * moved rather than restating the payload it was handed. Ids the caller
       * named that belong to another workspace are absent from this map and are
       * skipped below, exactly as the update's own `organisationId` predicate
       * skips them.
       */
      const known = await db
        .select({
          id: maintenanceBoardColumns.id,
          title: maintenanceBoardColumns.title,
          position: maintenanceBoardColumns.position,
          boardId: maintenanceBoardColumns.boardId,
        })
        .from(maintenanceBoardColumns)
        .where(eq(maintenanceBoardColumns.organisationId, orgId));
      const byId = new Map(known.map((row) => [row.id, row]));

      const moved: Array<{ id: string; title: string; from: number; to: number }> = [];
      for (const entry of body.order) {
        const id = text(entry?.id, 64);
        const position = Number(entry?.position);
        if (!id || !Number.isFinite(position)) continue;
        const existing = byId.get(id);
        if (existing && existing.position !== position) {
          moved.push({
            id,
            title: existing.title,
            from: existing.position,
            to: position,
          });
        }
        await db
          .update(maintenanceBoardColumns)
          .set({ position, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(maintenanceBoardColumns.id, id),
              eq(maintenanceBoardColumns.organisationId, orgId),
            ),
          );
      }

      if (moved.length) {
        const board = byId.get(moved[0].id)?.boardId ?? "maintenance";
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor({ actor: guard.scope.actor, identityEmail: guard.scope.identityEmail, session: guard.scope.session }),
          action: "board.columns_reordered",
          entityType: "maintenance_board_column",
          entityId: moved[0].id,
          summary:
            moved.length === 1
              ? `Moved the "${moved[0].title}" column on ${board}.`
              : `Reordered ${moved.length} columns on ${board}.`,
          detail: { board, moved },
          request,
        });
      }
      return Response.json({ ok: true });
    }

    const id = text(body.id, 64);
    if (!id) return bad("A column id is required.");

    const [existing] = await db
      .select()
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.id, id),
          eq(maintenanceBoardColumns.organisationId, orgId),
        ),
      );
    if (!existing) return bad("Column not found.", 404);

    const patch: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };

    if (typeof body.title === "string") {
      const title = text(body.title, 80);
      if (!title) return bad("Column title cannot be empty.");
      patch.title = title;
    }
    if (Number.isFinite(Number(body.width))) {
      patch.width = Math.min(Math.max(Number(body.width), 60), 640);
    }
    if (typeof body.visible === "boolean") patch.visible = body.visible;
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (typeof body.required === "boolean") patch.required = body.required;
    if (typeof body.description === "string") {
      patch.description = text(body.description, 240) || null;
    }
    if (typeof body.optionSetKey === "string") {
      patch.optionSetKey = text(body.optionSetKey, 48) || null;
    }
    if (typeof body.summary === "string") {
      const summary = text(body.summary, 24);
      if (summary && !summariesFor(existing.type).includes(summary as never)) {
        return bad(`A ${existing.type} column cannot be summarised by "${summary}".`);
      }
      patch.summary = summary || null;
    }
    if (body.settings && typeof body.settings === "object") {
      patch.settings = JSON.stringify(body.settings);
    }

    // Type conversion — N6. Refuse unless the stored values survive, unless the
    // caller has seen the warning and confirmed.
    if (typeof body.type === "string" && body.type !== existing.type) {
      const nextType = text(body.type, 40);
      if (!isColumnType(nextType)) return bad(`"${nextType}" is not a known column type.`);
      if (existing.system) return bad("System columns cannot change type.", 409);

      if (!canConvert(existing.type, nextType) && body.force !== true) {
        const [filled] = await db
          .select({ total: sql<number>`COUNT(*)` })
          .from(maintenanceBoardCells)
          .where(
            and(
              eq(maintenanceBoardCells.organisationId, orgId),
              eq(maintenanceBoardCells.columnId, existing.id),
              sql`${maintenanceBoardCells.value} <> ''`,
            ),
          );
        return Response.json(
          {
            error: "lossy-conversion",
            affected: Number(filled?.total ?? 0),
            message:
              `Converting ${existing.type} to ${nextType} cannot preserve the stored values. ` +
              `${Number(filled?.total ?? 0)} cell(s) would be cleared.`,
          },
          { status: 409 },
        );
      }
      patch.type = nextType;
    }

    await db
      .update(maintenanceBoardColumns)
      .set(patch)
      .where(
        and(eq(maintenanceBoardColumns.id, id), eq(maintenanceBoardColumns.organisationId, orgId)),
      );

    /*
     * Structure only — see the same rule in /api/board's `update_column`. A
     * width is a preference and fires on every drag; a rename, a hide, a pin,
     * a summary or a type conversion changes the board for everybody and is
     * what W13-05 asks to be attributable.
     */
    const structural = ["title", "type", "visible", "pinned", "summary"].filter(
      (field) => field in patch && patch[field] !== (existing as Record<string, unknown>)[field],
    );
    if (structural.length) {
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({ actor: guard.scope.actor, identityEmail: guard.scope.identityEmail, session: guard.scope.session }),
        action: "board.column_updated",
        entityType: "maintenance_board_column",
        entityId: id,
        summary: `Updated the "${patch.title ?? existing.title}" column on ${existing.boardId} (${structural.join(", ")}).`,
        detail: {
          board: existing.boardId,
          ...changeDetail(
            Object.fromEntries(
              structural.map((field) => [field, (existing as Record<string, unknown>)[field]]),
            ),
            Object.fromEntries(structural.map((field) => [field, patch[field]])),
          ),
        },
        request,
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    return unavailable(error);
  }
}

/** DELETE /api/board/columns?id=… — N7, with a data-loss count first. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 64);
    const confirmed = url.searchParams.get("confirm") === "true";
    if (!id) return bad("A column id is required.");

    const [existing] = await db
      .select()
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.id, id),
          eq(maintenanceBoardColumns.organisationId, orgId),
        ),
      );
    if (!existing) return bad("Column not found.", 404);
    if (existing.system) {
      return bad("System columns cannot be deleted. Hide it instead.", 409);
    }

    const [filled] = await db
      .select({ total: sql<number>`COUNT(*)` })
      .from(maintenanceBoardCells)
      .where(
        and(
          eq(maintenanceBoardCells.organisationId, orgId),
          eq(maintenanceBoardCells.columnId, id),
          sql`${maintenanceBoardCells.value} <> ''`,
        ),
      );
    const affected = Number(filled?.total ?? 0);

    if (affected > 0 && !confirmed) {
      return Response.json(
        {
          error: "has-data",
          affected,
          message: `"${existing.title}" holds ${affected} value${affected === 1 ? "" : "s"}. Deleting it discards them.`,
        },
        { status: 409 },
      );
    }

    await db
      .delete(maintenanceBoardCells)
      .where(
        and(
          eq(maintenanceBoardCells.organisationId, orgId),
          eq(maintenanceBoardCells.columnId, id),
        ),
      );
    await db
      .delete(maintenanceBoardColumns)
      .where(
        and(eq(maintenanceBoardColumns.id, id), eq(maintenanceBoardColumns.organisationId, orgId)),
      );

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor: guard.scope.actor, identityEmail: guard.scope.identityEmail, session: guard.scope.session }),
      action: "board.column_deleted",
      entityType: "maintenance_board_column",
      entityId: id,
      summary: `Deleted the "${existing.title}" column from ${existing.boardId}, discarding ${affected} value${affected === 1 ? "" : "s"}.`,
      // Not recoverable, and the line says so. See the matching note in
      // /api/board's delete_column for what making it recoverable would take.
      detail: { board: existing.boardId, title: existing.title, type: existing.type, discarded: affected, recoverable: false },
      request,
    });

    return Response.json({ ok: true, discarded: affected });
  } catch (error) {
    return unavailable(error);
  }
}
