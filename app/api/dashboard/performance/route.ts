/**
 * GET /api/dashboard/performance — SLA with its coverage, and the work mix.
 *
 * The SLA half returns `closed` and `measured` as separate numbers on purpose.
 * The card this replaces printed "100% met target" beside "Jobs closed 170"
 * and, in smaller type, "61 closed jobs measured" — a confident headline over a
 * third of the data. Coverage is part of the answer now rather than a footnote,
 * and `targetField` says WHICH column supplied the target, because a percentage
 * measured against a different column is a different metric.
 */

import { loadReactiveVsPlanned, loadSla } from "../../../lib/dashboard-aggregates";
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

    const [sla, mix] = await Promise.all([
      loadSla(scope.db, scope.orgId, filters, window, now),
      loadReactiveVsPlanned(scope.db, scope.orgId, filters, window, now),
    ]);

    return Response.json({ period: windowPayload(window), sla, mix });
  } catch (error) {
    return dashboardFailure(error);
  }
}
