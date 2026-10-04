import { and, eq, inArray, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../../../db/init";
import { getDb } from "../../../../../../db";
import { maintenanceRequests } from "../../../../../../db/schema";
import { contractorScope } from "../../../../../lib/contractor-auth";
import { createJobToken } from "../../../../../lib/job-tokens";
import { anonymousRefusal } from "../../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * POST /api/contractor/jobs/:id/open — the job's full page for a signed-in
 * contractor. Mints an ordinary contractor job link (the same /j page with
 * photos, uploads, notes, completion and signature), but only for a job that
 * is assigned to them right now.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    const db = await getDb();
    const scope = await contractorScope(db, request);
    if (!scope) return Response.json({ error: "Sign in to continue." }, { status: 401 });
    const { id } = await params;
    const ids = scope.contractors.map((row) => row.id);
    const [job] = await db
      .select({ id: maintenanceRequests.id, organisationId: maintenanceRequests.organisationId })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, id),
          inArray(maintenanceRequests.contractorId, ids),
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .limit(1);
    if (!job) return Response.json({ error: "That job isn't assigned to you." }, { status: 404 });
    const { token } = await createJobToken(db, {
      organisationId: job.organisationId,
      requestId: job.id,
      audience: "contractor",
      label: `Contractor app · ${scope.name}`.slice(0, 80),
      expiryDays: 30,
      createdBy: `contractor-app:${scope.sessionId}`,
    });
    return Response.json({ url: `/j/${token}`, token });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "That job can't be opened right now." }, { status: 503 });
  }
}
