/**
 * Trash — the deletion HISTORY, beside the bin.
 *
 * A DECISION WAS REVERSED HERE. THE OLD ONE IS RECORDED, NOT ERASED.
 *
 * This route used to say, correctly, that MAINTSUPP had no recycle bin: no
 * table in `db/schema.ts` carried a `deleted_at`, every delete path was a real
 * `DELETE FROM`, and so the screen showed a deletion history and refused to
 * grow a Restore button it could not honour. `recoverable: false` was the flag
 * that said so, and a test failed the moment a soft-delete column landed so the
 * claim could not quietly become false.
 *
 * The owner asked for the opposite: "when someone deleted something we should
 * have backup for 30 days and where he can find also the deleted section —
 * check monday.com". That is an instruction about what the product should be,
 * and the old reasoning was only ever a description of what it was. Stage 23
 * added `maintenance_requests.deleted_at`, `maintenance_groups.deleted_at` and
 * the `recycle_bin` table; `/api/trash` now serves a real bin with a real
 * Restore. The old test was rewritten to guard the NEW invariant — that the bin
 * exists and works — rather than deleted.
 *
 * WHAT THIS ROUTE STILL IS, and why it was not replaced by the bin:
 *
 * The bin holds what can still be brought back. This holds the record that a
 * deletion HAPPENED — including every deletion from before Stage 23, which is
 * unrecoverable and always will be, and every permanent purge since, which is
 * unrecoverable by design. `activity_log` and `audit_events` are append-only;
 * they are the only surviving trace once a bin entry is purged, and deleting
 * this screen in favour of the bin would have thrown away the history of
 * everything the bin is too late to help with.
 *
 * So the Trash screen shows both, in that order: what you can get back, then
 * what was deleted. This route serves the second half.
 */

import { and, desc, eq, like, or } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, auditEvents } from "../../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

/**
 * The entities a reader might expect to find in a bin, and the truth for each.
 *
 * Kept as data rather than prose so the screen can render it as a table.
 *
 * Stage 23 changed the first two rows from `softDelete: false` to true and
 * nothing else. That is the honest shape of this reversal: the bin covers what
 * a person actually deletes from a board, and the rest of this table is still
 * the list of things that go for good. A row here claiming recovery it does not
 * have would be exactly the failure the original version of this file was
 * written to avoid, and adding a bin is not a licence to start guessing.
 */
const RECOVERY_MATRIX = [
  {
    entity: "Jobs",
    table: "maintenance_requests",
    softDelete: true,
    archivable: true,
    note: "Deleting a job moves it to the recycle bin for 30 days. Restore puts it back in its group, at the position it held. Archive is still there for something you expect to keep.",
  },
  {
    entity: "Board groups",
    table: "maintenance_groups",
    softDelete: true,
    archivable: true,
    note: "Deleting a group moves it to the recycle bin for 30 days. Its items are moved to the group you choose first, so what comes back is the group itself — name, colour and position.",
  },
  {
    entity: "Boards",
    table: "boards",
    softDelete: false,
    archivable: true,
    note: "Deleting a board removes the row. Archiving is reversible.",
  },
  {
    /*
     * W2C — the biggest recoverable object in the product, and the newest.
     *
     * Deleting a workspace section moves the SECTION AND ITS REGISTER to the
     * bin as one entry: its rows and subitems, its columns, groups and views,
     * its form and its share token, its files, and any sites or contractors
     * created inside it. Nothing is taken apart to get there — the section is
     * the only door onto a `sec-` register, so hiding it hides the bundle —
     * which is what makes Restore a single act rather than a hundred.
     *
     * `archivable: true` as well, and the two are genuinely different promises:
     * "Remove" archives the section indefinitely and leaves every row in place,
     * "Delete" starts the 30-day countdown over all of it.
     */
    entity: "Workspace sections",
    table: "workspace_sections",
    softDelete: true,
    archivable: true,
    note: "Deleting a section moves it to the recycle bin for 30 days WITH its register — the items on it, their files, its columns, groups, views and form, and any sites or contractors created inside it. It appears as one entry and comes back as one. Removing a section instead archives it: it leaves every sidebar and nothing else changes. Only the product's own sections cannot be deleted this way.",
  },
  {
    entity: "Board views",
    table: "board_views",
    softDelete: true,
    archivable: false,
    note: "Deleting a view moves it to the recycle bin for 30 days. Restore brings back its name, icon, saved filters, saved sort and its place on the strip.",
  },
  {
    entity: "Board columns",
    table: "maintenance_board_columns",
    softDelete: true,
    archivable: false,
    note: "Deleting a column moves it to the recycle bin for 30 days, and every value it holds stays with it — nothing is discarded until somebody chooses \"Delete for good\" or the 30 days run out. Restore puts the column back at its old position, width, pin and summary, with its values. Hiding a column is different again: it stays on the board and only stops being drawn.",
  },
  {
    entity: "Files and evidence",
    table: "attachments",
    softDelete: false,
    archivable: false,
    note: "A file deleted on its own is gone, including the stored object. Files attached to a DELETED JOB are different: they go to the bin with the job and come back with it.",
  },
  {
    entity: "Sites and units",
    table: "sites, units",
    softDelete: false,
    archivable: false,
    note: "Closing a site or retiring a unit keeps the row and is reversible. Neither is deleted.",
  },
  {
    entity: "Contractors",
    table: "contractors",
    softDelete: false,
    archivable: true,
    note: "Contractors are never deleted. Removing one marks it inactive and unavailable, which is reversible from the Contractors screen; the jobs it worked keep pointing at it.",
  },
  {
    entity: "Teams",
    table: "teams",
    softDelete: false,
    archivable: true,
    note: "Teams archive rather than delete; restore them from the Teams screen.",
  },
] as const;

export async function GET(request: Request) {
  await ensureDatabase();
  try {
    const context = await scopedDb(request);
    const orgId = context.orgId;

    const [activityRows, auditRows] = await Promise.all([
      context.db
        .select({
          id: activityLog.id,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          action: activityLog.action,
          actorEmail: activityLog.actorEmail,
          detail: activityLog.detail,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.organisationId, orgId),
            or(
              like(activityLog.action, "%delete%"),
              like(activityLog.action, "%remove%"),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(100),
      context.db
        .select({
          id: auditEvents.id,
          entityType: auditEvents.entityType,
          entityId: auditEvents.entityId,
          action: auditEvents.action,
          actorEmail: auditEvents.actorEmail,
          summary: auditEvents.summary,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organisationId, orgId),
            or(
              like(auditEvents.action, "%delete%"),
              like(auditEvents.action, "%remove%"),
            ),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(100),
    ]);

    const deletions = [
      ...activityRows.map((row) => ({
        id: row.id,
        source: "activity_log" as const,
        entityType: row.entityType,
        entityId: row.entityId,
        action: row.action,
        actor: row.actorEmail,
        summary: summarise(row.detail),
        createdAt: row.createdAt,
      })),
      ...auditRows.map((row) => ({
        id: row.id,
        source: "audit_events" as const,
        entityType: row.entityType ?? "unknown",
        entityId: row.entityId ?? "",
        action: row.action,
        actor: row.actorEmail,
        summary: row.summary,
        createdAt: row.createdAt,
      })),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return Response.json({
      trash: {
        /**
         * Stage 23 flipped this, and the comment that used to sit here said
         * flipping it would be "the single change needed once a soft-delete
         * column exists". That was wrong, and it is worth recording why: the
         * column was the easy part. The work was the twenty-odd read paths that
         * had to stop returning deleted rows, the placement snapshot that makes
         * a restore land in the right group, and deciding what sweeps the 30
         * days in a project with no cron.
         */
        recoverable: true,
        reason:
          "Deleted jobs and board groups go to the recycle bin for 30 days and can be restored from there. Everything else in the table below is deleted for good.",
        recoveryMatrix: RECOVERY_MATRIX,
        deletions,
        deletionCount: deletions.length,
      },
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "The trash could not be loaded.",
      },
      { status: 503 },
    );
  }
}

/** Pull a human name out of the JSON detail blob, falling back to the blob. */
function summarise(detail: string | null) {
  if (!detail) return "";
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    for (const key of ["fileName", "name", "title", "label", "value"]) {
      const value = parsed[key];
      if (typeof value === "string" && value) return value;
    }
  } catch {
    // Not JSON — show the raw detail, truncated by the caller.
  }
  return detail.slice(0, 160);
}

/**
 * Emptying the bin lives at `DELETE /api/trash`, not here.
 *
 * This route serves a HISTORY, and a history is append-only — `activity_log`
 * and `audit_events` have no delete path anywhere in this codebase, which is a
 * property `tests/stage-twenty-teams-audit.test.mjs` asserts rather than
 * assumes. Answering anything but a refusal here would mean inventing one.
 *
 * The 409 is unchanged from before Stage 23; only its reason is different. It
 * used to mean "there is no bin". It now means "the bin is not here".
 */
export async function DELETE() {
  return Response.json(
    {
      error:
        "This is the deletion history and it cannot be erased. To empty the recycle bin, use DELETE /api/trash?all=true.",
    },
    { status: 409 },
  );
}
