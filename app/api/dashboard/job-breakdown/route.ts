/**
 * GET /api/dashboard/job-breakdown — five dimensions, each with its denominator.
 *
 * Every dimension returns `{ recorded, total, buckets }` and every bucket list
 * ends with `Not recorded` whenever `recorded < total`. That shape is the whole
 * point of the card: on this estate the missing values are the largest bucket
 * in two of the five dimensions, and the charts this replaces simply left them
 * out — so a tier chart with one real value looked complete.
 */

import { loadBreakdown } from "../../../lib/dashboard-aggregates";
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
    const breakdown = await loadBreakdown(scope.db, scope.orgId, filters, window);
    return Response.json({ period: windowPayload(window), ...breakdown });
  } catch (error) {
    return dashboardFailure(error);
  }
}
