/**
 * GET /api/dashboard/summary — the five KPI tiles, and their deltas.
 *
 * One aggregate for the window, one for the window before it, one row for the
 * oldest open job and one `GROUP BY status` so the page can name any status the
 * family map cannot place. Four statements, no job rows, and a payload of about
 * a dozen numbers regardless of how large the board is.
 *
 * The delta is omitted rather than reported as zero when no comparable prior
 * period exists — "all time" has nothing before it, and a "0" against nothing
 * is a claim the data cannot support.
 */

import { loadSummary } from "../../../lib/dashboard-aggregates";
import { statusLabelsInFamily } from "../../../lib/job-metrics";
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
    const { scope, filters, window, now } = resolved.value;

    const summary = await loadSummary(
      scope.db,
      scope.orgId,
      filters,
      window,
      now,
      statusLabelsInFamily("attention"),
    );

    return Response.json({ period: windowPayload(window), ...summary });
  } catch (error) {
    return dashboardFailure(error);
  }
}
