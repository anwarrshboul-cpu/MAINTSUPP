/**
 * An R2 bucket backed by a directory on disk.
 *
 * The app reaches file storage exactly one way: `await import("cloudflare:workers")`
 * then `env.BUCKET`. Under workerd that binding is a real R2 bucket; under plain
 * Node — which is what Railway runs — there is no `cloudflare:workers` module and
 * no binding behind it, so every upload, download and delete is a 503 from the
 * `if (!storage)` guard in each route. This module supplies the BUCKET half of
 * the replacement: a plain object implementing the slice of the R2 API the app
 * actually calls, storing bytes under a directory that on Railway is a mounted
 * volume.
 *
 * It is deliberately SELF-CONTAINED — no imports outside `node:` — because the
 * `cloudflare:workers` shim itself is owned elsewhere. `db/node-workers-env.ts`
 * currently states that "R2 is knowingly absent … that is a second port (R2 →
 * volume or S3)". This is that second port, and attaching it is two lines there
 * and nothing anywhere else:
 *
 *     import { createR2Bucket } from "./node-r2";
 *     export const env = { get DB() {...}, BUCKET: createR2Bucket() };
 *
 * `createR2Bucket()` opens no file descriptors and touches no disk — directories
 * are created on the first write — so unlike `DB` it does not need a lazy getter
 * to keep a missing volume from becoming a boot crash.
 *
 * Until those two lines exist, `env.BUCKET` stays undefined and the file routes
 * keep answering "File storage is unavailable." with a 503, which is the honest
 * state and not a regression.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ON-DISK LAYOUT IS NOT "THE KEY AS A PATH"
 *
 * The obvious implementation — write `org/maintenance/<job>/issue/<file>.jpg` to
 * that same path under the root — cannot be made correct, for four separate
 * reasons, and three of them are live in this app:
 *
 *   1. R2 has no directories. `a/b` and `a/b/c` are both perfectly legal object
 *      keys and may coexist; on a filesystem `a/b` would have to be a file and a
 *      directory at once. Today's keys are all leaves, but a layout that breaks
 *      the moment someone stores a key that is a prefix of another key is a trap
 *      left for the next person.
 *   2. R2 keys are case-SENSITIVE. macOS (APFS, default) and a Docker volume on
 *      a case-insensitive host are not. Two keys differing only in case would
 *      silently become one object, and the loss would be invisible until someone
 *      opened the wrong photograph.
 *   3. A key is caller-influenced. `validUploadKey` in the multipart route checks
 *      only the prefix and a 512-char cap, so a `..` segment or a leading `/`
 *      reaches storage. Joining that onto a root directory is a path traversal
 *      write. Hashing removes the class of bug rather than filtering for it.
 *   4. POSIX caps a single path component at 255 bytes. R2 caps a whole key at
 *      1024. `safeFileName` keeps the app's own names short enough, but nothing
 *      enforces that for keys written by an import script.
 *
 * So each key is addressed by `sha256(key)`, sharded two hex characters deep so
 * no one directory holds all 2,968-plus attachments, and the real key is stored
 * INSIDE the metadata sidecar — which is also what makes `list()` possible.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMMIT POINT IS THE SIDECAR RENAME
 *
 * Metadata must survive a restart, so it is a JSON sidecar next to the bytes.
 * The pair is written in an order that has no torn state a reader can observe:
 * the blob lands first under a name containing a fresh version id, and only then
 * is the sidecar renamed over the old one. `rename(2)` within a filesystem is
 * atomic, so a reader either sees the whole old object or the whole new one —
 * never new metadata pointing at bytes that are still being written, which is
 * what a plain "write the file, then write the meta" would give under a crash or
 * two concurrent PUTs to the same key.
 *
 * A crash between the two renames leaves an unreferenced blob. That wastes disk
 * and nothing else; see the gaps note at the bottom of this file.
 */

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

/* -------------------------------------------------------------------------- */
/* The shape of the R2 API this app uses.                                      */
/*                                                                             */
/* Declared here rather than imported from `@cloudflare/workers-types`, which   */
/* this project does not install — see the comment on `bucket()` in            */
/* app/api/files/[id]/route.ts about the unresolved-`R2Bucket` error baseline.  */
/* Structural typing means the object below still satisfies the `R2Bucket`      */
/* annotations at every call site.                                             */
/* -------------------------------------------------------------------------- */

export interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface LocalR2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata: R2HttpMetadata;
  customMetadata: Record<string, string>;
  checksums: { md5?: string };
  storageClass: string;
  range?: { offset: number; length: number };
  writeHttpMetadata(headers: Headers): void;
}

export interface LocalR2ObjectBody extends LocalR2Object {
  body: ReadableStream<Uint8Array>;
  bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

export interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2GetOptions {
  range?: R2Range;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface LocalR2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<LocalR2Object>;
  abort(): Promise<void>;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
}

export interface R2Objects {
  objects: LocalR2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

export type R2PutValue =
  | ArrayBuffer
  | ArrayBufferView
  | string
  | ReadableStream<Uint8Array>
  | Blob
  | null;

export interface LocalR2Bucket {
  put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<LocalR2Object>;
  get(key: string, options?: R2GetOptions): Promise<LocalR2ObjectBody | null>;
  head(key: string): Promise<LocalR2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  createMultipartUpload(
    key: string,
    options?: R2PutOptions,
  ): Promise<LocalR2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): LocalR2MultipartUpload;
  /** Where the bytes live. Diagnostics only; not part of the R2 API. */
  readonly localDir: string;
}

/* -------------------------------------------------------------------------- */
/* Persisted shapes                                                            */
/* -------------------------------------------------------------------------- */

interface ObjectSidecar {
  key: string;
  blob: string;
  version: string;
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  md5?: string;
}

interface UploadSidecar {
  key: string;
  uploadId: string;
  created: string;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
}

interface PartSidecar {
  partNumber: number;
  size: number;
  etag: string;
}

/* -------------------------------------------------------------------------- */

const HTTP_METADATA_FIELDS = [
  "contentType",
  "contentLanguage",
  "contentDisposition",
  "contentEncoding",
  "cacheControl",
  "cacheExpiry",
] as const;

/**
 * A missing object is `null`, not an exception — every other failure throws.
 *
 * `head()` and `get()` returning null is load-bearing: `GET /api/files/[id]`
 * distinguishes "no thumbnail, fall back to the original" from "the bucket is
 * broken" purely by that, and turning ENOENT into a throw would turn a missing
 * derivative into a 503 for a photograph that is perfectly present.
 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * R2 rejects a key over 1024 UTF-8 bytes; so does this, for the same reason a
 * shim should refuse what the real thing refuses — a difference only shows up
 * in production, where it is expensive.
 */
function assertKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("R2 key must be a non-empty string.");
  }
  if (Buffer.byteLength(key, "utf8") > 1024) {
    throw new TypeError("R2 key must be at most 1024 bytes.");
  }
  return key;
}

/**
 * The upload id becomes a directory name, and it arrives from the browser.
 *
 * `resumeMultipartUpload(key, uploadId)` is reached from `POST /api/files/multipart`
 * and from its `PUT` sibling with `uploadId` taken straight off the request —
 * the route validates the KEY prefix but never the id. Anything other than the
 * 32 hex characters this module issues is refused before it can reach `join()`.
 */
function assertUploadId(uploadId: string): string {
  if (typeof uploadId !== "string" || !/^[0-9a-f]{32}$/.test(uploadId)) {
    throw new Error("Invalid multipart upload id.");
  }
  return uploadId;
}

function newVersion(): string {
  return randomUUID().replace(/-/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Only R2's six known HTTP metadata fields are kept, and `cacheExpiry` is stored
 * as an ISO string so the sidecar round-trips through JSON. Unknown fields are
 * dropped rather than persisted: R2 drops them too, and a shim that quietly
 * accepted more than the real binding would let a bug ship that only fails once
 * it is back on Cloudflare.
 */
function normaliseHttpMetadata(
  input: R2HttpMetadata | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const field of HTTP_METADATA_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    output[field] =
      value instanceof Date ? value.toISOString() : String(value);
  }
  return output;
}

function hydrateHttpMetadata(stored: Record<string, string>): R2HttpMetadata {
  const output: R2HttpMetadata = {};
  for (const field of HTTP_METADATA_FIELDS) {
    const value = stored[field];
    if (value === undefined) continue;
    if (field === "cacheExpiry") output.cacheExpiry = new Date(value);
    else (output as Record<string, unknown>)[field] = value;
  }
  return output;
}

function normaliseCustomMetadata(
  input: Record<string, string> | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    output[name] = String(value);
  }
  return output;
}

/* -------------------------------------------------------------------------- */

export interface CreateR2BucketOptions {
  /**
   * Root directory for objects. On Railway this must be the mount path of a
   * volume — the container filesystem is discarded on every deploy, and 2,968
   * attachments discarded with it would not announce themselves.
   */
  dir?: string;
}

export function createR2Bucket(
  options: CreateR2BucketOptions = {},
): LocalR2Bucket {
  const root = path.resolve(
    options.dir ?? process.env.R2_LOCAL_DIR ?? path.join(process.cwd(), ".r2-local"),
  );
  const objectsDir = path.join(root, "objects");
  const uploadsDir = path.join(root, "uploads");
  const tmpDir = path.join(root, "tmp");

  /* ---------------------------------------------------------------------- */
  /* Paths                                                                   */
  /* ---------------------------------------------------------------------- */

  function shardDir(key: string): string {
    const hash = sha256Hex(key);
    return path.join(objectsDir, hash.slice(0, 2));
  }

  function sidecarPath(key: string): string {
    return path.join(shardDir(key), `${sha256Hex(key)}.json`);
  }

  function blobPath(key: string, blob: string): string {
    return path.join(shardDir(key), blob);
  }

  function uploadDir(uploadId: string): string {
    return path.join(uploadsDir, assertUploadId(uploadId));
  }

  function partPath(uploadId: string, partNumber: number): string {
    // Zero-padded so a directory listing sorts in part order, which is the
    // order `complete()` must concatenate in.
    return path.join(
      uploadDir(uploadId),
      `part-${String(partNumber).padStart(5, "0")}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Atomic write primitives                                                 */
  /* ---------------------------------------------------------------------- */

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * `rename` is only atomic within one filesystem, so the staging directory
   * lives under the same root as the destination rather than in the OS temp
   * directory — on Railway those are genuinely different mounts, and the
   * fallback `rename` would take there is a copy with a window in the middle.
   */
  async function stage(): Promise<string> {
    await ensureDir(tmpDir);
    return path.join(tmpDir, `${newVersion()}.tmp`);
  }

  async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
    const temporary = await stage();
    await fs.writeFile(temporary, JSON.stringify(value), "utf8");
    await ensureDir(path.dirname(target));
    await fs.rename(temporary, target);
  }

  async function readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Best-effort unlink: the caller has already committed, so ENOENT is fine. */
  async function unlinkQuietly(file: string): Promise<void> {
    try {
      await fs.unlink(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /**
   * Streams `value` to `target`, returning the byte count and MD5 as it goes.
   *
   * The MD5 is computed here, in one pass, because R2's etag for a single-shot
   * put IS the MD5 of the content — and a 90 MB video (the app's video ceiling)
   * must never be resident in memory just to hash it. Everything the app hands
   * this function today is already a buffer, but the streaming path is what
   * keeps that ceiling from becoming a memory ceiling.
   */
  async function writeBody(
    target: string,
    value: R2PutValue,
  ): Promise<{ size: number; md5: string }> {
    const hash = createHash("md5");
    let size = 0;

    const source = await toNodeReadable(value, (chunk) => {
      hash.update(chunk);
      size += chunk.byteLength;
    });

    await ensureDir(path.dirname(target));
    await pipeline(source, createWriteStream(target));
    return { size, md5: hash.digest("hex") };
  }

  /* ---------------------------------------------------------------------- */
  /* R2Object construction                                                   */
  /* ---------------------------------------------------------------------- */

  function toObject(sidecar: ObjectSidecar): LocalR2Object {
    const httpMetadata = hydrateHttpMetadata(sidecar.httpMetadata);
    return {
      key: sidecar.key,
      version: sidecar.version,
      size: sidecar.size,
      etag: sidecar.etag,
      httpEtag: `"${sidecar.etag}"`,
      uploaded: new Date(sidecar.uploaded),
      httpMetadata,
      customMetadata: sidecar.customMetadata,
      checksums: sidecar.md5 ? { md5: sidecar.md5 } : {},
      storageClass: "Standard",
      /**
       * The one method the app calls on a returned object.
       *
       * `GET /api/files/[id]` calls this first and then deliberately OVERWRITES
       * Content-Type, Content-Disposition and Cache-Control, because the stored
       * type came from the uploader and is not trusted for rendering. So the
       * only fields that survive from here are the ones that route does not set
       * — but it must still set what R2 sets, or a future caller that relies on
       * it gets nothing.
       */
      writeHttpMetadata(headers: Headers) {
        if (httpMetadata.contentType) {
          headers.set("Content-Type", httpMetadata.contentType);
        }
        if (httpMetadata.contentLanguage) {
          headers.set("Content-Language", httpMetadata.contentLanguage);
        }
        if (httpMetadata.contentDisposition) {
          headers.set("Content-Disposition", httpMetadata.contentDisposition);
        }
        if (httpMetadata.contentEncoding) {
          headers.set("Content-Encoding", httpMetadata.contentEncoding);
        }
        if (httpMetadata.cacheControl) {
          headers.set("Cache-Control", httpMetadata.cacheControl);
        }
        if (httpMetadata.cacheExpiry) {
          headers.set("Expires", httpMetadata.cacheExpiry.toUTCString());
        }
      },
    };
  }

  /**
   * Resolves an R2 range against a known object size.
   *
   * Returns null when the range cannot be satisfied, which R2 answers with a
   * null `get()`. `GET /api/files/[id]` has already clamped its own range
   * against `head.size` before calling, so this is the second line rather than
   * the first — but it is the line that holds if the caller ever changes.
   */
  function resolveRange(
    range: R2Range | undefined,
    size: number,
  ): { offset: number; length: number } | null {
    if (!range) return null;
    if (typeof range.suffix === "number") {
      const length = Math.min(Math.max(range.suffix, 0), size);
      return { offset: size - length, length };
    }
    const offset = typeof range.offset === "number" ? range.offset : 0;
    if (offset < 0 || offset > size) return null;
    const length =
      typeof range.length === "number"
        ? Math.min(range.length, size - offset)
        : size - offset;
    if (length < 0) return null;
    return { offset, length };
  }

  function toObjectBody(
    sidecar: ObjectSidecar,
    range: { offset: number; length: number } | null,
  ): LocalR2ObjectBody {
    const base = toObject(sidecar);
    const file = blobPath(sidecar.key, sidecar.blob);
    let stream: ReadableStream<Uint8Array> | null = null;
    let used = false;

    /**
     * The stream is created on first access, not here.
     *
     * `head()`-shaped uses of a `get()` result are common, and an eagerly opened
     * descriptor that nobody reads is a descriptor leaked per request. The file
     * route serves a 90 MB video by handing `object.body` to `new Response`, so
     * this must stay a real stream — reading the blob into a buffer would put
     * the whole video in the Worker's heap on every seek.
     */
    function open(): ReadableStream<Uint8Array> {
      if (!stream) {
        used = true;
        /*
         * A zero-length range is an empty body, not a read.
         *
         * `createReadStream`'s `end` is INCLUSIVE, so the arithmetic for a
         * zero-length span produces `end = start - 1` and Node throws
         * ERR_OUT_OF_RANGE rather than returning nothing. It is reachable: a
         * `Range: bytes=5-` against a 5-byte object resolves here with
         * `length: 0`. R2 answers that with an empty body, so this does too.
         */
        const node =
          range && range.length === 0
            ? Readable.from([])
            : range
              ? createReadStream(file, {
                  start: range.offset,
                  end: range.offset + range.length - 1,
                })
              : createReadStream(file);
        stream = Readable.toWeb(node) as ReadableStream<Uint8Array>;
      }
      return stream;
    }

    async function bytes(): Promise<Buffer> {
      const chunks: Buffer[] = [];
      const reader = open().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    }

    /**
     * A detached copy of the body.
     *
     * A local function rather than `this.arrayBuffer()` inside `blob()`: these
     * methods are on a plain object literal, so a caller who destructures
     * (`const { blob } = object`) would lose the receiver and get a TypeError
     * from a method that looked fine everywhere it was tested.
     */
    async function bodyArrayBuffer(): Promise<ArrayBuffer> {
      const buffer = await bytes();
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    }

    return {
      ...base,
      // R2 reports the FULL object size here even on a ranged read, and puts the
      // served span in `range`. `GET /api/files/[id]` relies on exactly that: it
      // sets Content-Length from `range?.length ?? object.size`.
      ...(range ? { range } : {}),
      get body() {
        return open();
      },
      get bodyUsed() {
        return used;
      },
      arrayBuffer: bodyArrayBuffer,
      async text() {
        return (await bytes()).toString("utf8");
      },
      async json<T = unknown>() {
        return JSON.parse((await bytes()).toString("utf8")) as T;
      },
      async blob() {
        // Via the ArrayBuffer rather than the Buffer directly: a Node Buffer is
        // typed over `ArrayBufferLike`, which may be a SharedArrayBuffer and so
        // is not a `BlobPart`.
        return new Blob([await bodyArrayBuffer()]);
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Commit                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Publishes a already-written blob under `key`, replacing whatever was there.
   *
   * The sidecar rename is the commit: before it, the new blob is invisible;
   * after it, the old blob is unreferenced and is removed. Doing it the other
   * way round — sidecar first — would expose metadata pointing at bytes that
   * may not exist yet, and `GET /api/files/[id]` would 404 a file it had just
   * been told the size of.
   */
  async function commit(
    key: string,
    blobFileName: string,
    fields: {
      size: number;
      etag: string;
      md5?: string;
      httpMetadata: Record<string, string>;
      customMetadata: Record<string, string>;
    },
  ): Promise<LocalR2Object> {
    const previous = await readJson<ObjectSidecar>(sidecarPath(key));
    const sidecar: ObjectSidecar = {
      key,
      blob: blobFileName,
      version: newVersion(),
      size: fields.size,
      etag: fields.etag,
      uploaded: new Date().toISOString(),
      httpMetadata: fields.httpMetadata,
      customMetadata: fields.customMetadata,
      ...(fields.md5 ? { md5: fields.md5 } : {}),
    };
    await writeJsonAtomic(sidecarPath(key), sidecar);
    if (previous && previous.blob !== blobFileName) {
      await unlinkQuietly(blobPath(key, previous.blob));
    }
    return toObject(sidecar);
  }

  /* ---------------------------------------------------------------------- */
  /* Bucket API                                                              */
  /* ---------------------------------------------------------------------- */

  async function put(
    key: string,
    value: R2PutValue,
    putOptions: R2PutOptions = {},
  ): Promise<LocalR2Object> {
    assertKey(key);
    const blobFileName = `${sha256Hex(key)}.${newVersion()}.bin`;
    const staged = await stage();
    const { size, md5 } = await writeBody(staged, value);
    await ensureDir(shardDir(key));
    await fs.rename(staged, blobPath(key, blobFileName));
    return commit(key, blobFileName, {
      size,
      // R2's etag for a single-shot put is the hex MD5 of the body, unquoted.
      etag: md5,
      md5,
      httpMetadata: normaliseHttpMetadata(putOptions.httpMetadata),
      customMetadata: normaliseCustomMetadata(putOptions.customMetadata),
    });
  }

  async function head(key: string): Promise<LocalR2Object | null> {
    assertKey(key);
    const sidecar = await readJson<ObjectSidecar>(sidecarPath(key));
    return sidecar ? toObject(sidecar) : null;
  }

  async function get(
    key: string,
    getOptions: R2GetOptions = {},
  ): Promise<LocalR2ObjectBody | null> {
    assertKey(key);
    const sidecar = await readJson<ObjectSidecar>(sidecarPath(key));
    if (!sidecar) return null;
    const range = resolveRange(getOptions.range, sidecar.size);
    if (getOptions.range && !range) return null;
    return toObjectBody(sidecar, range);
  }

  /**
   * Deleting a key that is not there is a success, in R2 and here.
   *
   * `purgeJob` in the trash route and `deleteFilesForColumn` in the board route
   * both hand over every key a query returned, including keys whose bytes were
   * already removed by an earlier pass. Throwing on the second pass would wedge
   * the thirty-day bin sweep, which is the exact failure the comment in
   * app/api/trash/route.ts is guarding against.
   */
  async function remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      assertKey(key);
      const file = sidecarPath(key);
      const sidecar = await readJson<ObjectSidecar>(file);
      if (!sidecar) continue;
      // Sidecar first: after this the object is gone as far as every reader is
      // concerned, and the blob removal is cleanup rather than part of the
      // observable delete.
      await unlinkQuietly(file);
      await unlinkQuietly(blobPath(key, sidecar.blob));
    }
  }

  /**
   * Not called anywhere in the app — added for operations.
   *
   * Nothing on the request path lists a bucket; the database is the index, and
   * `attachments.object_key` is the only enumeration the app ever needs. But a
   * migration off Miniflare, a check for objects the database has forgotten, and
   * "is anything actually in this volume" all want it, and without it the only
   * way to answer is to walk the directory by hand and re-implement the sidecar
   * format outside this file.
   *
   * It reads every sidecar in the root, so it is O(objects) per call. That is
   * fine for a tool and would not be fine on a request path; if it ever moves to
   * one, this needs an index.
   */
  async function list(listOptions: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = listOptions.prefix ?? "";
    const limit = Math.min(Math.max(listOptions.limit ?? 1000, 1), 1000);
    const after = listOptions.cursor
      ? Buffer.from(listOptions.cursor, "base64url").toString("utf8")
      : (listOptions.startAfter ?? "");

    const found: ObjectSidecar[] = [];
    let shards: string[];
    try {
      shards = await fs.readdir(objectsDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
      shards = [];
    }
    for (const shard of shards) {
      let entries: string[];
      try {
        entries = await fs.readdir(path.join(objectsDir, shard));
      } catch (error) {
        if (!isMissing(error)) throw error;
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const sidecar = await readJson<ObjectSidecar>(
          path.join(objectsDir, shard, entry),
        );
        if (!sidecar) continue;
        if (!sidecar.key.startsWith(prefix)) continue;
        if (after && sidecar.key <= after) continue;
        found.push(sidecar);
      }
    }
    found.sort((left, right) => (left.key < right.key ? -1 : 1));

    // A delimiter rolls every key that has one after the prefix into a common
    // prefix, exactly as R2 does, and those keys are then absent from `objects`.
    const delimiter = listOptions.delimiter;
    const objects: LocalR2Object[] = [];
    const delimitedPrefixes: string[] = [];
    let truncated = false;
    let cursor: string | undefined;

    for (const sidecar of found) {
      if (objects.length + delimitedPrefixes.length >= limit) {
        truncated = true;
        break;
      }
      if (delimiter) {
        const rest = sidecar.key.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at >= 0) {
          const group = prefix + rest.slice(0, at + delimiter.length);
          if (!delimitedPrefixes.includes(group)) delimitedPrefixes.push(group);
          cursor = sidecar.key;
          continue;
        }
      }
      objects.push(toObject(sidecar));
      cursor = sidecar.key;
    }

    return {
      objects,
      truncated,
      delimitedPrefixes,
      ...(truncated && cursor
        ? { cursor: Buffer.from(cursor, "utf8").toString("base64url") }
        : {}),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Multipart                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The metadata handed to `createMultipartUpload` belongs to the FINISHED
   * object, not to the session — so it is parked in the session directory and
   * applied at `complete()`.
   *
   * This is not a detail. `completeMetadata()` in the multipart route heads the
   * key immediately after completing and refuses the upload unless
   * `customMetadata.requestId`, `.kind`, `.boardColumnId`, `.fileId` and
   * `.originalName` all survived — and then deletes the object. An
   * implementation that dropped the metadata at `complete()` would not fail
   * loudly; every large upload would simply be rejected as "The completed file
   * metadata is invalid" with the bytes already written and thrown away.
   */
  async function createMultipartUpload(
    key: string,
    putOptions: R2PutOptions = {},
  ): Promise<LocalR2MultipartUpload> {
    assertKey(key);
    const uploadId = newVersion();
    const sidecar: UploadSidecar = {
      key,
      uploadId,
      created: new Date().toISOString(),
      httpMetadata: normaliseHttpMetadata(putOptions.httpMetadata),
      customMetadata: normaliseCustomMetadata(putOptions.customMetadata),
    };
    await ensureDir(uploadDir(uploadId));
    await writeJsonAtomic(
      path.join(uploadDir(uploadId), "upload.json"),
      sidecar,
    );
    return multipartHandle(key, uploadId);
  }

  /**
   * Synchronous, like the real binding.
   *
   * `app/api/files/multipart/route.ts` does `const multipart = storage.resumeMultipartUpload(...)`
   * with no `await` and then calls `.abort()` / `.complete()` / `.uploadPart()`
   * on the result. Returning a promise here would make every one of those a
   * "not a function" at run time. R2 does no existence check at resume either —
   * an unknown id fails when it is used, not when it is named.
   */
  function resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): LocalR2MultipartUpload {
    assertKey(key);
    assertUploadId(uploadId);
    return multipartHandle(key, uploadId);
  }

  /**
   * Loads the session and proves it belongs to `key`.
   *
   * The key/id pair both arrive from the client. `validUploadKey` in the route
   * proves the KEY is inside the caller's own tenant prefix, and nothing proves
   * anything about the id — so without this check a caller could resume another
   * tenant's in-flight upload and complete its parts under a key of their own
   * choosing. Binding the two here is what makes the route's prefix check
   * actually mean something.
   */
  async function loadUpload(
    key: string,
    uploadId: string,
  ): Promise<UploadSidecar> {
    const sidecar = await readJson<UploadSidecar>(
      path.join(uploadDir(uploadId), "upload.json"),
    );
    if (!sidecar || sidecar.key !== key) {
      throw new Error("The specified multipart upload does not exist.");
    }
    return sidecar;
  }

  function multipartHandle(
    key: string,
    uploadId: string,
  ): LocalR2MultipartUpload {
    return {
      key,
      uploadId,

      async uploadPart(
        partNumber: number,
        value: R2PutValue,
      ): Promise<R2UploadedPart> {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          throw new Error("Part number must be between 1 and 10000.");
        }
        await loadUpload(key, uploadId);
        const target = partPath(uploadId, partNumber);
        const staged = await stage();
        const { size, md5 } = await writeBody(staged, value);
        await ensureDir(path.dirname(target));
        await fs.rename(staged, target);
        const part: PartSidecar = { partNumber, size, etag: md5 };
        await writeJsonAtomic(`${target}.json`, part);
        // The route JSON-encodes this straight back to the browser, which holds
        // it until `complete`. Exactly `{partNumber, etag}`, like R2UploadedPart.
        return { partNumber, etag: md5 };
      },

      /**
       * Concatenates the named parts and publishes them as the object.
       *
       * The etags are checked, not trusted. They make the round trip through the
       * browser (`client-upload.ts` collects each part's etag and posts the list
       * back), so treating them as decoration would mean a client could complete
       * an upload whose parts it never successfully sent and get a truncated
       * file recorded at the byte size it declared. R2 rejects a mismatch and so
       * does this — which is also the check that gives the route's
       * `byteSize !== completed.head.size` comparison something real to compare.
       */
      async complete(parts: R2UploadedPart[]): Promise<LocalR2Object> {
        const upload = await loadUpload(key, uploadId);
        if (!Array.isArray(parts) || parts.length === 0) {
          throw new Error("A multipart upload needs at least one part.");
        }
        const ordered = [...parts].sort(
          (left, right) => left.partNumber - right.partNumber,
        );
        const seen = new Set<number>();
        for (const part of ordered) {
          if (seen.has(part.partNumber)) {
            throw new Error(`Part ${part.partNumber} was listed twice.`);
          }
          seen.add(part.partNumber);
        }

        const resolved: PartSidecar[] = [];
        for (const part of ordered) {
          const stored = await readJson<PartSidecar>(
            `${partPath(uploadId, part.partNumber)}.json`,
          );
          if (!stored) {
            throw new Error(`Part ${part.partNumber} was never uploaded.`);
          }
          if (stored.etag !== part.etag.replace(/^"|"$/g, "")) {
            throw new Error(`Part ${part.partNumber} does not match its etag.`);
          }
          resolved.push(stored);
        }

        const blobFileName = `${sha256Hex(key)}.${newVersion()}.bin`;
        const staged = await stage();
        const sink = createWriteStream(staged);
        // Attached before the first write, so a filesystem error on the sink is
        // never an unhandled 'error' event — which in Node is a process exit,
        // not a rejected upload.
        const closed = finished(sink);
        let size = 0;
        // R2's multipart etag is the MD5 of the concatenated RAW part digests,
        // suffixed with the part count — not the MD5 of the assembled object.
        // Reproducing it matters because it is what a later integrity check or
        // a comparison against the Cloudflare-side copy would look at.
        const digestOfDigests = createHash("md5");

        /*
         * Hand-rolled rather than `pipeline(part, sink, { end: false })`.
         *
         * `pipeline` attaches error/close/finish/end listeners to its
         * destination and only removes them when that destination finishes —
         * which `end: false` deliberately prevents. One sink shared across the
         * parts therefore accumulates four listeners per part and warns past
         * ten: measured at 18 parts for a 90 MB video, and this route accepts up
         * to 100. The warning is cosmetic; the retained listeners are not.
         *
         * Writing by hand and awaiting `drain` keeps backpressure — the point of
         * streaming at all is that a 90 MB assembly never sits in the heap.
         */
        try {
          for (const part of resolved) {
            digestOfDigests.update(Buffer.from(part.etag, "hex"));
            size += part.size;
            for await (const chunk of createReadStream(
              partPath(uploadId, part.partNumber),
            )) {
              if (!sink.write(chunk)) await once(sink, "drain");
            }
          }
          sink.end();
          await closed;
        } catch (error) {
          sink.destroy();
          await unlinkQuietly(staged);
          throw error;
        }

        await ensureDir(shardDir(key));
        await fs.rename(staged, blobPath(key, blobFileName));
        const object = await commit(key, blobFileName, {
          size,
          etag: `${digestOfDigests.digest("hex")}-${resolved.length}`,
          httpMetadata: upload.httpMetadata,
          customMetadata: upload.customMetadata,
        });
        // The session is finished the moment the object is committed. Removing
        // it after the commit rather than before means a crash in between costs
        // a stale directory, not a lost object.
        await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
        return object;
      },

      /**
       * `abort()` on an upload that is already gone is a success.
       *
       * `client-upload.ts` aborts from its own `catch`, and the thing it is
       * catching may well be a `complete()` that half-succeeded. Turning that
       * into a second error would replace the real upload failure the user needs
       * to see with a meaningless one.
       */
      async abort(): Promise<void> {
        const sidecar = await readJson<UploadSidecar>(
          path.join(uploadDir(uploadId), "upload.json"),
        );
        if (sidecar && sidecar.key !== key) {
          throw new Error("The specified multipart upload does not exist.");
        }
        await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
      },
    };
  }

  return {
    put,
    get,
    head,
    delete: remove,
    list,
    createMultipartUpload,
    resumeMultipartUpload,
    get localDir() {
      return root;
    },
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Turns everything R2's `put` accepts into a Node stream, hashing on the way.
 *
 * The app hands over an `ArrayBuffer` (`file.arrayBuffer()` in the two upload
 * routes) and a `Uint8Array` (the thumbnail PUT), so only those two paths are
 * exercised today. The rest are here because `R2Bucket.put` accepts them and a
 * shim that threw on a `ReadableStream` would be a landmine for the first person
 * who streams an upload straight through instead of buffering it.
 */
async function toNodeReadable(
  value: R2PutValue,
  onChunk: (chunk: Buffer) => void,
): Promise<Readable> {
  if (value === null || value === undefined) {
    return Readable.from([]);
  }
  if (typeof value === "string") {
    return bufferSource(Buffer.from(value, "utf8"), onChunk);
  }
  if (value instanceof ArrayBuffer) {
    return bufferSource(Buffer.from(new Uint8Array(value)), onChunk);
  }
  if (ArrayBuffer.isView(value)) {
    return bufferSource(
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      onChunk,
    );
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return bufferSource(Buffer.from(await value.arrayBuffer()), onChunk);
  }
  if (typeof (value as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    return Readable.from(
      (async function* () {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) return;
          const buffer = Buffer.from(chunk);
          onChunk(buffer);
          yield buffer;
        }
      })(),
    );
  }
  throw new TypeError("Unsupported R2 put value.");
}

function bufferSource(
  buffer: Buffer,
  onChunk: (chunk: Buffer) => void,
): Readable {
  onChunk(buffer);
  return Readable.from(buffer.byteLength ? [buffer] : []);
}

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 *   - No `onlyIf` / conditional get, no `checksums` verification on put, no
 *     `storageClass`, no `R2MultipartUpload` listing, no presigned URLs. None of
 *     them appear at any call site in this app.
 *   - No fsync. A hard power loss between the write and the OS flushing it can
 *     lose a just-uploaded object even though the rename appeared to succeed.
 *     Managed volumes make this unlikely enough that paying a flush on every
 *     5 MB part is the worse trade.
 *   - No garbage collection. A crash between the blob rename and the sidecar
 *     rename strands a blob; an abandoned multipart session strands its parts.
 *     Both waste disk and neither is reachable through the API. A sweep would
 *     go here.
 *   - Single process only. `rename` makes concurrent writers safe against torn
 *     reads, but two processes racing on the same key still pick a winner
 *     arbitrarily, which is what R2 does too.
 * ---------------------------------------------------------------------------
 */
