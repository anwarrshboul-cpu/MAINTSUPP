/**
 * Exercise the built Vercel function, in process, before anything is deployed.
 *
 * This imports the EXACT file that ships inside `__portal.func` and drives it
 * through a `node:http` server, because that is what Vercel's Nodejs launcher
 * does: it hands the exported default an `IncomingMessage` and a
 * `ServerResponse`. Nothing here is a stand-in for the app — the requests reach
 * `dist/server/index.js` and the queries reach Supabase.
 *
 * `x-forwarded-host` / `x-forwarded-proto` are set on every request because
 * Vercel's proxy sets them, and the handler builds the request's absolute URL
 * from them.
 *
 * Usage:
 *   set -a; . ./.dev.vars; set +a
 *   PG_D1=1 node vercel/local-check.mjs
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FUNCTION_ENTRY = path.join(
  HERE,
  ".deploy",
  ".vercel",
  "output",
  "functions",
  "__portal.func",
  "index.mjs",
);

if (process.env.PG_D1 !== "1") {
  console.error("PG_D1=1 is required — otherwise env.DB is the SQLite shim, not Supabase.");
  process.exit(2);
}
if (!process.env.PG_D1_URL && !process.env.DATABASE_URL) {
  console.error("Neither PG_D1_URL nor DATABASE_URL is set.");
  process.exit(2);
}

const { default: handler } = await import(FUNCTION_ENTRY);

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error("[harness] unhandled:", error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ checks -- */

const HOST = "maintsupp-portal.vercel.app";

/*
 * Optional. `maintsupp_session` holds a 256-bit token whose SHA-256 is what the
 * `sessions` table stores, so a probe session is created by inserting the hash
 * and passing the token here. Without it every authenticated route answers 401
 * or redirects to /login — which is still a real result, just not one that
 * proves rows come back.
 */
const SESSION_TOKEN = process.env.PROBE_SESSION_TOKEN ?? "";
const authHeaders = SESSION_TOKEN
  ? { cookie: `maintsupp_session=${SESSION_TOKEN}` }
  : {};

async function hit(pathname, init = {}) {
  const started = Date.now();
  const response = await fetch(origin + pathname, {
    redirect: "manual",
    ...init,
    headers: {
      "x-forwarded-host": HOST,
      "x-forwarded-proto": "https",
      host: HOST,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  return {
    path: pathname,
    status: response.status,
    ms: Date.now() - started,
    type: response.headers.get("content-type") ?? "",
    location: response.headers.get("location"),
    setCookie: response.headers.getSetCookie?.().length ?? 0,
    bytes: Buffer.byteLength(body),
    body,
  };
}

function line(r, extra = "") {
  const loc = r.location ? `  →${r.location}` : "";
  console.log(
    `${String(r.status).padEnd(4)} ${r.path.padEnd(28)} ${String(r.ms + "ms").padStart(8)}  ${String(r.bytes).padStart(8)}B  ${r.type.split(";")[0].padEnd(26)}${loc}${extra}`,
  );
}

console.log("status path                              time     bytes  content-type");
console.log("─".repeat(100));

const results = {};

/* Marketing home — no session, must render server-side HTML. */
results.home = await hit("/");
line(results.home, results.home.body.includes("<!DOCTYPE html>") || results.home.body.includes("<!doctype html>") ? "  [html doc]" : "  [NO DOCTYPE]");

results.login = await hit("/login");
line(results.login);

/* Unauthenticated — a redirect to /login is the correct answer, not a failure. */
results.dashboard = await hit("/dashboard");
line(results.dashboard);

results.context = await hit("/api/context");
line(results.context);

results.board = await hit("/api/board");
line(results.board);

/* Served by the CDN in the real deployment; proves the in-function fallback. */
results.asset = await hit("/favicon.svg");
line(results.asset);

results.missing = await hit("/this-route-does-not-exist");
line(results.missing);

console.log("─".repeat(100));

/* ------------------------------------------------------------ authenticated -- */

if (SESSION_TOKEN) {
  console.log("with a session cookie:");
  results.dashboard = await hit("/dashboard", { headers: authHeaders });
  line(results.dashboard);
  results.context = await hit("/api/context", { headers: authHeaders });
  line(results.context);
  results.board = await hit("/api/board", { headers: authHeaders });
  line(results.board);
  console.log("─".repeat(100));
}

/* --------------------------------------------------- record counts, for real -- */

function summarise(name, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`${name}: not JSON — first 200 chars: ${raw.slice(0, 200)}`);
    return null;
  }
  return parsed;
}

const board = summarise("/api/board", results.board.body);
if (board && typeof board === "object") {
  const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : "?");
  console.log(`/api/board  keys=[${Object.keys(board).join(", ")}]`);
  for (const key of Object.keys(board)) {
    console.log(`            ${key.padEnd(12)} ${count(board[key])}`);
  }
}

const context = summarise("/api/context", results.context.body);
if (context && typeof context === "object") {
  console.log(`/api/context  keys=[${Object.keys(context).join(", ")}]`);
}

/* -------------------------------------- second request: warm-instance timing -- */

const warm = await hit("/api/board", { headers: authHeaders });
console.log(`\n/api/board warm: ${warm.status} in ${warm.ms}ms (cold was ${results.board.ms}ms)`);

server.close();
process.exit(0);
