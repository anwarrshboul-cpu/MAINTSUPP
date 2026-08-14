import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const IMPORTER = "db/monday-export/import-monday-comments.mjs";
const THUMBNAILS = "db/monday-export/generate-thumbnails.mjs";
const FILES_ROUTE = "app/api/files/[id]/route.ts";
const CAPTURE = "db/monday-export/api-pull/comments.json";

const D1 =
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/" +
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite";
const R2 =
  ".wrangler/state/v3/r2/miniflare-R2BucketObject/" +
  "49e6826fd41b4990fd0dd7b3ba19a3021a358ffb618ea1ab8f4454a592996ae7.sqlite";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * Stage 24 — the comments and the pictures the import quietly dropped.
 *
 * Two defects, both invisible from the app because what is missing does not
 * draw anything.
 *
 *   6  TEN UPDATES NEVER ARRIVED. The importer skipped an update whose
 *      `text_body` was empty, on the reasoning that "an empty comment on screen
 *      reads as a bug". True of an update carrying nothing — but three of the
 *      ten it dropped are PHOTOGRAPHS WITH NO CAPTION, which monday renders
 *      perfectly well as a card that is the picture: 599116482 (2 assets),
 *      616199584 (2) and 601041893 (1). Those five are exactly the gap between
 *      the 58 assets in the capture and the 53 that reached `attachments`.
 *
 *      The tenth was collateral. The `continue` sat ABOVE the parent's reply
 *      loop, so skipping a parent skipped its entire conversation — which is
 *      how reply 616201331, "We sent an electrician on the 29th, but he could
 *      not fix the…", was lost: not for anything wrong with it, but because the
 *      update it hung under had no caption.
 *
 *   7  EVERY IMAGE CHIP DOWNLOADED THE FULL-SIZE ORIGINAL. `?thumb=1` serves
 *      `<objectKey>.thumb` when one exists and silently falls back to the
 *      original when it does not. None of the 49 images attached to comments
 *      had a derivative, because `generate-thumbnails.mjs` matched sources
 *      through the local `assets/` manifest and comment assets are streamed
 *      straight from monday's signed URLs into `POST /api/files` — they never
 *      land in `assets/`. 13,023,502 bytes across the corpus to draw 34px
 *      squares; 2,777,272 of them on one job.
 *
 * The capture is the authority for what SHOULD be there and is read here rather
 * than quoted. The database and R2 checks read the local development artefacts
 * and skip when they are absent, the same bargain stage-twentytwo-fix-tracker
 * makes. Nothing here writes.
 */

async function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // Older Node without the built-in driver.
  }
  try {
    return new DatabaseSync(path.join(root, file), { readOnly: true });
  } catch {
    return null; // No seeded development artefact on this machine.
  }
}

async function capture() {
  try {
    return JSON.parse(await read(CAPTURE));
  } catch {
    return null;
  }
}

/** The importer's own rule for what a comment is, applied to the capture. */
const cleanBody = (value) => (value ?? "").replace(/\s+/g, " ").trim();

function expectedFromCapture(pulled) {
  let parents = 0;
  let replies = 0;
  let pictureOnly = 0;
  let assets = 0;
  for (const items of Object.values(pulled)) {
    for (const item of items) {
      for (const update of item.updates ?? []) {
        const body = cleanBody(update.text_body);
        const assetCount = (update.assets ?? []).length;
        const replyList = update.replies ?? [];
        assets += assetCount;
        const keep = Boolean(body) || assetCount > 0 || replyList.length > 0;
        if (keep) parents += 1;
        if (!body && assetCount > 0) pictureOnly += 1;
        for (const reply of replyList) {
          if (keep && cleanBody(reply.text_body)) replies += 1;
        }
      }
    }
  }
  return { parents, replies, pictureOnly, assets };
}

/* ── 6. An update with no words is not necessarily an empty update ───────── */

test("an update with no caption but with assets is kept", async () => {
  const source = await read(IMPORTER);

  assert.match(
    source,
    /const keep = Boolean\(body\) \|\| assetCount > 0 \|\| replyList\.length > 0;/,
    "a picture with no caption is a card that is the picture",
  );

  // The bare skip is what dropped them.
  assert.doesNotMatch(
    source,
    /if \(!body\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*skipped\.push[^\n]*\n\s*continue;/,
    "the unconditional skip on an empty body is the defect",
  );
});

test("a skipped parent no longer takes its replies with it", async () => {
  const source = await read(IMPORTER);

  /*
   * The ordering is the whole fix. `keep` is true whenever the parent has
   * replies, so the `continue` that remains can only fire for an update with
   * no body, no assets AND no replies — nothing to lose. A reply is dropped
   * now only for its own emptiness.
   */
  const keepAt = source.indexOf("const keep = Boolean(body)");
  const replyLoopAt = source.indexOf("for (const reply of replyList)");
  assert.ok(keepAt > 0 && replyLoopAt > keepAt, "the reply loop must follow the keep decision");

  assert.match(
    source,
    /replyList\.length > 0/,
    "a parent with replies is the anchor that makes them reachable",
  );

  // A reply whose body is empty is now recorded as skipped rather than
  // vanishing silently.
  assert.match(source, /reason: "empty reply body"/);
});

test("the importer is idempotent by primary key", async () => {
  const source = await read(IMPORTER);

  // A re-run has to add the missing rows without duplicating the 265 already
  // there, or the fix could only ever be applied to an empty table.
  assert.match(source, /INSERT INTO item_updates/);
  assert.match(source, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(source, /const COMMIT = process\.argv\.includes\("--commit"\)/);
  assert.match(source, /Dry run\. Nothing written\. Pass --commit\./);

  // The count is recomputed from a COUNT, never incremented.
  assert.match(source, /SET comment_count = \(/);
  assert.doesNotMatch(source, /DELETE FROM item_updates/, "the importer must never remove a row");
});

test("every comment the capture holds is in the database", async (t) => {
  const pulled = await capture();
  const db = await openDatabase(D1);
  if (!pulled || !db) {
    t.skip("no capture or no development database on this machine");
    return;
  }

  const expected = expectedFromCapture(pulled);
  const parents = db
    .prepare("SELECT COUNT(*) AS c FROM item_updates WHERE id LIKE 'monday-update-%'")
    .get().c;
  const replies = db
    .prepare("SELECT COUNT(*) AS c FROM item_updates WHERE id LIKE 'monday-reply-%'")
    .get().c;

  assert.equal(
    parents,
    expected.parents,
    `the capture holds ${expected.parents} keepable comments, the database has ${parents}`,
  );
  assert.equal(
    replies,
    expected.replies,
    `the capture holds ${expected.replies} keepable replies, the database has ${replies}`,
  );
  assert.equal(expected.pictureOnly, 3, "three captioned-less pictures, per the capture");
});

test("the three caption-less pictures and the lost reply are rows", async (t) => {
  const db = await openDatabase(D1);
  if (!db) {
    t.skip("no development database on this machine");
    return;
  }

  for (const id of [
    "monday-update-599116482",
    "monday-update-616199584",
    "monday-update-601041893",
  ]) {
    const row = db.prepare("SELECT id, body FROM item_updates WHERE id = ?").get(id);
    assert.ok(row, `${id} is missing — the caption-less picture was dropped again`);
  }

  const lost = db
    .prepare("SELECT id, parent_id, body FROM item_updates WHERE id = 'monday-reply-616201331'")
    .get();
  assert.ok(lost, "reply 616201331 is missing — the parent's skip took it again");
  assert.ok(
    lost.body && lost.body.length > 40,
    "that reply carries real text; it was never empty",
  );
  assert.match(lost.body, /electrician/i);
  assert.ok(lost.parent_id, "a reply must hang off its parent");

  const parent = db
    .prepare("SELECT id FROM item_updates WHERE id = ?")
    .get(lost.parent_id);
  assert.ok(parent, "the anchor its parent_id names has to exist, or it is unreachable");
});

/* ── 7. A 34px chip is served 34px worth of bytes ────────────────────────── */

test("the file route serves a derivative when one exists and degrades when it does not", async () => {
  const source = await read(FILES_ROUTE);

  assert.match(source, /const thumbnailKey = `\$\{record\.objectKey\}\.thumb`/);
  assert.match(source, /const servingThumbnail = Boolean\(thumbnailHead\)/);
  assert.match(
    source,
    /const key = servingThumbnail \? thumbnailKey : record\.objectKey/,
    "a missing thumbnail degrades to a heavy image, never to a broken one",
  );
});

test("the thumbnail script can reach a file that never touched assets/", async () => {
  const source = await read(THUMBNAILS);

  /*
   * This is the actual cause. The script matched sources through the local
   * download manifest by name and byte size, and counted anything absent as
   * "source missing". Comment assets are uploaded through the API from
   * monday's signed URLs, so they are never in `assets/`, so the script could
   * never see them and 0 of the 49 had a derivative.
   */
  /*
   * Anchored on the closing backtick. Without it this also matches the
   * "have we already made one?" probe a few lines above, which asks for
   * `/api/files/<id>?thumb=1` and has been there since the script was written
   * — so the assertion would have passed against the very code it is meant to
   * pin, which is worse than no assertion at all.
   */
  assert.match(
    source,
    /const original = await fetch\(`\$\{BASE\}\/api\/files\/\$\{row\.id\}`/,
    "the original has to be readable back out of the app",
  );
  assert.doesNotMatch(
    source,
    /if \(!source \|\| !existsSync\(source\)\) \{\s*missing \+= 1;\s*continue;\s*\}/,
    "giving up when there is no local copy is what left the comment images bare",
  );

  // It writes, so it asks first.
  assert.match(source, /const COMMIT = args\.includes\("--commit"\)/);
  assert.match(source, /Dry run\./);
  assert.match(source, /--comments-only/, "the set that was never covered can be named");

  // It adds objects beside the originals and touches no row.
  assert.doesNotMatch(source, /DELETE FROM/);
  assert.doesNotMatch(source, /UPDATE attachments/);
});

test("every image on a comment has a thumbnail in the store", async (t) => {
  const d1 = await openDatabase(D1);
  const r2 = await openDatabase(R2);
  if (!d1 || !r2) {
    t.skip("no development database or object store on this machine");
    return;
  }

  const images = d1
    .prepare(
      `SELECT id, object_key, byte_size FROM attachments
        WHERE update_id IS NOT NULL AND content_type LIKE 'image/%'`,
    )
    .all();
  assert.ok(images.length >= 49, `expected the comment images, found ${images.length}`);

  const bare = [];
  for (const image of images) {
    const found = r2
      .prepare("SELECT key FROM _mf_objects WHERE key = ?")
      .get(`${image.object_key}.thumb`);
    if (!found) bare.push(image.id);
  }
  assert.deepEqual(
    bare,
    [],
    `${bare.length} comment images have no .thumb, so ?thumb=1 falls back to the original`,
  );
});

test("the live thumbnail is a thumbnail, not the original wearing its name", async (t) => {
  const d1 = await openDatabase(D1);
  if (!d1) {
    t.skip("no development database on this machine");
    return;
  }

  let cookie = null;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (response.ok) {
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((raw) => raw.split(";")[0])
        .join("; ");
    }
  } catch {
    cookie = null;
  }
  if (!cookie) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  // The heaviest comment image there is: the worst case is the honest test.
  const worst = d1
    .prepare(
      `SELECT id, byte_size FROM attachments
        WHERE update_id IS NOT NULL AND content_type LIKE 'image/%'
        ORDER BY byte_size DESC LIMIT 1`,
    )
    .get();

  const thumb = await fetch(`${BASE_URL}/api/files/${worst.id}?thumb=1`, { headers: { cookie } });
  assert.equal(thumb.status, 200);
  assert.equal(
    thumb.headers.get("content-type"),
    "image/webp",
    "a served derivative is WebP; the original's own type means it fell back",
  );

  const bytes = (await thumb.arrayBuffer()).byteLength;
  assert.ok(
    bytes < worst.byte_size / 10,
    `the chip pulled ${bytes} bytes against an original of ${worst.byte_size}`,
  );
});

/* ── The corpus is still the corpus ──────────────────────────────────────── */

test("nothing was removed from the tables this stage touched", async (t) => {
  const db = await openDatabase(D1);
  if (!db) {
    t.skip("no development database on this machine");
    return;
  }

  const count = (sql) => db.prepare(sql).get().c;

  assert.equal(count("SELECT COUNT(*) AS c FROM maintenance_requests"), 776);
  assert.equal(count("SELECT COUNT(*) AS c FROM attachments"), 2968);
  assert.equal(count("SELECT COUNT(*) AS c FROM sites"), 10);
  assert.equal(count("SELECT COUNT(*) AS c FROM maintenance_groups"), 84);

  /*
   * `item_updates` is a floor, not an equality.
   *
   * The Stage 24 import ADDED four rows that the old skip had dropped, and the
   * app writes to this table in normal use, so pinning an exact number here
   * would fail the first time somebody left a comment. What must never happen
   * is the count going backwards: 269 monday rows is every comment the capture
   * holds, and no importer run may return fewer.
   */
  assert.ok(
    count("SELECT COUNT(*) AS c FROM item_updates WHERE id LIKE 'monday-%'") >= 269,
    "monday's comments must never be fewer than the capture's 269",
  );
  assert.ok(
    count("SELECT COUNT(*) AS c FROM attachments WHERE update_id IS NOT NULL") >= 53,
    "a comment's files must never be unlinked",
  );
});
