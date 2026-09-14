/**
 * THE OVERVIEW — Job Intelligence, Spend & Reporting, Compliance — its UI
 * contract, pinned at the source.
 *
 * `oi-dash.tsx` draws three payloads — `/api/overview/metrics` (its `intel`),
 * `/api/reports/metrics` and `/api/compliance/metrics` — as three stacked
 * sections on the neon palette; `oi-dash-charts.tsx` holds the new shapes (the
 * semicircle gauge, the bar list, the target bars, the weekly sparkline, the
 * KPI tile); `oi-dash.css` holds the palette and the grids; `overview-page.tsx`
 * is the thin shell around them. The endpoints' own tests hold the SERVER to
 * the numbers. These hold the PAGE to the rules that make them trustworthy:
 *
 *   · the three sections, in the brief's order, each read from its endpoint
 *     under one explicit window, polled politely, and never recounted here;
 *   · every figure opens the list it counted — section 2 through the Reports
 *     block's own builders, section 3 through the Compliance block's
 *     `registerQuery`, section 1 through a pure pair section this suite runs
 *     against the board's `readDrillFilter` over the live job list;
 *   · the palette, the glow, and the mobile collapse the brief asks for, on
 *     the agreed breakpoints only;
 *   · no sample figure from the reference ships.
 *
 * The drill section at the foot of `oi-dash.tsx` is sliced out and transpiled
 * on its own — the trick `rp-dash-ui.test.mjs` uses — so the queries under
 * test are the component's own. The last test needs a development server and
 * skips, rather than fails, without one.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Source with comments removed, for any assertion about an ABSENCE. */
const codeOnly = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PAGE = "app/(app)/portal/ops/oi-dash.tsx";
const CHARTS = "app/(app)/portal/ops/oi-dash-charts.tsx";
const CSS = "app/(app)/portal/ops/oi-dash.css";
const SHELL = "app/(app)/portal/ops/overview-page.tsx";

const page = await read(PAGE);
const charts = await read(CHARTS);
const css = await read(CSS);
const shell = await read(SHELL);

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

const jobs = await importSlice(page, "/* ── THE JOB DRILLS AND THE RANGE ARITHMETIC", "/* ── End of the job drills");
const rp = await importSlice(
  await read("app/(app)/portal/ops/rp-dash.tsx"),
  "/* ── THE DRILL QUERIES",
  "/* ── End of the drill queries",
);
const palette = await importSlice(charts, "export const OI_COLOUR", "/** A shared-policy tone");

/* ── The shell and its wiring ─────────────────────────────────────────────── */

test("the Overview page is a thin shell around OiDash, keeping its export and props", () => {
  assert.match(shell, /export function OverviewPage\(\{/);
  assert.match(shell, /onNavigateToJobs: \(query: string\) => void;/);
  assert.match(shell, /onOpenJob: \(id: string\) => void;/);
  assert.match(shell, /onNavigateToCompliance: \(query\?: string\) => void;/, "Compliance now takes a register query");
  assert.match(shell, /onNavigateToSites: \(query: string\) => void;/);
  assert.match(shell, /import \{ OiDash \} from "\.\/oi-dash";/);
  assert.match(shell, /<OiDash\s/);
  const code = codeOnly(shell);
  for (const legacy of [
    "OvDash",
    "OpsFilterBar",
    "PulseRow",
    "AtAGlanceCard",
    "FinancialStatusCard",
    "PerformanceCard",
    "JobBreakdownCard",
    "SitesAttentionCard",
    "OverviewRecordsPanel",
    "MeterSettings",
    "ovw-jump",
  ]) {
    assert.doesNotMatch(code, new RegExp(`\\b${legacy}\\b`), `${legacy} is no longer composed on the Overview`);
  }
});

test("the two data-fix tools stay reachable, in the existing dialog shell", () => {
  assert.match(shell, /function OverviewTool\(\{/);
  assert.match(shell, /<ResolveNames onChanged=\{announceDataChanged\} \/>/);
  assert.match(shell, /<BulkSiteAssign onAssigned=\{announceDataChanged\} \/>/);
  assert.match(shell, />\s*Resolve contractor names\s*</);
  assert.match(shell, />\s*Assign jobs to a site\s*</);
  assert.match(shell, /<link rel="stylesheet" href=\{opsCss\} precedence="default" \/>/);
  assert.match(shell, /<link rel="stylesheet" href=\{toolsCss\} precedence="default" \/>/);
  assert.match(shell, /className="ops-sheet ovw-tool oi-tool"/);
  assert.match(css, /\.ops-sheet\.oi-tool > \.ops-sheet__panel \{[^}]*max-width: 900px;/, "the sheet is capped as it was");
});

test("the shell's Compliance callback carries the register query across", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const view = portal.slice(portal.indexOf("function OverviewView("), portal.indexOf("export function LegacyMaintenanceView"));
  assert.match(
    view,
    /onNavigateToCompliance=\{\(query\) => openSectionWithQuery\(onNavigate, "compliance", query \?\? ""\)\}/,
  );
  const cp = await read("app/(app)/portal/ops/cp-dash.tsx");
  assert.match(cp, /\nexport function registerQuery\(/, "the Compliance block's builder is exported for reuse");
});

/* ── Three sections, three endpoints, one window ──────────────────────────── */

test("it mounts on the shared design-system root and loads both stylesheets", () => {
  assert.match(page, /className="ov-dash oi-dash"/);
  assert.match(page, /import ovDashCss from "\.\/ov-dash\.css\?url";/);
  assert.match(page, /import oiDashCss from "\.\/oi-dash\.css\?url";/);
  assert.match(page, /<link rel="stylesheet" href=\{ovDashCss\} precedence="default" \/>/);
  assert.match(page, /<link rel="stylesheet" href=\{oiDashCss\} precedence="default" \/>/);
});

test("the sections stack in the brief's order: Job Intelligence, Spend & Reporting, Compliance", () => {
  const order = ["<JobIntelSection", "<SpendSection", "<ComplianceSection"].map((tag) => page.indexOf(tag));
  assert.ok(order.every((index) => index > 0), "all three are composed");
  assert.ok(order[0] < order[1] && order[1] < order[2], "in that order");
  for (const title of ['title="Job Intelligence"', 'title="Spend & Reporting"', 'title="Compliance"']) {
    assert.match(page, new RegExp(title.replace(/[&]/g, "\\$&")), title);
  }
});

test("three reads in parallel, each keeping its figures through a failed poll", () => {
  assert.match(page, /useOpsQuery<OvOverview>\("\/api\/overview\/metrics", search, \{ keepOnError: true \}\)/);
  assert.match(page, /useOpsQuery<RpMetrics>\("\/api\/reports\/metrics", reportsSearch, \{ keepOnError: true \}\)/);
  assert.match(page, /useOpsQuery<CpMetrics>\("\/api\/compliance\/metrics", complianceSearch, \{ keepOnError: true \}\)/);
});

test("every read sends an explicit window; compliance, a snapshot, sends the portfolio alone", () => {
  const memo = page.slice(page.indexOf("const search = useMemo("), page.indexOf("}, [portfolio, from, to]);"));
  assert.match(memo, /const next = new URLSearchParams\(\);/, "built from nothing, not the address bar");
  assert.match(memo, /next\.set\("from", from\);\s*next\.set\("to", to\);/, "from and to, always");
  const reports = page.slice(page.indexOf("const reportsSearch = useMemo("), page.indexOf("}, [search]);"));
  assert.match(reports, /next\.set\("trendRange", "6m"\);/);
  assert.match(reports, /next\.set\("sitesRange", "page"\);/);
  const compliance = page.slice(page.indexOf("const complianceSearch = useMemo("), page.indexOf("}, [portfolio]);"));
  assert.match(compliance, /next\.set\("portfolio", portfolio\)/);
  assert.doesNotMatch(compliance, /"from"|"to"/, "the compliance figures are today's snapshot");
});

test("the default range is the last twelve months, month-aligned, never written to the URL", () => {
  assert.deepEqual(jobs.oiDefaultRange(new Date("2026-09-11T10:00:00Z")), { from: "2025-10-01", to: "2026-09-11" });
  assert.deepEqual(jobs.oiDefaultRange(new Date("2026-01-31T23:30:00Z")), { from: "2025-02-01", to: "2026-01-31" });
  assert.deepEqual(jobs.oiDefaultRange(new Date("2026-12-01T00:00:00Z")), { from: "2026-01-01", to: "2026-12-01" });
  /* Recomputed when the UTC day turns (review finding): the poll refreshes the
     calendar, so a tab left open overnight does not count up to yesterday. */
  assert.match(page, /return \{ range: oiDefaultRange\(now\), presets: oiRangePresets\(now\) \};/);
  assert.match(page, /current\.range\.from === today\.from && current\.range\.to === today\.to\s*\? current/);
  /* And a URL day must be a real calendar day, not just the right shape. */
  assert.match(page, /const from = oiIsCalendarDay\(fromParam\) \? fromParam : fallback\.from;/);
  assert.equal(jobs.oiIsCalendarDay("2026-02-30"), false);
  assert.equal(jobs.oiIsCalendarDay("2026-09-11"), true);
  assert.match(page, /resetLabel="Reset to the last 12 months"/);
});

test("the URL owns portfolio, from and to; nothing is kept in browser storage", () => {
  assert.match(page, /const \{ params, setParams \} = useQueryState\(\);/);
  assert.match(page, /params\.get\("portfolio"\)/);
  for (const [name, source] of [
    [PAGE, page],
    [CHARTS, charts],
    [SHELL, shell],
  ]) {
    assert.doesNotMatch(codeOnly(source), /localStorage|sessionStorage/, `${name} keeps no state outside the URL`);
  }
});

test("it polls every sixty seconds while visible and refetches on focus", () => {
  assert.match(page, /const REFRESH_INTERVAL_MS = 60_000;/);
  assert.match(page, /if \(document\.visibilityState !== "visible"\) return;[\s\S]{0,420}reloadAll\(\);/);
  assert.match(page, /window\.addEventListener\("focus", refreshIfVisible\);/);
  assert.match(page, /document\.addEventListener\("visibilitychange", refreshIfVisible\);/);
  assert.match(page, /window\.setInterval\(refreshIfVisible, REFRESH_INTERVAL_MS\)/);
  assert.match(page, /window\.clearInterval\(timer\);/);
  assert.match(page, /reloadOverview\(\);\s*reloadReports\(\);\s*reloadCompliance\(\);/, "all three re-read");
});

test("section 1 reads only intel, and draws an empty state when the server does not send it", () => {
  assert.match(page, /const intel = data\?\.intel \?\? null;/);
  assert.match(page, /intel\?: OiIntel \| null;/);
  assert.match(page, /This server does not send job intelligence yet/);
});

/* ── It computes nothing ──────────────────────────────────────────────────── */

test("the wire contracts are imported as types, and the drizzle module not at all", () => {
  assert.match(page, /import type \{ OiIntel, OiPriorityKey, OiSlice \} from "\.\.\/\.\.\/\.\.\/lib\/overview-intel-contract";/);
  assert.match(page, /import type \{[^}]*RpMetrics[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/reports-dash-contract";/);
  assert.match(page, /import type \{ CpMetrics, CpRegisterFilter, CpStateKey \} from "\.\.\/\.\.\/\.\.\/lib\/compliance-dash-contract";/);
  const code = codeOnly(page);
  assert.doesNotMatch(code, /from "\.\.\/\.\.\/\.\.\/lib\/overview-metrics"/, "overview-metrics reaches drizzle");
  assert.doesNotMatch(code, /import \{[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/(overview-intel|reports-dash|compliance-dash)-contract"/);
});

test("no job list reaches the page, and no figure is recounted", () => {
  for (const source of [page, charts, shell]) {
    const code = codeOnly(source);
    assert.doesNotMatch(code, /\/api\/maintenance|requests\.filter|\/api\/dashboard\//);
    assert.doesNotMatch(code, /\.reduce\(/, "no sum over anything");
  }
});

test("colour comes from the shared policy and the payload's own thresholds", () => {
  assert.match(page, /import \{ QUALITY_ARC, SLA_TARGET_ARC, qualityTone, rateTone \} from "\.\.\/\.\.\/\.\.\/lib\/dashboard-policy";/);
  /* The SLA headline uses the SLA target's thresholds, like its bars (review
     finding: 92% was teal on the gauge and amber on a bar). */
  assert.match(page, /qualityTone\(sla\.percent, SLA_TARGET_ARC\)/, "the SLA gauge");
  assert.match(page, /rateTone\(repeat\.percent, policy\.repeatThresholds\)/, "the repeat rate — lower is better");
  assert.match(page, /qualityTone\(sites\.percent, policy\.thresholds\)/, "the sites gauge");
  assert.match(page, /qualityTone\(ring\.percent, policy\.thresholds\)/, "each requirement type");
  assert.doesNotMatch(codeOnly(page), />=\s*(90|75)\b|<\s*(90|75)\b/, "no quality threshold literal in the component");
  assert.match(page, /row\.percent >= target/, "the SLA bars against the payload's own target");
});

test("the palette colours by meaning, and a rolled-up bucket is always muted", () => {
  assert.deepEqual(palette.oiSeriesColours(["a", "__other__", "b"]), [
    "var(--accent-primary)",
    "var(--muted)",
    "var(--accent-secondary)",
  ]);
  assert.equal(palette.oiIsRollup("__not_recorded__"), true);
  assert.equal(palette.oiIsRollup("Other"), false, "a real category called Other is a category");
  assert.match(page, /urgent: OI_COLOUR\.critical,/, "High priority is a warning whatever its size");
  assert.match(page, /expired: OI_COLOUR\.critical,/);
  assert.match(page, /weekly: OI_COLOUR\.critical,/);
});

/* ── Every figure opens the list it counted ───────────────────────────────── */

test("section 1's drills speak the board's vocabulary, with the portfolio as its sites", () => {
  const q = (pairs, sites = []) => rp.rpJobsQuery(pairs, sites);
  assert.equal(q(jobs.OI_OPEN), "family=open");
  assert.equal(q(jobs.OI_OVERDUE), "family=open&overdue=1", "the SLA gauge and tile: the jobs failing SLA");
  assert.equal(q(jobs.OI_BREACH), "family=open&risk=breach", "the breach-risk gauge");
  assert.equal(
    q(jobs.oiCompletedPairs({ from: "2025-10-01", to: "2026-09-11" })),
    "measure=completed&period=custom&from=2025-10-01&to=2026-09-11",
  );
  assert.equal(
    q(jobs.oiStatusPairs({ label: "Other statuses", labels: ["On hold", "Quoted"] })),
    "family=open&meter=Other+statuses&status=On+hold%7CQuoted",
    "a folded status opens every status inside it",
  );
  assert.equal(q(jobs.oiOpenByPairs("tier", ["1"])), "family=open&tier=1");
  assert.equal(q(jobs.oiOpenByPairs("engineer", ["Handyman"]), ["a", "b"]), "family=open&engineer=Handyman&site=a%7Cb");
  assert.equal(
    q(jobs.oiAgingPairs({ oldestDay: "2026-06-25", cutoff: "2026-08-27" })),
    "family=open&measure=requested&period=custom&from=2026-06-25&to=2026-08-27",
  );
  assert.equal(jobs.oiAgingPairs({ oldestDay: null, cutoff: "2026-08-27" }), null, "nothing aged: no drill");
  assert.equal(q(jobs.oiVolumePairs({ from: "2025-10-01", to: "2026-09-11" })), "period=custom&from=2025-10-01&to=2026-09-11");
});

test("every section-1 figure is wired to its drill, and the breach gauge is a real control", () => {
  assert.match(page, /const openDrill = drill\(OI_OPEN\);/);
  assert.match(page, /const overdueDrill = drill\(OI_OVERDUE\);/);
  assert.match(page, /const completedDrill = drill\(oiCompletedPairs\(range\)\);/);
  assert.match(page, /onSelect=\{drill\(OI_BREACH\)\.go\}/);
  assert.match(page, /onSelect=\{agingPairs \? drill\(agingPairs\)\.go : undefined\}/);
  assert.match(page, /const jobsQuery = rpJobsQuery\(pairs, sites\);/);
  assert.match(page, /const sites = data\.portfolio\.siteIds;/);
});

test("the job-volume average divides by the calendar months the range touches", () => {
  assert.equal(jobs.oiMonthsSpanned("2025-10-01", "2026-09-11"), 12);
  assert.equal(jobs.oiMonthsSpanned("2026-09-11", "2025-10-01"), 12, "a reversed pair is the same range");
  assert.equal(jobs.oiMonthsSpanned("2026-09-01", "2026-09-11"), 1);
  assert.equal(jobs.oiMonthsSpanned("", "2026-09-11"), 1, "never a division by nothing");
  assert.match(page, /const perMonth = Math\.round\(repeat\.jobsInRange \/ months\);/);
});

test("section 2 reuses the Reports block's own drill builders, exactly as it calls them", () => {
  assert.match(
    page,
    /import \{\s*rpJobsQuery,\s*rpKpiQuery,\s*rpRecurrenceQuery,\s*rpRepeatIssueQuery,\s*rpRepeatQuery,\s*rpRepeatSiteQuery,\s*rpSiteBarQuery,\s*rpTrendQuery,\s*\} from "\.\/rp-dash";/,
  );
  /* RE-POINTED 2026-09-12: the Reports block's KPI drill now takes the
     figure's stable job type token (`drillType` — the type's id, null for the
     total), so section 2 passes exactly that, as the block does. */
  assert.match(page, /rpKpiQuery\(kpi\.drillType, scope, sites\)/);
  assert.match(page, /rpTrendQuery\(source, sites\)/);
  assert.match(page, /rpSiteBarQuery\(row\.siteId, topSites\)/);
  assert.match(page, /rpSiteBarQuery\("__unassigned__", topSites\)/, "No site, in the View all");
  assert.match(page, /rpRepeatQuery\(scope, sites\)/);
  assert.match(page, /rpRepeatIssueQuery\(slice\.labels, scope, sites\)/);
  assert.match(page, /rpRepeatSiteQuery\(slice\.labels, scope\)/);
  assert.match(page, /rpRecurrenceQuery\(band\.key, scope, sites\)/);
});

test("section 3 applies the payload's own register filters through registerQuery", () => {
  assert.match(page, /import \{ registerQuery \} from "\.\/cp-dash";/);
  /* The portfolio travels with the drill (review finding): the Compliance page
     opens on the portfolio its block counted, not "All portfolios". */
  assert.match(page, /const base = data\.portfolio\.id && data\.portfolio\.id !== "all" \? new URLSearchParams\(\{ portfolio: data\.portfolio\.id \}\) : "";/);
  assert.match(page, /const registerSearch = registerQuery\(base, filter, siteIds\)\.toString\(\);/);
  assert.match(page, /go: \(\) => onCompliance\(registerSearch\)/);
  assert.match(page, /register\(score\.filters\[slice\.key as CpStateKey\]\)/, "a score segment or legend row");
  assert.match(page, /register\(found\.filter\)\.go\(\)/, "a renewal segment");
  assert.match(page, /const destination = register\(ring\.filter\);/, "a requirement-type ring");
  assert.match(page, /onSelect=\{register\(ring\.filter\)\.go\}/, "a countdown ring");
  assert.match(
    page,
    /sitesFailing\s*\? \(\) => onSites\(new URLSearchParams\(\{ sites: sites\.notFullyCompliantIds\.join\("\|"\) \}\)\.toString\(\)\)\s*: undefined/,
    "the sites gauge opens the sites that are not compliant, and is no control when there are none",
  );
  assert.match(page, /value=\{sitesScored \? `\$\{sites\.percent\}%` : "—"\}/, "no site in the score is not a failing 0%");
});

test("every drillable element is a real link or button; a picture is role=img", () => {
  assert.match(charts, /<a\s+className=\{className\}\s+href=\{href\}\s+aria-label=\{label\}/);
  assert.match(charts, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;/);
  assert.match(charts, /<button type="button" className="oi-gauge oi-gauge--button" aria-label=\{label\} onClick=\{onSelect\}>/);
  assert.match(charts, /<span className="oi-gauge" role="img" aria-label=\{label\}>/);
  /* The weekly bars are drillable: a group of named buttons when a week can
     open the jobs closed in it, and one labelled picture only when nothing can. */
  assert.match(charts, /role=\{onSelect \? "group" : "img"\}/);
  assert.match(charts, /aria-label=\{`\$\{title\}\. Opens the jobs closed that week\.`\}/);
  assert.match(charts, /aria-expanded=\{expanded\}/, "View all is a disclosure");
});

/* ── The new shapes ───────────────────────────────────────────────────────── */

test("the gauge is a 180° arc from nine o'clock over the top, round caps, full muted track", () => {
  assert.match(
    charts,
    /const GAUGE_ARC = `M \$\{GAUGE_CX - GAUGE_RADIUS\} \$\{GAUGE_CY\} A \$\{GAUGE_RADIUS\} \$\{GAUGE_RADIUS\} 0 0 1 \$\{GAUGE_CX \+ GAUGE_RADIUS\} \$\{GAUGE_CY\}`;/,
  );
  assert.match(charts, /const GAUGE_LENGTH = Math\.PI \* GAUGE_RADIUS;/);
  assert.match(charts, /stroke="var\(--ov-track\)"/);
  assert.equal((charts.match(/strokeLinecap="round"/g) ?? []).length >= 2, true, "track and arc both round-capped");
  assert.match(charts, /\{drawn > 0\.5 \? \(/, "an arc of nothing draws no dot");
  assert.match(charts, /const \[eased = 0\] = useOvSweep\(\[safe\]\);/, "it sweeps like every other chart");
});

test("the glow is one filter, defined once, applied to coloured strokes and never to a track", () => {
  assert.match(charts, /<filter id="oi-glow" x="-30%" y="-30%" width="160%" height="160%">/);
  assert.match(charts, /<feGaussianBlur stdDeviation="2\.5" result="b" \/>/);
  assert.match(charts, /<feMergeNode in="b" \/>\s*<feMergeNode in="SourceGraphic" \/>/);
  assert.equal((page.match(/<OiGlowDefs \/>/g) ?? []).length, 1, "defined once per page");
  assert.match(css, /\.ov-dash\.oi-dash \.ov-chart__svg circle\[stroke\]:not\(\[stroke\*="track"\]\),\s*\.ov-dash\.oi-dash \.oi-gauge__arc \{\s*filter: url\(#oi-glow\);/);
  assert.match(css, /\.oi-bars__fill,[\s\S]*?box-shadow: 0 0 8px/, "HTML bars glow by box-shadow");
});

test("the target bars draw a marker at the payload's SLA target", () => {
  assert.match(page, /target=\{target\}/);
  assert.match(page, /const target = intel\.slaTargetPercent;/);
  assert.match(charts, /<span className="oi-targets__marker" style=\{\{ left: `\$\{marker\}%` \}\} \/>/);
});

/* ── The stylesheet ───────────────────────────────────────────────────────── */

test("the stylesheet declares the brief's palette, and repoints the shared tokens at it", () => {
  /*
   * RE-POINTED: the approved colour system replaced the neon palette with its
   * dark palette — turquoise #12b4a8 primary (was #22e6c5), light turquoise
   * #55e8d8 secondary (was violet #c74fff; the palette has no purple), yellow
   * #ffd447 (was #ffc24b), red #ff4d5e (was #ff4d7a), blue #38bdf8 (was
   * #3fa9f5), muted turquoise #147d77 (was #7af5db), and the approved text,
   * card, ground and border values. `--muted` is the approved muted text grey
   * #8099a3 (was #4a5b72) because a muted KPI caption is printed in it.
   */
  for (const [token, hex] of [
    ["--accent-primary", "#12b4a8"],
    ["--accent-secondary", "#55e8d8"],
    ["--accent-amber", "#ffd447"],
    ["--accent-critical", "#ff4d5e"],
    ["--accent-blue", "#38bdf8"],
    ["--accent-teal-light", "#147d77"],
    ["--accent-green", "#25d98b"],
    ["--accent-orange", "#ff8a3d"],
    ["--muted", "#8099a3"],
    ["--text-primary", "#f5fafc"],
    ["--text-secondary", "#b8c8ce"],
    ["--text-tertiary", "#8099a3"],
    ["--ov-bg", "#07131c"],
    ["--ov-card", "#102630"],
    ["--ov-card-border", "#163640"],
  ]) {
    assert.match(css, new RegExp(`${token}: ${hex};`, "i"), `${token} is ${hex}`);
  }
  assert.match(css, /--ov-teal: var\(--accent-primary\);/);
  assert.match(css, /--control-own-fg: var\(--text-primary\);/, "buttons opt out of the dark button blanket");
});

test("the brief's type scale: 13.5px card titles, 26–30px headline numbers, small captions", () => {
  assert.match(css, /\.oi-card__title \{[^}]*font-size: 13\.5px;[^}]*font-weight: 700;/);
  assert.match(css, /\.oi-kpi__value \{[^}]*font-size: 28px;[^}]*font-weight: 800;/);
  assert.match(css, /\.oi-kpi__value \{\s*font-size: 30px;/);
  assert.match(css, /\.oi-card \{[^}]*border-radius: 15px;/, "cards at 14–16px radius");
});

test("below 768 every grid is ONE column (max-width: 767px); two from 768; three and four from 1024", () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /* The base, outside any media query, is a single column. */
  const base = bare.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  assert.match(base, /\.ov-dash\.oi-dash \.oi-kpis,\s*\.ov-dash\.oi-dash \.oi-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  /* Every multi-column rule for the two grids lives at 768 or wider. */
  const blocks = [...bare.matchAll(/@media \(min-width: (\d+)px\) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)];
  const multi = blocks.filter(([, , body]) => /\.oi-(kpis|grid)[^{]*\{[^}]*repeat\(/.test(body));
  assert.ok(multi.length >= 2, "the two- and three/four-column tiers exist");
  for (const [, width] of multi) assert.ok(Number(width) >= 768, `a multi-column grid at ${width}px`);
  assert.match(bare, /@media \(min-width: 768px\) \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(bare, /@media \(min-width: 1024px\) \{\s*\.ov-dash\.oi-dash \.oi-kpis \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(bare, /\.ov-dash\.oi-dash \.oi-grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test("on a phone: 4 × 2 requirement types, rings 2–3 a row, a 120px chart floor, legends beneath", () => {
  assert.match(css, /\.ov-dash\.oi-dash \.oi-types \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/, "never eight in a row");
  assert.match(css, /\.ov-dash\.oi-dash \.oi-rings--countdown \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.ov-dash\.oi-dash \.oi-rings--bands \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.oi-donut > \.ov-chart \{[^}]*min-width: 120px;/);
  assert.match(css, /\.oi-gauge__svg \{[^}]*min-width: 120px;/);
  assert.match(css, /\.ov-dash\.oi-dash \.oi-donut \{[^}]*flex-direction: column;/, "the legend wraps below the ring");
});

test("every tap target is at least 44px on a phone or a coarse pointer", () => {
  for (const query of ["@media (pointer: coarse)", "@media (max-width: 767px)"]) {
    const block = css.slice(css.indexOf(query), css.indexOf("\n}\n", css.indexOf(query)));
    for (const cls of ["oi-legend__row", "oi-bars__row", "oi-targets__row", "oi-more", "oi-footer__tool"]) {
      assert.match(block, new RegExp(`\\.${cls}`), `${query}: ${cls}`);
    }
    assert.match(block, /min-height: 44px;/);
  }
});

test("only the agreed breakpoints, and every rule scoped to the island", () => {
  const widths = [...css.matchAll(/\((?:min|max)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.ok(widths.length > 0);
  for (const width of widths) assert.ok([640, 767, 768, 1024, 1280].includes(width), `${width}px`);
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{/g, "")
    .match(/[^{}]+(?=\{)/g)
    .map((selector) => selector.trim())
    .filter(Boolean);
  for (const selector of rules) {
    for (const part of selector.split(",")) {
      const trimmed = part.trim();
      if (trimmed === ".ops-sheet.oi-tool > .ops-sheet__panel") continue;
      assert.match(trimmed, /\.ov-dash\.oi-dash/, `"${trimmed}" is scoped to .ov-dash.oi-dash`);
    }
  }
});

test("text colours are written under body[data-theme], so the island stays dark in either theme", () => {
  for (const cls of [
    "oi-section__title",
    "oi-section__subtitle",
    "oi-card__title",
    "oi-kpi__value",
    "oi-kpi__label",
    "oi-legend__label",
    "oi-legend__value",
    "oi-gauge__value",
    "oi-note",
    "oi-bars__label",
  ]) {
    assert.match(css, new RegExp(`body\\[data-theme\\] \\.ov-dash\\.oi-dash[^{]*\\.${cls}`), cls);
  }
  for (const [expression] of css.matchAll(/(?:calc|clamp)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)) {
    const bare = expression.replace(/var\(--[\w-]+\)/g, "V");
    assert.doesNotMatch(bare, /[^\s(]\+|\+[^\s]/, `${expression}: spaces around +`);
    assert.doesNotMatch(bare, /[\w%)]-[\w(.]/, `${expression}: spaces around -`);
  }
});

/* ── No sample figure ships ───────────────────────────────────────────────── */

test("none of the reference's sample numbers appear anywhere in the page's source", () => {
  const samples = [
    "39,262",
    "25,087",
    "14,175",
    "675",
    "£32,887",
    "32,887",
    "22,232",
    "£32.9k",
    "12,195",
    "9,029",
    "8,064",
    "380 jobs",
    "4.2 days",
    "0.9 days",
    "Sample values",
  ];
  for (const [name, source] of [
    [PAGE, page],
    [CHARTS, charts],
    [CSS, css],
    [SHELL, shell],
  ]) {
    for (const sample of samples) {
      assert.ok(!source.includes(sample), `${name} does not contain the sample "${sample}"`);
    }
  }
});

/* ── Against the live estate ──────────────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body && body.intel);
  } catch {
    return false;
  }
}

async function allJobs() {
  const rows = [];
  for (let offset = 0, round = 0; round < 20; round += 1) {
    const response = await fetch(`${BASE}/api/maintenance?limit=1000&offset=${offset}`, { headers });
    const body = await response.json();
    rows.push(...(body.requests ?? []));
    if (!body.hasMore || typeof body.nextOffset !== "number") break;
    offset = body.nextOffset;
  }
  return rows;
}

test("every section-1 drill opens exactly the jobs its figure counted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server answering with intel");
    return;
  }
  const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
  const rows = await allJobs();
  assert.ok(rows.length > 0, "the estate has jobs to filter");
  const opened = (pairs, sites) => {
    const filter = readDrillFilter(new URLSearchParams(rp.rpJobsQuery(pairs, sites)), new Date(), { population: rows });
    return rows.filter((row) => filter.matches(row)).length;
  };

  const search = "from=2025-10-01&to=2026-09-11";
  const overview = await (await fetch(`${BASE}/api/overview/metrics?${search}`, { headers })).json();
  const reports = await (await fetch(`${BASE}/api/reports/metrics?${search}`, { headers })).json();
  const { intel, range } = overview;
  const sites = overview.portfolio.siteIds;
  const cases = [
    ["open jobs", jobs.OI_OPEN, intel.open],
    ["overdue (SLA)", jobs.OI_OVERDUE, intel.sla.overdue],
    ["breach risk", jobs.OI_BREACH, intel.breachRisk.count],
    ["completed", jobs.oiCompletedPairs(range), intel.completed],
    ...intel.status.map((slice) => [`status ${slice.label}`, jobs.oiStatusPairs(slice), slice.value]),
    ...intel.priority.map((slice) => [`priority ${slice.label}`, jobs.oiOpenByPairs("priority", slice.labels), slice.value]),
    ...intel.tiers.map((slice) => [`tier ${slice.label}`, jobs.oiOpenByPairs("tier", slice.labels), slice.value]),
    ...intel.engineers.map((slice) => [`engineer ${slice.label}`, jobs.oiOpenByPairs("engineer", slice.labels), slice.value]),
    ...intel.labels.map((slice) => [`label ${slice.label}`, jobs.oiOpenByPairs("label", slice.labels), slice.value]),
    ["job volume", jobs.oiVolumePairs(reports.range), reports.repeat.jobsInRange],
  ];
  const aging = jobs.oiAgingPairs(intel.aging);
  if (aging) cases.push(["aging backlog", aging, intel.aging.count]);
  for (const [name, pairs, figure] of cases) {
    assert.equal(opened(pairs, sites), figure, `${name}: the list holds ${opened(pairs, sites)} where the figure says ${figure}`);
  }
});
