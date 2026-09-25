/**
 * The Operations Centre's 2026-09-24 visual pass (owner answers 3B and 4A).
 *
 * 3B: the portal's top bar keeps search, New request, the bell and the avatar
 * prominent, and gathers the rest into one labelled group — every action still
 * one click away, nothing removed. A stronger workspace card.
 *
 * 4A (strict): the Overview keeps the approved 11 Sept information architecture
 * and content exactly — hierarchy, layout, density and polish only. No headline
 * row, no new section, and none of the superseded UI (the filter bar, the retired
 * cards) comes back.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PORTAL = "app/(app)/portal/portal-app.tsx";
const BRAND = "app/brand-overrides.css";

async function topbar() {
  const source = await read(PORTAL);
  return source.slice(source.indexOf('<div className="topbar-actions">'), source.indexOf("</header>"));
}

/* ------------------------------------------------------------------ */
/* 3B — the top bar                                                    */
/* ------------------------------------------------------------------ */

test("the seven secondary tools sit in one labelled group, in order", async () => {
  const bar = decommented(await topbar());
  const open = bar.indexOf('<div className="topbar-tools" role="group" aria-label="Workspace tools">');
  assert.ok(open > 0, "the group exists and is named for assistive technology");
  const group = bar.slice(open, bar.indexOf('<div className="notification-wrap">'));
  const order = [
    "<ThemeToggle />",
    'aria-label="Refresh the figures on screen"',
    'aria-label="Manage data"',
    'href="/request"',
    'href="/dashboard/account/invite"',
    'href="/dashboard/account/integrations"',
    'href="/dashboard/account/help"',
  ];
  let at = -1;
  for (const marker of order) {
    const next = group.indexOf(marker);
    assert.ok(next > at, `${marker} is in the group, after the one before it`);
    at = next;
  }
});

test("search, the bell, New request and the avatar stay outside the group, prominent", async () => {
  const source = decommented(await read(PORTAL));
  const header = source.slice(source.indexOf('<header className="portal-topbar">'), source.indexOf("</header>"));
  const groupEnd = header.indexOf('<div className="notification-wrap">');
  assert.ok(header.indexOf("<GlobalSearch") < header.indexOf('className="topbar-tools"'), "search comes before the group");
  for (const marker of ['<Icon name="bell"', 'className="primary-button topbar-create"', "<AccountMenu"]) {
    assert.ok(header.indexOf(marker) > groupEnd, `${marker} sits after the group, not inside it`);
  }
});

test("every tool keeps a name and gains a tooltip, because its words are not printed", async () => {
  const bar = await topbar();
  assert.match(bar, /title=\{refreshing \? "Refreshing…" : "Refresh the figures on screen"\}/);
  assert.match(bar, /aria-label="Manage data"\s*title="Manage data"/);
  assert.match(bar, /aria-label="Public request form"\s*title="Public request form"/);
  assert.match(bar, /<Icon name="share" size=\{17\} \/>\s*<span>Public request form<\/span>/, "not a second plus beside New request");
  assert.match(bar, /is-refreshing/, "the refresh glyph turns while it works");
});

test("the tools block never sets display, so every width still offers what it did", async () => {
  /*
   * `.topbar-link` and `a.topbar-icon` hide below 1180px and `.topbar-data-button`
   * below 760px through their own rules. The group's styling must not compete
   * with any of them, or it would quietly show or hide tools at some width.
   */
  const css = await read(BRAND);
  const block = css.slice(css.indexOf("THE TOP BAR'S TOOLS GROUP"), css.indexOf("THE WORKSPACE CARD, ON A DESKTOP"));
  assert.ok(block.length > 200, "the tools block should have been found");
  const rules = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (!/\.topbar-tools \.(topbar-data-button|topbar-link|topbar-icon|theme-toggle)\b(?![^,]*> span)/.test(selector)) continue;
    assert.ok(!/(^|;|\s)display\s*:/.test(body), `${selector.trim()} must not set display`);
  }
});

test("the search takes only the room left, so the page name keeps its letters", async () => {
  /* Measured: with a weighted shrink the name lost its last letter at 1024;
     with a factor under 1 on the name the row ran 27px wide at 1181. */
  const css = await read(BRAND);
  assert.match(css, /\.portal-topbar \.global-search:not\(\.is-compact\) \{\s*flex: 1 1 0;\s*min-width: 190px;\s*\}/);
  assert.match(css, /\.page-identity \{\s*flex: 0 1 auto;\s*min-width: 110px;/);
  assert.match(css, /\.page-identity span,\s*\.page-identity strong \{\s*display: block;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
});

test("touch floors hold: 44px to 1180, and the phone's search button", async () => {
  const css = await read(BRAND);
  const band = css.slice(css.indexOf("@media (min-width: 1024px) and (max-width: 1180px)"));
  assert.match(band, /^@media \(min-width: 1024px\) and \(max-width: 1180px\) \{[\s\S]*?width: 44px;[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.portal-topbar \.global-search\.is-compact > \.icon-button \{\s*min-width: 44px;/);
});

test("the workspace card gives the name a row of its own on a desktop", async () => {
  const css = await read(BRAND);
  const block = css.slice(css.indexOf("THE WORKSPACE CARD, ON A DESKTOP"));
  assert.match(block, /@media \(min-width: 1024px\) \{\s*\.portal-sidebar \.workspace-switcher \{\s*grid-template-areas:\s*"mark label add"\s*"mark name name";/);
  assert.match(block, /\.portal-sidebar \.workspace-switcher > \.workspace-switcher__copy \{\s*display: contents;/);
  /*
   * One height from first paint to loaded: the placeholder name takes the
   * picker's 30px row and the label row the add button's 28px, which both
   * arrive with the workspace list. Without them the card went 59px → 82px on
   * arrival and pushed the rail down (shell CLS 0.0256 → 0.0272 at 1440); with
   * them it holds 82px and the shell measured 0.0236.
   */
  assert.match(block, /\.portal-sidebar \.workspace-switcher__copy strong \{\s*display: flex;\s*align-items: center;\s*min-height: 30px;/);
  assert.match(block, /\.portal-sidebar \.workspace-switcher__copy small \{[^}]*min-height: 28px;/);
  /* Phones keep the arrangement stage-twentyfive measured: nothing here is outside a min-width query. */
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\n\.portal-sidebar \.workspace-switcher/.test(rules.split("@media")[0]), "no unconditional workspace-card rule");
});

/* ------------------------------------------------------------------ */
/* 4A — the Overview's content is untouched                           */
/* ------------------------------------------------------------------ */

test("the Overview is still the 11 Sept brief's three sections, in order, and nothing else", async () => {
  const dash = decommented(await read("app/(app)/portal/ops/oi-dash.tsx"));
  const body = dash.slice(dash.indexOf("<DashHeader"), dash.indexOf("</section>", dash.indexOf("<DashHeader")));
  const sections = [...body.matchAll(/<(JobIntelSection|SpendSection|ComplianceSection)\b/g)].map((m) => m[1]);
  assert.deepEqual(sections, ["JobIntelSection", "SpendSection", "ComplianceSection"]);
  assert.ok(!/ops-filter-bar|OpsFilterBar/.test(dash), "the superseded filter bar stays retired");
  const page = decommented(await read("app/(app)/portal/ops/overview-page.tsx"));
  for (const retired of ["overview-glance", "overview-financial", "overview-performance", "overview-breakdown", "overview-sites", "overview-records", "meter-settings"]) {
    assert.ok(!page.includes(retired), `${retired} stays unmounted`);
  }
});

test("the KPI tiles gain a decorative glyph and nothing else", async () => {
  const tiles = await read("app/(app)/portal/ops/oi-dash-charts.tsx");
  assert.match(tiles, /<span className="oi-kpi__icon" aria-hidden="true">\s*<Icon name=\{icon\} size=\{19\} \/>/);
  /* The same three lines the skeleton carries — label, value, caption. */
  for (const line of ["oi-kpi__label", "oi-kpi__value", "oi-kpi__caption"]) {
    assert.match(tiles, new RegExp(`className="${line}"`));
  }
  const dash = await read("app/(app)/portal/ops/oi-dash.tsx");
  for (const [label, icon] of [
    ["Open jobs", "wrench"],
    ["Completed jobs", "check"],
    ["Completion rate", "activity"],
    ["SLA met", "clock"],
  ]) {
    assert.match(dash, new RegExp(`label="${label}"\\s*icon="${icon}"`), `${label} wears ${icon}`);
  }
  assert.match(dash, /icon=\{KPI_ICON\[kpi\.key\]\}/, "and each spend tile its own");
});

test("the glyph is shorter than the label and value it spans, so the skeleton still fits", async () => {
  const css = await read("app/(app)/portal/ops/oi-dash.css");
  const icon = /\.ov-dash\.oi-dash \.oi-kpi__icon \{[^}]*height: (\d+)px;/.exec(css);
  const label = /body\[data-theme\] \.ov-dash\.oi-dash \.oi-kpi__label \{[^}]*font-size: ([\d.]+)px;[^}]*line-height: ([\d.]+);/.exec(css);
  const value = /body\[data-theme\] \.ov-dash\.oi-dash \.oi-kpi__value \{[^}]*font-size: (\d+)px;[^}]*line-height: ([\d.]+);/.exec(css);
  assert.ok(icon && label && value);
  const rows = Number(label[1]) * Number(label[2]) + 6 + Number(value[1]) * Number(value[2]);
  assert.ok(Number(icon[1]) < rows, `a ${icon[1]}px glyph beside ${rows.toFixed(1)}px of label and value`);
  assert.match(css, /grid-template-areas:\s*"icon label"\s*"icon value"\s*"caption caption";/);
});

/* ------------------------------------------------------------------ */
/* Round 2 (2026-09-25) — restrained polish, the 11 Sept IA unchanged   */
/* ------------------------------------------------------------------ */

test("the text that says what a figure is OF is no longer the smallest on the page", async () => {
  const css = await read("app/(app)/portal/ops/oi-dash.css");
  for (const [cls, floor] of [
    ["oi-note", 11.5],
    ["oi-gauge__caption", 11.5],
    ["oi-gauge__sub", 11.5],
    ["ov-ring__label", 11.5],
    ["oi-type__count", 11],
    ["ov-chart__centre-caption", 11],
  ]) {
    const rule = new RegExp(`body\\[data-theme\\] \\.ov-dash\\.oi-dash \\.${cls} \\{[^}]*font-size: ([\\d.]+)px;`).exec(css);
    assert.ok(rule, `${cls} has a size`);
    assert.ok(Number(rule[1]) >= floor, `${cls} is ${rule[1]}px, under ${floor}px`);
  }
});

test("an empty card says so in a framed inset, on the Overview and the Compliance page alike", async () => {
  const oi = await read("app/(app)/portal/ops/oi-dash.css");
  assert.match(oi, /\.ov-dash\.oi-dash \.oi-empty-note \{[^}]*border: 1px dashed var\(--ov-divider\);/);
  assert.match(oi, /body\[data-theme\] \.ov-dash\.oi-dash \.oi-empty-note \{\s*font-size: 12px;\s*color: var\(--text-secondary\);/);
  const cp = await read("app/(app)/portal/ops/cp-dash.css");
  assert.match(cp, /\.ov-dash\.cp-dash \.cp-empty \{[^}]*place-items: center;[^}]*border: 1px dashed var\(--ov-divider\);/);
  /* And on Reports, the third `.ov-dash` block (Phase 7 consistency pass): its
     bar list and repeat zones had kept one faint line in an empty card. */
  const rp = await read("app/(app)/portal/ops/rp-dash.css");
  assert.match(rp, /\.ov-dash\.rp-dash \.rp-bars--empty,\s*\.ov-dash\.rp-dash \.rp-zone__empty \{[^}]*border: 1px dashed var\(--ov-divider\);/);
  assert.match(rp, /\.ov-dash\.rp-dash \.rp-zone__empty \{[^}]*color: var\(--ov-text-2\);/);
});

test("the data tools are one labelled group that says what it is for", async () => {
  const page = await read("app/(app)/portal/ops/overview-page.tsx");
  assert.match(page, /<span className="oi-footer__label" id="oi-footer-label">Data tools<\/span>/);
  assert.match(page, /<span className="oi-footer__hint">Tidy the job records these figures are read from\.<\/span>/);
  assert.match(page, /<span className="oi-footer__tools" role="group" aria-labelledby="oi-footer-label">/);
  const tools = page.slice(page.indexOf('className="oi-footer__tools"'), page.indexOf("</span>", page.indexOf('className="oi-footer__tools"')));
  assert.match(tools, /Resolve contractor names/);
  assert.match(tools, /Assign jobs to a site/);
  const css = await read("app/(app)/portal/ops/oi-dash.css");
  assert.match(css, /\.ov-dash\.oi-dash \.oi-footer \{[^}]*border: 1px solid var\(--ov-card-border\);[^}]*background: var\(--ov-card\);/);
  assert.doesNotMatch(css, /\.oi-footer__label \{[^}]*margin-right: auto;/, "the label no longer pushes the tools to the far edge");
});
