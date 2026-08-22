/**
 * Structured, per-column filtering on the board grid.
 *
 * THE ENGINE IS NOT NEW, AND THAT IS THE POINT
 *
 * `views/view-model.ts` has carried monday's thirteen filter operators,
 * `matchesRule` and `applyFilters` since Stage 6, evaluated client-side against
 * the loaded rows. The alternative board views used them; the grid — the screen
 * an operator actually works in — had a free-text search box and two hard-coded
 * dropdowns and nothing else. A completion audit found the whole apparatus
 * present and unreachable.
 *
 * So this module wires the grid to that engine rather than growing a second
 * one. It contributes exactly three things the engine cannot know on its own:
 *
 *   1. WHICH FIELD A COLUMN READS. The engine takes a field name; a board
 *      column is either a system column over a field on the job or a workspace
 *      column over a cell. `filterFieldFor` maps one to the other.
 *   2. WHAT A ROW LOOKS LIKE TO IT. `toFilterItem` builds the adapter, and
 *      resolves option cells to their LABELS — a status cell stores a choice
 *      id, and nobody filters for `choice-3-8f2a`.
 *   3. WHICH OPERATORS MAKE SENSE. "contains" on a status column and "is within
 *      the next" on a phone number are offers the engine would honour and a
 *      person would never want.
 *
 * WHERE A FILTER IS STORED: on the column it narrows, in `settings.filter`.
 * Same reasoning as the sort beside it — see `BoardColumnSettings` in
 * lib/types.ts — and it means deleting a column takes its filter with it, so an
 * orphaned rule that quietly empties the board cannot exist.
 *
 * GLOBAL SEARCH IS UNTOUCHED. The search box and these rules are ANDed: search
 * answers "where is that job", filters answer "show me this kind of work", and
 * replacing either with the other would lose a question the board can be asked.
 */

import type { MaintenanceRequest } from "../../lib/types";
import type { BoardColumnType } from "../../lib/types";
import type { BoardDisplayColumn, ColumnKey } from "./board-model";
import { customCellDisplay, customCellKey } from "./board-format";
import { boardItemName } from "./board-ordering";
import {
  FILTER_OPERATORS,
  matchesRule,
  type BoardItem,
  type FilterOperator,
} from "./views/view-model";

export type BoardFilterRule = {
  columnId: string;
  operator: FilterOperator;
  values: string[];
};

export type BoardFilterState = {
  /** How the rules combine. monday offers the same choice. */
  join: "and" | "or";
  rules: BoardFilterRule[];
};

export const EMPTY_FILTER: BoardFilterState = { join: "and", rules: [] };

const OPERATOR_KEYS = new Set<string>(FILTER_OPERATORS.map((entry) => entry.key));

function isOperator(value: unknown): value is FilterOperator {
  return typeof value === "string" && OPERATOR_KEYS.has(value);
}

/**
 * The saved filter, read off the columns that carry one.
 *
 * The join is a board-level choice mirrored onto every filtered column, so the
 * lowest-position filtered column answers for the board — see `filterJoin` in
 * lib/types.ts for why it lives there rather than anywhere tidier.
 */
export function readFilterState(columns: BoardDisplayColumn[]): BoardFilterState {
  const filtered = columns
    .filter((entry) => isOperator(entry.column.settings.filter?.operator))
    .sort((left, right) => left.column.position - right.column.position);
  return {
    join: filtered[0]?.column.settings.filterJoin === "or" ? "or" : "and",
    rules: filtered.map((entry) => ({
      columnId: entry.column.id,
      operator: entry.column.settings.filter!.operator as FilterOperator,
      values: entry.column.settings.filter!.values ?? [],
    })),
  };
}

export function findFilterRule(state: BoardFilterState, columnId: string) {
  return state.rules.find((rule) => rule.columnId === columnId) ?? null;
}

export function setFilterRule(
  state: BoardFilterState,
  rule: BoardFilterRule,
): BoardFilterState {
  const at = state.rules.findIndex((entry) => entry.columnId === rule.columnId);
  return {
    ...state,
    rules:
      at < 0
        ? [...state.rules, rule]
        : state.rules.map((entry, index) => (index === at ? rule : entry)),
  };
}

export function removeFilterRule(
  state: BoardFilterState,
  columnId: string,
): BoardFilterState {
  return { ...state, rules: state.rules.filter((rule) => rule.columnId !== columnId) };
}

/**
 * The settings patch storing one column's rule — or removing it.
 *
 * The join is written onto every rule-carrying column, which is what keeps the
 * mirror from splitting into two answers. Dropping the rule drops the join with
 * it, so a column with no filter carries no opinion about how filters combine.
 */
export function filterSettingsFor(
  settings: Record<string, unknown>,
  state: BoardFilterState,
  columnId: string,
) {
  const { filter: _filter, filterJoin: _join, ...rest } = settings as {
    filter?: unknown;
    filterJoin?: unknown;
  };
  const rule = findFilterRule(state, columnId);
  if (!rule) return rest;
  return {
    ...rest,
    filter: { operator: rule.operator, values: rule.values },
    filterJoin: state.join,
  };
}

/* ── What a column reads ─────────────────────────────────────────────────── */

/**
 * The `BoardItem` field a system column filters on.
 *
 * A board row IS a `MaintenanceRequest` — the grid passes them straight through
 * — so most of these are the field the cell already draws. The two that are not
 * carry a note: `name` is computed (a workspace may override it with a cell)
 * and `timeline` filters on its END, because "show me what is due this week" is
 * the question a timeline is filtered with.
 */
const SYSTEM_FILTER_FIELDS: Partial<Record<ColumnKey, string>> = {
  name: "__name",
  location: "location",
  storeLocation: "location",
  description: "description",
  tier: "tier",
  engineer: "engineer",
  priority: "priority",
  label: "category",
  status: "status",
  contractor: "contractor",
  assignee: "assignee",
  requested: "requestedAt",
  completed: "completedAt",
  dueDate: "dueAt",
  timeline: "dueAt",
  requester: "requester",
  nextUpdate: "nextUpdateAt",
  issuePictures: "issueAttachmentCount",
  completedPictures: "completedAttachmentCount",
  cost: "cost",
  approvedBy: "approvedBy",
  invoice: "invoice",
  files: "attachmentCount",
  number: "contact",
  formView: "formUrl",
  move: "stage",
};

/** The field name a rule on this column addresses, or null if it cannot be filtered. */
export function filterFieldFor(entry: BoardDisplayColumn): string | null {
  if (entry.kind === "custom") return entry.column.id;
  // Subitems is an expander, not a value. Filtering a board by "how many
  // children" is a question monday does not offer and this grid cannot answer.
  if (entry.key === "subitems") return null;
  return SYSTEM_FILTER_FIELDS[entry.key] ?? null;
}

export function isFilterableColumn(entry: BoardDisplayColumn) {
  return filterFieldFor(entry) !== null;
}

/* ── Which operators a column offers ─────────────────────────────────────── */

export type FilterValueKind = "option" | "text" | "number" | "date";

/**
 * What kind of thing this column holds, for the purposes of offering operators.
 *
 * System option columns are recognised by KEY rather than by type, because the
 * board stores Tier as a `dropdown` and Priority as a `status` while both are
 * chosen from the workspace's own option list and both want the same operators.
 */
export function filterKindFor(entry: BoardDisplayColumn): FilterValueKind {
  if (entry.kind === "system") {
    switch (entry.key) {
      case "tier":
      case "engineer":
      case "priority":
      case "label":
      case "status":
      case "storeLocation":
      case "assignee":
      case "move":
        return "option";
      case "requested":
      case "completed":
      case "dueDate":
      case "nextUpdate":
      case "timeline":
        return "date";
      case "cost":
      case "files":
      case "issuePictures":
      case "completedPictures":
        return "number";
      default:
        return "text";
    }
  }
  return columnTypeKind(entry.column.type);
}

function columnTypeKind(type: BoardColumnType): FilterValueKind {
  if (type === "status" || type === "dropdown" || type === "people" || type === "checkbox") {
    return "option";
  }
  if (type === "date" || type === "timeline") return "date";
  if (type === "number" || type === "files") return "number";
  return "text";
}

const OPERATORS_BY_KIND: Record<FilterValueKind, FilterOperator[]> = {
  option: ["any_of", "not_any_of", "is_empty", "is_not_empty"],
  text: [
    "contains",
    "not_contains",
    "any_of",
    "not_any_of",
    "starts_with",
    "ends_with",
    "is_empty",
    "is_not_empty",
  ],
  number: ["greater_than", "lower_than", "between", "is_empty", "is_not_empty"],
  /*
   * Deliberately no `greater_than`/`between` on a date. The engine's numeric
   * comparison strips non-digits, so "2026-11-24" reaches `Number()` as
   * `2026-11-24` and evaluates to NaN — the rule would match nothing and look
   * broken rather than say so. The two relative-window operators are what a
   * date column is actually filtered with, and `any_of` covers an exact day.
   */
  date: ["within_the_next", "within_the_last", "any_of", "is_empty", "is_not_empty"],
};

export function operatorsFor(entry: BoardDisplayColumn) {
  const wanted = new Set<string>(OPERATORS_BY_KIND[filterKindFor(entry)]);
  // Ordered by the engine's own list so the menu reads the same everywhere.
  return FILTER_OPERATORS.filter((operator) => wanted.has(operator.key));
}

export function operatorArity(operator: FilterOperator) {
  return FILTER_OPERATORS.find((entry) => entry.key === operator)?.arity ?? 1;
}

/* ── Evaluating ──────────────────────────────────────────────────────────── */

export type BoardFilterContext = {
  boardId: string;
  columnsById: Map<string, BoardDisplayColumn>;
  cells: Record<string, string>;
  fileCounts: Record<string, number>;
};

/**
 * One row, in the shape `matchesRule` reads.
 *
 * Custom cells are resolved to their DISPLAYED value, not their stored one. A
 * status cell holds a choice id and a date cell holds a JSON blob carrying an
 * icon; filtering on either would mean typing an id nobody has seen or matching
 * against `{"date":"2026-11-24","icon":""}`. What the operator sees is what the
 * cell shows.
 */
export function toFilterItem(
  request: MaintenanceRequest,
  context: BoardFilterContext,
): BoardItem {
  const cells: Record<string, string> = {};
  let nameColumnId: string | null = null;
  for (const entry of context.columnsById.values()) {
    if (entry.kind === "system") {
      if (entry.key === "name") nameColumnId = entry.column.id;
      continue;
    }
    const key = customCellKey(request.id, entry.column.id);
    cells[entry.column.id] =
      entry.column.type === "files"
        ? String(context.fileCounts[key] ?? 0)
        : customCellDisplay(entry.column, context.cells[key] ?? "");
  }
  return {
    ...(request as unknown as BoardItem),
    __name: boardItemName(
      request,
      context.boardId,
      nameColumnId ? context.cells[customCellKey(request.id, nameColumnId)] : undefined,
    ),
    cells,
  } as BoardItem;
}

/**
 * The rows a filter leaves.
 *
 * A rule naming a column the board no longer has is skipped rather than failing
 * closed: a deleted column takes its own filter with it, but a stale rule
 * arriving from another tab must not silently empty the board.
 */
export function applyBoardFilter(
  rows: MaintenanceRequest[],
  state: BoardFilterState,
  context: BoardFilterContext,
): MaintenanceRequest[] {
  const live = state.rules
    .map((rule) => {
      const entry = context.columnsById.get(rule.columnId);
      const field = entry ? filterFieldFor(entry) : null;
      return field ? { field, operator: rule.operator, values: rule.values } : null;
    })
    .filter((rule): rule is NonNullable<typeof rule> => rule !== null);
  if (!live.length) return rows;

  return rows.filter((request) => {
    const item = toFilterItem(request, context);
    return state.join === "or"
      ? live.some((rule) => matchesRule(item, rule))
      : live.every((rule) => matchesRule(item, rule));
  });
}
