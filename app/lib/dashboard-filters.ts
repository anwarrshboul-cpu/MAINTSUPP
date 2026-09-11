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
import { jobTypeConfig, maintenanceGroupItems, maintenanceRequests, sites } from "../../db/schema";
import { DEFAULT_MEASURE, type CohortMeasure } from "./overview-meters";
import { isJobTypeCode, type JobTypeCode } from "./job-type-contract";
import {
  JOBS_BOARD_KEY,
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
 * A JOB OF ONE CANONICAL TYPE, BY THE TYPE'S STABLE CODE — in SQL.
 *
 * A job's type is `maintenance_requests.job_type_id`, the id of one of its
 * organisation's `job_type_config` rows. This asks the CONFIGURATION which
 * type carries the code rather than spelling out the seeded `jt_<org>_<code>`
 * id, so it holds for any row that carries the code, and a renamed type is
 * still the same type. Correlated on the OUTER row's organisation, so another
 * tenant's type can never vouch for this one's job, and `exists` rather than
 * `in (select …)` for the NULL trapdoor `unassignedSiteCondition` describes.
 *
 * The code reaches the statement as a literal, not a bound variable — the same
 * arrangement as `jobsBoardCondition`, so the ~100-variable ceiling several
 * statements chunk against is not moved — and it is checked against the three
 * known codes first, so nothing but `reactive`, `planned` or `project` can
 * ever be written into the SQL that way. A job with no type matches no code.
 */
export function jobTypeCodeCondition(code: JobTypeCode): SQL {
  if (!isJobTypeCode(code)) throw new Error(`Unknown job type code: ${String(code)}`);
  return sql`exists (select 1 from ${jobTypeConfig} where ${jobTypeConfig.id} = ${
    maintenanceRequests.jobTypeId
  } and ${jobTypeConfig.organisationId} = ${maintenanceRequests.organisationId} and ${
    jobTypeConfig.code
  } = ${sql.raw(`'${code}'`)})`;
}

/**
 * PLANNED VERSUS REACTIVE, DEFINED ONCE — AND NO LONGER GUESSED.
 *
 * Planned is the job type whose stable code is `planned`; reactive is the one
 * whose code is `reactive`. They used to be an inference — a category naming
 * compliance, or tier 4 and above, was "planned" and everything else
 * "reactive" — and the owner ruled that out: a job's type is now a real field,
 * and a job with no type is Unclassified, which is neither. The rule lives
 * HERE rather than in the aggregate that draws the chart, because the chart's
 * segments are tappable — a reader who taps `Planned` gets a filtered page, and
 * the rule that decided the segment's height has to be the rule that decides
 * which jobs come back. Two copies would mean a bar of 30 that filters to 27.
 */
export const plannedCondition = jobTypeCodeCondition("planned");
export const reactiveCondition = jobTypeCodeCondition("reactive");

/**
 * WHICH DATE PUTS A JOB IN THE COHORT — the master prompt §1.1.
 *
 * Not a filter. A filter narrows a cohort; this chooses the axis the cohort is
 * cut along, and every card on the page follows it: with `completed` selected,
 * "226 jobs requested in this period" becomes "226 jobs completed in this
 * period" and every breakdown regroups those jobs. That is why it lives beside
 * the filters in one state object and in one URL, and why `activeFilterCount`
 * deliberately does NOT count it — a reader who has switched axis has not
 * filtered anything, and a `Filters (1)` badge over an unfiltered page is a
 * lie the mobile sheet would repeat.
 */
/*
 * DECLARED IN `overview-meters.ts` AND RE-EXPORTED HERE, not the other way
 * round. This module imports drizzle and `db/schema`; a client component that
 * needed the type would have pulled the whole query builder into the browser
 * bundle to render the words "Date completed". Server callers keep importing it
 * from here, where the rest of the filter state is.
 */
export { DEFAULT_MEASURE, type CohortMeasure } from "./overview-meters";
const MEASURE_KEYS: CohortMeasure[] = ["requested", "completed"];

export type DashboardFilters = {
  period: PeriodKey;
  from: string | null;
  to: string | null;
  /** `requested` (default) or `completed` — see `CohortMeasure`. */
  measure: CohortMeasure;
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
  measure: DEFAULT_MEASURE,
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
  const measureRaw = (params.get("measure") ?? "").trim();
  return {
    period,
    from: day("from"),
    to: day("to"),
    measure: (MEASURE_KEYS as string[]).includes(measureRaw)
      ? (measureRaw as CohortMeasure)
      : DEFAULT_MEASURE,
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
  if (filters.measure !== DEFAULT_MEASURE) params.set("measure", filters.measure);
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
 * ON THE JOBS BOARD — or on no board yet — and on no other.
 *
 * `maintenance_requests` holds every board's rows, not only jobs: a Store
 * Documentation register row is a request row placed on `store-documentation`,
 * and a workspace section's rows are placed on a `sec-…` board. The Jobs board
 * draws only its own placements, so an aggregate that counted every live row
 * reported jobs the board it drills into could never show — measured on the
 * development estate, "98 open jobs" over a board drawing 82, the 16 being
 * Store Documentation rows at `Pending Approval` and `site-unassigned`.
 *
 * `not exists`, correlated, for the reason `unassignedSiteCondition` gives: a
 * `NOT IN` over a subquery is a NULL trapdoor in both dialects. The organisation
 * is matched against the OUTER row and the board key is a constant written into
 * the statement, so this adds no bound variable at all — every statement that
 * reaches it through `liveWorkOrderCondition` keeps its distance from D1's
 * ~100-variable ceiling, which several of them chunk right up against.
 *
 * The browser twin is `isOnJobsBoard` in `job-metrics.ts`.
 */
export function jobsBoardCondition(): SQL {
  return sql`not exists (select 1 from ${maintenanceGroupItems} where ${
    maintenanceGroupItems.requestId
  } = ${maintenanceRequests.id} and ${maintenanceGroupItems.organisationId} = ${
    maintenanceRequests.organisationId
  } and ${maintenanceGroupItems.boardId} <> ${sql.raw(`'${JOBS_BOARD_KEY}'`)})`;
}

/**
 * The rows that count as work at all — the same three exclusions
 * `liveWorkOrder` applies in `/api/workspace` and `countsAsWorkOrder` applies
 * in the browser. A binned job, an archived one and a subitem are not work —
 * and neither is a row that lives on another board (see `jobsBoardCondition`).
 */
export function liveWorkOrderCondition(orgId: string): SQL {
  return and(
    eq(maintenanceRequests.organisationId, orgId),
    isNull(maintenanceRequests.deletedAt),
    eq(maintenanceRequests.archived, false),
    isNull(maintenanceRequests.parentId),
    jobsBoardCondition(),
  )!;
}

/**
 * A DATE-ISH COLUMN AS ISO-COMPARABLE TEXT, ON EITHER DIALECT.
 *
 * DELIBERATELY THE SAME EXPRESSION as `dateText` in `dashboard-aggregates.ts`,
 * and deliberately a second copy of it. That module imports this one, so this
 * one cannot import it back; a cycle between the filter vocabulary and the
 * aggregates that consume it is a worse problem than one duplicated line, and
 * `tests/ops-rebuild-foundations.test.mjs` pins the two renderings identical so
 * they cannot drift apart unnoticed.
 *
 * The reasoning is written out in full over there. In short: Production's
 * `completed_at` and `due_at` are real Postgres `date` columns, Postgres has no
 * `trim(date)`, and the Overview answered "temporarily unavailable" for a day
 * with `function pg_catalog.btrim(date) does not exist` as the reason —
 * something nothing on Staging, where those columns are `text`, could ever have
 * shown.
 */
function dayTextSql(column: SQL | ReturnType<typeof sql>): SQL {
  return sql`replace(trim(cast(${column} as text)), ' ', 'T')`;
}

/** The column a cohort measure is cut along. */
function measureColumn(measure: CohortMeasure) {
  return measure === "completed"
    ? maintenanceRequests.completedAt
    : maintenanceRequests.requestedAt;
}

/**
 * `requested_at` inside a window, compared date-only. See the module note.
 *
 * With `measure = "completed"` the axis becomes `completed_at` and the cohort
 * is "jobs completed in this range" (§1.1). Two differences follow and both
 * matter:
 *
 *   · a job with no completion date is EXCLUDED rather than swept in. Without
 *     the emptiness guard an all-time window — which has no lower bound — would
 *     match every blank string, because `'' < '2026-09-11'` is true;
 *   · the column goes through `dayTextSql` before any text operation, because
 *     `completed_at` is a real `date` on Production.
 *
 * `requested_at` keeps the bare comparison it has always had: it is NOT NULL
 * with a default on every database `db/init.ts` created, and the existing
 * expectation is pinned.
 */
export function withinWindowCondition(
  window: PeriodWindow,
  measure: CohortMeasure = DEFAULT_MEASURE,
): SQL {
  if (measure === "completed") {
    const day = dayTextSql(sql`${maintenanceRequests.completedAt}`);
    const clauses: SQL[] = [
      sql`${maintenanceRequests.completedAt} is not null`,
      sql`${day} <> ''`,
      sql`substr(${day}, 1, 10) < ${window.endExclusive}`,
    ];
    if (window.start) clauses.push(sql`substr(${day}, 1, 10) >= ${window.start}`);
    return and(...clauses)!;
  }
  const clauses: SQL[] = [
    sql`${maintenanceRequests.requestedAt} < ${window.endExclusive}`,
  ];
  if (window.start) {
    clauses.push(sql`${maintenanceRequests.requestedAt} >= ${window.start}`);
  }
  return and(...clauses)!;
}

/**
 * THE JOBS THE COHORT LEAVES OUT, AND WHY — §1.1's footnote.
 *
 * "Jobs with no Date Requested are excluded from the cohort and reported in a
 * footnote — *14 jobs excluded — no request date recorded* — linking to those
 * records. Never impute a date."
 *
 * Scoped to the live estate and to the page's dimensional filters, but NOT to
 * the window: a row with no date on the axis cannot be inside a window on that
 * axis, so windowing the count would always answer zero. That is the whole
 * point of the footnote — these are the records the period cannot see.
 */
export function measureMissingCondition(
  orgId: string,
  filters: DashboardFilters,
): SQL {
  const column = measureColumn(filters.measure);
  /* NOT `blank()`: that spells emptiness with `trim(column)`, and `completed_at`
     is a real `date` on Production where `trim` throws. Same test, cast first. */
  const day = dayTextSql(sql`${column}`);
  return and(
    liveWorkOrderCondition(orgId),
    sql`(${column} is null or ${day} = '')`,
    ...dimensionConditions(filters, orgId),
  )!;
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
   * Nature — the job's canonical TYPE, by code. OR within the dimension, like
   * every other: both selected is "planned or reactive", never `planned AND
   * reactive`, which would return nothing and read as a broken filter. It is
   * no longer "no condition", because the two are no longer a partition: a
   * Project, a custom type or an Unclassified job is neither, and reading
   * "reactive" as "not planned" would have classified every untyped job.
   */
  if (filters.natures.length) {
    const clause = anyOf(
      filters.natures.map((nature) => (nature === "planned" ? plannedCondition : reactiveCondition)),
    );
    if (clause) conditions.push(clause);
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
    withinWindowCondition(window, filters.measure),
    ...dimensionConditions(filters, orgId),
  )!;
}

/**
 * The same scope over an arbitrary window — used for the previous-period delta.
 *
 * Follows the same axis as the page, because a delta between a cohort cut on
 * one date and a cohort cut on another is not a comparison of anything.
 */
export function jobScopeConditionForWindow(
  orgId: string,
  filters: DashboardFilters,
  start: string,
  endExclusive: string,
): SQL {
  return and(
    liveWorkOrderCondition(orgId),
    withinWindowCondition(
      { key: filters.period, start, endExclusive, days: 0, label: "", previous: null },
      filters.measure,
    ),
    ...dimensionConditions(filters, orgId),
  )!;
}

export { blank as blankColumn, present as presentColumn, anyOf as anyOfClauses };
export { or };
