/**
 * Decision K — the website media library, in a bucket of its own (§77 item 12).
 *
 * Pinned here:
 *   - SEPARATION: the website's files live in `CMS_BUCKET` (`cms-media`),
 *     never in `BUCKET` (`job-media`), and no route here touches the other;
 *   - WHO: platform staff only, on every read and write; the public reads a
 *     file only through `/media/...`, which reads one well-formed website key;
 *   - THE UPLOAD PATH IS #78's: session-bound multipart, parts listed from the
 *     bucket, each part's MD5 against its ETag, the size, the byte signature;
 *   - WHAT MAY BE STORED: images, MP4/WebM, PDF — and the one size policy;
 *   - SAFE REPLACEMENT: a new version under a new key; the old kept, restorable;
 *   - USAGE AWARENESS: an asset a page names cannot be deleted;
 *   - A MISSING BUCKET FAILS TRUTHFULLY and falls back to nothing.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const media = await import("../app/lib/cms-media.ts");
const blocks = await import("../app/lib/cms-blocks.ts");

/* ------------------------------------------------------------------ */
/* Real bytes, made here                                               */
/* ------------------------------------------------------------------ */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
/** A real, decodable PNG of `width` × `height`. */
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows[y * (width * 3 + 1) + 1 + x * 3] = (x * 40) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A lossless WebP header of the given size (enough for the header parsers). */
function webpHeader(width, height) {
  const bits = (width - 1) | ((height - 1) << 14);
  const body = Buffer.from([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff, 0, 0, 0]);
  const vp8l = Buffer.concat([Buffer.from("VP8L"), Buffer.from([body.length, 0, 0, 0]), body]);
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(4 + vp8l.length);
  return Buffer.concat([Buffer.from("RIFF"), riff, Buffer.from("WEBP"), vp8l]);
}
/** A JPEG whose frame header follows a large APP1 block, as a camera's does. */
function jpegHeader(width, height) {
  const app1 = Buffer.alloc(40_000, 0x41);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

/* ------------------------------------------------------------------ */
/* What may be stored                                                  */
/* ------------------------------------------------------------------ */

test("the library takes images, MP4/WebM and PDF — both claims must agree", () => {
  const accepted = [
    ["hero.JPG", "image/jpeg", "image"],
    ["hero.jpeg", "", "image"],
    ["logo.png", "image/png", "image"],
    ["team.webp", "image/webp", "image"],
    ["spinner.gif", "image/gif", "image"],
    ["tour.mp4", "video/mp4", "video"],
    ["tour.webm", "video/webm", "video"],
    ["brochure.pdf", "application/pdf", "document"],
  ];
  for (const [name, type, kind] of accepted) assert.equal(media.mediaTypeFor(name, type)?.kind, kind, `${name} ${type}`);
  const refused = [
    ["logo.svg", "image/svg+xml"],
    ["photo.heic", "image/heic"],
    ["clip.mov", "video/quicktime"],
    ["x.png", "text/html"],
    ["x.html", "image/png"],
    ["x.mp4", "text/plain"],
    ["price-list.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["noext", "image/png"],
    ["", "image/png"],
  ];
  for (const [name, type] of refused) assert.equal(media.mediaTypeFor(name, type), null, `${name} ${type}`);
  assert.doesNotMatch(media.CMS_MEDIA_ACCEPT, /svg|heic|quicktime/);
});

test("the one size policy: video 50 MB, everything else 25 MB", async () => {
  const policy = await import("../app/lib/upload-policy.ts");
  assert.equal(media.mediaSizeRefusal("video", policy.MAX_VIDEO_FILE_SIZE), null);
  assert.equal(media.mediaSizeRefusal("video", policy.MAX_VIDEO_FILE_SIZE + 1), policy.VIDEO_TOO_LARGE);
  assert.equal(media.mediaSizeRefusal("image", policy.MAX_STANDARD_FILE_SIZE + 1), policy.FILE_TOO_LARGE);
  assert.equal(media.mediaSizeRefusal("document", policy.MAX_STANDARD_FILE_SIZE), null);
});

test("keys and addresses: one shape, never reused, never outside cms/", () => {
  const mediaId = media.newMediaId();
  const versionId = media.newVersionId();
  assert.ok(media.isMediaId(mediaId) && media.isVersionId(versionId));
  assert.equal(media.mediaFileName("Façade Survey (Final).PDF"), "facade-survey-final.pdf");
  assert.equal(media.mediaFileName("../../etc/passwd.png"), "etc-passwd.png");
  assert.equal(media.mediaFileName("display.webp"), "original-display.webp", "an upload may not take the rendition's name");
  const key = media.mediaObjectKey(mediaId, versionId, "hero.jpg");
  assert.equal(key, `cms/${mediaId}/${versionId}/hero.jpg`);
  assert.equal(media.mediaUrl(key), `/media/${mediaId}/${versionId}/hero.jpg`);
  assert.equal(media.keyFromMediaPath(mediaId, versionId, "hero.jpg"), key);
  for (const [m, v, n] of [
    ["med_x", versionId, "a.jpg"],
    [mediaId, "mv_x", "a.jpg"],
    [mediaId, versionId, "../a.jpg"],
    [mediaId, versionId, "a..b.jpg"],
    [mediaId, versionId, "A.jpg"],
    [mediaId, versionId, "a b.jpg"],
    ["..", versionId, "a.jpg"],
  ]) {
    assert.equal(media.keyFromMediaPath(m, v, n), null, `${m}/${v}/${n}`);
  }
});

test("image dimensions come from the file's own header", () => {
  assert.deepEqual(media.imageDimensions("image/png", png(3, 2)), { width: 3, height: 2 });
  assert.deepEqual(media.imageDimensions("image/webp", webpHeader(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(media.imageDimensions("image/jpeg", jpegHeader(4032, 3024)), { width: 4032, height: 3024 }, "past a long EXIF block");
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 20, 0])]);
  assert.deepEqual(media.imageDimensions("image/gif", gif), { width: 10, height: 20 });
  assert.equal(media.imageDimensions("image/png", Buffer.from("not a png")), null);
  assert.equal(media.imageDimensions("image/jpeg", jpegHeader(10, 10).subarray(0, 1000)), null, "a truncated read says nothing rather than guess");
});

test("alt text is held to the site's copy rules; usage is read from any block body", () => {
  assert.equal(media.cleanMediaMeta({ altText: "Our engineers at work" }).ok, false);
  assert.deepEqual(media.cleanMediaMeta({ title: "  Store   front ", altText: "" }), { ok: true, title: "Store front", altText: null });
  assert.equal(media.cleanMediaMeta({ title: "" }).ok, false);
  const id = media.newMediaId();
  assert.deepEqual(media.mediaIdsIn(JSON.stringify({ mediaId: id, caption: "x" })), [id]);
  assert.deepEqual(media.mediaIdsIn({ nested: [{ mediaId: id }, { mediaId: "med_nope" }] }), [id]);
  assert.deepEqual(media.mediaIdsIn("{broken"), []);
  /*
   * AND AN ASSET THAT IS ONLY LINKED, which is the ONLY way a PDF is ever used:
   * no block embeds one, so a brochure in use on a live page read as "Not used
   * yet" while `mediaId` was the only thing counted — Delete stayed enabled and
   * 404ed the link. Any string value, under any key, at any depth.
   */
  const versionId = media.newVersionId();
  const href = media.mediaUrl(media.mediaObjectKey(id, versionId, "brochure.pdf"));
  assert.deepEqual(media.mediaIdsIn({ buttonHref: href }), [id], "a cta's href counts as a use");
  assert.deepEqual(
    media.mediaIdsIn(JSON.stringify({ html: `<p>See the <a href="${href}">brochure</a>.</p>` })),
    [id],
    "and so does a link inside a body",
  );
  assert.deepEqual(media.mediaIdsIn({ buttonHref: "/media/med_nothex/mv_x/y.pdf" }), [], "a malformed address names nothing");
  assert.deepEqual(media.mediaIdsIn({ mediaId: id, buttonHref: href }), [id], "embedded and linked is one use");
});

test("the image and video blocks name an asset by id, and nothing else passes", () => {
  const id = media.newMediaId();
  assert.equal(blocks.validateBlock("image", { mediaId: id, alt: "A shopfront" }).ok, true);
  assert.match(blocks.validateBlock("image", { mediaId: "https://evil.example/x.png" }).reason, /choose an image from the media library/);
  assert.match(blocks.validateBlock("video", {}).reason, /choose a video/);
  assert.equal(blocks.validateBlock("image", { mediaId: id, alt: "From £99" }).ok, false, "alt text and captions pass the claims rules");
  const kinds = blocks.BLOCK_CATALOGUE.map((entry) => entry.kind);
  assert.ok(kinds.includes("image") && kinds.includes("video"));
  assert.ok(!blocks.CMS_OMISSIONS.some((line) => /no image block/i.test(line)), "the gap K closes is no longer claimed");
});

/* ------------------------------------------------------------------ */
/* Storage, against real SQLite                                        */
/* ------------------------------------------------------------------ */

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS cms_media \([\s\S]*?\))`/)[1]);
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS cms_media_versions \([\s\S]*?\))`/)[1].replace(/BIGINT/g, "INTEGER"));
  for (const index of init.matchAll(/"(CREATE UNIQUE INDEX IF NOT EXISTS cms_media_versions_[^"]+)"/g)) sqlite.exec(index[1]);
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS site_pages \([\s\S]*?\))`/)[1].replace(/\/\*[\s\S]*?\*\//g, ""));
  for (const column of ["publish_at TEXT", "unpublish_at TEXT", "robots TEXT NOT NULL DEFAULT 'index'", "canonical_url TEXT"]) {
    sqlite.exec(`ALTER TABLE site_pages ADD COLUMN ${column}`);
  }
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS site_blocks \([\s\S]*?\))`/)[1].replace(/\/\*[\s\S]*?\*\//g, ""));
  const db = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  return { sqlite, db };
}

test("storage: an asset keeps every file it has had, and knows where it is used", async () => {
  const repo = await import("../app/lib/cms-media-repository.ts");
  const { db, sqlite } = await database();
  const id = media.newMediaId();
  await repo.createMedia(db, { id, kind: "image", title: "Shopfront", altText: null, actorEmail: "staff@maintsupp.com" });
  assert.deepEqual(await repo.listMedia(db), [], "no file yet, so not in the library");
  const version = (versionNo, versionId = media.newVersionId()) => ({
    id: versionId,
    mediaId: id,
    versionNo,
    objectKey: media.mediaObjectKey(id, versionId, "shopfront.png"),
    originalName: "shopfront.png",
    contentType: "image/png",
    byteSize: 1234,
    width: 3,
    height: 2,
    durationMs: null,
    displayKey: null,
    displayWidth: null,
    displayHeight: null,
    uploadedByEmail: "staff@maintsupp.com",
  });
  const first = version(1);
  await repo.addVersionAndMakeCurrent(db, first, "staff@maintsupp.com");
  assert.equal(await repo.nextVersionNo(db, id), 2);
  const second = version(2);
  await repo.addVersionAndMakeCurrent(db, second, "staff@maintsupp.com");
  const read = await repo.readMedia(db, id);
  assert.equal(read.item.current.id, second.id, "a replacement becomes current");
  assert.deepEqual(read.versions.map((entry) => entry.versionNo), [2, 1], "and the first file is kept");
  assert.notEqual(first.objectKey, second.objectKey, "under its own key — the bytes under a key never change");
  await assert.rejects(repo.addVersionAndMakeCurrent(db, { ...version(2), id: media.newVersionId() }, "x"), "one number per version");

  await repo.setDisplayRendition(db, second.id, { key: media.mediaObjectKey(id, second.id, media.DISPLAY_RENDITION), width: 3, height: 2 });
  const render = await repo.resolveMediaForRender(db, [id, media.newMediaId()]);
  assert.equal(render.size, 1, "an unknown id resolves to nothing");
  assert.match(render.get(id).src, /\/display\.webp$/, "images are drawn from the web-sized copy");
  assert.deepEqual((await repo.keysOfMedia(db, id)).length, 3, "both originals and the copy");

  sqlite.prepare("INSERT INTO site_pages (id, slug, title, published) VALUES ('p1','careers','Careers',1), ('p2','draft','Draft',0)").run();
  sqlite
    .prepare("INSERT INTO site_blocks (id, page_id, kind, position, body) VALUES ('b1','p1','image',0,?), ('b2','p2','image',0,?), ('b3','p2','heading',1,'{}')")
    .run(JSON.stringify({ mediaId: id, alt: "x" }), JSON.stringify({ mediaId: id }));
  const usage = (await repo.mediaUsage(db)).get(id);
  assert.deepEqual(usage.map((entry) => [entry.slug, entry.state]).sort(), [["careers", "live"], ["draft", "draft"]], "live AND draft pages count");

  /* A PDF is never embedded — it is LINKED, from a cta's href — and that is a use. */
  const pdf = media.newMediaId();
  const pdfVersion = media.newVersionId();
  sqlite
    .prepare("INSERT INTO site_blocks (id, page_id, kind, position, body) VALUES ('b4','p1','cta',2,?)")
    .run(
      JSON.stringify({
        title: "Our standards",
        buttonLabel: "Download the brochure",
        buttonHref: media.mediaUrl(media.mediaObjectKey(pdf, pdfVersion, "brochure.pdf")),
      }),
    );
  assert.deepEqual(
    (await repo.mediaUsage(db)).get(pdf)?.map((entry) => entry.slug),
    ["careers"],
    "a linked PDF is in use on the live page that links it",
  );

  await repo.updateMediaMeta(db, id, { currentVersionId: first.id, status: "archived", altText: "A shopfront" }, "x");
  const back = await repo.readMedia(db, id);
  assert.equal(back.item.current.id, first.id, "an earlier file can be made current again");
  assert.equal(back.item.status, "archived");
  assert.equal((await repo.resolveMediaForRender(db, [id])).size, 1, "an archived asset still draws where it is used");
  assert.equal(await repo.deleteMediaRows(db, id), true);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cms_media_versions").get().n, 0);
});

/* ------------------------------------------------------------------ */
/* Source pins                                                         */
/* ------------------------------------------------------------------ */

test("separate storage: the website bucket is its own binding and nothing here touches the documents one", async () => {
  const env = code(await read("db/node-workers-env.ts"));
  assert.match(env, /CMS_BUCKET: cmsMediaBucket\(\),/);
  assert.match(env, /S3_BUCKET: process\.env\.S3_CMS_BUCKET\?\.trim\(\) \|\| "cms-media",/, "its own bucket name, the other three S3_* shared");
  /*
   * RE-POINTED, AND THE RULE CHANGED WITH IT — a MEDIUM finding from the review of
   * this branch. This used to pin `createS3BucketFromEnv(...) ?? createR2Bucket({
   * dir: <R2_LOCAL_DIR>/cms-media })`, which meant that a deployment missing ONE
   * of the four S3_* variables got a per-instance directory — `/tmp/maintsupp-r2`
   * on Vercel. It lists fine, so `mediaStorageStatus` answered "ready", uploads
   * appeared to work, and the bytes went with the instance: exactly the silent
   * loss CLAUDE.md records for `BUCKET`. A half-configured deployment must now get
   * NO BINDING, so `cmsBucket()` is null and the routes say so.
   */
  assert.match(env, /if \(s3IsIntended\(\)\) return undefined;/, "some S3_* but not all is no binding, not a directory");
  assert.match(
    env,
    /const documents = process\.env\.R2_LOCAL_DIR \?\? path\.join\(process\.cwd\(\), "\.r2-local"\);\s*\n\s*return createR2Bucket\(\{ dir: `\$\{documents\}-cms-media` \}\);/,
    "and where there is no S3 at all, a directory BESIDE the documents one — never inside it, so clearing documents cannot take website media",
  );
  assert.doesNotMatch(env, /, "cms-media"\)/, "the directory nested inside the documents root is gone");
  const vite = await read("vite.config.ts");
  assert.match(vite, /binding: "CMS_BUCKET",\s*bucket_name: "site-creator-cms-media"/);
  for (const file of [
    "app/lib/cms-media-storage.ts",
    "app/api/cms-media/route.ts",
    "app/api/cms-media/upload/route.ts",
    "app/media/[mediaId]/[versionId]/[name]/route.ts",
  ]) {
    const source = code(await read(file));
    assert.doesNotMatch(source, /env\.BUCKET\b|\bBUCKET\?:|"\/api\/files/, `${file} must never reach the documents bucket`);
  }
  assert.match(code(await read("app/lib/cms-media-storage.ts")), /return \(env\.CMS_BUCKET as R2Bucket \| undefined\) \?\? null;/, "no binding is null — never a fallback");
  const cron = code(await read("app/api/cron/daily/route.ts"));
  assert.match(cron, /const bucket = target === "cms-media" \? env\.CMS_BUCKET : env\.BUCKET;/, "an abandoned website upload is aborted in the website bucket");
});

test("who: platform staff with a session on every read and write; no capability can reach it", async () => {
  for (const file of ["app/api/cms-media/route.ts", "app/api/cms-media/upload/route.ts"]) {
    const source = code(await read(file));
    assert.match(source, /if \(scope\.platformAdmin !== true\) return null;\s*if \(!scope\.authenticated\) return null;/, file);
    assert.doesNotMatch(source, /requireCapability|resolvePermissions/, `${file} names no workspace capability`);
    const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((match) => match[1]);
    for (const handler of handlers) {
      const body = source.slice(source.indexOf(`export async function ${handler}`)).split(/\nexport async function /)[0];
      assert.match(body, /if \(!scope\) return forbidden\(\);/, `${file} ${handler} is gated`);
    }
  }
});

test("the upload path is #78's: session-bound, bucket-listed parts, MD5 per part, size, signature", async () => {
  const route = code(await read("app/api/cms-media/upload/route.ts"));
  assert.match(route, /target: "cms-media",/, "the session names its bucket");
  assert.match(route, /session && session\.target === "cms-media" \? session : null/, "and this route touches only its own sessions");
  assert.match(route, /direct\.presignPart\(partNumber, size, PART_URL_LIFETIME_SECONDS\)/);
  assert.match(route, /assembleVerifiedUpload\(\{/);
  const start = route.slice(route.indexOf('if (action === "start")'), route.indexOf("if (action !== \"abort\""));
  assert.ok(start.indexOf("mediaTypeFor(") < start.indexOf("createMultipartUpload("), "the type is checked before anything is reserved");
  assert.ok(start.indexOf("mediaSizeRefusal(") < start.indexOf("createMultipartUpload("), "and the size");
  const assembly = code(await read("app/lib/upload-assembly.ts"));
  for (const step of ["direct.listParts()", "partsMatchPlan(listed, plan)", "declared.get(part.partNumber) === part.etag.toLowerCase()", "multipart.complete(parts)", "size !== Number(session.byteSize)", "signatureMatches("]) {
    assert.ok(assembly.includes(step), `the shared assembly keeps: ${step}`);
  }
  const order = ["direct.listParts()", "multipart.complete(parts)", "storage.head(key)", "signatureMatches("];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(assembly.indexOf(order[index - 1]) < assembly.indexOf(order[index]), `${order[index - 1]} before ${order[index]}`);
  }
  /* A proxied part's etag is the driver's own token and goes back to it untouched:
     Miniflare's are case-sensitive, and lower-casing them failed every local
     multipart upload (the documents route had the same fault, fixed alongside). */
  const { claimedPartsFrom } = await import("../app/lib/upload-assembly.ts");
  assert.deepEqual(claimedPartsFrom([{ partNumber: 1, etag: " AbC-9_x " }, { partNumber: 0, etag: "z" }, { partNumber: 2 }]), [{ partNumber: 1, etag: "AbC-9_x" }]);
  /* A body the caller has already said is too big is refused BEFORE it is
     buffered: `request.arrayBuffer()` holds all of it, so checking afterwards
     means allocating whatever was sent in order to refuse it. The real length is
     still checked after — a lying or absent Content-Length changes nothing. */
  for (const limit of ["MAX_RENDITION_BYTES", "MAX_PART_SIZE"]) {
    assert.ok(
      route.indexOf(`declaredOverLimit(request, ${limit})`) < route.indexOf("await request.arrayBuffer()", route.indexOf(`declaredOverLimit(request, ${limit})`)),
      `the declared length is checked before the body is buffered (${limit})`,
    );
  }
  const documents = code(await read("app/api/files/multipart/route.ts"));
  assert.match(documents, /etag: String\(value\.etag \?\? ""\)\.trim\(\),/);
  assert.match(documents, /const declared = new Map\(claimed\.map\(\(part\) => \[part\.partNumber, part\.etag\.toLowerCase\(\)\]\)\);/);
  /* And the documents route says out loud that it finishes DOCUMENTS sessions
     only. `validUploadKey` already makes a website session unreachable here, so
     this states the invariant where the bucket is chosen rather than leaving it
     to be deduced from a key shape that could change. */
  assert.match(
    documents,
    /if \(session && session\.target && session\.target !== "documents"\) \{\s*\n\s*return Response\.json\(\{ error: "The upload session is invalid\." \}, \{ status: 404 \}\);/,
    "a website session cannot be fed parts through the documents route",
  );
  const client = code(await read("app/lib/client-upload.ts"));
  const uploader = client.slice(client.indexOf("export async function uploadWebsiteMedia"));
  /* RE-POINTED: `sendSignedPart` is the shared part sender (a fresh signed URL
     per attempt, one retry rule) that main extracted for the workspace logo;
     the website library uses that rather than a loop of its own. */
  assert.match(uploader, /await sendSignedPart\(/, "the browser reuses the one part sender");
  assert.match(client, /async function sendSignedPart\(/, "which lives once in this module");
  assert.match(uploader, /validateFile\(file\);/, "and the one size policy");
});

test("the public route: one website key, allowlisted type, immutable, sandboxed, no database", async () => {
  const route = code(await read("app/media/[mediaId]/[versionId]/[name]/route.ts"));
  assert.match(route, /const key = keyFromMediaPath\(mediaId, versionId, name\);\s*if \(!key\) return notFound\(\);/);
  assert.match(route, /if \(!SERVABLE_MEDIA_TYPES\.has\(type\)\) return notFound\(\);/);
  assert.doesNotMatch(route, /ensureDatabase|getDb|scopedDb/, "no session and no database: that is what makes it cacheable");
  assert.equal(media.MEDIA_CACHE_CONTROL, "public, max-age=31536000, immutable");
  assert.match(media.MEDIA_RESPONSE_CSP, /sandbox/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.match(route, /"CDN-Cache-Control": MEDIA_CDN_CACHE_CONTROL/);
  assert.ok(![...media.SERVABLE_MEDIA_TYPES].some((type) => /svg|html|javascript|xml/.test(type)));
});

test("delete is guarded by use, and removes bytes before rows", async () => {
  const route = code(await read("app/api/cms-media/route.ts"));
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.ok(del.indexOf("mediaUsage(") < del.indexOf("storage.delete(keys)"), "use is checked first");
  assert.match(del, /status: 409/);
  assert.ok(del.indexOf("storage.delete(keys)") < del.indexOf("deleteMediaRows("), "bytes first, rows once storage let them go");
  const pages = code(await read("app/api/site-pages/route.ts"));
  assert.match(pages, /const library = await mediaKinds\(scope\.db, named\);/, "a page save checks every asset it names");
  assert.match(pages, /an image needs alt text/);
});

test("the renderer draws library media through its own elements, and a missing asset draws nothing", async () => {
  const renderer = code(await read("app/(marketing)/_cms/blocks.tsx"));
  assert.match(renderer, /if \(!asset \|\| asset\.kind !== "image"\) return null;/);
  assert.match(renderer, /loading="lazy"/);
  assert.match(renderer, /<video\s+controls\s+preload="metadata"/);
  const page = code(await read("app/(marketing)/p/[slug]/page.tsx"));
  assert.match(page, /<CmsBlocks blocks=\{page\.blocks\} media=\{media\} \/>/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

async function call(pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * One whole upload through the real route: start, each part, complete.
 *
 * BOTH TRANSPORTS, because the two environments this file is pointed at use
 * different ones and the same assertions have to hold in each. Local Miniflare
 * proxies every part through the server; a deployed Preview signs a part URL and
 * the bytes go straight to the bucket, which is the path carrying #78's
 * `x-amz-copy-source` defence — the completer declares each part's MD5 and the
 * server compares it against the ETag the bucket stored. This helper used to
 * THROW on the direct transport, which made the round trip below unrunnable
 * against a real provider; the one path that most needed testing was the one it
 * refused to test.
 */
async function uploadThrough(headers, name, type, bytes, extra = {}) {
  const start = await call("/api/cms-media/upload", {
    headers,
    method: "POST",
    body: JSON.stringify({ action: "start", originalName: name, contentType: type, byteSize: bytes.length, ...extra }),
  });
  if (start.status !== 201) return { start };
  const parts = [];
  for (let number = 1; number <= start.body.partCount; number += 1) {
    const slice = bytes.subarray((number - 1) * start.body.partSize, number * start.body.partSize);
    if (start.body.transport === "direct") {
      const signed = await call("/api/cms-media/upload", {
        headers,
        method: "POST",
        body: JSON.stringify({ action: "sign-part", key: start.body.key, uploadId: start.body.uploadId, partNumber: number }),
      });
      assert.equal(signed.status, 200, `a part URL was refused: ${JSON.stringify(signed.body)}`);
      const sent = await fetch(signed.body.url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: slice,
      });
      assert.ok(sent.ok, `the bucket refused part ${number}: ${sent.status}`);
      /* The MD5 the browser would declare for the bytes it sent. `complete`
         compares it against what the bucket stored, so a substituted part is
         refused — declaring it here is the test playing the browser's part, not
         a shortcut around the check. */
      parts.push({ partNumber: number, etag: createHash("md5").update(slice).digest("hex") });
      continue;
    }
    const response = await fetch(`${BASE_URL}/api/cms-media/upload`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/octet-stream", "X-Upload-Key": start.body.key, "X-Upload-Id": start.body.uploadId, "X-Upload-Part": String(number) },
      body: slice,
    });
    parts.push((await response.json()).part);
  }
  const complete = await call("/api/cms-media/upload", {
    headers,
    method: "POST",
    body: JSON.stringify({ action: "complete", key: start.body.key, uploadId: start.body.uploadId, parts, ...(extra.complete ?? {}) }),
  });
  /* A REFUSED `complete` leaves the session pending and its multipart upload open
     in the bucket, and this file's own cleanup used to walk away from it — one was
     found sitting on Staging after a QA run. A refused upload aborts itself. */
  if (complete.status !== 200 && complete.status !== 201) {
    await call("/api/cms-media/upload", {
      headers,
      method: "POST",
      body: JSON.stringify({ action: "abort", key: start.body.key, uploadId: start.body.uploadId }),
    });
  }
  return { start, complete };
}

test("live: nobody outside platform staff reads, uploads or deletes website media", { skip: !serverUp }, async () => {
  assert.ok([401, 403].includes((await call("/api/cms-media")).status));
  /*
   * `x-maintsupp-identity` is the LOCAL testing switcher, and `demoIdentityAllowed()`
   * refuses it in production — so a deployed host reads these requests as anonymous
   * and answers 401 where a dev server answers 403. Both are refusals, and which
   * one arrives is a fact about the environment rather than about the rule, so the
   * assertion accepts either and the test states why. (It demanded 403 and
   * therefore failed against every deployed Preview, which looked like a defect in
   * the product and was a defect in the test.) A REAL non-platform membership is
   * refused with a real 403 — proven against the deployed Preview in this batch's
   * QA with an invited workspace admin, which the switcher cannot stand in for.
   */
  for (const identity of ["admin@sunnamusk-uk.test.maintsupp.com", "client@sunnamusk-uk.test.maintsupp.com"]) {
    const headers = { "x-maintsupp-identity": identity };
    const refused = [401, 403];
    assert.ok(refused.includes((await call("/api/cms-media", { headers })).status), identity);
    const start = await call("/api/cms-media/upload", {
      headers,
      method: "POST",
      body: JSON.stringify({ action: "start", originalName: "x.png", contentType: "image/png", byteSize: 10 }),
    });
    assert.ok(refused.includes(start.status), `${identity} cannot start a website upload`);
    assert.ok(refused.includes((await call(`/api/cms-media?id=${media.newMediaId()}`, { headers, method: "DELETE" })).status));
  }
});

test("live: upload, serve, use on a page, refuse to delete, replace, archive, delete", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const as = { cookie };
  const library = await call("/api/cms-media", { headers: as });
  if (library.status !== 200) return t.skip("this identity is not platform staff here");
  if (library.body.storage.state !== "ready") return t.skip(`website media storage is ${library.body.storage.state}`);
  const tag = `qa-k-${Date.now().toString(36)}`;
  const created = [];
  const pageSlug = `${tag}-page`;
  try {
    /* Refusals, before anything is stored. */
    assert.equal((await uploadThrough(as, "logo.svg", "image/svg+xml", Buffer.from("<svg/>"))).start.status, 415);
    const big = await call("/api/cms-media/upload", { headers: as, method: "POST", body: JSON.stringify({ action: "start", originalName: "x.png", contentType: "image/png", byteSize: 26 * 1024 * 1024 }) });
    assert.equal(big.status, 413);
    const lying = await uploadThrough(as, `${tag}-fake.png`, "image/png", Buffer.from("<html><script>alert(1)</script></html>".padEnd(2000, " ")));
    assert.equal(lying.complete.status, 415, "HTML under a .png name is refused by its bytes");

    /* A real upload. */
    const first = await uploadThrough(as, `${tag}.png`, "image/png", png(30, 20), { complete: { title: `${tag} image` } });
    assert.equal(first.complete.status, 201, JSON.stringify(first.complete.body));
    const item = first.complete.body.item;
    created.push(item.id);
    assert.equal(item.kind, "image");
    assert.equal(item.current.width, 30, "dimensions read from the file itself");
    assert.equal(item.current.height, 20);

    const served = await fetch(`${BASE_URL}${item.current.url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(30, 20), "byte for byte");
    assert.equal((await fetch(`${BASE_URL}/media/${item.id}/${media.newVersionId()}/x.png`)).status, 404, "an unknown version is 404");

    /* A page may not use it without alt text; with alt text it renders it. */
    const pageBody = (alt) => ({
      original: null,
      slug: pageSlug,
      title: `${tag} page`,
      metaTitle: null,
      metaDescription: null,
      published: true,
      blocks: [{ kind: "image", body: { mediaId: item.id, ...(alt ? { alt } : {}), caption: `${tag} caption` } }],
    });
    const noAlt = await call("/api/site-pages", { headers: as, method: "PUT", body: JSON.stringify(pageBody(null)) });
    assert.equal(noAlt.status, 400);
    assert.match(noAlt.body.error, /alt text/);
    assert.equal((await call("/api/site-pages", { headers: as, method: "PUT", body: JSON.stringify(pageBody("A test shopfront")) })).status, 200);
    const publicPage = await (await fetch(`${BASE_URL}/p/${pageSlug}`)).text();
    assert.ok(publicPage.includes(item.current.url), "the public page draws the library file");
    assert.match(publicPage, /alt="A test shopfront"/);

    /* In use: delete refused, with the page named. */
    const refused = await call(`/api/cms-media?id=${item.id}`, { headers: as, method: "DELETE" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, new RegExp(pageSlug));

    /*
     * AND A PDF, WHICH IS ONLY EVER LINKED. No block embeds a document, so the
     * only way to use one is a cta's href — and a use nothing counted is a delete
     * nothing refused (the finding this covers: the library said "Not used yet",
     * Delete went through, and a live page's link 404ed).
     */
    const brochure = await uploadThrough(as, `${tag}-brochure.pdf`, "application/pdf", Buffer.from(`%PDF-1.4\n% ${tag}\n`.padEnd(2500, "x")));
    assert.equal(brochure.complete.status, 201, JSON.stringify(brochure.complete.body));
    const brochureItem = brochure.complete.body.item;
    created.push(brochureItem.id);
    assert.equal(brochureItem.kind, "document");
    const linkPage = await call("/api/site-pages", {
      headers: as,
      method: "PUT",
      body: JSON.stringify({
        original: pageSlug,
        slug: pageSlug,
        title: `${tag} page`,
        metaTitle: null,
        metaDescription: null,
        published: true,
        blocks: [
          { kind: "image", body: { mediaId: item.id, alt: "A test shopfront", caption: `${tag} caption` } },
          { kind: "cta", body: { title: "Our standards", buttonLabel: "Download the brochure", buttonHref: brochureItem.current.url } },
        ],
      }),
    });
    assert.equal(linkPage.status, 200, JSON.stringify(linkPage.body));
    const linkedRefusal = await call(`/api/cms-media?id=${brochureItem.id}`, { headers: as, method: "DELETE" });
    assert.equal(linkedRefusal.status, 409, "a linked PDF is in use");
    assert.match(linkedRefusal.body.error, new RegExp(pageSlug), "and the page that links it is named");
    const linkedLibrary = await call("/api/cms-media", { headers: as });
    assert.deepEqual(
      linkedLibrary.body.items.find((entry) => entry.id === brochureItem.id).usage.map((page) => page.slug),
      [pageSlug],
      "the library shows the use, so Delete is not offered",
    );

    /* Replace: same asset, new file, every page follows; the old one can come back. */
    const second = await uploadThrough(as, `${tag}-2.png`, "image/png", png(40, 10), { replaces: item.id });
    assert.equal(second.complete.status, 201, JSON.stringify(second.complete.body));
    assert.equal(second.complete.body.item.id, item.id);
    assert.notEqual(second.complete.body.item.current.url, item.current.url);
    assert.ok((await (await fetch(`${BASE_URL}/p/${pageSlug}`)).text()).includes(second.complete.body.item.current.url), "the page shows the new file");
    assert.equal((await fetch(`${BASE_URL}${item.current.url}`)).status, 200, "the old file's address still answers");
    const video = await uploadThrough(as, `${tag}.webm`, "video/webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 1)]));
    assert.equal(video.complete.status, 201, JSON.stringify(video.complete.body));
    created.push(video.complete.body.item.id);
    const wrongKind = await uploadThrough(as, `${tag}.webm`, "video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), { replaces: item.id });
    assert.equal(wrongKind.start.status, 409, "an image is only replaced by an image");
    const ranged = await fetch(`${BASE_URL}${video.complete.body.item.current.url}`, { headers: { range: "bytes=0-3" } });
    assert.equal(ranged.status, 206, "video answers byte ranges");
    const restore = await call("/api/cms-media", { headers: as, method: "PATCH", body: JSON.stringify({ id: item.id, currentVersion: item.current.id }) });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.item.current.id, item.current.id);

    /* Archive keeps the page working; once unused it can be deleted, and is gone. */
    assert.equal((await call("/api/cms-media", { headers: as, method: "PATCH", body: JSON.stringify({ id: item.id, status: "archived" }) })).status, 200);
    assert.ok((await (await fetch(`${BASE_URL}/p/${pageSlug}`)).text()).includes(item.current.url), "archived, still drawn");
    assert.equal((await call(`/api/site-pages?slug=${pageSlug}`, { headers: as, method: "DELETE" })).status, 200);
    assert.equal((await call(`/api/cms-media?id=${item.id}`, { headers: as, method: "DELETE" })).status, 200);
    created.splice(created.indexOf(item.id), 1);
    /*
     * THE ORIGIN, not the edge. This route sends `immutable` and a day of
     * `CDN-Cache-Control` because the bytes under a key never change — a
     * replacement is a new key — so after a delete a CDN keeps serving its copy
     * until that day is up, which the library screen states. Asking the same URL
     * deployed therefore answers 200 from cache, and the assertion that the file
     * is gone has to ask the origin: a unique query string is a different cache
     * key, and the route reads its path segments only, so the handler sees the
     * same request. (This assertion passed locally, where there is no edge, and
     * failed on the first deployed run — the cache was right and the test was
     * incomplete.)
     */
    const fromOrigin = await fetch(`${BASE_URL}${item.current.url}?deleted-check=${Date.now().toString(36)}`);
    assert.equal(fromOrigin.status, 404, "deleted means the origin no longer has the file");
  } finally {
    await call(`/api/site-pages?slug=${pageSlug}`, { headers: as, method: "DELETE" });
    for (const id of created) await call(`/api/cms-media?id=${id}`, { headers: as, method: "DELETE" });
  }
});
