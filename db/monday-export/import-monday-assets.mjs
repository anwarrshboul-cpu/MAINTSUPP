/**
 * Lands the downloaded monday assets in the app.
 *
 * Uploads go through the app's own `POST /api/files`, against a running dev
 * server, rather than being written into R2 and `attachments` directly. That
 * costs an HTTP round trip per file and is worth it: the route is the verified
 * path — it puts the object in the bucket the app actually reads, inserts the
 * attachment row, and moves the per-request counters in the same order the UI
 * expects. Writing the row by hand and the object separately is how you get an
 * attachment chip that 404s, and an honest empty cell beats a chip that lies.
 *
 * Matching is by identity, never by name:
 *   maintenance          monday item id  ->  maintenance_requests.external_id
 *   store documentation  item name       ->  the sd-NNN row's title
 * Store names are unique on that board — which is the only reason the second
 * one is safe, and the reason the first one exists at all: 732 of 744
 * maintenance items share 20 names between them.
 *
 * Usage:
 *   npm run dev                       # in another terminal
 *   set -a; . ./.env.monday; set +a   # not needed here, but keeps the pair together
 *   node db/monday-export/import-monday-assets.mjs --base http://localhost:5176 [--dry-run] [--limit N]
 *
 * Dry run by default in spirit: pass --commit to actually upload.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const PULL = path.join(HERE, "api-pull");
const ASSETS = path.join(HERE, "assets");

const DB_PATH = path.join(
  ROOT,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = flag("--base", "http://localhost:5176").replace(/\/$/, "");
const COMMIT = args.includes("--commit");
const LIMIT = Number(flag("--limit", Infinity));
const ONLY_BOARD = flag("--board", null);

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/*
 * The route's own limits, mirrored so the importer can report a refusal before
 * spending the upload rather than after. They are NOT relaxed here: raising a
 * validation limit so an import fits is how a limit stops meaning anything,
 * and the same route serves public contractor links.
 */
const MAX_STANDARD = 25 * 1024 * 1024;
const MAX_VIDEO = 90 * 1024 * 1024;
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);

const CONTENT_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  m4v: "video/x-m4v", mkv: "video/x-matroska", pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", zip: "application/zip",
};

const extOf = (name) => (name.includes(".") ? name.split(".").pop() : "").toLowerCase();

/**
 * The real type, read from the first bytes.
 *
 * One asset on the maintenance board is called `sweden`, with no extension at
 * all — a genuine 1.5 MB PNG photograph of a fault. The route accepts a file
 * whose *type* is allowed OR whose extension is, and with neither it refused
 * with 415. Sniffing the magic bytes answers the question the filename cannot,
 * and answers it more honestly than trusting a name would: this reports what
 * the file actually is rather than what it claims.
 *
 * Only the signatures that appear in this export are listed. An unrecognised
 * file keeps `application/octet-stream` and is refused by the route, which is
 * the correct outcome — the point is to identify real files, not to smuggle
 * unknown ones past validation.
 */
function sniffContentType(bytes) {
  const startsWith = (...signature) =>
    signature.every((byte, index) => bytes[index] === byte);

  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  // RIFF....WEBP
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return "image/webp";
  }
  // ....ftyp — MP4 and QuickTime share the container.
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "video/mp4";
  }
  return null;
}

function safeName(name) {
  return (name || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/* ---------------------------------------------------------------- */
/* Mapping                                                           */
/* ---------------------------------------------------------------- */

const manifest = JSON.parse(readFileSync(path.join(PULL, "manifest.json"), "utf8"));
const mondayBoards = JSON.parse(readFileSync(path.join(PULL, "columns.json"), "utf8"));

/** monday column id -> its title, per monday board id. */
const mondayColumnTitle = new Map();
for (const board of mondayBoards) {
  for (const column of board.columns) {
    mondayColumnTitle.set(`${board.id}:${column.id}`, column.title);
  }
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

/*
 * The app's boards are keyed by column TITLE, because that is what the CSV
 * importer matches and what `db/monday-board-spec.ts` captures verbatim.
 * Joining on the title rather than inventing a fourth id table is deliberate:
 * three disagreeing declarations of board structure is what put 38 columns on
 * a 25-column board.
 */
const localColumns = db
  .prepare(
    `SELECT id, board_id, column_key, title, type, organisation_id
       FROM maintenance_board_columns WHERE type = 'files'`,
  )
  .all();

const localColumnByTitle = new Map();
for (const column of localColumns) {
  localColumnByTitle.set(
    `${column.organisation_id}:${column.board_id}:${column.title.toLowerCase()}`,
    column,
  );
}

const requestsByExternal = new Map();
for (const row of db
  .prepare(
    "SELECT id, title, external_id, organisation_id FROM maintenance_requests WHERE external_id IS NOT NULL",
  )
  .all()) {
  requestsByExternal.set(String(row.external_id), row);
}

/*
 * The store index is scoped to the Store Documentation board.
 *
 * Built across every request, "Merry Hill" the store and "Merry hill" the
 * maintenance job normalise to the same key and the later row wins — which is
 * how the first run sent two of Merry Hill's certificates at a maintenance row
 * and collected a 404. Store names are unique *on their own board*, and that
 * is the only scope in which matching by name is safe at all.
 */
const requestsByTitle = new Map();
for (const row of db
  .prepare(
    `SELECT r.id, r.title, r.organisation_id
       FROM maintenance_requests r
       JOIN maintenance_group_items gi ON gi.request_id = r.id
      WHERE gi.board_id = 'store-documentation'`,
  )
  .all()) {
  requestsByTitle.set(
    `${row.organisation_id}:${row.title.toLowerCase().replace(/\s+/g, " ").trim()}`,
    row,
  );
}

/*
 * Already-imported files, so a re-run adds nothing twice.
 *
 * Keyed on request + column + original name + byte size. monday allows two
 * files of the same name in one cell, and the byte size is what separates
 * them; using the name alone would silently skip a genuine second document.
 */
const alreadyThere = new Set(
  db
    .prepare(
      `SELECT request_id, board_column_id, original_name, byte_size
         FROM attachments WHERE board_column_id IS NOT NULL`,
    )
    .all()
    .map((row) => `${row.request_id}|${row.board_column_id}|${row.original_name}|${row.byte_size}`),
);

const PRIMARY_ORG = db
  .prepare("SELECT organisation_id FROM maintenance_requests WHERE external_id IS NOT NULL LIMIT 1")
  .get()?.organisation_id;

db.close();

/** The local request a monday item belongs to, or null with a reason. */
function resolveRequest(row) {
  if (row.boardLabel === "maintenance") {
    const hit = requestsByExternal.get(String(row.itemId));
    return hit ? { request: hit } : { reason: "no maintenance row carries this monday item id" };
  }
  const key = `${PRIMARY_ORG}:${row.itemName.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const hit = requestsByTitle.get(key);
  return hit ? { request: hit } : { reason: `no store row named "${row.itemName}"` };
}

function resolveColumn(row, request) {
  const mondayTitle = mondayColumnTitle.get(`${row.boardId}:${row.columnId}`);
  if (!mondayTitle) return { reason: `monday column ${row.columnId} has no title` };
  const boardKey = row.boardLabel === "maintenance" ? "maintenance" : "store-documentation";
  const hit = localColumnByTitle.get(
    `${request.organisation_id}:${boardKey}:${mondayTitle.toLowerCase()}`,
  );
  return hit ? { column: hit } : { reason: `no ${boardKey} column titled "${mondayTitle}"` };
}

function assetPath(row) {
  return path.join(ASSETS, row.boardLabel, `${row.assetId}-${safeName(row.name)}`);
}

/* ---------------------------------------------------------------- */
/* Plan                                                              */
/* ---------------------------------------------------------------- */

const plan = [];
const skipped = [];

for (const row of manifest) {
  if (ONLY_BOARD && row.boardLabel !== ONLY_BOARD) continue;
  if (row.boardLabel === "subitems") {
    skipped.push({ row, reason: "the subitem board holds one empty placeholder and no files" });
    continue;
  }

  const file = assetPath(row);
  if (!existsSync(file)) {
    skipped.push({ row, reason: "not downloaded" });
    continue;
  }

  const { request, reason: requestReason } = resolveRequest(row);
  if (!request) {
    skipped.push({ row, reason: requestReason });
    continue;
  }
  const { column, reason: columnReason } = resolveColumn(row, request);
  if (!column) {
    skipped.push({ row, reason: columnReason });
    continue;
  }

  const size = statSync(file).size;
  const extension = extOf(row.name);
  const limit = VIDEO_EXT.has(extension) ? MAX_VIDEO : MAX_STANDARD;
  if (size > limit) {
    skipped.push({
      row,
      reason: `${(size / 1024 / 1024).toFixed(1)} MB exceeds the route's ${(limit / 1024 / 1024).toFixed(0)} MB limit`,
    });
    continue;
  }

  const ledgerKey = `${request.id}|${column.id}|${row.name}|${size}`;
  if (alreadyThere.has(ledgerKey)) {
    skipped.push({ row, reason: "already imported" });
    continue;
  }

  plan.push({ row, file, size, request, column, extension });
  if (plan.length >= LIMIT) break;
}

console.log(`planned uploads : ${plan.length}`);
console.log(`skipped         : ${skipped.length}`);
const reasons = {};
for (const entry of skipped) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${reason}`);
}

if (!COMMIT) {
  console.log("\nDry run. Nothing uploaded. Pass --commit to write.");
  process.exit(0);
}

/* ---------------------------------------------------------------- */
/* Upload                                                            */
/* ---------------------------------------------------------------- */

const signIn = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  console.error(`Sign-in failed (${signIn.status}). Is the dev server on ${BASE}?`);
  process.exit(1);
}
const cookie = (signIn.headers.getSetCookie?.() ?? [])
  .map((value) => value.split(";")[0])
  .join("; ");
if (!cookie) {
  console.error("Signed in but no session cookie came back.");
  process.exit(1);
}
console.log(`\nsigned in as ${EMAIL}\n`);

let uploaded = 0;
let failed = 0;
const failures = [];

/*
 * The same fork the browser takes, and for the same reason.
 *
 * The single-shot route parses a `multipart/form-data` body, and the Workers
 * runtime refuses to parse one at or above 1 MiB — answering a bare `413
 * Payload Too Large` before any route code runs. The first run of this importer
 * posted everything to that route and lost 1,097 ordinary phone photographs to
 * it, nowhere near the route's own 25 MB rule.
 *
 * That is a product bug, not an import quirk: it is why `client-upload.ts` now
 * forks at 900 KB instead of 4 MB. These constants deliberately match it, so
 * there is one answer to "how does a large file get uploaded" rather than two
 * that disagree. The 5 MB chunk is fine because the multipart route PUTs raw
 * octets and never calls `formData()` — a 6 MB raw PUT was accepted where a
 * 1 MiB form was not.
 */
const DIRECT_UPLOAD_LIMIT = 900 * 1024;
const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;

async function readApi(response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
  }
  return response.json();
}

async function uploadDirect(job, bytes, type) {
  const form = new FormData();
  form.set("file", new File([bytes], job.row.name, { type }), job.row.name);
  form.set("requestId", job.request.id);
  form.set("kind", "general");
  form.set("columnId", job.column.id);
  await readApi(
    await fetch(`${BASE}/api/files`, { method: "POST", headers: { cookie }, body: form }),
  );
}

async function uploadMultipart(job, bytes, type) {
  const start = await readApi(
    await fetch(`${BASE}/api/files/multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        action: "start",
        requestId: job.request.id,
        kind: "general",
        columnId: job.column.id,
        originalName: job.row.name,
        contentType: type,
        byteSize: bytes.length,
      }),
    }),
  );

  const parts = [];
  const partCount = Math.ceil(bytes.length / MULTIPART_CHUNK_SIZE);
  try {
    for (let index = 0; index < partCount; index += 1) {
      const from = index * MULTIPART_CHUNK_SIZE;
      const chunk = bytes.subarray(
        from,
        Math.min(from + MULTIPART_CHUNK_SIZE, bytes.length),
      );
      const part = await readApi(
        await fetch(`${BASE}/api/files/multipart`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Upload-Request-Id": job.request.id,
            "X-Upload-Kind": "general",
            "X-Upload-Column-Id": job.column.id,
            "X-Upload-Key": start.key,
            "X-Upload-Id": start.uploadId,
            "X-Upload-Part": String(index + 1),
            cookie,
          },
          body: chunk,
        }),
      );
      parts.push(part.part);
    }

    await readApi(
      await fetch(`${BASE}/api/files/multipart`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          action: "complete",
          requestId: job.request.id,
          kind: "general",
          columnId: job.column.id,
          key: start.key,
          uploadId: start.uploadId,
          parts,
        }),
      }),
    );
  } catch (error) {
    // An abandoned multipart upload leaves its parts in the bucket, so a
    // failure aborts rather than simply giving up.
    await fetch(`${BASE}/api/files/multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        action: "abort",
        requestId: job.request.id,
        kind: "general",
        columnId: job.column.id,
        key: start.key,
        uploadId: start.uploadId,
      }),
    }).catch(() => {});
    throw error;
  }
}

for (const [index, job] of plan.entries()) {
  const handle = await open(job.file);
  try {
    const bytes = await handle.readFile();
    // The extension first, because it is what the operator sees; magic bytes
    // only when the name cannot say. See `sniffContentType`.
    const type =
      CONTENT_TYPES[job.extension] ??
      sniffContentType(bytes) ??
      "application/octet-stream";
    if (bytes.length > DIRECT_UPLOAD_LIMIT) {
      await uploadMultipart(job, bytes, type);
    } else {
      await uploadDirect(job, bytes, type);
    }
    uploaded += 1;
  } catch (error) {
    failed += 1;
    failures.push({
      asset: job.row.assetId,
      name: job.row.name,
      board: job.row.boardLabel,
      request: job.request.id,
      column: job.column.column_key,
      error: String(error.message ?? error),
    });
  } finally {
    await handle.close();
  }

  if ((index + 1) % 50 === 0 || index === plan.length - 1) {
    console.log(`  ${index + 1}/${plan.length} — ${uploaded} ok, ${failed} failed`);
  }
}

console.log(`\nuploaded ${uploaded}, failed ${failed}`);
if (failures.length) {
  console.log("\nfailures:");
  for (const failure of failures.slice(0, 20)) {
    console.log(`  ${failure.asset} ${failure.name}: ${failure.error}`);
  }
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  process.exitCode = 1;
}
