/**
 * WHO RENEWS A CERTIFICATE — an optional link to a real contractor record — and
 * THE REGISTER ANSWERS INSIDE THE HEADER'S PORTFOLIO.
 *
 * Two approved changes to the Compliance register, tested together because both
 * are about which rows a figure and its drill describe:
 *
 *   · `compliance_documents.provider_contractor_id`: the contractor RECORD booked
 *     to renew a requirement. Optional, tenant-checked, never inferred from a
 *     matching name, never confused with the duty holder. "Who's renewing"
 *     groups by it where it is set and keeps every unlinked renewal visible by
 *     its free text.
 *   · the register's reads resolve the header's `portfolio` (∩ the member's
 *     sites), so a drill's stale `site=` list cannot show a store outside the
 *     portfolio the reader switched to.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const { complianceRowsFrom, filterComplianceRows, parseComplianceFilters, NO_PROVIDER } = await import(
  "../app/lib/compliance-view.ts"
);
const { buildComplianceDashboard } = await import("../app/lib/compliance-dash.ts");
const { complianceStateFor } = await import("../app/lib/store-documentation-register.ts");

const TODAY = new Date("2026-09-11T10:00:00Z");
const inDays = (n) => {
  const at = new Date(Date.UTC(2026, 8, 11));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
};

function entry({ site = "s1", kind, expiry = null, files = 1, provider = null }) {
  return {
    id: `${site}:${kind}`,
    siteId: site,
    siteName: site,
    kind,
    dutyHolder: null,
    state: complianceStateFor({ tracksExpiry: true, expiry, fileCount: files, today: TODAY }),
    expiry,
    fileCount: files,
    itemId: `item-${site}`,
    slotKey: kind.toLowerCase(),
    providerContractorId: provider,
  };
}

const MANAGERS = new Map([["s1", "Alice"], ["s2", "Bob"]]);
const NAMES = new Map([["c-acme", "Acme Fire"], ["c-blue", "Blue Water Hygiene"]]);

/* PAT Testing and Fire Alarm are chased by different roles on the board; "Water
   Hygiene" falls back to the manager. Two renewals share the fire role's text —
   one linked, one not — which is the case a text-only drill would get wrong. */
const ESTATE = [
  entry({ site: "s1", kind: "Fire Alarm", expiry: inDays(10), provider: "c-acme" }),
  entry({ site: "s2", kind: "Fire Alarm", expiry: inDays(20) }),
  entry({ site: "s1", kind: "Legionella", expiry: inDays(-2), provider: "c-blue" }),
  entry({ site: "s2", kind: "Legionella", expiry: inDays(40), provider: "c-gone" }),
  entry({ site: "s1", kind: "PAT Testing", expiry: inDays(400) }),
];

const build = (entries) =>
  buildComplianceDashboard({
    rows: complianceRowsFrom(entries, MANAGERS, NAMES),
    today: TODAY,
    portfolio: { id: "all", name: "All portfolios", siteIds: null },
    portfolios: [],
    range: { from: null, to: null, label: "Any due date" },
    activeSiteIds: ["s1", "s2"],
    warningWindowDays: 90,
  });

const opens = (entries, filter) => {
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries(filter)) for (const value of values) params.append(key, value);
  return filterComplianceRows(
    complianceRowsFrom(entries, MANAGERS, NAMES),
    parseComplianceFilters(new URL(`http://x/?${params}`)),
    TODAY,
  ).length;
};

/* ── The rows ─────────────────────────────────────────────────────────────── */

test("a linked requirement carries its contractor's name; a dangling link reads as unlinked", () => {
  const rows = complianceRowsFrom(ESTATE, MANAGERS, NAMES);
  const byKey = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual([byKey.get("s1:Fire Alarm").providerContractorId, byKey.get("s1:Fire Alarm").providerName], ["c-acme", "Acme Fire"]);
  assert.deepEqual([byKey.get("s2:Fire Alarm").providerContractorId, byKey.get("s2:Fire Alarm").providerName], [null, null], "null is allowed");
  assert.deepEqual([byKey.get("s2:Legionella").providerContractorId, byKey.get("s2:Legionella").providerName], [null, null],
    "a contractor that is not this organisation's (or is gone) is never printed as an id");
  assert.notEqual(byKey.get("s1:Fire Alarm").responsibility, "Acme Fire", "the provider never replaces who chases it");
  assert.deepEqual(complianceRowsFrom(ESTATE, MANAGERS).map((row) => row.providerName), [null, null, null, null, null],
    "no names supplied, nothing linked — the builder never guesses one");
});

test("the register filters by contractor record, and `__none__` is every unlinked requirement", () => {
  assert.equal(opens(ESTATE, { contractor: ["c-acme"] }), 1);
  assert.equal(opens(ESTATE, { contractor: ["c-acme", "c-blue"] }), 2, "OR within the dimension");
  assert.equal(opens(ESTATE, { contractor: [NO_PROVIDER] }), 3, "unlinked, including the dangling link");
  assert.equal(opens(ESTATE, { contractor: ["c-other-tenant"] }), 0, "an unknown id opens nothing");
});

/* ── Who's renewing ───────────────────────────────────────────────────────── */

test("who's renewing groups by the contractor record, keeps the unlinked by their text, and says how many of each", () => {
  const metrics = build(ESTATE);
  const renewals = metrics.renewals;
  assert.equal(renewals.total, 4, "three expiring and one expired");
  assert.equal(renewals.linked, 2, "Acme Fire and Blue Water, by record");
  assert.equal(renewals.unlinked, 2, "the unlinked fire alarm and the dangling link — never dropped");
  assert.equal(renewals.linked + renewals.unlinked, renewals.total);
  const acme = renewals.slices.find((slice) => slice.label === "Acme Fire");
  assert.ok(acme?.linked, "a linked slice is marked linked");
  assert.deepEqual(acme.filter.contractor, ["c-acme"], "and drills by the record's id, not its name");
  const unlinked = renewals.slices.filter((slice) => !slice.linked);
  assert.ok(unlinked.length >= 1);
  for (const slice of unlinked) assert.deepEqual(slice.filter.contractor, [NO_PROVIDER], `${slice.label} drills to the unlinked only`);
  assert.equal(metrics.dataGaps.unlinkedResponsibility, 2);
  assert.deepEqual(metrics.reconciliation, []);
});

test("every renewal slice opens exactly the renewals it counted — even where a linked and an unlinked renewal share a role", () => {
  const metrics = build(ESTATE);
  for (const slice of metrics.renewals.slices) {
    assert.equal(opens(ESTATE, slice.filter), slice.value, `slice ${slice.label}`);
  }
  assert.equal(opens(ESTATE, metrics.renewals.allFilter), metrics.renewals.total);
});

test("with nothing linked the block behaves exactly as before — every renewal unlinked, by its text", () => {
  const plain = ESTATE.map((row) => ({ ...row, providerContractorId: null }));
  const metrics = build(plain);
  assert.equal(metrics.renewals.linked, 0);
  assert.equal(metrics.renewals.unlinked, metrics.renewals.total);
  assert.ok(metrics.renewals.slices.every((slice) => !slice.linked));
});

test("site-type applicability is reported as the design, not as missing configuration", () => {
  assert.equal(build(ESTATE).dataGaps.siteTypeApplicability, "per-site");
});

/* ── The writes, by source ────────────────────────────────────────────────── */

test("the provider route is capability-gated, tenant-checked, allow-listed by the register, and audited", async () => {
  const route = codeOnly(await read("app/api/compliance/provider/route.ts"));
  assert.match(route, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.match(route, /resolveProviderContractor\(db, orgId, body\.contractorId\)/, "the contractor must be this organisation's");
  assert.ok(route.indexOf("resolveProviderContractor(") < route.indexOf(".update(complianceDocuments)"), "checked before any write");
  assert.match(route, /withinMemberScope\(allowed, entry\.siteId\)/, "only requirements inside the member's sites");
  assert.match(route, /None of those requirements are on this register\./);
  assert.match(route, /eq\(complianceDocuments\.organisationId, orgId\), inArray\(complianceDocuments\.id, chunk\)/, "tenant-scoped, chunked update");
  assert.match(route, /insert\(activityLog\)/);
  assert.match(route, /recordAudit\(\{/);
  assert.doesNotMatch(route, /issuedBy|issued_by/, "never inferred from the certificate's free text");
  const helper = codeOnly(await read("app/lib/compliance-provider.ts"));
  assert.match(helper, /eq\(contractors\.organisationId, organisationId\), eq\(contractors\.id, value\)/);
  assert.match(helper, /return \{ ok: false, error: "Contractor not found\.", status: 404 \};/, "one answer for none and another tenant's");
});

test("the workspace create and edit validate the same link, and the purge clears it", async () => {
  const route = await read("app/api/workspace/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));
  const branch = patch.slice(patch.indexOf('} else if (entity === "compliance") {'), patch.indexOf('} else if (entity === "unit") {'));
  assert.match(branch, /const providerSent = "providerContractorId" in data;/, "absent leaves it — the calendar never sends it");
  assert.match(branch, /\{ kind: "contractor", value: providerContractorId \|\| null \}/, "a named contractor must be this organisation's");
  assert.match(branch, /\.\.\.\(providerSent \? \{ providerContractorId: providerContractorId \|\| null \} : \{\}\)/);
  const trash = await read("app/api/trash/route.ts");
  assert.match(trash, /\.set\(\{ providerContractorId: null \}\)/, "a purged contractor leaves no dangling link");
  const schema = await read("db/schema.ts");
  assert.match(schema, /providerContractorId: text\("provider_contractor_id"\)\.references\(\(\) => contractors\.id, \{\s*onDelete: "set null",\s*\}\)/);
  const init = await read("db/init.ts");
  assert.match(init, /"provider_contractor_id",\s*"TEXT REFERENCES contractors\(id\) ON DELETE SET NULL"/);
});

/* ── Against the running estate ───────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const CLIENT = "client@sunnamusk-uk.test.maintsupp.com";

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function otherTenantContractorId() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  const file = (await readdir(directory).catch(() => [])).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  if (!file) return null;
  const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
  try {
    return db.prepare("SELECT id FROM contractors WHERE organisation_id <> 'org_000000000000000000000001' LIMIT 1").get()?.id ?? null;
  } finally {
    db.close();
  }
}

test("LIVE a requirement is linked, refused across tenants and to a client, and unlinked again", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
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
  const cookie = `${(login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ")}; maintsupp_demo_organisation=org_000000000000000000000001`;
  const as = (extra = {}) => ({ cookie, Accept: "application/json", ...extra });
  const summary = await (await fetch(`${BASE}/api/compliance/summary`, { headers: as() })).json();
  const group = summary.groups?.[0];
  const contractor = summary.providers?.find((provider) => provider.active);
  if (!group || !contractor) {
    t.skip("the estate needs a compliance group and an active contractor");
    return;
  }
  const records = await (await fetch(`${BASE}/api/compliance/records?key=${encodeURIComponent(group.siteId)}`, { headers: as() })).json();
  const target = records.records[0];
  const original = target.providerContractorId ?? null;
  const link = (contractorId, headers = as({ "content-type": "application/json" })) =>
    fetch(`${BASE}/api/compliance/provider`, {
      method: "POST",
      headers,
      body: JSON.stringify({ contractorId, records: [{ siteId: target.siteId, kind: target.kind }] }),
    });

  try {
    const linked = await link(contractor.id);
    assert.equal(linked.status, 200, await linked.clone().text());
    const after = await (await fetch(`${BASE}/api/compliance/records?key=${encodeURIComponent(group.siteId)}`, { headers: as() })).json();
    const row = after.records.find((record) => record.siteId === target.siteId && record.kind === target.kind);
    assert.equal(row.providerContractorId, contractor.id);
    assert.equal(row.providerName, contractor.name, "the register names the contractor");
    const filtered = await (await fetch(`${BASE}/api/compliance/records?contractor=${encodeURIComponent(contractor.id)}`, { headers: as() })).json();
    assert.ok(filtered.records.some((record) => record.siteId === target.siteId && record.kind === target.kind), "and filters by it");

    const foreign = await otherTenantContractorId();
    if (foreign) {
      const refused = await link(foreign);
      assert.equal(refused.status, 404, "another tenant's contractor cannot be linked");
    }
    assert.equal((await link("contractor-that-does-not-exist")).status, 404);
    const asClient = await fetch(`${BASE}/api/compliance/provider`, {
      method: "POST",
      headers: { "x-maintsupp-identity": CLIENT, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ contractorId: contractor.id, records: [{ siteId: target.siteId, kind: target.kind }] }),
    });
    assert.ok([401, 403].includes(asClient.status), `a client cannot link (answered ${asClient.status})`);

    const unlinked = await link(null);
    assert.equal(unlinked.status, 200);
    const cleared = await (await fetch(`${BASE}/api/compliance/records?key=${encodeURIComponent(group.siteId)}`, { headers: as() })).json();
    assert.equal(cleared.records.find((record) => record.siteId === target.siteId && record.kind === target.kind).providerContractorId ?? null, null);
  } finally {
    await link(original);
  }
});

test("LIVE the register answers inside the header's portfolio, whatever site list the address carries", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const headers = { "x-maintsupp-identity": ADMIN, Accept: "application/json" };
  const groups = (await (await fetch(`${BASE}/api/sites/groups`, { headers })).json()).groups ?? [];
  const all = await (await fetch(`${BASE}/api/compliance/summary`, { headers })).json();
  const registerSites = new Set(all.groups.map((group) => group.siteId));
  const portfolio = groups.find((group) => group.siteIds.some((id) => registerSites.has(id)) && group.siteIds.length < registerSites.size);
  if (!portfolio) {
    t.skip("no portfolio on this estate narrows the register");
    return;
  }
  const members = new Set(portfolio.siteIds);
  const outside = [...registerSites].find((id) => !members.has(id));
  const summary = await (await fetch(`${BASE}/api/compliance/summary?portfolio=${encodeURIComponent(portfolio.id)}`, { headers })).json();
  assert.ok(summary.groups.length > 0);
  for (const group of summary.groups) assert.ok(members.has(group.siteId), `${group.siteId} is in ${portfolio.name}`);
  assert.ok(summary.registerSites <= members.size);

  /* A drill's stale whole-estate site list, carried into the new portfolio. */
  const stale = await (await fetch(`${BASE}/api/compliance/summary?portfolio=${encodeURIComponent(portfolio.id)}&site=${encodeURIComponent(outside)}`, { headers })).json();
  assert.equal(stale.portfolio.total, 0, "a site outside the portfolio cannot be widened back in");
  const records = await (await fetch(`${BASE}/api/compliance/records?portfolio=${encodeURIComponent(portfolio.id)}&key=${encodeURIComponent(outside)}`, { headers })).json();
  assert.equal(records.total, 0);

  /* An id this organisation does not hold is "All portfolios", never an error or a wider set. */
  const unknown = await (await fetch(`${BASE}/api/compliance/summary?portfolio=not-a-portfolio`, { headers })).json();
  assert.equal(unknown.registerTotal, all.registerTotal);

  /* The block and the register agree about the portfolio's requirements. */
  const block = await (await fetch(`${BASE}/api/compliance/metrics?portfolio=${encodeURIComponent(portfolio.id)}`, { headers })).json();
  const scored = await (await fetch(`${BASE}/api/compliance/summary?portfolio=${encodeURIComponent(portfolio.id)}&scored=1`, { headers })).json();
  assert.equal(scored.portfolio.total, block.score.counts.compliant + block.score.counts.expiring + block.score.counts.expired + block.score.counts.missing);
});
