/**
 * GET /api/dashboard/meters — §2's At a glance, in one payload.
 *
 * The card this feeds replaces five tiles that reconciled to nothing. The
 * contract it has to keep is acceptance gate 11: THE EIGHT METERS SUM EXACTLY
 * TO THE COHORT TOTAL, in every range and filter combination. That is true by
 * construction rather than by a reconciliation step — `loadMeters` folds a
 * complete `GROUP BY status` through `meterForStatus`, which maps every status
 * to exactly one meter and resolves an unknown one to the permanent catch-all.
 *
 * `pulse`, `excluded` and `unmappedStatuses` are the three things the old card
 * could not say: the headline four with their previous-period twins, the rows
 * the chosen date axis cannot see (§1.1 forbids imputing a date), and the
 * statuses nobody has mapped, so an administrator can go and map them.
 */

import { loadMeters } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { MetersPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, now } = resolved.value;
    const payload: MetersPayload = {
      period: windowPayload(window),
      ...(await loadMeters(scope.db, scope.orgId, filters, window, now)),
    };
    return Response.json(payload);
  } catch (error) {
    /* A query failure is a 503 with a sentence, never a 200 carrying zeros:
       §4.1 requires loading, empty and error to look like three things. */
    return dashboardFailure(error);
  }
}
