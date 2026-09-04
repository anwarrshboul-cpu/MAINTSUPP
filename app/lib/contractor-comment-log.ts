/**
 * The Main Table's "Contractor Comments" column, and the log inside it — the
 * PURE half.
 *
 * Split from `contractor-comments.ts` so the rule can be tested by RUNNING it.
 * That module reaches the database, and reaching the database pulls
 * `board-registry` -> `chatgpt-auth` -> `next/headers` into the graph, which a
 * `node --test` process cannot resolve. Everything here is a string in and a
 * string out; the only import is the product's single date formatter, which
 * imports nothing itself.
 *
 * The reasoning for the column — why it is a board cell rather than
 * `maintenance_requests.completion_note`, and what "preserve history" means
 * when a cell has a ceiling — is in `contractor-comments.ts`, beside the writer.
 */

import { formatDate } from "./format-date";

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
