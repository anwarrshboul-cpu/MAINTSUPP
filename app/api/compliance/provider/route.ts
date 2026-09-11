/**
 * POST /api/compliance/provider — link (or unlink) the contractor RECORD that
 * renews one requirement, or many.
 *
 * ── WHAT IT IS, AND WHAT IT IS NOT ────────────────────────────────────────
 *
 * `compliance_documents.provider_contractor_id`: the service provider booked
 * to renew a certificate. It is not the duty holder (whose obligation it is —
 * client, landlord, shopping centre; `/api/compliance/responsibilities` sets
 * that) and it is not `issued_by`, the free text naming whoever issued the
 * certificate on file, which is kept exactly as written. A link is made by a
 * person, here; it is never inferred from a name that happens to match.
 *
 * ── WHY THIS ROUTE, AND NOT ONLY `PATCH /api/workspace` ──────────────────
 *
 * The workspace PATCH addresses a row by `compliance_documents.id`, so it cannot
 * reach a requirement the Store Documentation BOARD speaks for — those have no
 * annotation row until somebody makes one. This addresses a requirement the way
 * the register does (site × requirement name), exactly as the responsibilities
 * route does and for the same reasons, and creates the annotation row through
 * `ensureComplianceProfile` when there is none. The workspace PATCH accepts the
 * same field for register-only rows edited in "Manage register".
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 *
 * `sites.edit` — the capability every compliance write takes. The contractor
 * must be THIS organisation's (`resolveProviderContractor`, one 404 for "none"
 * and "another tenant's"), and every pair must already be a requirement on this
 * organisation's register inside the member's site scope; anything else is
 * refused rather than created. One activity-log line per site, naming the
 * contractor, so a link can be traced to who made it.
 */

import { and, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, complianceDocuments } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { readComplianceRegister } from "../../../lib/compliance-register";
import { ensureComplianceProfile } from "../../../lib/compliance-profile";
import { contractorNamesById, resolveProviderContractor } from "../../../lib/compliance-provider";
import { memberSiteSet, withinMemberScope } from "../../../lib/member-site-scope";
import { auditActor, recordAudit } from "../../../lib/audit";
import { chunkIds } from "../../../lib/sql-batching";

export const dynamic = "force-dynamic";

/** A blast radius, not a variable-cap number — the chunking handles any size. */
const MAX_RECORDS = 500;

type Pair = { siteId: string; kind: string };

const pairKey = (siteId: string, kind: string) => `${siteId}::${kind}`;

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId, siteScope } = guard.scope;

    const body = (await request.json().catch(() => null)) as
      | { contractorId?: unknown; records?: unknown }
      | null;
    if (!body || typeof body !== "object" || !("contractorId" in body)) {
      return Response.json(
        { error: "Send { contractorId, records: [{ siteId, kind }] } — contractorId null unlinks." },
        { status: 400 },
      );
    }

    const contractor = await resolveProviderContractor(db, orgId, body.contractorId);
    if (!contractor.ok) return Response.json({ error: contractor.error }, { status: contractor.status });
    const contractorId = contractor.id;

    const requested = Array.isArray(body.records) ? body.records : null;
    if (!requested || !requested.length) {
      return Response.json({ error: "Choose at least one requirement." }, { status: 400 });
    }
    if (requested.length > MAX_RECORDS) {
      return Response.json({ error: `Link at most ${MAX_RECORDS} requirements at once.` }, { status: 400 });
    }

    const pairs: Pair[] = [];
    const seen = new Set<string>();
    for (const entry of requested) {
      if (!entry || typeof entry !== "object") continue;
      const siteId = typeof (entry as Pair).siteId === "string" ? (entry as Pair).siteId : "";
      const kind = typeof (entry as Pair).kind === "string" ? (entry as Pair).kind : "";
      if (!siteId || !kind) continue;
      const key = pairKey(siteId, kind);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ siteId, kind });
    }
    if (!pairs.length) {
      return Response.json({ error: "Each requirement needs a site and a requirement name." }, { status: 400 });
    }

    /* THE ALLOW-LIST IS THE REGISTER, inside the member's sites. */
    const allowed = memberSiteSet(siteScope);
    const register = await readComplianceRegister(db, orgId, {});
    const known = new Set(
      register.entries
        .filter((entry) => withinMemberScope(allowed, entry.siteId))
        .map((entry) => pairKey(entry.siteId, entry.kind)),
    );
    const targets = pairs.filter((pair) => known.has(pairKey(pair.siteId, pair.kind)));
    const skipped = pairs.length - targets.length;
    if (!targets.length) {
      return Response.json({ error: "None of those requirements are on this register." }, { status: 404 });
    }

    const readStored = async () =>
      (await db
        .select({
          id: complianceDocuments.id,
          siteId: complianceDocuments.siteId,
          kind: complianceDocuments.kind,
          providerContractorId: complianceDocuments.providerContractorId,
        })
        .from(complianceDocuments)
        .where(eq(complianceDocuments.organisationId, orgId))) as Array<{
        id: string;
        siteId: string;
        kind: string;
        providerContractorId: string | null;
      }>;
    const byKey = (rows: Awaited<ReturnType<typeof readStored>>) => {
      /* A multimap: (site, kind) is not unique in this table, and every row for
         a pair gets the same answer — see the responsibilities route. */
      const map = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = pairKey(row.siteId, row.kind);
        const list = map.get(key);
        if (list) list.push(row);
        else map.set(key, [row]);
      }
      return map;
    };
    let storedByKey = byKey(await readStored());

    /* A board-derived requirement gets its annotation row when it is first
       linked — never when it is unlinked, which is already true of it. */
    let created = 0;
    const missing = targets.filter((pair) => !storedByKey.has(pairKey(pair.siteId, pair.kind)));
    if (contractorId !== null && missing.length) {
      const kindsBySite = new Map<string, string[]>();
      for (const pair of missing) {
        const list = kindsBySite.get(pair.siteId);
        if (list) list.push(pair.kind);
        else kindsBySite.set(pair.siteId, [pair.kind]);
      }
      for (const [siteId, kinds] of kindsBySite) {
        const result = await ensureComplianceProfile(db, orgId, siteId, { kinds });
        created += result.created.length;
      }
      storedByKey = byKey(await readStored());
    }

    const ids: string[] = [];
    const touchedSites = new Map<string, number>();
    let unchanged = 0;
    for (const pair of targets) {
      const rows = storedByKey.get(pairKey(pair.siteId, pair.kind)) ?? [];
      const changing = rows.filter((row) => (row.providerContractorId ?? null) !== contractorId);
      if (!changing.length) {
        unchanged += 1;
        continue;
      }
      for (const row of changing) ids.push(row.id);
      touchedSites.set(pair.siteId, (touchedSites.get(pair.siteId) ?? 0) + 1);
    }

    const now = new Date().toISOString();
    for (const chunk of chunkIds(ids)) {
      await db
        .update(complianceDocuments)
        .set({ providerContractorId: contractorId, updatedAt: now })
        .where(and(eq(complianceDocuments.organisationId, orgId), inArray(complianceDocuments.id, chunk)));
    }

    const contractorName = contractorId ? ((await contractorNamesById(db, orgId)).get(contractorId) ?? null) : null;
    for (const [siteId, count] of touchedSites) {
      await db.insert(activityLog).values({
        id: `activity-compliance-provider-${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        organisationId: orgId,
        entityType: "site",
        entityId: siteId,
        action: contractorId ? "compliance_provider_linked" : "compliance_provider_unlinked",
        actorEmail: actor.email,
        detail: JSON.stringify({ contractorId, contractorName, count }).slice(0, 4000),
      });
    }
    if (touchedSites.size) {
      const requirements = targets.length - unchanged;
      /* `recordAudit` never throws — an audit failure must not undo a saved link. */
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(guard.scope),
        action: contractorId ? "compliance.provider_linked" : "compliance.provider_unlinked",
        entityType: "compliance_requirement",
        entityId: contractorId ?? null,
        summary: contractorId
          ? `Linked ${contractorName ?? "a contractor"} as the renewal contractor on ${requirements} requirement(s) at ${touchedSites.size} site(s).`
          : `Unlinked the renewal contractor from ${requirements} requirement(s) at ${touchedSites.size} site(s).`,
        detail: { contractorId, contractorName, requirements, sites: [...touchedSites.keys()] },
        request,
      });
    }

    return Response.json({
      ok: true,
      contractorId,
      contractorName,
      updated: targets.length - unchanged,
      rowsWritten: ids.length,
      created,
      unchanged,
      skipped,
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
            : "That renewal contractor could not be saved.",
      },
      { status: 503 },
    );
  }
}
