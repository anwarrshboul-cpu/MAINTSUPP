/**
 * `/api/reports/schedules` — reports emailed on a schedule. §32.
 *
 * `data.export`, the capability that already governs taking the Reports figures
 * out of the portal. Recipients are MEMBERS of this workspace, chosen by id; a
 * typed address is not accepted, so a schedule cannot be pointed at somebody
 * outside the workspace. Each recipient's figures are computed under their own
 * access when it runs — see `app/lib/report-delivery.ts`.
 *
 * GET also says whether email would actually be delivered on this deployment
 * (`emailDelivery`), so the screen can say so before anybody waits for a report
 * that is never going to arrive.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { memberships, reportDispatches, reportSchedules, users } from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import { databaseSafeFailure } from "../../../lib/database-failure";
import { emailDeliveryStatus } from "../../../lib/notifications";
import { can, resolvePermissions } from "../../../lib/permissions";
import { nextRunOn, REPORT_PERIODS, validateSchedule } from "../../../lib/report-schedule-rules";
import { anonymousRefusal, scopedDbWithCapability, type ScopedDatabase } from "../../../lib/tenant-db";
import { everySiteRefusal } from "../../../lib/job-site-scope";
import { moduleRefusal } from "../../../lib/module-guard";

export const dynamic = "force-dynamic";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function failure(error: unknown, fallback: string) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const safe = databaseSafeFailure(error, fallback, 503);
  return Response.json({ error: safe.message }, { status: safe.status });
}

/** Active members of this workspace, by id — the only people a report may go to. */
async function members(scope: ScopedDatabase) {
  return scope.db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organisationId, scope.orgId), eq(memberships.status, "active"), eq(users.active, true)))
    .orderBy(asc(users.fullName));
}

function expose(row: typeof reportSchedules.$inferSelect) {
  let recipients: string[] = [];
  try {
    recipients = JSON.parse(row.recipients);
  } catch {
    recipients = [];
  }
  return {
    id: row.id,
    name: row.name,
    period: row.period,
    periodLabel: REPORT_PERIODS[row.period as keyof typeof REPORT_PERIODS] ?? row.period,
    cadence: row.cadence,
    weekday: row.weekday,
    monthDay: row.monthDay,
    recipients,
    state: row.state,
    nextRunOn: row.nextRunOn,
    lastRunOn: row.lastRunOn,
    lastOutcome: row.lastOutcome,
    lastDetail: row.lastDetail,
    createdByEmail: row.createdByEmail,
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal(guard.scope, "reports");
    if (switchedOff) return switchedOff;
    const everySite = everySiteRefusal(guard.scope.siteScope, "a scheduled report");
    if (everySite) return everySite;
    const scope = guard.scope;
    const rows = await scope.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.organisationId, scope.orgId))
      .orderBy(desc(reportSchedules.createdAt));
    /* Colleagues' addresses follow the directory's rule (Phase 9): a name is
       enough to choose somebody; an address needs `users.view`. */
    const mayReadAddresses = can(await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope), "users.view");
    const people = await members(scope);
    return Response.json({
      schedules: rows.map(expose),
      recipientsAvailable: people.map((person) => ({
        id: person.id,
        name: person.fullName?.trim() || (mayReadAddresses ? person.email : "Unnamed member"),
        email: mayReadAddresses ? person.email : null,
      })),
      emailDelivery: emailDeliveryStatus(),
    });
  } catch (error) {
    return failure(error, "Scheduled reports could not be loaded.");
  }
}

async function recipientsRefusal(scope: ScopedDatabase, encoded: unknown) {
  if (typeof encoded !== "string") return null;
  const ids = JSON.parse(encoded) as string[];
  const allowed = new Set((await members(scope)).map((person) => person.id));
  const outsider = ids.find((id) => !allowed.has(id));
  return outsider
    ? Response.json({ error: "Reports can only be sent to active members of this workspace." }, { status: 400 })
    : null;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal(guard.scope, "reports");
    if (switchedOff) return switchedOff;
    const everySite = everySiteRefusal(guard.scope.siteScope, "a scheduled report");
    if (everySite) return everySite;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const checked = validateSchedule(body, null);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const refused = await recipientsRefusal(scope, checked.fields.recipients);
    if (refused) return refused;
    const fields = checked.fields as Record<string, unknown>;
    const id = `rsch_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    await scope.db.insert(reportSchedules).values({
      id,
      organisationId: scope.orgId,
      name: String(fields.name),
      period: String(fields.period),
      cadence: String(fields.cadence),
      weekday: (fields.weekday as number | null | undefined) ?? null,
      monthDay: (fields.monthDay as number | null | undefined) ?? null,
      recipients: String(fields.recipients),
      state: String(fields.state ?? "active"),
      nextRunOn: nextRunOn(
        { cadence: String(fields.cadence), weekday: fields.weekday as number | null, monthDay: fields.monthDay as number | null },
        today(),
      ),
      createdByUserId: scope.session?.user.id ?? null,
      createdByEmail: scope.identityEmail ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report_schedule.created",
      entityType: "report_schedule",
      entityId: id,
      summary: `Scheduled the report "${String(fields.name)}".`,
      detail: { cadence: fields.cadence, period: fields.period },
      request,
    });
    const [row] = await scope.db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).limit(1);
    return Response.json({ schedule: row ? expose(row) : null }, { status: 201 });
  } catch (error) {
    return failure(error, "The schedule could not be saved.");
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal(guard.scope, "reports");
    if (switchedOff) return switchedOff;
    const everySite = everySiteRefusal(guard.scope.siteScope, "a scheduled report");
    if (everySite) return everySite;
    const scope = guard.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    const [existing] = await scope.db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.organisationId, scope.orgId)))
      .limit(1);
    if (!existing) return Response.json({ error: "Schedule not found." }, { status: 404 });
    const checked = validateSchedule(body, existing);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const refused = await recipientsRefusal(scope, checked.fields.recipients);
    if (refused) return refused;
    const fields = checked.fields as Record<string, unknown>;
    const rule = {
      cadence: String(fields.cadence ?? existing.cadence),
      weekday: ("weekday" in fields ? fields.weekday : existing.weekday) as number | null,
      monthDay: ("monthDay" in fields ? fields.monthDay : existing.monthDay) as number | null,
    };
    const ruleChanged = "cadence" in fields || "weekday" in fields || "monthDay" in fields;
    const resumed = fields.state === "active" && existing.state !== "active";
    await scope.db
      .update(reportSchedules)
      .set({
        ...(fields as Partial<typeof reportSchedules.$inferInsert>),
        ...(ruleChanged || resumed ? { nextRunOn: nextRunOn(rule, today()) } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.organisationId, scope.orgId)));
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report_schedule.updated",
      entityType: "report_schedule",
      entityId: id,
      summary: `Changed the scheduled report "${existing.name}".`,
      detail: { fields: Object.keys(fields) },
      request,
    });
    const [row] = await scope.db.select().from(reportSchedules).where(eq(reportSchedules.id, id)).limit(1);
    return Response.json({ schedule: row ? expose(row) : null });
  } catch (error) {
    return failure(error, "The schedule could not be changed.");
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "data.export");
    if (guard.denied) return guard.denied;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal(guard.scope, "reports");
    if (switchedOff) return switchedOff;
    const everySite = everySiteRefusal(guard.scope.siteScope, "a scheduled report");
    if (everySite) return everySite;
    const scope = guard.scope;
    const id = (new URL(request.url).searchParams.get("id") ?? "").slice(0, 80);
    const [existing] = await scope.db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.organisationId, scope.orgId)))
      .limit(1);
    if (!existing) return Response.json({ error: "Schedule not found." }, { status: 404 });
    /* A schedule is somebody's own setting, not operational data: removing it
       removes its run records with it, and the audit row keeps the fact. */
    await scope.db.delete(reportDispatches).where(and(eq(reportDispatches.scheduleId, id), eq(reportDispatches.organisationId, scope.orgId)));
    await scope.db.delete(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.organisationId, scope.orgId)));
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report_schedule.deleted",
      entityType: "report_schedule",
      entityId: id,
      summary: `Deleted the scheduled report "${existing.name}".`,
      detail: null,
      request,
    });
    return Response.json({ deleted: true });
  } catch (error) {
    return failure(error, "The schedule could not be deleted.");
  }
}

