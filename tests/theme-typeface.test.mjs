/**
 * Phase 6 — the portal's typeface, made real and made configurable.
 *
 * WHAT WAS ACTUALLY WRONG, AND IT WAS NOT "YOU CANNOT CHOOSE A FONT".
 *
 * `app/brand-overrides.css` named `Inter` for the body and `Manrope` for headings,
 * and the portal loaded NEITHER. There is no `@font-face` anywhere in the tree, no
 * `.woff2`, no `next/font`, and `app/(app)/layout.tsx` emits no font `<link>` — the
 * marketing group fetches those two faces from Google, the portal does not, and the
 * two layouts deliberately share no stylesheet. So the typeface a customer saw was
 * already whatever their own machine happened to have, and two machines rendered the
 * product differently. Naming a face you do not ship is not a default; it is an
 * accident with a plausible-looking cause.
 *
 * THE ONE THAT WOULD HAVE FAILED SILENTLY.
 *
 * `resolveThemeCss` and `resolveThemeFamily` both decided whether an override was
 * "set" by calling `parseHex` on it. A font name is not a hex. So a typeface token
 * dropped into the catalogue would have been stored, audited, echoed back by
 * `GET /api/theme` and shown as changed in the panel — **and emitted nothing.**
 *
 * This product has been bitten by that exact shape twice, and both are written
 * down: `theme-repository.ts` records a cached read that answered with a stale
 * colour, and `app/(public)/f/[token]/public-form.tsx` records a font picker that
 * "did nothing on most phones — a control that changed a stored value and nothing a
 * submitter could see". `TokenKind` is what stops the third, and
 * "a typeface override reaches the document" below is the assertion that proves it.
 *
 * WHY THERE IS NO SIZE CONTROL, AND WHY THAT IS A FEATURE OF THIS FILE.
 *
 * Measured on this commit: **2,043 `font-size` declarations across `app/**` and ten
 * of them read a `var()`.** A size control would move ten rules while 2,033 ignored
 * it — a switch that saves and changes almost nothing, which is the same fault as a
 * switch that changes something and does not save. It also collides with a 16px
 * floor on typed controls that ten test files pin with a stated user-facing reason:
 * iOS zooms into a form field under 16px and does not zoom back out.
 * `docs/vibe-tokens.reference.css` and `docs/vibe-token-mapping.md` already hold a
 * risk-scored order for that migration. The last test here refuses a size token, so
 * adding one has to be a deliberate act that removes an assertion.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FONT_KEYS,
  FONT_STACKS,
  THEME_TOKEN_CATALOGUE,
  fontStack,
  resolveThemeCss,
  resolveThemeFamily,
  themeContrastWarnings,
  validateThemeToken,
} from "../app/lib/theme-tokens.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

const FONT_TOKENS = [
  ["type.body", "--type-body", "inter"],
  ["type.display", "--type-display", "manrope"],
];

/** The declarations inside the block beginning on `line`. */
function blockAt(css, startLine) {
  const lines = css.split("\n");
  let depth = 0;
  const collected = [];
  for (let i = startLine - 1; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length;
    depth -= (lines[i].match(/\}/g) ?? []).length;
    collected.push(lines[i]);
    if (depth === 0 && collected.length > 1) break;
  }
  const body = decommented(collected.join("\n"));
  const out = {};
  for (const m of body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

async function paletteBlocks() {
  const css = await read("app/globals.css");
  const lines = css.split("\n");
  const light = lines.findIndex((l) => /^:root\s*\{/.test(l)) + 1;
  const dark = lines.findIndex((l) => /^:root:not\(\[data-theme="light"\]\)/.test(l)) + 1;
  assert.ok(light > 0 && dark > 0, "both palette blocks must be findable");
  return { light: blockAt(css, light), dark: blockAt(css, dark) };
}

/* ------------------------------------------------------------------ */
/* The kind discriminator                                              */
/* ------------------------------------------------------------------ */

test("every token declares its kind, and only the two typefaces are fonts", () => {
  /*
   * RE-POINTED for the third kind, and DELIBERATELY NOT WEAKENED.
   *
   * `"choice"` joined `"colour"` and `"font"` when corners, depth and the board's
   * row height arrived. The contract this test protects is not "there are two
   * kinds" — it is that **every token declares one**, because the kind is what
   * stops a token being stored, audited, echoed back and shown as changed while
   * emitting nothing (see the silent-drop test below, which now covers all three).
   * So the list of kinds is widened and the two counts that say WHICH tokens are
   * which are kept exactly as they were.
   */
  const KINDS = new Set(["colour", "font", "choice"]);
  for (const token of THEME_TOKEN_CATALOGUE) {
    assert.ok(KINDS.has(token.kind), `${token.key} must declare a kind`);
    /* A choice token's bound IS its option list, so an empty one would be a
       control that offers nothing and a validator that refuses everything. */
    if (token.kind === "choice") {
      assert.ok(
        Array.isArray(token.options) && token.options.length >= 2,
        `${token.key} must offer at least two options`,
      );
    } else {
      assert.equal(token.options, undefined, `${token.key} must not carry options`);
    }
  }
  assert.deepStrictEqual(
    THEME_TOKEN_CATALOGUE.filter((t) => t.kind === "font").map((t) => t.key),
    FONT_TOKENS.map(([key]) => key),
  );
  assert.equal(
    THEME_TOKEN_CATALOGUE.filter((t) => t.kind === "colour").length,
    6,
    "the six colour tokens are unchanged by this phase",
  );
});

test("A TYPEFACE OVERRIDE REACHES THE DOCUMENT — the silent-drop regression", () => {
  /*
   * THE MOST IMPORTANT ASSERTION IN THIS FILE.
   *
   * Before `TokenKind`, `resolveThemeCss` filtered on `parseHex(override)`. A font
   * key is not a hex, so this returned "" — the token was stored, audited, echoed
   * back and shown as changed, and no pixel moved. Nothing in the suite would have
   * noticed, because no test asked a non-colour token to emit.
   */
  for (const [key, property] of FONT_TOKENS) {
    const css = resolveThemeCss({ [key]: "serif" });
    assert.match(
      css,
      new RegExp(`${property}:`),
      `${key} must EMIT ${property}. If this fails, the token saves and changes ` +
        "nothing — check the kind gate in resolveThemeCss.",
    );
    assert.match(css, /ui-serif/, "and the emitted value must be the whitelisted stack");
    assert.ok(css.startsWith(":root{"), "on :root, where the consumers resolve it from");
  }
});

test("an unknown face is treated as unset, not emitted", () => {
  /*
   * The server refuses an unknown face on write, so this should be unreachable. But
   * a row written before a face was retired would still be in the table, and the
   * honest answer to "we no longer ship that" is the shipped default — not a CSS
   * declaration naming a font nobody has.
   */
  assert.equal(resolveThemeCss({ "type.body": "not-a-real-face" }), "");
  const family = resolveThemeFamily({ "type.body": "not-a-real-face" }, "dark");
  assert.equal(
    family["--type-body"],
    FONT_STACKS.inter.stack,
    "it falls back to the seed",
  );
});

test("a workspace that has changed nothing still emits nothing", () => {
  assert.equal(resolveThemeCss({}), "");
  assert.deepStrictEqual(themeContrastWarnings({}), []);
});

/* ------------------------------------------------------------------ */
/* The whitelist, and what it keeps out                                */
/* ------------------------------------------------------------------ */

test("every offered face resolves on the reader's own machine", () => {
  /*
   * No `url(`, no `http`, no `@import`. A webfont would arrive after first paint and
   * reflow the page, and the board's line lengths, truncation points, `line-clamp`
   * and its twelve-plus `font-variant-numeric: tabular-nums` alignments were all
   * measured against metrics the product already has. This is also why the marketing
   * site's Google Fonts `<link>` is not copied into the portal: one page a visitor
   * reads once is a different bargain from a shell somebody keeps open all day.
   */
  assert.ok(FONT_KEYS.length >= 4, `expected several faces, got ${FONT_KEYS.length}`);
  for (const key of FONT_KEYS) {
    const entry = FONT_STACKS[key];
    assert.ok(entry, `${key} must be in FONT_STACKS`);
    assert.ok(entry.label && entry.label.length > 1, `${key} needs a human label`);
    assert.ok(!/url\(|https?:|@import/i.test(entry.stack), `${key} must not fetch anything`);
    assert.match(
      entry.stack,
      /(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif)\s*$/,
      `${key} must end in a generic family, so it always resolves to something`,
    );
  }
});

test("the portal still loads no webfont, and this phase added none", async () => {
  const layout = await read("app/(app)/layout.tsx");
  assert.ok(
    !/fonts\.googleapis|fonts\.gstatic|rel="preconnect"|@font-face/.test(decommented(layout)),
    "the (app) layout must not start fetching a font — every offered face is local",
  );
  const globals = await read("app/globals.css");
  const brand = await read("app/brand-overrides.css");
  /* Comments stripped: `globals.css`'s own typeface block explains that there is no
     `@font-face` anywhere, and an assertion that could not tell the explanation from
     a declaration would be unfixable. */
  for (const [name, css] of [["globals.css", globals], ["brand-overrides.css", brand]]) {
    assert.ok(
      !/@font-face/.test(decommented(css)),
      `${name} must declare no @font-face — every offered face is local`,
    );
  }
  /* And the marketing group keeps its own loader, untouched — the two layouts
     deliberately share no stylesheet, which `stage-thirteen-css-split` pins. */
  const marketing = await read("app/(marketing)/layout.tsx");
  assert.match(marketing, /fonts\.googleapis/, "marketing keeps its own font loading");
});

test("the value stored is the KEY, and a caller's string never reaches the CSS", () => {
  /*
   * The safety boundary. A font stack is a far harder string to make safe than
   * `#rrggbb` — commas, quotes, arbitrary family names — so none of it is taken from
   * a request. `validateThemeToken` accepts only a whitelist KEY and the stack is
   * looked up server-side at render, which is the same principle the hex branch
   * follows by re-serialising from parsed integers.
   */
  const ok = validateThemeToken("type.body", "manrope");
  assert.deepStrictEqual(ok, { ok: true, key: "type.body", value: "manrope" });

  for (const hostile of [
    'Inter", sans-serif; } :root { --brand-primary: red',
    "url(https://evil.example/f.woff2)",
    "Inter, sans-serif",
    "</style><script>x()</script>",
    "",
    "INTER",
  ]) {
    const result = validateThemeToken("type.body", hostile);
    assert.equal(result.ok, false, `refused: ${JSON.stringify(hostile)}`);
  }

  /* Including the full stack itself — only the key is a valid value. */
  assert.equal(validateThemeToken("type.body", FONT_STACKS.inter.stack).ok, false);
  assert.equal(fontStack("not-a-face"), null);
});

test("a typeface has no contrast ratio, so the validator ignores it", () => {
  /*
   * A font stack compared to a background is nonsense. The contrast a typeface
   * participates in is between the ink and the ground, which the colour tokens
   * already own — and `theme-chart-tokens` asserts the warning rate over 1,331
   * colours stays under 5%, which a font token must not perturb.
   */
  assert.deepStrictEqual(themeContrastWarnings({ "type.body": "serif" }), []);
  assert.deepStrictEqual(themeContrastWarnings({ "type.display": "geometric" }), []);
});

/* ------------------------------------------------------------------ */
/* The declarations, and the file that actually wins                   */
/* ------------------------------------------------------------------ */

test("both typefaces are declared on the bare :root, and only there", async () => {
  const { light, dark } = await paletteBlocks();
  for (const [key, property] of FONT_TOKENS) {
    const token = THEME_TOKEN_CATALOGUE.find((t) => t.key === key);
    assert.equal(
      light[property],
      token.seed.light[property],
      `${property} must be declared on the bare :root exactly as the token seeds it`,
    );
    assert.equal(
      dark[property],
      undefined,
      `${property} must NOT be restated in the dark block — a typeface does not ` +
        "change with the theme, and two declarations would invite them to drift",
    );
  }
});

test("brand-overrides.css consumes them, and it is the file that wins", async () => {
  /*
   * Two files declare the same stacks and only one matters. `app/(app)/layout.tsx`
   * links `globals.css` and then `brand-overrides.css`, so at equal specificity the
   * second wins — which is why the tokens are consumed there. A reader looking for
   * "where is the font set" finds two places; this pins which one is live.
   */
  const brand = await read("app/brand-overrides.css");
  assert.match(brand, /font-family: var\(--type-body\);/);
  assert.match(brand, /font-family: var\(--type-display\);/);

  const layout = await read("app/(app)/layout.tsx");
  const globalsAt = layout.indexOf("href={globalsCss}");
  const brandAt = layout.indexOf("href={brandCss}");
  assert.ok(globalsAt > 0 && brandAt > 0, "both stylesheets must be linked");
  assert.ok(
    brandAt > globalsAt,
    "brand-overrides.css must still load AFTER globals.css, or the token consumers " +
      "stop being the winning declarations",
  );
});

test("the three dead --font-geist-sans references are gone", async () => {
  /*
   * A `create-next-app` leftover. `--font-geist-sans` was referenced three times and
   * declared NOWHERE, and a `var()` with no fallback whose property is undefined is
   * invalid at computed-value time: the whole `font-family` computes to `unset`,
   * which for an inherited property means `inherit`. So all three were no-ops —
   * including one on `.portal-shell` that out-specified the real body rule and then
   * did nothing. Re-pointed at `--type-body` rather than deleted, because each was a
   * place somebody meant the body face to apply.
   */
  for (const file of [
    "app/globals.css",
    "app/brand-overrides.css",
    "app/(app)/portal/media-viewer.css",
  ]) {
    const css = await read(file);
    assert.ok(
      !/--font-geist-sans/.test(css),
      `${file} still references --font-geist-sans, which is declared nowhere`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The control                                                         */
/* ------------------------------------------------------------------ */

test("the panel offers a select for a face and a swatch for a colour", async () => {
  const panel = await read("app/(app)/portal/views/brand-colours-panel.tsx");
  /*
   * RE-POINTED: the panel's type gained `"choice"`, and the branch that chooses a
   * select now reads `!== "colour"` rather than `=== "font"`. The contract is the
   * same one and is still asserted — the kind is READ from the server rather than
   * inferred from the key, and a COLOUR is the only kind that gets a swatch.
   */
  assert.match(panel, /kind: "colour" \| "font" \| "choice";/, "the kind is read, not inferred");
  assert.match(panel, /token\.kind !== "colour" \? \(/, "one list control, for every kind that has a list");
  assert.match(panel, /<select/);
  assert.match(panel, /type="color"/, "the colour control is unchanged");
  assert.ok(
    !/type="text"/.test(decommented(panel)),
    "a free-text font field would be a much harder string to make safe than a hex",
  );
  /* The choices come from the server, which is the same list the API refuses
     anything outside. A copy here would be a second source of truth for a safety
     boundary. */
  assert.match(panel, /\(token\.choices \?\? \[\]\)\.map/);
  const route = await read("app/api/theme/route.ts");
  assert.match(route, /token\.kind === "font"\s*\?\s*FONT_KEYS\.map/);
  assert.match(route, /kind: token\.kind,/);
});

test("the panel says what the typeface does NOT reach", async () => {
  /*
   * A claim on a settings screen is a promise — `theme-chart-tokens` pins the same
   * rule for the chart exclusions. Sizes are not configurable, and saying so is
   * better than letting somebody hunt for the control.
   */
  const panel = await read("app/(app)/portal/views/brand-colours-panel.tsx");
  assert.match(panel, /The typeface applies across the portal\./);
  assert.match(panel, /sizes<\/em> are not\s*\n?\s*configurable/);
  assert.match(panel, /iPhones zoom in and never zoom back out/,
    "and the reason for the 16px floor is recorded where somebody would change it");
  /* RE-POINTED: the card now also carries the surface group, so the heading names
     all three rather than two. */
  assert.match(
    panel,
    /Brand colours, typeface and surface style/,
    "the heading names what the card contains",
  );
});

/* ------------------------------------------------------------------ */
/* The line this phase does not cross                                  */
/* ------------------------------------------------------------------ */

test("no token configures a text SIZE, and that is deliberate", async () => {
  /*
   * The guard on the next person's instinct. 2,043 `font-size` declarations exist
   * across `app/**` and ten read a `var()`; a size token would move ten rules. If
   * this assertion is ever in the way, the answer is the migration in
   * `docs/vibe-token-mapping.md`, not the removal of this test.
   *
   * It also protects a contract with a user-facing reason: ten test files pin a 16px
   * floor on anything a reader types into, because iOS zooms a smaller field and does
   * not zoom back out. A multiplier would break the RELATIONSHIP those pins protect.
   */
  const FORBIDDEN = /font-size|line-height|letter-spacing|font-weight/;
  for (const token of THEME_TOKEN_CATALOGUE) {
    for (const mode of ["light", "dark"]) {
      for (const property of Object.keys(token.seed[mode])) {
        assert.ok(
          !FORBIDDEN.test(property),
          `${token.key} seeds ${property} — a metric token needs the vibe-token ` +
            "migration behind it, not a switch in front of it",
        );
      }
    }
  }
  /* And the 16px floor is still where it was. */
  const brand = await read("app/brand-overrides.css");
  assert.match(
    brand,
    /:root :is\(input, select, textarea\)[^{]*\{\s*\n?\s*font-size: 16px;/,
    "the iOS zoom floor must remain a literal 16px",
  );
});
