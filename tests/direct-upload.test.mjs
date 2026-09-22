/**
 * Direct uploads — files over 900 KB go from the browser straight into the
 * PRIVATE bucket on short-lived, upload-only part URLs, so a 50 MB video never
 * passes through a Vercel function (4.5 MB request cap). The owner's refined
 * rule: no persistent, public or read-capable storage URL or credential reaches
 * the browser; a single-part UPLOAD-ONLY URL for an upload the server already
 * authorised may. Downloads stay behind `GET /api/files/[id]`.
 *
 * Unit half: the SigV4 query presigner against AWS's published vector, the part
 * URL's shape, ListParts parsing, file signatures, the part plan, the uploader
 * identity and the session state machine on real SQLite. Source half: the order
 * of the checks in the route and the client. Live half (dev server): the
 * session binds an upload to the person who started it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const s3 = await import("../db/r2-over-s3.ts");
const signature = await import("../app/lib/file-signature.ts");
const sessions = await import("../app/lib/upload-sessions.ts");
const policy = await import("../app/lib/upload-policy.ts");

const CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const MiB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* The presigner and the part URL                                      */
/* ------------------------------------------------------------------ */

test("the query-string signer reproduces AWS's published presigned-URL vector", () => {
  // AWS, "Authenticating Requests: Using Query Parameters" — GET examplebucket/test.txt.
  const signed = s3.presignS3Url({
    method: "GET",
    canonicalPath: "/test.txt",
    host: "examplebucket.s3.amazonaws.com",
    query: [],
    headers: {},
    expiresSeconds: 86400,
    region: "us-east-1",
    ...CREDS,
    now: new Date("2013-05-24T00:00:00.000Z"),
  });
  assert.equal(signed.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.match(signed.canonicalRequest, /\nUNSIGNED-PAYLOAD$/);
});

function bucketWith(script = []) {
  const calls = [];
  let index = 0;
  const bucket = s3.createS3Bucket({
    endpoint: "https://ref.supabase.co/storage/v1/s3",
    bucket: "job-media",
    region: "eu-west-2",
    ...CREDS,
    now: () => new Date("2026-09-22T10:00:00.000Z"),
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, headers: init?.headers ?? {} });
      const next = script[index++] ?? { status: 200 };
      return new Response(next.body ?? null, { status: next.status ?? 200, headers: next.headers ?? {} });
    },
  });
  return { bucket, calls };
}

test("a part URL is UploadPart for one part of one upload, size-pinned, and carries no secret", () => {
  const { bucket } = bucketWith();
  const upload = bucket.resumeMultipartUpload("org_1/maintenance/site-s1/general/f1-clip.mov", "UP1");
  const url = new URL(upload.presignPart(3, 5 * MiB, 900));
  assert.equal(url.origin + url.pathname, "https://ref.supabase.co/storage/v1/s3/job-media/org_1/maintenance/site-s1/general/f1-clip.mov");
  assert.equal(url.searchParams.get("partNumber"), "3");
  assert.equal(url.searchParams.get("uploadId"), "UP1");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host", "the size is part of the signature");
  assert.match(url.searchParams.get("X-Amz-Credential"), /^AKIAIOSFODNN7EXAMPLE\/20260922\/eu-west-2\/s3\/aws4_request$/);
  assert.ok(!url.href.includes(CREDS.secretAccessKey), "the secret never appears in a URL");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);

  // A different size is a different signature: the browser cannot send more (or less).
  const other = new URL(upload.presignPart(3, 5 * MiB - 1, 900));
  assert.notEqual(other.searchParams.get("X-Amz-Signature"), url.searchParams.get("X-Amz-Signature"));

  for (const [part, size, expires] of [[0, 1, 900], [10001, 1, 900], [1, 0, 900], [1, 1, 0], [1, 1, 3601]]) {
    assert.throws(() => upload.presignPart(part, size, expires), `(${part}, ${size}, ${expires}) must be refused`);
  }
});

test("the only presigned operation is UploadPart — never a read", async () => {
  const client = code(await read("db/r2-over-s3.ts"));
  const handle = client.slice(client.indexOf("presignPart(partNumber: number"), client.indexOf("async listParts()"));
  assert.match(handle, /method: "PUT"/);
  assert.match(handle, /\["partNumber", String\(partNumber\)\],\s*\["uploadId", uploadId\]/);
  assert.equal((client.match(/presignS3Url\(\{/g) ?? []).length, 1, "presignS3Url has exactly one caller, presignPart");
});

test("ListParts is read from the bucket, sorted, and refuses a truncated listing", async () => {
  const xml = (truncated) =>
    `<?xml version="1.0"?><ListPartsResult><IsTruncated>${truncated}</IsTruncated>` +
    `<Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag><Size>100</Size></Part>` +
    `<Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag><Size>5242880</Size></Part></ListPartsResult>`;
  const { bucket, calls } = bucketWith([{ status: 200, body: xml("false") }, { status: 200, body: xml("true") }]);
  const upload = bucket.resumeMultipartUpload("org_1/k", "UP1");
  assert.deepEqual(await upload.listParts(), [
    { partNumber: 1, etag: "aaa", size: 5242880 },
    { partNumber: 2, etag: "bbb", size: 100 },
  ]);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /uploadId=UP1/);
  await assert.rejects(() => upload.listParts(), /truncated/);
});

test("ListParts also reads Supabase Storage's `<Parts>` shape, and ignores the markers", async () => {
  /* Measured on the Staging bucket: every part stored, and the AWS-only parser
     read none of them, so every direct upload was refused at `complete`. */
  const supabase =
    `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>job-media</Bucket><Key>k</Key><UploadId>UP1</UploadId>` +
    `<PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>2</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>` +
    `<Parts><PartNumber>1</PartNumber><LastModified>2026-09-22T10:00:00.000Z</LastModified><ETag>"aaa"</ETag><Size>5242880</Size></Parts>` +
    `<Parts><PartNumber>2</PartNumber><LastModified>2026-09-22T10:00:01.000Z</LastModified><ETag>"bbb"</ETag><Size>1000</Size></Parts>` +
    `</ListPartsResult>`;
  const { bucket } = bucketWith([{ status: 200, body: supabase }]);
  assert.deepEqual(await bucket.resumeMultipartUpload("org_1/k", "UP1").listParts(), [
    { partNumber: 1, etag: "aaa", size: 5242880 },
    { partNumber: 2, etag: "bbb", size: 1000 },
  ]);
});

test("MD5 matches RFC 1321's suite and node:crypto, including the padding edges", async () => {
  const { md5Hex } = await import("../app/lib/md5.ts");
  const { createHash, randomBytes } = await import("node:crypto");
  const rfc = {
    "": "d41d8cd98f00b204e9800998ecf8427e",
    a: "0cc175b9c0f1b6a831c399e269772661",
    abc: "900150983cd24fb0d6963f7d28e17f72",
    "message digest": "f96b697d7cb7938d525a2f31aaf161d0",
    abcdefghijklmnopqrstuvwxyz: "c3fcd3d76192e4007dfb496cca67e13b",
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890": "57edf4a22be3c955ac49da2e2107b67a",
  };
  for (const [input, want] of Object.entries(rfc)) assert.equal(md5Hex(new TextEncoder().encode(input)), want, JSON.stringify(input));
  for (const size of [55, 56, 63, 64, 65, 5 * MiB + 7]) {
    const bytes = randomBytes(size);
    assert.equal(md5Hex(new Uint8Array(bytes)), createHash("md5").update(bytes).digest("hex"), `${size} bytes`);
  }
});

test("a direct part is accepted only if the bucket stored the bytes the browser sent", async () => {
  /* Measured on Supabase Storage: a part URL honoured an unsigned x-amz-copy-source
     and stored ANOTHER object's bytes. The stored part's ETag (its MD5) must equal
     the MD5 the browser declares for what it sent — a copy cannot. */
  const route = code(await read("app/api/files/multipart/route.ts"));
  const complete = route.slice(route.indexOf('action === "complete"'));
  assert.ok(
    complete.indexOf("declared.get(part.partNumber) === part.etag.toLowerCase()") > 0 &&
      complete.indexOf("declared.get(part.partNumber) === part.etag.toLowerCase()") < complete.indexOf("multipart.complete(parts)"),
    "the contents are proven before anything is assembled",
  );
  const client = code(await read("app/lib/client-upload.ts"));
  assert.match(client, /const digest = md5Hex\(new Uint8Array\(await chunk\.arrayBuffer\(\)\)\);/);
  assert.match(client, /parts\.push\(\{ partNumber: index \+ 1, etag: digest \}\);/);
});

/* ------------------------------------------------------------------ */
/* File signatures                                                      */
/* ------------------------------------------------------------------ */

const bytes = (...values) => new Uint8Array(values);
const text = (value) => new TextEncoder().encode(value);
const withBox = (box) => new Uint8Array([0, 0, 0, 0x18, ...text(box), ...text("qt  ")]);

test("a file's first bytes must match the type it claims", () => {
  const { signatureMatches } = signature;
  const pass = [
    ["image/jpeg", "a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["image/png", "a.png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["image/gif", "a.gif", text("GIF89a")],
    ["image/webp", "a.webp", new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")])],
    ["image/heic", "a.heic", withBox("ftyp")],
    ["video/mp4", "a.mp4", withBox("ftyp")],
    ["video/quicktime", "a.mov", withBox("moov")],
    ["video/quicktime", "a.mov", withBox("wide")],
    ["video/webm", "a.webm", bytes(0x1a, 0x45, 0xdf, 0xa3)],
    ["application/pdf", "a.pdf", text("%PDF-1.7\n")],
    ["application/pdf", "a.pdf", text("\n\n%PDF-1.4")],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", text("PK\u0003\u0004")],
    ["application/msword", "a.doc", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
    ["text/plain", "a.txt", text("<html> is allowed in a text file; it is served as text")],
    ["text/csv", "a.csv", text("a,b\n1,2\n")],
    ["", "a.jpg", bytes(0xff, 0xd8, 0xff, 0xdb)],
  ];
  for (const [type, name, head] of pass) assert.ok(signatureMatches(type, name, head), `${type} ${name} should pass`);
  const refuse = [
    ["image/png", "a.png", text("<!doctype html><script>alert(1)</script>")],
    ["application/pdf", "a.pdf", text("MZ\u0090\u0000")],
    ["image/jpeg", "a.jpg", text("PK\u0003\u0004")],
    ["video/mp4", "a.mp4", text("<html>")],
    ["image/jpeg", "a.jpg", new Uint8Array(0)],
    ["text/html", "a.html", text("<html>")],
    ["image/svg+xml", "a.svg", text("<svg/>")],
  ];
  for (const [type, name, head] of refuse) assert.ok(!signatureMatches(type, name, head), `${type} ${name} must be refused`);
});

/* ------------------------------------------------------------------ */
/* The part plan, the uploader, and the session                         */
/* ------------------------------------------------------------------ */

test("the size policy: 50 MB for video, 25 MB for anything else, and what each refusal says", () => {
  assert.equal(policy.MAX_VIDEO_FILE_SIZE, 50 * MiB);
  assert.equal(policy.MAX_STANDARD_FILE_SIZE, 25 * MiB);
  assert.equal(policy.uploadSizeRefusal(true, 50 * MiB), null, "exactly the maximum is accepted");
  assert.equal(policy.uploadSizeRefusal(true, 50 * MiB + 1), "Maximum video size is 50 MB.");
  assert.equal(policy.uploadSizeRefusal(false, 25 * MiB), null);
  assert.equal(policy.uploadSizeRefusal(false, 25 * MiB + 1), "Files must be 25 MB or smaller.");
  assert.equal(policy.uploadSizeRefusal(false, 40 * MiB), "Files must be 25 MB or smaller.", "a non-video does not borrow the video ceiling");
  assert.equal(policy.maxUploadSize(true), 50 * MiB);
  assert.equal(policy.maxUploadSize(false), 25 * MiB);
});

test("the largest video (50 MB) is ten full parts; a smaller one ends on the remainder", () => {
  /* Re-pointed from "a 90 MB video is planned as 18 parts" when the owner set
     the video ceiling to 50 MB (2026-09-22): the plan arithmetic is unchanged,
     and both a remainder and an exact multiple are still covered. */
  const largest = sessions.partPlan(policy.MAX_VIDEO_FILE_SIZE);
  assert.equal(largest.partSize, 5 * MiB);
  assert.equal(largest.partCount, 10);
  assert.equal(largest.sizeOf(10), 5 * MiB, "the maximum ends on a full part");
  const plan = sessions.partPlan(48 * MiB + 321);
  assert.equal(plan.partCount, 10);
  assert.equal(plan.sizeOf(1), 5 * MiB);
  assert.equal(plan.sizeOf(10), 48 * MiB + 321 - 9 * 5 * MiB);
  assert.equal(plan.sizeOf(0), 0);
  assert.equal(plan.sizeOf(11), 0);
  assert.equal(sessions.partPlan(1_200_000).partCount, 1, "a file under 5 MiB is one part");
  assert.equal(sessions.partPlan(10 * MiB).sizeOf(2), 5 * MiB, "an exact multiple ends on a full part");
});

test("an upload belongs to the grant that authorised it — link, token, user or (locally) identity", async () => {
  const base = { via: "capability", tokenId: null, uploadToken: "", userId: "u1", authenticated: true, actorEmail: "A@x.test" };
  assert.equal(await sessions.uploaderKey({ ...base, via: "job-token", tokenId: "t1", uploadToken: "raw" }), "link:t1");
  const hashed = await sessions.uploaderKey({ ...base, via: "request-token", uploadToken: "raw-secret-token" });
  assert.match(hashed, /^token:[0-9a-f]{32}$/);
  assert.ok(!hashed.includes("raw-secret-token"), "a raw link is never stored");
  assert.equal(await sessions.uploaderKey(base), "user:u1");
  assert.equal(await sessions.uploaderKey({ ...base, authenticated: false }), "actor:a@x.test");
  // A dead link sent beside an editor's session authorised nothing, so it names nobody.
  assert.equal(await sessions.uploaderKey({ ...base, tokenId: "t9", uploadToken: "dead" }), "user:u1");
});

test("the bucket's part list must name exactly the planned parts; sizes count where the provider reports them", () => {
  const plan = sessions.partPlan(12 * MiB);
  const listed = (sizes) => sizes.map((size, index) => ({ partNumber: index + 1, size }));
  assert.ok(sessions.partsMatchPlan(listed([5 * MiB, 5 * MiB, 2 * MiB]), plan));
  assert.ok(sessions.partsMatchPlan(listed([0, 0, 0]), plan), "Supabase Storage reports Size 0 for every part");
  assert.ok(!sessions.partsMatchPlan(listed([5 * MiB, 5 * MiB - 1, 2 * MiB]), plan), "a reported size must be the planned one");
  assert.ok(!sessions.partsMatchPlan(listed([0, 0]), plan), "a missing part");
  assert.ok(!sessions.partsMatchPlan(listed([0, 0, 0, 0]), plan), "an extra part");
  assert.ok(!sessions.partsMatchPlan([{ partNumber: 1, size: 0 }, { partNumber: 3, size: 0 }, { partNumber: 4, size: 0 }], plan), "a gap");
});

test("a declared type must agree with the name, and only .txt/.csv are exempt from the byte check", () => {
  const { typeAgreesWithExtension, signatureMatches } = signature;
  for (const [type, name] of [
    ["video/mp4", "clip.mp4"],
    ["video/quicktime", "IMG_0559.MOV"],
    ["video/mp4", "clip.m4v"],
    ["image/heif", "IMG.HEIC"],
    ["application/vnd.ms-excel", "export.csv"],
    ["", "anything.pdf"],
  ]) assert.ok(typeAgreesWithExtension(type, name), `${type} ${name} agree`);
  for (const [type, name] of [
    ["text/plain", "x.mp4"],
    ["text/plain", "x.pdf"],
    ["application/pdf", "x.jpg"],
    ["video/mp4", "x.mov"],
    ["image/png", "x.jpg"],
  ]) assert.ok(!typeAgreesWithExtension(type, name), `${type} ${name} must not agree`);
  const text = (value) => new TextEncoder().encode(value);
  assert.ok(signatureMatches("application/vnd.ms-excel", "export.csv", text("a,b\n")), "Windows labels a CSV as Excel");
  assert.ok(!signatureMatches("text/plain", "x.mp4", text("anything")), "text is text only under a text name");
  assert.ok(signatureMatches("application/octet-stream", "a.pdf", text("%PDF-1.7")), "no real type: the extension decides");
  assert.ok(!signatureMatches("application/octet-stream", "a.pdf", text("<html>")));
});

test("a session refuses everyone but its uploader, and says when it has ended", () => {
  const now = Date.parse("2026-09-22T10:00:00Z");
  const live = { uploader: "user:u1", state: "pending", expiresAt: "2026-09-22T12:00:00.000Z" };
  assert.equal(sessions.sessionRefusal(live, "user:u1", now), null);
  const stranger = sessions.sessionRefusal(live, "user:u2", now);
  const missing = sessions.sessionRefusal(null, "user:u1", now);
  assert.deepEqual(stranger, missing, "another person's upload and no upload look the same");
  assert.equal(stranger.status, 404);
  assert.equal(sessions.sessionRefusal({ ...live, state: "completed" }, "user:u1", now).status, 410);
  assert.equal(sessions.sessionRefusal({ ...live, expiresAt: "2026-09-22T09:59:59.000Z" }, "user:u1", now).status, 410);
});

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a'), ('org_b');");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS upload_sessions \([\s\S]*?\))`/)[1].replace(/BIGINT/g, "INTEGER"));
  for (const index of init.matchAll(/"(CREATE (?:UNIQUE )?INDEX IF NOT EXISTS upload_sessions_[^"]+)"/g)) sqlite.exec(index[1]);
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

test("the session: scoped to its workspace, finished once, and swept when abandoned", async () => {
  const { db } = await database();
  const now = Date.parse("2026-09-22T10:00:00Z");
  const values = (key) => ({
    organisationId: "org_a",
    fileId: `f-${key}`,
    objectKey: key,
    uploadId: `up-${key}`,
    uploader: "user:u1",
    transport: "direct",
    contentType: "video/mp4",
    originalName: "clip.mp4",
    byteSize: 50 * MiB,
  });
  const made = await sessions.createUploadSession(db, values("org_a/k1"), now);
  assert.equal(made.state, "pending");
  assert.equal(Number(made.partCount), 10);
  assert.equal(made.expiresAt, new Date(now + sessions.UPLOAD_SESSION_LIFETIME_MS).toISOString());

  assert.ok(await sessions.findUploadSession(db, { organisationId: "org_a", objectKey: "org_a/k1", uploadId: "up-org_a/k1" }));
  assert.equal(
    await sessions.findUploadSession(db, { organisationId: "org_b", objectKey: "org_a/k1", uploadId: "up-org_a/k1" }),
    null,
    "another workspace cannot find it",
  );
  assert.equal(await sessions.claimFinalize(db, made.id, "org_b"), false, "nor claim it");
  assert.equal(await sessions.claimFinalize(db, made.id, "org_a"), true);
  assert.equal(await sessions.claimFinalize(db, made.id, "org_a"), false, "complete runs once");
  assert.equal(await sessions.abandonUploadSession(db, made.id, "org_a"), false, "an abort cannot interrupt a finishing upload");
  assert.equal(await sessions.settleUploadSession(db, made.id, "org_a", "completed", now), true);
  assert.equal(await sessions.settleUploadSession(db, made.id, "org_a", "failed", now), false, "an ending is never overwritten");

  const stale = await sessions.createUploadSession(db, values("org_a/k2"), now - sessions.UPLOAD_SESSION_LIFETIME_MS - 1000);
  const fresh = await sessions.createUploadSession(db, values("org_a/k3"), now);
  // Just past expiry but still finishing: its `complete` may be running, so the sweep waits.
  const finishing = await sessions.createUploadSession(db, values("org_a/k4"), now - sessions.UPLOAD_SESSION_LIFETIME_MS - 1000);
  await sessions.claimFinalize(db, finishing.id, "org_a");
  assert.equal(await sessions.pendingUploadCount(db, "org_a", "user:u1", now), 1, "only live pending sessions count");
  const aborted = [];
  const swept = await sessions.expireUploadSessions(db, async (key, uploadId) => aborted.push([key, uploadId]), { now });
  assert.deepEqual(aborted, [["org_a/k2", "up-org_a/k2"]], "only the abandoned upload is aborted in storage");
  assert.equal(swept.expired, 1);
  const after = await sessions.findUploadSession(db, { organisationId: "org_a", objectKey: "org_a/k2", uploadId: "up-org_a/k2" });
  assert.equal(after.state, "expired");
  assert.equal((await sessions.findUploadSession(db, { organisationId: "org_a", objectKey: "org_a/k3", uploadId: "up-org_a/k3" })).state, "pending");
  assert.equal((await sessions.findUploadSession(db, { organisationId: "org_a", objectKey: "org_a/k4", uploadId: "up-org_a/k4" })).state, "finalizing");
  assert.equal(await sessions.abandonUploadSession(db, fresh.id, "org_a"), true);
  assert.equal(await sessions.abandonUploadSession(db, fresh.id, "org_a"), false, "abort is one transition");
  void stale;
});

/* ------------------------------------------------------------------ */
/* Source: the order of the checks                                      */
/* ------------------------------------------------------------------ */

test("the route: authorise, then the session, then sign — and complete is claimed before it assembles", async () => {
  const route = code(await read("app/api/files/multipart/route.ts"));
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PUT"));
  const at = (needle) => {
    const index = post.indexOf(needle);
    assert.ok(index >= 0, `missing: ${needle}`);
    return index;
  };
  assert.ok(at("await authorizeUpload(") < at("await createUploadSession("), "start authorises before it reserves");
  assert.ok(at("await authorizeUpload(") < at("await findUploadSession("), "every action authorises first");
  const sign = post.slice(at('action === "sign-part"'));
  assert.ok(sign.indexOf("sessionRefusal(session, uploader)") < sign.indexOf("presignPart("), "a part is signed only for its own uploader");
  assert.match(sign, /partPlan\(Number\(session\.byteSize\), Number\(session\.partSize\)\)\.sizeOf\(partNumber\)/, "at the planned size");
  const complete = post.slice(at('action === "complete"'));
  assert.ok(complete.indexOf("claimFinalize(") < complete.indexOf("multipart.complete(parts)"), "claimed before assembly");
  assert.ok(complete.indexOf("direct.listParts()") < complete.indexOf("multipart.complete(parts)"), "direct parts are measured by the bucket");
  assert.match(complete, /if \(!partsMatchPlan\(listed, plan\)\)/);
  assert.ok(complete.indexOf("signatureMatches(") < complete.indexOf(".insert(attachments)"), "the bytes are checked before any row names them");
  assert.match(
    complete,
    /finally \{\s*if \(settled !== "completed"\) \{\s*if \(assembled\) await storage\.delete\(key\)[\s\S]*?else await multipart\.abort\(\)[\s\S]*?\}\s*await settleUploadSession\(db, session\.id, orgId, settled\)/,
    "every failed ending cleans the bucket, and is recorded",
  );
  assert.ok(post.indexOf("pendingUploadCount(") < post.indexOf("createMultipartUpload("), "the in-flight cap is checked before storage is reserved");
  assert.match(post, /session\.state === "pending" && \(await abandonUploadSession\(/, "abort only by winning pending → aborted");
  for (const file of ["app/api/files/multipart/route.ts", "app/api/files/route.ts"]) {
    assert.match(code(await read(file)), /typeAgreesWithExtension\(declared, /, `${file} requires the name and type to agree`);
  }
  const report = code(await read("app/api/report-job/route.ts"));
  assert.ok(report.indexOf("publicRetryAfter(d1, REPORT_JOB_SUBMISSIONS") < report.indexOf("await request.json()"), "the anonymous report door is throttled first");
  const put = route.slice(route.indexOf("export async function PUT"));
  assert.ok(put.indexOf("sessionRefusal(") < put.indexOf("await request.arrayBuffer()"), "a proxied part is refused before its bytes are read");
  assert.match(put, /bytes\.byteLength !== expected/);
  /* The size policy — 50 MB for video (owner decision, 2026-09-22; it was
     90 MB), 25 MB for everything else — is ONE module now, read by both routes
     and the client. Re-pointed from three per-file copies of the constants,
     which is how a limit drifts: each file must import it and keep no copy. */
  const policySource = await read("app/lib/upload-policy.ts");
  assert.match(policySource, /export const MAX_VIDEO_FILE_SIZE = 50 \* 1024 \* 1024;/);
  assert.match(policySource, /export const MAX_STANDARD_FILE_SIZE = 25 \* 1024 \* 1024;/);
  for (const file of ["app/api/files/multipart/route.ts", "app/api/files/route.ts", "app/lib/client-upload.ts"]) {
    const source = code(await read(file));
    assert.match(source, /from "[./]+(lib\/)?upload-policy"/, `${file} reads the one policy`);
    assert.doesNotMatch(source, /const MAX_(VIDEO|STANDARD)_FILE_SIZE\s*=/, `${file} keeps no copy of it`);
    assert.doesNotMatch(source, /90 MB/, `${file} no longer promises 90 MB`);
  }
  // Refused at `start`, before a session or an upload id exists.
  const start = route.slice(route.indexOf('if (action === "start")'));
  assert.ok(start.indexOf("uploadSizeRefusal(") < start.indexOf("createMultipartUpload("), "an oversized file never reserves storage");
  // And in the browser before the first request.
  const client = code(await read("app/lib/client-upload.ts"));
  assert.match(client, /function validateFile\(file: File\) \{\s*const refusal = uploadSizeRefusal\(isVideo\(file\), file\.size\);\s*if \(refusal\) throw new Error\(refusal\);/);
});

test("the small-file route checks the bytes before it stores them", async () => {
  const direct = code(await read("app/api/files/route.ts"));
  assert.ok(direct.indexOf("signatureMatches(file.type, file.name") < direct.indexOf("runtimeEnv.BUCKET.put(key, bytes"));
});

test("a caller with no session and no grant is refused before any lookup can say what exists", async () => {
  /* The job and anchor lookups run before the grant check (a token picks the
     tenant to look in), so without this floor a made-up job id answered 404 and
     a real one 401 — an existence oracle for `MN-<n>`. */
  const authority = code(await read("app/api/files/upload-authority.ts"));
  assert.match(
    authority,
    /export function ungrantedAnonymousRefusal\([\s\S]*?if \(uploadToken \|\| scope\.authenticated \|\| demoIdentityAllowed\(\)\) return null;\s*return refuse\("Sign in to upload a document\.", 401\);/,
  );
  for (const file of ["app/api/files/route.ts", "app/api/files/multipart/route.ts"]) {
    const source = code(await read(file));
    const floor = source.indexOf("ungrantedAnonymousRefusal(scope, uploadToken)");
    assert.ok(floor > 0, `${file}: the floor is applied`);
    for (const lookup of ["resolveUploadTenant(db", "eq(maintenanceRequests.id, requestId)", "anchorReferencesRefusal(db", "resolveUploadAuthority({"]) {
      const at = source.indexOf(lookup);
      assert.ok(at > floor, `${file}: \`${lookup}\` runs after the floor`);
    }
  }
});

test("the client sends parts to the signed URL without credentials, and never reads from storage", async () => {
  const client = code(await read("app/lib/client-upload.ts"));
  const putPart = client.slice(client.indexOf("function putPart("), client.indexOf("const PART_ATTEMPTS"));
  assert.match(putPart, /new XMLHttpRequest\(\)/);
  assert.match(putPart, /xhr\.open\("PUT", url\)/);
  assert.doesNotMatch(putPart, /withCredentials/, "the storage host gets no cookie of ours");
  assert.match(client, /action: "sign-part"/, "the URL comes from the route, for one part at a time");
  assert.doesNotMatch(client, /xhr\.open\("GET"|fetch\(signed\.url/, "the signed URL is only ever PUT to");
  assert.doesNotMatch(client, /supabase\.co|amazonaws\.com|r2\.dev|objectKey/, "the client builds no storage URL of its own");
  const upload = client.slice(client.indexOf("async function multipartUpload("));
  assert.ok(upload.indexOf('{ phase: "finalizing" }') < upload.indexOf('action: "complete"'), "finishing is shown while the server finishes");
  const entry = client.slice(client.indexOf("export async function uploadEvidenceFile("));
  assert.match(entry, /const finish = async[\s\S]*?onStage\?\.\(\{ phase: "complete" \}\)/, "complete only after the server answered");
});

test("the daily run sweeps abandoned uploads", async () => {
  const cron = code(await read("app/api/cron/daily/route.ts"));
  assert.match(cron, /expireUploadSessions\(db,/);
  assert.match(cron, /resumeMultipartUpload\(objectKey, uploadId\)\.abort\(\)/);
});

/* ------------------------------------------------------------------ */
/* Live: the session binds an upload to the person who started it       */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com", password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026" };
const RUN = `DUQA-${Date.now().toString(36)}`;
const made = [];
let cookie = "";
let fixtureSite = null;
let createdSite = null;

const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

async function call(pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function ownerContext() {
  if (!cookie) {
    const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
    if (!login.ok) return null;
    cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  }
  if (!fixtureSite) {
    const sites = await call("/api/sites", { headers: { cookie } });
    fixtureSite = (sites.body?.sites ?? []).find((row) => row.id)?.id ?? null;
  }
  if (!fixtureSite) {
    // A fresh local database has none: make one, marked, and close it afterwards.
    const created = await call("/api/sites", { method: "POST", headers: { cookie }, body: JSON.stringify({ data: { name: `${RUN} site`, addressLine1: "1 QA Street", city: "Testville", postcode: "ZZ99 9ZZ" } }) });
    fixtureSite = created.body?.id ?? created.body?.site?.id ?? null;
    if (fixtureSite) createdSite = fixtureSite;
  }
  return fixtureSite ? { cookie, site: fixtureSite } : null;
}

const startBody = (site, name, type, size) => JSON.stringify({ action: "start", kind: "general", siteId: site, originalName: name, contentType: type, byteSize: size });
const partHeaders = (site, start, part) => ({
  "content-type": "application/octet-stream",
  "X-Upload-Request-Id": "",
  "X-Upload-Kind": "general",
  "X-Upload-Key": start.key,
  "X-Upload-Id": start.uploadId,
  "X-Upload-Part": String(part),
  "X-Upload-Site-Id": site,
});

function pdfBytes(size) {
  const data = new Uint8Array(size);
  data.set(new TextEncoder().encode("%PDF-1.4\n"));
  for (let index = 9; index < size; index += 1) data[index] = (index * 31) % 251;
  return data;
}

test("live: a large upload belongs to the person who started it, and finishes once", { skip: !serverUp }, async (t) => {
  const owner = await ownerContext();
  if (!owner) return t.skip("the seeded owner or a site is unavailable here");
  const size = 6 * MiB + 123;
  const data = pdfBytes(size);
  const start = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: startBody(owner.site, `${RUN}-big.pdf`, "application/pdf", size) });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  made.push(start.body.fileId);
  assert.equal(start.body.partCount, 2);
  assert.ok(["proxy", "direct"].includes(start.body.transport));
  if (start.body.transport !== "proxy") return t.skip("this server signs direct parts; the Preview QA covers that path");

  const first = data.subarray(0, 5 * MiB);
  const second = data.subarray(5 * MiB);
  // Someone else in the SAME workspace (the local testing identity, no session) cannot feed this upload,
  const stranger = await call("/api/files/multipart", { method: "PUT", headers: { ...partHeaders(owner.site, start.body, 1), "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com" }, body: first });
  // 404, the session's answer: this admin may upload, so only the binding can refuse them.
  assert.equal(stranger.status, 404, `a colleague's part answered ${stranger.status}`);
  // and nor can a member of another workspace.
  const outsiderPart = await call("/api/files/multipart", { method: "PUT", headers: { ...partHeaders(owner.site, start.body, 1), "x-maintsupp-identity": "admin@demo-client-ltd.test.maintsupp.com" }, body: first });
  assert.ok(outsiderPart.status >= 400 && outsiderPart.status < 500, `another workspace's part answered ${outsiderPart.status}`);
  // The owner cannot send a part at a size the plan did not give it.
  const wrong = await call("/api/files/multipart", { method: "PUT", headers: { cookie, ...partHeaders(owner.site, start.body, 2) }, body: first });
  assert.equal(wrong.status, 400);

  const parts = [];
  for (const [index, chunk] of [first, second].entries()) {
    const sent = await call("/api/files/multipart", { method: "PUT", headers: { cookie, ...partHeaders(owner.site, start.body, index + 1) }, body: chunk });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    parts.push(sent.body.part);
  }
  const strangerComplete = await call("/api/files/multipart", {
    method: "POST",
    headers: { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com" },
    body: JSON.stringify({ action: "complete", kind: "general", siteId: owner.site, key: start.body.key, uploadId: start.body.uploadId, parts }),
  });
  assert.ok(strangerComplete.status >= 400 && strangerComplete.status < 500, `a stranger's complete answered ${strangerComplete.status}`);

  const completeBody = JSON.stringify({ action: "complete", kind: "general", siteId: owner.site, key: start.body.key, uploadId: start.body.uploadId, parts, title: `${RUN} big` });
  const done = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: completeBody });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const again = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: completeBody });
  assert.equal(again.status, 200, "a repeated complete answers with the same document");
  assert.equal(again.body.file.id, done.body.file.id);

  const download = await fetch(`${BASE_URL}/api/files/${done.body.file.id}`, { headers: { cookie } });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), data, "the bytes round-trip");
  /* Locally a cookie-less request is the testing identity, not a stranger (the
     development fallback; deployed builds refuse it — the Preview QA proves
     that). A member of ANOTHER workspace is a stranger everywhere. */
  const outsider = await fetch(`${BASE_URL}/api/files/${done.body.file.id}`, {
    headers: { "x-maintsupp-identity": "client@demo-client-ltd.test.maintsupp.com" },
  });
  assert.ok(outsider.status >= 400, `another workspace's member read the file (${outsider.status})`);
});

test("live: an abandoned upload cannot be finished, and false bytes are refused", { skip: !serverUp }, async (t) => {
  const owner = await ownerContext();
  if (!owner) return t.skip("the seeded owner or a site is unavailable here");
  const start = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: startBody(owner.site, `${RUN}-gone.pdf`, "application/pdf", 1_200_000) });
  assert.equal(start.status, 201);
  const keys = { kind: "general", siteId: owner.site, key: start.body.key, uploadId: start.body.uploadId };
  assert.equal((await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: JSON.stringify({ action: "abort", ...keys }) })).status, 200);
  const late = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: JSON.stringify({ action: "complete", ...keys, parts: [{ partNumber: 1, etag: "x" }] }) });
  assert.equal(late.status, 410, JSON.stringify(late.body));

  // A "PDF" that is really a web page: stored, checked, refused, deleted.
  if (start.body.transport === "proxy") {
    const html = new TextEncoder().encode(`<!doctype html><script>alert(1)</script>${"x".repeat(1_200_000)}`);
    const fake = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: startBody(owner.site, `${RUN}-fake.pdf`, "application/pdf", html.length) });
    assert.equal(fake.status, 201);
    made.push(fake.body.fileId);
    const part = await call("/api/files/multipart", { method: "PUT", headers: { cookie, ...partHeaders(owner.site, fake.body, 1) }, body: html });
    assert.equal(part.status, 200);
    const refused = await call("/api/files/multipart", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ action: "complete", kind: "general", siteId: owner.site, key: fake.body.key, uploadId: fake.body.uploadId, parts: [part.body.part] }),
    });
    assert.equal(refused.status, 415, JSON.stringify(refused.body));
  }
  // The small-file route refuses the same lie.
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode("<html><script>alert(1)</script></html>")], `${RUN}-fake.png`, { type: "image/png" }));
  form.set("kind", "general");
  form.set("siteId", owner.site);
  const direct = await fetch(`${BASE_URL}/api/files`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(direct.status, 415);

  // And the size and type policy is enforced before any storage is reserved.
  const huge = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: startBody(owner.site, `${RUN}-huge.mp4`, "video/mp4", policy.MAX_VIDEO_FILE_SIZE + 1) });
  assert.equal(huge.status, 413);
  assert.equal(huge.body?.error, "Maximum video size is 50 MB.");
  const page = await call("/api/files/multipart", { method: "POST", headers: { cookie }, body: startBody(owner.site, `${RUN}-page.html`, "text/html", 2_000_000) });
  assert.equal(page.status, 415);
});

test("live: with no session and no grant, a real job and a made-up one get the same 401", { skip: !serverUp }, async (t) => {
  /* A development server lends a signed-out caller the demo identity, so the
     floor cannot fire there; this runs against a production build (a Preview). */
  if ((await call("/api/context")).status !== 401) return t.skip("this server lends signed-out callers the demo identity");
  const owner = await ownerContext();
  if (!owner) return t.skip("the seeded owner is unavailable here");
  const jobs = await call("/api/maintenance", { headers: { cookie } });
  const real = (jobs.body?.requests ?? [])[0]?.id;
  if (!real) return t.skip("there is no job to probe with here");
  for (const [label, requestId] of [["real", real], ["made-up", `${RUN}-none`]]) {
    const start = await call("/api/files/multipart", { method: "POST", body: JSON.stringify({ action: "start", kind: "issue", requestId, originalName: "a.pdf", contentType: "application/pdf", byteSize: 2_000_000 }) });
    assert.equal(start.status, 401, `multipart start, ${label} job`);
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("kind", "issue");
    form.set("file", new Blob([pdfBytes(2000)], { type: "application/pdf" }), "a.pdf");
    const direct = await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form });
    assert.equal(direct.status, 401, `direct upload, ${label} job`);
  }
  const site = await call("/api/files/multipart", { method: "POST", body: startBody(`${RUN}-no-site`, "a.pdf", "application/pdf", 2_000_000) });
  assert.equal(site.status, 401, "a made-up site anchor gets the same answer");
});

after(async () => {
  if (!cookie) return;
  for (const id of made) {
    await fetch(`${BASE_URL}/api/files/${id}?confirm=true`, { method: "DELETE", headers: { cookie } }).catch(() => undefined);
  }
  if (createdSite) {
    await fetch(`${BASE_URL}/api/sites`, { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ id: createdSite }) }).catch(() => undefined);
  }
});
