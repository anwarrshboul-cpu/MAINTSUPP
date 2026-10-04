import { getDb } from "../../../../../db";
import { ensureDatabase } from "../../../../../db/init";
import { mondaySyncConfig, mondayWebhookKey, syncMondayItems } from "../../../../lib/monday-live-sync";
import { anonymousRefusal } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * `POST /api/integrations/monday/webhook?key=…` — monday.com calls this the
 * moment an item on Sunnamusk's Maintenance board changes (owner, 2026-10-04).
 *
 *   - monday's handshake (`{ challenge }`) is answered by echoing it back;
 *   - otherwise the event names an item, which is read back from monday with
 *     our own token and synced — see `app/lib/monday-live-sync.ts`.
 *
 * The URL's key is `mondayWebhookKey()` (MONDAY_WEBHOOK_SECRET, or derived
 * from the token); without it nothing is done. The
 * body is never trusted for content, only for which item to look at.
 */

function sameKey(given: string, expected: string) {
  if (!expected || given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  const config = mondaySyncConfig();
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!config.configured || !sameKey(key, await mondayWebhookKey())) {
    return Response.json({ error: "Not accepted." }, { status: 403 });
  }
  const payload = (await request.json().catch(() => null)) as {
    challenge?: unknown;
    event?: { type?: unknown; pulseId?: unknown; itemId?: unknown; boardId?: unknown };
  } | null;
  if (payload && typeof payload.challenge === "string") {
    return Response.json({ challenge: payload.challenge });
  }
  const event = payload?.event;
  const itemId = String(event?.pulseId ?? event?.itemId ?? "");
  if (!/^\d{1,20}$/.test(itemId) || String(event?.boardId ?? config.boardId) !== config.boardId) {
    /* Not ours, or nothing to look at: acknowledged so monday stops retrying. */
    return Response.json({ ok: true, ignored: true });
  }
  try {
    await ensureDatabase();
    const db = await getDb();
    const result = await syncMondayItems(db, [itemId]);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[monday webhook] sync failed", error instanceof Error ? error.message : error);
    /* A 5xx makes monday retry the event (every minute, for 30 minutes). */
    return Response.json({ error: "The item could not be synced right now." }, { status: 503 });
  }
}
