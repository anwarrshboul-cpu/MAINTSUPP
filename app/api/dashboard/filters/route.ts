/**
 * GET /api/dashboard/filters — the values each control offers, with counts.
 *
 * Counted over the whole live estate rather than over the filter currently
 * applied. A control that only listed the values already on screen could narrow
 * a filter and never widen it, which is a dead end a reader has to clear by
 * editing the address bar.
 */

import { FAMILY_OPTIONS, loadFilterOptions } from "../../../lib/dashboard-aggregates";
import { PERIOD_PRESETS } from "../../../lib/dashboard-filters";
import { PRIORITY_BANDS } from "../../../lib/job-metrics";
import { dashboardFailure, dashboardScope } from "../../../lib/dashboard-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope } = resolved.value;
    const options = await loadFilterOptions(scope.db, scope.orgId);
    return Response.json({
      ...options,
      periods: PERIOD_PRESETS,
      priorities: PRIORITY_BANDS,
      families: FAMILY_OPTIONS,
    });
  } catch (error) {
    return dashboardFailure(error);
  }
}
