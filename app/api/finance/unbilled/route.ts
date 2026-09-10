/**
 * `/api/finance/unbilled` — §8's highest-value alert, on its own endpoint.
 *
 * "Jobs with cost in and nothing charged out — unbilled work, which is money
 * already spent and not yet recovered." §15.1: "It is invisible in a
 * spreadsheet and it is pure lost revenue."
 *
 * The landing page carries the first twenty-five inside `/summary`; this is the
 * whole list, for the panel a reader opens to work through it.
 */

import { financeUnavailable, guardFinance } from "../../../lib/finance/access";
import { loadUnbilled } from "../../../lib/finance/analytics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    return Response.json(await loadUnbilled(db, orgId, 500));
  } catch (error) {
    return financeUnavailable(error, "Unbilled work could not be read.");
  }
}
