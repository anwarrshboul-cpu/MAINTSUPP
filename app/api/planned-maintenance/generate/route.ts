/**
 * `POST /api/planned-maintenance/generate` — "Create due visits now". §25.
 *
 * The same generator the daily cron runs, for THIS workspace only, and only
 * over the schedules the caller could edit: `sites.edit` is the capability
 * that already governs planned maintenance (`app/api/workspace/route.ts`
 * gates the planned register on it), and a site-restricted member's run is
 * confined to their own sites. It creates only what the schedules say is due
 * — an active schedule whose lead window has opened — so pressing it early is
 * a no-op, and pressing it twice cannot duplicate a visit: the claim index
 * decides, not this handler.
 *
 * Optional body `{ scheduleId }` narrows the run to one schedule.
 */
import { ensureDatabase } from "../../../../db/init";
import { auditActor, recordAudit } from "../../../lib/audit";
import { databaseSafeFailure } from "../../../lib/database-failure";
import { generatePlannedOccurrences } from "../../../lib/planned-generation";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { moduleRefusal } from "../../../lib/module-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    /* Planned's own operation inside a shared family: this is gated, the family
       is not — see `module-guard.ts`. */
    const switchedOff = await moduleRefusal(guard.scope, "calendar");
    if (switchedOff) return switchedOff;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as { scheduleId?: unknown };
    const scheduleId =
      typeof body.scheduleId === "string" && body.scheduleId.trim() ? body.scheduleId.trim().slice(0, 160) : null;

    const report = await generatePlannedOccurrences(scope.db, {
      organisationId: scope.orgId,
      siteScope: scope.siteScope,
      scheduleIds: scheduleId ? [scheduleId] : undefined,
    });

    if (report.created > 0 || report.failed > 0) {
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "planned.generated",
        entityType: "planned_maintenance",
        entityId: scheduleId ?? scope.orgId,
        summary: `Created ${report.created} planned visit job${report.created === 1 ? "" : "s"}${report.failed ? `; ${report.failed} failed` : ""}.`,
        detail: {
          created: report.outcomes.filter((o) => o.result === "created").map((o) => ({ scheduleId: o.scheduleId, dueDate: o.dueDate, requestId: o.requestId })),
          failed: report.outcomes.filter((o) => o.result === "failed").map((o) => ({ scheduleId: o.scheduleId, reason: o.reason })),
        },
        request,
      });
    }
    return Response.json(report);
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const failure = databaseSafeFailure(error, "Planned visits could not be created.", 503);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
