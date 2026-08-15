/**
 * An R2 bucket backed by an S3-compatible endpoint — Supabase Storage.
 *
 * The legacy portal reaches file storage exactly one way: `await import("cloudflare:workers")`
 * then `env.BUCKET`. `db/node-r2.ts` supplies that binding from a directory on
 * disk. This file supplies the same binding from Supabase Storage's S3 endpoint,
 * so the portal's files live where the rest of Phase 2 lives instead of on a
 * volume that only one container can mount.
 *
 * WIRING IS TWO LINES, in `db/node-workers-env.ts`, and nothing anywhere else:
 *
 *     import { createS3BucketFromEnv } from "./r2-over-s3";
 *     export const env = { get DB() {...}, BUCKET: createS3BucketFromEnv() ?? createR2Bucket() };
 *
 * `createS3BucketFromEnv()` returns null unless ALL of S3_ENDPOINT, S3_BUCKET,
 * S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set, which is what makes that
 * `??` safe: a half-configured deployment falls back to the volume rather than
 * booting with a bucket that 403s every request. Same all-or-none rule as
 * `s3ConfigFromEnv()` in apps/api/src/lib/storage.ts, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT IMPORT apps/api/src/lib/storage.ts
 *
 * That file already contains a hand-rolled SigV4 signer and this one is built
 * from the same approach — path-style URLs, `awsUriEncode` rather than
 * `encodeURIComponent`, `node:crypto` rather than twenty megabytes of AWS SDK.
 * It is not imported because the two live in different stacks: `apps/api` is the
 * Phase 2 Hono API and this is the legacy Next portal's Workers shim. Importing
 * across would make the legacy portal's boot depend on the new API package
 * resolving, which is the coupling `db/node-r2.ts` deliberately avoids when it
 * says it imports nothing outside `node:`. The signing code is eighty lines; the
 * dependency would be permanent.
 *
 * Two differences from that signer are deliberate corrections, not drift:
 *
 *   1. The canonical query string is built from a sorted, AWS-encoded pair list
 *      rather than `url.searchParams.toString()`. `URLSearchParams` encodes a
 *      space as `+` and leaves `!'()*` alone; SigV4 wants `%20` and encodes them.
 *      That file only ever signs requests with no query at all, so it never hits
 *      it. This one signs `?uploads`, `?uploadId=…&partNumber=…` and
 *      `?list-type=2&prefix=…`, where a prefix containing a space would sign one
 *      string and send another.
 *   2. The canonical path is the string we built, and we assert the URL parser
 *      did not rewrite it. See `objectUrl` below.
 *
 * ---------------------------------------------------------------------------
 * WHY CUSTOM METADATA IS NOT JUST `x-amz-meta-<name>: <value>`
 *
 * This is the part that would break in production, silently, and it is worth
 * the paragraph.
 *
 * `completeMetadata()` in app/api/files/multipart/route.ts heads the key the
 * instant `complete()` returns and refuses the upload unless
 * `customMetadata.requestId`, `.kind`, `.boardColumnId`, `.fileId` and
 * `.originalName` all come back — then DELETES the object it just accepted. So
 * a metadata round trip that is merely close is worse than one that throws:
 * every large upload succeeds, is thrown away, and the user is told "The
 * completed file metadata is invalid."
 *
 * Three things break a naive mapping:
 *
 *   1. CASE. HTTP header names are case-insensitive and S3 returns user metadata
 *      lower-cased: `x-amz-meta-originalName` comes back as
 *      `x-amz-meta-originalname`. The app reads `metadata.originalName`. Every
 *      camelCase name the app uses — requestId, boardColumnId, fileId,
 *      originalName, organisationId, byteSize, uploadedBy — would arrive under a
 *      name it never looks up, and `!metadata.originalName` would be true for
 *      every single object.
 *   2. BYTES. `originalName` is the user's filename, up to 255 characters of
 *      arbitrary Unicode ("Façade survey.pdf", an emoji, a CJK name). Header
 *      values are effectively latin-1; undici throws on a non-ASCII value before
 *      the request leaves the process, so this is not a corruption bug but a
 *      hard failure on the first accented filename.
 *   3. WHITESPACE AND COMMAS. SigV4 canonicalisation trims header values and
 *      collapses runs of spaces, and repeated headers are folded on commas. A
 *      value with a leading space or a comma signs as one thing and is stored as
 *      another.
 *
 * So values are ALWAYS percent-encoded (RFC 3986 unreserved kept, everything
 * else `%XX` over UTF-8) — always, not "when needed", because "when needed"
 * makes decoding ambiguous the moment a filename legitimately contains a `%`.
 * The original, case-preserved names are written as one extra header,
 * `x-amz-meta-r2-names`, a percent-encoded comma-joined list in insertion order.
 * Its presence is also the flag that says "this object's values were written by
 * this module, decode them"; an object written by some other tool has no such
 * header and its metadata is read back verbatim under lower-cased names, which
 * is the best that can be said about it.
 *
 * `r2-names` is reserved. A caller passing a metadata name that lower-cases to
 * it is a hard error, because silently overwriting the name table would corrupt
 * every other name on the object.
 *
 * ---------------------------------------------------------------------------
 * WHY MULTIPART METADATA IS EASIER HERE THAN ON THE FILESYSTEM
 *
 * `db/node-r2.ts` has to park the metadata in the session directory and apply it
 * at `complete()`. S3 does not: metadata is supplied to CreateMultipartUpload
 * and the server holds it, so `resumeMultipartUpload(key, uploadId)` — which is
 * synchronous and is handed no metadata at all — can complete an upload it knows
 * nothing about and still produce an object with the right headers on it. That
 * is load-bearing for the route, which starts the upload in one request and
 * completes it in another.
 *
 * The cost is that CompleteMultipartUpload's response carries no size, and the
 * route compares `byteSize !== completed.head.size`. So `complete()` issues a
 * HEAD before returning. One extra round trip at the end of an upload that just
 * made N of them, in exchange for a `.size` that is true rather than guessed.
 */

import { createHash, createHmac } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* The shape of the R2 API this app uses.                                      */
/*                                                                             */
/* Declared here rather than imported from `db/node-r2.ts`, so that neither     */
/* driver can be deleted or moved without the other still compiling, and       */
/* rather than from `@cloudflare/workers-types`, which this project does not    */
/* install. Structural typing means this object satisfies the `R2Bucket`        */
/* annotations at every call site exactly as the filesystem one does.          */
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

export interface S3R2Object {
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

export interface S3R2ObjectBody extends S3R2Object {
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

export interface S3R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<S3R2Object>;
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
  objects: S3R2Object[];
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

export interface S3R2Bucket {
  put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<S3R2Object>;
  get(key: string, options?: R2GetOptions): Promise<S3R2ObjectBody | null>;
  head(key: string): Promise<S3R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  createMultipartUpload(
    key: string,
    options?: R2PutOptions,
  ): Promise<S3R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): S3R2MultipartUpload;
  /** Which bucket at which endpoint. Diagnostics only; not part of the R2 API. */
  readonly describe: string;
}

/* -------------------------------------------------------------------------- */
/* SigV4                                                                       */
/* -------------------------------------------------------------------------- */

export interface S3BucketOptions {
  /** e.g. `https://<ref>.supabase.co/storage/v1/s3` — no trailing slash needed. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Injected so every request this module builds can be asserted on with no
   * network and no credentials. There is no way to integration-test against
   * Supabase until S3 keys are issued in the dashboard, and "we will test it
   * when we deploy" is how a signing bug reaches production as every image
   * 403ing at once. Defaults to global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Clock, injected for the same reason: a signature is only reproducible
   * against a known-answer vector if the timestamp is.
   */
  now?: () => Date;
  /**
   * How many keys `delete([...])` removes at a time. See `remove()` for why
   * this is a sequential fan-out and not DeleteObjects.
   */
  deleteConcurrency?: number;
}

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * AWS's percent-encoding, which is not `encodeURIComponent`.
 *
 * The unreserved set is exactly A-Z a-z 0-9 - _ . ~; everything else is encoded
 * with UPPERCASE hex. `encodeURIComponent` leaves `!'()*` alone and emits
 * lowercase hex for nothing, but the difference on those five characters is
 * enough: a single character canonicalised differently from how S3 does it
 * changes the signature, and it fails on exactly the one filename that contains
 * it — which is the worst possible failure mode to debug.
 */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/**
 * The four-stage derived key. `service` is a parameter rather than the constant
 * `"s3"` purely so the test suite can drive AWS's published `iam` derivation
 * vector through the same code path the real requests use — a vector that is
 * only worth anything if it exercises production code.
 */
export function sigv4SigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service = "s3",
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service),
    "aws4_request",
  );
}

/** `20130524T000000Z` and `20130524`, the two forms SigV4 wants. */
export function sigv4Stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export type QueryPairs = Array<[string, string]>;

/**
 * The canonical query string: every pair AWS-encoded, then sorted by encoded
 * name (and by encoded value where names tie), joined with `&`, and a valueless
 * parameter written as `name=`.
 *
 * Built from a list rather than from `URLSearchParams` — see the header note.
 * `?uploads` MUST canonicalise to `uploads=`; a `URLSearchParams` round trip
 * happens to agree there and disagrees on a prefix containing a space.
 */
export function canonicalQueryString(pairs: QueryPairs): string {
  return pairs
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export interface SignInput {
  method: string;
  /** Already AWS-encoded, slashes intact. e.g. `/job-media/org_1/a%20b.jpg` */
  canonicalPath: string;
  host: string;
  query: QueryPairs;
  /** Lower-cased names. `host`, `x-amz-date`, `x-amz-content-sha256` are added. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
  now?: Date;
}

export interface SignedRequest {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Signs a request in its headers and returns the intermediates as well as the
 * headers.
 *
 * The intermediates are returned because they are what a known-answer test can
 * actually pin down. A test that only compares the final signature tells you
 * "wrong" and nothing else; comparing the canonical request first says whether
 * the fault is in canonicalisation or in the key derivation, and those are
 * different bugs in different places.
 */
export function signS3Request(input: SignInput): SignedRequest {
  const now = input.now ?? new Date();
  const service = input.service ?? "s3";
  const { amzDate, dateStamp } = sigv4Stamps(now);
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const all: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (value === undefined || value === null) continue;
    all[name.toLowerCase()] = value;
  }
  all.host = input.host;
  all["x-amz-content-sha256"] = input.payloadHash;
  all["x-amz-date"] = amzDate;

  const names = Object.keys(all).sort();
  // Values are trimmed, exactly as the specification says the canonical form
  // is. This is also why metadata values are percent-encoded before they get
  // here: a value whose meaning depends on a leading space cannot survive it.
  const canonicalHeaders = names
    .map((name) => `${name}:${String(all[name]).trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method,
    input.canonicalPath,
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(
    sigv4SigningKey(input.secretAccessKey, dateStamp, input.region, service),
    stringToSign,
  ).toString("hex");

  return {
    headers: {
      ...all,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/* -------------------------------------------------------------------------- */
/* Custom metadata encoding                                                    */
/* -------------------------------------------------------------------------- */

/** The header holding the original, case-preserved metadata names. Reserved. */
export const META_NAMES_HEADER = "x-amz-meta-r2-names";
const META_NAMES_KEY = "r2-names";
const META_PREFIX = "x-amz-meta-";

/**
 * Percent-encodes everything outside the RFC 3986 unreserved set.
 *
 * Deliberately the same function as `awsUriEncode` rather than
 * `encodeURIComponent`: one encoder for the whole file means a value cannot be
 * encoded one way into a header and decoded another way out of it, and the
 * uppercase-hex form is what the signer already agrees with.
 */
const encodeMetaValue = (value: string): string => awsUriEncode(value, true);

const decodeMetaValue = (value: string): string => {
  // `decodeURIComponent` is the exact inverse of the encoder above for every
  // sequence the encoder can emit. A malformed sequence — which can only come
  // from an object this module did not write — is returned verbatim rather than
  // throwing, because a URIError here would turn one bad legacy object into a
  // 503 for the whole request.
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * `{originalName: "Façade survey.pdf"}` becomes the headers that carry it.
 *
 * Names must be HTTP tokens. A name that is not one has no representation in S3
 * at all, and encoding it would mean the name coming back is not the name that
 * went in — which the app compares. Every name the portal uses today
 * (requestId, organisationId, kind, boardColumnId, fileId, originalName,
 * contentType, byteSize, uploadedBy) is a plain camelCase identifier, so this
 * throws on nothing that exists and refuses loudly if that ever changes.
 */
export function encodeCustomMetadata(
  custom: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!custom) return headers;
  const names: string[] = [];
  for (const [name, value] of Object.entries(custom)) {
    if (value === undefined || value === null) continue;
    if (!/^[A-Za-z0-9!#$&'*+\-.^_`|~]+$/.test(name)) {
      throw new TypeError(
        `Custom metadata name ${JSON.stringify(name)} is not an HTTP token and cannot be stored in S3.`,
      );
    }
    const lower = name.toLowerCase();
    if (lower === META_NAMES_KEY) {
      throw new TypeError(
        `Custom metadata name ${JSON.stringify(name)} is reserved by the S3 bucket driver.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(headers, META_PREFIX + lower)) {
      // Two names differing only in case collapse into one header. R2 would
      // have kept both; S3 cannot, and quietly dropping one is data loss.
      throw new TypeError(
        `Custom metadata names ${JSON.stringify(name)} and its case-variant cannot both be stored in S3.`,
      );
    }
    headers[META_PREFIX + lower] = encodeMetaValue(String(value));
    names.push(name);
  }
  if (names.length) {
    headers[META_NAMES_HEADER] = names.map(encodeMetaValue).join(",");
  }
  return headers;
}

/**
 * The inverse, reading from a response's headers.
 *
 * With `r2-names` present, names are restored to the case they were written in
 * and values are decoded. Without it — an object some other tool wrote — the
 * lower-cased names and raw values are returned, which is all the information
 * there is.
 */
export function decodeCustomMetadata(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const read = (name: string): string | null =>
    headers instanceof Headers
      ? headers.get(name)
      : (headers[name] ?? headers[name.toLowerCase()] ?? null);

  const raw: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      if (name.toLowerCase().startsWith(META_PREFIX)) {
        raw[name.toLowerCase().slice(META_PREFIX.length)] = value;
      }
    });
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase().startsWith(META_PREFIX)) {
        raw[name.toLowerCase().slice(META_PREFIX.length)] = value;
      }
    }
  }

  const nameList = read(META_NAMES_HEADER);
  if (nameList === null) {
    delete raw[META_NAMES_KEY];
    return raw;
  }
  delete raw[META_NAMES_KEY];

  const custom: Record<string, string> = {};
  for (const encodedName of nameList.split(",")) {
    if (!encodedName) continue;
    const name = decodeMetaValue(encodedName);
    const value = raw[name.toLowerCase()];
    // A name listed with no header behind it means the object was truncated or
    // rewritten. Skipping it rather than inventing an empty string is what lets
    // `completeMetadata()` notice and refuse the upload.
    if (value === undefined) continue;
    custom[name] = decodeMetaValue(value);
    delete raw[name.toLowerCase()];
  }
  // Anything left over was written by something else. Keep it — dropping
  // metadata during a read is never the helpful choice.
  for (const [name, value] of Object.entries(raw)) custom[name] = value;
  return custom;
}

/* -------------------------------------------------------------------------- */
/* http metadata                                                               */
/* -------------------------------------------------------------------------- */

/**
 * R2 has six httpMetadata fields; S3 stores five of them as the corresponding
 * response headers and has no home for `cacheExpiry`, which is an R2 invention.
 * It is dropped rather than smuggled into custom metadata: a value that comes
 * back from a different place than it went into is worse than one that is
 * honestly absent, and nothing in this app sets it.
 */
const HTTP_METADATA_HEADERS: Array<[keyof R2HttpMetadata, string]> = [
  ["contentType", "content-type"],
  ["contentLanguage", "content-language"],
  ["contentDisposition", "content-disposition"],
  ["contentEncoding", "content-encoding"],
  ["cacheControl", "cache-control"],
];

export function encodeHttpMetadata(
  meta: R2HttpMetadata | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!meta) return headers;
  for (const [field, header] of HTTP_METADATA_HEADERS) {
    const value = meta[field];
    if (value === undefined || value === null || value === "") continue;
    headers[header] = String(value);
  }
  return headers;
}

function decodeHttpMetadata(headers: Headers): R2HttpMetadata {
  const meta: R2HttpMetadata = {};
  for (const [field, header] of HTTP_METADATA_HEADERS) {
    const value = headers.get(header);
    if (value === null) continue;
    (meta as Record<string, unknown>)[field] = value;
  }
  return meta;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

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
 * The upload id arrives from the browser — `POST /api/files/multipart` and its
 * `PUT` sibling take it straight off the request body and validate only the KEY
 * prefix. Unlike `db/node-r2.ts` it cannot be pinned to 32 hex characters,
 * because an S3 upload id is an opaque server-issued string whose alphabet is
 * not ours to decide. What it CAN be pinned to is "printable, bounded, and
 * AWS-encoded before it reaches a query string", which is what stops it from
 * being a request-splitting or path-injection vector.
 *
 * The key/id pairing is not checked here and does not need to be: S3 scopes an
 * upload id to the key it was created against, so resuming another tenant's
 * upload under a key of your own choosing gets NoSuchUpload from the server.
 * That is the same protection `loadUpload()` hand-rolls in the filesystem
 * driver, enforced one layer down.
 */
function assertUploadId(uploadId: string): string {
  if (
    typeof uploadId !== "string" ||
    uploadId.length === 0 ||
    uploadId.length > 1024 ||
    /[\x00-\x20\x7f]/.test(uploadId)
  ) {
    throw new Error("Invalid multipart upload id.");
  }
  return uploadId;
}

const unquote = (etag: string): string => etag.replace(/^"|"$/g, "");

/** `Content-Range: bytes 0-9/2048` -> 2048. Null when absent or unparseable. */
function totalFromContentRange(value: string | null): number | null {
  const match = value?.match(/^bytes\s+\d+-\d+\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** First `<tag>…</tag>` in `xml`, unescaped. Null when the tag is absent. */
export function xmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? xmlUnescape(match[1]) : null;
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1],
  );
}

/**
 * Everything R2's `put` accepts, as bytes.
 *
 * SigV4 needs the SHA-256 of the payload before the request is sent, so a body
 * cannot be streamed without either buffering it or falling back to
 * UNSIGNED-PAYLOAD. It is buffered, and that is a deliberate ceiling rather than
 * an oversight: `put()` is for whole objects the app already holds in memory
 * (`file.arrayBuffer()` in the upload routes, a Uint8Array for the thumbnail
 * PUT), and anything big enough for the buffering to matter is what
 * `createMultipartUpload` exists for — there the ceiling is one part, not one
 * file.
 */
async function toBytes(value: R2PutValue): Promise<Uint8Array> {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value, "utf8"));
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof (value as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new TypeError("Unsupported R2 put value.");
}

/* -------------------------------------------------------------------------- */
/* The bucket                                                                  */
/* -------------------------------------------------------------------------- */

export function createS3Bucket(options: S3BucketOptions): S3R2Bucket {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const base = new URL(endpoint);
  const { bucket, region, accessKeyId, secretAccessKey } = options;
  const doFetch = options.fetch ?? fetch;
  const clock = options.now ?? (() => new Date());
  const deleteConcurrency = Math.max(1, options.deleteConcurrency ?? 8);

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new TypeError(
      "createS3Bucket needs endpoint, bucket, region, accessKeyId and secretAccessKey.",
    );
  }

  /**
   * Path style, not virtual-host style: Supabase Storage's S3 endpoint is
   * `https://<ref>.supabase.co/storage/v1/s3` and the bucket is a path segment.
   * Rewriting it into the hostname would reach a domain that does not resolve.
   *
   * The canonical path is the string built here, and the URL handed to `fetch`
   * is built from the same string. They can disagree in exactly one way: a key
   * containing a `.` or `..` segment survives `awsUriEncode` (both are in the
   * unreserved set) and the URL parser then collapses it, so the request would
   * go to a different path than the one that was signed. R2 permits such keys,
   * so this is reachable rather than theoretical — `validUploadKey` in the
   * multipart route checks a prefix and a length and nothing else. Detecting it
   * and throwing turns an unexplainable SignatureDoesNotMatch into a named
   * error at the call site.
   */
  function objectPath(key: string): string {
    return `${base.pathname.replace(/\/+$/, "")}/${awsUriEncode(bucket)}/${awsUriEncode(key, false)}`;
  }

  function bucketPath(): string {
    return `${base.pathname.replace(/\/+$/, "")}/${awsUriEncode(bucket)}`;
  }

  function urlFor(canonicalPath: string, query: QueryPairs): string {
    const url = `${base.origin}${canonicalPath}`;
    if (new URL(url).pathname !== canonicalPath) {
      throw new Error(
        `Refusing an object key whose path is rewritten by URL normalisation: ${canonicalPath}`,
      );
    }
    const qs = canonicalQueryString(query);
    return qs ? `${url}?${qs}` : url;
  }

  interface SendInput {
    method: string;
    canonicalPath: string;
    query?: QueryPairs;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }

  async function send(input: SendInput): Promise<Response> {
    const query = input.query ?? [];
    const payloadHash = input.body ? sha256Hex(input.body) : EMPTY_SHA256;
    const signed = signS3Request({
      method: input.method,
      canonicalPath: input.canonicalPath,
      host: base.host,
      query,
      headers: input.headers ?? {},
      payloadHash,
      region,
      accessKeyId,
      secretAccessKey,
      now: clock(),
    });
    return doFetch(urlFor(input.canonicalPath, query), {
      method: input.method,
      headers: signed.headers,
      ...(input.body ? { body: input.body as unknown as BodyInit } : {}),
    });
  }

  /**
   * The body of an S3 error is XML naming the actual cause — expired
   * credentials, wrong region, a bucket file-size limit. Losing it turns every
   * storage failure into the same unhelpful 500, which is exactly the state
   * this port is trying to leave behind.
   */
  async function fail(operation: string, response: Response): Promise<never> {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      /* A HEAD has no body; the status is the whole message. */
    }
    throw new Error(`S3 ${operation} ${response.status}: ${detail}`);
  }

  function toObject(
    key: string,
    headers: Headers,
    overrides: { size?: number; etag?: string } = {},
  ): S3R2Object {
    const httpMetadata = decodeHttpMetadata(headers);
    const etag = unquote(overrides.etag ?? headers.get("etag") ?? "");
    const lastModified = headers.get("last-modified");
    const size =
      overrides.size ??
      totalFromContentRange(headers.get("content-range")) ??
      Number(headers.get("content-length") ?? 0);
    return {
      key,
      // S3 versioning is off on a Supabase bucket, so there is no version id to
      // report. The etag is the only per-write identifier there is, and it is
      // what the app would compare if it ever compared anything.
      version: headers.get("x-amz-version-id") ?? etag,
      size,
      etag,
      httpEtag: `"${etag}"`,
      uploaded: lastModified ? new Date(lastModified) : new Date(0),
      httpMetadata,
      customMetadata: decodeCustomMetadata(headers),
      // A multipart etag is not an MD5 and must not be reported as one; a
      // single-shot etag is. R2 draws the same line.
      checksums: etag && !etag.includes("-") ? { md5: etag } : {},
      storageClass: headers.get("x-amz-storage-class") ?? "STANDARD",
      /**
       * `GET /api/files/[id]` calls this first and then deliberately overwrites
       * Content-Type, Content-Disposition and Cache-Control, because the stored
       * type came from the uploader and is not trusted for rendering. Only the
       * fields that route does not set survive from here — but it must still
       * set what R2 sets, or a future caller relying on it gets nothing.
       */
      writeHttpMetadata(target: Headers) {
        if (httpMetadata.contentType) target.set("Content-Type", httpMetadata.contentType);
        if (httpMetadata.contentLanguage) {
          target.set("Content-Language", httpMetadata.contentLanguage);
        }
        if (httpMetadata.contentDisposition) {
          target.set("Content-Disposition", httpMetadata.contentDisposition);
        }
        if (httpMetadata.contentEncoding) {
          target.set("Content-Encoding", httpMetadata.contentEncoding);
        }
        if (httpMetadata.cacheControl) {
          target.set("Cache-Control", httpMetadata.cacheControl);
        }
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* put / head / get / delete                                               */
  /* ---------------------------------------------------------------------- */

  async function put(
    key: string,
    value: R2PutValue,
    putOptions: R2PutOptions = {},
  ): Promise<S3R2Object> {
    assertKey(key);
    const body = await toBytes(value);
    const headers = {
      ...encodeHttpMetadata(putOptions.httpMetadata),
      ...encodeCustomMetadata(putOptions.customMetadata),
    };
    const response = await send({
      method: "PUT",
      canonicalPath: objectPath(key),
      headers,
      body,
    });
    if (!response.ok) await fail("PUT", response);
    // Drain the (empty) body so the connection is returned to the pool rather
    // than held open until GC. undici keeps a socket per undrained response.
    await response.arrayBuffer().catch(() => undefined);
    return toObject(key, response.headers, { size: body.byteLength });
  }

  /**
   * A missing object is `null`, not an exception.
   *
   * `GET /api/files/[id]` distinguishes "no thumbnail, fall back to the
   * original" from "the bucket is broken" purely by that, and turning a 404
   * into a throw would turn a missing derivative into a 503 for a photograph
   * that is perfectly present. 403 is folded in with it because an S3 endpoint
   * is entitled to answer a HEAD for a key you cannot see with either.
   */
  async function head(key: string): Promise<S3R2Object | null> {
    assertKey(key);
    const response = await send({ method: "HEAD", canonicalPath: objectPath(key) });
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) await fail("HEAD", response);
    return toObject(key, response.headers);
  }

  function rangeHeader(range: R2Range): string | null {
    if (typeof range.suffix === "number") {
      if (range.suffix <= 0) return null;
      return `bytes=-${Math.floor(range.suffix)}`;
    }
    const offset = typeof range.offset === "number" ? Math.floor(range.offset) : 0;
    if (offset < 0) return null;
    if (typeof range.length !== "number") return `bytes=${offset}-`;
    const length = Math.floor(range.length);
    if (length <= 0) return null;
    return `bytes=${offset}-${offset + length - 1}`;
  }

  async function get(
    key: string,
    getOptions: R2GetOptions = {},
  ): Promise<S3R2ObjectBody | null> {
    assertKey(key);
    const headers: Record<string, string> = {};
    let wantsRange = false;
    if (getOptions.range) {
      const value = rangeHeader(getOptions.range);
      /*
       * A zero-length range is an empty body, not a read. R2 answers
       * `{offset: 5, length: 0}` against a 5-byte object with an empty body;
       * there is no HTTP Range that expresses it, and `bytes=5-4` is a 416. So
       * it is answered here, without a request, by heading the key for the size
       * and metadata and handing back an empty stream.
       */
      if (value === null) {
        const meta = await head(key);
        if (!meta) return null;
        return withBody(meta, new Blob([]).stream(), { offset: 0, length: 0 });
      }
      headers.range = value;
      wantsRange = true;
    }
    const response = await send({
      method: "GET",
      canonicalPath: objectPath(key),
      headers,
    });
    if (response.status === 404 || response.status === 403) return null;
    // 416 is "that range does not exist", which R2 reports as a null get and
    // `GET /api/files/[id]` turns into its own 416 rather than a 503.
    if (response.status === 416) return null;
    if (!response.ok) await fail("GET", response);

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const total = totalFromContentRange(response.headers.get("content-range"));
    // R2 reports the FULL object size in `.size` even on a ranged read and puts
    // the served span in `.range`. `GET /api/files/[id]` relies on exactly that:
    // it sets Content-Length from `range?.length ?? object.size`.
    const object = toObject(key, response.headers, {
      size: total ?? contentLength,
    });
    const range =
      wantsRange && total !== null
        ? {
            offset: Number(
              /^bytes\s+(\d+)-/.exec(response.headers.get("content-range") ?? "")?.[1] ??
                0,
            ),
            length: contentLength,
          }
        : undefined;
    return withBody(object, response.body ?? new Blob([]).stream(), range);
  }

  function withBody(
    object: S3R2Object,
    stream: ReadableStream<Uint8Array>,
    range?: { offset: number; length: number },
  ): S3R2ObjectBody {
    let used = false;
    const open = (): ReadableStream<Uint8Array> => {
      used = true;
      return stream;
    };
    /*
     * A detached copy of the body, as a local function rather than
     * `this.arrayBuffer()`: these methods are on a plain object literal, so a
     * caller who destructures (`const { blob } = object`) would lose the
     * receiver and get a TypeError from a method that looked fine everywhere it
     * was tested.
     */
    const bodyArrayBuffer = async (): Promise<ArrayBuffer> => {
      const chunks: Buffer[] = [];
      const reader = open().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      const buffer = Buffer.concat(chunks);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
    };
    return {
      ...object,
      ...(range ? { range } : {}),
      get body() {
        return open();
      },
      get bodyUsed() {
        return used;
      },
      arrayBuffer: bodyArrayBuffer,
      async text() {
        return Buffer.from(await bodyArrayBuffer()).toString("utf8");
      },
      async json<T = unknown>() {
        return JSON.parse(Buffer.from(await bodyArrayBuffer()).toString("utf8")) as T;
      },
      async blob() {
        return new Blob([await bodyArrayBuffer()]);
      },
    };
  }

  /**
   * Sequential DELETEs with a small fan-out, NOT the DeleteObjects batch API.
   *
   * Three reasons, in order of weight. DeleteObjects requires a Content-MD5 (or
   * an x-amz-checksum) over the request body and returns per-key results in a
   * 200 that may contain errors — two extra ways to be subtly wrong against an
   * endpoint we cannot test. Supabase's S3 compatibility layer does not document
   * DeleteObjects at all, so it may simply 501. And the callers are
   * `purgeJob` in the trash route and `deleteFilesForColumn` in the board route
   * — a nightly sweep and a column edit, neither of them latency-critical.
   *
   * Deleting a key that is not there is a success, in R2 and here: both of those
   * callers hand over every key a query returned, including keys whose bytes an
   * earlier pass already removed, and throwing on the second pass would wedge
   * the thirty-day bin sweep. S3's DELETE is already idempotent, so this is a
   * property inherited rather than implemented — but a non-2xx that is not a 404
   * still throws, because "the credentials expired" must not look like "it was
   * already gone".
   */
  async function remove(keys: string | string[]): Promise<void> {
    const list = (Array.isArray(keys) ? keys : [keys]).map(assertKey);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= list.length) return;
        const response = await send({
          method: "DELETE",
          canonicalPath: objectPath(list[index]),
        });
        if (!response.ok && response.status !== 404) {
          await fail("DELETE", response);
        }
        await response.arrayBuffer().catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(deleteConcurrency, list.length) }, worker),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* list — operations only                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Not called anywhere in the app, and here for the same reason `list()` is in
   * `db/node-r2.ts`: a migration off Miniflare, a check for objects the database
   * has forgotten, and "is anything actually in this bucket" all want it, and
   * without it the only way to answer is to re-implement ListObjectsV2 outside
   * this file.
   */
  async function list(listOptions: R2ListOptions = {}): Promise<R2Objects> {
    const query: QueryPairs = [["list-type", "2"]];
    if (listOptions.prefix) query.push(["prefix", listOptions.prefix]);
    if (listOptions.delimiter) query.push(["delimiter", listOptions.delimiter]);
    if (listOptions.cursor) query.push(["continuation-token", listOptions.cursor]);
    else if (listOptions.startAfter) query.push(["start-after", listOptions.startAfter]);
    query.push([
      "max-keys",
      String(Math.min(Math.max(listOptions.limit ?? 1000, 1), 1000)),
    ]);

    const response = await send({
      method: "GET",
      canonicalPath: bucketPath(),
      query,
    });
    if (!response.ok) await fail("GET (list)", response);
    const xml = await response.text();

    const objects: S3R2Object[] = xmlBlocks(xml, "Contents").map((block) => {
      const key = xmlTag(block, "Key") ?? "";
      const headers = new Headers();
      const etag = xmlTag(block, "ETag");
      if (etag) headers.set("etag", etag);
      const modified = xmlTag(block, "LastModified");
      if (modified) headers.set("last-modified", new Date(modified).toUTCString());
      // ListObjectsV2 never returns user metadata or content type. Reporting an
      // empty `customMetadata` is honest; synthesising one would let a caller
      // believe a listing can stand in for a HEAD, and it cannot.
      return toObject(key, headers, { size: Number(xmlTag(block, "Size") ?? 0) });
    });

    return {
      objects,
      truncated: xmlTag(xml, "IsTruncated") === "true",
      delimitedPrefixes: xmlBlocks(xml, "CommonPrefixes").map(
        (block) => xmlTag(block, "Prefix") ?? "",
      ),
      ...(xmlTag(xml, "NextContinuationToken")
        ? { cursor: xmlTag(xml, "NextContinuationToken") as string }
        : {}),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Multipart                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The metadata handed here belongs to the FINISHED object, and in S3 it is
   * attached at CREATE time — not at complete, the way the filesystem driver has
   * to. That is what makes `resumeMultipartUpload`, which is handed no metadata
   * at all, able to produce a correctly-tagged object: the server has been
   * holding it since this request.
   *
   * Which also means this is the ONLY place the metadata can be got right. If
   * these headers are missing or mis-encoded, every large upload completes, is
   * head-checked by `completeMetadata()`, fails the check, and is deleted — with
   * the bytes already paid for and the user told the file was invalid.
   */
  async function createMultipartUpload(
    key: string,
    putOptions: R2PutOptions = {},
  ): Promise<S3R2MultipartUpload> {
    assertKey(key);
    const response = await send({
      method: "POST",
      canonicalPath: objectPath(key),
      query: [["uploads", ""]],
      headers: {
        ...encodeHttpMetadata(putOptions.httpMetadata),
        ...encodeCustomMetadata(putOptions.customMetadata),
      },
      body: new Uint8Array(0),
    });
    if (!response.ok) await fail("POST ?uploads", response);
    const xml = await response.text();
    const uploadId = xmlTag(xml, "UploadId");
    if (!uploadId) {
      throw new Error(
        `S3 CreateMultipartUpload returned no UploadId: ${xml.slice(0, 300)}`,
      );
    }
    return multipartHandle(key, assertUploadId(uploadId));
  }

  /**
   * Synchronous, like the real binding.
   *
   * `app/api/files/multipart/route.ts` does
   * `const multipart = storage.resumeMultipartUpload(...)` with no `await` and
   * then calls `.abort()` / `.complete()` / `.uploadPart()` on the result.
   * Returning a promise here would make every one of those a "not a function"
   * at run time. R2 does no existence check at resume either — an unknown id
   * fails when it is used, not when it is named — and neither does this, which
   * is just as well because there is no S3 call that would perform one.
   */
  function resumeMultipartUpload(key: string, uploadId: string): S3R2MultipartUpload {
    assertKey(key);
    assertUploadId(uploadId);
    return multipartHandle(key, uploadId);
  }

  function multipartHandle(key: string, uploadId: string): S3R2MultipartUpload {
    return {
      key,
      uploadId,

      async uploadPart(partNumber: number, value: R2PutValue): Promise<R2UploadedPart> {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          throw new Error("Part number must be between 1 and 10000.");
        }
        const body = await toBytes(value);
        const response = await send({
          method: "PUT",
          canonicalPath: objectPath(key),
          query: [
            ["partNumber", String(partNumber)],
            ["uploadId", uploadId],
          ],
          body,
        });
        if (!response.ok) await fail("PUT part", response);
        await response.arrayBuffer().catch(() => undefined);
        const etag = response.headers.get("etag");
        if (!etag) throw new Error(`S3 UploadPart ${partNumber} returned no ETag.`);
        // Unquoted, matching `R2UploadedPart.etag` and the filesystem driver.
        // The route JSON-encodes this straight back to the browser, which holds
        // it until `complete`, so the quoting has to be decided once here rather
        // than differ between the two drivers.
        return { partNumber, etag: unquote(etag) };
      },

      /**
       * The parts come back through the BROWSER — `client-upload.ts` collects
       * each part's etag and posts the list back — so they are re-quoted and
       * handed to S3, which is the thing that actually verifies them. R2 rejects
       * a mismatch and so does S3; that rejection is what gives the route's
       * `byteSize !== completed.head.size` comparison something real to compare.
       */
      async complete(parts: R2UploadedPart[]): Promise<S3R2Object> {
        if (!Array.isArray(parts) || parts.length === 0) {
          throw new Error("A multipart upload needs at least one part.");
        }
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        const seen = new Set<number>();
        for (const part of ordered) {
          if (seen.has(part.partNumber)) {
            throw new Error(`Part ${part.partNumber} was listed twice.`);
          }
          seen.add(part.partNumber);
        }
        const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${ordered
          .map(
            (part) =>
              `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(
                `"${unquote(String(part.etag))}"`,
              )}</ETag></Part>`,
          )
          .join("")}</CompleteMultipartUpload>`;

        const response = await send({
          method: "POST",
          canonicalPath: objectPath(key),
          query: [["uploadId", uploadId]],
          headers: { "content-type": "application/xml" },
          body: new Uint8Array(Buffer.from(xmlBody, "utf8")),
        });
        if (!response.ok) await fail("POST complete", response);
        const text = await response.text();
        /*
         * S3's famous 200-with-an-error: CompleteMultipartUpload holds the
         * connection open while it assembles, so it has already sent 200 by the
         * time it can fail, and reports the failure in the body. Trusting
         * `response.ok` here would record an attachment row for an object that
         * does not exist, and the only symptom would be a broken image weeks
         * later.
         */
        if (/<Error[\s>]/.test(text)) {
          throw new Error(
            `S3 CompleteMultipartUpload returned an error body: ${text.slice(0, 300)}`,
          );
        }

        /*
         * HEAD, because the completion response carries no size and the route
         * compares `byteSize !== completed.head.size`. One round trip after N
         * part uploads, in exchange for a `.size` that is measured rather than
         * assumed — and it is also the first moment the metadata attached at
         * create time can be observed, which is the check that matters most.
         */
        const object = await head(key);
        if (!object) {
          throw new Error(
            "S3 CompleteMultipartUpload succeeded but the object is not readable.",
          );
        }
        return object;
      },

      /**
       * `abort()` on an upload that is already gone is a success.
       *
       * `client-upload.ts` aborts from its own `catch`, and the thing it is
       * catching may well be a `complete()` that half-succeeded. Turning that
       * into a second error would replace the real upload failure the user needs
       * to see with a meaningless one — so NoSuchUpload (404) is swallowed here
       * exactly as the filesystem driver swallows a missing session directory.
       */
      async abort(): Promise<void> {
        const response = await send({
          method: "DELETE",
          canonicalPath: objectPath(key),
          query: [["uploadId", uploadId]],
        });
        if (!response.ok && response.status !== 404) {
          await fail("DELETE ?uploadId", response);
        }
        await response.arrayBuffer().catch(() => undefined);
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
    get describe() {
      return `${endpoint}/${bucket} (${region})`;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The bucket described by the environment, or null.
 *
 * All four of endpoint/bucket/key/secret or none. A half-configured bucket that
 * silently fell back to the local volume would write a deployment's photographs
 * onto a container disk, and nobody would find out until the container was
 * replaced. Same rule and same wording as `s3ConfigFromEnv()` in
 * apps/api/src/lib/storage.ts, so the two stacks fail identically.
 *
 * `S3_REGION` defaults to eu-west-2, which is where the `job-media` bucket is.
 * A wrong region is not a routing error on Supabase — the endpoint is the same
 * host either way — it is a SignatureDoesNotMatch on every request, so the
 * default has to be the real one rather than AWS's us-east-1.
 */
export function createS3BucketFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3R2Bucket | null {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return createS3Bucket({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.S3_REGION?.trim() || "eu-west-2",
  });
}

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 *   - No `onlyIf` / conditional get, no checksum verification on put, no
 *     storage classes, no presigned URLs. None appear at any call site in the
 *     legacy portal. (apps/api/src/lib/storage.ts presigns; that is the other
 *     stack and the other file.)
 *   - No `cacheExpiry`. R2 has it, S3 does not, and nothing here sets it.
 *   - No DeleteObjects. See `remove()`.
 *   - No retry and no backoff. A 500 or a 503 from the endpoint surfaces to the
 *     route, which answers 503, which is the honest state. Retries belong here
 *     eventually, but a retry loop written against an endpoint nobody has ever
 *     reached is a guess about which failures are transient.
 *   - Nothing here has been run against a real Supabase bucket. S3 access keys
 *     had not been issued when it was written, so every assertion about it is a
 *     request-construction assertion. See scripts/README-storage-migration.md.
 * ---------------------------------------------------------------------------
 */
