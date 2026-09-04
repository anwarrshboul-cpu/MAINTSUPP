/**
 * W13 — WHAT A HEADER DROP MEANS, AS ARITHMETIC.
 *
 * The gesture in `contractor-column-drag.ts` answers "which gap is the pointer
 * over"; this answers "and what order does dropping there produce". Split for
 * the same reason `board-column-drag.ts` is split from its gesture: everything
 * here is pure — same input, same output, no DOM, no React, no state — so the
 * index arithmetic can be tested against numbers rather than against a browser,
 * and that is where the off-by-ones in a column drag actually live.
 *
 * ── THE TWO INDEX SPACES, AND WHY THEY ARE NOT THE SAME ONE ──────────────
 *
 * A register column drag has to reconcile two lists that do not line up:
 *
 *   THE DRAWN RUN — the columns a reader can see and drop between, in the order
 *   they are on screen. The frozen lane is not in it (it cannot be carried and
 *   nothing may go to its left), and neither is any hidden column. This is what
 *   the pointer is measured against, so `insertBefore` counts gaps in THIS.
 *
 *   THE STORED ORDER — every column the register holds, hidden ones included,
 *   which is what `reorderRegisterColumns` rewrites and what a reload draws
 *   from. `orderAfterMove` in `register-client.ts` operates on this.
 *
 * Counting positions on the table and using the answer against the stored list
 * is exactly the defect `stepNeighbour` was written to close: the owner's
 * register holds 22 hidden columns at sparse positions, so "one to the right on
 * screen" and "one to the right in the list" are almost never the same move.
 * The translation between the two happens here, once, and is named.
 */

import {
  orderAfterMove,
  orderAfterStep,
  type RegisterColumn,
} from "./register/register-client";

/**
 * The order a header drop produces, or null when there is nothing to write.
 *
 * Null rather than "the order unchanged" so a caller can tell "the reader
 * dropped it back where it started" from "the reader moved it", and not put a
 * reorder in the audit log for a gesture that changed nothing.
 *
 * @param columns     Every column the register holds, in stored order.
 * @param drawnIds    The ids of the columns a drag may pick up and drop
 *                    between, in the order they are drawn. The frozen lane and
 *                    every hidden column are already out of this.
 * @param columnId    The column being carried, by database id.
 * @param insertBefore The gap the pointer was over, as an index into `drawnIds`
 *                    — expressed against the order that STILL INCLUDES the
 *                    carried column, which is what the pointer is actually
 *                    over. `drawnIds.length` means "after everything".
 * @param frozenKey   The key of the column no move may cross, or null. Passed
 *                    rather than defaulted because this register's frozen lane
 *                    can be the identity FALLBACK — a column carrying no pin
 *                    for `orderAfterStep`'s own default to read.
 */
export function orderAfterHeaderDrop(
  columns: readonly RegisterColumn[],
  drawnIds: readonly string[],
  columnId: string,
  insertBefore: number,
  frozenKey: string | null = null,
): string[] | null {
  const from = drawnIds.indexOf(columnId);
  if (from < 0 || drawnIds.length === 0) return null;

  /*
   * STEP 1 — LIFT IT OUT. Every gap to the RIGHT of where the column sits
   * shifts left by one once the column is removed from the run. This is the
   * same adjustment `moveColumnTo` makes in `board-column-drag.ts`; it is done
   * here rather than by calling that helper because what has to come out of it
   * is an index into the STORED list, not a rearranged array of lanes.
   */
  const landing = Math.min(
    Math.max(insertBefore > from ? insertBefore - 1 : insertBefore, 0),
    drawnIds.length - 1,
  );
  if (landing === from) return null;

  /*
   * STEP 2 — NAME THE SLOT BY WHOEVER IS IN IT. The column currently occupying
   * the landing slot is the one the carried column has to end up in the place
   * of, and its index in the STORED list is the target `orderAfterMove` wants.
   * Translating through a column rather than through a count is what keeps the
   * hidden ones from being miscounted.
   */
  const neighbourId = drawnIds[landing];
  const moving = columns.find((column) => column.id === columnId);
  const target = columns.findIndex((column) => column.id === neighbourId);
  if (!moving || target < 0) return null;

  /*
   * STEP 3 — THE WHOLE ORDER, AND ONE PLACE ON THE TABLE IS A PRESS.
   *
   * `orderAfterMove` already delegates a one-place move to `orderAfterStep` —
   * but its test for "one place" is `|target - from| === 1` on the STORED list,
   * and on a register like the owner's that is almost never true of a
   * one-column drag: `availability` and `policyNumber` are neighbours on the
   * table with two hidden columns between them in the list. So the delegation
   * silently never fired for the surface it was written for, and a drag of one
   * place took the splice branch instead.
   *
   * WHY THE DIFFERENCE MATTERS, given both produce the same TABLE. A press is a
   * SWAP of two entries: every column the gesture did not name keeps its index,
   * so Move right followed by Move left restores the exact order that was
   * there. The splice does not — it drags the run of hidden columns between the
   * two along with it, and the pair leaves the columns panel's checklist
   * rearranged. `orderAfterStep`'s own header sets this out; all this does is
   * ask the question in the index space where it is actually meaningful.
   *
   * Anything further than one place on the table is a real drop at a real index
   * and keeps the splice, which is `orderAfterMove`'s job.
   */
  const order =
    Math.abs(landing - from) === 1
      ? orderAfterStep(columns, moving.key, landing - from, frozenKey)
      : orderAfterMove(columns, moving.key, target);
  // A drop the ordering rules refused — the frozen column's neighbour, in
  // practice. Nothing changed, so nothing is sent.
  const unchanged = order.every((key, index) => key === columns[index]?.key);
  return unchanged ? null : order;
}
