/**
 * Attaches monday's comment assets to the comments that carried them.
 *
 * A monday update can hold its own files — a quote PDF, a photo of the broken
 * part — and they belong to that comment, not loosely to the job. 58 of them
 * exist across the two boards. Until now they were counted by the comment
 * import and then discarded, which is why several imported comments read as
 * orphans: the body names a document ("Pro forma-0005585.pdf") that appeared
 * nowhere on screen.
 *
 * Two steps, and the ORDER matters. The file is uploaded through the app's own
 * `POST /api/files`, so the R2 object and the `attachments` row cannot
 * disagree — the same reason the board's photo import went that way. The route
 * has no concept of a comment, so the `update_id` link is written afterwards,
 * directly, against the id the route just returned.
 *
 * Signed monday URLs expire 3,600 seconds after the pull, so re-run
 * `pull-monday-comments.mjs` immediately before this.
 *
 * Idempotent: an asset already linked to its comment is skipped, matched on
 * the comment plus the filename and byte size — monday allows two files of the
 * same name on one update, and the size is what separates them.
 *
 *   npm run dev
 *   node db/monday-export/pull-monday-comments.mjs
 *   node db/monday-export/import-comment-assets.mjs --base http://localhost:5174 [--commit]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SOURCE = path.join(HERE, "api-pull", "comments.json");
const DB_PATH = path.join(
  ROOT,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const BASE = flagValue("--base", "http://localhost:5174").replace(/\/$/, "");
const COMMIT = args.includes("--commit");

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

const CONTENT_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", heic: "image/heic", pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain", csv: "text/csv", zip: "application/zip",
  mp4: "video/mp4", mov: "video/quicktime",
};

if (!existsSync(SOURCE)) {
  console.error(`No pull at ${SOURCE}. Run pull-monday-comments.mjs first.`);
  process.exit(1);
}

const pulled = JSON.parse(readFileSync(SOURCE, "utf8"));
const db = new DatabaseSync(DB_PATH);

/** Comment rows keyed by monday's update id, which the importer preserved. */
const updateByMondayId = new Map(
  db
    .prepare("SELECT id, request_id, organisation_id FROM item_updates WHERE id LIKE 'monday-update-%'")
    .all()
    .map((row) => [row.id.replace("monday-update-", ""), row]),
);

/** Already linked, so a re-run adds nothing twice. */
const existing = new Set(
  db
    .prepare(
      "SELECT update_id, original_name, byte_size FROM attachments WHERE update_id IS NOT NULL",
    )
    .all()
    .map((row) => `${row.update_id}|${row.original_name}|${row.byte_size}`),
);

const planned = [];
const skipped = [];

for (const items of Object.values(pulled)) {
  for (const item of items) {
    for (const update of item.updates ?? []) {
      const comment = updateByMondayId.get(String(update.id));
      if (!comment) {
        if ((update.assets ?? []).length) {
          skipped.push("the comment was not imported (empty body, or its job did not match)");
        }
        continue;
      }
      for (const asset of update.assets ?? []) {
        const size = Number(asset.file_size ?? 0);
        if (existing.has(`${comment.id}|${asset.name}|${size}`)) {
          skipped.push("already attached");
          continue;
        }
        planned.push({
          updateId: comment.id,
          requestId: comment.request_id,
          name: asset.name,
          url: asset.public_url,
          size,
          extension: (asset.file_extension ?? "").replace(/^\./, "").toLowerCase(),
        });
      }
    }
  }
}

console.log(`planned : ${planned.length} comment attachments`);
console.log(`skipped : ${skipped.length}`);
const reasons = {};
for (const reason of skipped) reasons[reason] = (reasons[reason] ?? 0) + 1;
for (const [reason, count] of Object.entries(reasons)) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}

if (!COMMIT) {
  console.log("\nDry run. Nothing uploaded. Pass --commit.");
  db.close();
  process.exit(0);
}

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

const DIRECT_UPLOAD_LIMIT = 900 * 1024;
const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;

async function readApi(response) {
  if (!response.ok) {
    throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
  }
  return response.json();
}

async function uploadDirect(job, bytes, type, cookie) {
  const form = new FormData();
  form.set("file", new File([bytes], job.name, { type }), job.name);
  form.set("requestId", job.requestId);
  form.set("kind", "general");
  return readApi(
    await fetch(`${BASE}/api/files`, { method: "POST", headers: { cookie }, body: form }),
  );
}

/** The chunked path, for anything the form parser would refuse. */
async function uploadMultipart(job, bytes, type, cookie) {
  const start = await readApi(
    await fetch(`${BASE}/api/files/multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        action: "start",
        requestId: job.requestId,
        kind: "general",
        originalName: job.name,
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
      const chunk = bytes.subarray(from, Math.min(from + MULTIPART_CHUNK_SIZE, bytes.length));
      const part = await readApi(
        await fetch(`${BASE}/api/files/multipart`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Upload-Request-Id": job.requestId,
            "X-Upload-Kind": "general",
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
    return await readApi(
      await fetch(`${BASE}/api/files/multipart`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          action: "complete",
          requestId: job.requestId,
          kind: "general",
          key: start.key,
          uploadId: start.uploadId,
          parts,
        }),
      }),
    );
  } catch (error) {
    // An abandoned multipart upload keeps its parts in the bucket.
    await fetch(`${BASE}/api/files/multipart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        action: "abort",
        requestId: job.requestId,
        kind: "general",
        key: start.key,
        uploadId: start.uploadId,
      }),
    }).catch(() => {});
    throw error;
  }
}

const link = db.prepare("UPDATE attachments SET update_id = ? WHERE id = ?");

let attached = 0;
let failed = 0;
const failures = [];

for (const [index, job] of planned.entries()) {
  try {
    const response = await fetch(job.url);
    if (!response.ok) throw new Error(`monday ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = CONTENT_TYPES[job.extension] ?? "application/octet-stream";

    /*
     * `general`, not `issue` or `completion`: a file on a comment is neither the
     * fault as reported nor the work as finished, and mislabelling it would put
     * it in the wrong board column and the wrong contractor view.
     *
     * The 900 KB fork is the same one `client-upload.ts` takes. The Workers
     * runtime refuses to parse a `multipart/form-data` body at or above 1 MiB
     * and answers a bare 413 before any route code runs — three of these
     * comment attachments are a video and two screenshots that land over it.
     */
    const payload =
      bytes.length > DIRECT_UPLOAD_LIMIT
        ? await uploadMultipart(job, bytes, type, cookie)
        : await uploadDirect(job, bytes, type, cookie);
    const attachmentId = payload?.file?.id;
    if (!attachmentId) throw new Error("upload returned no attachment id");

    // The route knows nothing about comments, so the link is written here
    // against the row it just created.
    link.run(job.updateId, attachmentId);
    attached += 1;
  } catch (error) {
    failed += 1;
    failures.push({ name: job.name, error: String(error.message ?? error) });
  }

  if ((index + 1) % 10 === 0 || index === planned.length - 1) {
    console.log(`  ${index + 1}/${planned.length} — ${attached} attached, ${failed} failed`);
  }
}

console.log(`\nattached ${attached}, failed ${failed}`);
console.log(
  `comments now carrying a file: ${
    db.prepare("SELECT COUNT(DISTINCT update_id) c FROM attachments WHERE update_id IS NOT NULL").get().c
  }`,
);
if (failures.length) {
  console.log("\nfailures:");
  for (const failure of failures.slice(0, 10)) {
    console.log(`  ${failure.name}: ${failure.error}`);
  }
  process.exitCode = 1;
}

db.close();
