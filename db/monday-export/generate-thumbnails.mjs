/**
 * Generates a small WebP thumbnail for every image attachment and stores it
 * beside the original.
 *
 * The board draws up to three 22px tiles per photo cell. Before this, those
 * tiles were the originals — one measured 4284x5712 at 4.5 MB — so a screenful
 * of the board pulled tens of megabytes to render a strip of stamps. On a phone
 * that is the difference between a board that loads and one that does not.
 *
 * The resize happens here rather than on the request path because workerd has
 * no image pipeline; `sharp` is already a dependency of this repo for the
 * marketing photographs. The result is PUT to
 * `PUT /api/files/<id>`, which writes it into the same bucket the app
 * reads — Miniflare's on-disk layout is an internal detail, so going through
 * the app is the only way to be certain the bytes land where the app looks.
 *
 * Idempotent: an attachment whose thumbnail already answers `?thumb=1` with a
 * WebP is skipped, so a re-run only fills the gaps.
 *
 * WHERE THE ORIGINAL COMES FROM — two places, in this order.
 *
 * It used to be the local download only, matched through `manifest.json` by
 * name and byte size, and anything not in that manifest was counted as "source
 * missing" and left alone. That is why the 49 images attached to COMMENTS had
 * no derivative: `import-comment-assets.mjs` streams them straight from
 * monday's signed URLs into `POST /api/files`, so they never land in
 * `assets/`, so this script could never see them. The consequence was
 * measurable — `?thumb=1` silently falls back to the original, so nine 34px
 * chips on one job pulled 2,777,272 bytes, and 13,023,502 bytes across the
 * corpus, to draw postage stamps.
 *
 * So: local file if the manifest has one — no network, no dependency on the
 * app — and otherwise the app's own `GET /api/files/<id>`, which is the bytes
 * as stored. Every image attachment is reachable one way or the other,
 * whatever route it arrived by.
 *
 * DRY RUN BY DEFAULT. It writes only `<key>.thumb` objects beside the
 * originals and touches no row, but it is still a write, and this repo's rule
 * for a script that changes stored state is that you have to ask for it.
 *
 * Usage:
 *   npm run dev                       # in another terminal
 *   node db/monday-export/generate-thumbnails.mjs --base http://localhost:5173 [--limit N] [--commit]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
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
const BASE = flag("--base", "http://localhost:5174").replace(/\/$/, "");
const LIMIT = Number(flag("--limit", Infinity));
const COMMIT = args.includes("--commit");
// The whole corpus by default; `--comments-only` narrows to the images hanging
// off a comment, which is the set that was never covered.
const COMMENTS_ONLY = args.includes("--comments-only");

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/*
 * 96px on the long edge.
 *
 * The tile is 22px at 1x and 26px on mobile, so 96px covers a 3x display with
 * room to spare and still lands in single-digit kilobytes. Going smaller saves
 * nothing that matters and looks soft on a retina screen.
 */
const THUMBNAIL_EDGE = 96;

function safeName(name) {
  return (name || "file")
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

/*
 * Only images. A PDF, a video and a zip render as a glyph in the cell, so a
 * derivative for them would be bytes nothing asks for.
 */
const rows = db
  .prepare(
    `SELECT id, original_name, content_type, byte_size
       FROM attachments
      WHERE content_type LIKE 'image/%'
        ${COMMENTS_ONLY ? "AND update_id IS NOT NULL" : ""}
      ORDER BY created_at`,
  )
  .all();
db.close();

/*
 * The original on disk, matched by monday's asset id in the filename.
 *
 * The downloader wrote `<assetId>-<safe name>`, and the same safe-name rule is
 * applied here. Matching on the name alone would be ambiguous — monday allows
 * two files of the same name in one cell — so the size is checked too, and a
 * mismatch is reported rather than silently thumbnailed from the wrong photo.
 */
const manifest = JSON.parse(
  readFileSync(path.join(HERE, "api-pull", "manifest.json"), "utf8"),
);
const localByNameSize = new Map();
for (const entry of manifest) {
  localByNameSize.set(
    `${entry.name}|${entry.byteSize}`,
    path.join(ASSETS, entry.boardLabel, `${entry.assetId}-${safeName(entry.name)}`),
  );
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

let made = 0;
let skipped = 0;
let missing = 0;
let failed = 0;
let bytesIn = 0;
let bytesOut = 0;
const failures = [];

const work = rows.slice(0, LIMIT);
console.log(`${rows.length} image attachments, ${work.length} in scope.\n`);

let fromApp = 0;
let wouldMake = 0;

for (const [index, row] of work.entries()) {
  const local = localByNameSize.get(`${row.original_name}|${row.byte_size}`);
  const source = local && existsSync(local) ? local : null;

  // Already done? `?thumb=1` answers WebP only when a derivative exists.
  try {
    const probe = await fetch(`${BASE}/api/files/${row.id}?thumb=1`, {
      method: "HEAD",
      headers: { cookie },
    });
    if (probe.ok && probe.headers.get("content-type") === "image/webp") {
      skipped += 1;
      continue;
    }
  } catch {
    // A failed probe is not a reason to skip; fall through and regenerate.
  }

  /*
   * No local copy — read the original back out of the app.
   *
   * This is the branch that used to be `missing += 1; continue`. Every comment
   * attachment lands here, because it was uploaded through the API from
   * monday's signed URL and was never written to `assets/`.
   */
  let input = source;
  if (!input) {
    try {
      const original = await fetch(`${BASE}/api/files/${row.id}`, { headers: { cookie } });
      if (!original.ok) throw new Error(`HTTP ${original.status}`);
      input = Buffer.from(await original.arrayBuffer());
      fromApp += 1;
    } catch (error) {
      missing += 1;
      failures.push({
        id: row.id,
        name: row.original_name,
        error: `no local copy and the app would not serve it: ${String(error.message ?? error)}`,
      });
      continue;
    }
  }

  if (!COMMIT) {
    wouldMake += 1;
    continue;
  }

  try {
    const thumbnail = await sharp(input)
      .rotate() // Honour EXIF orientation, or every phone photo lands sideways.
      .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: "cover", position: "centre" })
      .webp({ quality: 72 })
      .toBuffer();

    const response = await fetch(`${BASE}/api/files/${row.id}`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp", cookie },
      body: thumbnail,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
    }
    made += 1;
    bytesIn += row.byte_size;
    bytesOut += thumbnail.byteLength;
  } catch (error) {
    failed += 1;
    failures.push({ id: row.id, name: row.original_name, error: String(error.message ?? error) });
  }

  if ((index + 1) % 100 === 0 || index === work.length - 1) {
    console.log(`  ${index + 1}/${work.length} — ${made} made, ${skipped} skipped, ${failed} failed`);
  }
}

console.log(
  `\nmade ${made}, skipped ${skipped} (already have one), unreachable ${missing}, failed ${failed}`,
);
console.log(`${fromApp} originals read back from the app rather than from assets/`);
if (!COMMIT) {
  console.log(`\nDry run. ${wouldMake} thumbnails would be written. Pass --commit.`);
}
if (made) {
  console.log(
    `${(bytesIn / 1024 / 1024).toFixed(0)} MB of originals -> ` +
      `${(bytesOut / 1024).toFixed(0)} KB of thumbnails ` +
      `(${(bytesIn / Math.max(bytesOut, 1)).toFixed(0)}x smaller)`,
  );
}
if (failures.length) {
  console.log("\nfailures:");
  for (const failure of failures.slice(0, 10)) {
    console.log(`  ${failure.id} ${failure.name}: ${failure.error}`);
  }
  process.exitCode = 1;
}
