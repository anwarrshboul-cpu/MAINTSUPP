/**
 * GET /api/compliance/summary — the portfolio meter and every group header.
 *
 * ONE request draws the whole collapsed register: a segmented bar across all
 * records, ten site headers each with its own completion meter and outstanding
 * counts, and the filter controls' option lists. No records travel. The page
 * this replaces rendered 748 six-row cards to answer "which stores are
 * compliant", which is eleven phone screens of scrolling to reach a question
 * the header band now answers in one.
 *
 * The counts describe the FILTERED set, so a group header changes when a filter
 * is applied. That is why the summary is computed per request rather than
 * cached: a meter that kept describing the unfiltered register while the rows
 * beneath it were filtered would be a page contradicting itself.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sites } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { memberSiteSet, withinMemberScope } from "../../../lib/member-site-scope";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { contractorNamesById, providerOptions } from "../../../lib/compliance-provider";
import { resolveDashboardPortfolio } from "../../../lib/overview-metrics";
import {
  complianceFilterOptions,
  complianceRowsFrom,
  filterComplianceRows,
  groupCompliance,
  isGroupSort,
  parseComplianceFilters,
  portfolioCounts,
  soonestDue,
  sortGroups,
  GROUP_SORTS,
} from "../../../lib/compliance-view";
import { DUE_WINDOWS } from "../../../lib/compliance-status";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    /*
     * `board.view`, the same capability the Store Documentation board is gated
     * on. This register IS that board read a different way, and a second
     * capability over the same rows would be a permission an administrator has
     * to keep in step by hand.
     */
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.scope;
    const url = new URL(request.url);
    const filters = parseComplianceFilters(url);
    const sortRaw = url.searchParams.get("sort") ?? "";
    const sort = isGroupSort(sortRaw) ? sortRaw : "outstanding";

    // One instant classifies the whole register. `new Date()` inside the loop
    // drifts and can bucket two certificates expiring on the same day
    // differently.
    const today = new Date();
    const [register, siteRows, providerNames, portfolio] = await Promise.all([
      readComplianceRegister(db, orgId, { today }),
      // Managers, for the responsibility fallback — see the same query in
      // /api/compliance/records.
      db
        .select({ id: sites.id, manager: sites.manager, managerName: sites.managerName })
        .from(sites)
        .where(and(eq(sites.organisationId, orgId))),
      contractorNamesById(db, orgId),
      /*
       * THE HEADER'S PORTFOLIO, INTERSECTED WITH THE MEMBER'S SITES.
       *
       * The register used to be narrowed to a portfolio only by the `site=`
       * list a dashboard drill wrote, and it never read `portfolio` itself — so
       * after the header changed portfolio it went on showing whatever that
       * list said, including sites outside the new portfolio. It now answers
       * inside exactly the set the Compliance block counts: the portfolio's
       * members ∩ the membership's site scope (`resolveDashboardPortfolio`),
       * or the scope alone for "All portfolios". A stale `site=` list can only
       * narrow that set further; it can never widen it.
       */
      resolveDashboardPortfolio(db, orgId, url.searchParams.get("portfolio"), siteScope),
    ]);
    const managerById = new Map(
      siteRows.map((row) => [row.id, (row.managerName || row.manager || "").trim()]),
    );

    /* The member's authorised sites — see `member-site-scope.ts` — as the
       portfolio resolved them (null: every site). */
    const allowed = memberSiteSet(portfolio.siteIds);
    const scopedEntries = allowed
      ? register.entries.filter((entry) => withinMemberScope(allowed, entry.siteId))
      : register.entries;
    /* One row builder for the register and the dashboard block above it
       (`complianceRowsFrom`): responsibility, duty holder, whether a board row
       stands behind it, and the linked renewal contractor. */
    const rows = complianceRowsFrom(scopedEntries, managerById, providerNames);

    const filtered = filterComplianceRows(rows, filters, today);
    const groups = groupCompliance(filtered, today);

    const soonestBySite = new Map<string, string | null>();
    for (const group of groups) {
      soonestBySite.set(
        group.siteId,
        soonestDue(filtered.filter((row) => row.siteId === group.siteId)),
      );
    }

    return Response.json({
      portfolio: portfolioCounts(filtered),
      /*
       * The unfiltered totals as well, so the header can say "showing 84 of
       * 748" rather than quietly redefining the estate every time somebody
       * ticks a box.
       */
      registerTotal: rows.length,
      registerSites: new Set(rows.map((row) => row.siteId)).size,
      noDueDateTotal: rows.filter((row) => !row.expiry).length,
      groups: sortGroups(groups, sort, soonestBySite).map((group) => ({
        ...group,
        soonestDue: soonestBySite.get(group.siteId) ?? null,
      })),
      sorts: GROUP_SORTS,
      dueWindows: DUE_WINDOWS,
      /* The window this register was classified with, so "expiring within N
         days" names the window that turned these records amber. */
      expiryWindowDays: register.windowDays,
      options: complianceFilterOptions(rows),
      /* The contractors a renewal can be linked to, and the names behind any
         `contractor=` chip — this organisation's only. */
      providers: await providerOptions(
        db,
        orgId,
        new Set(rows.flatMap((row) => (row.providerContractorId ? [row.providerContractorId] : []))),
      ),
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Preview database error: ${message}`
            : "The compliance register is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
}
