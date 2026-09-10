/**
 * GET /api/dashboard/job-breakdown — §5's four dimensions, and only four.
 *
 * THE STATUS DIMENSION IS GONE (§5.2). The At a glance meters own status now,
 * with a mapping the operator controls in Settings, and two different groupings
 * of one field on one page is a contradiction a client notices. The per-status
 * detail is reachable from any meter tile and from "View all statuses".
 *
 * What each dimension returns is §1.4's percentage rule made unavoidable:
 * `recorded` is the denominator, `total` is the cohort, every share is a share
 * of recorded, and "Not recorded" is a grey, percentage-free count. Tier
 * renders all four tiers plus not-recorded INCLUDING the zeros, because an
 * absent tier is the finding; engineer's `recorded` is what the donut centre
 * must read — the card it replaces printed the cohort total (226) over a
 * caption saying "193 of 226 recorded".
 *
 * `?split=priority` adds `byPriority` to every bucket. The stacks sum to each
 * bucket's own `value`, so a split view reconciles with the unsplit one.
 */

import { loadBreakdown } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { BreakdownPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, url } = resolved.value;
    const split = url.searchParams.get("split") === "priority";
    const payload: BreakdownPayload = {
      period: windowPayload(window),
      ...(await loadBreakdown(scope.db, scope.orgId, filters, window, split)),
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
