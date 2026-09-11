/**
 * `GET /api/overview/metrics` — every figure on the dashboard block, once.
 *
 * The brief asks for one endpoint that computes the whole block "in one pass
 * from one consistent snapshot", and this is it. Six KPIs, the status donut,
 * the SLA speedometer, the priority rings, the category rings, the compliance
 * gauge and the spend trend all come back from a single call, computed from a
 * single `new Date()`, so no two widgets can disagree about what time it is.
 *
 * ── WHY THE RECONCILIATION RUNS ON THE SERVER ─────────────────────────────
 *
 * §5.3 lists six identities that must always hold — the donut, the rings and
 * the categories each summing to Open jobs, overdue never exceeding it, and
 * the SLA percentage being exactly the two of them divided. They are checked
 * HERE, on every response, and a failure is logged with the numbers in it.
 *
 * It does not refuse to answer. A dashboard that 500s because one subtotal
 * drifted is worse than one that draws and says so: the reader loses every
 * other figure on the page to protect them from one. The failure reaches the
 * logs where somebody can act on it, and the payload carries it so a test can
 * assert on it without scraping stderr.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 *
 * `board.view`, through `scopedDbWithCapability`, which is the same door every
 * other read on this page uses. `ensureDatabase()` runs first, as it does on
 * every boot path — a 401 from this route therefore also proves the migration
 * completed, which is how the deployed schema gets verified without a
 * credential.
 */

import { scopedDbWithCapability } from "../../../lib/tenant-db";
import { dashboardFailure } from "../../../lib/dashboard-route";
import { loadOverviewMetrics, reconcile } from "../../../lib/overview-metrics";
import { ensureDatabase } from "../../../../db/init";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;

    const url = new URL(request.url);
    const metrics = await loadOverviewMetrics(guard.scope.db, guard.scope.orgId, {
      portfolio: url.searchParams.get("portfolio"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      /* A site-restricted member reads only their stores, as on every
         `/api/dashboard/*` route — see `resolveDashboardPortfolio`. */
      siteScope: guard.scope.siteScope,
    });

    const failures = reconcile(metrics);
    if (failures.length > 0) {
      console.error("[overview-metrics] reconciliation failed", failures);
    }

    return Response.json({ ...metrics, reconciliation: failures });
  } catch (error) {
    return dashboardFailure(error);
  }
}
