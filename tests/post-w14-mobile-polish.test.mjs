/**
 * POST-W14 MOBILE POLISH — the phone board's header row and the group menu.
 *
 * Two reported defects, both photographed on a phone:
 *
 *   1. The one sticky column-header row did not line up with the columns it
 *      was heading. Every heading sat a few pixels left of its data.
 *   2. Opening a group's actions menu left a white square where the 3-dots
 *      button is, on a dark board.
 *
 * Neither was a mistake in the code that drew them. Both were a SECOND COPY of
 * something: the gutter's width, written once in CSS and again in TypeScript,
 * with only one of the two copies moved when the phone widened it; and the
 * light theme's hover colours, written as literals with no dark counterpart,
 * on a state a touchscreen cannot clear. The assertions below pin the absence
 * of the second copy, because that is what actually failed.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Line endings are per file in this repo and globals.css is CRLF. Every
   pattern below is written against \n, so normalise on the way in. */
const load = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/* A comment may name the literal it replaced; that is what the comment is
   for. Only the code is under test. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GLOBALS = "app/globals.css";
const HEADER = "app/(app)/portal/board-mobile-header.tsx";
const BOARD = "app/(app)/portal/live-board.tsx";

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** Every `@media (max-width: 760px)` block in the file, brace-matched. */
function phoneBlocks(css) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf("@media (max-width: 760px)", from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && (depth -= 1) === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i;
  }
  return out.join("\n");
}

/* ------------------------------------------------- A. one sizing source */

test("A: the sticky header and the body rows read one width, not two copies", async () => {
  const css = await load(GLOBALS);
  const sheet = rule(css, ".live-sheet");
  assert.ok(sheet, ".live-sheet is still the grid's base rule");
  assert.match(
    sheet,
    /--sheet-select-width:\s*\d+px/,
    "the select-all gutter's width is declared on the table every consumer sits inside",
  );
  assert.match(
    sheet,
    /--sheet-add-column-width:\s*\d+px/,
    'the trailing "+" cell likewise',
  );

  for (const selector of [".sheet-check", ".board-mobile-head__gutter"]) {
    const cell = rule(css, selector);
    assert.ok(cell, selector + " still has a width rule");
    for (const property of ["width", "min-width", "max-width"]) {
      assert.match(
        cell,
        new RegExp("\\n\\s*" + property + ": var\\(--sheet-select-width\\);"),
        `${selector} must take its ${property} from the token. A literal here is the defect: the body cell and the sticky header cell are two tables drawing ONE column, and only one of the two literals moved when the phone went to 42px.`,
      );
    }
  }

  const add = rule(css, ".sheet-add-column,\n.sheet-add-column-spacer");
  assert.ok(add, "the header cell and its body spacer are still sized together");
  assert.match(add, /width: var\(--sheet-add-column-width\)/);

  const spacer = rule(css, ".board-mobile-head__spacer");
  assert.ok(spacer, "the sticky row's trailing spacer is sized too");
  assert.match(
    spacer,
    /width: var\(--sheet-add-column-width\)/,
    "the last real column can only scroll fully into view if this cell is as wide as the one it stands in for",
  );
});

test("A: a colgroup is not enough — the cells have to agree as well", async () => {
  const header = codeOnly(await load(HEADER));

  assert.match(
    header,
    /const width = displayedBoardColumnWidth\(entry\.column, mobile\);/,
    "each heading reads its width from the same call the body cell under it reads",
  );
  assert.match(
    header,
    /width,\s*\n\s*minWidth: width,\s*\n\s*maxWidth: width,/,
    "and states all three, exactly as live-board.tsx does on the cell beneath. A fixed table stretched past the sum of its columns by `min-width: 100%` shares the slack out, and it shares it according to what the CELLS say: with one row's cells pinned by an inline trio and the other's free, the two tables spent the same slack in different places and the headings drifted along the row.",
  );

  const css = await load(GLOBALS);
  assert.doesNotMatch(
    css,
    /\.board-mobile-head th \{[^}]*min-width: 0/,
    "and the cells are NOT freed instead — measured at 390px, min-width:0 with max-width:none handed one column the entire slack, which was worse than the floor it removed",
  );
});

test("A: the colgroup carries no width of its own", async () => {
  const header = codeOnly(await load(HEADER));

  assert.doesNotMatch(
    header,
    /const (?:GUTTER_WIDTH|ADD_COLUMN_WIDTH) = \d/,
    "a width written as a number in this file is a second copy of a stylesheet value, and the copy is the one that drifted",
  );
  assert.match(
    header,
    /const GUTTER_WIDTH = "var\(--sheet-select-width\)"/,
    "the colgroup resolves the gutter against the table it is in, at whatever width the media query settled on",
  );
  assert.match(
    header,
    /const ADD_COLUMN_WIDTH = "var\(--sheet-add-column-width\)"/,
  );
  assert.match(
    header,
    /displayedBoardColumnWidth\(entry\.column, mobile\)/,
    "the data columns keep the one width rule they already had",
  );
});

/* ------------------------------------------- B. the phone moves the token */

test("B: widening the gutter for a touch target moves both tables", async () => {
  const phone = phoneBlocks(await load(GLOBALS));

  assert.match(
    phone,
    /\.live-sheet \{\n\s*--sheet-select-width: 42px;/,
    "the phone's 42px gutter is said as the token",
  );
  assert.doesNotMatch(
    phone,
    /\.sheet-check \{\n\s*width: \d+px;/,
    "and NOT as a literal on the cell: that is what the colgroup could not see, and it is why every heading sat 4px to the left of its column",
  );
});

test("B: the header table stretches on the same terms as the tables under it", async () => {
  const css = await load(GLOBALS);
  const sheet = rule(css, ".live-sheet");
  assert.match(sheet, /min-width: 100%/, "a group table fills the canvas");

  const grid = rule(css, ".board-mobile-head__grid");
  assert.ok(grid, "the header table still has its own rule");
  assert.match(
    grid,
    /min-width: 100%/,
    "so must the header table. With `min-width: 0` a board narrower than the phone left the group tables sharing the slack out across their columns while the header row did not grow at all.",
  );
});

test("B: the header row still names the group it is standing over", async () => {
  const header = codeOnly(await load(HEADER));
  assert.match(
    header,
    /naming \? current\.name : entry\.column\.title/,
    "the current-group label is the reason this row exists; an alignment fix must not cost it",
  );
  assert.match(header, /"sheet-column--name board-mobile-head__group"/);
});

/* ------------------------------------ C. the group menu's white square */

test("C: the 3-dots button paints from themed tokens, in both themes", async () => {
  const css = await load(GLOBALS);
  const button = rule(css, ".sheet-group__more");
  assert.ok(button, "the button still has its rule");

  assert.doesNotMatch(
    button,
    /(?:color|background)\s*:\s*#[0-9a-fA-F]{3,8}\s*;/,
    "a literal colour has one value for two themes. The dark board had no rule of its own anywhere in this file, which is the whole defect.",
  );
  assert.match(
    button,
    /--control-own-fg: var\(--control-fg\)/,
    "and it opts out of the dark `.portal-main button` blanket the way every other board control does, rather than racing it",
  );
  assert.match(button, /color: var\(--control-fg\)/);
});

test("C: no hover state a touchscreen cannot take back off", async () => {
  const css = await load(GLOBALS);

  for (const selector of [
    ".sheet-group__more:hover",
    ".sheet-group__rename:hover",
  ]) {
    const at = css.indexOf(selector + " {");
    assert.ok(at > 0, selector + " still exists — a pointer should still get feedback");
    const before = css.slice(0, at);
    const guard = before.lastIndexOf("@media (hover: hover) {");
    assert.ok(
      guard > 0 && before.indexOf("}", guard) < 0,
      `${selector} must sit inside @media (hover: hover). A tap leaves :hover on the element until the reader taps something else — which is exactly as long as the menu is open, and is the white square in the report.`,
    );
    assert.doesNotMatch(
      rule(css, selector),
      /#[0-9a-fA-F]{3,8}\s*;/,
      selector + " still paints a literal",
    );
  }
});

test("C: the open menu has a state, and it is the attribute the button already sets", async () => {
  const css = await load(GLOBALS);
  const open = rule(
    css,
    '.sheet-group__more:active,\n.sheet-group__more[aria-expanded="true"]',
  );
  assert.ok(
    open,
    "pressed and open share one rule: while the menu is up the handle should read as held down, not as hovered",
  );
  assert.match(open, /background: var\(--surface-active\)/);
  assert.match(open, /color: var\(--control-fg-strong\)/);

  const board = codeOnly(await load(BOARD));
  assert.match(
    board,
    /aria-expanded=\{groupMenuId === group\.id\}/,
    "the CSS reads the same attribute assistive technology does, so there is no second opinion about whether the menu is open",
  );
});

test("C: the keyboard ring is the global one, not a local copy of it", async () => {
  const css = await load(GLOBALS);
  assert.match(
    css,
    // The approved colour system gave focus its own token, --focus-ring
    // (#20d8c6 dark, #009b8c light — the spec's bright turquoise, darkened in
    // light to keep 3:1 on white). Same global ring, same 3px width, new colour.
    /\n:focus-visible \{\n\s*outline: 3px solid var\(--focus-ring\);/,
    "the tuned, themed ring is still there",
  );
  assert.doesNotMatch(
    css,
    /\.sheet-group__more:focus-visible/,
    "and this button does not restate it. A local ring is a worse copy that drifts; removing the white square must not cost 2.4.7.",
  );
  assert.doesNotMatch(
    css,
    /\.sheet-group__more:focus \{/,
    "a plain :focus rule would paint on a tap and bring the square straight back",
  );
});
