/**
 * `POST /api/reports/schedules/run` — "Send now". §32.
 *
 * Runs ONE schedule immediately, through exactly the path the daily job uses
 * (`deliverScheduledReports`), as a separate occurrence, so it does not use up
 * the scheduled run. The answer is the real outcome: with email not configured
 * it says the report was prepared and not delivered, and why.
 */
import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { reportSchedules } from "../../../../../db/schema";
import { databaseSafeFailure } from "../../../../lib/database-failure";
import { publicOrigin } from "../../../../lib/public-origin";
import { deliverScheduledReports } from "../../../../lib/report-delivery";
import { anonymousRefusal, scopedDbWithCapability } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    const [schedule] = await scope.db
      .select({ id: reportSchedules.id })
      .from(reportSchedules)
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.organisationId, scope.orgId)))
      .limit(1);
    if (!schedule) return Response.json({ error: "Schedule not found." }, { status: 404 });
    const [outcome] = await deliverScheduledReports(scope.db, {
      origin: publicOrigin(request),
      organisationId: scope.orgId,
      scheduleId: id,
    });
    return Response.json({ outcome: outcome ?? null });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const safe = databaseSafeFailure(error, "The report could not be sent.", 503);
    return Response.json({ error: safe.message }, { status: safe.status });
  }
}
