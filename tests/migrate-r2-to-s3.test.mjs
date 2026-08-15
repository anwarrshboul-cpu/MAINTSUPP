import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import { chunked } from "../scripts/migrate-r2-to-s3.mjs";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");

/**
 * The migration planner, against a Miniflare state built for the purpose.
 *
 * The real `.wrangler/state` is 3.3 GB and is not in the repository, so a test
 * that read it would pass on one laptop and be skipped everywhere else. This
 * builds the same two structures — the `_mf_objects` index and the blob
 * directory — small enough to assert on exactly, including the case that
 * matters most: an object whose `blob_id` is NULL because it was assembled from
 * multipart parts. Reading the schema off the real state and reproducing it
 * here is what makes the fixture worth anything.
 */

const SCHEMA = `
CREATE TABLE _mf_objects (
  key TEXT PRIMARY KEY, blob_id TEXT, version TEXT NOT NULL, size INTEGER NOT NULL,
  etag TEXT NOT NULL, uploaded INTEGER NOT NULL, checksums TEXT NOT NULL,
  http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL
);
CREATE TABLE _mf_multipart_uploads (
  upload_id TEXT PRIMARY KEY, key TEXT NOT NULL, http_metadata TEXT NOT NULL,
  custom_metadata TEXT NOT NULL, state TINYINT DEFAULT 0 NOT NULL
);
CREATE TABLE _mf_multipart_parts (
  upload_id TEXT NOT NULL, part_number INTEGER NOT NULL, blob_id TEXT NOT NULL,
  size INTEGER NOT NULL, etag TEXT NOT NULL, checksum_md5 TEXT NOT NULL,
  object_key TEXT, PRIMARY KEY (upload_id, part_number)
);
`;

async function buildState() {
  const root = await mkdtemp(path.join(tmpdir(), "r2-migrate-"));
  const stateDir = path.join(root, "r2");
  const indexDir = path.join(stateDir, "miniflare-R2BucketObject");
  const blobsDir = path.join(stateDir, "site-creator-r2", "blobs");
  await mkdir(indexDir, { recursive: true });
  await mkdir(blobsDir, { recursive: true });

  const db = new DatabaseSync(path.join(indexDir, `${"a".repeat(64)}.sqlite`));
  db.exec(SCHEMA);
  const putObject = db.prepare(
    "insert into _mf_objects values (?,?,?,?,?,?,?,?,?)",
  );
  const putUpload = db.prepare("insert into _mf_multipart_uploads values (?,?,?,?,?)");
  const putPart = db.prepare("insert into _mf_multipart_parts values (?,?,?,?,?,?,?)");

  const blob = async (name, bytes) => {
    await writeFile(path.join(blobsDir, name), bytes);
    return bytes.length;
  };

  // 1. An ordinary single-blob object with the metadata the portal writes.
  const one = randomBytes(1024);
  await blob("blob-one", one);
  putObject.run(
    "org_1/maintenance/req_1/general/a.jpg",
    "blob-one",
    "v1",
    one.length,
    "etag-one",
    1,
    "{}",
    JSON.stringify({ contentType: "image/jpeg" }),
    JSON.stringify({ requestId: "req_1", originalName: "a.jpg" }),
  );

  // 2. Its thumbnail.
  const thumb = randomBytes(64);
  await blob("blob-thumb", thumb);
  putObject.run(
    "org_1/maintenance/req_1/general/a.jpg.thumb",
    "blob-thumb",
    "v1",
    thumb.length,
    "etag-thumb",
    1,
    "{}",
    JSON.stringify({ contentType: "image/webp" }),
    "{}",
  );

  // 3. A COMPLETED multipart object: blob_id NULL, bytes in the part rows.
  //    This is the shape that holds 84% of the real corpus and that a migration
  //    reading only `blob_id` would silently drop.
  const partA = randomBytes(3000);
  const partB = randomBytes(1500);
  await blob("blob-part-a", partA);
  await blob("blob-part-b", partB);
  putObject.run(
    "org_1/maintenance/req_2/general/video.mov",
    null,
    "v1",
    partA.length + partB.length,
    "etag-multi-2",
    1,
    "{}",
    JSON.stringify({ contentType: "video/quicktime" }),
    JSON.stringify({ requestId: "req_2", originalName: "video.mov" }),
  );
  putUpload.run("upload-live", "org_1/maintenance/req_2/general/video.mov", "{}", "{}", 1);
  putPart.run("upload-live", 1, "blob-part-a", partA.length, "e1", "m1",
    "org_1/maintenance/req_2/general/video.mov");
  putPart.run("upload-live", 2, "blob-part-b", partB.length, "e2", "m2",
    "org_1/maintenance/req_2/general/video.mov");

  // 4. A genuinely abandoned in-flight session: state 0, no object row behind
  //    it. It must not be counted or transferred.
  const stray = randomBytes(9999);
  await blob("blob-stray", stray);
  putUpload.run("upload-dead", "org_1/maintenance/req_3/general/ghost.mov", "{}", "{}", 0);
  putPart.run("upload-dead", 1, "blob-stray", stray.length, "e3", "m3", null);

  // 5. An index row whose blob is not on disk.
  putObject.run("_probe/gone.pdf", "blob-missing", "v1", 42, "etag-gone", 1, "{}", "{}", "{}");

  db.close();
  return {
    root,
    stateDir,
    // Three readable objects: the jpeg, its thumbnail, and the multipart video.
    // `_probe/gone.pdf` is in the index and not on disk, so it is neither.
    liveBytes: one.length + thumb.length + partA.length + partB.length,
    liveObjects: 3,
    thumbBytes: thumb.length,
  };
}

const dryRun = async (stateDir, extra = []) => {
  const { stdout } = await run(
    process.execPath,
    ["scripts/migrate-r2-to-s3.mjs", "--dry-run", "--state-dir", stateDir, ...extra],
    { cwd: REPO },
  );
  return stdout;
};

test("the dry run counts completed multipart objects and ignores abandoned sessions", async () => {
  const state = await buildState();
  try {
    const out = await dryRun(state.stateDir);

    assert.match(out, /DRY RUN — nothing was uploaded and no credentials were used/);
    assert.match(out, new RegExp(`WOULD TRANSFER +${state.liveObjects} objects`));
    assert.match(out, new RegExp(`WOULD TRANSFER +${state.liveBytes} bytes`));
    // The 9,999-byte abandoned session is on disk and must be nowhere in the
    // totals — it is the difference between migrating the bucket and migrating
    // the bucket plus everybody's cancelled uploads.
    assert.ok(!out.includes("9999"));
    assert.ok(!out.includes("ghost.mov"));
    // The multipart-assembled object IS counted, and its bytes with it.
    assert.match(out, /scanned in index +4/);
    // The hole is reported by name rather than crashing the run.
    assert.match(out, /unreadable, skipped +1/);
    assert.match(out, /UNREADABLE +_probe\/gone\.pdf/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("--skip-thumbs removes exactly the derivatives and their bytes", async () => {
  const state = await buildState();
  try {
    const out = await dryRun(state.stateDir, ["--skip-thumbs"]);
    assert.match(out, /SKIPPED \(--skip-thumbs\)/);
    assert.match(out, new RegExp(`WOULD TRANSFER +${state.liveObjects - 1} objects`));
    assert.match(
      out,
      new RegExp(`WOULD TRANSFER +${state.liveBytes - state.thumbBytes} bytes`),
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("--prefix narrows the plan", async () => {
  const state = await buildState();
  try {
    const out = await dryRun(state.stateDir, ["--prefix", "org_1/maintenance/req_2/"]);
    assert.match(out, /WOULD TRANSFER +1 objects/);
    assert.match(out, /WOULD TRANSFER +4500 bytes/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("--max-object-bytes names the objects the bucket limit would reject", async () => {
  const state = await buildState();
  try {
    // Only the 4,500-byte multipart video is over; the 1,024-byte jpeg is not.
    const out = await dryRun(state.stateDir, ["--max-object-bytes", "2000"]);
    assert.match(out, /over --max-object-bytes 1 /);
    assert.match(out, /OVERSIZE .*video\.mov/);
    assert.match(out, /will be REJECTED by/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */

test("chunked re-splits a stream on exact part boundaries", async () => {
  // The source chunks are deliberately nothing like the part size: a completed
  // Miniflare object's parts can be any size at all, including under S3's 5 MiB
  // minimum, so the boundaries this produces must depend only on the requested
  // size and not on how the bytes arrived.
  const source = [
    Buffer.alloc(3, 1),
    Buffer.alloc(1, 2),
    Buffer.alloc(11, 3),
    Buffer.alloc(1, 4),
  ];
  const total = Buffer.concat(source);

  for (const size of [1, 2, 4, 5, 16, 100]) {
    const parts = [];
    for await (const part of chunked((async function* () {
      yield* source;
    })(), size)) {
      parts.push(Buffer.from(part));
    }
    // Every part but the last is exactly `size` — S3 rejects a short part in
    // the middle of an upload, and it rejects it at complete(), after the bytes
    // have been paid for.
    for (const part of parts.slice(0, -1)) {
      assert.equal(part.length, size, `size ${size}`);
    }
    assert.ok(parts.at(-1).length <= size && parts.at(-1).length > 0);
    // And no byte is lost, duplicated or reordered.
    assert.deepEqual(Buffer.concat(parts), total, `size ${size}`);
  }
});

test("chunked on an empty source yields nothing rather than an empty part", async () => {
  const parts = [];
  for await (const part of chunked((async function* () {})(), 8)) parts.push(part);
  // S3 rejects a zero-byte part, and a multipart upload of an empty object is
  // not a thing — `put` handles those, which is why the threshold exists.
  assert.deepEqual(parts, []);
});

/* -------------------------------------------------------------------------- */
/* End to end, against an S3 that is not Supabase                              */
/* -------------------------------------------------------------------------- */

/**
 * A minimal S3 that stores what it is given.
 *
 * This is NOT a claim that Supabase behaves this way — no part of this repo can
 * make that claim until keys are issued. It is the strongest statement that can
 * be made without them: that the driver and the migration script, run together
 * against an endpoint that follows the S3 protocol as documented, move every
 * byte and every piece of metadata into the right place, take the multipart
 * path when the object is large, and do nothing the second time they are run.
 *
 * It deliberately does not verify signatures — verifying them against our own
 * signer would prove only that it agrees with itself. AWS's published vectors
 * in `tests/r2-over-s3.test.mjs` are what pin the signature. What this DOES
 * check is that an Authorization header was present and covered every header
 * sent, because an unsigned header is a 403 from a real endpoint.
 */
async function fakeS3() {
  const { createServer } = await import("node:http");
  const objects = new Map();
  const uploads = new Map();
  let counter = 0;

  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(/^\/job-media\//, ""));
    const body = await readBody(request);

    const auth = request.headers.authorization ?? "";
    if (!/^AWS4-HMAC-SHA256 Credential=\S+, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/.test(auth)) {
      response.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const signed = new Set(/SignedHeaders=([^,]+),/.exec(auth)[1].split(";"));
    for (const name of Object.keys(request.headers)) {
      // A metadata header that is sent but not signed is silently dropped by
      // AWS and rejected by some implementations. Either way it is the bug this
      // whole file exists to catch.
      if (name.startsWith("x-amz-") || name === "content-type" || name === "content-disposition") {
        if (!signed.has(name)) {
          response.writeHead(403).end(`<Error><Code>Unsigned ${name}</Code></Error>`);
          return;
        }
      }
    }

    const meta = () => {
      const kept = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.startsWith("x-amz-meta-")) kept[name] = value;
        if (name === "content-type" || name === "content-disposition") kept[name] = value;
      }
      return kept;
    };

    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = `up-${++counter}`;
      uploads.set(id, { key, meta: meta(), parts: new Map() });
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    if (request.method === "PUT" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId"));
      if (!upload || upload.key !== key) {
        response.writeHead(404).end("<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      const etag = `p${url.searchParams.get("partNumber")}-${body.length}`;
      upload.parts.set(Number(url.searchParams.get("partNumber")), { body, etag });
      response.writeHead(200, { etag: `"${etag}"` }).end();
      return;
    }
    if (request.method === "POST" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId"));
      const asked = [...body.toString("utf8").matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;([^<]*)&quot;<\/ETag>/g)];
      const ordered = asked.map(([, number]) => Number(number));
      // Parts must arrive sorted and their etags must match, exactly as S3
      // requires — the etags made a round trip through a browser to get here.
      assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
      for (const [, number, etag] of asked) {
        assert.equal(upload.parts.get(Number(number)).etag, etag);
      }
      objects.set(key, {
        body: Buffer.concat(ordered.map((n) => upload.parts.get(n).body)),
        meta: upload.meta,
        parts: ordered.length,
      });
      uploads.delete(url.searchParams.get("uploadId"));
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end("<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>");
      return;
    }
    if (request.method === "PUT") {
      objects.set(key, { body, meta: meta(), parts: 1 });
      response.writeHead(200, { etag: '"single"' }).end();
      return;
    }
    if (request.method === "HEAD" || request.method === "GET") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        ...object.meta,
        "content-length": String(object.body.length),
        etag: '"stored"',
      });
      response.end(request.method === "HEAD" ? undefined : object.body);
      return;
    }
    response.writeHead(204).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, objects, port: server.address().port };
}

test("end to end: every byte and every metadata name lands, and a re-run is a no-op", async () => {
  const state = await buildState();
  const s3 = await fakeS3();
  const env = {
    ...process.env,
    S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
    S3_BUCKET: "job-media",
    S3_REGION: "eu-west-2",
    S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const migrate = (extra = []) =>
    run(
      process.execPath,
      [
        "scripts/migrate-r2-to-s3.mjs",
        "--state-dir",
        state.stateDir,
        // Kilobytes instead of gigabytes, so the 4,500-byte video takes the
        // multipart path and is reassembled from five parts.
        "--multipart-threshold",
        "2000",
        "--part-bytes",
        "1000",
        "--verify",
        ...extra,
      ],
      { cwd: REPO, env },
    );

  try {
    const first = await migrate();
    assert.match(first.stdout, /sent 3, skipped 0, conflicts 0, failed 0/);

    // Three objects, byte-exact.
    assert.equal(s3.objects.size, 3);
    const video = s3.objects.get("org_1/maintenance/req_2/general/video.mov");
    assert.equal(video.body.length, 4500);
    assert.equal(video.parts, 5, "4500 bytes in 1000-byte parts");
    assert.equal(video.meta["content-type"], "video/quicktime");

    // The metadata the portal wrote, plus the provenance the migration adds,
    // with the case table that makes the camelCase names readable again.
    assert.equal(video.meta["x-amz-meta-requestid"], "req_2");
    assert.equal(video.meta["x-amz-meta-originalname"], "video.mov");
    assert.equal(video.meta["x-amz-meta-r2sourceetag"], "etag-multi-2");
    assert.equal(
      video.meta["x-amz-meta-r2-names"],
      "requestId,originalName,r2SourceEtag",
    );

    const thumb = s3.objects.get("org_1/maintenance/req_1/general/a.jpg.thumb");
    assert.equal(thumb.body.length, state.thumbBytes);
    assert.equal(thumb.meta["content-type"], "image/webp");

    // The abandoned session's 9,999 bytes went nowhere.
    for (const key of s3.objects.keys()) assert.ok(!key.includes("ghost"));

    // And the second run sends nothing at all.
    const second = await migrate();
    assert.match(second.stdout, /sent 0, skipped 3, conflicts 0, failed 0/);
  } finally {
    s3.server.close();
    await rm(state.root, { recursive: true, force: true });
  }
});
