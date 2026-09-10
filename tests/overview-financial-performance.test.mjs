/**
 * FINANCIAL STATUS (§3) AND PERFORMANCE OVER TIME (§4) — the two analysis cards.
 *
 * These two cards carry more statements that are WRONG BY DEFAULT than
 * anything else on the Overview: a total that is really a 16% sample, a
 * percentage whose denominator is off screen, a zero that is really a blank,
 * an unmeasured SLA stage drawn as a column at 0%, and a median computed from
 * one job drawn as a trend. Every one of those is a sentence a client would
 * read as fact, and every one of them is a one-line change away from coming
 * back. So they are pinned here.
 *
 * TWO KINDS OF TEST, following `tests/overview-components.test.mjs`:
 *
 *   • BEHAVIOURAL — the pure helpers are sliced out of the shipped `.tsx` by
 *     name, stripped of their types by the compiler the repo already carries,
 *     and called. React cannot be mounted under `node:test` here (no DOM, no
 *     renderer in the dependency list), and a re-implementation would agree
 *     with itself while the product was wrong.
 *
 *   • STRUCTURAL — "the compliance link is gone", "a failure never looks like
 *     a zero" and "an unmeasurable stage prints no percentage" are statements
 *     about what is RENDERED, and without a DOM the only way to hold them is
 *     to read the source. When a refactor invalidates one, RE-POINT it at the
 *     contract's new home with the reason written in — never delete it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/*
 * NORMALISED, BECAUSE THIS IS A WINDOWS CHECKOUT AND LINE ENDINGS ARE PER FILE.
 * `slice` below looks for the literal "\n}\n" to find where a function ends,
 * which a CRLF file does not contain.
 */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the rules they explain; every source check strips them. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FINANCIAL = "app/(app)/portal/ops/overview-financial.tsx";
const PERFORMANCE = "app/(app)/portal/ops/overview-performance.tsx";
const STYLES = "app/(app)/portal/ops/overview-analysis.css";
const METERS = "app/lib/overview-meters.ts";

const financialSource = await read(FINANCIAL);
const performanceSource = await read(PERFORMANCE);
const stylesSource = await read(STYLES);
const metersSource = await read(METERS);

const financialCode = codeOnly(financialSource);
const performanceCode = codeOnly(performanceSource);

/* ── The harness: pure helpers, out of a .tsx, without React ──────────────── */

const ts = (await import("typescript")).default;

/** One function, sliced out by its braces. Exported or not. */
function slice(source, name) {
  const exported = source.indexOf(`export function ${name}(`);
  const at = exported >= 0 ? exported : source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} has moved or is no longer a function declaration; fix this test`);
  const end = source.indexOf("\n}\n", at);
  assert.ok(end > 0, `${name} must end with a brace at column zero`);
  return source.slice(at, end + 2).replace(/^export /, "");
}

/** One exported `const`, up to its terminating semicolon. */
function constant(source, name) {
  const at = source.indexOf(`export const ${name} =`);
  assert.ok(at >= 0, `${name} has moved or is no longer an exported const; fix this test`);
  const end = source.indexOf(";\n", at);
  assert.ok(end > 0, `${name} must end in a semicolon at the end of a line`);
  return source.slice(at, end + 1).replace(/^export /, "");
}

const strip = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/*
 * `sharesOfRecorded` is sliced rather than imported for the reason this repo's
 * memory records: `app/lib/overview-meters.ts` imports `./job-metrics.ts`, and
 * a relative specifier cannot resolve from a `data:` URL. Slicing keeps this
 * file from needing an import graph at all.
 */
const helpers = new Function(
  `${strip(
    [
      slice(metersSource, "sharesOfRecorded"),
      constant(financialSource, "SPEND_SUBTITLE"),
      slice(financialSource, "costBanner"),
      slice(financialSource, "spendConcentration"),
      slice(financialSource, "medianStanding"),
      constant(performanceSource, "MIN_SAMPLE"),
      slice(performanceSource, "targetWording"),
      slice(performanceSource, "pointsChange"),
      slice(performanceSource, "sampledValue"),
    ].join("\n\n"),
  )}
   return { sharesOfRecorded, SPEND_SUBTITLE, costBanner, spendConcentration,
            medianStanding, MIN_SAMPLE, targetWording, pointsChange, sampledValue };`,
)();

/* ══ 1. The component contract the page calls ═════════════════════════════ */

test("both cards export the component the Overview page calls, by name", async () => {
  assert.match(
    financialSource,
    /export function FinancialStatusCard\(/,
    "the page imports FinancialStatusCard; renaming it breaks the Overview with no type error at the call site until it is rebuilt",
  );
  assert.match(performanceSource, /export function PerformanceCard\(/);
});

test("each card still takes the props it was agreed with", async () => {
  /*
   * The signature is the interface. A renamed prop is a silent break for the
   * page that already wires it, so the names are pinned one by one.
   */
  const props = (source, component, names) => {
    const at = source.indexOf(`export function ${component}(`);
    const body = source.slice(at, source.indexOf("\n}) {", at));
    for (const name of names) {
      assert.match(
        body,
        new RegExp(`(^|[\\s{,])${name}[,?:\\s}]`, "m"),
        `${component} must still accept "${name}"`,
      );
    }
  };
  props(financialSource, "FinancialStatusCard", [
    "state",
    "measure",
    "filterChips",
    "onToggle",
    "onDrill",
    "onOpenRecords",
    "onOpenResolveNames",
    "onOpenJob",
  ]);
  props(performanceSource, "PerformanceCard", [
    "state",
    "measure",
    "filterChips",
    "onToggle",
    "onDrill",
    "onSelectWindow",
    "splitByPriority",
    "onToggleSplit",
  ]);
});

test("both cards draw through the shared components rather than their own", async () => {
  /*
   * §1.10 exists because "every card grew its own header, its own percentage
   * and its own idea of what not-recorded looks like". A card that stopped
   * importing these would be free to drift again.
   */
  assert.match(financialCode, /from "\.\/overview-shared"/);
  assert.match(financialCode, /\bCohortHeader\b/);
  assert.match(financialCode, /\bCoverageStrip\b/);
  assert.match(financialCode, /\bMetricTile\b/);
  assert.match(financialCode, /\bDataQualityRow\b/);
  assert.match(financialCode, /\bChartFrame\b/);
  assert.match(financialCode, /\bRankedBars\b/);
  assert.match(financialCode, /\bTimeSeries\b/);

  assert.match(performanceCode, /from "\.\/overview-shared"/);
  assert.match(performanceCode, /\bCohortHeader\b/);
  assert.match(performanceCode, /\bChartFrame\b/);
  assert.match(performanceCode, /\bTimeSeries\b/);
  assert.match(performanceCode, /\bGroupedColumns\b/);
});

/* ══ 2. §3.1 — the subtitle, verbatim ═════════════════════════════════════ */

test("the financial subtitle says who invoices the client, word for word", async () => {
  /*
   * §3.1. Maintsupp does not mark up trades and the client's finance team will
   * read this line as a statement about their own liabilities. It is pinned
   * character for character — including the apostrophe and the em dash —
   * because a "tidy-up" that turned "your contractors' charges" into "our
   * charges" would be a commercial misstatement, not a copy edit.
   */
  assert.equal(
    helpers.SPEND_SUBTITLE,
    "Trade spend recorded against jobs. Contractors invoice you directly, so these are your " +
      "contractors' charges — Maintsupp coordination fees are not included here.",
  );
});

test("the subtitle is written once and handed to the shared header", async () => {
  /* §3.1: "Subtitle, once". Two copies are two places for it to drift. */
  const declarations = financialSource.match(/SPEND_SUBTITLE\s*=/g) ?? [];
  assert.equal(declarations.length, 1, "SPEND_SUBTITLE is declared exactly once");
  assert.match(financialCode, /subtitle=\{SPEND_SUBTITLE\}/);
});

test("the card states §3.1's definition of spend: not invoiced, not quoted", async () => {
  assert.match(financialCode, /not an invoiced amount and not a quoted/);
  assert.match(financialCode, /A job with no cost recorded contributes zero/);
});

/* ══ 3. §3.2 — coverage first, and the confidence banner ══════════════════ */

test("coverage is rendered before any total", async () => {
  /*
   * §3.2 — "Rebuild so coverage is read first." The old card put £26,557 at
   * the top and the 6% that produced it nowhere at all. Source order is the
   * render order here, so it is the thing to assert.
   */
  const coverageAt = financialCode.indexOf("<CoverageStrip");
  const firstTileAt = financialCode.indexOf("<MetricTile");
  assert.ok(coverageAt > 0, "the coverage strip is rendered");
  assert.ok(firstTileAt > 0, "the headline tiles are rendered");
  assert.ok(
    coverageAt < firstTileAt,
    "the coverage strip must come before the first headline figure",
  );
});

test("the confidence banner fires at §3.2's thresholds and nowhere else", async () => {
  const under = helpers.costBanner(6);
  assert.equal(
    under,
    "Cost data covers 6% of jobs in this period. Treat these figures as indicative, not as portfolio spend.",
    "under 40% the amber sentence is the brief's, verbatim",
  );
  assert.ok(helpers.costBanner(39), "39% is still under the amber threshold");
  assert.match(helpers.costBanner(40) ?? "", /partial view of trade spend/, "40% is the quiet note");
  assert.match(helpers.costBanner(75) ?? "", /partial view of trade spend/, "75% is still the note");
  assert.equal(helpers.costBanner(76), undefined, "over 75% there is no banner at all");
  assert.equal(helpers.costBanner(100), undefined);
});

test("the banner's share and the strip's tone come from one implementation", async () => {
  /*
   * `CoverageStrip` decides amber/quiet/none from `sharesOfRecorded` over the
   * same two numbers. If the card computed its share any other way the
   * sentence could say 41% over an amber banner.
   */
  assert.match(financialCode, /sharesOfRecorded\(\[\s*Math\.max\(0, data\.costedJobs\)/);
  assert.doesNotMatch(
    financialCode,
    /costedJobs\s*\/\s*data\.cohortTotal/,
    "§1.4 has one percentage implementation and this card is not allowed a second",
  );
});

test("the totals still render at low coverage", async () => {
  /*
   * §3.2: "Do not hide the numbers at low coverage and do not fake precision."
   * A card that hid its totals under 40% would be answering a different
   * question from the one the reader asked.
   */
  const bannerAt = financialCode.indexOf("banner={banner}");
  const spendTileAt = financialCode.indexOf('label="Recorded spend"');
  assert.ok(bannerAt > 0 && spendTileAt > bannerAt);
  assert.doesNotMatch(
    financialCode,
    /coverageShare\s*<\s*40\s*\?\s*null/,
    "no figure is suppressed by the coverage threshold",
  );
});

test('"Add missing costs" opens the records panel for cohort jobs with no cost', async () => {
  assert.match(financialCode, /actionLabel="Add missing costs →"/);
  assert.match(financialCode, /onOpenRecords\("no_cost"\)/);
});

/* ══ 4. §3.3 and gate 17 — every budget element is gone ═══════════════════ */

test("no budget element survives anywhere in the financial card", async () => {
  /*
   * Gate 17. The card this replaces rendered "Aldgate 898%" by comparing a
   * 90-day spend with a pro-rated annual budget that half the estate did not
   * have — a data fault rendered as a metric. §3.3 deletes the presentation
   * and §8 keeps the data, so this asserts the first without touching the
   * second: nothing here reads a budget field or prints the word.
   */
  for (const forbidden of [
    /budget/i,
    /pro-?rat/i,
    /annualBudget/,
    /proRatedBudget/,
    /sitesWithoutBudget/,
    /utilisation/i,
  ]) {
    assert.doesNotMatch(
      financialCode,
      forbidden,
      `${forbidden} belongs to the deleted budget block — §3.3 removes the presentation entirely`,
    );
  }
});

test("the Period / Annual toggle survives and says which window it is showing", async () => {
  /* §3.3 — "label the header when active so the two modes cannot be confused". */
  assert.match(financialCode, /aria-pressed=\{basis === "period"\}/);
  assert.match(financialCode, /aria-pressed=\{basis === "annual"\}/);
  assert.match(financialCode, /rolling 12 months/i);
  assert.match(
    financialCode,
    /the page date range does not apply/,
    "Annual ignores the page range and has to say so",
  );
});

test("the median is labelled as a median and the mean is never printed", async () => {
  /* §3.3.3 — "Median cost per job — median, labelled as such." */
  assert.match(financialCode, /label="Median cost per job"/);
  assert.match(financialCode, /A median, not an average/);
  assert.doesNotMatch(
    financialCode,
    /averageCostPence|meanCost/,
    "an average job cost is one 200-day outlier away from being nonsense",
  );
});

test("the largest single job links to the job", async () => {
  assert.match(financialCode, /onOpenJob\(largest\.id\)/);
});

test("the spend trend carries a jobs-with-cost line beside the spend columns", async () => {
  /*
   * §3.3 — without the count line, a spike caused by more jobs and a spike
   * caused by dearer jobs are the same picture.
   */
  assert.match(financialCode, /key: "spend"/);
  /* Prettier puts the key and the label on their own lines; the assertion still
     requires both inside ONE object literal, which is the contract. */
  assert.match(financialCode, /key: "jobs",\s*label: "Jobs with cost"/s);
});

/* ══ 5. §3.4 — spend by site ══════════════════════════════════════════════ */

test('a site with no costed jobs reads "No cost data", never £0', async () => {
  /*
   * §3.4, and §1.5's whole argument in one row: "£0 is a fact; no data is not."
   * A store that spent nothing and a store nobody entered a cost for are two
   * different findings and only one of them is good news.
   */
  assert.match(
    financialCode,
    /format=\{\(value\) => \(value <= 0 \? "No cost data" : money\(value\)\)\}/,
    "the formatter is where £0.00 would otherwise be printed",
  );
  assert.match(
    financialCode,
    /notRecorded: site\.costedJobs === 0/,
    "and the row carries no percentage either — it was never in the denominator",
  );
  assert.match(financialCode, /site\.medianPence === null \? "No cost data"/);
});

test("every field §3.4 names is in the row", async () => {
  assert.match(financialCode, /jobs with cost/);
  assert.match(financialCode, /median/);
  assert.match(financialCode, /coverage/);
  assert.match(financialCode, /site\.coveragePercent/);
});

test("the portfolio median is marked, on the per-job axis", async () => {
  /*
   * §3.4 asks for the portfolio median marked on each bar. The ranked bar
   * carries a site's TOTAL spend and the median is per job, so a mark at
   * `median / maxSiteSpend` would be a hairline whose position says nothing.
   * The mark is on the per-job track instead — the only axis on which "this
   * site runs expensive per job" is readable — and it is on EVERY row.
   */
  assert.match(financialCode, /portfolioMarkerAt/);
  assert.match(financialCode, /className="ova-median__marker"/);
  assert.match(financialCode, /medianStanding\(site\.medianPence, data\.portfolioMedianPence\)/);
  assert.equal(helpers.medianStanding(30000, 25750), "above");
  assert.equal(helpers.medianStanding(10000, 25750), "below");
  assert.equal(helpers.medianStanding(25750, 25750), "level");
  assert.equal(
    helpers.medianStanding(null, 25750),
    null,
    "a site with no costed job is not 'average', it is unmeasured",
  );
  assert.equal(helpers.medianStanding(30000, null), null);
});

test("the unassigned bucket is reconciled in words, not ranked as a location", async () => {
  /*
   * §6.1 — "It is a broken foreign key, not a location, and ranking it against
   * real stores distorts the card." The same is true here, so it is filtered
   * out of the ranking and every pound of it is accounted for in a sentence
   * with a Fix action.
   */
  assert.match(financialCode, /data\.sites\.filter\(\(site\) => !site\.unassigned\)/);
  assert.match(financialCode, /with no site in the register/);
  assert.match(financialCode, /onOpenRecords\("no_site"\)/);
});

/* ══ 6. §3.5 — where the money goes ═══════════════════════════════════════ */

test("the money breakdowns are formatted as money, not as raw pence", async () => {
  /*
   * `BreakdownDimension.recorded` carries PENCE for these three, so the shared
   * `BreakdownSection` would head them "534200 of 534200 recorded (100%)" and
   * draw bars reading "534200". `MoneyBreakdown` composes the same
   * `ChartFrame` and `RankedBars` with a formatter instead. If
   * `BreakdownSection` ever takes a `format`, re-point this at it.
   */
  assert.match(financialCode, /function MoneyBreakdown\(/);
  assert.match(financialCode, /format=\{money\}/);
  assert.match(financialCode, /recorded spend/);
  assert.doesNotMatch(
    financialCode,
    /<BreakdownSection[\s\S]*?dimension=\{data\.by/,
    "a money dimension through the count-shaped section prints pence as a job count",
  );
});

test("the sentence beneath the breakdowns is derived, never hard-coded", async () => {
  /* §3.5 — "Beneath, one derived sentence". */
  assert.match(financialCode, /spendConcentration\(data\.byLabel\)/);
  const sentence = helpers.spendConcentration({
    key: "label",
    label: "Spend by label",
    /*
     * THE BUCKETS SUM TO `recorded`, and that is not decoration.
     *
     * The helper takes its denominator from the buckets it is handed, so the
     * sentence can never disagree with the bars the reader is looking at — the
     * one property worth having here. That is only the same number as
     * "% of recorded spend" when the buckets partition the recorded total,
     * which every payload `loadCost` produces does and which this fixture must
     * therefore do too. 175000 + 114200 + 68000 = 357200.
     */
    recorded: 357200,
    total: 357200,
    buckets: [
      { key: "Electrical", label: "Electrical", value: 175000, share: 49, colour: "", notRecorded: false },
      { key: "Glass", label: "Glass", value: 114200, share: 32, colour: "", notRecorded: false },
      { key: "Compliance", label: "Compliance", value: 68000, share: 19, colour: "", notRecorded: false },
    ],
    note: "",
    warning: null,
  });
  /* 49 + 32, from `sharesOfRecorded`, which corrects its rounding drift onto
     the largest slice so the three still sum to 100. */
  assert.equal(sentence, "Electrical and Glass account for 81% of recorded spend.");
  assert.equal(
    helpers.spendConcentration({ recorded: 0, buckets: [], note: "", warning: null }),
    "",
    "nothing recorded is nothing to say, not a sentence about zero",
  );
});

/* ══ 7. §3.6 — contractor spend ═══════════════════════════════════════════ */

test("every contractor row carries a chip, in both cases", async () => {
  /*
   * §3.6. A chip that appeared only on failures would teach the reader that a
   * row without one had never been checked — which is precisely the state the
   * old card left contractor scoring in.
   */
  assert.match(financialCode, /row\.linked \? "Linked" : "Not linked"/);
  assert.match(
    financialCode,
    /muted: !row\.linked/,
    "§3.6 — not-linked rows render muted with no bar fill, so they never read as verified",
  );
});

test("the contractor header states the real attribution, with its denominators", async () => {
  /* §3.6's sentence and §1.4's rule: never a percentage whose base is off screen. */
  assert.match(financialCode, /names a contractor/);
  assert.match(financialCode, /attributed to a contractor record/);
  assert.match(financialCode, /\{attributionShare\}%/);
  assert.match(financialCode, /exact\(data\.contractorAttributedPence\)/);
  assert.match(financialCode, /exact\(data\.totalSpendPence\)/);
});

test('"Resolve names" reaches the linking tool', async () => {
  assert.match(financialCode, /Resolve names →/);
  assert.match(financialCode, /onClick=\{onOpenResolveNames\}/);
});

/* ══ 8. §3.7 and gate 21 — data quality, and the link that must not exist ═ */

test("the compliance register link does not appear in the financial card", async () => {
  /*
   * Gate 21, and defect 4 in §7. It belongs on the Compliance page; in a
   * financial card it is a navigation dead end that says the two are related.
   * Pinned because a link that drifted back would pass every other check here.
   */
  assert.doesNotMatch(financialSource, /compliance register/i);
  assert.doesNotMatch(financialCode, /onNavigateToCompliance/);
});

test("the data-quality row covers §3.7's four counts and each one acts", async () => {
  for (const [key, action] of [
    ["completedWithoutCost", 'onOpenRecords("completed_without_cost")'],
    ["costWithoutContractor", 'onOpenRecords("cost_without_contractor")'],
    ["unlinkedNames", "onOpenResolveNames"],
    ["zeroOrNegative", 'onOpenRecords("zero_or_negative_cost")'],
  ]) {
    assert.ok(
      financialCode.includes(`data.dataQuality.${key}`),
      `§3.7 lists ${key} and it must be counted`,
    );
    assert.ok(financialCode.includes(action), `${key} must have a working action`);
  }
});

/* ══ 9. §1.5 and §9.10 — three states, three appearances ══════════════════ */

test("the financial card's loading, error and empty states are three different pictures", async () => {
  /*
   * "A failure must never look like a zero." The error branch is the server's
   * OWN sentence with a Retry; the loading branch is a skeleton at the
   * finished height; the empty branch is a labelled sentence inside
   * `ChartFrame`. No two of them share a rendering.
   */
  assert.match(financialCode, /if \(state\.error\) \{/);
  assert.match(financialCode, /error=\{state\.error\} onRetry=\{state\.reload\}/);
  assert.match(financialCode, /if \(!data\) \{/);
  assert.match(financialCode, /<SkeletonRow/);
  assert.match(financialCode, /emptyLabel=/);
  assert.doesNotMatch(
    financialCode,
    /state\.error[\s\S]{0,80}<EmptyState/,
    "an error is never drawn as an empty state",
  );
});

test("the performance card's three states are distinct and the failure carries the server's words", async () => {
  /*
   * §4.1 — this is the card that used to render nothing BUT a failure, so the
   * distinction is the rebuild's whole point.
   */
  assert.match(performanceCode, /loading=\{loading\}/);
  assert.match(performanceCode, /error=\{state\.error\}/);
  assert.match(performanceCode, /onRetry=\{state\.reload\}/);
  assert.match(performanceCode, /empty=\{closeEmpty\}/);
  assert.match(performanceCode, /empty=\{measurable\.length === 0\}/);
  assert.match(performanceCode, /emptyLabel=/);
  assert.match(
    performanceCode,
    /const loading = !data && !state\.error/,
    "a failed query is never also 'still loading'",
  );
});

/* ══ 10. §4.2 — bucketing and axis labels come from the payload ═══════════ */

test("the axis labels are the payload's real dates, never 'Week 1'", async () => {
  assert.doesNotMatch(performanceCode, /Week \d|week \d/);
  assert.match(performanceCode, /label: bucket\.label/);
  assert.match(performanceCode, /start: bucket\.start/);
  assert.match(
    performanceCode,
    /data\.bucketing/,
    "§4.2 — the bucketing is the server's decision and the header states it",
  );
});

/* ══ 11. §4.3 — time to close ═════════════════════════════════════════════ */

test("the lines are median and p90, and never the mean", async () => {
  assert.match(performanceCode, /key: "median"/);
  assert.match(performanceCode, /key: "p90"/);
  assert.match(performanceCode, /dashed: true/, "the p90 is the lighter, second line");
  assert.match(performanceSource, /A median, not a mean/);
  assert.doesNotMatch(
    performanceCode,
    /averageDays|meanDays/,
    "one 200-day job would distort every mean bucket it landed in",
  );
});

test("a bucket with fewer than three completed jobs passes null, not a number", async () => {
  /*
   * §4.3 and gate 23. A median of one job is noise drawn as a trend, and a
   * solid line through it asserts a value nobody measured. The floor is
   * enforced twice: `sampledValue` nulls the point on the way in, and
   * `minSample` stops `TimeSeries` joining across the gap with a solid line.
   */
  assert.equal(helpers.MIN_SAMPLE, 3);
  assert.equal(helpers.sampledValue(9, 3), 9);
  assert.equal(helpers.sampledValue(9, 2), null, "two jobs is not a trend");
  assert.equal(helpers.sampledValue(9, 0), null);
  assert.equal(helpers.sampledValue(null, 9), null, "a missing median stays missing");
  assert.match(performanceCode, /sampledValue\(bucket\.medianDays, bucket\.sample\)/);
  assert.match(performanceCode, /sampledValue\(bucket\.p90Days, bucket\.sample\)/);
  assert.match(performanceCode, /minSample=\{MIN_SAMPLE\}/);
});

test("the split by priority applies the sample floor per priority, not per bucket", async () => {
  /*
   * `TimeSeries` can only see the BUCKET's sample. A bucket of twelve holding
   * one urgent job would otherwise draw that single job as an urgent trend.
   */
  assert.match(performanceCode, /sampledValue\(row\.medianDays, row\.sample\)/);
  assert.match(performanceCode, /OVERVIEW_PRIORITY_COLOUR/);
  assert.match(performanceCode, /onClick=\{onToggleSplit\}/);
});

test("the open-jobs exclusion is stated beneath the chart", async () => {
  /* §4.3 and gate 23: "57 jobs still open and not included." */
  assert.match(performanceCode, /still open and not included/);
  assert.match(performanceCode, /close\.openExcluded/);
});

test("median, p90 and the change against the previous period are shown beneath", async () => {
  assert.match(performanceCode, /label="Median days to close"/);
  assert.match(performanceCode, /label="p90 days to close"/);
  assert.match(performanceCode, /previous=\{close\.previousMedianDays\}/);
  assert.match(performanceCode, /previous=\{close\.previousP90Days\}/);
});

/* ══ 12. §4.4 — the SLA trend ═════════════════════════════════════════════ */

test("only measurable stages are drawn, and an unmeasurable one prints its reason", async () => {
  /*
   * §4.4 and gate 24. "A stage with no timestamp shows 'Not measured — no
   * timestamp recorded', never 0% or 100%." A zero column and an unmeasured
   * stage are the same picture once drawn, and one of them says the team
   * missed every target it was ever set.
   */
  assert.match(
    performanceCode,
    /data\.sla\.stages\.filter\(\(stage\) => stage\.measurable\)/,
    "the chart series are built from the measurable stages only",
  );
  assert.match(performanceCode, /series=\{measurable\.map\(/);
  assert.match(performanceCode, /stage\.reason \?\? "Not measured — no timestamp recorded"/);
});

test("an unmeasurable stage's branch prints no percentage of any kind", async () => {
  /*
   * The ternary is read directly: whatever the FALSE arm renders is what an
   * unmeasurable stage shows, and it must contain no percent sign and no
   * `stage.percent`.
   */
  const at = performanceCode.indexOf("{stage.measurable ? (");
  assert.ok(at > 0, "the per-stage branch has moved; re-point this test at it");
  const branch = performanceCode.slice(at, performanceCode.indexOf("</li>", at));
  const elseArm = branch.slice(branch.indexOf(") : ("));
  assert.doesNotMatch(elseArm, /stage\.percent/, "no percentage is read for an unmeasured stage");
  assert.doesNotMatch(elseArm, /%/, "and none is printed either — not 0% and not 100%");
  assert.match(elseArm, /stage\.reason/);
});

test("each stage states its coverage through the shared sentence", async () => {
  /* §4.4 — "Show each stage's coverage", and §1.4's one implementation of it. */
  assert.match(performanceCode, /coverageSentence\(/);
  assert.match(performanceCode, /stage\.coverage\.measured/);
  assert.match(performanceCode, /stage\.coverage\.total/);
});

test("the configured targets are printed, in words, with their version", async () => {
  /*
   * §4.4 — targets live in a config table, are editable in Settings and are
   * versioned, "so changing a target does not silently rewrite past
   * performance". A reader cannot judge a score without seeing what it was
   * scored against.
   */
  assert.match(performanceCode, /data\.sla\.targets\.map/);
  assert.match(performanceCode, /targetWording\(target\.targetMinutes\)/);
  assert.match(performanceCode, /version \{target\.version\}/);
  assert.match(performanceSource, /edited in Settings and are versioned/);

  assert.equal(helpers.targetWording(30), "30 minutes");
  assert.equal(helpers.targetWording(1), "1 minute");
  assert.equal(helpers.targetWording(60), "1 hour");
  assert.equal(helpers.targetWording(90), "1.5 hours");
  assert.equal(helpers.targetWording(480), "8 hours");
  assert.equal(helpers.targetWording(1440), "1 day");
  assert.equal(helpers.targetWording(2880), "2 days");
});

test("the on-time change is stated in points, and a null is a dash and a reason", async () => {
  assert.equal(
    helpers.pointsChange(45, 40),
    "up 5 points on the previous period (40%)",
    "a percentage that moved 40 → 45 went up five POINTS, not five percent",
  );
  assert.equal(helpers.pointsChange(40, 45), "down 5 points on the previous period (45%)");
  assert.equal(helpers.pointsChange(40, 40), "level with the previous period (40%)");
  assert.equal(helpers.pointsChange(40, null), null, "§1.5 — nothing to compare is not 'no change'");
  assert.equal(helpers.pointsChange(null, 40), null);
  assert.match(
    performanceCode,
    /data\.sla\.overallPercent === null \? "—"/,
    "an unmeasurable range prints a dash, never a zero score",
  );
  assert.match(performanceCode, /That is missing data, not a score of zero/);
});

/* ══ 13. §1.3 — the palette ═══════════════════════════════════════════════ */

test("neither card reaches for a retired colour", async () => {
  /*
   * §1.3 retires the arbitrary palette — gold, cyan, pink, purple, assorted
   * blues — from the whole page, and forbids reusing the Jobs board's 23
   * status colours. Every colour in these two cards comes from
   * `overview-meters.ts` or from a `--ms-*` token.
   */
  for (const source of [financialCode, performanceCode]) {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, "no card declares its own hex");
    assert.doesNotMatch(source, /categoricalColour/, "§1.3 retires the hashed categorical palette");
    assert.doesNotMatch(source, /FAMILY_COLOUR|STATUS_COLOUR|PRIORITY_BANDS/);
  }
  assert.match(financialCode, /from "\.\.\/\.\.\/\.\.\/lib\/overview-meters"/);
  assert.match(performanceCode, /from "\.\.\/\.\.\/\.\.\/lib\/overview-meters"/);
});

/* ══ 14. The stylesheet ═══════════════════════════════════════════════════ */

test("overview-analysis.css uses only the agreed breakpoints", async () => {
  const widths = [...stylesSource.matchAll(/\(min-width:\s*(\d+)px\)|\(max-width:\s*(\d+)px\)/g)].map(
    (match) => Number(match[1] ?? match[2]),
  );
  assert.ok(widths.length > 0, "the stylesheet is responsive");
  for (const width of widths) {
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${width}px is not one of the agreed breakpoints — several stage tests fail on any other`,
    );
  }
});

test("overview-analysis.css contains no hex literal and no raw colour of any kind", async () => {
  const css = codeOnly(stylesSource);
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "colours that come from data arrive as an inline style, never from CSS");
  assert.doesNotMatch(css, /rgba?\(/, "a raw rgb() is a hex by another name and does not follow the theme");
  assert.doesNotMatch(css, /hsla?\(/);
  for (const named of ["white", "black", "red", "green"]) {
    assert.doesNotMatch(css, new RegExp(`:\\s*${named}\\b`), `${named} is not a theme-aware colour`);
  }
});

test("the controls these two cards add clear §1.8's 44px floor", async () => {
  /*
   * `ops-option` — the pill the old Cost card used for Period/Annual — is
   * 36px, which is under the floor. Both new controls are their own, at 44.
   */
  assert.match(stylesSource, /\.ova-switch__button \{[\s\S]*?min-height: 44px/);
  assert.match(stylesSource, /\.ova-action \{[\s\S]*?min-height: 44px/);
});

test("figures in these cards are tabular", async () => {
  /* §1.9 — a count that changes width on refresh makes a whole column jump. */
  const tabular = stylesSource.match(/font-variant-numeric: tabular-nums/g) ?? [];
  assert.ok(tabular.length >= 5, "every rule holding a number sets tabular figures");
});

test("both cards load the stylesheet they are written against", async () => {
  for (const source of [financialCode, performanceCode]) {
    assert.match(source, /import analysisCss from "\.\/overview-analysis\.css\?url"/);
    assert.match(source, /<link rel="stylesheet" href=\{analysisCss\} precedence="default" \/>/);
  }
});
