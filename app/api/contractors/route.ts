/**
 * THE CONTRACTOR ROSTER OF ONE SECTION'S OWN REGISTER — W2.
 *
 * ── WHY THIS ROUTE EXISTS, AND WHY IT IS NOT A SECOND CONTRACTORS API ─────
 *
 * `GET /api/workspace` is a single unparameterised snapshot — sites, units,
 * compliance, contractors, planned work, team, settings and activity in one
 * response — with thirteen consumers. Adding a register parameter to it would
 * change what every one of them receives for a scope only the Contractors
 * screen can act on, so the scoped READ lives here instead and the snapshot
 * keeps meaning what it has always meant: the workspace's own canonical
 * registers.
 *
 * Nothing about what a contractor IS lives here. Writes stay in
 * `app/api/workspace/route.ts`, which owns ten refusal guards, the trade
 * folding, the pence coercion and the certification writer; they take a scope
 * argument rather than being copied. One implementation, told which register it
 * is working in — see the header of `app/lib/contractor-repository.ts`.
 *
 * ── THE SCOPE IS REQUIRED, AND THAT IS THE POINT ──────────────────────────
 *
 * A missing `section` is a 400, not the canonical roster. The canonical
 * Contractors screen reads the workspace snapshot and always has; this route
 * exists only to answer "what is in THAT register". Defaulting it to canonical
 * would put an implicit fallback on the one code path added to remove them —
 * the same shape as `boardIdFrom` answering every unknown key with the job
 * board, which is the defect W02-06 was written to close.
 *
 * ── WHAT A CONTRACTOR IN AN INSTANCE IS RELATED TO ────────────────────────
 *
 * Their jobs are counted BY CONTRACTOR ID and never by name. The snapshot adds
 * a second, name-matched tally for the canonical roster — jobs whose free-text
 * `contractor` names a row nobody linked — and that tally is correct there and
 * would be a leak here: a job on the canonical board naming "Apex Electrical"
 * would be attributed to an instance's own "Apex Electrical", which is a
 * different company that happens to share a name. Two registers holding one
 * name is explicitly allowed (see `contractorNameHolder`), so the name is not
 * an identifier across them.
 *
 * The honest consequence is that a new instance's contractors show zero jobs,
 * zero spend and no documents. That is not an empty state standing in for
 * missing work — it is the true answer. Nothing on the canonical job board
 * references an instance contractor's id, because those rows did not exist when
 * the work was filed.
 */

import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  attachments,
  contractorCertifications,
  maintenanceRequests,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { expiryStatus } from "../../lib/expiry-status";
import { listContractors } from "../../lib/contractor-repository";
import {
  SCOPE_PARAM,
  resolveRegisterScope,
  scopeRefusal,
} from "../../lib/register-scope";
import type { WorkspaceCertification, WorkspaceContractor } from "../../lib/workspace-data";

export const dynamic = "force-dynamic";

/** The same tolerant parse the snapshot uses for the legacy JSON columns. */
function parseStringArray(value: string | null) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [] as string[];
  }
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);

    const url = new URL(request.url);
    if (!url.searchParams.get(SCOPE_PARAM)) {
      return Response.json(
        {
          error:
            "Name the register to read. The workspace's own contractor register is part of the workspace snapshot; this route answers for a section's own register.",
        },
        { status: 400 },
      );
    }

    /*
     * Organisation from the SESSION, register from the DATABASE. An unknown
     * section, one belonging to another organisation, an archived one, or one
     * holding a different kind of register are each a refusal with the reason —
     * never a quiet fall back to the canonical roster.
     */
    const resolved = await resolveRegisterScope(db, orgId, url, "contractors");
    const refused = scopeRefusal(resolved);
    if (refused) return refused;
    if (!resolved.ok) return refused;
    const scope = resolved.scope;

    const includeInactive = url.searchParams.get("archived") === "all";
    const rows = await listContractors(db, orgId, { includeInactive: true }, scope);
    const ids = rows.map((row) => row.id);

    /*
     * BY ID, and only by id — see the header. Both tallies are empty for a new
     * instance, which is the true answer rather than a placeholder.
     */
    const [jobRows, documentRows, certificationRows] = ids.length
      ? await Promise.all([
          db
            .select({
              contractorId: maintenanceRequests.contractorId,
              assigned: count(),
              completed: sql<number>`sum(case when ${maintenanceRequests.stage} = 'Completed' then 1 else 0 end)`,
              urgent: sql<number>`sum(case when ${maintenanceRequests.priority} = 'Urgent' and ${maintenanceRequests.stage} <> 'Completed' then 1 else 0 end)`,
              spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
            })
            .from(maintenanceRequests)
            .where(
              and(
                eq(maintenanceRequests.organisationId, orgId),
                isNotNull(maintenanceRequests.contractorId),
                inArray(maintenanceRequests.contractorId, ids),
              ),
            )
            .groupBy(maintenanceRequests.contractorId),
          db
            .select({ contractorId: attachments.contractorId, total: count() })
            .from(attachments)
            .where(
              and(
                eq(attachments.organisationId, orgId),
                isNotNull(attachments.contractorId),
                inArray(attachments.contractorId, ids),
              ),
            )
            .groupBy(attachments.contractorId),
          db
            .select()
            .from(contractorCertifications)
            .where(
              and(
                eq(contractorCertifications.organisationId, orgId),
                inArray(contractorCertifications.contractorId, ids),
              ),
            )
            .orderBy(contractorCertifications.position, contractorCertifications.name),
        ])
      : [
          [] as Array<{
            contractorId: string | null;
            assigned: number;
            completed: number;
            urgent: number;
            spend: number;
          }>,
          [] as Array<{ contractorId: string | null; total: number }>,
          [] as Array<typeof contractorCertifications.$inferSelect>,
        ];

    const jobsById = new Map(jobRows.map((row) => [row.contractorId as string, row]));
    const documentsById = new Map(
      documentRows.map((row) => [row.contractorId as string, Number(row.total)]),
    );

    /* One instant for the whole payload, as the snapshot does: `new Date()`
       inside the loop drifts and can bucket two certificates that expire on the
       same day differently. */
    const classifiedAt = new Date();
    const certificationsById = new Map<string, WorkspaceCertification[]>();
    for (const row of certificationRows) {
      const status = expiryStatus(row.expiresOn, classifiedAt);
      const list = certificationsById.get(row.contractorId) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        reference: row.reference,
        issuedOn: row.issuedOn,
        expiresOn: row.expiresOn,
        notes: row.notes,
        position: row.position,
        expiryState: status.state,
        expiryLabel: status.label,
        daysRemaining: status.daysRemaining,
      });
      certificationsById.set(row.contractorId, list);
    }

    const payload: WorkspaceContractor[] = rows
      .filter((row) => includeInactive || row.active)
      .map((contractor) => {
        const jobs = jobsById.get(contractor.id);
        const insurance = expiryStatus(contractor.insuranceExpiry, classifiedAt);
        return {
          id: contractor.id,
          name: contractor.name,
          email: contractor.email,
          phone: contractor.phone,
          whatsappNumber: contractor.whatsappNumber,
          contactName: contractor.contactName,
          address: contractor.address,
          postcode: contractor.postcode,
          notes: contractor.notes,
          dayRatePence: contractor.dayRatePence,
          hourlyRatePence: contractor.hourlyRatePence,
          callOutCostPence: contractor.callOutCostPence,
          otherCostPence: contractor.otherCostPence,
          otherCostLabel: contractor.otherCostLabel,
          paymentTerms: contractor.paymentTerms,
          financeReference: contractor.financeReference,
          serviceCategories: parseStringArray(contractor.serviceCategories),
          coverageAreas: parseStringArray(contractor.coverageAreas),
          certifications: parseStringArray(contractor.certifications),
          certificationEntries: certificationsById.get(contractor.id) ?? [],
          insuranceExpiry: contractor.insuranceExpiry,
          insuranceState: insurance.state,
          insuranceStatusLabel: insurance.label,
          insurerName: contractor.insurerName,
          policyNumber: contractor.policyNumber,
          insuranceNotes: contractor.insuranceNotes,
          availability: contractor.availability,
          rating: contractor.rating,
          active: contractor.active,
          assignedJobs: Number(jobs?.assigned ?? 0),
          completedJobs: Number(jobs?.completed ?? 0),
          urgentJobs: Number(jobs?.urgent ?? 0),
          spend: Number(jobs?.spend ?? 0),
          documentCount: documentsById.get(contractor.id) ?? 0,
        };
      });

    return Response.json({
      contractors: payload,
      /* Echoed so the browser can prove it is looking at the register it asked
         for, rather than inferring it from the URL it typed. */
      section: resolved.sectionKey,
      scope,
    });
  } catch (error) {
    const denied = anonymousRefusal(error);
    if (denied) return denied;
    return Response.json(
      { error: "The contractor register is temporarily unavailable." },
      { status: 503 },
    );
  }
}
