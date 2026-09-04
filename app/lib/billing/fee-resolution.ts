/**
 * WHAT A SITE COSTS FOR A PERIOD — three levels, and the date they were true.
 *
 * ── THE HIERARCHY, IN STRICT ORDER ─────────────────────────────────────────
 *
 *   1. a valid SITE OVERRIDE     (`site_fee_overrides`)
 *   2. a valid CLIENT FEE        (`client_site_fees`)
 *   3. the ORGANISATION DEFAULT  (`billing_settings.default_site_fee_pence`)
 *
 * The first level that resolves wins and the line records WHICH — `feeSource`
 * on `BillableSiteLine` — so a reader looking at two sites in one invoice
 * carrying different money can see why without opening the settings screen.
 *
 * If none resolves the line gets `feeSource: null`, a BLOCKING validation, and
 * finalisation is refused. There is deliberately no fallback of zero: an
 * invoice line for £0.00 looks like a decision somebody made, and it would be
 * indistinguishable from a site legitimately billed at nothing.
 *
 * ── WHY "VALID" MEANS COVERS, NOT OVERLAPS ────────────────────────────────
 *
 * A fee row is valid for a period when its effective window CONTAINS the whole
 * period. An open end (null) is unbounded in that direction, which is how a
 * current fee is stored — a rise closes the old row with an `effective_to` and
 * opens a new one, so an invoice raised for March in June still prices at
 * March's fee. That is the requirement, and containment is what delivers it.
 *
 * A row that merely OVERLAPS the period — a fee that changed on the 14th — is
 * NOT valid, and this module says so distinctly rather than reporting a bare
 * "no fee found". The two are different facts and lead to different fixes: one
 * needs a fee configured, the other needs a decision about which of two fees
 * the period is charged at, which is a commercial question and not one an
 * algorithm gets to answer by averaging.
 *
 * ── ISO DATES COMPARE AS STRINGS ───────────────────────────────────────────
 *
 * Every date here is `YYYY-MM-DD`, so `<` and `>` on the strings are the
 * calendar comparison, exactly. No `Date` is constructed and no timezone is
 * consulted, which is why this module has no runtime imports at all and can be
 * transpiled and called on its own from `node --test`.
 */

import type { FeeSource, IsoDate, Pence } from "../reporting/contract";
import type { FeeRecord } from "../reporting/inputs";

export interface FeePeriod {
  start: IsoDate;
  end: IsoDate;
}

export interface ResolvedFee {
  feePence: Pence;
  source: FeeSource;
  /** Null for the organisation default, which is a settings field, not a row. */
  recordId: string | null;
}

export interface FeeResolution {
  resolved: ResolvedFee | null;
  /**
   * Rows that touch the period without covering it. Non-empty only when
   * `resolved` is null or came from a lower level — it is the evidence behind
   * the "the fee changed inside this period" validation.
   */
  partialCover: FeeRecord[];
}

/** The window contains the whole period. An open end is unbounded. */
export function feeCoversPeriod(record: FeeRecord, period: FeePeriod): boolean {
  if (record.effectiveFrom && record.effectiveFrom > period.start) return false;
  if (record.effectiveTo && record.effectiveTo < period.end) return false;
  return true;
}

/** The window touches the period at all. */
export function feeTouchesPeriod(record: FeeRecord, period: FeePeriod): boolean {
  if (record.effectiveFrom && record.effectiveFrom > period.end) return false;
  if (record.effectiveTo && record.effectiveTo < period.start) return false;
  return true;
}

/**
 * The row that wins when more than one at the same level is valid.
 *
 * The latest `effective_from` — the most recently agreed price — and, when two
 * rows start on the same day (or both start unbounded), the one whose id sorts
 * last. The tie-break is arbitrary and is there so the answer is the SAME on
 * every run: a report that prices a site at £120 today and £140 tomorrow
 * because two rows were compared in whatever order the database returned them
 * is worse than a wrong price, because nobody can reproduce it.
 */
function mostRecent(records: readonly FeeRecord[]): FeeRecord | null {
  let winner: FeeRecord | null = null;
  for (const record of records) {
    if (!winner) {
      winner = record;
      continue;
    }
    const a = record.effectiveFrom ?? "";
    const b = winner.effectiveFrom ?? "";
    if (a > b || (a === b && record.id > winner.id)) winner = record;
  }
  return winner;
}

/**
 * The fee for one site over one period, and the evidence for it.
 *
 * `overrides` must already be narrowed to this site; `clientFees` are the
 * organisation's. Neither list is required to be sorted or deduplicated.
 */
export function resolveSiteFee(input: {
  overrides: readonly FeeRecord[];
  clientFees: readonly FeeRecord[];
  defaultFeePence: Pence | null;
  period: FeePeriod;
}): FeeResolution {
  const partialCover: FeeRecord[] = [];

  const validOverrides = input.overrides.filter((record) => feeCoversPeriod(record, input.period));
  const winningOverride = mostRecent(validOverrides);
  if (winningOverride) {
    return {
      resolved: {
        feePence: winningOverride.feePence,
        source: "Site override",
        recordId: winningOverride.id,
      },
      partialCover,
    };
  }
  partialCover.push(
    ...input.overrides.filter(
      (record) => feeTouchesPeriod(record, input.period) && !feeCoversPeriod(record, input.period),
    ),
  );

  const validClientFees = input.clientFees.filter((record) => feeCoversPeriod(record, input.period));
  const winningClientFee = mostRecent(validClientFees);
  if (winningClientFee) {
    return {
      resolved: {
        feePence: winningClientFee.feePence,
        source: "Client fee",
        recordId: winningClientFee.id,
      },
      partialCover,
    };
  }
  partialCover.push(
    ...input.clientFees.filter(
      (record) => feeTouchesPeriod(record, input.period) && !feeCoversPeriod(record, input.period),
    ),
  );

  if (typeof input.defaultFeePence === "number") {
    return {
      resolved: {
        feePence: input.defaultFeePence,
        source: "Organisation default",
        recordId: null,
      },
      partialCover,
    };
  }

  return { resolved: null, partialCover };
}
