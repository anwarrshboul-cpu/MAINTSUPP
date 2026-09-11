/**
 * `GET /api/compliance/metrics` — every figure on the Compliance dashboard
 * block, once; and `?format=csv`, the block's export, from the same snapshot.
 *
 * ONE register read, classified against ONE instant, feeds the score donut,
 * the type rings, the countdown, the renewals donut and the sites gauge — so no
 * two widgets can disagree about what day it is. The register is
 * `readComplianceRegister`, the function the Compliance page below the block,
 * the Overview's compliance KPI and the nightly digest already share; the
 * arithmetic is `buildComplianceDashboard`, which is pure and tested directly.
 *
 * ── READ-ONLY ─────────────────────────────────────────────────────────────
 *
 * Nothing here writes. No status is stored: every state is derived from the
 * due date and the file count against today, so a certificate flips from
 * Expiring soon to Expired at the day's end without any row changing.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 *
 * `board.view`, the capability the register itself is read under, through
 * `scopedDbWithCapability`, which fixes the organisation. The portfolio is
 * resolved inside that organisation and intersected with the membership's
 * site restriction (`resolveDashboardPortfolio`), so no query-string value can
 * widen what a member sees — neither the figures nor the export.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sites } from "../../../../db/schema";
import { scopedDbWithCapability } from "../../../lib/tenant-db";
import { dashboardFailure } from "../../../lib/dashboard-route";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { complianceRowsFrom, isScoredRow } from "../../../lib/compliance-view";
import { EXPIRY_DUE_SOON_DAYS } from "../../../lib/compliance-status";
import { buildComplianceDashboard } from "../../../lib/compliance-dash";
import { listSites } from "../../../lib/sites-repository";
import {
  formatDay,
  formatDayRange,
  resolveDashboardPortfolio,
} from "../../../lib/overview-metrics";
import { csvCell, csvDownload } from "../../../lib/finance/exports";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The due-date range the header picker holds, and the words its pill prints. */
function dueRange(url: URL) {
  const rawFrom = (url.searchParams.get("from") ?? "").trim();
  const rawTo = (url.searchParams.get("to") ?? "").trim();
  let from = DAY.test(rawFrom) ? rawFrom : null;
  let to = DAY.test(rawTo) ? rawTo : null;
  if (from && to && from > to) [from, to] = [to, from];
  const label =
    from && to
      ? formatDayRange(from, to)
      : from
        ? `From ${formatDay(from)}`
        : to
          ? `Until ${formatDay(to)}`
          : "Any due date";
  return { from, to, label };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.scope;
    const url = new URL(request.url);
    const range = dueRange(url);

    /* One instant classifies the whole register. */
    const today = new Date();
    const [register, managerRows, registerSites, portfolio] = await Promise.all([
      readComplianceRegister(db, orgId, { today }),
      /* Managers for `responsibilityFor`'s fallback — the same read the
         register's own summary and records routes make. */
      db
        .select({ id: sites.id, manager: sites.manager, managerName: sites.managerName })
        .from(sites)
        .where(and(eq(sites.organisationId, orgId))),
      /* The Sites page's own list: the canonical register, closed included,
         so "active" below is that page's `status !== "closed"`. */
      listSites(db, orgId, { includeInactive: true }),
      resolveDashboardPortfolio(db, orgId, url.searchParams.get("portfolio"), siteScope),
    ]);

    const managerById = new Map(
      (managerRows as Array<{ id: string; manager: string | null; managerName: string | null }>).map(
        (row) => [row.id, (row.managerName || row.manager || "").trim()],
      ),
    );
    const rows = complianceRowsFrom(register.entries, managerById);
    const allowed = portfolio.siteIds ? new Set(portfolio.siteIds) : null;
    const activeSiteIds = (registerSites as Array<{ id: string; status: string | null }>)
      .filter((site) => site.status !== "closed" && (!allowed || allowed.has(site.id)))
      .map((site) => site.id);

    const metrics = buildComplianceDashboard({
      rows,
      today,
      portfolio: portfolio.chosen
        ? { ...portfolio.chosen, siteIds: portfolio.siteIds }
        : { id: "all", name: "All portfolios", siteIds: portfolio.siteIds },
      portfolios: portfolio.portfolios,
      range,
      activeSiteIds,
      warningWindowDays: EXPIRY_DUE_SOON_DAYS,
    });

    if (metrics.reconciliation.length > 0) {
      console.error("[compliance-metrics] reconciliation failed", metrics.reconciliation);
    }

    if (url.searchParams.get("format") !== "csv") return Response.json(metrics);

    /*
     * THE EXPORT — every requirement under the block's filters (portfolio and
     * due-date range), with the filter values and a timestamp in the header
     * rows and every metric on the block in a summary section. Built from the
     * SAME snapshot as the figures, so the file cannot disagree with the screen
     * it was taken from. `csvCell` neutralises formula starters in every cell —
     * a site or contractor name typed as `=HYPERLINK(…)` arrives as text.
     */
    const lines: string[] = [];
    const row = (...cells: unknown[]) => lines.push(cells.map(csvCell).join(","));
    row("MAINTSUPP — Compliance overview");
    row("Generated", metrics.generatedAt);
    row("Classified as of", metrics.today);
    row("Portfolio", metrics.portfolio.name);
    row("Due-date range", metrics.range.label);
    row("Reconciliation", metrics.reconciliation.length ? metrics.reconciliation.join("; ") : "Every identity held");
    row("");
    row("Summary", "Item", "Value");
    row("Score", "Compliance score (percent)", metrics.score.scored ? metrics.score.percent : "not scored");
    row("Score", "Requirements on track (X)", metrics.score.satisfied);
    row("Score", "Requirements in the score (Y)", metrics.score.applicable);
    row("Score", "Compliant", metrics.score.counts.compliant);
    row("Score", "Expiring soon", metrics.score.counts.expiring);
    row("Score", "Expired", metrics.score.counts.expired);
    row("Score", "Missing", metrics.score.counts.missing);
    row("Score", "Not required (outside the score)", metrics.score.notRequired);
    row("Score", "Responsibility not confirmed as the client's (outside the score)", metrics.score.excluded);
    for (const ring of metrics.types) {
      row("Compliance by type", ring.label, `${ring.percent}% (${ring.counts.compliant} of ${ring.total})`);
    }
    for (const ring of metrics.countdown.rings) row("Renewals outlook", ring.label, ring.value);
    for (const slice of metrics.renewals.slices) row("Who's renewing", slice.label, slice.value);
    row("Who's renewing", "Unlinked to a contractor record", metrics.renewals.unlinked);
    row("Sites", "Sites fully compliant", metrics.sites.fullyCompliant);
    row("Sites", "Active sites with a requirement in the score", metrics.sites.considered);
    row("Sites", "Sites fully compliant (percent)", metrics.sites.percent);
    row("Data gaps", "Certificates held with no due date", metrics.dataGaps.heldWithoutDueDate);
    row("Data gaps", "Site-type applicability configuration", metrics.dataGaps.siteTypeApplicability);
    row("");
    row("Site", "Requirement", "Status", "Due date", "Responsible", "In the score");
    const siteAllowed = allowed;
    for (const entry of rows) {
      if (siteAllowed && !siteAllowed.has(entry.siteId)) continue;
      if (range.from || range.to) {
        if (!entry.expiry) continue;
        if (range.from && entry.expiry < range.from) continue;
        if (range.to && entry.expiry > range.to) continue;
      }
      row(
        entry.siteName,
        entry.kind,
        entry.state,
        entry.expiry ?? "No due date",
        entry.responsibility,
        isScoredRow(entry) ? "Yes" : entry.state === "Not required" ? "No — not required" : "No — responsibility not confirmed",
      );
    }
    return csvDownload(
      `compliance-overview-${metrics.today}.csv`,
      `﻿${lines.join("\r\n")}\r\n`,
    );
  } catch (error) {
    return dashboardFailure(error);
  }
}
