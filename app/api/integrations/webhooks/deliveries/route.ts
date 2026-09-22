/**
 * `/api/integrations/webhooks/deliveries` — one endpoint's delivery log, and
 * the Retry button (§35b). `integrations.manage`.
 *
 * GET   `?endpointId=` → the latest 50 deliveries: event, status, attempts,
 *       when the next try is due, the receiver's status code and the fixed
 *       reason a try failed. Never the payload's destination.
 * POST  `{ id }` → try this delivery again now, whatever its schedule — a
 *       failed one or an abandoned one alike.
 */

import { and, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { webhookDeliveries } from "../../../../../db/schema";
import { databaseSafeFailure } from "../../../../lib/database-failure";
import { attemptDelivery, listDeliveries } from "../../../../lib/integrations/webhooks";
import { anonymousRefusal, scopedDbWithCapability } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const safe = databaseSafeFailure(error, fallback, 503);
  return Response.json({ error: safe.message }, { status: safe.status });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const endpointId = (new URL(request.url).searchParams.get("endpointId") ?? "").slice(0, 80);
    if (!endpointId) return Response.json({ error: "Say which endpoint." }, { status: 400 });
    return Response.json({ deliveries: await listDeliveries(db, orgId, endpointId) });
  } catch (error) {
    return failure(error, "The delivery log is temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    /* Back into the queue, due now — only this workspace's, only if not
       already delivered or in flight. */
    const [requeued] = await db
      .update(webhookDeliveries)
      .set({ status: "pending", nextAttemptAt: Date.now(), claimedUntil: 0, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.organisationId, orgId),
          inArray(webhookDeliveries.status, ["failed", "abandoned", "pending"]),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    if (!requeued) return Response.json({ error: "No delivery here that can be retried." }, { status: 404 });
    const outcome = await attemptDelivery(db, id, orgId);
    const [row] = await db
      .select({ status: webhookDeliveries.status, responseStatus: webhookDeliveries.responseStatus, error: webhookDeliveries.error })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.organisationId, orgId)))
      .limit(1);
    return Response.json({ outcome, delivery: row ?? null });
  } catch (error) {
    return failure(error, "The delivery could not be retried.");
  }
}
