/**
 * A MEMBER CONFINED TO SOME SITES IS SENT ONLY THOSE SITES — AND ONLY THEIR SCORE.
 *
 * `memberships.site_scope` confines a member to named stores. The dashboard
 * endpoints honoured it through `resolveDashboardPortfolio`; the Sites view and
 * the Compliance register did not. So a member confined to two stores was sent
 * every store in the organisation, and the Sites page's "Portfolio compliance"
 * tile scored every requirement the organisation holds: numerator AND
 * denominator counted sites the member may not see. Aggregate leakage is
 * leakage.
 *
 * Three layers:
 *   1. the predicate (`member-site-scope.ts`), called directly;
 *   2. every read that draws the Sites view or the Compliance register is pinned
 *      to it by source, so a new read cannot quietly skip it;
 *   3. against the running estate, with purpose-built restricted members: the
 *      ids and counts each role is sent. Skips without a dev server, as ~32
 *      files in this suite already do.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { memberSiteSet, withinMemberScope } = await import("../app/lib/member-site-scope.ts");

/* ── 1. The predicate ─────────────────────────────────────────────────────── */

test("an unrestricted member sees every row, including a row with no site", () => {
  const allowed = memberSiteSet(null);
  assert.equal(allowed, null);
  assert.equal(withinMemberScope(allowed, "site-a"), true);
  assert.equal(withinMemberScope(allowed, null), true);
  assert.equal(withinMemberScope(allowed, undefined), true);
});

test("a restricted member sees their sites and nothing else — not even a row with no site", () => {
  const allowed = memberSiteSet(["site-a", "site-b"]);
  assert.equal(withinMemberScope(allowed, "site-a"), true);
  assert.equal(withinMemberScope(allowed, "site-b"), true);
  assert.equal(withinMemberScope(allowed, "site-c"), false);
  assert.equal(withinMemberScope(allowed, null), false, "nothing proves a site-less row is one of theirs");
  assert.equal(withinMemberScope(allowed, undefined), false);
  assert.equal(withinMemberScope(allowed, ""), false);
});

/* ── 2. Every read that draws the Sites view or the register uses it ──────── */

test("GET /api/sites confines the list, one site, the aggregate, the groups and the tile", async () => {
  const route = await read("app/api/sites/route.ts");
  const handler = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(handler, /const \{ actor, db, orgId, siteScope \} = await scopedDb\(request\);/);
  assert.match(handler, /const allowed = memberSiteSet\(siteScope\);/);
  assert.match(handler, /aggregated\s*\.filter\(\(row\) => withinMemberScope\(allowed, row\.id\)\)/, "the aggregate");
  assert.match(
    handler,
    /if \(!withinMemberScope\(allowed, id\)\) \{\s*return Response\.json\(\{ error: "Site not found\." \}, \{ status: 404 \}\);/,
    "one site outside the scope is not found, before any read",
  );
  assert.ok(
    handler.indexOf("withinMemberScope(allowed, id)") < handler.indexOf("getSite(db, orgId, id, scope)"),
    "the scope refusal comes before the site is loaded",
  );
  assert.match(handler, /const rows = listed\.filter\(\(row\) => withinMemberScope\(allowed, row\.id\)\);/, "the list");
  assert.match(handler, /siteIds: group\.siteIds\.filter\(\(siteId\) => withinMemberScope\(allowed, siteId\)\)/, "the groups");
  assert.match(
    handler,
    /complianceCompletion\(\s*allowed\s*\?\s*register\.entries\.filter\(\(entry\) => withinMemberScope\(allowed, entry\.siteId\)\)/,
    "the tile scores only the member's sites",
  );
  assert.match(handler, /const siteIds = rows\.map\(\(row\) => row\.id\);/, "per-site meters are drawn for the confined rows");
});

test("the Sites export, the groups read and the register's two reads are confined the same way", async () => {
  const csv = await read("app/api/sites/csv/route.ts");
  assert.match(csv, /const \{ db, orgId, siteScope \} = guard\.scope;/);
  assert.match(csv, /\.filter\(\(site\) =>\s*withinMemberScope\(allowed, site\.id\),?\s*\)/);

  const groups = await read("app/api/sites/groups/route.ts");
  const groupsGet = groups.slice(groups.indexOf("export async function GET"), groups.indexOf("export async function POST"));
  assert.match(groupsGet, /const \{ db, orgId, siteScope \} = await scopedDb\(request\);/);
  assert.match(groupsGet, /siteIds: group\.siteIds\.filter\(\(siteId\) => withinMemberScope\(allowed, siteId\)\)/);

  for (const file of ["app/api/compliance/summary/route.ts", "app/api/compliance/records/route.ts"]) {
    const source = await read(file);
    assert.match(source, /const \{ db, orgId, siteScope \} = guard\.scope;/, file);
    assert.match(source, /const allowed = memberSiteSet\(siteScope\);/, file);
    assert.match(
      source,
      /const scopedEntries = allowed\s*\?\s*register\.entries\.filter\(\(entry\) => withinMemberScope\(allowed, entry\.siteId\)\)\s*:\s*register\.entries;/,
      file,
    );
    assert.match(source, /const rows: ComplianceRow\[\] = scopedEntries\.map\(/, `${file} builds its rows from the confined entries`);
    assert.doesNotMatch(source, /register\.entries\.map\(/, `${file} never maps the unconfined register`);
  }
});

/* ── 3. Against the running estate ────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const OTHER_TENANT_ADMIN = "admin@demo-client-ltd.test.maintsupp.com";
const ORG = "org_000000000000000000000001";
/* The address shape `scripts/clean-test-accounts.mjs` sweeps, so an interrupted
   run's fixtures are still recognisably test accounts. */
const RUN = `scope-probe-${Date.now().toString(36)}`;
const RESTRICTED_CLIENT = `${RUN}-client@example.com`;
const RESTRICTED_ADMIN = `${RUN}-admin@example.com`;

const as = (email) => ({ "x-maintsupp-identity": email, Accept: "application/json" });
const getJson = async (url, email) => {
  const response = await fetch(`${BASE}${url}`, { headers: as(email) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/compliance/metrics`, { headers: as(ADMIN), signal: AbortSignal.timeout(4000) });
    return response.status < 500 && response.status !== 404;
  } catch {
    return false;
  }
}

async function openDevDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  const db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  /* The dev server holds this file open; wait for its writer rather than lose the race. */
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/** A purpose-built member of the dev organisation, confined to `siteIds`. */
function addRestrictedMember(db, email, role, siteIds) {
  const userId = `user-${RUN}-${role}`;
  db.prepare(
    "INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, ?, ?, 1)",
  ).run(userId, ORG, email, `Scope probe (${role})`, role);
  db.prepare(
    `INSERT INTO memberships (id, user_id, organisation_id, role, status, accepted_at, site_scope)
     VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, ?)`,
  ).run(`membership-${userId}-${ORG}`, userId, ORG, role, JSON.stringify(siteIds));
}

after(async () => {
  const db = await openDevDatabase().catch(() => null);
  if (!db) return;
  try {
    db.prepare("DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)").run(`${RUN}%`);
    db.prepare("DELETE FROM users WHERE email LIKE ?").run(`${RUN}%`);
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    db.close();
  }
});

test("LIVE a restricted member's Sites view, tile and register hold only their sites", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const db = await openDevDatabase();
  if (!db) {
    t.skip("no development database to add a restricted member to");
    return;
  }

  /* The unrestricted view, first: which stores exist and which hold requirements. */
  const adminSites = await getJson("/api/sites", ADMIN);
  const adminMetrics = await getJson("/api/compliance/metrics", ADMIN);
  const adminSummary = await getJson("/api/compliance/summary", ADMIN);
  assert.equal(adminSites.status, 200);
  const siteIds = new Set(adminSites.body.sites.map((site) => site.id));
  const withRequirements = adminSummary.body.groups
    .filter((group) => siteIds.has(group.siteId))
    .sort((a, b) => b.total - a.total)
    .map((group) => group.siteId);
  if (withRequirements.length < 3) {
    t.skip("the dev estate needs three sites holding requirements to prove a narrowing");
    return;
  }
  const scope = withRequirements.slice(0, 2);
  const outside = withRequirements[2];

  /* The unrestricted admin's tile is still the product's score. */
  assert.equal(adminSites.body.portfolioCompliance.percent, adminMetrics.body.score.percent);
  assert.equal(adminSites.body.portfolioCompliance.applicable, adminMetrics.body.score.applicable);

  try {
    addRestrictedMember(db, RESTRICTED_CLIENT, "client", scope);
    addRestrictedMember(db, RESTRICTED_ADMIN, "admin", scope);
  } finally {
    db.close();
  }

  for (const email of [RESTRICTED_CLIENT, RESTRICTED_ADMIN]) {
    const label = email.includes("-client@") ? "restricted client" : "restricted admin";

    /* The list: exactly the member's sites, by id. */
    const sites = await getJson("/api/sites", email);
    assert.equal(sites.status, 200, label);
    assert.deepEqual(
      sites.body.sites.map((site) => site.id).sort(),
      [...scope].sort(),
      `${label}: the Sites list is the scope, by id`,
    );
    assert.equal(sites.body.coverage.total, scope.length, `${label}: coverage counts the same rows`);

    /* The tile: the member's score, and the Compliance block's for the same member. */
    const metrics = await getJson("/api/compliance/metrics", email);
    assert.equal(metrics.status, 200, label);
    assert.equal(sites.body.portfolioCompliance.applicable, metrics.body.score.applicable, `${label}: denominator = the block's`);
    assert.equal(sites.body.portfolioCompliance.satisfied, metrics.body.score.satisfied, `${label}: numerator = the block's`);
    assert.equal(sites.body.portfolioCompliance.percent, metrics.body.score.percent, `${label}: percent = the block's`);
    assert.ok(
      sites.body.portfolioCompliance.applicable < adminSites.body.portfolioCompliance.applicable,
      `${label}: the denominator no longer counts the organisation (${sites.body.portfolioCompliance.applicable} of ${adminSites.body.portfolioCompliance.applicable})`,
    );

    /* One site: inside answers, outside is not found. */
    assert.equal((await getJson(`/api/sites?id=${encodeURIComponent(scope[0])}`, email)).status, 200, `${label}: own site`);
    assert.equal((await getJson(`/api/sites?id=${encodeURIComponent(outside)}`, email)).status, 404, `${label}: another site is not found`);

    /* The groups name no site outside the scope. */
    const groups = await getJson("/api/sites/groups", email);
    assert.equal(groups.status, 200, label);
    for (const group of groups.body.groups) {
      for (const member of group.siteIds) assert.ok(scope.includes(member), `${label}: group ${group.name} names ${member}`);
    }

    /* The register: its headers and its records, and a URL cannot widen it. */
    const summary = await getJson("/api/compliance/summary", email);
    assert.equal(summary.status, 200, label);
    for (const group of summary.body.groups) assert.ok(scope.includes(group.siteId), `${label}: register group ${group.siteId}`);
    assert.ok(summary.body.registerSites <= scope.length, `${label}: register sites`);
    const widened = await getJson(`/api/compliance/summary?site=${encodeURIComponent(outside)}`, email);
    assert.equal(widened.body.portfolio.total, 0, `${label}: ?site= naming another store opens nothing`);
    const records = await getJson(`/api/compliance/records?key=${encodeURIComponent(outside)}`, email);
    assert.equal(records.body.total, 0, `${label}: ?key= naming another store returns no records`);
    const own = await getJson(`/api/compliance/records?key=${encodeURIComponent(scope[0])}`, email);
    assert.ok(own.body.total > 0, `${label}: the member's own store still returns its records`);

    /* The export holds the same stores as the screen. */
    const csv = await fetch(`${BASE}/api/sites/csv`, { headers: as(email) });
    assert.equal(csv.status, 200, `${label}: export`);
    const lines = (await csv.text()).replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
    assert.equal(lines.length - 1, scope.length, `${label}: the export's rows are the scope`);
  }
});

test("LIVE another organisation's member is sent none of these sites", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const mine = await getJson("/api/sites", ADMIN);
  const theirs = await getJson("/api/sites", OTHER_TENANT_ADMIN);
  if (theirs.status !== 200) {
    t.skip("the second tenant's identity is not seeded on this database");
    return;
  }
  const myIds = new Set(mine.body.sites.map((site) => site.id));
  const leaked = theirs.body.sites.filter((site) => myIds.has(site.id));
  assert.deepEqual(leaked, [], "no site id crosses the tenant boundary");
  const theirSummary = await getJson("/api/compliance/summary", OTHER_TENANT_ADMIN);
  for (const group of theirSummary.body.groups) assert.ok(!myIds.has(group.siteId), `register group ${group.siteId}`);
});
