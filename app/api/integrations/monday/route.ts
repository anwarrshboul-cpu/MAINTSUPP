import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  catchUpMondaySync,
  connectMondayWebhooks,
  listMondayWebhooks,
  mondaySyncConfig,
  syncMondayItems,
} from "../../../lib/monday-live-sync";
import { publicOrigin } from "../../../lib/public-origin";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * `/api/integrations/monday` — MAINTSUPP staff control of the live monday.com
 * sync (owner, 2026-10-04). Platform staff with a real session only.
 *
 *   GET                                  is it configured, which webhooks exist
 *   POST { action: "connect" }           register the board's webhooks
 *   POST { action: "sync", days? }       catch up items changed in the last N days
 *   POST { action: "sync", itemIds }     sync these monday items now
 */

async function staffOnly(request: Request) {
  const scope = await scopedDb(request);
  if (!scope.platformAdmin || !scope.authenticated) {
    return Response.json({ error: "Only MAINTSUPP staff can manage the monday.com sync." }, { status: 403 });
  }
  return null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const denied = await staffOnly(request);
    if (denied) return denied;
    const config = mondaySyncConfig();
    const webhooks = config.token ? await listMondayWebhooks().catch((error: unknown) => ({ error: String(error instanceof Error ? error.message : error) })) : [];
    return Response.json({
      configured: config.configured,
      tokenSet: Boolean(config.token),
      secretSet: Boolean(config.secret),
      boardId: config.boardId,
      organisationId: config.organisationId,
      webhooks: Array.isArray(webhooks) ? webhooks.map(({ id, event }) => ({ id, event })) : webhooks,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The monday.com sync status could not be read." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const denied = await staffOnly(request);
    if (denied) return denied;
    const config = mondaySyncConfig();
    if (!config.configured) {
      return Response.json({ error: "Set MONDAY_API_TOKEN in the Vercel environment first." }, { status: 409 });
    }
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; days?: unknown; itemIds?: unknown };
    if (body.action === "connect") {
      return Response.json({ ok: true, ...(await connectMondayWebhooks(publicOrigin(request))) });
    }
    if (body.action === "sync") {
      const db = await getDb();
      if (Array.isArray(body.itemIds)) {
        return Response.json({ ok: true, ...(await syncMondayItems(db, body.itemIds.slice(0, 200).map(String))) });
      }
      const days = typeof body.days === "number" ? body.days : 2;
      return Response.json({ ok: true, ...(await catchUpMondaySync(db, days)) });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/integrations/monday]", error instanceof Error ? error.message : error);
    return Response.json(
      { error: error instanceof Error && error.message.startsWith("monday API") ? error.message : "The monday.com sync could not run right now." },
      { status: 503 },
    );
  }
}
