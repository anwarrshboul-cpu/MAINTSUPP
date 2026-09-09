/**
 * Presigned URLs, which are how a file larger than 4.5 MB reaches storage.
 *
 *   node --test tests/presigned-upload.test.mjs
 *
 * Every byte this application stored used to travel through a Vercel function,
 * and two limits made that impossible above ~4.5 MB: Vercel refuses a request
 * body over 4.5 MB, and S3 requires multipart parts of at least 5 MiB. Measured
 * in Phase 3, a 6.74 MiB upload answered FUNCTION_PAYLOAD_TOO_LARGE, and 73 of
 * the migration's 3,107 files — 18.3% of its bytes, including two O&M manuals —
 * could not be uploaded by any code path at all.
 *
 * A presigned URL removes the relay: the server signs, the client PUTs straight
 * to storage. So the signature is now the only thing standing between a private
 * bucket and the internet, and these tests exist because a signing bug does not
 * fail loudly — it either 403s everything or, far worse, signs more than it
 * meant to.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, createHash } from "node:crypto";

import {
  canonicalQueryString,
  createS3Bucket,
  presignS3Url,
  sigv4SigningKey,
} from "../db/r2-over-s3.ts";

const ENDPOINT = "https://example.supabase.co/storage/v1/s3";
const BUCKET = "job-media";
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const AT = new Date(Date.UTC(2026, 8, 9, 12, 0, 0));

const parse = (url) => {
  const u = new URL(url);
  return { url: u, q: (name) => u.searchParams.get(name) };
};

const presign = (over = {}) =>
  presignS3Url({
    method: "PUT",
    canonicalPath: "/storage/v1/s3/job-media/org_1/photo.jpg",
    host: "example.supabase.co",
    origin: "https://example.supabase.co",
    expiresInSeconds: 900,
    region: "eu-west-2",
    ...CREDS,
    now: AT,
    ...over,
  });

test("the URL carries the six SigV4 query parameters and a signature", () => {
  const { q } = parse(presign().url);
  assert.equal(q("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(q("X-Amz-Credential"), "AKIDEXAMPLE/20260909/eu-west-2/s3/aws4_request");
  assert.equal(q("X-Amz-Date"), "20260909T120000Z");
  assert.equal(q("X-Amz-Expires"), "900");
  assert.equal(q("X-Amz-SignedHeaders"), "host");
  assert.match(q("X-Amz-Signature"), /^[0-9a-f]{64}$/);
});

test("the signature verifies against an independently recomputed one", () => {
  /*
   * Recomputed here from the specification rather than from the implementation,
   * so this fails if `presignS3Url` changes what it signs. Comparing the module
   * against itself would pass no matter what it signed.
   */
  const { url, q } = parse(presign().url);
  const query = [...url.searchParams.entries()].filter(([name]) => name !== "X-Amz-Signature");
  const canonicalRequest = [
    "PUT",
    "/storage/v1/s3/job-media/org_1/photo.jpg",
    canonicalQueryString(query),
    "host:example.supabase.co\n",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20260909T120000Z",
    "20260909/eu-west-2/s3/aws4_request",
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const expected = createHmac(
    "sha256",
    sigv4SigningKey(CREDS.secretAccessKey, "20260909", "eu-west-2", "s3"),
  ).update(stringToSign).digest("hex");

  assert.equal(q("X-Amz-Signature"), expected);
});

test("the payload is unsigned, because the signer never sees the bytes", () => {
  /*
   * The whole point. If this ever signed a real payload hash, the server would
   * have to receive the file to sign for it — which is the 4.5 MB relay this
   * replaces.
   */
  const a = presign().url;
  const b = presign().url;
  assert.equal(a, b, "signing must not depend on any payload");
});

test("only host is signed, so a client may set its own headers", () => {
  // Every signed header becomes one the uploader must reproduce byte-identically.
  // A browser that adds Content-Type would break a signature that covered it.
  assert.equal(parse(presign().url).q("X-Amz-SignedHeaders"), "host");
});

test("X-Amz-Signature is appended after signing, never signed itself", () => {
  const { url } = parse(presign().url);
  const raw = url.search.slice(1);
  assert.ok(
    raw.endsWith(`&X-Amz-Signature=${url.searchParams.get("X-Amz-Signature")}`),
    "the signature must be the last parameter and outside the canonical query",
  );
});

test("a different key produces a different signature", () => {
  // The signature is scoped to one object. It is not a bucket-wide credential.
  const one = parse(presign().url).q("X-Amz-Signature");
  const two = parse(
    presign({ canonicalPath: "/storage/v1/s3/job-media/org_1/other.jpg" }).url,
  ).q("X-Amz-Signature");
  assert.notEqual(one, two);
});

test("a different method produces a different signature", () => {
  // A URL signed for reading must not also permit writing.
  const put = parse(presign().url).q("X-Amz-Signature");
  const get = parse(presign({ method: "GET" }).url).q("X-Amz-Signature");
  assert.notEqual(put, get);
});

test("expiry is reported as an absolute instant the caller can check", () => {
  const { expiresAt } = presign({ expiresInSeconds: 600 });
  assert.equal(expiresAt, new Date(AT.getTime() + 600_000).toISOString());
});

test("a space in the key survives canonicalisation", () => {
  // AWS encoding, not encodeURIComponent: one character encoded differently
  // from how S3 does it is a SignatureDoesNotMatch on exactly one filename.
  const { url } = parse(
    presign({ canonicalPath: "/storage/v1/s3/job-media/org_1/a%20b.jpg" }).url,
  );
  assert.equal(url.pathname, "/storage/v1/s3/job-media/org_1/a%20b.jpg");
});

test("the bucket exposes presign for both verbs", () => {
  const bucket = createS3Bucket({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    region: "eu-west-2",
    ...CREDS,
    fetch: async () => new Response(null, { status: 200 }),
    now: () => AT,
  });
  const put = bucket.presign("PUT", "org_1/photo.jpg", 900);
  const get = bucket.presign("GET", "org_1/photo.jpg", 900);
  assert.match(put.url, /^https:\/\/example\.supabase\.co\/storage\/v1\/s3\/job-media\/org_1\/photo\.jpg\?/);
  assert.notEqual(
    new URL(put.url).searchParams.get("X-Amz-Signature"),
    new URL(get.url).searchParams.get("X-Amz-Signature"),
  );
  assert.equal(put.expiresAt, new Date(AT.getTime() + 900_000).toISOString());
});

test("presign signs exactly the path put() would store at", async () => {
  /*
   * The invariant that actually matters, and the one a hand-rolled encoder gets
   * wrong. If the signed path and the stored path disagree by a single
   * character the upload either 403s or lands somewhere nobody looks for it,
   * and both failures point at the wrong layer.
   *
   * Checked against `put`'s own URL rather than against a hardcoded string, so
   * the two cannot drift apart later. The keys are the awkward ones: a space, a
   * plus (which is a space in form encoding but not in a path), and a character
   * outside ASCII.
   */
  for (const key of ["org_1/a b.jpg", "org_1/a+b.jpg", "org_1/café.pdf", "org_1/100%.pdf"]) {
    let seen = null;
    const bucket = createS3Bucket({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      region: "eu-west-2",
      ...CREDS,
      fetch: async (url) => {
        seen = new URL(String(url)).pathname;
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      },
      now: () => AT,
    });
    await bucket.put(key, new Uint8Array([1]).buffer);
    const signed = new URL(bucket.presign("PUT", key, 900).url).pathname;
    assert.equal(signed, seen, `presign and put disagree on the path for ${key}`);
  }
});
