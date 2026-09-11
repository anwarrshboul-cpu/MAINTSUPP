/**
 * THE COMPLIANCE DASHBOARD BLOCK'S METRICS — the brief's §9, as tests.
 *
 * Three layers, the same three the Overview block's suite uses:
 *
 *   1. `buildComplianceDashboard` is PURE, so it is imported and CALLED with
 *      fixtures whose answers are known — through the real pipeline: states
 *      come from `complianceStateFor` against an injected "today", rows from
 *      `complianceRowsFrom`, drills are replayed through the register's own
 *      `parseComplianceFilters` + `filterComplianceRows`. A re-implementation
 *      in the test would agree with itself while the product disagreed.
 *   2. The route is pinned by source for what "reuse, do not redefine" means.
 *   3. The identities are checked against the LIVE endpoint and the register's
 *      own summary endpoint — the real destination of every drill. Those skip
 *      without a dev server, as ~32 files in this suite already do.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { buildComplianceDashboard, reconcileComplianceDashboard, countdownBands } = await import(
  "../app/lib/compliance-dash.ts"
);
const { complianceRowsFrom, filterComplianceRows, parseComplianceFilters, isScoredRow } = await import(
  "../app/lib/compliance-view.ts"
);
const { complianceStateFor } = await import("../app/lib/store-documentation-register.ts");
const { complianceCompletion, EXPIRY_DUE_SOON_DAYS } = await import("../app/lib/compliance-status.ts");

const TODAY = new Date("2026-09-11T10:00:00Z");

/** A day `n` after TODAY's calendar day. */
function inDays(n, from = TODAY) {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/**
 * One requirement, the way the register produces it: a slot, a file count and
 * an expiry, classified by the product's own classifier against `today`.
 */
function entry({ site = "s1", siteName = site, kind = "Fire Alarm", expiry = null, files = 1, tracks = true, notRequired = false, duty = null, id } = {}, today = TODAY) {
  return {
    id: id ?? `${site}:${kind}`,
    siteId: site,
    siteName,
    kind,
    dutyHolder: duty,
    state: complianceStateFor({ tracksExpiry: tracks, expiry, fileCount: files, notRequired, today }),
    expiry,
    fileCount: files,
    itemId: `item-${site}`,
    slotKey: kind.toLowerCase(),
  };
}

const MANAGERS = new Map([["s1", "Alice Manager"], ["s2", "Bob Manager"], ["s3", "Cara Manager"]]);

function build(entries, overrides = {}, today = TODAY) {
  return buildComplianceDashboard({
    rows: complianceRowsFrom(entries, MANAGERS),
    today,
    portfolio: { id: "all", name: "All portfolios", siteIds: null },
    portfolios: [],
    range: { from: null, to: null, label: "Any due date" },
    activeSiteIds: ["s1", "s2", "s3"],
    warningWindowDays: EXPIRY_DUE_SOON_DAYS,
    ...overrides,
  });
}

/** How many register rows a payload filter opens — the drill's destination. */
function opens(entries, filter, today = TODAY, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries({ ...filter, ...extra })) {
    for (const value of values) params.append(key, value);
  }
  const rows = complianceRowsFrom(entries, MANAGERS);
  return filterComplianceRows(rows, parseComplianceFilters(new URL(`http://x/?${params}`)), today).length;
}

/* A representative estate: every state, a not-required slot, an unconfirmed
   responsibility, a held certificate with no due date, three sites. */
const ESTATE = [
  entry({ site: "s1", kind: "Fire Alarm", expiry: inDays(400) }),
  entry({ site: "s1", kind: "PAT Testing", expiry: inDays(5) }),
  entry({ site: "s1", kind: "Gas Safety", expiry: inDays(-3) }),
  entry({ site: "s1", kind: "Emergency Lighting", files: 0 }),
  entry({ site: "s2", kind: "Fire Alarm", expiry: inDays(35) }),
  entry({ site: "s2", kind: "PAT Testing", expiry: inDays(55) }),
  entry({ site: "s2", kind: "Gas Safety", notRequired: true }),
  entry({ site: "s2", kind: "Emergency Lighting", expiry: null, files: 1 }),
  entry({ site: "s3", kind: "Fire Alarm", expiry: inDays(200) }),
  entry({ site: "s3", kind: "PAT Testing", expiry: inDays(300) }),
  entry({ site: "s3", kind: "Gas Safety", files: 0, duty: "unconfirmed" }),
];

/* ── Zero data ────────────────────────────────────────────────────────────── */

test("an empty estate is 'not scored', never a failing 0%", () => {
  const empty = build([], { activeSiteIds: [] });
  assert.equal(empty.score.scored, false, "nothing applicable is a different claim from 0%");
  assert.equal(empty.score.percent, 0);
  assert.deepEqual(empty.score.counts, { compliant: 0, expiring: 0, expired: 0, missing: 0 });
  assert.deepEqual(empty.types, []);
  assert.equal(empty.countdown.total, 0);
  assert.ok(empty.countdown.rings.every((ring) => ring.value === 0 && Number.isFinite(ring.value)));
  assert.equal(empty.countdown.rings.some((ring) => ring.key === "no-date"), false, "no permanent fifth zero");
  assert.deepEqual(empty.renewals.slices, []);
  assert.deepEqual([empty.sites.fullyCompliant, empty.sites.considered, empty.sites.percent], [0, 0, 0]);
  assert.deepEqual(empty.reconciliation, []);
});

/* ── The score is the product's rule ──────────────────────────────────────── */

test("the score is complianceCompletion's, and its four states partition Y", () => {
  const metrics = build(ESTATE);
  const completion = complianceCompletion(complianceRowsFrom(ESTATE, MANAGERS));
  assert.equal(metrics.score.percent, completion.percent);
  assert.equal(metrics.score.satisfied, completion.satisfied, "X");
  assert.equal(metrics.score.applicable, completion.applicable, "Y");
  const { compliant, expiring, expired, missing } = metrics.score.counts;
  assert.equal(compliant + expiring + expired + missing, metrics.score.applicable, "C + E + X + M = Y");
  assert.equal(metrics.score.notRequired, 1, "the not-required slot is reported, outside the score");
  assert.equal(metrics.score.excluded, 1, "so is the unconfirmed responsibility");
  assert.deepEqual(metrics.score.counts, { compliant: 3, expiring: 4, expired: 1, missing: 1 });
  assert.deepEqual(metrics.reconciliation, []);
});

test("a requirement marked not applicable is outside every count and denominator", () => {
  const withIt = build(ESTATE);
  const without = build(ESTATE.filter((row) => !(row.siteId === "s2" && row.kind === "Gas Safety")));
  assert.equal(withIt.score.applicable, without.score.applicable);
  assert.equal(withIt.score.percent, without.score.percent);
  const gas = withIt.types.find((ring) => ring.label === "Gas Safety");
  assert.equal(gas.total, 1, "Gas Safety counts s1's expired certificate only — s2 is not required, s3 unconfirmed");
});

test("a type with no certificates is a 0% ring, not a missing ring", () => {
  const metrics = build([
    entry({ site: "s1", kind: "Legionella", files: 0 }),
    entry({ site: "s2", kind: "Legionella", files: 0 }),
    entry({ site: "s1", kind: "Fire Alarm", expiry: inDays(400) }),
  ]);
  const legionella = metrics.types.find((ring) => ring.label === "Legionella");
  assert.equal(legionella.percent, 0);
  assert.equal(legionella.total, 2);
  assert.equal(legionella.counts.missing, 2);
  assert.equal(metrics.types[0].label, "Legionella", "worst first");
});

test("a certificate held with no due date follows the shipped rule and keeps the rings whole", () => {
  const metrics = build(ESTATE);
  /* `complianceStateFor`: a dated slot holding a file and no date is Expiring
     soon — we hold it and cannot say it is in date. */
  assert.equal(metrics.dataGaps.heldWithoutDueDate, 1);
  const noDate = metrics.countdown.rings.find((ring) => ring.key === "no-date");
  assert.ok(noDate, "a fifth ring appears when it has something to hold");
  assert.equal(noDate.value, 1);
  const windows = metrics.countdown.rings
    .filter((ring) => ring.key !== "expired")
    .reduce((sum, ring) => sum + ring.value, 0);
  assert.equal(windows, metrics.score.counts.expiring, "0–20 + 21–40 + 41–60 + no date = Expiring soon");
});

test("the countdown windows are thirds of the shipped warning window", () => {
  assert.equal(EXPIRY_DUE_SOON_DAYS, 60);
  assert.deepEqual(countdownBands(60).map((band) => band.label), ["0–20 days", "21–40 days", "41–60 days"]);
  assert.deepEqual(countdownBands(90).map((band) => band.label), ["0–30 days", "31–60 days", "61–90 days"],
    "the brief's own 90 would split the way the brief draws it");
  const metrics = build(ESTATE);
  const value = (key) => metrics.countdown.rings.find((ring) => ring.key === key).value;
  assert.equal(value("expired"), metrics.score.counts.expired, "Expired ring = Expired in the legend");
  assert.equal(value("band-1"), 1, "PAT at s1, 5 days");
  assert.equal(value("band-2"), 1, "Fire Alarm at s2, 35 days");
  assert.equal(value("band-3"), 1, "PAT at s2, 55 days");
});

test("free-text responsibilities are grouped by their normalised name and reported as unlinked", () => {
  const rows = complianceRowsFrom(ESTATE, MANAGERS).map((row, index) =>
    row.state === "Expired" || row.state === "Expiring soon"
      ? { ...row, responsibility: index % 2 ? "Fire  safety partner" : "fire safety partner" }
      : row,
  );
  const metrics = buildComplianceDashboard({
    rows,
    today: TODAY,
    portfolio: { id: "all", name: "All portfolios", siteIds: null },
    portfolios: [],
    range: { from: null, to: null, label: "Any due date" },
    activeSiteIds: ["s1", "s2", "s3"],
    warningWindowDays: 60,
  });
  assert.equal(metrics.renewals.slices.length, 1, "two spellings, one party");
  assert.equal(metrics.renewals.slices[0].value, metrics.renewals.total);
  assert.deepEqual(new Set(metrics.renewals.slices[0].filter.who), new Set(["Fire  safety partner", "fire safety partner"]),
    "and the drill carries both spellings, so the register opens every renewal the segment counted");
  assert.equal(metrics.renewals.unlinked, metrics.renewals.total, "none is silently linked to a contractor record");
  assert.equal(metrics.renewals.linked, 0);
  assert.equal(metrics.renewals.total, metrics.score.counts.expired + metrics.score.counts.expiring);
});

test("more than seven types: seven rings and an eighth that aggregates the rest", () => {
  const kinds = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const metrics = build(kinds.map((kind, index) => entry({ site: "s1", kind, expiry: index % 2 ? inDays(400) : inDays(-1) })));
  assert.equal(metrics.types.length, 8);
  assert.equal(metrics.types[7].label, "Other types");
  assert.equal(metrics.types[7].kinds.length, 2);
  assert.equal(metrics.typeCount, 9);
  assert.equal(metrics.types.reduce((sum, ring) => sum + ring.total, 0), metrics.score.applicable, "the grid adds up to Y");
  assert.equal(metrics.types.reduce((sum, ring) => sum + ring.counts.compliant, 0), metrics.score.satisfied, "and to X");
  const percents = metrics.types.slice(0, 7).map((ring) => ring.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b), "worst compliant percentage first");
});

/* ── Every identity fails on its own ──────────────────────────────────────── */

test("each reconciliation rule fails on its own, and says which", () => {
  const good = build(ESTATE);
  const broken = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return reconcileComplianceDashboard(copy);
  };
  assert.match(broken((m) => { m.score.counts.missing += 1; }).join(), /status counts .* != requirements/);
  assert.match(broken((m) => { m.types[0].total += 1; }).join(), /type rings \d+ != requirements/);
  assert.match(broken((m) => { m.types[0].counts.compliant += 1; }).join(), /type rings compliant/);
  assert.match(broken((m) => { m.countdown.rings[0].value += 1; }).join(), /expired ring/);
  assert.match(broken((m) => { m.countdown.rings[1].value += 1; }).join(), /countdown windows/);
  assert.match(broken((m) => { m.renewals.slices[0].value += 1; }).join(), /who's renewing/);
  assert.match(broken((m) => { m.score.percent += 1; }).join(), /score \d+% != \d+%/);
  assert.match(broken((m) => { m.sites.considered = m.sites.activeSites + 1; }).join(), /sites considered/);
});

/* ── Midnight ─────────────────────────────────────────────────────────────── */

test("with a fixed clock, a certificate due today is Expiring soon — and Expired the next day, with no data change", () => {
  const dueToday = inDays(0);
  const estate = (today) => [
    entry({ site: "s1", kind: "Fire Alarm", expiry: dueToday }, today),
    entry({ site: "s1", kind: "PAT Testing", expiry: inDays(400) }, today),
  ];
  /* The last second of the certificate's day, and the first of the next. The
     product's classifier counts whole UTC days — the same "today" the board
     calendar and job due dates use — so this is midnight in winter London time
     and 01:00 in summer. */
  const lastSecond = new Date(`${dueToday}T23:59:59Z`);
  const nextDay = new Date(`${inDays(1)}T00:00:01Z`);

  const before = build(estate(lastSecond), {}, lastSecond);
  assert.equal(before.score.counts.expiring, 1);
  assert.equal(before.score.counts.expired, 0);
  assert.equal(before.countdown.rings.find((ring) => ring.key === "band-1").value, 1, "0 days left is inside 0–20");

  const after = build(estate(nextDay), {}, nextDay);
  assert.equal(after.score.counts.expiring, 0);
  assert.equal(after.score.counts.expired, 1, "flipped by the clock alone");
  assert.equal(after.countdown.rings.find((ring) => ring.key === "expired").value, 1);
  assert.equal(after.countdown.rings.find((ring) => ring.key === "band-1").value, 0);
  assert.equal(after.types.find((ring) => ring.label === "Fire Alarm").counts.expired, 1, "the type ring moves");
  assert.equal(after.renewals.total, 1, "the renewals donut still counts it");
  assert.equal(after.sites.fullyCompliant, 0, "and the site is no longer fully compliant");
  assert.equal(before.sites.fullyCompliant, 1);
  assert.equal(before.score.percent, after.score.percent, "the score counts Compliant only, so it holds");
  assert.deepEqual(after.reconciliation, []);
});

/* ── Updates ──────────────────────────────────────────────────────────────── */

test("uploading a certificate, changing a due date and reassigning a party move every widget together", () => {
  const before = build(ESTATE);
  const uploaded = ESTATE.map((row) =>
    row.siteId === "s1" && row.kind === "Emergency Lighting" ? entry({ site: "s1", kind: "Emergency Lighting", expiry: inDays(500) }) : row,
  );
  const afterUpload = build(uploaded);
  assert.equal(afterUpload.score.counts.missing, before.score.counts.missing - 1);
  assert.equal(afterUpload.score.counts.compliant, before.score.counts.compliant + 1);
  assert.ok(afterUpload.score.percent > before.score.percent, "the score donut moves");

  const renewed = uploaded.map((row) =>
    row.siteId === "s1" && row.kind === "Gas Safety" ? entry({ site: "s1", kind: "Gas Safety", expiry: inDays(365) }) : row,
  );
  const afterRenewal = build(renewed);
  assert.equal(afterRenewal.score.counts.expired, 0, "the expired certificate is renewed");
  assert.equal(afterRenewal.countdown.rings.find((ring) => ring.key === "expired").value, 0, "the countdown moves");
  assert.equal(afterRenewal.sites.fullyCompliant, 3, "every site is now fully compliant — the gauge moves");
  assert.equal(afterRenewal.sites.percent, 100);

  const rows = complianceRowsFrom(renewed, MANAGERS).map((row) =>
    row.state === "Expiring soon" && row.siteId === "s2" ? { ...row, responsibility: "Acme Electrical" } : row,
  );
  const reassigned = buildComplianceDashboard({
    rows,
    today: TODAY,
    portfolio: { id: "all", name: "All portfolios", siteIds: null },
    portfolios: [],
    range: { from: null, to: null, label: "Any due date" },
    activeSiteIds: ["s1", "s2", "s3"],
    warningWindowDays: 60,
  });
  assert.ok(reassigned.renewals.slices.some((slice) => slice.label === "Acme Electrical"), "the contractor donut moves");
  /* The Overview's compliance KPI is `complianceCompletion` over the same
     register — equal after every change, not only before the first. */
  for (const [metrics, entries] of [[afterUpload, uploaded], [afterRenewal, renewed], [reassigned, renewed]]) {
    assert.deepEqual(metrics.reconciliation, []);
    assert.equal(metrics.score.percent, complianceCompletion(complianceRowsFrom(entries, MANAGERS)).percent);
  }
});

/* ── Sites fully compliant ────────────────────────────────────────────────── */

test("sites fully compliant counts active sites with a scored requirement and no Expired or Missing", () => {
  const metrics = build(ESTATE, { activeSiteIds: ["s1", "s2", "s3", "s4"] });
  assert.equal(metrics.sites.activeSites, 4, "every active site, requirements or not");
  assert.equal(metrics.sites.considered, 3, "s4 has nothing in the score, so it is neither compliant nor not");
  assert.deepEqual(metrics.sites.notFullyCompliantIds, ["s1"], "s1 holds an expired and a missing certificate");
  assert.equal(metrics.sites.fullyCompliant, 2);
  assert.equal(metrics.sites.percent, 67);

  const closed = build(ESTATE, { activeSiteIds: ["s2", "s3"] });
  assert.equal(closed.sites.considered, 2, "a closed site is not in the Sites page's active count, nor here");
});

test("a portfolio narrows every figure to its sites", () => {
  const scoped = build(ESTATE, {
    portfolio: { id: "p1", name: "North", siteIds: ["s3"] },
    activeSiteIds: ["s3"],
  });
  assert.equal(scoped.score.applicable, 2, "s3's two scored requirements");
  assert.equal(scoped.score.percent, 100);
  assert.deepEqual(scoped.portfolio.siteIds, ["s3"]);
  assert.deepEqual(scoped.reconciliation, []);
});

/* ── Every drill opens exactly what it counted ────────────────────────────── */

test("every segment, ring and legend row filters the register to its own count", () => {
  const metrics = build(ESTATE);
  for (const [key, filter] of Object.entries(metrics.score.filters)) {
    assert.equal(opens(ESTATE, filter), metrics.score.counts[key], `score segment ${key}`);
  }
  for (const ring of metrics.types) {
    assert.equal(opens(ESTATE, ring.filter), ring.total, `type ring ${ring.label}`);
    assert.equal(opens(ESTATE, ring.expiredFilter), ring.counts.expired, `expired dot ${ring.label}`);
  }
  for (const ring of metrics.countdown.rings) {
    assert.equal(opens(ESTATE, ring.filter), ring.value, `countdown ${ring.label}`);
  }
  for (const slice of metrics.renewals.slices) {
    assert.equal(opens(ESTATE, slice.filter), slice.value, `renewals ${slice.label}`);
  }
  assert.equal(opens(ESTATE, metrics.renewals.allFilter), metrics.renewals.total, "view all renewals");
});

test("with a portfolio chosen, the drill carries its sites and still opens the same count", () => {
  const metrics = build(ESTATE, { portfolio: { id: "p1", name: "One", siteIds: ["s1"] }, activeSiteIds: ["s1"] });
  const site = { site: ["s1"] };
  for (const [key, filter] of Object.entries(metrics.score.filters)) {
    assert.equal(opens(ESTATE, filter, TODAY, site), metrics.score.counts[key], `score segment ${key}`);
  }
});

test("the register's new narrowings parse and apply", () => {
  const filters = parseComplianceFilters(new URL("http://x/?scored=1&due=band:0-20&due=overdue&from=2026-10-01&to=2026-09-01&who=__none__"));
  assert.equal(filters.scored, true);
  assert.deepEqual(filters.dueBands, [{ from: 0, to: 20 }]);
  assert.deepEqual(filters.due, ["overdue"], "a fixed window and a band are OR'd in one dimension");
  assert.deepEqual([filters.dueFrom, filters.dueTo], ["2026-09-01", "2026-10-01"], "a reversed range is swapped, not refused");
  const rows = complianceRowsFrom(ESTATE, MANAGERS);
  const dated = filterComplianceRows(rows, parseComplianceFilters(new URL(`http://x/?from=${inDays(0)}&to=${inDays(60)}`)), TODAY);
  assert.equal(dated.length, 3, "a due-date range keeps the three certificates due inside it and nothing undated");
  assert.ok(rows.filter((row) => isScoredRow(row)).length < rows.length, "scored is a real narrowing on this estate");
});

/* ── The route ────────────────────────────────────────────────────────────── */

test("the route reuses the register, the rows builder and the canonical classifier — and writes nothing", async () => {
  const route = await read("app/api/compliance/metrics/route.ts");
  assert.match(route, /readComplianceRegister\(db, orgId, \{ today \}\)/);
  assert.match(route, /complianceRowsFrom\(register\.entries, managerById\)/);
  assert.match(route, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(route, /resolveDashboardPortfolio\(db, orgId, url\.searchParams\.get\("portfolio"\), siteScope\)/,
    "the membership's site restriction reaches the figures and the export");
  assert.match(route, /cells\.map\(csvCell\)/, "every export cell is neutralised");
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /\.insert\(|\.update\(|\.delete\(|db\.run\(/, "a GET that writes nothing");
  const builder = await read("app/lib/compliance-dash.ts");
  assert.doesNotMatch(builder, /from "drizzle-orm"|from "\.\.\/\.\.\/db/, "the builder is pure");
});

/* ── Against the running estate ───────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/compliance/metrics`, { headers, signal: AbortSignal.timeout(4000) });
    return response.status < 500 && response.status !== 404;
  } catch {
    return false;
  }
}

test("the live block reconciles, and its score is the Overview's", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const block = await (await fetch(`${BASE}/api/compliance/metrics`, { headers })).json();
  const overview = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  assert.deepEqual(block.reconciliation, []);
  assert.equal(block.score.percent, overview.compliance.percent, "Compliance % here = the Overview's KPI and gauge");
  assert.equal(block.score.satisfied, overview.compliance.satisfied);
  assert.equal(block.score.applicable, overview.compliance.applicable);
  const kpi = overview.kpis.find((entry) => entry.key === "compliance");
  assert.equal(kpi.value, block.score.percent);
});

test("the live register opens exactly the count each drill was counted with", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const block = await (await fetch(`${BASE}/api/compliance/metrics`, { headers })).json();
  const count = async (filter) => {
    const params = new URLSearchParams();
    for (const [key, values] of Object.entries(filter)) for (const value of values) params.append(key, value);
    const summary = await (await fetch(`${BASE}/api/compliance/summary?${params}`, { headers })).json();
    return summary.portfolio.total;
  };
  for (const [key, filter] of Object.entries(block.score.filters)) {
    assert.equal(await count(filter), block.score.counts[key], `score ${key}`);
  }
  for (const ring of block.countdown.rings) assert.equal(await count(ring.filter), ring.value, `countdown ${ring.label}`);
  for (const ring of block.types.slice(0, 3)) assert.equal(await count(ring.filter), ring.total, `type ${ring.label}`);
  assert.equal(await count(block.renewals.allFilter), block.renewals.total, "all renewals");
});

test("the live export is a CSV of the same snapshot, formula-safe", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const response = await fetch(`${BASE}/api/compliance/metrics?format=csv`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  const body = await response.text();
  assert.match(body, /"Compliance score \(percent\)"/);
  assert.match(body, /"Site","Requirement","Status","Due date","Responsible","In the score"/);
  assert.doesNotMatch(body, /\n"[=+@]/, "no cell starts with a formula character");
});
