/**
 * §36 — the portal's global search.
 *
 * The rules that matter are boundaries, so most of this file is about who is
 * answered what: the organisation comes from the session, every group asks its
 * own screen's question, documents go through the register's own handler, and
 * matching is case-insensitive on Postgres as well as SQLite.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";

const ts = (await import("typescript")).default;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function loadNeedle() {
  const source = await read("app/lib/search-text.ts");
  const start = source.indexOf("export function searchNeedle(");
  const body = source.slice(start, source.indexOf("\n}\n", start) + 2).replace(/^export /, "");
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("SEARCH_MIN_LENGTH", "SEARCH_MAX_LENGTH", `${js}; return searchNeedle;`)(2, 80);
}

test("the needle: lower-cased, wildcards stripped, too short is no search", async () => {
  const needle = await loadNeedle();
  assert.equal(needle("Invoice"), "%invoice%");
  assert.equal(needle("  MN-10  "), "%mn-10%");
  assert.equal(needle("50%_off"), "%50off%", "a typed % or _ is not a wildcard");
  assert.equal(needle("a"), null, "one character is not a search");
  assert.equal(needle("%_"), null, "nothing left after stripping");
  assert.equal(needle(null), null);
  assert.equal(needle("x".repeat(200)).length, 82, "bounded");
});

test("case-insensitive on both databases: lower(column) like lower(needle)", async () => {
  const helper = code(await read("app/lib/search-text.ts"));
  assert.match(helper, /sql`lower\(coalesce\(\$\{column\}, ''\)\) like \$\{needle\}`/);
  /* The document register's own search used bare like(), which Postgres
     matches case-sensitively. */
  const files = code(await read("app/api/files/route.ts"));
  assert.doesNotMatch(files, /like\(attachments\.(title|originalName|documentType)/);
  assert.match(files, /containsText\(attachments\.title, queryNeedle\)/);
});

test("the workspace comes from the session, never the request", async () => {
  const route = code(await read("app/api/search/route.ts"));
  assert.match(route, /const scope = await scopedDb\(request\);/);
  assert.doesNotMatch(route, /searchParams\.get\("(org|organisation|organisationId|workspace)"\)/);
  assert.match(route, /const refusal = requireCapability\(subject, "board\.view"\);\s*if \(refusal\) return refusal;/);
});

test("every group asks its own screen's question", async () => {
  const route = code(await read("app/api/search/route.ts"));
  /* jobs and sites inside the site restriction */
  assert.match(route, /restricted \? inArray\(maintenanceRequests\.siteId, restricted\) : undefined/);
  assert.match(route, /restricted \? inArray\(sites\.id, restricted\) : undefined/);
  assert.match(route, /isNull\(maintenanceRequests\.deletedAt\)/, "a binned job is not a result");
  /* documents: the register's OWN handler, with the caller's own request */
  assert.match(route, /import \{ GET as listDocuments \} from "\.\.\/files\/route";/);
  assert.match(route, /listDocuments\(new Request\(documentUrl, \{ headers: request\.headers \}\)\)/);
  /* invoices and quotes: the Invoice Tracker's rank rule and capability */
  assert.match(route, /ROLE_RANK\[scope\.actor\.role\] >= ROLE_RANK\.admin && can\(subject, FINANCE_CAPABILITIES\["ledger\.read"\]\)/);
  assert.match(route, /if \(can\(subject, FINANCE_CAPABILITIES\["quote\.read"\]\)\)/);
  /* people: the directory's capability */
  assert.match(route, /if \(can\(subject, "users\.view"\)\)/);
  /* a group the caller may not see is absent, not empty */
  assert.match(route, /searched: groups\.map\(\(group\) => group\.key\),/);
});

test("the search box is in the topbar and says what it searches", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /<GlobalSearch\s+compact=\{narrowTopbar\}/);
  const box = await read("app/(app)/portal/global-search.tsx");
  assert.match(box, /fetch\(`\/api\/search\?q=\$\{encodeURIComponent\(term\)\}`/);
  assert.match(box, /event\.ctrlKey \|\| event\.metaKey/, "Ctrl/Cmd+K");
  const css = await read("app/(app)/portal/global-search.css");
  for (const width of css.matchAll(/max-width:\s*(\d+)px\)/g)) {
    assert.ok(["640", "767", "768", "1024", "1280"].includes(width[1]), `media query width ${width[1]} is not an allowed breakpoint`);
  }
  const explore = await read("app/(app)/portal/views/account-explore.tsx");
  assert.doesNotMatch(explore, /No global command palette/, "the shortcuts card no longer says there is none");
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const DEMO = "org_000000000000000000000002";
const STAMP = `${Date.now()}`;

const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

function jar(response) {
  return (response.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
}

async function call(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

let ownerCookie = null;
const invited = [];
after(async () => {
  if (!serverUp || !ownerCookie) return;
  await call(ownerCookie, "/api/admin/roles", { method: "PUT", body: JSON.stringify({ organisationId: DEMO, changes: [{ role: "client", capability: "board.view", allowed: null }] }) });
  const roster = await call(ownerCookie, `/api/admin/users?organisationId=${DEMO}`);
  for (const user of roster.body?.users ?? []) {
    if (!invited.includes(user.email) || !user.active) continue;
    await call(ownerCookie, "/api/admin/users", { method: "PATCH", body: JSON.stringify({ userId: user.id, action: "deactivate", organisationId: DEMO }) });
  }
});

test("live: the owner finds jobs and sites; a client is told only what a client may see", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  ownerCookie = jar(login);

  const short = await call(ownerCookie, "/api/search?q=a");
  assert.equal(short.status, 400, "one character is refused in words");

  /* Signed out: 401 when deployed. A dev server answers an anonymous caller as
     the demonstration identity on purpose (`demoIdentityAllowed`), so here the
     only claim is that it is not a crash; the 401 is proven on the Preview. */
  const anonymous = await call(null, "/api/search?q=aldgate");
  assert.ok([200, 401].includes(anonymous.status), `signed out: ${anonymous.status}`);

  const owner = await call(ownerCookie, "/api/search?q=mn-");
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.ok(owner.body.searched.includes("jobs"));
  assert.ok(owner.body.searched.includes("people"), "an owner holds users.view");

  /* A client in the demonstration workspace. */
  const email = `p36-client-${STAMP}@sec.test.maintsupp.com`;
  const created = await call(ownerCookie, "/api/admin/users", { method: "POST", body: JSON.stringify({ email, role: "client", organisationId: DEMO }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  invited.push(email);
  const token = String(created.body.inviteUrl).split("/invite/")[1];
  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: `p36 fixture ${STAMP} ok`, fullName: "P36 client" }) });
  assert.equal(accepted.status, 201);
  const client = jar(accepted);

  const asClient = await call(client, "/api/search?q=an");
  assert.equal(asClient.status, 200, JSON.stringify(asClient.body));
  for (const withheld of ["invoices", "quotes", "people"]) {
    assert.ok(!asClient.body.searched.includes(withheld), `a client is not searched for ${withheld}`);
  }
  assert.ok(asClient.body.searched.includes("jobs"));

  const revoked = await call(ownerCookie, "/api/admin/roles", { method: "PUT", body: JSON.stringify({ organisationId: DEMO, changes: [{ role: "client", capability: "board.view", allowed: false }] }) });
  assert.equal(revoked.status, 200);
  assert.equal((await call(client, "/api/search?q=an")).status, 403, "no board, no search");
});
