/**
 * EVERY FIGURE ON THE REPORTS DASHBOARD, LOADED ONCE — shared by the page and
 * the scheduled report email. §32.
 *
 * This body was inline in `GET /api/reports/metrics`. It moved here, unchanged,
 * because §32 asks that a scheduled report use THE SAME SOURCE DATA as the
 * widgets, and the scheduler has no request and no session to call the route
 * with. One loader, two callers: the route answers the page, and
 * `app/lib/report-delivery.ts` answers an email — neither can drift from the
 * other because there is no other.
 *
 * ONE read of the jobs the Overview counts (`dashboardJobScope` — live, on the
 * Jobs board, in the portfolio), ONE read of the Overview's own monthly-spend
 * query for the trend, ONE instant, and `buildReportsDashboard` for the
 * arithmetic, which is pure and tested directly. READ-ONLY. The caller decides
 * who may see it and passes their site restriction in.
 */
import { eq } from "drizzle-orm";
import { maintenanceRequests, sites } from "../../db/schema";
import type { getDb } from "../../db";
import {
  dashboardJobScope,
  loadSpendByMonth,
  resolveDashboardPortfolio,
} from "./overview-metrics";
import {
  buildReportsDashboard,
  resolveReportsRange,
  shiftDays,
  shiftMonth,
  type ReportsJob,
} from "./reports-dash";
import { drillSiteIds } from "./job-metrics";
import { listJobTypes } from "./job-types";
import type { RpSitesRange, RpTrendRange } from "./reports-dash-contract";

type Database = Awaited<ReturnType<typeof getDb>>;

const TREND_RANGES: readonly RpTrendRange[] = ["3m", "6m", "12m", "ytd"];
const SITES_RANGES: readonly RpSitesRange[] = ["page", "month", "3m", "ytd"];

/** The page's query parameters, as the page sends them. */
export type ReportsQuery = {
  from?: string | null;
  to?: string | null;
  reportPeriod?: string | null;
  trendRange?: string | null;
  sitesRange?: string | null;
  portfolio?: string | null;
};

export async function loadReportsSnapshot(
  db: Database,
  orgId: string,
  siteScope: string[] | null,
  query: ReportsQuery,
  now: Date = new Date(),
) {
  const range = resolveReportsRange(
    {
      from: query.from ?? null,
      to: query.to ?? null,
      reportPeriod: query.reportPeriod ?? null,
    },
    now,
  );
  const trendWanted = (query.trendRange ?? null) as RpTrendRange | null;
  const trendRange: RpTrendRange = trendWanted && TREND_RANGES.includes(trendWanted) ? trendWanted : "6m";
  const sitesWanted = (query.sitesRange ?? null) as RpSitesRange | null;
  const sitesRange: RpSitesRange = sitesWanted && SITES_RANGES.includes(sitesWanted) ? sitesWanted : "page";

  const portfolio = await resolveDashboardPortfolio(
    db,
    orgId,
    query.portfolio ?? null,
    siteScope,
  );
  const scope = dashboardJobScope(orgId, portfolio);

  /* The trend's months and the equal window before them, for its delta. */
  const anchor = range.to.slice(0, 7);
  const trendMonths =
    trendRange === "3m" ? 3 : trendRange === "12m" ? 12 : trendRange === "ytd" ? Number(anchor.slice(5, 7)) : 6;
  const firstMonth = shiftMonth(anchor, -(2 * trendMonths - 1));

  const [jobRows, siteRows, monthlySpend, jobTypes] = await Promise.all([
    db
      .select({
        id: maintenanceRequests.id,
        siteId: maintenanceRequests.siteId,
        category: maintenanceRequests.category,
        tier: maintenanceRequests.tier,
        jobTypeId: maintenanceRequests.jobTypeId,
        cost: maintenanceRequests.cost,
        completedAt: maintenanceRequests.completedAt,
        requestedAt: maintenanceRequests.requestedAt,
        contractor: maintenanceRequests.contractor,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
      })
      .from(maintenanceRequests)
      .where(scope),
    db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      .where(eq(sites.organisationId, orgId)),
    loadSpendByMonth(db, scope, `${firstMonth}-01`, shiftDays(range.to, 1)),
    listJobTypes(db, orgId),
  ]);

  const jobs = jobRows as unknown as ReportsJob[];
  const siteList = siteRows as Array<{ id: string; name: string }>;
  const siteNames = new Map(siteList.map((site) => [site.id, site.name]));
  const allowed = portfolio.siteIds ? new Set(portfolio.siteIds) : null;
  /* Every site in scope, closed ones included: the ceiling "sites with
     repeats" is reconciled against (see `siteCount` in reports-dash). */
  const siteCount = siteList.filter((site) => !allowed || allowed.has(site.id)).length;

  const metrics = buildReportsDashboard({
    jobs,
    siteNames,
    jobTypes,
    monthlySpend,
    now,
    range,
    trendRange,
    sitesRange,
    portfolio: portfolio.chosen
      ? { ...portfolio.chosen, siteIds: drillSiteIds(portfolio.siteIds) }
      : { id: "all", name: "All portfolios", siteIds: drillSiteIds(portfolio.siteIds) },
    portfolios: portfolio.portfolios,
    siteCount,
  });

  if (metrics.reconciliation.length > 0) {
    console.error("[reports-metrics] reconciliation failed", metrics.reconciliation);
  }

  return { metrics, jobs, siteNames, jobTypes, range };
}
