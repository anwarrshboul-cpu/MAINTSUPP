/**
 * GET /api/dashboard/sites-attention — the merged attention card.
 *
 * Three things the Overview used to draw as three separate panels, in one
 * payload: the whole-estate ageing distribution that was "Open job ageing", the
 * per-site rows that were "Sites needing attention", and the job feed that was
 * "Units requiring attention". They were the same open jobs, three times over.
 *
 * The top jobs for each site come back INLINE. Expanding a row is then free,
 * which is the difference between a card that feels instant on a phone and one
 * that spins every time somebody opens a site.
 *
 * Compliance per site is joined on here rather than left to the browser,
 * because the register is derived from the Store Documentation board and the
 * browser has no way to compute it without the 432 KB workspace snapshot this
 * rebuild exists to stop downloading.
 */

import { loadAgeing, loadSitesAttention } from "../../../lib/dashboard-aggregates";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { complianceCompletion } from "../../../lib/compliance-status";
import type { ComplianceState } from "../../../lib/types";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";

export const dynamic = "force-dynamic";

/**
 * What a site with no register entry gets.
 *
 * `scored: false`, not `percent: 0`. "Nobody has set up requirements at this
 * store" and "this store is failing its requirements" are different claims, and
 * a meter that renders the first as the second is the more dangerous of the two
 * — an unconfigured site looks identical to a compliant one today, and a zero
 * would make it look identical to a failing one instead.
 */
const NO_REGISTER = {
  satisfied: 0,
  applicable: 0,
  notRequired: 0,
  total: 0,
  percent: 0,
  scored: false,
  /* Kept in step with `ComplianceCompletion` and with `EMPTY_COMPLETION` in
     `app/lib/site-metrics.ts`: two literals standing in for the same shape must
     not answer with different fields, or a caller reading `excluded` gets it
     from one endpoint and `undefined` from the other. */
  excluded: 0,
  counts: {
    Compliant: 0,
    "Expiring soon": 0,
    Expired: 0,
    Missing: 0,
    "Not required": 0,
  } as Record<ComplianceState, number>,
};

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, now, url } = resolved.value;

    const jobLimit = Math.min(Math.max(Number(url.searchParams.get("jobs")) || 10, 1), 25);
    const siteLimit = Math.min(Math.max(Number(url.searchParams.get("sites")) || 12, 1), 60);

    const [ageing, attention, register] = await Promise.all([
      loadAgeing(scope.db, scope.orgId, filters, window, now),
      loadSitesAttention(scope.db, scope.orgId, filters, window, now, { siteLimit, jobLimit }),
      readComplianceRegister(scope.db, scope.orgId, { today: now }),
    ]);

    /*
     * Compliance keyed by site id, counted with the SHARED completion rule, so
     * the meter on this row is the same number the Compliance page prints for
     * the same store. `bySite` is the register's own per-site index, so nothing
     * here re-groups it and the two screens cannot come to different totals.
     * One instant — `now` — classifies the whole register, rather than
     * `new Date()` drifting through the loop.
     */
    const complianceBySite = new Map(
      [...register.bySite].map(([siteId, records]) => [
        siteId,
        complianceCompletion(records as Array<{ state: ComplianceState }>),
      ]),
    );

    return Response.json({
      period: windowPayload(window),
      ageing,
      siteCount: attention.siteCount,
      sites: attention.sites.map((site) => ({
        ...site,
        compliance: complianceBySite.get(site.siteId) ?? NO_REGISTER,
      })),
    });
  } catch (error) {
    return dashboardFailure(error);
  }
}
