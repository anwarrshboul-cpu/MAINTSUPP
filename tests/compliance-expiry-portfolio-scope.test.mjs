/**
 * THE COMPLIANCE EXPIRY TIMELINE COUNTS THE PAGE'S PORTFOLIO (2026-09-25).
 *
 * Every other figure on /dashboard/compliance answers inside the header's
 * portfolio — the portfolio's member sites ∩ the member's own sites, resolved by
 * `resolveDashboardPortfolio`. The Expiry timeline was handed the workspace
 * snapshot whole, so on the "Europe" portfolio (0 sites, 0 requirements) it still
 * said "199 certificates due" and "71 already expired".
 *
 * It now counts over the SAME resolved set, taken from the Compliance block's
 * payload. These tests run that exact chain on real code: the product's own
 * portfolio relationship (`site_groups` + `site_group_members`, built from
 * `db/init.ts`) → `resolveDashboardPortfolio` → the payload's encoding
 * (`drillSiteIds`) → the client's reading of it (`scopeFromPayloadSiteIds`) →
 * `recordsInScope` → `expiryTimeline`. The wiring that joins them on the page is
 * pinned by source at the end.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const { resolveDashboardPortfolio } = await import("../app/lib/overview-metrics.ts");
const { drillSiteIds, NO_SITE_IN_SCOPE } = await import("../app/lib/job-metrics.ts");
const { expiryTimeline, recordsInScope, scopeFromPayloadSiteIds } = await import(
  "../app/lib/compliance-expiry-timeline.ts"
);

/* ── The estate ───────────────────────────────────────────────────────────── */

const ORG = "org-a";
const OTHER_ORG = "org-b";

/*
 * Organisation A:
 *   North  = north-1, north-2   (records)
 *   South  = south-1            (a site, but no certificate on it)
 *   Europe = no sites at all    (the measured case)
 *   loose-1 belongs to no portfolio.
 * Organisation B has its own portfolio and site; A must never resolve either.
 */
async function estate() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY);");
  sqlite.exec("CREATE TABLE sites (id TEXT PRIMARY KEY);");
  const init = await read("db/init.ts");
  for (const table of ["site_groups", "site_group_members"]) {
    const ddl = init.match(new RegExp("`(CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\))`"));
    assert.ok(ddl, `${table} is still created by db/init.ts`);
    sqlite.exec(ddl[1]);
  }
  for (const org of [ORG, OTHER_ORG]) sqlite.prepare("INSERT INTO organisations VALUES (?)").run(org);
  for (const site of ["north-1", "north-2", "south-1", "loose-1", "b-1"]) {
    sqlite.prepare("INSERT INTO sites VALUES (?)").run(site);
  }
  const group = sqlite.prepare(
    "INSERT INTO site_groups (id, organisation_id, name, slug) VALUES (?, ?, ?, ?)",
  );
  group.run("grp-north", ORG, "North", "north");
  group.run("grp-south", ORG, "South", "south");
  group.run("grp-europe", ORG, "Europe", "europe");
  group.run("grp-b", OTHER_ORG, "B portfolio", "b-portfolio");
  const member = sqlite.prepare(
    "INSERT INTO site_group_members (id, organisation_id, site_group_id, site_id) VALUES (?, ?, ?, ?)",
  );
  member.run("m1", ORG, "grp-north", "north-1");
  member.run("m2", ORG, "grp-north", "north-2");
  member.run("m3", ORG, "grp-south", "south-1");
  member.run("m4", OTHER_ORG, "grp-b", "b-1");

  return drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
}

/* Organisation A's register, as the workspace snapshot carries it. */
const NOW = new Date("2026-09-25T10:00:00Z");
const RECORDS = [
  { id: "r1", siteId: "north-1", expiry: "2026-08-01" }, // expired
  { id: "r2", siteId: "north-1", expiry: "2026-10-15" }, // Oct
  { id: "r3", siteId: "north-2", expiry: "2027-01-10" }, // Jan
  { id: "r4", siteId: "north-2", expiry: null }, // no date: counted nowhere
  { id: "r5", siteId: "loose-1", expiry: "2026-11-20" }, // Nov
  { id: "r6", siteId: "loose-1", expiry: "2026-07-01" }, // expired
];

/** The page's chain, end to end: portfolio → payload → client → figures. */
async function timelineFor(db, portfolioId, siteScope = null) {
  const resolved = await resolveDashboardPortfolio(db, ORG, portfolioId, siteScope);
  const payloadSiteIds = drillSiteIds(resolved.siteIds); // what /api/compliance/metrics sends
  const scope = scopeFromPayloadSiteIds(payloadSiteIds); // what the page reads back
  return { resolved, scope, timeline: expiryTimeline(recordsInScope(RECORDS, scope), NOW) };
}

const monthCounts = (timeline) =>
  Object.fromEntries(timeline.slots.filter((slot) => slot.count).map((slot) => [slot.label, slot.count]));

/* ── 1–4. The four behaviours the owner named ─────────────────────────────── */

test("all portfolios: the whole workspace, across several portfolios and sites", async () => {
  const db = await estate();
  const { scope, timeline } = await timelineFor(db, null);
  assert.equal(scope, null, "nothing to narrow");
  assert.equal(timeline.expired, 2, "north-1 and loose-1 each have a lapsed certificate");
  assert.equal(timeline.total, 3);
  assert.deepEqual(monthCounts(timeline), { Oct: 1, Nov: 1, Jan: 1 });
  assert.equal(timeline.slots.length, 12, "twelve months, zeros included");
  assert.equal(timeline.slots[0].key, "2026-8", "this month first (September, zero-based month)");
});

test("a chosen portfolio counts only its own sites", async () => {
  const db = await estate();
  const { resolved, timeline } = await timelineFor(db, "grp-north");
  assert.equal(resolved.chosen?.name, "North");
  assert.deepEqual([...resolved.siteIds].sort(), ["north-1", "north-2"]);
  assert.equal(timeline.expired, 1, "only north-1's lapsed certificate");
  assert.equal(timeline.total, 2);
  assert.deepEqual(monthCounts(timeline), { Oct: 1, Jan: 1 }, "loose-1's November is not North's");
});

test("a portfolio with no certificates — or no sites at all — is zero, never the workspace", async () => {
  const db = await estate();
  const south = await timelineFor(db, "grp-south");
  assert.deepEqual(south.resolved.siteIds, ["south-1"]);
  assert.equal(south.timeline.expired, 0);
  assert.equal(south.timeline.total, 0);

  /* The measured case: Europe has no member site. */
  const europe = await timelineFor(db, "grp-europe");
  assert.deepEqual(europe.resolved.siteIds, [], "resolves to no sites");
  assert.deepEqual(drillSiteIds(europe.resolved.siteIds), [NO_SITE_IN_SCOPE], "sent as the no-site sentinel");
  assert.notEqual(europe.scope, null, "and read back as a narrowing, not as 'every site'");
  assert.equal(europe.timeline.expired, 0, "was 71 on the local estate");
  assert.equal(europe.timeline.total, 0, "was 199 on the local estate");
});

test("clearing the portfolio restores the workspace figures", async () => {
  const db = await estate();
  const before = await timelineFor(db, null);
  await timelineFor(db, "grp-europe");
  const after = await timelineFor(db, "");
  assert.deepEqual(after.timeline, before.timeline);
});

/* ── Isolation ────────────────────────────────────────────────────────────── */

test("another organisation's portfolio is never resolved, and its sites are never counted", async () => {
  const db = await estate();
  const { resolved, timeline } = await timelineFor(db, "grp-b");
  assert.equal(resolved.chosen, null, "B's portfolio id means nothing in A");
  assert.ok(!resolved.portfolios.some((row) => row.id === "grp-b"), "and is not offered");
  assert.equal(resolved.siteIds, null, "A's own workspace, not B's sites");
  assert.equal(timeline.total, 3);
  const foreign = recordsInScope([{ id: "b", siteId: "b-1", expiry: "2026-10-01" }], ["north-1", "north-2"]);
  assert.deepEqual(foreign, [], "a site outside the resolved set is outside the count");
});

test("a site-restricted member counts only their sites, under every portfolio", async () => {
  const db = await estate();
  const scope = ["north-2"];

  const all = await timelineFor(db, null, scope);
  assert.deepEqual(all.scope, ["north-2"], "All portfolios is the member's own sites");
  assert.equal(all.timeline.expired, 0, "north-1 and loose-1 are not theirs");
  assert.deepEqual(monthCounts(all.timeline), { Jan: 1 });

  const north = await timelineFor(db, "grp-north", scope);
  assert.deepEqual(north.resolved.siteIds, ["north-2"], "the portfolio ∩ the member's sites");
  assert.deepEqual(monthCounts(north.timeline), { Jan: 1 });

  const south = await timelineFor(db, "grp-south", scope);
  assert.deepEqual(south.resolved.siteIds, [], "none of South is theirs");
  assert.equal(south.timeline.total + south.timeline.expired, 0);

  /* The rule the register applies: a record with no site is outside any narrowed scope. */
  assert.deepEqual(recordsInScope([{ id: "x", siteId: null, expiry: "2026-10-01" }], scope), []);
});

test("the register's day: a certificate due today is due, not expired", () => {
  const today = expiryTimeline([{ expiry: "2026-09-25" }], NOW);
  assert.equal(today.expired, 0);
  assert.equal(today.slots[0].count, 1);
  const yesterday = expiryTimeline([{ expiry: "2026-09-24" }], NOW);
  assert.equal(yesterday.expired, 1);
});

/* ── The page is wired to that chain ──────────────────────────────────────── */

test("the page feeds the timeline the Compliance block's own scope, with no request of its own", async () => {
  const portal = code(await read("app/(app)/portal/portal-app.tsx"));
  const view = portal.slice(portal.indexOf("function ComplianceView("), portal.indexOf("function ComplianceView(") + 4000);
  assert.match(view, /const \[timelineScope, setTimelineScope\] = useState<ExpiryTimelineScope>\(\{ state: "loading" \}\);/);
  assert.match(view, /<CpDash[\s\S]*?onScope=\{setTimelineScope\}/);
  assert.match(view, /<ComplianceExpiryTimeline compliance=\{complianceRecords\} now=\{now\} scope=\{timelineScope\} \/>/);
  assert.match(view, /aria-busy=\{timelineScope\.state === "ready" && timelineScope\.pending \? true : undefined\}/);

  const dash = code(await read("app/(app)/portal/ops/cp-dash.tsx"));
  assert.match(dash, /siteIds: scopeFromPayloadSiteIds\(data\.portfolio\.siteIds\),\s*pending: stale,/);
  assert.match(dash, /onScope\(error \? \{ state: "failed" \} : \{ state: "loading" \}\);/, "never the workspace while unknown");

  const insights = code(await read("app/(app)/portal/dashboard-insights.tsx"));
  const timeline = insights.slice(insights.indexOf("export function ComplianceExpiryTimeline"), insights.indexOf("/* ── Reactive versus planned"));
  assert.match(timeline, /expiryTimeline\(recordsInScope\(compliance, siteIds\), new Date\(clock\)\)/);
  assert.doesNotMatch(timeline, /fetch\(|useOpsQuery/, "no request of its own");
  assert.match(timeline, /if \(!months\) \{\s*return \(\s*<InsightPanel title=\{title\} hint=\{hint\} loading>/);

  /* The encoding the reader relies on is the one the payload is built with. */
  const builder = await read("app/lib/compliance-dash.ts");
  assert.match(builder, /siteIds: drillSiteIds\(input\.portfolio\.siteIds\),/);
  const route = await read("app/api/compliance/metrics/route.ts");
  assert.match(route, /resolveDashboardPortfolio\(db, orgId, url\.searchParams\.get\("portfolio"\), siteScope\)/);
});
