/**
 * MONEY — the one place a number becomes pence, and the one rounding rule.
 *
 * Types only above this file (`contract.ts`); arithmetic only in it. Nothing
 * here imports anything, which is deliberate: the invoice arithmetic is the
 * part of this feature a client will check with a calculator, so it has to be
 * callable from `node --test` without a database, a component or a bundler.
 *
 * ── THE ONE CONVERSION BOUNDARY ────────────────────────────────────────────
 *
 * Existing job cost lives in `maintenance_requests.cost` as a SQLite REAL, in
 * POUNDS. Everything this feature computes is INTEGER PENCE. `poundsToPence`
 * below is the only function allowed to cross that boundary, and every caller
 * goes through it — so a job costing 1.005 is worth the same 101p wherever it
 * is added up, and the Excel export cannot disagree with the PDF because one
 * of them multiplied by 100 itself.
 *
 * The conversion is NOT a bare `value * 100`. Binary floats cannot hold 12.34,
 * so `12.34 * 100` is 1233.9999999999998 and `1.005 * 100` is
 * 100.49999999999999 — the second of which rounds DOWN to 100p, losing a penny
 * on exactly the values a person would check by hand. Fixing the
 * representation first (`toFixed(4)`) and rounding after is what makes
 * 1.005 -> 101p, which is the answer a calculator gives.
 *
 * ── THE ROUNDING RULE, STATED ONCE ─────────────────────────────────────────
 *
 * HALF AWAY FROM ZERO, applied to whole pence.
 *
 * `Math.round` alone is half-UP, which is not symmetric: it sends -0.5 to -0
 * and +0.5 to +1. A credit line is a negative amount, so an asymmetric rule
 * would round a credit and the charge it reverses to different absolute
 * values, and a credit note for the exact amount of an invoice would not clear
 * it. Rounding the magnitude and restoring the sign is symmetric by
 * construction.
 *
 * ── WHY VAT IS ROUNDED PER LINE, NOT ON THE SUBTOTAL ───────────────────────
 *
 * `InvoiceTotals.vatPence` is the SUM of `BillableSiteLine.lineVatPence`, and
 * each line's VAT is rounded when it is computed. Rounding the subtotal
 * instead would be a penny or two different, and then a reader adding the line
 * totals in the Excel export would not get the invoice total printed on the
 * PDF. The exporters render one payload, so the payload has to be internally
 * consistent: lines must sum to the totals exactly, and this is the rule that
 * makes them.
 */

import type { Pence } from "./contract";

/**
 * Whole pence, half away from zero. The only rounding this feature performs.
 *
 * A non-finite input is 0 rather than NaN: a NaN in one line would poison
 * every total downstream and print "£NaN" on a client document, where a zero
 * is at least a number a validator can notice is wrong.
 */
export function roundPence(value: number): Pence {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value));
}

/**
 * Pounds (a REAL, as `maintenance_requests.cost` stores it) to integer pence.
 *
 * THE conversion boundary. See the header for why the `toFixed` is not
 * decoration. Null, undefined and NaN resolve to null rather than to zero,
 * because "no cost recorded" and "cost recorded as zero" are different facts
 * and the data-quality section reports the first one.
 */
export function poundsToPence(pounds: number | null | undefined): Pence | null {
  if (pounds === null || pounds === undefined) return null;
  if (typeof pounds !== "number" || !Number.isFinite(pounds)) return null;
  return roundPence(Number((pounds * 100).toFixed(4)));
}

/** `poundsToPence`, with a missing or invalid cost read as zero for a total. */
export function poundsToPenceOrZero(pounds: number | null | undefined): Pence {
  return poundsToPence(pounds) ?? 0;
}

/** Integer pence back to pounds, for the two places a REAL column is written. */
export function penceToPounds(pence: Pence): number {
  return Number((pence / 100).toFixed(2));
}

/**
 * VAT on an amount, from a basis-point rate. 20% is 2000, not 0.2 and not 20.
 *
 * Basis points because a percentage stored as a float reintroduces exactly the
 * problem `poundsToPence` exists to remove, and because 17.5% — a rate this
 * country used for seventeen years — is not expressible as a whole percent.
 */
export function vatOnPence(amountPence: Pence, rateBasisPoints: number): Pence {
  if (!Number.isFinite(rateBasisPoints) || rateBasisPoints <= 0) return 0;
  return roundPence((amountPence * rateBasisPoints) / 10_000);
}

/** Sum, with every non-finite entry treated as zero rather than poisoning it. */
export function sumPence(values: Iterable<Pence | null | undefined>): Pence {
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
  }
  return Math.trunc(total);
}

/**
 * The mean, rounded once. Zero sites is 0 rather than NaN.
 *
 * Only ever shown as "Average Site Fee", and only when `singleFeePence` is
 * null — see `InvoiceTotals` in the contract for why the payload decides which
 * of the two the card shows rather than leaving it to a renderer.
 */
export function averagePence(total: Pence, count: number): Pence {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return roundPence(total / count);
}

/**
 * Whether every value in the list is the same — what makes a fee "fixed".
 *
 * An empty list is NOT single: an invoice with no included lines has no fixed
 * fee to state, and claiming one would put a confident number on an empty
 * document.
 */
export function singleValue(values: readonly Pence[]): Pence | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}
