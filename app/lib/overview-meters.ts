/**
 * THE OVERVIEW'S SHARED VOCABULARY — meters, ramps, and the percentage rule.
 *
 * One module, imported by the aggregates that count and by the components that
 * draw, because the master prompt's opening complaint about this page is that
 * "the same question got a different answer on two cards". Every rule below is
 * one a card could plausibly re-derive, and every one of them is therefore
 * here instead.
 *
 * ── WHY THE COLOURS ARE NOT IN `job-metrics.ts` ───────────────────────────
 *
 * That module owns the product's semantic colours — the three status families,
 * the ageing bands, the four priorities — and they are used by the Compliance
 * page, the Jobs board, the digest emails and the CSV exports. §1.3 asks for a
 * DIFFERENT palette on the Overview specifically: a meter ramp that reads left
 * to right as one progression, and a severity ramp used only where a value is
 * being judged. Restyling `job-metrics.ts` would repaint five other surfaces
 * that nobody asked to change, and would break the pins that hold those
 * surfaces to their current colours for good reasons.
 *
 * So the Overview's ramps live here, the rest of the product keeps its own, and
 * the two do not fight. The hexes below are duplicated once, in
 * `app/(app)/portal/ops/ops-tokens.css`, because CSS cannot import TypeScript;
 * `tests/overview-foundations.test.mjs` pins the two lists identical.
 */

import { statusKey } from "./job-metrics";

/* ── The eight meters ─────────────────────────────────────────────────────── */

/**
 * §2.1. In WORKFLOW ORDER, which is the order the segmented bar draws and the
 * order the tiles fall in — completed work first, stuck work last, so the bar
 * reads as a story rather than as a rainbow.
 */
export const METER_KEYS = [
  "completed",
  "scheduled",
  "in_progress",
  "waiting_approval",
  "waiting_parts",
  "waiting_payment",
  "needs_attention",
  "other",
] as const;

export type MeterKey = (typeof METER_KEYS)[number];

/**
 * THE PERMANENT CATCH-ALL.
 *
 * §2.1: "`other` is a permanent catch-all and cannot be deleted, renamed away
 * from that role, or hidden." Every status with no assignment resolves here,
 * which is what makes "a status added later must appear correctly with no code
 * change" (§9.9) true by construction rather than by remembering.
 */
export const CATCH_ALL_METER: MeterKey = "other";

/** The seeded display names. An operator may change any of them in Settings. */
export const METER_SEED_LABEL: Record<MeterKey, string> = {
  completed: "Completed",
  scheduled: "Scheduled",
  in_progress: "In progress",
  waiting_approval: "Waiting for approval",
  waiting_parts: "Waiting for parts",
  waiting_payment: "Waiting for payment",
  needs_attention: "Needs attention",
  other: "Other",
};

/**
 * THE METER RAMP — §1.3. One progression from moving to stuck.
 *
 * `#E8C468` and `#4FC3C0` are fills only and never text on light: they are the
 * two that do not reach AA against a white card, which §1.3 states outright.
 * The rule is enforced by using them exclusively as `background` in
 * `ops-tokens.css`; nothing here sets a text colour.
 */
export const METER_SEED_COLOUR: Record<MeterKey, string> = {
  completed: "#0B6E63",
  scheduled: "#0DA1A9",
  in_progress: "#4FC3C0",
  waiting_approval: "#E8C468",
  waiting_parts: "#E0A32E",
  waiting_payment: "#DC7A3C",
  needs_attention: "#C24437",
  other: "#9AAFB2",
};

/**
 * The meters whose work is still in hand — §2.4's "Where work is stuck" reads
 * exactly these four, and the tile ageing readout treats them as open.
 */
export const WAITING_METERS: readonly MeterKey[] = [
  "waiting_approval",
  "waiting_parts",
  "waiting_payment",
  "needs_attention",
];

export function isMeterKey(value: string): value is MeterKey {
  return (METER_KEYS as readonly string[]).includes(value);
}

/** One meter as the workspace has configured it. */
export type MeterDefinition = {
  key: string;
  label: string;
  colour: string;
  sortOrder: number;
  visible: boolean;
  isCatchAll: boolean;
};

/** The seed, for a workspace whose rows have not been read yet. */
export function seedMeterDefinitions(): MeterDefinition[] {
  return METER_KEYS.map((key, index) => ({
    key,
    label: METER_SEED_LABEL[key],
    colour: METER_SEED_COLOUR[key],
    sortOrder: index,
    visible: true,
    isCatchAll: key === CATCH_ALL_METER,
  }));
}

/**
 * WHICH METER A STATUS BELONGS TO.
 *
 * `assignments` is `job_status_map` read as normalised-label → meter key. The
 * lookup is on the NORMALISED label for the same reason every other status
 * comparison in this product is: the stored labels have been through a
 * spreadsheet and a form, so "In Progress" and "in  progress" are one status
 * and an exact-match lookup would put the same work in two buckets.
 *
 * An unknown status, or one whose row carries no `meter_key`, is the catch-all.
 * That is not a fallback for a broken case — it is §2.1's stated behaviour, and
 * it is what lets a status invented tomorrow reconcile today.
 */
export function meterForStatus(
  assignments: ReadonlyMap<string, string>,
  status: string | null | undefined,
): MeterKey {
  const assigned = assignments.get(statusKey(status ?? ""));
  return assigned && isMeterKey(assigned) ? assigned : CATCH_ALL_METER;
}

/** Order a workspace's meters for the bar and the tile grid. */
export function orderMeters(meters: readonly MeterDefinition[]): MeterDefinition[] {
  const rank = new Map<string, number>(METER_KEYS.map((key, index) => [key, index]));
  return [...meters].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99);
  });
}

/* ── Severity, priority and "not recorded" ────────────────────────────────── */

export type SeverityKey = "fresh" | "ageing" | "overdue" | "critical";

/** §1.3's severity ramp, used only where a value is judged good or bad. */
export const SEVERITY_KEYS: readonly SeverityKey[] = ["fresh", "ageing", "overdue", "critical"];

export const SEVERITY_COLOUR: Record<SeverityKey, string> = {
  fresh: "#0DA1A9",
  ageing: "#E0A32E",
  overdue: "#DC7A3C",
  critical: "#C24437",
};

export const SEVERITY_LABEL: Record<SeverityKey, string> = {
  fresh: "Fresh",
  ageing: "Ageing",
  overdue: "Overdue",
  critical: "Critical",
};

export const SEVERITY_RANGE: Record<SeverityKey, string> = {
  fresh: "0–14 days",
  ageing: "15–30 days",
  overdue: "31–60 days",
  critical: "60+ days",
};

/** §5.4 — the priority bar is a severity judgement, so it takes that ramp. */
export const OVERVIEW_PRIORITY_COLOUR: Record<string, string> = {
  urgent: "#C24437",
  medium: "#E0A32E",
  low: "#0DA1A9",
  not_recorded: "#9AAFB2",
};

/**
 * §1.3 — "Not recorded is always #9AAFB2 grey, never a colour that could pass
 * for a real category." Distinct from `job-metrics.ts`'s `NOT_RECORDED_COLOUR`
 * (#64748B), which the Compliance and Sites pages still use; this one belongs
 * to the Overview alone.
 */
export const NOT_RECORDED_INK = "#9AAFB2";

/**
 * NEUTRAL CATEGORICAL DATA — a single-hue teal scale, darkest for the largest.
 *
 * §1.3 retires the hashed eight-colour palette (`CATEGORICAL_COLOURS` in
 * `job-metrics.ts`: gold, cyan, pink, purple) from this page. It "carries no
 * meaning and matches nothing in the brand", and three of its eight collided
 * with the semantic family, priority and ageing colours used elsewhere on the
 * same page — so the reader was invited to learn a colour that meant one thing
 * in the legend and another six inches away.
 *
 * `rank` is 0 for the largest bucket. The scale is stepped rather than
 * interpolated so that two adjacent bars are always distinguishable, and it
 * stops at seven: past that the ranked-bar list is the affordance, not colour.
 */
const TEAL_SCALE = [
  "#075E63",
  "#077E85",
  "#0A929A",
  "#0DA1A9",
  "#35B4BA",
  "#5FC6CB",
  "#8AD8DB",
] as const;

export function tealScale(rank: number): string {
  if (!Number.isFinite(rank) || rank < 0) return TEAL_SCALE[TEAL_SCALE.length - 1];
  return TEAL_SCALE[Math.min(rank, TEAL_SCALE.length - 1)];
}

/* ── The percentage rule ──────────────────────────────────────────────────── */

/**
 * SHARES OF RECORDED VALUES, SUMMING TO 100 AFTER ROUNDING.
 *
 * §1.4, in one function so no card can implement it differently:
 *
 *   · the denominator is the RECORDED total, never the cohort total. A blank
 *     field is excluded from the maths and reported as coverage instead;
 *   · the rounded shares are corrected to sum to exactly 100, by adjusting the
 *     LARGEST slice. Adjusting the smallest is the more common trick and it is
 *     wrong here: a 1-point correction on a 2% slice is a 50% error on that
 *     number, while the same point on a 57% slice is invisible;
 *   · a zero denominator yields zero shares rather than `NaN`, because a
 *     breakdown with nothing recorded still has to draw its legend.
 *
 * Returns integers. §1.4's worked example — `Handyman — 110 · 57% of recorded`
 * — has no decimal place, and a percentage carrying one implies a precision the
 * coverage figure does not support.
 */
export function sharesOfRecorded(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => 0);
  const shares = values.map((value) => Math.round((Math.max(0, value) / total) * 100));
  const drift = 100 - shares.reduce((sum, share) => sum + share, 0);
  if (drift !== 0) {
    let largest = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] > values[largest]) largest = index;
    }
    shares[largest] += drift;
  }
  return shares;
}

/** Coverage, as §1.4 states it in a section header. Never a rounded 100 over a gap. */
export function coverageSentence(label: string, recorded: number, total: number): string {
  if (total <= 0) return `${label} — nothing in this period`;
  const percent = Math.round((recorded / total) * 100);
  const shown = recorded > 0 && recorded < total && percent === 100 ? 99 : percent;
  return `${label} — ${recorded} of ${total} recorded (${shown}%)`;
}

/* ── Cohort wording ───────────────────────────────────────────────────────── */

/**
 * §1.1 — every card header changes wording with the axis, not just its figures.
 * "226 jobs requested in this period" / "226 jobs completed in this period".
 */
export function cohortWording(measure: "requested" | "completed", total: number): string {
  const noun = total === 1 ? "job" : "jobs";
  const verb = measure === "completed" ? "completed" : "requested";
  return `${total} ${noun} ${verb} in this period`;
}

/** The footnote for the rows the axis cannot see. §1.1: never impute a date. */
export function excludedWording(measure: "requested" | "completed", excluded: number): string {
  const noun = excluded === 1 ? "job" : "jobs";
  const field = measure === "completed" ? "completion date" : "request date";
  return `${excluded} ${noun} excluded — no ${field} recorded`;
}

/* ── Ageing ───────────────────────────────────────────────────────────────── */

/** The band a number of days open falls in. Boundaries are §1.3's, inclusive. */
export function severityBand(daysOpen: number): SeverityKey {
  if (!Number.isFinite(daysOpen) || daysOpen <= 14) return "fresh";
  if (daysOpen <= 30) return "ageing";
  if (daysOpen <= 60) return "overdue";
  return "critical";
}
