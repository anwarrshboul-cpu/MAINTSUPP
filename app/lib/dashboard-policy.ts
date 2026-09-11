/**
 * THE DASHBOARD BLOCKS' POLICY NUMBERS — every threshold, in one place.
 *
 * The three dashboard blocks (Overview, Compliance, Reports) colour their
 * gauges by thresholds, and each brief says the same thing about them:
 * "Thresholds are config values, not hardcoded in the component." A number
 * such as "an SLA gauge turns amber below 90%" is a POLICY — the point at which
 * somebody decides service is acceptable — and a policy written as `>= 90`
 * inside a JSX expression is one nobody can find on the day it changes.
 *
 * This product keeps its analytic policy numbers as named constants in `app/lib`
 * — `EXPIRY_DUE_SOON_DAYS` in `expiry-status.ts` set the pattern, with its
 * reasoning written beside it — so that is what this module is: the one file to
 * edit, read by the server (which echoes the values in each payload) and by the
 * components (which never type a threshold of their own). The compliance
 * warning window has since become an organisation setting as its brief asks
 * (`compliance-policy.ts`, default 90); these gauge thresholds remain product
 * policy.
 *
 * It imports NOTHING. The components that read it are client components and
 * must not reach drizzle, and `node --test` loads it directly.
 */

/** A quality percentage where HIGHER is better: teal ≥ good, amber ≥ warn, red below. */
export type HigherIsBetter = { readonly good: number; readonly warn: number };

/** A rate where LOWER is better: teal ≤ good, amber ≤ warn, red above. */
export type LowerIsBetter = { readonly good: number; readonly warn: number };

/**
 * The Overview's SLA speedometer and compliance gauge, and the Compliance
 * block's "Sites fully compliant" speedometer.
 *
 * ≥ 90 good, 75–89 warning, < 75 poor — the figures all three briefs state.
 * One constant rather than three, because the Overview's compliance gauge and
 * the Compliance block's gauges describe the same estate and must never colour
 * the same percentage two different ways.
 */
export const QUALITY_ARC: HigherIsBetter = { good: 90, warn: 75 };

/**
 * The Reports block's repeat-rate speedometer. LOWER IS BETTER: a repeat rate
 * of 8% is healthy, 15% needs a look, 25% means work is not being fixed.
 * ≤ 10 good, 10–20 warning, > 20 poor, per the Reports brief §4.
 */
export const REPEAT_RATE_ARC: LowerIsBetter = { good: 10, warn: 20 };

/**
 * The Overview's "SLA Compliance by Priority Tier" bars: the share of open jobs
 * within SLA, against the brief's 95% target line. At or above the target is
 * good, 80–94 a warning, below 80 poor. The server draws its target marker
 * from `good`, so the line and the colours cannot disagree.
 */
export const SLA_TARGET_ARC: HigherIsBetter = { good: 95, warn: 80 };

export type ArcTone = "good" | "warn" | "poor";

/** Where a higher-is-better percentage falls. */
export function qualityTone(percent: number, policy: HigherIsBetter = QUALITY_ARC): ArcTone {
  const value = Number.isFinite(percent) ? percent : 0;
  if (value >= policy.good) return "good";
  if (value >= policy.warn) return "warn";
  return "poor";
}

/** Where a lower-is-better rate falls. */
export function rateTone(percent: number, policy: LowerIsBetter = REPEAT_RATE_ARC): ArcTone {
  const value = Number.isFinite(percent) ? percent : 0;
  if (value <= policy.good) return "good";
  if (value <= policy.warn) return "warn";
  return "poor";
}
