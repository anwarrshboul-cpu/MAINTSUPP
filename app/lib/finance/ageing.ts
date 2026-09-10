/**
 * §9's AGED DEBTORS AND AGED CREDITORS — one function, both directions.
 *
 * "Aged debtors (owed to you) and aged creditors (owed by you), both bucketed
 * Current / 1–30 / 31–60 / 61–90 / 90+, by counterparty, with drill-down to the
 * invoices."
 *
 * ── WHY THIS FILE IMPORTS NOTHING BUT `./rules` ────────────────────────────
 *
 * The same reason `app/lib/finance/model.ts` gives at length: a module that
 * reaches drizzle cannot be loaded by `node --test`, so the decisions worth
 * arguing about are kept where a test can CALL them. The SQL that feeds this
 * lives in `app/api/finance/ageing/route.ts` and it reuses
 * `invoiceBalances()` from `./balance` — there is no second implementation of a
 * balance in this module, and §6 would not survive one.
 *
 * ── THE BUCKET IS `ageingFor`'s, NEVER A SECOND LADDER ─────────────────────
 *
 * `ageingFor` in `./rules.ts` already decides which of §9's five an invoice is
 * in, and its boundaries are documented there to the day. This file only ADDS
 * UP; it never re-decides. A second set of boundaries is how an aged-debtor
 * report and an invoice's own badge come to disagree about the same row.
 *
 * ── WEIGHTED BY BALANCE, NEVER COUNTED BY ROW ──────────────────────────────
 *
 * `ageingFor`'s note states the rule and this is where it is kept: a paid
 * invoice still has a real due date and still has a bucket, and what makes it
 * contribute nothing is that its BALANCE is zero. Rows at or below zero are
 * dropped entirely rather than added as zeroes, so a counterparty who owes
 * nothing does not appear on a report of who owes you money.
 */

import { AGEING_BUCKETS, ageingFor, type AgeingBucket } from "./rules";

export { AGEING_BUCKETS, type AgeingBucket };

/** One invoice, as the ageing report needs it. */
export interface AgeingInput {
  invoiceId: string;
  /** `invoices.counterparty_id`, or null where only a name was recorded. */
  counterpartyId: string | null;
  counterpartyName: string | null;
  /** `YYYY-MM-DD`, or null. A missing due date is `current` — see `ageingFor`. */
  dueDay: string | null;
  /** What is still outstanding. `gross − paid − credited`, from `./balance`. */
  balancePence: number;
  internalRef?: string | null;
  invoiceNumber?: string | null;
}

/** §9's five columns for one counterparty, plus the row total. */
export interface AgeingCounterparty {
  /** A stable grouping key: the id where there is one, `name:…` otherwise. */
  id: string;
  name: string;
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  b90: number;
  totalPence: number;
  invoiceCount: number;
  /** The invoice ids behind this row, so the UI can drill down without a second query. */
  invoiceIds: string[];
}

export type AgeingTotals = Omit<AgeingCounterparty, "id" | "name" | "invoiceIds">;

export interface AgeingReport {
  buckets: readonly AgeingBucket[];
  counterparties: AgeingCounterparty[];
  totals: AgeingTotals;
}

/** The JSON key each §9 bucket is reported under. */
const BUCKET_FIELD: Record<AgeingBucket, keyof AgeingTotals> = {
  current: "current",
  "1-30": "b1_30",
  "31-60": "b31_60",
  "61-90": "b61_90",
  "90+": "b90",
};

/**
 * The aged report for one direction.
 *
 * Sorted by the OLDEST money first — 90+, then 61–90, and so on — because the
 * question an aged-creditor report answers is "who has been waiting longest",
 * and a list sorted by total puts a large current balance above a small
 * ninety-day one. Ties fall back to the total and then to the name, so the
 * order is stable across two calls with the same data.
 */
export function ageingReport(rows: readonly AgeingInput[], todayDay: string): AgeingReport {
  const byCounterparty = new Map<string, AgeingCounterparty>();
  const totals = emptyTotals();

  for (const row of rows) {
    const balancePence = Math.trunc(row.balancePence || 0);
    /* Settled and over-paid rows contribute nothing. An over-payment is a real
       event and `invoiceBalance` reports it, but subtracting it here would
       reduce somebody's arrears with a credit that is not on their account. */
    if (balancePence <= 0) continue;

    const key = groupKey(row.counterpartyId, row.counterpartyName);
    let entry = byCounterparty.get(key);
    if (!entry) {
      entry = {
        id: key,
        name: (row.counterpartyName ?? "").trim() || "Unnamed counterparty",
        ...emptyTotals(),
        invoiceIds: [],
      };
      byCounterparty.set(key, entry);
    }

    const field = BUCKET_FIELD[ageingFor(row.dueDay, todayDay).ageingBucket];
    entry[field] += balancePence;
    entry.totalPence += balancePence;
    entry.invoiceCount += 1;
    entry.invoiceIds.push(row.invoiceId);

    totals[field] += balancePence;
    totals.totalPence += balancePence;
    totals.invoiceCount += 1;
  }

  const counterparties = [...byCounterparty.values()].sort(
    (a, b) =>
      b.b90 - a.b90
      || b.b61_90 - a.b61_90
      || b.b31_60 - a.b31_60
      || b.b1_30 - a.b1_30
      || b.totalPence - a.totalPence
      || a.name.localeCompare(b.name),
  );

  return { buckets: AGEING_BUCKETS, counterparties, totals };
}

/**
 * One counterparty, as one key.
 *
 * The id when there is one, because two suppliers may share a trading name and
 * a report that folded them together would send the wrong person a statement.
 * The NAME is the fallback and it is normalised — these names have been through
 * a CSV and a human, so "ACME Ltd" and "acme ltd " are one supplier.
 *
 * Deliberately NOT `counterpartyKey` from `./rules.ts`: that one exists to
 * decide whether two invoices duplicate each other and folds punctuation out of
 * a supplier REFERENCE. Reusing it here would make the grouping key of a report
 * move whenever the duplicate rule was tuned.
 */
export function groupKey(
  counterpartyId: string | null | undefined,
  counterpartyName: string | null | undefined,
): string {
  const id = (counterpartyId ?? "").trim();
  if (id) return id;
  const name = (counterpartyName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return name ? `name:${name}` : "name:unnamed";
}

function emptyTotals(): AgeingTotals {
  return {
    current: 0,
    b1_30: 0,
    b31_60: 0,
    b61_90: 0,
    b90: 0,
    totalPence: 0,
    invoiceCount: 0,
  };
}
