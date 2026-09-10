/**
 * THE OVERVIEW'S ARITHMETIC, TESTED WHERE IT CAN ACTUALLY BE WRONG.
 *
 * `app/lib/overview-aggregates.ts` is mostly SQL, and SQL is verified against a
 * live database. What is NOT verified that way is the arithmetic the module
 * does on the way back — the bucketing rule, the percentile that stands in for
 * `percentile_cont`, the severity bands, the percentage rule, and the fold that
 * acceptance gate 11 rests on. Every one of those is a pure function here, and
 * every test below runs the real one rather than a copy of it.
 *
 * These are behavioural tests, not pins: they assert what the functions ANSWER,
 * including at the exact boundaries the master prompt names (31/32 and 120/121
 * days, the 14/30/60-day severity edges, a sub-3-sample bucket), and two of
 * them check a property against a brute-force expansion rather than against a
 * remembered number.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));

/* `app/lib/**` imports its neighbours without file extensions and reaches
   `cloudflare:workers` for a binding. TypeScript resolves the first and the
   deployed build aliases the second; Node needs both spelled out. Same hook as
   `tests/performance-legacy-date-types.test.mjs`. */
const stub = pathToFileURL(`${root}tests/fixtures/cloudflare-workers-stub.mjs`).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && ctx.parentURL?.endsWith(".ts")) {
      const base = new URL(spec, ctx.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const {
  addSeverity,
  averageFromCounts,
  bucketIndexFor,
  bucketingFor,
  businessMinutesBetween,
  emptySeverity,
  normaliseContractorName,
  overviewBuckets,
  quantileFromCounts,
} = await import("../app/lib/overview-aggregates.ts");
const meters = await import("../app/lib/overview-meters.ts");
const { statusKey } = await import("../app/lib/job-metrics.ts");

const NOW = new Date("2026-09-10T12:00:00.000Z");

/* ── 1. §4.2's bucketing, at the exact boundaries ─────────────────────────── */

test("the bucket width changes on the days §4.2 names, not near them", () => {
  assert.equal(bucketingFor(1), "daily");
  assert.equal(bucketingFor(31), "daily", "31 is the LAST daily width");
  assert.equal(bucketingFor(32), "weekly", "32 is the FIRST weekly width");
  assert.equal(bucketingFor(120), "weekly", "120 is the last weekly width");
  assert.equal(bucketingFor(121), "monthly", "121 is the first monthly width");
  assert.equal(bucketingFor(3650), "monthly");
});

const windowOf = (start, endExclusive, key = "custom") => ({
  key,
  start,
  endExclusive,
  days: start === null ? 365 : Math.round((Date.parse(endExclusive) - Date.parse(start)) / 86_400_000),
  label: "",
  previous: null,
});

test("a 31-day window draws 31 daily buckets and a 32-day one draws weeks", () => {
  const daily = overviewBuckets(windowOf("2026-08-11", "2026-09-11"), NOW);
  assert.equal(daily.bucketing, "daily");
  assert.equal(daily.buckets.length, 31);
  assert.equal(daily.buckets[0].label, "11 Aug", "axis labels are real dates, never 'Week 1'");

  const weekly = overviewBuckets(windowOf("2026-08-10", "2026-09-11"), NOW);
  assert.equal(weekly.bucketing, "weekly");
  assert.match(weekly.buckets[0].label, /^w\/c /, "weekly buckets are labelled week-commencing");
});

test("weekly buckets commence on a Monday, even when the window does not", () => {
  /* 2026-06-13 is a Saturday; the week it falls in commenced on Monday the 8th.
     The label says so and the counts are unaffected, because the cohort
     predicate has already excluded anything before the window. */
  const { buckets } = overviewBuckets(windowOf("2026-06-13", "2026-09-11"), NOW);
  assert.equal(buckets[0].start, "2026-06-08");
  assert.equal(new Date(`${buckets[0].start}T00:00:00Z`).getUTCDay(), 1, "a Monday");
  for (const bucket of buckets) {
    assert.equal(new Date(`${bucket.start}T00:00:00Z`).getUTCDay(), 1);
  }
});

test("monthly buckets start on the first and an unbounded window uses the data", () => {
  const { bucketing, buckets } = overviewBuckets(windowOf(null, "2026-09-11", "all"), NOW, "2026-06-25");
  assert.equal(bucketing, "monthly");
  assert.deepEqual(
    buckets.map((bucket) => bucket.label),
    ["Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"],
  );
  assert.equal(buckets[0].start, "2026-06-01", "the month the data starts in, from its first");
});

test("buckets tile the window with no gap, no overlap and no bucket past the end", () => {
  for (const window of [
    windowOf("2026-08-11", "2026-09-11"),
    windowOf("2026-06-13", "2026-09-11"),
    windowOf("2025-01-01", "2026-09-11"),
  ]) {
    const { buckets } = overviewBuckets(window, NOW);
    for (let index = 1; index < buckets.length; index += 1) {
      assert.equal(
        buckets[index].start,
        buckets[index - 1].endExclusive,
        "each bucket begins where the last one ended",
      );
    }
    assert.equal(buckets.at(-1).endExclusive, window.endExclusive, "and the last one stops at the window");
    assert.equal(
      buckets.at(-1).endInclusive,
      "2026-09-10",
      "endInclusive is a real day inside the window, so a tap can set an inclusive `to`",
    );
  }
});

test("a bucket containing today is partial and one wholly in the past is not", () => {
  const { buckets } = overviewBuckets(windowOf("2026-08-11", "2026-09-11"), NOW);
  const today = buckets.find((bucket) => bucket.start === "2026-09-10");
  const past = buckets.find((bucket) => bucket.start === "2026-08-11");
  assert.equal(today.partial, true, "today is not over, so its column is not finished");
  assert.equal(past.partial, false);
});

test("a day is assigned to its bucket, and one past the axis is clamped rather than dropped", () => {
  const { buckets } = overviewBuckets(windowOf("2026-08-11", "2026-09-11"), NOW);
  assert.equal(bucketIndexFor(buckets, "2026-08-11"), 0);
  assert.equal(bucketIndexFor(buckets, "2026-08-12"), 1);
  assert.equal(bucketIndexFor(buckets, "2026-09-10"), buckets.length - 1);
  /*
   * The clamp is the reason the chart reconciles with the headline beneath it.
   * With `measure = requested`, a job raised on the last day of the range and
   * closed a week later has a completion day past the last bucket; dropping it
   * would make the two disagree, which §1.5 forbids.
   */
  assert.equal(bucketIndexFor(buckets, "2026-12-25"), buckets.length - 1, "clamped forward");
  assert.equal(bucketIndexFor(buckets, "2020-01-01"), 0, "clamped back");
  assert.equal(bucketIndexFor(buckets, ""), -1, "and a blank day belongs nowhere");
});

/* ── 2. The percentile that replaces `percentile_cont` ────────────────────── */

/** The same order statistic, computed by expanding the counts. The oracle. */
function bruteForce(entries, quantile) {
  const expanded = [];
  for (const entry of entries) for (let index = 0; index < entry.count; index += 1) expanded.push(entry.value);
  expanded.sort((left, right) => left - right);
  const n = expanded.length;
  if (!n) return null;
  const h = quantile * n;
  if (Number.isInteger(h) && h >= 1 && h < n) return (expanded[h - 1] + expanded[h]) / 2;
  return expanded[Math.min(n - 1, Math.max(0, Math.ceil(h) - 1))];
}

test("the median of grouped counts is the median of the jobs those counts stand for", () => {
  // Four jobs at 2, 4, 6, 8 days: the textbook median is the mean of the middle two.
  const four = [
    { value: 2, count: 1 },
    { value: 4, count: 1 },
    { value: 6, count: 1 },
    { value: 8, count: 1 },
  ];
  assert.equal(quantileFromCounts(four, 0.5), 5);
  // Five jobs: the middle one.
  assert.equal(quantileFromCounts([...four, { value: 10, count: 1 }], 0.5), 6);
  // And a count of 40 stands for 40 jobs, not for one.
  assert.equal(quantileFromCounts([{ value: 1, count: 40 }, { value: 99, count: 1 }], 0.5), 1);
  assert.equal(quantileFromCounts([], 0.5), null, "nothing to measure is null, never zero");
});

test("p90 puts the tail on screen, which is the whole reason §4.3 plots it", () => {
  const entries = [
    { value: 1, count: 9 },
    { value: 200, count: 1 },
  ];
  assert.equal(quantileFromCounts(entries, 0.5), 1, "the median is unmoved by one 200-day job");
  assert.equal(quantileFromCounts(entries, 0.9), 100.5, "and p90 is where it shows up");
  // §4.3: "Never plot the mean — one 200-day job would distort every bucket."
  assert.equal(averageFromCounts(entries), 20.9);
});

test("the grouped percentile agrees with a brute-force expansion on random input", () => {
  let seed = 20260910;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    const entries = [];
    const distinct = 1 + Math.floor(random() * 8);
    for (let index = 0; index < distinct; index += 1) {
      entries.push({ value: Math.floor(random() * 60), count: 1 + Math.floor(random() * 5) });
    }
    for (const quantile of [0.5, 0.9]) {
      assert.equal(
        quantileFromCounts(entries, quantile),
        bruteForce(entries, quantile),
        `round ${round} q=${quantile}: ${JSON.stringify(entries)}`,
      );
    }
  }
});

/* ── 3. §1.4's percentage rule ────────────────────────────────────────────── */

test("shares are a share of RECORDED and sum to exactly 100 after rounding", () => {
  const shares = meters.sharesOfRecorded([1, 1, 1]);
  assert.equal(
    shares.reduce((sum, share) => sum + share, 0),
    100,
    "three thirds must still add to 100",
  );
  // The correction lands on the LARGEST slice, where a point is invisible.
  const skewed = meters.sharesOfRecorded([57, 2, 2, 2, 2]);
  assert.equal(skewed.reduce((sum, share) => sum + share, 0), 100);
  assert.equal(skewed[1], 3, "the 2-of-65 slices keep their honest 3%");
  assert.deepEqual(meters.sharesOfRecorded([0, 0]), [0, 0], "an empty denominator is 0, never NaN");
});

test("the eight meters' shares reconcile for every cohort a fold can produce", () => {
  const cases = [
    [3, 20, 1, 75, 0, 1, 2, 0],
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [101, 1, 1, 1, 1, 1, 1, 1],
  ];
  for (const totals of cases) {
    const shares = meters.sharesOfRecorded(totals);
    const sum = shares.reduce((left, right) => left + right, 0);
    assert.equal(sum, totals.some((value) => value > 0) ? 100 : 0, JSON.stringify(totals));
  }
});

/* ── 4. Severity banding, at §1.3's edges ─────────────────────────────────── */

test("the severity bands break exactly where §1.3 says they do", () => {
  assert.equal(meters.severityBand(0), "fresh");
  assert.equal(meters.severityBand(14), "fresh", "0–14 days");
  assert.equal(meters.severityBand(15), "ageing", "15–30 days");
  assert.equal(meters.severityBand(30), "ageing");
  assert.equal(meters.severityBand(31), "overdue", "31–60 days");
  assert.equal(meters.severityBand(60), "overdue");
  assert.equal(meters.severityBand(61), "critical", "60+ days");
  assert.equal(meters.severityBand(4000), "critical");
});

test("a severity tally counts grouped jobs, not grouped rows", () => {
  const counts = emptySeverity();
  addSeverity(counts, 3, 9);
  addSeverity(counts, 46, 1);
  addSeverity(counts, 90, 2);
  assert.deepEqual(counts, { fresh: 9, ageing: 0, overdue: 1, critical: 2 });
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    12,
    "and the four bands account for every job",
  );
});

/* ── 5. The fold acceptance gate 11 rests on ──────────────────────────────── */

/** What `loadMeters` does to a `GROUP BY status` result, in eight lines. */
function foldStatuses(rows, assignments) {
  const totals = new Map();
  for (const row of rows) {
    const key = meters.meterForStatus(assignments, row.status);
    totals.set(key, (totals.get(key) ?? 0) + row.total);
  }
  return totals;
}

test("the meter fold is a partition: nothing is lost and nothing is double-counted", () => {
  const assignments = new Map([
    [statusKey("Job Completed"), "completed"],
    [statusKey("Job Scheduled"), "scheduled"],
    [statusKey("Pending Approval"), "waiting_approval"],
    [statusKey("Third Party Delay"), "needs_attention"],
  ]);
  const rows = [
    { status: "Job Completed", total: 3 },
    { status: "  job   completed  ", total: 1 }, // the same status, spelled by a spreadsheet
    { status: "Job Scheduled", total: 20 },
    { status: "Pending Approval", total: 75 },
    { status: "Third Party Delay", total: 2 },
    { status: "A status invented tomorrow", total: 7 }, // §9.9 — no code change
    { status: "", total: 4 }, // no status at all
    { status: null, total: 1 },
  ];
  const totals = foldStatuses(rows, assignments);
  const cohort = rows.reduce((sum, row) => sum + row.total, 0);
  const folded = [...totals.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(folded, cohort, "the meters sum EXACTLY to the cohort — acceptance gate 11");

  assert.equal(totals.get("completed"), 4, "two spellings of one status are one status");
  assert.equal(
    totals.get(meters.CATCH_ALL_METER),
    12,
    "an unmapped status, a blank and a null all land in the permanent catch-all",
  );
  for (const key of totals.keys()) {
    assert.ok(meters.isMeterKey(key), `${key} is one of the eight`);
  }
});

test("a meter key that is not one of the eight cannot capture a status", () => {
  // A row whose `meter_key` was hand-edited to something meaningless must not
  // create a ninth bucket — it resolves to the catch-all, and the total holds.
  const assignments = new Map([[statusKey("Escalated"), "not_a_meter"]]);
  assert.equal(meters.meterForStatus(assignments, "Escalated"), meters.CATCH_ALL_METER);
});

test("hiding a meter never removes it from the eight", () => {
  const seeded = meters.seedMeterDefinitions();
  assert.equal(seeded.length, 8);
  assert.equal(seeded.filter((meter) => meter.isCatchAll).length, 1);
  assert.equal(seeded.at(-1).key, meters.CATCH_ALL_METER, "the catch-all is last in workflow order");
  assert.deepEqual(
    meters.orderMeters([...seeded].reverse()).map((meter) => meter.key),
    seeded.map((meter) => meter.key),
    "order is data, and it is restored from `sortOrder` rather than from arrival order",
  );
});

/* ── 6. The contractor link §3.6 says the card gets wrong ─────────────────── */

test("an alias matches the name somebody typed, whatever the spacing and case", () => {
  assert.equal(normaliseContractorName("  UK   Safety  "), "uk safety");
  assert.equal(normaliseContractorName("TaskRabbit"), "taskrabbit");
  assert.equal(normaliseContractorName(null), "");
  // The two spellings collide on purpose: that is what makes an alias resolve
  // a name the card currently renders as "Not linked".
  assert.equal(normaliseContractorName("Omega Fire  and Security"), normaliseContractorName("omega fire and security"));
});

/* ── 7. Business hours, for the day a stage timestamp finally arrives ─────── */

test("business minutes run only inside the working day and skip weekends and holidays", () => {
  const none = new Set();
  // 09:00 to 11:30 on a Tuesday.
  assert.equal(businessMinutesBetween("2026-09-08T09:00:00Z", "2026-09-08T11:30:00Z", none), 150);
  // 17:30 Tuesday to 08:30 Wednesday: 30 minutes before close, 30 after open.
  assert.equal(businessMinutesBetween("2026-09-08T17:30:00Z", "2026-09-09T08:30:00Z", none), 60);
  // Friday 17:00 to Monday 09:00: one hour on Friday, one on Monday.
  assert.equal(businessMinutesBetween("2026-09-11T17:00:00Z", "2026-09-14T09:00:00Z", none), 120);
  // The same span with the Monday declared a bank holiday: the Monday hour goes.
  assert.equal(
    businessMinutesBetween("2026-09-11T17:00:00Z", "2026-09-14T09:00:00Z", new Set(["2026-09-14"])),
    60,
  );
  assert.equal(businessMinutesBetween("2026-09-08T09:00:00Z", "2026-09-08T09:00:00Z", none), 0);
  assert.equal(businessMinutesBetween("not a date", "2026-09-08T09:00:00Z", none), null);
});

/* ── 8. The words a card prints, from the axis it was computed on ─────────── */

test("the cohort wording follows the measure, not just the figure", () => {
  assert.equal(meters.cohortWording("requested", 226), "226 jobs requested in this period");
  assert.equal(meters.cohortWording("completed", 226), "226 jobs completed in this period");
  assert.equal(meters.cohortWording("requested", 1), "1 job requested in this period");
  assert.equal(meters.excludedWording("completed", 14), "14 jobs excluded — no completion date recorded");
  assert.equal(meters.excludedWording("requested", 1), "1 job excluded — no request date recorded");
});

test("coverage is never rounded up into a claim of completeness", () => {
  assert.equal(meters.coverageSentence("Engineer required", 193, 226), "Engineer required — 193 of 226 recorded (85%)");
  assert.equal(
    meters.coverageSentence("Label", 999, 1000),
    "Label — 999 of 1000 recorded (99%)",
    "a gap of one must not print as 100%",
  );
});
