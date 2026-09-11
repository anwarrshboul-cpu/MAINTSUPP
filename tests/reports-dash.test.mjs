/**
 * THE REPORTS DASHBOARD BLOCK'S METRICS — the brief's §9, as tests.
 *
 *   1. `buildReportsDashboard` and `analyseRepeats` are PURE: imported and
 *      CALLED with a fixture whose answers are worked out by hand in the
 *      comments — zero data, no cost, no type, no site, no issue, a three-job
 *      repeat chain and a pair just outside the window.
 *   2. Every drill is replayed through `readDrillFilter` — the Jobs page's own
 *      filter — over the same rows, and must select exactly the jobs and the
 *      pounds the figure counted.
 *   3. Against the LIVE endpoints: every identity holds, the trend equals the
 *      Overview's months to the penny, and the real job feed reproduces each
 *      clicked figure. Skips without a dev server.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { buildReportsDashboard, reconcileReportsDashboard, resolveReportsRange, dayOf, shiftDays, shiftMonth } =
  await import("../app/lib/reports-dash.ts");
const { analyseRepeats, spendLineOf, spendTypeOf, REPEAT_WINDOW_DAYS, recurrenceBandOf, medianOf } = await import(
  "../app/lib/job-metrics.ts"
);
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
const { dayString, shiftDay } = await import("../app/lib/dashboard-filters.ts");

const NOW = new Date("2026-09-11T10:00:00Z");
const SITES = new Map([["s1", "Aldgate"], ["s2", "Bluewater"], ["s3", "Cabot Circus"]]);

/** A job row, as the route selects it and as `/api/maintenance` sends it. */
function job(id, over = {}) {
  return {
    id,
    siteId: "s1",
    category: "Electrical",
    tier: 1,
    cost: null,
    completedAt: null,
    requestedAt: "2026-06-01T09:00:00.000Z",
    contractor: null,
    reference: id,
    title: id,
    /* The browser-only fields the drill filter reads. */
    archived: false,
    parentId: null,
    boardId: "maintenance",
    status: "Job Completed",
    stage: "Completed",
    ...over,
  };
}

/*
 * THE FIXTURE, worked by hand. Range 1 Jun – 31 Aug 2026.
 *
 *   J1  s1 Electrical  raised 1 Jun   £120.50 completed 10 Jun   reactive
 *   J2  s1 Electrical  raised 1 Jul   no cost                     → repeat of J1 (30 days)
 *   J3  s1 Electrical  raised 31 Jul  £1,500 completed 5 Aug     → repeat of J2 (30 days), projects
 *   J4  s2 Plumbing    raised 1 Mar   £50 completed 15 Jun        reactive
 *   J5  s2 Plumbing    raised 1 Jun   —                            92 days after J4: NOT a repeat
 *   J6  s2 Compliance… raised 10 Jul  £300 completed 20 Jul       planned (compliance)
 *   J7  NO SITE Glass  raised 20 Jun  £80 completed 2 Jul          reactive, No site
 *   J8  s3 NO ISSUE    raised 25 Jul  £40 completed 1 Aug          reactive, never a repeat
 *   J9  s3 NO ISSUE    raised 2 Aug   —                            8 days later, but no issue: not a repeat
 *   J10 s1 Electrical  raised 1 Jan 2025 £99 completed 10 Jan 2025 tier 5 — outside everything
 *
 *   Spend in range: 120.50 + 1500 + 50 + 300 + 80 + 40 = £2,090.50 over 6 jobs
 *     reactive 120.50 + 50 + 80 + 40 = £290.50 (4) · planned £300 (1) · projects £1,500 (1)
 *   Raised in range: J1 J2 J3 J5 J6 J7 J8 J9 = 8; repeats J2 J3 = 2 → 25%
 *   Repeat spend: J3 £1,500 (J2 has no cost) · one pattern, gaps 30 and 30 → median 30 → Monthly
 */
const JOBS = [
  job("J1", { cost: 120.5, completedAt: "2026-06-10", requestedAt: "2026-06-01T09:00:00.000Z" }),
  job("J2", { requestedAt: "2026-07-01T09:00:00.000Z", status: "New", stage: "Incoming" }),
  job("J3", { cost: 1500, completedAt: "2026-08-05", requestedAt: "2026-07-31T09:00:00.000Z" }),
  job("J4", { siteId: "s2", category: "Plumbing", cost: 50, completedAt: "2026-06-15", requestedAt: "2026-03-01T09:00:00.000Z" }),
  job("J5", { siteId: "s2", category: "Plumbing", requestedAt: "2026-06-01T09:00:00.000Z", status: "New", stage: "Incoming" }),
  job("J6", { siteId: "s2", category: "Compliance inspection", tier: 2, cost: 300, completedAt: "2026-07-20", requestedAt: "2026-07-10T09:00:00.000Z" }),
  job("J7", { siteId: "", category: "Glass", cost: 80, completedAt: "2026-07-02", requestedAt: "2026-06-20T09:00:00.000Z" }),
  job("J8", { siteId: "s3", category: "", cost: 40, completedAt: "2026-08-01", requestedAt: "2026-07-25T09:00:00.000Z" }),
  job("J9", { siteId: "s3", category: "", requestedAt: "2026-08-02T09:00:00.000Z", status: "New", stage: "Incoming" }),
  job("J10", { tier: 5, cost: 99, completedAt: "2025-01-10", requestedAt: "2025-01-01T09:00:00.000Z" }),
];

/** What `loadSpendByMonth` returns for these rows: completed cost by month, in pence. */
function monthlyOf(jobs) {
  const months = new Map();
  for (const row of jobs) {
    const line = spendLineOf(row);
    if (!line) continue;
    const month = line.day.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + line.pence);
  }
  return months;
}

function build(jobs = JOBS, over = {}) {
  const range = over.range ?? resolveReportsRange({ from: "2026-06-01", to: "2026-08-31" }, NOW);
  return buildReportsDashboard({
    jobs,
    siteNames: SITES,
    monthlySpend: monthlyOf(jobs),
    now: NOW,
    range,
    trendRange: over.trendRange ?? "3m",
    sitesRange: over.sitesRange ?? "page",
    portfolio: { id: "all", name: "All portfolios", siteIds: [] },
    portfolios: [],
    activeSiteCount: 3,
  });
}

const kpi = (metrics, key) => metrics.kpis.find((entry) => entry.key === key);

/* ── The repeat rule ──────────────────────────────────────────────────────── */

test("a three-job chain yields two repeats, and the first job in it is not one", () => {
  const analysis = analyseRepeats(JOBS, { from: "2026-06-01", toExclusive: "2026-09-01" });
  assert.equal(analysis.verdicts.get("J1").repeat, false, "the first in a chain is never a repeat");
  assert.equal(analysis.verdicts.get("J2").repeat, true);
  assert.equal(analysis.verdicts.get("J2").previousId, "J1");
  assert.equal(analysis.verdicts.get("J3").previousId, "J2", "each job is compared with the one before it");
  assert.deepEqual([...analysis.inRange].sort(), ["J2", "J3"]);
  assert.equal(REPEAT_WINDOW_DAYS, 90);
});

test("two jobs just outside the window are not a repeat", () => {
  assert.equal(analyseRepeats(JOBS, { from: "2026-01-01", toExclusive: "2026-12-31" }).verdicts.get("J5").repeat, false,
    "J5 is 92 days after J4");
  const edge = analyseRepeats(
    [job("A", { requestedAt: "2026-01-01" }), job("B", { requestedAt: "2026-04-01" }), job("C", { requestedAt: "2026-06-30" })],
    { from: "2026-01-01", toExclusive: "2027-01-01" },
  );
  assert.equal(edge.verdicts.get("B").repeat, true, "exactly 90 days is inside the window");
  assert.equal(edge.verdicts.get("C").repeat, true);
  const outside = analyseRepeats(
    [job("A", { requestedAt: "2026-01-01" }), job("B", { requestedAt: "2026-04-02" })],
    { from: "2026-01-01", toExclusive: "2027-01-01" },
  );
  assert.equal(outside.verdicts.get("B").repeat, false, "91 days is outside it");
});

test("no site, or no issue, can never make a repeat", () => {
  const analysis = analyseRepeats(
    [
      job("U1", { siteId: "", requestedAt: "2026-06-01" }),
      job("U2", { siteId: "site-unassigned", requestedAt: "2026-06-02" }),
      job("N1", { category: "", requestedAt: "2026-06-01" }),
      job("N2", { category: "[object Object]", requestedAt: "2026-06-02" }),
    ],
    { from: "2026-01-01", toExclusive: "2027-01-01" },
  );
  assert.equal(analysis.inRange.size, 0, "two unassigned jobs are not the same place; two blank issues are not the same problem");
});

test("recurrence bands follow the median gap, on the brief's boundaries", () => {
  assert.equal(medianOf([30, 30]), 30);
  assert.equal(medianOf([4, 10, 50]), 10);
  assert.equal(medianOf([4, 10]), 7);
  assert.deepEqual([10, 11, 21, 22, 45, 46].map(recurrenceBandOf),
    ["weekly", "fortnightly", "fortnightly", "monthly", "monthly", "less-often"]);
});

/* ── The block ────────────────────────────────────────────────────────────── */

test("zero data renders £0, 0% and empty rings — never NaN", () => {
  const metrics = build([]);
  for (const entry of metrics.kpis) {
    assert.equal(entry.pence, 0);
    assert.equal(entry.delta.direction, "none", "a delta of nothing against nothing is not 'New'");
    assert.ok(entry.spark.every((point) => point.pence === 0));
  }
  assert.equal(metrics.repeat.percent, 0);
  assert.equal(metrics.repeat.spendPence, 0);
  assert.ok(metrics.repeat.bands.every((band) => band.value === 0));
  assert.deepEqual(metrics.topSites.rows, []);
  assert.deepEqual(metrics.reconciliation, []);
  assert.doesNotMatch(JSON.stringify(metrics), /NaN|Infinity/);
});

test("the KPIs split by type and reconcile to the total, to the penny", () => {
  const metrics = build();
  assert.equal(kpi(metrics, "total").pence, 209050);
  assert.equal(kpi(metrics, "total").jobs, 6, "J2, J5 and J9 have no cost; J10 is outside the range");
  assert.equal(kpi(metrics, "reactive").pence, 29050);
  assert.equal(kpi(metrics, "planned").pence, 30000, "a compliance category is planned");
  assert.equal(kpi(metrics, "projects").pence, 150000, "£1,500 of non-planned work is a project");
  assert.deepEqual(metrics.unclassified, { pence: 0, jobs: 0 }, "the shipped rule types every job");
  assert.equal(
    kpi(metrics, "reactive").pence + kpi(metrics, "planned").pence + kpi(metrics, "projects").pence + metrics.unclassified.pence,
    kpi(metrics, "total").pence,
  );
  assert.equal(spendTypeOf({ category: "Compliance", cost: 5000 }), "planned", "a £5,000 compliance job is planned, not a project");
  for (const entry of metrics.kpis) {
    assert.equal(entry.spark.reduce((sum, point) => sum + point.pence, 0), entry.pence, `${entry.key} sparkline sums to its KPI`);
  }
  assert.equal(metrics.sparkUnit, "week", "92 days is weekly, per the brief's 45-day rule");
  assert.equal(kpi(metrics, "total").label, "Total spend", "not the current month");
});

test("a job with no cost counts as raised, never as spend", () => {
  const metrics = build();
  assert.equal(metrics.repeat.jobsInRange, 8);
  assert.ok(!metrics.kpis.some((entry) => entry.jobs > 6));
  assert.equal(spendLineOf({ cost: null, completedAt: "2026-06-01" }), null);
  assert.equal(spendLineOf({ cost: 10, completedAt: null }), null, "an open job has not been spent yet");
  assert.deepEqual(spendLineOf({ cost: 12.345, completedAt: "2026-06-01T10:00:00Z" }), { pence: 1235, day: "2026-06-01" });
});

test("no site lands in 'No site', and every site plus No site is the card's total", () => {
  const metrics = build();
  assert.deepEqual(metrics.topSites.noSite, { pence: 8000, jobs: 1 });
  assert.equal(metrics.topSites.sitesPence + metrics.topSites.noSite.pence, metrics.topSites.totalPence);
  assert.equal(metrics.topSites.totalPence, kpi(metrics, "total").pence, "with the card on the page range");
  assert.deepEqual(metrics.topSites.rows.map((row) => row.name), ["Aldgate", "Bluewater", "Cabot Circus"]);
  assert.equal(metrics.dataGaps.withoutSite, 1);
  assert.equal(metrics.dataGaps.withoutIssue, 1, "J8");
});

test("the repeat widget: rate, spend, both donuts and the rings agree", () => {
  const { repeat } = build();
  assert.equal(repeat.repeatJobs, 2);
  assert.equal(repeat.percent, 25, "2 of 8 raised in range");
  assert.equal(repeat.sitesAffected, 1);
  assert.equal(repeat.spendPence, 150000, "J3's cost; J2 has none yet");
  assert.equal(repeat.byIssue.reduce((sum, slice) => sum + slice.value, 0), repeat.spendPence);
  assert.equal(repeat.bySite.reduce((sum, slice) => sum + slice.value, 0), repeat.spendPence, "both donuts share one total");
  assert.deepEqual(repeat.byIssue.map((slice) => [slice.label, slice.jobs]), [["Electrical", 2]]);
  assert.equal(repeat.patterns, 1);
  assert.deepEqual(repeat.bands.map((band) => [band.key, band.value, band.jobs]), [
    ["weekly", 0, 0], ["fortnightly", 0, 0], ["monthly", 1, 2], ["less-often", 0, 0],
  ]);
});

test("the trend sums its own points and dates spend by completion", () => {
  const metrics = build();
  assert.deepEqual(metrics.trend.points.map((point) => [point.month, point.pence, point.jobs]), [
    ["2026-06", 17050, 2],
    ["2026-07", 38000, 2],
    ["2026-08", 154000, 2],
  ]);
  assert.equal(metrics.trend.totalPence, 209050);
  assert.equal(metrics.trend.delta.direction, "new", "the three months before held nothing in range");
});

test("each reconciliation rule fails on its own, and says which", () => {
  const good = build();
  const broken = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return reconcileReportsDashboard(copy, { activeSiteCount: 3 }).join(" | ");
  };
  assert.match(broken((m) => { m.kpis[1].pence += 1; }), /types \d+ != total/);
  assert.match(broken((m) => { m.kpis[0].spark[0].pence += 1; }), /total sparkline/);
  assert.match(broken((m) => { m.trend.points[0].pence += 1; }), /trend points/);
  assert.match(broken((m) => { m.topSites.noSite.pence += 1; }), /no site/);
  assert.match(broken((m) => { m.repeat.byIssue[0].value += 1; }), /repeat by issue/);
  assert.match(broken((m) => { m.repeat.bySite[0].value += 1; }), /repeat by site/);
  assert.match(broken((m) => { m.repeat.bands[2].value += 1; }), /recurrence rings/);
  assert.match(broken((m) => { m.repeat.repeatJobs = m.repeat.jobsInRange + 1; }), /repeat jobs \d+ > jobs raised/);
  assert.match(broken((m) => { m.repeat.sitesAffected = 9; }), /sites with repeats 9 > active sites 3/);
});

test("changing a job's cost, type, site or issue moves every widget and still reconciles", () => {
  const before = build();
  const change = (id, patch) => JOBS.map((row) => (row.id === id ? { ...row, ...patch } : row));

  const dearer = build(change("J1", { cost: 220.5 }));
  assert.equal(kpi(dearer, "total").pence, kpi(before, "total").pence + 10000);
  assert.equal(kpi(dearer, "reactive").pence, kpi(before, "reactive").pence + 10000);
  assert.equal(dearer.trend.points[0].pence, before.trend.points[0].pence + 10000, "the trend moves");
  assert.equal(dearer.topSites.rows.find((row) => row.name === "Aldgate").pence, 172050, "the site bar moves: J1 £220.50 + J3 £1,500");

  const retyped = build(change("J1", { tier: 4 }));
  assert.equal(kpi(retyped, "planned").pence, kpi(before, "planned").pence + 12050, "tier 4 is planned");

  const moved = build(change("J3", { siteId: "s2" }));
  assert.equal(moved.repeat.repeatJobs, 1, "J3 at another site no longer repeats J2");
  assert.equal(moved.repeat.spendPence, 0, "so the repeat spend, both donuts and the gauge move");

  const reissued = build(change("J2", { category: "Plumbing" }));
  /* J2 leaves the chain: it is no longer a repeat, and J3 now repeats J1,
     60 days back — inside the window — so one repeat remains. */
  assert.equal(reissued.repeat.repeatJobs, 1, "the rate, the donuts and the rings move");
  assert.equal(reissued.repeat.bands.find((band) => band.key === "less-often").value, 1, "a 60-day gap recurs less often than monthly");

  for (const metrics of [dearer, retyped, moved, reissued]) assert.deepEqual(metrics.reconciliation, []);
});

test("J3 still repeats J1 when J2 is re-categorised, because 60 days is inside the window", () => {
  /* The assertion above is the interesting edge, so it is pinned by value. */
  const chain = analyseRepeats(JOBS.map((row) => (row.id === "J2" ? { ...row, category: "Plumbing" } : row)), {
    from: "2026-06-01",
    toExclusive: "2026-09-01",
  });
  assert.equal(chain.verdicts.get("J3").repeat, true);
  assert.equal(chain.verdicts.get("J3").previousId, "J1");
});

/* ── Every drill selects what it counted ──────────────────────────────────── */

function drill(query) {
  const filter = readDrillFilter(new URLSearchParams(query), NOW, { population: JOBS });
  const rows = JOBS.filter((row) => filter.matches(row));
  return { jobs: rows.length, pence: rows.reduce((sum, row) => sum + (spendLineOf(row)?.pence ?? 0), 0) };
}

test("every element's drill opens the jobs and the pounds it counted", () => {
  const metrics = build();
  const window = `period=custom&from=${metrics.range.from}&to=${metrics.range.to}`;
  const costed = `hasCost=1&measure=completed&${window}`;
  assert.deepEqual(drill(costed), { jobs: kpi(metrics, "total").jobs, pence: kpi(metrics, "total").pence }, "total KPI");
  for (const key of ["reactive", "planned", "projects"]) {
    assert.deepEqual(drill(`${costed}&type=${key}`), { jobs: kpi(metrics, key).jobs, pence: kpi(metrics, key).pence }, `${key} KPI`);
  }
  for (const point of metrics.trend.points) {
    assert.deepEqual(drill(`hasCost=1&measure=completed&period=custom&from=${point.from}&to=${point.to}`), { jobs: point.jobs, pence: point.pence }, `trend ${point.month}`);
  }
  for (const row of metrics.topSites.rows) {
    assert.deepEqual(
      drill(`hasCost=1&measure=completed&period=custom&from=${metrics.topSites.from}&to=${metrics.topSites.to}&site=${row.siteId}`),
      { jobs: row.jobs, pence: row.pence },
      `site bar ${row.name}`,
    );
  }
  assert.deepEqual(drill(`repeat=1&${window}`), { jobs: metrics.repeat.repeatJobs, pence: metrics.repeat.spendPence }, "repeat gauge");
  for (const slice of metrics.repeat.byIssue) {
    assert.deepEqual(drill(`repeat=1&${window}&label=${encodeURIComponent(slice.labels.join("|"))}`), { jobs: slice.jobs, pence: slice.value }, `issue ${slice.label}`);
  }
  for (const slice of metrics.repeat.bySite) {
    assert.deepEqual(drill(`repeat=1&${window}&site=${encodeURIComponent(slice.labels.join("|"))}`), { jobs: slice.jobs, pence: slice.value }, `site ${slice.label}`);
  }
  for (const band of metrics.repeat.bands) {
    assert.equal(drill(`recurrence=${band.key}&${window}`).jobs, band.jobs, `recurrence ${band.label}`);
  }
});

/* ── The range ────────────────────────────────────────────────────────────── */

test("the range: this month by default, the Overview's month token, and equal previous windows", () => {
  const current = resolveReportsRange({}, NOW);
  assert.deepEqual([current.from, current.to, current.calendarMonth, current.currentMonth], ["2026-09-01", "2026-09-11", true, true]);
  assert.deepEqual(current.previous, { from: "2026-08-01", to: "2026-08-11" }, "month to date against the same days of last month");
  assert.match(current.comparedWith, /^vs Aug 2026$/);

  const tapped = resolveReportsRange({ reportPeriod: "month:2026-07" }, NOW);
  assert.deepEqual([tapped.from, tapped.to, tapped.calendarMonth], ["2026-07-01", "2026-07-31", true]);
  assert.deepEqual(tapped.previous, { from: "2026-06-01", to: "2026-06-30" });

  const custom = resolveReportsRange({ from: "2026-08-31", to: "2026-06-01" }, NOW);
  assert.deepEqual([custom.from, custom.to, custom.calendarMonth], ["2026-06-01", "2026-08-31", false], "a reversed range is swapped");
  assert.deepEqual(custom.previous, { from: "2026-03-01", to: "2026-05-31" }, "92 days before");
  assert.equal(custom.comparedWith, "vs previous period");
});

test("the day helpers agree with the dashboard filters they restate", () => {
  for (const at of [NOW, new Date("2026-03-29T00:30:00Z"), new Date("2024-02-29T23:59:59Z")]) {
    assert.equal(dayOf(at), dayString(at));
  }
  for (const [day, by] of [["2026-09-11", -30], ["2024-02-28", 1], ["2026-12-31", 1]]) {
    assert.equal(shiftDays(day, by), shiftDay(day, by));
  }
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-09", -11), "2025-10");
});

/* ── The route ────────────────────────────────────────────────────────────── */

test("the route counts the Overview's jobs with the Overview's spend query — and writes nothing", async () => {
  const route = await read("app/api/reports/metrics/route.ts");
  assert.match(route, /dashboardJobScope\(orgId, portfolio\.siteIds\)/, "the same scope as the Overview block");
  assert.match(route, /loadSpendByMonth\(db, scope,/, "the trend is the Overview's own query");
  assert.match(route, /resolveDashboardPortfolio\(\s*db,\s*orgId,\s*url\.searchParams\.get\("portfolio"\),\s*siteScope,?\s*\)/,
    "with the membership's site restriction");
  assert.match(route, /cells\.map\(csvCell\)/, "every export cell is neutralised");
  const code = route.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /\.insert\(|\.update\(|\.delete\(|db\.run\(/);
  const builder = await read("app/lib/reports-dash.ts");
  assert.doesNotMatch(builder, /from "drizzle-orm"|from "\.\.\/\.\.\/db/, "the builder is pure");
  const overview = await read("app/lib/overview-metrics.ts");
  assert.match(overview, /loadSpendByMonth\(db, scope, shiftDay\(rangeTo, -364\), endExclusive\)/,
    "and the Overview reads spend through the very same function");
});

/* ── Against the running estate ───────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/reports/metrics`, { headers, signal: AbortSignal.timeout(4000) });
    return response.status < 500 && response.status !== 404;
  } catch {
    return false;
  }
}

test("the live block reconciles, and its trend is the Overview's month for month", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const reports = await (await fetch(`${BASE}/api/reports/metrics?trendRange=12m`, { headers })).json();
  const overview = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  assert.deepEqual(reports.reconciliation, []);
  const overviewMonths = new Map(overview.spend.map((point) => [point.month, point.pence]));
  for (const point of reports.trend.points) {
    assert.equal(point.pence, overviewMonths.get(point.month), `${point.month}: Reports and the Overview agree`);
  }
});

test("the live job feed reproduces every clicked figure", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const query = "from=2025-09-01&to=2026-09-11&trendRange=12m&sitesRange=ytd";
  const metrics = await (await fetch(`${BASE}/api/reports/metrics?${query}`, { headers })).json();
  const population = (await (await fetch(`${BASE}/api/maintenance?limit=2000`, { headers })).json()).requests ?? [];
  const live = (drillQuery) => {
    const filter = readDrillFilter(new URLSearchParams(drillQuery), new Date(), { population });
    const rows = population.filter((row) => filter.matches(row));
    return { jobs: rows.length, pence: rows.reduce((sum, row) => sum + (spendLineOf(row)?.pence ?? 0), 0) };
  };
  const window = `period=custom&from=${metrics.range.from}&to=${metrics.range.to}`;
  const total = metrics.kpis[0];
  assert.deepEqual(live(`hasCost=1&measure=completed&${window}`), { jobs: total.jobs, pence: total.pence }, "total");
  for (const entry of metrics.kpis.slice(1)) {
    assert.deepEqual(live(`hasCost=1&measure=completed&${window}&type=${entry.key}`), { jobs: entry.jobs, pence: entry.pence }, entry.key);
  }
  for (const point of metrics.trend.points) {
    assert.deepEqual(live(`hasCost=1&measure=completed&period=custom&from=${point.from}&to=${point.to}`), { jobs: point.jobs, pence: point.pence }, point.month);
  }
  assert.deepEqual(live(`repeat=1&${window}`), { jobs: metrics.repeat.repeatJobs, pence: metrics.repeat.spendPence }, "repeat gauge");
  for (const slice of metrics.repeat.byIssue) {
    assert.deepEqual(live(`repeat=1&${window}&label=${encodeURIComponent(slice.labels.join("|"))}`), { jobs: slice.jobs, pence: slice.value }, slice.label);
  }
  for (const band of metrics.repeat.bands) {
    assert.equal(live(`recurrence=${band.key}&${window}`).jobs, band.jobs, band.label);
  }
});

test("the live export is a formula-safe CSV of every cost line", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const response = await fetch(`${BASE}/api/reports/metrics?format=csv&from=2025-09-01&to=2026-09-11`, { headers });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"Completed","Reference","Job","Site","Job type","Issue category","Contractor","Cost \(GBP\)","Repeat"/);
  assert.doesNotMatch(body, /\n"[=+@]/);
});
