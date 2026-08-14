import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createR2Bucket } from "../db/node-r2.ts";

/**
 * The filesystem R2 bucket, exercised the way the app exercises it.
 *
 * Every assertion here is copied from a real call site rather than from the R2
 * documentation, because the documentation is a superset and the app is what has
 * to keep working:
 *
 *   - `POST /api/files` puts an ArrayBuffer with httpMetadata + customMetadata
 *     and deletes the key again if the database insert throws.
 *   - `GET /api/files/[id]` heads the key, heads `<key>.thumb` and expects null
 *     when there is no derivative, gets with `{range:{offset,length}}` for video
 *     seeking, calls `object.writeHttpMetadata(headers)`, reads `object.size`
 *     and streams `object.body` into a Response.
 *   - `PUT /api/files/[id]` puts a Uint8Array under `<objectKey>.thumb`.
 *   - `POST/PUT /api/files/multipart` starts an upload, reads `.key` and
 *     `.uploadId` off it, resumes it SYNCHRONOUSLY, uploads parts, completes
 *     with the etags the browser sent back, then heads the key and compares
 *     `head.size` and `head.customMetadata` against what it declared.
 *   - `DELETE /api/files/[id]` and the trash/board purges delete an ARRAY of
 *     keys, including keys that are already gone.
 *
 * A fresh temporary root per test, because the point of the implementation is
 * that the root is configurable and nothing outside it is touched.
 */

async function withBucket(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "r2-local-"));
  try {
    await run(createR2Bucket({ dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const md5 = (buffer) => createHash("md5").update(buffer).digest("hex");

/**
 * A standalone ArrayBuffer holding exactly these bytes.
 *
 * `Buffer.from("...").buffer` is NOT it: small Buffers are slices of a shared
 * 64KB pool, so passing `.buffer` hands over the pool and everything else
 * currently in it. `file.arrayBuffer()` in the routes returns a detached buffer
 * of exactly the file, so that is what the tests must pass.
 */
const arrayBufferOf = (buffer) =>
  buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );

test("put -> head -> get -> body -> delete, as POST/GET/DELETE /api/files do", async () => {
  await withBucket(async (bucket) => {
    const bytes = Buffer.from("the fault photograph bytes", "utf8");
    const key = "org-1/maintenance/job-1/issue/abc-photo.jpg";

    // POST /api/files passes an ArrayBuffer from `file.arrayBuffer()`.
    const put = await bucket.put(key, arrayBufferOf(bytes), {
      httpMetadata: {
        contentType: "image/jpeg",
        contentDisposition: 'inline; filename="photo.jpg"',
      },
      customMetadata: {
        requestId: "job-1",
        kind: "issue",
        uploadedBy: "owner@maintsupp.com",
        originalName: "photo.jpg",
      },
    });
    assert.equal(put.key, key);
    assert.equal(put.size, bytes.byteLength);
    assert.equal(put.etag, md5(bytes), "single-shot etag is the body MD5");

    const head = await bucket.head(key);
    assert.ok(head);
    assert.equal(head.size, bytes.byteLength);
    assert.equal(head.customMetadata.requestId, "job-1");
    assert.equal(head.customMetadata.originalName, "photo.jpg");
    assert.equal(head.httpMetadata.contentType, "image/jpeg");
    assert.ok(head.uploaded instanceof Date);
    assert.ok(Number.isFinite(head.uploaded.getTime()));

    // A derivative that was never generated must be null, not a throw — that is
    // the `?thumb=1` fallback in GET /api/files/[id].
    assert.equal(await bucket.head(`${key}.thumb`), null);
    assert.equal(await bucket.get(`${key}.thumb`), null);

    const object = await bucket.get(key);
    assert.ok(object);
    assert.equal(object.size, bytes.byteLength);

    // The route calls this and then overwrites Content-Type itself.
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    assert.equal(headers.get("Content-Type"), "image/jpeg");
    assert.equal(
      headers.get("Content-Disposition"),
      'inline; filename="photo.jpg"',
    );

    // `new Response(object.body)` is what the route actually does with it.
    const served = await new Response(object.body).arrayBuffer();
    assert.equal(Buffer.from(served).toString("utf8"), bytes.toString("utf8"));

    await bucket.delete(key);
    assert.equal(await bucket.head(key), null);
    assert.equal(await bucket.get(key), null);
  });
});

test("metadata survives a restart", async () => {
  // The sidecar is the whole reason for the layout: a new bucket object over the
  // same directory must see everything the previous process wrote.
  const dir = await mkdtemp(path.join(tmpdir(), "r2-local-"));
  try {
    const first = createR2Bucket({ dir });
    await first.put("org-1/maintenance/job-2/general/report.pdf", "hello", {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { requestId: "job-2", fileId: "f-2" },
    });

    const second = createR2Bucket({ dir });
    const head = await second.head("org-1/maintenance/job-2/general/report.pdf");
    assert.ok(head);
    assert.equal(head.httpMetadata.contentType, "application/pdf");
    assert.equal(head.customMetadata.fileId, "f-2");
    assert.equal(head.size, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ranged get returns the span and the full size, for video seeking", async () => {
  await withBucket(async (bucket) => {
    const bytes = Buffer.from("0123456789abcdef", "utf8");
    const key = "org-1/maintenance/job-3/completion/clip.mp4";
    await bucket.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });

    const head = await bucket.head(key);
    // GET /api/files/[id] clamps the Range header against head.size first.
    const object = await bucket.get(key, { range: { offset: 4, length: 6 } });
    assert.ok(object);
    assert.equal(
      object.size,
      head.size,
      "R2 reports the full object size on a ranged read",
    );
    assert.deepEqual(object.range, { offset: 4, length: 6 });
    const body = Buffer.from(await new Response(object.body).arrayBuffer());
    assert.equal(body.toString("utf8"), "456789");

    // The route's `Content-Length: range?.length ?? object.size` and its
    // `Content-Range: bytes start-end/head.size` both come out of the above.
    const tail = await bucket.get(key, { range: { offset: 10 } });
    assert.equal(
      Buffer.from(await new Response(tail.body).arrayBuffer()).toString("utf8"),
      "abcdef",
    );

    // `bytes=16-` against a 16-byte object. Reachable from the Range header and
    // an ERR_OUT_OF_RANGE throw before the zero-length case was special-cased.
    const empty = await bucket.get(key, { range: { offset: bytes.byteLength } });
    assert.ok(empty);
    assert.equal(
      (await new Response(empty.body).arrayBuffer()).byteLength,
      0,
      "a zero-length range is an empty body, not a throw",
    );

    // Past the end is unsatisfiable, which R2 answers with null.
    assert.equal(await bucket.get(key, { range: { offset: 99 } }), null);
    // A suffix range, and a length that runs past the end, both clamp.
    const suffix = await bucket.get(key, { range: { suffix: 3 } });
    assert.equal(
      Buffer.from(await new Response(suffix.body).arrayBuffer()).toString("utf8"),
      "def",
    );
    const over = await bucket.get(key, { range: { offset: 13, length: 999 } });
    assert.deepEqual(over.range, { offset: 13, length: 3 });
  });
});

test("thumbnail put alongside the original, and both deleted together", async () => {
  await withBucket(async (bucket) => {
    const key = "org-1/maintenance/job-4/issue/xyz-photo.jpg";
    await bucket.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/jpeg" },
    });
    // PUT /api/files/[id] writes a WebP derivative as a Uint8Array.
    await bucket.put(`${key}.thumb`, new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      httpMetadata: { contentType: "image/webp" },
    });
    assert.equal((await bucket.head(`${key}.thumb`)).size, 4);

    // DELETE /api/files/[id] passes both keys as one array.
    await bucket.delete([key, `${key}.thumb`]);
    assert.equal(await bucket.head(key), null);
    assert.equal(await bucket.head(`${key}.thumb`), null);
  });
});

test("deleting keys that are already gone is a success", async () => {
  await withBucket(async (bucket) => {
    // purgeJob in the trash route re-deletes defensively and must not throw.
    await bucket.delete(["never/existed", "also/never/existed"]);
    await bucket.delete("never/existed");
  });
});

test("list enumerates by prefix and rolls up on a delimiter", async () => {
  await withBucket(async (bucket) => {
    await bucket.put("org-1/maintenance/job-5/issue/a.jpg", "a");
    await bucket.put("org-1/maintenance/job-5/issue/b.jpg", "b");
    await bucket.put("org-1/maintenance/job-6/issue/c.jpg", "c");
    await bucket.put("org-2/maintenance/job-7/issue/d.jpg", "d");

    const all = await bucket.list();
    assert.equal(all.objects.length, 4);
    assert.equal(all.truncated, false);

    const scoped = await bucket.list({ prefix: "org-1/maintenance/job-5/" });
    assert.deepEqual(
      scoped.objects.map((object) => object.key),
      [
        "org-1/maintenance/job-5/issue/a.jpg",
        "org-1/maintenance/job-5/issue/b.jpg",
      ],
      "sorted by key, like R2",
    );

    const rolled = await bucket.list({
      prefix: "org-1/maintenance/",
      delimiter: "/",
    });
    assert.deepEqual(rolled.delimitedPrefixes, [
      "org-1/maintenance/job-5/",
      "org-1/maintenance/job-6/",
    ]);
    assert.equal(rolled.objects.length, 0);

    // A cursor must carry on where the page stopped.
    const page = await bucket.list({ limit: 1 });
    assert.equal(page.truncated, true);
    const next = await bucket.list({ limit: 10, cursor: page.cursor });
    assert.equal(next.objects.length, 3);
    assert.equal(next.objects[0].key, "org-1/maintenance/job-5/issue/b.jpg");
  });
});

test("multipart upload, exactly as /api/files/multipart drives it", async () => {
  await withBucket(async (bucket) => {
    const fileId = randomUUID();
    const key = `org-1/maintenance/job-8/completion/${fileId}-site-walk.mp4`;
    const partOne = Buffer.alloc(1024, 0x61);
    const partTwo = Buffer.alloc(1024, 0x62);
    const partThree = Buffer.from("tail", "utf8");
    const whole = Buffer.concat([partOne, partTwo, partThree]);

    // action=start
    const started = await bucket.createMultipartUpload(key, {
      httpMetadata: {
        contentType: "video/mp4",
        contentDisposition: 'inline; filename="site-walk.mp4"',
      },
      customMetadata: {
        requestId: "job-8",
        organisationId: "org-1",
        kind: "completion",
        fileId,
        originalName: "site walk.mp4",
        contentType: "video/mp4",
        byteSize: String(whole.byteLength),
        uploadedBy: "owner@maintsupp.com",
      },
    });
    assert.equal(started.key, key, "the route returns upload.key to the client");
    assert.match(started.uploadId, /^[0-9a-f]{32}$/);

    // PUT — a separate request per part, so a FRESH resume each time. The route
    // does not await this call, so it must not be a promise.
    const parts = [];
    for (const [index, chunk] of [partOne, partTwo, partThree].entries()) {
      const resumed = bucket.resumeMultipartUpload(key, started.uploadId);
      assert.equal(
        typeof resumed.uploadPart,
        "function",
        "resumeMultipartUpload must be synchronous",
      );
      const part = await resumed.uploadPart(index + 1, arrayBufferOf(chunk));
      // The route JSON-encodes this object straight back to the browser.
      assert.deepEqual(Object.keys(part).sort(), ["etag", "partNumber"]);
      assert.equal(part.etag, md5(chunk));
      parts.push(JSON.parse(JSON.stringify(part)));
    }

    // action=complete
    const completed = await bucket
      .resumeMultipartUpload(key, started.uploadId)
      .complete(parts);
    assert.equal(completed.key, key);
    assert.equal(completed.size, whole.byteLength);
    assert.match(
      completed.etag,
      /^[0-9a-f]{32}-3$/,
      "R2 multipart etag is <md5 of the part digests>-<count>",
    );

    // completeMetadata(): head the key and check the metadata survived.
    const head = await bucket.head(key);
    assert.ok(head);
    assert.equal(head.customMetadata.requestId, "job-8");
    assert.equal(head.customMetadata.kind, "completion");
    assert.equal(head.customMetadata.fileId, fileId);
    assert.equal(head.customMetadata.originalName, "site walk.mp4");
    assert.equal(head.customMetadata.boardColumnId, undefined);
    assert.equal(head.httpMetadata.contentType, "video/mp4");
    // The route refuses the upload unless declared byteSize === head.size.
    assert.equal(Number(head.customMetadata.byteSize), head.size);

    // And the assembled bytes are the file, in order.
    const object = await bucket.get(key);
    const served = Buffer.from(await new Response(object.body).arrayBuffer());
    assert.equal(served.byteLength, whole.byteLength);
    assert.ok(served.equals(whole), "parts concatenated in part-number order");
  });
});

test("multipart abort discards the session", async () => {
  await withBucket(async (bucket) => {
    const key = "org-1/maintenance/job-9/issue/aborted.mp4";
    const started = await bucket.createMultipartUpload(key);
    await bucket
      .resumeMultipartUpload(key, started.uploadId)
      .uploadPart(1, Buffer.from("partial"));

    await bucket.resumeMultipartUpload(key, started.uploadId).abort();
    assert.equal(await bucket.head(key), null, "nothing was published");

    // client-upload.ts aborts from a catch block that may already have raced a
    // complete, so a second abort must be quiet.
    await bucket.resumeMultipartUpload(key, started.uploadId).abort();

    await assert.rejects(
      () =>
        bucket
          .resumeMultipartUpload(key, started.uploadId)
          .complete([{ partNumber: 1, etag: md5(Buffer.from("partial")) }]),
      /does not exist/,
    );
  });
});

test("a multipart session is bound to its key and its etags", async () => {
  await withBucket(async (bucket) => {
    const key = "org-1/maintenance/job-10/issue/real.mp4";
    const started = await bucket.createMultipartUpload(key);
    const part = await bucket
      .resumeMultipartUpload(key, started.uploadId)
      .uploadPart(1, Buffer.from("bytes"));

    // Another tenant's key must not be able to ride this session — the route's
    // validUploadKey proves the prefix, this proves the pairing.
    await assert.rejects(
      () =>
        bucket
          .resumeMultipartUpload("org-2/maintenance/job-10/issue/real.mp4", started.uploadId)
          .complete([part]),
      /does not exist/,
    );

    // A part etag the client made up is refused.
    await assert.rejects(
      () =>
        bucket
          .resumeMultipartUpload(key, started.uploadId)
          .complete([{ partNumber: 1, etag: "0".repeat(32) }]),
      /does not match its etag/,
    );

    // As is a part that was never sent.
    await assert.rejects(
      () =>
        bucket
          .resumeMultipartUpload(key, started.uploadId)
          .complete([part, { partNumber: 2, etag: "0".repeat(32) }]),
      /never uploaded/,
    );

    assert.equal(await bucket.head(key), null);
  });
});

test("a forged upload id cannot escape the storage root", async () => {
  await withBucket(async (bucket) => {
    // `uploadId` comes off the request body / X-Upload-Id header unvalidated.
    for (const forged of ["../../etc", "..", "a/b", "", "NOTHEX".repeat(4)]) {
      assert.throws(
        () => bucket.resumeMultipartUpload("org-1/x", forged),
        /Invalid multipart upload id/,
      );
    }
  });
});

test("a key with traversal or case-only differences stays inside the root", async () => {
  await withBucket(async (bucket, dir) => {
    // Neither of these may escape, and the two casings must stay distinct —
    // both are silent data loss under a naive key-as-path layout on macOS.
    await bucket.put("../../escape.txt", "nope");
    await bucket.put("org-1/Photo.JPG", "upper");
    await bucket.put("org-1/photo.jpg", "lower");

    assert.equal(
      Buffer.from(
        await new Response((await bucket.get("org-1/Photo.JPG")).body).arrayBuffer(),
      ).toString("utf8"),
      "upper",
    );
    assert.equal(
      Buffer.from(
        await new Response((await bucket.get("org-1/photo.jpg")).body).arrayBuffer(),
      ).toString("utf8"),
      "lower",
    );

    const keys = (await bucket.list()).objects.map((object) => object.key).sort();
    assert.deepEqual(keys, ["../../escape.txt", "org-1/Photo.JPG", "org-1/photo.jpg"]);
    assert.equal(bucket.localDir, path.resolve(dir));
  });
});

test("overwriting a key replaces bytes and metadata together", async () => {
  await withBucket(async (bucket) => {
    const key = "org-1/maintenance/job-11/general/notes.txt";
    await bucket.put(key, "first", { customMetadata: { version: "1" } });
    const before = await bucket.head(key);
    await bucket.put(key, "second version", { customMetadata: { version: "2" } });
    const after = await bucket.head(key);

    assert.notEqual(after.version, before.version);
    assert.equal(after.size, "second version".length);
    assert.equal(after.customMetadata.version, "2");
    assert.equal(
      Buffer.from(
        await new Response((await bucket.get(key)).body).arrayBuffer(),
      ).toString("utf8"),
      "second version",
    );

    // The superseded blob is not left behind.
    const { objects } = await bucket.list({ prefix: key });
    assert.equal(objects.length, 1);
  });
});
