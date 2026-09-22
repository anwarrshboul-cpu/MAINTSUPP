/**
 * Public intake — contractor applications and the two marketing-site doors.
 *
 * MEASURED BEFORE THE FIX (local repro, 2026-09-22): an anonymous POST to
 * `/api/contractor-applications` was filed under `org_000000000000000000000001`,
 * which on this installation is **Sunnamusk UK, a real client company** — the
 * anonymous-resolved PRIMARY organisation — while the platform's own intake
 * workspace (`org_maintsupp_website_leads`, the one #59 created for leads) sat
 * unused beside it. Nothing read the rows, so nothing had leaked; the first
 * workspace capability over them would have shown that customer every contractor
 * who ever applied to MAINTSUPP.
 *
 * Pinned here: new applications go to the intake workspace (never the anonymous
 * org, never a fallback to a customer); `/api/leads` and
 * `/api/contractor-applications` are throttled per address before anything is
 * read or written; the new inbox answers to platform staff only; the public route
 * stays write-only.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const statuses = await import("../app/lib/application-status.ts");

test("a new application is filed under the platform's intake workspace, never the anonymous-resolved one", async () => {
  const route = code(await read("app/api/contractor-applications/route.ts"));
  assert.match(route, /\.where\(eq\(organisations\.id, WEBSITE_LEADS_WORKSPACE_ID\)\)/, "resolved by the fixed id, from the database");
  assert.match(route, /organisationId: intake\.id,/, "the row names the intake workspace");
  assert.doesNotMatch(route, /organisationId: orgId/, "never the org scopedDb resolves for a stranger");
  assert.doesNotMatch(route, /const \{ db, orgId \} = await scopedDb/, "the anonymous org is not even read");
  const insert = route.indexOf("db.insert(contractorApplications)");
  assert.ok(route.indexOf("if (!intake)") < insert, "a missing intake workspace refuses before anything is written");
  assert.match(route.slice(route.indexOf("if (!intake)"), insert), /status: 503/, "and refuses with a 503, not a fallback");
  assert.match(route, /sendNotification\(db, \{\s*organisationId: intake\.id,/, "the alert is logged against the same workspace");
});

test("both marketing-site doors are throttled per address before anything is read or written", async () => {
  for (const [file, throttle] of [
    ["app/api/contractor-applications/route.ts", "CONTRACTOR_APPLICATIONS"],
    ["app/api/leads/route.ts", "LEAD_SUBMISSIONS"],
  ]) {
    const source = code(await read(file));
    const post = source.slice(source.indexOf("export async function POST"));
    const check = post.indexOf(`publicRetryAfter(d1, ${throttle}, address)`);
    const count = post.indexOf(`recordPublicAttempt(d1, ${throttle}, address)`);
    const body = post.indexOf("await request.json()");
    assert.ok(check > 0 && count > check && body > count, `${file}: throttle, then count, then read the body`);
    assert.match(post, /const address = requestIp\(request\);/, `${file}: keyed per address`);
    assert.match(post, /if \(wait > 0\) return tooManyAttempts\(wait\);/, `${file}: the 429 every public door answers`);
  }
  const leads = code(await read("app/api/leads/route.ts"));
  const post = leads.slice(leads.indexOf("export async function POST"));
  assert.ok(post.indexOf("LEAD_SUBMISSIONS") < post.indexOf("clean(payload.website, 200)"), "a honeypot hit counts too");
  const throttles = await import("../app/lib/form-throttle.ts");
  for (const name of ["LEAD_SUBMISSIONS", "CONTRACTOR_APPLICATIONS"]) {
    assert.equal(throttles[name].max, 10, `${name} allows ten`);
    assert.equal(throttles[name].windowMs, 10 * 60_000, `${name} per ten minutes`);
  }
});

test("the inbox answers to platform staff only, and the public route stays write-only", async () => {
  const inbox = code(await read("app/api/contractor-applications/inbox/route.ts"));
  for (const method of ["GET", "PATCH"]) {
    const handler = inbox.slice(inbox.indexOf(`export async function ${method}`));
    const gate = handler.indexOf("scope.platformAdmin !== true || !scope.authenticated");
    assert.ok(gate > 0 && gate < handler.indexOf("contractorApplications"), `${method}: the gate comes before any read`);
    assert.match(handler.slice(gate, gate + 300), /status: 403/);
  }
  assert.match(inbox, /inArray\(contractorApplications\.organisationId, scope\.organisationIds\)/, "confined to what platform staff may see");
  assert.match(inbox, /if \(!isApplicationStatus\(body\?\.status\)\)/, "a status cannot be invented");
  const publicRoute = code(await read("app/api/contractor-applications/route.ts"));
  assert.doesNotMatch(publicRoute, /export async function GET/, "no public read of the application register");
  const page = await read("app/(app)/admin/applications/page.tsx");
  assert.ok(page.indexOf("requirePageSession(\"/admin/applications\")") < page.indexOf("requirePlatformAdmin()"), "sign-in first, then platform staff");
});

test("the application vocabulary starts at the database default and is closed", async () => {
  assert.equal(statuses.APPLICATION_STATUSES[0].key, "New");
  assert.equal(statuses.DEFAULT_APPLICATION_STATUS, "New");
  const schema = await read("db/schema.ts");
  const table = schema.slice(schema.indexOf("export const contractorApplications"));
  assert.match(table.slice(0, 1500), /status: text\("status"\)\.notNull\(\)\.default\("New"\)/, "the same default the column has");
  assert.equal(new Set(statuses.APPLICATION_STATUS_KEYS).size, statuses.APPLICATION_STATUSES.length);
  assert.ok(statuses.isApplicationStatus("In review"));
  assert.ok(!statuses.isApplicationStatus("Hired"), "a request cannot invent a status");
  assert.equal(statuses.applicationStatus("Something old").closed, false, "an unknown state counts as open work");
  assert.ok(statuses.APPLICATION_OMISSIONS.some((line) => /contractor register/.test(line)), "approving is honest about what it does not do");
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com", password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026" };
const RUN = `P11-QA-${Date.now().toString(36)}`;
const serverUp = await (async () => {
  try {
    return (await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) })).status < 500;
  } catch {
    return false;
  }
})();

const application = (suffix) => ({
  company: `${RUN} ${suffix}`,
  contactName: "P11 QA",
  email: "p11-qa@example.test",
  phone: "0100 000 0000",
  regions: "London",
  trades: ["Glazing"],
  insured: "Yes",
  consent: true,
});
const post = (route, body) =>
  fetch(`${BASE_URL}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("live: an application lands in the intake workspace and in the platform inbox, and nowhere else", { skip: !serverUp }, async (t) => {
  const created = await post("/api/contractor-applications", application("routing"));
  if (created.status === 429) return t.skip("this address is throttled right now");
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const inbox = await (await fetch(`${BASE_URL}/api/contractor-applications/inbox`, { headers: { cookie } })).json();
  const row = inbox.applications.find((entry) => entry.id === id);
  assert.ok(row, "platform staff see it");
  assert.equal(row.organisationId, "org_maintsupp_website_leads", "filed under the platform's intake workspace");
  assert.equal(row.status, "New");

  const moved = await fetch(`${BASE_URL}/api/contractor-applications/inbox`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, status: "In review", reason: `${RUN} vetting` }),
  });
  assert.equal(moved.status, 200);
  const invented = await fetch(`${BASE_URL}/api/contractor-applications/inbox`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, status: "Hired" }),
  });
  assert.equal(invented.status, 400);

  // A workspace admin — the local testing identity — is not platform staff.
  const outsider = await fetch(`${BASE_URL}/api/contractor-applications/inbox`, {
    headers: { "x-maintsupp-identity": "admin@demo-client-ltd.test.maintsupp.com" },
  });
  assert.equal(outsider.status, 403);
});

test("live: the eleventh submission from one address inside ten minutes is refused, on both doors", { skip: !serverUp }, async () => {
  let applications = 0;
  let refused = 0;
  for (let index = 0; index < 11; index += 1) {
    const response = await post("/api/contractor-applications", application(`throttle ${index}`));
    if (response.status === 201) applications += 1;
    if (response.status === 429) refused += 1;
  }
  assert.ok(refused >= 1, `an eleventh application was not refused (${applications} accepted)`);
  let leads = 0;
  let leadRefused = 0;
  for (let index = 0; index < 11; index += 1) {
    const response = await post("/api/leads", { name: "P11 QA", company: `${RUN} lead ${index}`, email: `p11.${index}@example.test`, siteRange: "11–25" });
    if (response.status === 201) leads += 1;
    if (response.status === 429) leadRefused += 1;
  }
  assert.ok(leadRefused >= 1, `an eleventh lead was not refused (${leads} accepted)`);
});

/* This run's rows and throttle counters, removed from the local D1 by marker —
   the counters too, or every later live test that posts a lead from this address
   would be refused for ten minutes. */
after(async () => {
  if (!serverUp) return;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const { readdir } = await import("node:fs/promises");
    const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sqlite"))) {
      const db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
      try {
        db.prepare("DELETE FROM contractor_applications WHERE company LIKE ?").run(`${RUN}%`);
        db.prepare("DELETE FROM leads WHERE company LIKE ?").run(`${RUN}%`);
        db.prepare("DELETE FROM sign_in_failures WHERE key LIKE 'throttle:contractor-application|%' OR key LIKE 'throttle:lead-submit|%'").run();
      } catch {
        /* Not the portal's database file. */
      } finally {
        db.close();
      }
    }
  } catch {
    console.warn(`${RUN}: local fixtures could not be swept`);
  }
});
