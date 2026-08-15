/**
 * The legacy portal as a single Vercel Node Function.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `vinext build` emits `dist/client/` and `dist/server/index.js`, and that
 * server entry is a Cloudflare Worker object — `{ fetch(request, env, ctx) }`.
 * vinext ships adapters for workerd and for a plain Node http server and
 * nothing else; there is no `.next` directory and no `.vercel/output`, so
 * Vercel's framework detection has nothing to detect.
 *
 * What makes the port possible is that `vinext start` is *thin*. Read
 * `node_modules/vinext/dist/server/prod-server.js` → `startAppRouterServer`:
 * having imported that same worker object, its entire per-request job is
 *
 *   1. reject open-redirect-shaped paths, normalise the pathname (400 on
 *      malformed percent-encoding),
 *   2. serve `/assets/*` from `dist/client`,
 *   3. serve `/_vinext/image` from `dist/client` (unresized — the Workers
 *      `IMAGES` binding is not there on Node either),
 *   4. convert IncomingMessage → Request, call `worker.fetch(request,
 *      undefined, ctx)`,
 *   5. if the response carries `x-vinext-static-file`, serve that file from
 *      `dist/client` instead of the body,
 *   6. stream the Response back.
 *
 * Every one of those six steps is platform-neutral. This file is that list
 * again, with steps 1–3 and 5 kept because a request can still reach the
 * function without having passed Vercel's static filesystem, and with the
 * compression step dropped because Vercel's edge already negotiates it.
 *
 * The handler is reimplemented here rather than imported from
 * `vinext/server/prod-server` for two reasons: that module only exposes
 * `startProdServer()`, which binds a socket and never returns a handler, and
 * importing it would drag `@vercel/og` and its font/WASM payload into a
 * function that renders no OG images.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FUNCTION NEEDS ON DISK
 * ---------------------------------------------------------------------------
 * `dist/server/**` — `index.js` dynamically imports `./ssr/index.js` and reads
 * its sibling manifests, so the directory ships whole.
 * `dist/client/**` — for steps 2, 3 and 5. Vercel's `handle: filesystem`
 * serves these first in practice; this copy is the correctness backstop.
 * `node_modules/postgres` — see `PG_D1_DRIVER` below.
 * `package.json` with `"type": "module"` — `dist/server/index.js` is ESM with
 * a `.js` extension. Without it Node parses it as CommonJS and the function
 * dies at import with "Cannot use import statement outside a module".
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(ROOT, "dist", "client");
const SERVER_ENTRY = path.join(ROOT, "dist", "server", "index.js");

/*
 * `db/node-pg-d1.ts` loads postgres.js through
 * `createRequire(join(process.cwd(), "node-pg-d1.cjs"))(process.env.PG_D1_DRIVER
 * || "postgres")` — deliberately opaque to the bundler, and therefore resolved
 * against the process's CURRENT WORKING DIRECTORY at first query. A Vercel
 * function's cwd is not guaranteed to be the directory this file sits in, and
 * a bare `"postgres"` that fails to resolve surfaces as a 500 on the first
 * database call rather than at boot. Handing it an absolute path removes cwd
 * from the question entirely. `postgres`'s package.json has a `main`, so a
 * directory require resolves to the CommonJS build — which is the one that
 * speaks TCP; the `workerd` export condition would have selected the
 * `cloudflare:sockets` build.
 */
process.env.PG_D1_DRIVER ||= path.join(ROOT, "node_modules", "postgres");

/*
 * `db/node-workers-env.ts` builds `env.BUCKET` from `createR2Bucket()`, whose
 * root is `R2_LOCAL_DIR` or `${cwd}/.r2-local`. Everything outside /tmp is
 * read-only in a Vercel function, so an unset value turns the first upload
 * into an EROFS crash instead of a storage miss. /tmp is writable and per
 * instance: reads of anything uploaded before this instance existed return
 * "not found", which is the clean failure this deployment is designed for
 * until Supabase Storage S3 credentials exist. Nothing else changes — the
 * factory opens no file until a request actually touches an object.
 */
process.env.R2_LOCAL_DIR ||= "/tmp/maintsupp-r2";

/* ------------------------------------------------------------ static files -- */

const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Resolve a URL pathname inside `dist/client`, or null if it escapes.
 *
 * The containment check is on the RESOLVED path rather than on the input,
 * because `%2e%2e` survives a naive substring test and `path.resolve` is what
 * actually decides which bytes get read.
 */
function resolveClientFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(CLIENT_DIR, "." + path.posix.normalize(decoded));
  if (resolved !== CLIENT_DIR && !resolved.startsWith(CLIENT_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveStatic(req, res, pathname, extraHeaders = {}, statusCode = 200) {
  const file = resolveClientFile(pathname);
  if (!file) return false;

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const headers = {
    "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(stat.size),
    ...extraHeaders,
  };

  res.writeHead(statusCode, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    res.on("finish", resolve);
    stream.on("end", resolve);
  });
  return true;
}

/* ------------------------------------------------------- request pipeline -- */

/** `prod-server.js` / `request-pipeline.js` — `isOpenRedirectShaped`. */
function isOpenRedirectShaped(rawPathname) {
  if (!rawPathname.startsWith("/")) return false;
  const afterSlash = rawPathname.slice(1);
  if (afterSlash.startsWith("/") || afterSlash.startsWith("\\")) return true;
  if (afterSlash.length >= 3 && afterSlash[0] === "%") {
    const encoded = afterSlash.slice(0, 3).toLowerCase();
    if (encoded === "%5c" || encoded === "%2f") return true;
  }
  return false;
}

/** `vinext/dist/routing/utils.js` — `normalizePathnameForRouteMatchStrict`. */
const PATH_DELIMITER_REGEX = /([/#?\\]|%(2f|23|3f|5c))/gi;
function decodeRouteSegmentStrict(segment) {
  return decodeURIComponent(segment).replace(PATH_DELIMITER_REGEX, (c) =>
    encodeURIComponent(c),
  );
}
function normalizePathnameForRouteMatchStrict(pathname) {
  return pathname.split("/").map(decodeRouteSegmentStrict).join("/");
}

/** `vinext/dist/server/normalize-path.js` — `normalizePath`. */
function normalizePath(pathname) {
  if (
    pathname === "/" ||
    (pathname.length > 1 &&
      pathname[0] === "/" &&
      !pathname.includes("//") &&
      !pathname.includes("/./") &&
      !pathname.includes("/../") &&
      !pathname.endsWith("/.") &&
      !pathname.endsWith("/.."))
  ) {
    return pathname;
  }
  const resolved = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return "/" + resolved.join("/");
}

/**
 * Which origin the app should believe it is served from.
 *
 * `prod-server.js` distrusts `x-forwarded-host` unless `VINEXT_TRUSTED_HOSTS`
 * names it, because on a bare Node server that header is attacker-controlled.
 * Behind Vercel's proxy it is not: the proxy sets `x-forwarded-host` and
 * `x-forwarded-proto` itself on every request. Trusting them here is what makes
 * `redirect()` and every absolute URL the app builds point at the deployment's
 * own hostname instead of an internal one.
 */
function requestUrl(req, pathnameAndQuery) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}${pathnameAndQuery}`;
}

const BODYLESS = new Set(["GET", "HEAD"]);

function nodeToWebRequest(req, pathnameAndQuery) {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    // HTTP/2 pseudo-headers are not legal Headers names.
    if (name.startsWith(":")) continue;
    headers.append(name, req.rawHeaders[i + 1]);
  }

  const method = req.method ?? "GET";
  const init = { method, headers };
  if (!BODYLESS.has(method)) {
    init.body = Readable.toWeb(req);
    // Node requires this for a streaming request body.
    init.duplex = "half";
  }
  return new Request(requestUrl(req, pathnameAndQuery), init);
}

async function sendWebResponse(webResponse, req, res) {
  const headers = {};
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  // getSetCookie() keeps multiple Set-Cookie values apart; iterating Headers
  // folds them into one comma-joined string that browsers mis-parse.
  const cookies = webResponse.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;

  res.writeHead(webResponse.status, webResponse.statusText || undefined, headers);

  if (!webResponse.body || req.method === "HEAD") {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    res.end();
  }
}

/* ------------------------------------------------------------- the worker -- */

const VINEXT_STATIC_FILE_HEADER = "x-vinext-static-file";

/**
 * Imported once per instance and reused, exactly as `vinext start` does. The
 * import is what runs `db/node-workers-env.ts`; the first request through the
 * handler is what runs `db/init.ts`'s bootstrap against Postgres.
 */
let fetchHandlerPromise = null;
function getFetchHandler() {
  if (!fetchHandlerPromise) {
    fetchHandlerPromise = import(SERVER_ENTRY).then((mod) => {
      const entry = mod.default;
      if (typeof entry === "function") return entry;
      if (entry && typeof entry.fetch === "function") {
        return (request, ctx) => entry.fetch(request, undefined, ctx);
      }
      throw new Error(
        "[vercel] dist/server/index.js exported neither a handler function nor a { fetch } object",
      );
    });
    fetchHandlerPromise.catch(() => {
      fetchHandlerPromise = null;
    });
  }
  return fetchHandlerPromise;
}

/*
 * `env` is deliberately `undefined`, matching what `prod-server.js` passes.
 * `worker/index.ts` only reads `env.ASSETS` / `env.IMAGES` inside the
 * `/_vinext/image` branch, which is intercepted below and never reaches it;
 * `app/**` reaches bindings through `import("cloudflare:workers")`, which the
 * D1_NODE_SHIM build has already aliased to `db/node-workers-env.ts`.
 *
 * `waitUntil` is fire-and-forget, as on Node. Worth knowing: a Vercel function
 * instance may be frozen once the response is sent, so work deferred here is
 * not guaranteed to finish. Nothing on the request path depends on it.
 */
function executionContext() {
  return {
    waitUntil(promise) {
      Promise.resolve(promise).catch(() => {});
    },
    passThroughOnException() {},
  };
}

const IMAGE_SECURITY_HEADERS = {
  "content-security-policy": "script-src 'none'; frame-src 'none'; sandbox;",
  "x-content-type-options": "nosniff",
  "content-disposition": "inline",
};

export default async function handler(req, res) {
  const rawUrl = req.url ?? "/";
  const queryIndex = rawUrl.indexOf("?");
  const rawPathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);

  if (isOpenRedirectShaped(rawPathname)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }

  let pathname;
  try {
    pathname = normalizePath(
      normalizePathnameForRouteMatchStrict(rawPathname.replaceAll("\\", "/")),
    );
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  // Normally unreachable: `handle: filesystem` in config.json serves these from
  // the CDN. Kept so the function is correct on its own.
  if (pathname.startsWith("/assets/")) {
    if (
      await serveStatic(req, res, pathname, {
        "cache-control": "public, max-age=31536000, immutable",
      })
    ) {
      return;
    }
  }

  /*
   * The optimizer with no optimizer behind it, which is what `vinext start`
   * also does: the transform needs Cloudflare's `IMAGES` binding, so on any
   * Node host the endpoint degrades to serving the original bytes with the
   * security headers that make an uploaded SVG inert.
   */
  if (pathname === "/_vinext/image") {
    const target = new URL(rawUrl, "http://localhost").searchParams.get("url");
    if (!target || !target.startsWith("/") || target.startsWith("//")) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    if (await serveStatic(req, res, target, IMAGE_SECURITY_HEADERS)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Image not found");
    return;
  }

  try {
    const fetchHandler = await getFetchHandler();
    const request = nodeToWebRequest(req, pathname + query);
    const response = await fetchHandler(request, executionContext());

    const staticSignal = response.headers.get(VINEXT_STATIC_FILE_HEADER);
    if (staticSignal) {
      let staticPath = staticSignal;
      try {
        staticPath = decodeURIComponent(staticSignal);
      } catch {
        /* keep the raw value */
      }
      const passthrough = {};
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (
          lower === VINEXT_STATIC_FILE_HEADER ||
          lower === "content-encoding" ||
          lower === "content-length" ||
          lower === "content-type"
        ) {
          return;
        }
        passthrough[lower] = value;
      });
      response.body?.cancel().catch(() => {});
      if (await serveStatic(req, res, staticPath, passthrough, response.status)) return;
      res.writeHead(404, { ...passthrough, "content-type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }

    await sendWebResponse(response, req, res);
  } catch (error) {
    console.error("[vercel] handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    } else {
      res.end();
    }
  }
}
