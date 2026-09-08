/**
 * THE COMPLIANCE REGISTER AS THE PAGE NEEDS IT — grouped, filtered, counted.
 *
 * `compliance-register.ts` answers "what does the estate hold"; this answers
 * "what should the screen draw". They are separate because the first is shared
 * with the nightly digest and the calendar, and a filter that belongs to one
 * page has no business in a module those depend on.
 *
 * ── WHY THIS IS NOT A `GROUP BY` ──────────────────────────────────────────
 *
 * The brief asks for the counts to be aggregated in the database. They cannot
 * be, and the reason is structural rather than lazy: a compliance record is not
 * a row. It is a BOARD CELL crossed with a certificate slot — twelve slots per
 * store, each reading a file column and, for most of them, an expiry column,
 * with `compliance_documents` layered on top as the override that can mark a
 * slot not required. `readComplianceRegister` already does that work with
 * joins; there is no table to `GROUP BY` afterwards.
 *
 * What the brief is actually protecting is honoured exactly: the browser never
 * receives 748 records to draw ten headers. The summary endpoint returns ten
 * group headers and a portfolio meter, and records arrive only for the groups
 * that are open.
 *
 * Date maths is in `expiryStatus`, against ONE injected instant, so a register
 * cannot drift across its own classification loop — and never in the browser.
 */

import { storeDocumentationResponsibility } from "../../db/monday-board-spec";
import {
  complianceCompletion,
  complianceUrgency,
  compareDueDates,
  isDueWindow,
  outstandingCount,
  withinDueWindow,
  type ComplianceCompletion,
  type DueWindowKey,
} from "./compliance-status";
import type { ComplianceState } from "./types";

/** One row of the register, flattened for the wire. */
export type ComplianceRow = {
  id: string;
  siteId: string;
  siteName: string;
  kind: string;
  responsibility: string;
  state: ComplianceState;
  expiry: string | null;
  fileCount: number;
  /**
   * Whether this record can be edited from the register at all.
   *
   * A board-derived requirement cannot: "Manage register" would open a blank
   * `compliance_documents` form whose save the next read recomputes away, and a
   * row minted that way can go on to switch a real board slot off. The row shows
   * a lock instead, which is a PERMISSION STATE and not an action — the reason
   * "Read-only" came off the actions row.
   */
  editable: boolean;
};

export type ComplianceGroup = {
  siteId: string;
  siteName: string;
  completion: ComplianceCompletion;
  outstanding: number;
  noDueDate: number;
  /** Expiring inside the shared amber window. */
  expiringSoon: number;
  expired: number;
  missing: number;
  total: number;
};

export type ComplianceFilters = {
  sites: string[];
  states: ComplianceState[];
  kinds: string[];
  responsibilities: string[];
  due: DueWindowKey[];
  search: string;
};

export const EMPTY_COMPLIANCE_FILTERS: ComplianceFilters = {
  sites: [],
  states: [],
  kinds: [],
  responsibilities: [],
  due: [],
  search: "",
};

const STATES: ComplianceState[] = [
  "Compliant",
  "Expiring soon",
  "Expired",
  "Missing",
  "Not required",
];

function list(params: URLSearchParams, key: string, max = 60): string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll(key)) {
    const value = raw.trim().slice(0, 160);
    if (value) seen.add(value);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** The same parser on both sides of the wire, for the same reason as everywhere. */
export function parseComplianceFilters(url: URL): ComplianceFilters {
  const params = url.searchParams;
  return {
    sites: list(params, "site"),
    states: list(params, "state").filter((value): value is ComplianceState =>
      (STATES as string[]).includes(value),
    ),
    kinds: list(params, "kind"),
    responsibilities: list(params, "who"),
    due: list(params, "due").filter(isDueWindow),
    search: (params.get("q") ?? "").trim().slice(0, 120),
  };
}

/**
 * Who chases this certificate.
 *
 * From the Store Documentation capture, never from a substring match on the
 * requirement name: RAMS, the PLI and the store drawing contain none of the
 * keywords a matcher would look for, so all three used to fall through to the
 * store manager. Anything the board does not define falls back to the manager,
 * which is the right answer for a requirement an admin added themselves.
 */
export function responsibilityFor(kind: string, siteManager: string): string {
  return storeDocumentationResponsibility.get(kind) || siteManager || "Store manager";
}

/**
 * Apply the filters to a flattened register.
 *
 * OR within a dimension, AND across dimensions — the rule the whole product
 * uses. The search matches the requirement and the site name, which are the two
 * things somebody types into this box.
 */
export function filterComplianceRows(
  rows: readonly ComplianceRow[],
  filters: ComplianceFilters,
  today: Date,
): ComplianceRow[] {
  const needle = filters.search.toLowerCase();
  const sites = new Set(filters.sites);
  const states = new Set(filters.states);
  const kinds = new Set(filters.kinds);
  const who = new Set(filters.responsibilities);
  return rows.filter((row) => {
    if (sites.size && !sites.has(row.siteId)) return false;
    if (states.size && !states.has(row.state)) return false;
    if (kinds.size && !kinds.has(row.kind)) return false;
    if (who.size && !who.has(row.responsibility)) return false;
    if (filters.due.length) {
      const matches = filters.due.some((window) => withinDueWindow(row, window, today));
      if (!matches) return false;
    }
    if (needle) {
      const haystack = `${row.kind} ${row.siteName} ${row.responsibility}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export type GroupSort = "outstanding" | "least-complete" | "name" | "soonest";

export const GROUP_SORTS: ReadonlyArray<{ key: GroupSort; label: string }> = [
  { key: "outstanding", label: "Most outstanding" },
  { key: "least-complete", label: "Least complete" },
  { key: "name", label: "Site name (A–Z)" },
  { key: "soonest", label: "Soonest due" },
];

export function isGroupSort(value: string): value is GroupSort {
  return GROUP_SORTS.some((entry) => entry.key === value);
}

/**
 * Group by site and count each group, over whatever set the caller passes.
 *
 * The meters always describe what is on screen: passing the FILTERED rows is
 * what makes a group header change when a filter is applied, which is the
 * behaviour the brief asks for and the thing a summary computed once and cached
 * could not do.
 *
 * A site whose every record was filtered away yields NO GROUP, so the register
 * hides it rather than rendering an empty accordion.
 */
export function groupCompliance(
  rows: readonly ComplianceRow[],
  today: Date,
): ComplianceGroup[] {
  const byId = new Map<string, ComplianceRow[]>();
  for (const row of rows) {
    const list = byId.get(row.siteId);
    if (list) list.push(row);
    else byId.set(row.siteId, [row]);
  }
  return [...byId].map(([siteId, records]) => {
    const completion = complianceCompletion(records);
    return {
      siteId,
      siteName: records[0]?.siteName ?? siteId,
      completion,
      outstanding: outstandingCount(completion.counts),
      noDueDate: records.filter((record) => !record.expiry).length,
      expiringSoon: completion.counts["Expiring soon"],
      expired: completion.counts.Expired,
      missing: completion.counts.Missing,
      total: records.length,
    };
  });
}

/** Soonest expiry inside a group, for the `Soonest due` sort. */
export function soonestDue(rows: readonly ComplianceRow[]): string | null {
  let soonest: string | null = null;
  for (const row of rows) {
    if (!row.expiry) continue;
    if (soonest === null || row.expiry < soonest) soonest = row.expiry;
  }
  return soonest;
}

export function sortGroups(
  groups: ComplianceGroup[],
  order: GroupSort,
  soonestBySite: Map<string, string | null>,
): ComplianceGroup[] {
  const byName = (left: ComplianceGroup, right: ComplianceGroup) =>
    left.siteName.localeCompare(right.siteName, "en-GB");
  const sorted = [...groups];
  switch (order) {
    case "least-complete":
      sorted.sort(
        (left, right) => left.completion.percent - right.completion.percent || byName(left, right),
      );
      break;
    case "name":
      sorted.sort(byName);
      break;
    case "soonest":
      sorted.sort((left, right) => {
        const a = soonestBySite.get(left.siteId) ?? null;
        const b = soonestBySite.get(right.siteId) ?? null;
        return compareDueDates(a, b) || byName(left, right);
      });
      break;
    default:
      // Most outstanding first — the store needing the most work at the top,
      // which is the question this page is opened to answer.
      sorted.sort(
        (left, right) => right.outstanding - left.outstanding || byName(left, right),
      );
  }
  return sorted;
}

/**
 * Records inside a group, ordered by urgency and then by date.
 *
 * Missing before Expired before Expiring soon before Compliant before Not
 * required, then soonest due, then requirement name. No control chooses this:
 * the thing to do today belongs at the top of every group whatever sort the
 * reader picked for the groups themselves.
 */
export function sortRecords(rows: readonly ComplianceRow[]): ComplianceRow[] {
  return [...rows].sort(
    (left, right) =>
      complianceUrgency(left.state) - complianceUrgency(right.state) ||
      compareDueDates(left.expiry, right.expiry) ||
      left.kind.localeCompare(right.kind, "en-GB"),
  );
}

/** Portfolio counts across whatever set is on screen. */
export function portfolioCounts(rows: readonly ComplianceRow[]) {
  const completion = complianceCompletion(rows);
  return {
    counts: completion.counts,
    completion,
    noDueDate: rows.filter((row) => !row.expiry).length,
    sites: new Set(rows.map((row) => row.siteId)).size,
    total: rows.length,
  };
}

/** The distinct values each filter control offers, with counts. */
export function complianceFilterOptions(rows: readonly ComplianceRow[]) {
  const tally = (pick: (row: ComplianceRow) => string) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = pick(row);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((left, right) => left.label.localeCompare(right.label, "en-GB"));
  };
  return {
    sites: [...new Map(rows.map((row) => [row.siteId, row.siteName]))]
      .map(([value, label]) => ({
        value,
        label,
        count: rows.filter((row) => row.siteId === value).length,
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "en-GB")),
    kinds: tally((row) => row.kind),
    responsibilities: tally((row) => row.responsibility),
    states: STATES.map((state) => ({
      value: state,
      label: state,
      count: rows.filter((row) => row.state === state).length,
    })),
  };
}

export { STATES as COMPLIANCE_STATE_ORDER, sortRecords as sortComplianceRecords };
