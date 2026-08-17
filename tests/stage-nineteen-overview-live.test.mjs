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

test("the compliance sparkline is not a hand-written series", async () => {
  const overview = await overviewSource();
  // The exact literal that used to sit in the trend prop. It drew eleven
  // percentages nobody measured, rising to 88%, under a card reading 26%.
  assert.ok(
    !overview.includes("[72, 74, 73, 76, 78, 77, 81, 82, 84, 86, 88"),
    "the invented compliance history must not come back",
  );
  assert.ok(
    /trend=\{complianceTrend\(complianceItems, now\)\}/.test(overview),
    "the compliance card must plot the series derived from recorded expiry dates",
  );
  // Every other sparkline on the six tiles is counted from the request rows.
  const trendProps = [...overview.matchAll(/trend=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map(
    (match) => match[1],
  );
  assert.equal(trendProps.length, 6, "all six metric tiles must pass an explicit series");
  for (const prop of trendProps) {
    /*
     * `periodTrend`, not `requestTrend` — Stage 23. The invariant is unchanged
     * and is the whole point of this test: a sparkline is COUNTED, never
     * written by hand. Only the address moved, when the reporting period became
     * a control and `requestTrend`'s fixed twelve 7-day buckets from
     * `Date.now()` were replaced by buckets that follow the selected window.
     */
    assert.ok(
      prop.startsWith("periodTrend(") || prop.startsWith("complianceTrend("),
      `sparkline series must be computed, got: ${prop}`,
    );
  }
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

test("active units counts units, and never falls back to the site count", async () => {
  const overview = await overviewSource();
  assert.ok(
    !/activeUnitCount = units\.length/.test(overview),
    "the unit count must not switch to a different measurement when empty",
  );
  assert.ok(
    !/:\s*scopedStores\.length/.test(overview),
    "sites must never be counted as units",
  );
  assert.ok(
    /const activeUnitCount = units\.filter\(/.test(overview),
    "the unit count must come from the unit register",
  );
  // An empty register says what would fill it rather than borrowing a number.
  assert.ok(
    overview.includes("Add units to the register"),
    "an empty unit register needs an honest caption",
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
  const overview = await overviewSource();
  for (const copy of [
    // Spend is optional on a job, so a portfolio can genuinely have none.
    "No costs recorded against jobs in this period",
    // A brand new site has no requirements loaded, which is not 0% compliant.
    "No compliance requirements recorded for these sites yet",
    "No jobs in this period",
  ]) {
    assert.ok(overview.includes(copy), `missing honest empty state: ${copy}`);
  }
  // The charts must be behind those guards, not rendered regardless.
  assert.ok(
    /spendSeries\.some\(\(point\) => point\.value > 0\)\s*\?\s*<TrendChart/.test(overview),
    "the spend chart must only draw when spend was recorded",
  );
  assert.ok(
    /tradeRows\.length\s*\?\s*<HorizontalBars/.test(overview),
    "the trade chart must only draw when there are jobs",
  );
});

test("the Overview reads only from scoped props, never from the mock module", async () => {
  const overview = await overviewSource();
  // portal-app.tsx still imports the bundled dataset as a fallback for when the
  // API is unreachable, which is deliberate. What must not happen is the
  // Overview reaching past its props to read it directly, because that bypasses
  // the organisation scoping the APIs apply.
  for (const symbol of ["sampleRequests", "sampleFiles", "storeDocumentationResponsibility"]) {
    assert.ok(
      !overview.includes(symbol),
      `OverviewView must not read ${symbol} directly`,
    );
  }
  // `stores` arrives renamed as storeRows precisely so the mock import cannot be
  // referenced by accident inside this component.
  assert.ok(
    /stores: storeRows,/.test(overview),
    "the stores prop must stay shadowed as storeRows",
  );
  assert.ok(
    !/\bstoreRows = stores\b/.test(overview),
    "the mock store list must not be substituted inside the Overview",
  );
});

test("every Overview figure is derived from the request, unit and compliance rows", async () => {
  const overview = await overviewSource();
  // Each tile's value must be a length or a computed percentage — not a
  // literal. This is the cheap check that catches a number typed in to make a
  // screenshot look busy.
  const values = [...overview.matchAll(/<AnalyticsMetricCard label="([^"]+)" value=\{([^}]+)\}/g)];
  assert.equal(values.length, 6, "the Overview has six metric tiles");
  for (const [, label, expression] of values) {
    assert.ok(
      /\.length|Percent|Count/.test(expression),
      `${label} must be counted, got: ${expression}`,
    );
  }
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
