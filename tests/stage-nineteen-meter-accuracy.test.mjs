import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The meter maths is deliberately a plain TypeScript module with no React in
 * it, so the numbers on the six cards can be asserted against rows instead of
 * eyeballed on the page. Transpiling it here is what buys that: these are real
 * calls into the shipped code, not a re-implementation of it that could agree
 * with itself while the board is wrong.
 */
const meters = await (async () => {
  const source = await read("app/(app)/portal/dashboard-meters.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
})();

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

let sequence = 0;
function row(overrides = {}) {
  sequence += 1;
  return {
    id: `T-${sequence}`,
    source: "Portal form",
    title: `Job ${sequence}`,
    description: "",
    location: "Bristol Cabot Circus",
    siteId: "store-bristol",
    requester: "Manager",
    contact: "",
    category: "Other",
    engineer: "Handyman",
    tier: 2,
    priority: "Medium",
    stage: "Incoming",
    status: "Pending Scheduling",
    contractor: null,
    assignee: null,
    requestedAt: new Date(NOW - DAY).toISOString(),
    dueAt: null,
    completedAt: null,
    nextUpdateAt: null,
    cost: null,
    attachmentCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

const compute = (rows, period = "90") =>
  meters.computeJobMeters(rows, period, NOW);

test("every status a meter names is a real monday label", async () => {
  // The whole point of naming labels instead of sniffing substrings is lost if
  // a meter names one monday does not have — it would silently count nothing
  // and nobody would see it. The capture is the ground truth.
  // The capture is prose wrapped at 79 columns, so a label can straddle a line
  // break — flatten the whitespace before looking for it.
  const capture = (
    await read("db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md")
  ).replace(/\s+/g, " ");
  assert.equal(
    meters.maintenanceStatusLabels.length,
    23,
    "monday's Status column has 23 labels",
  );
  for (const label of meters.maintenanceStatusLabels) {
    assert.ok(capture.includes(label), `${label} is not in the monday capture`);
  }
  const vocabulary = new Set(meters.maintenanceStatusLabels);
  for (const label of [
    ...meters.awaitingPartsStatuses,
    ...meters.awaitingApprovalStatuses,
    ...meters.completedStatuses,
  ]) {
    assert.ok(vocabulary.has(label), `${label} is not a monday Status label`);
  }
});

test('"Awaiting parts" counts parts, not "Third Party Delay"', () => {
  // The regression this file exists for. `status.includes("part")` matches
  // "Third Party Delay" on par-t-y, and on the live board that false positive
  // *was* the meter: it read 2 while nothing was waiting for a part.
  const rows = [
    row({ status: "Third Party Delay" }),
    row({ status: "Third Party Delay" }),
    row({ status: "Waiting for parts" }),
  ];
  assert.equal(compute(rows).parts.count, 1);
  assert.equal(
    rows.filter((r) => r.status.toLowerCase().includes("part")).length,
    3,
    "the old substring test really did match all three — this is not a straw man",
  );
  // Only one of monday's 23 labels is about a part.
  assert.deepEqual([...meters.awaitingPartsStatuses], ["Waiting for parts"]);
});

test('"Awaiting approval" counts sign-off, and says which labels', () => {
  const counted = [
    "Pending Approval",
    "Awaiting Landlord Approval",
    "Quote Received (waiting for Approval)",
  ];
  const notCounted = [
    "Quote requested", // waiting on the contractor, not on a signature
    "Waiting for decisions", // a scope decision is not a sign-off
    "Quote approved", // already decided
    "Quote rejected",
  ];
  assert.deepEqual([...meters.awaitingApprovalStatuses], counted);
  assert.equal(
    compute(counted.map((status) => row({ status }))).approval.count,
    3,
    "all three sign-off labels count",
  );
  assert.equal(
    compute(notCounted.map((status) => row({ status }))).approval.count,
    0,
    "nothing else does",
  );
  // On today's vocabulary the old `includes("approval")` happened to select the
  // same three labels, so this meter's *number* did not change — what changed
  // is that the three are now a decision on the record instead of an accident
  // of spelling. The next label monday gains cannot join the meter by
  // containing the word: prove that by checking the set is closed.
  const accidental = meters.maintenanceStatusLabels.filter((label) =>
    label.toLowerCase().includes("approval"),
  );
  assert.deepEqual(accidental, counted, "the accident and the decision agree today");
  assert.equal(
    compute([row({ status: "Quote approved" })]).approval.count,
    0,
    '"Quote approved" is a decision already taken',
  );
});

test("a status is matched whole, and survives an import's stray whitespace", () => {
  // Monday round-trips labels through CSV and forms; casing and doubled spaces
  // are accidents, not different statuses.
  const rows = [
    row({ status: "  waiting  for   parts " }),
    row({ status: "WAITING FOR PARTS" }),
    row({ status: "Waiting for parts and labour" }),
  ];
  assert.equal(compute(rows).parts.count, 2, "two are the label; one is not");
});

test("open and closed partition the rows in view", () => {
  // The meters sit above the table, which prints "Showing N". If open + closed
  // is ever anything but N, one of the two is lying about the same rows.
  const rows = [
    row({ stage: "Incoming", status: "Pending Approval" }),
    row({ stage: "Booked", status: "Job Scheduled" }),
    row({ stage: "Attention", status: "Escalated" }),
    row({ stage: "Completed", status: "Job Completed" }),
    row({ stage: "Incoming", status: "Job Completed" }),
  ];
  const result = compute(rows);
  assert.equal(result.open.count + result.closed.count, rows.length);
  assert.equal(compute([]).open.count + compute([]).closed.count, 0);
});

test('a job whose status is "Job Completed" is not open work', () => {
  // Monday flags exactly one Status label as done. The import files those rows
  // in groups that carry no lifecycle stage, so `stage` stays "Incoming" — a
  // stage-only test reported 28 finished jobs as open on the live board.
  const rows = [
    row({ stage: "Incoming", status: "Job Completed" }),
    row({ stage: "Incoming", status: "Job In Progress" }),
  ];
  const result = compute(rows);
  assert.equal(result.open.count, 1);
  assert.equal(result.closed.count, 1);
  // And a finished job is never counted as blocked on anything.
  const blocked = [
    row({ stage: "Incoming", status: "Waiting for parts" }),
    row({ stage: "Completed", status: "Waiting for parts" }),
  ];
  assert.equal(compute(blocked).parts.count, 1);
});

test('"P1 critical" is the union it claims, and only over open work', () => {
  const rows = [
    row({ priority: "Urgent", tier: 3 }),
    row({ priority: "Low", tier: 1 }),
    row({ priority: "Medium", tier: 2 }),
    row({ priority: "Urgent", tier: 1, stage: "Completed" }),
  ];
  assert.equal(compute(rows).critical.count, 2);
});

test("every meter's number and its sparkline come from one predicate", () => {
  // They used to be written out twice, and had already drifted: the value
  // counted open rows while the sparkline counted closed ones too.
  const rows = [
    row({ priority: "Urgent", requestedAt: new Date(NOW - 3 * DAY).toISOString() }),
    row({ status: "Waiting for parts", requestedAt: new Date(NOW - 20 * DAY).toISOString() }),
    row({ status: "Pending Approval", requestedAt: new Date(NOW - 60 * DAY).toISOString() }),
    row({
      stage: "Completed",
      status: "Job Completed",
      requestedAt: new Date(NOW - 70 * DAY).toISOString(),
      completedAt: new Date(NOW - 2 * DAY).toISOString(),
    }),
  ];
  const result = compute(rows);
  for (const key of ["open", "critical", "parts", "approval", "closed"]) {
    const sum = result[key].trend.reduce((total, value) => total + value, 0);
    assert.equal(
      sum,
      result[key].count,
      `${key}: the sparkline totals ${sum} but the card reads ${result[key].count}`,
    );
    assert.equal(result[key].trend.length, meters.meterTrendBuckets);
  }
});

test("the trend spans the selected period, not a fixed twelve weeks", () => {
  // Old code: 12 buckets of 7 days, whatever the period. On "Last 30 days"
  // eight of them were empty by construction and every card drew the same
  // flat-then-cliff shape — the period filter read as a surge in work.
  const rows = [
    row({ requestedAt: new Date(NOW - 29 * DAY).toISOString() }),
    row({ requestedAt: new Date(NOW - 1 * DAY).toISOString() }),
  ];
  const thirty = compute(rows, "30").open.trend;
  assert.equal(thirty[0], 1, "the oldest row starts the window");
  assert.equal(thirty.at(-1), 1, "the newest row ends it");
  assert.equal(
    thirty.filter((value) => value === 0).length,
    meters.meterTrendBuckets - 2,
    "nothing in between",
  );

  // "All records" has no lower bound, so the window opens at the oldest row.
  const wide = compute(
    [
      row({ requestedAt: new Date(NOW - 900 * DAY).toISOString() }),
      row({ requestedAt: new Date(NOW - 1 * DAY).toISOString() }),
    ],
    "all",
  ).open.trend;
  assert.equal(wide[0], 1);
  assert.equal(wide.at(-1), 1);
});

test("the closures sparkline is placed by when jobs closed", () => {
  // A line under "Closed" that buckets by the date the job was *raised*
  // answers a question nobody asked.
  const rows = [
    row({
      stage: "Completed",
      status: "Job Completed",
      requestedAt: new Date(NOW - 88 * DAY).toISOString(),
      completedAt: new Date(NOW - 1 * DAY).toISOString(),
    }),
  ];
  const result = compute(rows, "90");
  assert.equal(result.closed.trend.at(-1), 1, "closed yesterday, plotted at the end");
  assert.equal(result.closed.trend[0], 0);
});

test("Avg SLA target averages the board's own due dates", () => {
  // It used to average a hard-coded table — { Urgent: 4, High: 24, Medium: 72,
  // Low: 120 } — that was not derived from the board at all. monday's Priority
  // column has no "High", so that row could never match, and it reported
  // 36.0 hrs while the due dates on the same rows averaged 243.9.
  const rows = [
    row({
      priority: "Urgent",
      requestedAt: new Date(NOW - 10 * DAY).toISOString(),
      dueAt: new Date(NOW - 10 * DAY + 10 * HOUR).toISOString(),
    }),
    row({
      priority: "Urgent",
      requestedAt: new Date(NOW - 10 * DAY).toISOString(),
      dueAt: new Date(NOW - 10 * DAY + 20 * HOUR).toISOString(),
    }),
  ];
  const result = compute(rows);
  assert.equal(result.sla.averageHours, 15, "the mean of 10 and 20 hours");
  assert.equal(result.sla.sample, 2);
  // Priority is not consulted: two Urgent rows, and the answer is neither 4 nor
  // any other constant.
  assert.notEqual(result.sla.averageHours, 4);
});

test("rows with no due date are left out of the SLA mean, not counted as zero", () => {
  const rows = [
    row({
      requestedAt: new Date(NOW - DAY).toISOString(),
      dueAt: new Date(NOW - DAY + 24 * HOUR).toISOString(),
    }),
    row({ dueAt: null }),
    row({ dueAt: null }),
  ];
  const result = compute(rows);
  assert.equal(result.sla.averageHours, 24);
  assert.equal(result.sla.sample, 1);
  // With nothing to average the card shows a dash rather than "0.0 hrs", which
  // would read as "we answer everything instantly".
  const empty = compute([row({ dueAt: null })]);
  assert.equal(empty.sla.averageHours, null);
  assert.equal(empty.sla.sample, 0);
});

test("an empty board reads zero, never a fallback", () => {
  const result = compute([]);
  for (const key of ["open", "critical", "parts", "approval", "closed"]) {
    assert.equal(result[key].count, 0);
    assert.deepEqual(
      result[key].trend,
      new Array(meters.meterTrendBuckets).fill(0),
    );
  }
  assert.equal(result.sla.averageHours, null);
});

test("the period window is defined once for the rows and the meters", async () => {
  // If the filter and the buckets disagree about where the period ends, the
  // sparkline plots a different set of rows from the number above it.
  //
  // The one place that definition lives moved in Stage 23, when the owner asked
  // the Spend and reporting screen for a named month, a quarter, a single date
  // and a custom range: the window maths is now period-model.ts, and BOTH the
  // row filter and this file's `analyticsWindow` delegate to it. That is the
  // same invariant this test has always guarded — one definition — asserted at
  // its new address. tests/stage-twentythree-period.test.mjs asserts token by
  // token that the legacy vocabulary resolves to the identical window.
  const analytics = await read("app/(app)/portal/dashboard-analytics.tsx");
  assert.match(analytics, /import \{ stampWithinPeriod \} from "\.\/period-model"/);
  assert.match(
    analytics,
    /function withinAnalyticsPeriod[\s\S]{0,320}stampWithinPeriod\(value, period, now\)/,
  );
  // …and period-model calls `analyticsWindow` for the rolling windows rather
  // than writing them out a second time. This file stays free of imports, which
  // is what lets the loader at the top of this test transpile it on its own.
  const model = await read("app/(app)/portal/period-model.ts");
  assert.match(model, /import \{ analyticsWindow \} from "\.\/dashboard-meters"/);
  assert.match(model, /const \{ start, end \} = analyticsWindow\(token, now\)/);
  assert.doesNotMatch(
    await read("app/(app)/portal/dashboard-meters.ts"),
    /^import (?!type )/m,
    "the meter maths must stay loadable on its own",
  );

  const window = meters.analyticsWindow("30", NOW);
  assert.equal(window.start, NOW - 30 * DAY);
  assert.equal(window.end, NOW + DAY, "the one-day grace for future-dated rows");
  assert.equal(meters.analyticsWindow("all", NOW).start, Number.NEGATIVE_INFINITY);
  assert.equal(
    meters.analyticsWindow("all", NOW).end,
    NOW + DAY,
    "the meters divide by (end - start); an unbounded end collapses every bucket onto the first",
  );
});

test("the board's meters read the rows the board is drawing", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  /*
   * `visibleRows` is the table's own row set: `filtered` (search, priority and
   * assignee) with the structured column filters applied on top — Batch 1A
   * added the second stage, and the meters have to read the LAST one or they
   * describe rows the table is not drawing. `scopedRequests` is portfolio and
   * period only, which is what left all six numbers frozen while the filters
   * emptied the table underneath them.
   */
  assert.match(
    board,
    /computeJobMeters\(visibleRows, analyticsPeriod, analyticsNow\)/,
    "the meters must be computed from the rows the grid draws",
  );
  assert.match(
    board,
    /applyBoardFilter\(filtered, filterState, filterContext\)/,
    "and those rows must be the filtered ones",
  );
  assert.doesNotMatch(
    board,
    /computeJobMeters\(scopedRequests/,
    "the unfiltered scope is not what the table shows",
  );
});

test("no meter sniffs a status for a substring any more", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.doesNotMatch(board, /status\.toLowerCase\(\)\.includes\(/);
  assert.doesNotMatch(board, /responseTargets/, "the invented SLA table is gone");
  // And each card's small print says what that card counts.
  assert.match(board, /label="P1 critical"[\s\S]{0,80}detail="Urgent or Tier 1"/);
  assert.match(board, /label="Awaiting approval"[\s\S]{0,80}detail="Sign-off required"/);
  // A mean is only as good as its sample, and this one's is thin — the monday
  // export arrived with one due date across 745 rows. The card has to print
  // the sample, or a single row reads as a portfolio-wide fact. It also has to
  // fit: the detail line ellipsises past about 22 characters, and a caveat
  // rendered as "Request-to-due · 0 of …" is no caveat at all.
  assert.match(
    board,
    /label="Avg SLA target"[\s\S]{0,220}detail=\{`Mean of \$\{jobAnalytics\.sla\.sample\} due dates`\}/,
  );
});

test("a sparkline never draws a series it was not given", async () => {
  // The fallback used to be [3, 5, 4, 7, 5, 8, 6, 9, 7, 10, 8, 12] — an
  // invented rising line, which is the one shape a reader acts on.
  const analytics = await read("app/(app)/portal/dashboard-analytics.tsx");
  // (The old array survives inside the comment that explains why it went; what
  // must not survive is a declaration binding it to a name.)
  assert.doesNotMatch(analytics, /const \w+ = \[3, 5, 4, 7, 5, 8, 6, 9, 7, 10, 8, 12\]/);
  assert.match(analytics, /const emptySpark = new Array<number>\(meterTrendBuckets\)\.fill\(0\)/);
});

test("each sparkline carries what it plots, and admits it is not a history", () => {
  // Nothing records what a job's status was last week, so no meter's value can
  // be plotted over time. Every label has to say so rather than let the shape
  // imply it.
  const labels = Object.values(meters.jobMeterTrendLabels);
  assert.equal(labels.length, 6, "one per card");
  for (const label of labels) {
    assert.match(label, /across the selected period/);
  }
  for (const key of ["open", "critical", "parts", "approval"]) {
    assert.match(
      meters.jobMeterTrendLabels[key],
      /Not a history/,
      `${key} must not let its line read as a trend line`,
    );
  }
});

test("the meter maths stays React-free so it can be tested at all", async () => {
  const source = await read("app/(app)/portal/dashboard-meters.ts");
  assert.doesNotMatch(source, /use[A-Z]\w*\(/, "no hooks");
  assert.doesNotMatch(source, /"use client"/);
  assert.doesNotMatch(source, /from "react"/);
  // Nothing here may reach for the clock: `now` is a parameter, so a test and
  // a render see the same buckets.
  assert.doesNotMatch(source, /Date\.now\(\)/);
});

test("the meters hold up on a row of every monday status", () => {
  // One row per label, all open, so each meter's share of the 23 is explicit
  // and a new monday label cannot quietly join a meter.
  const rows = meters.maintenanceStatusLabels.map((status) =>
    row({ status, stage: "Incoming", priority: "Medium", tier: 2 }),
  );
  const result = compute(rows);
  assert.equal(result.closed.count, 1, 'only "Job Completed" is done');
  assert.equal(result.open.count, 22);
  assert.equal(result.parts.count, 1);
  assert.equal(result.approval.count, 3);
  assert.equal(result.critical.count, 0, "no Urgent and no Tier 1 in the set");
});
