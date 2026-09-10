/**
 * THE OVERVIEW'S SHARED COMPONENTS — the contract other cards are built on.
 *
 * `overview-shared.tsx` and `overview-charts.tsx` are consumed by every section
 * of the rebuilt Operations Overview, so their prop names are an interface
 * several people code against at once and their rules — the percentage rule,
 * the three states, the touch behaviour — are rules the whole page inherits.
 * Both are asserted here.
 *
 * TWO KINDS OF TEST, following `tests/ops-rebuild-foundations.test.mjs`:
 *
 *   • The BEHAVIOURAL ones run the shipped code. React cannot be mounted in
 *     `node:test` here — there is no DOM and no renderer in the dependency list
 *     — so the pure helpers are sliced out of the two `.tsx` files by name,
 *     stripped of their types by the compiler the repo already carries, and
 *     called. The slice is real shipped source: a re-implementation could agree
 *     with itself while the product is wrong.
 *
 *   • The STRUCTURAL ones read source, because "the not-recorded bucket carries
 *     no percentage" and "a failure never looks like a zero" are statements
 *     about what is rendered and the only way to hold them without a DOM is to
 *     look. When a refactor invalidates one, RE-POINT it at the contract's new
 *     home with the reason written in — never delete it.
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
 * which a CRLF file does not contain. See the same note in
 * `tests/ops-rebuild-foundations.test.mjs`.
 */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the rules they explain; every source check strips them. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CHARTS = "app/(app)/portal/ops/overview-charts.tsx";
const SHARED = "app/(app)/portal/ops/overview-shared.tsx";
const STYLES = "app/(app)/portal/ops/overview.css";

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

const strip = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const chartsSource = await read(CHARTS);
const sharedSource = await read(SHARED);
const stylesSource = await read(STYLES);
const metersSource = await read("app/lib/overview-meters.ts");
const primitivesSource = await read("app/(app)/portal/ops/ops-primitives.tsx");

/*
 * `sharesOfRecorded` and `money` are sliced rather than imported for the reason
 * the memory of this repo records: `app/lib/overview-meters.ts` imports
 * `./job-metrics`, and a bare specifier cannot be resolved from a `data:` URL.
 * Slicing keeps this file from needing an import graph at all.
 */
const helpers = new Function(
  `${strip(
    [
      slice(metersSource, "sharesOfRecorded"),
      slice(primitivesSource, "money"),
      slice(chartsSource, "donutSegmentPath"),
      slice(chartsSource, "scrubIndexAt"),
      slice(chartsSource, "sharesExcludingNotRecorded"),
      slice(chartsSource, "niceCeiling"),
      slice(sharedSource, "abbreviateNumber"),
      slice(sharedSource, "formatCount"),
      slice(sharedSource, "formatMoneyPence"),
    ].join("\n\n"),
  )}
   return { sharesOfRecorded, money, donutSegmentPath, scrubIndexAt,
            sharesExcludingNotRecorded, niceCeiling, abbreviateNumber,
            formatCount, formatMoneyPence };`,
)();

/* ── 1. The component API other agents are coding against ─────────────────── */

test("every agreed component is exported from the file that owns it", async () => {
  for (const name of [
    "CohortHeader",
    "SeverityBar",
    "MetricTile",
    "BreakdownSection",
    "DataQualityRow",
    "ChartFrame",
    "CoverageStrip",
    "useAbbreviatedNumbers",
    "formatCount",
    "formatMoneyPence",
  ]) {
    assert.match(
      sharedSource,
      new RegExp(`export function ${name}\\(`),
      `${name} is part of the shared contract and must stay exported from overview-shared.tsx`,
    );
  }
  for (const name of ["SegmentedBar", "Donut", "RankedBars", "TimeSeries", "GroupedColumns"]) {
    assert.match(
      chartsSource,
      new RegExp(`export function ${name}\\(`),
      `${name} is part of the chart contract and must stay exported from overview-charts.tsx`,
    );
  }
});

test("each component still takes the props it was agreed with", async () => {
  /*
   * The signature is the interface. A renamed prop is a silent break for every
   * card already written against it, so the names are pinned one by one.
   */
  const props = (source, component, names) => {
    const at = source.indexOf(`export function ${component}(`);
    const body = source.slice(at, source.indexOf("\n}", at));
    for (const name of names) {
      assert.match(
        body,
        new RegExp(`(^|[\\s{,])${name}[,?:\\s}]`, "m"),
        `${component} must still accept "${name}"`,
      );
    }
  };
  props(sharedSource, "CohortHeader", [
    "title",
    "total",
    "measure",
    "filterChips",
    "action",
    "id",
    "subtitle",
  ]);
  props(sharedSource, "SeverityBar", ["counts", "showNumbers", "size", "onSelect", "label"]);
  props(sharedSource, "MetricTile", [
    "label",
    "value",
    "accent",
    "share",
    "delta",
    "previous",
    "footnote",
    "severity",
    "onSelect",
    "accessibleValue",
  ]);
  props(sharedSource, "BreakdownSection", [
    "dimension",
    "splitByPriority",
    "onToggleSplit",
    "onSelect",
    "onDrill",
    "onFix",
    "forceShape",
    "initialLimit",
  ]);
  props(sharedSource, "DataQualityRow", ["items"]);
  props(sharedSource, "ChartFrame", [
    "title",
    "loading",
    "error",
    "onRetry",
    "empty",
    "emptyLabel",
    "table",
    "minHeight",
    "children",
  ]);
  props(sharedSource, "CoverageStrip", [
    "recorded",
    "total",
    "label",
    "actionLabel",
    "onAction",
    "banner",
  ]);
  props(chartsSource, "SegmentedBar", ["segments", "total", "onSelect", "label"]);
  props(chartsSource, "Donut", ["segments", "centreValue", "centreLabel", "onSelect", "label"]);
  props(chartsSource, "RankedBars", [
    "rows",
    "splitByPriority",
    "marker",
    "max",
    "onSelect",
    "onDrill",
    "format",
  ]);
  props(chartsSource, "TimeSeries", [
    "buckets",
    "columns",
    "lines",
    "formatValue",
    "onSelectBucket",
    "label",
    "minSample",
  ]);
  props(chartsSource, "GroupedColumns", ["buckets", "series", "onSelectBucket", "label", "suffix"]);
});

/* ── 2. §1.4 — the percentage rule, and the grey bucket ───────────────────── */

test("no percentage is derived here; the shared implementation is called", async () => {
  const charts = codeOnly(chartsSource);
  const shared = codeOnly(sharedSource);
  assert.match(charts, /import \{[\s\S]*sharesOfRecorded[\s\S]*\} from "\.\.\/\.\.\/\.\.\/lib\/overview-meters"/);
  assert.match(shared, /sharesOfRecorded/, "the shared components ask the one implementation");
  assert.match(shared, /coverageSentence\(/, "coverage is stated by the shared implementation");
  // §1.4's last line: the denominator has to be on screen. The breakdown header
  // IS that denominator, so it is `coverageSentence` and not a bare title.
  assert.match(
    shared,
    /<h3 className="ovw-breakdown__title">\s*\{\s*coverageSentence\(/,
    "the breakdown header must print coverage, not a bare label",
  );
});

test("sharesExcludingNotRecorded keeps the grey bucket out of the denominator", async () => {
  const { sharesExcludingNotRecorded } = helpers;
  // §1.4's own worked example: Handyman 110 of 193 recorded reads 57%.
  assert.deepEqual(sharesExcludingNotRecorded([110, 83, 33], [false, false, true]), [57, 43, null]);
  assert.deepEqual(sharesExcludingNotRecorded([10, 20, 70], [false, false, false]), [10, 20, 70]);
  // The correction lands on the LARGEST slice, so three equal thirds are 34/33/33.
  assert.deepEqual(sharesExcludingNotRecorded([1, 1, 1], [false, false, false]), [34, 33, 33]);
  // A breakdown with nothing recorded still has to draw its legend.
  assert.deepEqual(sharesExcludingNotRecorded([0, 0], [false, false]), [0, 0]);
  assert.deepEqual(sharesExcludingNotRecorded([5], [true]), [null], "an excluded value has no share");
  assert.deepEqual(sharesExcludingNotRecorded([], []), []);
  for (const share of sharesExcludingNotRecorded([9, 9, 9, 9], [true, true, true, true])) {
    assert.equal(share, null, "nothing recorded means no percentage anywhere");
  }
});

test("the not-recorded bucket renders a grey count, no percentage, and a Fix action", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("ovw-breakdown__not-recorded");
  assert.ok(at > 0, "BreakdownSection must still render the not-recorded line");
  const block = shared.slice(at, shared.indexOf("</p>", at));
  assert.doesNotMatch(block, /%/, "§1.5: the grey count never carries a percentage");
  assert.match(block, /NOT_RECORDED_INK/, "§1.3: the grey is the shared one, never a category colour");
  assert.match(block, /Not recorded — \{notRecorded\} jobs/);
  assert.match(shared, /Fix these →/, "§1.5: every not-recorded count has a working Fix action");

  // The charts refuse to print one too, rather than trusting the caller.
  const charts = codeOnly(chartsSource);
  assert.match(
    charts,
    /shares\[index\] === null \? null : \(/,
    "the segmented bar's legend prints no share for an excluded segment",
  );
  assert.match(charts, /ovw-legend__share--none/, "the donut says the words instead");
  assert.match(charts, /ovw-ranked__share--none/, "so does the ranked list");
  assert.match(
    charts,
    /const percentText = \(share.*\) =>\s*\(share === null \? "" : /,
    "the readout drops the percentage as well as the paint",
  );
});

/* ── 3. §1.5 — loading, empty and error are three different pictures ──────── */

test("ChartFrame draws three distinct states and reuses the shared ones", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function ChartFrame(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  for (const marker of [
    "ovw-frame__state--loading",
    "ovw-frame__state--error",
    "ovw-frame__state--empty",
  ]) {
    assert.match(body, new RegExp(marker), `${marker} is one of the three states §9.10 requires`);
  }
  assert.match(body, /<SkeletonRow/, "loading is a skeleton shaped like the chart, not a spinner");
  assert.match(body, /<ErrorState/, "an error names what failed and offers a retry");
  assert.match(body, /<EmptyState/, "an empty result is labelled, not blank");
  assert.match(body, /role="alert"/, "a failure is announced");
  assert.match(
    body,
    /if \(loading\)[\s\S]*else if \(error\)[\s\S]*else if \(empty\)/,
    "the three are mutually exclusive branches, so a failure can never render as a zero",
  );
  // §9.44 — the skeleton occupies the final dimensions.
  assert.match(body, /const reserved = minHeight \?\? 200;/);
  assert.match(body, /style=\{\{ minHeight: reserved \}\}/);

  // Three different appearances, not three different words on one appearance.
  const css = codeOnly(stylesSource);
  for (const rule of [
    ".ovw-frame__state--loading",
    ".ovw-frame__state--empty",
    ".ovw-frame__state--error",
  ]) {
    assert.ok(css.includes(rule), `${rule} needs a look of its own`);
  }
});

test("every chart has a text alternative and it is not duplicated", async () => {
  const shared = codeOnly(sharedSource);
  assert.match(shared, /import \{[\s\S]*HiddenDataTable[\s\S]*\} from "\.\/ops-primitives"/);
  const at = shared.indexOf("export function ChartFrame(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(body, /<HiddenDataTable\s+caption=\{table\.caption\}/);
  assert.match(body, /aria-pressed=\{showTable\}/, "the toggle reports its own state");
  assert.match(
    body,
    /showTable \? \([\s\S]*<table>[\s\S]*\) : \([\s\S]*<HiddenDataTable/,
    "open swaps the visible table IN and the hidden one OUT, so the numbers are in the accessibility tree exactly once",
  );
  /*
   * EVERY `<svg>` IS HIDDEN FROM THE READER, and the count is derived rather
   * than typed so adding a sixth chart cannot quietly ship a picture with no
   * words. Two today: the donut's ring and the time series' lines. The other
   * three charts are HTML boxes and have no svg at all.
   */
  const charts = codeOnly(chartsSource);
  const svgs = (charts.match(/<svg\b/g) ?? []).length;
  assert.equal(svgs, 2, "the donut and the time series are the only two that draw an svg");
  assert.equal(
    (charts.match(/aria-hidden="true"\n\s+focusable="false"/g) ?? []).length,
    svgs,
    "each drawn svg is hidden from the reader; the labelled wrapper carries the words",
  );
  /*
   * `role="img"` MAKES ITS SUBTREE PRESENTATIONAL, so it may only wrap a
   * subtree with no controls in it. `ops-primitives.tsx` sets the convention —
   * `role="img"` plus `aria-label={`${label}: ${readout}`}` — and the donut's
   * centre is the one place in this file that qualifies. Every other wrapper
   * holds `<button>`s a keyboard reader has to reach, so it is `role="group"`
   * with the same label. Getting this wrong is silent: the picture still draws
   * and the buttons simply stop existing for a screen reader.
   */
  assert.equal(
    (charts.match(/role="img"/g) ?? []).length,
    2,
    "two subtrees have no controls under them: the donut's centre, and a ranked row that was given no onSelect",
  );
  assert.match(
    charts,
    /<span className="ovw-ranked__hit" role="img" aria-label=\{description\}>/,
    "a row with no click handler is a picture of a number and says so",
  );
  assert.match(
    charts,
    /className="ovw-donut__centre"\s*\n\s*role="img"\s*\n\s*aria-label=\{`\$\{label\}: \$\{centreValue\} \$\{centreLabel\}\. \$\{readout\}`\}/,
    "§5.3: the recorded count in the middle is spoken as well as drawn",
  );
  for (const wrapper of [
    /className="ovw-segbar__track" role="group" aria-label=\{`\$\{label\}: \$\{readout\}`\}/,
    /className=\{`ovw-ts__plot[\s\S]{0,120}role="group"/,
    /className="ovw-grouped__plot" role="group"/,
  ]) {
    assert.match(charts, wrapper, "a wrapper holding buttons must be a group, never an image");
  }
});

/* ── 4. §1.8 — tap to pin, tap away to dismiss, drag to scrub ─────────────── */

test("the tooltip pins on tap and dismisses on a tap outside or Escape", async () => {
  const charts = codeOnly(chartsSource);
  assert.match(charts, /export function useTapToPin</);
  assert.match(
    charts,
    /document\.addEventListener\("pointerdown", dismiss\)/,
    "a tap anywhere else closes the pinned tooltip",
  );
  assert.match(charts, /event\.key === "Escape"/, "§1.9: a keyboard reader can dismiss it too");
  assert.match(
    charts,
    /document\.removeEventListener\("pointerdown", dismiss\)/,
    "the listener is removed with the pin, not left on the document",
  );
  assert.match(charts, /const togglePin = useCallback/, "a second tap on the same target un-pins");
  // All five charts use it, so the behaviour cannot be present on some and not others.
  for (const component of ["SegmentedBar", "Donut", "RankedBars", "TimeSeries", "GroupedColumns"]) {
    const at = charts.indexOf(`export function ${component}(`);
    const body = charts.slice(at, charts.indexOf("\n}\n", at));
    if (component === "RankedBars") {
      // A ranked row prints its own numbers on the row, so it needs no tooltip.
      assert.match(body, /aria-label=\{description\}/, "the row states its full value instead");
      continue;
    }
    assert.match(body, /useTapToPin</, `${component} must pin on tap like the others`);
  }
});

test("the time series scrubs by drag, on touch as well as with a mouse", async () => {
  const charts = codeOnly(chartsSource);
  const at = charts.indexOf("export function TimeSeries(");
  const body = charts.slice(at, charts.indexOf("\n}\n", at));
  assert.match(body, /onPointerDown=\{\(event\) => \{/);
  assert.match(body, /setPointerCapture\(event\.pointerId\)/, "a drag keeps reporting after it leaves the column it started in");
  assert.match(body, /onPointerMove=\{move\}/);
  assert.match(body, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(body, /onPointerCancel=/, "a cancelled touch must not leave the chart scrubbing");
  assert.match(body, /scrubIndexAt\(event\.clientX, rect\.left, rect\.width, count\)/);
  const css = codeOnly(stylesSource);
  assert.match(
    css,
    /\.ovw-ts__scrub \{[^}]*touch-action: pan-y;/,
    "a vertical page scroll must still work through the chart",
  );
});

test("scrubIndexAt clamps at both ends and never returns a bucket that is not there", async () => {
  const { scrubIndexAt } = helpers;
  assert.equal(scrubIndexAt(0, 0, 100, 4), 0, "the left edge is the first bucket");
  assert.equal(scrubIndexAt(24.9, 0, 100, 4), 0);
  assert.equal(scrubIndexAt(25, 0, 100, 4), 1, "the boundary belongs to the bucket it opens");
  assert.equal(scrubIndexAt(99.9, 0, 100, 4), 3);
  assert.equal(scrubIndexAt(100, 0, 100, 4), 3, "the right edge is the LAST bucket, not count");
  assert.equal(scrubIndexAt(1000, 0, 100, 4), 3, "a drag past the end stays on the end");
  assert.equal(scrubIndexAt(-50, 0, 100, 4), 0, "and a drag before the start stays on the start");
  assert.equal(scrubIndexAt(210, 200, 100, 5), 0, "the plot's own left offset is honoured");
  assert.equal(scrubIndexAt(50, 0, 0, 4), -1, "a plot with no width reports nothing");
  assert.equal(scrubIndexAt(50, 0, 100, 0), -1, "a chart with no buckets reports nothing");
  assert.equal(scrubIndexAt(Number.NaN, 0, 100, 4), -1);
});

test("a desktop click drills and a touch tap pins, so no capability is desktop-only", async () => {
  const charts = codeOnly(chartsSource);
  assert.match(charts, /export function useHoverCapable\(\): boolean \{/);
  assert.match(charts, /useMediaQuery\("\(hover: hover\) and \(pointer: fine\)"\)/);
  assert.match(
    charts,
    /if \(hoverCapable && onSelect\) onSelect\(segment\.key\);\s*else togglePin\(segment\.key\);/,
    "the same gesture cannot both drill and explain, so the two inputs get the mapping that suits them",
  );
  assert.match(
    charts,
    /ovw-tip__action/,
    "the pinned tooltip carries the drill, which is how touch reaches it",
  );
  assert.match(
    charts,
    /const \[matches, setMatches\] = useState\(false\)/,
    "the default is touch: guessing desktop and being wrong costs a phone reader their tooltip",
  );
});

/* ── 5. §1.8 — abbreviation, with the full value kept ─────────────────────── */

test("formatCount abbreviates only when asked, and promotes rather than printing 1000k", async () => {
  const { formatCount } = helpers;
  assert.equal(formatCount(0, false), "0");
  assert.equal(formatCount(1234, false), "1,234", "unabbreviated is the en-GB grouping");
  assert.equal(formatCount(0, true), "0");
  assert.equal(formatCount(999, true), "999", "below a thousand there is nothing to abbreviate");
  assert.equal(formatCount(1000, true), "1k", "a whole thousand loses its .0");
  assert.equal(formatCount(1049, true), "1k");
  assert.equal(formatCount(1050, true), "1.1k");
  assert.equal(formatCount(12345, true), "12.3k");
  assert.equal(formatCount(999949, true), "999.9k");
  assert.equal(formatCount(999999, true), "1m", "the promotion boundary: never 1000.0k");
  assert.equal(formatCount(-1500, true), "-1.5k", "the sign survives abbreviation");
  assert.equal(formatCount(Number.NaN, true), "—", "§1.5: not a number is not a zero");
  assert.equal(formatCount(Number.POSITIVE_INFINITY, false), "—");
});

test("formatMoneyPence follows §3.7 — two decimals below £1,000, none above", async () => {
  const { formatMoneyPence } = helpers;
  assert.equal(formatMoneyPence(0, false), "£0.00", "£0 is a fact and it is printed as one");
  assert.equal(formatMoneyPence(99, false), "£0.99");
  assert.equal(formatMoneyPence(8300, false), "£83.00", "§3.6's £83 attributed to a contractor");
  assert.equal(formatMoneyPence(99999, false), "£999.99", "the last penny below the threshold");
  assert.equal(formatMoneyPence(100000, false), "£1,000", "and the first pound above it");
  assert.equal(formatMoneyPence(2655700, false), "£26,557", "§3.2's recorded spend");
  assert.equal(formatMoneyPence(2655700, true), "£26.6k", "§1.8's worked example");
  assert.equal(formatMoneyPence(99999, true), "£999.99", "abbreviation does not apply below £1,000");
  assert.equal(formatMoneyPence(-12345, false), "-£123.45");
  assert.equal(formatMoneyPence(-2655700, true), "-£26.6k");
  assert.equal(formatMoneyPence(Number.NaN, false), "—");
});

test("the full value reaches the accessible label even when the figure is abbreviated", async () => {
  const shared = codeOnly(sharedSource);
  assert.match(shared, /export function useAbbreviatedNumbers\(\): boolean \{/);
  assert.match(shared, /useMediaQuery\("\(max-width: 767px\)"\)/, "767 is one of the agreed widths");
  const at = shared.indexOf("export function MetricTile(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(body, /const spoken = accessibleValue \?\?/);
  assert.match(
    body,
    /aria-label=\{name\}/,
    "§1.9: the screen reader is told the full value, not the abbreviated one",
  );
  assert.match(body, /const name = `\$\{label\}: \$\{spoken\}/);
});

/* ── 6. §1.5 — null is an em dash and a sentence, never a zero ────────────── */

test("MetricTile prints an em dash and an explanation for a missing value", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function MetricTile(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(body, /const missing = value === null;/);
  assert.match(body, /const shown = missing \? "—" : String\(value\);/);
  assert.match(body, /Not recorded for this period/, "the em dash is explained, not left bare");
  assert.match(body, /ovw-tile__value--missing/, "and it does not look like a measured figure");
  assert.match(
    body,
    /share === null \|\| share === undefined \? null :/,
    "a missing share prints nothing rather than 0%",
  );
});

test("GroupedColumns draws an unmeasured stage as unmeasured, never as 0%", async () => {
  const charts = codeOnly(chartsSource);
  const at = charts.indexOf("export function GroupedColumns(");
  const body = charts.slice(at, charts.indexOf("\n}\n", at));
  assert.match(body, /if \(value === null\) \{/);
  assert.match(body, /ovw-grouped__unmeasured/);
  assert.match(body, /Not measured — no timestamp recorded/, "§4.4's exact words");
  assert.match(body, /not measured/, "and the same thing in the readout");
});

test("a bucket below the sample floor is a gap with a dotted connector, not a point", async () => {
  const charts = codeOnly(chartsSource);
  const at = charts.indexOf("export function TimeSeries(");
  const body = charts.slice(at, charts.indexOf("\n}\n", at));
  assert.match(
    body,
    /bucket\.sample === undefined \|\| bucket\.sample >= floor/,
    "§4.3: fewer than `minSample` is not drawable",
  );
  assert.match(body, /strokeDasharray="1 4"/, "the connector across a gap is dotted");
  assert.match(body, /insufficient data/, "and the tooltip says why");
  assert.match(charts, /function runsOf\(/, "the series is split into runs so a gap stays a gap");
});

/* ── 7. §1.9 — colour is never the only signal ────────────────────────────── */

test("every segment carries a text label and a number as well as a colour", async () => {
  const charts = codeOnly(chartsSource);
  for (const component of ["SegmentedBar", "Donut"]) {
    const at = charts.indexOf(`export function ${component}(`);
    const body = charts.slice(at, charts.indexOf("\n}\n", at));
    assert.match(body, /ovw-legend__label/, `${component} names every segment in words`);
    assert.match(body, /ovw-legend__value/, `${component} prints every segment's count`);
  }
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function SeverityBar(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(body, /SEVERITY_RANGE\[segment\.key\]/, "'ageing' means nothing without its days");
  assert.match(body, /ovw-severity__count/, "§6.3 wants the numbers ON the segments");
  assert.match(
    body,
    /role=\{onSelect \? "group" : "img"\}/,
    "buttons inside role=img are unreachable, so an interactive bar cannot be an image",
  );
});

test("the shared primitives are reused rather than re-drawn", async () => {
  const shared = codeOnly(sharedSource);
  const imported = /import \{([\s\S]*?)\} from "\.\/ops-primitives";/.exec(shared);
  assert.ok(imported, "overview-shared.tsx must draw on ops-primitives.tsx");
  for (const name of [
    "EmptyState",
    "ErrorState",
    "FilterChip",
    "HiddenDataTable",
    "ProgressMeter",
    "SegmentedMeter",
    "SkeletonRow",
    "deltaText",
    "money",
  ]) {
    assert.ok(imported[1].includes(name), `${name} already exists; it must not be written twice`);
  }
  assert.match(
    shared,
    /if \(!showNumbers\) \{\s*return \(\s*<SegmentedMeter/,
    "SeverityBar delegates its plain form to the primitive",
  );
  assert.match(shared, /<ProgressMeter/, "CoverageStrip's bar is the primitive's");
});

/* ── 8. §3.2 — coverage first, and the banner that fires on the data ──────── */

test("CoverageStrip decides its own banner from the numbers, and stays quiet above 75%", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function CoverageStrip(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(
    body,
    /const \[share\] = sharesOfRecorded\(\[Math\.max\(0, recorded\), Math\.max\(0, total - recorded\)\]\)/,
    "even the coverage share goes through the one implementation",
  );
  assert.match(
    body,
    /share < 40 \? "amber" : share <= 75 \? "quiet" : "none"/,
    "§3.2's three bands, computed each render rather than passed in",
  );
  assert.match(body, /banner && tone === "amber"/);
  assert.match(body, /banner && tone === "quiet"/);
  assert.doesNotMatch(
    body,
    /tone === "none"/,
    "over 75% nothing is drawn at all, which is the absence of a branch",
  );
  const { sharesOfRecorded } = helpers;
  // The card's real numbers: 46 of 776 is 6%, which is squarely in the amber band.
  assert.deepEqual(sharesOfRecorded([46, 730]), [6, 94]);
  assert.deepEqual(sharesOfRecorded([0, 0]), [0, 0], "an empty period is not a divide by zero");
});

/* ── 9. §1.10 — shape, the top eight, and only the non-zero rows ──────────── */

test("BreakdownSection picks its shape by category count and expands in place", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function BreakdownSection(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(
    body,
    /const shape = forceShape \?\? \(recordedBuckets\.length > 5 \? "bars" : "donut"\)/,
    "§1.10: more than five categories is a ranked list, five or fewer is a ring",
  );
  assert.match(body, /const limit = initialLimit \?\? 8;/, "§5.3's top eight");
  assert.match(body, /Show all \{recordedBuckets\.length\} →/, "a control, not a '+8 more' truncation");
  assert.match(body, /onClick=\{\(\) => setExpanded\(true\)\}/, "expanding happens IN PLACE");
  assert.match(body, /centreLabel="recorded"/, "§5.3: the centre is the recorded count, with the word");
  assert.match(
    body,
    /centreValue=\{dimension\.recorded\}/,
    "defect 3 in §7: the centre read the cohort total while its caption read the recorded count",
  );
  assert.match(body, /aria-pressed=\{splitByPriority\}/, "the split toggle reports its state");
});

test("DataQualityRow renders only the non-zero items", async () => {
  const shared = codeOnly(sharedSource);
  const at = shared.indexOf("export function DataQualityRow(");
  const body = shared.slice(at, shared.indexOf("\n}\n", at));
  assert.match(body, /items\.filter\(\(item\) => item\.count > 0\)/, "§1.10, in one line");
  assert.match(body, /if \(live\.length === 0\) return <><\/>;/, "and nothing at all when they are all zero");
  assert.match(body, /onClick=\{item\.onAction\}/, "every item's Fix action is wired");
});

/* ── 10. The donut's arc maths ────────────────────────────────────────────── */

test("donutSegmentPath draws from twelve o'clock and survives a whole ring", async () => {
  const { donutSegmentPath } = helpers;
  assert.equal(donutSegmentPath(84, 78, 50, 0, 0), "", "a zero slice is not a hairline");
  assert.equal(donutSegmentPath(84, 78, 50, 0, -0.2), "", "nor is a negative one");
  assert.equal(donutSegmentPath(84, 78, 50, 0, Number.NaN), "");

  const quarter = donutSegmentPath(84, 78, 50, 0, 0.25);
  assert.ok(quarter.startsWith("M 84 6 "), "zero is twelve o'clock, not three");
  assert.match(quarter, /A 78 78 0 0 1 162 84/, "a quarter turn ends at three o'clock");
  assert.match(quarter, /A 50 50 0 0 0 84 34 Z/, "and comes back along the inner radius");

  assert.match(
    donutSegmentPath(84, 78, 50, 0, 0.5),
    /A 78 78 0 0 1 /,
    "a half turn is not a LARGE arc",
  );
  assert.match(
    donutSegmentPath(84, 78, 50, 0, 0.51),
    /A 78 78 0 1 1 /,
    "one degree more and it is",
  );

  const whole = donutSegmentPath(84, 78, 50, 0, 1);
  assert.equal(
    (whole.match(/M /g) ?? []).length,
    2,
    "a single category at 100% is split in two: one arc from a point back to itself draws nothing",
  );
  assert.equal(
    donutSegmentPath(84, 78, 50, 0, 1.4),
    whole,
    "and anything over a whole ring is the same whole ring",
  );
});

test("niceCeiling gives an axis top a reader can divide by", async () => {
  const { niceCeiling } = helpers;
  assert.equal(niceCeiling(0), 1, "an empty chart still needs a scale");
  assert.equal(niceCeiling(Number.NaN), 1);
  assert.equal(niceCeiling(1), 1);
  assert.equal(niceCeiling(7), 7.5);
  assert.equal(niceCeiling(93), 100);
  assert.equal(niceCeiling(26557), 30000);
});

/* ── 11. The stylesheet ───────────────────────────────────────────────────── */

test("overview.css uses only the agreed breakpoints", async () => {
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

test("overview.css contains no hex literal and no raw colour of any kind", async () => {
  const css = codeOnly(stylesSource);
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "colours that come from data arrive as an inline style, never from CSS");
  assert.doesNotMatch(css, /rgba?\(/, "a raw rgb() is a hex by another name and does not follow the theme");
  assert.doesNotMatch(css, /hsla?\(/);
  for (const named of ["white", "black", "red", "green"]) {
    assert.doesNotMatch(
      css,
      new RegExp(`:\\s*${named}\\b`),
      `${named} is a colour with no dark-mode value`,
    );
  }
});

test("every custom property overview.css reads is actually defined somewhere", async () => {
  /*
   * An undefined `var(--x)` renders as nothing and takes the rule with it. The
   * tokens live in two files — the Overview's own and the product's — and this
   * is the check that a typo in a token name cannot ship silently.
   */
  const defined = new Set();
  for (const file of ["app/(app)/portal/ops/ops-tokens.css", "app/globals.css"]) {
    for (const match of (await read(file)).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
  }
  const used = new Set(
    [...stylesSource.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]),
  );
  assert.ok(used.size > 10, "the stylesheet is written in tokens");
  for (const token of used) {
    assert.ok(defined.has(token), `${token} is read by overview.css but defined nowhere`);
  }
  assert.ok(used.has("--ms-ink"), "§1.3's tokens are the ones this page is written in");
  assert.ok(used.has("--surface-card") || used.has("--ms-surface"), "and they alias the product's own");
});

test("figures are tabular, focus is visible, and touch targets clear 44px", async () => {
  const css = codeOnly(stylesSource);
  assert.ok(
    (css.match(/font-variant-numeric: tabular-nums;/g) ?? []).length >= 12,
    "§1.9: every element holding a number is tabular, so counts do not jitter on refresh",
  );
  assert.ok(
    (css.match(/:focus-visible \{/g) ?? []).length >= 6,
    "§1.9: every interactive element has a visible focus state",
  );
  assert.match(css, /outline: 2px solid var\(--accent-fg\)/);
  assert.ok(
    (css.match(/min-height: 44px;/g) ?? []).length >= 6,
    "§1.8: tap targets are at least 44px",
  );
  assert.match(css, /gap: 8px;/, "§1.8: with at least 8px between them");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "the ops.css rule, copied");
});

test("nothing wider than the viewport escapes its own scroller", async () => {
  const css = codeOnly(stylesSource);
  const scrollers = [...css.matchAll(/overflow-x:\s*auto/g)];
  assert.ok(scrollers.length >= 2, "the wide charts scroll inside themselves, not the page");
  assert.match(
    css,
    /\.ovw-ts__scroller,\s*\n\.ovw-grouped__scroller \{[^}]*border-inline-end: 2px dashed/,
    "§1.8: an explicitly scrollable container needs a visible edge affordance",
  );
  assert.match(css, /scrollbar-width: thin;/);
  // One column on a phone; the grid arrives with the width.
  assert.match(css, /\.ovw-tiles \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@media \(min-width: 640px\) \{\s*\.ovw-tiles \{\s*grid-template-columns: repeat\(2/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  // §1.8: donut above, legend beneath, until there is room beside it.
  assert.match(css, /\.ovw-donut \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.ovw-donut \{\s*grid-template-columns: 168px minmax\(0, 1fr\);/);
});

/* ── 12. No dependency was added to draw any of this ──────────────────────── */

test("the charts are hand-rolled: no library, no canvas, nothing new imported", async () => {
  assert.doesNotMatch(chartsSource, /<canvas/i, "a canvas has no accessibility story and no theme");
  const specifiers = [...chartsSource.matchAll(/from "([^"]+)"/g), ...sharedSource.matchAll(/from "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith("."));
  assert.deepEqual(
    [...new Set(specifiers)],
    ["react"],
    "this product has five runtime dependencies and none of them draws a chart; it stays that way",
  );
  for (const name of ["recharts", "chart.js", "d3", "victory", "nivo", "apexcharts"]) {
    assert.ok(!chartsSource.includes(name), `${name} is not a dependency here`);
  }
});
