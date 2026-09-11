/**
 * THE OVERVIEW'S "JOB INTELLIGENCE" SECTION — built from grouped rows.
 *
 * `loadOverviewMetrics` runs the queries (it already holds the scope, the
 * open-work predicate and the overdue rule every other Overview figure uses)
 * and hands the grouped rows here. Everything below is PURE — no database, no
 * clock of its own, no drizzle import — so the tests call it with a worked
 * fixture, and the route and the tests cannot compute two different answers.
 *
 * The definitions, each chosen to agree with a figure the product already
 * shows rather than to introduce a second one:
 *
 *   · OPEN is the Jobs board's open work (`not closedJobSql`), and every split
 *     of it — status, priority, tier, engineer, label — sums back to it.
 *   · SLA MET is the existing Overview SLA: open jobs not yet past their due
 *     date, over open jobs. Per priority it is the same ratio inside each
 *     priority, so the per-priority "within" counts sum to the headline's.
 *   · COMPLETED is the existing Completed KPI: `completed_at` inside the range.
 *   · AGING is open work requested more than fourteen days ago.
 *   · BREACH RISK is open High-priority or Tier 1 work that is not yet overdue
 *     and falls due within the next 48 hours. Due dates are DAYS, so that is
 *     "due today or tomorrow" — the same day-versus-instant rule the overdue
 *     test applies, read forwards instead of backwards.
 *   · TIME TO CLOSE is completed day minus requested day, in whole days, over
 *     jobs completed inside the range, against the equal-length period before.
 */
import { SLA_TARGET_ARC } from "./dashboard-policy";
import type {
  OiIntel,
  OiPriority,
  OiPriorityKey,
  OiSlaByPriority,
  OiSlice,
  OiWeek,
} from "./overview-intel-contract";

/* ── Policy ───────────────────────────────────────────────────────────────── */

/** "Aging Backlog: % of open jobs where Date Requested is more than 14 days ago." */
export const AGING_THRESHOLD_DAYS = 14;
/** "SLA Breach Risk: … due within 48h." */
export const BREACH_WINDOW_HOURS = 48;
/** "SLA Compliance by Priority Tier … with a target-line marker at 95%." — the policy's `good`. */
export const SLA_TARGET_PERCENT = SLA_TARGET_ARC.good;
/** "Cap the legend at ~6 rows, roll anything smaller into 'Other statuses'." */
export const STATUS_LEGEND_CAP = 6;
/** "Avg. Time to Close … a small 7-bar trend sparkline (weekly average)." */
export const TIME_TO_CLOSE_WEEKS = 7;

/** The board's "not recorded" filter value — `NOT_RECORDED_KEY` in dashboard-filters. */
export const NOT_RECORDED = "__not_recorded__";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * THE BOARD'S OWN MATCHING RULE — trim, lower-case, collapse runs of
 * whitespace: `key()` in `board-drill-filter.ts` and `statusKey` in job-metrics.
 * Every split that the Jobs board will be asked to reproduce is GROUPED by it,
 * so "Electrical" and "electrical " are one slice here exactly as they are one
 * value there — otherwise each slice's drill would open both spellings under a
 * figure that counted one.
 */
export function matchKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** A value the importer wrote by stringifying an object: never a real label. */
const OBJECT_TEXT = "[object Object]";

/* ── Day arithmetic (UTC, date-only) ──────────────────────────────────────── */

export function addDays(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  /* An impossible day ("2026-13-01") is returned as it came rather than
     throwing; the loader refuses such a range before it gets here. */
  if (Number.isNaN(at.getTime())) return day;
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/** A real calendar day in `YYYY-MM-DD` — "2026-02-30" is not one. */
export function isCalendarDay(day: string | null | undefined): day is string {
  if (!day || !DAY.test(day)) return false;
  const at = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === day;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const WEEK_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ── Inputs ───────────────────────────────────────────────────────────────── */

type Slice = { key: string; label: string; value: number; labels: string[] };

export type JobIntelInput = {
  /** Today, `YYYY-MM-DD`, UTC — the product-wide "today". */
  today: string;
  /** The page range, inclusive days. */
  range: { from: string; to: string };
  open: number;
  overdue: number;
  completed: number;
  /** The Overview's own splits of open work, already computed. */
  statusSlices: readonly Slice[];
  prioritySlices: readonly Slice[];
  /** Open jobs grouped by the raw `category` — the board's Label. */
  categoryRows: ReadonlyArray<{ category: string | null; total: number }>;
  tierRows: ReadonlyArray<{ tier: number | null; total: number }>;
  engineerRows: ReadonlyArray<{ engineer: string | null; total: number }>;
  /** Open jobs grouped by the raw priority, with how many are overdue. */
  priorityRows: ReadonlyArray<{ priority: string | null; total: number; overdue: number }>;
  aging: { count: number; oldestDay: string | null };
  breach: { pool: number; count: number };
  /** Jobs completed from the previous period's start to the range's end. */
  closures: ReadonlyArray<{ requestedDay: string | null; completedDay: string | null }>;
  /** `normalisePriority` from job-metrics, passed in so this module stays pure. */
  normalisePriority: (value: string | null | undefined) => OiPriorityKey;
};

/* ── The builders ─────────────────────────────────────────────────────────── */

/** Six largest statuses, then "Other statuses" — unless a seventh would be alone in it. */
export function capStatuses(slices: readonly Slice[]): OiSlice[] {
  /* Two display labels the board would treat as one value are one slice. */
  const merged = new Map<string, Slice>();
  for (const slice of slices) {
    const id = matchKey(slice.label);
    const entry = merged.get(id);
    if (entry) {
      entry.value += slice.value;
      entry.labels = [...new Set([...entry.labels, ...slice.labels])];
    } else {
      merged.set(id, { ...slice, labels: [...slice.labels] });
    }
  }
  const ranked = [...merged.values()]
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "en-GB"));
  const plain = (slice: Slice): OiSlice => ({ key: slice.key, label: slice.label, value: slice.value, labels: [...slice.labels] });
  if (ranked.length <= STATUS_LEGEND_CAP + 1) return ranked.map(plain);
  const head = ranked.slice(0, STATUS_LEGEND_CAP).map(plain);
  const tail = ranked.slice(STATUS_LEGEND_CAP);
  head.push({
    key: "__other_statuses__",
    label: "Other statuses",
    value: tail.reduce((sum, slice) => sum + slice.value, 0),
    labels: tail.flatMap((slice) => slice.labels),
  });
  return head;
}

/**
 * Tier 1 first. Zero and null are both "no tier" — the importer wrote one and
 * the form writes the other — and the drill sends both spellings so the board
 * lists every job the slice counted.
 */
export function buildTiers(rows: JobIntelInput["tierRows"]): OiSlice[] {
  const byTier = new Map<number, number>();
  let none = 0;
  for (const row of rows) {
    const tier = Number(row.tier ?? 0);
    const total = Number(row.total ?? 0);
    if (!Number.isFinite(tier) || tier <= 0) none += total;
    else byTier.set(tier, (byTier.get(tier) ?? 0) + total);
  }
  const slices: OiSlice[] = [...byTier.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, value]) => value > 0)
    .map(([tier, value]) => ({ key: String(tier), label: `Tier ${tier}`, value, labels: [String(tier)] }));
  if (none > 0) slices.push({ key: NOT_RECORDED, label: "No tier", value: none, labels: [NOT_RECORDED, "0"] });
  return slices;
}

/** Largest first; blank and the importer's "[object Object]" are "Not recorded". */
export function buildEngineers(rows: JobIntelInput["engineerRows"]): OiSlice[] {
  const byName = new Map<string, { label: string; value: number; labels: Set<string> }>();
  let none = 0;
  for (const row of rows) {
    const raw = String(row.engineer ?? "").trim();
    const total = Number(row.total ?? 0);
    if (!raw || raw === OBJECT_TEXT) {
      none += total;
      continue;
    }
    /* Grouped by the board's own key, so each bar's drill opens exactly it. */
    const key = matchKey(raw);
    const entry = byName.get(key) ?? { label: raw, value: 0, labels: new Set<string>() };
    entry.value += total;
    entry.labels.add(raw);
    byName.set(key, entry);
  }
  const slices: OiSlice[] = [...byName.values()]
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "en-GB"))
    .map((entry) => ({ key: entry.label, label: entry.label, value: entry.value, labels: [...entry.labels] }));
  if (none > 0) {
    slices.push({ key: NOT_RECORDED, label: "Not recorded", value: none, labels: [NOT_RECORDED, OBJECT_TEXT] });
  }
  return slices;
}

/** Labels shown by name before the rest fold into "Other". */
export const LABEL_HEAD = 5;

/**
 * THE LABEL DONUT — the five largest labels, the rest folded into "Other",
 * and "Unassigned" for blank or stringified-object categories.
 *
 * Grouped by the board's key, like engineers. This estate also has a label
 * literally named "Other"; when it is among the five, the tail folds INTO it
 * (carrying both sets of raw labels) rather than drawing the word twice with
 * two numbers. "Unassigned" sends the board's not-recorded value AND the
 * object text, so its list holds every job the slice counted.
 */
export function buildLabels(rows: JobIntelInput["categoryRows"]): OiSlice[] {
  const groups = new Map<string, { label: string; value: number; labels: Set<string>; weight: Map<string, number> }>();
  let unassigned = 0;
  for (const row of rows) {
    const raw = String(row.category ?? "").trim();
    const total = Number(row.total ?? 0);
    if (!raw || raw === OBJECT_TEXT) {
      unassigned += total;
      continue;
    }
    const id = matchKey(raw);
    const entry = groups.get(id) ?? { label: raw, value: 0, labels: new Set<string>(), weight: new Map<string, number>() };
    entry.value += total;
    entry.labels.add(raw);
    entry.weight.set(raw, (entry.weight.get(raw) ?? 0) + total);
    groups.set(id, entry);
  }
  /* The spelling most jobs use is the one printed. */
  const named = [...groups.entries()]
    .filter(([, entry]) => entry.value > 0)
    .map(([id, entry]) => {
      const printed = [...entry.weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en-GB"))[0][0];
      return { id, label: printed, value: entry.value, labels: [...entry.labels] };
    })
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "en-GB"));
  const head: OiSlice[] = named.slice(0, LABEL_HEAD).map((entry) => ({
    key: entry.label,
    label: entry.label,
    value: entry.value,
    labels: entry.labels,
  }));
  const tail = named.slice(LABEL_HEAD);
  if (tail.length) {
    const tailValue = tail.reduce((sum, entry) => sum + entry.value, 0);
    const tailLabels = tail.flatMap((entry) => entry.labels);
    const existing = head.find((slice) => matchKey(slice.label) === "other");
    if (existing) {
      existing.value += tailValue;
      existing.labels = [...existing.labels, ...tailLabels];
    } else {
      head.push({ key: "__other__", label: "Other", value: tailValue, labels: tailLabels });
    }
  }
  if (unassigned > 0) {
    head.push({ key: "__unassigned__", label: "Unassigned", value: unassigned, labels: [NOT_RECORDED, OBJECT_TEXT] });
  }
  return head.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "en-GB"));
}

const PRIORITY_ORDER: OiPriorityKey[] = ["urgent", "medium", "low", "not_recorded"];
const PRIORITY_LABEL: Record<OiPriorityKey, string> = {
  urgent: "High",
  medium: "Medium",
  low: "Low",
  not_recorded: "Unset",
};

/** The SLA ratio inside each priority; "Unset" only when it holds jobs. */
export function buildSlaByPriority(
  rows: JobIntelInput["priorityRows"],
  normalise: JobIntelInput["normalisePriority"],
): OiSlaByPriority[] {
  const tally = new Map<OiPriorityKey, { jobs: number; overdue: number }>();
  for (const row of rows) {
    const key = normalise(row.priority);
    const entry = tally.get(key) ?? { jobs: 0, overdue: 0 };
    entry.jobs += Number(row.total ?? 0);
    entry.overdue += Number(row.overdue ?? 0);
    tally.set(key, entry);
  }
  return PRIORITY_ORDER.filter((key) => key !== "not_recorded" || (tally.get(key)?.jobs ?? 0) > 0).map((key) => {
    const entry = tally.get(key) ?? { jobs: 0, overdue: 0 };
    const withinSla = Math.max(0, entry.jobs - Math.min(entry.overdue, entry.jobs));
    return { key, label: PRIORITY_LABEL[key], jobs: entry.jobs, withinSla, percent: percentOf(withinSla, entry.jobs) };
  });
}

/** The previous period: the same number of days, ending the day before `from`. */
export function previousPeriod(range: { from: string; to: string }): { from: string; to: string } {
  const length = daysBetween(range.from, range.to) + 1;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(length - 1)), to };
}

/** The seven weeks ending on the range's last day, oldest first. */
export function closeWeeks(rangeTo: string): Array<{ from: string; to: string }> {
  const weeks: Array<{ from: string; to: string }> = [];
  for (let index = TIME_TO_CLOSE_WEEKS - 1; index >= 0; index -= 1) {
    const to = addDays(rangeTo, -7 * index);
    weeks.push({ from: addDays(to, -6), to });
  }
  return weeks;
}

/** The earliest day `closures` must reach back to: the previous period or the first week. */
export function closuresFrom(range: { from: string; to: string }): string {
  const previous = previousPeriod(range).from;
  const firstWeek = closeWeeks(range.to)[0].from;
  return previous < firstWeek ? previous : firstWeek;
}

export function summariseTimeToClose(
  closures: JobIntelInput["closures"],
  range: { from: string; to: string },
): OiIntel["timeToClose"] {
  const spans: Array<{ day: string; days: number }> = [];
  for (const row of closures) {
    const requested = String(row.requestedDay ?? "").slice(0, 10);
    const completed = String(row.completedDay ?? "").slice(0, 10);
    if (!DAY.test(requested) || !DAY.test(completed)) continue;
    /* A completion recorded before its request is a data-entry slip, not a
       negative duration; it counts as closed the same day. */
    spans.push({ day: completed, days: Math.max(0, daysBetween(requested, completed)) });
  }
  const within = (from: string, to: string) => spans.filter((span) => span.day >= from && span.day <= to);
  const mean = (rows: Array<{ days: number }>) =>
    rows.length ? oneDecimal(rows.reduce((sum, row) => sum + row.days, 0) / rows.length) : null;

  const current = within(range.from, range.to);
  const previousRange = previousPeriod(range);
  const previous = within(previousRange.from, previousRange.to);
  const averageDays = mean(current);
  const previousAverageDays = mean(previous);

  const weeks: OiWeek[] = closeWeeks(range.to).map((week) => {
    const rows = within(week.from, week.to);
    return {
      from: week.from,
      to: week.to,
      label: `w/c ${WEEK_LABEL.format(new Date(`${week.from}T12:00:00Z`))}`,
      averageDays: mean(rows),
      jobs: rows.length,
    };
  });

  return {
    averageDays,
    jobs: current.length,
    previousAverageDays,
    previousJobs: previous.length,
    deltaDays:
      averageDays !== null && previousAverageDays !== null ? oneDecimal(averageDays - previousAverageDays) : null,
    weeks,
  };
}

export function buildJobIntel(input: JobIntelInput): OiIntel {
  const open = Math.max(0, input.open);
  const overdue = Math.min(Math.max(0, input.overdue), open);
  const withinSla = open - overdue;
  const completed = Math.max(0, input.completed);

  const priority: OiPriority[] = input.prioritySlices
    .filter((slice) => (PRIORITY_ORDER as string[]).includes(slice.key))
    .map((slice) => ({
      key: slice.key as OiPriorityKey,
      label: slice.label,
      value: slice.value,
      labels: [...slice.labels],
    }));

  return {
    open,
    completed,
    completionRate: percentOf(completed, completed + open),
    sla: { percent: percentOf(withinSla, open), withinSla, overdue, open },
    priority,
    status: capStatuses(input.statusSlices),
    tiers: buildTiers(input.tierRows),
    engineers: buildEngineers(input.engineerRows),
    labels: buildLabels(input.categoryRows),
    aging: {
      thresholdDays: AGING_THRESHOLD_DAYS,
      /* Raw, not capped: an over-count is the reconciliation's to catch. */
      count: input.aging.count,
      open,
      percent: percentOf(input.aging.count, open),
      cutoff: addDays(input.today, -(AGING_THRESHOLD_DAYS + 1)),
      oldestDay: input.aging.count > 0 && input.aging.oldestDay && DAY.test(input.aging.oldestDay.slice(0, 10))
        ? input.aging.oldestDay.slice(0, 10)
        : null,
    },
    breachRisk: {
      windowHours: BREACH_WINDOW_HOURS,
      count: input.breach.count,
      pool: input.breach.pool,
      percent: percentOf(input.breach.count, input.breach.pool),
    },
    timeToClose: summariseTimeToClose(input.closures, input.range),
    slaByPriority: buildSlaByPriority(input.priorityRows, input.normalisePriority),
    slaTargetPercent: SLA_TARGET_PERCENT,
  };
}

/* ── Reconciliation, asserted rather than assumed ─────────────────────────── */

/**
 * The section's identities AND its ties to the Overview figures it restates:
 * open work, the overdue count behind the SLA, and the Completed KPI. Kept
 * beside `reconcileIntel` rather than inside `overview-metrics.ts`'s own
 * `reconcile`, which the Overview block's tests lift out and run on its own.
 */
export function reconcileIntelWithOverview(metrics: {
  openJobs: number;
  sla: { overdue: number };
  kpis: ReadonlyArray<{ key: string; value: number }>;
  intel: OiIntel;
}): string[] {
  const failures = reconcileIntel(metrics.intel);
  if (metrics.intel.open !== metrics.openJobs) {
    failures.push(`intel open ${metrics.intel.open} != open ${metrics.openJobs}`);
  }
  if (metrics.intel.sla.overdue !== metrics.sla.overdue) {
    failures.push(`intel overdue ${metrics.intel.sla.overdue} != overdue ${metrics.sla.overdue}`);
  }
  const completedKpi = metrics.kpis.find((kpi) => kpi.key === "completed");
  if (completedKpi && completedKpi.value !== metrics.intel.completed) {
    failures.push(`intel completed ${metrics.intel.completed} != Completed KPI ${completedKpi.value}`);
  }
  return failures;
}

/** Every split of open work sums to it; every "part of" is no larger than its whole. */
export function reconcileIntel(intel: OiIntel): string[] {
  const failures: string[] = [];
  const sum = (rows: readonly { value: number }[]) => rows.reduce((total, row) => total + row.value, 0);
  const open = intel.open;
  for (const [name, rows] of [
    ["status", intel.status],
    ["priority", intel.priority],
    ["tiers", intel.tiers],
    ["engineers", intel.engineers],
    ["labels", intel.labels],
  ] as const) {
    if (sum(rows) !== open) failures.push(`intel ${name} ${sum(rows)} != open ${open}`);
  }
  const slaJobs = intel.slaByPriority.reduce((total, row) => total + row.jobs, 0);
  const slaWithin = intel.slaByPriority.reduce((total, row) => total + row.withinSla, 0);
  if (slaJobs !== open) failures.push(`sla by priority jobs ${slaJobs} != open ${open}`);
  if (slaWithin !== intel.sla.withinSla) {
    failures.push(`sla by priority within ${slaWithin} != within ${intel.sla.withinSla}`);
  }
  if (intel.sla.withinSla + intel.sla.overdue !== open) {
    failures.push(`sla within ${intel.sla.withinSla} + overdue ${intel.sla.overdue} != open ${open}`);
  }
  if (intel.aging.count > open) failures.push(`aging ${intel.aging.count} > open ${open}`);
  if (intel.breachRisk.count > intel.breachRisk.pool) {
    failures.push(`breach risk ${intel.breachRisk.count} > pool ${intel.breachRisk.pool}`);
  }
  if (intel.breachRisk.pool > open) failures.push(`breach pool ${intel.breachRisk.pool} > open ${open}`);
  if (intel.timeToClose.jobs > intel.completed) {
    failures.push(`time to close jobs ${intel.timeToClose.jobs} > completed ${intel.completed}`);
  }
  return failures;
}
