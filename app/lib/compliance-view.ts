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
  countsTowardCompliance,
  responsibilityCoverage,
  type ResponsibilityCoverage,
} from "./compliance-duty-holder";
import {
  complianceCompletion,
  complianceUrgency,
  compareDueDates,
  expiryStatus,
  isDueWindow,
  outstandingCount,
  withinDueWindow,
  type ComplianceCompletion,
  type DueWindowKey,
} from "./compliance-status";
import { dateOnlyValue } from "./expiry-status";
import type { ComplianceState } from "./types";

/** One row of the register, flattened for the wire. */
export type ComplianceRow = {
  id: string;
  siteId: string;
  siteName: string;
  kind: string;
  /**
   * WHO CHASES THE CERTIFICATE — Contractor, Fire safety partner, Insurance
   * broker, and so on, falling back to the site manager. Derived per slot by
   * `responsibilityFor`, offered as the `?who=` filter.
   *
   * NOT to be confused with `dutyHolder` below. They are two axes and the
   * confusion is easy: a fire alarm service can be chased by the fire safety
   * partner and still be the landlord's obligation in a mall unit.
   */
  responsibility: string;
  /**
   * WHOSE OBLIGATION IT IS — client / landlord / centre / not_applicable, or
   * `"unconfirmed"`, or null if nobody has ever been asked.
   *
   * Load-bearing rather than decorative: `complianceCompletion` reads it to
   * decide whether the record belongs in the percentage at all. It has to be
   * carried on THIS type, not only on `RegisterEntry`, because `groupCompliance`
   * and `portfolioCounts` both score `ComplianceRow[]` — dropping it here is
   * what made a brand-new site's twelve unclaimed requirements read 0%
   * compliant instead of "not yet confirmed".
   */
  dutyHolder: string | null;
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
  /**
   * HOW MANY OF THIS SITE'S RESPONSIBILITIES HAVE BEEN ANSWERED FOR.
   *
   * A count, never a percentage, and it travels on the GROUP HEADER because
   * that is where it is needed: the header is drawn from the summary while the
   * group is still collapsed, so a coverage line computed from the records
   * would be blank until somebody opened the accordion — which is precisely the
   * store whose "0 of 12" nobody would ever see.
   *
   * Beside `completion` rather than inside it, because they answer different
   * questions: `completion.percent` is a claim about certificates and this is a
   * count of answers. See `responsibilityCoverage`.
   */
  coverage: ResponsibilityCoverage;
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
  /**
   * ONLY THE REQUIREMENTS INSIDE THE SCORE — `?scored=1`.
   *
   * The Compliance dashboard block counts the score's population: not "Not
   * required", and not a requirement whose responsibility is unconfirmed or
   * somebody else's (`countsTowardCompliance`). The register lists every record.
   * So a segment reading "Missing 250" opened a register of 1,229 Missing
   * records — the list wider than the figure, the defect every drill here is
   * written to avoid. With this, the register opens on exactly the rows the
   * figure counted.
   */
  scored: boolean;
  /**
   * Days-remaining bands — `?due=band:0-30` — the countdown rings' windows.
   * They are thirds of the organisation's warning window, so they cannot be fixed keys in
   * `DUE_WINDOWS`; they travel as their own bounds. OR'd with `due`.
   */
  dueBands: Array<{ from: number; to: number }>;
  /**
   * A DUE-DATE RANGE — `?from=&to=`, inclusive. The block's date picker filters
   * the register by due date, per its brief; a record with no due date is
   * outside any range. Null bounds are open.
   */
  dueFrom: string | null;
  dueTo: string | null;
};

export const EMPTY_COMPLIANCE_FILTERS: ComplianceFilters = {
  sites: [],
  states: [],
  kinds: [],
  responsibilities: [],
  due: [],
  search: "",
  scored: false,
  dueBands: [],
  dueFrom: null,
  dueTo: null,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BAND = /^band:(\d{1,4})-(\d{1,4})$/;

/**
 * The `?who=` value for "nobody is recorded as chasing this". Empty values are
 * dropped by the parser, so the absence needs a name of its own; a real
 * responsibility can never be spelled like this.
 */
export const NO_RESPONSIBILITY = "__none__";

/** A `?due=band:a-b` token as its bounds, or null for anything else. */
export function parseDueBand(value: string): { from: number; to: number } | null {
  const match = BAND.exec(value.trim());
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  return from <= to ? { from, to } : { from: to, to: from };
}

/** The token a band travels as — the inverse of `parseDueBand`. */
export function dueBandToken(from: number, to: number): string {
  return `band:${from}-${to}`;
}

/**
 * Whether a record is inside the compliance SCORE — the population
 * `complianceCompletion` divides by. Not marked not required, and owned by the
 * client (or never asked). One predicate, read by the register's `scored`
 * filter and by the dashboard block, so the two count the same rows.
 */
export function isScoredRow(row: { state: ComplianceState; dutyHolder?: string | null }): boolean {
  return row.state !== "Not required" && countsTowardCompliance(row.dutyHolder);
}

const STATES: ComplianceState[] = [
  "Compliant",
  "Expiring soon",
  "Expired",
  "Missing",
  "Not required",
];

/*
 * 1,000, not 60. The dashboard's drills send every value a figure counted —
 * each requirement behind "Other types", each member of a portfolio — and a
 * cap below the estate's own size silently dropped the tail, so the register
 * listed fewer records than the figure said. The per-value 160-character trim
 * still bounds what one parameter can carry.
 */
function list(params: URLSearchParams, key: string, max = 1000): string[] {
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
  const dueValues = list(params, "due");
  const from = (params.get("from") ?? "").trim();
  const to = (params.get("to") ?? "").trim();
  const [dueFrom, dueTo] =
    DAY.test(from) && DAY.test(to) && from > to ? [to, from] : [from, to];
  return {
    sites: list(params, "site"),
    states: list(params, "state").filter((value): value is ComplianceState =>
      (STATES as string[]).includes(value),
    ),
    kinds: list(params, "kind"),
    responsibilities: list(params, "who"),
    due: dueValues.filter(isDueWindow),
    search: (params.get("q") ?? "").trim().slice(0, 120),
    scored: params.get("scored") === "1",
    dueBands: dueValues
      .map(parseDueBand)
      .filter((band): band is { from: number; to: number } => band !== null),
    dueFrom: DAY.test(dueFrom) ? dueFrom : null,
    dueTo: DAY.test(dueTo) ? dueTo : null,
  };
}

/**
 * The register's rows from a register read — ONE builder, so the dashboard
 * block and the register it drills into describe the same records the same
 * way. `responsibility` is `responsibilityFor` over the site's manager, exactly
 * as `/api/compliance/summary` and `/api/compliance/records` build it.
 */
export function complianceRowsFrom(
  entries: ReadonlyArray<{
    id: string;
    siteId: string;
    siteName: string;
    kind: string;
    dutyHolder: string | null;
    state: ComplianceState;
    expiry: string | null;
    fileCount: number;
    itemId: string | null;
    slotKey: string | null;
  }>,
  managerById: ReadonlyMap<string, string>,
): ComplianceRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    siteId: entry.siteId,
    siteName: entry.siteName,
    kind: entry.kind,
    responsibility: responsibilityFor(entry.kind, managerById.get(entry.siteId) ?? ""),
    dutyHolder: entry.dutyHolder,
    state: entry.state,
    expiry: entry.expiry,
    fileCount: entry.fileCount,
    editable: !(Boolean(entry.itemId) && Boolean(entry.slotKey)),
  }));
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
  const bands = filters.dueBands ?? [];
  const dueFrom = filters.dueFrom ?? null;
  const dueTo = filters.dueTo ?? null;
  return rows.filter((row) => {
    if (sites.size && !sites.has(row.siteId)) return false;
    if (states.size && !states.has(row.state)) return false;
    if (kinds.size && !kinds.has(row.kind)) return false;
    if (
      who.size &&
      !who.has(row.responsibility) &&
      !(who.has(NO_RESPONSIBILITY) && !row.responsibility.trim())
    ) {
      return false;
    }
    if (filters.scored && !isScoredRow(row)) return false;
    if (filters.due.length || bands.length) {
      const matches =
        filters.due.some((window) => withinDueWindow(row, window, today)) ||
        bands.some((band) => {
          const days = expiryStatus(row.expiry, today).daysRemaining;
          return days !== null && days >= band.from && days <= band.to;
        });
      if (!matches) return false;
    }
    if (dueFrom || dueTo) {
      const due = dateOnlyValue(row.expiry);
      if (!due) return false;
      if (dueFrom && due < dueFrom) return false;
      if (dueTo && due > dueTo) return false;
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
      coverage: responsibilityCoverage(records),
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
    /* The same sentence as every group header, from the same function, so the
       portfolio band and the store beneath it cannot disagree about how much of
       the register has been answered for. */
    coverage: responsibilityCoverage(rows),
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
