/**
 * Shared types and the filter engine for the alternative board views.
 *
 * The filter operators mirror monday's so a saved filter means the same thing
 * in both systems during the changeover. Filters are evaluated client-side
 * against the loaded page of items; server-side filtering arrives with
 * pagination in a later stage.
 */

export type BoardItem = {
  id: string;
  reference: string | null;
  title: string;
  parentId: string | null;
  archived: boolean;
  groupId: string | null;
  status: string | null;
  priority: string | null;
  siteId: string | null;
  /**
   * The board passes `MaintenanceRequest` objects straight through, so these
   * three are always present. They were absent from the type, which is why the
   * views that needed them reached into `cells` — keyed by column id, not by
   * column key — and silently read nothing.
   */
  location?: string | null;
  description?: string | null;
  requester?: string | null;
  category: string | null;
  engineer: string | null;
  tier: number | null;
  contractor: string | null;
  assignee: string | null;
  requestedAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  nextUpdateAt: string | null;
  cost: number | null;
  attachmentCount: number | null;
  commentCount: number | null;
  cells: Record<string, string>;
};

export type BoardGroup = {
  id: string;
  name: string;
  colour: string;
  position: number;
  items: number;
};

export type FilterOperator =
  | "any_of"
  | "not_any_of"
  | "is_empty"
  | "is_not_empty"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "lower_than"
  | "between"
  | "within_the_last"
  | "within_the_next";

export type FilterRule = {
  field: keyof BoardItem | string;
  operator: FilterOperator;
  values: string[];
};

export type FilterSet = {
  /** How rules combine. monday offers the same choice. */
  conjunction: "and" | "or";
  rules: FilterRule[];
};

export type SortRule = { field: string; direction: "asc" | "desc" };

export const FILTER_OPERATORS: Array<{
  key: FilterOperator;
  label: string;
  /** How many values the operator takes. 0 means none. */
  arity: 0 | 1 | 2;
  appliesTo: "any" | "text" | "number" | "date";
}> = [
  { key: "any_of", label: "is one of", arity: 1, appliesTo: "any" },
  { key: "not_any_of", label: "is not one of", arity: 1, appliesTo: "any" },
  { key: "is_empty", label: "is empty", arity: 0, appliesTo: "any" },
  { key: "is_not_empty", label: "is not empty", arity: 0, appliesTo: "any" },
  { key: "contains", label: "contains", arity: 1, appliesTo: "text" },
  { key: "not_contains", label: "does not contain", arity: 1, appliesTo: "text" },
  { key: "starts_with", label: "starts with", arity: 1, appliesTo: "text" },
  { key: "ends_with", label: "ends with", arity: 1, appliesTo: "text" },
  { key: "greater_than", label: "is greater than", arity: 1, appliesTo: "number" },
  { key: "lower_than", label: "is less than", arity: 1, appliesTo: "number" },
  { key: "between", label: "is between", arity: 2, appliesTo: "number" },
  { key: "within_the_last", label: "is within the last (days)", arity: 1, appliesTo: "date" },
  { key: "within_the_next", label: "is within the next (days)", arity: 1, appliesTo: "date" },
];

function fieldValue(item: BoardItem, field: string): unknown {
  if (field in item) return (item as Record<string, unknown>)[field];
  return item.cells?.[field];
}

function asText(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function asNumber(value: unknown) {
  const numeric = Number(asText(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function daysFromToday(value: unknown) {
  const text = asText(value);
  if (!text) return null;
  const when = new Date(text);
  if (Number.isNaN(when.getTime())) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((when.getTime() - today.getTime()) / 86_400_000);
}

/** Evaluates one rule. Unknown operators fail closed rather than matching everything. */
export function matchesRule(item: BoardItem, rule: FilterRule): boolean {
  const raw = fieldValue(item, rule.field);
  const text = asText(raw).toLowerCase();
  const wanted = rule.values.map((value) => value.toLowerCase());

  switch (rule.operator) {
    case "any_of":
      return wanted.includes(text);
    case "not_any_of":
      return !wanted.includes(text);
    case "is_empty":
      return text.trim() === "";
    case "is_not_empty":
      return text.trim() !== "";
    case "contains":
      return wanted.some((value) => text.includes(value));
    case "not_contains":
      return !wanted.some((value) => text.includes(value));
    case "starts_with":
      return wanted.some((value) => text.startsWith(value));
    case "ends_with":
      return wanted.some((value) => text.endsWith(value));
    case "greater_than": {
      const left = asNumber(raw);
      const right = asNumber(rule.values[0]);
      return left !== null && right !== null && left > right;
    }
    case "lower_than": {
      const left = asNumber(raw);
      const right = asNumber(rule.values[0]);
      return left !== null && right !== null && left < right;
    }
    case "between": {
      const left = asNumber(raw);
      const low = asNumber(rule.values[0]);
      const high = asNumber(rule.values[1]);
      return left !== null && low !== null && high !== null && left >= low && left <= high;
    }
    case "within_the_last": {
      const offset = daysFromToday(raw);
      const window = asNumber(rule.values[0]);
      return offset !== null && window !== null && offset <= 0 && offset >= -window;
    }
    case "within_the_next": {
      const offset = daysFromToday(raw);
      const window = asNumber(rule.values[0]);
      return offset !== null && window !== null && offset >= 0 && offset <= window;
    }
    default:
      return false;
  }
}

export function applyFilters(items: BoardItem[], filters: FilterSet | null): BoardItem[] {
  if (!filters || filters.rules.length === 0) return items;
  return items.filter((item) =>
    filters.conjunction === "or"
      ? filters.rules.some((rule) => matchesRule(item, rule))
      : filters.rules.every((rule) => matchesRule(item, rule)),
  );
}

/** Multi-column sort — P10. Earlier rules win; later rules break ties. */
export function applySort(items: BoardItem[], sort: SortRule[]): BoardItem[] {
  if (!sort.length) return items;
  return [...items].sort((a, b) => {
    for (const rule of sort) {
      const left = asText(fieldValue(a, rule.field));
      const right = asText(fieldValue(b, rule.field));
      const leftNum = asNumber(left);
      const rightNum = asNumber(right);

      let comparison: number;
      if (leftNum !== null && rightNum !== null && left !== "" && right !== "") {
        comparison = leftNum - rightNum;
      } else {
        // Empty values sort last regardless of direction — a blank is not
        // "smallest", it is missing.
        if (left === "" && right !== "") return 1;
        if (right === "" && left !== "") return -1;
        comparison = left.localeCompare(right, "en-GB");
      }

      if (comparison !== 0) return rule.direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
}

/** Groups items by any field, preserving a stable order for the buckets. */
export function groupBy(items: BoardItem[], field: string) {
  const buckets = new Map<string, BoardItem[]>();
  for (const item of items) {
    const key = asText(fieldValue(item, field)) || "—";
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  return buckets;
}

import { formatDate as sharedFormatDate } from "../../../lib/format-date";

/**
 * Formats a cost. POUNDS, despite what this was called.
 *
 * The parameter was named `pence` and divided by 100. Every caller sums
 * `item.cost`, and `maintenance_requests.cost` is a `real` in POUNDS — the
 * pence column beside it, `cost_pence`, is a different field that these views
 * never read. So the board's alternative views rendered every cost at one
 * hundredth: £42,540.14 of real spend displayed as £425.40, on the Kanban
 * totals, the chart view, the flat table and the item panel.
 *
 * `dashboard-insights.ts` has its own `money()` which also takes pounds and
 * does not divide — that one was right, which is part of why this went
 * unnoticed: the same figure was correct on the dashboard and wrong on the
 * board.
 */
export function formatMoney(pounds: number | null) {
  if (pounds === null || pounds === undefined) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pounds);
}

/**
 * A DD/MM/YYYY date, in the UK convention the rest of the platform uses.
 *
 * A DATE-ONLY VALUE IS NOT A MOMENT IN TIME, and this used to treat it as one.
 * It did `new Date(value)` and formatted with no `timeZone`. `new Date
 * ("2026-11-24")` is midnight UTC by specification, so any viewer west of
 * Greenwich — New York is five hours behind — rendered Aldgate's PAT expiry as
 * 23/11/2026. A certificate silently one day early, on a screen whose only job
 * is to say when things run out.
 *
 * Every other date formatter this board touches already knew: `expiry-cell.tsx`
 * pins `timeZone: "UTC"` and documents this exact hazard, `summaryDate` in
 * `board-format.ts` pins it, and `store-expiry-calendar.tsx` avoids `Date`
 * altogether. This was the one that did not.
 *
 * WHY NOT JUST ADD `timeZone: "UTC"`. Because `formatDate` is shared, and half
 * its callers pass a full timestamp rather than a date-only value —
 * `item.requestedAt`, `item.completedAt`, `entry.performedAt`,
 * `file.uploadedAt`. Those ARE moments, and a moment should read in the
 * viewer's own zone: a job logged at 00:30 on 4 August in London is not "3
 * August" because UTC says so. Pinning the shared formatter to UTC would have
 * traded one silent day shift for another, on more screens.
 *
 * So the value decides. `YYYY-MM-DD` and nothing else is split into three
 * numbers and never passed through `Date` at all, which is the only way a zone
 * cannot reach it. Anything carrying a time keeps the local rendering it had,
 * unchanged. `parseIsoDay` in the calendar takes the same approach for the
 * same reason.
 *
 * THAT RULE NOW LIVES IN app/lib/format-date.ts, where every screen shares it.
 * It was worked out here and then worked out again, separately, in
 * expiry-status.ts; a completion audit counted nine independent date formatters
 * across the portal, four of them asking `Intl` for en-US. This is the same
 * function it always was, in one place, and the export stays so the board's
 * alternative views need no edit.
 */
export const formatDate = sharedFormatDate;
