/**
 * The Main Table's "Contractor Comments" column, and the log inside it.
 *
 * WHY IT EXISTS. Owner Part 7: what a contractor writes in the Fix Tracker must
 * appear on the canonical job, in a column a coordinator can see without
 * opening anything. Before this, a contractor's comment reached three places —
 * `item_updates` (the durable record), `activity_log` (what the drawer's
 * Updates tab renders) and `maintenance_requests.comment_count` (the bubble on
 * the row) — and none of them is a column on the Main Table. The board showed a
 * number and no words.
 *
 * WHY IT IS A BOARD COLUMN AND NOT A FIELD ON THE JOB.
 *
 * The obvious home was `maintenance_requests.completion_note`, and it is the
 * wrong one, for reasons the repository already wrote down:
 *
 *   · `tests/counters-origin-and-write-path.test.mjs` — "`completion_note` is a
 *     single column, NOT a log: a note probe overwrites whatever a coordinator
 *     had put there, and `/api/maintenance` PATCH cannot put it back, because
 *     `request-fields.ts` DELIBERATELY does not expose that column to the field
 *     editor."
 *   · `app/api/job-link/[token]/route.ts` — every submission REPLACES it, on
 *     purpose ("ONLY WHAT WAS SENT").
 *
 * Turning that field into an append-only log would break both decisions at
 * once. So the log lives where every other per-job, per-column value on this
 * board lives: `maintenance_board_cells`, under a column of its own. That costs
 * no migration, works identically on SQLite and Postgres, renders through the
 * board's existing `long_text` cell, exports through the existing CSV, and is
 * editable by a coordinator who wants to tidy it — all of which a bespoke field
 * would have had to be given one at a time.
 *
 * The column is NOT a system column, and that is load-bearing: `update_cell`
 * refuses a system column outright, because a system cell shadows the job field
 * it draws. This column draws no field. It shadows nothing.
 *
 * WHAT "PRESERVE HISTORY" MEANS HERE. Every comment is still its own row in
 * `item_updates`, for ever — that is the record, and nothing in this file can
 * shorten it. The column is the readable digest of that record: newest first,
 * each entry stamped with when it was written and who wrote it, and capped at
 * what a `long_text` cell may hold (5,000 characters — `normalizeBoardCellValue`).
 * Past the cap the OLDEST whole entries fall off and the cell says so, pointing
 * at the Updates tab. A comment is never silently replaced.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { maintenanceBoardCells, maintenanceBoardColumns } from "../../db/schema";
import { setBoardCell } from "./board-mutations";
import { boardKeyForRequest } from "./board-registry";
import { formatDate } from "./format-date";

type CommentDatabase = Awaited<ReturnType<typeof getDb>>;

/** The board column key. One spelling, used by the seeder and by the writer. */
export const CONTRACTOR_COMMENTS_KEY = "contractorComments";
export const CONTRACTOR_COMMENTS_TITLE = "Contractor Comments";

/**
 * What a `long_text` cell may hold — `normalizeBoardCellValue` trims to this,
 * and trimming a LOG at an arbitrary character is how the newest comment ends
 * mid-word. Kept in step deliberately: this file does the trimming itself, at
 * an entry boundary, and says that it did.
 */
export const CONTRACTOR_COMMENTS_LIMIT = 5000;

const OVERFLOW_NOTE =
  "…older comments are not shown here. The full history is in the job's Updates tab.";

const SEPARATOR = "\n\n";

/**
 * The log with one more comment on the front.
 *
 * PURE, so the rule can be tested without a database, and NEWEST FIRST, because
 * a board cell shows its first line and the first line a coordinator wants is
 * the latest thing the contractor said.
 *
 * `at` is a parameter rather than a call to the clock so every entry in one
 * write agrees about the time and so this is testable without freezing it.
 */
export function appendContractorComment(
  existing: string | null | undefined,
  entry: { body: string; author?: string | null; at: Date },
): string {
  const body = entry.body.trim();
  if (!body) return (existing ?? "").trim();

  const author = (entry.author ?? "").trim() || "Contractor";
  const stamp = `${formatDate(entry.at.toISOString())} · ${author}`;
  const head = `${stamp}\n${body}`;

  const previous = (existing ?? "")
    .trim()
    // A previous overflow note is not history; it is a marker, and it is
    // re-added below if it is still true. Left in place it would accumulate.
    .split(SEPARATOR)
    .filter((block) => block.trim() && block.trim() !== OVERFLOW_NOTE);

  const blocks = [head, ...previous];

  // Drop the OLDEST whole entries until it fits, then say that it happened.
  let dropped = false;
  while (blocks.length > 1 && blocks.join(SEPARATOR).length > CONTRACTOR_COMMENTS_LIMIT) {
    blocks.pop();
    dropped = true;
  }
  if (dropped) {
    blocks.push(OVERFLOW_NOTE);
    while (blocks.length > 2 && blocks.join(SEPARATOR).length > CONTRACTOR_COMMENTS_LIMIT) {
      blocks.splice(blocks.length - 2, 1);
    }
  }

  /*
   * A single comment longer than the cell itself is cut, and only then — the
   * one case where a character boundary is unavoidable, because there is no
   * entry boundary left to cut at. The whole thing is still in `item_updates`.
   */
  const joined = blocks.join(SEPARATOR);
  return joined.length > CONTRACTOR_COMMENTS_LIMIT
    ? joined.slice(0, CONTRACTOR_COMMENTS_LIMIT)
    : joined;
}

/**
 * The id of this board's Contractor Comments column, creating it if the board
 * has never had one.
 *
 * `onConflictDoNothing` against the `(organisation_id, board_id, key)` unique
 * index does two jobs at once: it makes this safe to call on every board load,
 * and it means a column an admin has DELETED is not resurrected — a binned
 * column keeps its key, so the insert is discarded and this returns the binned
 * row's id, which `setBoardCell` will still write to and the board will not
 * draw. Deleting the column is therefore a decision the product honours.
 *
 * `position` is deliberately past the system columns rather than interleaved
 * with them: the board stores positions in thousands and an admin's own
 * ordering must not be disturbed by a column appearing.
 */
export async function ensureContractorCommentsColumn(
  db: CommentDatabase,
  orgId: string,
  boardId: string,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: maintenanceBoardColumns.id })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.key, CONTRACTOR_COMMENTS_KEY),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  /*
   * Deterministic, and NAMING THE BOARD.
   *
   * `tenantSeedId("column-system-<key>", orgId)` does not name the board, which
   * is exactly the defect recorded in `/api/board`'s seeding comment: on a
   * second board every insert collided with the first board's row and was
   * discarded, leaving an empty board and no error. This id cannot do that.
   */
  const id = `column-${CONTRACTOR_COMMENTS_KEY}-${boardId}-${orgId}`;
  await db
    .insert(maintenanceBoardColumns)
    .values({
      id,
      organisationId: orgId,
      boardId,
      key: CONTRACTOR_COMMENTS_KEY,
      title: CONTRACTOR_COMMENTS_TITLE,
      type: "long_text",
      position: 90_000,
      width: 260,
      settings: JSON.stringify({ wrap: true }),
      // NOT a system column — see the header. A system cell is refused by
      // `update_cell`, and this value is a cell.
      system: false,
    })
    .onConflictDoNothing();

  const [created] = await db
    .select({ id: maintenanceBoardColumns.id })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardId),
        eq(maintenanceBoardColumns.key, CONTRACTOR_COMMENTS_KEY),
      ),
    )
    .limit(1);
  return created?.id ?? null;
}

/**
 * Files a contractor's comment into the canonical job's Contractor Comments
 * column.
 *
 * ONE JOB, the one the caller has already scoped. Every statement is bounded by
 * `orgId` and `requestId`; nothing here reads a job id from a request body, and
 * the board is resolved from the job's own placement (`boardKeyForRequest`)
 * rather than from the literal "maintenance", so a work order on a section's
 * register files into that register's column.
 *
 * Best-effort by design: the caller has already recorded the comment in
 * `item_updates` and `activity_log`, which are the durable record. A board that
 * could not be resolved must not fail a contractor's submission after their
 * words are already saved — it must leave the digest behind, and the words in
 * the place they are actually kept.
 */
export async function recordContractorComment(
  db: CommentDatabase,
  orgId: string,
  requestId: string,
  entry: { body: string; author?: string | null; at?: Date },
): Promise<{ filed: boolean; columnId?: string }> {
  if (!entry.body.trim()) return { filed: false };
  try {
    const boardId = await boardKeyForRequest(db, orgId, requestId);
    const columnId = await ensureContractorCommentsColumn(db, orgId, boardId);
    if (!columnId) return { filed: false };

    /*
     * Read, then modify, then write — through `setBoardCell`, the one writer of
     * cells in this codebase and the one the board's own editor and the
     * automation engine both go through.
     *
     * Two coordinators commenting in the same second can still lose one from
     * the DIGEST; neither can lose one from `item_updates`, which is exactly
     * why that is the record and this is the summary.
     */
    const [cell] = await db
      .select({ value: maintenanceBoardCells.value })
      .from(maintenanceBoardCells)
      .where(
        and(
          eq(maintenanceBoardCells.organisationId, orgId),
          eq(maintenanceBoardCells.boardId, boardId),
          eq(maintenanceBoardCells.requestId, requestId),
          eq(maintenanceBoardCells.columnId, columnId),
        ),
      )
      .limit(1);

    const next = appendContractorComment(cell?.value ?? "", {
      body: entry.body,
      author: entry.author ?? null,
      at: entry.at ?? new Date(),
    });
    await setBoardCell(db, orgId, boardId, requestId, columnId, next);
    return { filed: true, columnId };
  } catch {
    return { filed: false };
  }
}
