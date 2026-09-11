/**
 * THE REPORTS DASHBOARD BLOCK'S ONE SOURCE OF TRUTH — pure.
 *
 * Every figure on `.rp-dash` — four KPIs and their sparklines, the spend
 * trend, the top sites, the repeat-rate gauge, both repeat-spend donuts and the
 * recurrence rings — is computed here, in one pass, from one set of job rows
 * and one instant. No widget counts anything of its own.
 *
 * ── WHAT IS REUSED RATHER THAN REDEFINED ──────────────────────────────────
 *
 *   · the JOBS are `liveWorkOrderCondition`'s — live, not archived, not a
 *     sub-item, on the Jobs board — the population every dashboard counts;
 *   · SPEND is `spendLineOf`: `maintenance_requests.cost`, counted once the job
 *     is completed and dated by its completion day — the Overview spend trend's
 *     basis. The trend's monthly points are the Overview's own query
 *     (`loadSpendByMonth`, handed in by the route), so a month cannot read one
 *     figure there and another here;
 *   · the TYPE split is `spendTypeOf`, the rule the Reports page has always
 *     shown (Planned: compliance or tier ≥ 4; Projects: otherwise ≥ £1,000;
 *     Reactive: the rest). The schema has no job-type column;
 *   · the ISSUE is `maintenance_requests.category`, the configured label set;
 *   · a REPEAT is `analyseRepeats` — the same function the Jobs page's `repeat=`
 *     and `recurrence=` filters run, so a drill lists exactly what was counted.
 *
 * ── TWO BASES, STATED ─────────────────────────────────────────────────────
 *
 * Spend is dated by COMPLETION. The repeat figures describe jobs RAISED in the
 * range — "repeat jobs ÷ all jobs created in the range" — so a repeat job's
 * spend is its completed cost wherever the completion falls. The brief defines
 * both, and each is labelled where it is drawn.
 *
 * Pure: no database, no clock, no React. `node --test` calls it directly.
 */

import type {
  RpBand,
  RpDelta,
  RpKpi,
  RpMetrics,
  RpSitesRange,
  RpSparkPoint,
  RpSpendSlice,
  RpSpendType,
  RpTrendPoint,
  RpTrendRange,
} from "./reports-dash-contract";
import {
  RECURRENCE_BANDS,
  REPEAT_WINDOW_DAYS,
  SPEND_TYPES,
  SPEND_TYPE_LABEL,
  analyseRepeats,
  repeatIssueKey,
  spendLineOf,
  spendTypeOf,
} from "./job-metrics";
import { REPEAT_RATE_ARC } from "./dashboard-policy";

/* ── Day arithmetic, on the calendar and in UTC ───────────────────────────── */

/*
 * The same two helpers as `dayString` / `shiftDay` in `dashboard-filters.ts`,
 * restated so this module imports no query builder; `tests/reports-dash.test.mjs`
 * pins the two pairs to the same answers.
 */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function shiftDays(day: string, by: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(month: string): string {
  return shiftDays(`${shiftMonth(month, 1)}-01`, -1);
}

/** `2026-09` moved by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number);
  const index = year * 12 + (number - 1) + by;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const MONTH_SHORT = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const MONTH_LONG = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const DAY_SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_LONG = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const at = (day: string) => new Date(`${day}T12:00:00Z`);

/** `12 May – 11 Jun 2026`, the briefs' format; both years when they differ. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return DAY_LONG.format(at(from));
  if (from.slice(0, 4) !== to.slice(0, 4)) return `${DAY_LONG.format(at(from))} – ${DAY_LONG.format(at(to))}`;
  return `${DAY_SHORT.format(at(from))} – ${DAY_LONG.format(at(to))}`;
}

/* ── The range ────────────────────────────────────────────────────────────── */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_TOKEN = /^month:(\d{4}-\d{2})$/;

export type ResolvedRange = {
  from: string;
  to: string;
  calendarMonth: boolean;
  /** The current calendar month, to date. */
  currentMonth: boolean;
  previous: { from: string; to: string };
  comparedWith: string;
};

/**
 * THE PAGE'S DATE RANGE, resolved on the server.
 *
 *   · `from`/`to` when the header picker set them;
 *   · else `reportPeriod=month:YYYY-MM` — the token the Overview's spend trend
 *     sends when a month is tapped — as that month;
 *   · else the current calendar month to date.
 *
 * The PREVIOUS period is the equal window immediately before — except for a
 * calendar month, where it is the same span of the month before ("1–11 Sep vs
 * 1–11 Aug", "all of Aug vs all of Jul"), labelled with that month's name.
 */
export function resolveReportsRange(
  params: { from?: string | null; to?: string | null; reportPeriod?: string | null },
  now: Date,
): ResolvedRange {
  const today = dayOf(now);
  let from = params.from && DAY.test(params.from) ? params.from : null;
  let to = params.to && DAY.test(params.to) ? params.to : null;
  if (!from && !to) {
    const token = MONTH_TOKEN.exec((params.reportPeriod ?? "").trim());
    if (token) {
      from = `${token[1]}-01`;
      const end = monthEnd(token[1]);
      to = end < today ? end : today;
    }
  }
  if (!from && !to) {
    from = monthStart(today);
    to = today;
  }
  from = from ?? to!;
  to = to ?? today;
  if (from > to) [from, to] = [to, from];

  const month = from.slice(0, 7);
  const sameMonth = to.slice(0, 7) === month;
  const endOfMonth = monthEnd(month);
  const calendarMonth =
    from === `${month}-01` && sameMonth && (to === endOfMonth || (to === today && month === today.slice(0, 7)));
  const currentMonth = calendarMonth && month === today.slice(0, 7);

  let previous: { from: string; to: string };
  let comparedWith: string;
  if (calendarMonth) {
    const prior = shiftMonth(month, -1);
    const priorEnd = monthEnd(prior);
    const span = daysBetween(from, to);
    const candidate = shiftDays(`${prior}-01`, span);
    previous = { from: `${prior}-01`, to: to === endOfMonth || candidate > priorEnd ? priorEnd : candidate };
    comparedWith = `vs ${MONTH_LONG.format(at(`${prior}-01`))}`;
  } else {
    const length = daysBetween(from, to) + 1;
    previous = { from: shiftDays(from, -length), to: shiftDays(from, -1) };
    comparedWith = "vs previous period";
  }
  return { from, to, calendarMonth, currentMonth, previous, comparedWith };
}

/* ── Inputs ───────────────────────────────────────────────────────────────── */

export type ReportsJob = {
  id: string;
  siteId: string | null;
  category: string | null;
  tier: number | null;
  /** Pounds, as the column holds it. */
  cost: number | null;
  /** `substr(dateText(completed_at), 1, 10)` — the Overview's own day expression. */
  completedAt: string | null;
  requestedAt: string | null;
  contractor?: string | null;
  reference?: string | null;
  title?: string | null;
};

export type ReportsDashInput = {
  /** Every live job on the Jobs board in the portfolio — not only the range's. */
  jobs: readonly ReportsJob[];
  /** Site names by id, for every site the organisation holds. */
  siteNames: ReadonlyMap<string, string>;
  /** The trend's monthly pence, from `loadSpendByMonth` — the Overview's query. */
  monthlySpend: ReadonlyMap<string, number>;
  now: Date;
  range: ResolvedRange;
  trendRange: RpTrendRange;
  sitesRange: RpSitesRange;
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  /**
   * EVERY site in scope, closed ones included — the ceiling "sites with
   * repeats" is checked against. It used to be ACTIVE sites, and a closed store
   * with a repeat still on its books then raised a reconciliation failure that
   * described no fault: history does not stop being history when a shop shuts.
   */
  siteCount: number;
};

/* ── Colour: the brief's tokens, restated for a server ────────────────────── */

export const RP_COLOURS = {
  teal: "#46A2AD",
  orange: "#D8652B",
  amber: "#E3A140",
  blue: "#5A7293",
  green: "#5E946E",
  grey: "#5E697E",
  weekly: "#D34E49",
  fortnightly: "#E09438",
  monthly: "#5878A4",
  lessOften: "#44546C",
} as const;

/** "Colours in default order: teal, orange, amber, blue, green, grey." */
const SERIES = [RP_COLOURS.teal, RP_COLOURS.orange, RP_COLOURS.amber, RP_COLOURS.blue, RP_COLOURS.green] as const;

const BAND_COLOUR: Record<RpBand["key"], string> = {
  weekly: RP_COLOURS.weekly,
  fortnightly: RP_COLOURS.fortnightly,
  monthly: RP_COLOURS.monthly,
  "less-often": RP_COLOURS.lessOften,
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

export const NO_SITE_KEY = "__unassigned__";

/** A job's site for SPEND: a real site, or "No site" for blank / placeholder / dangling. */
function spendSiteOf(job: ReportsJob, siteNames: ReadonlyMap<string, string>): string {
  const id = (job.siteId ?? "").trim();
  return id && id !== "site-unassigned" && siteNames.has(id) ? id : NO_SITE_KEY;
}

function deltaOf(current: number, previous: number, comparedWith: string): RpDelta {
  if (previous === 0 && current === 0) return { direction: "none", percent: null, comparedWith };
  if (previous === 0) return { direction: "new", percent: null, comparedWith };
  const percent = Math.round(((current - previous) / previous) * 1000) / 10;
  return {
    direction: percent > 0 ? "up" : percent < 0 ? "down" : "flat",
    percent: Math.abs(percent),
    comparedWith,
  };
}

type SpendLine = { job: ReportsJob; pence: number; day: string; type: RpSpendType };

function inWindow(day: string, from: string, to: string): boolean {
  return day >= from && day <= to;
}

/** Top five by value, then "Other" — folded into a real category called "Other" when one is shown. */
function topFive(
  groups: Array<{ key: string; label: string; value: number; jobs: number; labels: string[] }>,
  otherLabel: string,
): RpSpendSlice[] {
  const ranked = [...groups].sort(
    (left, right) => right.value - left.value || right.jobs - left.jobs || left.label.localeCompare(right.label, "en-GB"),
  );
  const head: RpSpendSlice[] = ranked.slice(0, 5).map((group, index) => ({
    ...group,
    colour: SERIES[index % SERIES.length],
  }));
  const tail = ranked.slice(5);
  if (tail.length === 0) return head;
  const value = tail.reduce((sum, group) => sum + group.value, 0);
  const jobs = tail.reduce((sum, group) => sum + group.jobs, 0);
  const labels = tail.flatMap((group) => group.labels);
  /* The same trap the Overview's category ring records: this estate has a
     category literally named "Other", so the remainder folds INTO it rather
     than printing the word twice with two different sums. */
  const existing = head.find((slice) => slice.label.trim().toLowerCase() === otherLabel.toLowerCase());
  if (existing) {
    existing.value += value;
    existing.jobs += jobs;
    existing.labels = [...existing.labels, ...labels];
    return head;
  }
  return [...head, { key: "__other__", label: otherLabel, value, jobs, labels, colour: RP_COLOURS.grey }];
}

/* ── The one pass ─────────────────────────────────────────────────────────── */

export function buildReportsDashboard(input: ReportsDashInput): RpMetrics {
  const { range, siteNames } = input;

  /* Every spend line, once — the basis of every pound below. */
  const lines: SpendLine[] = [];
  for (const job of input.jobs) {
    const line = spendLineOf(job);
    if (!line) continue;
    lines.push({ job, pence: line.pence, day: line.day, type: spendTypeOf(job) });
  }

  /* ── KPIs ───────────────────────────────────────────────────────────────── */

  const inRange = lines.filter((line) => inWindow(line.day, range.from, range.to));
  const inPrevious = lines.filter((line) => inWindow(line.day, range.previous.from, range.previous.to));
  const length = daysBetween(range.from, range.to) + 1;
  /*
   * THE BRIEF'S 45-DAY RULE — daily up to 45 days, weekly beyond — and then
   * coarser still, so a long custom range keeps every pound on the line rather
   * than stopping at a bucket cap. Weekly to two years, monthly to 400 months,
   * yearly after that. A cap that dropped the tail would draw a sparkline that
   * no longer summed to the figure above it.
   */
  const monthsSpanned =
    (Number(range.to.slice(0, 4)) - Number(range.from.slice(0, 4))) * 12 +
    (Number(range.to.slice(5, 7)) - Number(range.from.slice(5, 7))) + 1;
  const sparkUnit: RpMetrics["sparkUnit"] =
    length <= 45 ? "day" : length <= 728 ? "week" : monthsSpanned <= 400 ? "month" : "year";
  const bucketStarts: string[] = [range.from];
  for (;;) {
    const last = bucketStarts[bucketStarts.length - 1];
    const next =
      sparkUnit === "day"
        ? shiftDays(last, 1)
        : sparkUnit === "week"
          ? shiftDays(last, 7)
          : sparkUnit === "month"
            ? `${shiftMonth(last.slice(0, 7), 1)}-01`
            : `${String(Number(last.slice(0, 4)) + 1).padStart(4, "0")}-01-01`;
    if (next > range.to) break;
    bucketStarts.push(next);
  }
  const bucketOf = (day: string) => {
    if (sparkUnit === "day") return daysBetween(range.from, day);
    if (sparkUnit === "week") return Math.floor(daysBetween(range.from, day) / 7);
    const years = Number(day.slice(0, 4)) - Number(range.from.slice(0, 4));
    if (sparkUnit === "year") return years;
    return years * 12 + (Number(day.slice(5, 7)) - Number(range.from.slice(5, 7)));
  };
  const sparkLabel = (start: string) =>
    sparkUnit === "day"
      ? DAY_SHORT.format(at(start))
      : sparkUnit === "week"
        ? `w/c ${DAY_SHORT.format(at(start))}`
        : sparkUnit === "month"
          ? MONTH_LONG.format(at(start))
          : start.slice(0, 4);

  const kpiFor = (key: RpKpi["key"], label: string, pick: (line: SpendLine) => boolean): RpKpi => {
    const current = inRange.filter(pick);
    const previous = inPrevious.filter(pick);
    const pence = current.reduce((sum, line) => sum + line.pence, 0);
    const previousPence = previous.reduce((sum, line) => sum + line.pence, 0);
    const spark: RpSparkPoint[] = bucketStarts.map((start) => ({
      key: start,
      label: sparkLabel(start),
      pence: 0,
      jobs: 0,
    }));
    for (const line of current) {
      const point = spark[bucketOf(line.day)];
      if (!point) continue;
      point.pence += line.pence;
      point.jobs += 1;
    }
    return {
      key,
      label,
      pence,
      jobs: current.length,
      previousPence,
      delta: deltaOf(pence, previousPence, range.comparedWith),
      spark,
    };
  };

  const kpis: RpKpi[] = [
    kpiFor("total", range.currentMonth ? "This month" : "Total spend", () => true),
    ...SPEND_TYPES.map((type) => kpiFor(type, SPEND_TYPE_LABEL[type], (line) => line.type === type)),
  ];
  const total = kpis[0];
  const typed = kpis.slice(1);
  const unclassified = {
    pence: total.pence - typed.reduce((sum, kpi) => sum + kpi.pence, 0),
    jobs: total.jobs - typed.reduce((sum, kpi) => sum + kpi.jobs, 0),
  };

  /* ── Spend trend ────────────────────────────────────────────────────────── */

  const anchor = range.to.slice(0, 7);
  const count = input.trendRange === "3m" ? 3 : input.trendRange === "12m" ? 12 : input.trendRange === "ytd" ? Number(anchor.slice(5, 7)) : 6;
  const trendMonths: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) trendMonths.push(shiftMonth(anchor, -index));
  const trendLabel =
    input.trendRange === "ytd" ? "This year" : `Last ${count} months`;
  const trendJobs = new Map<string, number>();
  for (const line of lines) {
    if (line.day > range.to) continue;
    const month = line.day.slice(0, 7);
    trendJobs.set(month, (trendJobs.get(month) ?? 0) + 1);
  }
  const points: RpTrendPoint[] = trendMonths.map((month) => ({
    month,
    label: MONTH_SHORT.format(at(`${month}-01`)),
    longLabel: MONTH_LONG.format(at(`${month}-01`)),
    from: `${month}-01`,
    to: month === anchor ? range.to : monthEnd(month),
    pence: input.monthlySpend.get(month) ?? 0,
    jobs: trendJobs.get(month) ?? 0,
  }));
  const trendTotal = points.reduce((sum, point) => sum + point.pence, 0);
  /* The previous EQUAL window: the same number of months immediately before. */
  const priorMonths = trendMonths.map((month) => shiftMonth(month, -count));
  const trendPrevious = priorMonths.reduce((sum, month) => sum + (input.monthlySpend.get(month) ?? 0), 0);

  /* ── Top sites ──────────────────────────────────────────────────────────── */

  const sitesWindow = (() => {
    switch (input.sitesRange) {
      case "month":
        return { from: monthStart(range.to), to: range.to, label: "This month" };
      case "3m":
        return { from: `${shiftMonth(anchor, -2)}-01`, to: range.to, label: "Last 3 months" };
      case "ytd":
        return { from: `${range.to.slice(0, 4)}-01-01`, to: range.to, label: "This year" };
      default:
        return { from: range.from, to: range.to, label: rangeLabel(range.from, range.to) };
    }
  })();
  const bySite = new Map<string, { pence: number; jobs: number }>();
  let sitesTotal = 0;
  for (const line of lines) {
    if (!inWindow(line.day, sitesWindow.from, sitesWindow.to)) continue;
    const key = spendSiteOf(line.job, siteNames);
    const entry = bySite.get(key) ?? { pence: 0, jobs: 0 };
    entry.pence += line.pence;
    entry.jobs += 1;
    bySite.set(key, entry);
    sitesTotal += line.pence;
  }
  const noSite = bySite.get(NO_SITE_KEY) ?? { pence: 0, jobs: 0 };
  const realSites = [...bySite.entries()].filter(([key]) => key !== NO_SITE_KEY);
  const siteRows = realSites
    .map(([siteId, entry]) => ({ siteId, name: siteNames.get(siteId) ?? siteId, pence: entry.pence, jobs: entry.jobs }))
    .sort((left, right) => right.pence - left.pence || left.name.localeCompare(right.name, "en-GB"));

  /* ── Repeat activity ────────────────────────────────────────────────────── */

  const toExclusive = shiftDays(range.to, 1);
  const analysis = analyseRepeats(input.jobs, { from: range.from, toExclusive });
  const raised = input.jobs.filter((job) => {
    const day = String(job.requestedAt ?? "").trim().slice(0, 10);
    return day >= range.from && day < toExclusive;
  });
  const repeatJobs = input.jobs.filter((job) => analysis.inRange.has(job.id));
  const spendOf = (job: ReportsJob) => spendLineOf(job)?.pence ?? 0;
  const repeatSpend = repeatJobs.reduce((sum, job) => sum + spendOf(job), 0);
  /* Real sites only. A repeat whose site id names no site row is drawn in the
     by-site donut as "No site" (`spendSiteOf`), so "across N sites" does not
     count it as one either — the sentence and the donut say the same thing. */
  const sitesAffected = new Set(
    repeatJobs.map((job) => spendSiteOf(job, siteNames)).filter((key) => key !== NO_SITE_KEY),
  ).size;

  const issueGroups = new Map<string, { key: string; label: string; value: number; jobs: number; labels: Set<string> }>();
  for (const job of repeatJobs) {
    const key = repeatIssueKey(job.category) ?? "__none__";
    const raw = String(job.category ?? "").trim();
    const group = issueGroups.get(key) ?? { key, label: raw || "Other", value: 0, jobs: 0, labels: new Set<string>() };
    group.value += spendOf(job);
    group.jobs += 1;
    if (raw) group.labels.add(raw);
    issueGroups.set(key, group);
  }
  const byIssue = topFive(
    [...issueGroups.values()].map((group) => ({ ...group, labels: [...group.labels] })),
    "Other",
  );

  const siteGroups = new Map<string, { key: string; label: string; value: number; jobs: number; labels: string[] }>();
  for (const job of repeatJobs) {
    const key = spendSiteOf(job, siteNames);
    const siteId = (job.siteId ?? "").trim();
    const group =
      siteGroups.get(key) ??
      (key === NO_SITE_KEY
        ? { key, label: "No site", value: 0, jobs: 0, labels: [NO_SITE_KEY] }
        : { key, label: siteNames.get(siteId) ?? siteId, value: 0, jobs: 0, labels: [siteId] });
    /* A DANGLING id — a site row that no longer exists — is "No site" too, and
       the slice's drill must name it: `__unassigned__` alone matches only a
       blank or placeholder site, so the board would list fewer jobs than the
       slice counted. */
    if (key === NO_SITE_KEY && siteId && siteId !== "site-unassigned" && !group.labels.includes(siteId)) {
      group.labels.push(siteId);
    }
    group.value += spendOf(job);
    group.jobs += 1;
    siteGroups.set(key, group);
  }
  const noSiteGroup = siteGroups.get(NO_SITE_KEY);
  const siteSlices = topFive(
    [...siteGroups.values()].filter((group) => group.key !== NO_SITE_KEY),
    "Other sites",
  );
  if (noSiteGroup) {
    /* `--ov-grey` at 60%, as the brief draws "No site". */
    siteSlices.push({ ...noSiteGroup, colour: `${RP_COLOURS.grey}99` });
  }

  const bandCounts = new Map<RpBand["key"], { patterns: number; jobs: number }>();
  for (const pattern of analysis.patterns.values()) {
    const entry = bandCounts.get(pattern.band) ?? { patterns: 0, jobs: 0 };
    entry.patterns += 1;
    entry.jobs += pattern.repeatIds.length;
    bandCounts.set(pattern.band, entry);
  }
  const bands: RpBand[] = RECURRENCE_BANDS.map((band) => ({
    key: band.key,
    label: band.label,
    value: bandCounts.get(band.key)?.patterns ?? 0,
    jobs: bandCounts.get(band.key)?.jobs ?? 0,
    colour: BAND_COLOUR[band.key],
  }));

  /* ── Data gaps, over the costed jobs in range ───────────────────────────── */

  const withoutSite = inRange.filter((line) => spendSiteOf(line.job, siteNames) === NO_SITE_KEY).length;
  const withoutIssue = inRange.filter((line) => repeatIssueKey(line.job.category) === null).length;

  const metrics: RpMetrics = {
    generatedAt: input.now.toISOString(),
    portfolio: input.portfolio,
    portfolios: input.portfolios,
    range: {
      from: range.from,
      to: range.to,
      label: rangeLabel(range.from, range.to),
      calendarMonth: range.calendarMonth,
      previous: { ...range.previous, label: rangeLabel(range.previous.from, range.previous.to) },
    },
    policy: {
      repeatWindowDays: REPEAT_WINDOW_DAYS,
      repeatThresholds: { good: REPEAT_RATE_ARC.good, warn: REPEAT_RATE_ARC.warn },
      recurrenceBands: RECURRENCE_BANDS.map((band) => ({ key: band.key, label: band.label, maxDays: band.maxDays })),
    },
    kpis,
    unclassified,
    sparkUnit,
    trend: {
      range: input.trendRange,
      label: trendLabel,
      points,
      totalPence: trendTotal,
      previousPence: trendPrevious,
      delta: deltaOf(trendTotal, trendPrevious, `vs previous ${count} ${count === 1 ? "month" : "months"}`),
    },
    topSites: {
      range: input.sitesRange,
      label: sitesWindow.label,
      from: sitesWindow.from,
      to: sitesWindow.to,
      rows: siteRows.slice(0, 8),
      sitesPence: sitesTotal - noSite.pence,
      noSite,
      totalPence: sitesTotal,
      siteCount: siteRows.length,
    },
    repeat: {
      jobsInRange: raised.length,
      repeatJobs: repeatJobs.length,
      percent: raised.length > 0 ? Math.round((repeatJobs.length / raised.length) * 100) : 0,
      sitesAffected,
      spendPence: repeatSpend,
      byIssue,
      bySite: siteSlices,
      patterns: analysis.patterns.size,
      bands,
    },
    dataGaps: {
      costedJobs: inRange.length,
      /* Zero under the shipped rule, which types every job — computed rather
         than asserted, so a rule that can leave a job untyped shows here. */
      withoutType: unclassified.jobs,
      withoutSite,
      withoutIssue,
    },
    reconciliation: [],
  };
  metrics.reconciliation = reconcileReportsDashboard(metrics, {
    siteCount: input.siteCount,
  });
  return metrics;
}

/* ── Reconciliation, asserted rather than assumed ─────────────────────────── */

/** The brief's §5.3 identities, as a function the tests and the route both run. */
export function reconcileReportsDashboard(
  metrics: RpMetrics,
  context: { siteCount?: number } = {},
): string[] {
  const failures: string[] = [];
  const [total, ...typed] = metrics.kpis;
  if (total) {
    const typedPence = typed.reduce((sum, kpi) => sum + kpi.pence, 0) + metrics.unclassified.pence;
    if (typedPence !== total.pence) failures.push(`types ${typedPence} != total ${total.pence}`);
    const typedJobs = typed.reduce((sum, kpi) => sum + kpi.jobs, 0) + metrics.unclassified.jobs;
    if (typedJobs !== total.jobs) failures.push(`typed jobs ${typedJobs} != total jobs ${total.jobs}`);
  }
  for (const kpi of metrics.kpis) {
    const spark = kpi.spark.reduce((sum, point) => sum + point.pence, 0);
    if (spark !== kpi.pence) failures.push(`${kpi.key} sparkline ${spark} != ${kpi.pence}`);
  }
  const trend = metrics.trend.points.reduce((sum, point) => sum + point.pence, 0);
  if (trend !== metrics.trend.totalPence) failures.push(`trend points ${trend} != total ${metrics.trend.totalPence}`);
  const { topSites } = metrics;
  if (topSites.sitesPence + topSites.noSite.pence !== topSites.totalPence) {
    failures.push(`sites ${topSites.sitesPence} + no site ${topSites.noSite.pence} != ${topSites.totalPence}`);
  }
  const { repeat } = metrics;
  const byIssue = repeat.byIssue.reduce((sum, slice) => sum + slice.value, 0);
  const bySite = repeat.bySite.reduce((sum, slice) => sum + slice.value, 0);
  if (byIssue !== repeat.spendPence) failures.push(`repeat by issue ${byIssue} != repeat spend ${repeat.spendPence}`);
  if (bySite !== repeat.spendPence) failures.push(`repeat by site ${bySite} != repeat spend ${repeat.spendPence}`);
  const issueJobs = repeat.byIssue.reduce((sum, slice) => sum + slice.jobs, 0);
  if (issueJobs !== repeat.repeatJobs) failures.push(`repeat issue jobs ${issueJobs} != repeat jobs ${repeat.repeatJobs}`);
  const bands = repeat.bands.reduce((sum, band) => sum + band.value, 0);
  if (bands !== repeat.patterns) failures.push(`recurrence rings ${bands} != patterns ${repeat.patterns}`);
  const bandJobs = repeat.bands.reduce((sum, band) => sum + band.jobs, 0);
  if (bandJobs !== repeat.repeatJobs) failures.push(`recurrence jobs ${bandJobs} != repeat jobs ${repeat.repeatJobs}`);
  if (repeat.repeatJobs > repeat.jobsInRange) {
    failures.push(`repeat jobs ${repeat.repeatJobs} > jobs raised ${repeat.jobsInRange}`);
  }
  if (repeat.sitesAffected > repeat.repeatJobs) {
    failures.push(`sites with repeats ${repeat.sitesAffected} > repeat jobs ${repeat.repeatJobs}`);
  }
  if (context.siteCount !== undefined && repeat.sitesAffected > context.siteCount) {
    failures.push(`sites with repeats ${repeat.sitesAffected} > sites in scope ${context.siteCount}`);
  }
  return failures;
}
