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

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  complianceDocuments,
  contractorCertifications,
  contractorSites,
  contractors,
  invoices,
  itemActivity,
  itemUpdateLikes,
  itemUpdates,
  jobAccessTokens,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  plannedMaintenance,
  quotations,
  recycleBin,
  registerValues,
  siteAliases,
  siteGroupMembers,
  siteGroups,
  sites,
  units,
  workspaceSections,
} from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import { can, resolvePermissions } from "../../lib/permissions";
import {
  RETENTION_DAYS,
  SECTION_ENTITY_TYPE,
  binnedSectionBoards,
  listBin,
  maybeSweepRecycleBin,
  restoreFromBin,
  sweepRecycleBin,
  type PurgeFn,
} from "../../lib/recycle-bin";
import { deleteBoardStructure } from "../../lib/board-registry";
import {
  BUILT_IN_BOARD_KEYS,
  forgetSectionReferences,
} from "../workspace-sections/route";
import { CANONICAL_REGISTER } from "../../lib/register-scope";
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

    /*
     * `?sweep=1` — THE UNSAMPLED SWEEP, ON REQUEST.
     *
     * There is no scheduler in this deployment: no cron trigger, no queue, no
     * Durable Object alarm, nothing in `vercel.json` or `railway.json`. The
     * thirty days are swept opportunistically by the line above, on roughly one
     * call in ten to this route — which is honest and is what the screen says,
     * and which means the bin empties when somebody uses the app rather than at
     * midnight.
     *
     * This is the deterministic version of the same sweep, so the retention can
     * be RUN rather than waited for: by an operator who wants the bin emptied
     * now, by a test that must not depend on `Math.random`, and — the reason it
     * takes a parameter rather than being a private helper — by whatever
     * scheduler this deployment eventually grows. It is not itself automation
     * and nothing calls it on a timer today; wiring it to one is a deployment
     * change, not a code change.
     *
     * `data.delete`, because it destroys. The guard above is `board.view`, so
     * the capability is resolved again here rather than assumed — a client can
     * read this route and must not be able to empty the bin by adding a query
     * parameter.
     */
    if (["1", "true", "yes"].includes((url.searchParams.get("sweep") ?? "").toLowerCase())) {
      const sweeper = await scopedDbWithCapability(request, "data.delete");
      if (sweeper.denied) return sweeper.denied;
      const swept = await sweepRecycleBin(db, purgeFor(db));
      return Response.json({
        ok: true,
        swept,
        retentionDays: RETENTION_DAYS,
        /* Capped per pass on purpose. A bin holding ten thousand expired rows
           drains over several calls; nothing is lost, because what is left is
           still expired and still first in line. */
        more: swept > 0,
      });
    }
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

    // `?? {}` because a body of literal `null` parses — the catch never
    // fires, and `body.id` below threw into the 503 catch instead of a 400.
    const body = ((await request.json().catch(() => null)) ?? {}) as { id?: unknown };
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
  /* W2C — a restored section is a `workspace_section` in the audit trail, the
     same name its create, rename and archive lines already carry. */
  section: "workspace_section",
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

    const all = await db
      .select({
        id: recycleBin.id,
        entityType: recycleBin.entityType,
        entityId: recycleBin.entityId,
        boardId: recycleBin.boardId,
        title: recycleBin.title,
      })
      .from(recycleBin)
      .where(
        id
          ? and(eq(recycleBin.id, id), eq(recycleBin.organisationId, orgId))
          : eq(recycleBin.organisationId, orgId),
      );

    /*
     * W2C — A CHILD OF A DELETED SECTION IS NOT SEPARATELY DESTROYABLE.
     *
     * The same rule the restore path applies, for the same reason and with a
     * second one of its own. The bin does not list these entries — they are
     * folded into their section's line — so anything naming one here is a stale
     * tab or a script; and `?all=true` would otherwise walk a list in which the
     * section's own entry destroys its children mid-loop, leaving the rest of
     * the loop deleting rows that are already gone. Skipping them is exact:
     * whatever they point at goes when the section does, and the section's entry
     * is still in this list.
     */
    const binnedBoards = await binnedSectionBoards(db, orgId);
    const entries = all.filter(
      (entry) =>
        entry.entityType === SECTION_ENTITY_TYPE ||
        !entry.boardId ||
        !binnedBoards.has(entry.boardId),
    );

    if (id && all.length && !entries.length) {
      return Response.json(
        {
          error:
            "That belongs to a section which is in the recycle bin. Delete the section for good and this goes with it, or restore the section first.",
        },
        { status: 409 },
      );
    }

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
    /*
     * W2C — a whole custom section, and everything its register owned.
     *
     * The only entity kind here whose purge is a TRAVERSAL rather than one
     * row's worth of cleanup, because it is the only one that is a bundle. It
     * reuses `purgeJob` and `purgeColumn` above rather than restating what
     * destroying a row or a column means: two definitions of that is how one of
     * them ends up forgetting the files.
     */
    if (entityType === SECTION_ENTITY_TYPE) {
      return purgeSection(db, organisationId, entityId);
    }
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
/**
 * Destroy a job for good — and its subitems with it.
 *
 * A subitem is binned alongside its parent and carries its own bin entry, so
 * purging only the parent would leave those entries pointing at children whose
 * `parent_id` names a row that no longer exists: restorable in principle,
 * invisible in practice, which is the orphan this whole path exists to stop.
 * Permanently deleting a job deletes what hangs off it, as monday does.
 *
 * One level is enough — the board does not nest subitems under subitems.
 */
async function purgeJob(db: Database, orgId: string, requestId: string) {
  const children = await db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.parentId, requestId),
        eq(maintenanceRequests.organisationId, orgId),
      ),
    );

  for (const child of children) {
    await purgeJobRow(db, orgId, child.id);
    // Its bin entry goes too, or the bin keeps offering a row that is gone.
    await db
      .delete(recycleBin)
      .where(
        and(
          eq(recycleBin.organisationId, orgId),
          eq(recycleBin.entityType, "job"),
          eq(recycleBin.entityId, child.id),
        ),
      );
  }

  return purgeJobRow(db, orgId, requestId);
}

async function purgeJobRow(db: Database, orgId: string, requestId: string) {
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
  /*
   * THE PUBLIC LINKS GO WITH THE JOB, and this is not tidiness.
   *
   * `job_access_tokens` rows are keyed on `request_id`, and MAINTSUPP REUSES
   * MN- IDS: the highest id is not a high-water mark, so a purged MN-1072 is
   * handed straight back out to the next job created. Observed during QA — a
   * "new" job arrived already carrying six token rows minted against the
   * unrelated job that had held the id a week earlier.
   *
   * Every survivor in that instance was already revoked or expired, so nothing
   * was exposed. But the shape is a real hole rather than an untidy one: a
   * token that outlives its job and is still live becomes, the moment its id is
   * reissued, a no-login credential for somebody else's job — and now that the
   * Fix Tracker's links are contractor grants, a WRITE credential. Deleting
   * them here is what makes "purge" mean what it says.
   *
   * Before the request row, deliberately, so a failure part-way through leaves
   * a job with no links rather than links with no job.
   */
  await db
    .delete(jobAccessTokens)
    .where(
      and(
        eq(jobAccessTokens.requestId, requestId),
        eq(jobAccessTokens.organisationId, orgId),
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

/* ── W2C — a section bundle, destroyed for good ────────────────────────── */

/**
 * ONE CUSTOM SECTION AND EVERYTHING IT OWNED, PERMANENTLY.
 *
 * Reached two ways and no others: somebody with `data.delete` pressed "Delete
 * for good" on the section's entry in the bin, or thirty days elapsed and the
 * sweep did it for them. Both are the same code, which is the point — the
 * automatic ending must not be a different, quieter deletion than the one a
 * person chose.
 *
 * ── WHAT IS OWNED, AND WHAT IS ONLY REFERENCED ────────────────────────────
 *
 * The whole of the safety here is one distinction, applied per table:
 *
 *   OWNED — it exists BECAUSE this register exists and is addressed by its
 *   `board_id`: the board row, its columns, options, groups, views, forms,
 *   automations and runs; the items placed on it and their subitems, cells,
 *   files, comments, activity and public links; the sites, contractors and
 *   reporting groups created inside a Sites or Contractors instance; the
 *   section's own row, its remembered views and its name in every arrangement.
 *
 *   SHARED — it existed before this section and will exist after it: the
 *   canonical Jobs, Sites, Contractors and Documentation registers (`board_id`
 *   NULL or one of `BUILT_IN_BOARD_KEYS`), the workspace's option sets, and
 *   `register_columns`, which is keyed by REGISTER KIND rather than by board
 *   and so is one shared definition every Sites instance draws with. Not one
 *   of them is touched here.
 *
 * ── THE ONE PLACE OWNERSHIP IS NOT ENOUGH ─────────────────────────────────
 *
 * A site or a contractor created inside an instance is owned by it, and is also
 * the target of NOT NULL foreign keys from six other tables. Destroying one
 * that a canonical job, a planned visit, a unit or a compliance document still
 * points at would be a cascade across data this section never owned — and on
 * Postgres it would simply throw, which is the class of failure that passes
 * locally and fails deployed. So each row is checked, and a row referenced from
 * OUTSIDE the bundle is RETURNED TO THE CANONICAL REGISTER instead of
 * destroyed. The section still goes, the register still goes, the name is still
 * free; what survives is the row somebody else was relying on, in the one place
 * a person can see it.
 *
 * Returns true when the section is gone, which is what lets the bin entry go
 * with it. See `sweepRecycleBin` for why returning false has to leave both.
 */
async function purgeSection(db: Database, orgId: string, sectionKey: string) {
  const [section] = await db
    .select()
    .from(workspaceSections)
    .where(
      and(
        eq(workspaceSections.organisationId, orgId),
        eq(workspaceSections.key, sectionKey),
      ),
    )
    .limit(1);

  /* The row is already gone. True, not false: leaving the entry behind would
     offer a Restore for a section that no longer exists, which is the one
     outcome worse than an over-eager purge. */
  if (!section) return true;

  /* A board key that is one of the product's own is a DOOR onto a shared
     screen, never this section's register. Checked here as well as at the point
     the bundle was made, because this function can also be reached by the sweep
     thirty days after anybody last looked at it. */
  const boardKey =
    section.surfaceRef && !BUILT_IN_BOARD_KEYS.has(section.surfaceRef)
      ? section.surfaceRef
      : null;

  let ownsBoard = false;
  if (boardKey) {
    /* Any other section naming this register — archived and deleted included.
       A register a second section still points at is not this one's to destroy,
       and a section sitting in the bin beside this one is exactly the caller
       whose Restore would otherwise come back to nothing. */
    const others = await db
      .select({ key: workspaceSections.key })
      .from(workspaceSections)
      .where(
        and(
          eq(workspaceSections.organisationId, orgId),
          eq(workspaceSections.surfaceRef, boardKey),
          ne(workspaceSections.key, sectionKey),
        ),
      )
      .limit(1);
    ownsBoard = others.length === 0;
  }

  if (boardKey && ownsBoard) {
    await purgeRegisterContents(db, orgId, boardKey);
    /*
     * The board's own configuration, last and through the canonical primitive.
     *
     * `deleteBoardStructure` clears the eight board-scoped configuration tables
     * and the board row, and it deliberately deletes no item, file, site or
     * contractor — that is its whole contract and a test holds it. Everything
     * above is what makes calling it safe here: by this line the register is
     * genuinely empty.
     */
    await deleteBoardStructure(db, orgId, boardKey);
  }

  /* Its remembered views and its name in every stored arrangement. Not done
     when the section merely went to the bin — an arrangement is somebody's work
     and a restored section has to come back where they had it — so this is the
     one point at which those are discarded. */
  await forgetSectionReferences(db, orgId, sectionKey);

  await db
    .delete(workspaceSections)
    .where(
      and(
        eq(workspaceSections.organisationId, orgId),
        eq(workspaceSections.key, sectionKey),
      ),
    );

  return true;
}

/**
 * Everything filed ON a register, destroyed — the half `deleteBoardStructure`
 * is not allowed to do.
 *
 * Items first, because purging one deletes its files and its public links, and
 * a link that outlives its job is a no-login credential waiting for the id to
 * be reissued (see `purgeJobRow`). Columns second, so a file column's uploads
 * go with it. Then the comment thread, the per-item activity, and any cell that
 * somehow survived both.
 */
async function purgeRegisterContents(db: Database, orgId: string, boardKey: string) {
  /*
   * Live placements AND the register's own bin entries, together.
   *
   * A row deleted yesterday has no placement — binning LIFTS it — so reading
   * only `maintenance_group_items` would leave every recently-deleted row of
   * this register behind, still flagged deleted, pointing at a board that no
   * longer exists. That is the orphan the `boardBinCount` refusal existed to
   * prevent, answered here by destroying them rather than by refusing.
   */
  const placed = await db
    .select({ id: maintenanceGroupItems.requestId })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, orgId),
        eq(maintenanceGroupItems.boardId, boardKey),
      ),
    );
  const binned = await db
    .select({ id: recycleBin.entityId })
    .from(recycleBin)
    .where(
      and(
        eq(recycleBin.organisationId, orgId),
        eq(recycleBin.boardId, boardKey),
        eq(recycleBin.entityType, "job"),
      ),
    );

  const itemIds = new Set([
    ...placed.map((row) => row.id),
    ...binned.map((row) => row.id),
  ]);
  for (const id of itemIds) {
    // Subitems and their own bin entries go with each parent. See `purgeJob`.
    await purgeJob(db, orgId, id);
  }

  const columns = await db
    .select({ id: maintenanceBoardColumns.id })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardKey),
      ),
    );
  for (const column of columns) {
    await purgeColumn(db, orgId, column.id);
  }

  /* The update thread and its likes. `item_update_likes` is keyed on the update
     rather than the board, so the ids have to be named — chunked, because a
     busy register can carry more of them than D1 will bind in one statement. */
  const updates = await db
    .select({ id: itemUpdates.id })
    .from(itemUpdates)
    .where(and(eq(itemUpdates.organisationId, orgId), eq(itemUpdates.boardId, boardKey)));
  for (const chunk of chunkIds(updates.map((row) => row.id), 90)) {
    await db
      .delete(itemUpdateLikes)
      .where(
        and(
          eq(itemUpdateLikes.organisationId, orgId),
          inArray(itemUpdateLikes.updateId, chunk),
        ),
      );
  }
  await db
    .delete(itemUpdates)
    .where(and(eq(itemUpdates.organisationId, orgId), eq(itemUpdates.boardId, boardKey)));
  await db
    .delete(itemActivity)
    .where(and(eq(itemActivity.organisationId, orgId), eq(itemActivity.boardId, boardKey)));
  /* Defensive, and by board rather than by row: a cell whose item or column was
     already gone before this ran has nothing left to be reached through. */
  await db
    .delete(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.organisationId, orgId),
        eq(maintenanceBoardCells.boardId, boardKey),
      ),
    );

  await purgeInstanceRegisterRows(db, orgId, boardKey);

  /*
   * The register's remaining bin entries — its views, its columns, its groups.
   *
   * NOT the section's own entry: that one is the caller's, and `sweepRecycleBin`
   * and the DELETE handler both remove it only after this returns true.
   */
  await db
    .delete(recycleBin)
    .where(
      and(
        eq(recycleBin.organisationId, orgId),
        eq(recycleBin.boardId, boardKey),
        ne(recycleBin.entityType, SECTION_ENTITY_TYPE),
      ),
    );
}

/**
 * The rows a Sites or Contractors instance holds — destroyed, or sent home.
 *
 * See the ownership note on `purgeSection`. A row nothing outside the bundle
 * points at is destroyed with its own satellites; one that is still referenced
 * has `board_id` set back to `CANONICAL_REGISTER` and appears in the
 * workspace's own register, where it is visible and a person can decide.
 */
async function purgeInstanceRegisterRows(
  db: Database,
  orgId: string,
  boardKey: string,
) {
  const totalOf = async (statements: Array<Promise<Array<{ value: unknown }>>>) => {
    let total = 0;
    for (const statement of statements) {
      const [row] = await statement;
      total += Number(row?.value ?? 0);
    }
    return total;
  };

  const ownedSites = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.organisationId, orgId), eq(sites.boardId, boardKey)));
  const ownedContractors = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.organisationId, orgId), eq(contractors.boardId, boardKey)));
  const ownedGroups = await db
    .select({ id: siteGroups.id })
    .from(siteGroups)
    .where(and(eq(siteGroups.organisationId, orgId), eq(siteGroups.boardId, boardKey)));

  /* ── contractors ── */
  for (const { id } of ownedContractors) {
    /* Everything outside this bundle that still names the contractor. The
       bundle's own jobs are already gone by the time this runs, so anything
       counted here belongs to somebody else's register. */
    const referenced = await totalOf([
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            eq(maintenanceRequests.contractorId, id),
          ),
        ),
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(quotations)
        .where(and(eq(quotations.organisationId, orgId), eq(quotations.contractorId, id))),
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(invoices)
        .where(and(eq(invoices.organisationId, orgId), eq(invoices.contractorId, id))),
    ]);
    if (referenced > 0) {
      await db
        .update(contractors)
        .set({ boardId: CANONICAL_REGISTER })
        .where(and(eq(contractors.organisationId, orgId), eq(contractors.id, id)));
      continue;
    }
    await db
      .delete(contractorSites)
      .where(
        and(eq(contractorSites.organisationId, orgId), eq(contractorSites.contractorId, id)),
      );
    await db
      .delete(contractorCertifications)
      .where(
        and(
          eq(contractorCertifications.organisationId, orgId),
          eq(contractorCertifications.contractorId, id),
        ),
      );
    await db
      .delete(registerValues)
      .where(
        and(
          eq(registerValues.organisationId, orgId),
          eq(registerValues.registerKey, "contractors"),
          eq(registerValues.entityId, id),
        ),
      );
    await purgeAttachmentsOf(db, orgId, eq(attachments.contractorId, id));
    await db
      .delete(contractors)
      .where(and(eq(contractors.organisationId, orgId), eq(contractors.id, id)));
  }

  /* ── sites ── */
  for (const { id } of ownedSites) {
    const referenced = await totalOf([
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(units)
        .where(and(eq(units.organisationId, orgId), eq(units.siteId, id))),
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(plannedMaintenance)
        .where(
          and(
            eq(plannedMaintenance.organisationId, orgId),
            eq(plannedMaintenance.siteId, id),
          ),
        ),
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(complianceDocuments)
        .where(
          and(
            eq(complianceDocuments.organisationId, orgId),
            eq(complianceDocuments.siteId, id),
          ),
        ),
      db
        .select({ value: sql<number>`COUNT(*)` })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.organisationId, orgId),
            eq(maintenanceRequests.siteId, id),
          ),
        ),
    ]);
    if (referenced > 0) {
      await db
        .update(sites)
        .set({ boardId: CANONICAL_REGISTER })
        .where(and(eq(sites.organisationId, orgId), eq(sites.id, id)));
      continue;
    }
    await db
      .delete(siteAliases)
      .where(and(eq(siteAliases.organisationId, orgId), eq(siteAliases.siteId, id)));
    await db
      .delete(siteGroupMembers)
      .where(and(eq(siteGroupMembers.organisationId, orgId), eq(siteGroupMembers.siteId, id)));
    await db
      .delete(contractorSites)
      .where(and(eq(contractorSites.organisationId, orgId), eq(contractorSites.siteId, id)));
    await db
      .delete(registerValues)
      .where(
        and(
          eq(registerValues.organisationId, orgId),
          eq(registerValues.registerKey, "sites"),
          eq(registerValues.entityId, id),
        ),
      );
    await purgeAttachmentsOf(db, orgId, eq(attachments.siteId, id));
    await db.delete(sites).where(and(eq(sites.organisationId, orgId), eq(sites.id, id)));
  }

  /* ── reporting groups ── */
  for (const { id } of ownedGroups) {
    await db
      .delete(siteGroupMembers)
      .where(
        and(eq(siteGroupMembers.organisationId, orgId), eq(siteGroupMembers.siteGroupId, id)),
      );
    await db
      .delete(siteGroups)
      .where(and(eq(siteGroups.organisationId, orgId), eq(siteGroups.id, id)));
  }
}

/**
 * Files matching one condition, out of storage and then out of the database.
 *
 * The same order and the same tolerance as `purgeJobRow`: the objects first,
 * then the rows that point at them, and a bucket that is unavailable does not
 * wedge a thirty-day-old entry in the bin for ever. A stranded object is
 * recoverable; a bin that never empties is not.
 */
async function purgeAttachmentsOf(
  db: Database,
  orgId: string,
  condition: ReturnType<typeof eq>,
) {
  const where = and(eq(attachments.organisationId, orgId), condition);
  const files = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(where);
  if (!files.length) return;

  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
  if (runtimeEnv.BUCKET) {
    for (const keys of chunkIds(files.map((file) => file.objectKey), 1000)) {
      await runtimeEnv.BUCKET.delete(keys);
    }
  }
  await db.delete(attachments).where(where);
}
