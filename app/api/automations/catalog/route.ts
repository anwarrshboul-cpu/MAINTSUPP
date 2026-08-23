/**
 * `GET /api/automations/catalog` — every trigger and action, with availability.
 *
 * Availability is decided on the server from the environment, so the builder
 * cannot offer an email action on a workspace with no mail provider. The
 * board's columns and groups come from `/api/automations`, not here; this is
 * the vocabulary of rules, not of one board.
 */

import { ensureDatabase } from "../../../../db/init";
import { currentCatalog } from "../../../lib/automations/store";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    return Response.json(currentCatalog());
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The catalogue is temporarily unavailable." }, { status: 503 });
  }
}
