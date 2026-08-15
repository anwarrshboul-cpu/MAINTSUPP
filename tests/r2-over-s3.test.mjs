import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  awsUriEncode,
  canonicalQueryString,
  createS3Bucket,
  createS3BucketFromEnv,
  decodeCustomMetadata,
  encodeCustomMetadata,
  encodeHttpMetadata,
  META_NAMES_HEADER,
  sigv4SigningKey,
  signS3Request,
  xmlTag,
} from "../db/r2-over-s3.ts";

/**
 * The S3-backed R2 bucket, tested without an S3.
 *
 * S3 access keys for the Supabase project had not been issued when this was
 * written, so there is no integration test and cannot be one. That is not a
 * reason to ship unverified signing code — it is a reason to test the two
 * things that are testable offline and that account for almost every way this
 * can be wrong in production:
 *
 *   1. THE SIGNATURE. Checked against AWS's own published SigV4 test vectors,
 *      the ones in "Examples: Signature Calculations" and "Deriving the signing
 *      key". A signing bug is invisible until a deployment, where it presents
 *      as every single request 403ing with SignatureDoesNotMatch and no clue
 *      which of the six canonicalisation rules was broken. The canonical
 *      request and the string-to-sign are asserted separately from the final
 *      signature, so a failure says WHICH stage is wrong.
 *
 *   2. THE REQUEST. Every operation is driven through an injected `fetch` that
 *      records what was asked for and answers with a canned S3 response. This
 *      pins the method, path, query and headers of put/head/get/ranged get/
 *      delete/list and the whole four-call multipart dance — and, most
 *      importantly, that custom metadata survives the round trip with its
 *      CASE and its BYTES intact, which is the one failure that would let every
 *      large upload complete and then be deleted as invalid.
 *
 * What is NOT covered here, and only a real bucket can cover: whether Supabase
 * accepts these requests at all.
 */

const CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_EXAMPLE_DATE = new Date("2013-05-24T00:00:00.000Z");
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

/* -------------------------------------------------------------------------- */
/* 1. Known-answer vectors                                                     */
/* -------------------------------------------------------------------------- */

test("the derived signing key is the four-stage chain, and every stage matters", () => {
  /*
   * There is deliberately no hardcoded expected key here.
   *
   * The four vectors below pin it far better than a standalone constant could:
   * each one runs `sigv4SigningKey` and then compares the FINAL signature
   * against a published value, so a wrong derivation cannot pass any of them.
   * A separately-quoted key constant would only be as trustworthy as whoever
   * typed it, and a mistyped one is worse than none — it fails a correct
   * implementation and invites someone to "fix" the code to match.
   *
   * What is worth asserting here is that each stage is actually fed in, since a
   * dropped stage (a `region` that never reaches the HMAC chain, say) produces
   * a key that is perfectly stable and perfectly wrong, and vectors that all
   * share one region and one service would not notice.
   */
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const base = sigv4SigningKey(secret, "20130524", "us-east-1", "s3").toString("hex");
  assert.equal(base.length, 64);
  for (const variant of [
    sigv4SigningKey(`${secret}x`, "20130524", "us-east-1", "s3"),
    sigv4SigningKey(secret, "20130525", "us-east-1", "s3"),
    sigv4SigningKey(secret, "20130524", "eu-west-2", "s3"),
    sigv4SigningKey(secret, "20130524", "us-east-1", "iam"),
  ]) {
    assert.notEqual(variant.toString("hex"), base);
  }
  // The default is s3, so `region` is the only thing the bucket has to get
  // right — and eu-west-2 versus us-east-1 is a silent SignatureDoesNotMatch.
  assert.equal(sigv4SigningKey(secret, "20130524", "eu-west-2").toString("hex"),
    sigv4SigningKey(secret, "20130524", "eu-west-2", "s3").toString("hex"));
});

test("SigV4 vector 1: GET Object with a Range header", () => {
  const signed = signS3Request({
    method: "GET",
    canonicalPath: "/test.txt",
    host: "examplebucket.s3.amazonaws.com",
    query: [],
    headers: { range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    now: AWS_EXAMPLE_DATE,
    ...CREDS,
  });

  assert.equal(
    signed.canonicalRequest,
    [
      "GET",
      "/test.txt",
      "",
      "host:examplebucket.s3.amazonaws.com",
      "range:bytes=0-9",
      `x-amz-content-sha256:${EMPTY_SHA256}`,
      "x-amz-date:20130524T000000Z",
      "",
      "host;range;x-amz-content-sha256;x-amz-date",
      EMPTY_SHA256,
    ].join("\n"),
  );
  assert.equal(
    sha256Hex(signed.canonicalRequest),
    "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  );
  assert.equal(
    signed.signature,
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.match(
    signed.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb/,
  );
});

test("SigV4 vector 2: PUT Object with a body and a pre-encoded key", () => {
  // `/test%24file.text` — the `$` is encoded in the canonical URI. This is the
  // vector that catches an `encodeURIComponent` slipping in for awsUriEncode.
  const signed = signS3Request({
    method: "PUT",
    canonicalPath: "/test%24file.text",
    host: "examplebucket.s3.amazonaws.com",
    query: [],
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash: sha256Hex("Welcome to Amazon S3."),
    region: "us-east-1",
    now: AWS_EXAMPLE_DATE,
    ...CREDS,
  });
  assert.equal(
    signed.signature,
    "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});

test("SigV4 vector 4: GET with a valueless query parameter (?lifecycle)", () => {
  // `?lifecycle` MUST canonicalise to `lifecycle=`. This is the same shape as
  // the `?uploads` that starts every multipart upload, so getting it wrong here
  // means no video ever uploads.
  const signed = signS3Request({
    method: "GET",
    canonicalPath: "/",
    host: "examplebucket.s3.amazonaws.com",
    query: [["lifecycle", ""]],
    headers: {},
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    now: AWS_EXAMPLE_DATE,
    ...CREDS,
  });
  assert.equal(signed.canonicalRequest.split("\n")[2], "lifecycle=");
  assert.equal(
    signed.signature,
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
});

test("SigV4 vector 5: GET with two query parameters, sorted", () => {
  // Deliberately passed out of order, because the canonical form is sorted and
  // the caller's order must not matter.
  const signed = signS3Request({
    method: "GET",
    canonicalPath: "/",
    host: "examplebucket.s3.amazonaws.com",
    query: [
      ["prefix", "J"],
      ["max-keys", "2"],
    ],
    headers: {},
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    now: AWS_EXAMPLE_DATE,
    ...CREDS,
  });
  assert.equal(signed.canonicalRequest.split("\n")[2], "max-keys=2&prefix=J");
  assert.equal(
    signed.signature,
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

test("awsUriEncode differs from encodeURIComponent exactly where it must", () => {
  // The five characters encodeURIComponent leaves alone and SigV4 does not.
  assert.equal(awsUriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(awsUriEncode(" "), "%20");
  assert.equal(awsUriEncode("a/b"), "a%2Fb");
  assert.equal(awsUriEncode("a/b", false), "a/b");
  assert.equal(awsUriEncode("-_.~"), "-_.~");
  // Uppercase hex, and UTF-8 multi-byte encoded byte by byte.
  assert.equal(awsUriEncode("ç"), "%C3%A7");
  assert.equal(awsUriEncode("%"), "%25");
});

test("canonicalQueryString sorts by encoded name and writes empty values", () => {
  assert.equal(
    canonicalQueryString([
      ["uploadId", "abc"],
      ["partNumber", "7"],
    ]),
    "partNumber=7&uploadId=abc",
  );
  assert.equal(canonicalQueryString([["uploads", ""]]), "uploads=");
  // A space is %20 here and `+` through URLSearchParams — the reason this
  // function exists at all.
  assert.equal(canonicalQueryString([["prefix", "a b"]]), "prefix=a%20b");
});

/* -------------------------------------------------------------------------- */
/* 2. Metadata encoding                                                        */
/* -------------------------------------------------------------------------- */

/** Everything the multipart route attaches, with a filename that hurts. */
const APP_METADATA = {
  requestId: "req_ee4e6a231a324576b3846f2541bd9e11",
  organisationId: "org_000000000000000000000001",
  kind: "general",
  boardColumnId: "seed-org_000000000000000000000001-maintenance-issuePictures",
  fileId: "5e18f600-c2b4-407e-b1fa-08dedd450c69",
  originalName: "Façade survey, final (100%) — v2.pdf",
  contentType: "application/pdf",
  byteSize: "6403444",
  uploadedBy: "owner@maintsupp.com",
};

test("custom metadata round-trips with its case and its bytes intact", () => {
  const headers = encodeCustomMetadata(APP_METADATA);

  // Every header name is lower-case, because that is what S3 will hand back
  // whatever we send. The name table is what restores the camelCase.
  for (const name of Object.keys(headers)) {
    assert.equal(name, name.toLowerCase());
  }
  assert.equal(
    headers[META_NAMES_HEADER],
    "requestId,organisationId,kind,boardColumnId,fileId,originalName,contentType,byteSize,uploadedBy",
  );
  // Values are pure ASCII on the wire — undici throws on anything else.
  for (const value of Object.values(headers)) {
    assert.match(value, /^[\x21-\x7e]*$/, `not header-safe: ${value}`);
  }

  // Simulate S3: lower-case every header name on the way back.
  const returned = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    returned.set(name.toLowerCase(), value);
  }
  assert.deepEqual(decodeCustomMetadata(returned), APP_METADATA);
});

test("the five fields completeMetadata() checks survive verbatim", () => {
  // Copied from `completeMetadata()` in app/api/files/multipart/route.ts, which
  // deletes the just-uploaded object unless all five match.
  const returned = new Headers();
  for (const [name, value] of Object.entries(encodeCustomMetadata(APP_METADATA))) {
    returned.set(name.toLowerCase(), value);
  }
  const metadata = decodeCustomMetadata(returned);
  assert.equal(metadata.requestId, APP_METADATA.requestId);
  assert.equal(metadata.kind, APP_METADATA.kind);
  assert.equal(metadata.boardColumnId || null, APP_METADATA.boardColumnId);
  assert.ok(metadata.fileId);
  assert.ok(metadata.originalName);
  assert.equal(metadata.originalName, "Façade survey, final (100%) — v2.pdf");
  assert.equal(Number(metadata.byteSize), 6403444);
});

test("values that would break a header value survive", () => {
  const nasty = {
    leading: "  two spaces in front",
    trailing: "and behind  ",
    commas: "a,b,c",
    newline: "line\nbreak",
    percent: "100% of 50%",
    emoji: "📸 photo.jpg",
    empty: "",
  };
  const headers = encodeCustomMetadata(nasty);
  const returned = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    returned.set(name.toLowerCase(), value);
  }
  assert.deepEqual(decodeCustomMetadata(returned), nasty);
});

test("names that cannot be stored are refused rather than mangled", () => {
  assert.throws(() => encodeCustomMetadata({ "original name": "x" }), /HTTP token/);
  assert.throws(() => encodeCustomMetadata({ "r2-names": "x" }), /reserved/);
  assert.throws(() => encodeCustomMetadata({ "R2-Names": "x" }), /reserved/);
  assert.throws(
    () => encodeCustomMetadata({ fileId: "a", FileId: "b" }),
    /case-variant/,
  );
});

test("metadata from an object this module did not write is read, not dropped", () => {
  const foreign = new Headers();
  foreign.set("x-amz-meta-originalname", "raw value");
  foreign.set("content-type", "image/jpeg");
  // No name table, so no decoding: the value comes back exactly as stored, under
  // the only name S3 knows for it.
  assert.deepEqual(decodeCustomMetadata(foreign), { originalname: "raw value" });
});

test("httpMetadata maps onto the two headers the app sets", () => {
  assert.deepEqual(
    encodeHttpMetadata({
      contentType: "application/pdf",
      contentDisposition: 'inline; filename="a.pdf"',
      cacheExpiry: new Date(0),
    }),
    {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="a.pdf"',
    },
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Request construction                                                     */
/* -------------------------------------------------------------------------- */

const ENDPOINT = "https://wghfhtdzxttfhofuljyy.supabase.co/storage/v1/s3";
const BUCKET = "job-media";
const KEY =
  "org_000000000000000000000001/maintenance/req_1/general/abc-IMG 0559 (1).mov";

/** A `fetch` that records and answers from a script. */
function recorder(script = []) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const next = script[index++] ?? { status: 200 };
    return new Response(next.body ?? null, {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return { impl, calls };
}

const bucketWith = (script, extra = {}) => {
  const { impl, calls } = recorder(script);
  return {
    calls,
    bucket: createS3Bucket({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      region: "eu-west-2",
      ...CREDS,
      fetch: impl,
      now: () => AWS_EXAMPLE_DATE,
      ...extra,
    }),
  };
};

test("put sends PUT to the path-style URL with the metadata headers", async () => {
  const { bucket, calls } = bucketWith([
    { status: 200, headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' } },
  ]);
  const bytes = new Uint8Array([1, 2, 3]);
  const object = await bucket.put(KEY, bytes.buffer, {
    httpMetadata: { contentType: "video/quicktime", contentDisposition: 'inline; filename="a.mov"' },
    customMetadata: { fileId: "abc", originalName: "IMG 0559 (1).mov" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  // Path style: the bucket is a path segment under /storage/v1/s3, the key is
  // AWS-encoded with its slashes left alone, and the space and parentheses in
  // the filename are encoded the SigV4 way.
  assert.equal(
    calls[0].url,
    "https://wghfhtdzxttfhofuljyy.supabase.co/storage/v1/s3/job-media/" +
      "org_000000000000000000000001/maintenance/req_1/general/abc-IMG%200559%20%281%29.mov",
  );
  assert.equal(calls[0].headers["content-type"], "video/quicktime");
  assert.equal(calls[0].headers["content-disposition"], 'inline; filename="a.mov"');
  assert.equal(calls[0].headers["x-amz-meta-fileid"], "abc");
  assert.equal(
    calls[0].headers["x-amz-meta-originalname"],
    "IMG%200559%20%281%29.mov",
  );
  assert.equal(calls[0].headers[META_NAMES_HEADER], "fileId,originalName");
  // The payload hash is the real SHA-256 of the body, not UNSIGNED-PAYLOAD.
  assert.equal(
    calls[0].headers["x-amz-content-sha256"],
    sha256Hex(Buffer.from([1, 2, 3])),
  );
  assert.match(calls[0].headers.authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/eu-west-2\/s3\/aws4_request/);
  // Every header that was sent is covered by the signature.
  const signedHeaders = /SignedHeaders=([^,]+),/
    .exec(calls[0].headers.authorization)[1]
    .split(";");
  for (const name of Object.keys(calls[0].headers)) {
    if (name === "authorization") continue;
    assert.ok(signedHeaders.includes(name), `${name} was sent but not signed`);
  }
  assert.equal(object.size, 3);
  assert.equal(object.etag, "d41d8cd98f00b204e9800998ecf8427e");
});

test("head returns null for a missing key and an object for a present one", async () => {
  const missing = bucketWith([{ status: 404 }]);
  assert.equal(await missing.bucket.head(`${KEY}.thumb`), null);
  assert.equal(missing.calls[0].method, "HEAD");
  assert.match(missing.calls[0].url, /\.thumb$/);

  const present = bucketWith([
    {
      status: 200,
      headers: {
        etag: '"abc123-2"',
        "content-length": "6403444",
        "content-type": "application/pdf",
        "last-modified": "Fri, 24 May 2013 00:00:00 GMT",
        ...Object.fromEntries(
          Object.entries(encodeCustomMetadata(APP_METADATA)).map(([n, v]) => [
            n.toLowerCase(),
            v,
          ]),
        ),
      },
    },
  ]);
  const object = await present.bucket.head(KEY);
  assert.equal(object.size, 6403444);
  assert.equal(object.etag, "abc123-2");
  assert.equal(object.httpEtag, '"abc123-2"');
  // A multipart etag is not an MD5 and must not be reported as a checksum.
  assert.deepEqual(object.checksums, {});
  assert.deepEqual(object.customMetadata, APP_METADATA);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  assert.equal(headers.get("Content-Type"), "application/pdf");
});

test("a ranged get sends Range and reports the FULL size with the served span", async () => {
  const { bucket, calls } = bucketWith([
    {
      status: 206,
      body: "0123456789",
      headers: {
        etag: '"e"',
        "content-length": "10",
        "content-range": "bytes 100-109/36139705",
      },
    },
  ]);
  const object = await bucket.get(KEY, { range: { offset: 100, length: 10 } });
  assert.equal(calls[0].headers.range, "bytes=100-109");
  // `GET /api/files/[id]` sets Content-Length from `range?.length ?? size`, so
  // these two must be the full object and the served span respectively.
  assert.equal(object.size, 36139705);
  assert.deepEqual(object.range, { offset: 100, length: 10 });
  assert.equal(await object.text(), "0123456789");
});

test("a suffix range and an unsatisfiable range behave as R2 does", async () => {
  const suffix = bucketWith([
    {
      status: 206,
      body: "89",
      headers: { "content-length": "2", "content-range": "bytes 8-9/10" },
    },
  ]);
  await suffix.bucket.get(KEY, { range: { suffix: 2 } });
  assert.equal(suffix.calls[0].headers.range, "bytes=-2");

  // 416 is "that range does not exist", which R2 reports as a null get.
  const bad = bucketWith([{ status: 416 }]);
  assert.equal(await bad.bucket.get(KEY, { range: { offset: 99999 } }), null);

  // A zero-length range is an empty body, not a request: there is no HTTP Range
  // that expresses it. It heads the key instead.
  const zero = bucketWith([
    { status: 200, headers: { "content-length": "5", etag: '"e"' } },
  ]);
  const object = await zero.bucket.get(KEY, { range: { offset: 5, length: 0 } });
  assert.equal(zero.calls[0].method, "HEAD");
  assert.equal(object.size, 5);
  assert.deepEqual(object.range, { offset: 0, length: 0 });
  assert.equal(await object.text(), "");
});

test("delete takes one key or an array, and an already-gone key is a success", async () => {
  const { bucket, calls } = bucketWith([
    { status: 204 },
    { status: 404 },
    { status: 204 },
  ]);
  await bucket.delete([KEY, `${KEY}.thumb`, "org_1/other"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map((c) => c.method)), new Set(["DELETE"]));
  // Sequential objects, not a DeleteObjects batch — see the comment on remove().
  for (const call of calls) assert.ok(!call.url.includes("?delete"));

  const failing = bucketWith([{ status: 403, body: "<Error>expired</Error>" }]);
  await assert.rejects(() => failing.bucket.delete(KEY), /S3 DELETE 403/);
});

test("list issues ListObjectsV2 and parses the XML", async () => {
  const { bucket, calls } = bucketWith([
    {
      status: 200,
      body: `<?xml version="1.0"?><ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>tok/en+1</NextContinuationToken>
        <Contents><Key>org_1/a &amp; b.jpg</Key><Size>1234</Size><ETag>&quot;abc&quot;</ETag><LastModified>2013-05-24T00:00:00.000Z</LastModified></Contents>
        <Contents><Key>org_1/c.jpg</Key><Size>7</Size><ETag>&quot;def&quot;</ETag><LastModified>2013-05-24T00:00:00.000Z</LastModified></Contents>
      </ListBucketResult>`,
    },
  ]);
  const page = await bucket.list({ prefix: "org_1/", limit: 2 });
  assert.match(calls[0].url, /\/job-media\?list-type=2&max-keys=2&prefix=org_1%2F$/);
  assert.equal(page.objects.length, 2);
  assert.equal(page.objects[0].key, "org_1/a & b.jpg");
  assert.equal(page.objects[0].size, 1234);
  assert.equal(page.truncated, true);
  assert.equal(page.cursor, "tok/en+1");
});

/* -------------------------------------------------------------------------- */
/* 4. Multipart — the metadata round trip that matters                         */
/* -------------------------------------------------------------------------- */

test("createMultipartUpload attaches the metadata to the CREATE, where S3 keeps it", async () => {
  const { bucket, calls } = bucketWith([
    {
      status: 200,
      body: "<InitiateMultipartUploadResult><UploadId>UPLOAD/ID+1==</UploadId></InitiateMultipartUploadResult>",
    },
  ]);
  const upload = await bucket.createMultipartUpload(KEY, {
    httpMetadata: {
      contentType: "video/quicktime",
      contentDisposition: 'inline; filename="IMG_0559.mov"',
    },
    customMetadata: APP_METADATA,
  });

  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\?uploads=$/);
  // THE assertion of this file. In S3 the metadata is attached here and nowhere
  // else; `complete()` cannot add it and `resumeMultipartUpload()` is never told
  // it. If these headers are absent or lower-cased, every large upload finishes
  // and is then deleted by completeMetadata() as invalid.
  assert.equal(calls[0].headers["content-type"], "video/quicktime");
  assert.equal(
    calls[0].headers[META_NAMES_HEADER],
    "requestId,organisationId,kind,boardColumnId,fileId,originalName,contentType,byteSize,uploadedBy",
  );
  assert.equal(calls[0].headers["x-amz-meta-requestid"], APP_METADATA.requestId);
  assert.equal(
    calls[0].headers["x-amz-meta-originalname"],
    awsUriEncode(APP_METADATA.originalName),
  );
  // The route reads these two off the result and sends them to the browser.
  assert.equal(upload.key, KEY);
  assert.equal(upload.uploadId, "UPLOAD/ID+1==");
});

test("resumeMultipartUpload is synchronous, as the route calls it", () => {
  const { bucket } = bucketWith([]);
  // No `await` — `app/api/files/multipart/route.ts` does exactly this and then
  // calls .abort()/.complete()/.uploadPart() on the result.
  const handle = bucket.resumeMultipartUpload(KEY, "UPLOAD/ID+1==");
  assert.equal(typeof handle.uploadPart, "function");
  assert.equal(handle.uploadId, "UPLOAD/ID+1==");
  assert.throws(() => bucket.resumeMultipartUpload(KEY, "bad\nid"), /Invalid multipart upload id/);
});

test("uploadPart puts to ?partNumber&uploadId and returns an unquoted etag", async () => {
  const { bucket, calls } = bucketWith([
    { status: 200, headers: { etag: '"9b2cf5d3ba5f1e3e0e6f5a0f3f2b1c0a"' } },
  ]);
  const handle = bucket.resumeMultipartUpload(KEY, "UPLOAD/ID+1==");
  const part = await handle.uploadPart(7, new Uint8Array([9, 9]));

  assert.equal(calls[0].method, "PUT");
  // Sorted, AWS-encoded: the `/`, `+` and `=` in the upload id all have to be
  // escaped identically in the URL and in the signature.
  assert.match(calls[0].url, /\?partNumber=7&uploadId=UPLOAD%2FID%2B1%3D%3D$/);
  // Exactly `{partNumber, etag}` like R2UploadedPart — the route JSON-encodes
  // this straight back to the browser, which holds it until complete.
  assert.deepEqual(part, {
    partNumber: 7,
    etag: "9b2cf5d3ba5f1e3e0e6f5a0f3f2b1c0a",
  });
});

test("complete sends sorted parts as XML and HEADs for the true size", async () => {
  const metadataHeaders = Object.fromEntries(
    Object.entries(encodeCustomMetadata(APP_METADATA)).map(([n, v]) => [
      n.toLowerCase(),
      v,
    ]),
  );
  const { bucket, calls } = bucketWith([
    {
      status: 200,
      body: "<CompleteMultipartUploadResult><ETag>&quot;abc-2&quot;</ETag></CompleteMultipartUploadResult>",
    },
    {
      status: 200,
      headers: {
        etag: '"abc-2"',
        "content-length": "6403444",
        "content-type": "application/pdf",
        ...metadataHeaders,
      },
    },
  ]);
  const handle = bucket.resumeMultipartUpload(KEY, "UPLOAD/ID+1==");
  // Deliberately out of order and with quoted etags, which is how they come
  // back from the browser.
  const object = await handle.complete([
    { partNumber: 2, etag: '"bbb"' },
    { partNumber: 1, etag: "aaa" },
  ]);

  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\?uploadId=UPLOAD%2FID%2B1%3D%3D$/);
  assert.equal(
    Buffer.from(calls[0].body).toString("utf8"),
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      "<Part><PartNumber>1</PartNumber><ETag>&quot;aaa&quot;</ETag></Part>" +
      "<Part><PartNumber>2</PartNumber><ETag>&quot;bbb&quot;</ETag></Part>" +
      "</CompleteMultipartUpload>",
  );

  // The HEAD is not optional: CompleteMultipartUpload's response carries no
  // size, and the route compares `byteSize !== completed.head.size`.
  assert.equal(calls[1].method, "HEAD");
  assert.equal(object.size, 6403444);
  assert.equal(Number(APP_METADATA.byteSize), object.size);
  assert.deepEqual(object.customMetadata, APP_METADATA);
});

test("complete refuses S3's 200-with-an-error-body", async () => {
  const { bucket } = bucketWith([
    {
      status: 200,
      body: '<?xml version="1.0"?><Error><Code>InternalError</Code></Error>',
    },
  ]);
  const handle = bucket.resumeMultipartUpload(KEY, "u1");
  // A 200 whose body is an Error is how CompleteMultipartUpload reports a
  // failure it discovered after the headers were already sent. Trusting
  // response.ok would record an attachment row for an object that is not there.
  await assert.rejects(
    () => handle.complete([{ partNumber: 1, etag: "a" }]),
    /returned an error body/,
  );
});

test("abort deletes the session and tolerates one that is already gone", async () => {
  const { bucket, calls } = bucketWith([{ status: 404 }]);
  await bucket.resumeMultipartUpload(KEY, "u1").abort();
  assert.equal(calls[0].method, "DELETE");
  assert.match(calls[0].url, /\?uploadId=u1$/);
});

/* -------------------------------------------------------------------------- */
/* 5. Guards                                                                   */
/* -------------------------------------------------------------------------- */

test("a key whose path the URL parser would rewrite is refused, not mis-signed", async () => {
  const { bucket } = bucketWith([{ status: 200 }]);
  // `validUploadKey` in the multipart route checks a prefix and a length, so a
  // `..` segment reaches storage. Encoded it survives awsUriEncode and is then
  // collapsed by the URL parser, which would send the request to a different
  // path than the one that was signed.
  await assert.rejects(
    () => bucket.head("org_1/maintenance/../../secret.jpg"),
    /URL normalisation/,
  );
});

test("createS3BucketFromEnv is all four variables or nothing", () => {
  assert.equal(createS3BucketFromEnv({}), null);
  assert.equal(
    createS3BucketFromEnv({
      S3_ENDPOINT: ENDPOINT,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: "a",
    }),
    null,
  );
  const bucket = createS3BucketFromEnv({
    S3_ENDPOINT: ENDPOINT,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "a",
    S3_SECRET_ACCESS_KEY: "b",
  });
  // eu-west-2 by default, because a wrong region on Supabase is not a routing
  // error, it is SignatureDoesNotMatch on every single request.
  assert.equal(bucket.describe, `${ENDPOINT}/${BUCKET} (eu-west-2)`);
});

test("xmlTag unescapes entities so a key with an ampersand survives", () => {
  assert.equal(xmlTag("<Key>a &amp; b &lt;c&gt;</Key>", "Key"), "a & b <c>");
  assert.equal(xmlTag("<Key></Key>", "UploadId"), null);
});
