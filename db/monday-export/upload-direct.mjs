/**
 * Transfers the exported monday files to object storage WITHOUT routing a
 * single byte through a Vercel function.
 *
 *   node db/monday-export/upload-direct.mjs \
 *     --export D:/MAINTSUPP-Monday-Export/full-2026-09-09 \
 *     --base   https://maintsupp-portal-git-develop-maintsupp.vercel.app \
 *     --org    org_000000000000000000000003 \
 *     --concurrency 3 --dry-run
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE (§10)
 * ---------------------------------------------------------------------------
 * An attachment ROW must never exist without its BYTES.
 *
 * Production is the proof of why. It holds 2,968 attachment rows claiming
 * 3,357 MB, and `storage.objects` is empty — every thumbnail and every download
 * in the live portal is broken, because a previous import wrote metadata that
 * its file transfer never caught up with. That is not a hypothetical failure
 * mode; it is the current state of the client's system.
 *
 * So the order is fixed and is not an implementation detail:
 *
 *     OBJECT TRANSFER -> VERIFY SIZE -> CREATE THE ROW
 *
 * `complete` on the multipart route is what creates the row, and it HEADs the
 * object and compares the byte count before it does. A transfer that fails
 * leaves an object with no row — invisible, sweepable, and harmless. The
 * opposite leaves a document the portal will 500 on forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BYTES DO NOT GO THROUGH VERCEL
 * ---------------------------------------------------------------------------
 * They cannot. S3 requires multipart parts of at least 5 MiB; Vercel refuses a
 * function request body over 4.5 MB. 73 of the 3,107 files need a part larger
 * than that and had no code path at all. This asks the server to SIGN a URL and
 * then PUTs to storage directly, so the function handles a few hundred bytes of
 * JSON per part and the 3.73 GB never touches it.
 *
 * ---------------------------------------------------------------------------
 * CHECKPOINT MODEL
 * ---------------------------------------------------------------------------
 * One JSON file, keyed by monday's `asset_id`, holding a state per file:
 *
 *   pending    nothing has happened
 *   uploading  a multipart upload was started; `key` and `uploadId` recorded
 *   uploaded   every part is in storage; `parts` recorded
 *   committed  `complete` returned and the attachment row exists; `fileId` set
 *   failed     the last attempt errored; `error` recorded, retried next run
 *
 * Written after every state change, so killing the process loses at most the
 * file in flight. A re-run skips `committed`, resumes `uploading` by
 * re-presigning the parts it has not sent, and retries `failed`. That makes the
 * whole transfer idempotent and restartable, which for 3,107 files over an hour
 * is the difference between a retry and starting again.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CHUNK = 5 * 1024 * 1024;

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i];
  if (!flag.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[flag.slice(2)] = next; i += 1; }
  else args[flag.slice(2)] = true;
}
if (!args.export) throw new Error("--export is required");
if (!args["dry-run"] && !args.base) throw new Error("--base is required unless --dry-run");

const ORG = args.org ?? "org_000000000000000000000003";
const PROTECTED = new Set([
  "org_000000000000000000000001", // Sunnamusk / the live Production tenant id
  "org_000000000000000000000002", // Demo
]);
if (PROTECTED.has(ORG) && !args["i-know-this-is-production"]) {
  throw new Error(
    `REFUSED: ${ORG} is a protected tenant. This tool will not upload into it ` +
      "without an explicit acknowledgement flag, and Phase 4 forbids doing so at all.",
  );
}

const CONCURRENCY = Math.max(1, Math.min(Number(args.concurrency ?? 3), 6));
const checkpointPath = path.join(args.export, `upload-checkpoint-${ORG}.json`);

/* ── manifest ────────────────────────────────────────────────────────────── */

function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^\uFEFF/, ""));
  return rows.filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const manifest = parseCsv(readFileSync(path.join(args.export, "file-manifest.csv"), "utf8"));

const files = manifest.map((row) => ({
  assetId: row.asset_id,
  itemId: row.item_id,
  name: row.filename,
  size: Number(row.downloaded_size || 0),
  sha256: row.sha256,
  contentType: row.content_type || "",
  source: row.source,
  columnId: row.column_id || "",
  file: path.join(args.export, row.path.replace(/\\/g, "/")),
}));

/* ── checkpoint ──────────────────────────────────────────────────────────── */

const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8"))
  : { organisation: ORG, export: args.export, files: {} };
if (checkpoint.organisation !== ORG) {
  throw new Error(
    `REFUSED: checkpoint at ${checkpointPath} belongs to ${checkpoint.organisation}, not ${ORG}`,
  );
}
let dirty = false;
const save = () => {
  if (!dirty) return;
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 1));
  dirty = false;
};
const setState = (assetId, patch) => {
  checkpoint.files[assetId] = { ...(checkpoint.files[assetId] ?? {}), ...patch };
  dirty = true;
};

/* ── transfer ────────────────────────────────────────────────────────────── */

const api = (body) =>
  fetch(`${args.base}/api/files/multipart`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: process.env.MAINTSUPP_COOKIE ?? "" },
    body: JSON.stringify(body),
  });

async function transfer(entry) {
  const state = checkpoint.files[entry.assetId] ?? {};
  if (state.state === "committed") return { skipped: true };

  const anchor = state.requestId ?? `job-${entry.itemId}`;
  const kind = "general";

  let key = state.key;
  let uploadId = state.uploadId;
  if (!key || !uploadId) {
    const started = await api({
      action: "start", requestId: anchor, kind,
      originalName: entry.name,
      contentType: entry.contentType || "application/octet-stream",
      byteSize: entry.size,
    });
    if (!started.ok) throw new Error(`start ${started.status}: ${(await started.text()).slice(0, 160)}`);
    const body = await started.json();
    key = body.key; uploadId = body.uploadId;
    setState(entry.assetId, { state: "uploading", key, uploadId, requestId: anchor, parts: [] });
    save();
  }

  const partCount = Math.max(1, Math.ceil(entry.size / CHUNK));
  const done = new Map((checkpoint.files[entry.assetId].parts ?? []).map((p) => [p.partNumber, p]));
  const missing = [];
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) missing.push(n);

  if (missing.length) {
    const signed = await api({
      action: "presign", requestId: anchor, kind, key, uploadId,
      partNumbers: missing.slice(0, 100),
    });
    const body = await signed.json();
    if (!body.supported) {
      throw new Error(
        "storage cannot presign — refusing to relay 3.73 GB through a function",
      );
    }
    const urls = new Map(body.parts.map((p) => [p.partNumber, p.url]));

    // Read only the part being sent, so a 41 MB file never sits in memory whole.
    const handle = await open(entry.file, "r");
    try {
      for (const n of missing.slice(0, 100)) {
        const offset = (n - 1) * CHUNK;
        const length = Math.min(CHUNK, entry.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        const res = await fetch(urls.get(n), { method: "PUT", body: buffer });
        if (!res.ok) throw new Error(`part ${n} -> ${res.status}`);
        const etag = (res.headers.get("etag") ?? "").replace(/^"|"$/g, "");
        if (!etag) throw new Error(`part ${n} returned no ETag`);
        done.set(n, { partNumber: n, etag });
        setState(entry.assetId, { parts: [...done.values()].sort((a, b) => a.partNumber - b.partNumber) });
        save();
      }
    } finally {
      await handle.close();
    }
  }

  if (done.size < partCount) return { partial: true, uploaded: done.size, of: partCount };
  setState(entry.assetId, { state: "uploaded" });
  save();

  /*
   * The row is created HERE and nowhere earlier. `complete` HEADs the object and
   * refuses if the byte count disagrees, so a row cannot outrun its bytes.
   */
  const completed = await api({
    action: "complete", requestId: anchor, kind, key, uploadId,
    parts: [...done.values()].sort((a, b) => a.partNumber - b.partNumber),
  });
  if (!completed.ok) {
    throw new Error(`complete ${completed.status}: ${(await completed.text()).slice(0, 200)}`);
  }
  const file = (await completed.json()).file ?? {};
  if (Number(file.byteSize) !== entry.size) {
    throw new Error(`size disagreement: stored ${file.byteSize}, source ${entry.size}`);
  }
  setState(entry.assetId, { state: "committed", fileId: file.id, byteSize: file.byteSize });
  save();
  return { committed: true, fileId: file.id };
}

/* ── run ─────────────────────────────────────────────────────────────────── */

const tally = { committed: 0, skipped: 0, failed: 0, partial: 0, bytes: 0 };
const missingOnDisk = files.filter((f) => !existsSync(f.file));
const oversize = files.filter((f) => f.size > 4.5 * 1000 * 1000);

console.log(`export        : ${args.export}`);
console.log(`organisation  : ${ORG}`);
console.log(`files         : ${files.length}`);
console.log(`bytes         : ${files.reduce((t, f) => t + f.size, 0).toLocaleString()}`);
console.log(`over 4.5 MB   : ${oversize.length} (these need the presigned path; there is no other)`);
console.log(`missing on disk: ${missingOnDisk.length}`);
console.log(`already done  : ${Object.values(checkpoint.files).filter((f) => f.state === "committed").length}`);
console.log(`concurrency   : ${CONCURRENCY}`);

if (args["dry-run"]) {
  console.log("\nDRY RUN — nothing was uploaded and no row was created.");
  const bySize = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  console.log("largest five, all of which require the direct path:");
  for (const f of bySize) {
    console.log(`  ${(f.size / 1024 / 1024).toFixed(1).padStart(7)} MiB  ${Math.ceil(f.size / CHUNK)} parts  ${f.name.slice(0, 58)}`);
  }
  process.exit(0);
}

const queue = files.filter((f) => checkpoint.files[f.assetId]?.state !== "committed");
let cursor = 0;
async function worker(id) {
  while (cursor < queue.length) {
    const entry = queue[cursor++];
    if (!existsSync(entry.file)) {
      setState(entry.assetId, { state: "failed", error: "file missing on disk" });
      tally.failed += 1;
      continue;
    }
    try {
      const result = await transfer(entry);
      if (result.committed) { tally.committed += 1; tally.bytes += entry.size; }
      else if (result.skipped) tally.skipped += 1;
      else if (result.partial) tally.partial += 1;
    } catch (error) {
      setState(entry.assetId, { state: "failed", error: String(error.message).slice(0, 200) });
      tally.failed += 1;
      console.log(`  FAILED ${entry.name.slice(0, 50)}: ${String(error.message).slice(0, 120)}`);
    }
    if ((tally.committed + tally.failed) % 25 === 0) {
      console.log(`  ${tally.committed} committed, ${tally.failed} failed, ` +
        `${(tally.bytes / 1024 / 1024).toFixed(0)} MiB transferred`);
    }
    save();
  }
}

const startedAt = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
save();
console.log(`\ncommitted ${tally.committed}, failed ${tally.failed}, partial ${tally.partial}, ` +
  `skipped ${tally.skipped} in ${((Date.now() - startedAt) / 1000 / 60).toFixed(1)} minutes`);
console.log(`checkpoint: ${checkpointPath}`);
process.exitCode = tally.failed > 0 ? 1 : 0;
