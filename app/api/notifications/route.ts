import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { activityLog, jobStatusMap, maintenanceRequests } from "../../../db/schema";
import { closedJobSql, closedJobSqlFor } from "../../lib/dashboard-aggregates";
import { closedStatusKeys } from "../../lib/job-metrics";
import { liveWorkOrderCondition } from "../../lib/dashboard-filters";
import { memberSiteCondition } from "../../lib/member-site-scope";
import { exposeRequest } from "../../lib/request-payload";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

type NotificationState = "read" | "dismissed";

function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (process.env.NODE_ENV === "development") {
    return `Preview database error: ${message}`;
  }
  return "Notification preferences are temporarily unavailable.";
}

function exposeStates(
  rows: (typeof activityLog.$inferSelect)[],
) {
  const latest = new Map<
    string,
    { requestId: string; state: NotificationState; updatedAt: string }
  >();

  for (const row of rows) {
    if (latest.has(row.entityId)) continue;
    const state = row.action.replace("notification.", "");
    if (state !== "read" && state !== "dismissed") continue;
    latest.set(row.entityId, {
      requestId: row.entityId,
      state,
      updatedAt: row.createdAt,
    });
  }

  return Array.from(latest.values());
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { actor, db, orgId, siteScope } = await scopedDb(request);
    const rowsRead = db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "notification"),
          eq(activityLog.actorEmail, actor.email),
          eq(activityLog.organisationId, orgId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(500);

    /*
     * THE BELL'S OWN JOBS, AND THE SIDEBAR'S OPEN COUNT.
     *
     * The shell built both from the full job list, which it downloads only on
     * the screens that draw jobs (`JOB_LIST_SURFACES`). The Overview, the page
     * everybody lands on, is not one of them, so its bell said "You're all
     * caught up" over two jobs needing attention, and the Jobs badge was blank.
     * The same rule as `notificationCandidates` in the shell (open, and in
     * Attention or Urgent) and the same scope as the job feed (live work
     * orders on the Jobs board, the member's sites), so the two never differ.
     */
    /* The workspace's own "counts as open" settings, as the Overview applies
       them (2026-10-06); the shipped vocabulary when none are configured. */
    const statusRows = await db
      .select({ label: jobStatusMap.sourceStatusLabel, open: jobStatusMap.countsAsOpen })
      .from(jobStatusMap)
      .where(and(eq(jobStatusMap.organisationId, orgId), eq(jobStatusMap.active, true)));
    const closedSql = statusRows.length
      ? closedJobSqlFor(
          closedStatusKeys(
            statusRows.map((row) => ({ sourceStatusLabel: String(row.label ?? ""), countsAsOpen: Boolean(row.open) })),
          ),
        )
      : closedJobSql;
    const open = and(
      liveWorkOrderCondition(orgId),
      memberSiteCondition(maintenanceRequests.siteId, siteScope),
      sql`not ${closedSql}`,
    );
    /* Three independent reads, started together: one round trip, not three. */
    const [rows, candidates, [openRow]] = await Promise.all([
      rowsRead,
      db
        .select()
        .from(maintenanceRequests)
        .where(and(open, or(eq(maintenanceRequests.stage, "Attention"), eq(maintenanceRequests.priority, "Urgent"))))
        .orderBy(desc(maintenanceRequests.requestedAt))
        .limit(100),
      db.select({ total: count() }).from(maintenanceRequests).where(open),
    ]);

    return Response.json({
      states: exposeStates(rows),
      candidates: candidates.map((row) => exposeRequest(row)),
      openJobs: Number(openRow?.total ?? 0),
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const { actor, db, orgId } = await scopedDb(request);
    const payload = (await request.json()) as Record<string, unknown>;
    const state = payload.state;
    const requestIds = Array.isArray(payload.requestIds)
      ? Array.from(
          new Set(
            payload.requestIds
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().slice(0, 40))
              .filter(Boolean),
          ),
        ).slice(0, 100)
      : [];

    if ((state !== "read" && state !== "dismissed") || !requestIds.length) {
      return Response.json(
        { error: "A valid notification action and request ID are required." },
        { status: 400 },
      );
    }

    const createdAt = new Date().toISOString();

    for (const requestId of requestIds) {
      await db.insert(activityLog).values({
        id: crypto.randomUUID(),
        organisationId: orgId,
        entityType: "notification",
        entityId: requestId,
        action: `notification.${state}`,
        actorEmail: actor.email,
        detail: null,
        createdAt,
      });
    }

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "notification"),
          eq(activityLog.actorEmail, actor.email),
          eq(activityLog.organisationId, orgId),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(500);

    return Response.json({ states: exposeStates(rows) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}
