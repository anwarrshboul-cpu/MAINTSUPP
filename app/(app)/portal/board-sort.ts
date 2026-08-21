/**
 * The board's ordered sort — one primary column, then tie-breakers.
 *
 * WHAT CHANGED, AND WHY IT IS HERE RATHER THAN IN live-board.tsx
 *
 * The board held `{ columnId, direction } | null`. Sorting by a second column
 * silently discarded the first, so "Priority, then Due Date" — the ordering a
 * maintenance board is actually read in — could not be expressed. The state is
 * now an ORDERED LIST of rules, and the storage it round-trips through is the
 * same one the single sort already used: `settings.sort` on the column, plus a
 * `settings.sortPriority` saying where in the list it sits. A board saved before
 * this existed reads back as a one-rule list, because a column with a sort and
 * no priority is priority 0.
 *
 * It lives in its own module because it is pure — no JSX, no hooks, no fetch —
 * and because the comparator is the part that has to be right. A test can feed
 * it rows and assert the order; inside a 5,700-line component it could only be
 * eyeballed. `board-ordering.ts`, which holds the single-value comparison this
 * builds on, is at its 200-line ceiling.
 *
 * THE ORDERING RULES, which are the same ones the single sort had:
 *
 *   · an option-backed column sorts by THE ORDER ITS OPTIONS ARE DEFINED IN,
 *     not alphabetically. Priority on this board is Medium, Low, Urgent;
 *     alphabetical would put Low above Medium and present that as ascending;
 *   · EMPTY SORTS LAST IN BOTH DIRECTIONS. Reversing a sort should reverse the
 *     rows that have a value, not float the blanks to the top — on a board
 *     where most cells are still empty that reads as the sort having lost the
 *     data;
 *   · two rows that every rule calls equal fall back to their stored board
 *     position, so the order is stable between renders rather than left to the
 *     engine's sort.
 */

import type { MaintenanceRequest } from "../../lib/types";
import type { BoardDisplayColumn, ColumnKey } from "./board-model";
import {
  boardItemName,
  compareBoardValues,
  systemColumnSortValue,
} from "./board-ordering";
import { customCellKey, customCellSortValue } from "./board-format";

export type SortDirection = "asc" | "desc";

/** One column's place in the board's sort. Position in the array IS priority. */
export type BoardSortRule = { columnId: string; direction: SortDirection };

/**
 * Everything the comparator needs that is not a rule or a row.
 *
 * Passed in rather than reached for so this module keeps no state and a test
 * can build a context by hand.
 */
export type BoardSortContext = {
  boardId: string;
  /** Every column the board knows, by id. */
  columnsById: Map<string, BoardDisplayColumn>;
  cells: Record<string, string>;
  fileCounts: Record<string, number>;
  /** Business order of an option-backed system column, value or label → index. */
  optionOrderFor: (key: ColumnKey) => Map<string, number> | undefined;
  /** Where the row sits in its group when no rule separates it from another. */
  positionOf: (requestId: string) => number;
};

/**
 * The saved sort, read off the columns that carry it.
 *
 * Ordered by `sortPriority`, then by column position so two columns that were
 * hand-edited to the same priority still land in a defined order. A column with
 * a sort and no priority is priority 0 — that is exactly the shape the previous
 * single-column sort wrote, so an existing board reads back unchanged.
 */
export function readSortRules(columns: BoardDisplayColumn[]): BoardSortRule[] {
  return columns
    .filter((entry) => entry.column.settings.sort)
    .sort((left, right) => {
      const byPriority =
        (left.column.settings.sortPriority ?? 0) -
        (right.column.settings.sortPriority ?? 0);
      return byPriority || left.column.position - right.column.position;
    })
    .map((entry) => ({
      columnId: entry.column.id,
      direction: entry.column.settings.sort as SortDirection,
    }));
}

/** Where a column sits in the sort, or -1. Callers draw the 1/2/3 badge off it. */
export function sortRuleIndex(rules: BoardSortRule[], columnId: string) {
  return rules.findIndex((rule) => rule.columnId === columnId);
}

export function sortDirectionFor(rules: BoardSortRule[], columnId: string) {
  return rules.find((rule) => rule.columnId === columnId)?.direction ?? null;
}

/**
 * The fast path: sort by this column and nothing else.
 *
 * What a header click has always done, and still does. Keeping it as the
 * default is deliberate — the common case is one column, and making every quick
 * sort accumulate would leave an operator with a sort they did not ask for and
 * no obvious way back.
 */
export function replaceSortRules(
  columnId: string,
  direction: SortDirection,
): BoardSortRule[] {
  return [{ columnId, direction }];
}

/**
 * The deliberate path: add this column as the next tie-breaker.
 *
 * A column already in the sort has its direction changed rather than being
 * appended twice, so "add as subsort" on a column that is already the primary
 * sort flips it instead of producing a rule that can never fire.
 */
export function addSortRule(
  rules: BoardSortRule[],
  columnId: string,
  direction: SortDirection,
): BoardSortRule[] {
  const at = sortRuleIndex(rules, columnId);
  if (at < 0) return [...rules, { columnId, direction }];
  return rules.map((rule, index) =>
    index === at ? { columnId, direction } : rule,
  );
}

export function removeSortRule(rules: BoardSortRule[], columnId: string) {
  return rules.filter((rule) => rule.columnId !== columnId);
}

/** Flips one rule's direction, leaving its priority alone. */
export function flipSortRule(rules: BoardSortRule[], columnId: string) {
  return rules.map((rule) =>
    rule.columnId === columnId
      ? { ...rule, direction: rule.direction === "asc" ? ("desc" as const) : ("asc" as const) }
      : rule,
  );
}

/**
 * Moves a rule up or down the priority order.
 *
 * Out-of-range moves return the list unchanged rather than wrapping: a "move
 * up" on the primary sort should do nothing, not send it to the bottom.
 */
export function moveSortRule(
  rules: BoardSortRule[],
  columnId: string,
  delta: -1 | 1,
): BoardSortRule[] {
  const from = sortRuleIndex(rules, columnId);
  if (from < 0) return rules;
  const to = from + delta;
  if (to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * What one column sorts a row by.
 *
 * Exported because the grouping code needs the same answer, and because two
 * definitions of "what does this cell sort as" is precisely how a board ends up
 * ordering the same column two different ways in two places.
 */
export function boardSortValue(
  entry: BoardDisplayColumn,
  request: MaintenanceRequest,
  context: BoardSortContext,
): string | number {
  if (entry.kind === "custom") {
    if (entry.column.type === "files") {
      return context.fileCounts[customCellKey(request.id, entry.column.id)] ?? 0;
    }
    return customCellSortValue(
      entry.column,
      context.cells[customCellKey(request.id, entry.column.id)] ?? "",
    );
  }

  if (entry.key === "name") {
    return boardItemName(
      request,
      context.boardId,
      context.cells[customCellKey(request.id, entry.column.id)],
    );
  }

  const order = context.optionOrderFor(entry.key);
  if (order) {
    const raw = String(systemColumnSortValue(request, entry.key) ?? "");
    if (!raw) return "";
    // Anything not in the workspace's list sorts after everything that is,
    // rather than landing at position 0 where a missing lookup would put it.
    return order.get(raw) ?? order.size;
  }
  return systemColumnSortValue(request, entry.key);
}

function isEmptyValue(value: string | number) {
  return value === "" || value === null || value === undefined;
}

/**
 * Compare two rows under the whole ordered sort.
 *
 * The first rule that separates them decides; the rest never run. Rows no rule
 * separates fall back to board position, which is what keeps a partially-sorted
 * board from reshuffling on every render.
 */
export function compareBoardRows(
  left: MaintenanceRequest,
  right: MaintenanceRequest,
  rules: BoardSortRule[],
  context: BoardSortContext,
): number {
  for (const rule of rules) {
    const entry = context.columnsById.get(rule.columnId);
    if (!entry) continue;
    const leftValue = boardSortValue(entry, left, context);
    const rightValue = boardSortValue(entry, right, context);
    const leftEmpty = isEmptyValue(leftValue);
    const rightEmpty = isEmptyValue(rightValue);
    // Empty last in BOTH directions — see the header.
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty && rightEmpty) continue;
    const compared = compareBoardValues(leftValue, rightValue);
    if (compared) return compared * (rule.direction === "desc" ? -1 : 1);
  }
  return context.positionOf(left.id) - context.positionOf(right.id);
}

/** A new array, sorted. Never mutates its input. */
export function sortBoardRows(
  rows: MaintenanceRequest[],
  rules: BoardSortRule[],
  context: BoardSortContext,
): MaintenanceRequest[] {
  return [...rows].sort((left, right) =>
    compareBoardRows(left, right, rules, context),
  );
}

/**
 * The settings patch that stores one column's place in the sort — or removes it.
 *
 * Returned rather than applied so the caller decides when to write. `sort` and
 * `sortPriority` are dropped together: a priority with no direction orders
 * nothing, and leaving one behind would make a cleared sort look half-set on
 * the next read.
 */
export function sortSettingsFor(
  settings: Record<string, unknown>,
  rules: BoardSortRule[],
  columnId: string,
) {
  const index = sortRuleIndex(rules, columnId);
  const { sort: _sort, sortPriority: _priority, ...rest } = settings as {
    sort?: unknown;
    sortPriority?: unknown;
  };
  if (index < 0) return rest;
  return { ...rest, sort: rules[index].direction, sortPriority: index };
}
