import { and, desc, inArray, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import { maintenanceRequests, organisations } from "../../../../db/schema";
import { contractorScope } from "../../../lib/contractor-auth";
import { anonymousRefusal } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * GET /api/contractor/me — the signed-in contractor and THEIR jobs: every job
 * whose contractor is one of their records. No prices, no other contractors'
 * jobs, no client contact details beyond what the job itself shows them.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = await getDb();
    const scope = await contractorScope(db, request);
    if (!scope) return Response.json({ signedIn: false }, { status: 401 });
    const ids = scope.contractors.map((row) => row.id);
    const rows = await db
      .select({
        id: maintenanceRequests.id,
        organisationId: maintenanceRequests.organisationId,
        location: maintenanceRequests.location,
        description: maintenanceRequests.description,
        title: maintenanceRequests.title,
        status: maintenanceRequests.status,
        stage: maintenanceRequests.stage,
        priority: maintenanceRequests.priority,
        engineer: maintenanceRequests.engineer,
        requestedAt: maintenanceRequests.requestedAt,
        dueAt: maintenanceRequests.dueAt,
        completedAt: maintenanceRequests.completedAt,
        attachmentCount: maintenanceRequests.attachmentCount,
      })
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.contractorId, ids),
          isNull(maintenanceRequests.deletedAt),
          isNull(maintenanceRequests.parentId),
        ),
      )
      .orderBy(desc(maintenanceRequests.requestedAt))
      .limit(500);
    const orgIds = [...new Set(scope.contractors.map((row) => row.organisationId))];
    const orgRows = orgIds.length
      ? await db
          .select({ id: organisations.id, name: organisations.name })
          .from(organisations)
          .where(inArray(organisations.id, orgIds))
      : [];
    const orgName = new Map(orgRows.map((row) => [row.id, row.name]));
    return Response.json({
      signedIn: true,
      name: scope.name,
      jobs: rows.map(({ organisationId, ...job }) => ({ ...job, client: orgName.get(organisationId) ?? null })),
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Your jobs can't be loaded right now." }, { status: 503 });
  }
}
