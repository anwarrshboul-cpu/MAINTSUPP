/**
 * THE REPORTS DASHBOARD BLOCK'S WIRE SHAPE — `GET /api/reports/metrics`.
 *
 * Types only, and NO imports of any kind, for the reason
 * `compliance-dash-contract.ts` gives: the block that renders this is a client
 * component, and a module with no imports cannot drag the query builder into
 * the browser bundle however it is imported.
 *
 * The server builds this in `app/lib/reports-dash.ts`. Every pound in it is
 * `maintenance_requests.cost`, counted once the job is completed and dated by
 * its completion day — the Overview spend trend's basis, through the same
 * query — so a month reads the same on both pages. Every job it counts is a
 * live row on the Jobs board (`liveWorkOrderCondition`). Money is integer PENCE
 * throughout; the component formats, it never divides.
 *
 * ── THE TYPE SPLIT IS THE JOB'S CANONICAL JOB TYPE ───────────────────────
 *
 * Reactive / Planned / Project are the three DEFAULT job types, matched by
 * their stable `code` (`job-type-contract.ts`), never inferred from a
 * category, a tier or a cost. Custom types are grouped as Other, and a job with
 * no type is Unclassified; the five together are the total, to the penny. Each
 * figure's drill sends a stable `type=` token — the type's id, or `__other__` /
 * `__unclassified__` — so renaming a type moves the words and never a link.
 */

/** The three stable codes a type KPI is drawn for — `JOB_TYPE_CODES`, restated because this module imports nothing. */
export type RpTypeCode = "reactive" | "planned" | "project";

/** Every bucket a pound of spend falls in, by its job's canonical type (`jobTypeBucketOf`). */
export type RpSpendType = RpTypeCode | "other" | "unclassified";

export type RpDelta = {
  /** "new" when the previous period was £0 and this one is not; "none" when both were £0. */
  direction: "up" | "down" | "flat" | "new" | "none";
  /** Whole-number percentage change, or null for "new" / "none". */
  percent: number | null;
  /** "vs Aug 2026" for a calendar month, otherwise "vs previous period" / "vs previous 6 months". */
  comparedWith: string;
};

export type RpSparkPoint = {
  /** `YYYY-MM-DD` — the first day of the bucket. */
  key: string;
  /** "12 May", "w/c 12 May", "May 2024" or "2024" — see `sparkUnit`. */
  label: string;
  pence: number;
  jobs: number;
};

export type RpKpi = {
  /** "total", or the default type's stable code. Keys the card's accent and icon — never its words. */
  key: "total" | RpTypeCode;
  /**
   * "This month" when the range is the current calendar month, else "Total
   * spend"; or the job type's CURRENT label from its configuration, so a
   * renamed type shows its new name on the next read.
   */
  label: string;
  /** The job type's stable id; null for the total. */
  jobTypeId: string | null;
  /** The default type's stable code; null for the total. */
  code: RpTypeCode | null;
  /**
   * The `type=` token this card's drill sends — the type's id — or null for
   * the total, which sends no type at all.
   */
  drillType: string | null;
  /**
   * False for a DEACTIVATED default type. Its card is kept while it still has
   * spend in the range — retiring a type hides it from new jobs, it does not
   * delete the history filed under it — and is dropped once it has none.
   */
  active: boolean;
  pence: number;
  /** Jobs whose completed cost is counted in `pence`. */
  jobs: number;
  previousPence: number;
  delta: RpDelta;
  /** Daily (range ≤ 45 days) or weekly buckets; the points sum to `pence`. */
  spark: RpSparkPoint[];
};

/**
 * The spend NO type card claims — carried beside the KPIs, named in the total
 * card's tooltip and the data gaps, and drillable, so it is never silently
 * dropped. Reactive + Planned + Project + Other + Unclassified = the total.
 */
export type RpTypeBucket = {
  key: "other" | "unclassified";
  /** "Other" / "Unclassified". */
  label: string;
  /** The `type=` token its drill sends: `__other__` or `__unclassified__`. */
  drillType: string;
  pence: number;
  jobs: number;
  previousPence: number;
  delta: RpDelta;
  /** For Other: the labels of the custom types in the range, for a tooltip. Empty for Unclassified. */
  typeLabels: string[];
};

export type RpTrendPoint = {
  /** `YYYY-MM`. */
  month: string;
  /** "Sep". */
  label: string;
  /** "Sep 2026", for the tooltip. */
  longLabel: string;
  /** The month's first and last day, for the drill-through. */
  from: string;
  to: string;
  pence: number;
  jobs: number;
};

export type RpTrendRange = "3m" | "6m" | "12m" | "ytd";
export type RpSitesRange = "page" | "month" | "3m" | "ytd";

export type RpSiteRow = {
  siteId: string;
  name: string;
  pence: number;
  jobs: number;
};

export type RpSpendSlice = {
  key: string;
  label: string;
  /** Pence. */
  value: number;
  jobs: number;
  colour: string;
  /**
   * What the slice's drill sends: the raw category labels behind an issue
   * segment (several for "Other"), or the site ids behind a site segment
   * (`__unassigned__` for "No site").
   */
  labels: string[];
};

export type RpBand = {
  key: "weekly" | "fortnightly" | "monthly" | "less-often";
  label: string;
  /** Repeat patterns in this band — what the ring draws. */
  value: number;
  /**
   * The repeat JOBS those patterns hold — what the ring's drill lists. A ring
   * reading "2 patterns" opens the jobs that make them up, so the tooltip and
   * the accessible name state both numbers ("2 patterns · 5 repeat jobs") and
   * the list the reader lands on matches a number they were shown.
   */
  jobs: number;
  colour: string;
};

export type RpMetrics = {
  generatedAt: string;
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  range: {
    from: string;
    to: string;
    label: string;
    /** True when the range is exactly one calendar month. */
    calendarMonth: boolean;
    previous: { from: string; to: string; label: string };
  };
  policy: {
    repeatWindowDays: number;
    /** `REPEAT_RATE_ARC` — lower is better. */
    repeatThresholds: { good: number; warn: number };
    recurrenceBands: { key: RpBand["key"]; label: string; maxDays: number | null }[];
  };
  /**
   * Total first, then one card per DEFAULT job type in code order — reactive,
   * planned, project — each labelled from the configuration. A deactivated
   * default type's card is present only while it has spend in the range.
   */
  kpis: RpKpi[];
  /** Every custom (code-less) job type together. */
  other: RpTypeBucket;
  /** Jobs with no job type. Reactive + Planned + Project + Other + this = total. */
  unclassified: RpTypeBucket;
  /** Daily to 45 days, weekly to two years, monthly to 400 months, then yearly. */
  sparkUnit: "day" | "week" | "month" | "year";
  trend: {
    range: RpTrendRange;
    label: string;
    points: RpTrendPoint[];
    /** The sum of the points — the card's big number. */
    totalPence: number;
    previousPence: number;
    delta: RpDelta;
  };
  topSites: {
    range: RpSitesRange;
    label: string;
    from: string;
    to: string;
    /** The eight highest, descending. */
    rows: RpSiteRow[];
    /** Every site's spend in the card's range, not only the eight shown. */
    sitesPence: number;
    noSite: { pence: number; jobs: number };
    /** sitesPence + noSite.pence — the card's range total. */
    totalPence: number;
    siteCount: number;
  };
  repeat: {
    /** Jobs raised in the range — the rate's denominator. */
    jobsInRange: number;
    repeatJobs: number;
    /** Whole percent; lower is better. */
    percent: number;
    sitesAffected: number;
    /** Completed cost of the repeat jobs raised in the range. */
    spendPence: number;
    byIssue: RpSpendSlice[];
    bySite: RpSpendSlice[];
    /** Site × issue patterns with at least one repeat job in the range. */
    patterns: number;
    bands: RpBand[];
  };
  /** The brief's §10.1 data-gap report, over the costed jobs in range. */
  dataGaps: {
    costedJobs: number;
    /** Costed jobs with no job type — the Unclassified bucket. */
    withoutType: number;
    withoutTypePence: number;
    /** Costed jobs of a custom type — the Other bucket. */
    otherType: number;
    otherTypePence: number;
    withoutSite: number;
    withoutIssue: number;
  };
  /** Empty when every §5.3 identity held. */
  reconciliation: string[];
};
