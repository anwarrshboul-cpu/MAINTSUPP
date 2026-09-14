/**
 * REPORTS BY THE JOB'S CANONICAL JOB TYPE — the owner's rule, as tests.
 *
 * The Reports KPIs used to INFER a type: a compliance category or tier 4+ was
 * "planned", £1,000 or more a "project", everything else "reactive". None of
 * those is a business fact, the owner ruled them out, and the split is now the
 * job's own `job_type_id` against the organisation's `job_type_config`. What
 * that has to guarantee, and what this file asserts by CALLING the builder and
 * the Jobs page's filter over one fixture:
 *
 *   1. one KPI per DEFAULT type, by its stable code, in the order reactive,
 *      planned, project — each labelled with the type's CURRENT label, so a
 *      rename moves the words and never the figures;
 *   2. custom types grouped as Other and untyped jobs as Unclassified: neither
 *      crashes anything, neither is dropped, and
 *      Reactive + Planned + Project + Other + Unclassified = the total, exactly;
 *   3. a DEACTIVATED default type keeps its card while it has spend in the
 *      range — retiring a type is not deleting its history — and loses it when
 *      it has none;
 *   4. every drill is a STABLE token — the type's id, `__other__`,
 *      `__unclassified__` — that opens exactly the jobs and the pounds the
 *      figure counted, with or without the types to hand; an old
 *      `type=projects` link still opens the Project jobs; an unknown token
 *      opens nothing.
 *
 * Pure: `buildReportsDashboard` and `readDrillFilter` are imported and called.
 * The last two tests check the same properties against a running server and
 * SKIP without one.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { buildReportsDashboard, resolveReportsRange } = await import("../app/lib/reports-dash.ts");
const { jobTypeBucketOf, spendLineOf } = await import("../app/lib/job-metrics.ts");
const { poundsToPence } = await import("../app/lib/reporting/money.ts");
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");

const NOW = new Date("2026-09-11T10:00:00Z");
const SITES = new Map([["s1", "Aldgate"]]);

/* The ids `seedJobTypes` mints, plus two an administrator added (`jt_<uuid>`). */
const ID = {
  reactive: "jt_org-9_reactive",
  planned: "jt_org-9_planned",
  project: "jt_org-9_project",
  emergency: "jt_4d1f9c0a11f14d0b8f4a2f6e5c7b1a20",
  landlord: "jt_9b2e7d3c44a24e1fb0c85d7e6a9f3c11",
};

/*
 * The organisation's types as `listJobTypes` returns them — deactivated ones
 * included. Planned has been RENAMED, Project RETIRED, and there are two
 * custom types, one of them retired too.
 */
const TYPES = [
  { id: ID.reactive, code: "reactive", label: "Reactive", colourHex: null, sortOrder: 10, active: true },
  { id: ID.planned, code: "planned", label: "Planned upkeep", colourHex: null, sortOrder: 20, active: true },
  { id: ID.project, code: "project", label: "Project", colourHex: null, sortOrder: 30, active: false },
  { id: ID.emergency, code: null, label: "Emergency call-out", colourHex: "#FF8A3D", sortOrder: 40, active: true },
  { id: ID.landlord, code: null, label: "Landlord works", colourHex: null, sortOrder: 50, active: false },
];

function job(id, over = {}) {
  return {
    id,
    siteId: "s1",
    category: "Electrical",
    tier: 1,
    jobTypeId: null,
    cost: null,
    completedAt: null,
    requestedAt: "2026-06-01T09:00:00.000Z",
    contractor: null,
    reference: id,
    title: id,
    /* The browser-only fields `readDrillFilter` reads. */
    archived: false,
    parentId: null,
    boardId: "maintenance",
    status: "Job Completed",
    stage: "Completed",
    ...over,
  };
}

/*
 * THE FIXTURE, worked by hand. Range 1 Jun – 31 Aug 2026, previous 1 Mar – 31 May.
 *
 *   R1  Reactive            £100     completed 10 Jun
 *   R2  Reactive            £25.25   completed 1 Jul
 *   N1  Reactive, NO COST   —                              never a spend line
 *   P1  Planned upkeep      £300     completed 20 Jun
 *   X1  Project (RETIRED)   £1,000   completed 5 Aug       history, not deleted
 *   C1  Emergency call-out  £40      completed 15 Jul      custom → Other
 *   C2  Landlord works      £60      completed 16 Jul      custom, retired → Other
 *   D1  jt_gone             £15      completed 21 Aug      names no type → Other
 *   U1  no type             £70      completed 5 Jun       → Unclassified
 *   U2  type "" (blank)     £30      completed 20 Aug      → Unclassified
 *   O1  Reactive            £500     completed 1 May       the PREVIOUS period
 *
 *   In range: 100 + 25.25 + 300 + 1000 + 40 + 60 + 15 + 70 + 30 = £1,640.25 over 9 jobs
 *     Reactive £125.25 (2) · Planned £300 (1) · Project £1,000 (1)
 *     Other £115 (3) · Unclassified £100 (2)
 */
const JOBS = [
  job("R1", { jobTypeId: ID.reactive, cost: 100, completedAt: "2026-06-10" }),
  job("R2", { jobTypeId: ID.reactive, cost: 25.25, completedAt: "2026-07-01" }),
  job("N1", { jobTypeId: ID.reactive, status: "New", stage: "Incoming" }),
  job("P1", { jobTypeId: ID.planned, category: "Compliance inspection", cost: 300, completedAt: "2026-06-20" }),
  job("X1", { jobTypeId: ID.project, cost: 1000, completedAt: "2026-08-05" }),
  job("C1", { jobTypeId: ID.emergency, category: "Plumbing", cost: 40, completedAt: "2026-07-15" }),
  job("C2", { jobTypeId: ID.landlord, category: "Glass", cost: 60, completedAt: "2026-07-16" }),
  job("D1", { jobTypeId: "jt_gone", category: "Doors", cost: 15, completedAt: "2026-08-21" }),
  job("U1", { cost: 70, completedAt: "2026-06-05" }),
  job("U2", { jobTypeId: "", category: "Lifts", cost: 30, completedAt: "2026-08-20" }),
  job("O1", { jobTypeId: ID.reactive, cost: 500, completedAt: "2026-05-01" }),
];

/** `loadSpendByMonth`'s rule: grouped by month and cost, converted once per cost. */
function monthlyOf(jobs) {
  const groups = new Map();
  for (const row of jobs) {
    const line = spendLineOf(row);
    if (!line) continue;
    const key = `${line.day.slice(0, 7)}|${row.cost}`;
    const group = groups.get(key) ?? { month: line.day.slice(0, 7), cost: row.cost, jobs: 0 };
    group.jobs += 1;
    groups.set(key, group);
  }
  const months = new Map();
  for (const group of groups.values()) {
    months.set(group.month, (months.get(group.month) ?? 0) + poundsToPence(Number(group.cost)) * group.jobs);
  }
  return months;
}

function build(jobs = JOBS, types = TYPES) {
  return buildReportsDashboard({
    jobs,
    siteNames: SITES,
    jobTypes: types,
    monthlySpend: monthlyOf(jobs),
    now: NOW,
    range: resolveReportsRange({ from: "2026-06-01", to: "2026-08-31" }, NOW),
    trendRange: "3m",
    sitesRange: "page",
    portfolio: { id: "all", name: "All portfolios", siteIds: [] },
    portfolios: [],
    siteCount: 1,
  });
}

const kpi = (metrics, key) => metrics.kpis.find((entry) => entry.key === key);

/* ── The split ────────────────────────────────────────────────────────────── */

test("every KPI is a job type, and the five buckets are the total to the penny", () => {
  const metrics = build();
  assert.deepEqual(metrics.kpis.map((entry) => entry.key), ["total", "reactive", "planned", "project"],
    "total first, then one card per default code in code order");
  assert.equal(kpi(metrics, "total").pence, 164025);
  assert.equal(kpi(metrics, "total").jobs, 9);
  assert.deepEqual([kpi(metrics, "reactive").pence, kpi(metrics, "reactive").jobs], [12525, 2]);
  assert.deepEqual([kpi(metrics, "planned").pence, kpi(metrics, "planned").jobs], [30000, 1]);
  assert.deepEqual([kpi(metrics, "project").pence, kpi(metrics, "project").jobs], [100000, 1]);
  assert.deepEqual([metrics.other.pence, metrics.other.jobs], [11500, 3], "two custom types and an id that names none");
  assert.deepEqual([metrics.unclassified.pence, metrics.unclassified.jobs], [10000, 2], "a null type and a blank one");
  assert.equal(
    kpi(metrics, "reactive").pence + kpi(metrics, "planned").pence + kpi(metrics, "project").pence +
      metrics.other.pence + metrics.unclassified.pence,
    kpi(metrics, "total").pence,
    "Reactive + Planned + Project + Other + Unclassified = the total",
  );
  assert.deepEqual(metrics.reconciliation, [], "and the builder says so itself");
  assert.doesNotMatch(JSON.stringify(metrics), /NaN|Infinity/);
});

test("nothing is inferred: a costly compliance job with no type is Unclassified", () => {
  /*
   * The retired rule would have made P1 "planned" for its category and X1 a
   * "project" for its cost whatever their types said. The fixture proves the
   * opposite direction too: U1 is a £70 job with no type and it stays
   * Unclassified, and a £5,000 compliance job would as well.
   */
  const heavy = job("H1", { category: "Compliance", tier: 5, cost: 5000, completedAt: "2026-06-07" });
  const metrics = build([...JOBS, heavy]);
  assert.equal(metrics.unclassified.pence, 10000 + 500000);
  assert.equal(kpi(metrics, "planned").pence, 30000, "the category did not move it");
  assert.equal(kpi(metrics, "project").pence, 100000, "nor did the cost");
  assert.equal(jobTypeBucketOf(heavy.jobTypeId, TYPES), "unclassified");
  assert.equal(metrics.dataGaps.withoutType, 3);
  assert.equal(metrics.dataGaps.withoutTypePence, 510000, "the gap is reported in pounds as well as in jobs");
  assert.equal(metrics.dataGaps.otherType, 3);
  assert.equal(metrics.dataGaps.otherTypePence, 11500);
  assert.deepEqual(metrics.reconciliation, []);
});

test("a renamed type moves the words and never the figures", () => {
  const before = build();
  assert.equal(kpi(before, "planned").label, "Planned upkeep", "the card reads the configuration's current label");
  const renamed = TYPES.map((type) => (type.code === "planned" ? { ...type, label: "Scheduled maintenance" } : type));
  const after = build(JOBS, renamed);
  assert.equal(kpi(after, "planned").label, "Scheduled maintenance");
  assert.equal(kpi(after, "planned").pence, kpi(before, "planned").pence, "the same pounds");
  assert.equal(kpi(after, "planned").jobTypeId, kpi(before, "planned").jobTypeId, "and the same id");
  assert.equal(kpi(after, "planned").drillType, ID.planned, "so an old link still opens the same jobs");
  assert.deepEqual(
    metricsLabels(after),
    ["Reactive", "Scheduled maintenance", "Project"],
    "every card takes its words from the configuration",
  );
  assert.deepEqual(after.other.typeLabels, ["Emergency call-out", "Landlord works"],
    "and Other can name the custom types inside it");
});

function metricsLabels(metrics) {
  return metrics.kpis.filter((entry) => entry.key !== "total").map((entry) => entry.label);
}

test("a deactivated type keeps its card while it has spend, and loses it when it has none", () => {
  const withHistory = build();
  const retired = kpi(withHistory, "project");
  assert.equal(retired.active, false, "Project is deactivated in the fixture");
  assert.equal(retired.pence, 100000, "and its history is still counted — retiring is not deleting");

  const withoutHistory = build(JOBS.filter((row) => row.id !== "X1"));
  assert.equal(kpi(withoutHistory, "project"), undefined, "with nothing in the range the card goes");
  assert.deepEqual(withoutHistory.kpis.map((entry) => entry.key), ["total", "reactive", "planned"]);
  assert.deepEqual(withoutHistory.reconciliation, [], "and the identity still holds");
  assert.equal(kpi(withoutHistory, "reactive").active, true);
});

test("an organisation with no types at all still reconciles", () => {
  /* Every typed job is then a type nobody can name — Other — and nothing is
     dropped, which is the property that matters. */
  const metrics = build(JOBS, []);
  assert.deepEqual(metrics.kpis.map((entry) => entry.key), ["total"]);
  assert.equal(metrics.other.pence + metrics.unclassified.pence, kpi(metrics, "total").pence);
  assert.deepEqual(metrics.reconciliation, []);
});

/* ── The drills ───────────────────────────────────────────────────────────── */

const WINDOW = "hasCost=1&measure=completed&period=custom&from=2026-06-01&to=2026-08-31";

function opened(query, context = { jobTypes: TYPES }) {
  const filter = readDrillFilter(new URLSearchParams(query), NOW, { population: JOBS, ...context });
  const rows = JOBS.filter((row) => filter.matches(row));
  return {
    jobs: rows.length,
    pence: rows.reduce((sum, row) => sum + (spendLineOf(row)?.pence ?? 0), 0),
    ids: rows.map((row) => row.id),
  };
}

test("every figure's drill opens exactly the jobs and the pounds it counted", () => {
  const metrics = build();
  for (const entry of metrics.kpis) {
    const query = entry.drillType ? `${WINDOW}&type=${encodeURIComponent(entry.drillType)}` : WINDOW;
    const list = opened(query);
    assert.deepEqual([list.jobs, list.pence], [entry.jobs, entry.pence], `${entry.key} card`);
  }
  for (const bucket of [metrics.other, metrics.unclassified]) {
    const list = opened(`${WINDOW}&type=${encodeURIComponent(bucket.drillType)}`);
    assert.deepEqual([list.jobs, list.pence], [bucket.jobs, bucket.pence], `${bucket.key} bucket`);
  }
  assert.deepEqual(opened(`${WINDOW}&type=__other__`).ids, ["C1", "C2", "D1"],
    "Other holds the custom types AND the id that names none — never a dropped job");
  assert.deepEqual(opened(`${WINDOW}&type=__unclassified__`).ids, ["U1", "U2"]);
});

test("a drill works whether or not the page was handed the organisation's types", () => {
  /*
   * The shell may render the board before the types have loaded. The three
   * defaults are still recognised by their deterministic `jt_<org>_<code>`
   * ids, and a custom id is still not one of them, so the same link opens the
   * same list either way.
   */
  const metrics = build();
  for (const entry of metrics.kpis.slice(1)) {
    const query = `${WINDOW}&type=${encodeURIComponent(entry.drillType)}`;
    assert.deepEqual(opened(query, {}).ids, opened(query).ids, `${entry.key} without the types`);
  }
  for (const token of ["__other__", "__unclassified__", "projects"]) {
    assert.deepEqual(opened(`${WINDOW}&type=${token}`, {}).ids, opened(`${WINDOW}&type=${token}`).ids, token);
  }
});

test("an old type= link still opens the same jobs, and an unknown one opens none", () => {
  const project = opened(`${WINDOW}&type=jt_org-9_project`);
  assert.deepEqual(opened(`${WINDOW}&type=projects`).ids, project.ids, "the Reports block's old plural");
  assert.deepEqual(opened(`${WINDOW}&type=project`).ids, project.ids);
  assert.deepEqual(opened(`${WINDOW}&type=reactive`).ids, opened(`${WINDOW}&type=${ID.reactive}`).ids);
  for (const token of ["type=jt_not_a_type", "type=banana", "type=__nope__"]) {
    assert.deepEqual(opened(`${WINDOW}&${token}`).ids, [],
      "an unknown token selects nothing rather than everything — a stale URL cannot widen a list");
  }
});

test("the chip names the type as it is called now, not as the link spells it", () => {
  const chip = (query, context = { jobTypes: TYPES }) =>
    readDrillFilter(new URLSearchParams(query), NOW, context).chips.find((entry) => entry.key === "type")?.value;
  assert.equal(chip(`type=${ID.planned}`), "Planned upkeep");
  assert.equal(chip("type=planned"), "Planned upkeep", "an old link, named by the configuration it lands in");
  assert.equal(chip(`type=${ID.emergency}`), "Emergency call-out");
  assert.equal(chip("type=__unclassified__"), "Unclassified");
  assert.equal(chip("type=__other__"), "Other");
  assert.equal(chip("type=planned", {}), "Planned", "without the types, the default's own word");
});

/* ── The route ────────────────────────────────────────────────────────────── */

test("the route reads the job's type and the organisation's types, and names them in the export", async () => {
  const route = await read("app/api/reports/metrics/route.ts");
  assert.match(route, /jobTypeId: maintenanceRequests\.jobTypeId,/, "the type reaches the builder");
  assert.match(route, /listJobTypes\(db, orgId\)/, "with the organisation's own types, retired ones included");
  assert.match(route, /buildReportsDashboard\(\{\s*jobs,\s*siteNames,\s*jobTypes,/);
  assert.match(route, /"Job type"/, "and the export keeps its column");
  assert.match(route, /const typeLabels = new Map\(jobTypes\.map\(\(type\) => \[type\.id, type\.label\]\)\);/);
  assert.match(route, /if \(!id\) return UNCLASSIFIED_LABEL;/);
  assert.match(route, /return typeLabels\.get\(id\) \?\? OTHER_JOB_TYPES_LABEL;/);
  assert.doesNotMatch(route, /spendTypeOf|SPEND_TYPE_LABEL/, "the inference is gone from the route as well");
  const builder = await read("app/lib/reports-dash.ts");
  assert.doesNotMatch(builder, /spendTypeOf|PROJECT_COST_THRESHOLD/, "and from the builder");
  const rules = await read("app/lib/job-metrics.ts");
  assert.doesNotMatch(rules, /export function spendTypeOf/, "and from the module it used to live in");
});

/* ── Against the running estate ───────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/reports/metrics`, { headers, signal: AbortSignal.timeout(6000) });
    return response.ok;
  } catch {
    return false;
  }
}

test("the live block's type split reconciles and each drill matches its figure", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const query = "from=2025-09-01&to=2026-09-11";
  const metrics = await (await fetch(`${BASE}/api/reports/metrics?${query}`, { headers })).json();
  assert.deepEqual(metrics.reconciliation, []);
  const total = metrics.kpis[0];
  const typed = metrics.kpis.slice(1);
  assert.equal(
    typed.reduce((sum, entry) => sum + entry.pence, 0) + metrics.other.pence + metrics.unclassified.pence,
    total.pence,
    "the five buckets are the total",
  );
  for (const entry of typed) {
    assert.ok(["reactive", "planned", "project"].includes(entry.key), `${entry.key} is a stable code`);
    assert.ok(entry.drillType && entry.drillType === entry.jobTypeId, "a card drills by its type's id");
  }

  /* The labels are the configuration's, so the two reads agree on the words. */
  const configured = await fetch(`${BASE}/api/job-types`, { headers });
  if (configured.ok) {
    const byId = new Map(((await configured.json()).jobTypes ?? []).map((type) => [type.id, type.label]));
    for (const entry of typed) assert.equal(entry.label, byId.get(entry.jobTypeId), `${entry.key} reads its current label`);
  }

  const population = (await (await fetch(`${BASE}/api/maintenance?limit=2000`, { headers })).json()).requests ?? [];
  const live = (drillQuery) => {
    const filter = readDrillFilter(new URLSearchParams(drillQuery), new Date(), { population });
    const rows = population.filter((row) => filter.matches(row));
    return { jobs: rows.length, pence: rows.reduce((sum, row) => sum + (spendLineOf(row)?.pence ?? 0), 0) };
  };
  const window = `hasCost=1&measure=completed&period=custom&from=${metrics.range.from}&to=${metrics.range.to}`;
  assert.deepEqual(live(window), { jobs: total.jobs, pence: total.pence }, "the total");
  for (const figure of [...typed, metrics.other, metrics.unclassified]) {
    assert.deepEqual(
      live(`${window}&type=${encodeURIComponent(figure.drillType)}`),
      { jobs: figure.jobs, pence: figure.pence },
      figure.key,
    );
  }
});

test("the live export names each job's type in words", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const response = await fetch(`${BASE}/api/reports/metrics?format=csv&from=2025-09-01&to=2026-09-11`, { headers });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"Completed","Reference","Job","Site","Job type","Issue category","Contractor","Cost \(GBP\)","Repeat"/);
  assert.match(body, /"Key figures","Unclassified",/, "and the summary carries the two buckets no card draws");
  assert.match(body, /"Key figures","Other",/);
  /* Parsed rather than split on `","`: a job title can hold a quote or a
     comma, and `csvCell` escapes both — a naive split would read the wrong
     column and call a real file broken. */
  const cells = (line) => {
    const out = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char !== '"') value += char;
        else if (line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === ",") {
        out.push(value);
        value = "";
      } else value += char;
    }
    out.push(value);
    return out;
  };
  const rows = body.split("\r\n");
  const header = rows.findIndex((line) => line.includes('"Job type"'));
  assert.ok(header > 0, "the cost lines follow the header");
  const known = new Set(["Unclassified", "Other"]);
  const configured = await fetch(`${BASE}/api/job-types`, { headers });
  if (configured.ok) for (const type of (await configured.json()).jobTypes ?? []) known.add(type.label);
  for (const line of rows.slice(header + 1).filter(Boolean)) {
    const type = cells(line)[4];
    assert.ok(type && known.has(type), `every cost line names a type this workspace holds: ${type} in ${line}`);
  }
});
