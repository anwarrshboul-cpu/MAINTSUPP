/**
 * THE OVERVIEW'S WIRE CONTRACT — types only, no runtime.
 *
 * Every payload `/api/dashboard/*` returns and every payload the page consumes,
 * declared once so the aggregate and the card cannot disagree about a field
 * name. It carries no code deliberately: it is imported by client components
 * and by server route handlers alike, and a runtime import in a module both
 * sides pull would drag drizzle into the browser bundle.
 *
 * ── THE THREE RULES EVERY SHAPE BELOW ENCODES ─────────────────────────────
 *
 * 1. §1.4 — a percentage is always a share of RECORDED values, so every
 *    breakdown carries `recorded` and `total` separately and never a bare
 *    percentage whose denominator the reader cannot see.
 * 2. §1.5 — zero, null and "no data" are three different things. A count is a
 *    `number`; an unanswerable figure is `null`; the difference is never
 *    collapsed to 0 on the way out.
 * 3. §1.1 — the cohort follows one axis, so every payload states the `measure`
 *    it was computed on and every card can print the matching wording.
 *
 * Money crosses the wire as INTEGER PENCE, named `…Pence`, for the same reason
 * it is stored that way: a float that has been through JSON twice is not the
 * number anybody typed.
 */

/*
 * From `overview-meters.ts`, which reaches nothing but `job-metrics.ts`.
 *
 * `dashboard-filters.ts` re-exports the same type, and taking it from there
 * would be harmless at runtime — `import type` is erased — but this file is
 * imported by client components and by route handlers alike, and the rule the
 * suite pins is a rule about the SPECIFIER, not about whether the emit happens
 * to be empty. One import path, and it is the browser-safe one.
 */
import type { CohortMeasure } from "../../../lib/overview-meters";

export type { CohortMeasure };

/** The resolved date window, as every route already returns it. */
export type WindowPayload = {
  key: string;
  label: string;
  start: string | null;
  endExclusive: string;
  days: number;
  hasPrevious: boolean;
};

/** A figure with its previous-period twin. `null` means "not comparable". */
export type Delta = {
  value: number | null;
  previous: number | null;
};

/* ── At a glance ──────────────────────────────────────────────────────────── */

export type SeverityCounts = {
  fresh: number;
  ageing: number;
  overdue: number;
  critical: number;
};

export type MeterRow = {
  key: string;
  label: string;
  colour: string;
  sortOrder: number;
  /** Hidden meters still appear here — §2.3: hiding must never break the total. */
  visible: boolean;
  isCatchAll: boolean;
  /** Jobs in the cohort whose current status maps to this meter. */
  total: number;
  /** Of those, the ones still open. */
  open: number;
  /** Integer share of the cohort. The eight sum to 100 after rounding. */
  share: number;
  previousTotal: number | null;
  /** Absolute change against the immediately preceding equal-length period. */
  delta: number | null;
  /** Ageing of this meter's OPEN jobs. Null when it has none. */
  oldestOpenDays: number | null;
  averageOpenDays: number | null;
  /** Completed only — §2.3 shows "Avg time to close 21d" in place of ageing. */
  averageCloseDays: number | null;
  severity: SeverityCounts;
  /** The status labels this meter owns, so a tile can drill with one chip. */
  statuses: string[];
};

export type MetersPayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  /** The whole cohort. The meters sum to exactly this. */
  cohortTotal: number;
  /** §1.1's footnote — rows the axis cannot see. Never imputed. */
  excluded: number;
  meters: MeterRow[];
  /** §2.2 — four headline figures, no chart. */
  pulse: {
    open: Delta;
    urgentOpen: Delta;
    oldestOpenDays: Delta & { reference: string | null };
    incompleteRecords: Delta;
  };
  /** Statuses with no row in the map at all, for the admin notice. */
  unmappedStatuses: string[];
};

/* ── Where work is stuck ──────────────────────────────────────────────────── */

export type StuckRow = {
  id: string;
  reference: string | null;
  title: string;
  siteId: string | null;
  siteName: string;
  meterKey: string;
  meterLabel: string;
  /** Days since the job entered its CURRENT status — §2.4. */
  heldDays: number;
  heldSince: string | null;
  /** Where `heldSince` came from, so the report can say what was recovered. */
  heldSource: "activity" | "column" | "updated_at";
  lastUpdate: string | null;
  owner: string | null;
  status: string;
};

export type StuckPayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  rows: StuckRow[];
  /** Every waiting job, not just the six shown. */
  totalWaiting: number;
  byMeter: Array<{ key: string; label: string; count: number; overThirtyDays: number }>;
  /** §2.4 asks for these two numbers to be reported. */
  recovered: number;
  fallback: number;
};

/* ── Breakdowns ───────────────────────────────────────────────────────────── */

export type BreakdownBucket = {
  key: string;
  label: string;
  value: number;
  /** Share of RECORDED, integer, summing to 100 across the recorded buckets. */
  share: number;
  colour: string;
  notRecorded: boolean;
  /** Present only when Split by priority is on. Sums to `value`. */
  byPriority?: Record<string, number>;
};

export type BreakdownDimension = {
  key: string;
  label: string;
  /** Rows with a value. The percentage denominator, and it is always shown. */
  recorded: number;
  /** The cohort. `total - recorded` is the "Not recorded" count. */
  total: number;
  buckets: BreakdownBucket[];
  /** A computed sentence, never a hard-coded one. Empty when there is nothing to say. */
  note: string;
  /** Fires on the conditions §5.3 names — tier underuse, label taxonomy. */
  warning: string | null;
};

export type BreakdownPayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  total: number;
  excluded: number;
  splitByPriority: boolean;
  dimensions: {
    tier: BreakdownDimension;
    engineer: BreakdownDimension;
    priority: BreakdownDimension;
    label: BreakdownDimension;
  };
};

/* ── Financial status ─────────────────────────────────────────────────────── */

export type CostSiteRow = {
  siteId: string;
  siteName: string;
  unassigned: boolean;
  spendPence: number;
  costedJobs: number;
  jobsInCohort: number;
  medianPence: number | null;
  coveragePercent: number;
};

export type ContractorSpendRow = {
  /** A contractor id, or `name:<lowercased>` when the job carries text only. */
  key: string;
  name: string;
  spendPence: number;
  jobs: number;
  /** False renders muted with no bar fill — §3.6: never read as verified. */
  linked: boolean;
};

export type SpendBucket = {
  label: string;
  start: string;
  endInclusive: string;
  spendPence: number;
  costedJobs: number;
  /** A period still running. Drawn hatched, never as a completed column. */
  partial: boolean;
};

export type CostPayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  cohortTotal: number;
  costedJobs: number;
  /**
   * Read first — §3.2. The banner threshold is decided from this.
   *
   * NULL WHEN THERE IS NOTHING TO COVER, AND THAT IS NOT THE SAME AS 0%.
   *
   * `percentOf` answers 0 for a zero denominator, so a period holding no job
   * at all returned `cohortTotal: 0, costedJobs: 0, coveragePercent: 0` and the
   * card fired §3.2's amber banner: "Cost data covers 0% of jobs in this
   * period. Treat these figures as indicative, not as portfolio spend." That is
   * a "no data" state rendered as a confident statement about bad data, which
   * is precisely what §1.5 separates — zero, null and "no data" are three
   * different things. Reproducible on
   * `?period=custom&from=2020-01-01&to=2020-03-31`.
   *
   * The rest of this payload already knows how to say "unknown":
   * `medianCostPence` and `largest` are both nullable for the same reason. Only
   * this field was typed so that it could not.
   */
  coveragePercent: number | null;
  totalSpendPence: number;
  medianCostPence: number | null;
  largest: { id: string; reference: string | null; title: string; spendPence: number } | null;
  previous: {
    totalSpendPence: number;
    costedJobs: number;
    medianCostPence: number | null;
    largestPence: number | null;
  } | null;
  bucketing: Bucketing;
  trend: SpendBucket[];
  /** Rolling twelve months ending today, ignoring the page range — §3.3. */
  annual: { totalSpendPence: number; costedJobs: number; from: string; to: string } | null;
  sites: CostSiteRow[];
  /** Marked on every bar, so a site running expensive per job stands out. */
  portfolioMedianPence: number | null;
  byLabel: BreakdownDimension;
  byTier: BreakdownDimension;
  byEngineer: BreakdownDimension;
  contractors: ContractorSpendRow[];
  contractorAttributedPence: number;
  contractorLinkedPence: number;
  dataQuality: {
    completedWithoutCost: number;
    costWithoutContractor: number;
    unlinkedNames: number;
    zeroOrNegative: number;
  };
};

/* ── Performance over time ────────────────────────────────────────────────── */

export type Bucketing = "daily" | "weekly" | "monthly";

export type TimeToCloseBucket = {
  label: string;
  start: string;
  endInclusive: string;
  /** §4.3 — fewer than three renders as a gap with a dotted connector. */
  sample: number;
  medianDays: number | null;
  p90Days: number | null;
  byPriority: Record<string, { sample: number; medianDays: number | null }> | null;
};

export type SlaStage = {
  key: "acknowledged" | "assigned" | "attended" | "resolved";
  label: string;
  /** False draws "Not measured — no timestamp recorded", never 0% or 100%. */
  measurable: boolean;
  reason: string | null;
  coverage: { measured: number; total: number };
  buckets: Array<{ label: string; start: string; endInclusive: string; sample: number; percent: number | null }>;
  percent: number | null;
  previousPercent: number | null;
};

export type PerformancePayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  bucketing: Bucketing;
  timeToClose: {
    buckets: TimeToCloseBucket[];
    /** "57 jobs still open and not included." */
    openExcluded: number;
    medianDays: number | null;
    p90Days: number | null;
    previousMedianDays: number | null;
    previousP90Days: number | null;
    /**
     * THE COMPLETED JOBS THE HEADLINE WAS COMPUTED FROM, AND ITS PREVIOUS TWIN.
     *
     * §4.3's floor — "a median of fewer than three jobs is noise drawn as a
     * trend" — was applied to the BUCKETS and not to the headline above them,
     * so a window holding a single completed job reported a median and a
     * ninetieth percentile that were both that one job's age. The aggregate now
     * applies the same floor to the headline, which makes `medianDays` and
     * `p90Days` null under three.
     *
     * These two counts are what let the card say WHICH null it is. "No job was
     * completed in this period" and "1 completed job — too few to average" are
     * different facts about coverage, and an em dash with nothing beside it
     * states neither: it reads as a figure that failed to load.
     */
    sample: number;
    previousSample: number;
    splitByPriority: boolean;
  };
  sla: {
    stages: SlaStage[];
    targets: Array<{
      stage: string;
      priorityKey: string;
      targetMinutes: number;
      basis: string;
      version: number;
    }>;
    /** §4.4 — replaces the Jobs page's meaningless "Avg SLA target 64.8 hrs". */
    overallPercent: number | null;
    previousOverallPercent: number | null;
  };
};

/* ── Sites needing attention ──────────────────────────────────────────────── */

export type AttentionSiteRow = {
  siteId: string;
  siteName: string;
  openCount: number;
  urgentCount: number;
  oldestDays: number | null;
  oldestReference: string | null;
  /** A percentage — §6.3. The old card printed a count beside a bar. */
  shareOfOpen: number;
  severity: SeverityCounts;
  /** Weighted so critical-aged and urgent rank highest — §6.3. */
  score: number;
  compliance: { satisfied: number; applicable: number; scored: boolean };
};

export type SitesAttentionPayload = {
  period: WindowPayload;
  measure: CohortMeasure;
  /** Real sites only. Unassigned is data quality, not a location — §6.1. */
  openTotal: number;
  siteCount: number;
  portfolioSiteCount: number;
  ageing: SeverityCounts;
  /** Fires when Fresh and Ageing are both zero while the tail is not — §6.2. */
  intakeWarning: string | null;
  sites: AttentionSiteRow[];
  quietSites: number;
  dataQuality: {
    jobsWithNoSite: number;
    sitesWithoutComplianceProfile: number;
    sitesWithNoJobsAndNoContact: number;
  };
};

/* ── The drill-down list ──────────────────────────────────────────────────── */

/**
 * The records behind a footnote or a data-quality row.
 *
 * §1.5 requires every "Fix these →" to work. Most of them are expressible as a
 * Jobs-list filter and go there; the few that are not — "no request date
 * recorded", "cost but no contractor named" — have no vocabulary on the board's
 * filter bar, and inventing one there would be a larger change to a busier
 * screen. So the Overview answers them itself, from one endpoint, and the panel
 * that shows the rows can also act on them (§6.4's bulk site assign).
 */
export type RecordRow = {
  id: string;
  reference: string | null;
  title: string;
  siteId: string | null;
  siteName: string;
  status: string;
  priority: string;
  requestedAt: string | null;
  completedAt: string | null;
  costPence: number | null;
  contractor: string | null;
};

export type RecordsQuery =
  | "missing_measure_date"
  /*
   * The five conditions the Pulse tile COUNTS, so tapping it opens the jobs it
   * was counting. It used to open `no_site`, which is one of the five: a reader
   * tapped a figure of N and got a shorter list with no explanation.
   */
  | "incomplete_records"
  | "no_site"
  | "no_cost"
  | "completed_without_cost"
  | "cost_without_contractor"
  | "zero_or_negative_cost"
  | "stuck";

export type RecordsPayload = {
  period: WindowPayload;
  query: RecordsQuery;
  title: string;
  total: number;
  rows: RecordRow[];
  /** True when `rows` is a page of `total` rather than all of it. */
  truncated: boolean;
};

/* ── Settings → Dashboard meters ──────────────────────────────────────────── */

export type MeterSettingsPayload = {
  meters: Array<{
    key: string;
    label: string;
    colour: string;
    sortOrder: number;
    visible: boolean;
    isCatchAll: boolean;
    /** Live counts for the preview bar — §2.5. */
    count: number;
    statuses: Array<{ id: string; label: string; displayLabel: string; count: number }>;
  }>;
  cohortTotal: number;
  canEdit: boolean;
};
