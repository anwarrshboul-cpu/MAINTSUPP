/**
 * GET /api/dashboard/sites-attention — §6, real sites only.
 *
 * REBUILT. The card read "57 open jobs across 2 sites" over a portfolio of ten,
 * and one of the two was *Unassigned site*, which is not a location — it is a
 * broken foreign key, and ranking it against real stores distorted every row.
 * §6.1 moves it out of the list and into `dataQuality.jobsWithNoSite`, where a
 * bulk site-assign view can act on it.
 *
 * `shareOfOpen` is a PERCENTAGE (§6.3 — the old card printed a count beside a
 * bar and called it "Share of open 26"), and `score` weights critical-aged and
 * urgent work highest so the ranking is a judgement rather than a row count.
 *
 * COMPLIANCE STILL COMES FROM THE SHARED REGISTER, and that is deliberate and
 * pinned: `readComplianceRegister` is the same function the Compliance page
 * reads and `complianceCompletion` is the same rule it counts with, keyed by
 * the register's own `bySite` index so nothing here re-groups it. The old
 * defect was two panels on one page disagreeing about one store, and it must
 * not come back through a rebuild.
 */

import { loadSitesAttention } from "../../../lib/overview-aggregates";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { complianceCompletion } from "../../../lib/compliance-status";
import type { ComplianceState } from "../../../lib/types";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { SitesAttentionPayload } from "../../../(app)/portal/ops/overview-contract";

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
    const { scope, filters, window, now } = resolved.value;

    const [attention, register] = await Promise.all([
      loadSitesAttention(scope.db, scope.orgId, filters, window, now),
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

    const payload: SitesAttentionPayload = {
      period: windowPayload(window),
      ...attention,
      sites: attention.sites.map((site) => {
        const completion = complianceBySite.get(site.siteId);
        return {
          ...site,
          compliance: completion
            ? {
                satisfied: completion.satisfied,
                applicable: completion.applicable,
                scored: completion.scored,
              }
            : { satisfied: NO_REGISTER.satisfied, applicable: NO_REGISTER.applicable, scored: NO_REGISTER.scored },
        };
      }),
      dataQuality: {
        ...attention.dataQuality,
        /*
         * "N sites have no compliance profile" — §6.4. Counted here rather than
         * in the aggregate because the register is what knows: a site with no
         * entry in `bySite` has no requirements set up at all, which is the
         * same distinction `scored: false` draws one row down.
         */
        sitesWithoutComplianceProfile: Math.max(
          0,
          attention.portfolioSiteCount -
            [...complianceBySite.values()].filter((entry) => entry.scored).length,
        ),
      },
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
