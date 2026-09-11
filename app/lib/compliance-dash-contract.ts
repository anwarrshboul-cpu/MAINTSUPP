/**
 * THE COMPLIANCE DASHBOARD BLOCK'S WIRE SHAPE — `GET /api/compliance/metrics`.
 *
 * Types only, and NO imports of any kind. The block that renders this is a
 * client component and `overview-page.tsx` records what happened the last time
 * a client module reached a server one: two words from `dashboard-filters.ts`
 * dragged the whole query builder into the browser bundle. A module with no
 * imports cannot do that, whichever way it is imported.
 *
 * The server builds this in `app/lib/compliance-dash.ts`; the component draws
 * it and computes nothing. Every count here comes from the SAME register and
 * the SAME classifier as the Compliance page below the block, the Overview's
 * compliance KPI and the Sites page — `readComplianceRegister` and
 * `complianceCompletion` — so the score cannot disagree with them.
 */

/** One segment, ring or legend row — the same shape the Overview block uses. */
export type CpSlice = {
  key: string;
  label: string;
  value: number;
  colour: string;
  /**
   * The raw values this slice stands for, so its drill opens exactly the rows
   * it counted: the register `kind`s behind a type ring (several for "Other
   * types"), or the `who` values behind a renewal segment.
   */
  labels: string[];
};

/** The four states that make up the score. "Not required" is outside it. */
export type CpStateKey = "compliant" | "expiring" | "expired" | "missing";

export type CpStatusCounts = Record<CpStateKey, number>;

/**
 * A register filter, as query parameters the Compliance register ALREADY
 * reads (`parseComplianceFilters`). The block applies it to the address bar and
 * the register below redraws on exactly the rows the figure counted.
 * `scored=1` is on every one of them: the block counts only the requirements
 * inside the score, and the register must open on the same population.
 */
export type CpRegisterFilter = Record<string, string[]>;

export type CpTypeRing = {
  /** The requirement kind, or `__other__` for the aggregate eighth ring. */
  key: string;
  /** The full requirement name — "Fire Risk Assessment" — or "Other types". */
  label: string;
  /** Every register kind this ring counts (one, or the folded remainder). */
  kinds: string[];
  counts: CpStatusCounts;
  /** Compliant + Expiring soon + Expired + Missing for this type. */
  total: number;
  /** Whole percent compliant; 0 when `total` is 0. */
  percent: number;
  filter: CpRegisterFilter;
  /** The register filter for this type's Expired records (the red dot). */
  expiredFilter: CpRegisterFilter;
};

export type CpCountdownKey = "expired" | "band-1" | "band-2" | "band-3" | "no-date";

export type CpCountdownRing = {
  key: CpCountdownKey;
  /** "Expired", "0–30 days", "31–60 days", "61–90 days" (thirds of the window), "No due date". */
  label: string;
  value: number;
  colour: string;
  filter: CpRegisterFilter;
};

export type CpRenewalSlice = CpSlice & {
  /** Whether this responsible party is a linked contractor record. */
  linked: boolean;
  filter: CpRegisterFilter;
};

export type CpMetrics = {
  /** The instant the register was classified at, ISO. */
  generatedAt: string;
  /**
   * The calendar day the classifier used, `YYYY-MM-DD`: the Europe/London day
   * (`complianceDay`), which is what `expiryStatus` counts whole days from. A
   * certificate due today flips to Expired when that UK day ends — in winter
   * and in British Summer Time alike — with no data change.
   */
  today: string;
  portfolio: { id: string; name: string; siteIds: string[] };
  portfolios: { id: string; name: string }[];
  /**
   * The due-date range the header's picker holds. It filters the REGISTER below
   * and the EXPORT, per the brief; the block's own figures are a snapshot as of
   * today and do not move with it. Null bounds mean "any due date".
   */
  range: { from: string | null; to: string | null; label: string };
  policy: {
    /** The organisation's warning window (default 90) — the amber window, and what the countdown splits. */
    warningWindowDays: number;
    /** The three countdown windows, inclusive day bounds. */
    bands: { key: "band-1" | "band-2" | "band-3"; label: string; fromDays: number; toDays: number }[];
    /** `QUALITY_ARC` — the sites gauge's colour thresholds. */
    thresholds: { good: number; warn: number };
  };
  score: {
    /** Whole percent — `complianceCompletion(...).percent`. */
    percent: number;
    /** False when nothing is applicable: print "—", never a failing 0%. */
    scored: boolean;
    /** X — requirements compliant. */
    satisfied: number;
    /** Y — requirements in the score; `counts` sums to it. */
    applicable: number;
    counts: CpStatusCounts;
    /** Records marked not required: outside the score on both sides. */
    notRequired: number;
    /** Records whose responsibility is unconfirmed or not the client's: outside the score. */
    excluded: number;
    /** A register filter per status, for the donut's segments and legend rows. */
    filters: Record<CpStateKey, CpRegisterFilter>;
  };
  /** Worst compliant percentage first; at most eight, the eighth aggregating the rest. */
  types: CpTypeRing[];
  /** Every requirement type in the score, before the top-seven cut. */
  typeCount: number;
  countdown: {
    rings: CpCountdownRing[];
    /** Expired + every Expiring soon record — the denominator each ring fills against. */
    total: number;
  };
  renewals: {
    slices: CpRenewalSlice[];
    /** Expired + Expiring soon — the same records the countdown counts. */
    total: number;
    /** Renewals whose responsible party is free text, not a contractor record. */
    unlinked: number;
    linked: number;
    /** The register filter "View all renewals" applies (sorted soonest due). */
    allFilter: CpRegisterFilter;
  };
  sites: {
    /** Active sites with ≥ 1 requirement in the score and no Expired or Missing one. */
    fullyCompliant: number;
    /** Active sites with ≥ 1 requirement in the score — the gauge's denominator. */
    considered: number;
    percent: number;
    /** What the gauge opens: the Sites list narrowed to the sites NOT fully compliant. */
    notFullyCompliantIds: string[];
    /** Active sites in scope, by the Sites page's own rule, with or without requirements. */
    activeSites: number;
  };
  /** The brief's §10.1 data-gap report, from the same snapshot. */
  dataGaps: {
    /** Certificates held with no due date recorded (the amber "no date" case). */
    heldWithoutDueDate: number;
    /** Every scored record with no due date, held or not. */
    noDueDate: number;
    unlinkedResponsibility: number;
    /** Whether the product holds a site-type → requirement applicability config. */
    siteTypeApplicability: "exists" | "missing";
  };
  /** Empty when every §5.3 identity held. */
  reconciliation: string[];
};
