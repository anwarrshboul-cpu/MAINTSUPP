/**
 * LIVE monday.com → MAINTSUPP SYNC (owner, 2026-10-04).
 *
 * Sunnamusk's requests still arrive on monday. Two boards are mirrored into the
 * Sunnamusk workspace, ONE WAY — Maintenance (jobs) and Store Documentation
 * (each store's certificates). A new item on monday appears here, and every
 * change to it — a column, its name, its group, a comment or a reply, a file
 * added to a file column — follows. Nothing written in MAINTSUPP is ever sent
 * back to monday.
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
 * place and nothing is ever duplicated. Store Documentation rows were imported
 * without monday's id, so each is linked to its monday item by its exact store
 * name ON THAT BOARD ONLY (store names are unique there; "Merry Hill" the store
 * and "Merry hill" a maintenance job are not the same thing) before the write.
 *
 * FILES are copied into the bucket the app reads, as the historical asset
 * import did: one attachment per monday asset, on the column it sits in, and
 * skipped when that job already holds a file of the same name and size in that
 * column — the import's own ledger key — so nothing is ever stored twice. Comments land in `item_updates` with
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
 *   MONDAY_STORE_DOC_BOARD_ID defaults to 1398027719, Store Documentation
 *   MONDAY_WEBHOOK_SECRET     optional: the key monday's webhook URL carries;
 *                             derived from the token when unset, so one
 *                             variable is all the setup needs
 *   MONDAY_SYNC_ORGANISATION_ID  defaults to the primary (Sunnamusk) workspace
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  attachments,
  itemUpdates,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceRequests,
} from "../../db/schema";
import { commit, jobTypeMatcher } from "../api/import/route";
import { kindForColumnKey, reconcileAttachmentCounts } from "./attachment-counts";
import { listJobTypes } from "./job-types";
import { planImport, type ImportBoardKey } from "./monday-import";
import { notifyPlatformStaff } from "./push-notify";
import { PRIMARY_ORGANISATION_ID } from "./tenant-access";

type Database = Awaited<ReturnType<typeof getDb>>;

/* MONDAY_API_URL exists for local end-to-end tests against a stand-in server;
   production never sets it. */
const MONDAY_API = process.env.MONDAY_API_URL?.trim() || "https://api.monday.com/v2";
const DEFAULT_BOARD_ID = "1139774521";
const DEFAULT_STORE_DOC_BOARD_ID = "1398027719";

export type SyncedBoard = { mondayId: string; key: ImportBoardKey };

export function mondaySyncConfig() {
  const token = process.env.MONDAY_API_TOKEN?.trim() || "";
  const secret = process.env.MONDAY_WEBHOOK_SECRET?.trim() || "";
  const boardId = process.env.MONDAY_SYNC_BOARD_ID?.trim() || DEFAULT_BOARD_ID;
  const storeDocBoardId = process.env.MONDAY_STORE_DOC_BOARD_ID?.trim() || DEFAULT_STORE_DOC_BOARD_ID;
  const boards: SyncedBoard[] = [
    { mondayId: boardId, key: "maintenance" },
    { mondayId: storeDocBoardId, key: "store-documentation" },
  ];
  return {
    token,
    secret,
    boardId,
    storeDocBoardId,
    boards,
    organisationId: process.env.MONDAY_SYNC_ORGANISATION_ID?.trim() || PRIMARY_ORGANISATION_ID,
    configured: Boolean(token),
  };
}

/** Which of our boards a monday board id is, if it is one. */
export function syncedBoardFor(mondayBoardId: unknown): SyncedBoard | null {
  return mondaySyncConfig().boards.find((board) => board.mondayId === String(mondayBoardId ?? "")) ?? null;
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
type MondayAsset = { id: string; name?: string | null; file_size?: number | null; public_url?: string | null };
export type MondayItem = {
  id: string;
  name: string;
  state?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  board?: { id: string } | null;
  group?: { title: string } | null;
  column_values: Array<{ id: string; type?: string | null; text?: string | null; value?: string | null; column?: { title: string } | null }>;
  assets?: MondayAsset[] | null;
  updates?: MondayUpdate[] | null;
};

const ITEM_FIELDS = `
  id name state created_at updated_at
  board { id }
  group { title }
  column_values { id type text value column { title } }
  assets { id name file_size public_url }
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

/** Item ids on a board — every one, or only those changed since `since`. */
export async function boardItemIds(boardId: string, since: Date | null) {
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
      if (!since || !changed || Number.isNaN(changed.getTime()) || changed >= since) ids.push(item.id);
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
 * The items laid out exactly as monday's own Excel export lays out a board —
 * group heading, header, row — so `planImport` reads them with the same column
 * matching, aliases and date handling as a file. "Item ID" carries monday's id.
 */
export function planFromMondayItems(items: MondayItem[], board: ImportBoardKey = "maintenance") {
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
    rows.push([], [item.group?.title?.trim() || (board === "maintenance" ? "Incoming requests" : "Stores")], titles, values);
  }
  return planImport(rows, board);
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

function storeKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/* ── the sync ────────────────────────────────────────────────────────────── */

export type MondaySyncResult = {
  items: number;
  created: number;
  updated: number;
  linked: number;
  comments: number;
  files: number;
  filesAlreadyHere: number;
  filesPending: number;
  filesSkipped: number;
  ignored: number;
};

/**
 * Store Documentation rows from the historical import carry no monday id. Each
 * is linked to its monday item by exact store name, scoped to that board, and
 * only when exactly one unlinked row has the name — never a guess.
 */
async function linkStoreDocumentationRows(db: Database, orgId: string, items: MondayItem[]) {
  if (!items.length) return 0;
  const rows = await db
    .select({ id: maintenanceRequests.id, title: maintenanceRequests.title })
    .from(maintenanceRequests)
    .innerJoin(maintenanceGroupItems, eq(maintenanceGroupItems.requestId, maintenanceRequests.id))
    .where(
      and(
        eq(maintenanceRequests.organisationId, orgId),
        eq(maintenanceGroupItems.boardId, "store-documentation"),
        isNull(maintenanceRequests.externalId),
      ),
    );
  const byName = new Map<string, string[]>();
  for (const row of rows) {
    const key = storeKey(row.title);
    byName.set(key, [...(byName.get(key) ?? []), row.id]);
  }
  let linked = 0;
  for (const item of items) {
    const matches = byName.get(storeKey(item.name ?? "")) ?? [];
    if (matches.length !== 1) continue;
    await db
      .update(maintenanceRequests)
      .set({ externalId: String(item.id) })
      .where(and(eq(maintenanceRequests.id, matches[0]), isNull(maintenanceRequests.externalId)));
    byName.delete(storeKey(item.name ?? ""));
    linked += 1;
  }
  return linked;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain", csv: "text/csv",
};
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function contentTypeFor(name: string, bytes: Uint8Array) {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (CONTENT_TYPES[extension]) return CONTENT_TYPES[extension];
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  return "application/octet-stream";
}

function cleanFileName(name: string) {
  return (name || "file").replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

/**
 * Copies the files in the items' file columns that are not here yet. Stops
 * starting new downloads once `deadline` passes; a later run picks up the rest.
 */
async function copyMondayFiles(
  db: Database,
  orgId: string,
  items: Array<{ item: MondayItem; board: SyncedBoard }>,
  requestByExternal: Map<string, { id: string; siteId: string | null }>,
  deadline: number,
  result: MondaySyncResult,
) {
  const work: Array<{ requestId: string; siteId: string | null; columnId: string; columnKey: string; asset: MondayAsset }> = [];
  const columns = await db
    .select({
      id: maintenanceBoardColumns.id,
      key: maintenanceBoardColumns.key,
      title: maintenanceBoardColumns.title,
      boardId: maintenanceBoardColumns.boardId,
    })
    .from(maintenanceBoardColumns)
    .where(and(eq(maintenanceBoardColumns.organisationId, orgId), eq(maintenanceBoardColumns.type, "files")));
  const columnByTitle = new Map(columns.map((column) => [`${column.boardId}:${column.title.trim().toLowerCase()}`, column]));

  for (const { item, board } of items) {
    const request = requestByExternal.get(String(item.id));
    if (!request) continue;
    const assetById = new Map((item.assets ?? []).map((asset) => [String(asset.id), asset]));
    for (const value of item.column_values ?? []) {
      if (value.type !== "file" || !value.value) continue;
      const column = columnByTitle.get(`${board.key}:${(value.column?.title ?? "").trim().toLowerCase()}`);
      if (!column) continue;
      let files: Array<{ assetId?: number | string }> = [];
      try {
        files = (JSON.parse(value.value) as { files?: Array<{ assetId?: number | string }> }).files ?? [];
      } catch {
        continue;
      }
      for (const file of files) {
        const asset = file.assetId != null ? assetById.get(String(file.assetId)) : undefined;
        if (asset?.name) work.push({ requestId: request.id, siteId: request.siteId, columnId: column.id, columnKey: column.key, asset });
      }
    }
  }
  if (!work.length) return;

  const requestIds = [...new Set(work.map((entry) => entry.requestId))];
  const existing = await db
    .select({
      requestId: attachments.requestId,
      columnId: attachments.boardColumnId,
      name: attachments.originalName,
      size: attachments.byteSize,
    })
    .from(attachments)
    .where(and(eq(attachments.organisationId, orgId), inArray(attachments.requestId, requestIds)));
  const ledger = new Set(existing.map((row) => `${row.requestId}|${row.columnId}|${row.name}|${row.size}`));
  const namesHere = new Set(existing.map((row) => `${row.requestId}|${row.columnId}|${row.name}`));

  const { env } = await import("cloudflare:workers");
  const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
  const touched = new Set<string>();
  for (const entry of work) {
    const name = entry.asset.name as string;
    const size = entry.asset.file_size ?? null;
    const sameFile = size != null
      ? ledger.has(`${entry.requestId}|${entry.columnId}|${name}|${size}`)
      : namesHere.has(`${entry.requestId}|${entry.columnId}|${name}`);
    if (sameFile) {
      result.filesAlreadyHere += 1;
      continue;
    }
    if (!bucket || !entry.asset.public_url || (size != null && size > MAX_FILE_BYTES)) {
      result.filesSkipped += 1;
      continue;
    }
    if (Date.now() > deadline) {
      result.filesPending += 1;
      continue;
    }
    const response = await fetch(entry.asset.public_url).catch(() => null);
    if (!response || !response.ok) {
      result.filesSkipped += 1;
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength === 0) {
      result.filesSkipped += 1;
      continue;
    }
    /* Checked again with the real size, so a file monday reported without one
       is not stored twice either. */
    if (ledger.has(`${entry.requestId}|${entry.columnId}|${name}|${bytes.byteLength}`)) {
      result.filesAlreadyHere += 1;
      continue;
    }
    const id = crypto.randomUUID();
    const kind = kindForColumnKey(entry.columnKey);
    const cleanName = cleanFileName(name);
    const contentType = contentTypeFor(name, bytes);
    const key = `${orgId}/maintenance/${entry.requestId}/${kind}/${id}-${cleanName}`;
    await bucket.put(key, bytes, {
      httpMetadata: { contentType, contentDisposition: `inline; filename="${cleanName}"` },
      customMetadata: {
        requestId: entry.requestId,
        kind,
        boardColumnId: entry.columnId,
        uploadedBy: "monday.com",
        originalName: name,
        mondayAssetId: String(entry.asset.id),
      },
    });
    await db.insert(attachments).values({
      id,
      organisationId: orgId,
      requestId: entry.requestId,
      siteId: entry.siteId,
      kind,
      boardColumnId: entry.columnId,
      objectKey: key,
      originalName: name,
      contentType,
      byteSize: bytes.byteLength,
      versionNo: 1,
      isCurrent: true,
      uploadedByEmail: "monday.com",
    });
    ledger.add(`${entry.requestId}|${entry.columnId}|${name}|${bytes.byteLength}`);
    namesHere.add(`${entry.requestId}|${entry.columnId}|${name}`);
    touched.add(entry.requestId);
    result.files += 1;
  }
  /* Counters recounted from the rows, the way every upload does it. */
  for (const requestId of touched) await reconcileAttachmentCounts(db, orgId, requestId);
}

/**
 * Syncs the named monday items into the Sunnamusk workspace. Items on any
 * other board, and archived or deleted ones that are not here yet, are ignored.
 * File copying stops starting downloads at `budgetMs`, so one call stays well
 * inside the function's time limit; the rest follow on the next run.
 */
export async function syncMondayItems(
  db: Database,
  ids: string[],
  options: { budgetMs?: number } = {},
): Promise<MondaySyncResult> {
  const started = Date.now();
  const config = mondaySyncConfig();
  const unique = [...new Set(ids.map(String).filter((id) => /^\d{1,20}$/.test(id)))];
  const result: MondaySyncResult = {
    items: 0, created: 0, updated: 0, linked: 0, comments: 0,
    files: 0, filesAlreadyHere: 0, filesPending: 0, filesSkipped: 0, ignored: 0,
  };
  if (!unique.length) return result;

  const fetched = await fetchMondayItems(unique);
  const orgId = config.organisationId;

  /* Store Documentation rows from the historical import learn their monday id. */
  result.linked = await linkStoreDocumentationRows(
    db,
    orgId,
    fetched.filter((item) => syncedBoardFor(item.board?.id)?.key === "store-documentation"),
  );

  const known = new Set(
    (
      await db
        .select({ externalId: maintenanceRequests.externalId })
        .from(maintenanceRequests)
        .where(and(eq(maintenanceRequests.organisationId, orgId), inArray(maintenanceRequests.externalId, unique)))
    ).map((row) => String(row.externalId)),
  );

  /* Only our two boards, and only live items unless the row is already here. */
  const items: Array<{ item: MondayItem; board: SyncedBoard }> = [];
  for (const item of fetched) {
    const board = syncedBoardFor(item.board?.id);
    const live = !item.state || item.state === "active";
    if (board && (live || known.has(String(item.id)))) items.push({ item, board });
    else result.ignored += 1;
  }
  if (!items.length) return result;

  const matchJobType = jobTypeMatcher(await listJobTypes(db, orgId));
  for (const board of config.boards) {
    const onBoard = items.filter((entry) => entry.board.key === board.key).map((entry) => entry.item);
    if (!onBoard.length) continue;
    const plan = planFromMondayItems(onBoard, board.key);
    const batchId = `monday-live-${Date.now().toString(36)}`;
    const outcome = await commit(db, orgId, board.key, plan, batchId, board.key === "maintenance" ? matchJobType : null);
    result.items += onBoard.length;
    result.created += outcome.created;
    result.updated += outcome.updated;
  }

  const requestRows = await db
    .select({
      id: maintenanceRequests.id,
      externalId: maintenanceRequests.externalId,
      siteId: maintenanceRequests.siteId,
    })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.organisationId, orgId),
        inArray(
          maintenanceRequests.externalId,
          items.map((entry) => String(entry.item.id)),
        ),
      ),
    );
  const requestByExternal = new Map(
    requestRows.map((row) => [String(row.externalId), { id: row.id, siteId: row.siteId ?? null }]),
  );

  /* Comments and replies, keyed on monday's own ids. */
  const touched = new Set<string>();
  for (const { item, board } of items) {
    const requestId = requestByExternal.get(String(item.id))?.id;
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
            boardId: board.key,
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

  await copyMondayFiles(db, orgId, items, requestByExternal, started + (options.budgetMs ?? 35_000), result);

  /* A brand-new maintenance request is worth a tap on the office's phones. */
  const fresh = items
    .filter(({ item, board }) => board.key === "maintenance" && !known.has(String(item.id)) && (!item.state || item.state === "active"))
    .map(({ item }) => item);
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

/** The daily catch-up: everything on both boards changed in the last `days`. */
export async function catchUpMondaySync(db: Database, days = 2, options: { budgetMs?: number } = {}) {
  const config = mondaySyncConfig();
  if (!config.token) return { skipped: "MONDAY_API_TOKEN is not set" } as const;
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000);
  const ids: string[] = [];
  for (const board of config.boards) ids.push(...(await boardItemIds(board.mondayId, since)));
  const outcome = await syncMondayItems(db, ids, options);
  return { changed: ids.length, ...outcome };
}

/* ── webhooks on monday ──────────────────────────────────────────────────── */

/** The events that change what a row looks like here. */
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
  const hooks: Array<{ id: string; event: string; board: string }> = [];
  for (const board of mondaySyncConfig().boards) {
    const data = await mondayQuery<{ webhooks: Array<{ id: string; event: string }> }>(
      `query ($board: ID!) { webhooks(board_id: $board) { id event } }`,
      { board: board.mondayId },
    );
    for (const hook of data.webhooks ?? []) hooks.push({ id: hook.id, event: hook.event, board: board.key });
  }
  return hooks;
}

/** Registers, on both boards, every event's webhook not registered already. */
export async function connectMondayWebhooks(origin: string) {
  const url = await mondayWebhookUrl(origin);
  const existing = new Set((await listMondayWebhooks()).map((hook) => `${hook.board}:${hook.event}`));
  const created: string[] = [];
  for (const board of mondaySyncConfig().boards) {
    for (const event of MONDAY_WEBHOOK_EVENTS) {
      if (existing.has(`${board.key}:${event}`)) continue;
      await mondayQuery(
        `mutation ($board: ID!, $url: String!, $event: WebhookEventType!) {
           create_webhook(board_id: $board, url: $url, event: $event) { id }
         }`,
        { board: board.mondayId, url, event },
      );
      created.push(`${board.key}:${event}`);
    }
  }
  return { created, alreadyThere: [...existing] };
}
