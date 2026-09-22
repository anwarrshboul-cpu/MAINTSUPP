/**
 * THE WORKSPACE LOGO — the owner's decision M, held here.
 *
 *   - PNG, JPEG and WebP only; never SVG. About 2 MB at most. The bytes decide,
 *     not the name or the declared type (`app/lib/file-signature.ts`).
 *   - Stored in the PRIVATE bucket under the workspace's own prefix and served
 *     only through `/api/branding/logo/image`, which authorises every request
 *     from the session — never from a parameter.
 *   - `settings.edit` and a signed-in account to change it; every change audited.
 *   - Over 900 KB it travels the #78 direct-upload path: the same upload
 *     sessions, the same part URLs, the same MD5 proof of each part.
 *   - A default when there is none; MAINTSUPP's own mark is never replaced.
 *
 * The rules are CALLED; the storage logic runs against a REAL SQLite built from
 * the migration's own DDL; the renderers are called with and without a logo;
 * the routes' ordering is pinned in their source; the live half uploads, serves,
 * replaces and removes a real logo through the dev server (skipping when none
 * answers) and removes everything it made.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 as zlibCrc32 } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const rules = await import("../app/lib/organisation-logo-rules.ts");
const store = await import("../app/lib/organisation-logo.ts");
const { renderPdf } = await import("../app/lib/exports/pdf.ts");
const { renderDocx } = await import("../app/lib/exports/docx.ts");
const { readStoredZip } = await import("../app/lib/exports/zip.ts");
const { samplePayload } = await import("../app/lib/exports/sample-payload.ts");
const { NO_BRANDING, coverLogoSize } = await import("../app/lib/exports/document-model.ts");

/* ── Real image bytes, made here so nothing depends on a fixture file ─────── */

const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  return Buffer.concat([u32(data.length), body, u32(zlibCrc32(body))]);
};

/** A genuine, decodable RGB PNG. `noise` makes it incompressible, so its size is predictable. */
function png(width, height, { noise = false } = {}) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < width * 3; x += 1) {
      raw[y * row + 1 + x] = noise ? Math.floor(Math.random() * 256) : (x * 7 + y * 3) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: noise ? 0 : 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG's header: SOI, an APP0 with a padded body, then a frame. Enough to be read, not drawn. */
function jpegHeader(width, height, { components = 3, frame = 0xc0, app = 16 } = {}) {
  const appBody = Buffer.alloc(app - 2);
  appBody.write("JFIF\0", 0, "latin1");
  const sof = Buffer.alloc(2 + 6 + components * 3);
  sof.writeUInt16BE(sof.length, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = components;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from([(app >> 8) & 0xff, app & 0xff]),
    appBody,
    Buffer.from([0xff, frame]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function webpLossless(width, height) {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const body = Buffer.concat([
    Buffer.from("VP8L", "ascii"),
    Buffer.from([5, 0, 0, 0, 0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]),
  ]);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([body.length + 4, 0, 0, 0]), Buffer.from("WEBP", "ascii"), body, Buffer.alloc(8)]);
}

const bytes = (buffer) => new Uint8Array(buffer);

/* ================================================================== */
/* The rules                                                            */
/* ================================================================== */

test("PNG, JPEG and WebP are accepted, and their size is read from their own header", () => {
  const cases = [
    ["image/png", "logo.png", png(320, 96), 320, 96],
    ["image/jpeg", "logo.jpg", jpegHeader(640, 200), 640, 200],
    ["image/jpeg", "logo.jpeg", jpegHeader(300, 300, { frame: 0xc2, app: 4000 }), 300, 300],
    ["image/webp", "logo.webp", webpLossless(512, 128), 512, 128],
    ["", "logo.png", png(64, 64), 64, 64],
  ];
  for (const [type, name, file, width, height] of cases) {
    const inspected = rules.inspectLogo(type, name, bytes(file));
    assert.equal(inspected.ok, true, `${name}: ${inspected.error}`);
    assert.equal(inspected.width, width, name);
    assert.equal(inspected.height, height, name);
  }
});

test("SVG is refused however it is named or declared, and a disguised file by its bytes", () => {
  const svg = bytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  for (const [type, name] of [
    ["image/svg+xml", "logo.svg"],
    ["image/png", "logo.svg"],
    ["image/svg+xml", "logo.png"],
    ["image/png", "logo.png"],
    ["", "logo.png"],
  ]) {
    const inspected = rules.inspectLogo(type, name, svg);
    assert.equal(inspected.ok, false, `${type} ${name}`);
    assert.equal(inspected.status, 415, `${type} ${name}`);
  }
  // A GIF, a HEIC and a PDF are refused too: not a still mark a browser draws everywhere.
  assert.equal(rules.inspectLogo("image/gif", "logo.gif", bytes(Buffer.from("GIF89a...."))).ok, false);
  assert.equal(rules.inspectLogo("application/pdf", "logo.pdf", bytes(Buffer.from("%PDF-1.7"))).ok, false);
  // The type, the extension and the bytes must all agree.
  assert.equal(rules.inspectLogo("image/jpeg", "logo.png", bytes(png(32, 32))).ok, false);
  assert.equal(rules.inspectLogo("image/png", "logo.jpg", bytes(png(32, 32))).ok, false);
  assert.equal(rules.inspectLogo("image/png", "logo.png", bytes(jpegHeader(32, 32))).ok, false);
});

test("the owner's 2 MB ceiling, and a size a sidebar can safely decode", () => {
  assert.equal(rules.LOGO_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(rules.logoDeclarationRefusal("image/png", "a.png", rules.LOGO_MAX_BYTES + 1)?.status, 413);
  assert.equal(rules.logoDeclarationRefusal("image/png", "a.png", rules.LOGO_MAX_BYTES), null);
  assert.equal(rules.logoDeclarationRefusal("image/png", "a.png", 0)?.status, 400);
  const tooBig = Buffer.concat([png(32, 32), Buffer.alloc(rules.LOGO_MAX_BYTES)]);
  assert.equal(rules.inspectLogo("image/png", "a.png", bytes(tooBig)).status, 413);
  // 16–4096 px on each side: no tracking pixel, and no decompression bomb.
  assert.equal(rules.inspectLogo("image/png", "a.png", bytes(png(8, 64))).status, 422);
  const bomb = png(32, 32);
  bomb.writeUInt32BE(60000, 16);
  assert.equal(rules.inspectLogo("image/png", "a.png", bytes(bomb)).status, 422);
  // A JPEG whose scan starts before any frame cannot say how big it is.
  const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0xff, 0xd9]);
  assert.equal(rules.inspectLogo("image/jpeg", "a.jpg", bytes(noFrame)).status, 415);
});

test("the documents' copy must be a small grey or colour JPEG", () => {
  assert.equal(rules.inspectPrintRendition(bytes(jpegHeader(600, 200))).ok, true);
  assert.equal(rules.inspectPrintRendition(bytes(jpegHeader(600, 200, { components: 1 }))).ok, true);
  assert.equal(rules.inspectPrintRendition(bytes(jpegHeader(600, 200, { components: 4 }))).ok, false, "CMYK prints inverted in some readers");
  assert.equal(rules.inspectPrintRendition(bytes(jpegHeader(2400, 200))).ok, false, "over 1200 px is not a print copy");
  assert.equal(rules.inspectPrintRendition(bytes(png(64, 64))).ok, false, "a PDF embeds a JPEG natively, not a PNG");
});

test("the key is the server's, under the workspace's own prefix — and a foreign one is refused", () => {
  const id = "0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
  const key = rules.logoObjectKey("org_a", id, "image/png");
  assert.equal(key, `org_a/branding/logo/${id}.png`);
  assert.equal(rules.isLogoKeyOf("org_a", key), true);
  for (const foreign of [
    `org_b/branding/logo/${id}.png`,
    `org_a/branding/logo/../../org_b/branding/logo/${id}.png`,
    `org_a/maintenance/unfiled/issue/${id}-x.png`,
    `org_a/branding/logo/${id}.svg`,
    `org_a/branding/logo/not-a-uuid.png`,
    "",
  ]) {
    assert.equal(rules.isLogoKeyOf("org_a", foreign), false, foreign);
  }
  assert.equal(rules.printRenditionKey(key), `${key}.print.jpg`);
  assert.equal(rules.logoImageUrl(id), `/api/branding/logo/image?v=${id}`);
  assert.equal(rules.logoImageUrl(id, "print"), `/api/branding/logo/image?v=${id}&rendition=print`);
});

/* ================================================================== */
/* Storage — a real SQLite, a recording bucket                          */
/* ================================================================== */

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a'), ('org_b');");
  sqlite.exec(
    "CREATE TABLE audit_events (id TEXT PRIMARY KEY, organisation_id TEXT, actor_user_id TEXT, actor_email TEXT, actor_role TEXT, action TEXT, entity_type TEXT, entity_id TEXT, summary TEXT, detail TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
  );
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS organisation_logos \([\s\S]*?\))`/)[1]);
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
  const objects = new Map();
  const storage = {
    deleted: [],
    async delete(key) {
      this.deleted.push(key);
      objects.delete(key);
    },
    async get(key) {
      return objects.has(key) ? { body: new Response(objects.get(key)).body } : null;
    },
  };
  return { sqlite, db, storage, objects };
}

const scope = { identityEmail: "Owner@Example.com", actor: { role: "admin" }, session: { user: { id: "u1" } } };
const request = new Request("http://localhost/api/branding/logo", { method: "POST" });
const logoFor = (id) => ({
  logoId: id,
  objectKey: `org_a/branding/logo/${id}.png`,
  contentType: "image/png",
  byteSize: 1234,
  width: 320,
  height: 96,
  originalName: "acme.png",
});

test("adopting a logo names it, replacing one retires the old objects, removing one goes back to the default", async () => {
  const { db, storage, sqlite } = await database();
  const first = logoFor("11111111-1111-4111-8111-111111111111");
  const second = logoFor("22222222-2222-4222-8222-222222222222");

  await store.adoptOrganisationLogo({ db, storage, organisationId: "org_a", logo: first, scope, request, multipart: false });
  let described = store.describeLogo(await store.readOrganisationLogo(db, "org_a"));
  assert.equal(described.id, first.logoId);
  assert.equal(described.url, `/api/branding/logo/image?v=${first.logoId}`);
  assert.equal(described.printUrl, null, "no print copy until the browser stores one");
  assert.ok(!("objectKey" in described), "the object key never reaches the browser");
  assert.deepEqual(storage.deleted, [], "nothing to retire the first time");

  await store.adoptOrganisationLogo({ db, storage, organisationId: "org_a", logo: second, scope, request, multipart: true });
  described = store.describeLogo(await store.readOrganisationLogo(db, "org_a"));
  assert.equal(described.id, second.logoId);
  assert.deepEqual(storage.deleted, [first.objectKey, `${first.objectKey}.print.jpg`], "the replaced logo's bytes are gone");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM organisation_logos").get().n, 1, "one row per workspace");

  assert.equal(await store.readOrganisationLogo(db, "org_b"), null, "another workspace has no logo");

  assert.equal(await store.removeOrganisationLogo({ db, storage, organisationId: "org_a", scope, request }), true);
  assert.equal(await store.readOrganisationLogo(db, "org_a"), null);
  assert.ok(storage.deleted.includes(second.objectKey));
  assert.equal(await store.removeOrganisationLogo({ db, storage, organisationId: "org_a", scope, request }), false, "nothing to remove");

  const actions = sqlite.prepare("SELECT action, organisation_id, entity_type FROM audit_events ORDER BY rowid").all().map((row) => ({ ...row }));
  assert.deepEqual(
    actions.map((row) => row.action),
    ["theme.logo_changed", "theme.logo_changed", "theme.logo_removed"],
    "every change is audited, and a removal of nothing is not",
  );
  assert.ok(actions.every((row) => row.organisation_id === "org_a" && row.entity_type === "organisation_logo"));
});

test("the print copy is recorded only against the logo it was drawn from", async () => {
  const { db, storage, objects } = await database();
  const first = logoFor("33333333-3333-4333-8333-333333333333");
  await store.adoptOrganisationLogo({ db, storage, organisationId: "org_a", logo: first, scope, request, multipart: false });
  assert.equal(await store.recordPrintRendition(db, "org_a", "44444444-4444-4444-8444-444444444444", { width: 600, height: 180 }), false, "a stale copy matches no row");
  assert.equal(await store.recordPrintRendition(db, "org_b", first.logoId, { width: 600, height: 180 }), false, "nor another workspace's");
  assert.equal(await store.documentLogo(db, storage, "org_a"), null, "no recorded copy, no document logo");

  const jpeg = jpegHeader(600, 180);
  objects.set(`${first.objectKey}.print.jpg`, jpeg);
  assert.equal(await store.recordPrintRendition(db, "org_a", first.logoId, { width: 600, height: 180 }), true);
  const described = store.describeLogo(await store.readOrganisationLogo(db, "org_a"));
  assert.equal(described.printUrl, `/api/branding/logo/image?v=${first.logoId}&rendition=print`);
  const logo = await store.documentLogo(db, storage, "org_a");
  assert.deepEqual([logo.width, logo.height, logo.components], [600, 180, 3]);
  assert.deepEqual(Buffer.from(logo.jpeg), jpeg);

  // A new logo drops the old copy's record: a report never prints pixels from the logo before.
  await store.adoptOrganisationLogo({ db, storage, organisationId: "org_a", logo: logoFor("55555555-5555-4555-8555-555555555555"), scope, request, multipart: false });
  assert.equal(store.describeLogo(await store.readOrganisationLogo(db, "org_a")).printUrl, null);
  assert.equal(await store.documentLogo(db, storage, "org_a"), null);
});

/* ================================================================== */
/* The documents                                                        */
/* ================================================================== */

const printLogo = { jpeg: bytes(jpegHeader(600, 200)), width: 600, height: 200, components: 3 };
const latin1 = (value) => Buffer.from(value).toString("latin1");

test("an unbranded PDF and Word file are byte-for-byte what they were", () => {
  assert.deepEqual(renderPdf(samplePayload(), "combined", NO_BRANDING), renderPdf(samplePayload()));
  assert.deepEqual(renderDocx(samplePayload(), "combined", NO_BRANDING), renderDocx(samplePayload()));
  assert.doesNotMatch(latin1(renderPdf(samplePayload())), /\/XObject|DCTDecode/);
});

test("the PDF embeds the logo's JPEG as an image on the cover, above MAINTSUPP's title", () => {
  const pdf = renderPdf(samplePayload(), "report", { logo: printLogo });
  const text = latin1(pdf);
  assert.match(text, /\/Subtype \/Image \/Width 600 \/Height 200 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.match(text, /\/XObject << \/Im1 \d+ 0 R >>/);
  assert.match(text, /cm \/Im1 Do Q/);
  assert.ok(Buffer.from(pdf).includes(Buffer.from(printLogo.jpeg)), "the JPEG is embedded byte-for-byte");
  assert.match(text, /MAINTSUPP Maintenance Report/, "the title is still MAINTSUPP's");
  // It sits in the letterhead box, aspect kept.
  assert.deepEqual(coverLogoSize({ width: 600, height: 200 }, { width: 170, height: 48 }), { width: 144, height: 48 });
});

test("the Word file carries the logo as an inline picture with its own part", () => {
  const parts = readStoredZip(renderDocx(samplePayload(), "report", { logo: printLogo }));
  assert.deepEqual(Buffer.from(parts.get("word/media/workspace-logo.jpeg")), Buffer.from(printLogo.jpeg));
  const types = Buffer.from(parts.get("[Content_Types].xml")).toString("utf8");
  assert.match(types, /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  const rels = Buffer.from(parts.get("word/_rels/document.xml.rels")).toString("utf8");
  assert.match(rels, /Id="rIdWorkspaceLogo" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image" Target="media\/workspace-logo\.jpeg"/);
  const document = Buffer.from(parts.get("word/document.xml")).toString("utf8");
  assert.match(document, /xmlns:wp="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/wordprocessingDrawing"/);
  assert.match(document, /<a:blip r:embed="rIdWorkspaceLogo"\/>/);
  assert.ok(document.indexOf("rIdWorkspaceLogo") < document.indexOf("MAINTSUPP Maintenance Report"), "above the title");
});

/* ================================================================== */
/* The routes, pinned in their source                                   */
/* ================================================================== */

test("every write needs settings.edit and a signed-in account, and nothing in the request names a workspace", async () => {
  const gate = code(await read("app/api/branding/logo/gate.ts"));
  assert.match(gate, /requireCapability\(subject, "settings\.edit"\)/);
  assert.match(gate, /if \(!scope\.authenticated\)/);
  for (const file of ["app/api/branding/logo/route.ts", "app/api/branding/logo/image/route.ts", "app/api/branding/logo/upload/route.ts"]) {
    const source = code(await read(file));
    assert.doesNotMatch(source, /organisationId"\)|searchParams\.get\("org|maintsupp_demo_organisation/, `${file} takes no workspace from the request`);
    assert.match(source, /scopedDb|logoEditorScope/, file);
  }
  const main = code(await read("app/api/branding/logo/route.ts"));
  for (const handler of ["export async function POST", "export async function DELETE"]) {
    const body = main.slice(main.indexOf(handler));
    assert.ok(body.indexOf("logoEditorScope(request)") > 0 && body.indexOf("logoEditorScope(request)") < body.indexOf("logoBucket()"), `${handler} is gated before storage`);
  }
});

test("the small path checks the bytes before it stores them", async () => {
  const main = code(await read("app/api/branding/logo/route.ts"));
  const post = main.slice(main.indexOf("export async function POST"));
  assert.ok(post.indexOf("inspectLogo(file.type, file.name, bytes)") > 0);
  assert.ok(post.indexOf("inspectLogo(") < post.indexOf("storage.put("), "judged before stored");
  assert.ok(post.indexOf("storage.put(") < post.indexOf("adoptOrganisationLogo("));
  assert.match(post, /contentType: inspected\.type/, "the stored type is the one the bytes proved");
});

test("the parts path is #78's: a session, a signed part, the bucket's own list and MD5, then the same inspection", async () => {
  const upload = code(await read("app/api/branding/logo/upload/route.ts"));
  for (const primitive of ["createUploadSession(", "findUploadSession(", "sessionRefusal(", "claimFinalize(", "settleUploadSession(", "partsMatchPlan(", "presignPart(", "pendingUploadCount("]) {
    assert.ok(upload.includes(primitive), `reuses ${primitive}`);
  }
  const complete = upload.slice(upload.indexOf('action === "complete"'));
  const md5 = complete.indexOf("declared.get(part.partNumber) === part.etag.toLowerCase()");
  assert.ok(md5 > 0 && md5 < complete.indexOf("multipart.complete(parts)"), "each part's contents are proven before assembly");
  assert.ok(complete.indexOf("direct.listParts()") < md5, "the parts are listed from the bucket");
  assert.ok(complete.indexOf("inspectLogo(session.contentType, session.originalName, bytes)") > complete.indexOf("multipart.complete(parts)"));
  assert.ok(complete.indexOf("inspectLogo(") < complete.indexOf("adoptOrganisationLogo("), "judged before it becomes the logo");
  assert.match(complete, /if \(assembled\) await storage\.delete\(key\)[\s\S]*?else await multipart\.abort\(\)/, "nothing of a failed upload stays");
  const start = upload.slice(upload.indexOf('action === "start"'), upload.indexOf('const key = String(payload.key'));
  assert.match(start, /logoDeclarationRefusal\(contentType, originalName, byteSize\)/);
  assert.match(start, /logoObjectKey\(orgId, logoId, type\)/, "the server names the key");
  const put = upload.slice(upload.indexOf("export async function PUT"));
  assert.ok(put.indexOf("sessionRefusal(") < put.indexOf("await request.arrayBuffer()"), "a part is refused before its bytes are read");
  assert.ok(upload.indexOf("isLogoKeyOf(orgId, key)") > 0 && put.includes("isLogoKeyOf(scope.orgId, key)"));
  /* A proxied part's etag goes back to the driver AS SENT (Miniflare's are
     case-sensitive base64url); only the direct path's MD5 is compared lowercased.
     Found building this: lowercasing broke every local >900 KB upload, documents
     included, at `complete`. */
  for (const file of ["app/api/files/multipart/route.ts", "app/api/branding/logo/upload/route.ts"]) {
    const source = code(await read(file));
    assert.match(source, /etag: String\(value\.etag \?\? ""\)\.trim\(\),/, `${file} hands a proxied etag back as sent`);
    assert.match(source, /claimed\.map\(\(part\) => \[part\.partNumber, part\.etag\.toLowerCase\(\)\]\)/, `${file} compares the MD5 lowercased`);
  }
  // The daily sweep closes an abandoned logo upload too: it walks every session.
  const cron = code(await read("app/api/cron/daily/route.ts"));
  assert.match(cron, /expireUploadSessions\(db,/);
});

test("the bytes leave the bucket only through the image route, hardened", async () => {
  const image = code(await read("app/api/branding/logo/image/route.ts"));
  const get = image.slice(image.indexOf("export async function GET"), image.indexOf("export async function PUT"));
  assert.match(get, /const scope = await scopedDb\(request\);/);
  assert.match(get, /"X-Content-Type-Options": "nosniff"/);
  assert.match(get, /"Content-Security-Policy": "default-src 'none';[^"]*sandbox"/);
  assert.match(get, /"Cross-Origin-Resource-Policy": "same-origin"/);
  assert.match(get, /LOGO_TYPES as readonly string\[\]\)\.includes\(row\.contentType\)/, "only one of the three types is ever served");
  const put = image.slice(image.indexOf("export async function PUT"));
  assert.ok(put.indexOf("logoEditorScope(request)") < put.indexOf("request.arrayBuffer()"));
  assert.ok(put.indexOf("inspectPrintRendition(bytes)") < put.indexOf("storage.put("));
  assert.match(put, /recordPrintRendition\(scope\.db, scope\.orgId, row\.logoId, inspected\)/);
  // No other route reads the logo's object — the key is never handed out.
  const context = code(await read("app/api/context/route.ts"));
  assert.match(context, /logoUrl: organisation\.id === context\.orgId \? logoUrl : null/);
  assert.doesNotMatch(context, /organisationLogos|objectKey/);
  const account = code(await read("app/api/account/route.ts"));
  assert.match(account, /logoUrl: await organisationLogoUrl\(context\.db, context\.orgId\)/);
});

test("the migration is one additive table, and the organisation row stays as it was", async () => {
  const init = await read("db/init.ts");
  const from = init.indexOf("async function ensureOrganisationLogos");
  const stage = init.slice(from, init.indexOf("\n}\n", from) + 3);
  assert.match(stage, /CREATE TABLE IF NOT EXISTS organisation_logos/);
  assert.doesNotMatch(stage, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i, "no backfill, nothing destructive");
  assert.match(stage, /byte_size BIGINT NOT NULL/);
  assert.match(init, /await ensureOrganisationLogos\(d1\);/);
  const schema = await read("db/schema.ts");
  const organisations = schema.slice(schema.indexOf('export const organisations = sqliteTable("organisations"'));
  assert.doesNotMatch(organisations.slice(0, organisations.indexOf("});")), /objectKey|logoId/, "no object key on the row the browser is handed");
});

test("the chrome shows the workspace's mark beside its name and never in place of MAINTSUPP's", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const brand = portal.slice(portal.indexOf('className="portal-sidebar__brand"'), portal.indexOf('className="workspace-switcher"'));
  assert.match(brand, /<BrandMark \/>/, "the MAINTSUPP mark stays where it was");
  assert.doesNotMatch(brand, /WorkspaceMark|logoUrl/);
  const switcher = portal.slice(portal.indexOf('className="workspace-switcher"'));
  assert.match(switcher.slice(0, 900), /<WorkspaceMark\s+logoUrl=\{runtimeContext\?\.currentOrganisation\.logoUrl\}\s+fallback=\{<Icon name="building" size=\{17\} \/>\}/);
  assert.match(portal, /<WorkspaceLogoPanel \/>/);
  const mark = await read("app/(app)/portal/workspace-mark.tsx");
  assert.match(mark, /alt=\{label \?\? ""\}/, "decorative beside a printed name");
  assert.match(mark, /onError=\{\(\) => setFailedUrl\(logoUrl\)\}/, "a broken logo falls back to the default");
  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /<WorkspaceMark\s+logoUrl=\{snapshot\?\.workspace\.logoUrl\}/);
  const preview = await read("app/(app)/portal/reports/report-preview.tsx");
  assert.match(preview, /<WorkspaceMark logoUrl=\{logo\?\.printUrl\}/, "the preview shows exactly the copy the download embeds");
  const panel = await read("app/(app)/portal/views/workspace-logo-panel.tsx");
  assert.match(panel, /uploadWorkspaceLogo\(file, \{ onStage: setStage \}\)/, "one way in");
  assert.doesNotMatch(code(panel), /fetch\("\/api\/branding\/logo", \{ method: "POST"/, "the panel never hand-rolls the upload");
  const client = await read("app/lib/client-upload.ts");
  const logoClient = client.slice(client.indexOf("export async function uploadWorkspaceLogo("));
  assert.match(logoClient, /if \(file\.size > DIRECT_UPLOAD_LIMIT\) \{\s*return finish\(await logoPartsUpload\(file, progress\)\);/);
  assert.match(logoClient, /error\.status === 413[\s\S]*?logoPartsUpload/);
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

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

async function signIn() {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!login.ok) return null;
  return (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
}

async function json(response) {
  return response.json().catch(() => null);
}

test("live: upload, serve, replace in parts, print copy, export, remove — and who may not", { skip: !serverUp }, async (t) => {
  const cookie = await signIn();
  if (!cookie) return t.skip("the seeded owner could not sign in");
  const as = (init = {}) => ({ ...init, headers: { cookie, ...(init.headers ?? {}) } });
  const before = await json(await fetch(`${BASE_URL}/api/branding/logo`, as()));
  if (before?.logo) return t.skip("this workspace already has a logo; not replacing somebody's");
  assert.equal(before.canEdit, true);

  const created = [];
  try {
    // A client may see the logo but not change it.
    const clientPost = new FormData();
    clientPost.set("file", new File([png(64, 64)], "qa-logo.png", { type: "image/png" }));
    const clientRefused = await fetch(`${BASE_URL}/api/branding/logo`, {
      method: "POST",
      body: clientPost,
      headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" },
    });
    assert.ok([401, 403].includes(clientRefused.status), `client upload answered ${clientRefused.status}`);

    // SVG is refused at the door.
    const svg = new FormData();
    svg.set("file", new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "qa-logo.svg", { type: "image/svg+xml" }));
    assert.equal((await fetch(`${BASE_URL}/api/branding/logo`, as({ method: "POST", body: svg }))).status, 415);

    // A small PNG on the single-shot path.
    const small = png(240, 80);
    const form = new FormData();
    form.set("file", new File([small], "qa-logo.png", { type: "image/png" }));
    const posted = await fetch(`${BASE_URL}/api/branding/logo`, as({ method: "POST", body: form }));
    const postedBody = await json(posted);
    assert.equal(posted.status, 201, JSON.stringify(postedBody));
    created.push(postedBody.logo.id);
    assert.deepEqual([postedBody.logo.width, postedBody.logo.height, postedBody.logo.contentType], [240, 80, "image/png"]);

    const served = await fetch(`${BASE_URL}${postedBody.logo.url}`, as());
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(served.headers.get("cache-control") ?? "", /immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), small, "byte-for-byte");

    // The context carries it for the sidebar; a signed-out caller gets nothing.
    const context = await json(await fetch(`${BASE_URL}/api/context`, as()));
    assert.equal(context.context.currentOrganisation.logoUrl, postedBody.logo.url);
    /* A signed-out caller: refused wherever the server refuses strangers. A local
       dev server answers them as the seeded demo identity by design
       (`demoIdentityAllowed`), so there the check is the deployed QA's. */
    const signedOutContext = await fetch(`${BASE_URL}/api/branding/logo`);
    if (signedOutContext.status === 401) {
      const stranger = await fetch(`${BASE_URL}${postedBody.logo.url}`);
      assert.equal(stranger.status, 401, "a stranger is not served the logo");
    }

    // Another workspace's admin sees their own workspace's (absent) logo, never this one.
    const other = await fetch(`${BASE_URL}/api/branding/logo`, { headers: { "x-maintsupp-identity": "admin@demo-client-ltd.test.maintsupp.com" } });
    if (other.status === 200) {
      const otherBody = await json(other);
      assert.notEqual(otherBody.logo?.id, postedBody.logo.id, "one workspace's logo is not another's");
    }

    // Over 900 KB: the #78 parts path.
    const large = png(560, 560, { noise: true });
    assert.ok(large.length > 900 * 1024 && large.length < 2 * 1024 * 1024, `${large.length} bytes`);
    const post = (body) => fetch(`${BASE_URL}/api/branding/logo/upload`, as({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const start = await json(await post({ action: "start", originalName: "qa-logo-large.png", contentType: "image/png", byteSize: large.length }));
    assert.ok(start?.key && start.uploadId, JSON.stringify(start));
    assert.doesNotMatch(start.key, /\.\./);
    let parts;
    if (start.transport === "direct") {
      const signed = await json(await post({ action: "sign-part", key: start.key, uploadId: start.uploadId, partNumber: 1 }));
      const put = await fetch(signed.url, { method: "PUT", body: large });
      assert.ok(put.ok, `direct part answered ${put.status}`);
      const { createHash } = await import("node:crypto");
      parts = [{ partNumber: 1, etag: createHash("md5").update(large).digest("hex") }];
    } else {
      const part = await fetch(`${BASE_URL}/api/branding/logo/upload`, as({
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "X-Upload-Key": start.key, "X-Upload-Id": start.uploadId, "X-Upload-Part": "1" },
        body: large,
      }));
      assert.equal(part.status, 200);
      parts = [(await json(part)).part];
    }
    const completed = await post({ action: "complete", key: start.key, uploadId: start.uploadId, parts });
    const completedBody = await json(completed);
    assert.equal(completed.status, 201, JSON.stringify(completedBody));
    created.push(completedBody.logo.id);
    assert.deepEqual([completedBody.logo.width, completedBody.logo.height], [560, 560]);
    assert.equal((await fetch(`${BASE_URL}${postedBody.logo.url}`, as())).status, 200, "the old URL now answers with the current logo, uncached");
    const largeServed = await fetch(`${BASE_URL}${completedBody.logo.url}`, as());
    assert.deepEqual(Buffer.from(await largeServed.arrayBuffer()), large);

    // The print copy, for this logo only.
    const printBytes = jpegHeader(600, 200);
    const stale = await fetch(`${BASE_URL}/api/branding/logo/image?rendition=print&v=${postedBody.logo.id}`, as({ method: "PUT", headers: { "content-type": "image/jpeg" }, body: printBytes }));
    assert.equal(stale.status, 409, "a copy of the replaced logo is refused");
    const print = await fetch(`${BASE_URL}/api/branding/logo/image?rendition=print&v=${completedBody.logo.id}`, as({ method: "PUT", headers: { "content-type": "image/jpeg" }, body: printBytes }));
    assert.equal(print.status, 200, JSON.stringify(await json(print)));
    const meta = await json(await fetch(`${BASE_URL}/api/branding/logo`, as()));
    assert.ok(meta.logo.printUrl);

    // Removal: back to the default, and the bytes are gone.
    const removed = await fetch(`${BASE_URL}/api/branding/logo`, as({ method: "DELETE" }));
    assert.equal(removed.status, 200);
    created.length = 0;
    assert.equal((await fetch(`${BASE_URL}${completedBody.logo.url}`, as())).status, 404);
    assert.equal((await json(await fetch(`${BASE_URL}/api/context`, as()))).context.currentOrganisation.logoUrl, null);
  } finally {
    if (created.length) await fetch(`${BASE_URL}/api/branding/logo`, as({ method: "DELETE" }));
  }
});
