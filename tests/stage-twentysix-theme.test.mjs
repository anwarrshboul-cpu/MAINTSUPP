/**
 * Stage 26 — the theme mechanism, and the rail that has to survive it.
 *
 * Two of the four defects the owner reported were about colour, and neither was
 * a colour. They were about WHERE the decision is made.
 *
 * ---------------------------------------------------------------------------
 * 1. "THE DEFAULT THEME SHOULD BE BASED ON THE USED DEVICE"
 *
 * It was not, and could not be. Measured over CDP on a fresh profile with the
 * storage key removed and `Emulation.setEmulatedMedia` forcing the device
 * preference: `prefers-color-scheme: light` ended with `data-theme="dark"` on
 * both `<html>` and `<body>`, computed `color-scheme: dark`, body background
 * rgb(11,18,24) — byte-identical to the `prefers-color-scheme: dark` run. The
 * device was ignored 100% of the time, for four independent reasons:
 *
 *   (a) `theme-toggle.tsx` defaulted to the literal "dark" in both snapshots,
 *       so `resolve()` — which already knew how to ask `matchMedia` — was never
 *       given "system" to resolve.
 *   (b) `portal-app.tsx` and `account-shell.tsx` each set
 *       `body.dataset.theme = "dark"` unconditionally on mount, overwriting
 *       whatever the toggle had just applied. On the account routes that was
 *       the ONLY write, so an explicit Light choice was discarded outright.
 *   (c) `live-board.tsx` kept a second copy of the preference, initialised to
 *       "dark", and — the lasting damage — wrote it back to `localStorage` on
 *       mount. Every visitor therefore carried an explicit stored "dark" they
 *       had never chosen, which is why changing the default alone would have
 *       reached nobody. Hence the one-off migration asserted below.
 *   (d) The server sent no `data-theme` and there was no pre-hydration script,
 *       so the first paint was always the CSS default. Measured: first
 *       contentful paint at 176.0ms with no attribute, correct attribute at
 *       204.5ms — 28.5ms of the wrong theme AFTER content was on screen. An
 *       effect cannot win that race; a blocking inline script can, and does.
 *
 * ---------------------------------------------------------------------------
 * 2. "THE MENU SHOULD BE ALWAYS IN A DARK COLOR"
 *
 * The light skin repainted the rail's GROUND white with one rule and left
 * every colour inside it — all dark-ground literals, in four files, none of
 * them theme-aware — untouched. `.portal-sidebar { color: white }` is
 * inherited by anything with no colour of its own, so "Need a hand?",
 * "MAINTSUPP Owner" and "Super Admin" measured exactly 1.00:1: white on white.
 * Ten more labels sat between 1.49:1 and 4.14:1.
 *
 * The fix is subtraction plus a token set. The rail owns `--rail-*` on the
 * bare `:root`, they are NOT redefined in either theme block, and every rule
 * that paints the rail reads them. That is what "always dark, by token" means:
 * there is no rule for a theme to disagree with. The tests below pin exactly
 * that, because the failure mode is silent — a single literal reintroduced in
 * any of these files paints identically in both themes and cannot follow one.
 *
 * These are static assertions on purpose: they run in CI with no browser and
 * no server, and they fail on the *cause* rather than on a rendered pixel.
 * The live verification (Chrome over CDP, `prefers-color-scheme` emulated both
 * ways, every text node in the rail measured against its effective background)
 * is what produced the numbers quoted throughout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const GLOBALS = "app/globals.css";
const BRAND = "app/brand-overrides.css";
const SIDEBAR_CSS = "app/(app)/portal/sidebar-nav.css";
const THEME = "app/(app)/portal/theme.ts";
const BOOT = "app/(app)/portal/theme-boot.ts";
const TOGGLE = "app/(app)/portal/theme-toggle.tsx";
const APP_LAYOUT = "app/(app)/layout.tsx";
const ROOT_LAYOUT = "app/layout.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const BOARD = "app/(app)/portal/live-board.tsx";
const ACCOUNT_SHELL = "app/(app)/portal/views/account-shell.tsx";
const ACCOUNT_EXPLORE = "app/(app)/portal/views/account-explore.tsx";

/** Comments in these files contain braces and colour literals. Strip them. */
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in a stylesheet, nested ones included, as
 * `{ chain, selector, declarations }`.
 *
 * Brace-matched rather than regexed: `body[data-theme="dark"]` is written with
 * CSS nesting, so its component rules are inside its body and a flat regex
 * reports them as absent — which is how a rule can be "obviously there" and
 * still not be found by a test.
 */
function eachRule(css, visit, chain = []) {
  let index = 0;
  let start = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === "{") {
      const selector = css.slice(start, index).trim();
      let depth = 1;
      let end = index + 1;
      while (end < css.length && depth > 0) {
        if (css[end] === "{") depth += 1;
        else if (css[end] === "}") depth -= 1;
        end += 1;
      }
      const body = css.slice(index + 1, end - 1);
      const nextChain = [...chain, selector];
      visit({ chain: nextChain, selector, body, declarations: topLevel(body) });
      eachRule(body, visit, nextChain);
      index = end;
      start = end;
      continue;
    }
    if (char === "}" || char === ";") {
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
}

/** The declarations of a block, with any nested blocks removed. */
function topLevel(body) {
  let out = "";
  let depth = 0;
  let pending = "";
  for (const char of body) {
    if (char === "{") {
      if (depth === 0) pending = "";
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (char === ";") {
      out += `${pending};`;
      pending = "";
      continue;
    }
    pending += char;
  }
  return out;
}

const rulesOf = (css) => {
  const found = [];
  eachRule(strip(css), (rule) => found.push(rule));
  return found;
};

/*
 * The classes that make up the rail: the shell, the nav, the customisation
 * editor, the workspace card, the client list and the profile block. This is
 * the surface the owner is pointing at, and every one of them was a
 * dark-ground literal before this stage.
 */
const RAIL_SELECTOR =
  /\.(portal-sidebar|portal-nav|nav-label|nav-icon|nav-count|nav-row|nav-chip|nav-editor|nav-customise|nav-rename|nav-new|nav-lock|nav-caret|sidebar-help|sidebar-profile|sidebar-close|workspace-switcher|workspace-tenants|workspace-identity|workspace-icon|profile-signout)/;

/** Properties that paint. `box-shadow` is excluded: a black shadow is a
    shadow, not a theme decision. */
const PAINTING = /(^|;)\s*(color|background|background-color|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|text-decoration-color|accent-color)\s*:/;

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(white|black|silver|gray|grey)\b/;

/** The declarations of one rule, split and trimmed. */
const declarationList = (declarations) =>
  declarations
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// 1. The default follows the device.
// ---------------------------------------------------------------------------

test("with nothing stored the theme is 'system', on the server and the client", async () => {
  const theme = await read(THEME);

  // The server render, and therefore the first client render.
  assert.match(
    theme,
    /function serverChoice\(\): ThemeChoice \{\s*return "system";/,
    "the server snapshot must be 'system'; a literal 'dark' is what made the device irrelevant",
  );

  // The stored-value read, both of its fallbacks.
  const stored = /export function readThemeChoice\(\): ThemeChoice \{[\s\S]*?\n\}/.exec(theme);
  assert.ok(stored, "readThemeChoice must exist");
  assert.equal(
    /return\s+"dark"/.test(stored[0]),
    false,
    "nothing may fall back to 'dark' when a preference is absent",
  );
  assert.equal(
    (stored[0].match(/\?\?\s*"system"/g) ?? []).length >= 2,
    true,
    "an absent preference resolves to 'system' whether or not storage is readable",
  );
});

test("'system' is resolved through prefers-color-scheme, not assumed", async () => {
  const theme = await read(THEME);
  const resolve = /export function resolveTheme\([\s\S]*?\n\}/.exec(theme);
  assert.ok(resolve, "resolveTheme must exist");
  assert.match(
    resolve[0],
    /matchMedia\("\(prefers-color-scheme: dark\)"\)/,
    "the device preference is the media query; nothing else can answer for it",
  );
  assert.match(
    resolve[0],
    /if \(choice !== "system"\) return choice;/,
    "an explicit choice must pass through untouched — that is what makes it beat the device",
  );
});

test("the boot script asks the device before it assumes anything", async () => {
  const boot = await read(BOOT);
  const script = /export const themeBootScript = \[([\s\S]*?)\]\.join\(""\);/.exec(boot);
  assert.ok(script, "the boot script must be a module-level constant");

  assert.match(script[1], /prefers-color-scheme: dark/);
  // The order is load-bearing: stored value first, device second.
  const storedAt = script[1].indexOf("THEME_STORAGE_KEY");
  const deviceAt = script[1].indexOf("prefers-color-scheme");
  assert.ok(
    storedAt !== -1 && storedAt < deviceAt,
    "the stored choice must be read before the device is asked, or an explicit choice loses",
  );
  assert.match(
    script[1],
    /c="system"/,
    "anything that is not an explicit light/dark resolves to 'system'",
  );
});

test("the device flipping is subscribed to, so 'system' actually tracks it", async () => {
  const theme = await read(THEME);
  const subscribe = /function subscribe\([\s\S]*?\n\}/.exec(theme);
  assert.ok(subscribe, "subscribe must exist");
  assert.match(
    subscribe[0],
    /media\.addEventListener\("change", onChange\)/,
    "a device theme change has to reach every subscriber, not just the one that asked",
  );
  assert.match(
    subscribe[0],
    /media\.removeEventListener\("change", onChange\)/,
    "and be torn down with the subscription",
  );
});

// ---------------------------------------------------------------------------
// 2. An explicit choice still wins, and survives.
// ---------------------------------------------------------------------------

test("the storage key has exactly one writer, and it is a user gesture", async () => {
  const files = await Promise.all(
    [THEME, BOOT, TOGGLE, BOARD, PORTAL, ACCOUNT_EXPLORE, ACCOUNT_SHELL].map(read),
  );
  const writers = [];
  for (const [index, source] of files.entries()) {
    // `setItem` on the preference key, anywhere but the migration marker.
    const matches = source.match(/setItem\(\s*THEME_STORAGE_KEY|setItem\(\s*["']maintsupp:theme-preference["']/g);
    if (matches) writers.push([index, matches.length]);
  }
  assert.equal(
    writers.length,
    1,
    "only theme.ts may write the preference; live-board writing it on mount is what gave every visitor an explicit 'dark' they never chose",
  );

  const theme = await read(THEME);
  const setter = /export function setThemeChoice\([\s\S]*?\n\}/.exec(theme);
  assert.ok(setter, "setThemeChoice must exist");
  assert.match(setter[0], /store\.setItem\(THEME_STORAGE_KEY, next\)/);
  assert.match(
    setter[0],
    /applyTheme\(resolveTheme\(next\)\)/,
    "the choice is applied immediately, so the control cannot disagree with the page",
  );
});

test("both pickers read and write the same store", async () => {
  const board = await read(BOARD);
  const toggle = await read(TOGGLE);
  const explore = await read(ACCOUNT_EXPLORE);

  for (const [name, source] of [
    ["live-board", board],
    ["theme-toggle", toggle],
    ["account-explore", explore],
  ]) {
    assert.match(
      source,
      /from "\.\.?\/(\.\.\/)?theme"|from "\.\/theme"/,
      `${name} must drive the shared store; a private copy is how the topbar read "Light" while the board read "Dark" in the same document`,
    );
    assert.match(source, /setThemeChoice/, `${name} must set the choice through the store`);
  }

  assert.equal(
    /useState<ThemePreference>/.test(board),
    false,
    "the board must not keep its own theme state",
  );
});

test("the raw choice is never written to the document", async () => {
  // `data-theme="system"` matches no stylesheet: the account panel used to
  // write the choice straight onto <body>, producing a third, unintended skin
  // in which the rail fell back to --navy-950 instead of its own ground.
  const explore = await read(ACCOUNT_EXPLORE);
  assert.equal(
    /dataset\.theme\s*=\s*theme\b/.test(explore),
    false,
    "the account theme panel must resolve through setThemeChoice, not assign the raw choice",
  );

  const theme = await read(THEME);
  const apply = /export function applyTheme\(resolved: ResolvedTheme\)[\s\S]*?\n\}/.exec(theme);
  assert.ok(apply, "applyTheme must exist");
  assert.match(
    apply[0],
    /root\.dataset\.theme = resolved/,
    "only a RESOLVED value — light or dark — may reach the attribute",
  );
});

test("nothing writes an unconditional theme any more", async () => {
  for (const path of [PORTAL, ACCOUNT_SHELL, BOARD, ACCOUNT_EXPLORE, TOGGLE]) {
    const source = strip(await read(path)).replace(/\/\/[^\n]*/g, "");
    assert.equal(
      /dataset\.theme\s*=\s*["']dark["']/.test(source),
      false,
      `${path} must not hard-code a theme onto the document`,
    );
    assert.equal(
      /setAttribute\(\s*["']data-theme["']\s*,\s*["'](dark|light)["']\s*\)/.test(source),
      false,
      `${path} must not hard-code a theme onto the document`,
    );
  }
});

test("the legacy auto-written preference is cleared exactly once", async () => {
  const boot = await read(BOOT);
  const theme = await read(THEME);

  assert.match(
    boot,
    /export const THEME_MIGRATION_KEY = "maintsupp:theme-default-migrated";/,
    "the one-off clear needs a marker of its own; the stored VALUE cannot tell a real choice from the one live-board wrote",
  );
  // Guarded by the marker in both places, so it can never run twice.
  assert.match(theme, /if \(store\.getItem\(THEME_MIGRATION_KEY\) === "1"\) return;/);
  assert.match(boot, /!=="1"/);
  // And a deliberate choice must mark it done, so the clear cannot land on top.
  assert.match(theme, /store\.setItem\(THEME_MIGRATION_KEY, "1"\)/);
});

// ---------------------------------------------------------------------------
// 3 and 4. color-scheme, and no flash.
// ---------------------------------------------------------------------------

test("color-scheme is applied with the theme, before paint and after", async () => {
  const theme = await read(THEME);
  assert.match(
    theme,
    /root\.style\.colorScheme = resolved/,
    "scrollbars, date pickers and unstyled controls follow color-scheme, not data-theme",
  );

  const boot = await read(BOOT);
  assert.match(boot, /e\.style\.colorScheme=r/);
});

test("the theme is stamped before first paint, on html and on body", async () => {
  const boot = await read(BOOT);
  const layout = await read(APP_LAYOUT);

  assert.match(boot, /e\.setAttribute\("data-theme",r\)/, "the root carries the token switch");
  assert.match(
    boot,
    /if\(d\.body\)\{d\.body\.setAttribute\("data-theme",r\)\}/,
    "and the body carries the light skin — stamping only one of the two is the flash with extra steps",
  );

  assert.match(
    layout,
    /<script dangerouslySetInnerHTML=\{\{ __html: themeBootScript \}\} \/>/,
    "the script must be inlined by the app layout",
  );
  // Ahead of the stylesheets, and ahead of everything the group renders.
  const scriptAt = layout.indexOf("themeBootScript }");
  const firstStyleAt = layout.indexOf("<link rel=\"stylesheet\"");
  const childrenAt = layout.indexOf("{children}");
  assert.ok(scriptAt !== -1 && scriptAt < firstStyleAt && scriptAt < childrenAt,
    "the boot script has to run before anything can paint");

  // Small enough to be worth inlining on every response.
  const script = /export const themeBootScript = \[([\s\S]*?)\]\.join\(""\);/.exec(boot);
  const bytes = script[1].replace(/\s*"|",?\s*/g, "").length;
  assert.ok(bytes < 900, `the inline script must stay tiny; measured ${bytes} bytes`);
});

test("React is told the theme attributes are expected", async () => {
  // Without this, hydration reports the attributes the boot script added as a
  // mismatch — a console error about the fix working.
  const root = await read(ROOT_LAYOUT);
  assert.match(root, /<html lang="en" suppressHydrationWarning>/);
  assert.match(root, /<body suppressHydrationWarning>/);
});

test("the account row is written on a change, not on arrival", async () => {
  // ThemeToggle used to PATCH /api/account 400ms after every mount, so merely
  // loading a page rewrote users.theme_preference.
  const toggle = await read(TOGGLE);
  assert.match(
    toggle,
    /if \(lastPersisted\.current === null\) \{\s*lastPersisted\.current = choice;\s*return;\s*\}/,
    "the first effect run is the page arriving, not somebody choosing",
  );
  assert.match(toggle, /if \(lastPersisted\.current === choice\) return;/);
});

// ---------------------------------------------------------------------------
// 5. The rail is dark in both themes, by token.
// ---------------------------------------------------------------------------

test("the rail tokens are declared on the bare :root", async () => {
  const globals = await read(GLOBALS);
  const bare = rulesOf(globals).find((rule) => rule.selector === ":root");
  assert.ok(bare, "globals.css must declare a bare :root palette");

  const required = [
    "--rail-bg",
    "--rail-bg-raised",
    "--rail-border",
    "--rail-fg",
    "--rail-fg-muted",
    "--rail-fg-faint",
    "--rail-accent",
    "--rail-hover-bg",
    "--rail-active-bg",
    "--rail-active-fg",
    "--rail-count-bg",
    "--rail-count-fg",
    "--rail-card-bg",
    "--rail-card-border",
    "--rail-control-bg",
    "--rail-control-border",
    "--rail-selected-bg",
  ];
  for (const token of required) {
    assert.match(
      bare.declarations,
      new RegExp(`${token}\\s*:`),
      `${token} must be defined on the bare :root, where both themes can see it`,
    );
  }
});

test("no theme block redefines a rail token — that is what 'always dark' means", async () => {
  for (const path of [GLOBALS, BRAND, SIDEBAR_CSS]) {
    const css = await read(path);
    for (const rule of rulesOf(css)) {
      const themed = rule.chain.some((selector) => selector.includes("data-theme"));
      if (!themed) continue;
      const offender = /--rail-[a-z-]+\s*:/.exec(rule.declarations);
      assert.equal(
        offender,
        null,
        `${path}: ${rule.chain.join(" ")} redefines ${offender?.[0]} — a rail token restated per theme is a rail that changes with the theme`,
      );
    }
  }
});

test("every rail token used is a token that exists", async () => {
  const globals = await read(GLOBALS);
  const bare = rulesOf(globals).find((rule) => rule.selector === ":root");
  const defined = new Set(
    [...bare.declarations.matchAll(/(--rail-[a-z-]+)\s*:/g)].map((match) => match[1]),
  );
  for (const path of [GLOBALS, BRAND, SIDEBAR_CSS]) {
    const css = strip(await read(path));
    for (const match of css.matchAll(/var\((--rail-[a-z-]+)/g)) {
      assert.ok(
        defined.has(match[1]),
        `${path} reads ${match[1]}, which nothing defines — an undefined custom property paints as nothing at all`,
      );
    }
  }
});

test("nothing in the rail hard-codes a colour", async () => {
  const offenders = [];
  for (const path of [GLOBALS, BRAND, SIDEBAR_CSS]) {
    const css = await read(path);
    for (const rule of rulesOf(css)) {
      if (!RAIL_SELECTOR.test(rule.selector)) continue;
      for (const declaration of declarationList(rule.declarations)) {
        if (!PAINTING.test(`;${declaration}`)) continue;
        if (!LITERAL.test(declaration)) continue;
        offenders.push(`${path}: ${rule.selector} { ${declaration} }`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a literal inside the rail paints the same in both themes and cannot follow one",
  );
});

test("the sidebar customisation editor is entirely tokenised", async () => {
  // 34 colour declarations, zero theme rules, ten of them dark-ground literals
  // on what light mode turned into a white rail. It is the part of the menu
  // that stays broken if the rail is fixed with an override instead of tokens.
  const css = strip(await read(SIDEBAR_CSS));
  const literals = [];
  for (const rule of rulesOf(css)) {
    for (const declaration of declarationList(rule.declarations)) {
      if (!PAINTING.test(`;${declaration}`)) continue;
      if (LITERAL.test(declaration)) literals.push(`${rule.selector} { ${declaration} }`);
    }
  }
  assert.deepEqual(literals, [], "sidebar-nav.css must paint only through the rail tokens");
  assert.equal(
    /data-theme/.test(css),
    false,
    "and must need no theme rule at all — the rail does not change with the theme",
  );
});

test("the light skin does not reach into the rail", async () => {
  const brand = await read(BRAND);
  for (const rule of rulesOf(brand)) {
    const chain = rule.chain.join(" ");
    if (!chain.includes('data-theme="light"')) continue;
    assert.equal(
      /\.portal-sidebar|\.portal-nav|\.workspace-switcher|\.workspace-tenants|\.sidebar-(help|profile|close)/.test(
        chain,
      ),
      false,
      `the light skin must not repaint the rail: ${chain}`,
    );
  }

  // The one that was easy to miss: the light control rule was scoped to the
  // SHELL, which is the rail plus the content area, so it caught the workspace
  // picker and the Testing-access select inside the rail.
  assert.equal(
    /\.portal-shell[^{]*:is\(input, select, textarea\)/.test(strip(brand)),
    false,
    "light control styling belongs to .portal-main, not .portal-shell",
  );
});

test("the rail's ground and inherited ink come from the tokens", async () => {
  const globals = await read(GLOBALS);
  const shell = rulesOf(globals).find(
    (rule) => rule.selector === ".portal-sidebar" && /position:\s*fixed/.test(rule.declarations),
  );
  assert.ok(shell, "the rail's layout rule must exist");
  assert.match(shell.declarations, /background:\s*var\(--rail-bg\)/);
  assert.match(
    shell.declarations,
    /color:\s*var\(--rail-fg\)/,
    "`color: white` here is inherited by every label with no colour of its own — it is the single worst line in the old sheet",
  );
  assert.match(
    shell.declarations,
    /color-scheme:\s*dark/,
    "the rail scrolls and holds two <select>s whose menus the browser draws itself; without this they are drawn for the PAGE's scheme and the option text goes near-white on white",
  );

  // And the dark theme block must not restate the rail's ground, which is how
  // the rail's real colour came to exist only in one of the two states.
  for (const rule of rulesOf(globals)) {
    if (!rule.chain.some((selector) => selector.includes('data-theme="dark"'))) continue;
    if (!/\.portal-sidebar/.test(rule.selector)) continue;
    assert.equal(
      /background|border-color/.test(rule.declarations),
      false,
      "the dark block must not own the rail's ground any more",
    );
  }
});

test("the rail's own controls state their colours rather than hoping to inherit", async () => {
  // A <select> inherits nothing useful from `.portal-sidebar { color }`, and
  // these two are the workspace picker and Testing access — the controls the
  // owner uses to move between clients.
  const brand = await read(BRAND);
  const rules = rulesOf(brand);
  const picker = rules.find((rule) => rule.selector === ".workspace-switcher__copy select");
  const testing = rules.find((rule) => rule.selector === ".sidebar-profile__copy select");

  assert.ok(picker, ".workspace-switcher__copy select must be styled");
  assert.match(picker.declarations, /color:\s*var\(--rail-fg\)/);

  assert.ok(testing, ".sidebar-profile__copy select must be styled");
  assert.match(testing.declarations, /color:\s*var\(--rail-accent\)/);
  assert.match(testing.declarations, /background:\s*var\(--rail-control-bg\)/);
});
