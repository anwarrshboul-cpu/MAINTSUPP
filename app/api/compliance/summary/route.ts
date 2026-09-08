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
import { readComplianceRegister } from "../../../lib/compliance-register";
import {
  complianceFilterOptions,
  filterComplianceRows,
  groupCompliance,
  isGroupSort,
  parseComplianceFilters,
  portfolioCounts,
  responsibilityFor,
  soonestDue,
  sortGroups,
  GROUP_SORTS,
  type ComplianceRow,
} from "../../../lib/compliance-view";
import { DUE_WINDOWS, EXPIRY_DUE_SOON_DAYS } from "../../../lib/compliance-status";

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
    const { db, orgId } = guard.scope;

    const url = new URL(request.url);
    const filters = parseComplianceFilters(url);
    const sortRaw = url.searchParams.get("sort") ?? "";
    const sort = isGroupSort(sortRaw) ? sortRaw : "outstanding";

    // One instant classifies the whole register. `new Date()` inside the loop
    // drifts and can bucket two certificates expiring on the same day
    // differently.
    const today = new Date();
    const [register, siteRows] = await Promise.all([
      readComplianceRegister(db, orgId, { today }),
      // Managers, for the responsibility fallback — see the same query in
      // /api/compliance/records.
      db
        .select({ id: sites.id, manager: sites.manager, managerName: sites.managerName })
        .from(sites)
        .where(and(eq(sites.organisationId, orgId))),
    ]);
    const managerById = new Map(
      siteRows.map((row) => [row.id, (row.managerName || row.manager || "").trim()]),
    );

    const rows: ComplianceRow[] = register.entries.map((entry) => ({
      id: entry.id,
      siteId: entry.siteId,
      siteName: entry.siteName,
      kind: entry.kind,
      responsibility: responsibilityFor(entry.kind, managerById.get(entry.siteId) ?? ""),
      state: entry.state,
      expiry: entry.expiry,
      fileCount: entry.fileCount,
      /*
       * Editable only when NO board row stands behind it.
       *
       * Both halves of the board address are needed — `itemId` names the row
       * and `slotKey` names which of the twelve certificates — and a record
       * carrying one without the other is treated as register-only, which is
       * the safe direction. The same predicate is `isBoardDerived` in
       * `compliance-links.ts`; it is spelled out here rather than imported
       * because that module is a client one and a route handler must not pull
       * a `"use client"` file into the server graph.
       */
      editable: !(Boolean(entry.itemId) && Boolean(entry.slotKey)),
    }));

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
      expiryWindowDays: EXPIRY_DUE_SOON_DAYS,
      options: complianceFilterOptions(rows),
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
