/**
 * LIVE monday.com → MAINTSUPP SYNC (owner, 2026-10-04).
 *
 * Sunnamusk's requests still arrive on monday (their Maintenance board, the one
 * the historical import came from). This keeps the Sunnamusk workspace in
 * step, ONE WAY: a new item on monday appears here, and every change to it —
 * a column, its name, its group, a comment or a reply — follows. Nothing
 * written in MAINTSUPP is ever sent back to monday.
 *
 * Two doors, one path:
 *   - monday's webhooks call `/api/integrations/monday/webhook` the moment an
 *     item changes, and that syncs the one item;
 *   - the daily run (`/api/cron/daily`) catches up anything changed in the last
 *     two days, in case a webhook was missed.
 *
 * WHAT IS WRITTEN goes through the file import's own `commit` — the same
 * column mapping, group matching, site matching and status history — fed with
 * a plan built from monday's API instead of a spreadsheet. A job is matched on
 * monday's item id (`external_id`), so the jobs already imported are updated in
 * place and nothing is ever duplicated. Comments land in `item_updates` with
 * the ids the historical comment import used (`monday-update-<id>`,
 * `monday-reply-<id>`), so they too replace rather than repeat.
 *
 * A webhook body is never trusted for content: it only names an item, which is
 * then read back from monday with our own token and must belong to the
 * configured board.
 *
 * Configuration (Vercel environment variables):
 *   MONDAY_API_TOKEN          monday personal API token (required)
 *   MONDAY_SYNC_BOARD_ID      defaults to 1139774521, Sunnamusk's Maintenance
 *   MONDAY_WEBHOOK_SECRET     optional: the key monday's webhook URL carries;
 *                             derived from the token when unset, so one
 *                             variable is all the setup needs
 *   MONDAY_SYNC_ORGANISATION_ID  defaults to the primary (Sunnamusk) workspace
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { itemUpdates, maintenanceRequests } from "../../db/schema";
import { commit, jobTypeMatcher } from "../api/import/route";
import { listJobTypes } from "./job-types";
import { planImport } from "./monday-import";
import { notifyPlatformStaff } from "./push-notify";
import { PRIMARY_ORGANISATION_ID } from "./tenant-access";

type Database = Awaited<ReturnType<typeof getDb>>;

/* MONDAY_API_URL exists for local end-to-end tests against a stand-in server;
   production never sets it. */
const MONDAY_API = process.env.MONDAY_API_URL?.trim() || "https://api.monday.com/v2";
const DEFAULT_BOARD_ID = "1139774521";
const BOARD_KEY = "maintenance";

export function mondaySyncConfig() {
  const token = process.env.MONDAY_API_TOKEN?.trim() || "";
  const secret = process.env.MONDAY_WEBHOOK_SECRET?.trim() || "";
  return {
    token,
    secret,
    boardId: process.env.MONDAY_SYNC_BOARD_ID?.trim() || DEFAULT_BOARD_ID,
    organisationId: process.env.MONDAY_SYNC_ORGANISATION_ID?.trim() || PRIMARY_ORGANISATION_ID,
    configured: Boolean(token),
  };
}

/** The key the webhook URL carries: set explicitly, or derived from the token. */
export async function mondayWebhookKey() {
  const { token, secret } = mondaySyncConfig();
  if (secret) return secret;
  if (!token) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("maintsupp-monday-webhook"));
  return Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

/* ── monday API ──────────────────────────────────────────────────────────── */

export async function mondayQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { token } = mondaySyncConfig();
  if (!token) throw new Error("MONDAY_API_TOKEN is not set.");
  const response = await fetch(MONDAY_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => null)) as { data?: T; errors?: unknown; error_message?: string } | null;
  if (!response.ok || !body || body.errors || body.error_message || !body.data) {
    const detail = body?.error_message ?? (body?.errors ? JSON.stringify(body.errors).slice(0, 300) : response.statusText);
    throw new Error(`monday API ${response.status}: ${detail}`);
  }
  return body.data;
}

type MondayPerson = { name?: string | null; email?: string | null } | null;
type MondayReply = { id: string; text_body?: string | null; created_at?: string | null; creator?: MondayPerson };
type MondayUpdate = MondayReply & { updated_at?: string | null; replies?: MondayReply[] | null };
export type MondayItem = {
  id: string;
  name: string;
  state?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  board?: { id: string } | null;
  group?: { title: string } | null;
  column_values: Array<{ id: string; text?: string | null; column?: { title: string } | null }>;
  updates?: MondayUpdate[] | null;
};

const ITEM_FIELDS = `
  id name state created_at updated_at
  board { id }
  group { title }
  column_values { id text column { title } }
  updates(limit: 100) {
    id text_body created_at updated_at creator { name email }
    replies { id text_body created_at creator { name email } }
  }`;

export async function fetchMondayItems(ids: string[]): Promise<MondayItem[]> {
  const items: MondayItem[] = [];
  for (let start = 0; start < ids.length; start += 25) {
    const batch = ids.slice(start, start + 25);
    const data = await mondayQuery<{ items: MondayItem[] }>(
      `query ($ids: [ID!]) { items(ids: $ids) { ${ITEM_FIELDS} } }`,
      { ids: batch },
    );
    items.push(...(data.items ?? []));
  }
  return items;
}

/** Every item id on the board changed since `since`, read in light pages. */
async function changedItemIds(boardId: string, since: Date) {
  type Page = { cursor: string | null; items: Array<{ id: string; updated_at?: string | null }> };
  const ids: string[] = [];
  const first = await mondayQuery<{ boards: Array<{ items_page: Page }> }>(
    `query ($board: [ID!]) { boards(ids: $board) { items_page(limit: 500) { cursor items { id updated_at } } } }`,
    { board: [boardId] },
  );
  let page: Page | undefined = first.boards?.[0]?.items_page;
  for (let guard = 0; page && guard < 40; guard += 1) {
    for (const item of page.items ?? []) {
      const changed = item.updated_at ? new Date(item.updated_at) : null;
      if (!changed || Number.isNaN(changed.getTime()) || changed >= since) ids.push(item.id);
    }
    if (!page.cursor) break;
    const next: { next_items_page: Page } = await mondayQuery<{ next_items_page: Page }>(
      `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id updated_at } } }`,
      { cursor: page.cursor },
    );
    page = next.next_items_page;
  }
  return ids;
}

/* ── monday item → import plan ───────────────────────────────────────────── */

/**
 * The item laid out exactly as monday's own Excel export lays out one row —
 * group heading, header, row — so `planImport` reads it with the same column
 * matching, aliases and date handling as a file. "Item ID" carries monday's id.
 */
export function planFromMondayItems(items: MondayItem[]) {
  const rows: string[][] = [];
  for (const item of items) {
    const titles = ["Name", "Item ID"];
    const values = [item.name ?? "", String(item.id)];
    for (const column of item.column_values ?? []) {
      const title = column.column?.title?.trim();
      if (!title || column.id === "name") continue;
      titles.push(title);
      values.push(column.text ?? "");
    }
    rows.push([], [item.group?.title?.trim() || "Incoming requests"], titles, values);
  }
  return planImport(rows, "maintenance");
}

function cleanBody(value: string | null | undefined) {
  return (value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);
}

/* ── the sync ────────────────────────────────────────────────────────────── */

export type MondaySyncResult = {
  items: number;
  created: number;
  updated: number;
  comments: number;
  ignored: number;
};

/**
 * Syncs the named monday items into the Sunnamusk workspace. Items on another
 * board, archived or deleted ones that are not here yet, are ignored.
 */
export async function syncMondayItems(db: Database, ids: string[]): Promise<MondaySyncResult> {
  const config = mondaySyncConfig();
  const unique = [...new Set(ids.map(String).filter((id) => /^\d{1,20}$/.test(id)))];
  const result: MondaySyncResult = { items: 0, created: 0, updated: 0, comments: 0, ignored: 0 };
  if (!unique.length) return result;

  const fetched = await fetchMondayItems(unique);
  const orgId = config.organisationId;
  const known = new Set(
    (
      await db
        .select({ externalId: maintenanceRequests.externalId })
        .from(maintenanceRequests)
        .where(and(eq(maintenanceRequests.organisationId, orgId), inArray(maintenanceRequests.externalId, unique)))
    ).map((row) => String(row.externalId)),
  );

  /* Only this board, and only live items unless the job is already here. */
  const items = fetched.filter((item) => {
    const onBoard = String(item.board?.id ?? "") === config.boardId;
    const live = !item.state || item.state === "active";
    const keep = onBoard && (live || known.has(String(item.id)));
    if (!keep) result.ignored += 1;
    return keep;
  });
  if (!items.length) return result;

  const plan = planFromMondayItems(items);
  const batchId = `monday-live-${Date.now().toString(36)}`;
  const outcome = await commit(db, orgId, BOARD_KEY, plan, batchId, jobTypeMatcher(await listJobTypes(db, orgId)));
  result.items = items.length;
  result.created = outcome.created;
  result.updated = outcome.updated;

  /* Comments and replies, keyed on monday's own ids. */
  const requestRows = await db
    .select({ id: maintenanceRequests.id, externalId: maintenanceRequests.externalId })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, orgId),
        inArray(
          maintenanceRequests.externalId,
          items.map((item) => String(item.id)),
        ),
      ),
    );
  const requestByExternal = new Map(requestRows.map((row) => [String(row.externalId), row.id]));
  const touched = new Set<string>();
  for (const item of items) {
    const requestId = requestByExternal.get(String(item.id));
    if (!requestId) continue;
    for (const update of item.updates ?? []) {
      const body = cleanBody(update.text_body);
      const replies = update.replies ?? [];
      if (!body && !replies.length) continue;
      const parentId = `monday-update-${update.id}`;
      const rows = [
        {
          id: parentId,
          parentId: null as string | null,
          body,
          author: update.creator,
          createdAt: update.created_at,
          editedAt: update.updated_at && update.updated_at !== update.created_at ? update.updated_at : null,
        },
        ...replies
          .map((reply) => ({
            id: `monday-reply-${reply.id}`,
            parentId,
            body: cleanBody(reply.text_body),
            author: reply.creator,
            createdAt: reply.created_at,
            editedAt: null as string | null,
          }))
          .filter((reply) => reply.body),
      ];
      for (const row of rows) {
        await db
          .insert(itemUpdates)
          .values({
            id: row.id,
            organisationId: orgId,
            boardId: BOARD_KEY,
            requestId,
            parentId: row.parentId,
            authorName: row.author?.name || "monday.com",
            authorEmail: row.author?.email || null,
            body: row.body,
            editedAt: row.editedAt,
            createdAt: row.createdAt || new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: itemUpdates.id,
            set: {
              body: row.body,
              authorName: row.author?.name || "monday.com",
              authorEmail: row.author?.email || null,
              editedAt: row.editedAt,
            },
          });
        result.comments += 1;
        touched.add(requestId);
      }
    }
  }
  /* The denormalised counter, recomputed from the rows (never incremented). */
  for (const requestId of touched) {
    await db
      .update(maintenanceRequests)
      .set({
        commentCount: sql`(SELECT COUNT(*) FROM item_updates u WHERE u.request_id = ${requestId})`,
      })
      .where(eq(maintenanceRequests.id, requestId));
  }

  /* A brand-new request is worth a tap on the office's phones. */
  const fresh = items.filter((item) => !known.has(String(item.id)) && (!item.state || item.state === "active"));
  if (fresh.length) {
    await notifyPlatformStaff(db, {
      title: fresh.length === 1 ? "New Sunnamusk request" : `${fresh.length} new Sunnamusk requests`,
      body: fresh.length === 1 ? `${fresh[0].name} — arrived from monday.com` : fresh.map((item) => item.name).slice(0, 3).join(", "),
      url: "/dashboard",
      tag: `monday-new-${fresh[0].id}`,
    });
  }
  return result;
}

/** The daily catch-up: everything on the board changed in the last `days`. */
export async function catchUpMondaySync(db: Database, days = 2) {
  const config = mondaySyncConfig();
  if (!config.token) return { skipped: "MONDAY_API_TOKEN is not set" } as const;
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 30) * 86_400_000);
  const ids = await changedItemIds(config.boardId, since);
  const outcome = await syncMondayItems(db, ids);
  return { changed: ids.length, ...outcome };
}

/* ── webhooks on monday ──────────────────────────────────────────────────── */

/** The events that change what a job looks like here. */
export const MONDAY_WEBHOOK_EVENTS = [
  "create_item",
  "change_column_value",
  "change_name",
  "item_moved_to_any_group",
  "create_update",
  "edit_update",
] as const;

export async function mondayWebhookUrl(origin: string) {
  const key = await mondayWebhookKey();
  return `${origin.replace(/\/$/, "")}/api/integrations/monday/webhook?key=${encodeURIComponent(key)}`;
}

export async function listMondayWebhooks() {
  const { boardId } = mondaySyncConfig();
  const data = await mondayQuery<{ webhooks: Array<{ id: string; event: string; config?: string | null }> }>(
    `query ($board: ID!) { webhooks(board_id: $board) { id event config } }`,
    { board: boardId },
  );
  return data.webhooks ?? [];
}

/** Registers every event's webhook that is not registered already. */
export async function connectMondayWebhooks(origin: string) {
  const { boardId } = mondaySyncConfig();
  const url = await mondayWebhookUrl(origin);
  const existing = new Set((await listMondayWebhooks()).map((hook) => hook.event));
  const created: string[] = [];
  for (const event of MONDAY_WEBHOOK_EVENTS) {
    if (existing.has(event)) continue;
    await mondayQuery(
      `mutation ($board: ID!, $url: String!, $event: WebhookEventType!) {
         create_webhook(board_id: $board, url: $url, event: $event) { id }
       }`,
      { board: boardId, url, event },
    );
    created.push(event);
  }
  return { created, alreadyThere: [...existing] };
}
