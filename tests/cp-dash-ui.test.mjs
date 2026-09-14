/**
 * THE COMPLIANCE DASHBOARD BLOCK — its UI contract, pinned at the source.
 *
 * `cp-dash.tsx` draws `GET /api/compliance/metrics` above the Compliance
 * register; `cp-dash-charts.tsx` holds the one new chart shape (the segmented
 * ring); `cp-dash.css` holds the brief's `--cp-*` tokens and the grids. The
 * endpoint's own tests hold the SERVER to the numbers. These hold the BLOCK to
 * the rules that make those numbers trustworthy on screen:
 *
 *   · it fetches once, keyed on its own three parameters, and polls politely;
 *   · it computes nothing — every drill applies the payload's own filter;
 *   · a drill REPLACES the register's filters, carries the portfolio as sites,
 *     and lands on the register through a real anchor;
 *   · it is a visual block — no table, no text list — scoped and always dark;
 *   · the register below reads, shows and clears what the block writes.
 *
 * Measured against the live payload when this was written: every one of the
 * 25 drill targets opened a register whose own count equalled the figure that
 * was clicked (score legend, type rings, expired dots, countdown rings,
 * renewal rows, "View all renewals", a donut arc).
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

const BLOCK = "app/(app)/portal/ops/cp-dash.tsx";
const CHARTS = "app/(app)/portal/ops/cp-dash-charts.tsx";
const CSS = "app/(app)/portal/ops/cp-dash.css";
const PAGE = "app/(app)/portal/ops/compliance-page.tsx";

const block = await read(BLOCK);
const charts = await read(CHARTS);
const css = await read(CSS);
const page = await read(PAGE);

/* ── The mount the shell composes ─────────────────────────────────────────── */

test("the block keeps the entry point the shell mounts", async () => {
  assert.match(block, /export function CpDash\(\{\s*onNavigateToSites,\s*\}: \{/);
  assert.match(block, /onNavigateToSites: \(query: string\) => void;/);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /<CpDash\s*\n\s*onNavigateToSites=\{\(query\) => openSectionWithQuery\(onNavigate, "stores", query\)\}/,
    "portal-app.tsx mounts it above the register with the Sites callback",
  );
});

test("it mounts on the shared design-system root and loads both stylesheets", () => {
  assert.match(block, /<section className="ov-dash cp-dash" aria-busy=\{loading\} aria-label="Compliance overview">/);
  assert.match(block, /import ovDashCss from "\.\/ov-dash\.css\?url";/);
  assert.match(block, /import cpDashCss from "\.\/cp-dash\.css\?url";/);
  assert.match(block, /<link rel="stylesheet" href=\{cpDashCss\} precedence="default" \/>/);
});

/* ── One fetch, keyed on the block's own parameters ───────────────────────── */

test("one request for the whole block, keeping figures through a refetch or a failed poll", () => {
  assert.match(
    block,
    /useOpsQuery<CpMetrics>\(\s*"\/api\/compliance\/metrics",\s*search,\s*\{ keepOnError: true \},?\s*\)/,
  );
});

test("the fetch key is portfolio, from and to — never the register's keys", () => {
  const memo = block.slice(block.indexOf("const search = useMemo("), block.indexOf("}, [portfolio, fromParam, toParam]);"));
  assert.ok(memo.length > 0, "the search memo exists");
  assert.match(memo, /const next = new URLSearchParams\(\);/, "built from nothing, not from the address bar");
  assert.match(memo, /next\.set\("portfolio", portfolio\)/);
  assert.match(memo, /next\.set\("from", fromParam\)/);
  assert.match(memo, /next\.set\("to", toParam\)/);
  assert.doesNotMatch(memo, /window\.location/, "a register chip must not refetch the block");
});

test("it polls every sixty seconds while visible and refetches on focus", () => {
  assert.match(block, /const REFRESH_INTERVAL_MS = 60_000;/);
  assert.match(block, /if \(document\.visibilityState === "visible"\) reload\(\);/);
  assert.match(block, /window\.addEventListener\("focus", refreshIfVisible\);/);
  assert.match(block, /document\.addEventListener\("visibilitychange", refreshIfVisible\);/);
  assert.match(block, /window\.setInterval\(refreshIfVisible, REFRESH_INTERVAL_MS\)/);
  assert.match(block, /window\.clearInterval\(timer\);/, "and stops when the block unmounts");
});

test("the skeleton is only for the render with no payload, at the cards' final size", () => {
  assert.match(block, /if \(!data\) \{/);
  assert.match(block, /ov-card ov-skeleton cp-skeleton cp-skeleton--score/);
  assert.match(block, /ov-card ov-skeleton cp-skeleton cp-skeleton--renewals/);
  for (const name of ["score", "types", "renewals"]) {
    assert.match(css, new RegExp(`\\.cp-skeleton--${name} \\{\\s*min-height: \\d+px;`), `${name} skeleton has a height`);
  }
});

/* ── It computes nothing ──────────────────────────────────────────────────── */

test("the wire contract is imported as a type, from the module with no imports", () => {
  assert.match(block, /import type \{\s*CpMetrics,\s*CpRegisterFilter,\s*CpStateKey,\s*\} from "\.\.\/\.\.\/\.\.\/lib\/compliance-dash-contract";/);
  assert.doesNotMatch(codeOnly(block), /import \{[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/compliance-dash-contract"/);
  assert.doesNotMatch(codeOnly(block), /from "\.\.\/\.\.\/\.\.\/lib\/compliance-dash"/, "never the server module");
  assert.doesNotMatch(codeOnly(charts), /compliance-dash-contract|compliance-dash"/);
});

test("no figure is recounted in the browser", () => {
  const code = codeOnly(block);
  assert.doesNotMatch(code, /\.reduce\(/, "no sum over anything");
  assert.doesNotMatch(code, /readComplianceRegister|\/api\/compliance\/records|\/api\/compliance\/summary/);
});

test("the sites gauge takes its colour from the payload's thresholds, not typed ones", () => {
  assert.match(block, /import \{ qualityTone, type ArcTone \} from "\.\.\/\.\.\/\.\.\/lib\/dashboard-policy";/);
  assert.match(block, /TONE_COLOUR\[qualityTone\(sites\.percent, policy\.thresholds\)\]/);
  assert.doesNotMatch(codeOnly(block), />=\s*(90|75)\b|<\s*(90|75)\b/, "no threshold literal in the component");
});

test("rings draw the four states in the score donut's order and colours", () => {
  assert.match(block, /const STATUS_ORDER: readonly CpStateKey\[\] = \["compliant", "expiring", "expired", "missing"\];/);
  for (const [key, token] of [
    ["compliant", "--cp-compliant"],
    ["expiring", "--cp-expiring"],
    ["expired", "--cp-expired"],
    ["missing", "--cp-missing"],
  ]) {
    assert.match(block, new RegExp(`${key}: "var\\(${token}\\)"`));
  }
});

/* ── Every drill applies the payload's own filter ─────────────────────────── */

test("every element applies the filter the server counted it with", () => {
  assert.match(block, /applyRegisterFilter\(score\.filters\[key as CpStateKey\]\)/, "score segment and legend row");
  assert.match(block, /href=\{registerHref\(score\.filters\[slice\.key as CpStateKey\]\)\}/);
  assert.match(block, /if \(ring\) applyRegisterFilter\(ring\.filter\);/, "a type ring");
  assert.match(block, /if \(ring\) applyRegisterFilter\(ring\.expiredFilter\);/, "its expired dot");
  assert.match(block, /onSelect=\{\(\) => applyRegisterFilter\(ring\.filter\)\}/, "a countdown ring");
  assert.match(block, /if \(found\) applyRegisterFilter\(found\.filter\);/, "a renewal segment");
  assert.match(block, /onActivate=\{\(\) => applyRegisterFilter\(slice\.filter\)\}/, "a renewal legend row");
  assert.match(
    block,
    /applyRegisterFilter\(renewals\.allFilter, \{ sort: "soonest" \}\)/,
    "View all renewals, sorted by due date",
  );
  assert.match(block, /onActivate=\{\(\) => applyRegisterFilter\(\{\}\)\}/, "View register: no filter");
});

test("a drill replaces the register's filters and keeps the block's own", () => {
  assert.match(
    block,
    /* Re-pointed: a "Who's renewing" slice now drills by contractor RECORD
       (`contractor=`), so a drill replaces that key too. */
    /const REGISTER_KEYS = \["site", "state", "kind", "who", "due", "q", "scored", "open", "view", "contractor"\] as const;/,
  );
  const keys = block.match(/const REGISTER_KEYS = \[([^\]]*)\]/)[1];
  for (const own of ["portfolio", "from", "to", "sort"]) {
    assert.ok(!keys.includes(`"${own}"`), `${own} is not one of the register's keys`);
  }
  const fn = block.slice(block.indexOf("function registerQuery("), block.indexOf("function scrollToRegister"));
  assert.match(fn, /for \(const key of REGISTER_KEYS\) next\.delete\(key\);/);
  /*
   * NARROWED, NOT LOOSENED: `portfolio` and `sort` survive every drill, but the
   * header's due-date range now survives only the plain "View register" link.
   * The figures ignore the range, so a figure's drill that kept it listed
   * fewer rows than the figure counted — the "No due date" ring opened empty
   * under any range. Review finding, 2026-09-11.
   */
  assert.match(
    fn,
    /if \(Object\.keys\(filter\)\.length > 0\) \{\s*next\.delete\("from"\);\s*next\.delete\("to"\);\s*\}/,
    "a figure's drill drops the range the figure never applied",
  );
  assert.match(fn, /for \(const value of values\) if \(value\) next\.append\(key, value\);/, "repeated, never joined");
  assert.match(fn, /for \(const id of siteIds\) if \(id\) next\.append\("site", id\);/, "the portfolio travels as its sites");
});

test("the click and the link are the same address", () => {
  assert.match(block, /setParams\(registerQuery\(window\.location\.search, filter, portfolioSiteIds, extra\)\);/);
  assert.match(block, /const query = registerQuery\(params, filter, portfolioSiteIds, extra\)\.toString\(\);/);
  assert.match(block, /const ROUTE_COMPLIANCE = "\/dashboard\/compliance";/);
  assert.match(block, /query \? `\$\{ROUTE_COMPLIANCE\}\?\$\{query\}` : ROUTE_COMPLIANCE/);
  /* Legend rows and card links are real anchors; a plain click stays in page. */
  assert.match(block, /<a\s+className=\{className\}\s+href=\{href\}/);
  assert.match(block, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return;/);
});

test("a drill from a portfolio with no sites in scope says so in the register's chips", async () => {
  /* The drill carries `NO_SITE_IN_SCOPE`, which matches nothing — correctly —
     and the chip reads the words, not the placeholder id. */
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  assert.match(page, /\(group\.key === "site" && value === NO_SITE_IN_SCOPE \? NO_SITE_IN_SCOPE_LABEL : null\)/);
});

test("changing the portfolio takes the old portfolio's sites off the register", () => {
  const handler = block.slice(block.indexOf("onPortfolio={(next) =>"), block.indexOf("range={{"));
  /* Re-pointed from "exactly the old portfolio's sites" to "all within the old
     portfolio": the register now intersects with the portfolio on the server, so
     the client rule only has to stop a stale or partial list stranding the reader
     on an empty register. A selection made under All portfolios is still kept. */
  assert.match(handler, /applied\.every\(\(id\) => previous\.has\(id\)\)/, "every applied site belonged to the portfolio being left");
  assert.match(handler, /query\.delete\("site"\);/);
  assert.match(handler, /query\.delete\("open"\);/);
});

test("the sites gauge opens the Sites list on the sites that are not fully compliant", async () => {
  assert.match(block, /new URLSearchParams\(\{ sites: sites\.notFullyCompliantIds\.join\("\|"\) \}\)\.toString\(\)/);
  /* RE-POINTED: the gauge is a control only when there are sites to open — a
     drill with none opened the unfiltered list — and with no site in the score
     it prints "—" rather than a failing 0%. Review finding, 2026-09-11. */
  assert.match(block, /onSelect=\{sitesFailing \? goToSites : undefined\}/);
  assert.match(block, /readout=\{sitesScored \? undefined : "—"\}/);
  assert.match(block, /const sitesScored = sites\.considered > 0;/);
  const sitesList = await read("app/(app)/portal/ops/sites-list.tsx");
  assert.match(sitesList, /params\.getAll\("sites"\)\.flatMap\(\(value\) => value\.split\("\|"\)\)/, "which splits the list it is sent");
});

/* ── The register is a real anchor, and the scroll lands on it ────────────── */

test("a drill scrolls to the register anchor, instantly for reduced motion", () => {
  assert.match(block, /const REGISTER_ANCHOR = "compliance-register";/);
  assert.match(block, /document\.getElementById\(REGISTER_ANCHOR\)/);
  assert.match(block, /behavior: reduced \? "auto" : "smooth", block: "start"/);
  assert.match(block, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
});

test("the scroll re-aims while the register redraws, and yields to the reader", () => {
  const fn = block.slice(block.indexOf("function scrollToRegister"), block.indexOf("/* ── The block"));
  assert.match(fn, /new ResizeObserver\(/);
  for (const event of ["wheel", "touchstart", "keydown"]) {
    assert.match(fn, new RegExp(`window\\.addEventListener\\("${event}", release`), `${event} hands the page back`);
  }
  assert.match(fn, /window\.setTimeout\(release, SETTLE_MS\)/, "and it always ends");
});

test("the register wraps its filter bar AND body in the anchor, so the bar still sticks", () => {
  const start = page.indexOf('id="compliance-register"');
  assert.ok(start > 0, "the anchor exists");
  const bar = page.indexOf("<OpsFilterBar", start);
  const register = page.indexOf('view === "setup" ?', start);
  const close = page.indexOf("</section>", register);
  assert.ok(bar > start && register > bar && close > register, "bar, then the register, inside the anchor");
  assert.match(page, /scrollMarginTop: 84/, "clear of the sticky topbar");
  assert.match(page, /gap: "inherit"/, "and spaced as the page spaces its rows");
});

/* ── The register reads, shows and clears what the block writes ───────────── */

test("Clear all removes the block's narrowings but not its portfolio", () => {
  const keys = page.slice(page.indexOf("const FILTER_KEYS = ["), page.indexOf("] as const;", page.indexOf("const FILTER_KEYS = [")));
  for (const key of ["site", "state", "kind", "who", "due", "q", "sort", "view", "open", "scored", "from", "to"]) {
    assert.ok(keys.includes(`"${key}"`), `${key} is cleared`);
  }
  assert.ok(!keys.includes('"portfolio"'), "the header's portfolio is the block's to clear");
});

test("the block's narrowings read as words in the register's chips", () => {
  assert.match(page, /return `Due in \$\{low\}–\$\{high\} days`;/, "a countdown band");
  assert.match(page, /\(group\.key === "due" \? dueBandText\(value\) : null\)/);
  assert.match(page, /value: "In the score",/, "scored=1");
  assert.match(page, /return `Due between \$\{/, "a due-date range");
  assert.match(page, /return `Due from \$\{formatShortDate\(start\)\}`;/);
  assert.match(page, /return `Due until \$\{formatShortDate\(end\)\}`;/);
  assert.match(page, /next\.delete\("from"\);\s*next\.delete\("to"\);/, "the range comes off as one");
});

/* ── A visual block: no tables, no text lists ─────────────────────────────── */

test("the block draws no table and no text list", () => {
  for (const [name, source] of [
    [BLOCK, block],
    [CHARTS, charts],
  ]) {
    const code = codeOnly(source);
    /* The whole tag name, so `<link rel="stylesheet">` is not read as `<li`. */
    for (const tag of ["table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "dl"]) {
      assert.doesNotMatch(code, new RegExp(`<${tag}[\\s>]`), `${name} renders no <${tag}> element`);
    }
  }
});

/* ── The segmented ring and its grid ──────────────────────────────────────── */

test("the type rings reuse the Overview's sweep, pin, arc and tooltip", () => {
  assert.match(
    charts,
    /import \{\s*OvArc,\s*OvTip,\s*OvTipAction,\s*ovFraction,\s*useOvHoverCapable,\s*useOvPin,\s*useOvSweep,\s*\} from "\.\/ov-dash-charts";/,
  );
  assert.match(charts, /const eased = useOvSweep\(targets\);/);
  assert.match(charts, /const RING_DESKTOP = 84;/);
  assert.match(charts, /const RING_MOBILE = 64;/);
  assert.match(charts, /const RING_STROKE = 8;/);
  assert.match(charts, /const RING_GAP = 2;/);
  assert.match(charts, /<g transform=\{`rotate\(-90 \$\{half\} \$\{half\}\)`\}>/, "clockwise from twelve o'clock");
});

test("a segment too short for its caps is a dot, never dropped", () => {
  assert.match(charts, /const reserve = present > 1 \? gap \+ stroke : 0;/);
  assert.match(charts, /if \(present > 1 && target \* circumference <= reserve\) \{/);
  assert.match(charts, /dots\.push\(/);
});

test("hover drills on a fine pointer; a tap pins the tooltip on touch", () => {
  assert.match(charts, /if \(hoverCapable\) \{\s*onSelect\(tile\.key\);\s*return;\s*\}/);
  assert.match(charts, /togglePin\(tile\.key\);/);
  assert.match(charts, /<OvTipAction onClick=\{\(\) => onSelect\(activeTile\.key\)\} \/>/);
  assert.match(charts, /View expired →/, "the dot's drill is reachable by touch too");
});

test("the expired dot is its own button, a sibling of the ring's", () => {
  const tile = charts.slice(charts.indexOf('<div className="cp-type" key={tile.key}>'));
  const ringClose = tile.indexOf("</button>");
  const flag = tile.indexOf('className="cp-type__flag"');
  assert.ok(ringClose > 0 && flag > ringClose, "never a button inside a button");
  assert.match(charts, /onClick=\{\(\) => onSelectFlag\(tile\.key\)\}/);
  assert.match(css, /\.cp-type__flag::before \{[^}]*width: 8px;[^}]*height: 8px;[^}]*background: var\(--cp-expired\);/s);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.cp-type__flag \{\s*pointer-events: none;/);
});

test("every chart states its values to a screen reader", () => {
  assert.match(block, /const typesLabel = `Compliance by type: \$\{/);
  assert.match(block, /ariaLabel=\{typesLabel\}/);
  assert.match(block, /aria-label=\{countdownLabel\}/);
  assert.match(block, /ariaLabel="Compliance score"/);
  assert.match(block, /ariaLabel="Who's renewing"/);
  assert.match(charts, /role="group" aria-label=\{ariaLabel\}/);
});

/* ── The stylesheet ───────────────────────────────────────────────────────── */

test("the stylesheet declares the brief's compliance tokens and no second Overview palette", () => {
  /*
   * RE-POINTED: the approved colour system gives compliance one palette
   * everywhere — compliant green #25d98b (was #48a0a8), expiring yellow
   * #ffd447 (was #e09438), expired red #ff4d5e (was #c0442e), missing orange
   * #ff8a3d (was #5c7ca8) — and the renewal urgency scale orange #ff8a3d /
   * yellow #ffd447 / blue #38bdf8 (was #c85024 / #d88c38 / #5878a4), with the
   * neutral grey #64707b (was #44546c).
   */
  for (const [token, hex] of [
    ["--cp-compliant", "#25d98b"],
    ["--cp-expiring", "#ffd447"],
    ["--cp-expired", "#ff4d5e"],
    ["--cp-missing", "#ff8a3d"],
    ["--cp-due-30", "#ff8a3d"],
    ["--cp-due-60", "#ffd447"],
    ["--cp-due-90", "#38bdf8"],
    ["--cp-other", "#64707b"],
  ]) {
    assert.match(css, new RegExp(`${token}: ${hex};`, "i"), `${token} is ${hex}`);
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--ov-[\w-]+\s*:/, "the --ov-* palette is inherited, not copied");
});

test("every rule is scoped to the block", () => {
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media[^{]*\{/g, "")
    .match(/[^{}]+(?=\{)/g)
    .map((selector) => selector.trim())
    .filter(Boolean);
  for (const selector of rules) {
    for (const part of selector.split(",")) {
      assert.match(part.trim(), /\.ov-dash\.cp-dash/, `"${part.trim()}" is scoped to .ov-dash.cp-dash`);
    }
  }
});

test("new text colours are written under body[data-theme], so the block stays dark", () => {
  for (const cls of ["cp-score__caption", "cp-note", "cp-type__name", "cp-type__count", "cp-zone__title", "cp-ring__centre"]) {
    assert.match(css, new RegExp(`body\\[data-theme\\] \\.ov-dash\\.cp-dash[^{]*\\.${cls}`), `${cls}`);
  }
});

test("only the agreed breakpoints, [hidden] stays hidden, and calc() is spaced", () => {
  const widths = [...css.matchAll(/\((?:min|max)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.ok(widths.length > 0);
  for (const width of widths) assert.ok([640, 767, 768, 1024, 1280].includes(width), `${width}px`);
  assert.match(css, /\[hidden\] \{\s*display: none !important;/);
  for (const [expression] of css.matchAll(/(?:calc|clamp)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)) {
    const bare = expression.replace(/var\(--[\w-]+\)/g, "V");
    assert.doesNotMatch(bare, /[^\s(]\+|\+[^\s]/, `${expression}: spaces around +`);
    assert.doesNotMatch(bare, /[\w%)]-[\w(.]/, `${expression}: spaces around -`);
  }
});
