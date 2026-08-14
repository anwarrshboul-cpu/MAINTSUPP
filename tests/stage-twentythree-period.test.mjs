/**
 * The reporting period.
 *
 * The owner asked to be able to choose the window every figure on the Spend and
 * reporting screen is measured over — a month, a quarter, a single date, a
 * range — and for everything below the control to follow it. That makes the
 * period the single most load-bearing number on the screen: get the window
 * wrong and every tile, bar and table below is confidently wrong together, with
 * nothing on the page to give it away.
 *
 * So period-model.ts has no React in it, exactly as dashboard-meters.ts has
 * none, and this file transpiles and calls it directly. These are real calls
 * into the shipped code — not a re-implementation that could agree with itself
 * while the screen is wrong.
 *
 * The three things asserted hardest:
 *   1. The legacy vocabulary is unchanged. Three screens already pass "30",
 *      "90", "365" and "all" through `withinAnalyticsPeriod`, and the new
 *      resolver must give those the identical window, grace day and all.
 *   2. The sparklines follow the period. They did not: `requestTrend` built
 *      twelve fixed seven-day buckets and never saw the period, so any window
 *      older than 84 days drew a flat line at zero under a number in the
 *      thousands. That defect is reproduced here and then shown fixed.
 *   3. An empty period is empty, and an unfinished one is neither empty nor
 *      full. "Nothing in this period" and "choose both dates" are different
 *      sentences and the model has to be able to tell them apart.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/**
 * A data: URL cannot resolve a relative specifier, so a dependency has to be
 * substituted for its own data: URL before the importer is loaded.
 *
 * period-model.ts calls `analyticsWindow` rather than writing the rolling
 * windows out a second time, which is the point — one definition of what a
 * period is — and this is the price of asserting that from a test that
 * transpiles the shipped source instead of importing a build.
 */
const metersUrl = asModule(
  transpile(await read("app/(app)/portal/dashboard-meters.ts")),
);
const meters = await import(metersUrl);

const period = await import(
  asModule(
    transpile(await read("app/(app)/portal/period-model.ts")).replace(
      /from ["']\.\/dashboard-meters["']/g,
      `from "${metersUrl}"`,
    ),
  )
);

const DAY = 86_400_000;
/** A Sunday, mid-afternoon — deliberately not a month or week boundary. */
const NOW = new Date(2026, 7, 9, 15, 30, 0, 0).getTime();

const at = (year, month, day, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

let sequence = 0;
function row(requestedAt, cost = null, overrides = {}) {
  sequence += 1;
  return {
    id: `P-${sequence}`,
    siteId: "store-aldgate",
    category: "Lights",
    tier: 2,
    priority: "Medium",
    stage: "Incoming",
    status: "Pending Approval",
    requestedAt,
    cost,
    ...overrides,
  };
}

/* ── 1. The legacy vocabulary is untouched ───────────────────────────────── */

test("every token analyticsWindow understood resolves to the identical window", () => {
  for (const token of ["7", "30", "90", "365", "1", "0"]) {
    const legacy = meters.analyticsWindow(token, NOW);
    const next = period.resolvePeriod(token, NOW);
    assert.equal(
      next.start,
      legacy.start,
      `start moved for "${token}" — the board's own period control would change meaning`,
    );
    assert.equal(
      next.end,
      legacy.end,
      `the one-day grace on the end was lost for "${token}"`,
    );
    assert.equal(next.recognised, true);
  }
});

test('"all" still means every row, including one whose date will not parse', () => {
  const window = period.resolvePeriod("all", NOW);
  assert.equal(Number.isFinite(window.start), false);
  assert.equal(period.stampWithinPeriod("not a date at all", "all", NOW), true);
  assert.equal(period.stampWithinPeriod("2015-09-02", "all", NOW), true);
  assert.equal(window.label, "All records");
});

test("a row is in the same rolling window it was before", () => {
  // The legacy filter, verbatim from dashboard-analytics.tsx before this work.
  const legacyWithin = (value, token, now) => {
    const { start, end } = meters.analyticsWindow(token, now);
    if (!Number.isFinite(start)) return true;
    const stamp = new Date(value).getTime();
    return stamp >= start && stamp <= end;
  };
  const stamps = [
    "2026-08-09 07:39:18",
    "2026-08-03",
    "2026-06-01",
    "2026-01-15",
    "2025-02-27",
    "2015-09-02",
  ];
  for (const token of ["30", "90", "365", "all"]) {
    for (const stamp of stamps) {
      assert.equal(
        period.stampWithinPeriod(stamp, token, NOW),
        legacyWithin(stamp, token, NOW),
        `"${stamp}" changed sides of the "${token}" window`,
      );
    }
  }
});

/* ── 2. The new vocabulary ───────────────────────────────────────────────── */

test("every option the picker offers resolves, or says why it does not", () => {
  const needsArgument = new Set(["month", "year", "date", "range"]);
  for (const option of period.periodOptions) {
    const window = period.resolvePeriod(option.value, NOW);
    if (needsArgument.has(option.value)) {
      assert.equal(
        window.recognised,
        false,
        `"${option.label}" is a prompt for a second field, not a window`,
      );
      assert.ok(window.reason.length > 10, `"${option.label}" must say what to do`);
      continue;
    }
    assert.equal(window.recognised, true, `"${option.label}" resolved to nothing`);
    assert.ok(window.start <= window.end, `"${option.label}" ends before it starts`);
    assert.ok(window.label.length > 0, `"${option.label}" has no caption`);
  }
});

test("the owner's list is all present", () => {
  // Named one by one, from the owner's words. A missing option is the kind of
  // thing a "we added a period picker" summary hides.
  const wanted = [
    "today",
    "yesterday",
    "week",
    "mtd",
    "month",
    "quarter",
    "quarter-1",
    "6m",
    "12m",
    "ytd",
    "date",
    "range",
  ];
  const offered = new Set(period.periodOptions.map((option) => option.value));
  for (const value of wanted) {
    assert.ok(offered.has(value), `the period selector does not offer "${value}"`);
  }
});

test("each calendar period is exactly its own calendar edges", () => {
  const cases = [
    ["today", at(2026, 8, 9), at(2026, 8, 9, 23, 59)],
    ["yesterday", at(2026, 8, 8), at(2026, 8, 8, 23, 59)],
    // NOW is a Sunday, so this week began on Monday 3 August.
    ["week", at(2026, 8, 3), at(2026, 8, 9, 23, 59)],
    ["week-1", at(2026, 7, 27), at(2026, 8, 2, 23, 59)],
    ["mtd", at(2026, 8, 1), at(2026, 8, 9, 23, 59)],
    ["month-1", at(2026, 7, 1), at(2026, 7, 31, 23, 59)],
    ["quarter", at(2026, 7, 1), at(2026, 8, 9, 23, 59)],
    ["quarter-1", at(2026, 4, 1), at(2026, 6, 30, 23, 59)],
    ["6m", at(2026, 3, 1), at(2026, 8, 9, 23, 59)],
    ["12m", at(2025, 9, 1), at(2026, 8, 9, 23, 59)],
    ["ytd", at(2026, 1, 1), at(2026, 8, 9, 23, 59)],
    ["year-1", at(2025, 1, 1), at(2025, 12, 31, 23, 59)],
    ["month:2026-02", at(2026, 2, 1), at(2026, 2, 28, 23, 59)],
    ["month:2024-02", at(2024, 2, 1), at(2024, 2, 29, 23, 59)],
    ["year:2024", at(2024, 1, 1), at(2024, 12, 31, 23, 59)],
    ["date:2026-03-17", at(2026, 3, 17), at(2026, 3, 17, 23, 59)],
    ["range:2026-01-01..2026-03-31", at(2026, 1, 1), at(2026, 3, 31, 23, 59)],
  ];
  for (const [token, start, end] of cases) {
    const window = period.resolvePeriod(token, NOW);
    assert.equal(window.start, start, `"${token}" starts in the wrong place`);
    // Compared to the minute: the end is the last millisecond of its day, and
    // asserting that exactly is what stops an off-by-one dropping the newest row.
    assert.equal(
      Math.floor(window.end / 60_000),
      Math.floor(end / 60_000),
      `"${token}" ends in the wrong place`,
    );
    assert.equal(window.end % 60_000, 59_999, `"${token}" does not end on a day edge`);
  }
});

test("a leap day is inside February 2024 and outside February 2026", () => {
  assert.equal(period.stampWithinPeriod("2024-02-29", "month:2024-02", NOW), true);
  assert.equal(period.stampWithinPeriod("2024-03-01", "month:2024-02", NOW), false);
});

test("adjacent periods never both claim the same row", () => {
  const pairs = [
    ["yesterday", "today"],
    ["week-1", "week"],
    ["month-1", "mtd"],
    ["quarter-1", "quarter"],
    ["year-1", "ytd"],
  ];
  for (const [earlier, later] of pairs) {
    const first = period.resolvePeriod(earlier, NOW);
    const second = period.resolvePeriod(later, NOW);
    assert.ok(
      first.end < second.start,
      `"${earlier}" overlaps "${later}" — a row would be counted in both`,
    );
  }
});

test("the caption names a whole month and a whole year by name", () => {
  assert.equal(period.resolvePeriod("month:2026-07", NOW).label, "July 2026");
  assert.equal(period.resolvePeriod("year:2025", NOW).label, "2025");
  assert.equal(period.resolvePeriod("date:2026-03-17", NOW).label, "17 Mar 2026");
  assert.equal(period.resolvePeriod("today", NOW).label, "9 Aug 2026");
  assert.equal(
    period.resolvePeriod("quarter-1", NOW).label,
    "1 Apr 2026 – 30 Jun 2026",
  );
});

/* ── 3. Empty, unfinished, and the difference between them ───────────────── */

test("an empty period is empty — not unreadable", () => {
  const window = period.resolvePeriod("date:2019-01-01", NOW);
  assert.equal(window.recognised, true);
  const rows = [row("2026-08-01"), row("2026-07-01")];
  const scoped = rows.filter((item) =>
    period.stampWithinPeriod(item.requestedAt, "date:2019-01-01", NOW),
  );
  assert.equal(scoped.length, 0);
  // The screen can now say "nothing in this period" against a named window,
  // which is a fact, rather than printing £0, which reads as a result.
  assert.equal(window.label, "1 Jan 2019");
});

test("an unfinished custom range is not an empty period", () => {
  for (const token of ["range:..", "range:2026-01-01..", "range:..2026-03-31", "month:", "date:"]) {
    const window = period.resolvePeriod(token, NOW);
    assert.equal(window.recognised, false, `"${token}" pretended to be a window`);
    assert.ok(window.reason.length > 10, `"${token}" gave no reason`);
    // And nothing is silently in scope, which is what the old resolver did with
    // any string it did not understand: it returned an infinite lower bound and
    // every row on the board passed the filter.
    assert.equal(period.stampWithinPeriod("2026-08-01", token, NOW), false);
  }
});

test("a range entered backwards is read in date order, not thrown away", () => {
  const backwards = period.resolvePeriod("range:2026-03-31..2026-01-01", NOW);
  const forwards = period.resolvePeriod("range:2026-01-01..2026-03-31", NOW);
  assert.equal(backwards.recognised, true);
  assert.equal(backwards.start, forwards.start);
  assert.equal(backwards.end, forwards.end);
});

/* ── 4. The sparkline defect ─────────────────────────────────────────────── */

test("the sparkline follows the period instead of a fixed 84 days", () => {
  // Two jobs a week through the whole of last year.
  const rows = [];
  for (let week = 0; week < 52; week += 1) {
    const when = new Date(at(2025, 8, 10) + week * 7 * DAY);
    rows.push(row(when.toISOString().slice(0, 10)));
    rows.push(row(when.toISOString().slice(0, 10)));
  }

  // The defect, reproduced: twelve fixed seven-day buckets ending now.
  const fixedEightyFour = (items) =>
    Array.from({ length: 12 }, (_, index) => {
      const end = NOW - (11 - index) * 7 * DAY;
      const start = end - 7 * DAY;
      return items.filter((item) => {
        const stamp = new Date(item.requestedAt).getTime();
        return stamp >= start && stamp < end;
      }).length;
    });

  const token = "month:2026-01";
  const scoped = rows.filter((item) =>
    period.stampWithinPeriod(item.requestedAt, token, NOW),
  );
  assert.ok(scoped.length > 0, "January 2026 should hold some of these jobs");

  const old = fixedEightyFour(scoped);
  assert.equal(
    old.reduce((sum, value) => sum + value, 0),
    0,
    "the fixed 84-day window drew a flat zero for a month seven months back — " +
      "if this no longer reproduces, the fixture stopped exercising the defect",
  );

  const fixed = period.periodTrend(scoped, () => true, token, NOW);
  assert.equal(fixed.length, 12);
  assert.equal(
    fixed.reduce((sum, value) => sum + value, 0),
    scoped.length,
    "every row the number counts must appear somewhere in the line under it",
  );
});

test("the sparkline counts exactly what its predicate counts", () => {
  const rows = [
    row("2026-07-02", 5000, { priority: "Urgent" }),
    row("2026-07-12", 40),
    row("2026-07-22", null, { priority: "Urgent" }),
  ];
  const urgent = period.periodTrend(
    rows,
    (item) => item.priority === "Urgent",
    "month:2026-07",
    NOW,
  );
  assert.equal(urgent.reduce((sum, value) => sum + value, 0), 2);
});

test("a period with no rows draws a flat zero line, not an invented shape", () => {
  const trend = period.periodTrend([], () => true, "yesterday", NOW);
  assert.deepEqual(trend, new Array(12).fill(0));
});

/* ── 5. Money, and the buckets under the trend chart ─────────────────────── */

test("cost is pounds and is never divided by a hundred", () => {
  // `maintenance_requests.cost` is a `real` in POUNDS. views/view-model.ts
  // carried a `/100` that rendered £42,540.14 of real spend as £425.40 on four
  // screens; nothing in this file may reintroduce that.
  const rows = [row("2026-07-04", 1000), row("2026-07-20", 234.56)];
  const series = period.periodSpendSeries(rows, "month:2026-07", NOW);
  const total = series.reduce((sum, point) => sum + point.value, 0);
  assert.equal(Number(total.toFixed(2)), 1234.56);
});

test("the spend buckets account for every row in the period and no others", () => {
  const rows = [
    row("2025-12-31", 100),
    row("2026-01-01", 200),
    row("2026-02-14", 300),
    row("2026-03-31", 400),
    row("2026-04-01", 500),
  ];
  const token = "range:2026-01-01..2026-03-31";
  const scoped = rows.filter((item) =>
    period.stampWithinPeriod(item.requestedAt, token, NOW),
  );
  assert.equal(scoped.length, 3);
  const series = period.periodSpendSeries(scoped, token, NOW);
  assert.equal(
    series.reduce((sum, point) => sum + point.value, 0),
    900,
    "a bucketed chart that loses a row is worse than no chart",
  );
});

test("the granularity comes from the period, and never runs away", () => {
  const shapes = [
    ["today", 6],
    ["yesterday", 6],
    ["month:2026-07", 31],
    ["quarter-1", 14],
    ["12m", 12],
    ["ytd", 8],
  ];
  for (const [token, count] of shapes) {
    const buckets = period.periodBuckets(token, NOW, []);
    assert.equal(buckets.length, count, `"${token}" drew ${buckets.length} buckets`);
  }
  // "All records" spans eleven years on this workspace. 132 monthly points is a
  // fringe, not a trend, so they merge — and the merged label says so.
  const all = period.periodBuckets("all", NOW, [at(2015, 9, 2), NOW]);
  assert.ok(all.length <= 36, `all records drew ${all.length} points`);
  assert.ok(all.some((bucket) => bucket.label.includes("–")), "merged buckets must name their span");
});

test("the first bucket starts where the period does, not where its calendar does", () => {
  // "Last quarter" begins on 1 April; its first weekly bucket would naturally
  // begin on Monday 30 March, and the axis would then disagree with the caption
  // above it.
  const [first] = period.periodBuckets("quarter-1", NOW, []);
  assert.equal(first.start, at(2026, 4, 1));
  assert.equal(first.label, "1 Apr");
});

test("axis labels thin out; buckets never do", () => {
  const buckets = period.periodBuckets("month:2026-07", NOW, []);
  assert.equal(buckets.length, 31, "a month is still thirty-one days of data");
  const labelled = buckets.filter((bucket) => bucket.label).length;
  assert.ok(labelled <= 10, `${labelled} labels would collide on a phone`);
  assert.ok(buckets[buckets.length - 1].label, "the last tick keeps its label");
});

/* ── 6. Stored timestamps ────────────────────────────────────────────────── */

test("both forms the database stores are read as the wall-clock they are", () => {
  // 634 rows are a bare date, 142 carry a time, and not one carries a zone.
  assert.equal(period.parseStamp("2026-08-03"), at(2026, 8, 3));
  assert.equal(period.parseStamp("2026-08-09 07:39:18"), at(2026, 8, 9, 7, 39) + 18_000);
  // A bare date read by `new Date` is UTC midnight, which is a different
  // instant from the local midnight every calendar bound here is built from.
  assert.equal(period.stampWithinPeriod("2026-08-03", "date:2026-08-03", NOW), true);
  assert.equal(period.stampWithinPeriod("2026-08-03", "date:2026-08-02", NOW), false);
  assert.equal(period.stampWithinPeriod("2026-08-03", "date:2026-08-04", NOW), false);
});

test("a stamp that will not parse is out of every window except all records", () => {
  assert.equal(period.stampWithinPeriod("", "month:2026-07", NOW), false);
  assert.equal(period.stampWithinPeriod("tomorrow-ish", "month:2026-07", NOW), false);
  assert.equal(period.stampWithinPeriod("tomorrow-ish", "all", NOW), true);
});

/* ── 7. Sorting ──────────────────────────────────────────────────────────── */

test("top sites sort highest first, and reverse on request", () => {
  const items = [
    { label: "Aldgate", value: 900 },
    { label: "Bristol", value: 4200 },
    { label: "Solihull", value: 150 },
  ];
  assert.deepEqual(
    period.sortBySpend(items, "desc").map((item) => item.label),
    ["Bristol", "Aldgate", "Solihull"],
  );
  assert.deepEqual(
    period.sortBySpend(items, "asc").map((item) => item.label),
    ["Solihull", "Aldgate", "Bristol"],
  );
  // And it does not mutate what it was given — the caller memoises this list.
  assert.equal(items[0].label, "Aldgate");
});

/* ── 8. The wiring, in the files that own it ─────────────────────────────── */

test("withinAnalyticsPeriod is one definition, shared", async () => {
  const source = await read("app/(app)/portal/dashboard-analytics.tsx");
  assert.match(
    source,
    /return stampWithinPeriod\(value, period, now\)/,
    "the period filter must delegate, not carry a second copy of the window maths",
  );
});

test("no insight panel builds its own fixed six months any more", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.doesNotMatch(
    source,
    /for \(let offset = 5; offset >= 0; offset -= 1\)/,
    "SpendMatrix and ReactiveVsPlanned built six calendar months from `now` and " +
      "ignored the period control entirely",
  );
  assert.match(source, /periodColumns\(period, clock, stamps, 6\)/);
});

test("the money helper on the reports screen takes pounds", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  const money = source.split("function money(pence: number) {")[1].split("}")[0];
  assert.doesNotMatch(money, /\/\s*100/, "cost is pounds — dividing renders £425 for £42,540");
});

/*
 * The Spend and reporting screen itself lives in portal-app.tsx, which this
 * work does not own; the changes to it were handed over as a patch. These two
 * assertions turn themselves on the moment that patch lands, so the section
 * order and the period wiring stop being something a human has to remember.
 */
const reportsPatched = (await read("app/(app)/portal/portal-app.tsx")).includes(
  "periodControl={",
);

test("Repeat activity is the last section on the reports screen", { skip: reportsPatched ? false : "portal-app.tsx patch not applied yet" }, async () => {
  const source = await read("app/(app)/portal/portal-app.tsx");
  const reports = source.slice(source.indexOf("function ReportsView("));
  const body = reports.slice(0, reports.indexOf("\nfunction "));
  assert.ok(
    body.indexOf("analytics-repeat-panel") > body.indexOf('surface="reports"'),
    "the owner asked for Repeat activity last; it sits above the arrangeable panels",
  );
});

test("the reports screen no longer uses the fixed-window sparkline", { skip: reportsPatched ? false : "portal-app.tsx patch not applied yet" }, async () => {
  const source = await read("app/(app)/portal/portal-app.tsx");
  const reports = source.slice(source.indexOf("function ReportsView("));
  const body = reports.slice(0, reports.indexOf("\nfunction "));
  assert.doesNotMatch(body, /requestTrend\(/, "requestTrend ignores the period");
  assert.match(body, /periodTrend\(/);
  assert.match(body, /periodSpendSeries\(/);
});
