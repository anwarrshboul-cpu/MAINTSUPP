/**
 * `/api/finance/ageing` — aged debtors and aged creditors. §9.
 *
 * One direction per request, because the two answer different questions to
 * different people: an aged-debtor report is a chasing list, an aged-creditor
 * report is a payment plan. Sharing one payload would have the UI filter a
 * table it had just been handed, which is the habit this whole module was
 * built to stop.
 *
 * The arithmetic is `ageing.ts`, which is pure and tested against a hand-seeded
 * set; this route only chooses the rows.
 */

import { financeBadRequest, financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadOpenLedger } from "../../../lib/finance/analytics";
import { ageingReport } from "../../../lib/finance/ageing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const direction = new URL(request.url).searchParams.get("direction") ?? "payable";
    if (direction !== "payable" && direction !== "receivable") {
      return financeBadRequest("Ask for direction=payable or direction=receivable.");
    }

    const ledger = await loadOpenLedger(db, orgId);
    const report = ageingReport(ledger.ageing[direction], ledger.todayDay);
    return Response.json({ direction, today: ledger.todayDay, ...report });
  } catch (error) {
    return financeUnavailable(error, "The aged report could not be read.");
  }
}
