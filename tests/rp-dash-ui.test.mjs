/**
 * THE REPORTS BLOCK ("Spend and reporting") — its UI contract.
 *
 * `rp-dash.tsx` renders `/api/reports/metrics` and computes nothing but
 * presentation, so what can go wrong in it is not arithmetic. It is:
 *
 *   · a drill that sends the wrong filter, so the list the reader lands on is
 *     not the number they tapped — the fault `board-drill-filter.ts` exists to
 *     prevent;
 *   · a fetch key that picks up the Reports page's other parameters, or a card
 *     selector that never reaches the address bar;
 *   · a table or a sample number creeping back into a block the brief made
 *     visual and live;
 *   · a stylesheet that branches at a width the stage tests refuse, restates
 *     the shared `--ov-*` palette, or loses the always-dark island to the light
 *     skin.
 *
 * The drill queries are a pure, import-free section at the foot of
 * `rp-dash.tsx`; this suite slices that section out and transpiles it on its
 * own — the trick `ov-dash-metrics.test.mjs` uses — so the queries under test
 * are the component's own, not a copy. With a development server answering,
 * the last test runs every one of them through the board's `readDrillFilter`
 * over the live job list and checks the count AND the pounds against the
 * figure that sends it. Without one, that test skips rather than fails.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const BLOCK = "app/(app)/portal/ops/rp-dash.tsx";
const CHARTS = "app/(app)/portal/ops/rp-dash-charts.tsx";
const STYLES = "app/(app)/portal/ops/rp-dash.css";

const ts = (await import("typescript")).default;

/** A slice of a module, transpiled on its own and imported from a data: URL. */
async function importSlice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `the slice still starts at "${from}"`);
  const end = to ? source.indexOf(to, start) : source.length;
  assert.ok(end > start, `the slice still ends at "${to}"`);
  const output = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

/** Source with comments removed, so a pin cannot be satisfied by prose. */
function codeOnly(source) {
  return source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const blockSource = await read(BLOCK);
const chartsSource = await read(CHARTS);
const drills = await importSlice(blockSource, "/* ── THE DRILL QUERIES", "/* ── End of the drill queries");
const money = await importSlice(chartsSource, "const RP_POUNDS_WHOLE", "/* ── A media query");

/* ── The drill queries, as pure functions ─────────────────────────────────── */

test("a spend drill sends exactly the window and keys its figure was counted with", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  /*
   * RE-POINTED 2026-09-12. `rpKpiQuery`'s first argument is now the figure's
   * stable job type TOKEN (the payload's `drillType`) rather than the KPI key:
   * null for the total, which names no type, and the type's id for a card —
   * so renaming a type cannot change, or break, the link.
   */
  assert.equal(
    drills.rpKpiQuery(null, range),
    "hasCost=1&measure=completed&period=custom&from=2026-09-01&to=2026-09-30",
    "the total card: completed cost inside the range, and nothing else",
  );
  assert.equal(
    drills.rpKpiQuery("jt_org-1_reactive", range),
    "hasCost=1&measure=completed&period=custom&from=2026-09-01&to=2026-09-30&type=jt_org-1_reactive",
    "a type card adds its type's stable id",
  );
  assert.equal(
    drills.rpKpiQuery("__unclassified__", range),
    "hasCost=1&measure=completed&period=custom&from=2026-09-01&to=2026-09-30&type=__unclassified__",
    "and the Unclassified link its token",
  );
  assert.equal(
    drills.rpTrendQuery({ from: "2026-08-01", to: "2026-08-31" }),
    "hasCost=1&measure=completed&period=custom&from=2026-08-01&to=2026-08-31",
    "a trend point sends its own month, not the page's range",
  );
  assert.equal(
    drills.rpSiteBarQuery("store-a", { from: "2026-01-01", to: "2026-09-11" }),
    "hasCost=1&measure=completed&period=custom&from=2026-01-01&to=2026-09-11&site=store-a",
    "a site bar sends the CARD's window and its one site",
  );
});

test("a repeat drill sends the raised-in-range window and its one dimension", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  assert.equal(drills.rpRepeatQuery(range), "repeat=1&period=custom&from=2026-09-01&to=2026-09-30");
  assert.equal(
    drills.rpRepeatIssueQuery(["HVAC", "Lighting"], range),
    "repeat=1&period=custom&from=2026-09-01&to=2026-09-30&label=HVAC%7CLighting",
    "an issue slice sends every raw category it folded, pipe-joined",
  );
  assert.equal(
    drills.rpRepeatSiteQuery(["__unassigned__"], range),
    "repeat=1&period=custom&from=2026-09-01&to=2026-09-30&site=__unassigned__",
    "'No site' is the board's own unassigned sentinel",
  );
  assert.equal(
    drills.rpRecurrenceQuery("fortnightly", range),
    "recurrence=fortnightly&period=custom&from=2026-09-01&to=2026-09-30",
  );
  /* Measure is never "completed" on a repeat drill: a repeat is judged by the
     date it was RAISED, and the board's window axis follows `measure`. */
  for (const query of [drills.rpRepeatQuery(range), drills.rpRecurrenceQuery("weekly", range)]) {
    assert.doesNotMatch(query, /measure=/);
  }
});

test("the portfolio rides along as its sites, unless the figure names a site itself", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  const sites = ["store-a", "store-b"];
  /* RE-POINTED 2026-09-12: the total card's type token is null (see above). */
  assert.match(drills.rpKpiQuery(null, range, sites), /&site=store-a%7Cstore-b$/);
  assert.match(drills.rpRepeatQuery(range, sites), /&site=store-a%7Cstore-b$/);
  assert.match(drills.rpRecurrenceQuery("weekly", range, sites), /&site=store-a%7Cstore-b$/);
  assert.match(drills.rpRepeatIssueQuery(["HVAC"], range, sites), /&site=store-a%7Cstore-b$/);
  assert.equal(drills.rpKpiQuery(null, range, []), drills.rpKpiQuery(null, range), "All portfolios sends no site at all");
  assert.doesNotMatch(drills.rpSiteBarQuery("store-a", range), /store-b/, "a site bar is never widened to the portfolio");
  assert.equal(drills.rpJobsQuery([["from", ""], ["to", "2026-09-30"]]), "to=2026-09-30", "an empty value is dropped, not sent blank");
});

test("every key a drill sends is one the Jobs board reads — and it reads them as meant", async () => {
  const { readDrillFilter, DRILL_KEYS } = await import("../app/(app)/portal/board-drill-filter.ts");
  const range = { from: "2026-09-01", to: "2026-09-30" };
  /* RE-POINTED 2026-09-12: a type card now sends its type's id, and the two
     buckets no card draws send their tokens — each still a `type=` the board reads. */
  const queries = [
    drills.rpKpiQuery("jt_org-1_planned", range, ["store-a"]),
    drills.rpKpiQuery("__other__", range),
    drills.rpKpiQuery("__unclassified__", range),
    drills.rpTrendQuery(range),
    drills.rpSiteBarQuery("store-a", range),
    drills.rpRepeatQuery(range),
    drills.rpRepeatIssueQuery(["HVAC"], range),
    drills.rpRepeatSiteQuery(["store-a"], range),
    drills.rpRecurrenceQuery("monthly", range),
  ];
  for (const query of queries) {
    for (const key of new URLSearchParams(query).keys()) {
      assert.ok(DRILL_KEYS.includes(key), `"${key}" is a key the board reads and its Clear strips`);
    }
    const filter = readDrillFilter(new URLSearchParams(query), new Date("2026-09-11T12:00:00Z"));
    assert.equal(filter.empty, false, `${query} narrows the board`);
  }
  const chips = (query) =>
    readDrillFilter(new URLSearchParams(query), new Date("2026-09-11T12:00:00Z")).chips.map((chip) => chip.key);
  assert.deepEqual(chips(drills.rpKpiQuery("jt_org-1_planned", range)), ["type", "hasCost", "period"]);
  assert.deepEqual(chips(drills.rpRecurrenceQuery("monthly", range)), ["recurrence", "period"]);
  assert.deepEqual(chips(drills.rpRepeatIssueQuery(["HVAC"], range)), ["label", "repeat", "period"]);
});

/* ── Money and axes, as the block writes them ─────────────────────────────── */

test("money is whole en-GB pounds, and nothing ever prints NaN or -£0", () => {
  assert.equal(money.rpPounds(48275000), "£482,750");
  assert.equal(money.rpPounds(0), "£0");
  assert.equal(money.rpPounds(-40), "£0", "a credit of pence is not -£0");
  assert.equal(money.rpPounds(Number.NaN), "£0");
  assert.equal(money.rpPounds(Number.POSITIVE_INFINITY), "£0");
  assert.equal(money.rpJobs(1), "1 job");
  assert.equal(money.rpJobs(1234), "1,234 jobs");
  assert.equal(money.rpCount(Number.NaN), "0");
});

test("a site axis divides into steps a reader would have written down", () => {
  /* £100k in fives (the reference's £20k steps); £40k and £2k in fours. */
  assert.equal(money.rpAxisDivisions(10_000_000), 5);
  assert.equal(money.rpAxisDivisions(5_000_000), 5);
  assert.equal(money.rpAxisDivisions(4_000_000), 4);
  assert.equal(money.rpAxisDivisions(200_000), 4);
  assert.equal(money.rpAxisDivisions(0), 1, "an empty card has one tick, £0");
  assert.equal(money.rpAxisDivisions(Number.NaN), 1);
});

/* ── The component's source contract ──────────────────────────────────────── */

test("one fetch, keyed on the block's six parameters and nothing else", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /export function RpDash\(\{\s*onNavigateToJobs,\s*onNavigateToSite,\s*\}: \{/);
  assert.match(code, /onNavigateToJobs: \(query: string\) => void;/);
  assert.match(code, /onNavigateToSite: \(siteId: string\) => void;/);
  assert.match(
    code,
    /useOpsQuery<RpMetrics>\("\/api\/reports\/metrics", search, \{\s*keepOnError: true,\s*\}\)/,
    "one round trip, and a failed poll keeps the figures on screen",
  );
  const memo = code.slice(code.indexOf("const search = useMemo"), code.indexOf("}, [portfolio, fromParam"));
  const keys = [...memo.matchAll(/next\.set\("(\w+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(keys, ["from", "portfolio", "reportPeriod", "sitesRange", "to", "trendRange"]);
  assert.doesNotMatch(memo, /window\.location/, "the key is rebuilt from the six, never the whole address bar");
});

test("it stays fresh by polling while visible and refetching on focus", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /const REFRESH_INTERVAL_MS = 60_000;/);
  assert.match(code, /window\.addEventListener\("focus", refreshIfVisible\)/);
  assert.match(code, /document\.addEventListener\("visibilitychange", refreshIfVisible\)/);
  assert.match(code, /if \(document\.visibilityState === "visible"\) reload\(\);/);
  assert.match(code, /window\.clearInterval\(timer\)/, "and stops when the block unmounts");
});

test("the card selectors and the range live in the address bar", () => {
  const code = codeOnly(blockSource);
  for (const [value, label] of [
    ["3m", "Last 3 months"],
    ["6m", "Last 6 months"],
    ["12m", "Last 12 months"],
    ["ytd", "This year"],
  ]) {
    assert.match(code, new RegExp(`\\{ value: "${value}", label: "${label}" \\}`));
  }
  for (const [value, label] of [
    ["page", "Date range"],
    ["month", "This month"],
    ["3m", "Last 3 months"],
    ["ytd", "This year"],
  ]) {
    assert.match(code, new RegExp(`\\{ value: "${value}", label: "${label}" \\}`));
  }
  assert.match(code, /const TREND_DEFAULT: RpTrendRange = "6m";/);
  assert.match(code, /const SITES_DEFAULT: RpSitesRange = "page";/);
  assert.match(code, /if \(next === TREND_DEFAULT\) query\.delete\("trendRange"\);/, "the default is omitted from the URL");
  assert.match(code, /if \(next === SITES_DEFAULT\) query\.delete\("sitesRange"\);/);
  assert.match(code, /query\.delete\("reportPeriod"\);/, "a chosen range replaces a drilled-in month");
  assert.match(code, /title="Spend and reporting"/);
  assert.match(code, /resetLabel="Reset to this month"/);
  assert.match(code, /`\/api\/reports\/metrics\?format=csv\$\{search \? `&\$\{search\}` : ""\}`/, "Export is the server's CSV under the same keys");
  assert.doesNotMatch(code, /localStorage/, "no filter state outside the URL");
});

test("every figure is a real link or a chart control, to the shell's real routes", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /jobs: "\/dashboard\/jobs"/);
  assert.match(code, /sites: "\/dashboard\/sites"/);
  assert.match(code, /`\$\{ROUTE\.sites\}\?site=\$\{encodeURIComponent\(siteId\)\}`/, "a site name opens that site's page");
  assert.match(code, /<a\s+className=\{className\}\s+href=\{href\}/, "RpLink is an anchor, so new-tab and middle-click work");
  assert.match(code, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;/);
  for (const drill of ["rpKpiQuery(", "rpTrendQuery(", "rpSiteBarQuery(", "rpRepeatQuery(", "rpRepeatIssueQuery(", "rpRepeatSiteQuery(", "rpRecurrenceQuery("]) {
    const uses = code.split(drill).length - 1;
    assert.ok(uses >= 2, `${drill.slice(0, -1)} is defined and used`);
  }
});

test("the gauge's colour is the payload's policy, and the charts are the shared ones", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /rateTone\(repeat\.percent, data\.policy\.repeatThresholds\)/, "no threshold typed in the component");
  assert.match(code, /from "\.\.\/\.\.\/\.\.\/lib\/dashboard-policy"/);
  assert.match(code, /import type \{[^}]*RpMetrics[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/reports-dash-contract"/);
  assert.doesNotMatch(code, /import \{[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/reports-dash-contract"/, "the contract is types only");
  const libImports = [...code.matchAll(/from "(\.\.\/\.\.\/\.\.\/lib\/[^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(libImports, ["../../../lib/dashboard-policy", "../../../lib/reports-dash-contract"], "nothing that reaches drizzle");
  assert.match(code, /import \{ AreaTrend, Donut, RingMeter, Speedometer,[^}]*\} from "\.\/ov-dash-charts";/);
  assert.match(code, /const REPEAT_DONUT = \{ box: 150, radius: 66, stroke: 18 \} as const;/);
  assert.equal((code.match(/gapPx=\{2\}/g) ?? []).length, 2, "both repeat donuts have the brief's 2px gaps");
  assert.match(code, /size=\{72\}\s*stroke=\{8\}/, "the recurrence rings are 72px with an 8px stroke");
  assert.match(code, /lineColour="var\(--rp-line\)"/);
  assert.match(code, /className="ov-dash rp-dash"/, "mounted on the shared design-system root");
  assert.match(code, /aria-label="Spend and reporting"/);
  assert.match(code, /import ovDashCss from "\.\/ov-dash\.css\?url";/);
  assert.match(code, /import rpDashCss from "\.\/rp-dash\.css\?url";/);
  assert.match(code, /<link rel="stylesheet" href=\{rpDashCss\} precedence="default" \/>/);
});

test("a recurrence ring states the jobs its drill opens, not only the patterns it draws", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /const both = `\$\{plural\(band\.value, "pattern", "patterns"\)\} · \$\{plural\(band\.jobs, "repeat job", "repeat jobs"\)\}`;/);
  assert.match(code, /tipLines=\{\[both,/);
  assert.match(code, /describe=\{`\$\{both\}\. Opens those repeat jobs`\}/);
  assert.match(code, /value=\{band\.value\}\s*total=\{patterns\}/, "the ring's fill is patterns over all patterns");
});

test("the total card names what the four types and Unclassified add up to", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /Unclassified \$\{rpPounds\(unclassified\.pence\)\}/);
  assert.match(code, /title=\{isTotal \? breakdown : ovPoundsExact\(kpi\.pence\)\}/);
  /* 2026-09-12: the type cards are named by their CURRENT labels, and Other
     joins the breakdown — the five figures shown add up to the one on the card. */
  assert.match(code, /\.map\(\(kpi\) => `\$\{kpi\.label\} \$\{rpPounds\(kpi\.pence\)\}`\)/);
  assert.match(code, /\$\{other\.label\} \$\{rpPounds\(other\.pence\)\}/);
});

test("Other and Unclassified are never dropped: each is drillable under the KPI row", () => {
  const code = codeOnly(blockSource);
  assert.match(code, /const typeGaps = \[unclassified, other\]\.filter\(\(bucket\) => bucket\.jobs > 0\);/);
  assert.match(code, /const query = rpKpiQuery\(bucket\.drillType, scope, portfolioSites\);/, "by the bucket's stable token");
  assert.match(code, /const query = rpKpiQuery\(kpi\.drillType, scope, portfolioSites\);/, "and each card by its type's id");
  assert.match(code, /project: "var\(--rp-projects\)"/, "the accent follows the stable code, not the label");
});

test("no table, no text list, no sample figure", () => {
  for (const [file, source] of [[BLOCK, blockSource], [CHARTS, chartsSource]]) {
    const code = codeOnly(source);
    for (const tag of ["table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "dl"]) {
      /* A whole tag name — `<li` must not match the stylesheet's `<link`. */
      assert.doesNotMatch(code, new RegExp(`<${tag}[\s>/]`), `${file} renders no <${tag}> element`);
    }
    assert.doesNotMatch(code, /£\d/, `${file} holds no pound figure of its own`);
    assert.doesNotMatch(code, /482,750|214,300|163,450|105,000|2,426,120|Sample data/, `${file} holds none of the reference's sample numbers`);
  }
});

test("the sparkline and the bars are built from the shared motion, pin and tooltip", () => {
  const code = codeOnly(chartsSource);
  for (const name of ["useOvSweep", "useOvPin", "useOvHoverCapable", "OvTip", "OvTipAction", "ovNiceCeiling"]) {
    assert.match(code, new RegExp(`\\b${name}\\b[^]*from "\\./ov-dash-charts"`), `${name} comes from ov-dash-charts`);
  }
  assert.doesNotMatch(code, /requestAnimationFrame/, "no second animation loop");
  /* The sparkline lives inside the KPI card's <a>: no nested interactive element. */
  const spark = code.slice(code.indexOf("export function RpSparkline"), code.indexOf("export type RpBarDatum"));
  assert.doesNotMatch(spark, /<button|<a\s/, "the sparkline adds no control inside the card's link");
  assert.match(spark, /if \(hoverCapable\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/, "only a tap is consumed");
  const bars = code.slice(code.indexOf("export function RpSiteBars"));
  assert.match(bars, /const ceiling = ovNiceCeiling\(/, "bars are drawn against the axis, not the leader");
  assert.match(bars, /else togglePin\(row\.key\);/, "a tap pins before it navigates");
});

/* ── The stylesheet ───────────────────────────────────────────────────────── */

test("the stylesheet branches only at the agreed widths", async () => {
  const css = await read(STYLES);
  const widths = [...css.matchAll(/@media[^{]*?\((?:min|max)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.ok(widths.length > 0);
  for (const width of widths) {
    assert.ok([640, 767, 768, 1024, 1280].includes(width), `@media at ${width}px is not an agreed breakpoint`);
  }
  assert.doesNotMatch(css, /@container/, "no container width queries standing in for breakpoints");
});

test("it adds the brief's --rp-* tokens and restates none of the shared palette", async () => {
  const css = await read(STYLES);
  /*
   * RE-POINTED: the approved colour system's dark palette — total and bars
   * turquoise #12b4a8 (was #46a2ad / #4c98a4) with the bright line #20d8c6
   * (was #6fc3cc) and its wash at rgb(18 180 168), reactive orange #ff8a3d
   * (was #e0a050), planned blue #38bdf8 (was #5c8ec3), projects light
   * turquoise #55e8d8 (was #6e9f7f), and the repeat scale red / yellow / blue
   * / grey #ff4d5e / #ffd447 / #38bdf8 / #64707b (was #d34e49 / #e09438 /
   * #5878a4 / #44546c).
   */
  for (const [token, value] of [
    ["--rp-total", "#12b4a8"],
    ["--rp-reactive", "#ff8a3d"],
    ["--rp-planned", "#38bdf8"],
    ["--rp-projects", "#55e8d8"],
    ["--rp-bar", "#12b4a8"],
    ["--rp-line", "#20d8c6"],
    ["--rp-area-top", "rgba(18, 180, 168, 0.35)"],
    ["--rp-area-bottom", "rgba(18, 180, 168, 0.03)"],
    ["--rp-weekly", "#ff4d5e"],
    ["--rp-fortnightly", "#ffd447"],
    ["--rp-monthly", "#38bdf8"],
    ["--rp-less-often", "#64707b"],
  ]) {
    assert.ok(css.includes(`${token}: ${value};`), `${token} is ${value}`);
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--ov-[\w-]+\s*:/, "no --ov-* token is declared here");
});

test("a falling delta's red clears 4.5:1 on the card", async () => {
  const css = await read(STYLES);
  const hex = css.match(/--rp-down: (#[0-9a-f]{6});/)?.[1];
  assert.ok(hex, "the down-delta ink is a token");
  const luminance = (value) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /*
   * RE-POINTED: the approved colour system moved `--ov-card` from #0e1721 to
   * #102630 and `--ov-red` from #d34e49 to #ff4d5e. The new red clears 4.5:1
   * on the card itself (4.83) but not on the hover ground `--ov-nav-active`
   * #14313c (4.22), so the delta ink is now held to BOTH grounds.
   */
  assert.ok(ratio(hex, "#102630") >= 4.5, `${hex} is ${ratio(hex, "#102630").toFixed(2)}:1 on --ov-card`);
  assert.ok(ratio(hex, "#14313c") >= 4.5, `${hex} is ${ratio(hex, "#14313c").toFixed(2)}:1 on --ov-nav-active`);
  assert.ok(ratio("#ff4d5e", "#14313c") < 4.5, "and the reason it exists: --ov-red is not, on the hover ground");
});

test("every rule is scoped to the block, and calc() keeps its spaces", async () => {
  const css = (await read(STYLES)).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/(^|[{}])\s*([^{}@][^{}]*?)\s*\{/g)]
    .map((match) => match[2].trim())
    .filter((selector) => selector && !selector.startsWith("@") && !/^(from|to|\d+%)$/.test(selector));
  assert.ok(selectors.length > 40);
  for (const list of selectors) {
    for (const selector of list.split(",")) {
      assert.match(selector, /\.ov-dash\.rp-dash/, `"${selector.trim()}" is scoped to .ov-dash.rp-dash`);
    }
  }
  for (const [, body] of css.matchAll(/(?:calc|clamp)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const stripped = body.replace(/var\([^)]*\)/g, "V");
    assert.doesNotMatch(stripped, /[^\s(,][+-][^\s]|[^\s][+-][^\s(,]/, `calc/clamp keeps spaces around + and -: "${body}"`);
  }
});

test("the island stays dark on a light profile", async () => {
  const css = await read(STYLES);
  assert.match(
    css,
    /body\[data-theme\] \.ov-dash\.rp-dash \.rp-select select:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\) \{[^}]*border: 1px solid var\(--ov-card-border\);/,
    "the card select out-ranks the light skin's (0,5,2) field rule and keeps its dark edge",
  );
  assert.match(css, /\.ov-dash\.rp-dash \.rp-select::after \{[^}]*pointer-events: none;/, "its chevron is the label's, not a background the skin can wipe");
  assert.match(css, /body\[data-theme\] \.ov-dash\.rp-dash \.rp-zone__title \{/, "the zone headings beat the light heading ink");
  assert.match(css, /body\[data-theme\] \.ov-dash\.rp-dash \.rp-bars__name \{/, "and so do the site links");
  assert.match(css, /--control-own-fg: var\(--ov-text\);/, "chart buttons opt out of the dark button blanket");
  const reports = await read("app/(app)/portal/reports/reports.css");
  assert.doesNotMatch(reports, /\.ov-dash|\.rp-/, "the Reports page's own sheet never reaches into the block");
});

/* ── Against the live estate ──────────────────────────────────────────────── */

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

async function allJobs() {
  const rows = [];
  for (let offset = 0, page = 0; page < 20; page += 1) {
    const response = await fetch(`${BASE}/api/maintenance?limit=1000&offset=${offset}`, { headers });
    const body = await response.json();
    rows.push(...(body.requests ?? []));
    if (!body.hasMore || typeof body.nextOffset !== "number") break;
    offset = body.nextOffset;
  }
  return rows;
}

test("every drill opens exactly the jobs, and the pounds, its figure counted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
  const { spendLineOf } = await import("../app/lib/job-metrics.ts");
  const rows = await allJobs();
  assert.ok(rows.length > 0, "the estate has jobs to filter");

  const opened = (query) => {
    const filter = readDrillFilter(new URLSearchParams(query), new Date(), { population: rows });
    const hit = rows.filter((row) => filter.matches(row));
    return { jobs: hit.length, pence: hit.reduce((sum, row) => sum + (spendLineOf(row)?.pence ?? 0), 0) };
  };

  for (const search of ["", "from=2025-09-01&to=2026-09-11&trendRange=12m&sitesRange=ytd"]) {
    const metrics = await (await fetch(`${BASE}/api/reports/metrics${search ? `?${search}` : ""}`, { headers })).json();
    const scope = { from: metrics.range.from, to: metrics.range.to };
    const sites = metrics.portfolio.siteIds;
    /* RE-POINTED 2026-09-12: each card drills by its payload `drillType`, and
       the Other / Unclassified buckets are figures with drills of their own. */
    const cases = [
      ...metrics.kpis.map((kpi) => [`KPI ${kpi.key}`, drills.rpKpiQuery(kpi.drillType, scope, sites), kpi.jobs, kpi.pence]),
      ...[metrics.other, metrics.unclassified].map((bucket) => [`type ${bucket.key}`, drills.rpKpiQuery(bucket.drillType, scope, sites), bucket.jobs, bucket.pence]),
      ...metrics.trend.points.map((point) => [`trend ${point.month}`, drills.rpTrendQuery(point, sites), point.jobs, point.pence]),
      ...metrics.topSites.rows.map((row) => [`site ${row.name}`, drills.rpSiteBarQuery(row.siteId, metrics.topSites), row.jobs, row.pence]),
      ["repeat", drills.rpRepeatQuery(scope, sites), metrics.repeat.repeatJobs, metrics.repeat.spendPence],
      ...metrics.repeat.byIssue.map((slice) => [`issue ${slice.label}`, drills.rpRepeatIssueQuery(slice.labels, scope, sites), slice.jobs, slice.value]),
      ...metrics.repeat.bySite.map((slice) => [`repeat site ${slice.label}`, drills.rpRepeatSiteQuery(slice.labels, scope), slice.jobs, slice.value]),
      ...metrics.repeat.bands.map((band) => [`band ${band.key}`, drills.rpRecurrenceQuery(band.key, scope, sites), band.jobs, null]),
    ];
    for (const [name, query, jobs, pence] of cases) {
      const got = opened(query);
      assert.equal(got.jobs, jobs, `${search || "default"} · ${name}: the list holds ${got.jobs} where the figure says ${jobs}`);
      if (pence !== null) {
        assert.equal(got.pence, pence, `${search || "default"} · ${name}: the list sums ${got.pence}p where the figure says ${pence}p`);
      }
    }
  }
});
