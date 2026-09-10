/**
 * THE REBUILT OVERVIEW'S NUMBERS, COUNTED IN THE DATABASE.
 *
 * `dashboard-aggregates.ts` is the previous Overview's arithmetic and it stays
 * where it is: eight test files pin literal expressions inside it, and several
 * of those pins protect contracts that are still live (the overdue rule, the
 * planned/reactive inference, the contractor key shape, the `dateText` cast).
 * The master prompt's rebuild is additive rather than a rewrite of that file,
 * so everything new lives here and the payload shapes come from ONE place —
 * `app/(app)/portal/ops/overview-contract.ts`, imported as types so the card
 * and the aggregate cannot disagree about a field name.
 *
 * ── THE FOUR RULES EVERY STATEMENT BELOW OBEYS ────────────────────────────
 *
 * 1. ONE DIALECT. Every statement has to run on Miniflare's SQLite and on
 *    Supabase Postgres. `db/sqlite-to-postgres.ts` refuses `julianday(`,
 *    `strftime(`, `unixepoch(`, `json_extract(`, `printf(`, `GLOB` and `rowid`
 *    by name, and there are no window functions here either — `OVER` /
 *    `PARTITION BY` do not survive the shim, which is why `loadSitesAttention`
 *    caps per-site rows in JS rather than in SQL.
 *
 * 2. ALL DAY ARITHMETIC HAPPENS IN JS, from the ONE `now` the route resolved,
 *    and reaches SQL as a bare `YYYY-MM-DD` comparison. The technique and the
 *    reason are written out in the header of `dashboard-filters.ts`.
 *
 * 3. EVERY TEXT OPERATION ON A DATE COLUMN GOES THROUGH `dateText()` FIRST.
 *    This is the one that has already cost a Production outage. `due_at`,
 *    `completed_at` and `target_completion_date` are real Postgres `date`
 *    columns on Production and `text` on Staging, so `trim()`/`substr()` on
 *    them answers `function pg_catalog.btrim(date) does not exist` on
 *    Production and nowhere else. MEASURED WHILE BUILDING THIS MODULE and
 *    worth writing down: `requested_at`, `updated_at` and
 *    `item_activity.created_at` are `timestamp with time zone` on Staging, and
 *    `select substr(requested_at, 1, 10) from portal.maintenance_requests`
 *    fails there with the identical class of error —
 *    `42883 function substr(timestamp with time zone, integer, integer) does
 *    not exist`. So the rule is not "the three date columns"; it is EVERY
 *    date-ish column, including the two that look like plain text locally.
 *
 * 4. PERCENTILES WITHOUT `percentile_cont`. SQLite has no ordered-set
 *    aggregate, so a median or a p90 is computed here from GROUPED COUNTS:
 *    `group by` the date PAIR — `substr(dateText(requested_at),1,10)` and
 *    `substr(dateText(completed_at),1,10)` — which returns at most one row per
 *    distinct pair and never one row per job, and the day difference, the
 *    median and the p90 come out of `quantileFromCounts` below. It is exact,
 *    not a sample: every job is represented by its count.
 *
 * ── WHAT "AGGREGATE ROWS, NEVER JOB ROWS" MEANS HERE ──────────────────────
 *
 * Every read below is a `GROUP BY` whose row count is bounded by the number of
 * DISTINCT values, not by the size of the board. The three exceptions are
 * deliberate, capped, and never reach the browser: the single oldest open job
 * (one row), the single largest costed job (one row), and the twelve
 * longest-held stuck jobs (`§2.4` shows six). `SELECT *` on
 * `maintenance_requests` appears nowhere.
 */

import { and, count, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  contractorNameAliases,
  contractors,
  dashboardMeters,
  itemActivity,
  jobStatusMap,
  maintenanceRequests,
  sites,
  slaTargets,
  bankHolidays,
} from "../../db/schema";
import { closedJobSql, dateText } from "./dashboard-aggregates";
import {
  blankColumn,
  daysBetweenDays,
  dayString,
  jobScopeCondition,
  jobScopeConditionForWindow,
  liveWorkOrderCondition,
  measureMissingCondition,
  NOT_RECORDED_KEY,
  shiftDay,
  unassignedSiteCondition,
  type DashboardFilters,
  type PeriodWindow,
} from "./dashboard-filters";
import {
  NOT_RECORDED_LABEL,
  UNASSIGNED_SITE_LABEL,
  normalisePriority,
  statusKey,
  type PriorityKey,
} from "./job-metrics";
import {
  CATCH_ALL_METER,
  METER_KEYS,
  METER_SEED_COLOUR,
  METER_SEED_LABEL,
  NOT_RECORDED_INK,
  OVERVIEW_PRIORITY_COLOUR,
  SEVERITY_KEYS,
  WAITING_METERS,
  cohortWording,
  meterForStatus,
  orderMeters,
  seedMeterDefinitions,
  severityBand,
  sharesOfRecorded,
  tealScale,
  type MeterDefinition,
  type MeterKey,
} from "./overview-meters";
import { chunkIds } from "./sql-batching";
import type {
  AttentionSiteRow,
  BreakdownBucket,
  BreakdownDimension,
  BreakdownPayload,
  ContractorSpendRow,
  CostPayload,
  CostSiteRow,
  Bucketing,
  Delta,
  MeterRow,
  MetersPayload,
  PerformancePayload,
  RecordRow,
  RecordsPayload,
  RecordsQuery,
  SeverityCounts,
  SitesAttentionPayload,
  SlaStage,
  SpendBucket,
  StuckPayload,
  StuckRow,
  TimeToCloseBucket,
} from "../(app)/portal/ops/overview-contract";

type Database = Awaited<ReturnType<typeof getDb>>;

/** Every loader returns its payload minus `period`; the route adds that. */
type Body<T> = Omit<T, "period">;

/* ══ Shared SQL vocabulary ══════════════════════════════════════════════════ */

/**
 * `dateText` widened to anything that can appear in a `sql` template.
 *
 * `dateText`'s parameter type is `dashboard-aggregates.ts`'s private
 * `TextColumn`, which pins `notNull: boolean`; `requested_at` and `updated_at`
 * are `.notNull()` columns whose generic argument is `notNull: true`, and
 * TypeScript will not widen one into the other. The cast is at the boundary
 * rather than in the expression, so there is still exactly ONE rendering of the
 * cast in this codebase and `tests/ops-rebuild-foundations.test.mjs` keeps the
 * two copies it already knows about identical.
 */
type DateishColumn = Parameters<typeof dateText>[0];
function dayText(column: unknown): SQL {
  return dateText(column as DateishColumn);
}

/** The first ten characters of a date-ish column: `YYYY-MM-DD`, on both dialects. */
function dayOnly(column: unknown): SQL {
  return sql`substr(${dayText(column)}, 1, 10)`;
}

/**
 * A column `db/schema.ts` does not declare, qualified by its table.
 *
 * `status_changed_at`, `acknowledged_at`, `assigned_at`, `attended_at` and
 * `job_status_map.meter_key` are added by `addColumn` on the boot path in
 * `db/init.ts` and have no drizzle field. `db/**` belongs to another workstream
 * and is not edited from here, so they are named as text — qualified, so a
 * join can never make one ambiguous.
 */
function rawColumn(table: typeof maintenanceRequests | typeof jobStatusMap, name: string): SQL {
  return sql`${table}.${sql.raw(name)}`;
}

const openJobSql = sql`not ${closedJobSql}`;

/**
 * The priority spellings this estate carries, folded through the ONE
 * classifier so the SQL and the browser cannot bucket a job differently.
 *
 * The candidate list mirrors `PRIORITY_CANDIDATES` in `dashboard-filters.ts`
 * for the same reason that one exists: `normalisePriority` is the authority and
 * the answers are derived from it rather than typed out a second time.
 */
const PRIORITY_SPELLINGS = [
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

const URGENT_SPELLINGS = [
  ...new Set(
    PRIORITY_SPELLINGS.filter((value) => normalisePriority(value) === "urgent").map((value) =>
      value.toLowerCase(),
    ),
  ),
];

const RECOGNISED_PRIORITIES = [
  ...new Set(
    PRIORITY_SPELLINGS.filter((value) => normalisePriority(value) !== "not_recorded").map((value) =>
      value.toLowerCase(),
    ),
  ),
];

const urgentSql = sql`lower(trim(${maintenanceRequests.priority})) in ${URGENT_SPELLINGS}`;

/** A cost that is a recorded trade spend. Zero and negative are data quality, not money. */
const costedSql = sql`(${maintenanceRequests.cost} is not null and ${maintenanceRequests.cost} > 0)`;

/**
 * `cost` IS THE AUTHORITY, AND IT IS POUNDS.
 *
 * Both columns exist on Supabase and only one of them exists everywhere:
 *
 *   · local Miniflare D1 has NO `cost_pence` on `maintenance_requests` at all
 *     (`pragma_table_info` returns `cost` and nothing else), so a statement
 *     naming it would throw "no such column" on every developer machine;
 *   · on Staging `cost` is populated on 104 rows and `cost_pence` on 92, and
 *     `cost_pence = round(cost * 100)` on all 92 where both are set. `cost` is
 *     therefore a strict superset with no disagreement to resolve;
 *   · every existing reader — `loadCost` in `dashboard-aggregates.ts`,
 *     `periodSpendSeries` in `period-model.ts`, the Reports spend split — reads
 *     `cost`. Two readers of two columns is how a card comes to disagree with a
 *     report about one number.
 *
 * So `cost` is read and converted to integer pence ON THE WAY OUT, in SQL
 * rather than in JS: every partition then sums exact integers, which is what
 * makes §9.18 — "spend by site totals equal the headline exactly" — true by
 * construction rather than by a rounding adjustment.
 */
const costPenceSql = sql`cast(round(${maintenanceRequests.cost} * 100) as integer)`;
const spendPenceSql = sql<number>`coalesce(sum(case when ${costedSql} then ${costPenceSql} else 0 end), 0)`;

/** The column the cohort is cut along — §1.1's Measure by. */
function measureColumn(filters: DashboardFilters) {
  return filters.measure === "completed"
    ? maintenanceRequests.completedAt
    : maintenanceRequests.requestedAt;
}

/**
 * §2.2's "Incomplete records", defined once and counted in SQL.
 *
 * A job counts as incomplete when ANY of the five fields a coordinator needs to
 * act on it is missing: no site the register knows, no recognised priority, no
 * engineer type, no tier, or — once the work is finished — no cost. Those are
 * the five the master prompt names, and each is separately reachable from the
 * data-quality rows, so the headline figure and the repair lists agree.
 *
 * The priority arm tests the NORMALISED value rather than emptiness, because 22
 * imported rows carry the literal string "[object Object]" where a blank should
 * be, and a null check alone reports them as recorded.
 */
function incompleteRecordSql(orgId: string): SQL {
  return sql`(${unassignedSiteCondition(orgId)}
    or ${blankColumn(sql`${maintenanceRequests.priority}`)}
    or lower(trim(${maintenanceRequests.priority})) not in ${RECOGNISED_PRIORITIES}
    or ${blankColumn(sql`${maintenanceRequests.engineer}`)}
    or ${maintenanceRequests.tier} is null
    or ${maintenanceRequests.tier} = 0
    or (${closedJobSql} and not ${costedSql}))`;
}

/* ══ Pure helpers — the arithmetic, testable without a database ═════════════ */

/**
 * §4.2's bucketing rule: ≤ 31 days daily, 32–120 weekly, > 120 monthly.
 *
 * The boundaries are inclusive on both sides as the table states them, so 31 is
 * the last daily width and 32 the first weekly one; 120 is the last weekly and
 * 121 the first monthly.
 */
export function bucketingFor(days: number): Bucketing {
  if (!Number.isFinite(days) || days <= 31) return "daily";
  if (days <= 120) return "weekly";
  return "monthly";
}

export type OverviewBucket = {
  label: string;
  start: string;
  endExclusive: string;
  endInclusive: string;
  /** A bucket whose window has not finished. Drawn hatched, never as a zero. */
  partial: boolean;
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `3 Aug` — a real date, never "Week 1". §4.2. */
function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(date)} ${MONTH_NAMES[Number(month) - 1] ?? ""}`.trim();
}

function monthLabel(day: string): string {
  const [year, month] = day.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? ""} ${year}`;
}

/** The Monday on or before a day. `Date.UTC` day 0 is Sunday. */
function weekStart(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return shiftDay(day, weekday === 0 ? -6 : 1 - weekday);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function nextMonth(day: string): string {
  const [year, month] = day.split("-").map(Number);
  return dayString(new Date(Date.UTC(year, month, 1)));
}

/**
 * The buckets a window is drawn in, INCLUDING the empty ones.
 *
 * A `GROUP BY` returns no row for a day nothing matched, and a chart drawn
 * straight from that silently omits its gaps. Every series here is projected
 * onto this list, so a zero is a zero and an absence is impossible.
 *
 * `dataStart` is only consulted for an unbounded window ("all time"), where
 * there is no `window.start` to bucket from; the caller supplies the earliest
 * day the cohort actually holds so the axis begins at the data rather than at
 * an arbitrary year.
 */
export function overviewBuckets(
  window: PeriodWindow,
  now: Date,
  dataStart?: string | null,
): { bucketing: Bucketing; buckets: OverviewBucket[] } {
  const today = dayString(now);
  const end = window.endExclusive;
  const start =
    window.start ??
    (dataStart && dataStart < end ? dataStart : shiftDay(end, -365));
  const days = Math.max(1, daysBetweenDays(start, end));
  const bucketing = window.start === null ? "monthly" : bucketingFor(days);

  const buckets: OverviewBucket[] = [];
  /*
   * The END is clamped to the window and the START deliberately is not. A
   * weekly bucket is labelled by its week-commencing MONDAY, which can fall
   * before the window's first day; the counts are unaffected because the cohort
   * predicate has already excluded anything outside the window, and a label
   * reading "w/c 8 Jun" over a range starting on the 13th is the honest one.
   */
  const push = (from: string, toExclusive: string, label: string) => {
    const clampedTo = toExclusive > end ? end : toExclusive;
    if (from >= clampedTo) return;
    const endInclusive = shiftDay(clampedTo, -1);
    buckets.push({
      label,
      start: from,
      endExclusive: clampedTo,
      endInclusive,
      /* Partial means "this window has not finished". A bucket that contains
         today qualifies — today is not over — and so does one entirely ahead
         of it. Anything wholly in the past is complete. */
      partial: endInclusive >= today,
    });
  };

  /* 400 is a hard stop, not a policy: a daily axis is capped at 31 by the rule
     above, a weekly one at ~18, and a monthly one only runs away on an
     "all time" window over an estate with a decade of history. */
  const LIMIT = 400;

  if (bucketing === "daily") {
    for (let day = start; day < end && buckets.length < LIMIT; day = shiftDay(day, 1)) {
      push(day, shiftDay(day, 1), shortDay(day));
    }
  } else if (bucketing === "weekly") {
    for (
      let day = weekStart(start);
      day < end && buckets.length < LIMIT;
      day = shiftDay(day, 7)
    ) {
      push(day, shiftDay(day, 7), `w/c ${shortDay(day)}`);
    }
  } else {
    for (
      let day = monthStart(start);
      day < end && buckets.length < LIMIT;
      day = nextMonth(day)
    ) {
      push(day, nextMonth(day), monthLabel(day));
    }
  }

  if (!buckets.length) {
    const endInclusive = shiftDay(end, -1);
    buckets.push({
      label: shortDay(start),
      start,
      endExclusive: end,
      endInclusive,
      partial: endInclusive >= today,
    });
  }
  return { bucketing, buckets };
}

/**
 * Which bucket a `YYYY-MM-DD` falls in, CLAMPED to the ends of the axis.
 *
 * Clamped rather than dropped, and that is a decision worth naming. With
 * `measure = requested` the cohort is "jobs raised in this range" while §4.3
 * buckets by COMPLETION, so a job raised on the last day of the range and
 * closed a week later has a completion day past the last bucket. Dropping it
 * would make the chart disagree with the headline median beneath it, and §1.5
 * requires every total to equal the sum of its visible parts. It is folded into
 * the nearest bucket instead.
 */
export function bucketIndexFor(buckets: readonly OverviewBucket[], day: string): number {
  if (!buckets.length || !day) return -1;
  if (day < buckets[0].start) return 0;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (day >= buckets[index].start) return index;
  }
  return buckets.length - 1;
}

export type CountedValue = { value: number; count: number };

/**
 * A QUANTILE FROM GROUPED COUNTS, BECAUSE `percentile_cont` IS NOT PORTABLE.
 *
 * SQLite has no ordered-set aggregate, so the values arrive as
 * `{ value, count }` pairs out of a `GROUP BY` and the order statistic is found
 * by walking the cumulative count. Exact, not sampled: a pair with a count of
 * 40 stands for 40 jobs.
 *
 * The definition is the averaged order statistic (R's type 2, SAS's default):
 * `h = q * n`; when `h` is a whole number the answer is the mean of the values
 * at 0-based indices `h-1` and `h`, otherwise it is the value at `ceil(h)-1`.
 * That is chosen because it makes `quantile(…, 0.5)` the textbook median — the
 * mean of the two middle values on an even sample — while giving p90 the usual
 * nearest-rank answer. Using nearest-rank for both would report a "median" that
 * a reader checking four jobs by hand would not recognise.
 */
export function quantileFromCounts(
  entries: readonly CountedValue[],
  quantile: number,
): number | null {
  const sorted = entries
    .filter((entry) => Number.isFinite(entry.value) && entry.count > 0)
    .sort((left, right) => left.value - right.value);
  const total = sorted.reduce((sum, entry) => sum + entry.count, 0);
  if (total <= 0) return null;

  const at = (rank: number): number => {
    /* `rank` is 0-based over the expanded sample. */
    let seen = 0;
    for (const entry of sorted) {
      seen += entry.count;
      if (rank < seen) return entry.value;
    }
    return sorted[sorted.length - 1].value;
  };

  const h = quantile * total;
  if (Number.isInteger(h) && h >= 1 && h < total) {
    return (at(h - 1) + at(h)) / 2;
  }
  const index = Math.min(total - 1, Math.max(0, Math.ceil(h) - 1));
  return at(index);
}

/** The weighted mean of grouped counts. Never used where §4.3 forbids a mean. */
export function averageFromCounts(entries: readonly CountedValue[]): number | null {
  let sum = 0;
  let total = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.value) || entry.count <= 0) continue;
    sum += entry.value * entry.count;
    total += entry.count;
  }
  return total ? sum / total : null;
}

export function emptySeverity(): SeverityCounts {
  return { fresh: 0, ageing: 0, overdue: 0, critical: 0 };
}

/** Add `count` jobs that have been open `days` days into a severity tally. */
export function addSeverity(into: SeverityCounts, days: number, amount = 1): SeverityCounts {
  into[severityBand(days)] += amount;
  return into;
}

function totalSeverity(counts: SeverityCounts): number {
  return SEVERITY_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

/** A whole number of days between two `YYYY-MM-DD` values, never negative. */
function daysSince(day: string | null | undefined, today: string): number | null {
  const from = (day ?? "").slice(0, 10);
  if (from.length !== 10) return null;
  return Math.max(0, daysBetweenDays(from, today));
}

function penceToPounds(pence: number): string {
  const pounds = pence / 100;
  return pounds >= 1000
    ? `£${Math.round(pounds).toLocaleString("en-GB")}`
    : `£${pounds.toFixed(2)}`;
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function delta(value: number | null, previous: number | null): Delta {
  return { value, previous };
}

/**
 * A NAME NORMALISED THE WAY `contractor_name_aliases.normalised` IS.
 *
 * "Lower-cased, whitespace-collapsed", per the column's own documentation. The
 * collapsing cannot be expressed portably in SQL — SQLite has no regex — so the
 * alias table is read whole (it is a per-workspace list of typed names, tens of
 * rows) and the match is made here against the same normaliser. That is also
 * what fixes §3.6's complaint: the card reported "Not linked" against names
 * that already had an alias, because it only ever looked at `contractor_id`.
 */
export function normaliseContractorName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* ══ Meters — §2.1 to §2.3 ══════════════════════════════════════════════════ */

type StatusTally = {
  status: string;
  total: number;
  open: number;
  urgentOpen: number;
  incomplete: number;
};

function readTally(row: Record<string, unknown>): StatusTally {
  return {
    status: String(row.status ?? "").trim(),
    total: Number(row.total ?? 0),
    open: Number(row.open ?? 0),
    urgentOpen: Number(row.urgentOpen ?? 0),
    incomplete: Number(row.incomplete ?? 0),
  };
}

function tallySelection(orgId: string) {
  return {
    status: maintenanceRequests.status,
    total: count(),
    open: sql<number>`sum(case when ${openJobSql} then 1 else 0 end)`,
    urgentOpen: sql<number>`sum(case when ${openJobSql} and ${urgentSql} then 1 else 0 end)`,
    incomplete: sql<number>`sum(case when ${incompleteRecordSql(orgId)} then 1 else 0 end)`,
  };
}

/**
 * The workspace's meters, merged over the seed.
 *
 * Merged rather than replaced: §2.1 makes the eight keys canonical and `other`
 * a permanent catch-all, so a workspace whose `dashboard_meters` rows are
 * missing or partial still gets eight meters and still reconciles. What the
 * rows supply is the part an operator owns — the display name, the colour, the
 * order and whether the meter draws a tile.
 */
async function readMeterDefinitions(db: Database, orgId: string): Promise<MeterDefinition[]> {
  const rows = await db
    .select({
      key: dashboardMeters.meterKey,
      label: dashboardMeters.displayLabel,
      colour: dashboardMeters.colourHex,
      sortOrder: dashboardMeters.sortOrder,
      visible: dashboardMeters.visible,
      isCatchAll: dashboardMeters.isCatchAll,
    })
    .from(dashboardMeters)
    .where(eq(dashboardMeters.organisationId, orgId));

  const configured = new Map(rows.map((row) => [String(row.key), row]));
  const merged: MeterDefinition[] = METER_KEYS.map((key, index) => {
    const row = configured.get(key);
    return {
      key,
      label: row?.label?.trim() || METER_SEED_LABEL[key],
      colour: row?.colour?.trim() || METER_SEED_COLOUR[key],
      sortOrder: row ? Number(row.sortOrder) : index,
      /* §2.1: `other` cannot be hidden, whatever a row says. Hiding it would
         remove the one meter that guarantees the eight sum to the cohort. */
      visible: key === CATCH_ALL_METER ? true : row ? Boolean(row.visible) : true,
      isCatchAll: key === CATCH_ALL_METER,
    };
  });
  return orderMeters(merged.length ? merged : seedMeterDefinitions());
}

/** `job_status_map` as normalised-label → meter key, plus the labels it knows. */
async function readStatusAssignments(
  db: Database,
  orgId: string,
): Promise<{
  assignments: Map<string, string>;
  labelsByMeter: Map<string, string[]>;
  known: Set<string>;
}> {
  const rows = await db
    .select({
      label: jobStatusMap.sourceStatusLabel,
      meter: sql<string | null>`${rawColumn(jobStatusMap, "meter_key")}`,
    })
    .from(jobStatusMap)
    .where(eq(jobStatusMap.organisationId, orgId));

  const assignments = new Map<string, string>();
  const labelsByMeter = new Map<string, string[]>();
  const known = new Set<string>();
  for (const row of rows) {
    const label = String(row.label ?? "").trim();
    if (!label) continue;
    known.add(statusKey(label));
    const meter = String(row.meter ?? "").trim();
    if (!meter) continue;
    assignments.set(statusKey(label), meter);
    const list = labelsByMeter.get(meter) ?? [];
    if (!list.includes(label)) list.push(label);
    labelsByMeter.set(meter, list);
  }
  return { assignments, labelsByMeter, known };
}

export async function loadMeters(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<Body<MetersPayload>> {
  const scope = jobScopeCondition(orgId, filters, window);
  const today = dayString(now);
  const previousScope = window.previous
    ? jobScopeConditionForWindow(orgId, filters, window.previous.start, window.previous.endExclusive)
    : null;

  const [
    definitions,
    assignment,
    currentRows,
    previousRows,
    openAgeRows,
    closeRows,
    oldestOpen,
    previousOldestOpen,
    excludedRows,
  ] = await Promise.all([
    readMeterDefinitions(db, orgId),
    readStatusAssignments(db, orgId),
    db.select(tallySelection(orgId)).from(maintenanceRequests).where(scope).groupBy(maintenanceRequests.status),
    previousScope
      ? db
          .select(tallySelection(orgId))
          .from(maintenanceRequests)
          .where(previousScope)
          .groupBy(maintenanceRequests.status)
      : Promise.resolve(null),
    /*
     * The ageing of OPEN work, as one row per (status, day raised). The row
     * count is bounded by the number of distinct raised days in the cohort and
     * never by the board; the severity band, the oldest and the average all
     * come out of it in JS, from the one `now` the route resolved.
     */
    db
      .select({
        status: maintenanceRequests.status,
        raised: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("raised"),
        total: count(),
      })
      .from(maintenanceRequests)
      .where(and(scope, openJobSql))
      .groupBy(maintenanceRequests.status, sql`raised`),
    /* The same shape for CLOSED work, grouped by the date PAIR — §2.3's
       "Avg time to close 21d" on the Completed tile. */
    db
      .select({
        status: maintenanceRequests.status,
        raised: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("raised"),
        closed: sql<string>`${dayOnly(maintenanceRequests.completedAt)}`.as("closed"),
        total: count(),
      })
      .from(maintenanceRequests)
      .where(and(scope, closedJobSql, isNotNull(maintenanceRequests.completedAt)))
      .groupBy(maintenanceRequests.status, sql`raised`, sql`closed`),
    db
      .select({ reference: maintenanceRequests.reference, id: maintenanceRequests.id, raisedAt: maintenanceRequests.requestedAt })
      .from(maintenanceRequests)
      .where(and(scope, openJobSql))
      .orderBy(maintenanceRequests.requestedAt)
      .limit(1),
    previousScope
      ? db
          .select({ raisedAt: maintenanceRequests.requestedAt })
          .from(maintenanceRequests)
          .where(and(previousScope, openJobSql))
          .orderBy(maintenanceRequests.requestedAt)
          .limit(1)
      : Promise.resolve(null),
    db.select({ total: count() }).from(maintenanceRequests).where(measureMissingCondition(orgId, filters)),
  ]);

  const current = currentRows.map(readTally);
  const previous = previousRows?.map(readTally) ?? null;
  const cohortTotal = current.reduce((sum, row) => sum + row.total, 0);

  /*
   * THE FOLD, AND WHY IT CANNOT MISS A JOB — acceptance gate 11.
   *
   * `current` is a complete `GROUP BY status` over the cohort, so its totals
   * already sum to the cohort. `meterForStatus` maps every status to exactly
   * one meter and resolves anything unassigned to the catch-all, so the fold is
   * a partition of that set. The eight therefore sum to `cohortTotal` by
   * construction rather than by a reconciliation step — including for a status
   * invented after this code was written, which is §9.9.
   */
  const meterOf = (status: string): MeterKey => meterForStatus(assignment.assignments, status);

  const totals = new Map<string, { total: number; open: number }>();
  const previousTotals = new Map<string, number>();
  const observed = new Map<string, string[]>();
  let openTotal = 0;
  let urgentOpenTotal = 0;
  let incompleteTotal = 0;

  for (const row of current) {
    const key = meterOf(row.status);
    const entry = totals.get(key) ?? { total: 0, open: 0 };
    entry.total += row.total;
    entry.open += row.open;
    totals.set(key, entry);
    openTotal += row.open;
    urgentOpenTotal += row.urgentOpen;
    incompleteTotal += row.incomplete;
    const labels = observed.get(key) ?? [];
    if (row.status && !labels.includes(row.status)) labels.push(row.status);
    observed.set(key, labels);
  }
  for (const row of previous ?? []) {
    const key = meterOf(row.status);
    previousTotals.set(key, (previousTotals.get(key) ?? 0) + row.total);
  }

  /* Ageing, per meter, from the grouped days. */
  const ageing = new Map<
    string,
    { severity: SeverityCounts; oldest: number | null; days: CountedValue[] }
  >();
  for (const row of openAgeRows) {
    const key = meterOf(String(row.status ?? ""));
    const days = daysSince(String(row.raised ?? ""), today);
    if (days === null) continue;
    const amount = Number(row.total ?? 0);
    const entry = ageing.get(key) ?? { severity: emptySeverity(), oldest: null, days: [] };
    addSeverity(entry.severity, days, amount);
    entry.oldest = entry.oldest === null ? days : Math.max(entry.oldest, days);
    entry.days.push({ value: days, count: amount });
    ageing.set(key, entry);
  }

  const closing = new Map<string, CountedValue[]>();
  for (const row of closeRows) {
    const key = meterOf(String(row.status ?? ""));
    const raised = String(row.raised ?? "");
    const closed = String(row.closed ?? "");
    if (raised.length !== 10 || closed.length !== 10) continue;
    const entry = closing.get(key) ?? [];
    entry.push({
      value: Math.max(0, daysBetweenDays(raised, closed)),
      count: Number(row.total ?? 0),
    });
    closing.set(key, entry);
  }

  const shares = sharesOfRecorded(definitions.map((meter) => totals.get(meter.key)?.total ?? 0));

  const meters: MeterRow[] = definitions.map((meter, index) => {
    const tally = totals.get(meter.key) ?? { total: 0, open: 0 };
    const age = ageing.get(meter.key);
    const close = closing.get(meter.key);
    const previousTotal = previous ? previousTotals.get(meter.key) ?? 0 : null;
    const averageOpen = age ? averageFromCounts(age.days) : null;
    const averageClose = close ? averageFromCounts(close) : null;
    /*
     * The labels a tile drills into: everything `job_status_map` files under
     * this meter, plus anything observed in the cohort that folded here. The
     * second half is what makes the catch-all's chip honest — a status with no
     * map row is only ever discoverable from the data.
     */
    const owned = new Set<string>([
      ...(assignment.labelsByMeter.get(meter.key) ?? []),
      ...(observed.get(meter.key) ?? []),
    ]);
    return {
      key: meter.key,
      label: meter.label,
      colour: meter.colour,
      sortOrder: index,
      visible: meter.visible,
      isCatchAll: meter.isCatchAll,
      total: tally.total,
      open: tally.open,
      share: shares[index] ?? 0,
      previousTotal,
      delta: previousTotal === null ? null : tally.total - previousTotal,
      oldestOpenDays: age?.oldest ?? null,
      averageOpenDays: averageOpen === null ? null : Math.round(averageOpen),
      averageCloseDays: averageClose === null ? null : Math.round(averageClose),
      severity: age?.severity ?? emptySeverity(),
      statuses: [...owned].sort((left, right) => left.localeCompare(right, "en-GB")),
    };
  });

  const oldestRow = oldestOpen[0];
  const oldestDays = daysSince(String(oldestRow?.raisedAt ?? ""), today);
  const previousOldestDays = daysSince(String(previousOldestOpen?.[0]?.raisedAt ?? ""), today);

  return {
    measure: filters.measure,
    cohortTotal,
    excluded: Number(excludedRows[0]?.total ?? 0),
    meters,
    pulse: {
      open: delta(openTotal, previous ? previous.reduce((sum, row) => sum + row.open, 0) : null),
      urgentOpen: delta(
        urgentOpenTotal,
        previous ? previous.reduce((sum, row) => sum + row.urgentOpen, 0) : null,
      ),
      /*
       * BOTH FIGURES ARE AGED TO THE SAME INSTANT — today.
       *
       * "Of the work raised in each period, how old is the oldest piece still
       * open?" Ageing the previous cohort to the end of its own window would
       * answer a different question with today's open set, which is a figure
       * nothing in the database supports.
       */
      oldestOpenDays: {
        ...delta(oldestDays, previousOldestDays),
        reference: oldestRow?.reference ?? oldestRow?.id ?? null,
      },
      incompleteRecords: delta(
        incompleteTotal,
        previous ? previous.reduce((sum, row) => sum + row.incomplete, 0) : null,
      ),
    },
    unmappedStatuses: current
      .map((row) => row.status)
      .filter((label) => label && !assignment.known.has(statusKey(label)))
      .sort((left, right) => left.localeCompare(right, "en-GB")),
  };
}

/* ══ Where work is stuck — §2.4 ═════════════════════════════════════════════ */

/**
 * WHEN A JOB ENTERED ITS CURRENT STATUS, IN ONE EXPRESSION.
 *
 * §2.4's "Held for" resolves through three sources in order, and the first two
 * are the ones that carry authority:
 *
 *   1. the most recent `item_activity` row for this job with
 *      `column_key = 'status'` — the board's own audit trail;
 *   2. `maintenance_requests.status_changed_at`, written by the mutation path
 *      from the moment that column existed;
 *   3. `updated_at`, which is NOT NULL with a default on every estate and is
 *      therefore what makes this expression total.
 *
 * The activity lookup is a CORRELATED SCALAR SUBQUERY, evaluated once per row
 * by the index `item_activity_status_idx (request_id, column_key)` that
 * `db/init.ts` creates for exactly this. It is emphatically not a query per
 * row: the whole thing is one statement, and the two aggregates below embed it
 * twice between them.
 */
function statusEnteredSql(orgId: string): { activityAt: SQL; heldSince: SQL; heldDay: SQL } {
  const activityAt = sql`(select max(activity.created_at) from ${itemActivity} activity where activity.request_id = ${maintenanceRequests.id} and activity.column_key = 'status' and activity.organisation_id = ${orgId})`;
  /* `nullif(…, '')` at every step: the importer wrote empty strings where a
     null belongs, and `coalesce` would happily settle on one of them. */
  const heldSince = sql`coalesce(nullif(${dayText(activityAt)}, ''), nullif(${dayText(
    rawColumn(maintenanceRequests, "status_changed_at"),
  )}, ''), nullif(${dayText(maintenanceRequests.updatedAt)}, ''))`;
  return { activityAt, heldSince, heldDay: sql`substr(coalesce(${heldSince}, ''), 1, 10)` };
}

export async function loadStuckWork(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<Body<StuckPayload>> {
  const scope = jobScopeCondition(orgId, filters, window);
  const today = dayString(now);
  const thirtyDaysAgo = shiftDay(today, -30);

  const [definitions, assignment] = await Promise.all([
    readMeterDefinitions(db, orgId),
    readStatusAssignments(db, orgId),
  ]);

  const waitingKeys = new Set<string>(WAITING_METERS);
  const waitingStatusKeys = [...assignment.assignments.entries()]
    .filter(([, meter]) => waitingKeys.has(meter as MeterKey))
    .map(([key]) => key);

  const labelFor = new Map(definitions.map((meter) => [meter.key, meter.label]));
  const empty: Body<StuckPayload> = {
    measure: filters.measure,
    rows: [],
    totalWaiting: 0,
    byMeter: [...WAITING_METERS].map((key) => ({
      key,
      label: labelFor.get(key) ?? key,
      count: 0,
      overThirtyDays: 0,
    })),
    recovered: 0,
    fallback: 0,
  };
  if (!waitingStatusKeys.length) return empty;

  const waiting = sql`lower(trim(${maintenanceRequests.status})) in ${waitingStatusKeys}`;
  const { activityAt, heldSince, heldDay } = statusEnteredSql(orgId);
  const where = and(scope, openJobSql, waiting)!;

  const [grouped, rows, siteRows] = await Promise.all([
    db
      .select({
        status: maintenanceRequests.status,
        total: count(),
        overThirty: sql<number>`sum(case when ${heldDay} <> '' and ${heldDay} < ${thirtyDaysAgo} then 1 else 0 end)`,
        recovered: sql<number>`sum(case when ${activityAt} is not null then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.status),
    /*
     * The rows themselves. Twelve read, six shown: the ORDER BY is the same
     * expression the aggregate above counted with, so the ranking is already
     * exact and the extra six are only headroom against ties.
     */
    db
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        siteId: maintenanceRequests.siteId,
        status: maintenanceRequests.status,
        owner: maintenanceRequests.assignee,
        lastUpdate: sql<string>`${dayText(maintenanceRequests.updatedAt)}`,
        activityAt: sql<string | null>`${activityAt}`,
        statusChangedAt: sql<string | null>`${rawColumn(maintenanceRequests, "status_changed_at")}`,
        held: sql<string>`${heldSince}`.as("held"),
      })
      .from(maintenanceRequests)
      .where(where)
      .orderBy(sql`held`)
      .limit(12),
    db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.organisationId, orgId)),
  ]);

  const nameById = new Map(siteRows.map((row) => [row.id, row.name]));
  const perMeter = new Map<string, { count: number; overThirtyDays: number }>();
  let totalWaiting = 0;
  let recovered = 0;
  for (const row of grouped) {
    const key = meterForStatus(assignment.assignments, String(row.status ?? ""));
    const entry = perMeter.get(key) ?? { count: 0, overThirtyDays: 0 };
    entry.count += Number(row.total ?? 0);
    entry.overThirtyDays += Number(row.overThirty ?? 0);
    perMeter.set(key, entry);
    totalWaiting += Number(row.total ?? 0);
    recovered += Number(row.recovered ?? 0);
  }

  const stuck: StuckRow[] = rows.map((row) => {
    const activity = String(row.activityAt ?? "").trim();
    const column = String(row.statusChangedAt ?? "").trim();
    const heldSinceValue = String(row.held ?? "").trim() || null;
    const meterKey = meterForStatus(assignment.assignments, String(row.status ?? ""));
    const rawSite = String(row.siteId ?? "").trim();
    return {
      id: row.id,
      reference: row.reference ?? null,
      title: row.title,
      siteId: rawSite && nameById.has(rawSite) ? rawSite : null,
      siteName: rawSite && nameById.has(rawSite) ? nameById.get(rawSite)! : UNASSIGNED_SITE_LABEL,
      meterKey,
      meterLabel: labelFor.get(meterKey) ?? meterKey,
      heldDays: daysSince(heldSinceValue, today) ?? 0,
      heldSince: heldSinceValue,
      heldSource: activity ? "activity" : column ? "column" : "updated_at",
      lastUpdate: String(row.lastUpdate ?? "").trim() || null,
      owner: (row.owner ?? "").trim() || null,
      status: (row.status ?? "").trim() || "No status",
    };
  });
  stuck.sort((left, right) => right.heldDays - left.heldDays);

  return {
    measure: filters.measure,
    rows: stuck.slice(0, 6),
    totalWaiting,
    byMeter: [...WAITING_METERS].map((key) => ({
      key,
      label: labelFor.get(key) ?? key,
      count: perMeter.get(key)?.count ?? 0,
      overThirtyDays: perMeter.get(key)?.overThirtyDays ?? 0,
    })),
    recovered,
    /* §2.4 asks for exactly these two: how many rows the activity log could
       answer for, and how many fell back to a column. */
    fallback: totalWaiting - recovered,
  };
}

/* ══ Breakdown dimensions — shared by §3.5 and §5.3 ═════════════════════════ */

type RawBucket = { key: string; label: string; value: number; byPriority?: Record<string, number> };

/**
 * One dimension, assembled to §1.4's percentage rule.
 *
 * `recorded` is the denominator and it is ALWAYS returned beside the shares, so
 * the card can print "193 of 226 recorded (85%)" and never a bare percentage
 * whose denominator is off screen. "Not recorded" is appended last, is grey,
 * and carries no share of its own — it is not a category, it is the coverage
 * gap.
 *
 * Colour is `tealScale` by RANK, darkest for the largest, per §1.3.
 * `categoricalColour` from `job-metrics.ts` is deliberately never used on this
 * page: three of its eight collided with the semantic family, priority and
 * ageing colours used six inches away on the same screen.
 */
function buildDimension(
  key: string,
  label: string,
  entries: RawBucket[],
  notRecorded: number,
  notRecordedByPriority: Record<string, number> | null,
  total: number,
  options: {
    top?: number;
    /** Keep zero-valued buckets, so an absence is visible — §5.3's tiers. */
    keepZeros?: boolean;
    colourFor?: (entry: RawBucket, rank: number) => string;
    sort?: boolean;
    /*
     * THE KEY THE GREY BUCKET FILTERS BY, when it is not the shared sentinel.
     *
     * `NOT_RECORDED_KEY` ("__not_recorded__") is one value across tier,
     * engineer and label so that one rule in the SQL builder covers all three.
     * Priority is the exception and always was: "not recorded" is a real
     * member of `PriorityKey`, spelled `not_recorded`, and `parseFilters`
     * DROPS anything that is not a `PriorityKey`. So the grey priority bucket
     * used to send a value the server silently discarded — "Fix these" built a
     * filter that matched nothing and opened an empty board, while the chip in
     * the header claimed a filter was applied.
     */
    notRecordedKey?: string;
    note?: (buckets: BreakdownBucket[], recorded: number, total: number) => string;
    warning?: (buckets: BreakdownBucket[], recorded: number, total: number) => string | null;
  } = {},
): BreakdownDimension {
  const sorted = options.sort === false ? [...entries] : [...entries].sort(
    (left, right) => right.value - left.value || left.label.localeCompare(right.label, "en-GB"),
  );
  const kept = options.keepZeros ? sorted : sorted.filter((entry) => entry.value > 0);

  let ranked = kept;
  if (options.top && kept.length > options.top) {
    const head = kept.slice(0, options.top);
    const tail = kept.slice(options.top);
    const other: RawBucket = {
      key: "__other__",
      label: "Other",
      value: tail.reduce((sum, entry) => sum + entry.value, 0),
      byPriority: tail.some((entry) => entry.byPriority)
        ? tail.reduce<Record<string, number>>((into, entry) => {
            for (const [priority, amount] of Object.entries(entry.byPriority ?? {})) {
              into[priority] = (into[priority] ?? 0) + amount;
            }
            return into;
          }, {})
        : undefined,
    };
    ranked = [...head, other];
  }

  const recorded = ranked.reduce((sum, entry) => sum + entry.value, 0);
  const shares = sharesOfRecorded(ranked.map((entry) => entry.value));
  const buckets: BreakdownBucket[] = ranked.map((entry, index) => ({
    key: entry.key,
    label: entry.label,
    value: entry.value,
    share: shares[index] ?? 0,
    colour: options.colourFor ? options.colourFor(entry, index) : tealScale(index),
    notRecorded: false,
    ...(entry.byPriority ? { byPriority: entry.byPriority } : {}),
  }));

  if (notRecorded > 0) {
    buckets.push({
      key: options.notRecordedKey ?? NOT_RECORDED_KEY,
      label: NOT_RECORDED_LABEL,
      value: notRecorded,
      /* No share: §1.4 excludes blanks from the maths and reports them as
         coverage instead. A percentage here would be a share of a denominator
         that does not exist. */
      share: 0,
      colour: NOT_RECORDED_INK,
      notRecorded: true,
      ...(notRecordedByPriority ? { byPriority: notRecordedByPriority } : {}),
    });
  }

  return {
    key,
    label,
    recorded,
    total,
    buckets,
    note: options.note ? options.note(buckets, recorded, total) : "",
    warning: options.warning ? options.warning(buckets, recorded, total) : null,
  };
}

/** The priority key a stored label folds to, for the split-by-priority stacks. */
function priorityBucket(value: string | null | undefined): PriorityKey {
  return normalisePriority(value);
}

/* ══ Job breakdown — §5 ════════════════════════════════════════════════════ */

type GroupedRow = { value: string | null; priority?: string | null; total: number };

async function groupDimension(
  db: Database,
  where: SQL,
  column: SQL,
  split: boolean,
): Promise<GroupedRow[]> {
  if (split) {
    const rows = await db
      .select({
        value: sql<string | null>`${column}`.as("dimension"),
        priority: maintenanceRequests.priority,
        total: count(),
      })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(sql`dimension`, maintenanceRequests.priority);
    return rows.map((row) => ({
      value: row.value,
      priority: row.priority,
      total: Number(row.total),
    }));
  }
  const rows = await db
    .select({ value: sql<string | null>`${column}`.as("dimension"), total: count() })
    .from(maintenanceRequests)
    .where(where)
    .groupBy(sql`dimension`);
  return rows.map((row) => ({ value: row.value, total: Number(row.total) }));
}

type Accumulated = { value: number; byPriority: Record<string, number> };

function accumulate(
  rows: GroupedRow[],
  keyOf: (value: string | null) => string | null,
  split: boolean,
): { buckets: Map<string, Accumulated>; missing: Accumulated } {
  const buckets = new Map<string, Accumulated>();
  const missing: Accumulated = { value: 0, byPriority: {} };
  for (const row of rows) {
    const key = keyOf(row.value);
    const target =
      key === null
        ? missing
        : buckets.get(key) ?? (buckets.set(key, { value: 0, byPriority: {} }), buckets.get(key)!);
    target.value += row.total;
    if (split) {
      const priority = priorityBucket(row.priority);
      target.byPriority[priority] = (target.byPriority[priority] ?? 0) + row.total;
    }
  }
  return { buckets, missing };
}

export async function loadBreakdown(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  split: boolean,
): Promise<Body<BreakdownPayload>> {
  const where = jobScopeCondition(orgId, filters, window);

  const [tierRows, engineerRows, priorityRows, labelRows, excludedRows] = await Promise.all([
    groupDimension(db, where, sql`${maintenanceRequests.tier}`, split),
    groupDimension(db, where, sql`${maintenanceRequests.engineer}`, split),
    groupDimension(db, where, sql`${maintenanceRequests.priority}`, false),
    groupDimension(db, where, sql`${maintenanceRequests.category}`, split),
    db.select({ total: count() }).from(maintenanceRequests).where(measureMissingCondition(orgId, filters)),
  ]);

  const total = tierRows.reduce((sum, row) => sum + row.total, 0);
  const withPriority = (entry: Accumulated | undefined): Record<string, number> | undefined =>
    split ? entry?.byPriority ?? {} : undefined;

  /* ── Tier: all four, including the zeros — §5.3 ──────────────────────────── */
  const tier = accumulate(
    tierRows,
    (value) => {
      const number = Number(value ?? 0);
      return Number.isInteger(number) && number > 0 ? String(number) : null;
    },
    split,
  );
  const tierEntries: RawBucket[] = ["1", "2", "3", "4"].map((value) => ({
    key: value,
    label: `Tier ${value}`,
    value: tier.buckets.get(value)?.value ?? 0,
    byPriority: withPriority(tier.buckets.get(value)),
  }));
  /* A tier outside 1–4 is real data and must not vanish; it appears after the
     scale rather than being folded into "not recorded", which would claim the
     job carries no tier at all. */
  for (const [key, entry] of tier.buckets) {
    if (["1", "2", "3", "4"].includes(key)) continue;
    tierEntries.push({ key, label: `Tier ${key}`, value: entry.value, byPriority: withPriority(entry) });
  }

  const tierDimension = buildDimension(
    "tier",
    "Tier level",
    tierEntries,
    tier.missing.value,
    split ? tier.missing.byPriority : null,
    total,
    {
      keepZeros: true,
      sort: false,
      colourFor: (entry, index) => {
        /* Darkest for the largest, per §1.3 — ranked by count rather than by
           tier number, with the scale still stable for the zeros. */
        const order = [...tierEntries]
          .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key))
          .findIndex((candidate) => candidate.key === entry.key);
        return tealScale(order >= 0 ? order : index);
      },
      note: (buckets, recorded, cohort) =>
        recorded > 0
          ? `${recorded} of ${cohort} jobs carry a tier.`
          : "No job in this period carries a tier.",
      warning: (buckets, recorded) => {
        const real = buckets.filter((bucket) => !bucket.notRecorded && bucket.value > 0);
        const largest = real.reduce<BreakdownBucket | null>(
          (best, bucket) => (best && best.value >= bucket.value ? best : bucket),
          null,
        );
        if (!largest || recorded <= 0) return null;
        return largest.value / recorded >= 0.9
          ? `${largest.value} of ${recorded} recorded jobs are ${largest.label}. Tier is not currently differentiating work — set tiers on new jobs to make this breakdown useful.`
          : null;
      },
    },
  );

  /* ── Engineer required — the donut whose centre must read `recorded` ─────── */
  const engineer = accumulate(
    engineerRows,
    (value) => {
      const text = String(value ?? "").trim();
      return text && text !== "[object Object]" ? text : null;
    },
    split,
  );
  const engineerDimension = buildDimension(
    "engineer",
    "Engineer required",
    [...engineer.buckets].map(([key, entry]) => ({
      key,
      label: key,
      value: entry.value,
      byPriority: withPriority(entry),
    })),
    engineer.missing.value,
    split ? engineer.missing.byPriority : null,
    total,
    {
      note: (buckets, recorded, cohort) =>
        recorded > 0
          ? `${recorded} of ${cohort} jobs record an engineer type.`
          : "No job in this period records an engineer type.",
    },
  );

  /* ── Priority — the severity ramp, in a fixed order ──────────────────────── */
  const priority = accumulate(priorityRows, (value) => {
    const key = priorityBucket(value);
    return key === "not_recorded" ? null : key;
  }, false);
  const PRIORITY_ORDER: PriorityKey[] = ["urgent", "medium", "low"];
  const priorityDimension = buildDimension(
    "priority",
    "Priority",
    PRIORITY_ORDER.map((key) => ({
      key,
      label: key === "urgent" ? "Urgent" : key === "medium" ? "Medium" : "Low",
      value: priority.buckets.get(key)?.value ?? 0,
    })),
    priority.missing.value,
    null,
    total,
    {
      keepZeros: true,
      sort: false,
      /* `not_recorded`, not the shared sentinel — see `notRecordedKey`. This
         is the one dimension whose blank bucket has a name in the filter
         vocabulary already. */
      notRecordedKey: "not_recorded",
      colourFor: (entry) => OVERVIEW_PRIORITY_COLOUR[entry.key] ?? NOT_RECORDED_INK,
      note: (buckets, recorded) => {
        const urgent = buckets.find((bucket) => bucket.key === "urgent");
        if (!urgent || recorded <= 0) return "";
        return `Urgent is ${urgent.share}% of recorded work this period.`;
      },
    },
  );

  /* ── Label — the full list; the card takes the top eight ─────────────────── */
  const label = accumulate(
    labelRows,
    (value) => {
      const text = String(value ?? "").trim();
      return text && text !== "[object Object]" ? text : null;
    },
    split,
  );
  const labelDimension = buildDimension(
    "label",
    "Label",
    [...label.buckets].map(([key, entry]) => ({
      key,
      label: key,
      value: entry.value,
      byPriority: withPriority(entry),
    })),
    label.missing.value,
    split ? label.missing.byPriority : null,
    total,
    {
      note: (buckets, recorded, cohort) =>
        recorded > 0
          ? `${recorded} of ${cohort} jobs carry a label.`
          : "No job in this period carries a label.",
      warning: (buckets, recorded, cohort) => {
        /* §5.3's taxonomy warning. "Other" here is a LABEL somebody typed, not
           the ranked tail — the tail is not truncated in this payload. */
        const other = buckets
          .filter((bucket) => !bucket.notRecorded && /^other$/i.test(bucket.label))
          .reduce((sum, bucket) => sum + bucket.value, 0);
        const blank = cohort - recorded;
        if (cohort <= 0 || other + blank <= cohort * 0.25) return null;
        return `${other} jobs are labelled Other and ${blank} have no label — ${percentOf(
          other + blank,
          cohort,
        )}% of this period's work is not classified. Consider adding labels for the recurring faults inside Other.`;
      },
    },
  );

  return {
    measure: filters.measure,
    total,
    excluded: Number(excludedRows[0]?.total ?? 0),
    splitByPriority: split,
    dimensions: {
      tier: tierDimension,
      engineer: engineerDimension,
      priority: priorityDimension,
      label: labelDimension,
    },
  };
}

/* ══ Financial status — §3 ═════════════════════════════════════════════════ */

type CostTotals = {
  cohortTotal: number;
  costedJobs: number;
  spendPence: number;
  attributedPence: number;
  completedWithoutCost: number;
  costWithoutContractor: number;
  zeroOrNegative: number;
};

function costTotalsSelection() {
  return {
    cohortTotal: count(),
    costedJobs: sql<number>`sum(case when ${costedSql} then 1 else 0 end)`,
    spendPence: spendPenceSql,
    attributedPence: sql<number>`coalesce(sum(case when ${costedSql} and (${maintenanceRequests.contractorId} is not null or trim(coalesce(${maintenanceRequests.contractor}, '')) <> '') then ${costPenceSql} else 0 end), 0)`,
    completedWithoutCost: sql<number>`sum(case when ${closedJobSql} and not ${costedSql} then 1 else 0 end)`,
    costWithoutContractor: sql<number>`sum(case when ${costedSql} and ${maintenanceRequests.contractorId} is null and trim(coalesce(${maintenanceRequests.contractor}, '')) = '' then 1 else 0 end)`,
    zeroOrNegative: sql<number>`sum(case when ${maintenanceRequests.cost} is not null and ${maintenanceRequests.cost} <= 0 then 1 else 0 end)`,
  };
}

function readCostTotals(row: Record<string, unknown> | undefined): CostTotals {
  return {
    cohortTotal: Number(row?.cohortTotal ?? 0),
    costedJobs: Number(row?.costedJobs ?? 0),
    spendPence: Number(row?.spendPence ?? 0),
    attributedPence: Number(row?.attributedPence ?? 0),
    completedWithoutCost: Number(row?.completedWithoutCost ?? 0),
    costWithoutContractor: Number(row?.costWithoutContractor ?? 0),
    zeroOrNegative: Number(row?.zeroOrNegative ?? 0),
  };
}

/** The costed values as `{ pence, count }`, for a median without `percentile_cont`. */
async function costValues(db: Database, where: SQL): Promise<CountedValue[]> {
  const rows = await db
    .select({ cost: maintenanceRequests.cost, total: count() })
    .from(maintenanceRequests)
    .where(and(where, costedSql))
    .groupBy(maintenanceRequests.cost);
  return rows.map((row) => ({
    value: Math.round(Number(row.cost ?? 0) * 100),
    count: Number(row.total),
  }));
}

export async function loadCost(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<Body<CostPayload>> {
  const where = jobScopeCondition(orgId, filters, window);
  const today = dayString(now);
  const axis = measureColumn(filters);
  const previousScope = window.previous
    ? jobScopeConditionForWindow(orgId, filters, window.previous.start, window.previous.endExclusive)
    : null;

  /* §3.3's Annual: a rolling twelve months ending today, IGNORING the page
     range, on the same axis and with the same dimensional filters. */
  const annualFrom = shiftDay(today, -364);
  const annualTo = shiftDay(today, 1);

  const [
    totalRows,
    values,
    largestRows,
    dailyRows,
    annualRows,
    siteCostRows,
    siteCohortRows,
    labelRows,
    tierRows,
    engineerRows,
    contractorRows,
    aliasRows,
    contractorNames,
    siteRows,
    previousTotalRows,
    previousValues,
    spanRows,
  ] = await Promise.all([
    db.select(costTotalsSelection()).from(maintenanceRequests).where(where),
    costValues(db, where),
    db
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        cost: maintenanceRequests.cost,
      })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .orderBy(desc(maintenanceRequests.cost))
      .limit(1),
    /*
     * THE TREND, GROUPED BY DAY AND BUCKETED IN JS.
     *
     * Not one `sum(case when …)` per bucket, which is what the older trend
     * aggregate does: a daily axis over 31 days would bind 124 parameters and
     * D1 refuses a statement past ~100 with "too many SQL variables". One row
     * per distinct day is bounded by the cohort, is exact, and serves all three
     * bucket widths from the same read.
     */
    db
      .select({
        day: sql<string>`${dayOnly(axis)}`.as("day"),
        spendPence: spendPenceSql,
        costedJobs: sql<number>`sum(case when ${costedSql} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(sql`day`),
    db
      .select({
        spendPence: spendPenceSql,
        costedJobs: sql<number>`sum(case when ${costedSql} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(jobScopeConditionForWindow(orgId, filters, annualFrom, annualTo)),
    db
      .select({ siteId: maintenanceRequests.siteId, cost: maintenanceRequests.cost, total: count() })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .groupBy(maintenanceRequests.siteId, maintenanceRequests.cost),
    db
      .select({ siteId: maintenanceRequests.siteId, total: count() })
      .from(maintenanceRequests)
      .where(where)
      .groupBy(maintenanceRequests.siteId),
    db
      .select({ value: maintenanceRequests.category, spendPence: spendPenceSql, jobs: count() })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .groupBy(maintenanceRequests.category),
    db
      .select({ value: maintenanceRequests.tier, spendPence: spendPenceSql, jobs: count() })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .groupBy(maintenanceRequests.tier),
    db
      .select({ value: maintenanceRequests.engineer, spendPence: spendPenceSql, jobs: count() })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .groupBy(maintenanceRequests.engineer),
    db
      .select({
        contractorId: maintenanceRequests.contractorId,
        contractor: maintenanceRequests.contractor,
        spendPence: spendPenceSql,
        jobs: count(),
      })
      .from(maintenanceRequests)
      .where(and(where, costedSql))
      .groupBy(maintenanceRequests.contractorId, maintenanceRequests.contractor),
    db
      .select({ normalised: contractorNameAliases.normalised, contractorId: contractorNameAliases.contractorId })
      .from(contractorNameAliases)
      .where(eq(contractorNameAliases.organisationId, orgId)),
    db.select({ id: contractors.id, name: contractors.name }).from(contractors).where(eq(contractors.organisationId, orgId)),
    db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.organisationId, orgId)),
    previousScope
      ? db.select(costTotalsSelection()).from(maintenanceRequests).where(previousScope)
      : Promise.resolve(null),
    previousScope ? costValues(db, previousScope) : Promise.resolve(null),
    /* Only consulted for an unbounded window, where there is no `start` to
       bucket from. One scalar, not a scan of rows. */
    window.start === null
      ? db
          .select({ earliest: sql<string | null>`min(${dayOnly(axis)})` })
          .from(maintenanceRequests)
          .where(where)
      : Promise.resolve(null),
  ]);

  const totals = readCostTotals(totalRows[0] as Record<string, unknown> | undefined);
  const medianCostPence = quantileFromCounts(values, 0.5);
  const largest = largestRows[0];

  const { bucketing, buckets } = overviewBuckets(window, now, spanRows?.[0]?.earliest ?? null);
  const trend: SpendBucket[] = buckets.map((bucket) => ({
    label: bucket.label,
    start: bucket.start,
    endInclusive: bucket.endInclusive,
    spendPence: 0,
    costedJobs: 0,
    partial: bucket.partial,
  }));
  for (const row of dailyRows) {
    const index = bucketIndexFor(buckets, String(row.day ?? ""));
    if (index < 0) continue;
    trend[index].spendPence += Number(row.spendPence ?? 0);
    trend[index].costedJobs += Number(row.costedJobs ?? 0);
  }

  /* ── Sites, ranked by spend, each with its own median and coverage ───────── */
  const nameById = new Map(siteRows.map((row) => [row.id, row.name]));
  const cohortBySite = new Map<string, number>();
  let jobsWithNoSite = 0;
  for (const row of siteCohortRows) {
    const raw = String(row.siteId ?? "").trim();
    if (!raw || !nameById.has(raw)) {
      jobsWithNoSite += Number(row.total);
      continue;
    }
    cohortBySite.set(raw, (cohortBySite.get(raw) ?? 0) + Number(row.total));
  }

  const perSite = new Map<string, { spendPence: number; costedJobs: number; values: CountedValue[] }>();
  const unattributed = { spendPence: 0, costedJobs: 0, values: [] as CountedValue[] };
  for (const row of siteCostRows) {
    const raw = String(row.siteId ?? "").trim();
    const pence = Math.round(Number(row.cost ?? 0) * 100);
    const jobs = Number(row.total);
    const target =
      raw && nameById.has(raw)
        ? perSite.get(raw) ??
          (perSite.set(raw, { spendPence: 0, costedJobs: 0, values: [] }), perSite.get(raw)!)
        : unattributed;
    target.spendPence += pence * jobs;
    target.costedJobs += jobs;
    target.values.push({ value: pence, count: jobs });
  }

  const sitesRanked: CostSiteRow[] = [...perSite.entries()].map(([siteId, entry]) => {
    const jobsInCohort = cohortBySite.get(siteId) ?? entry.costedJobs;
    return {
      siteId,
      siteName: nameById.get(siteId) ?? siteId,
      unassigned: false,
      spendPence: entry.spendPence,
      costedJobs: entry.costedJobs,
      jobsInCohort,
      medianPence: quantileFromCounts(entry.values, 0.5),
      coveragePercent: percentOf(entry.costedJobs, jobsInCohort),
    };
  });
  /* Every cohort site is listed, including the ones with no costed work — §3.4
     asks for "No cost data" rather than a £0 that reads as a fact. */
  for (const [siteId, jobsInCohort] of cohortBySite) {
    if (perSite.has(siteId)) continue;
    sitesRanked.push({
      siteId,
      siteName: nameById.get(siteId) ?? siteId,
      unassigned: false,
      spendPence: 0,
      costedJobs: 0,
      jobsInCohort,
      medianPence: null,
      coveragePercent: 0,
    });
  }
  if (unattributed.spendPence > 0 || jobsWithNoSite > 0) {
    sitesRanked.push({
      siteId: "__unassigned__",
      siteName: UNASSIGNED_SITE_LABEL,
      unassigned: true,
      spendPence: unattributed.spendPence,
      costedJobs: unattributed.costedJobs,
      jobsInCohort: jobsWithNoSite,
      medianPence: quantileFromCounts(unattributed.values, 0.5),
      coveragePercent: percentOf(unattributed.costedJobs, jobsWithNoSite),
    });
  }
  sitesRanked.sort((left, right) => right.spendPence - left.spendPence);

  /* ── Where the money goes — three breakdowns OF SPEND, not of jobs ───────── */
  const spendDimension = (
    key: string,
    label: string,
    rows: Array<{ value: unknown; spendPence: unknown }>,
    keyOf: (value: unknown) => { key: string; label: string } | null,
  ): BreakdownDimension => {
    const entries: RawBucket[] = [];
    let missing = 0;
    for (const row of rows) {
      const pence = Number(row.spendPence ?? 0);
      const named = keyOf(row.value);
      if (!named) {
        missing += pence;
        continue;
      }
      const existing = entries.find((entry) => entry.key === named.key);
      if (existing) existing.value += pence;
      else entries.push({ key: named.key, label: named.label, value: pence });
    }
    return buildDimension(key, label, entries, missing, null, totals.spendPence, {
      top: 6,
      note: (buckets, recorded) => {
        const top = buckets.filter((bucket) => !bucket.notRecorded).slice(0, 2);
        if (!top.length || recorded <= 0) return "";
        const share = top.reduce((sum, bucket) => sum + bucket.share, 0);
        return `${top.map((bucket) => bucket.label).join(" and ")} account for ${share}% of recorded spend.`;
      },
    });
  };

  const byLabel = spendDimension("label", "Spend by label", labelRows, (value) => {
    const text = String(value ?? "").trim();
    return text && text !== "[object Object]" ? { key: text, label: text } : null;
  });
  const byTier = spendDimension("tier", "Spend by tier", tierRows, (value) => {
    const number = Number(value ?? 0);
    return Number.isInteger(number) && number > 0
      ? { key: String(number), label: `Tier ${number}` }
      : null;
  });
  const byEngineer = spendDimension("engineer", "Spend by engineer type", engineerRows, (value) => {
    const text = String(value ?? "").trim();
    return text && text !== "[object Object]" ? { key: text, label: text } : null;
  });

  /* ── Contractors, linked through the ALIAS table as well as the id ───────── */
  const aliasToContractor = new Map(
    aliasRows.map((row) => [String(row.normalised ?? "").trim(), String(row.contractorId ?? "")]),
  );
  const contractorNameById = new Map(contractorNames.map((row) => [row.id, row.name]));
  const spendByContractor = new Map<string, ContractorSpendRow>();
  let contractorLinkedPence = 0;
  let unlinkedNames = 0;
  for (const row of contractorRows) {
    const id = row.contractorId ?? null;
    const typed = (row.contractor ?? "").trim();
    if (!id && !typed) continue;
    const pence = Number(row.spendPence ?? 0);
    const jobs = Number(row.jobs ?? 0);
    /* The key shape `dashboard-filters.ts` parses back: an id when the job is
       linked, `name:<lowercased>` when it only carries typed text. */
    const aliasId = !id ? aliasToContractor.get(normaliseContractorName(typed)) : undefined;
    const resolvedId = id ?? aliasId ?? null;
    const key = resolvedId ?? `name:${typed.toLowerCase()}`;
    const current =
      spendByContractor.get(key) ??
      ({
        key,
        name: typed || contractorNameById.get(resolvedId ?? "") || resolvedId || "",
        spendPence: 0,
        jobs: 0,
        linked: Boolean(resolvedId),
      } satisfies ContractorSpendRow);
    current.spendPence += pence;
    current.jobs += jobs;
    if (typed && (!current.name || current.name === resolvedId)) current.name = typed;
    spendByContractor.set(key, current);
    if (resolvedId) contractorLinkedPence += pence;
  }
  for (const row of spendByContractor.values()) {
    if (!row.linked) unlinkedNames += 1;
  }

  const previousTotals = previousTotalRows
    ? readCostTotals(previousTotalRows[0] as Record<string, unknown> | undefined)
    : null;
  const previousCostValues = previousValues ?? [];

  return {
    measure: filters.measure,
    cohortTotal: totals.cohortTotal,
    costedJobs: totals.costedJobs,
    /* §3.2 — read FIRST, and the banner threshold is decided from it. */
    coveragePercent: percentOf(totals.costedJobs, totals.cohortTotal),
    totalSpendPence: totals.spendPence,
    medianCostPence,
    largest: largest
      ? {
          id: largest.id,
          reference: largest.reference ?? null,
          title: largest.title,
          spendPence: Math.round(Number(largest.cost ?? 0) * 100),
        }
      : null,
    previous: previousTotals
      ? {
          totalSpendPence: previousTotals.spendPence,
          costedJobs: previousTotals.costedJobs,
          medianCostPence: quantileFromCounts(previousCostValues, 0.5),
          largestPence: previousCostValues.length
            ? Math.max(...previousCostValues.map((entry) => entry.value))
            : null,
        }
      : null,
    bucketing,
    trend,
    annual: {
      totalSpendPence: Number(annualRows[0]?.spendPence ?? 0),
      costedJobs: Number(annualRows[0]?.costedJobs ?? 0),
      from: annualFrom,
      to: today,
    },
    sites: sitesRanked,
    /* §3.4's marker is a per-JOB median, so it is the portfolio's own median
       cost per job — the same number the headline prints, drawn on every bar. */
    portfolioMedianPence: medianCostPence,
    byLabel,
    byTier,
    byEngineer,
    contractors: [...spendByContractor.values()].sort(
      (left, right) => right.spendPence - left.spendPence,
    ),
    contractorAttributedPence: totals.attributedPence,
    contractorLinkedPence,
    dataQuality: {
      completedWithoutCost: totals.completedWithoutCost,
      costWithoutContractor: totals.costWithoutContractor,
      unlinkedNames,
      zeroOrNegative: totals.zeroOrNegative,
    },
  };
}

/* ══ Performance over time — §4 ════════════════════════════════════════════ */

const SLA_STAGE_LABEL: Record<SlaStage["key"], string> = {
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  attended: "Attended",
  resolved: "Resolved",
};

const SLA_STAGE_COLUMN: Record<"acknowledged" | "assigned" | "attended", string> = {
  acknowledged: "acknowledged_at",
  assigned: "assigned_at",
  attended: "attended_at",
};

/**
 * BUSINESS MINUTES BETWEEN TWO INSTANTS, HONOURING `bank_holidays`.
 *
 * §4.4's targets are stated as business time — "P2 within 1 business hour", "P3
 * same working day" — so a stage measured against them has to run the clock
 * only during working hours on working days. Exported and pure so it can be
 * tested without a database.
 *
 * The working day is 08:00–18:00 UTC, Monday to Friday, minus any date in
 * `holidays` (a set of `YYYY-MM-DD`). It is UTC rather than Europe/London
 * because every other instant in this product is compared in UTC and a
 * timezone conversion here would put two figures on two clocks; the difference
 * is one hour of window placement during BST and it is documented rather than
 * hidden.
 *
 * NOTE, and it matters for reading the report: no stage on any current estate
 * is measurable against a minutes target — `acknowledged_at`, `assigned_at` and
 * `attended_at` are NULL on every row of every database — so this function
 * currently changes no figure on screen. It exists so that the first job to
 * carry an acknowledgement timestamp is measured correctly rather than against
 * raw elapsed time nobody labelled.
 */
/**
 * Elapsed WALL-CLOCK minutes, for a target whose basis is `calendar`.
 *
 * §4.4 allows both bases and `sla_targets.basis` says which one a row means:
 * "P1 within 30 minutes" runs through the night, "P3 same working day" does
 * not. Measuring a calendar target on business hours would report a breach as
 * a success every weekend, so the two are kept apart and the row decides.
 */
export function calendarMinutesBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return 0;
  return Math.round((end - start) / 60_000);
}

export function businessMinutesBetween(
  from: string,
  to: string,
  holidays: ReadonlySet<string>,
  dayStartHour = 8,
  dayEndHour = 18,
): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return 0;

  const minutesPerDay = (dayEndHour - dayStartHour) * 60;
  let total = 0;
  let cursor = new Date(start);
  const limit = new Date(end);
  /* Walked a day at a time: the ranges this measures are minutes to days, and
     a closed-form solution would still need the holiday list expanded. */
  let guard = 0;
  while (cursor < limit && guard < 4000) {
    guard += 1;
    const day = dayString(cursor);
    const weekday = cursor.getUTCDay();
    const working = weekday !== 0 && weekday !== 6 && !holidays.has(day);
    if (working) {
      const [year, month, date] = day.split("-").map(Number);
      const open = Date.UTC(year, month - 1, date, dayStartHour);
      const close = Date.UTC(year, month - 1, date, dayEndHour);
      const from2 = Math.max(cursor.getTime(), open);
      const to2 = Math.min(limit.getTime(), close);
      if (to2 > from2) total += Math.min(minutesPerDay, (to2 - from2) / 60_000);
    }
    const [year, month, date] = day.split("-").map(Number);
    cursor = new Date(Date.UTC(year, month - 1, date + 1));
  }
  return Math.round(total);
}

type TargetRow = {
  stage: string;
  priorityKey: string;
  targetMinutes: number;
  basis: string;
  version: number;
};

export async function loadPerformance(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
  split: boolean,
): Promise<Body<PerformancePayload>> {
  const where = jobScopeCondition(orgId, filters, window);
  const axis = measureColumn(filters);
  const previousScope = window.previous
    ? jobScopeConditionForWindow(orgId, filters, window.previous.start, window.previous.endExclusive)
    : null;

  const completedPresent = sql`(${maintenanceRequests.completedAt} is not null and ${dayText(
    maintenanceRequests.completedAt,
  )} <> '')`;
  const closedAndDated = and(closedJobSql, completedPresent)!;

  /*
   * THE CLOSE-TIME PAIRS, AS AGGREGATE ROWS.
   *
   * One row per distinct (raised day, completed day) — and per priority when
   * the split is on — so a median and a p90 can be computed exactly without
   * `percentile_cont`, which SQLite does not have. §4.3 forbids the mean and
   * this never computes one for the chart.
   */
  const pairSelection = {
    raised: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("raised"),
    closed: sql<string>`${dayOnly(maintenanceRequests.completedAt)}`.as("closed"),
    total: count(),
  };

  const [
    pairs,
    priorityPairs,
    openRows,
    previousPairs,
    stageCoverage,
    targetRows,
    resolvedRows,
    previousResolvedRows,
    spanRows,
    stageRows,
    holidays,
  ] = await Promise.all([
    db
      .select(pairSelection)
      .from(maintenanceRequests)
      .where(and(where, closedAndDated))
      .groupBy(sql`raised`, sql`closed`),
    split
      ? db
          .select({ ...pairSelection, priority: maintenanceRequests.priority })
          .from(maintenanceRequests)
          .where(and(where, closedAndDated))
          .groupBy(sql`raised`, sql`closed`, maintenanceRequests.priority)
      : Promise.resolve(null),
    db
      .select({ total: count() })
      .from(maintenanceRequests)
      .where(and(where, sql`(${openJobSql} or not ${completedPresent})`)),
    previousScope
      ? db
          .select(pairSelection)
          .from(maintenanceRequests)
          .where(and(previousScope, closedAndDated))
          .groupBy(sql`raised`, sql`closed`)
      : Promise.resolve(null),
    /*
     * WHETHER A STAGE CAN BE MEASURED AT ALL — §4.4, and the reason this is one
     * cheap query rather than three expensive ones. `acknowledged_at`,
     * `assigned_at` and `attended_at` were added by `db/init.ts` and are NULL on
     * every row of every estate today. Counting the coverage first means the
     * card can say "Not measured — no timestamp recorded" instead of drawing a
     * confident 0% or 100% against a column nobody has ever written.
     */
    db
      .select({
        total: count(),
        acknowledged: sql<number>`sum(case when nullif(${dayText(
          rawColumn(maintenanceRequests, "acknowledged_at"),
        )}, '') is not null then 1 else 0 end)`,
        assigned: sql<number>`sum(case when nullif(${dayText(
          rawColumn(maintenanceRequests, "assigned_at"),
        )}, '') is not null then 1 else 0 end)`,
        attended: sql<number>`sum(case when nullif(${dayText(
          rawColumn(maintenanceRequests, "attended_at"),
        )}, '') is not null then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(where),
    db
      .select({
        stage: slaTargets.stage,
        priorityKey: slaTargets.priorityKey,
        targetMinutes: slaTargets.targetMinutes,
        basis: slaTargets.basis,
        version: slaTargets.version,
      })
      .from(slaTargets)
      .where(and(eq(slaTargets.organisationId, orgId), sql`${slaTargets.supersededAt} is null`)),
    /*
     * RESOLVED. The one stage with data, measured the way the previous card
     * measured it and for the same reason: `sla_targets` seeds only the
     * `acknowledged` ladder, so there is no minutes target for resolution and
     * the promise that DOES exist is the date recorded on each job.
     * `target_completion_date` is the explicit commitment and `due_at` the
     * board's deadline; the first that is present wins, per row.
     */
    db
      .select({
        closed: sql<string>`${dayOnly(maintenanceRequests.completedAt)}`.as("closed"),
        met: sql<number>`sum(case when ${dayOnly(maintenanceRequests.completedAt)} <= coalesce(nullif(${dayOnly(
          maintenanceRequests.targetCompletionDate,
        )}, ''), ${dayOnly(maintenanceRequests.dueAt)}) then 1 else 0 end)`,
        measured: count(),
      })
      .from(maintenanceRequests)
      .where(
        and(
          where,
          closedAndDated,
          sql`coalesce(nullif(${dayOnly(maintenanceRequests.targetCompletionDate)}, ''), nullif(${dayOnly(
            maintenanceRequests.dueAt,
          )}, '')) is not null`,
        ),
      )
      .groupBy(sql`closed`),
    previousScope
      ? db
          .select({
            met: sql<number>`sum(case when ${dayOnly(maintenanceRequests.completedAt)} <= coalesce(nullif(${dayOnly(
              maintenanceRequests.targetCompletionDate,
            )}, ''), ${dayOnly(maintenanceRequests.dueAt)}) then 1 else 0 end)`,
            measured: count(),
          })
          .from(maintenanceRequests)
          .where(
            and(
              previousScope,
              closedAndDated,
              sql`coalesce(nullif(${dayOnly(maintenanceRequests.targetCompletionDate)}, ''), nullif(${dayOnly(
                maintenanceRequests.dueAt,
              )}, '')) is not null`,
            ),
          )
      : Promise.resolve(null),
    window.start === null
      ? db
          .select({ earliest: sql<string | null>`min(${dayOnly(axis)})` })
          .from(maintenanceRequests)
          .where(where)
      : Promise.resolve(null),
    /*
     * THE ROWS THAT MAKE A LADDER STAGE MEASURABLE — §4.4, and gate 25.
     *
     * Only jobs that actually CARRY one of the three stage timestamps, so this
     * costs the size of the measured population and not the size of the estate.
     * On every estate today that is zero rows, which is what makes reading whole
     * rows here acceptable: it grows only as somebody starts recording
     * acknowledgements, and a stage nobody records costs nothing to not measure.
     *
     * The comparison happens in JS rather than SQL deliberately. §4.4 states its
     * targets in BUSINESS minutes, and minute-level arithmetic across both
     * dialects would need `julianday`/`strftime`/`unixepoch`, all forbidden here,
     * while business hours additionally need the bank-holiday calendar expanded.
     * `businessMinutesBetween` already does that, purely and under test — this is
     * what finally calls it.
     */
    db
      .select({
        priority: maintenanceRequests.priority,
        raisedAt: sql<string>`${dayText(maintenanceRequests.requestedAt)}`.as("raised_at"),
        acknowledgedAt: sql<string | null>`${dayText(
          rawColumn(maintenanceRequests, "acknowledged_at"),
        )}`.as("acknowledged_at_text"),
        assignedAt: sql<string | null>`${dayText(
          rawColumn(maintenanceRequests, "assigned_at"),
        )}`.as("assigned_at_text"),
        attendedAt: sql<string | null>`${dayText(
          rawColumn(maintenanceRequests, "attended_at"),
        )}`.as("attended_at_text"),
      })
      .from(maintenanceRequests)
      .where(
        and(
          where,
          sql`(nullif(${dayText(rawColumn(maintenanceRequests, "acknowledged_at"))}, '') is not null
             or nullif(${dayText(rawColumn(maintenanceRequests, "assigned_at"))}, '') is not null
             or nullif(${dayText(rawColumn(maintenanceRequests, "attended_at"))}, '') is not null)`,
        ),
      )
      .limit(5000),
    readBankHolidays(db),
  ]);

  const { bucketing, buckets } = overviewBuckets(window, now, spanRows?.[0]?.earliest ?? null);

  const daysBetween = (raised: string, closed: string): number | null => {
    if (raised.length !== 10 || closed.length !== 10) return null;
    return Math.max(0, daysBetweenDays(raised, closed));
  };

  const overall: CountedValue[] = [];
  const perBucket: CountedValue[][] = buckets.map(() => []);
  for (const row of pairs) {
    const raised = String(row.raised ?? "");
    const closed = String(row.closed ?? "");
    const days = daysBetween(raised, closed);
    if (days === null) continue;
    const entry = { value: days, count: Number(row.total ?? 0) };
    overall.push(entry);
    const index = bucketIndexFor(buckets, closed);
    if (index >= 0) perBucket[index].push(entry);
  }

  const perBucketPriority: Array<Map<string, CountedValue[]>> = buckets.map(() => new Map());
  for (const row of priorityPairs ?? []) {
    const raised = String(row.raised ?? "");
    const closed = String(row.closed ?? "");
    const days = daysBetween(raised, closed);
    if (days === null) continue;
    const index = bucketIndexFor(buckets, closed);
    if (index < 0) continue;
    const key = priorityBucket(row.priority);
    const list = perBucketPriority[index].get(key) ?? [];
    list.push({ value: days, count: Number(row.total ?? 0) });
    perBucketPriority[index].set(key, list);
  }

  const sampleOf = (entries: CountedValue[]) => entries.reduce((sum, entry) => sum + entry.count, 0);
  const round = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

  const timeToCloseBuckets: TimeToCloseBucket[] = buckets.map((bucket, index) => {
    const entries = perBucket[index];
    const sample = sampleOf(entries);
    return {
      label: bucket.label,
      start: bucket.start,
      endInclusive: bucket.endInclusive,
      sample,
      /* §4.3 — fewer than three completed jobs is noise drawn as a trend. The
         card renders a gap; the payload says so with a null rather than with a
         number nobody should read. */
      medianDays: sample >= 3 ? round(quantileFromCounts(entries, 0.5)) : null,
      p90Days: sample >= 3 ? round(quantileFromCounts(entries, 0.9)) : null,
      byPriority: split
        ? Object.fromEntries(
            [...perBucketPriority[index].entries()].map(([key, list]) => {
              const inner = sampleOf(list);
              return [
                key,
                { sample: inner, medianDays: inner >= 3 ? round(quantileFromCounts(list, 0.5)) : null },
              ];
            }),
          )
        : null,
    };
  });

  const previousEntries: CountedValue[] = [];
  for (const row of previousPairs ?? []) {
    const days = daysBetween(String(row.raised ?? ""), String(row.closed ?? ""));
    if (days === null) continue;
    previousEntries.push({ value: days, count: Number(row.total ?? 0) });
  }

  /* ── SLA ─────────────────────────────────────────────────────────────────── */
  const coverage = stageCoverage[0];
  const cohortTotal = Number(coverage?.total ?? 0);
  const targets: TargetRow[] = targetRows.map((row) => ({
    stage: String(row.stage ?? ""),
    priorityKey: String(row.priorityKey ?? ""),
    targetMinutes: Number(row.targetMinutes ?? 0),
    basis: String(row.basis ?? "calendar"),
    version: Number(row.version ?? 1),
  }));
  const hasTargetFor = (stage: string) => targets.some((row) => row.stage === stage);

  const unmeasuredStage = (
    key: "acknowledged" | "assigned" | "attended",
    measured: number,
  ): SlaStage => ({
    key,
    label: SLA_STAGE_LABEL[key],
    measurable: false,
    reason: measured
      ? `Only ${measured} of ${cohortTotal} jobs record a ${SLA_STAGE_LABEL[key].toLowerCase()} time — too few to report.`
      : `Not measured — no ${SLA_STAGE_LABEL[key].toLowerCase()} timestamp is recorded on any job in this period (${SLA_STAGE_COLUMN[key]} is empty).`,
    coverage: { measured, total: cohortTotal },
    buckets: buckets.map((bucket) => ({
      label: bucket.label,
      start: bucket.start,
      endInclusive: bucket.endInclusive,
      sample: 0,
      /* NEVER 0 and never 100 for a stage nobody recorded — §4.4. */
      percent: null,
    })),
    percent: null,
    previousPercent: null,
  });

  /*
   * A LADDER STAGE, MEASURED AGAINST `sla_targets` — §4.4, and gate 25:
   * "changing an SLA target changes the chart, with no deploy".
   *
   * This used to be three unconditional calls to `unmeasuredStage`, so no
   * stage could EVER report a percentage however much data arrived, and no
   * code path read `sla_targets` at all. The output happened to be honest — no
   * job on any estate records these timestamps — but it was honest by accident
   * rather than by measurement, and a target nobody reads is a setting that
   * lies about being a setting.
   *
   * The floor stays exactly where it was: a stage with no coverage still says
   * "not measured" in the same words, and never draws 0% or 100% against a
   * column nobody has written.
   */
  const targetFor = (stage: string, priority: string) =>
    targets.find((row) => row.stage === stage && row.priorityKey === priority)
    ?? targets.find((row) => row.stage === stage && row.priorityKey === "any")
    ?? targets.find((row) => row.stage === stage);

  const measureStage = (
    key: "acknowledged" | "assigned" | "attended",
    reachedAtOf: (row: (typeof stageRows)[number]) => string | null,
  ): SlaStage => {
    const measured = Number(
      coverage?.[key as "acknowledged" | "assigned" | "attended"] ?? 0,
    );
    /* No coverage, or no agreed target: unchanged behaviour, same sentence. */
    if (measured <= 0 || !hasTargetFor(key)) return unmeasuredStage(key, measured);

    const perBucket = buckets.map(() => ({ sample: 0, met: 0 }));
    let totalSample = 0;
    let totalMet = 0;

    for (const row of stageRows) {
      const reached = (reachedAtOf(row) ?? "").trim();
      const raised = String(row.raisedAt ?? "").trim();
      if (!reached || !raised) continue;
      const target = targetFor(key, priorityBucket(row.priority));
      /* A stage with coverage but no target for THIS priority is not a
         failure — it is a job nobody promised anything about, so it leaves the
         denominator rather than counting as a breach. */
      if (!target) continue;

      const elapsed =
        String(target.basis ?? "calendar") === "business"
          ? businessMinutesBetween(raised, reached, holidays)
          : calendarMinutesBetween(raised, reached);
      if (elapsed === null) continue;

      const index = bucketIndexFor(buckets, reached.slice(0, 10));
      const met = elapsed <= Number(target.targetMinutes ?? 0) ? 1 : 0;
      totalSample += 1;
      totalMet += met;
      if (index < 0) continue;
      perBucket[index].sample += 1;
      perBucket[index].met += met;
    }

    if (totalSample <= 0) return unmeasuredStage(key, measured);

    return {
      key,
      label: SLA_STAGE_LABEL[key],
      measurable: true,
      reason: null,
      coverage: { measured, total: cohortTotal },
      buckets: buckets.map((bucket, index) => ({
        label: bucket.label,
        start: bucket.start,
        endInclusive: bucket.endInclusive,
        sample: perBucket[index].sample,
        /* Same rule as every other percentage on this page: no denominator,
           no number. */
        percent:
          perBucket[index].sample > 0
            ? percentOf(perBucket[index].met, perBucket[index].sample)
            : null,
      })),
      percent: percentOf(totalMet, totalSample),
      /* The previous period would need a second pass over a population that is
         empty on every estate today; stated as unknown rather than computed
         from nothing. */
      previousPercent: null,
    };
  };

  const stages: SlaStage[] = [
    measureStage("acknowledged", (row) => row.acknowledgedAt),
    measureStage("assigned", (row) => row.assignedAt),
    measureStage("attended", (row) => row.attendedAt),
  ];

  let resolvedMeasured = 0;
  let resolvedMet = 0;
  const resolvedBuckets = buckets.map((bucket) => ({
    label: bucket.label,
    start: bucket.start,
    endInclusive: bucket.endInclusive,
    sample: 0,
    percent: null as number | null,
    met: 0,
  }));
  for (const row of resolvedRows) {
    const index = bucketIndexFor(buckets, String(row.closed ?? ""));
    const measured = Number(row.measured ?? 0);
    const met = Number(row.met ?? 0);
    resolvedMeasured += measured;
    resolvedMet += met;
    if (index < 0) continue;
    resolvedBuckets[index].sample += measured;
    resolvedBuckets[index].met += met;
  }
  for (const bucket of resolvedBuckets) {
    bucket.percent = bucket.sample > 0 ? percentOf(bucket.met, bucket.sample) : null;
  }

  const previousResolvedMeasured = Number(previousResolvedRows?.[0]?.measured ?? 0);
  const previousResolvedMet = Number(previousResolvedRows?.[0]?.met ?? 0);

  stages.push({
    key: "resolved",
    label: SLA_STAGE_LABEL.resolved,
    measurable: resolvedMeasured > 0,
    /*
     * The honest label §4.4 asks for. There is no `resolved` row in
     * `sla_targets` — the seed carries the acknowledgement ladder only — so the
     * promise being measured is the date recorded on each job, and pause codes
     * (client approval, landlord permit, special-order parts) are not recorded
     * anywhere, so this is RAW elapsed time and says so.
     */
    reason:
      resolvedMeasured > 0
        ? `Measured against each job's own recorded target date${
            hasTargetFor("resolved") ? "" : " — no resolution target is configured in sla_targets"
          }. Pause codes are not recorded, so this is raw elapsed time.`
        : "Not measured — no closed job in this period carries both a completion date and a target date.",
    coverage: { measured: resolvedMeasured, total: cohortTotal },
    buckets: resolvedBuckets.map(({ label, start, endInclusive, sample, percent }) => ({
      label,
      start,
      endInclusive,
      sample,
      percent,
    })),
    percent: resolvedMeasured > 0 ? percentOf(resolvedMet, resolvedMeasured) : null,
    previousPercent:
      previousResolvedMeasured > 0
        ? percentOf(previousResolvedMet, previousResolvedMeasured)
        : null,
  });

  /*
   * §4.4's replacement for the Jobs page's "Avg SLA target 64.8 hrs", which
   * averaged the TARGETS themselves and measured nothing about performance:
   * promises met over promises measurable, summed across every stage that can
   * be measured at all.
   *
   * Summed from the COUNTS rather than from the stages' rounded percentages.
   * Reconstructing a numerator by multiplying a rounded percentage back out is
   * how a headline comes to disagree with the rows above it by one.
   */
  const measured: Array<{ measured: number; met: number }> = [
    ...(resolvedMeasured > 0 ? [{ measured: resolvedMeasured, met: resolvedMet }] : []),
  ];
  const overallMeasured = measured.reduce((sum, entry) => sum + entry.measured, 0);
  const overallMet = measured.reduce((sum, entry) => sum + entry.met, 0);

  return {
    measure: filters.measure,
    bucketing,
    timeToClose: {
      buckets: timeToCloseBuckets,
      openExcluded: Number(openRows[0]?.total ?? 0),
      /*
       * §4.3'S FLOOR APPLIES TO THE HEADLINE TOO, and it did not.
       *
       * The buckets have always refused to draw a median under three completed
       * jobs — "noise drawn as a trend" — but the figure ABOVE them was
       * computed straight off `overall` with no floor at all. Measured on the
       * 90-day window: the only bucket with any data reported `sample: 1,
       * medianDays: null`, correctly, while the header printed a median AND a
       * 90th percentile of 44 days from that single job. The chart was refusing
       * to draw the number the header was asserting.
       *
       * `sample` travels with them so the card can say WHY there is no figure —
       * "1 completed job, too few to average" reads as a fact about coverage,
       * where a bare blank reads as a bug.
       */
      sample: sampleOf(overall),
      medianDays: sampleOf(overall) >= 3 ? round(quantileFromCounts(overall, 0.5)) : null,
      p90Days: sampleOf(overall) >= 3 ? round(quantileFromCounts(overall, 0.9)) : null,
      previousSample: previousPairs ? sampleOf(previousEntries) : 0,
      previousMedianDays:
        previousPairs && sampleOf(previousEntries) >= 3
          ? round(quantileFromCounts(previousEntries, 0.5))
          : null,
      previousP90Days:
        previousPairs && sampleOf(previousEntries) >= 3
          ? round(quantileFromCounts(previousEntries, 0.9))
          : null,
      splitByPriority: split,
    },
    sla: {
      stages,
      targets: targets.map((row) => ({
        stage: row.stage,
        priorityKey: row.priorityKey,
        targetMinutes: row.targetMinutes,
        basis: row.basis,
        version: row.version,
      })),
      overallPercent: overallMeasured > 0 ? percentOf(overallMet, overallMeasured) : null,
      previousOverallPercent:
        previousResolvedMeasured > 0
          ? percentOf(previousResolvedMet, previousResolvedMeasured)
          : null,
    },
  };
}

/** The bank-holiday calendar, for the business-hours basis. Not org-scoped: a
 *  bank holiday is a fact about the country, not about a tenant. */
export async function readBankHolidays(
  db: Database,
  jurisdiction = "england-and-wales",
): Promise<Set<string>> {
  const rows = await db
    .select({ day: bankHolidays.holidayDate })
    .from(bankHolidays)
    .where(eq(bankHolidays.jurisdiction, jurisdiction));
  return new Set(rows.map((row) => String(row.day ?? "").slice(0, 10)).filter(Boolean));
}

/* ══ Sites needing attention — §6 ══════════════════════════════════════════ */

export async function loadSitesAttention(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  now: Date,
): Promise<Body<Omit<SitesAttentionPayload, "sites">> & { sites: Array<Omit<AttentionSiteRow, "compliance">> }> {
  const scope = jobScopeCondition(orgId, filters, window);
  const openScope = and(scope, openJobSql)!;
  const today = dayString(now);

  const [grouped, siteRows, noSiteRows, everSeenRows] = await Promise.all([
    /* One row per (site, day raised) over OPEN work: the ageing bands, the
       urgent count and the oldest day all come out of it. */
    db
      .select({
        siteId: maintenanceRequests.siteId,
        raised: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("raised"),
        total: count(),
        urgent: sql<number>`sum(case when ${urgentSql} then 1 else 0 end)`,
      })
      .from(maintenanceRequests)
      .where(openScope)
      .groupBy(maintenanceRequests.siteId, sql`raised`),
    db
      .select({
        id: sites.id,
        name: sites.name,
        manager: sites.manager,
        managerName: sites.managerName,
        managerEmail: sites.managerEmail,
        managerPhone: sites.managerPhone,
      })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
    /* §6.1 — Unassigned is a broken foreign key, not a location. It leaves the
       ranked list entirely and becomes a data-quality row. */
    db
      .select({ total: count() })
      .from(maintenanceRequests)
      .where(and(scope, unassignedSiteCondition(orgId))),
    /*
     * Which sites have EVER carried live work, over the whole estate rather
     * than over the period. §6.4's "N sites have no jobs and no contact
     * recorded" is a property of the site, not of the range a reader happens to
     * be looking at: a store with fifty jobs last year and none this quarter is
     * not an unset-up store, and counting it as one would send somebody to fix
     * a record that is already correct.
     */
    db
      .select({ siteId: maintenanceRequests.siteId })
      .from(maintenanceRequests)
      .where(liveWorkOrderCondition(orgId))
      .groupBy(maintenanceRequests.siteId),
  ]);

  const nameById = new Map(siteRows.map((row) => [row.id, row.name]));
  const everCarriedWork = new Set(
    everSeenRows.map((row) => String(row.siteId ?? "").trim()).filter(Boolean),
  );

  type SiteTally = {
    openCount: number;
    urgentCount: number;
    oldestDays: number | null;
    oldestDay: string | null;
    severity: SeverityCounts;
  };
  const bySite = new Map<string, SiteTally>();
  const portfolioAgeing = emptySeverity();
  let openTotal = 0;

  for (const row of grouped) {
    const raw = String(row.siteId ?? "").trim();
    if (!raw || !nameById.has(raw)) continue; // real sites only
    const days = daysSince(String(row.raised ?? ""), today);
    if (days === null) continue;
    const amount = Number(row.total ?? 0);
    const entry =
      bySite.get(raw) ??
      ({
        openCount: 0,
        urgentCount: 0,
        oldestDays: null,
        oldestDay: null,
        severity: emptySeverity(),
      } satisfies SiteTally);
    entry.openCount += amount;
    entry.urgentCount += Number(row.urgent ?? 0);
    if (entry.oldestDays === null || days > entry.oldestDays) {
      entry.oldestDays = days;
      entry.oldestDay = String(row.raised ?? "").slice(0, 10);
    }
    addSeverity(entry.severity, days, amount);
    addSeverity(portfolioAgeing, days, amount);
    bySite.set(raw, entry);
    openTotal += amount;
  }

  /*
   * The reference of each site's oldest open job, in ONE bounded statement.
   *
   * The aggregate above already knows the DAY each site's oldest job was
   * raised, so this reads only jobs raised on one of those days — at most one
   * distinct day per site — rather than paging the board. Chunked at the `IN`
   * limit `db/node-pg-d1.ts` shares with D1.
   */
  const oldestDays = [...new Set([...bySite.values()].map((entry) => entry.oldestDay).filter(Boolean))] as string[];
  const oldestReference = new Map<string, string>();
  for (const chunk of chunkIds(oldestDays)) {
    const rows = await db
      .select({
        siteId: maintenanceRequests.siteId,
        reference: maintenanceRequests.reference,
        id: maintenanceRequests.id,
        raised: sql<string>`${dayOnly(maintenanceRequests.requestedAt)}`.as("raised"),
      })
      .from(maintenanceRequests)
      .where(and(openScope, inArray(sql`${dayOnly(maintenanceRequests.requestedAt)}`, chunk)))
      .orderBy(maintenanceRequests.requestedAt);
    for (const row of rows) {
      const raw = String(row.siteId ?? "").trim();
      const entry = bySite.get(raw);
      if (!entry || oldestReference.has(raw)) continue;
      if (String(row.raised ?? "").slice(0, 10) !== entry.oldestDay) continue;
      oldestReference.set(raw, row.reference ?? row.id);
    }
  }

  /* §6.3 — a PERCENTAGE, and one that adds up. The old card printed a count
     beside a bar and called it "Share of open 26"; `sharesOfRecorded` is the
     same rule every breakdown on the page uses, so these sum to exactly 100
     after rounding rather than to 101. */
  const entries = [...bySite.entries()];
  const openShares = sharesOfRecorded(entries.map(([, entry]) => entry.openCount));

  const rows: Array<Omit<AttentionSiteRow, "compliance">> = entries.map(
    ([siteId, entry], index) => ({
      siteId,
      siteName: nameById.get(siteId) ?? siteId,
      openCount: entry.openCount,
      urgentCount: entry.urgentCount,
      oldestDays: entry.oldestDays,
      oldestReference: oldestReference.get(siteId) ?? null,
      shareOfOpen: openShares[index] ?? 0,
      severity: entry.severity,
      /*
       * The severity score, weighted so critical-aged and urgent rank highest.
       * A site with one 90-day job outranks a site with six fresh ones, which
       * is the judgement the card exists to make.
       */
      score:
        entry.severity.critical * 8 +
        entry.severity.overdue * 4 +
        entry.severity.ageing * 2 +
        entry.severity.fresh * 1 +
        entry.urgentCount * 6,
    }),
  );
  rows.sort((left, right) => right.score - left.score || right.openCount - left.openCount);

  const withoutContact = siteRows.filter(
    (row) =>
      !(row.manager ?? "").trim() &&
      !(row.managerName ?? "").trim() &&
      !(row.managerEmail ?? "").trim() &&
      !(row.managerPhone ?? "").trim(),
  );

  /* §6.2's intake warning. It fires on a portfolio whose open work is ALL old:
     either nothing new has been logged, or request dates are missing. */
  const tail = portfolioAgeing.overdue + portfolioAgeing.critical;
  const fresh = portfolioAgeing.fresh + portfolioAgeing.ageing;
  const intakeWarning =
    fresh === 0 && tail > 0
      ? "No open job in this portfolio is under 30 days old. Either no new work has been logged recently, or request dates are missing — check intake."
      : null;

  return {
    measure: filters.measure,
    openTotal,
    siteCount: rows.length,
    portfolioSiteCount: siteRows.length,
    ageing: portfolioAgeing,
    intakeWarning,
    sites: rows,
    quietSites: Math.max(0, siteRows.length - rows.length),
    dataQuality: {
      jobsWithNoSite: Number(noSiteRows[0]?.total ?? 0),
      /* Filled in by the route, which owns the compliance register join. */
      sitesWithoutComplianceProfile: 0,
      sitesWithNoJobsAndNoContact: withoutContact.filter((row) => !everCarriedWork.has(row.id))
        .length,
    },
  };
}

/* ══ The drill-down list ═══════════════════════════════════════════════════ */

const RECORD_QUERIES: readonly RecordsQuery[] = [
  "missing_measure_date",
  "no_site",
  "no_cost",
  "completed_without_cost",
  "cost_without_contractor",
  "zero_or_negative_cost",
  "stuck",
];

export function isRecordsQuery(value: string): value is RecordsQuery {
  return (RECORD_QUERIES as readonly string[]).includes(value);
}

const RECORD_TITLE: Record<RecordsQuery, string> = {
  missing_measure_date: "Jobs with no date on the current measure",
  no_site: "Jobs that point at no site in the register",
  no_cost: "Jobs in this period with no cost recorded",
  completed_without_cost: "Completed jobs with no cost recorded",
  cost_without_contractor: "Jobs with a cost but no contractor named",
  zero_or_negative_cost: "Jobs with a zero or negative cost",
  stuck: "Open jobs held in a waiting status",
};

export const RECORDS_PAGE = 200;

/**
 * The records behind a footnote or a data-quality row.
 *
 * Every one of these is a question the Jobs board's filter language cannot
 * express — "no request date recorded", "a cost but no contractor named" — and
 * inventing a vocabulary for them on a busier screen would be the larger
 * change. The Overview answers them itself, capped, with the real total beside
 * the page so the panel never implies it is showing everything.
 */
export async function loadRecords(
  db: Database,
  orgId: string,
  filters: DashboardFilters,
  window: PeriodWindow,
  query: RecordsQuery,
): Promise<Body<RecordsPayload>> {
  const scope = jobScopeCondition(orgId, filters, window);

  let where: SQL;
  switch (query) {
    case "missing_measure_date":
      where = measureMissingCondition(orgId, filters);
      break;
    case "no_site":
      where = and(scope, unassignedSiteCondition(orgId))!;
      break;
    case "no_cost":
      where = and(scope, sql`not ${costedSql}`)!;
      break;
    case "completed_without_cost":
      where = and(scope, closedJobSql, sql`not ${costedSql}`)!;
      break;
    case "cost_without_contractor":
      where = and(
        scope,
        costedSql,
        sql`${maintenanceRequests.contractorId} is null and trim(coalesce(${maintenanceRequests.contractor}, '')) = ''`,
      )!;
      break;
    case "zero_or_negative_cost":
      where = and(
        scope,
        sql`(${maintenanceRequests.cost} is not null and ${maintenanceRequests.cost} <= 0)`,
      )!;
      break;
    case "stuck":
    default: {
      const assignment = await readStatusAssignments(db, orgId);
      const waiting = new Set<string>(WAITING_METERS);
      const keys = [...assignment.assignments.entries()]
        .filter(([, meter]) => waiting.has(meter as MeterKey))
        .map(([key]) => key);
      where = and(
        scope,
        openJobSql,
        keys.length ? sql`lower(trim(${maintenanceRequests.status})) in ${keys}` : sql`1 = 0`,
      )!;
      break;
    }
  }

  const [totalRows, rows, siteRows] = await Promise.all([
    db.select({ total: count() }).from(maintenanceRequests).where(where),
    db
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        siteId: maintenanceRequests.siteId,
        status: maintenanceRequests.status,
        priority: maintenanceRequests.priority,
        requestedAt: sql<string | null>`${dayText(maintenanceRequests.requestedAt)}`,
        completedAt: sql<string | null>`${dayText(maintenanceRequests.completedAt)}`,
        cost: maintenanceRequests.cost,
        contractor: maintenanceRequests.contractor,
      })
      .from(maintenanceRequests)
      .where(where)
      .orderBy(maintenanceRequests.requestedAt)
      .limit(RECORDS_PAGE),
    db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.organisationId, orgId)),
  ]);

  const nameById = new Map(siteRows.map((row) => [row.id, row.name]));
  const total = Number(totalRows[0]?.total ?? 0);

  const records: RecordRow[] = rows.map((row) => {
    const raw = String(row.siteId ?? "").trim();
    const known = Boolean(raw && nameById.has(raw));
    return {
      id: row.id,
      reference: row.reference ?? null,
      title: row.title,
      siteId: known ? raw : null,
      siteName: known ? nameById.get(raw)! : UNASSIGNED_SITE_LABEL,
      status: (row.status ?? "").trim() || "No status",
      priority: (row.priority ?? "").trim() || NOT_RECORDED_LABEL,
      requestedAt: String(row.requestedAt ?? "").trim() || null,
      completedAt: String(row.completedAt ?? "").trim() || null,
      costPence: row.cost === null || row.cost === undefined ? null : Math.round(Number(row.cost) * 100),
      contractor: (row.contractor ?? "").trim() || null,
    };
  });

  return {
    query,
    title: RECORD_TITLE[query],
    total,
    rows: records,
    truncated: total > records.length,
  };
}

/* ══ Wording helpers the routes hand straight to a card ════════════════════ */

/** Re-exported so a route can label a payload without importing two modules. */
export { cohortWording, penceToPounds, totalSeverity };
