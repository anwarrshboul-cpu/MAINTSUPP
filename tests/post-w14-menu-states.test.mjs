/**
 * POST-W14 — the three board menus and the states their triggers can be in.
 *
 * The group menu's white square was fixed first. The same audit then found the
 * column header's trigger had a worse version of the same fault and the row
 * menu's a quieter one, so this file pins the shape all three now share rather
 * than any one of their colours:
 *
 *   · the OPEN state is selected by `aria-expanded`, the attribute the button
 *     already sets for assistive technology, so the paint and the accessibility
 *     tree cannot disagree;
 *   · hover-only paint sits behind `@media (hover: hover)`, because a tap
 *     leaves `:hover` on an element until the reader taps elsewhere;
 *   · a painted state is never selected by bare `:focus`, which fires for a
 *     mouse press too and leaves a block behind after a click;
 *   · the keyboard ring is the tuned global one and no control restates it.
 *
 * The column header's open state deserves its own sentence. It was written as
 * `.custom-column-header:has(.custom-column-menu)`, and `AnchoredPopover`
 * portals that menu into `#maintsupp-layers` — so the selector could never
 * match, at any width, in either theme. Measured in Chrome before the change:
 * `aria-expanded` true, background `rgba(0, 0, 0, 0)`, opacity 0.45. The rule
 * had been dead since the popover moved to the shared layer.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/* globals.css is CRLF in this repo and there is no .gitattributes. Every
   pattern below is written with bare newlines, so normalise on the way in. */
const load = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* CSS has block comments only, and a comment that NAMES what was removed is the
   point of the comment. Every absence check below runs against the code. */
const cssCode = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

const GLOBALS = "app/globals.css";
const COLUMN = "app/(app)/portal/board-column-header.tsx";
const BOARD = "app/(app)/portal/live-board.tsx";

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** True when `selector` sits inside an `@media (hover: hover)` block. */
function insideHoverGuard(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return false;
  const before = css.slice(0, at);
  const guard = before.lastIndexOf("@media (hover: hover) {");
  if (guard < 0) return false;
  /* Nothing may have closed that block between it and the selector. */
  return before.indexOf("}", guard) < 0 || before.indexOf("}", guard) > before.lastIndexOf("{");
}

const noLiteralColour = (body, what) => {
  assert.doesNotMatch(
    body,
    /(?:^|\n)\s*(?:color|background)\s*:\s*(?:#[0-9a-fA-F]{3,8}|white|black)\s*;/,
    `${what} paints a literal colour, which has one value for two themes`,
  );
};

/* ------------------------------------------------------- A. the open state */

test("A: the column trigger's open state is a themed state, not a light literal", async () => {
  const css = await load(GLOBALS);

  const open = rule(
    css,
    '.custom-column-header > .custom-column-header__more:focus-visible,\n' +
      '.custom-column-header > .custom-column-header__more:active,\n' +
      '.custom-column-header > .custom-column-header__more[aria-expanded="true"]',
  );
  assert.ok(
    open,
    "pressed, focused-by-keyboard and open share one rule on this trigger, keyed off the attribute the button already sets",
  );
  assert.match(open, /background: var\(--surface-active\)/);
  assert.match(open, /color: var\(--control-fg-strong\)/);
  noLiteralColour(open, "the column trigger's open state");

  assert.doesNotMatch(
    css,
    /\.custom-column-header:has\(\.custom-column-menu\)[\s\S]{0,120}background/,
    "and it is NOT selected by :has(.custom-column-menu) — AnchoredPopover portals the menu out of the header, so that selector matched nothing in either theme and the trigger looked identical open and closed",
  );
});

test("A: its colours come from one place, so the dark block has nothing to add", async () => {
  const css = await load(GLOBALS);

  const base = rule(css, ".custom-column-header > .custom-column-header__more");
  assert.ok(base, "the trigger still has a base rule");
  noLiteralColour(base, "the column trigger");

  /*
   * The dark literals lived in one shared rule with two other controls, so the
   * check is on that rule's selector list rather than on a slice of the file:
   * `body[data-theme="dark"] {` opens the token block near the top as well, and
   * slicing from the first one reads the whole stylesheet.
   */
  // The approved colour system moved this rule's #243641 / #79bfff to
  // var(--surface-hover) / var(--accent-fg); the pair is still unique to it.
  const shared = css.indexOf("background: var(--surface-hover);\n    color: var(--accent-fg);");
  assert.ok(shared > 0, "the shared dark hover rule is still there for the controls that still need it");
  const selectors = css.slice(css.lastIndexOf("\n\n", shared), shared);
  assert.match(selectors, /\.sheet-row-more:hover/, "the row trigger still uses it");
  assert.match(selectors, /\.sheet-open-item:hover/, "and so does the open-item button");
  assert.doesNotMatch(
    cssCode(selectors),
    /custom-column-header/,
    "but the column trigger must not: it paints from --surface-hover and --surface-active, which are already per-theme, so a dark rule for it would be a third opinion about one colour",
  );
});

/* ------------------------------------------------------------- B. hover */

test("B: hover paint is restricted to devices that really hover", async () => {
  const css = await load(GLOBALS);

  assert.ok(
    insideHoverGuard(css, ".custom-column-header:hover > .custom-column-header__more"),
    "the column trigger's hover must sit inside @media (hover: hover): a tap leaves :hover on the element until the reader taps something else, which is the whole time the menu is open",
  );
  assert.ok(
    insideHoverGuard(css, ".sheet-group__more:hover"),
    "the group trigger's hover, fixed in the previous pass, must stay guarded",
  );

  const touch = rule(css, ".custom-column-header > .custom-column-header__more");
  assert.ok(touch);
  assert.match(
    css,
    /@media \(hover: none\) \{\n\s*\.custom-column-header > \.custom-column-header__more \{\n\s*opacity: 0\.55;/,
    "and a finger, which cannot hover at all, still gets to see the trigger — the same fallback the sort arrow twenty lines below already takes",
  );
});

/* ------------------------------------------------------------- C. focus */

test("C: the keyboard keeps its indication, and the mouse stops leaving blocks", async () => {
  const css = await load(GLOBALS);

  assert.match(
    css,
    // The approved colour system gave focus its own token, --focus-ring
    // (#20d8c6 dark, #009b8c light — the spec's bright turquoise, darkened in
    // light to keep 3:1 on white). Same global ring, same 3px width, new colour.
    /\n:focus-visible \{\n\s*outline: 3px solid var\(--focus-ring\);/,
    "the tuned global ring is still there",
  );
  for (const control of [
    ".custom-column-header__more",
    ".sheet-group__more",
    ".sheet-row-more",
  ]) {
    assert.doesNotMatch(
      css,
      new RegExp(`\\${control}:focus-visible \\{\\s*outline`),
      `${control} must not restate the global ring — a local copy drifts from the tuned one`,
    );
  }

  assert.doesNotMatch(
    css,
    /\.custom-column-header > \.custom-column-header__more:focus[,\s{]/,
    "a painted state selected by bare :focus fires for a mouse press too, and leaves a block behind after the click that opened the menu. :focus-visible is the half a keyboard user needs.",
  );
  assert.match(
    css,
    /\.custom-column-header > \.custom-column-header__more:focus-visible/,
    "and a keyboard user must still see the trigger change when it is focused",
  );
});

/* ------------------------------------------------------------- D. parity */

test("D: all three board menus report open the same way", async () => {
  const css = await load(GLOBALS);

  for (const [selector, where] of [
    ['.sheet-group__more[aria-expanded="true"]', "the group menu"],
    ['.custom-column-header__more[aria-expanded="true"]', "the column menu"],
    ['.sheet-row-more[aria-expanded="true"]', "the row menu"],
  ]) {
    assert.ok(
      css.includes(selector),
      `${where}'s trigger must paint its open state from aria-expanded, so main and custom tables behave alike`,
    );
  }

  /* And the attribute is really set, in the component that draws each one. */
  const column = codeOnly(await load(COLUMN));
  assert.match(
    column,
    /aria-expanded=\{menuOpen\}/,
    "the column trigger's attribute follows the real menu state",
  );
  const board = codeOnly(await load(BOARD));
  assert.match(board, /aria-expanded=\{groupMenuId === group\.id\}/);
  assert.match(
    board,
    /aria-expanded=\{menuOpen\}/,
    "and so does the row trigger's",
  );
});

test("D: the row menu's open state outranks its own hover", async () => {
  const css = await load(GLOBALS);
  const hover = css.indexOf(".sheet-row-more:hover {");
  assert.ok(hover > 0, "the hover rule is still there");

  /*
   * The attribute selector appears twice — once as the last name in the
   * opacity rule above, once on the rule that paints. It is the PAINTING one
   * that has to come last, so find the occurrence whose body sets a background.
   */
  const paints = [...css.matchAll(/\.sheet-row-more\[aria-expanded="true"\] \{([^}]*)\}/g)].filter(
    (m) => /background:/.test(m[1]),
  );
  assert.equal(paints.length, 1, "exactly one rule paints the row trigger's open state");
  assert.match(paints[0][1], /background: var\(--surface-active\)/);
  assert.ok(
    paints[0].index > hover,
    "they have equal specificity, so source order decides. With the open rule first, resting the pointer on an open trigger repainted it as merely hovered.",
  );
});
