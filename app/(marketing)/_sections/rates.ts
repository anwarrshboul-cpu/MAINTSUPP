/**
 * THE ONLY PLACE ON THIS SITE THAT HOLDS A NUMBER WITH A PRICE ATTACHED.
 *
 * WHY IT EXISTS. `tests/homepage-v3.test.mjs` has a rule with a good reason
 * behind it: no marketing file except `pricing.tsx` may contain a `£` followed
 * by a digit, because a second typed copy of a rate is a second thing to keep
 * true, and the copy that goes stale is never the one somebody is reading. That
 * rule was written when the pricing section was the only place that quoted a
 * figure.
 *
 * The commercial update needs the "What does it cost?" FAQ to quote the entry
 * rates as well, and needs — in its own words — every figure to agree across
 * "cards, rate-card table, monthly totals, footnotes and the cost FAQ". Typing
 * them into `content.ts` would satisfy the brief and break the rule; leaving
 * them out would satisfy the rule and break the brief.
 *
 * So the numbers move here and BOTH files derive from them. The rule survives
 * intact — still no typed `£<digit>` anywhere but `pricing.tsx`, because a
 * `£${…}` interpolation has no digit after the sign — and it is now enforcing
 * something stronger than it was: not "one file may quote a price" but "one
 * file may KNOW one".
 *
 * There is deliberately no `£` in this file. It holds quantities; the two
 * files that render them own the currency sign, the thousands separator and
 * the sentence around it.
 */

/** A rate column. `compliance` is a rate, not a plan — see `pricing.tsx`. */
export type RateKey = "essential" | "compliance" | "complete";

/**
 * The four portfolio bands, at the approved rates, per store per month.
 *
 * `null` in the top band means "Book a Portfolio Review". It is `null` rather
 * than 0 or a sentinel string so that anything printing a figure has to handle
 * its absence in the type system rather than by remembering to.
 *
 * COMPLETE IS EXACTLY 15 BELOW BUYING THE OTHER TWO SEPARATELY, at every band
 * that carries numbers: 60+55-100, 56+51-92, 52+47-84. The badge on the card
 * derives that subtraction rather than stating it, so the two cannot drift
 * apart — and `tests/stage-twentyeight-landing-rebuild.test.mjs` recomputes it
 * from this table and fails if any band breaks the pattern.
 */
export const BANDS = [
  { id: "b5", label: "5–10 stores", min: 5, max: 10, essential: 60, compliance: 55, complete: 100 },
  { id: "b11", label: "11–25 stores", min: 11, max: 25, essential: 56, compliance: 51, complete: 92 },
  { id: "b26", label: "26–50 stores", min: 26, max: 50, essential: 52, compliance: 47, complete: 84 },
  {
    id: "b51",
    label: "51+ stores",
    min: 51,
    max: Infinity,
    essential: null,
    compliance: null,
    complete: null,
  },
] as const;

export type Band = (typeof BANDS)[number];

/** The band every "from" price and every struck-through comparison is against. */
export const ENTRY_BAND = BANDS[0];

/** The band a portfolio of `count` stores falls in. */
export function bandForCount(count: number): Band {
  return BANDS.find((entry) => count <= entry.max) ?? BANDS[BANDS.length - 1];
}

/*
 * The calculator's range. It opens at the bottom of the bottom band and reaches
 * past the top one, so a reader with sixty stores arrives at "Book a Portfolio
 * Review" by dragging rather than by reading a footnote.
 *
 * FIVE IS THE FLOOR, not a default. Maintsupp coordinates portfolios of five
 * sites and above, the enquiry form says so, and an FAQ says so — the slider
 * must not be able to describe a portfolio the business will not take.
 */
export const SLIDER_MIN = 5;
export const SLIDER_MAX = 60;

/** The smallest portfolio the business accepts, in sites. */
export const MINIMUM_SITES = 5;

/* Everything the footnotes quote, once each. */
export const PORTFOLIO_MINIMUM = 300;
export const INCLUDED_JOBS = 4;
export const ADDITIONAL_JOB = 50;
export const ONBOARDING_PER_STORE = 75;
export const ONBOARDING_CAP = 1200;
export const OUT_OF_HOURS_P1 = 95;
export const PROJECT_PERCENT = 12;
export const PROJECT_MINIMUM = 350;

/**
 * The published minimum and the entry rate cannot contradict each other.
 *
 * §10.3 of the brief: "The stated minimum (£300) equals 5 × the Essential entry
 * rate (£60). No contradiction between calculator readout and any footnote."
 * Asserted here rather than in a test alone, because the failure it prevents is
 * a reader doing the multiplication themselves and finding the page wrong.
 */
if (ENTRY_BAND.essential * MINIMUM_SITES !== PORTFOLIO_MINIMUM) {
  throw new Error(
    `Portfolio minimum ${PORTFOLIO_MINIMUM} does not equal ${MINIMUM_SITES} x the entry rate ${ENTRY_BAND.essential}`,
  );
}
