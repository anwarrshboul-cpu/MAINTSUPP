import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contrastRatio } from "../app/(app)/portal/chip-ink.ts";
import {
  AA_FILL,
  AA_TEXT,
  MODE_GROUND,
  deriveBrandFamily,
  deriveStatusFamily,
} from "../app/lib/theme-colour.ts";
import {
  THEME_TOKEN_CATALOGUE,
  resolveThemeCss,
  resolveThemeFamily,
  themeContrastWarnings,
  validateThemeToken,
} from "../app/lib/theme-tokens.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/* ------------------------------------------------------------------ */
/* Parsing the shipped palette out of globals.css                      */
/* ------------------------------------------------------------------ */

/**
 * The declarations inside the block that begins on `line`.
 *
 * Deliberately a brace-counting scan rather than a regex over the whole file:
 * `globals.css` is 17,000 lines with nested at-rules, and a lazy regex picks up
 * the wrong closing brace. Comments are stripped first because several token
 * declarations are commented out inside the block as documentation.
 */
function blockAt(css, startLine) {
  const lines = css.split("\n");
  let depth = 0;
  const collected = [];
  for (let i = startLine - 1; i < lines.length; i += 1) {
    const line = lines[i];
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    collected.push(line);
    if (depth === 0 && collected.length > 1) break;
  }
  const body = collected.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = {};
  for (const match of body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

/*
 * RE-POINTED: THE SHIPPED VALUES NO LONGER ALL LIVE IN ONE FILE.
 *
 * `app/board-metrics.css` declares the board's geometry — row, header, group and
 * subitem heights — on its own `:root`, and its header says why it is separate:
 * "COLOUR IS NOT COPIED. Every value below is a dimension." `layout.board_density`
 * seeds four of those dimensions, so the test that proves a seed matches what
 * ships has to read the file that ships it. The CONTRACT is unchanged and is the
 * whole reason this test exists: a seed that disagrees with the stylesheet would
 * make a workspace paint a stale value the moment it overrode anything unrelated.
 *
 * Only the `:root` block is read, and only from files the layout actually loads in
 * this order — globals, then board-metrics — so the merge below is the cascade the
 * browser performs, not an invention.
 */
async function shippedMetrics() {
  const css = await read("app/board-metrics.css");
  const lines = css.split("\n");
  const rootLine = lines.findIndex((line) => /^:root\s*\{/.test(line)) + 1;
  assert.ok(rootLine > 0, "board-metrics.css must declare its metrics on a bare :root");
  return blockAt(css, rootLine);
}

async function shippedPalette() {
  const css = await read("app/globals.css");
  const lines = css.split("\n");

  const lightLine = lines.findIndex((line) => /^:root\s*\{/.test(line)) + 1;
  const darkLine =
    lines.findIndex((line) => /^:root:not\(\[data-theme="light"\]\)/.test(line)) + 1;

  assert.ok(lightLine > 0, "globals.css must declare the light palette on a bare :root");
  assert.ok(darkLine > 0, "globals.css must declare a dark palette block");

  const metrics = await shippedMetrics();
  /* The board's dimensions are mode-independent — board-metrics.css has no dark
     block — so they join both sides exactly as the cascade delivers them. */
  const light = { ...metrics, ...blockAt(css, lightLine) };
  const dark = blockAt(css, darkLine);
  /* The dark block restates only what differs, so anything it does not name is
     inherited from the light block — the same resolution a browser performs. */
  return { light, dark: { ...light, ...dark } };
}

/* ------------------------------------------------------------------ */

test("the seeded palette is the one globals.css actually ships", async () => {
  /*
   * THE POINT OF THIS TEST.
   *
   * `tests/stage-twentysix-contrast.test.mjs` explains why it reads the hexes
   * out of `globals.css` rather than restating them: "a test with the hex values
   * written into it is a second copy of the palette", and a second copy drifts.
   *
   * `app/lib/theme-tokens.ts` had to make exactly that second copy — the theme
   * engine needs the shipped values as its fallback, and a stylesheet cannot be
   * imported as data by the server bundle. So the copy is pinned here instead.
   * If somebody retunes a colour in `globals.css` and not in the seed, a
   * workspace that has never touched the editor would keep painting the old
   * value the moment it overrode any unrelated token. This test is what makes
   * that impossible.
   */
  const palette = await shippedPalette();

  for (const token of THEME_TOKEN_CATALOGUE) {
    for (const mode of ["light", "dark"]) {
      for (const [property, seeded] of Object.entries(token.seed[mode])) {
        assert.equal(
          seeded,
          palette[mode][property],
          `${token.key} seeds ${property} as "${seeded}" for the ${mode} theme, but ` +
            `globals.css ships "${palette[mode][property]}". Update the seed in ` +
            `app/lib/theme-tokens.ts to match, or the fallback is wrong.`,
        );
      }
    }
  }
});

test("a workspace that has changed nothing emits no CSS at all", () => {
  /*
   * The single most important property of this phase. Every organisation,
   * Production included, has an empty `theme_tokens` table on the day this
   * ships. An empty string renders no element, so the page is byte-identical to
   * what it is today and there is nothing that can go wrong.
   */
  assert.equal(resolveThemeCss({}), "");
  assert.equal(resolveThemeCss({ "brand.primary": "" }), "");
  assert.equal(resolveThemeCss({ "brand.primary": "not a colour" }), "");
  assert.equal(resolveThemeCss({ "unknown.token": "#ffffff" }), "");
});

test("an unset token resolves to the shipped value, not to a derived one", () => {
  /*
   * The seed is the hand-tuned palette and must be used verbatim. Deriving the
   * default from `#12b4a8` would produce a near-miss of every rung and repaint
   * every existing customer for no benefit — see the header of theme-tokens.ts.
   */
  const brand = THEME_TOKEN_CATALOGUE.find((t) => t.key === "brand.primary");
  for (const mode of ["light", "dark"]) {
    const resolved = resolveThemeFamily({}, mode);
    for (const [property, value] of Object.entries(brand.seed[mode])) {
      assert.equal(resolved[property], value);
    }
  }
  /* And the derivation of the same hex is NOT the seed, which is the reason the
     seed has to exist rather than being computed. */
  assert.notDeepEqual(
    deriveBrandFamily("#12b4a8", "light"),
    brand.seed.light,
  );
});

test("only hex this server re-serialised can reach the stylesheet", () => {
  /*
   * `resolveThemeCss` interpolates into a `<style>` element. The defence is not
   * escaping — it is that the caller's string is parsed into three integers and
   * thrown away, so nothing a caller wrote is ever emitted.
   */
  const refused = [
    ["brand.primary", "red"],
    ["brand.primary", "#12b4a8;} body{display:none"],
    ["brand.primary", "url(javascript:alert(1))"],
    ["brand.primary", '#12b4a8"><script>alert(1)</script>'],
    ["brand.primary", "var(--anything)"],
    ["brand.primary", "#12b4a"],
    ["brand.primary", 123],
    ["brand.primary", null],
    ["unknown.token", "#ffffff"],
    [42, "#ffffff"],
  ];
  for (const [key, value] of refused) {
    const result = validateThemeToken(key, value);
    assert.equal(result.ok, false, `${String(key)} = ${String(value)} must be refused`);
  }

  const accepted = [
    ["brand.primary", "#7C3AED", "#7c3aed"],
    ["brand.primary", "  #fff  ", "#ffffff"],
    ["status.danger", "#ff4d5e", "#ff4d5e"],
  ];
  for (const [key, value, expected] of accepted) {
    const result = validateThemeToken(key, value);
    assert.equal(result.ok, true, `${value} should be accepted`);
    assert.equal(result.value, expected);
  }

  /*
   * And nothing that survives can carry a CSS delimiter. Read as property/value
   * pairs rather than by splitting on the block braces: an earlier version of
   * this assertion split on `}` and `{` and joined the last value of the light
   * block to the first property of the dark one, which failed on correct output.
   */
  const css = resolveThemeCss({ "brand.primary": "#7c3aed", "status.danger": "#ff0000" });
  const pairs = [...css.matchAll(/(--[A-Za-z0-9-]+):([^;}]+)/g)];
  assert.ok(pairs.length > 0, "the emitted CSS must contain declarations");
  for (const [, property, value] of pairs) {
    assert.match(
      property,
      /^--[a-z0-9-]+$/,
      `emitted property "${property}" is not a token`,
    );
    assert.match(
      value,
      /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/,
      `emitted "${value}" is not a plain colour`,
    );
  }

  /* Nothing that could end a declaration or open a rule survives anywhere. */
  assert.ok(!css.includes("</"), "the emitted CSS must not be able to close a tag");
  assert.equal(
    (css.match(/\{/g) ?? []).length,
    2,
    "exactly two blocks — a third means a value opened a rule of its own",
  );
});

test("the emitted block reuses globals.css's own selectors, so order decides", async () => {
  /*
   * The cascade tie-break IS the mechanism: the block is rendered after the
   * three stylesheet links, and wins only because its selectors match exactly.
   * A heavier selector would win too, and would also outrank the [data-theme]
   * rules further down globals.css that these tokens cooperate with.
   */
  const css = resolveThemeCss({ "brand.primary": "#7c3aed" });
  assert.ok(css.startsWith(":root{"), "the light block must be a bare :root");
  assert.ok(
    css.includes(':root:not([data-theme="light"]), body[data-theme="dark"]{'),
    "the dark block must match globals.css's dark selector verbatim",
  );

  const globals = await read("app/globals.css");
  assert.ok(
    globals.includes(':root:not([data-theme="light"]),'),
    "globals.css no longer declares the selector the emitted block copies — " +
      "re-point LIGHT_SELECTOR/DARK_SELECTOR in app/lib/theme-tokens.ts",
  );
});

test("a derived text shade reads on the page AND on its own wash", () => {
  /*
   * `globals.css` states the contract in its light-palette comment: a -fg shade
   * clears "4.5:1 on every light surface and on its own wash". Solving against
   * the page alone satisfies half of it — measured across 1,331 hues, 84% of
   * them produced a -fg that read on the page and failed on its own wash. That
   * regression is what this test exists to catch.
   */
  const hues = [];
  for (let r = 0; r < 256; r += 51) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 51) {
        hues.push(`#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }

  for (const hex of hues) {
    for (const mode of ["light", "dark"]) {
      const ground = MODE_GROUND[mode];

      const brand = deriveBrandFamily(hex, mode);
      assert.ok(
        contrastRatio(brand["--brand-fg"], ground) >= AA_TEXT,
        `${hex} ${mode}: --brand-fg fails on the page`,
      );
      assert.ok(
        contrastRatio(brand["--brand-fg"], brand["--brand-wash"]) >= AA_TEXT,
        `${hex} ${mode}: --brand-fg fails on its own wash`,
      );
      assert.ok(
        contrastRatio(brand["--brand-fill"], ground) >= AA_FILL,
        `${hex} ${mode}: --brand-fill fails the 3:1 a filled control needs`,
      );

      const status = deriveStatusFamily("green", hex, mode);
      assert.ok(
        contrastRatio(status["--status-green-fg"], ground) >= AA_TEXT,
        `${hex} ${mode}: --status-green-fg fails on the page`,
      );
      assert.ok(
        contrastRatio(status["--status-green-fg"], status["--status-green-wash"]) >=
          AA_TEXT,
        `${hex} ${mode}: --status-green-fg fails on its own wash`,
      );
    }
  }
});

test("the chrome follows the brand, and the rail stays theme-invariant", async () => {
  /*
   * Two contracts in one test, because they pull against each other.
   *
   * FOLLOWS: the sidebar and topbar read `--rail-*` (133 uses) and `--legacy-*`
   * (71 uses), not `--brand-*`. A brand colour that repaints the buttons and
   * leaves the navigation teal is the half-feature "no fake implementation"
   * exists to prevent, so the brand-derived members of those sets move too.
   *
   * STAYS: `globals.css` declares `--rail-*` ONCE, with no dark override, so the
   * chrome does not shift between themes. Deriving it per mode would give the
   * rail two appearances. It must therefore take one value in both blocks.
   */
  const css = resolveThemeCss({ "brand.primary": "#7c3aed" });
  for (const property of [
    "--rail-accent",
    "--rail-active-fg",
    "--rail-active-bg",
    "--rail-selected-bg",
    "--legacy-brand-primary",
    "--legacy-accent-fg",
    "--legacy-teal-500",
  ]) {
    assert.ok(
      css.includes(`${property}:`),
      `${property} must follow a brand change or the chrome stays teal`,
    );
  }

  const light = resolveThemeFamily({ "brand.primary": "#7c3aed" }, "light");
  const dark = resolveThemeFamily({ "brand.primary": "#7c3aed" }, "dark");
  for (const property of Object.keys(light)) {
    if (!property.startsWith("--rail-")) continue;
    assert.equal(
      light[property],
      dark[property],
      `${property} differs between themes — the rail is pinned theme-invariant ` +
        "in globals.css and deriving it per mode breaks that on purpose-built chrome",
    );
  }

  /* And the neutrals must NOT move. A hue filter over these sets also catches
     the near-greys, which are grounds; they stay wherever the brand goes. */
  for (const property of [
    "--rail-bg",
    "--rail-fg",
    "--legacy-canvas",
    "--legacy-line-soft",
    "--legacy-ink",
  ]) {
    assert.ok(
      !css.includes(`${property}:`),
      `${property} is a ground, not a brand colour — it must not follow the brand`,
    );
  }
});

test("the contrast warning is silent on the default and honest about the rest", () => {
  /*
   * Two failure modes, both of which this validator has actually had:
   *
   *  - Warning about the SHIPPED palette. An earlier version measured the bare
   *    --brand-primary against the page and reported the house teal at 2.59:1,
   *    because the palette has a separate rung (--brand-fill) for that job. A
   *    validator that flags the default teaches people to dismiss it.
   *  - Never firing at all. Checking only the rungs the solver guarantees gives
   *    a green tick that proves nothing.
   */
  assert.deepEqual(themeContrastWarnings({}), []);
  assert.deepEqual(themeContrastWarnings({ "brand.primary": "#12b4a8" }), []);

  let swept = 0;
  let warned = 0;
  for (let r = 0; r < 256; r += 25) {
    for (let g = 0; g < 256; g += 25) {
      for (let b = 0; b < 256; b += 25) {
        const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        swept += 1;
        if (themeContrastWarnings({ "brand.primary": hex }).length > 0) warned += 1;
      }
    }
  }
  const rate = warned / swept;
  assert.ok(rate > 0, "a validator that can never fire is not a validator");
  assert.ok(
    rate < 0.05,
    `${(rate * 100).toFixed(1)}% of colours warn — that is noise, not a warning. ` +
      "A rate this high means a derived rung is failing a pair the solver should " +
      "have handled, not that the colours are bad.",
  );
});

test("the write path is capability-gated, tenant-scoped and audited", async () => {
  const route = await read("app/api/theme/route.ts");

  assert.match(
    route,
    /requireCapability\(subject, "settings\.edit"\)/,
    "PUT /api/theme must require settings.edit — the same capability that gates " +
      "the Overview's meter colours in app/api/overview/meter-settings/route.ts",
  );
  assert.match(
    route,
    /if \(!scope\.authenticated\)/,
    "a caller who has not proved who they are must not repaint a workspace",
  );
  assert.match(
    route,
    /scopedDb\(request\)/,
    "the organisation must come from the tenancy resolver, never from the request",
  );
  assert.match(
    route,
    /action: write\.value === null \? "theme\.token_reset" : "theme\.token_changed"/,
    "every colour change must reach the audit log",
  );
  /* Validation before any write — a partial save leaves a palette that is
     neither what they had nor what they asked for. */
  assert.ok(
    route.indexOf("validateThemeToken") < route.indexOf("writeThemeOverride"),
    "every value must be validated before anything is written",
  );
});

test("resetting a colour deletes the row rather than storing the default", async () => {
  /*
   * The difference matters the day the shipped palette changes: a workspace that
   * reset stays with the product, and one that had today's teal written into it
   * would be silently frozen on a colour nobody chose.
   */
  const repository = await read("app/lib/theme-repository.ts");
  assert.match(
    repository,
    /if \(value === null\) \{[\s\S]*?\.delete\(themeTokens\)/,
    "a null value must delete the row",
  );
  /*
   * RE-POINTED, not removed. This assertion used to require
   * `invalidateThemeCache(organisationId)` after a write, guarding the contract
   * "a save is visible immediately". That contract still holds; its home moved.
   *
   * Authenticated QA against the deployed Preview showed why: the cache was
   * per-isolate, so a write invalidated only the serverless instance that served
   * it and a read landing elsewhere answered with the old colour for up to
   * thirty seconds. Since the editor reloads the page after saving, that meant
   * watching the product repaint in the OLD colour and concluding the save had
   * failed. There is no cross-instance invalidation channel in this product, so
   * the cache went instead — it was guarding two rare callers.
   *
   * The pin therefore now asserts the absence, which is what makes the save
   * immediate. Reintroducing a cache here without a shared invalidation channel
   * brings the bug back, so this test refuses one.
   */
  assert.ok(
    !/new Map\(|CACHE_TTL|invalidateThemeCache/.test(repository),
    "theme-repository.ts must not cache: the cache was per-isolate, so a saved " +
      "colour could stay invisible on other serverless instances for up to its " +
      "TTL, which reads as a save that silently failed",
  );
  assert.match(
    repository,
    /export async function readThemeOverrides[\s\S]*?await db\s*\n?\s*\.select/,
    "every read must go to the database, so the answer is always current",
  );
});

test("the stamped style element comes after the stylesheets it overrides", async () => {
  const layout = await read("app/(app)/layout.tsx");
  const brandCss = layout.indexOf("href={brandCss}");
  const styleTag = layout.indexOf("data-maintsupp-theme");
  assert.ok(brandCss > 0, "the layout must still load brand-overrides.css");
  assert.ok(styleTag > 0, "the layout must stamp the workspace theme");
  assert.ok(
    styleTag > brandCss,
    "the theme block must be rendered AFTER the stylesheet links — it wins the " +
      "cascade by document order alone, because it reuses their selectors",
  );
});
