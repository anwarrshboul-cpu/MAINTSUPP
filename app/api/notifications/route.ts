import { and, desc, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { activityLog } from "../../../db/schema";
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
    const { actor, db, orgId } = await scopedDb(request);
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
