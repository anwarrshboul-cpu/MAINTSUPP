/**
 * GET /api/dashboard/stuck — §2.4's "Where work is stuck".
 *
 * The six longest-held open jobs across the four waiting meters, plus the two
 * numbers §2.4 asks to be REPORTED rather than assumed: how many rows the
 * board's own activity log could answer "when did this enter its current
 * status" for (`recovered`), and how many fell back to a column (`fallback`).
 *
 * `byMeter` carries counts and never a sentence. The card's line — "45 jobs are
 * waiting for approval, 12 of them for more than 30 days" — is DERIVED from
 * those counts, because a hard-coded version of it is exactly the kind of
 * number this rebuild exists to remove.
 */

import { loadStuckWork } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { StuckPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, now } = resolved.value;
    const payload: StuckPayload = {
      period: windowPayload(window),
      ...(await loadStuckWork(scope.db, scope.orgId, filters, window, now)),
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
