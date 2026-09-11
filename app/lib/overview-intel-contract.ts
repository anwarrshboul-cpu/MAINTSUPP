/**
 * THE OVERVIEW'S "JOB INTELLIGENCE" SECTION — the wire contract.
 *
 * Type-only, and ZERO imports, for the same reason as the compliance and
 * reports contracts beside it: the server builds this in `overview-intel.ts`
 * (which imports drizzle), and the browser draws it in `oi-dash.tsx`, which
 * must never pull the query builder into the client bundle.
 *
 * ── ONE POPULATION, TWO CLOCKS ─────────────────────────────────────────────
 *
 * Every figure counts the Jobs board's own rows (`liveWorkOrderCondition`:
 * live, not archived, not a sub-item, on the Jobs board) inside the chosen
 * portfolio. Two clocks apply, and each field says which:
 *
 *   · NOW — open work as it stands: the open count, every split of it
 *     (status, priority, tier, engineer, label), SLA, aging and breach risk.
 *     A job is open by `closedJobSql`, the rule the Jobs board's meters use.
 *   · THE RANGE — `completed` and the time to close count jobs whose
 *     `completed_at` falls inside the page's date range.
 *
 * Slices carry the RAW values behind them in `labels`, so a drill can send
 * exactly what the segment counted, and carry NO colour: the page colours by
 * meaning (priority, tier) or by rank, from its own palette.
 */

export type OiSlice = {
  /** Stable key: the raw value, or a `__…__` sentinel for a rolled-up bucket. */
  key: string;
  label: string;
  value: number;
  /** The raw values this slice counts, for the Jobs board's filter. */
  labels: string[];
};

/** Priority as the board's filter speaks it: `urgent` is shown as "High". */
export type OiPriorityKey = "urgent" | "medium" | "low" | "not_recorded";

export type OiPriority = OiSlice & { key: OiPriorityKey };

export type OiSlaByPriority = {
  key: OiPriorityKey;
  label: string;
  /** Open jobs of this priority. */
  jobs: number;
  /** Of those, the ones not past their due date. */
  withinSla: number;
  /** withinSla ÷ jobs, whole percent; null when there are no jobs. */
  percent: number | null;
};

export type OiWeek = {
  /** First and last day of the week, inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** "w/c 4 Aug". */
  label: string;
  /** Mean days from requested to completed; null when nothing closed. */
  averageDays: number | null;
  jobs: number;
};

export type OiIntel = {
  /** NOW — open jobs. */
  open: number;
  /** RANGE — jobs completed inside the page's range. */
  completed: number;
  /** completed ÷ (completed + open), whole percent; null when both are 0. */
  completionRate: number | null;

  /**
   * NOW — the product's SLA metric: open jobs not yet past their due date,
   * as a share of open jobs. `percent` is null with no open jobs.
   */
  sla: { percent: number | null; withinSla: number; overdue: number; open: number };

  /** NOW — open jobs by priority, High → Low, "Unset" only when non-zero. */
  priority: OiPriority[];

  /** NOW — open jobs by status: the six largest, then "Other statuses". */
  status: OiSlice[];

  /** NOW — open jobs by tier level, Tier 1 first, then "No tier". */
  tiers: OiSlice[];

  /** NOW — open jobs by Engineer Required, largest first, then "Not recorded". */
  engineers: OiSlice[];

  /** NOW — open jobs by Label (the `category` field): top five, "Other", "Unassigned". */
  labels: OiSlice[];

  /** NOW — open jobs requested more than `thresholdDays` days ago. */
  aging: {
    thresholdDays: number;
    count: number;
    open: number;
    /** count ÷ open, whole percent; null with no open jobs. */
    percent: number | null;
    /** The newest requested day that counts as aged (today − threshold − 1). */
    cutoff: string;
    /** The oldest requested day among the aged jobs, for the drill's window. */
    oldestDay: string | null;
  };

  /**
   * NOW — open High-priority or Tier 1 jobs, not yet overdue, due inside the
   * next `windowHours` (due today or tomorrow: due dates are days).
   */
  breachRisk: {
    windowHours: number;
    count: number;
    /** Open High-priority or Tier 1 jobs — the gauge's denominator. */
    pool: number;
    percent: number | null;
  };

  /**
   * RANGE — mean days from requested to completed, over jobs completed in the
   * range, against the equal-length period immediately before it.
   */
  timeToClose: {
    averageDays: number | null;
    jobs: number;
    previousAverageDays: number | null;
    previousJobs: number;
    /** averageDays − previousAverageDays; negative is faster. */
    deltaDays: number | null;
    /** The seven weeks ending on the range's last day, oldest first. */
    weeks: OiWeek[];
  };

  /** NOW — the SLA metric per priority, with the target the bars are drawn against. */
  slaByPriority: OiSlaByPriority[];
  slaTargetPercent: number;
};
