import { retirePlaceholderAssets, retireUnlistedSites } from "../../../lib/store-register-cleanup";
import { reconcileStoreRegister } from "../../../lib/store-register-sync";
import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  boardItemIds,
  catchUpMondaySync,
  connectMondayWebhooks,
  listMondayWebhooks,
  mondaySyncConfig,
  repairMissingFiles,
  syncMondayItems,
} from "../../../lib/monday-live-sync";
import { verifyStoreDocumentation } from "../../../lib/monday-verify";
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
 *   POST { action: "import", board, page, size? }
 *        every item of one board, a page at a time (size ≤ 40), so a full
 *        import never runs into the function's time limit; `done` says when
 *        the last page has been taken
 *
 *   POST { action: "repair-files", board, page, size? }
 *        puts back the bytes of files the database names but storage does not
 *        hold, from monday, at the object key each row already names;
 *        or { action: "repair-files", itemIds } for up to 10 named items
 *
 *   POST { action: "verify-store-docs" }
 *   POST { action: "retire-unlisted-sites" | "retire-placeholder-assets", apply? } one-off tidy-ups, dry run by default
 *   POST { action: "sync-store-register" } sites, groups and site assets from Store Documentation
 *        read-only comparison of Store Documentation with monday
 *
 * Every write is idempotent — matched on monday's item id, files on name and
 * size — so any call can be repeated safely.
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
      boards: config.boards,
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
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      days?: unknown;
      itemIds?: unknown;
      board?: unknown;
      page?: unknown;
      size?: unknown;
    };
    if (body.action === "verify-store-docs") {
      /* Read-only: every difference between monday's Store Documentation and
         ours — stores, certificate files (and their bytes), expiry dates. */
      return Response.json(await verifyStoreDocumentation(await getDb()));
    }
    if (body.action === "retire-unlisted-sites" || body.action === "retire-placeholder-assets") {
      /* The two one-off tidy-ups of 2026-10-06 (app/lib/store-register-cleanup.ts).
         A dry run unless `apply: true` is sent. */
      const db = await getDb();
      const apply = (body as { apply?: unknown }).apply === true;
      if (body.action === "retire-unlisted-sites") {
        return Response.json({ ok: true, ...(await retireUnlistedSites(db, config.organisationId, { apply })) });
      }
      const scope = await scopedDb(request);
      return Response.json({
        ok: true,
        ...(await retirePlaceholderAssets(
          db,
          config.organisationId,
          { email: scope.actor.email, displayName: scope.actor.displayName },
          { apply },
        )),
      });
    }
    if (body.action === "sync-store-register") {
      /* The site register, its groups and every site's own asset, brought into
         line with Store Documentation now rather than at the next change. */
      return Response.json({
        ok: true,
        ...(await reconcileStoreRegister(await getDb(), config.organisationId)),
      });
    }
    if (body.action === "connect") {
      return Response.json({ ok: true, ...(await connectMondayWebhooks(publicOrigin(request))) });
    }
    if (body.action === "sync") {
      const db = await getDb();
      if (Array.isArray(body.itemIds)) {
        return Response.json({ ok: true, ...(await syncMondayItems(db, body.itemIds.slice(0, 40).map(String))) });
      }
      const days = typeof body.days === "number" ? body.days : 2;
      return Response.json({ ok: true, ...(await catchUpMondaySync(db, days)) });
    }
    if (body.action === "repair-files") {
      /* Named items (≤ 10 a call) — e.g. the open jobs first, inside a storage
         plan that cannot hold every historical photograph at once. */
      if (Array.isArray(body.itemIds)) {
        return Response.json({ ok: true, ...(await repairMissingFiles(await getDb(), body.itemIds.slice(0, 10).map(String))) });
      }
      const board = config.boards.find((entry) => entry.key === body.board);
      if (!board) return Response.json({ error: "Choose maintenance or store-documentation." }, { status: 400 });
      const size = Math.min(Math.max(typeof body.size === "number" ? Math.floor(body.size) : 25, 1), 40);
      const page = Math.max(typeof body.page === "number" ? Math.floor(body.page) : 0, 0);
      const ids = await boardItemIds(board.mondayId, null);
      const slice = ids.slice(page * size, page * size + size);
      const outcome = await repairMissingFiles(await getDb(), slice);
      return Response.json({ ok: true, board: board.key, page, total: ids.length, done: (page + 1) * size >= ids.length, ...outcome });
    }
    if (body.action === "import") {
      const board = config.boards.find((entry) => entry.key === body.board);
      if (!board) return Response.json({ error: "Choose maintenance or store-documentation." }, { status: 400 });
      const size = Math.min(Math.max(typeof body.size === "number" ? Math.floor(body.size) : 25, 1), 40);
      const page = Math.max(typeof body.page === "number" ? Math.floor(body.page) : 0, 0);
      const ids = await boardItemIds(board.mondayId, null);
      const slice = ids.slice(page * size, page * size + size);
      const db = await getDb();
      const outcome = await syncMondayItems(db, slice);
      return Response.json({
        ok: true,
        board: board.key,
        page,
        total: ids.length,
        done: (page + 1) * size >= ids.length,
        ...outcome,
      });
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
