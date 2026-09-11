/**
 * SPEND ADDS UP TO THE PENNY, WHEREVER IT IS ADDED.
 *
 * `maintenance_requests.cost` is a binary float in POUNDS — a SQLite REAL, and
 * a Postgres `real` (single precision) on the deployed estate. Three surfaces
 * add it up: a KPI and its sparkline (per job, in `spendLineOf`), the monthly
 * trend on Reports and the Overview (`loadSpendByMonth`), and the list of jobs
 * a reader lands on after tapping either. They have to agree exactly, because
 * the reconciliation the Reports block performs is an equality, not a
 * tolerance, and because a client checks these numbers with a calculator.
 *
 * TWO WAYS THEY USED TO DISAGREE, both pinned below:
 *
 *   · `Math.round(pounds * 100)` — binary floats cannot hold 1.005, so
 *     `1.005 * 100` is 100.49999999999999 and rounds DOWN to £1.00. Every
 *     conversion now goes through `poundsToPence`, which fixes the
 *     representation before rounding;
 *   · `sum(cost)` IN SQL, rounded once per month. Two jobs at £0.125 are 13p
 *     each — 26p — as jobs, but £0.25 summed, which rounds to 25p; two at
 *     £10.004 are 2000p as jobs and 2001p summed. On Postgres it is worse than
 *     a penny: `sum(real)` is itself `real`, seven significant digits, so a
 *     month past about £100,000 drifts before the total ever reaches
 *     JavaScript. `loadSpendByMonth` now groups by (month, cost) with a COUNT
 *     and multiplies per-job pence in JS.
 *
 * The arithmetic is asserted by CALLING it; the query's shape is pinned against
 * its source, because a `GROUP BY` cannot be called without a database.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { spendLineOf } = await import("../app/lib/job-metrics.ts");
const { poundsToPence } = await import("../app/lib/reporting/money.ts");
const { buildReportsDashboard, resolveReportsRange } = await import("../app/lib/reports-dash.ts");

const NOW = new Date("2026-09-11T10:00:00Z");
const DAY = "2026-06-10";

const line = (cost, completedAt = DAY) => spendLineOf({ cost, completedAt })?.pence ?? null;

/* ── One job, one conversion ──────────────────────────────────────────────── */

test("a job's pence are the answer a calculator gives, not the float's", () => {
  assert.equal(line(0.125), 13, "half a penny rounds away from zero");
  assert.equal(line(1.005), 101, "1.005 * 100 is 100.49999999999999 in binary; the answer is still 101p");
  assert.equal(line(10.004), 1000);
  assert.equal(line(12.34), 1234, "12.34 * 100 is 1233.9999999999998");
  assert.equal(line(12.345), 1235);
  assert.equal(line(0.1 + 0.2), 30, "0.30000000000000004 is 30p");
  assert.equal(line(0), 0, "a £0 job is a spend line of nothing, not an absence");
  assert.equal(line(-1.005), -101, "a credit rounds by the same magnitude, so it clears the charge it reverses");
  assert.equal(spendLineOf({ cost: null, completedAt: DAY }), null);
  assert.equal(spendLineOf({ cost: 10, completedAt: null }), null);
  assert.equal(spendLineOf({ cost: Number.NaN, completedAt: DAY }), null, "never NaN pence");
});

test("the bare multiplication this replaced loses the penny", () => {
  /* Kept as an assertion rather than a comment: it is the reason the
     conversion is a function and not an expression. */
  assert.equal(Math.round(1.005 * 100), 100, "the old rule");
  assert.equal(poundsToPence(1.005), 101, "the rule now");
  assert.equal(line(1.005), poundsToPence(1.005), "and `spendLineOf` is that rule, not a second copy");
});

/* ── Many jobs, one month ─────────────────────────────────────────────────── */

/**
 * `loadSpendByMonth`'s rule, restated: the database groups completed jobs by
 * (month, cost) and counts them; each distinct cost becomes pence ONCE and is
 * multiplied by its count. The real query cannot be called without a database,
 * so its shape is pinned against the source below.
 */
function groupedMonths(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const day = String(job.completedAt ?? "").slice(0, 10);
    if (!day || job.cost === null || job.cost === undefined) continue;
    const key = `${day.slice(0, 7)}|${job.cost}`;
    const group = groups.get(key) ?? { month: day.slice(0, 7), cost: job.cost, jobs: 0 };
    group.jobs += 1;
    groups.set(key, group);
  }
  const months = new Map();
  for (const group of groups.values()) {
    months.set(group.month, (months.get(group.month) ?? 0) + poundsToPence(Number(group.cost)) * group.jobs);
  }
  return months;
}

/** What the query used to do: `sum(cost)` in SQL, rounded once per month. */
function summedMonths(jobs) {
  const months = new Map();
  for (const job of jobs) {
    const day = String(job.completedAt ?? "").slice(0, 10);
    if (!day || job.cost === null || job.cost === undefined) continue;
    months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + Number(job.cost));
  }
  return new Map([...months].map(([month, pounds]) => [month, Math.round(pounds * 100)]));
}

const jobsAt = (...costs) =>
  costs.map((cost, index) => ({ id: `J${index}`, cost, completedAt: DAY, siteId: "s1", category: "Electrical" }));

function sumOfLines(jobs) {
  return jobs.reduce((total, job) => total + (spendLineOf(job)?.pence ?? 0), 0);
}

test("a month is the sum of its jobs' pence — the cases where summing first is not", () => {
  for (const [name, costs, grouped, summed] of [
    ["two at £0.125", [0.125, 0.125], 26, 25],
    ["two at £10.004", [10.004, 10.004], 2000, 2001],
    ["two at £1.005", [1.005, 1.005], 202, 201],
    ["£0.1 and £0.2", [0.1, 0.2], 30, 30],
  ]) {
    const jobs = jobsAt(...costs);
    assert.equal(groupedMonths(jobs).get("2026-06"), grouped, `${name}: the month`);
    assert.equal(sumOfLines(jobs), grouped, `${name}: the same as its jobs' lines`);
    assert.equal(summedMonths(jobs).get("2026-06"), summed, `${name}: what summing the column first gives`);
  }
});

test("mixed costs in one month still reconcile with the job list", () => {
  const jobs = jobsAt(0.125, 0.125, 10.004, 1.005, 12.34, 0, 99.995);
  assert.equal(groupedMonths(jobs).get("2026-06"), sumOfLines(jobs));
  assert.equal(groupedMonths(jobs).get("2026-06"), 13 + 13 + 1000 + 101 + 1234 + 0 + 10000);
});

/* ── The block: KPI, sparkline and trend agree ────────────────────────────── */

function build(jobs) {
  return buildReportsDashboard({
    jobs: jobs.map((job) => ({
      ...job,
      tier: 1,
      jobTypeId: null,
      requestedAt: `${DAY}T09:00:00.000Z`,
      contractor: null,
      reference: job.id,
      title: job.id,
    })),
    siteNames: new Map([["s1", "Aldgate"]]),
    jobTypes: [],
    monthlySpend: groupedMonths(jobs),
    now: NOW,
    range: resolveReportsRange({ from: "2026-06-01", to: "2026-06-30" }, NOW),
    trendRange: "3m",
    sitesRange: "page",
    portfolio: { id: "all", name: "All portfolios", siteIds: [] },
    portfolios: [],
    siteCount: 1,
  });
}

test("the KPI, its sparkline, the site bar and the trend all read the same pennies", () => {
  for (const [costs, pence] of [
    [[0.125, 0.125], 26],
    [[10.004, 10.004], 2000],
    [[1.005, 1.005], 202],
  ]) {
    const metrics = build(jobsAt(...costs));
    const total = metrics.kpis[0];
    assert.equal(total.pence, pence, `two jobs at ${costs[0]}`);
    assert.equal(total.spark.reduce((sum, point) => sum + point.pence, 0), pence, "the sparkline");
    assert.equal(metrics.topSites.totalPence, pence, "the site bars");
    assert.equal(metrics.trend.points.find((point) => point.month === "2026-06")?.pence, pence, "the monthly trend");
    assert.deepEqual(metrics.reconciliation, [], "and the block reconciles");
  }
});

/* ── The query's shape, pinned where it lives ─────────────────────────────── */

test("loadSpendByMonth groups by cost and counts — it does not sum the column", async () => {
  const source = await read("app/lib/overview-metrics.ts");
  const fn = source.slice(source.indexOf("export async function loadSpendByMonth"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /cost: maintenanceRequests\.cost,/, "the cost comes back as itself");
  assert.match(body, /jobs: count\(\),/, "with how many jobs carry it");
  assert.match(body, /\.groupBy\(sql`month`, maintenanceRequests\.cost\)/, "grouped by month AND cost");
  assert.match(body, /const pence = poundsToPence\(Number\(row\.cost\)\);/, "converted once per distinct cost");
  assert.match(body, /pence \* Number\(row\.jobs \?\? 0\)/, "and multiplied by the count, in integers");
  assert.doesNotMatch(body, /sum\(/, "summing the float column in SQL is what this replaced");
  assert.doesNotMatch(body, /Math\.round\(Number\(row\.pounds/, "and so is rounding a month's float total once");
  assert.match(source, /import \{ poundsToPence \} from "\.\/reporting\/money";/);
});

/* ── And the query itself, over a real database ───────────────────────────── */

test("the real query returns the jobs' pennies, run over SQLite", async () => {
  /*
   * The pins above describe the statement; this RUNS it. `loadSpendByMonth` is
   * handed a drizzle instance over `node:sqlite` through the proxy driver, so
   * the `GROUP BY month, cost` and the count are the real ones — the arithmetic
   * is checked where it actually happens, not in a restatement of it.
   */
  const { drizzle } = await import("drizzle-orm/sqlite-proxy");
  const { sql } = await import("drizzle-orm");
  const { loadSpendByMonth } = await import("../app/lib/overview-metrics.ts");
  const { maintenanceRequests } = await import("../db/schema.ts");

  const lite = new DatabaseSync(":memory:");
  lite.exec(`CREATE TABLE maintenance_requests (
    id TEXT PRIMARY KEY NOT NULL,
    organisation_id TEXT,
    cost REAL,
    completed_at TEXT
  );`);
  const insert = lite.prepare(
    "INSERT INTO maintenance_requests (id, organisation_id, cost, completed_at) VALUES (?, 'org', ?, ?)",
  );
  const rows = [
    ["a", 0.125, "2026-06-10"],
    ["b", 0.125, "2026-06-11"],
    ["c", 10.004, "2026-07-01"],
    ["d", 10.004, "2026-07-02"],
    ["e", 1.005, "2026-07-03"],
    ["f", null, "2026-07-04"],
    ["g", 5, ""],
  ];
  for (const row of rows) insert.run(...row);

  const db = drizzle(async (query, params, method) => {
    if (method === "run") return { rows: [] };
    return { rows: lite.prepare(query).all(...params).map((row) => Object.values(row)) };
  });

  const months = await loadSpendByMonth(
    db,
    sql`${maintenanceRequests.organisationId} = 'org'`,
    "2026-01-01",
    "2027-01-01",
  );
  assert.equal(months.get("2026-06"), 26, "two jobs at £0.125 are 26p, not the 25p a summed £0.25 rounds to");
  assert.equal(months.get("2026-07"), 1000 + 1000 + 101, "two at £10.004 are 2000p, not 2001p, and £1.005 is 101p");
  assert.equal(months.size, 2, "a job with no cost and one with no completion day are not spend");
  const jobs = rows.map(([id, cost, completedAt]) => ({ id, cost, completedAt }));
  assert.equal(
    [...months.values()].reduce((sum, pence) => sum + pence, 0),
    sumOfLines(jobs),
    "and the months add up to exactly the jobs' own lines",
  );
});

test("spendLineOf converts through the one money boundary", async () => {
  const rules = await read("app/lib/job-metrics.ts");
  const fn = rules.slice(rules.indexOf("export function spendLineOf"));
  assert.match(fn.slice(0, 400), /const pence = poundsToPence\(Number\(job\.cost\)\);/);
  assert.doesNotMatch(fn.slice(0, 400), /Math\.round\(pounds \* 100\)/, "never the bare multiplication");
  assert.match(rules, /import \{ poundsToPence \} from "\.\/reporting\/money\.ts";/,
    "with the `.ts` specifier this module needs to stay loadable by node --test",
  );
});
