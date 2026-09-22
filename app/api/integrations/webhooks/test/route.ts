/**
 * `POST /api/integrations/webhooks/test` `{ id }` — sends one `ping` to one
 * endpoint and reports what the receiver answered (§35b). `integrations.manage`.
 * A paused or switched-off endpoint is not sent to; resume it first.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { webhookEndpoints } from "../../../../../db/schema";
import { databaseSafeFailure } from "../../../../lib/database-failure";
import { sendTestEvent } from "../../../../lib/integrations/webhooks";
import { secretBoxStatus } from "../../../../lib/secret-box";
import { anonymousRefusal, scopedDbWithCapability } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "integrations.manage");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const storage = await secretBoxStatus();
    if (!storage.configured) {
      return Response.json({ error: `Nothing can be sent here: ${storage.reason}`, notConfigured: true }, { status: 409 });
    }
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    const [endpoint] = await db
      .select({ id: webhookEndpoints.id, state: webhookEndpoints.state })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.organisationId, orgId)))
      .limit(1);
    if (!endpoint || endpoint.state === "deleted") return Response.json({ error: "No such webhook in this workspace." }, { status: 404 });
    if (endpoint.state !== "on") return Response.json({ error: "This endpoint is not on. Resume it first." }, { status: 409 });
    return Response.json(await sendTestEvent(db, orgId, endpoint.id));
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const safe = databaseSafeFailure(error, "The test could not be sent.", 503);
    return Response.json({ error: safe.message }, { status: safe.status });
  }
}
