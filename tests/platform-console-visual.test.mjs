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
  for (const editor of [
    "BrandColoursPanel",
    "PortalModulesPanel",
    "NavIconsPanel",
    "WorkspaceLogoPanel",
    "AppearancePanel",
  ]) {
    assert.ok(!shell.includes(editor), `the shell must not mount ${editor}`);
    assert.ok(!overview.includes(editor), `the overview must not mount ${editor}`);
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
  const urls = [...block.matchAll(/\["[a-z]+", "([^"]+)"\]/g)].map((m) => m[1]);
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
  const code = decommented(await read("app/(app)/admin/platform-overview.tsx"));
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
