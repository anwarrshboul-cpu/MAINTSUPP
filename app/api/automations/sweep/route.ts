/**
 * `POST /api/automations/sweep` — evaluate the time-based rules now.
 *
 * The same sweep `GET /api/automations` runs when a board opens, invoked on
 * purpose. `force: true` ignores the ten-minute interval and needs
 * `board.edit`, because it makes rules fire; without it the call is a read
 * that may do nothing, and `board.view` is enough.
 */

import { ensureDatabase } from "../../../../db/init";
import { automationContext, sweepTimeBasedRules } from "../../../lib/automations";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as { force?: unknown };
    const force = body.force === true;
    const guard = await scopedDbWithCapability(request, force ? "board.edit" : "board.view");
    if (guard.denied) return guard.denied;
    const outcome = await sweepTimeBasedRules(automationContext(guard.scope, request), { force });
    return Response.json(outcome);
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/automations/sweep]", error);
    return Response.json({ error: "The sweep could not run." }, { status: 503 });
  }
}
