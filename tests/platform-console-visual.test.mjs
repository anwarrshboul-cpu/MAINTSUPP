/**
 * The platform console's 2026-09-24 visual pass (owner answers 1A, 2A, 3B, 5A).
 *
 * `platform-admin-shell.test.mjs` guards the console's security shape — the two
 * guards, the catalogue, what is deliberately absent. This file guards what the
 * visual pass added on top of it, and the promises that pass made:
 *
 *   - the rail is drawn in groups, and no screen can fall out of it;
 *   - the Theme Engine and Portal Builder are LINKED (answer 1A), never copied,
 *     and never registered as platform screens they are not;
 *   - the top bar carries only controls with something real behind them;
 *   - the Overview reads only APIs that already exist, one at a time;
 *   - the stylesheets stay tokens-only and inside the permitted breakpoints;
 *   - three accessibility defects found on the way stay fixed.
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_ELSEWHERE,
  PLATFORM_GROUPS,
  PLATFORM_SECTIONS,
  PLATFORM_SECTION_KEYS,
  PLATFORM_WORKSPACE_LINKS,
  platformGroupOf,
  platformSection,
} from "../app/lib/platform-sections.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------ */
/* The rail's groups                                                   */
/* ------------------------------------------------------------------ */

test("every console screen is in exactly one rail group", () => {
  const drawn = PLATFORM_GROUPS.flatMap((group) => [...group.sections]);
  assert.deepEqual(
    [...drawn].sort(),
    [...PLATFORM_SECTION_KEYS].sort(),
    "the groups must draw every catalogue screen — a screen in no group would vanish from the rail",
  );
  assert.equal(new Set(drawn).size, drawn.length, "and none twice");
  for (const key of PLATFORM_SECTION_KEYS) {
    assert.ok(platformGroupOf(key), `${key || "(overview)"} has a group`);
  }
});

test("the groups are drawn in the owner's order", () => {
  assert.deepEqual(
    PLATFORM_GROUPS.map((group) => group.label),
    ["Platform", "Website", "Clients & portal", "Access & governance", "System"],
  );
  assert.deepEqual(PLATFORM_GROUPS[0].sections, ["", "search"], "the overview and search come first");
});

test("the landing screen is called Overview, as the portal's is", () => {
  assert.equal(PLATFORM_SECTIONS[0].key, "");
  assert.equal(PLATFORM_SECTIONS[0].label, "Overview");
});

/* ------------------------------------------------------------------ */
/* Answer 1A: linked, not copied, not registered                       */
/* ------------------------------------------------------------------ */

test("the portal's theme and modules are linked to, and are not platform screens", async () => {
  assert.ok(PLATFORM_WORKSPACE_LINKS.length > 0);
  for (const link of PLATFORM_WORKSPACE_LINKS) {
    assert.equal(link.href, "/dashboard/settings", "they live on the workspace's own Settings page");
    assert.ok(
      PLATFORM_GROUPS.some((group) => group.key === link.group),
      `${link.label} names a group the rail draws`,
    );
    assert.ok(link.blurb.length > 20, "and says whose settings they are");
  }
  /* The rule `platform-admin-shell.test.mjs` asserts, restated from this side:
     linking to the workspace's Settings did not make a platform "theme" or
     "settings" screen, because there is no platform API for either. */
  for (const key of ["theme", "settings", "branding", "modules"]) {
    assert.equal(platformSection(key), null, `${key} must not become a console screen`);
  }

  /* And nothing was copied: the console mounts none of the Settings editors. */
  const shell = decommented(await read("app/(app)/admin/platform-shell.tsx"));
  const overview = decommented(await read("app/(app)/admin/platform-overview.tsx"));
  /* Round 2 moved the panels into their own file; it is held to the same rule. */
  const panels = decommented(await read("app/(app)/admin/platform-overview-panels.tsx"));
  for (const editor of [
    "BrandColoursPanel",
    "PortalModulesPanel",
    "NavIconsPanel",
    "WorkspaceLogoPanel",
    "AppearancePanel",
  ]) {
    assert.ok(!shell.includes(editor), `the shell must not mount ${editor}`);
    assert.ok(!overview.includes(editor), `the overview must not mount ${editor}`);
    assert.ok(!panels.includes(editor), `the overview's panels must not mount ${editor}`);
  }
});

test("every rail icon is one the product has", async () => {
  const components = await read("app/components.tsx");
  const union = components.slice(components.indexOf("export type IconName"));
  const icons = new Set(
    [...union.slice(0, union.indexOf(";")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]),
  );
  for (const link of [...PLATFORM_WORKSPACE_LINKS, ...PLATFORM_ELSEWHERE]) {
    assert.ok(icons.has(link.icon), `${link.href} uses an unknown icon`);
  }
});

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

test("the rail is drawn by group, and below 1024px it is a disclosure", async () => {
  const shell = decommented(await read("app/(app)/admin/platform-shell.tsx"));
  assert.match(shell, /PLATFORM_GROUPS\.map\(/);
  assert.match(shell, /aria-expanded=\{menuOpen\}/);
  assert.match(shell, /aria-controls="platform-rail"/);
  assert.match(shell, /id="platform-rail"/);
  assert.match(shell, /event\.key !== "Escape"/, "Escape closes it");
  assert.match(shell, /menuButton\.current\?\.focus\(\)/, "and hands focus back to the button");
  assert.match(shell, /aria-current=\{current \? "page" : undefined\}/);
});

test("the top bar's search is a real GET form to the console's Search", async () => {
  const shell = decommented(await read("app/(app)/admin/platform-shell.tsx"));
  assert.match(shell, /<form className="platform-search" role="search" action="\/admin\/search" method="get">/);
  assert.match(shell, /name="q"/);
  assert.match(shell, /htmlFor="platform-search-q"/, "the field is labelled");

  /* And the Search screen answers it: `?q=` is read through an external store
     whose server snapshot is empty (so hydration agrees), and run once. */
  const view = decommented(await read("app/(app)/admin/console-search-view.tsx"));
  assert.match(view, /new URLSearchParams\(window\.location\.search\)\.get\("q"\)/);
  assert.match(view, /useSyncExternalStore\(noSubscription, readArrivalQuery, noArrivalQuery\)/);
  assert.match(view, /const noArrivalQuery = \(\) => "";/);
  assert.match(view, /void search\(arrivedWith\);/);
});

test("the top bar offers no control with nothing behind it", async () => {
  /*
   * The owner's reference shows "Platform Online", "Save Changes" and "Publish
   * All". There is no health endpoint and no platform-wide save or publish, so
   * each would be a control that does nothing — the thing this console refuses.
   */
  const shell = decommented(await read("app/(app)/admin/platform-shell.tsx"));
  for (const fake of ["Publish All", "Publish all", "Save Changes", "Save changes", "Platform Online", "All systems operational"]) {
    assert.ok(!shell.includes(fake), `"${fake}" has no real equivalent and must not be drawn`);
  }
  assert.match(shell, /href="\/" target="_blank" rel="noopener noreferrer"/, "Visit website is the real public site");
  assert.match(shell, /\(opens in a new tab\)/, "and says it opens a new tab");
});

/* ------------------------------------------------------------------ */
/* The Overview                                                        */
/* ------------------------------------------------------------------ */

async function routeExists(apiPath) {
  const clean = apiPath.split("?")[0].replace(/^\/api\//, "");
  try {
    await stat(path.join(root, "app/api", clean, "route.ts"));
    return true;
  } catch {
    return false;
  }
}

test("the Overview reads only APIs that already exist", async () => {
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  const block = overview.slice(overview.indexOf("const READS = ["), overview.indexOf("] as const;"));
  /* Keys may be camelCase since round 2 added `portalNav`. */
  const urls = [...block.matchAll(/\["[A-Za-z]+", "([^"]+)"\]/g)].map((m) => m[1]);
  assert.ok(urls.length >= 10, `the read list should have been found; got ${urls.length}`);
  for (const url of urls) {
    assert.ok(await routeExists(url), `${url} must be an existing route — the overview adds no API`);
  }
});

test("the Overview's secondary reads run one at a time", async () => {
  /*
   * Eleven concurrent requests from one landing screen is the instance fan-out
   * the 2026-09-22 incident was made of. In sequence they reuse a warm instance.
   */
  const code = decommented(await read("app/(app)/admin/platform-overview.tsx"));
  assert.ok(!/Promise\.all/.test(code), "no parallel fan-out of the secondary reads");
  assert.match(code, /for \(const \[key, url\] of READS\) \{\s*const state = await readOnce\(url, controller\.signal\);/);
  assert.match(code, /useQueuedReads\(Boolean\(data\)\)/, "and they start only after the workspaces answer");
});

test("the Overview still trusts the server's totals and names every state", async () => {
  const code = decommented(await read("app/(app)/admin/platform-overview.tsx"));
  assert.ok(!/\.reduce\(/.test(code), "the totals must not be re-derived in the browser");
  assert.match(code, /status: "refused"/, "a refused card says so");
  assert.match(code, /status: "failed"/, "a failed card says so, with a retry");
  assert.match(code, /Try again/);
});

test("the latest enquiries never show contact details", async () => {
  /* Re-pointed in round 2: the inbox panel moved to platform-overview-panels.tsx. */
  const code = decommented(await read("app/(app)/admin/platform-overview-panels.tsx"));
  const block = code.slice(code.indexOf('className="platform-latest"'), code.indexOf("</Card>", code.indexOf('className="platform-latest"')));
  assert.ok(block.length > 0);
  for (const field of ["email", "phone"]) {
    assert.ok(!block.includes(`lead.${field}`), `the overview must not print a lead's ${field}`);
  }
});

/* ------------------------------------------------------------------ */
/* Stylesheets                                                         */
/* ------------------------------------------------------------------ */

test("the Overview's stylesheet is tokens only, inside the permitted widths", async () => {
  const css = await read("app/(app)/admin/platform-overview.css");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), "no hex literal");
  assert.ok(!/\b(?:rgba?|hsla?)\(/.test(body), "no colour function — use the tokens");
  const globals = await read("app/globals.css");
  for (const token of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) {
    assert.ok(globals.includes(`${token}:`), `${token} is not defined in globals.css`);
  }
  const allowed = new Set(["640", "767", "768", "1024", "1280"]);
  for (const [, width] of body.matchAll(/@media[^{]*?(\d+)px/g)) {
    assert.ok(allowed.has(width), `${width}px is not a permitted width`);
  }
  assert.match(body, /prefers-reduced-motion: reduce/, "the shimmer stops for people who asked for less motion");
});

test("the rail uses the portal's rail tokens, so both surfaces are one product", async () => {
  const css = await read("app/(app)/admin/platform-shell.css");
  for (const token of ["--rail-bg", "--rail-fg", "--rail-active-bg", "--rail-accent", "--rail-border"]) {
    assert.ok(css.includes(`var(${token})`), `the console rail paints with ${token}`);
  }
  assert.match(css, /\.platform-rail a\.is-active \{[^}]*box-shadow: inset 3px 0 0 var\(--rail-accent\)/);
});

/* ------------------------------------------------------------------ */
/* Accessibility defects found during the pass                         */
/* ------------------------------------------------------------------ */

test("AdminNotice wraps its children in a div, so a list inside it is valid HTML", async () => {
  /* `<ul>` inside `<p>` made /admin/pages and /admin/leads log a nesting error —
     a hydration mismatch in production. */
  const kit = decommented(await read("app/(app)/portal/views/admin-shell.tsx"));
  assert.match(kit, /\{children \? <div className="admin-notice__body">\{children\}<\/div> : null\}/);
  assert.ok(!/\{children \? <p>\{children\}<\/p>/.test(kit));
  const css = await read("app/(app)/portal/views/admin-console.css");
  assert.match(css, /\.admin-notice__body,\s*\.admin-notice p \{/);
});

test("every Website copy field is named by its visible label", async () => {
  /* axe counted 44 unnamed inputs on /admin/copy before this. */
  const view = decommented(await read("app/(app)/admin/site-copy-view.tsx"));
  assert.match(view, /<span className="site-copy__field-label" id=\{labelId\}>/);
  assert.equal((view.match(/aria-labelledby=\{labelId\}/g) ?? []).length, 2, "the paragraph and the line controls");
  assert.match(view, /aria-label=\{`\$\{field\.label\}, line \$\{index \+ 1\}`\}/, "and each line of a list");
});

test("both inbox tables name their action column and scroll inside themselves", async () => {
  for (const file of ["app/(app)/admin/leads-view.tsx", "app/(app)/admin/applications-view.tsx"]) {
    const view = decommented(await read(file));
    assert.ok(!/<th \/>/.test(view), `${file}: an empty header cell is announced as nothing`);
    assert.match(view, /<span className="visually-hidden">Actions<\/span>/, `${file} names it`);
    assert.match(
      view,
      /<div className="leads-admin__scroll">\s*<table className="admin-table leads-admin__list">/,
      `${file}: the table scrolls sideways inside its own box, not the page`,
    );
  }
  /* The hidden header text is absolutely positioned; the scroller must be its
     containing block or it is placed against the page (17-32px of page overflow
     at 390 and 375, measured before this). */
  const css = await read("app/(app)/admin/leads.css");
  assert.match(css, /\.leads-admin__scroll \{\s*overflow-x: auto;[\s\S]*?position: relative;\s*\}/);
});

test("the Users counts are lifted to ink inside the console", async () => {
  /* `.site-stat-grid strong` is --navy-950 and only `.portal-content` lifts it. */
  const css = await read("app/(app)/admin/platform-shell.css");
  assert.match(css, /\.platform-main \.site-stat-grid strong \{\s*color: var\(--ink\);/);
});

/* ------------------------------------------------------------------ */
/* Round 2 (2026-09-25, owner answers 1C 2A 3A 4A 5A 6B 7A)            */
/* ------------------------------------------------------------------ */

const model = await import("../app/lib/platform-overview-model.ts");

test("the enquiries chart counts every one of the last 30 days, ending today", () => {
  const now = Date.parse("2026-09-25T10:00:00Z");
  const series = model.enquiriesByDay(
    ["2026-09-25 08:00:00", "2026-09-25T09:00:00Z", "2026-08-27 00:00:01", "2026-08-26 23:59:59", "not a date"],
    now,
  );
  assert.equal(series.length, 30, "every day in the window, zero where nothing arrived");
  assert.equal(series[0].day, "2026-08-27");
  assert.equal(series.at(-1).day, "2026-09-25");
  assert.equal(series.at(-1).count, 2, "two today, in both stamp formats");
  assert.equal(series[0].count, 1, "the first day of the window counts");
  const summary = model.summariseDays(series);
  assert.equal(summary.total, 3, "outside the window and unreadable stamps are not counted");
  assert.deepEqual(summary.busiest, { day: "2026-09-25", count: 2 });
});

test("the page list puts the built-in pages first, then CMS pages newest first", () => {
  const rows = model.websitePageRows(
    [{ key: "home", label: "Home page", path: "/" }],
    null,
    [
      { id: "a", slug: "old", title: "Old", state: "draft", updatedAt: "2026-09-01 10:00:00" },
      { id: "b", slug: "new", title: "New", state: "live", updatedAt: "2026-09-20T10:00:00Z" },
    ],
  );
  assert.deepEqual(rows.map((row) => row.title), ["Home page", "New", "Old"]);
  assert.equal(rows[0].state, "live", "a built-in page is always live");
  assert.equal(rows[0].changedAt, null, "and 'as shipped' until the copy is saved");
  assert.equal(rows[1].address, "/p/new");
  assert.equal(model.choiceLabel("soft", [{ key: "soft", label: "Soft (MAINTSUPP default)" }]), "Soft (MAINTSUPP default)");
  assert.equal(model.choiceLabel("odd", null), "odd");
});

test("the chart says it counts enquiries, not traffic (answer 5A)", async () => {
  const panels = await read("app/(app)/admin/platform-overview-panels.tsx");
  assert.match(panels, /Enquiries received, last 30 days/);
  assert.match(panels, /not website traffic/);
  for (const banned of ["Page Views", "page views", "Unique Visitors", "Conversion", "Sessions"]) {
    assert.ok(!panels.includes(banned), `"${banned}" is web analytics this product does not have`);
  }
});

test("the integrations panel uses Account → Integrations' own words (answer 4A)", async () => {
  const panels = decommented(await read("app/(app)/admin/platform-overview-panels.tsx"));
  const account = await read("app/(app)/portal/views/account-ui.tsx");
  assert.match(account, /okLabel = "Configured"/);
  assert.match(account, /offLabel = "Not configured"/);
  assert.match(panels, /\{entry\.configured \? "Configured" : "Not configured"\}/, "the same two labels, nothing warmer");
  assert.match(panels, /ready<PlatformPayload>\(platform\)\?\.platform\.integrations/, "read from the same API the Account screen reads");
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  assert.match(overview, /\["platform", "\/api\/account\/platform"\]/);
});

test("the Overview draws status, never controls that change anything", async () => {
  const panels = decommented(await read("app/(app)/admin/platform-overview-panels.tsx"));
  for (const control of ['role="switch"', 'type="checkbox"', "<input", "<select", "<textarea", "<iframe"]) {
    assert.ok(!panels.includes(control), `${control} has no place on a read-only overview`);
  }
  for (const fake of ["Publish all", "Publish All", "Save changes", "Platform Online", "Live Preview"]) {
    assert.ok(!panels.includes(fake), `"${fake}" has nothing real behind it`);
  }
  /* The hero snapshot lists its calls to action as words, not buttons (7A). */
  const hero = panels.slice(panels.indexOf("export function HeroPanel"), panels.indexOf("export function BrandPanel"));
  assert.ok(!/<button/.test(hero), "the snapshot has no button");
  assert.match(hero, /Calls to action:/);
  assert.match(hero, /platform-hero__badge">Snapshot</);
});

test("the brand snapshot draws chips and chosen icons, no sample charts (answer 6B)", async () => {
  const panels = decommented(await read("app/(app)/admin/platform-overview-panels.tsx"));
  const brand = panels.slice(panels.indexOf("export function BrandPanel"), panels.indexOf("export function NavigationPanel"));
  assert.match(brand, /className="platform-swatch" style=\{\{ background: token\.value \}\}/);
  assert.match(brand, /customIcons/, "only the icons a workspace actually chose");
  assert.ok(!/<svg|<circle|<path|donut|gauge/i.test(brand), "no sample chart shapes");
});

test("the headline strip mixes platform and website figures (answer 3A)", async () => {
  const overview = await read("app/(app)/admin/platform-overview.tsx");
  for (const label of ["Workspaces", "People", "Sites", "Open jobs", "Web pages", "Media", "Enquiries"]) {
    assert.match(overview, new RegExp(`label(: |=)"${label}"`), `the strip has ${label}`);
  }
});

test("the search guide names the groups the search route answers with", async () => {
  const view = await read("app/(app)/admin/console-search-view.tsx");
  const route = await read("app/api/admin/search/route.ts");
  const guide = [...view.slice(view.indexOf("const SEARCH_GROUPS"), view.indexOf("];", view.indexOf("const SEARCH_GROUPS"))).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(guide.length, 7);
  for (const label of guide) {
    assert.match(route, new RegExp(`label: "${label}"`), `${label} is a group the route really returns`);
  }
  assert.match(view, /!data && !failure && !busy \?/, "shown only before the first answer — never beside results");
});

test("the jump menus link only to headings the editors draw", async () => {
  const copy = await read("app/(app)/admin/site-copy-view.tsx");
  assert.match(copy, /<nav className="platform-jump" aria-label="Jump to a section of this page">/);
  assert.match(copy, /href="#site-copy-seo"/);
  assert.match(copy, /id="site-copy-seo"/);
  assert.match(copy, /href=\{`#site-copy-\$\{spec\.key\}-\$\{section\.key\}`\}/);
  assert.match(copy, /id=\{`site-copy-\$\{spec\.key\}-\$\{section\.key\}`\}/);
  const nav = await read("app/(app)/admin/site-navigation-view.tsx");
  for (const target of ["site-nav-header", "site-nav-fixed"]) {
    assert.match(nav, new RegExp(`href="#${target}"`));
    assert.match(nav, new RegExp(`id="${target}"`));
  }
  assert.match(nav, /href=\{`#site-nav-\$\{group\.id\}`\}/);
  assert.match(nav, /id=\{`site-nav-\$\{group\.id\}`\}/);
  const css = await read("app/(app)/admin/platform-shell.css");
  assert.match(css, /scroll-margin-top: 140px/, "and the heading lands below the sticky top bar");
});

test("wide tables scroll on purpose: shadows at the edges, the first column pinned", async () => {
  const css = await read("app/(app)/admin/platform-shell.css");
  assert.match(css, /\.platform-page \.platform-main \.admin-panel \.table-scroll \{\s*background:[\s\S]*?no-repeat local/);
  const media = css.slice(css.indexOf("@media (min-width: 1024px)"));
  assert.match(media, /\.data-table td:first-child \{\s*position: sticky;\s*left: 0;/, "pinned from 1024 only");
  const overview = await read("app/(app)/admin/platform-overview.css");
  assert.match(overview, /\.platform-mini-table \{\s*\/\*[\s\S]*?\*\/\s*position: relative;/, "hidden header text stays inside its scroller");
});

test("the inbox tables and notices read as designed", async () => {
  const leads = await read("app/(app)/admin/leads.css");
  assert.match(leads, /\.leads-admin__list th \{[^}]*text-transform: uppercase;/);
  assert.match(leads, /\.leads-admin \{\s*display: flex;\s*flex-direction: column;\s*gap: 14px;/, "the inbox screens' parts no longer touch");
  assert.match(leads, /\.leads-admin__list a \{\s*color: var\(--brand-fg\);/, "links in the brand's text tone, which passes contrast on white");
  const backups = await read("app/(app)/admin/backups-view.tsx");
  assert.match(backups, /<div className="section-stack admin-console">/, "the five backup notices keep the portal's stack gap");
  assert.match(leads, /\.leads-admin__list td \{[^}]*padding: 12px 14px;/);
  const kit = await read("app/(app)/portal/views/admin-console.css");
  assert.match(kit, /\.admin-notice__body strong \{\s*display: inline;/);
  for (const file of ["app/(app)/admin/site-copy.css", "app/(app)/admin/site-navigation.css"]) {
    const css = await read(file);
    assert.match(css, /__panel \{\s*padding: 18px 20px;\s*border: 1px solid var\(--line\);/, `${file}: each panel is a card`);
  }
});
