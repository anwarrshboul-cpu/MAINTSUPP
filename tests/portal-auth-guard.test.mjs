/**
 * The dashboard is not produced for a browser that has not signed in.
 *
 * WHAT THIS IS ABOUT. On 14 September 2026 an anonymous `GET /dashboard`
 * against this repository answered 200 with 47,663 bytes of the operations
 * shell — "Operations centre", "Good morning", "Job Intelligence" — rendered
 * under a placeholder identity, seven copies of the literal "Preview User".
 * `/portal` forwarded into it without asking who was asking. The only thing
 * that eventually sent the visitor to /login was `portal/session-guard.ts`, a
 * client fetch wrapper reacting to the twelve 401s the widgets then collected;
 * live on maintsupp.com that took two to three seconds, during which the whole
 * dashboard was on screen.
 *
 * The fix is `app/lib/page-guard.ts`: the session is resolved on the SERVER, in
 * the entry of every protected route, and a missing or invalid one produces a
 * redirect and an empty body. This file is what stops that being undone.
 *
 * Two halves, following the pattern of `stage-twenty-auth.test.mjs`.
 *
 * The SOURCE half pins properties a passing request cannot demonstrate — that
 * the guard exists on every protected page, that it shares one session
 * implementation with the API rather than a second copy that could disagree,
 * and that the fix is structural rather than a timeout or a CSS rule. The
 * enumeration is the load-bearing test: a protected page added later without a
 * guard fails here rather than leaking quietly.
 *
 * The LIVE half drives a running dev server: signed out, signed in, with a
 * forged cookie, and across sign-in and sign-out. It skips when nothing is
 * listening.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Every route under the authenticated shell, as the report listed them.
 *
 * `/dashboard/units` is here too because it is a live address the asset
 * register used to own, and an old bookmark must meet the same guard as a
 * current link.
 */
const PROTECTED_PATHS = [
  "/dashboard",
  "/dashboard/jobs",
  "/dashboard/compliance",
  "/dashboard/store-documentation",
  "/dashboard/planned",
  "/dashboard/sites",
  "/dashboard/assets",
  "/dashboard/units",
  "/dashboard/contractors",
  "/dashboard/documents",
  "/dashboard/invoice-tracker",
  "/dashboard/reports",
  "/dashboard/settings",
  "/dashboard/team",
  "/dashboard/audit",
  "/dashboard/reconcile",
  "/dashboard/recycle-bin",
  "/dashboard/admin",
  "/dashboard/admin/roles",
  "/dashboard/admin/clients",
  "/dashboard/account",
  "/dashboard/account/security",
  "/dashboard/teams",
  "/admin/reconcile",
];

/**
 * Pages inside `app/(app)` that are public BY DESIGN, each with its reason.
 *
 * Anything not on this list must call `requirePageSession`. Adding a name here
 * is a decision somebody has to write down, which is the point: the failure
 * mode this file exists to prevent is a protected page added without a guard
 * and nobody noticing.
 */
const PUBLIC_PAGES = new Map([
  [
    "app/(app)/login/page.tsx",
    "the sign-in form itself — guarding it would be a redirect loop. It does " +
      "the opposite check: a live session is sent on rather than shown a form.",
  ],
  [
    "app/(app)/request/page.tsx",
    "the public job-request form. The visitor is a store manager with no " +
      "account at all, so there is no session to require.",
  ],
]);

/** Strings that only exist inside the authenticated shell. */
const SHELL_MARKERS = [
  "Operations centre",
  "Job Intelligence",
  "Preview User",
  "preview@maintsupp.local",
];

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

async function appPages() {
  const root = new URL("../app/(app)/", import.meta.url);
  const found = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      } else if (entry.name === "page.tsx") {
        found.push(`app/(app)/${prefix}page.tsx`);
      }
    }
  }
  await walk(root, "");
  return found.sort();
}

test("every page under the authenticated shell guards, or says why not", async () => {
  const pages = await appPages();
  assert.ok(pages.length >= 6, `expected the app routes to be found, got ${pages.length}`);

  const unguarded = [];
  for (const page of pages) {
    const source = await read(page);
    const guarded = source.includes("requirePageSession");
    if (PUBLIC_PAGES.has(page)) {
      assert.equal(
        guarded,
        false,
        `${page} is on the public list but calls requirePageSession — remove one or the other`,
      );
      continue;
    }
    if (!guarded) unguarded.push(page);
  }

  assert.deepEqual(
    unguarded,
    [],
    "these pages render without resolving a session first. Call " +
      "requirePageSession from app/lib/page-guard.ts, or add the page to " +
      "PUBLIC_PAGES above with the reason it has no session to require.",
  );
});

test("the public list has not quietly grown", async () => {
  // A second lock on the same door. The list above is only meaningful if
  // adding to it is a visible act; pinning the size makes an addition show up
  // in a diff even when the walk finds no new page.
  assert.equal(PUBLIC_PAGES.size, 2);
  assert.ok(PUBLIC_PAGES.has("app/(app)/login/page.tsx"));
  assert.ok(PUBLIC_PAGES.has("app/(app)/request/page.tsx"));
  for (const [page, reason] of PUBLIC_PAGES) {
    assert.ok(reason.length > 40, `${page} needs a real reason, not a label`);
  }
});

test("the page guard and the API share one session implementation", async () => {
  const guard = await read("app/lib/page-guard.ts");

  // Not a second copy of the cookie check. The whole point is that a page and
  // an API route cannot disagree about what a valid session is.
  assert.match(guard, /from "\.\/auth-session"/);
  assert.match(guard, /getSession\(/);
  assert.match(guard, /safeRedirectPath/);
  assert.match(guard, /redirect\(loginRedirect\(pathname\)\)/);

  // The cookie must not be re-parsed here, and no second expiry rule invented.
  assert.doesNotMatch(guard, /maintsupp_session/);
  assert.doesNotMatch(guard, /token_hash|expires_at|IDLE_LIFETIME/);

  const session = await read("app/lib/auth-session.ts");
  assert.match(
    session,
    /export async function getSession/,
    "page-guard imports getSession; it has to still be exported from there",
  );
  assert.match(
    session,
    /export async function requireSession/,
    "the API half of the same implementation",
  );
});

test("the sign-in target is sanitised on the way out as well as in", async () => {
  const guard = await read("app/lib/page-guard.ts");
  // `next` is built from route params, which anyone can put anything into.
  assert.match(
    guard,
    /encodeURIComponent\(safeRedirectPath\(pathname\)\)/,
    "the redirect target must be sanitised before it is encoded",
  );

  const login = await read("app/(app)/login/page.tsx");
  assert.match(
    login,
    /safeRedirectPath\(rawNext\)/,
    "and checked again where it is read back",
  );
});

/** Source with comments removed, so a comment that QUOTES a withdrawn literal
 *  does not read as the literal still being there. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the dashboard has no placeholder identity left to fall back to", async () => {
  const page = code(await read("app/(app)/dashboard/[[...section]]/page.tsx"));

  assert.match(page, /await requirePageSession\(/);
  // The exact literals that used to be served to an anonymous browser.
  assert.doesNotMatch(page, /"Preview User"/);
  assert.doesNotMatch(page, /"preview@maintsupp\.local"/);
  // A guarded session is non-null, so the optional chain that carried the
  // fallback must be gone too — leaving it would let a future edit reintroduce
  // the fallback without touching this test.
  assert.doesNotMatch(page, /\bsession\?\./);
  assert.match(page, /userName=\{session\.user\./);
  assert.match(page, /userEmail=\{session\.user\.email\}/);
});

test("/portal resolves auth itself instead of bouncing through /dashboard", async () => {
  const page = await read("app/(app)/portal/page.tsx");
  assert.match(page, /await requirePageSession\("\/dashboard"\)/);
  // The guard has to come first. A redirect above it would forward an
  // anonymous visitor into the protected route, which is the original defect.
  assert.ok(
    page.indexOf("requirePageSession") < page.indexOf('redirect("/dashboard")'),
    "the session must be resolved before the forward, not after it",
  );
});

test("the fix is structural — no timer, no CSS, no hidden shell", async () => {
  for (const path of [
    "app/lib/page-guard.ts",
    "app/(app)/portal/session-guard.ts",
    "app/(app)/dashboard/[[...section]]/page.tsx",
    "app/(app)/portal/page.tsx",
  ]) {
    const source = await read(path);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /setTimeout|setInterval/, `${path} must not wait`);
    assert.doesNotMatch(
      code,
      /opacity\s*:|visibility\s*:|display\s*:\s*['"]none/,
      `${path} must not hide the shell instead of not producing it`,
    );
  }
});

test("one 401 handler, and it cancels the rest rather than letting them render", async () => {
  const guard = await read("app/(app)/portal/session-guard.ts");

  // Still narrow: only 401, only `signIn: true`, only same-origin /api, never
  // the auth routes themselves, and only once.
  assert.match(guard, /response\.status !== 401/);
  assert.match(guard, /signIn === true/);
  assert.match(guard, /path\.startsWith\("\/api\/"\)/);
  assert.match(guard, /path\.startsWith\("\/api\/auth\/"\)/);

  // New: in-flight requests are cancelled, and nothing after the decision is
  // handed back to a caller that could render "Your session has ended".
  assert.match(guard, /const inFlight = new Set<AbortController>\(\)/);
  assert.match(guard, /controller\.abort\(\)/);
  assert.match(guard, /function neverSettles/);
  assert.match(guard, /beginSignIn\(\);\s*\r?\n[\s\S]{0,400}?return neverSettles<Response>\(\)/);
  assert.match(guard, /if \(redirecting\) return neverSettles<Response>\(\)/);

  // The redirect is committed exactly once, however many widgets find out.
  assert.match(guard, /function beginSignIn\(\) \{\s*\r?\n\s*if \(redirecting\) return;/);
});

test('"Your session has ended" stays a server sentence and never a widget state', async () => {
  // It is produced in exactly one place, as an API body. No component may
  // hold it as a literal to render.
  const tenant = await read("app/lib/tenant-db.ts");
  assert.match(tenant, /Your session has ended\. Sign in to continue\./);

  const root = new URL("../app/", import.meta.url);
  const offenders = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      const source = await readFile(new URL(entry.name, dir), "utf8");
      if (source.includes("Your session has ended")) {
        offenders.push(`app/${prefix}${entry.name}`);
      }
    }
  }
  await walk(root, "");
  assert.deepEqual(offenders, [], "no component may render that string itself");
});

test("sign-out replaces the history entry rather than stacking on it", async () => {
  const menu = await read("app/(app)/portal/account-menu.tsx");
  // `assign` would leave the dashboard of a dead session as the previous
  // entry, where Back can restore it from the back/forward cache without a
  // request the server guard could refuse.
  assert.match(menu, /window\.location\.replace\("\/login"\)/);
  assert.doesNotMatch(menu, /window\.location\.assign\("\/login"\)/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      signal: AbortSignal.timeout(6_000),
      redirect: "manual",
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!response.ok) return null;
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
  return cookie || null;
}

test("signed out, no protected route answers with a page", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  for (const path of PROTECTED_PATHS) {
    const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
    assert.ok(
      response.status === 307 || response.status === 302 || response.status === 303,
      `${path} answered ${response.status}, not a redirect`,
    );

    const location = new URL(response.headers.get("location"), BASE_URL);
    assert.equal(location.pathname, "/login", `${path} must go to /login`);

    const next = location.searchParams.get("next");
    assert.ok(next, `${path} must carry a next target`);
    assert.ok(next.startsWith("/"), `${path} next must be a local path`);
    assert.ok(!next.startsWith("//"), `${path} next must not be protocol-relative`);

    // And the body is empty. This is the assertion the whole file is for.
    const body = await response.text();
    assert.equal(body.length, 0, `${path} sent ${body.length} bytes of body`);
  }
});

test("the dashboard markup does not exist anywhere in a signed-out response", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // `redirect: "follow"` on purpose: even after following to /login, none of
  // the shell may appear. This is the check a person does with devtools.
  for (const path of ["/portal", "/dashboard", "/dashboard/jobs"]) {
    const response = await fetch(`${BASE_URL}${path}`);
    assert.equal(new URL(response.url).pathname, "/login", `${path} lands on /login`);
    const html = await response.text();
    for (const marker of SHELL_MARKERS) {
      assert.ok(!html.includes(marker), `${path} leaked "${marker}"`);
    }
  }
});

test("/portal signed out never touches /dashboard on the way", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/portal`, { redirect: "manual" });
  const location = new URL(response.headers.get("location"), BASE_URL);
  assert.equal(location.pathname, "/login");
  assert.equal(
    location.searchParams.get("next"),
    "/dashboard",
    "signing in should still land where /portal was taking them",
  );
});

test("a forged or expired session cookie is refused like no cookie at all", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const forged = [
    "maintsupp_session=" + "a".repeat(64),
    "maintsupp_session=short",
    "maintsupp_session=",
    "maintsupp_session=' OR 1=1 --",
  ];

  for (const cookie of forged) {
    const response = await fetch(`${BASE_URL}/dashboard`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.ok(
      response.status === 307 || response.status === 302,
      `"${cookie}" answered ${response.status}`,
    );
    assert.equal(new URL(response.headers.get("location"), BASE_URL).pathname, "/login");
    assert.equal((await response.text()).length, 0);
  }
});

test("a path that tries to escape the site cannot leave it", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  for (const attempt of [
    "/dashboard//evil.example.com",
    "/dashboard/%2f%2fevil.example.com",
    "/dashboard/https:%2f%2fevil.example.com",
  ]) {
    const response = await fetch(`${BASE_URL}${attempt}`, { redirect: "manual" });
    const location = new URL(response.headers.get("location"), BASE_URL);
    assert.equal(location.origin, new URL(BASE_URL).origin);
    const next = location.searchParams.get("next") ?? "";
    assert.ok(next.startsWith("/") && !next.startsWith("//"), `next was ${next}`);
    assert.ok(
      !/evil\.example\.com/.test(new URL(next, BASE_URL).host),
      `next resolved off-site: ${next}`,
    );
  }
});

test("signed in, the same routes render — and under the real identity", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  for (const path of ["/dashboard", "/dashboard/jobs", "/dashboard/account", "/dashboard/teams"]) {
    const response = await fetch(`${BASE_URL}${path}`, { headers: { cookie } });
    assert.equal(response.status, 200, `${path} signed in`);
    const html = await response.text();
    assert.ok(html.length > 1000, `${path} returned an empty page`);
    assert.ok(!html.includes("Preview User"), `${path} still shows the placeholder identity`);
  }

  const overview = await fetch(`${BASE_URL}/dashboard`, { headers: { cookie } });
  const html = await overview.text();
  assert.ok(html.includes("Operations centre"), "the shell should render for a real session");
  assert.ok(html.includes(OWNER_EMAIL), "the signed-in account's own identity");

  // /portal forwards rather than refusing, and /login gets out of the way.
  const portal = await fetch(`${BASE_URL}/portal`, { headers: { cookie }, redirect: "manual" });
  assert.equal(new URL(portal.headers.get("location"), BASE_URL).pathname, "/dashboard");

  const login = await fetch(`${BASE_URL}/login`, { headers: { cookie }, redirect: "manual" });
  assert.equal(
    new URL(login.headers.get("location"), BASE_URL).pathname,
    "/dashboard",
    "a signed-in visitor to /login must not be shown a form — and must not loop",
  );
});

test("sign-in honours the next target, and cannot be pointed off-site", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const honoured = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      next: "/dashboard/assets",
    }),
  });
  if (!honoured.ok) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  assert.equal((await honoured.json()).redirectTo, "/dashboard/assets");

  for (const hostile of ["https://evil.example.com/", "//evil.example.com", "/\\evil.example.com"]) {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, next: hostile }),
    });
    const body = await response.json();
    assert.equal(body.redirectTo, "/dashboard", `"${hostile}" was not neutralised`);
  }
});

test("after signing out the same cookie no longer opens the dashboard", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  const before = await fetch(`${BASE_URL}/dashboard`, { headers: { cookie }, redirect: "manual" });
  assert.equal(before.status, 200);

  const out = await fetch(`${BASE_URL}/api/auth/logout`, { method: "POST", headers: { cookie } });
  assert.ok(out.ok, "sign-out should succeed");

  const after = await fetch(`${BASE_URL}/dashboard`, { headers: { cookie }, redirect: "manual" });
  assert.ok(
    after.status === 307 || after.status === 302,
    `a revoked session still rendered the dashboard (${after.status})`,
  );
  assert.equal((await after.text()).length, 0);
});

test("the login page itself does not redirect, so there is no loop", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/login?next=%2Fdashboard%2Fjobs`, {
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes("Sign in"), "the form should be there");
  for (const marker of SHELL_MARKERS) {
    assert.ok(!html.includes(marker), `/login leaked "${marker}"`);
  }
});
