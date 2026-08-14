/**
 * One storage interface, two drivers.
 *
 * The same shape as packages/db/src/client.ts, for the same reason: local
 * development must work with nothing installed and no cloud account, and the
 * code above this file must not be able to tell which driver it got. A route
 * that works against the filesystem works against Supabase Storage.
 *
 * Chosen by environment: set S3_ENDPOINT + S3_BUCKET + the two keys and you get
 * the S3 driver, leave them unset and you get the filesystem. There is no third
 * mode and no in-memory fake — a store that accepts everything and returns
 * nothing is how "the photographs are gone" reaches production.
 *
 * TWO RULES HOLD ON BOTH DRIVERS, and they are the whole security model:
 *
 *   1. The bucket is PRIVATE. Nothing is readable by URL alone. `attachments`
 *      stores an `object_key`, never a URL, so a leaked database row — a stray
 *      log line, a backup, a screenshot of a query — is not a leaked
 *      photograph of the inside of a client's shop.
 *   2. Reads go through a SHORT-LIVED signed URL. Five minutes, long enough for
 *      a page of thumbnails to load and short enough that a URL pasted into a
 *      chat is dead before anyone clicks it.
 *
 * The S3 driver is deliberately hand-rolled against `fetch` and `node:crypto`.
 * SigV4 is about eighty lines; @aws-sdk/client-s3 is roughly twenty megabytes
 * of dependency to send four HTTP requests, and Supabase's own SDK would tie
 * this file to one vendor when the point of speaking S3 is that it does not.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** How long a signed read URL lives. Short on purpose — see rule 2 above. */
export const SIGNED_URL_TTL_SECONDS = 300;

export interface Storage {
  readonly backend: "local" | "s3";
  /** Writes an object. Overwrites, because object keys are freshly minted uuids. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A URL that reads this object and stops working after `ttlSeconds`. */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * Bytes back into the process.
   *
   * Not in the brief's three, and load-bearing anyway: the download route
   * streams from here, which is what lets the API apply an access check to a
   * read. Without it the only way to serve a file is to hand the browser a URL
   * that bypasses the API entirely.
   */
  get(key: string): Promise<Uint8Array | null>;
}

/* ------------------------------------------------------------ object keys -- */

/*
 * Keys are minted by this API (`<prefix>/<uuid>.<ext>`), never accepted from a
 * caller. This is the belt to that braces: a key reaching a driver is checked
 * against the shape we generate, so a traversal sequence cannot become a write
 * outside the storage directory even if a future route is careless about where
 * its key came from.
 */
const KEY_SHAPE = /^[a-z0-9][a-z0-9/._-]{0,300}$/i;

export function assertSafeKey(key: string): void {
  if (!KEY_SHAPE.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Refusing an unsafe object key.");
  }
}

/* ------------------------------------------------- HMAC-signed read tokens -- */

let cachedSecret: Buffer | undefined;

/**
 * The key that signs local read tokens.
 *
 * With no `UPLOAD_SIGNING_SECRET` it is random per process, which means old
 * links stop working on restart. That is the right default for development and
 * the wrong one for production, so production says so out loud rather than
 * quietly falling back to a constant compiled into the repository — a shipped
 * default secret is not a secret.
 */
function signingSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.UPLOAD_SIGNING_SECRET?.trim();
  if (configured) {
    cachedSecret = createHash("sha256").update(configured).digest();
  } else {
    cachedSecret = randomBytes(32);
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[storage] UPLOAD_SIGNING_SECRET is unset — signed file links will " +
          "break on every restart and will not survive more than one instance.",
      );
    }
  }
  return cachedSecret;
}

const b64url = (value: Buffer | string): string =>
  Buffer.from(value as never).toString("base64url");

/**
 * Mints `<expiry>.<key>.<mac>` for the API's own download route.
 *
 * The expiry is inside the signed material, so moving it forward invalidates
 * the signature — a bearer token that cannot be extended by editing it.
 */
export function signObjectToken(key: string, ttlSeconds: number): string {
  assertSafeKey(key);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  const payload = `${expiresAt}.${b64url(key)}`;
  const mac = createHmac("sha256", signingSecret()).update(payload).digest();
  return `${payload}.${b64url(mac)}`;
}

/** The key this token grants, or null. Never throws — a bad token is a 403. */
export function verifyObjectToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [expiry, encodedKey, signature] = parts;

  const expected = createHmac("sha256", signingSecret())
    .update(`${expiry}.${encodedKey}`)
    .digest();
  const presented = Buffer.from(signature, "base64url");
  // Constant time: a byte-at-a-time comparison leaks how much of a forged MAC
  // was right, which is enough to build the rest of it one request at a time.
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    return null;
  }

  // Expiry is checked AFTER the signature, so an expired token and a forged one
  // take the same path and are answered identically.
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now()) return null;

  const key = Buffer.from(encodedKey, "base64url").toString("utf8");
  try {
    assertSafeKey(key);
  } catch {
    return null;
  }
  return key;
}

/* ----------------------------------------------------- local (filesystem) -- */

/** Repo root — this file is at website/apps/api/src/lib/storage.ts. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export function localStorageDir(): string {
  const configured = process.env.STORAGE_DIR?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(REPO_ROOT, ".storage");
}

/** Where a signed local URL points. The API serves it; no static directory. */
const apiUrl = () =>
  (process.env.API_URL ?? "http://localhost:8787").replace(/\/+$/, "");

function localDriver(): Storage {
  const baseDir = localStorageDir();

  const resolve = (key: string): string => {
    assertSafeKey(key);
    const full = path.resolve(baseDir, key);
    // Defence in depth behind assertSafeKey: whatever the key was, the byte we
    // write must land inside the storage directory.
    if (full !== path.normalize(full) || !full.startsWith(baseDir + path.sep)) {
      throw new Error("Refusing an unsafe object key.");
    }
    return full;
  };

  return {
    backend: "local",

    async put(key, bytes) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes);
    },

    async get(key) {
      try {
        return await readFile(resolve(key));
      } catch {
        // Absent and unreadable are the same answer to a caller: no bytes.
        return null;
      }
    },

    async getSignedUrl(key, ttlSeconds) {
      /*
       * NOT a path under a static directory. Serving `.storage/` over HTTP
       * would make every object readable by anyone who can guess or overhear
       * its key, permanently — the exact property rule 1 exists to prevent.
       * This URL carries an HMAC that /uploads/file verifies before it reads a
       * single byte.
       */
      return `${apiUrl()}/uploads/file?token=${encodeURIComponent(
        signObjectToken(key, ttlSeconds),
      )}`;
    },

    async delete(key) {
      try {
        await unlink(resolve(key));
      } catch {
        /* Already gone is the outcome the caller asked for. */
      }
    },
  };
}

/* ------------------------------------------------------------ S3 (SigV4) -- */

export type S3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * AWS's percent-encoding, which is not `encodeURIComponent`.
 *
 * The unreserved set is exactly A-Z a-z 0-9 - _ . ~; everything else is encoded
 * with uppercase hex. `encodeURIComponent` leaves ! ' ( ) * alone, and a single
 * character encoded differently from how S3 canonicalises it changes the
 * signature and produces SignatureDoesNotMatch on that one filename.
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

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

/** `20130524T000000Z` and `20130524`, the two forms SigV4 wants. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function objectUrl(config: S3Config, key: string): URL {
  const base = config.endpoint.replace(/\/+$/, "");
  // Path style, not virtual-host style. Supabase Storage's S3 endpoint is
  // `https://<ref>.supabase.co/storage/v1/s3` and only speaks path style;
  // rewriting the bucket into the hostname would reach a domain that does not
  // resolve.
  return new URL(
    `${base}/${awsUriEncode(config.bucket)}/${awsUriEncode(key, false)}`,
  );
}

/** Builds the Authorization header for a request signed in its headers. */
export function signS3Request(
  config: S3Config,
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  now = new Date(),
): Record<string, string> {
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  const all: Record<string, string> = {
    ...headers,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(all)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(all[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(
    signingKey(config.secretAccessKey, dateStamp, config.region),
    stringToSign,
  ).toString("hex");

  return {
    ...all,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * A presigned GET: the credential travels in the query string, not a header.
 *
 * Takes a URL rather than a key so the signer can be exercised against AWS's
 * own published test vector, which is virtual-host style and would otherwise be
 * unreachable through `objectUrl`. `tests/uploads.test.ts` does exactly that —
 * a signing bug is invisible until a deployment, where it presents as every
 * image 403ing with SignatureDoesNotMatch.
 */
export function presignS3Url(
  config: S3Config,
  url: URL,
  ttlSeconds: number,
  now = new Date(),
): string {
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.floor(ttlSeconds))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  // Sorted by encoded key, which is what "canonical" means here.
  const canonicalQuery = query
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const signature = hmac(
    signingKey(config.secretAccessKey, dateStamp, config.region),
    ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n"),
  ).toString("hex");

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The presigned URL for one object in the configured bucket. */
export function presignS3Get(
  config: S3Config,
  key: string,
  ttlSeconds: number,
  now = new Date(),
): string {
  return presignS3Url(config, objectUrl(config, key), ttlSeconds, now);
}

function s3Driver(config: S3Config): Storage {
  const send = async (
    method: string,
    key: string,
    body: Uint8Array | undefined,
    contentType?: string,
  ): Promise<Response> => {
    assertSafeKey(key);
    const url = objectUrl(config, key);
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const headers = signS3Request(
      config,
      method,
      url,
      contentType ? { "content-type": contentType } : {},
      payloadHash,
    );
    return fetch(url, {
      method,
      headers,
      ...(body ? { body: body as BodyInit } : {}),
    });
  };

  return {
    backend: "s3",

    async put(key, bytes, contentType) {
      const response = await send("PUT", key, bytes, contentType);
      if (!response.ok) {
        // The body is S3's XML error, which names the actual cause (expired
        // credentials, wrong region, missing bucket). Losing it turns every
        // storage failure into the same unhelpful 500.
        throw new Error(
          `S3 PUT ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      }
    },

    async get(key) {
      const response = await send("GET", key, undefined);
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    },

    async getSignedUrl(key, ttlSeconds) {
      assertSafeKey(key);
      return presignS3Get(config, key, ttlSeconds);
    },

    async delete(key) {
      await send("DELETE", key, undefined);
    },
  };
}

/* ----------------------------------------------------------------- entry -- */

export function s3ConfigFromEnv(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  // All four or none. A half-configured bucket that silently falls back to the
  // filesystem writes a deployment's photographs onto an ephemeral container
  // disk, and nobody finds out until the container is replaced.
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION?.trim() || "us-east-1",
  };
}

export function createStorage(): Storage {
  const config = s3ConfigFromEnv();
  return config ? s3Driver(config) : localDriver();
}

let singleton: Storage | undefined;

/** The process-wide store. Memoised so config is read once, at first use. */
export function getStorage(): Storage {
  if (!singleton) singleton = createStorage();
  return singleton;
}
