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

import type { MaintenanceBoardColumn, MaintenanceRequest } from "../../lib/types";
import type { BoardDisplayColumn, ColumnKey, Option } from "./board-model";
import {
  boardItemName,
  compareBoardValues,
  systemColumnSortValue,
} from "./board-ordering";
import { customCellKey, customCellSortValue } from "./board-format";
import type { BoardOptionColumn } from "../../lib/types";

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
  // Custom columns spell "no value" as "" (board-format.ts customCellSortValue),
  // but the system date and cost columns spell it as NEGATIVE_INFINITY
  // (board-ordering.ts systemColumnSortValue) so that present values still
  // compare numerically. Both are the SAME "missing" state, and both must sort
  // last in either direction — otherwise reversing an ascending Due Date /
  // Date Completed / Next Update / Cost sort floats every blank cell to the top,
  // which the header's "empty sorts last in both directions" rule forbids.
  return (
    value === "" ||
    value === null ||
    value === undefined ||
    value === Number.NEGATIVE_INFINITY
  );
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

/* ── The toolbar's one-click sort ─────────────────────────────────────────── */

/**
 * Which column the quick sort writes a rule on, and what the button should say.
 *
 * OWNER REPRO 3, and the reason this is here rather than in the component.
 *
 * It was `isStoreDocumentation ? itemNameColumn : <the "requested" column>` —
 * two boards and an assumption. A section's generated register has neither: its
 * six columns are Item, Status, Owner, Date, Notes and Files. So the column
 * resolved to null, the toggle returned on its first line, and the button went
 * on being drawn reading "Newest". A control that takes a click and does
 * nothing.
 *
 * The ladder looks for a column ON THIS BOARD, in the order a reader would: the
 * arrival date where there is one, otherwise the board's own first date or
 * timeline column, otherwise the row's name. A board with none of the three
 * returns null and the toolbar draws no button at all — nothing to sort by is a
 * reason to show no button, never a reason to show a dead one.
 *
 * The label follows the COLUMN rather than the board, and names it: on a
 * register whose date column is called "Renewal due", the old button promised
 * "the date each job was requested".
 *
 * Pure, so it can be fed columns and asserted on. Inside a 5,700-line component
 * it could only be eyeballed — the same argument the header above makes for the
 * comparator.
 */
export type QuickSort = {
  column: MaintenanceBoardColumn;
  by: "date" | "name";
  direction: SortDirection | null;
  label: { text: string; aria: string };
};

export function resolveQuickSort(input: {
  isStoreDocumentation: boolean;
  itemNameColumn: MaintenanceBoardColumn | null;
  systemColumns: MaintenanceBoardColumn[];
  boardColumns: Array<{ column: MaintenanceBoardColumn }>;
  sortRules: BoardSortRule[];
}): QuickSort | null {
  const { isStoreDocumentation, itemNameColumn, systemColumns, boardColumns, sortRules } = input;

  const chosen: { column: MaintenanceBoardColumn; by: "date" | "name" } | null =
    isStoreDocumentation && itemNameColumn
      ? { column: itemNameColumn, by: "name" }
      : (() => {
          const requested = systemColumns.find((column) => column.key === "requested");
          if (requested) return { column: requested, by: "date" as const };
          const date = boardColumns.find(
            (entry) => entry.column.type === "date" || entry.column.type === "timeline",
          );
          if (date) return { column: date.column, by: "date" as const };
          if (itemNameColumn) return { column: itemNameColumn, by: "name" as const };
          return null;
        })();

  if (!chosen) return null;
  const direction = sortDirectionFor(sortRules, chosen.column.id);
  const label =
    chosen.by === "name"
      ? {
          text: direction === "desc" ? "Z\u2013A" : "A\u2013Z",
          aria: `Sort by ${chosen.column.title}, A to Z`,
        }
      : {
          text: direction === "asc" ? "Oldest" : "Newest",
          aria: `Sort by ${chosen.column.title}, newest first`,
        };
  return { ...chosen, direction, label };
}


/* ── The order an option-backed column's values are DEFINED in ───────────── */

/** The bare number inside a tier value — "Tier 3" becomes "3". */
export const tierDigits = (value: string) => value.replace(/\D+/g, "");

/** One board option, in the only two fields the ordering needs. */
export type SortableBoardOption = {
  columnKey: string;
  value: string;
  label: string;
  position: number;
};

/**
 * WHERE EACH CHOICE SITS, per option-backed column.
 *
 * The first rule at the top of this file is that an option column sorts by the
 * order its options are DEFINED in rather than alphabetically — Priority on
 * this board reads Medium, Low, Urgent, and alphabetical would put Low above
 * Medium and present that as ascending. This builds the lookup that rule needs:
 * value (and label) to index, for the six registry-backed columns.
 *
 * Extracted from `live-board.tsx`, unchanged. It is pure — a list of options
 * in, a map out — and it belongs beside the comparator that consumes it rather
 * than inside a component that had one line of headroom left under its size
 * ceiling. The extraction is what paid for the Store Documentation instance
 * fix; see the note on `storeDocumentation` in `LiveMaintenanceBoard`.
 *
 * `fallbackOptions` is passed in rather than imported, and that is not style.
 * This module is loaded in two tests by transpiling it to a `data:` URL, where
 * a relative specifier cannot be resolved at all — so every value import here
 * has to be rewritten by hand in those loaders, and one that is forgotten fails
 * the WHOLE FILE rather than a test. Keeping the module free of new value
 * imports is what stops the next extraction breaking two suites at a distance.
 * The caller has the table anyway.
 *
 * The fallback covers a column whose board has no saved chips yet, so a board
 * sorts sensibly before its first option edit.
 */
export function systemOptionOrders(
  boardOptions: SortableBoardOption[],
  fallbackOptions: Partial<Record<BoardOptionColumn, Option[]>>,
) {
  const orders = new Map<string, Map<string, number>>();
  for (const key of [
    "tier",
    "engineer",
    "priority",
    "label",
    "status",
    "storeLocation",
  ] as BoardOptionColumn[]) {
    const saved = boardOptions
      .filter((option) => option.columnKey === key)
      .sort((left, right) => left.position - right.position);
    const choices = saved.length
      ? saved.map((option) => ({ value: option.value, label: option.label }))
      : (fallbackOptions[key] ?? []).map((option) => ({
          value: option.value,
          label: option.label,
        }));
    if (!choices.length) continue;
    const lookup = new Map<string, number>();
    choices.forEach((choice, index) => {
      if (choice.value) lookup.set(choice.value, index);
      if (choice.label) lookup.set(choice.label, index);
      // The tier FIELD is the bare number; alias "3" onto "Tier 3" so a
      // tier sort ranks rows instead of scoring them all "not in the list".
      if (key === "tier") {
        const digits = tierDigits(choice.value ?? "");
        if (digits) lookup.set(digits, index);
      }
    });
    orders.set(key, lookup);
  }
  return orders;
}
