/**
 * The dashboard block's metrics — §5 and §9 of the Overview Dashboard brief.
 *
 * Three layers, because three different things can go wrong:
 *
 *   1. `reconcile()` is pure, so it is TRANSPILED AND CALLED with fixtures.
 *      A re-implementation of the rules in a test would agree with itself
 *      while the product disagreed, which is the failure this whole file
 *      exists to catch, so the shipped function is the one under test.
 *   2. The SQL is pinned by source, because the brief's instruction was to
 *      REUSE existing definitions rather than write new ones, and "did you
 *      reuse it" is a question about the source rather than about a number.
 *   3. The identities are then checked against the LIVE endpoint, which is the
 *      only place the SQL and the arithmetic meet real rows. Those tests skip
 *      without a dev server, as ~32 files in this suite already do.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const ts = (await import("typescript")).default;

/**
 * `reconcile` alone, lifted out of a module that reaches drizzle.
 *
 * `overview-metrics.ts` imports `db/schema`, which native ESM cannot resolve
 * (no file extension) and which a `data:` URL cannot resolve either (a bare
 * `drizzle-orm` specifier). The function under test is pure and sits at the
 * bottom of the file, so the slice from its docblock to the end transpiles and
 * runs on its own — the same trick `module-five-finance-analytics` uses.
 */
const metricsSource = await read("app/lib/overview-metrics.ts");
const sliceFrom = metricsSource.indexOf("/* ── Reconciliation, asserted rather than assumed");
assert.ok(sliceFrom > 0, "the reconciliation section is still where the test slices it");
const { reconcile } = await import(
  `data:text/javascript,${encodeURIComponent(
    ts.transpileModule(metricsSource.slice(sliceFrom), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )}`
);

/** A metrics payload with known answers, adjustable per case. */
const build = (over = {}) => ({
  openJobs: 10,
  jobsByStatus: [
    { key: "Open", label: "Open", value: 6, colour: "#46A2AD", labels: ["Open"] },
    { key: "In progress", label: "In progress", value: 4, colour: "#D8652B", labels: ["In progress"] },
  ],
  priority: [
    { key: "urgent", label: "High", value: 3, colour: "#D34E49", labels: ["urgent"] },
    { key: "medium", label: "Medium", value: 5, colour: "#E3A140", labels: ["medium"] },
    { key: "low", label: "Low", value: 2, colour: "#5E697E", labels: ["low"] },
  ],
  categories: [
    { key: "Electrical", label: "Electrical", value: 7, colour: "#46A2AD", labels: ["Electrical"] },
    { key: "__unassigned__", label: "Unassigned", value: 3, colour: "#5E697E", labels: ["__not_recorded__"] },
  ],
  sla: { percent: 80, open: 10, overdue: 2, withinSla: 8 },
  compliance: { percent: 21, satisfied: 73, applicable: 355, notRequired: 0, scored: true },
  kpis: [{ key: "compliance", label: "Compliance", value: 21, isPercent: true, spark: null }],
  ...over,
});

test("a consistent payload satisfies every §5.3 rule", () => {
  assert.deepEqual(reconcile(build()), []);
});

test("each reconciliation rule fails on its own, and says which", () => {
  /*
   * Asserted one at a time rather than as "something is wrong", because a
   * single catch-all check passes the day two rules break in opposite
   * directions and cancel out.
   */
  const statuses = reconcile(build({
    jobsByStatus: [{ key: "Open", label: "Open", value: 9, colour: "#46A2AD", labels: ["Open"] }],
  }));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /jobs by status 9 != open 10/);

  const priority = reconcile(build({
    priority: [{ key: "urgent", label: "High", value: 1, colour: "#D34E49", labels: ["urgent"] }],
  }));
  assert.match(priority[0], /priority rings 1 != open 10/);

  const categories = reconcile(build({
    categories: [{ key: "Electrical", label: "Electrical", value: 4, colour: "#46A2AD", labels: ["Electrical"] }],
  }));
  assert.match(categories[0], /categories 4 != open 10/);

  /* Overdue may equal Open — every open job can be late — but never exceed it. */
  const overdue = reconcile(build({ sla: { percent: 0, open: 10, overdue: 11, withinSla: 0 } }));
  assert.ok(overdue.some((line) => /overdue 11 > open 10/.test(line)));

  const sla = reconcile(build({ sla: { percent: 99, open: 10, overdue: 2, withinSla: 8 } }));
  assert.ok(sla.some((line) => /sla 99% != 80%/.test(line)));

  /* The KPI and the gauge are the same fact drawn twice; they may not differ. */
  const compliance = reconcile(build({
    kpis: [{ key: "compliance", label: "Compliance", value: 92, isPercent: true, spark: null }],
  }));
  assert.ok(compliance.some((line) => /compliance KPI 92% != gauge 21%/.test(line)));
});

test("an empty estate reconciles at zero rather than dividing by it", () => {
  /*
   * §5.2: "Division by zero → show 0 / 0%, never NaN, never blank." A brand
   * new workspace hits this on its first load, which is the worst possible
   * moment for a dashboard to render `NaN%`.
   */
  const empty = reconcile({
    openJobs: 0,
    jobsByStatus: [],
    priority: [],
    categories: [],
    sla: { percent: 0, open: 0, overdue: 0, withinSla: 0 },
    compliance: { percent: 0, satisfied: 0, applicable: 0, notRequired: 0, scored: false },
    kpis: [{ key: "compliance", label: "Compliance", value: 0, isPercent: true, spark: null }],
  });
  assert.deepEqual(empty, []);
});

test("jobs with no priority and no category still reconcile", () => {
  /*
   * The two buckets that exist precisely so the totals hold: a job nobody has
   * triaged, and a job nobody has categorised. If either were dropped the
   * rings would sum to less than the KPI above them.
   */
  const untriaged = build({
    openJobs: 4,
    jobsByStatus: [{ key: "Open", label: "Open", value: 4, colour: "#46A2AD", labels: ["Open"] }],
    priority: [
      { key: "urgent", label: "High", value: 1, colour: "#D34E49", labels: ["urgent"] },
      { key: "not_recorded", label: "Unset", value: 3, colour: "#5E697E", labels: ["not_recorded"] },
    ],
    categories: [
      { key: "__unassigned__", label: "Unassigned", value: 4, colour: "#5E697E", labels: ["__not_recorded__"] },
    ],
    sla: { percent: 100, open: 4, overdue: 0, withinSla: 4 },
  });
  assert.deepEqual(reconcile(untriaged), []);
});

/* ── What the brief asked to be REUSED rather than reinvented ─────────────── */

test("the metrics reuse the product's existing definitions", async () => {
  const source = metricsSource;

  /* Open/closed is the CONFIGURABLE category, not a hardcoded status list. */
  assert.match(source, /jobStatusMap\.countsAsOpen/, "open/closed comes from job_status_map");
  assert.match(source, /not \$\{closedJobSql\}/, "and the closure test is the shared one");

  /* Overdue is the same expression the board and the ageing card use. */
  assert.match(source, /overdueOpenSql\(now\)/);

  /*
   * A job counts as work at all by the same exclusions as everywhere.
   *
   * RE-POINTED: the block's scope used to RESTATE the three exclusions, and a
   * restatement is how a fourth gets added in one place and missed in the other
   * — which is what happened: a Store Documentation store is not a job, and the
   * block counted 16 of them as open. It now IS `liveWorkOrderCondition`, so the
   * exclusions are asserted where they live, all four of them.
   */
  assert.match(source, /const base = liveWorkOrderCondition\(orgId\);/);
  const filters = await read("app/lib/dashboard-filters.ts");
  const rule = filters.slice(filters.indexOf("export function liveWorkOrderCondition")).slice(0, 400);
  assert.match(rule, /isNull\(maintenanceRequests\.deletedAt\)/);
  assert.match(rule, /eq\(maintenanceRequests\.archived, false\)/);
  assert.match(rule, /isNull\(maintenanceRequests\.parentId\)/);
  assert.match(rule, /jobsBoardCondition\(\)/);

  /* Priority folds through the one classifier. */
  assert.match(source, /normalisePriority\(row\.priority\)/);

  /*
   * COMPLIANCE IS THE SHIPPED RULE, and this is the pin that matters most.
   *
   * `complianceCompletion` excludes "Not required" from its denominator, and
   * its own comment records that an earlier brief asked for the other
   * arrangement and it was refused because it inflates — near 70% against near
   * 25% on this estate. The owner chose the shipped rule again for this block,
   * so the gauge reads low and reads the same as the Compliance page and the
   * nightly digest. A future change that quietly swaps the formula would move
   * the number on four screens at once; this stops it doing so silently.
   */
  assert.match(source, /readComplianceRegister\(db, orgId/);
  assert.match(source, /complianceCompletion\(scorable\)/);
  /*
   * RE-POINTED: "Not required" is still out of the fraction on both sides, but
   * the exclusion is `complianceCompletion`'s own — the list is no longer
   * pre-filtered, which is what made the export's "not required" row read 0.
   * The rule is asserted where it lives, so the pin still fails the day
   * somebody counts those records as satisfied.
   */
  const status = await read("app/lib/compliance-status.ts");
  assert.match(status, /const applicable = total - notRequired - excluded;/);
  assert.doesNotMatch(source, /entry\.state !== "Not required" && \(!allowed/,
    "the pre-filter that zeroed notRequired is gone");
});

test("the metrics SQL obeys the dual-dialect rules", async () => {
  const source = metricsSource;
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const banned of [
    /julianday\(/, /strftime\(/, /unixepoch\(/, /json_extract\(/,
    /printf\(/, /\bGLOB\b/, /\browid\b/, /\bover\s*\(\s*partition\b/i,
  ]) {
    assert.doesNotMatch(code, banned, `banned SQL construct reached the metrics: ${banned}`);
  }

  /*
   * Every date-ish column goes through `dateText` before any text operation.
   * `due_at` and `completed_at` are real Postgres `date` columns on
   * Production and `text` on Staging, so `substr()` on a raw one throws 42883
   * in Production and passes every local run — the exact shape of the outage
   * `dashboard-aggregates.ts` documents.
   */
  const substrCalls = code.match(/substr\(\s*\$\{[^}]*\}/g) ?? [];
  for (const call of substrCalls) {
    assert.match(call, /dateText|dayOnly/, `substr on an uncast column: ${call}`);
  }
});

/* ── Against real rows ────────────────────────────────────────────────────── */

const BASE = "http://localhost:5173";
const IDENTITY = "admin@sunnamusk-uk.test.maintsupp.com";

async function metrics(query = "") {
  const response = await fetch(`${BASE}/api/overview/metrics${query}`, {
    headers: { "x-maintsupp-identity": IDENTITY, Accept: "application/json" },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, {
      headers: { "x-maintsupp-identity": IDENTITY },
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("every §5.3 rule holds against the real estate", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const { status, body } = await metrics();
  assert.equal(status, 200);

  /*
   * The route runs `reconcile` itself and returns what it found, so this
   * asserts on the SHIPPED answer rather than re-deriving one. An empty array
   * is the whole contract.
   */
  assert.deepEqual(body.reconciliation, [], "the live payload reconciles");

  /* And again from the outside, in case the route ever stops calling it. */
  assert.deepEqual(reconcile(body), []);

  const open = body.kpis.find((kpi) => kpi.key === "openJobs");
  assert.equal(open.value, body.openJobs, "the KPI and the figure the rings share are one number");
  assert.ok(body.sla.overdue <= body.openJobs);
});

test("the sparklines end where their KPI says they do", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const { body } = await metrics();

  for (const key of ["openJobs", "overdue"]) {
    const kpi = body.kpis.find((entry) => entry.key === key);
    assert.ok(Array.isArray(kpi.spark) && kpi.spark.length > 0, `${key} has a series`);
    assert.equal(
      kpi.spark[kpi.spark.length - 1].value,
      kpi.value,
      `${key}: the line's last point is the number printed above it`,
    );
  }

  /*
   * AND THE TWO THAT HAVE NO HISTORY CARRY NONE.
   *
   * Nothing records what "Active units" or "Compliance" was on a past date and
   * there is no snapshot table, so a line drawn for either would be invented.
   * The owner chose to omit the sparkline on those two cards rather than draw
   * a flat one, and `null` is how that choice reaches the component.
   */
  for (const key of ["activeUnits", "compliance"]) {
    const kpi = body.kpis.find((entry) => entry.key === key);
    assert.equal(kpi.spark, null, `${key} states that it has no history`);
  }
});

test("a portfolio narrows every figure, and an unknown one is ignored", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const all = (await metrics()).body;
  assert.ok(all.portfolios.length > 0, "the estate has at least one portfolio to filter by");

  const first = all.portfolios[0];
  const scoped = (await metrics(`?portfolio=${encodeURIComponent(first.id)}`)).body;
  assert.equal(scoped.portfolio.id, first.id);
  assert.ok(scoped.openJobs <= all.openJobs, "a portfolio can only ever narrow the estate");
  assert.deepEqual(scoped.reconciliation, [], "and it still reconciles once narrowed");

  /* An id nobody holds must fall back to the whole estate rather than to an
     empty page that looks like a workspace with no work in it. */
  const nonsense = (await metrics("?portfolio=not-a-real-group")).body;
  assert.equal(nonsense.portfolio.id, "all");
  assert.equal(nonsense.openJobs, all.openJobs);
});

test("changing a job moves the donut, the rings, the gauge and the KPIs", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  /*
   * §9.3. The point is not that one number changes — it is that all four
   * widgets move TOGETHER and still reconcile afterwards, because they are
   * meant to be one count sliced four ways rather than four counts.
   */
  const before = (await metrics()).body;
  const board = await fetch(`${BASE}/api/maintenance?limit=200`, {
    headers: { "x-maintsupp-identity": IDENTITY, Accept: "application/json" },
  });
  const rows = (await board.json().catch(() => null))?.requests ?? [];
  /*
   * A JOB, on the Jobs board. The feed carries every board's rows, and the
   * newest one on the development estate is a section's "New store" fixture —
   * picking it meant this test patched a row the metrics never counted, got a
   * 400 and skipped every run. `boardId` is how the feed says where a row lives.
   */
  const openRow = rows.find(
    (row) =>
      (!row.boardId || row.boardId === "maintenance") &&
      !row.archived &&
      !row.parentId &&
      row.stage !== "Completed" &&
      row.priority &&
      String(row.priority).trim().toLowerCase() !== "urgent",
  );
  if (!openRow) {
    t.skip("no suitable open job to move");
    return;
  }

  const originalPriority = openRow.priority;
  const patch = async (priority) =>
    fetch(`${BASE}/api/maintenance`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-maintsupp-identity": IDENTITY,
      },
      /* `fields`, the route's contract — `data` was refused with a 400 and the
         test skipped itself on every run. */
      body: JSON.stringify({ id: openRow.id, fields: { priority } }),
    });

  const moved = await patch("Urgent");
  if (!moved.ok) {
    t.skip(`could not move the fixture job: ${moved.status}`);
    return;
  }
  try {
    const after = (await metrics()).body;
    const high = (payload) => payload.priority.find((slice) => slice.key === "urgent")?.value ?? 0;
    assert.equal(high(after), high(before) + 1, "the High ring gained the job");
    assert.deepEqual(after.reconciliation, [], "and everything still adds up afterwards");
    assert.equal(
      after.priority.reduce((sum, slice) => sum + slice.value, 0),
      after.openJobs,
      "the rings still total Open jobs",
    );
  } finally {
    await patch(originalPriority);
  }

  /* Put back, and prove it: a test that leaves the estate changed makes the
     next run of itself lie. */
  const restored = (await metrics()).body;
  assert.equal(
    restored.priority.find((slice) => slice.key === "urgent")?.value ?? 0,
    before.priority.find((slice) => slice.key === "urgent")?.value ?? 0,
    "the fixture job is back where it started",
  );
});
