/**
 * The number of photographs a job HAS, counted the way the board counts them.
 *
 * THE BUG THIS EXISTS FOR.
 *
 * `maintenance_requests` carries four denormalised counters —
 * `attachment_count`, `issue_attachment_count`, `completed_attachment_count`,
 * `general_attachment_count` — and every surface that says "2 photos" without
 * opening anything reads one of them: the mobile job card, the board's sort by
 * picture count, the Fix Tracker card, the CSV export.
 *
 * On the preview workspace job `MN-1055` those counters read
 * `issue=3, completion=1, general=1` — five photographs — against exactly three
 * rows in `attachments`, of which precisely ONE was an issue photograph. The
 * table promised the coordinator two fault photographs that had never existed;
 * the public job page, which counts rows, correctly showed none. The number
 * people trusted was the one that was wrong.
 *
 * It was not a single bad writer. All sixteen jobs in that workspace had a
 * correct `attachment_count` and drifting per-kind counters, and the drift had
 * one shape: the issue counter equalled the TOTAL at the moment the job's true
 * issue count was zero. That is `db/init.ts`'s legacy back-fill —
 *
 *     UPDATE maintenance_requests SET issue_attachment_count = attachment_count
 *      WHERE attachment_count > 0 AND issue_attachment_count = 0
 *
 * — written for migration 0002, when there was only one kind of attachment, and
 * still running on every cold start. Upload a completion photograph to a job
 * with no fault photographs and the next boot declares that completion
 * photograph to be a fault photograph. It re-corrupts a corrected row the
 * moment the row's true issue count returns to zero, which is why "just fix the
 * data" is not a fix.
 *
 * WHY DERIVE RATHER THAN CHASE THE WRITERS.
 *
 * There are six increment/decrement sites across three routes plus an importer,
 * a repair script and that boot statement, and `attachments.kind` can be
 * rewritten underneath all of them (`scripts/repair-attachment-kinds.mjs`
 * reclassified 2,915 rows) without any of them being told. A counter with that
 * many writers and no reconciler drifts — `db/schema.ts` says so about
 * `item_update_likes`, having already been bitten here.
 *
 * So the rows are the record and this is the reconciler. The stored counters
 * stay (they are what a bare `SELECT *` returns, and nothing has to be migrated
 * to stop trusting them), but every payload that leaves the server has them
 * REPLACED with a count of the rows behind them.
 *
 * BY COLUMN FIRST, THEN BY KIND — THE BOARD'S OWN RULE, NOT A NEW ONE.
 *
 * This is the part that makes the numbers agree rather than merely making them
 * defensible. `/api/board` draws the "Pictures of Maintenance Issue" and
 * "Picture of completed works" cells from rows filed under those COLUMNS, plus
 * rows that carry the matching KIND and no column — because the monday import
 * filed 2,915 photographs by column and left `kind` at its default, while every
 * upload the app itself performs sets the kind and leaves the column null. Both
 * are the cell's photographs. `GET /api/files?columnId=…` repeats the same
 * predicate so the hover card lists exactly what the cell counted.
 *
 * Counting purely by `kind` here would have produced a THIRD answer: a job
 * whose fault photographs came from monday would show a full picture cell and
 * `issueAttachmentCount = 0`, which is the same class of contradiction this
 * module exists to end. So the rule below is the board's, verbatim:
 *
 *   · a row that names a board column is counted under THAT column — the two
 *     picture columns by name, any other file column as general evidence;
 *   · a row with no column is counted under its `kind`;
 *   · `general` is the remainder, so the three always sum to the total.
 *
 * A row whose `kind` is none of the three and which names no column therefore
 * lands in the remainder rather than being silently reassigned, which is the
 * honest place for it.
 */

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { attachments, maintenanceBoardColumns, maintenanceRequests } from "../../db/schema";
import { boardKeyForRequest } from "./board-registry";
import { chunkIds } from "./sql-batching";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * A SUPERSEDED VERSION IS NOT A SECOND PHOTOGRAPH.
 *
 * W07-03 gave documents version lineage, and versioning a counter that counts
 * ROWS is the fastest way to make it lie again — which is the exact failure this
 * whole module exists to end. A PAT certificate replaced twice is ONE document
 * with three rows: without this predicate the board's photo strip would show
 * three tiles for it, the job card would say "3 photos", the CSV export would
 * agree, and the compliance register's `fileCount > 0` would keep a slot
 * "Compliant" on the strength of a certificate that had been replaced precisely
 * because it expired.
 *
 * Archived rows are excluded for the same reason from the other direction:
 * archiving is the reversible half of "archive or remove" (W07-05), so an
 * archived document must leave the counters exactly as deleting it would, or
 * archiving would be visibly different from removing and nobody would trust it.
 *
 * Both columns carry defaults that reproduce the pre-versioning meaning —
 * `is_current = true`, `archived_at = NULL` — so every row that existed before
 * this satisfies the predicate untouched and no back-fill was needed.
 *
 * Built with drizzle's own helpers rather than written as raw SQL, because the
 * boolean has to survive both dialects: SQLite stores 0/1 and Postgres stores a
 * real `boolean`, and `db/sqlite-to-postgres.ts` rewrites the comparison on the
 * way through — which it can only do for a bound parameter it recognises, not
 * for a literal `= true` embedded in a template.
 */
export const liveAttachmentRows = () =>
  and(eq(attachments.isCurrent, true), isNull(attachments.archivedAt));

/**
 * The same predicate, kept private under its old name for this module's own use.
 *
 * Exported above because the counters are NOT the only reader that has to agree
 * about it: `/api/board` builds the file cells from its own scans of
 * `attachments`, and when those scans lacked this predicate the cell said 3 for
 * a certificate replaced twice while the counter beside it said 1 — the exact
 * contradiction this module's header exists to end, reintroduced by versioning
 * through a different door.
 */
const liveRows = liveAttachmentRows;

/** The storage kinds `attachments.kind` may actually hold. */
export type CountedKind = "issue" | "completion" | "general";

/**
 * The board column keys that MEAN something, and what they mean.
 *
 * Monday's own names for the three maintenance file columns, captured verbatim
 * in `db/monday-board-spec.ts`. A Store Documentation certificate and a file
 * column an admin added are neither, and are general evidence — which is what
 * they already were.
 *
 * The same three pairs appear in `scripts/repair-attachment-kinds.mjs`, which
 * had to work them out to undo the damage. They are declared once here so the
 * next thing that needs them does not work them out a third time.
 */
export const KIND_BY_COLUMN_KEY: Record<string, CountedKind> = {
  issuePictures: "issue",
  completedPictures: "completion",
  files: "general",
};

/**
 * What a file dropped into a given column IS.
 *
 * Used on the upload paths, where the column the operator dropped a file into
 * is better evidence of what the file is than anything the client said. An
 * unknown or absent column is general evidence.
 */
export function kindForColumnKey(key: string | null | undefined): CountedKind {
  return KIND_BY_COLUMN_KEY[key ?? ""] ?? "general";
}

/** The two picture columns of one board, by id. Either may be absent. */
export type PictureColumns = { issue: string | null; completion: string | null };

const NO_PICTURE_COLUMNS: PictureColumns = { issue: null, completion: null };

/**
 * The two picture columns of the board a job is placed on.
 *
 * Resolved from the placement rather than from the literal `"maintenance"`,
 * because Store Documentation rows live on another board and have neither of
 * these — see `boardKeyForRequest`, which exists for the same reason.
 *
 * A job whose board is gone, or which has no placement at all, yields two
 * nulls, and the counting below falls back to kind alone. That is the right
 * answer rather than a failure: an unplaced row's photographs are still its
 * photographs.
 */
export async function pictureColumnsFor(
  db: Database,
  orgId: string,
  requestId: string,
): Promise<PictureColumns> {
  let boardId: string;
  try {
    boardId = await boardKeyForRequest(db, orgId, requestId);
  } catch {
    return NO_PICTURE_COLUMNS;
  }
  const rows = await db
    .select({ id: maintenanceBoardColumns.id, key: maintenanceBoardColumns.key })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.type, "files"),
      ),
    );
  const byKey = new Map(rows.map((row) => [row.key, row.id]));
  return {
    issue: byKey.get("issuePictures") ?? null,
    completion: byKey.get("completedPictures") ?? null,
  };
}

export type AttachmentCounts = {
  attachmentCount: number;
  issueAttachmentCount: number;
  completedAttachmentCount: number;
  generalAttachmentCount: number;
};

const ZERO: AttachmentCounts = {
  attachmentCount: 0,
  issueAttachmentCount: 0,
  completedAttachmentCount: 0,
  generalAttachmentCount: 0,
};

/**
 * Which of the three a single row belongs to. The rule, in one place.
 *
 * `columns` are the ids of the board's two picture columns. `null` for either
 * means the board has no such column, in which case nothing can be filed under
 * it and only the kind can answer.
 */
function bucketFor(
  columnId: string | null,
  kind: string | null,
  columns: PictureColumns,
): CountedKind {
  if (columnId) {
    if (columns.issue && columnId === columns.issue) return "issue";
    if (columns.completion && columnId === columns.completion) return "completion";
    // Any other file column — a custom one, or a compliance slot.
    return "general";
  }
  if (kind === "issue") return "issue";
  if (kind === "completion") return "completion";
  return "general";
}

/**
 * True counts per job, for the jobs named.
 *
 * ONE aggregate query per chunk rather than one per job: `GROUP BY request_id,
 * board_column_id, kind` returns a handful of rows per job and the whole
 * board's answer arrives in the same number of round trips the board already
 * spends on its file previews. Chunked for the same reason every other
 * `IN (…)` here is — D1 counts one bound variable per element and rejects the
 * statement past its limit, which a 745-row board would cross on the first try.
 *
 * A job with no attachments has no group and therefore no entry in the map.
 * Callers read through `attachmentCountsFor`, which returns four zeroes for a
 * miss, so "absent" and "none" cannot be confused into leaving a stale counter
 * in place.
 */
export async function attachmentCountsByRequest(
  db: Database,
  orgId: string,
  requestIds: readonly string[],
  columns: PictureColumns = NO_PICTURE_COLUMNS,
): Promise<Map<string, AttachmentCounts>> {
  const counts = new Map<string, AttachmentCounts>();
  if (!requestIds.length) return counts;

  for (const chunk of chunkIds(requestIds)) {
    const rows = await db
      .select({
        requestId: attachments.requestId,
        columnId: attachments.boardColumnId,
        kind: attachments.kind,
        total: count(),
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          inArray(attachments.requestId, chunk),
          // Superseded versions and archived documents are not extra files.
          liveRows(),
        ),
      )
      .groupBy(attachments.requestId, attachments.boardColumnId, attachments.kind);

    for (const row of rows) {
      if (!row.requestId) continue;
      let entry = counts.get(row.requestId);
      if (!entry) {
        entry = { ...ZERO };
        counts.set(row.requestId, entry);
      }
      const total = Number(row.total) || 0;
      entry.attachmentCount += total;
      const bucket = bucketFor(row.columnId, row.kind, columns);
      if (bucket === "issue") entry.issueAttachmentCount += total;
      else if (bucket === "completion") entry.completedAttachmentCount += total;
      else entry.generalAttachmentCount += total;
    }
  }

  return counts;
}

/** The counts for one job, or four zeroes when it holds no attachments. */
export function attachmentCountsFor(
  counts: Map<string, AttachmentCounts>,
  requestId: string,
): AttachmentCounts {
  return counts.get(requestId) ?? ZERO;
}

/**
 * Overwrites a request row's four counters with the counted truth.
 *
 * Returns a NEW object rather than mutating: the row it is handed comes
 * straight out of drizzle and may be shared with a cache or a second
 * projection, and a reconciler that quietly rewrites its input is the kind of
 * thing that is fine until it is not.
 *
 * Applied BEFORE `exposeRequest` redacts, so the redaction list stays the one
 * place that decides what leaves the server.
 */
export function withCountedAttachments<Row extends AttachmentCounts>(
  row: Row,
  counts: Map<string, AttachmentCounts>,
  requestId: string,
): Row {
  return { ...row, ...attachmentCountsFor(counts, requestId) };
}

/**
 * Sets a job's four counters from the rows, and returns the row it wrote.
 *
 * RECOMPUTED, NEVER ADJUSTED — the rule `POST /api/updates` already follows
 * for `comment_count`, and for the same stated reason: two writers on one
 * denormalised column with no reconciler is exactly how
 * `issue_attachment_count` came to read 2,281 with no rows behind it.
 *
 * The increment it replaces was `+ 1` on the counter matching the uploaded
 * kind, and the decrement was `max(… - 1, 0)` on the counter matching the
 * deleted row's kind. Both are correct arithmetic on a number that was already
 * wrong, and neither can ever bring one back: `max(x - 1, 0)` on a counter
 * inflated to 3 by the boot back-fill still leaves 2 after the only real
 * photograph is deleted. A COUNT converges from any starting value, and a
 * repeated call is a no-op rather than a further drift, which matters because
 * the file routes retry.
 *
 * The counting itself is ONE statement — four sub-selects evaluated inside the
 * UPDATE, no read-then-write — so a second upload landing between a SELECT and
 * an UPDATE cannot lose a photograph the way an increment computed in
 * JavaScript would. `pictureColumnsFor` is a separate read, but it reads the
 * BOARD's shape rather than the job's files: a column being added or removed
 * mid-upload changes which cell a photograph is drawn in, not how many there
 * are, and the next reconcile settles it either way.
 *
 * The sub-selects are written against `attachments` in full rather than
 * filtered by organisation as well. `attachments.request_id` points at one job
 * and a job belongs to one organisation, so the extra predicate would narrow
 * nothing — and the enclosing WHERE is scoped to the tenant, so no row outside
 * it is touched.
 */
export async function reconcileAttachmentCounts(
  db: Database,
  orgId: string,
  requestId: string,
) {
  const columns = await pictureColumnsFor(db, orgId, requestId);

  /*
   * `live` is interpolated into every subquery below, so the counter and the
   * list the board draws beside it are answering the same question. A predicate
   * applied to some of the four counters and not the others would make them stop
   * summing, which is precisely the contradiction this module exists to end.
   */
  const live = liveRows();

  const total = sql`(select count(*) from ${attachments} where ${attachments.requestId} = ${requestId} and ${live})`;
  /*
   * Column first, then kind — `bucketFor` expressed in SQL. A board with no
   * such column can hold nothing under it, so the predicate collapses to the
   * kind alone rather than comparing against NULL and matching nothing.
   */
  const bucket = (columnId: string | null, kind: CountedKind) =>
    columnId
      ? sql`(select count(*) from ${attachments} where ${attachments.requestId} = ${requestId} and ${live} and (${attachments.boardColumnId} = ${columnId} or (${attachments.boardColumnId} is null and ${attachments.kind} = ${kind})))`
      : sql`(select count(*) from ${attachments} where ${attachments.requestId} = ${requestId} and ${live} and ${attachments.boardColumnId} is null and ${attachments.kind} = ${kind})`;

  const issue = bucket(columns.issue, "issue");
  const completion = bucket(columns.completion, "completion");

  const [updated] = await db
    .update(maintenanceRequests)
    .set({
      attachmentCount: total,
      issueAttachmentCount: issue,
      completedAttachmentCount: completion,
      /*
       * The remainder, so the three always sum to the total: a file in a custom
       * column, a `general` upload, and anything whose kind is none of the
       * three. Written as a subtraction rather than a fourth predicate so that
       * "general" cannot drift away from "not one of the other two" the next
       * time a column key is added.
       */
      generalAttachmentCount: sql`${total} - ${issue} - ${completion}`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
      ),
    )
    .returning();

  return updated;
}
