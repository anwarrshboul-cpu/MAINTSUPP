/**
 * Downloads every asset named in `api-pull/manifest.json` to `assets/`.
 *
 * Separate from the pull because the two fail differently. The pull is one
 * cheap pass over the API; this is 2,917 files and 3.4 GB over an hour-limited
 * signature, so it is built to be interrupted and re-run: a file already on
 * disk at its manifest byte size is skipped, and only what is missing is
 * fetched. Killing it and starting again costs nothing already paid for.
 *
 * Usage:
 *   set -a; . ./.env.monday; set +a
 *   node db/monday-export/download-monday-assets.mjs [--limit N] [--board LABEL]
 *
 * Files land at assets/<board>/<assetId>-<safe name>, which keeps monday's
 * asset id — the only stable identity a file has — in the filename, so the
 * import step can match a file back to its cell without trusting the name.
 * monday allows two files with the same name in the same column; the id is
 * what makes them distinguishable.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "api-pull", "manifest.json");
const ASSET_DIR = path.join(HERE, "assets");

const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) {
  console.error("MONDAY_API_TOKEN is not set. `set -a; . ./.env.monday; set +a`");
  process.exit(1);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const boardArg = args.indexOf("--board");
const BOARD = boardArg >= 0 ? args[boardArg + 1] : null;

/*
 * Eight at a time.
 *
 * These are S3 reads, not monday API calls, so the complexity budget does not
 * apply — but 2,900 concurrent connections would exhaust the socket pool and
 * the failures would look like corruption rather than congestion. Eight keeps
 * a domestic connection saturated without that.
 */
const CONCURRENCY = 8;

/** Safe on every filesystem, and recognisable when someone opens the folder. */
function safeName(name) {
  return (name || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Fresh signed URLs for assets whose hour has run out.
 *
 * A signature is valid for 3,600 seconds from the pull, and a 3.4 GB download
 * outlives that. Re-querying `assets(ids:)` is far cheaper than re-running the
 * whole board pull, so the downloader refreshes in batches of 100 as it goes
 * rather than asking the operator to start over.
 */
async function refreshUrls(assetIds) {
  const fresh = new Map();
  for (let i = 0; i < assetIds.length; i += 100) {
    const batch = assetIds.slice(i, i + 100);
    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: TOKEN,
        "Content-Type": "application/json",
        "API-Version": "2024-10",
      },
      body: JSON.stringify({
        query: `{ assets(ids: [${batch.join(",")}]) { id public_url } }`,
      }),
    });
    const body = await response.json();
    if (body.errors) throw new Error(`refresh failed: ${JSON.stringify(body.errors)}`);
    for (const asset of body.data.assets ?? []) {
      fresh.set(String(asset.id), asset.public_url);
    }
  }
  return fresh;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))
  .filter((row) => (BOARD ? row.boardLabel === BOARD : true))
  .slice(0, LIMIT);

for (const label of new Set(manifest.map((row) => row.boardLabel))) {
  mkdirSync(path.join(ASSET_DIR, label), { recursive: true });
}

function targetPath(row) {
  return path.join(
    ASSET_DIR,
    row.boardLabel,
    `${row.assetId}-${safeName(row.name)}`,
  );
}

/*
 * A partial file from an interrupted run is worse than no file: it is the right
 * size to look finished at a glance and the wrong bytes to open. So every
 * download writes to `.part` and is renamed only once the stream closes, and a
 * size mismatch against the manifest deletes the file rather than keeping it.
 */
async function download(row, url) {
  const target = targetPath(row);
  const partial = `${target}.part`;
  const response = await fetch(url);
  if (response.status === 403) return "expired";
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));

  const written = statSync(partial).size;
  if (row.byteSize && written !== row.byteSize) {
    await unlink(partial);
    throw new Error(`size mismatch: expected ${row.byteSize}, got ${written}`);
  }
  await rename(partial, target);
  return "downloaded";
}

const pending = manifest.filter((row) => {
  const target = targetPath(row);
  if (!existsSync(target)) return true;
  return row.byteSize ? statSync(target).size !== row.byteSize : false;
});

console.log(
  `${manifest.length} assets in scope, ${manifest.length - pending.length} already on disk, ${pending.length} to fetch.`,
);

const urls = new Map(pending.map((row) => [row.assetId, row.publicUrl]));
let done = 0;
let failed = 0;
let bytes = 0;
const failures = [];

const queue = [...pending];
async function worker() {
  while (queue.length) {
    const row = queue.shift();
    try {
      let result = await download(row, urls.get(row.assetId));
      if (result === "expired") {
        const fresh = await refreshUrls([row.assetId]);
        const url = fresh.get(row.assetId);
        if (!url) throw new Error("no fresh URL returned");
        result = await download(row, url);
        if (result === "expired") throw new Error("403 after refresh");
      }
      done += 1;
      bytes += row.byteSize;
    } catch (error) {
      failed += 1;
      failures.push({ assetId: row.assetId, name: row.name, error: String(error.message ?? error) });
    }
    const total = done + failed;
    if (total % 50 === 0 || !queue.length) {
      console.log(
        `  ${total}/${pending.length} — ${done} ok, ${failed} failed, ${(bytes / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\ndownloaded ${done}, failed ${failed}, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
if (failures.length) {
  console.log("\nfailures (re-run to retry — finished files are skipped):");
  for (const failure of failures.slice(0, 20)) {
    console.log(`  ${failure.assetId} ${failure.name}: ${failure.error}`);
  }
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
  process.exitCode = 1;
}
