/**
 * THE SITE NO LONGER PUBLISHES A PRICE — and this file is where that is recorded.
 *
 * WHAT IT HELD. Until 2026-11-25 this was the only place on the site that held a
 * number with a price attached: four portfolio bands of per-store monthly
 * rates, the portfolio minimum, the onboarding fee, the out-of-hours fee and
 * the project percentage. `pricing.tsx`, the cost FAQ and `/pricing` all
 * derived from it, so that no two of them could disagree.
 *
 * WHAT CHANGED, AND WHO DECIDED IT. The owner withdrew the published monthly
 * plans (decided 2026-11-19, released 2026-11-25). Nobody was buying the
 * subscription; the outreach that sends people to this site promises "no
 * subscription"; and the buyer the site is now written for is a single shop or
 * kiosk that wants one job done. So every job is priced individually and the
 * price is confirmed before work starts. A managed monthly plan still exists
 * for portfolios, but it is arranged on request and its rates are not printed.
 *
 * WHY THE FILE STAYS. Two reasons.
 *
 * First, the rule it was created to keep is now stronger, not gone.
 * `tests/homepage-v3.test.mjs` forbids a pound sign followed by a digit in the
 * marketing tree. `pricing.tsx` used to be the one exception; there is no
 * exception any more. `CONTENT_RULES` in `app/lib/cms-blocks.ts` sends staff
 * here when a typed price is refused, and this header is the answer they need:
 * prices are not published, so there is nothing to type.
 *
 * Second, one number with a commercial meaning is still stated on the site:
 * the size of portfolio the managed plan starts at. It lives here so that the
 * pricing section, the FAQ, the landing pages and the organisation's structured
 * data cannot come to say different things, and the enquiry form's size ranges
 * are tested against it.
 *
 * IF PRICES ARE EVER PUBLISHED AGAIN they come back HERE first, as quantities
 * with no currency sign, and everything that prints one derives it. A second
 * typed copy of a rate is a second thing to keep true, and the copy that goes
 * stale is never the one somebody is reading.
 */

/** The smallest portfolio the managed monthly plan is offered to, in sites. */
export const MANAGED_PLAN_MINIMUM_SITES = 5;

/**
 * The counts the copy spells out in words.
 *
 * The FAQ says "five sites", not "5", and interpolating the constant is what
 * keeps that sentence from becoming a second typed copy of the figure.
 *
 * Deliberately a tiny map rather than a general number-to-words function: only
 * a handful of small values are ever spelled out on this site, and a general
 * one would be forty lines of code nobody reads to serve two callers.
 */
const WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
};

/** A small count as the word for it, or the numeral when it is not small. */
export function inWords(value: number): string {
  return WORDS[value] ?? String(value);
}

/**
 * THE FOUR SENTENCES THE WHOLE SITE AGREES ON.
 *
 * They are the commercial terms a reader is being offered, so they are written
 * once. The pricing section, the cost FAQ, `/pricing` and the London landing
 * pages all quote these rather than restate them, for the same reason the
 * rates used to be derived: the call-out line in particular is a promise about
 * money, and two wordings of a promise are two promises.
 *
 * `callOut` is the owner's chosen form (2026-11-25): free WITH the repair, not
 * free unconditionally, because a contractor who attends and repairs nothing
 * still has to be paid. `noRepairVisit` is the other half of the same decision
 * and is quoted beside it every time: `tests/homepage-commercial-update.test.mjs`
 * counts the two in every file and fails when one appears without the other.
 */
export const TERMS = {
  perJob: "Every job is priced individually, and you have the price before any work is booked.",
  callOut: "No call-out charge when we carry out the repair.",
  noRepairVisit: "A visit with no repair to follow is priced before anyone attends.",
  managedPlan: `A managed monthly plan is available on request for portfolios of ${inWords(MANAGED_PLAN_MINIMUM_SITES)} sites and above.`,
} as const;
