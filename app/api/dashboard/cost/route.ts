/**
 * GET /api/dashboard/cost — spend against a PRO-RATED budget, and attribution.
 *
 * Both halves lead with what they cannot see:
 *
 *  - the budget half returns the annual figure AND the pro-rated one, so the
 *    card compares 90 days of spend with 90 days of budget rather than with a
 *    year of it. That arithmetic is what produced 223% against a site that was
 *    inside its budget, and the old card admitted it in its own subtitle rather
 *    than fixing it;
 *
 *  - the contractor half returns the period's whole spend, how much of it names
 *    a contractor at all, and how much of THAT resolves to a register record.
 *    The gap between the last two is the finding, and a bar chart of the
 *    attributed slice alone hides it.
 */

import { loadCost } from "../../../lib/dashboard-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window } = resolved.value;
    const cost = await loadCost(scope.db, scope.orgId, filters, window);
    return Response.json({ period: windowPayload(window), ...cost });
  } catch (error) {
    return dashboardFailure(error);
  }
}
