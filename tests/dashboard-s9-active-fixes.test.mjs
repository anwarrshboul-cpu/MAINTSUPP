/**
 * The original dashboard master prompt's §9 — the ACTIVE failures Phase 1
 * confirmed on Production on 2026-09-23, each held here to its fix.
 *
 *   item 7  — "the network tab shows no bulk job fetch for the Overview page".
 *             After one visit to Jobs, every section change re-walked
 *             `/api/maintenance?limit=1000` (≈94 KB), the Overview included.
 *   item 40 — "tap targets ≥ 44px; abbreviated figures reveal full values on
 *             tap and in accessible labels". The tool dialogs' Close was 32x32
 *             and their buttons 42px, the Spend Trend's edge columns 28.5px, the
 *             portfolio select 14.4px; the donuts announced "£29.1k".
 *   item 44 — "skeletons occupy final dimensions; no layout shift". CLS 0.13 at
 *             1440, 0.106 of it Job Intelligence growing from 3 skeleton cards
 *             to 10 and pushing Spend & Reporting down.
 *
 * Items 20 and 25 have executed suites of their own
 * (`contractor-alias-transaction`, `sla-compliance-targets`); item 42 is held
 * in `phase10-a11y-fixes`. These are source contracts — the behaviour itself
 * was measured in a browser on the Preview and on Production, and the numbers
 * are in the §9 acceptance report.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const uncommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── item 7 ──────────────────────────────────────────────────────────────── */

test("item 7: only a surface that reads the job list fetches it — no latch re-walks it elsewhere", async () => {
  const portal = uncommented(await read("app/(app)/portal/portal-app.tsx"));
  assert.match(portal, /if \(!JOB_LIST_SURFACES\.has\(activeSurface\)\) return;\s*let active = true;\s*async function loadRequests\(\)/);
  assert.doesNotMatch(portal, /jobListWanted/, "the latch that fetched on every later section change is gone");
  const surfaces = /const JOB_LIST_SURFACES: ReadonlySet<Section> = new Set<Section>\(\[([^\]]*)\]\)/.exec(portal);
  assert.ok(surfaces, "JOB_LIST_SURFACES is still a literal set");
  assert.doesNotMatch(surfaces[1], /"overview"/, "and the Overview is not one of them");
  assert.doesNotMatch(surfaces[1], /"stores"/);
});

/* ── item 40 ─────────────────────────────────────────────────────────────── */

test("item 40: the Spend Trend's edge columns never fall below 44px, and a desktop plot is unchanged", async () => {
  const charts = await read("app/(app)/portal/ops/ov-dash-charts.tsx");
  assert.match(charts, /const EDGE_COLUMN_MIN_PX = 44;/);
  assert.match(charts, /return `max\(\$\{midpoint\}, \$\{EDGE_COLUMN_MIN_PX\}px\)`;/, "the first boundary is at least 44px in");
  assert.match(charts, /return `min\(\$\{midpoint\}, calc\(100% - \$\{EDGE_COLUMN_MIN_PX\}px\)\)`;/, "and its mirror on the right");
  assert.match(charts, /style=\{\{ left: bandAt\(index\)\.left, width: bandAt\(index\)\.width \}\}/);
});

test("item 40: the portfolio select is itself the 44px target on a touch pointer", async () => {
  const css = await read("app/(app)/portal/ops/ov-dash.css");
  const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));
  assert.match(
    coarse,
    /body\[data-theme\] \.ov-dash \.ov-dash__control--select > select:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[multiple\]\) \{\s*min-height: 44px;/,
  );
  assert.match(coarse, /body\[data-theme\] \.ov-dash \.ov-dash__control--select \{\s*padding-top: 0;\s*padding-bottom: 0;/);
});

test("item 40: the Overview's two tool dialogs clear 44px on touch, and nothing else that shares their classes moves", async () => {
  const css = await read("app/(app)/portal/ops/overview-tools.css");
  const block = css.slice(css.indexOf("@media (pointer: coarse), (max-width: 767px) {"));
  assert.match(block, /\.ovw-tool \.ops-sheet__head \.ops-menu__button \{\s*width: 44px;\s*height: 44px;/);
  assert.match(block, /\.ovw-tool \.primary-button,\s*\.ovw-tool \.secondary-button \{\s*min-height: 44px;/);
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.match(page, /className="ops-sheet ovw-tool oi-tool"/, "the scope is the dialog shell the Overview draws");
});

test("item 40: an abbreviated donut centre is announced with its full value", async () => {
  const charts = await read("app/(app)/portal/ops/ov-dash-charts.tsx");
  assert.match(charts, /aria-label=\{`\$\{ariaLabel\}: \$\{readout \|\| "no data"\}\. \$\{centreLabel \?\? printed\} \$\{caption\}`\}/);
  const page = await read("app/(app)/portal/ops/oi-dash.tsx");
  const abbreviated = page.match(/centreValue=\{ovPoundsShort\(repeat\.spendPence\)\}\s*centreLabel=\{rpPounds\(repeat\.spendPence\)\}/g) ?? [];
  assert.equal(abbreviated.length, 2, "both repeat-spend donuts carry the full figure to a screen reader");
  assert.equal((page.match(/centreValue=\{ovPoundsShort\(/g) ?? []).length, 2, "and no other centre abbreviates without one");
});

/* ── item 44 ─────────────────────────────────────────────────────────────── */

/** Each section's real cards, in order, as the skeleton names them. */
function cardShapes(source, fromMarker, toMarker) {
  const start = source.indexOf(fromMarker);
  const end = toMarker ? source.indexOf(toMarker, start + 1) : source.length;
  assert.ok(start > 0 && end > start, `section ${fromMarker} not found`);
  const body = source.slice(start, end);
  const shapes = [];
  for (const match of body.matchAll(/<OiCard\b([\s\S]*?)>/g)) {
    const attributes = match[1];
    if (/\bwide\b/.test(attributes)) shapes.push("oi-card--wide");
    else if (/oi-span-md/.test(attributes)) shapes.push("oi-span-md");
    else shapes.push("");
  }
  return shapes;
}

function skeleton(source, name) {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
  assert.ok(match, `${name} is declared`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

test("item 44: every section's skeleton lists its real cards, in order, with their spans", async () => {
  const page = await read("app/(app)/portal/ops/oi-dash.tsx");
  const sections = [
    ["JOB_INTEL_SKELETON", "function JobIntelSection(", "function toneName("],
    ["SPEND_SKELETON", "function SpendSection(", "function ComplianceSection("],
    ["COMPLIANCE_SKELETON", "function ComplianceSection(", "const OI_DAY ="],
  ];
  for (const [name, from, to] of sections) {
    const cards = cardShapes(page, from, to);
    assert.ok(cards.length >= 5, `${name}: found the section's cards (${cards.length})`);
    assert.deepEqual(skeleton(page, name), cards, `${name} must match the cards the section draws`);
  }
  assert.match(page, /<SectionSkeleton kpis=\{4\} cards=\{JOB_INTEL_SKELETON\} \/>/);
  assert.match(page, /<SectionSkeleton kpis=\{4\} cards=\{SPEND_SKELETON\} \/>/);
  assert.match(page, /<SectionSkeleton kpis=\{0\} cards=\{COMPLIANCE_SKELETON\} \/>/);
});

test("item 44: a skeleton tile carries the real tile's three lines, so it is the real tile's height", async () => {
  const page = await read("app/(app)/portal/ops/oi-dash.tsx");
  assert.match(
    page,
    /<div key=\{slot\} className="oi-kpi ov-skeleton oi-skeleton--kpi" aria-hidden="true">\s*<span className="oi-kpi__label">&nbsp;<\/span>\s*<span className="oi-kpi__value">&nbsp;<\/span>\s*<span className="oi-kpi__caption">&nbsp;<\/span>/,
  );
  const tiles = await read("app/(app)/portal/ops/oi-dash-charts.tsx");
  for (const line of ["oi-kpi__label", "oi-kpi__value", "oi-kpi__caption"]) {
    assert.match(tiles, new RegExp(`className="${line}"`), `the real tile still draws ${line}`);
  }
});
