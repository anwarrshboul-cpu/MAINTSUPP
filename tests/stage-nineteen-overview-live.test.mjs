/**
 * Stage 19 — the Dashboard Overview must show measurements, not decoration.
 *
 * The Overview was already fed by the scoped APIs; what it was not was honest
 * about the gaps in them. Three things reached the screen that no row in the
 * database supported: a hand-written compliance history, a unit count that
 * silently became a site count, and a bar for a third of the portfolio with no
 * label on it. These tests pin each one shut, because all three are the kind of
 * regression that looks completely fine in a screenshot.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UNRECORDED_TRADE,
  complianceTrend,
  tradeBreakdown,
  tradeLabel,
} from "../app/(app)/portal/views/overview-series.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/** The Overview component only — the rest of the file is other people's work. */
async function overviewSource() {
  const source = await read("app/(app)/portal/portal-app.tsx");
  const start = source.indexOf("function OverviewView({");
  assert.ok(start > 0, "OverviewView must still exist in portal-app.tsx");
  const end = source.indexOf("\nexport function LegacyMaintenanceView", start);
  assert.ok(end > start, "OverviewView must still be followed by LegacyMaintenanceView");
  return source.slice(start, end);
}

/*
 * RE-POINTED, NOT DROPPED. The compliance figure moved off a sparkline.
 *
 * The defect this protects is the one that matters: eleven percentages nobody
 * measured, rising to 88%, drawn under a card reading 26%. Sparklines are gone
 * from the Overview — the compliance figure is a meter on each site row, fed by
 * `/api/dashboard/sites-attention`, which counts the SHARED register with the
 * SHARED completion rule. A hand-written series is now unrepresentable rather
 * than merely absent: the page holds no series at all.
 */
test("no Overview figure is a hand-written series", async () => {
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.ok(
    !page.includes("[72, 74, 73, 76, 78, 77, 81, 82, 84, 86, 88"),
    "the invented compliance history must not come back",
  );
  /*
   * The cheap general form of the same check: no array literal of four or more
   * bare numbers anywhere on the page. That is what a decorative series looks
   * like, and there is no legitimate reason for one here — every number the
   * page draws arrives from an endpoint.
   */
  assert.ok(
    !/\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(page),
    "a literal series is a number nobody measured",
  );
  const route = await read("app/api/dashboard/sites-attention/route.ts");
  assert.match(
    route,
    /complianceCompletion/,
    "the compliance figure is counted from the register, by the shared rule",
  );
});

test("compliance trend follows the recorded expiry dates", () => {
  const now = Date.UTC(2026, 7, 7);
  const items = [
    // In date throughout the window.
    { kind: "Gas safety", state: "Compliant", expiry: "2031-01-01", fileCount: 1 },
    // Ran out three weeks ago, so the last three readings must drop.
    { kind: "EICR", state: "Expired", expiry: "2026-07-20", fileCount: 1 },
    // Never held: no expiry to be in date against, at any point.
    { kind: "Fire risk", state: "Missing", expiry: null, fileCount: 0 },
    { kind: "PAT", state: "Missing", expiry: null, fileCount: 0 },
  ];
  const series = complianceTrend(items, now);
  assert.equal(series.length, 12, "the sparkline expects twelve readings");
  // Before the EICR lapsed on 20 July, two of four were in date.
  assert.equal(series[0], 50);
  assert.equal(series[8], 50);
  // After it lapsed, one of four — and the step falls on the recorded date.
  assert.equal(series[9], 25);
  assert.equal(series[11], 25);
  // The last reading is today's measured count, the same figure the card
  // prints, so the line and the headline cannot drift apart.
  const compliantNow = items.filter((item) => item.state === "Compliant").length;
  assert.equal(series.at(-1), Math.round((compliantNow / items.length) * 100));
  // Monotonic here because nothing was renewed — an invented series would not
  // have to obey the dates at all.
  assert.deepEqual([...series].sort((a, b) => b - a), series);
});

test("compliance trend is flat at zero, never the decorative default", () => {
  // Sparkline substitutes its own rising placeholder for a series of one or
  // fewer values, so an empty workspace must still get twelve real readings.
  const series = complianceTrend([], Date.now());
  assert.equal(series.length, 12);
  assert.ok(series.every((value) => value === 0));
});

/*
 * RE-POINTED. The tile strip changed; the rule about it did not.
 *
 * The original defect was a tile that BORROWED a measurement: "Active units"
 * counted the unit register, which is empty on this account, so the largest
 * number on the dashboard read 0 and meant nothing. It was re-pinned once
 * already when the tile became "Active sites".
 *
 * The rebuilt strip is the five tiles the brief specifies — Open jobs, Needs
 * attention, Oldest open, Urgent open, Unassigned site — and the site count
 * moved to the Sites page, where it is counted from the site register through
 * the same shared predicate. What is asserted here is the rule rather than the
 * tile: every tile counts the thing it names, from the server, and none of them
 * substitutes a different measurement when its own is zero.
 */
test("every Overview tile counts the thing it names, and never borrows another measurement", async () => {
  /*
   * RE-POINTED. The five hard-coded tiles are gone: §2.2 replaces them with
   * four Pulse figures and §2.3 with eight meters rendered from
   * `data.meters`, so there is no `const tiles = [` to slice and no
   * `totals.unassignedOpen` tile — §6.1 moved "Unassigned site" off the card
   * entirely, because it is a broken foreign key rather than a location.
   *
   * The contract is untouched and is what the expression list was really for:
   * every figure on this page is READ from a payload the server computed, and
   * no tile borrows another tile's measurement. Each Pulse figure names its own
   * field, and the meter grid maps over the payload rather than over literals.
   */
  const page = await read("app/(app)/portal/ops/overview-glance.tsx");
  /* Bounded by the array's own closing bracket. `return (` appears earlier, in
     the error branch above it, so slicing to that gave an empty string. */
  const figuresAt = page.indexOf("const figures = [");
  const figures = page.slice(figuresAt, page.indexOf("\n  ];", figuresAt));
  for (const [label, expression] of [
    ["Open", "pulse.open.value"],
    ["P1 / Urgent open", "pulse.urgentOpen.value"],
    ["Oldest open", "pulse.oldestOpenDays.value"],
    ["Incomplete records", "pulse.incompleteRecords.value"],
  ]) {
    assert.ok(
      figures.includes(`value: ${expression}`),
      `${label} must read ${expression} from the meters payload`,
    );
  }
  assert.ok(
    !/const activeUnitCount/.test(page),
    "the superseded unit count must be gone, not left beside it",
  );

  /*
   * And the site count it used to hold is still counted, on the page that owns
   * sites, from the site register through the shared status predicate — not
   * from Jobs, and not from lifecycle, which admits the unverifiable 'other'
   * rows.
   */
  const sites = await read("app/(app)/portal/ops/sites-list.tsx");
  assert.match(
    sites,
    /const active = sites\.filter\(\(site\) => site\.status !== "closed"\)\.length/,
    "the Sites page counts active sites from the register's own status column",
  );
});

test("jobs with no trade recorded are named, not left as a blank bar", () => {
  const requests = [
    { engineer: "Electrician" },
    { engineer: "Electrician" },
    { engineer: "" },
    { engineer: "   " },
    { engineer: undefined },
  ];
  const rows = tradeBreakdown(requests);
  const unrecorded = rows.find((row) => row.label === UNRECORDED_TRADE);
  assert.ok(unrecorded, "blank trades must be gathered under a stated label");
  assert.equal(unrecorded.value, 3, "no job may be dropped from the breakdown");
  assert.ok(
    rows.every((row) => row.label.trim().length > 0),
    "no bar may render without a label",
  );
  // Every job is accounted for, so the panel cannot understate the workload.
  assert.equal(
    rows.reduce((sum, row) => sum + row.value, 0),
    requests.length,
  );
  // Biggest first, and the absence of a trade reads as absence, not category.
  assert.equal(rows[0].label, UNRECORDED_TRADE);
  assert.equal(unrecorded.color, "#6f8190");
  assert.notEqual(rows.find((row) => row.label === "Electrician").color, "#6f8190");
});

/*
 * The live workspace's own numbers, so a regression is visible as the figure an
 * owner actually reads rather than as a fixture. The seven values and their
 * counts are `SELECT engineer, count(*) FROM portal.maintenance_requests GROUP
 * BY engineer` on 2026-08-17: 776 rows, none deleted, which is the exact set the
 * Overview scopes to on "All records" with every site selected.
 */
const LIVE_ENGINEER_COUNTS = [
  ["Handyman", 445],
  ["Electrician", 279],
  ["", 36],
  ["Other", 9],
  ["Plummer", 4],
  ["[object Object]", 2],
  ["General", 1],
];

test("a stringified object is not a trade, and does not become a bar", () => {
  // The value in the column, not an object: the importer stringified it long
  // before this panel sees it. See UNUSABLE_TRADE_VALUES.
  assert.equal(tradeLabel("[object Object]"), UNRECORDED_TRADE);
  assert.equal(tradeLabel("[OBJECT OBJECT]"), UNRECORDED_TRADE);
  assert.equal(tradeLabel("undefined"), UNRECORDED_TRADE);
  assert.equal(tradeLabel("null"), UNRECORDED_TRADE);
  // A live object would have thrown on `.trim()` before; it must not now, and
  // it must not be captioned with its own stringification either.
  assert.equal(tradeLabel({ index: 5 }), UNRECORDED_TRADE);
  assert.equal(tradeLabel(undefined), UNRECORDED_TRADE);
  // Real trades are untouched — including ones that merely contain the word.
  assert.equal(tradeLabel(" Electrician "), "Electrician");
  assert.equal(tradeLabel("Object handling"), "Object handling");
});

test("the live trade bars move exactly two jobs, and account for all 776", () => {
  const requests = LIVE_ENGINEER_COUNTS.flatMap(([engineer, n]) =>
    Array.from({ length: n }, () => ({ engineer })),
  );
  assert.equal(requests.length, 776);

  const rows = tradeBreakdown(requests);
  const by = new Map(rows.map((row) => [row.label, row.value]));

  // No bar may be captioned with the wreckage of a value.
  assert.ok(!by.has("[object Object]"), "[object Object] must not be a bar");

  // The named trades are untouched, to the job. This is the assertion that
  // stops a future "cleanup" quietly rebucketing the owner's figures.
  assert.equal(by.get("Handyman"), 445);
  assert.equal(by.get("Electrician"), 279);
  assert.equal(by.get("Other"), 9);
  assert.equal(by.get("Plummer"), 4);

  // The 36 blanks plus those two, and nothing else.
  assert.equal(by.get(UNRECORDED_TRADE), 38);

  // Every job is in a bar now: dropping the bogus bar frees the sixth slot for
  // the one "General" job the six-bar cap had been cutting off, so the panel
  // accounts for 776 of 776 where it used to account for 775.
  assert.equal(rows.length, 6);
  assert.equal(
    rows.reduce((sum, row) => sum + row.value, 0),
    776,
  );
});

test("trade breakdown keeps the six-bar cap and the existing palette", async () => {
  const requests = Array.from({ length: 40 }, (_, index) => ({
    engineer: `Trade ${index % 9}`,
  }));
  assert.equal(tradeBreakdown(requests).length, 6);

  const series = await read("app/(app)/portal/views/overview-series.ts");
  // Unchanged design: the same five hues the panel has always used.
  for (const hex of ["#12b4a8", "#f26a21", "#f0a91f", "#5c82af", "#6f8190"]) {
    assert.ok(series.includes(hex), `${hex} must stay in the trade palette`);
  }
});

test("panels with nothing behind them say so instead of drawing an empty axis", async () => {
  /*
   * RE-POINTED to the rebuilt cards. The sentences moved; the rule did not.
   *
   * A portfolio can genuinely have no recorded spend, and a new site genuinely
   * has no requirements loaded — which is not 0% compliant. Both must read as
   * an explicit statement rather than as a chart pinned to its axis, because a
   * flat line invites the reader to conclude the work was free.
   */
  /*
   * RE-POINTED AGAIN, and one of the four sentences is gone from the product
   * rather than moved.
   *
   * §3.3 deletes the whole budget block: "Aldgate 898%" was a 90-day spend
   * compared against an unreliable pro-rated annual figure with half the sites
   * carrying no budget at all — a data fault rendered as a metric. So "No site
   * has an annual budget set" no longer has anything to caption. The budget
   * DATA is untouched in the database; only the card stopped presenting it.
   *
   * The rule is unchanged and is now carried by `ChartFrame`, which every chart
   * on the page goes through: an empty answer draws a labelled empty state and
   * never an axis with nothing on it. That is stronger than four hand-written
   * sentences, because a new card cannot forget to write the fifth.
   */
  const page = (
    await Promise.all(
      [
        "overview-page",
        "overview-glance",
        "overview-financial",
        "overview-performance",
        "overview-breakdown",
        "overview-sites",
        "overview-shared",
      ].map((name) => read(`app/(app)/portal/ops/${name}.tsx`)),
    )
  ).join("\n");

  for (const copy of [
    "No costed job in this period names a contractor",
    "No job was requested in this period",
  ]) {
    assert.ok(page.includes(copy), `missing honest empty state: ${copy}`);
  }
  /*
   * Comment-stripped: `overview-financial.tsx` explains in prose why the budget
   * block went, and a rule against naming it would be a rule against writing
   * the explanation down. Same `codeOnly` idiom the other ops suites use.
   */
  const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !code.includes("annual budget"),
    "§3.3 — the budget comparison is gone from the card, so it captions nothing",
  );
  // The charts are behind that guard, not rendered regardless.
  assert.match(
    page,
    /empty=\{[^}]*length === 0\}/,
    "a chart is told it is empty rather than being asked to draw nothing",
  );
  assert.match(
    page,
    /emptyLabel=/,
    "and the empty state is a sentence the frame prints, not a blank axis",
  );
});

/*
 * RE-POINTED 2026-09-04, NOT DROPPED.
 *
 * The third empty-state above used to be the "Jobs by trade" panel's, asserted
 * against portal-app.tsx as `tradeRows.length ? <HorizontalBars`. That panel is
 * gone: it plotted `request.engineer`, which is now one of the five meters in
 * the Job breakdown panel, and two panels over one column was the duplication
 * the owner objected to.
 *
 * The contract it protected is unchanged and is re-pinned at the new address —
 * a job-shaped panel must distinguish "nothing here" from "not loaded yet", and
 * must not draw a chart regardless. It moved file, so the assertion did too.
 */
test("the job breakdown panel separates loading from empty, and draws neither blind", async () => {
  const meters = await read("app/(app)/portal/overview-job-meters.tsx");

  assert.ok(
    meters.includes("No jobs in this period"),
    "an empty period must say so in words rather than draw an empty track",
  );
  assert.ok(
    meters.includes("Loading jobs…"),
    "and must not present a period that has not loaded as an empty one",
  );
  // The guard order matters: loading is checked BEFORE emptiness, or a slow
  // fetch renders as a confident "no jobs".
  const loadingAt = meters.indexOf("Loading jobs…");
  const emptyAt = meters.indexOf("No jobs in this period");
  assert.ok(
    loadingAt > -1 && loadingAt < emptyAt,
    "loading must be tested before emptiness",
  );
  assert.match(
    meters,
    /meters\.every\(\(meter\) => meter\.total === 0\)/,
    "emptiness must be measured from the meters themselves, not assumed",
  );
});

test("the Overview reads only from scoped endpoints, never from the mock module", async () => {
  /*
   * RE-POINTED, and the property is now structural rather than a naming
   * convention.
   *
   * portal-app.tsx still imports the bundled dataset as a fallback for when the
   * API is unreachable, which is deliberate. What must not happen is the
   * Overview reaching past its scoping to read it, because the organisation
   * filter lives in `scopedDb`. The page cannot: it holds no job list, no
   * workspace snapshot and no import of either — every number arrives from an
   * endpoint that resolved the organisation from the session.
   */
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  for (const symbol of [
    "sampleRequests",
    "sampleFiles",
    "storeDocumentationResponsibility",
    "mock-data",
  ]) {
    assert.ok(!page.includes(symbol), `the Overview must not read ${symbol}`);
  }
  const imports = [...page.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.ok(
      !specifier.includes("workspace-data") && !specifier.includes("mock"),
      `the Overview must not import ${specifier}`,
    );
  }
  for (const route of [
    "app/api/dashboard/summary/route.ts",
    "app/api/dashboard/sites-attention/route.ts",
    "app/api/dashboard/job-breakdown/route.ts",
    "app/api/dashboard/performance/route.ts",
    "app/api/dashboard/cost/route.ts",
  ]) {
    const source = await read(route);
    assert.match(
      source,
      /dashboardScope\(request\)|scopedDbWithCapability/,
      `${route} must resolve the organisation from the session`,
    );
  }
});

test("every Overview figure is counted, never typed in", async () => {
  /*
   * RE-POINTED. The cheap check that catches a number typed in to make a
   * screenshot look busy, applied to the tiles' new shape.
   *
   * Each tile's `value` must be an expression over the payload rather than a
   * literal, and the payload itself must be an aggregate: the summary endpoint
   * issues `count()` and `sum(case when …)` and returns about a dozen numbers,
   * so there is nowhere for an invented figure to hide.
   */
  const page = await read("app/(app)/portal/ops/overview-glance.tsx");
  /* Bounded by the array's own closing bracket. `return (` appears earlier, in
     the error branch above it, so slicing to that gave an empty string. */
  const figuresAt = page.indexOf("const figures = [");
  const figures = page.slice(figuresAt, page.indexOf("\n  ];", figuresAt));
  const values = [...figures.matchAll(/\n      value: ([^,]+),/g)];
  /*
   * FOUR now, not five: §2.2's Pulse row. The eight meter tiles beside it are
   * not in this list at all because they are a `.map` over the payload, which
   * is the stronger form of the same guarantee — there is no literal to type a
   * number into.
   */
  assert.equal(values.length, 4, "the Overview has four Pulse figures");
  for (const [, expression] of values) {
    assert.ok(
      /pulse\./.test(expression),
      `a Pulse value must come from the payload, got: ${expression}`,
    );
    assert.ok(!/^\d+$/.test(expression.trim()), `a value must not be a literal: ${expression}`);
  }
  assert.match(
    page,
    /value=\{formatCount\(meter\.total, abbreviate\)\}/,
    "and every meter tile reads its own count off the payload",
  );

  const aggregates = await read("app/lib/dashboard-aggregates.ts");
  assert.match(aggregates, /inPeriod: count\(\)/);
  assert.match(aggregates, /sum\(case when \$\{openJobSql\} then 1 else 0 end\)/);
});

test("the spend series sums the cost column and invents nothing", async () => {
  /*
   * `periodSpendSeries` in period-model.ts, not `monthlySpendSeries` in
   * portal-app.tsx — Stage 23. Same invariant, new address: the series is a sum
   * of the recorded cost, an unpriced job counts as zero, and nothing is scaled
   * or randomised. `monthlySpendSeries` was deleted when the six fixed calendar
   * months it built from "now" stopped matching the period the reader had
   * chosen.
   */
  const source = await read("app/(app)/portal/period-model.ts");
  const start = source.indexOf("export function periodSpendSeries");
  assert.ok(start > 0, "the spend series must still exist");
  const body = source.slice(start, source.indexOf("\nexport function periodTrend", start));
  assert.ok(
    body.includes("row.cost ?? 0"),
    "spend must come from the recorded cost, treating an unpriced job as zero",
  );
  assert.ok(
    !/Math\.random|\* 1\d{2,}/.test(body),
    "spend must not be scaled or randomised",
  );
});

test("the unit and compliance figures match a stated database rule", () => {
  // A guard on the arithmetic behind the two tiles that are not a plain count
  // of rows, checked against a fixture rather than against the live D1 file so
  // the test does not go red when someone logs a job.
  const items = [
    { kind: "a", state: "Compliant", expiry: "2031-01-01", fileCount: 1 },
    { kind: "b", state: "Missing", expiry: null, fileCount: 0 },
    { kind: "c", state: "Missing", expiry: null, fileCount: 0 },
    { kind: "d", state: "Not required", expiry: null, fileCount: 0 },
  ];
  // "Not required" is excluded from the denominator by the Overview before the
  // series sees it, matching `not_required = 1` in compliance_documents.
  const counted = items.filter((item) => item.state !== "Not required");
  assert.equal(counted.length, 3);
  assert.equal(
    Math.round((counted.filter((item) => item.state === "Compliant").length / counted.length) * 100),
    33,
  );
  // And the sparkline's final reading agrees with that percentage.
  assert.equal(complianceTrend(counted, Date.UTC(2026, 7, 7)).at(-1), 33);
});
