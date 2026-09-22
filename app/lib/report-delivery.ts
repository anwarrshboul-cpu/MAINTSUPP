/**
 * SENDING SCHEDULED REPORTS — §32.
 *
 * For every schedule that is due (or one named by "Send now"):
 *
 *   1. CLAIM the run in `report_dispatches` under UNIQUE (schedule, occurrence),
 *      so a run that overlaps another — the daily job and a manual press, two
 *      instances — sends once.
 *   2. The schedule's OWNER must still be a member who may export reports
 *      (`data.export`). If not, the run is refused and the schedule paused, with
 *      the reason on it: a schedule must not outlive the permission that made it.
 *   3. For EACH RECIPIENT, separately: still an active member, still allowed to
 *      open the board (`board.view`), and the figures are computed under THEIR
 *      site restriction by `loadReportsSnapshot` — the loader the Reports page
 *      itself uses. Nobody is emailed a figure they could not open.
 *   4. Send through `sendNotification`, the one door every email uses, and
 *      record exactly what it returned. With email not configured the run is
 *      recorded as NOT DELIVERED with the reason (owner decision Q1) — never as
 *      "sent".
 *
 * The daily job calls this across every workspace; each schedule carries its
 * own `organisation_id` and every read below is scoped to it.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  memberships,
  organisations,
  platformAdmins,
  reportDispatches,
  reportSchedules,
  users,
} from "../../db/schema";
import type { getDb } from "../../db";
import { poundsText } from "./finance/exports";
import { emailDeliveryStatus, reportDigestTemplate, sendNotification } from "./notifications";
import { can, resolvePermissions } from "./permissions";
import { nextRunOn, periodWindow, REPORT_PERIODS, type ReportPeriod } from "./report-schedule-rules";
import { loadReportsSnapshot } from "./reports-metrics";
import { parseSiteScope } from "./tenant-grants";
import type { WorkspaceRole } from "./workspace-actor";

type Database = Awaited<ReturnType<typeof getDb>>;

export type DeliveryOutcome = {
  scheduleId: string;
  organisationId: string;
  occurrence: string;
  outcome: "sent" | "not-delivered" | "partial" | "failed" | "refused" | "skipped";
  detail: string;
  recipients: number;
};

type Access = { role: WorkspaceRole; siteScope: string[] | null } | null;

/** A person's access in one workspace: their membership, or platform authority. */
async function accessOf(db: Database, organisationId: string, userId: string): Promise<Access> {
  const [member] = await db
    .select({ role: memberships.role, siteScope: memberships.siteScope })
    .from(memberships)
    .where(and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId), eq(memberships.status, "active")))
    .limit(1);
  if (member) return { role: member.role as WorkspaceRole, siteScope: parseSiteScope(member.siteScope) };
  const [platform] = await db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(and(eq(platformAdmins.userId, userId), eq(platformAdmins.status, "active")))
    .limit(1);
  return platform ? { role: "super_admin" as WorkspaceRole, siteScope: null } : null;
}

async function may(db: Database, organisationId: string, access: Access, capability: "data.export" | "board.view") {
  if (!access) return false;
  return can(await resolvePermissions(db, organisationId, access.role, access.siteScope), capability);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function deliverScheduledReports(
  db: Database,
  options: {
    /** The site's own address, for the link in the email. */
    origin: string;
    organisationId?: string;
    /** "Send now": this schedule, whatever its next run day. */
    scheduleId?: string;
    day?: string;
  },
): Promise<DeliveryOutcome[]> {
  const runDay = options.day ?? today();
  const manual = Boolean(options.scheduleId);
  const conditions = manual
    ? [eq(reportSchedules.id, options.scheduleId!)]
    : [eq(reportSchedules.state, "active"), lte(reportSchedules.nextRunOn, runDay)];
  if (options.organisationId) conditions.push(eq(reportSchedules.organisationId, options.organisationId));
  const due = await db.select().from(reportSchedules).where(and(...conditions));
  const delivery = emailDeliveryStatus();
  const outcomes: DeliveryOutcome[] = [];

  for (const schedule of due) {
    const organisationId = schedule.organisationId;
    const occurrence = manual ? `manual:${new Date().toISOString()}` : schedule.nextRunOn ?? runDay;
    const base = { scheduleId: schedule.id, organisationId, occurrence };

    const [claimed] = await db
      .insert(reportDispatches)
      .values({
        id: `rdsp_${crypto.randomUUID().replace(/-/g, "")}`,
        organisationId,
        scheduleId: schedule.id,
        occurrence,
        status: "claimed",
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: reportDispatches.id });
    if (!claimed) {
      outcomes.push({ ...base, outcome: "skipped", detail: "Already sent for this day.", recipients: 0 });
      continue;
    }

    const finish = async (outcome: DeliveryOutcome["outcome"], detail: string, recipients: number, pause = false) => {
      await db.update(reportDispatches).set({ status: outcome, detail }).where(eq(reportDispatches.id, claimed.id));
      await db
        .update(reportSchedules)
        .set({
          lastRunOn: runDay,
          lastOutcome: outcome,
          lastDetail: detail.slice(0, 500),
          ...(pause ? { state: "paused" } : {}),
          ...(!manual ? { nextRunOn: nextRunOn(schedule, schedule.nextRunOn ?? runDay) ?? null } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(reportSchedules.id, schedule.id), eq(reportSchedules.organisationId, organisationId)));
      outcomes.push({ ...base, outcome, detail, recipients });
    };

    try {
      /* 2. The owner's permission, now — not the day it was created. */
      const owner = schedule.createdByUserId ? await accessOf(db, organisationId, schedule.createdByUserId) : null;
      if (!(await may(db, organisationId, owner, "data.export"))) {
        await finish("refused", "The person who set this schedule up can no longer export reports here, so it has been paused.", 0, true);
        continue;
      }

      const window = periodWindow(schedule.period, runDay);
      if (!window) {
        await finish("refused", "The schedule's period is not one the report understands.", 0, true);
        continue;
      }
      const [workspace] = await db
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

      let ids: string[] = [];
      try {
        const parsed = JSON.parse(schedule.recipients);
        ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
      } catch {
        ids = [];
      }
      const people = ids.length
        ? await db
            .select({ id: users.id, email: users.email, active: users.active })
            .from(users)
            .where(inArray(users.id, ids))
        : [];

      const statuses: string[] = [];
      const reasons: string[] = [];
      for (const person of people) {
        /* 3. Each recipient's own access, today. */
        if (person.active === false || !person.email) {
          reasons.push("a recipient's account is no longer active");
          continue;
        }
        const access = await accessOf(db, organisationId, person.id);
        if (!(await may(db, organisationId, access, "board.view"))) {
          reasons.push(`${person.email} can no longer open this workspace's reports`);
          continue;
        }
        const { metrics } = await loadReportsSnapshot(db, organisationId, access!.siteScope, window);
        const email = reportDigestTemplate({
          scheduleName: schedule.name,
          workspaceName: workspace?.name ?? "Your workspace",
          periodLabel: REPORT_PERIODS[schedule.period as ReportPeriod] ?? schedule.period,
          rangeLabel: metrics.range.label,
          figures: [
            ...metrics.kpis.map((kpi) => ({ label: kpi.label, value: `${poundsText(kpi.pence)} · ${kpi.jobs} job${kpi.jobs === 1 ? "" : "s"}` })),
            { label: metrics.other.label, value: poundsText(metrics.other.pence) },
            { label: metrics.unclassified.label, value: poundsText(metrics.unclassified.pence) },
          ],
          topSites: metrics.topSites.rows.slice(0, 5).map((site) => ({ name: site.name, value: poundsText(site.pence) })),
          link: `${options.origin}/dashboard/reports?from=${window.from}&to=${window.to}`,
        });
        /* 4. The one door every email uses; what it returned is what is recorded. */
        const sent = await sendNotification(db, {
          organisationId,
          channel: "email",
          event: "report.scheduled",
          subjectType: "report",
          subjectId: schedule.id,
          to: person.email,
          subject: email.subject,
          body: email.body,
        });
        statuses.push(sent.status);
        /* §33 — a person's own switch or the duplicate guard is about THIS
           recipient, not the deployment, so it is named rather than folded into
           the deployment-wide reason below. */
        if (sent.suppressedBy === "preference") reasons.push(`${person.email} has switched off report emails`);
        if (sent.suppressedBy === "duplicate") reasons.push(`${person.email} already had this report in the last 10 minutes`);
      }
      for (const missing of ids.filter((id) => !people.some((person) => person.id === id))) {
        reasons.push(`recipient ${missing.slice(0, 12)}… no longer exists`);
      }

      const sentCount = statuses.filter((s) => s === "sent").length;
      const failedCount = statuses.filter((s) => s === "failed").length;
      const undelivered = statuses.length - sentCount - failedCount;
      const note = reasons.length ? ` Not sent to everyone: ${reasons.join("; ")}.` : "";
      if (!statuses.length) {
        await finish("refused", `Nobody on the list may receive it.${note}`, 0);
      } else if (failedCount) {
        await finish(sentCount ? "partial" : "failed", `${sentCount} sent, ${failedCount} failed; see the notification log.${note}`, statuses.length);
      } else if (undelivered && !sentCount) {
        await finish("not-delivered", `${delivery.reason ?? "Email was not delivered."} The report was prepared for ${undelivered} recipient${undelivered === 1 ? "" : "s"}.${note}`, statuses.length);
      } else if (undelivered) {
        await finish("partial", `${sentCount} sent, ${undelivered} not delivered.${note}`, statuses.length);
      } else {
        await finish(reasons.length ? "partial" : "sent", `Sent to ${sentCount} recipient${sentCount === 1 ? "" : "s"}.${note}`, statuses.length);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finish("failed", `The report could not be prepared: ${message.slice(0, 200)}`, 0).catch(() => {});
    }
  }
  return outcomes;
}
