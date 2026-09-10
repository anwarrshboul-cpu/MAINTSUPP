/**
 * `/api/finance/summary` — the Invoice Tracker's landing figures. §8 and §9.
 *
 * "That last chart is what tells you whether you can commit to a project next
 * month." Everything here is one read of the open ledger, handed to the pure
 * reports in `cash.ts` — the balances are computed once and shared, so the cash
 * position and the forecast cannot disagree about a payment that landed between
 * two queries.
 *
 * The unbilled-work figure rides along deliberately rather than living only
 * behind its own endpoint: §15.1 calls it "the highest-value item here", and a
 * landing page that had to make a second request for it would be a landing page
 * that sometimes renders without it.
 */

import { financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadOpenLedger, loadUnbilled } from "../../../lib/finance/analytics";
import { cashForecast, cashSummary } from "../../../lib/finance/cash";
import { blockingFlags } from "../../../lib/finance/rules";
import { financeDay, shiftDay } from "../../../lib/finance/model";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { invoiceFlags, invoices, quotations } from "../../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const now = new Date();
    const today = financeDay(now);
    const ledger = await loadOpenLedger(db, orgId, now);

    const [unbilled, flagRows, quoteRows] = await Promise.all([
      loadUnbilled(db, orgId, 25),
      /*
       * OPEN blocking flags only. A waived flag is a decision somebody has
       * already taken and recorded; counting it as outstanding would keep
       * asking them to take it again.
       */
      db
        .select({ flagType: invoiceFlags.flagType, severity: invoiceFlags.severity })
        .from(invoiceFlags)
        .innerJoin(invoices, eq(invoices.id, invoiceFlags.invoiceId))
        .where(
          and(
            eq(invoiceFlags.organisationId, orgId),
            eq(invoiceFlags.status, "open"),
            isNull(invoices.voidedAt),
          ),
        ),
      /*
       * §3 — "An expired quote on an unstarted job is money quietly leaking."
       * Seven days is the reminder horizon, so it is the horizon the landing
       * page counts against too.
       */
      db
        .select({ id: quotations.id, validUntil: quotations.validUntil })
        .from(quotations)
        .where(
          and(
            eq(quotations.organisationId, orgId),
            isNotNull(quotations.validUntil),
            lte(quotations.validUntil, shiftDay(today, 7)),
            sql`${quotations.status} not in ('Approved', 'Rejected', 'Expired', 'Superseded')`,
          ),
        ),
    ]);

    const summary = cashSummary(ledger.cashRows, ledger.todayDay);
    const forecast = cashForecast(ledger.cashRows, ledger.todayDay);
    const open = blockingFlags(
      flagRows.map((row) => ({
        flagType: row.flagType,
        severity: row.severity,
        status: "open" as const,
      })),
    );

    return Response.json({
      today,
      ...summary,
      forecast,
      unbilled,
      flagsOpen: open.length,
      flagsOpenTotal: flagRows.length,
      quotesExpiring: quoteRows.length,
    });
  } catch (error) {
    return financeUnavailable(error, "The cash position could not be read.");
  }
}
