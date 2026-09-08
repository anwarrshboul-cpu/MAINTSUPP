/**
 * THE FILTER STATE EVERY OPERATIONS PAGE SHARES, AND THE SQL IT BECOMES.
 *
 * One shape, parsed identically on both sides of the wire. The browser puts it
 * in the query string — `?period=90&site=store-aldgate&priority=urgent` — the
 * route handler reads the same parameters off the same `URLSearchParams`, and
 * the aggregate is computed in the database against them. Nothing downloads a
 * job list to filter it in the browser, which is what the Overview used to do:
 * `/api/workspace` alone is a 432 KB payload on this estate and every card was
 * a `.filter()` over it.
 *
 * ── REPEATED PARAMETERS, NOT COMMA-JOINED ONES ────────────────────────────
 *
 * `?site=a&site=b`, because a site name, an engineer type and a label are all
 * free text an operator types, and one of them containing a comma would
 * silently split into two filters that match nothing. `URLSearchParams.getAll`
 * is the whole parser.
 *
 * ── DATES ARE COMPARED AS DATE-ONLY STRINGS, AND THAT IS LOAD-BEARING ─────
 *
 * `maintenance_requests.requested_at` carries TWO formats on the live estate —
 * `2026-09-04 15:27:14` from SQLite's `CURRENT_TIMESTAMP` and
 * `2026-06-25T09:00:00.000Z` from the importer. A lexicographic comparison
 * against a full ISO cutoff gets rows raised ON the boundary day backwards,
 * because a space sorts before a `T`. Every cutoff in this module is therefore
 * a bare `YYYY-MM-DD`, which compares correctly against both shapes in SQLite
 * and casts to midnight in Postgres. The end of a window is always EXCLUSIVE
 * and always the day after, so no row is both in and out.
 *
 * `julianday()` is not available: `db/sqlite-to-postgres.ts` refuses it by
 * name. Day arithmetic therefore happens where the server clock is — in this
 * module, on the way into the statement — and never in the browser, which is
 * the property the brief asks for. What reaches SQL is a comparison against a
 * date the server computed.
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { maintenanceRequests, sites } from "../../db/schema";
import {
  NATURE_KEYS,
  UNASSIGNED_SITE_ID,
  normalisePriority,
  statusKey,
  statusLabelsInFamily,
  type JobStatusFamily,
  type NatureKey,
  type PriorityKey,
} from "./job-metrics";

/* ── Period ───────────────────────────────────────────────────────────────── */

export const PERIOD_PRESETS = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom range" },
] as const;

export type PeriodKey = (typeof PERIOD_PRESETS)[number]["key"];

export const DEFAULT_PERIOD: PeriodKey = "90";

function isPeriodKey(value: string): value is PeriodKey {
  return PERIOD_PRESETS.some((preset) => preset.key === value);
}

/** `YYYY-MM-DD` for an instant, in UTC. Never shifts a day west of Greenwich. */
export function dayString(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` a whole number of days from another one. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return dayString(new Date(Date.UTC(year, month - 1, date + days)));
}

/** Whole days between two `YYYY-MM-DD` values, right minus left. */
export function daysBetweenDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodWindow = {
  key: PeriodKey;
  /** Inclusive first day, or null for "all time". */
  start: string | null;
  /** EXCLUSIVE last day — always the day after the last day in the window. */
  endExclusive: string;
  /** Whole days the window covers, used to pro-rate an annual budget. */
  days: number;
  label: string;
  /** The equivalent window immediately before this one, or null when unbounded. */
  previous: { start: string; endExclusive: string } | null;
};

/**
 * The window a period key resolves to, against a server instant.
 *
 * The end is TOMORROW rather than today, because a job raised an hour ago must
 * be inside "the last 7 days" and a same-day exclusive bound would drop it. It
 * is the same one-day grace `analyticsWindow` in `dashboard-meters.ts` applies,
 * expressed in days rather than milliseconds.
 */
export function resolveWindow(
  period: PeriodKey,
  from: string | null,
  to: string | null,
  now: Date,
): PeriodWindow {
  const today = dayString(now);
  const tomorrow = shiftDay(today, 1);

  const bounded = (start: string, endExclusive: string, label: string): PeriodWindow => {
    const days = Math.max(1, daysBetweenDays(start, endExclusive));
    return {
      key: period,
      start,
      endExclusive,
      days,
      label,
      previous: { start: shiftDay(start, -days), endExclusive: start },
    };
  };

  switch (period) {
    case "all":
      return {
        key: period,
        start: null,
        endExclusive: tomorrow,
        /*
         * 365 rather than "however many days of history happen to exist".
         * `days` is only ever used to pro-rate an ANNUAL budget, and an
         * all-time view is the one place where comparing against the whole
         * annual figure is the honest thing to do.
         */
        days: 365,
        label: "All time",
        previous: null,
      };
    case "month": {
      const start = `${today.slice(0, 7)}-01`;
      return bounded(start, tomorrow, "This month");
    }
    case "last-month": {
      const firstOfThis = `${today.slice(0, 7)}-01`;
      const start = `${shiftDay(firstOfThis, -1).slice(0, 7)}-01`;
      return bounded(start, firstOfThis, "Last month");
    }
    case "ytd":
      return bounded(`${today.slice(0, 4)}-01-01`, tomorrow, "Year to date");
    case "custom": {
      const start = from && DAY_PATTERN.test(from) ? from : shiftDay(today, -90);
      const rawEnd = to && DAY_PATTERN.test(to) ? shiftDay(to, 1) : tomorrow;
      // A reversed range is a typo, not a query. Swapped rather than refused,
      // so the page shows something rather than an error the reader cannot act
      // on from a date picker.
      const [lo, hi] = start < rawEnd ? [start, rawEnd] : [rawEnd, start];
      return bounded(lo, hi, `${lo} to ${shiftDay(hi, -1)}`);
    }
    default: {
      const days = Number(period);
      return bounded(shiftDay(tomorrow, -days), tomorrow, `${days} days`);
    }
  }
}

/* ── The filter shape ─────────────────────────────────────────────────────── */

/**
 * The sentinel a "not recorded" bucket is filtered by.
 *
 * A single value across every dimension, so one rule in the SQL builder covers
 * tier, engineer, label and priority. It has to be a value rather than an empty
 * string because an empty query parameter is indistinguishable from an absent
 * one, and "show me the jobs with no tier" is a real question — it is the
 * fastest route to clearing the gaps, which is the whole reason the bucket is
 * tappable.
 */
export const NOT_RECORDED_KEY = "__not_recorded__";

/**
 * PLANNED VERSUS REACTIVE, DEFINED ONCE.
 *
 * The board has no "is this planned?" column, so planned work is inferred:
 * anything whose category names compliance, or anything at tier 4 or above.
 * That inference lives HERE rather than in the aggregate that draws the chart,
 * because the chart's segments are now tappable — a reader who taps `Planned`
 * gets a filtered page, and the rule that decided the segment's height has to
 * be the same rule that decides which jobs come back. Two copies of it would
 * mean a bar of 30 that filters to 27 with no explanation.
 */
export const plannedCondition = sql`(lower(coalesce(${maintenanceRequests.category}, '')) like '%compliance%' or ${maintenanceRequests.tier} >= 4)`;

export type DashboardFilters = {
  period: PeriodKey;
  from: string | null;
  to: string | null;
  sites: string[];
  priorities: PriorityKey[];
  families: JobStatusFamily[];
  statuses: string[];
  engineers: string[];
  labels: string[];
  tiers: string[];
  natures: NatureKey[];
  /**
   * A contractor bucket, keyed exactly as `loadCost` keys it: a contractor id
   * when the job is linked to a record, or `name:<lowercased name>` when the
   * job only carries typed text. Both shapes are needed because 87% of this
   * estate's costed work names a contractor that has no record.
   */
  contractors: string[];
};

export const EMPTY_FILTERS: DashboardFilters = {
  period: DEFAULT_PERIOD,
  from: null,
  to: null,
  sites: [],
  priorities: [],
  families: [],
  statuses: [],
  engineers: [],
  labels: [],
  tiers: [],
  natures: [],
  contractors: [],
};

/** Trim, drop blanks, cap length and de-duplicate one repeated parameter. */
function readList(params: URLSearchParams, key: string, max = 60): string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll(key)) {
    const value = raw.trim().slice(0, 160);
    if (value) seen.add(value);
    if (seen.size >= max) break;
  }
  return [...seen];
}

const PRIORITY_KEYS: PriorityKey[] = ["urgent", "medium", "low", "not_recorded"];
const FAMILY_KEYS: JobStatusFamily[] = ["completed", "in_progress", "attention"];

/**
 * Read the filter state out of a URL. The same function serves the route
 * handler and the browser, so a link cannot mean one thing to each.
 */
export function parseFilters(url: URL | string): DashboardFilters {
  const params =
    typeof url === "string" ? new URL(url, "https://maintsupp.local").searchParams : url.searchParams;
  const periodRaw = (params.get("period") ?? "").trim();
  const period = isPeriodKey(periodRaw) ? periodRaw : DEFAULT_PERIOD;
  const day = (key: string) => {
    const value = (params.get(key) ?? "").trim();
    return DAY_PATTERN.test(value) ? value : null;
  };
  return {
    period,
    from: day("from"),
    to: day("to"),
    sites: readList(params, "site"),
    priorities: readList(params, "priority").filter((value): value is PriorityKey =>
      (PRIORITY_KEYS as string[]).includes(value),
    ),
    families: readList(params, "family").filter((value): value is JobStatusFamily =>
      (FAMILY_KEYS as string[]).includes(value),
    ),
    statuses: readList(params, "status"),
    engineers: readList(params, "engineer"),
    labels: readList(params, "label"),
    tiers: readList(params, "tier", 20),
    natures: readList(params, "nature").filter((value): value is NatureKey =>
      (NATURE_KEYS as readonly string[]).includes(value),
    ),
    contractors: readList(params, "contractor"),
  };
}

/**
 * The query string for a filter state, in a stable key order.
 *
 * Stable because the string is what the browser pushes into history and what a
 * reader copies out of the address bar; two identical filter states that
 * serialise differently would put duplicate entries in the back stack.
 * Defaults are omitted, so an unfiltered page has a clean URL.
 */
export function serialiseFilters(filters: DashboardFilters): string {
  const params = new URLSearchParams();
  if (filters.period !== DEFAULT_PERIOD) params.set("period", filters.period);
  if (filters.period === "custom") {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  const append = (key: string, values: readonly string[]) => {
    for (const value of [...values].sort()) params.append(key, value);
  };
  append("site", filters.sites);
  append("priority", filters.priorities);
  append("family", filters.families);
  append("status", filters.statuses);
  append("engineer", filters.engineers);
  append("label", filters.labels);
  append("tier", filters.tiers);
  append("nature", filters.natures);
  append("contractor", filters.contractors);
  return params.toString();
}

/** How many dimensions carry a value — the number on the mobile `Filters (3)`. */
export function activeFilterCount(filters: DashboardFilters): number {
  return (
    filters.sites.length +
    filters.priorities.length +
    filters.families.length +
    filters.statuses.length +
    filters.engineers.length +
    filters.labels.length +
    filters.tiers.length +
    filters.natures.length +
    filters.contractors.length
  );
}

/* ── SQL ──────────────────────────────────────────────────────────────────── */

/**
 * A column is "not recorded" when it is null OR empty after trimming.
 *
 * Both, because the two estates disagree: the importer wrote empty strings
 * where monday's cell was blank and the form writes nulls. A dimension that
 * tested only one of them reported a coverage figure that was right on one half
 * of the board.
 */
function blank(column: SQL | ReturnType<typeof sql>): SQL {
  return sql`(${column} is null or trim(${column}) = '')`;
}

function present(column: SQL | ReturnType<typeof sql>): SQL {
  return sql`(${column} is not null and trim(${column}) <> '')`;
}

/**
 * A JOB WITH NO SITE, IN BOTH OF THE SHAPES THAT MEANS.
 *
 * Audit finding, and the reason this is a function rather than a null check.
 * The development estate carries 80 of its 111 live jobs at
 * `site_id = 'site-unassigned'` — a value that is not null, not empty, and has
 * NO row in `sites`. A dangling reference, so every screen that resolved a name
 * by lookup printed a blank where the site should be, and the largest cluster
 * of open work on the board rendered as an unlabelled row nobody could click.
 * That is the same defect as a null `site_id`; it simply wears a different
 * disguise, and a check for null alone would report "0 unassigned" over 80
 * jobs.
 *
 * `not exists` rather than `not in (select …)`: a `NOT IN` over a subquery that
 * can yield a NULL returns NULL for every row in both dialects, which would
 * silently match nothing. The correlated existence test has no such trapdoor.
 * The subquery is scoped to the organisation because a site id belonging to
 * another tenant must not vouch for this one's job.
 */
export function unassignedSiteCondition(orgId: string): SQL {
  return sql`(${blank(sql`${maintenanceRequests.siteId}`)} or not exists (select 1 from ${sites} where ${
    sites.id
  } = ${maintenanceRequests.siteId} and ${eq(sites.organisationId, orgId)}))`;
}

/**
 * OR within a dimension, AND across dimensions — the rule the brief states and
 * the one every filter bar in this product already implies. A reader picking
 * two sites means "either of these", and picking a site and a priority means
 * "both".
 */
function anyOf(clauses: SQL[]): SQL | undefined {
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return sql`(${sql.join(clauses, sql` or `)})`;
}

/**
 * The rows that count as work at all — the same three exclusions
 * `liveWorkOrder` applies in `/api/workspace` and `countsAsWorkOrder` applies
 * in the browser. A binned job, an archived one and a subitem are not work.
 */
export function liveWorkOrderCondition(orgId: string): SQL {
  return and(
    eq(maintenanceRequests.organisationId, orgId),
    isNull(maintenanceRequests.deletedAt),
    eq(maintenanceRequests.archived, false),
    isNull(maintenanceRequests.parentId),
  )!;
}

/** `requested_at` inside a window, compared date-only. See the module note. */
export function withinWindowCondition(window: PeriodWindow): SQL {
  const clauses: SQL[] = [
    sql`${maintenanceRequests.requestedAt} < ${window.endExclusive}`,
  ];
  if (window.start) {
    clauses.push(sql`${maintenanceRequests.requestedAt} >= ${window.start}`);
  }
  return and(...clauses)!;
}

/**
 * Every dimension of the filter bar, as one condition.
 *
 * The window is deliberately NOT included: several cards need the same
 * dimensional filter over a different window — the previous period for a delta,
 * the whole estate for a coverage figure — and folding the two together is how
 * a "compared with last period" number came to compare a period with itself.
 */
export function dimensionConditions(
  filters: DashboardFilters,
  orgId: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (filters.sites.length) {
    const ids = filters.sites.filter((id) => id !== UNASSIGNED_SITE_ID);
    const clauses: SQL[] = [];
    if (ids.length) clauses.push(inArray(maintenanceRequests.siteId, ids));
    if (filters.sites.includes(UNASSIGNED_SITE_ID)) {
      clauses.push(unassignedSiteCondition(orgId));
    }
    const clause = anyOf(clauses);
    if (clause) conditions.push(clause);
  }

  if (filters.priorities.length) {
    const clauses: SQL[] = [];
    const named = filters.priorities.filter((key) => key !== "not_recorded");
    for (const key of named) {
      /*
       * Matched on the NORMALISED value rather than on the stored one, because
       * the board carries "Urgent", "urgent" and — from the legacy importer —
       * the literal string "[object Object]" where a blank should be. The
       * labels a key accepts are derived from `normalisePriority` so the
       * browser and the database agree about which spellings are that key.
       */
      const labels = PRIORITY_LABELS_BY_KEY[key];
      if (labels.length) clauses.push(inArray(maintenanceRequests.priority, labels));
    }
    if (filters.priorities.includes("not_recorded")) {
      clauses.push(
        sql`(${blank(sql`${maintenanceRequests.priority}`)} or lower(trim(${maintenanceRequests.priority})) not in ${RECOGNISED_PRIORITY_LABELS})`,
      );
    }
    const clause = anyOf(clauses);
    if (clause) conditions.push(clause);
  }

  const statusLabels = new Set(filters.statuses.map((label) => label));
  for (const family of filters.families) {
    for (const key of statusLabelsInFamily(family)) statusLabels.add(key);
  }
  if (statusLabels.size) {
    /*
     * Compared on a normalised copy on BOTH sides. The stored labels have been
     * through a spreadsheet and a form, so "In Progress" and "in  progress" are
     * one status; an `IN` over the raw column would put the same work in two
     * buckets.
     */
    const keys = [...statusLabels].map((label) => statusKey(label));
    conditions.push(
      sql`lower(trim(${maintenanceRequests.status})) in ${keys}`,
    );
  }

  const textDimension = (
    values: string[],
    column: SQL | ReturnType<typeof sql>,
  ) => {
    if (!values.length) return;
    const named = values.filter((value) => value !== NOT_RECORDED_KEY);
    const clauses: SQL[] = [];
    if (named.length) {
      clauses.push(sql`trim(${column}) in ${named}`);
    }
    if (values.includes(NOT_RECORDED_KEY)) clauses.push(blank(column));
    const clause = anyOf(clauses);
    if (clause) conditions.push(clause);
  };

  textDimension(filters.engineers, sql`${maintenanceRequests.engineer}`);
  textDimension(filters.labels, sql`${maintenanceRequests.category}`);

  if (filters.tiers.length) {
    const numbers = filters.tiers
      .filter((value) => value !== NOT_RECORDED_KEY)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    const clauses: SQL[] = [];
    if (numbers.length) clauses.push(inArray(maintenanceRequests.tier, numbers));
    if (filters.tiers.includes(NOT_RECORDED_KEY)) {
      clauses.push(
        sql`(${maintenanceRequests.tier} is null or ${maintenanceRequests.tier} = 0)`,
      );
    }
    const clause = anyOf(clauses);
    if (clause) conditions.push(clause);
  }

  /*
   * Nature. Selecting both is the same question as selecting neither, so the
   * pair collapses to no condition rather than to `planned AND reactive`,
   * which would return nothing and read as a broken filter.
   */
  if (filters.natures.length === 1) {
    conditions.push(
      filters.natures[0] === "planned" ? plannedCondition : sql`not ${plannedCondition}`,
    );
  }

  /*
   * Contractor, in the two shapes `loadCost` produces. A linked bucket is an
   * id; an unlinked one is the typed name, and it must ALSO require a null id,
   * because a job carrying both belongs to the id's bucket and would otherwise
   * be counted twice.
   */
  if (filters.contractors.length) {
    const ids = filters.contractors.filter((value) => !value.startsWith("name:"));
    const names = filters.contractors
      .filter((value) => value.startsWith("name:"))
      .map((value) => value.slice("name:".length))
      .filter(Boolean);
    const clauses: SQL[] = [];
    if (ids.length) clauses.push(inArray(maintenanceRequests.contractorId, ids));
    if (names.length) {
      clauses.push(
        sql`(${maintenanceRequests.contractorId} is null and lower(trim(coalesce(${maintenanceRequests.contractor}, ''))) in ${names})`,
      );
    }
    const clause = anyOf(clauses);
    if (clause) conditions.push(clause);
  }

  return conditions;
}

/**
 * The spellings each priority key accepts, derived from `normalisePriority` so
 * the browser's bucketing and the database's filter cannot drift.
 *
 * Built once at module load by asking the classifier about every candidate
 * spelling rather than by writing the answer out twice.
 */
const PRIORITY_CANDIDATES = [
  "Urgent",
  "urgent",
  "Critical",
  "critical",
  "P1",
  "p1",
  "Medium",
  "medium",
  "Normal",
  "normal",
  "Standard",
  "standard",
  "Low",
  "low",
];

const PRIORITY_LABELS_BY_KEY: Record<PriorityKey, string[]> = {
  urgent: PRIORITY_CANDIDATES.filter((value) => normalisePriority(value) === "urgent"),
  medium: PRIORITY_CANDIDATES.filter((value) => normalisePriority(value) === "medium"),
  low: PRIORITY_CANDIDATES.filter((value) => normalisePriority(value) === "low"),
  not_recorded: [],
};

const RECOGNISED_PRIORITY_LABELS = [
  ...new Set(
    PRIORITY_CANDIDATES.filter((value) => normalisePriority(value) !== "not_recorded").map(
      (value) => value.toLowerCase(),
    ),
  ),
];

/** Everything a card needs: the work-order rule, the window and the dimensions. */
export function jobScopeCondition(
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
): SQL {
  return and(
    liveWorkOrderCondition(orgId),
    withinWindowCondition(window),
    ...dimensionConditions(filters, orgId),
  )!;
}

/** The same scope over an arbitrary window — used for the previous-period delta. */
export function jobScopeConditionForWindow(
  orgId: string,
  filters: DashboardFilters,
  start: string,
  endExclusive: string,
): SQL {
  return and(
    liveWorkOrderCondition(orgId),
    sql`${maintenanceRequests.requestedAt} >= ${start}`,
    sql`${maintenanceRequests.requestedAt} < ${endExclusive}`,
    ...dimensionConditions(filters, orgId),
  )!;
}

export { blank as blankColumn, present as presentColumn, anyOf as anyOfClauses };
export { or };
