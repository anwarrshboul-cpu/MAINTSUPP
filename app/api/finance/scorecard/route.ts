/**
 * `/api/finance/scorecard` — §15.10, from real data only.
 *
 * "Turns payment data into a procurement decision" — but only where the data
 * supports one. Every column the ledger cannot yet answer comes back NULL
 * rather than zero, and the payload carries a sentence saying which and why. A
 * scorecard that printed 0% variance for a supplier who has never quoted would
 * rank them alongside one who quotes accurately every time.
 */

import { financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadScorecard } from "../../../lib/finance/analytics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    return Response.json(await loadScorecard(db, orgId));
  } catch (error) {
    return financeUnavailable(error, "The contractor scorecard could not be read.");
  }
}
