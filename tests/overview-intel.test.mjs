/**
 * THE OVERVIEW'S "JOB INTELLIGENCE" SECTION — `app/lib/overview-intel.ts`.
 *
 *   1. The builders are PURE, so they are imported and CALLED with fixtures
 *      whose answers are worked out by hand in the comments.
 *   2. Every slice's drill is replayed through `readDrillFilter` — the Jobs
 *      board's own filter — and must open exactly the jobs the slice counted.
 *   3. Against the LIVE endpoint: the section reconciles, ties to the figures
 *      beside it, and the real job feed reproduces every clicked split.
 *      Skips without a dev server.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const intel = await import("../app/lib/overview-intel.ts");
const { normalisePriority } = await import("../app/lib/job-metrics.ts");
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");

const {
  AGING_THRESHOLD_DAYS,
  SLA_TARGET_PERCENT,
  buildEngineers,
  buildJobIntel,
  buildLabels,
  isCalendarDay,
  matchKey,
  buildSlaByPriority,
  buildTiers,
  capStatuses,
  closeWeeks,
  closuresFrom,
  previousPeriod,
  reconcileIntel,
  summariseTimeToClose,
} = intel;

const slice = (key, value, labels = [key]) => ({ key, label: key, value, labels });

/* ── 1. The builders ──────────────────────────────────────────────────────── */

test("statuses: six largest, then 'Other statuses' carrying every raw label", () => {
  const nine = ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((key, index) => slice(key, 90 - index * 10));
  const capped = capStatuses(nine);
  assert.deepEqual(capped.map((row) => row.label), ["A", "B", "C", "D", "E", "F", "Other statuses"]);
  /* G 30 + H 20 + I 10 — and the drill must send all three. */
  assert.equal(capped[6].value, 60);
  assert.deepEqual(capped[6].labels, ["G", "H", "I"]);
  assert.equal(capped.reduce((sum, row) => sum + row.value, 0), nine.reduce((sum, row) => sum + row.value, 0));
  /* Seven fit without a one-member "Other"; zero rows never draw. */
  assert.equal(capStatuses(nine.slice(0, 7)).length, 7);
  assert.equal(capStatuses([slice("A", 3), slice("B", 0)]).length, 1);
});

test("tiers: Tier 1 first, and 0 or null is one 'No tier' slice the drill can reach", () => {
  const tiers = buildTiers([
    { tier: 3, total: 5 },
    { tier: 1, total: 2 },
    { tier: 0, total: 1 },
    { tier: null, total: 2 },
  ]);
  assert.deepEqual(tiers.map((row) => [row.label, row.value]), [["Tier 1", 2], ["Tier 3", 5], ["No tier", 3]]);
  assert.deepEqual(tiers[2].labels, ["__not_recorded__", "0"], "both spellings, so the board lists all three");
});

test("engineers: largest first, grouped case-insensitively, blanks are 'Not recorded'", () => {
  const engineers = buildEngineers([
    { engineer: "Handyman", total: 4 },
    { engineer: "handyman ", total: 1 },
    { engineer: "Plumber", total: 2 },
    { engineer: "", total: 1 },
    { engineer: null, total: 1 },
    { engineer: "[object Object]", total: 1 },
  ]);
  assert.deepEqual(engineers.map((row) => [row.label, row.value]), [["Handyman", 5], ["Plumber", 2], ["Not recorded", 3]]);
  assert.deepEqual(engineers[0].labels.sort(), ["Handyman", "handyman"].sort());
});

test("labels group by the board's own key, fold the tail into the real 'Other', and catch object text", () => {
  const labels = buildLabels([
    { category: "Electrical", total: 5 },
    { category: "electrical ", total: 2 },
    { category: "Plumbing", total: 4 },
    { category: "Other", total: 9 },
    { category: "Glass", total: 3 },
    { category: "Locks", total: 2 },
    { category: "CCTV", total: 1 },
    { category: "Signage", total: 1 },
    { category: "", total: 2 },
    { category: "[object Object]", total: 1 },
  ]);
  /*
   * Electrical 7 (two spellings, one value to the board), Plumbing 4, Other 9,
   * Glass 3, Locks 2 are the five; CCTV and Signage (2) fold into the real
   * "Other" → 11; blank and object text (3) are Unassigned. Total 30.
   */
  assert.deepEqual(labels.map((row) => [row.label, row.value]), [
    ["Other", 11],
    ["Electrical", 7],
    ["Plumbing", 4],
    ["Glass", 3],
    ["Unassigned", 3],
    ["Locks", 2],
  ]);
  assert.deepEqual(labels.find((row) => row.label === "Electrical").labels.sort(), ["Electrical", "electrical"].sort());
  assert.deepEqual(labels.find((row) => row.label === "Other").labels, ["Other", "CCTV", "Signage"]);
  assert.deepEqual(labels.find((row) => row.label === "Unassigned").labels, ["__not_recorded__", "[object Object]"]);
  assert.equal(labels.reduce((sum, row) => sum + row.value, 0), 30, "every row lands in exactly one slice");
  /* The one normalisation, stated once and equal to the board's. */
  assert.equal(matchKey("  Job   Scheduled "), "job scheduled");
});

test("two statuses the board treats as one value are one slice", () => {
  const capped = capStatuses([slice("Job Scheduled", 5), { key: "job scheduled", label: "job  scheduled", value: 2, labels: ["job  scheduled"] }]);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].value, 7);
  assert.deepEqual(capped[0].labels, ["Job Scheduled", "job  scheduled"]);
});

test("an impossible calendar day is refused, not thrown on", () => {
  assert.equal(isCalendarDay("2026-09-11"), true);
  for (const bad of ["2026-13-01", "2026-02-30", "2026-9-11", "", null, undefined]) {
    assert.equal(isCalendarDay(bad), false, String(bad));
  }
  assert.equal(intel.addDays("2026-13-01", 1), "2026-13-01", "returned as it came, never a RangeError");
});

test("SLA by priority is the headline's ratio inside each priority", () => {
  const rows = buildSlaByPriority(
    [
      { priority: "Urgent", total: 4, overdue: 1 },
      { priority: "critical", total: 1, overdue: 1 },
      { priority: "Medium", total: 10, overdue: 0 },
      { priority: "Low", total: 0, overdue: 0 },
    ],
    normalisePriority,
  );
  /* Urgent + critical are both "High": 5 jobs, 2 overdue → 3 within → 60%. */
  assert.deepEqual(rows.map((row) => [row.label, row.jobs, row.withinSla, row.percent]), [
    ["High", 5, 3, 60],
    ["Medium", 10, 10, 100],
    ["Low", 0, 0, null],
  ]);
  const unset = buildSlaByPriority([{ priority: "", total: 2, overdue: 2 }], normalisePriority);
  assert.equal(unset.at(-1).label, "Unset", "shown only when it holds jobs");
  assert.equal(unset.at(-1).percent, 0);
});

test("time to close: the range's mean, the equal period before, and seven weekly means", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  assert.deepEqual(previousPeriod(range), { from: "2026-07-01", to: "2026-07-31" }, "31 days, ending the day before");
  const weeks = closeWeeks(range.to);
  assert.equal(weeks.length, 7);
  assert.deepEqual(weeks.at(-1), { from: "2026-08-25", to: "2026-08-31" });
  assert.deepEqual(weeks[0], { from: "2026-07-14", to: "2026-07-20" });
  assert.equal(closuresFrom(range), "2026-07-01", "the earlier of the previous period and the first week");

  /*
   * In range: 2 days (Aug 3), 4 days (Aug 30), and a completion logged before
   * its request (Aug 30) which counts as 0 — mean (2 + 4 + 0) / 3 = 2.0.
   * Before: 5 days (Jul 10) → 5.0. Delta 2.0 − 5.0 = −3.0 (faster).
   */
  const summary = summariseTimeToClose(
    [
      { requestedDay: "2026-08-01", completedDay: "2026-08-03" },
      { requestedDay: "2026-08-26", completedDay: "2026-08-30" },
      { requestedDay: "2026-08-31", completedDay: "2026-08-30" },
      { requestedDay: "2026-07-05", completedDay: "2026-07-10" },
      { requestedDay: null, completedDay: "2026-08-10" },
    ],
    range,
  );
  assert.equal(summary.averageDays, 2);
  assert.equal(summary.jobs, 3, "the undated request cannot be timed");
  assert.equal(summary.previousAverageDays, 5);
  assert.equal(summary.previousJobs, 1);
  assert.equal(summary.deltaDays, -3);
  assert.deepEqual(summary.weeks.at(-1), { from: "2026-08-25", to: "2026-08-31", label: "w/c 25 Aug", averageDays: 2, jobs: 2 });
  assert.equal(summary.weeks[0].averageDays, null, "a week with nothing closed has no mean, never 0");
});

/* A consistent fixture: 10 open (3 overdue), 5 completed in range. */
function fixture(over = {}) {
  return {
    today: "2026-09-11",
    range: { from: "2025-10-01", to: "2026-09-11" },
    open: 10,
    overdue: 3,
    completed: 5,
    statusSlices: [slice("Pending Approval", 6), slice("Job Scheduled", 4)],
    prioritySlices: [slice("urgent", 2), slice("medium", 7), slice("low", 1)],
    categoryRows: [{ category: "Electrical", total: 6 }, { category: "Other", total: 4 }],
    tierRows: [{ tier: 1, total: 2 }, { tier: 2, total: 8 }],
    engineerRows: [{ engineer: "Handyman", total: 7 }, { engineer: "", total: 3 }],
    priorityRows: [
      { priority: "Urgent", total: 2, overdue: 1 },
      { priority: "Medium", total: 7, overdue: 2 },
      { priority: "Low", total: 1, overdue: 0 },
    ],
    aging: { count: 4, oldestDay: "2026-06-25" },
    breach: { pool: 3, count: 1 },
    closures: [{ requestedDay: "2026-09-01", completedDay: "2026-09-05" }],
    normalisePriority,
    ...over,
  };
}

test("the section: headline figures, and every split sums back to open work", () => {
  const built = buildJobIntel(fixture());
  assert.equal(built.completionRate, 33, "5 ÷ (5 + 10)");
  assert.deepEqual(built.sla, { percent: 70, withinSla: 7, overdue: 3, open: 10 });
  assert.equal(built.aging.percent, 40);
  assert.equal(built.aging.cutoff, "2026-08-27", `requested more than ${AGING_THRESHOLD_DAYS} days before 11 Sept`);
  assert.equal(built.breachRisk.percent, 33, "1 of the 3 High or Tier 1");
  assert.equal(built.slaTargetPercent, SLA_TARGET_PERCENT);
  assert.equal(SLA_TARGET_PERCENT, 95);
  assert.deepEqual(reconcileIntel(built), []);

  const empty = buildJobIntel(
    fixture({
      open: 0,
      overdue: 0,
      completed: 0,
      statusSlices: [],
      prioritySlices: [],
      categoryRows: [],
      tierRows: [],
      engineerRows: [],
      priorityRows: [],
      aging: { count: 0, oldestDay: null },
      breach: { pool: 0, count: 0 },
      closures: [],
    }),
  );
  assert.equal(empty.completionRate, null, "no work at all is '—', never a failing 0%");
  assert.equal(empty.sla.percent, null);
  assert.equal(empty.aging.percent, null);
  assert.equal(empty.timeToClose.averageDays, null);
  assert.deepEqual(reconcileIntel(empty), []);
  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/);
});

test("each reconciliation rule fails on its own, and says which", () => {
  const good = buildJobIntel(fixture());
  const broken = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return reconcileIntel(copy).join(" | ");
  };
  assert.match(broken((m) => { m.status[0].value += 1; }), /intel status 11 != open 10/);
  assert.match(broken((m) => { m.tiers[0].value += 1; }), /intel tiers/);
  assert.match(broken((m) => { m.engineers[0].value += 1; }), /intel engineers/);
  assert.match(broken((m) => { m.labels[0].value += 1; }), /intel labels/);
  assert.match(broken((m) => { m.priority[0].value += 1; }), /intel priority/);
  assert.match(broken((m) => { m.slaByPriority[0].jobs += 1; }), /sla by priority jobs/);
  assert.match(broken((m) => { m.slaByPriority[0].withinSla += 1; }), /sla by priority within/);
  assert.match(broken((m) => { m.aging.count = 11; }), /aging 11 > open 10/);
  assert.match(broken((m) => { m.breachRisk.count = 9; }), /breach risk 9 > pool 3/);
  assert.match(broken((m) => { m.timeToClose.jobs = 6; }), /time to close jobs 6 > completed 5/);
  /* The builder reports raw counts, so an over-counting query is caught here
     rather than quietly capped on its way to the page. */
  const overCounted = buildJobIntel(fixture({ aging: { count: 11, oldestDay: "2026-06-25" }, breach: { pool: 3, count: 4 } }));
  assert.match(reconcileIntel(overCounted).join(" | "), /aging 11 > open 10/);
  assert.match(reconcileIntel(overCounted).join(" | "), /breach risk 4 > pool 3/);
});

/* ── 2. Every split's drill opens what it counted ─────────────────────────── */

const NOW = new Date("2026-09-11T10:00:00Z");
function job(id, over = {}) {
  return {
    id,
    status: "Pending Approval",
    stage: "Incoming",
    priority: "Medium",
    tier: 2,
    engineer: "Handyman",
    category: "Electrical",
    siteId: "s1",
    requestedAt: "2026-09-01T09:00:00.000Z",
    dueAt: null,
    completedAt: null,
    archived: false,
    parentId: null,
    boardId: "maintenance",
    ...over,
  };
}

test("tier, engineer and aging drills open exactly the jobs each figure counted", () => {
  const population = [
    job("J1", { tier: 1 }),
    job("J2", { tier: 0 }),
    job("J3", { tier: null }),
    job("J4", { engineer: "" }),
    job("J5", { engineer: "handyman" }),
    job("J6", { requestedAt: "2026-06-25T08:00:00.000Z" }),
    job("J7", { requestedAt: "2026-08-27T23:00:00.000Z" }),
    job("J8", { requestedAt: "2026-08-28T08:00:00.000Z" }),
    job("J9", { status: "Job Completed", stage: "Completed", completedAt: "2026-09-02", tier: 0 }),
  ];
  const open = (query) => {
    const filter = readDrillFilter(new URLSearchParams(`family=open&${query}`), NOW, { population });
    return population.filter((row) => filter.matches(row)).map((row) => row.id);
  };
  const tiers = buildTiers([{ tier: 1, total: 1 }, { tier: 2, total: 5 }, { tier: 0, total: 1 }, { tier: null, total: 1 }]);
  const none = tiers.find((row) => row.label === "No tier");
  assert.deepEqual(open(`tier=${encodeURIComponent(none.labels.join("|"))}`), ["J2", "J3"], "0 and null, open only");

  const engineers = buildEngineers([{ engineer: "Handyman", total: 6 }, { engineer: "handyman", total: 1 }, { engineer: "", total: 1 }]);
  assert.deepEqual(open(`engineer=${encodeURIComponent(engineers[0].labels.join("|"))}`).length, 7);
  assert.deepEqual(open(`engineer=${encodeURIComponent(engineers.at(-1).labels.join("|"))}`), ["J4"]);

  /* Aged: requested on or before the cutoff (27 Aug for 11 Sept). J6 and J7. */
  const built = buildJobIntel(fixture({ aging: { count: 2, oldestDay: "2026-06-25" } }));
  assert.deepEqual(
    open(`measure=requested&period=custom&from=${built.aging.oldestDay}&to=${built.aging.cutoff}`),
    ["J6", "J7"],
  );
});

test("breach risk: High or Tier 1, not yet late, due today or tomorrow — or within 48h of now", () => {
  const population = [
    job("R1", { priority: "Urgent", dueAt: "2026-09-11" }),
    job("R2", { tier: 1, dueAt: "2026-09-12" }),
    job("R3", { priority: "Urgent", dueAt: "2026-09-13" }),
    job("R4", { priority: "Urgent", dueAt: "2026-09-10" }),
    job("R5", { priority: "Medium", tier: 2, dueAt: "2026-09-11" }),
    job("R6", { priority: "Urgent", dueAt: "2026-09-13T09:00:00.000Z" }),
    job("R7", { priority: "Urgent", dueAt: "2026-09-13T11:00:00.000Z" }),
    job("R8", { priority: "Urgent", dueAt: "2026-09-11T09:00:00.000Z" }),
    job("R9", { priority: "Urgent", dueAt: "2026-09-11", status: "Job Completed", stage: "Completed" }),
  ];
  const filter = readDrillFilter(new URLSearchParams("family=open&risk=breach"), NOW, { population });
  /*
   * NOW is 11 Sept 10:00Z. R1/R2: due today/tomorrow, High or Tier 1. R3: the
   * day after tomorrow — outside. R4: already overdue. R5: neither High nor
   * Tier 1. R6: 47h from now — inside; R7: 49h — outside. R8: an instant an
   * hour ago — overdue, not at risk. R9: finished work is never at risk.
   */
  assert.deepEqual(population.filter((row) => filter.matches(row)).map((row) => row.id), ["R1", "R2", "R6"]);
  assert.ok(filter.chips.some((chip) => chip.key === "risk"), "and the banner says why the list is short");
});

/* ── 3. Live ──────────────────────────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, { headers, signal: AbortSignal.timeout(4000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

test("the live section reconciles and ties to the Overview's own figures", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics?from=2025-10-01&to=2026-09-11`, { headers })).json();
  assert.deepEqual(metrics.reconciliation, [], "the route's own identities, the intel ones included");
  const section = metrics.intel;
  assert.equal(section.open, metrics.openJobs);
  assert.equal(section.sla.percent ?? 0, metrics.sla.percent);
  assert.equal(section.completed, metrics.kpis.find((kpi) => kpi.key === "completed").value);
  assert.deepEqual(reconcileIntel(section), []);
  assert.doesNotMatch(JSON.stringify(section), /NaN|Infinity/);
});

test("the live job feed reproduces every clicked split", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics?from=2025-10-01&to=2026-09-11`, { headers })).json();
  const population = (await (await fetch(`${BASE}/api/maintenance?limit=2000`, { headers })).json()).requests ?? [];
  const count = (query) => {
    const filter = readDrillFilter(new URLSearchParams(query), new Date(), { population });
    return population.filter((row) => filter.matches(row)).length;
  };
  const pipe = (labels) => encodeURIComponent(labels.join("|"));
  const { intel: section } = metrics;
  assert.equal(count("family=open"), section.open, "open jobs");
  for (const row of section.tiers) assert.equal(count(`family=open&tier=${pipe(row.labels)}`), row.value, row.label);
  for (const row of section.engineers) assert.equal(count(`family=open&engineer=${pipe(row.labels)}`), row.value, row.label);
  for (const row of section.labels) assert.equal(count(`family=open&label=${pipe(row.labels)}`), row.value, row.label);
  for (const row of section.priority) assert.equal(count(`family=open&priority=${pipe(row.labels)}`), row.value, row.label);
  for (const row of section.status) {
    assert.equal(count(`family=open&meter=${encodeURIComponent(row.label)}&status=${pipe(row.labels)}`), row.value, row.label);
  }
  if (section.aging.oldestDay) {
    assert.equal(
      count(`family=open&measure=requested&period=custom&from=${section.aging.oldestDay}&to=${section.aging.cutoff}`),
      section.aging.count,
      "aging",
    );
  }
  assert.equal(count("family=open&overdue=1"), section.sla.overdue, "the jobs failing SLA");
  assert.equal(count("family=open&risk=breach"), section.breachRisk.count, "breach risk");
});

/* ── 4. The server wiring ─────────────────────────────────────────────────── */

test("the section is built once, from the Overview's own scope and predicates", async () => {
  const metrics = await read("app/lib/overview-metrics.ts");
  assert.match(metrics, /intel: buildJobIntel\(\{/);
  assert.match(metrics, /categoryRows: categoryGrouped\.map\(/, "labels are grouped from the raw rows, by the board's key");
  assert.match(metrics, /const from = isCalendarDay\(options\.from\) \? options\.from : shiftDay\(today, -30\);/);
  const route = await read("app/api/overview/metrics/route.ts");
  assert.match(route, /const failures = \[\.\.\.reconcile\(metrics\), \.\.\.reconcileIntelWithOverview\(metrics\)\];/);
  /* Open work is `openScope` (not closedJobSql) in every split query. */
  const block = metrics.slice(metrics.indexOf("const [tierRows, engineerRows"), metrics.indexOf("const openJobs = Number"));
  assert.equal((block.match(/\.where\(openScope\)/g) ?? []).length, 3, "tier, engineer and priority splits");
  assert.match(block, /sum\(case when \$\{overdueOpenSql\(now\)\} then 1 else 0 end\)/, "the headline's overdue rule");
  assert.doesNotMatch(block, /julianday|over \(/i, "dual-dialect: no julianday, no window functions");
  const contract = await read("app/lib/overview-intel-contract.ts");
  assert.doesNotMatch(contract, /^import /m, "the wire contract imports nothing");
  const builder = await read("app/lib/overview-intel.ts");
  assert.doesNotMatch(builder, /from "drizzle-orm"|db\/schema/, "the builder stays pure");
});
