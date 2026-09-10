/**
 * THE ONLY THING IN THIS PRODUCT ALLOWED TO ANSWER "WHAT IS OUTSTANDING?".
 *
 * §6: "Never store a balance field — always compute it. A stored balance drifts
 * and then no one trusts the ledger." There is no balance column anywhere in
 * the Module 5 schema and there is no second implementation of this arithmetic;
 * `db/schema.ts` says so at the head of its Module 5 block and this file is the
 * other half of that promise.
 *
 * ── THREE QUERIES, NEVER N+1 ───────────────────────────────────────────────
 *
 * One read of the invoices, one aggregate over `payment_alloc`, one aggregate
 * over `credit_notes` — whether the caller asked about one invoice or four
 * hundred. A ledger page that issued a query per row would be the same defect
 * the Overview was rebuilt to remove (`app/lib/dashboard-aggregates.ts`), on a
 * table that grows every month rather than one that is already large.
 *
 * The id lists are chunked at `SQL_VARIABLE_CHUNK` (90). D1's variable cap is
 * about a hundred per statement, and an IN-list of four hundred invoice ids is
 * the exact shape that trips it — see `app/lib/sql-batching.ts`.
 *
 * ── DAY ARITHMETIC HAPPENS HERE, NOT IN SQL ────────────────────────────────
 *
 * `db/sqlite-to-postgres.ts` refuses `julianday(` by name and no expression
 * computes a day difference in both dialects, so the ageing bucket is decided
 * in JavaScript from a single server `now` passed in by the caller. What comes
 * back from SQL is the due date as TEXT, through `dateText()` — which is not
 * optional: Production's date columns are real Postgres `date`s and
 * `trim(date)` throws `function pg_catalog.btrim(date) does not exist`, a fault
 * that cannot appear locally because Miniflare declares the same column TEXT.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import { creditNotes, invoices, paymentAllocations } from "../../../db/schema";
import { dateText } from "../dashboard-aggregates";
import { selectInChunks } from "../sql-batching";
import { dayOf, financeDay, type InvoiceDirection } from "./model";
import { ageingFor, invoiceBalance, signedForCashPosition, type AgeingBucket } from "./rules";

type Database = Awaited<ReturnType<typeof getDb>>;

/* The pure half lives in `./rules.ts` so the test suite can call it — see the
   header there. Re-exported so that "balance.ts answers the balance" stays true
   for every consumer, whichever half of it they need. */
export {
  ageingFor,
  invoiceBalance,
  signedForCashPosition,
  AGEING_BUCKETS,
  type AgeingBucket,
  type InvoiceBalance,
} from "./rules";

export interface InvoiceBalanceSummary {
  invoiceId: string;
  direction: InvoiceDirection;
  currency: string;
  grossPence: number;
  paidPence: number;
  creditedPence: number;
  balancePence: number;
  overpaidPence: number;
  settled: boolean;
  /** `YYYY-MM-DD`, or null where the invoice carries no due date. */
  dueDay: string | null;
  ageingBucket: AgeingBucket;
  daysOverdue: number;
  /** Positive for a receivable, negative for a payable. §9's net position. */
  cashPositionPence: number;
}

export interface BalanceOptions {
  /**
   * The server instant every ageing bucket in this batch is measured against.
   *
   * One clock read per request, passed down, so that four hundred invoices on
   * one page cannot straddle midnight and land in two different buckets for the
   * same due date.
   */
  now?: Date;
}

/**
 * Per-invoice balances and ageing for a set of invoice ids.
 *
 * Every statement filters on `organisationId` from the caller's `scopedDb`
 * handle. An id belonging to another workspace simply does not come back — it
 * is absent from the map rather than refused, which is the same answer the
 * caller would get for an id that does not exist, and is deliberately
 * indistinguishable from it.
 */
export async function invoiceBalances(
  db: Database,
  organisationId: string,
  invoiceIds: readonly string[],
  options: BalanceOptions = {},
): Promise<Map<string, InvoiceBalanceSummary>> {
  const ids = [...new Set(invoiceIds.filter((id) => typeof id === "string" && id.length > 0))];
  const summaries = new Map<string, InvoiceBalanceSummary>();
  if (ids.length === 0) return summaries;

  const todayDay = financeDay(options.now ?? new Date());

  const headers = await selectInChunks(ids, (chunk) =>
    db
      .select({
        id: invoices.id,
        direction: invoices.direction,
        currency: invoices.currency,
        grossPence: invoices.grossPence,
        netPence: invoices.netPence,
        /* `dateText` returns a bare `SQL`, so the select needs the type said
           out loud — otherwise the column arrives as `unknown` and `dayOf` cannot
           read it. */
        dueAt: sql<string | null>`${dateText(invoices.dueAt)}`,
      })
      .from(invoices)
      .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, chunk))),
  );

  const paid = await sumByInvoice(
    ids,
    (chunk) =>
      db
        .select({
          invoiceId: paymentAllocations.invoiceId,
          total: sql<number | string>`coalesce(sum(${paymentAllocations.amountPence}), 0)`,
        })
        .from(paymentAllocations)
        .where(
          and(
            eq(paymentAllocations.organisationId, organisationId),
            inArray(paymentAllocations.invoiceId, chunk),
          ),
        )
        .groupBy(paymentAllocations.invoiceId),
  );

  const credited = await sumByInvoice(
    ids,
    (chunk) =>
      db
        .select({
          invoiceId: creditNotes.invoiceId,
          total: sql<number | string>`coalesce(sum(${creditNotes.amountPence}), 0)`,
        })
        .from(creditNotes)
        .where(
          and(eq(creditNotes.organisationId, organisationId), inArray(creditNotes.invoiceId, chunk)),
        )
        .groupBy(creditNotes.invoiceId),
  );

  for (const header of headers) {
    const direction: InvoiceDirection = header.direction === "receivable" ? "receivable" : "payable";
    /*
     * GROSS, falling back to NET where no gross was recorded.
     *
     * A balance is what is owed, and what is owed is the gross — VAT included,
     * because the counterparty is invoiced for it whether or not it is
     * reclaimable. Rows typed before a VAT figure existed carry only a net, and
     * treating those as zero would report a settled invoice that has never been
     * paid. Falling back is visible in the totals; silently zeroing is not.
     */
    const grossPence = header.grossPence ?? header.netPence ?? 0;
    const balance = invoiceBalance({
      grossPence,
      paidPence: paid.get(header.id) ?? 0,
      creditedPence: credited.get(header.id) ?? 0,
    });
    const dueDay = dayOf(header.dueAt);
    const ageing = ageingFor(dueDay, todayDay);
    summaries.set(header.id, {
      invoiceId: header.id,
      direction,
      currency: header.currency ?? "GBP",
      ...balance,
      dueDay,
      ...ageing,
      cashPositionPence: signedForCashPosition(direction, balance.balancePence),
    });
  }

  return summaries;
}

/** One invoice's balance, or null where it does not belong to this workspace. */
export async function invoiceBalanceFor(
  db: Database,
  organisationId: string,
  invoiceId: string,
  options: BalanceOptions = {},
): Promise<InvoiceBalanceSummary | null> {
  const map = await invoiceBalances(db, organisationId, [invoiceId], options);
  return map.get(invoiceId) ?? null;
}

/**
 * §9's cash position, from a set of already-computed balances.
 *
 * Pure, and deliberately fed rather than querying: the landing page has the
 * balances in hand from the list it just drew, and a second pass over the
 * database to add up numbers already in memory is how two cards on one screen
 * come to disagree.
 */
export interface CashPosition {
  receivableOutstandingPence: number;
  receivableOverduePence: number;
  payableOutstandingPence: number;
  payableOverduePence: number;
  netPositionPence: number;
  dueNext7Pence: { in: number; out: number };
  dueNext14Pence: { in: number; out: number };
  dueNext30Pence: { in: number; out: number };
}

export function cashPosition(
  summaries: Iterable<InvoiceBalanceSummary>,
  now: Date = new Date(),
): CashPosition {
  const today = financeDay(now);
  const position: CashPosition = {
    receivableOutstandingPence: 0,
    receivableOverduePence: 0,
    payableOutstandingPence: 0,
    payableOverduePence: 0,
    netPositionPence: 0,
    dueNext7Pence: { in: 0, out: 0 },
    dueNext14Pence: { in: 0, out: 0 },
    dueNext30Pence: { in: 0, out: 0 },
  };

  for (const summary of summaries) {
    /* A settled invoice contributes nothing, which falls out of the arithmetic
       rather than needing a filter: its balance is zero. An OVER-paid one is
       skipped explicitly, because a negative balance would otherwise reduce the
       outstanding total and hide the over-payment inside it. */
    if (summary.balancePence <= 0) continue;
    const receivable = summary.direction === "receivable";
    if (receivable) {
      position.receivableOutstandingPence += summary.balancePence;
      if (summary.daysOverdue > 0) position.receivableOverduePence += summary.balancePence;
    } else {
      position.payableOutstandingPence += summary.balancePence;
      if (summary.daysOverdue > 0) position.payableOverduePence += summary.balancePence;
    }
    position.netPositionPence += summary.cashPositionPence;

    if (!summary.dueDay || summary.dueDay < today) continue;
    const horizon = daysAhead(today, summary.dueDay);
    const side = receivable ? "in" : "out";
    if (horizon <= 7) position.dueNext7Pence[side] += summary.balancePence;
    if (horizon <= 14) position.dueNext14Pence[side] += summary.balancePence;
    if (horizon <= 30) position.dueNext30Pence[side] += summary.balancePence;
  }

  return position;
}

function daysAhead(today: string, day: string): number {
  const [ty, tm, td] = today.split("-").map(Number);
  const [dy, dm, dd] = day.split("-").map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/**
 * One `GROUP BY` per source table, chunked, collapsed into a map.
 *
 * `sum()` comes back as a STRING from node-pg — `numeric` and `bigint` both do —
 * and as a number from D1. Coercing here is the difference between adding
 * "1200" to a balance and adding 1200, and the failure only ever appears
 * deployed, which is the class of bug `db/node-pg-d1.ts` exists to absorb.
 */
async function sumByInvoice(
  ids: readonly string[],
  query: (chunk: string[]) => Promise<Array<{ invoiceId: string; total: number | string }>>,
): Promise<Map<string, number>> {
  const rows = await selectInChunks(ids, query);
  const totals = new Map<string, number>();
  for (const row of rows) {
    const value = typeof row.total === "string" ? Number(row.total) : row.total;
    totals.set(row.invoiceId, Number.isFinite(value) ? Math.trunc(value) : 0);
  }
  return totals;
}
