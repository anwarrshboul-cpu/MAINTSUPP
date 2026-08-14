import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chipInk, contrastRatio } from "../app/(app)/portal/chip-ink.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * TEXT CONTRAST, COMPUTED FROM THE TOKENS THEMSELVES.
 *
 * The owner's report was "in the light mode we can't see the text". The
 * measurement behind it: 12,470 text nodes below WCAG AA in light and 5,852 in
 * dark, across 18 of 19 routes — and the cause was not sixty bad screens. It
 * was that colours were hard-coded outside any `[data-theme]` block, so they
 * painted the same in both themes and could not follow one; and that the tint
 * pairs were tuned one half at a time, so a `-100` wash was restated per theme
 * while the `-600` ink that goes on it was not.
 *
 * WHY THIS TEST READS THE STYLESHEET INSTEAD OF LISTING COLOURS
 *
 * A test with the hex values written into it is a second copy of the palette,
 * and the failure it is meant to catch — the two copies drifting — is exactly
 * what it would stop detecting. So the token values are PARSED out of
 * globals.css, per theme, and the ratios are recomputed here every run. Change
 * `--muted` to something too pale and this file fails; add a token pair and it
 * is checked from the first run; the numbers cannot rot because there are no
 * numbers to rot.
 *
 * WHAT COUNTS AS A PAIR
 *
 * Only pairs the product actually paints. A foreground token is checked
 * against the surfaces it is really used on — `--muted` against `--canvas`
 * (the page ground) as well as `--paper`, because tuning it against paper
 * alone is how it ended up at 4.23:1 on the ground most secondary text
 * actually sits on.
 */

/** WCAG AA for body text. Every pair below is body-sized. */
const AA = 4.5;

/* ------------------------------------------------------------------ */
/* Reading the palette                                                 */
/* ------------------------------------------------------------------ */

/**
 * The token blocks, as text.
 *
 * `:root` is the complete light palette; the dark block redefines only what
 * differs. The dark selector list is matched loosely on purpose — it names two
 * selectors (`:root:not([data-theme="light"])` and `body[data-theme="dark"]`)
 * because the attribute lands on both `html` and `body`, and this test should
 * keep working if that list is edited again.
 */
function blocks(css) {
  const light = css.match(/(?:^|\n):root\s*\{([\s\S]*?)\n\}/);
  assert.ok(light, "globals.css must declare the light palette on a bare :root");

  const darkStart = css.search(/\n:root:not\(\[data-theme="light"\]\)/);
  assert.ok(darkStart > 0, "globals.css must declare a dark palette block");
  const dark = css.slice(darkStart).match(/\{([\s\S]*?)\n\}/);
  assert.ok(dark, "the dark palette block must be readable");

  return { light: light[1], dark: dark[1] };
}

/** `--name: value;` pairs from one block, comments and nesting ignored. */
function tokens(block) {
  const found = new Map();
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of withoutComments.split("\n")) {
    const match = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (match) found.set(match[1], match[2].trim());
  }
  return found;
}

/**
 * A token's value in one theme, following `var()` indirection.
 *
 * Dark falls back to light for anything it does not restate — which is what
 * the cascade does, and what makes "declared only inside a theme block" a bug
 * this test can see rather than a hole it falls through.
 */
function resolve(name, theme, palettes, seen = new Set()) {
  assert.ok(!seen.has(name), `token cycle through ${name}`);
  seen.add(name);
  const value =
    (theme === "dark" ? palettes.dark.get(name) : undefined) ??
    palettes.light.get(name);
  assert.ok(value, `token ${name} is not declared on :root (${theme})`);
  const indirect = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  return indirect ? resolve(indirect[1], theme, palettes, seen) : value;
}

const css = await read("app/globals.css");
const raw = blocks(css);
const palettes = { light: tokens(raw.light), dark: tokens(raw.dark) };

/* ------------------------------------------------------------------ */
/* The pairs                                                           */
/* ------------------------------------------------------------------ */

/**
 * Foreground token -> the surfaces it is painted on.
 *
 * Each entry is a pairing the product makes somewhere. The comment on a pair
 * names where, so a future reader can check the claim rather than trust it.
 */
const PAIRS = [
  // Body copy and headings, on both the page ground and a card.
  ["--ink", "--canvas"],
  ["--ink", "--paper"],
  ["--ink", "--surface-card"],
  ["--ink", "--surface-card-hi"],
  ["--ink", "--surface-card-lo"],
  ["--ink", "--surface-sunken"],
  ["--ink", "--surface-head"],
  ["--ink", "--surface-hover"],
  ["--ink", "--surface-active"],

  // Secondary text. `--muted` on `--canvas` is the pair that was at 4.23:1 and
  // accounted for 1,664 failing nodes: page subtitles, drawer labels, the
  // board's summary strip.
  ["--muted", "--canvas"],
  ["--muted", "--paper"],
  ["--muted", "--surface-card"],
  ["--muted", "--surface-card-lo"],
  ["--muted", "--surface-sunken"],
  ["--muted", "--surface-head"],

  // The third step of the ink ladder. It failed EVERYWHERE it was used in
  // light (2.87:1 on paper, 2.67:1 on canvas) — a step so quiet it had stopped
  // being text.
  ["--muted-2", "--canvas"],
  ["--muted-2", "--paper"],
  ["--muted-2", "--surface-card"],

  // Controls: the secondary button, the topbar links, the icon buttons.
  ["--control-fg", "--paper"],
  ["--control-fg", "--canvas"],
  ["--control-fg", "--surface-card"],
  ["--control-fg-strong", "--surface-hover"],

  // Table headers, on the header fill they actually sit on.
  ["--table-head-fg", "--surface-head"],
  ["--table-head-fg", "--canvas"],
  ["--table-head-fg", "--paper"],

  // The accent, used as text: eyebrow chips, panel footers, hover states.
  ["--accent-fg", "--paper"],
  ["--accent-fg", "--canvas"],
  ["--accent-fg", "--surface-card"],

  // Tint pairs. Each wash and the ink that goes on it — the halves that were
  // tuned independently and failed in both themes at once.
  ["--teal-700", "--teal-100"],
  ["--teal-600", "--teal-100"],
  ["--red-600", "--red-100"],
  ["--amber-600", "--amber-100"],
  ["--green-700", "--green-100"],
  ["--orange-600", "--orange-100"],
  ["--blue-600", "--blue-100"],

  // The same inks used as bare text on a page or a card, which is how the
  // audit-log chips and the insight flags render them.
  ["--red-600", "--canvas"],
  ["--red-600", "--paper"],
  ["--amber-600", "--canvas"],
  ["--amber-600", "--paper"],
  ["--green-700", "--paper"],
  ["--teal-600", "--canvas"],
  ["--teal-600", "--paper"],
  ["--blue-600", "--canvas"],
  ["--blue-600", "--paper"],

  // Brand fills carry their own foreground and are identical in both themes.
  ["--on-brand-bright", "--brand-bright"],
  ["--on-brand-solid", "--brand-solid"],
  ["--on-danger-solid", "--danger-solid"],

  // The neutral chip: the board's empty cell and the timeline pill.
  ["--chip-neutral-fg", "--chip-neutral-bg"],

  /*
   * THE NAVIGATION RAIL, checked in both themes on purpose.
   *
   * The owner asked for the menu to stay dark whatever the theme, so these
   * tokens are declared once on the bare `:root` and never restated. Running
   * them through both themes is what proves that: if somebody later adds a
   * light `--rail-bg` without moving the foregrounds with it, the pass that
   * used to be free starts failing here instead of on a screenshot.
   */
  ["--rail-fg", "--rail-bg"],
  ["--rail-fg", "--rail-bg-raised"],
  ["--rail-fg-muted", "--rail-bg"],
  ["--rail-fg-muted", "--rail-selected-bg"],
  ["--rail-fg-faint", "--rail-bg"],
  ["--rail-accent", "--rail-bg"],
  ["--rail-accent", "--rail-control-bg"],
  ["--rail-active-fg", "--rail-active-bg"],
  ["--rail-count-fg", "--rail-count-bg"],
];

for (const theme of ["light", "dark"]) {
  test(`every text token pair clears AA in ${theme}`, () => {
    const failures = [];
    for (const [fg, bg] of PAIRS) {
      const foreground = resolve(fg, theme, palettes);
      const background = resolve(bg, theme, palettes);
      const ratio = contrastRatio(foreground, background);
      if (ratio < AA) {
        failures.push(
          `${fg} (${foreground}) on ${bg} (${background}) = ${ratio.toFixed(2)}:1`,
        );
      }
    }
    assert.deepEqual(
      failures,
      [],
      `${failures.length} token pair(s) below ${AA}:1 in ${theme}:\n  ${failures.join("\n  ")}`,
    );
  });
}

/* ------------------------------------------------------------------ */
/* The trap the house style names                                      */
/* ------------------------------------------------------------------ */

test("no token exists only in the dark block", () => {
  /*
   * A colour whose ONLY definition lives inside a `[data-theme]` block applies
   * in one state and silently vanishes in the other. That is how the sidebar's
   * real ground came to exist only in dark, and how the light skin ended up
   * repainting card text whose card background it never repainted.
   */
  const orphans = [...palettes.dark.keys()].filter(
    (name) => !palettes.light.has(name),
  );
  assert.deepEqual(
    orphans,
    [],
    `these tokens are declared only in the dark block, so they are undefined in light: ${orphans.join(", ")}`,
  );
});

test("the rail keeps one always-dark definition", () => {
  // Subtraction, not an override: the rail is chrome and stays dark in both
  // themes, so a `--rail-*` token restated per theme means somebody has started
  // fighting the theme again.
  const restated = [...palettes.dark.keys()].filter((name) =>
    name.startsWith("--rail-"),
  );
  assert.deepEqual(
    restated,
    [],
    `--rail-* must be declared once on :root; the dark block restates: ${restated.join(", ")}`,
  );
});

/* ------------------------------------------------------------------ */
/* Chips, whose ground is data rather than design                      */
/* ------------------------------------------------------------------ */

test("every board colour gets a legible chip label", async () => {
  /*
   * Status, priority and label chips are painted from the colour stored on the
   * option row — monday's palette. The ground cannot follow a theme and should
   * not; the label on it must still be readable. `chipInk` decides that at
   * render time, and this walks the whole seed palette through it so a colour
   * added to the board cannot ship an unreadable label.
   *
   * The colours come out of the seed spec rather than a list here, for the
   * same reason the tokens are parsed: a copy would stop tracking the thing it
   * is copying.
   */
  const spec = await read("db/monday-board-spec.ts");
  const colours = [...new Set(spec.match(/#[0-9a-fA-F]{6}/g) ?? [])];
  assert.ok(colours.length > 20, "the seed spec should carry the board palette");

  const failures = [];
  for (const colour of colours) {
    const ink = chipInk(colour, "#ffffff");
    const ratio = contrastRatio(ink, colour);
    if (ratio < AA) failures.push(`${colour} -> ${ink} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(
    failures,
    [],
    `chip labels below ${AA}:1:\n  ${failures.join("\n  ")}`,
  );
});

test("chipInk keeps a stored label colour that already works", () => {
  // The point is not to repaint every chip. monday stores dark ink on its pale
  // yellows and an admin can pick their own; a legible choice is left alone.
  assert.equal(chipInk("#ffcb00", "#101820"), "#101820");
  assert.equal(chipInk("#225091", "#ffffff"), "#ffffff");
  // ...and a failing one is replaced rather than trusted.
  assert.notEqual(chipInk("#fdab3d", "#ffffff"), "#ffffff");
  assert.ok(contrastRatio(chipInk("#00c875", "#ffffff"), "#00c875") >= AA);
});

/* ------------------------------------------------------------------ */
/* The literals that cannot follow a theme                             */
/* ------------------------------------------------------------------ */

test("the command-centre block paints through tokens in both stylesheets", async () => {
  /*
   * This block is duplicated verbatim in globals.css and brand-overrides.css,
   * and the second file loads last, so a fix applied to one of them alone did
   * nothing. Both copies now go through tokens; this fails if a raw colour
   * comes back to the rules that were the largest single cause of the light
   * failures.
   */
  const brand = await read("app/brand-overrides.css");
  const RULES = [
    /\.data-table th\s*\{[^}]*\}/,
    /\.secondary-button,\s*\n?\.topbar-link,\s*\n?\.icon-button\s*\{[^}]*\}/,
  ];
  for (const [name, sheet] of [
    ["globals.css", css],
    ["brand-overrides.css", brand],
  ]) {
    for (const rule of RULES) {
      const match = sheet.match(rule);
      if (!match) continue;
      assert.doesNotMatch(
        match[0],
        /#[0-9a-fA-F]{3,8}/,
        `${name}: ${match[0].split("\n")[0]} must colour through tokens, not a literal`,
      );
    }
  }
});

test("the board's chip colours come from the theme, not from JSX", async () => {
  /*
   * The empty cell was one hard-coded pair — 2,229 nodes, identical in both
   * themes and failing in both.
   *
   * Asked of the CODE, not of the prose: the comment that replaced those
   * literals names them, to explain what the tokens are for, and a match over
   * the raw file would read that explanation as the defect and fail for
   * documenting the fix.
   */
  const stripped = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const file of [
    "app/(app)/portal/live-board.tsx",
    "app/(app)/portal/board-cells.tsx",
  ]) {
    assert.doesNotMatch(
      stripped(await read(file)),
      /#8a979f|#eef1f3/,
      `${file} must take its empty-chip colours from --chip-neutral-*`,
    );
  }
});
