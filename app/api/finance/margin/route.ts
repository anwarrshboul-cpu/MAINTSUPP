/**
 * `/api/finance/margin` — §8, the number the business is run on.
 *
 * Cost in is the payable allocation, charged out is the receivable allocation,
 * and the roll-up is `margin.ts` — pure, sorted worst-first, and returning a
 * NULL margin percentage wherever nothing has been charged out. A margin
 * percentage over a zero denominator is not −100%; it is unknown, and the two
 * must not be drawn the same way.
 *
 * `coverage` rides on every row for the same reason: a site with twenty jobs
 * and three invoices has a margin that is a partial picture rather than a
 * result, and the row says so.
 */

import { financeBadRequest, financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadMarginInputs } from "../../../lib/finance/analytics";
import { MARGIN_GROUPINGS, isMarginGrouping, marginRollup } from "../../../lib/finance/margin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const asked = new URL(request.url).searchParams.get("groupBy") ?? "job";
    if (!isMarginGrouping(asked)) {
      return financeBadRequest(`Group by one of: ${MARGIN_GROUPINGS.join(", ")}.`);
    }

    const { jobs, allocations } = await loadMarginInputs(db, orgId);
    return Response.json({ groupings: MARGIN_GROUPINGS, ...marginRollup(jobs, allocations, asked) });
  } catch (error) {
    return financeUnavailable(error, "Margin could not be read.");
  }
}
