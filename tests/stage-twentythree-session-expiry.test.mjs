/**
 * Stage 23 — an expired session says so, and the browser acts on it.
 *
 * Every route in this codebase wraps its body in a try/catch ending in a 503
 * and a sentence like "the workspace is temporarily unavailable". That is the
 * right answer for a database that is down. It was the answer given to a
 * caller whose session had expired, and it is wrong twice over: 503 means
 * "retry later", so a browser and a person both wait for a recovery that will
 * never come; and it blames the workspace for something the reader fixes in
 * ten seconds by signing in.
 *
 * Worse, it was invisible. A dashboard whose session expired overnight renders
 * empty panels and error text on every screen at once, while the account menu
 * still shows the person's name — that came from the server render, which
 * happened while they were still signed in.
 *
 * The source half of this file pins the decisions. The live half proves the
 * production branch, which needs the two production switches flipped, so it is
 * a source-level proof of the branch plus a runtime proof of everything the
 * development environment can actually reach.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Public by design: no account exists behind either, so "sign in" is wrong advice. */
const PUBLIC_ROUTES = new Set([
  "app/api/leads/route.ts",
  "app/api/job-link/[token]/route.ts",
  /*
   * The shared form link, on the same footing as the contractor job link above:
   * the share token IS the authorisation, and the person holding it is a store
   * manager with no account. Answering "your session expired, sign in" to
   * somebody who never had a session would be wrong advice, so these two are
   * exempt from the sign-out branch rather than pretending to implement it.
   *
   * The one place they DO mention signing in is the optional "Require sign-in"
   * setting, which answers 401 with that instruction because there the advice
   * is correct — it is a deliberate per-form choice, not an expired session.
   */
  "app/api/forms/[token]/route.ts",
  "app/api/forms/[token]/submit/route.ts",
]);

async function routeFiles(dir = "app/api", found = []) {
  const entries = await readdir(new URL(`../${dir}`, import.meta.url), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await routeFiles(path, found);
    else if (entry.name === "route.ts") found.push(path);
  }
  return found;
}

test("the refusal is a 401 that a client can branch on", async () => {
  const source = await read("app/lib/tenant-db.ts");

  assert.match(source, /export function anonymousRefusal\(error: unknown\): Response \| null/);
  assert.match(source, /if \(!isAnonymousAccess\(error\)\) return null/);
  assert.match(source, /signIn: true/, "a flag beats parsing prose");
  assert.match(source, /\{ status: 401 \}/);
  // 403 is a different screen: signed in, and not allowed.
  assert.doesNotMatch(
    source.slice(source.indexOf("export function anonymousRefusal")),
    /status: 403/,
  );
});

test("every route that answers 503 asks first whether it is a sign-out", async () => {
  const files = await routeFiles();
  const missing = [];

  for (const path of files) {
    if (PUBLIC_ROUTES.has(path)) continue;
    const source = await read(path);
    if (!source.includes("status: 503")) continue;
    // A 503 that is genuinely about storage, not about who is asking.
    if (path === "app/api/files/[id]/route.ts") continue;
    if (!source.includes("anonymousRefusal(")) missing.push(path);
  }

  assert.deepEqual(
    missing,
    [],
    `these answer 503 without checking for an expired session:\n  ${missing.join("\n  ")}`,
  );
});

test("no bare catch is left holding a 503 it cannot explain", async () => {
  const files = await routeFiles();
  const offenders = [];

  for (const path of files) {
    if (PUBLIC_ROUTES.has(path)) continue;
    const source = await read(path);
    // `} catch {` discards the error, so the handler cannot tell an outage
    // from a sign-out even if it wanted to.
    for (const match of source.matchAll(/\}\s*catch\s*\{\n/g)) {
      const window = source.slice(match.index, match.index + 900);
      if (window.includes("status: 503")) offenders.push(path);
    }
  }

  assert.deepEqual(offenders, [], `bare catches answering 503:\n  ${offenders.join("\n  ")}`);
});

test("the browser reacts, and reacts narrowly", async () => {
  const guard = await read("app/(app)/portal/session-guard.ts");

  assert.match(guard, /response\.status !== 401/);
  assert.match(guard, /payload\?\.signIn === true/, "a bare 401 is a capability refusal, not a sign-out");
  assert.match(guard, /path\.startsWith\("\/api\/auth\/"\)/, "a failed sign-in must not reload the sign-in page");
  assert.match(guard, /!path\.startsWith\("\/api\/"\)/, "only our own API");
  assert.match(guard, /redirecting = true/, "the first redirect wins");
  // The body belongs to the caller. Consuming it turns an expired session into
  // a "body already read" crash in whichever loader was unlucky.
  assert.match(guard, /response\.clone\(\)\.json\(\)/);
  assert.match(guard, /\/login\?next=\$\{encodeURIComponent\(returnTo\(\)\)\}/);

  // And it is actually installed, before anything fetches.
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /installSessionGuard\(\);/);
});

test("the production branch is what makes any of this reachable", async () => {
  // Two independent switches decide whether an unauthenticated caller is
  // anonymous. Both must stay, or the refusal is unreachable and every test
  // above passes while production quietly hands out the live tenant.
  const access = await read("app/lib/tenant-access.ts");
  assert.match(access, /if \(session \|\| demoIdentityAllowed\(\)\) \{/);
  assert.match(access, /anonymous = true;/);

  const actor = await read("app/lib/workspace-actor.ts");
  assert.match(
    actor,
    /if \(process\.env\.NODE_ENV === "production"\) return "client";/,
    "an absent role cookie must not mean super_admin in production",
  );
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("development is unchanged, and a signed-in caller is unaffected", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // The demo identities are how the dashboard is demoed. Breaking them to fix
  // production would be a poor trade, and this is the guard against it.
  for (const path of ["/api/workspace", "/api/board", "/api/maintenance"]) {
    const response = await fetch(`${BASE_URL}${path}`);
    assert.equal(response.status, 200, `${path} in development`);
  }

  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!login.ok) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const cookie = (login.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");

  for (const path of ["/api/workspace", "/api/audit", "/api/teams", "/api/trash"]) {
    const response = await fetch(`${BASE_URL}${path}`, { headers: { cookie } });
    assert.equal(response.status, 200, `${path} with a session`);
  }
});

test("a comment thread refuses rather than throwing", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  // GET /api/updates had no try/catch at all, so `scopedDb` throwing for a
  // caller with no session escaped as a 500 — "the server is broken" for
  // somebody whose session had simply ended.
  const source = await read("app/api/updates/route.ts");
  /*
   * What is being pinned is that the call is INSIDE the try, not the shape of
   * what it destructures. This named `{ db, orgId }` exactly, and Like — which
   * has to know whether the reader is one of the likers — added `actor` to the
   * same statement, failing an assertion about session handling for a reason
   * that had nothing to do with sessions.
   */
  assert.match(
    source,
    /try \{\s*\(\{[^}]*\bdb\b[^}]*\borgId\b[^}]*\} = await scopedDb\(request\)\);/,
  );
  assert.match(source, /const refusal = anonymousRefusal\(error\);/);

  const response = await fetch(`${BASE_URL}/api/updates?requestId=nope`);
  assert.notEqual(response.status, 500, "an unknown job is not a crash");
});
