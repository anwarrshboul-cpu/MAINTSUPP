/**
 * GET /api/compliance/records — the rows inside expanded groups.
 *
 * Called on EXPAND, not on load. The collapsed register draws entirely from
 * `/api/compliance/summary`, so opening the page costs ten group headers rather
 * than 748 records — which is the whole point of the rebuild, and the reason
 * this endpoint takes a group key rather than returning everything.
 *
 * `group=site` (default) returns the records for one or more sites.
 * `group=kind` inverts it and returns every site's record for one requirement,
 * which is what answers "which stores are missing their emergency lighting
 * certificate?" — a question the flat list could not answer at all without
 * reading all 748 rows.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { sites } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { memberSiteSet, withinMemberScope } from "../../../lib/member-site-scope";
import { readComplianceRegister } from "../../../lib/compliance-register";
import {
  filterComplianceRows,
  parseComplianceFilters,
  responsibilityFor,
  sortComplianceRecords,
  type ComplianceRow,
} from "../../../lib/compliance-view";
import { NO_DUE_DATE } from "../../../lib/compliance-status";

export const dynamic = "force-dynamic";

/** How many records one request may carry. `Show all 37` asks for the rest. */
const PAGE = 200;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.scope;
    /* Inside the member's authorised sites, exactly as the summary route draws
       the group headers these records expand. A `key=` naming a site outside
       the scope matches nothing: the id is not a capability. */
    const allowed = memberSiteSet(siteScope);

    const url = new URL(request.url);
    const filters = parseComplianceFilters(url);
    const groupBy = url.searchParams.get("group") === "kind" ? "kind" : "site";
    const keys = url.searchParams.getAll("key").map((key) => key.trim()).filter(Boolean);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit")) || PAGE, 1),
      1000,
    );
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    const today = new Date();
    const [register, siteRows] = await Promise.all([
      readComplianceRegister(db, orgId, { today }),
      /*
       * Managers, for the responsibility fallback.
       *
       * `storeDocumentationResponsibility` names the third party for the twelve
       * board slots; anything an admin added themselves falls back to the store
       * manager, and without this query that fallback had nothing to fall back
       * to. Two columns because the estate writes the manager into either of
       * them depending on how the row was created.
       */
      db
        .select({ id: sites.id, manager: sites.manager, managerName: sites.managerName })
        .from(sites)
        .where(and(eq(sites.organisationId, orgId))),
    ]);

    const managerById = new Map(
      siteRows.map((row) => [row.id, (row.managerName || row.manager || "").trim()]),
    );

    const scopedEntries = allowed
      ? register.entries.filter((entry) => withinMemberScope(allowed, entry.siteId))
      : register.entries;
    const rows: ComplianceRow[] = scopedEntries.map((entry) => ({
      id: entry.id,
      siteId: entry.siteId,
      siteName: entry.siteName,
      kind: entry.kind,
      responsibility: responsibilityFor(entry.kind, managerById.get(entry.siteId) ?? ""),
      /* Whose obligation it is, which is a different question from who chases
         it — and the one the percentage depends on. See ComplianceRow. */
      dutyHolder: entry.dutyHolder,
      state: entry.state,
      expiry: entry.expiry,
      fileCount: entry.fileCount,
      editable: !(Boolean(entry.itemId) && Boolean(entry.slotKey)),
    }));

    const filtered = filterComplianceRows(rows, filters, today);
    const wanted = keys.length
      ? filtered.filter((row) => keys.includes(groupBy === "kind" ? row.kind : row.siteId))
      : filtered;
    const ordered = sortComplianceRecords(wanted);

    return Response.json({
      group: groupBy,
      total: ordered.length,
      offset,
      hasMore: offset + limit < ordered.length,
      /*
       * `NO_DUE_DATE` travels with the payload rather than being typed into the
       * component, so the register, the site detail and the contractor's
       * document list all print the same words where a date is absent. An em
       * dash reads as a rendering fault; readers have reported it as one.
       */
      noDueDateLabel: NO_DUE_DATE,
      records: ordered.slice(offset, offset + limit),
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
