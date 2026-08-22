/**
 * `/api/trash` — the recycle bin itself.
 *
 * Stage 23, and a reversal. `/api/account/trash` next door used to be the whole
 * story: a deletion HISTORY, correctly labelled, with no Restore button, because
 * no table stored a deleted row. The owner asked for monday's behaviour instead
 * — thirty days of backup and a place to find deleted things — so this route
 * exists and that one now describes both halves. The history was not replaced;
 * it is still there, underneath the bin, and it is still the only record of the
 * deletions that happened before this stage.
 *
 * THREE VERBS, THREE DIFFERENT ANSWERS TO "MAY YOU":
 *
 *   GET    `board.view`  — seeing what is in the bin is reading the board.
 *   POST   `board.edit`  — restoring puts a row back on a board. It is a write,
 *                          and it is guarded as one.
 *   DELETE `data.delete` — permanent. `data.delete` is withheld from `admin` by
 *                          default precisely so the irreversible verb has to be
 *                          granted deliberately; that is the capability's whole
 *                          purpose and this is the route it was waiting for.
 *
 * A client holds `board.view`, so a client CAN read this route. That sentence
 * used to say the opposite, and the opposite is what a reader would have relied
 * on. What a client cannot do is act: restoring needs `board.edit` and purging
 * needs `data.delete`, and neither is theirs. The payload therefore says which
 * of the two verbs this caller holds, so the screen can offer what it can
 * actually carry out rather than drawing buttons that answer 403 — and so the
 * sidebar can decide whether to list the bin at all.
 */

import { and, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  recycleBin,
} from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import { can, resolvePermissions } from "../../lib/permissions";
import {
  RETENTION_DAYS,
  listBin,
  maybeSweepRecycleBin,
  restoreFromBin,
  type PurgeFn,
} from "../../lib/recycle-bin";
import { chunkIds } from "../../lib/sql-batching";
import { anonymousRefusal, scopedDbWithCapability } from "../../lib/tenant-db";

type Scope = Awaited<ReturnType<typeof scopedDbWithCapability>>["scope"];
type Database = NonNullable<Scope>["db"];

function unavailable(error: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  if (error) console.error("[/api/trash]", error);
  return Response.json(
    { error: "The recycle bin is temporarily unavailable." },
    { status: 503 },
  );
}

/* ── GET — what is in the bin ──────────────────────────────────────────── */

/**
 * Filters are applied here rather than in the browser so the screen stays
 * honest about the size of the bin: `total` is the unfiltered count, `entries`
 * is what matched. A filter that hid rows while claiming an empty bin would be
 * the same class of mistake this stage is undoing.
 */
export async function GET(request: Request) {
  await ensureDatabase();
  try {
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    // Sampled, capped and index-driven. See `maybeSweepRecycleBin`.
    await maybeSweepRecycleBin(db, purgeFor(db));

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind");
    const board = url.searchParams.get("board");
    const actor = url.searchParams.get("actor");
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();

    /*
     * What this caller may DO, answered once and sent with the list.
     *
     * The same resolution the guard above already performed, reused for the two
     * verbs this route also offers. Cheaper than two more guarded round trips
     * and, more to the point, it is the only way the screen can tell the
     * difference between "nothing to restore" and "not yours to restore".
     */
    const subject = await resolvePermissions(db, orgId, guard.scope.actor.role);

    const all = await listBin(db, orgId);
    const entries = all.filter((entry) => {
      if (kind && kind !== "all" && entry.entityType !== kind) return false;
      if (board && board !== "all" && entry.boardId !== board) return false;
      if (actor && actor !== "all" && (entry.deletedByEmail ?? "") !== actor) return false;
      if (query && !`${entry.title} ${entry.summary ?? ""}`.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });

    return Response.json({
      bin: {
        recoverable: true,
        canRestore: can(subject, "board.edit"),
        canPurge: can(subject, "data.delete"),
        retentionDays: RETENTION_DAYS,
        entries,
        total: all.length,
        matched: entries.length,
        /*
         * The filter vocabulary is derived from what is actually in the bin, so
         * the screen never offers a filter that can only return nothing.
         */
        kinds: [...new Set(all.map((entry) => entry.entityType))].sort(),
        boards: [...new Set(all.map((entry) => entry.boardId).filter(Boolean))].sort(),
        actors: [
          ...new Map(
            all
              .filter((entry) => entry.deletedByEmail)
              .map((entry) => [entry.deletedByEmail, entry.deletedBy]),
          ),
        ].map(([email, name]) => ({ email, name })),
      },
    });
  } catch (error) {
    return unavailable(error);
  }
}

/* ── POST — restore ────────────────────────────────────────────────────── */

/**
 * Restoring is a write, so it is guarded as one.
 *
 * `board.edit` rather than `data.delete`: putting a row back is the same kind of
 * act as moving one, and demanding the destructive capability to undo a mistake
 * would push people towards leaving the mistake in place.
 */
export async function POST(request: Request) {
  await ensureDatabase();
  try {
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;

    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
    if (!id) return Response.json({ error: "A bin entry id is required." }, { status: 400 });

    const outcome = await restoreFromBin(db, orgId, id);
    if (!outcome.ok) {
      return Response.json({ error: outcome.error }, { status: outcome.status });
    }

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "trash.restored",
      entityType: RESTORED_ENTITY_TYPES[outcome.entityType] ?? outcome.entityType,
      entityId: outcome.entityId,
      summary: outcome.message,
      detail: { entityType: outcome.entityType, entityId: outcome.entityId },
      request,
    });

    return Response.json({ ok: true, restored: outcome.entityId, message: outcome.message });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * What each restorable kind is called in the audit trail.
 *
 * The audit vocabulary names database entities; the bin names user-facing
 * things. This was a two-way ternary that read "job or else group", so adding a
 * third kind would have silently filed every restored view as a group.
 */
const RESTORED_ENTITY_TYPES: Record<string, string> = {
  job: "maintenance_request",
  group: "maintenance_group",
  board_view: "board_view",
  // The correction: a column can be in the bin now, and a restored one is a
  // `maintenance_board_column` in the audit trail like every change to it.
  column: "maintenance_board_column",
};

/* ── DELETE — permanent ────────────────────────────────────────────────── */

/**
 * Delete for good: one entry with `?id=`, or everything with `?all=true`.
 *
 * This is the code that used to run the moment somebody pressed Delete on the
 * board — `POST /api/board` action `delete_items`. It has not been softened,
 * only moved behind a second, deliberate act and a capability that is not
 * granted by default. What was one irreversible click is now two, and the first
 * one is reversible for thirty days.
 */
export async function DELETE(request: Request) {
  await ensureDatabase();
  try {
    const guard = await scopedDbWithCapability(request, "data.delete");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, identityEmail, session } = guard.scope;

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const emptyAll = url.searchParams.get("all") === "true";

    if (!id && !emptyAll) {
      return Response.json(
        { error: "Pass ?id= to delete one item for good, or ?all=true to empty the bin." },
        { status: 400 },
      );
    }

    const entries = await db
      .select({
        id: recycleBin.id,
        entityType: recycleBin.entityType,
        entityId: recycleBin.entityId,
        title: recycleBin.title,
      })
      .from(recycleBin)
      .where(
        id
          ? and(eq(recycleBin.id, id), eq(recycleBin.organisationId, orgId))
          : eq(recycleBin.organisationId, orgId),
      );

    if (!entries.length) {
      return Response.json(
        { error: id ? "That item is no longer in the bin." : "The bin is already empty." },
        { status: id ? 404 : 409 },
      );
    }

    const purge = purgeFor(db);
    const purged: typeof entries = [];
    const skipped: typeof entries = [];
    for (const entry of entries) {
      // The bin row goes only if the purge did. See `sweepRecycleBin` for why
      // removing it regardless is the one outcome worse than leaving it.
      if (await purge(orgId, entry.entityType, entry.entityId)) {
        await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));
        purged.push(entry);
      } else {
        skipped.push(entry);
      }
    }

    if (!purged.length) {
      return Response.json(
        {
          error:
            "Nothing was deleted. Items are still filed under the groups in the bin; move them out first.",
          skipped: skipped.length,
        },
        { status: 409 },
      );
    }

    /*
     * Written after the deletes, not before.
     *
     * The rows, their cells, their attachments and their history have just been
     * destroyed, so this event is the only surviving record that they existed —
     * and an event claiming a deletion that then failed would be worse than no
     * event at all. That is the same rule the board route's `delete_items` audit
     * followed, and it is the reason the Trash screen's deletion history still
     * has something to show after the bin is emptied.
     */
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({ actor, identityEmail, session }),
      action: "trash.purged",
      entityType: "recycle_bin",
      summary: `Permanently deleted ${purged.length} item${purged.length === 1 ? "" : "s"} from the recycle bin.`,
      detail: {
        permanent: true,
        entries: purged.map((entry) => ({
          type: entry.entityType,
          id: entry.entityId,
          title: entry.title,
        })),
      },
      request,
    });

    return Response.json({
      ok: true,
      purged: purged.length,
      skipped: skipped.length,
      message: `${purged.length} item${purged.length === 1 ? "" : "s"} deleted for good. This cannot be undone.`,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/* ── The destructive half ──────────────────────────────────────────────── */

/**
 * Builds the purge function the bin and the sweep both use.
 *
 * A closure over `db` rather than a plain export because `sweepRecycleBin` in
 * `app/lib/recycle-bin.ts` must stay free of `cloudflare:workers` — that import
 * only resolves inside the Worker, and keeping it here is what lets a test drive
 * the sweep with a stub.
 */
function purgeFor(db: Database): PurgeFn {
  return async (organisationId, entityType, entityId) => {
    if (entityType === "job") return purgeJob(db, organisationId, entityId);
    if (entityType === "group") return purgeGroup(db, organisationId, entityId);
    /*
     * A board view leaves nothing behind. Unlike a job or a group, its row is
     * removed the moment it goes to the bin — `board_views` has a UNIQUE index
     * on (organisation, board, key) that a soft-deleted row would hold against
     * a view created in the meantime — so the entry itself IS the whole thing,
     * and letting the bin row go is the entire purge. See `sendBoardViewToBin`.
     */
    if (entityType === "board_view") return true;
    if (entityType === "column") return purgeColumn(db, organisationId, entityId);
    // An entity kind this build does not know how to destroy. Declining leaves
    // the entry in the bin, which is visible and fixable; pretending otherwise
    // would strand the row.
    return false;
  };
}

/**
 * Destroy a column: its files, then its values, then the column itself.
 *
 * This is the only place a column's cells are ever deleted, and it runs either
 * because someone chose "Delete for good" in front of a confirmation naming the
 * column, or because thirty days elapsed. Everything before this point is
 * reversible; nothing after it is.
 *
 * Order matters and is the same as `purgeJob`'s: the objects in storage, then
 * the rows that point at them, then the rows that point at those. The foreign
 * key from `maintenance_board_cells.column_id` means the column row cannot go
 * first — which is also why the bin had to keep the column row rather than
 * orphaning its cells behind it.
 */
async function purgeColumn(db: Database, orgId: string, columnId: string) {
  const files = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(
      and(
        eq(attachments.boardColumnId, columnId),
        eq(attachments.organisationId, orgId),
      ),
    );

  if (files.length) {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
    if (runtimeEnv.BUCKET) {
      for (const keys of chunkIds(files.map((file) => file.objectKey), 1000)) {
        await runtimeEnv.BUCKET.delete(keys);
      }
    }
    // Storage being down does not wedge the entry in the bin for ever. See the
    // matching note in `purgeJob`.
  }

  await db
    .delete(attachments)
    .where(
      and(
        eq(attachments.boardColumnId, columnId),
        eq(attachments.organisationId, orgId),
      ),
    );
  await db
    .delete(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.columnId, columnId),
        eq(maintenanceBoardCells.organisationId, orgId),
      ),
    );
  await db
    .delete(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.id, columnId),
        eq(maintenanceBoardColumns.organisationId, orgId),
      ),
    );
  return true;
}

/**
 * Destroy a job and everything hanging off it.
 *
 * Lifted from `POST /api/board` action `delete_items`, which is where this ran
 * before Stage 23, and kept in the same order: files first, then the rows that
 * point at the files, then the row itself. The placement is already gone — it
 * was deleted when the job went into the bin — but it is deleted again here
 * defensively, because a job restored and re-deleted by a racing request would
 * otherwise leave an orphan pointing at a row that no longer exists.
 */
async function purgeJob(db: Database, orgId: string, requestId: string) {
  const files = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(
      and(eq(attachments.requestId, requestId), eq(attachments.organisationId, orgId)),
    );

  if (files.length) {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
    if (runtimeEnv.BUCKET) {
      // R2 caps a bulk delete at 1,000 keys per call.
      for (const keys of chunkIds(files.map((file) => file.objectKey), 1000)) {
        await runtimeEnv.BUCKET.delete(keys);
      }
    }
    /*
     * Storage being unavailable does not stop the database half.
     *
     * The board route refused the whole delete when R2 was down, which was right
     * for a one-shot destructive action a person had just asked for. Here the
     * caller may be the expiry sweep, which has no one to report to and must not
     * wedge a thirty-day-old entry in the bin for ever because a bucket binding
     * was missing. The rows go; a stranded object is recoverable, a bin that
     * never empties is not.
     */
  }

  await db
    .delete(attachments)
    .where(and(eq(attachments.requestId, requestId), eq(attachments.organisationId, orgId)));
  await db
    .delete(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.requestId, requestId),
        eq(maintenanceGroupItems.organisationId, orgId),
      ),
    );
  await db
    .delete(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.requestId, requestId),
        eq(maintenanceBoardCells.organisationId, orgId),
      ),
    );
  await db
    .delete(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "maintenance_request"),
        inArray(activityLog.entityId, [requestId]),
        eq(activityLog.organisationId, orgId),
      ),
    );
  await db
    .delete(maintenanceRequests)
    .where(
      and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)),
    );

  return true;
}

/**
 * Destroy a board group.
 *
 * A group only reaches the bin empty — `DELETE /api/board/groups` still refuses
 * to bin a group holding items until they have been moved somewhere — so there
 * is nothing to cascade. Any placement that has since appeared is re-parented
 * rather than destroyed, because deleting a group must never silently take jobs
 * with it.
 */
async function purgeGroup(db: Database, orgId: string, groupId: string) {
  const stragglers = await db
    .select({ requestId: maintenanceGroupItems.requestId })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.groupId, groupId),
        eq(maintenanceGroupItems.organisationId, orgId),
      ),
    );

  if (stragglers.length) {
    // Something is filed in a group that should have been empty. Refuse: the
    // group row stays, its bin entry stays, and a person can deal with it. The
    // alternative — deleting the group — would take those jobs' placements with
    // it and drop them off the board silently.
    return false;
  }

  await db
    .delete(maintenanceGroups)
    .where(
      and(eq(maintenanceGroups.id, groupId), eq(maintenanceGroups.organisationId, orgId)),
    );

  return true;
}
