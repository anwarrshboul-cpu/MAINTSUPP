/**
 * GET /api/dashboard/cost — §3's Financial status, coverage first.
 *
 * REBUILT. The card this feeds reported "£26,557 across 46 jobs" over a cohort
 * of 776 — a 6% sample presented as a total — and compared it against a
 * pro-rated annual budget half the sites had never set, which is how "Aldgate
 * 898%" reached a client's screen. §3.3 removes the budget presentation
 * entirely, so this payload no longer returns `annualBudget`, `proRatedBudget`,
 * `utilisation` or `sitesWithoutBudget`.
 *
 * NOTHING IS DELETED FROM THE DATABASE. `sites.annual_budget_pence` is
 * untouched and `loadCost` in `dashboard-aggregates.ts` still reads it; §8
 * allows unpublishing and forbids deleting, and the budget comparison can come
 * back the day cost coverage supports it.
 *
 * `coveragePercent` leads because §3.2 says it must: the confidence banner is
 * decided from it, and every figure beneath it is "based on jobs with a cost
 * recorded". Money crosses the wire as INTEGER PENCE.
 */

import { loadCost } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { CostPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, now } = resolved.value;
    const payload: CostPayload = {
      period: windowPayload(window),
      ...(await loadCost(scope.db, scope.orgId, filters, window, now)),
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
