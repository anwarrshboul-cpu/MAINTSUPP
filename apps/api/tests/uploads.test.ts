/**
 * The upload pipeline, and the uploads that must be refused.
 *
 * Photographs are the product's evidence: the intake form declines requests
 * without them and a contractor's "pictures of completed works" is what a
 * client pays against. So this file spends most of its length on the refusals —
 * an oversized file, a type that is not on the list, a type that lies about
 * itself, and a caller reaching for a job that is not theirs.
 *
 * Storage is pointed at a throwaway directory before the app is built, so these
 * run against the real local driver: bytes are written, signed, fetched back
 * and compared.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const storageDir = await mkdtemp(path.join(tmpdir(), "maintsupp-storage-"));
process.env.STORAGE_DIR = storageDir;
process.env.UPLOAD_SIGNING_SECRET = "test-signing-secret-not-a-real-one";
process.env.API_URL = "http://api.test";
// The S3 driver must not be picked up from a developer's shell.
for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
  delete process.env[key];
}

const { createTestDb } = await import("../../../packages/db/src/client.ts");
type Db = Awaited<ReturnType<typeof createTestDb>>;
const { createApp } = await import("../src/server.ts");
const {
  getStorage,
  presignS3Url,
  signObjectToken,
  SIGNED_URL_TTL_SECONDS,
} = await import("../src/lib/storage.ts");
const { sniffContentType, checkUpload, MAX_UPLOAD_BYTES } = await import(
  "../src/lib/files.ts"
);

let db: Db;
let app: ReturnType<typeof createApp>;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/* ------------------------------------------------------------- fixtures -- */

/** A byte string that sniffs as a real JPEG without being a real photograph. */
function jpeg(bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 12));
  out.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  for (let i = 12; i < out.length; i += 1) out[i] = i % 251;
  return out;
}

function png(): Uint8Array {
  const out = new Uint8Array(32);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
}

function pdf(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
}

function heic(): Uint8Array {
  const out = new Uint8Array(32);
  out.set([0, 0, 0, 0x18], 0);
  out.set(new TextEncoder().encode("ftypheic"), 4);
  return out;
}

function webp(): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode("RIFF"), 0);
  out.set(new TextEncoder().encode("WEBP"), 8);
  return out;
}

/* -------------------------------------------------------------- helpers -- */

let ipCounter = 0;
/** A fresh address per call, so one test's requests never spend another's quota. */
const freshIp = () => `10.9.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

function call(method: string, path: string, body?: unknown, cookie?: string) {
  return app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": freshIp(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(
  path: string,
  file: { bytes: Uint8Array; type: string; name: string },
  fields: Record<string, string> = {},
  cookie?: string,
  ip = freshIp(),
) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([file.bytes as unknown as BlobPart], { type: file.type }),
    file.name,
  );
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return app.request(path, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": ip },
    body: form,
  });
}

async function account(
  email: string,
  role: string,
  scope: { organisationId?: string; contractorId?: string } = {},
) {
  await call("POST", "/auth/register", {
    email, password: "test-password-1234", fullName: email,
  });
  await db.query("update users set email_verified_at = now() where lower(email) = $1", [email]);
  await db.query(
    `update profiles set role = $2::user_role, status = 'active',
            organisation_id = $3, contractor_id = $4 where email = $1`,
    [email, role, scope.organisationId ?? null, scope.contractorId ?? null],
  );
  const res = await call("POST", "/auth/sign-in", { email, password: "test-password-1234" });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("ms_session="), `${email} could not sign in`);
  return cookie;
}

before(async () => {
  db = await createTestDb();
  app = createApp(db);

  ids.orgA = (await db.query<{ id: string }>(
    "insert into organisations (name, slug) values ('Client A','up-a') returning id::text"))[0].id;
  ids.orgB = (await db.query<{ id: string }>(
    "insert into organisations (name, slug) values ('Client B','up-b') returning id::text"))[0].id;
  ids.contractor = (await db.query<{ id: string }>(
    "insert into contractors (name) values ('Acme Shutters') returning id::text"))[0].id;

  const [job] = await db.query<{ id: string; token: string }>(
    `insert into jobs (organisation_id, title, description, contractor_id)
     values ($1,'Shutter jammed','Front shutter will not close',$2)
     returning id::text, share_token as token`,
    [ids.orgA, ids.contractor],
  );
  ids.job = job.id;
  ids.token = job.token;

  cookies.admin = await account("up-admin@maintsupp.test", "admin");
  cookies.clientA = await account("up-a@client.test", "client_admin", { organisationId: ids.orgA });
  cookies.clientB = await account("up-b@client.test", "client_admin", { organisationId: ids.orgB });
  cookies.contractor = await account("up-c@acme.test", "contractor", { contractorId: ids.contractor });
});

after(async () => {
  await db.close();
  await rm(storageDir, { recursive: true, force: true });
});

/* ============================================================== the bytes == */

describe("1 — what the bytes are, not what they claim to be", () => {
  test("each allowed format is recognised from its magic number", () => {
    assert.equal(sniffContentType(jpeg()), "image/jpeg");
    assert.equal(sniffContentType(png()), "image/png");
    assert.equal(sniffContentType(webp()), "image/webp");
    assert.equal(sniffContentType(heic()), "image/heic");
    assert.equal(sniffContentType(pdf()), "application/pdf");
  });

  test("formats that are not on the list are not recognised", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const gif = new TextEncoder().encode("GIF89a............");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const bytes of [svg, html, gif, zip]) {
      assert.equal(sniffContentType(bytes), null);
    }
  });

  test("a declaration of octet-stream defers to the bytes, a wrong one does not", () => {
    // Android cameras really do send this for a HEIC; it is an absent claim,
    // not a contradicted one.
    const vague = checkUpload("application/octet-stream", heic());
    assert.equal(vague.ok && vague.contentType, "image/heic");

    const lie = checkUpload("image/jpeg", pdf());
    assert.equal(lie.ok, false);
  });
});

/* ======================================================= authenticated in == */

describe("2 — a signed-in caller attaches to a job", () => {
  test("staff upload a photograph and the bytes land in storage", async () => {
    const bytes = jpeg(4096);
    const res = await upload(
      `/uploads/job/${ids.job}`,
      { bytes, type: "image/jpeg", name: "IMG_0042.jpg" },
      { kind: "issue_picture" },
      cookies.admin,
    );
    const created = await res.json();
    assert.equal(res.status, 200, JSON.stringify(created));
    const { attachment } = created;

    assert.equal(attachment.content_type, "image/jpeg");
    assert.equal(Number(attachment.byte_size), bytes.length);
    assert.equal(attachment.pending, false, "a staff upload was held for review");
    assert.match(attachment.object_key, new RegExp(`^jobs/${ids.job}/[0-9a-f-]{36}\\.jpg$`));
    ids.attachment = attachment.id;

    const onDisk = await readFile(path.join(storageDir, attachment.object_key));
    assert.deepEqual(new Uint8Array(onDisk), bytes, "the stored bytes are not the sent bytes");
  });

  test("the key is derived from the sniffed type, never the sent filename", async () => {
    const res = await upload(
      `/uploads/job/${ids.job}`,
      // A double extension that would be dangerous if the name chose the path.
      { bytes: png(), type: "image/png", name: "invoice.pdf.html" },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 200);
    const { attachment } = await res.json();
    assert.match(attachment.object_key, /\.png$/, "the client's extension reached disk");
    assert.equal(attachment.original_name, "invoice.pdf.html", "the display name was lost");
  });

  test("a PDF is stored as a file, a photograph as a picture", async () => {
    const res = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: pdf(), type: "application/pdf", name: "gas-cert.pdf" },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).attachment.kind, "file");
  });

  test("a kind that is not in the enum is ignored, not passed through", async () => {
    const res = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: jpeg(), type: "image/jpeg", name: "a.jpg" },
      { kind: "'; drop table attachments; --" },
      cookies.admin,
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).attachment.kind, "issue_picture");
  });

  test("the assigned contractor can attach; a signed-out caller cannot", async () => {
    const ok = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: jpeg(), type: "image/jpeg", name: "done.jpg" },
      { kind: "completed_picture" },
      cookies.contractor,
    );
    assert.equal(ok.status, 200);

    const out = await upload(`/uploads/job/${ids.job}`, {
      bytes: jpeg(), type: "image/jpeg", name: "done.jpg",
    });
    assert.equal(out.status, 401);
  });
});

/* =========================================================== the refusals == */

describe("3 — the uploads that must be refused", () => {
  test("an oversized file is refused", async () => {
    const tooBig = jpeg(MAX_UPLOAD_BYTES + 1);
    const res = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: tooBig, type: "image/jpeg", name: "huge.jpg" },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /10MB or smaller/);

    const [{ n }] = await db.query<{ n: number }>(
      "select count(*)::int as n from attachments where byte_size > $1",
      [MAX_UPLOAD_BYTES],
    );
    assert.equal(Number(n), 0, "an oversized file reached the database");
  });

  test("a content type that is not on the allow-list is refused", async () => {
    const res = await upload(
      `/uploads/job/${ids.job}`,
      {
        bytes: new TextEncoder().encode("id,name\n1,Aldgate\n"),
        type: "text/csv",
        name: "sites.csv",
      },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 415);
  });

  test("an SVG is refused even though it is an image", async () => {
    const res = await upload(
      `/uploads/job/${ids.job}`,
      {
        bytes: new TextEncoder().encode('<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"/>'),
        type: "image/svg+xml",
        name: "logo.svg",
      },
      {},
      cookies.admin,
    );
    assert.equal(res.status, 415);
  });

  test("a spoofed Content-Type with mismatched magic bytes is refused", async () => {
    // An HTML page announced as a JPEG — the attack the sniff exists for.
    const html = await upload(
      `/uploads/job/${ids.job}`,
      {
        bytes: new TextEncoder().encode("<!doctype html><script>fetch('/steal')</script>"),
        type: "image/jpeg",
        name: "photo.jpg",
      },
      {},
      cookies.admin,
    );
    assert.equal(html.status, 415);

    // And an allowed type wearing another allowed type's label, which would
    // otherwise be stored with a content type that makes it render inline.
    const swapped = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: pdf(), type: "image/png", name: "photo.png" },
      {},
      cookies.admin,
    );
    assert.equal(swapped.status, 415);
    assert.match((await swapped.json()).error, /do not match/i);

    const [{ n }] = await db.query<{ n: number }>(
      "select count(*)::int as n from attachments where original_name in ('photo.jpg','photo.png')",
    );
    assert.equal(Number(n), 0, "a spoofed upload was recorded");
  });

  test("an empty part and a missing part are refused", async () => {
    const empty = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: new Uint8Array(0), type: "image/jpeg", name: "nothing.jpg" },
      {},
      cookies.admin,
    );
    assert.equal(empty.status, 415);

    const form = new FormData();
    form.set("kind", "issue_picture");
    const none = await app.request(`/uploads/job/${ids.job}`, {
      method: "POST",
      headers: { cookie: cookies.admin, "x-forwarded-for": freshIp() },
      body: form,
    });
    assert.equal(none.status, 400);
  });

  test("a caller cannot attach to a job outside their scope", async () => {
    // Client B naming client A's job id. 404 and not 403: "forbidden" would
    // confirm the job exists.
    const res = await upload(
      `/uploads/job/${ids.job}`,
      { bytes: jpeg(), type: "image/jpeg", name: "not-mine.jpg" },
      {},
      cookies.clientB,
    );
    assert.equal(res.status, 404);

    const [{ n }] = await db.query<{ n: number }>(
      "select count(*)::int as n from attachments where original_name = 'not-mine.jpg'",
    );
    assert.equal(Number(n), 0, "client B attached a file to client A's job");
  });

  test("an unassigned contractor cannot attach to somebody else's job", async () => {
    const [other] = await db.query<{ id: string }>(
      `insert into jobs (organisation_id, title, description)
       values ($1,'Leak','Staff WC') returning id::text`,
      [ids.orgB],
    );
    const res = await upload(
      `/uploads/job/${other.id}`,
      { bytes: jpeg(), type: "image/jpeg", name: "x.jpg" },
      {},
      cookies.contractor,
    );
    assert.equal(res.status, 404);
  });
});

/* ============================================================ reading out == */

describe("4 — reads go through a short-lived signed URL", () => {
  test("an in-scope caller gets a URL that returns the bytes", async () => {
    const res = await call("GET", `/uploads/${ids.attachment}/url`, undefined, cookies.clientA);
    assert.equal(res.status, 200);
    const { url, expiresIn } = await res.json();
    assert.equal(expiresIn, SIGNED_URL_TTL_SECONDS);
    assert.ok(expiresIn <= 900, "a 'short-lived' URL outlived fifteen minutes");
    assert.match(url, /^http:\/\/api\.test\/uploads\/file\?token=/);

    // No cookie: the signature in the URL is the whole credential, because an
    // <img> tag loading cross-origin sends nothing else.
    const fetched = await app.request(url.replace("http://api.test", ""));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "image/jpeg");
    assert.equal(fetched.headers.get("cache-control"), `private, max-age=${SIGNED_URL_TTL_SECONDS}`);
    assert.match(fetched.headers.get("content-disposition") ?? "", /^inline;/);
    assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), jpeg(4096));
  });

  test("a PDF is served as an attachment, never inline on the API's origin", async () => {
    const [doc] = await db.query<{ id: string }>(
      "select id::text from attachments where content_type = 'application/pdf' limit 1");
    const { url } = await (
      await call("GET", `/uploads/${doc.id}/url`, undefined, cookies.admin)
    ).json();
    const fetched = await app.request(url.replace("http://api.test", ""));
    assert.match(fetched.headers.get("content-disposition") ?? "", /^attachment;/);
  });

  test("a tampered, forged or expired token returns nothing", async () => {
    const good = signObjectToken("jobs/x/y.jpg", 300);
    const [expiry, key, signature] = good.split(".");

    for (const bad of [
      undefined,
      "",
      "garbage",
      `${expiry}.${key}`,                                  // no signature
      `${Number(expiry) + 86400}.${key}.${signature}`,     // expiry moved out
      `${expiry}.${Buffer.from("jobs/other/z.jpg").toString("base64url")}.${signature}`,
      `${expiry}.${key}.${Buffer.from("x".repeat(32)).toString("base64url")}`,
      signObjectToken("jobs/x/y.jpg", -60),                // correctly signed, expired
    ]) {
      const res = await app.request(
        `/uploads/file${bad === undefined ? "" : `?token=${encodeURIComponent(bad)}`}`,
      );
      assert.equal(res.status, 403, `token ${String(bad).slice(0, 24)}… was accepted`);
    }
  });

  test("guessing the object key without a signature gets nothing", async () => {
    const [row] = await db.query<{ object_key: string }>(
      "select object_key from attachments where id = $1", [ids.attachment]);
    // Exactly what someone who read the database row would try.
    const res = await app.request(`/uploads/file?token=${encodeURIComponent(row.object_key)}`);
    assert.equal(res.status, 403);
  });

  test("a client cannot get a URL for another client's attachment", async () => {
    const res = await call("GET", `/uploads/${ids.attachment}/url`, undefined, cookies.clientB);
    assert.equal(res.status, 404);
  });

  test("a signed-out caller cannot ask for a URL at all", async () => {
    assert.equal((await call("GET", `/uploads/${ids.attachment}/url`)).status, 401);
  });
});

/* =========================================================== the share link == */

describe("5 — the contractor's upload through a share link", () => {
  test("it lands pending, attributed, and via the link", async () => {
    const res = await upload(
      `/public/job/${ids.token}/upload`,
      { bytes: jpeg(2048), type: "image/jpeg", name: "completed.jpg" },
      { uploaderName: "Dave (Acme)" },
    );
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.pending, true);
    // Nothing that would let the uploader read anything back.
    assert.equal("url" in body, false);
    assert.equal("objectKey" in body, false);
    ids.shared = body.attachmentId;

    const [row] = await db.query<{
      pending: boolean; via_share_link: boolean; uploaded_by_name: string;
      kind: string; uploaded_by: string | null; job_id: string;
    }>(
      `select pending, via_share_link, uploaded_by_name, kind::text,
              uploaded_by::text, job_id::text from attachments where id = $1`,
      [ids.shared],
    );
    assert.equal(row.pending, true, "an anonymous upload was published immediately");
    assert.equal(row.via_share_link, true);
    assert.equal(row.uploaded_by_name, "Dave (Acme)");
    assert.equal(row.uploaded_by, null, "an anonymous upload was credited to an account");
    assert.equal(row.kind, "completed_picture");
    assert.equal(row.job_id, ids.job);
  });

  test("an unnamed upload is refused", async () => {
    const res = await upload(
      `/public/job/${ids.token}/upload`,
      { bytes: jpeg(), type: "image/jpeg", name: "anon.jpg" },
      {},
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /name/i);
  });

  test("the limits apply to the anonymous path too", async () => {
    const big = await upload(
      `/public/job/${ids.token}/upload`,
      { bytes: jpeg(MAX_UPLOAD_BYTES + 1), type: "image/jpeg", name: "huge.jpg" },
      { uploaderName: "Dave" },
    );
    assert.equal(big.status, 413);

    const wrong = await upload(
      `/public/job/${ids.token}/upload`,
      { bytes: new TextEncoder().encode("<!doctype html>"), type: "image/jpeg", name: "x.jpg" },
      { uploaderName: "Dave" },
    );
    assert.equal(wrong.status, 415);
  });

  test("a wrong, revoked or expired token is refused identically", async () => {
    const wrongShape = await upload(
      "/public/job/not-a-token/upload",
      { bytes: jpeg(), type: "image/jpeg", name: "a.jpg" }, { uploaderName: "D" });
    const wrongValue = await upload(
      `/public/job/${"0".repeat(64)}/upload`,
      { bytes: jpeg(), type: "image/jpeg", name: "a.jpg" }, { uploaderName: "D" });

    const [expired] = await db.query<{ token: string }>(
      `insert into jobs (organisation_id, title, description, share_expires_at)
       values ($1,'Old','Old', now() - interval '1 day') returning share_token as token`,
      [ids.orgA]);
    const aged = await upload(
      `/public/job/${expired.token}/upload`,
      { bytes: jpeg(), type: "image/jpeg", name: "a.jpg" }, { uploaderName: "D" });

    const [revoked] = await db.query<{ token: string }>(
      `insert into jobs (organisation_id, title, description, share_enabled)
       values ($1,'Off','Off', false) returning share_token as token`,
      [ids.orgA]);
    const off = await upload(
      `/public/job/${revoked.token}/upload`,
      { bytes: jpeg(), type: "image/jpeg", name: "a.jpg" }, { uploaderName: "D" });

    for (const res of [wrongShape, wrongValue, aged, off]) assert.equal(res.status, 404);
    assert.deepEqual(await wrongValue.json(), await aged.json());
  });

  test("a pending upload is invisible everywhere until it is released", async () => {
    // Not on the job, not on the share page, and no URL for a client.
    const portal = await call("GET", `/jobs/${ids.job}`, undefined, cookies.clientA);
    const listed = (await portal.json()).attachments.map((a: { id: string }) => a.id);
    assert.equal(listed.includes(ids.shared), false, "a pending upload was shown in the portal");

    const shared = await call("GET", `/public/job/${ids.token}`);
    const onShare = (await shared.json()).attachments.map((a: { id: string }) => a.id);
    assert.equal(onShare.includes(ids.shared), false, "a pending upload was shown on the share page");

    const url = await call("GET", `/uploads/${ids.shared}/url`, undefined, cookies.clientA);
    assert.equal(url.status, 404, "a client got a URL for an unreviewed upload");

    const viaLink = await call("GET", `/public/job/${ids.token}/attachment/${ids.shared}`);
    assert.equal(viaLink.status, 404);
  });

  test("staff can see it waiting, and only staff can release it", async () => {
    const staffView = await call("GET", `/uploads/job/${ids.job}`, undefined, cookies.admin);
    const waiting = (await staffView.json()).attachments.filter(
      (a: { pending: boolean }) => a.pending);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].uploaded_by_name, "Dave (Acme)");

    const clientView = await call("GET", `/uploads/job/${ids.job}`, undefined, cookies.clientA);
    assert.equal(
      (await clientView.json()).attachments.some((a: { pending: boolean }) => a.pending),
      false, "a client was shown an unreviewed upload");

    assert.equal(
      (await call("POST", `/uploads/${ids.shared}/release`, {}, cookies.clientA)).status, 403);
    assert.equal(
      (await call("POST", `/uploads/${ids.shared}/release`, {}, cookies.contractor)).status, 403);

    const released = await call("POST", `/uploads/${ids.shared}/release`, {}, cookies.admin);
    assert.equal(released.status, 200);

    const [row] = await db.query<{ pending: boolean; reviewed_by: string | null }>(
      "select pending, reviewed_by::text from attachments where id = $1", [ids.shared]);
    assert.equal(row.pending, false);
    assert.ok(row.reviewed_by, "a release was recorded with nobody's name against it");

    // Releasing twice is not a second release.
    assert.equal(
      (await call("POST", `/uploads/${ids.shared}/release`, {}, cookies.admin)).status, 404);
  });

  test("once released it is on the job, and readable through the link", async () => {
    const portal = await call("GET", `/jobs/${ids.job}`, undefined, cookies.clientA);
    const listed = (await portal.json()).attachments.map((a: { id: string }) => a.id);
    assert.ok(listed.includes(ids.shared), "a released upload never reached the job");

    const res = await call("GET", `/public/job/${ids.token}/attachment/${ids.shared}`);
    assert.equal(res.status, 200);
    const { url } = await res.json();
    const fetched = await app.request(url.replace("http://api.test", ""));
    assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), jpeg(2048));

    // …but only through the link for THAT job.
    const [other] = await db.query<{ token: string }>(
      `insert into jobs (organisation_id, title, description)
       values ($1,'Elsewhere','Elsewhere') returning share_token as token`, [ids.orgA]);
    assert.equal(
      (await call("GET", `/public/job/${other.token}/attachment/${ids.shared}`)).status, 404);
  });

  test("staff can discard a pending upload and its bytes go with it", async () => {
    const posted = await upload(
      `/public/job/${ids.token}/upload`,
      { bytes: jpeg(128), type: "image/jpeg", name: "blurry.jpg" },
      { uploaderName: "Dave (Acme)" },
    );
    const { attachmentId } = await posted.json();
    const [{ object_key: key }] = await db.query<{ object_key: string }>(
      "select object_key from attachments where id = $1", [attachmentId]);

    assert.ok(await getStorage().get(key), "the upload never reached storage");
    assert.equal((await call("POST", `/uploads/${attachmentId}/discard`, {}, cookies.admin)).status, 200);
    assert.equal(await getStorage().get(key), null, "the discarded bytes are still in the bucket");
  });

  test("the public upload endpoint is rate limited", async () => {
    const ip = "203.0.113.77";
    let refused = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = await upload(
        `/public/job/${ids.token}/upload`,
        { bytes: jpeg(64), type: "image/jpeg", name: `flood-${i}.jpg` },
        { uploaderName: "Flood" },
        undefined,
        ip,
      );
      if (res.status === 429) refused += 1;
    }
    assert.ok(refused > 0, "a script could upload without limit through a share link");
  });
});

/* ============================================================== the intake == */

describe("6 — intake photographs become real attachments", () => {
  test("a photograph is staged and comes back as a claim ticket, not a key", async () => {
    const res = await upload("/public/intake/upload", {
      bytes: jpeg(1024), type: "image/jpeg", name: "shutter.jpg",
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.photo, /^[0-9a-f-]{36}$/);
    // The client learns a ticket. It never learns where the bytes live.
    assert.equal("objectKey" in body, false);
    assert.equal("url" in body, false);
    ids.ticket = body.photo;
  });

  test("submitting the form turns the ticket into an attachment", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Dana", phone: "07700 900000",
      email: "dana@store.test", description: "The front shutter is jammed open.",
      faultCategory: "Locks", photos: [ids.ticket],
    });
    const submitted = await res.json();
    assert.equal(res.status, 200, JSON.stringify(submitted));
    const { reference, photographs } = submitted;
    assert.match(reference, /^REQ-[0-9A-F]{8}$/);
    assert.equal(photographs, 1);

    const [request] = await db.query<{ id: string; photos: string[] }>(
      "select id::text, photos from job_requests where email = 'dana@store.test'");
    ids.request = request.id;

    const [attachment] = await db.query<{
      kind: string; object_key: string; content_type: string; byte_size: string;
    }>(
      `select kind::text, object_key, content_type, byte_size::text
         from attachments where job_request_id = $1`, [request.id]);
    assert.ok(attachment, "the intake photograph did not become an attachment");
    assert.equal(attachment.kind, "issue_picture");
    assert.equal(attachment.content_type, "image/jpeg");
    assert.equal(Number(attachment.byte_size), 1024);

    // Backwards compatibility: `photos` still holds the object keys, so the
    // triage queue that reads it keeps working unchanged.
    assert.deepEqual(request.photos, [attachment.object_key]);
  });

  test("a ticket works exactly once", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Dana", phone: "07700 900000",
      email: "dana2@store.test", description: "Trying the same photograph twice.",
      faultCategory: "Locks", photos: [ids.ticket],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /expired/i);

    const [{ n }] = await db.query<{ n: number }>(
      "select count(*)::int as n from job_requests where email = 'dana2@store.test'");
    assert.equal(Number(n), 0, "a rejected submission still wrote a request");
  });

  test("an invented ticket is refused rather than filed as a photograph", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Mal", phone: "07700 900001",
      email: "mal@store.test", description: "Claiming a photograph I never sent.",
      faultCategory: "Locks", photos: ["11111111-2222-3333-4444-555555555555"],
    });
    assert.equal(res.status, 400);
  });

  test("a request with no photographs is still declined", async () => {
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Aldgate", contactName: "Dana", phone: "07700 900000",
      email: "dana3@store.test", description: "The front shutter is jammed open.",
      faultCategory: "Locks", photos: [],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /photograph/i);
  });

  test("a bare string is kept in photos and becomes no attachment", async () => {
    // The pre-upload shape. It is not evidence that any bytes exist, so it is
    // recorded and not promoted.
    const res = await call("POST", "/public/report-a-job", {
      siteName: "Legacy Store", contactName: "Pat", phone: "07700 900002",
      email: "pat@store.test", description: "Submitted the way the old form did.",
      faultCategory: "Locks", photos: ["intake/shutter.jpg"],
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).photographs, 0);

    const [row] = await db.query<{ id: string; photos: string[] }>(
      "select id::text, photos from job_requests where email = 'pat@store.test'");
    assert.deepEqual(row.photos, ["intake/shutter.jpg"]);
    const [{ n }] = await db.query<{ n: number }>(
      "select count(*)::int as n from attachments where job_request_id = $1", [row.id]);
    assert.equal(Number(n), 0);
  });

  test("triage carries the photograph onto the job it becomes", async () => {
    const res = await call("POST", `/jobs/intake/${ids.request}/convert`,
      { organisationId: ids.orgA, priority: "Urgent" }, cookies.admin);
    assert.equal(res.status, 200);
    const { job } = await res.json();

    const [row] = await db.query<{ job_id: string; request_id: string | null }>(
      `select job_id::text, job_request_id::text as request_id
         from attachments where job_id = $1`, [job.id]);
    assert.ok(row, "the evidence did not follow the request onto the job");
    assert.equal(row.request_id, null, "the attachment kept two owners");
  });

  test("intake uploads obey the same byte rules", async () => {
    assert.equal(
      (await upload("/public/intake/upload", {
        bytes: new TextEncoder().encode("<!doctype html><script></script>"),
        type: "image/png", name: "x.png",
      })).status,
      415,
    );
    assert.equal(
      (await upload("/public/intake/upload", {
        bytes: jpeg(MAX_UPLOAD_BYTES + 1), type: "image/jpeg", name: "x.jpg",
      })).status,
      413,
    );
  });
});

/* ============================================================ the drivers == */

describe("7 — the storage drivers", () => {
  test("the local driver refuses a key that escapes its directory", async () => {
    const storage = getStorage();
    assert.equal(storage.backend, "local");
    for (const key of ["../escaped.jpg", "jobs/../../etc/passwd", "/etc/passwd", "a//b.jpg"]) {
      await assert.rejects(
        () => storage.put(key, jpeg(), "image/jpeg"),
        /unsafe object key/i,
        `${key} was accepted`,
      );
    }
  });

  test("nothing is served from a guessable path", async () => {
    const [row] = await db.query<{ object_key: string }>(
      "select object_key from attachments where id = $1", [ids.attachment]);
    for (const path of [
      `/${row.object_key}`,
      `/uploads/${row.object_key}`,
      `/storage/${row.object_key}`,
      `/uploads/file?key=${encodeURIComponent(row.object_key)}`,
    ]) {
      const res = await app.request(path);
      assert.notEqual(res.status, 200, `${path} served a file without a signature`);
    }
  });

  test("the limits endpoint states the same rules that are enforced", async () => {
    const res = await app.request("/uploads/limits");
    assert.equal(res.status, 200);
    const limits = await res.json();
    assert.equal(limits.maxBytes, MAX_UPLOAD_BYTES);
    assert.deepEqual(limits.accept.sort(), [
      "application/pdf", "image/heic", "image/jpeg", "image/png", "image/webp",
    ]);
  });

  test("the S3 presigner matches AWS's published test vector", () => {
    /*
     * The documented "GET Object (using query parameters)" example. A SigV4
     * mistake is invisible in every local test — the local driver never signs
     * anything — and surfaces in production as every photograph 403ing with
     * SignatureDoesNotMatch. This is the only check that would have caught it.
     */
    const url = presignS3Url(
      {
        endpoint: "https://examplebucket.s3.amazonaws.com",
        bucket: "examplebucket",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      86400,
      new Date("2013-05-24T00:00:00Z"),
    );
    assert.equal(
      url.split("X-Amz-Signature=")[1],
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    assert.match(url, /X-Amz-Expires=86400/);
  });
});
