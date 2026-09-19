import { desc, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { notificationLog } from "../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { replayFailed } from "../../../lib/notifications";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/replay — the delivery log, newest first.
 *
 * `settings.edit`, the same capability the POST below already requires, and the
 * asymmetry it corrects was precise: replaying a notification was an operator
 * act, while READING the log — every address this workspace has ever notified,
 * every subject line, and every delivery error — asked for nothing beyond a
 * membership. A `client` could not retry a message but could enumerate the
 * recipients.
 *
 * Nothing in the product calls this route, so no screen loses anything; it is
 * reached by hand, by whoever is diagnosing delivery, and that is the person
 * `settings.edit` describes.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const rows = await db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.organisationId, orgId))
      .orderBy(desc(notificationLog.createdAt))
      .limit(100);

    return Response.json({
      notifications: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        event: row.event,
        recipient: row.recipient,
        subject: row.subject,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        deliveredAt: row.deliveredAt,
        createdAt: row.createdAt,
      })),
      // Anything failed or skipped is replayable — a missing API key produces
      // skipped rows that become sendable the moment the key is configured.
      replayable: rows.filter((row) => row.status === "failed" || row.status === "skipped").length,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The notification log is temporarily unavailable." },
      { status: 503 },
    );
  }
}

/** POST /api/notifications/replay — retry everything that failed or was skipped. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const result = await replayFailed(db, orgId);
    return Response.json(result);
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The replay is temporarily unavailable." },
      { status: 503 },
    );
  }
}
