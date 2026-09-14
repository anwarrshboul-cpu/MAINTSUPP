/**
 * `GET /api/reports/metrics` — every figure on the Reports dashboard block,
 * once; and `?format=csv`, the block's export, from the same snapshot.
 *
 * ONE read of the jobs the Overview counts (`dashboardJobScope` — live, on the
 * Jobs board, in the portfolio), ONE read of the Overview's own monthly-spend
 * query for the trend, ONE instant. `buildReportsDashboard` does the
 * arithmetic, and it is pure and tested directly.
 *
 * WHY THE JOB ROWS AND NOT ONLY `GROUP BY`. Spend by month is a `GROUP BY`
 * here exactly as it is on the Overview — it is the Overview's query. But a
 * repeat is a comparison between a job and the one BEFORE it at the same site
 * for the same issue, inside a 90-day window. Without `julianday` or window
 * functions (both refused on this dual-dialect stack) that comparison cannot be
 * written in SQL that runs on SQLite and Postgres alike — and the Jobs page has
 * to reproduce it in the browser to filter by it. So the rule is ONE TypeScript
 * function, `analyseRepeats`, run here over the scoped rows and there over the
 * same rows; the columns selected are exactly the ones `/api/maintenance`
 * sends, raw, so the two see identical inputs.
 *
 * THE TYPE SPLIT IS THE JOB'S CANONICAL JOB TYPE: `job_type_id` is selected
 * with the rest, the organisation's types come from `listJobTypes` (retired
 * ones included, so history keeps its meaning), and `jobTypeBucketOf` puts
 * every costed job in exactly one of Reactive / Planned / Project / Other /
 * Unclassified — the same rule the Jobs page's `type=` drill runs.
 *
 * READ-ONLY, `board.view`, organisation-scoped, and the membership's site
 * restriction applied through `resolveDashboardPortfolio`.
 */

import { eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { maintenanceRequests, sites } from "../../../../db/schema";
import { scopedDbWithCapability } from "../../../lib/tenant-db";
import { dashboardFailure } from "../../../lib/dashboard-route";
import {
  dashboardJobScope,
  loadSpendByMonth,
  resolveDashboardPortfolio,
} from "../../../lib/overview-metrics";
import {
  NO_SITE_KEY,
  buildReportsDashboard,
  resolveReportsRange,
  shiftDays,
  shiftMonth,
  type ReportsJob,
} from "../../../lib/reports-dash";
import {
  analyseRepeats,
  drillSiteIds,
  spendLineOf,
} from "../../../lib/job-metrics";
import { listJobTypes } from "../../../lib/job-types";
import { OTHER_JOB_TYPES_LABEL, UNCLASSIFIED_LABEL } from "../../../lib/job-type-contract";
import type { RpSitesRange, RpTrendRange } from "../../../lib/reports-dash-contract";
import { csvCell, csvDownload, poundsText } from "../../../lib/finance/exports";

export const dynamic = "force-dynamic";

const TREND_RANGES: readonly RpTrendRange[] = ["3m", "6m", "12m", "ytd"];
const SITES_RANGES: readonly RpSitesRange[] = ["page", "month", "3m", "ytd"];

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.scope;
    const url = new URL(request.url);
    const now = new Date();

    const range = resolveReportsRange(
      {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        reportPeriod: url.searchParams.get("reportPeriod"),
      },
      now,
    );
    const trendWanted = url.searchParams.get("trendRange") as RpTrendRange | null;
    const trendRange: RpTrendRange = trendWanted && TREND_RANGES.includes(trendWanted) ? trendWanted : "6m";
    const sitesWanted = url.searchParams.get("sitesRange") as RpSitesRange | null;
    const sitesRange: RpSitesRange = sitesWanted && SITES_RANGES.includes(sitesWanted) ? sitesWanted : "page";

    const portfolio = await resolveDashboardPortfolio(
      db,
      orgId,
      url.searchParams.get("portfolio"),
      siteScope,
    );
    const scope = dashboardJobScope(orgId, portfolio.siteIds);

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

    if (url.searchParams.get("format") !== "csv") return Response.json(metrics);

    /*
     * THE EXPORT — every job cost line under the active filters: a completed
     * job with a cost, dated inside the range, in the portfolio. Filter values
     * and a timestamp head the file and every metric on the block follows in a
     * summary section; the lines come from the same snapshot as the figures.
     * `csvCell` neutralises formula starters in every cell.
     */
    const verdicts = analyseRepeats(jobs, {
      from: range.from,
      toExclusive: shiftDays(range.to, 1),
    }).verdicts;
    const lines: string[] = [];
    const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(","));
    row("MAINTSUPP — Spend and reporting");
    row("Generated", metrics.generatedAt);
    row("Portfolio", metrics.portfolio.name);
    row("Date range", metrics.range.label);
    row("From", metrics.range.from);
    row("To", metrics.range.to);
    row("Spend basis", "Job cost, counted when the job is completed and dated by completion");
    row("Reconciliation", metrics.reconciliation.length ? metrics.reconciliation.join("; ") : "Every identity held");
    row("");
    row("Summary", "Item", "Value");
    for (const kpi of metrics.kpis) {
      row("Key figures", kpi.label, poundsText(kpi.pence));
      row("Key figures", `${kpi.label} — jobs`, kpi.jobs);
      row("Key figures", `${kpi.label} — ${kpi.delta.comparedWith}`, kpi.delta.percent === null ? kpi.delta.direction : `${kpi.delta.direction} ${kpi.delta.percent}%`);
    }
    /* The two buckets no card claims, so the summary reconciles to the total on
       paper as it does on screen. */
    for (const bucket of [metrics.other, metrics.unclassified]) {
      row("Key figures", bucket.label, poundsText(bucket.pence));
      row("Key figures", `${bucket.label} — jobs`, bucket.jobs);
    }
    for (const point of metrics.trend.points) row(`Spend trend (${metrics.trend.label})`, point.longLabel, poundsText(point.pence));
    row(`Spend trend (${metrics.trend.label})`, "Total", poundsText(metrics.trend.totalPence));
    for (const site of metrics.topSites.rows) row(`Top sites (${metrics.topSites.label})`, site.name, poundsText(site.pence));
    row(`Top sites (${metrics.topSites.label})`, "All sites", poundsText(metrics.topSites.sitesPence));
    row(`Top sites (${metrics.topSites.label})`, "No site", poundsText(metrics.topSites.noSite.pence));
    row("Repeat activity", "Jobs raised in range", metrics.repeat.jobsInRange);
    row("Repeat activity", "Repeat jobs", metrics.repeat.repeatJobs);
    row("Repeat activity", "Repeat rate (percent)", metrics.repeat.percent);
    row("Repeat activity", "Sites affected", metrics.repeat.sitesAffected);
    row("Repeat activity", "Repeat spend", poundsText(metrics.repeat.spendPence));
    for (const slice of metrics.repeat.byIssue) row("Repeat spend by issue", slice.label, poundsText(slice.value));
    for (const slice of metrics.repeat.bySite) row("Repeat spend by site", slice.label, poundsText(slice.value));
    for (const band of metrics.repeat.bands) row("Recurrence", band.label, band.value);
    row("");
    /*
     * "Job type" is the type's CURRENT label from the organisation's
     * configuration — a renamed type prints its new name — "Unclassified" for a
     * job with no type, and "Other" for an id that names no type (which the app
     * never writes, and which the figures group as Other too).
     */
    const typeLabels = new Map(jobTypes.map((type) => [type.id, type.label]));
    const jobTypeLabel = (job: ReportsJob) => {
      const id = (job.jobTypeId ?? "").trim();
      if (!id) return UNCLASSIFIED_LABEL;
      return typeLabels.get(id) ?? OTHER_JOB_TYPES_LABEL;
    };
    row("Completed", "Reference", "Job", "Site", "Job type", "Issue category", "Contractor", "Cost (GBP)", "Repeat");
    for (const job of jobs) {
      const line = spendLineOf(job);
      if (!line || line.day < range.from || line.day > range.to) continue;
      const siteId = (job.siteId ?? "").trim();
      const site = siteId && siteId !== "site-unassigned" && siteNames.has(siteId) ? siteNames.get(siteId) : "No site";
      row(
        line.day,
        job.reference ?? job.id,
        job.title ?? "",
        site ?? NO_SITE_KEY,
        jobTypeLabel(job),
        (job.category ?? "").trim() || "Other",
        (job.contractor ?? "").trim(),
        poundsText(line.pence),
        verdicts.get(job.id)?.repeat ? "Yes" : "No",
      );
    }
    return csvDownload(
      `spend-and-reporting-${metrics.range.from}-to-${metrics.range.to}.csv`,
      `﻿${lines.join("\r\n")}\r\n`,
    );
  } catch (error) {
    return dashboardFailure(error);
  }
}
