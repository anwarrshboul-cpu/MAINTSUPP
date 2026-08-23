/**
 * UI batch — "+ Add column".
 *
 * The owner reported the board as having no way to add a column. It had one:
 * a `<th class="sheet-add-column">` after the last header, wired to the same
 * `ColumnPicker` the column menu opens. Two things hid it.
 *
 *   1. It was a bare 34px transparent "+" in a 48px cell. A lone glyph at the
 *      far right of a board that scrolls is not an entry point anybody finds.
 *
 *   2. On a desktop it was not reachable AT ALL. `.live-sheet` is pushed 34px
 *      to the right by the row gutter, but `.sheet-group` and
 *      `.live-board-canvas` both size to `max-content`, which does not count
 *      that margin — so the table overhung its own scroll container by exactly
 *      34px, and the thing sitting in those 34px was this cell. Scrolled fully
 *      right it landed past the scroller's edge: about 7px of the button
 *      visible, `document.elementFromPoint` at its centre returning the page
 *      behind it, and Playwright timing out on a click. That is the defect the
 *      report described.
 *
 * The fix is the gutter given back to the group as padding, plus a labelled,
 * outlined affordance in a cell wide enough to hold it. The label comes from
 * CSS: the button already exposes the same string as its accessible name, so
 * a reader hears no change and live-board.tsx keeps its line budget.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const GLOBALS = "app/globals.css";
const BOARD = "app/(app)/portal/live-board.tsx";
const PICKER = "app/(app)/portal/board-column-picker.tsx";

/** The body of the first rule whose selector list matches `selector`. */
function rule(css, selector) {
  const needle = new RegExp(
    `(^|[},;/*\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`,
  );
  const hit = needle.exec(css);
  if (!hit) return null;
  const open = css.indexOf("{", hit.index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** Every `@media (max-width: 760px)` block, brace-matched and joined. */
function phoneBlocks(css) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf("@media (max-width: 760px)", from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    let depth = 0;
    let index = open;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(open + 1, index));
    from = index;
  }
  return out.join("\n");
}

const px = (body, property) => {
  const hit = new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;]+);`).exec(body);
  return hit ? hit[1].trim() : null;
};

test("the group gives back the 34px gutter the table borrows from it", async () => {
  const css = await read(GLOBALS);

  // The two numbers are a pair; if one moves the other has to.
  const sheet = rule(css, ".live-sheet");
  assert.ok(sheet !== null);
  const gutter = /\.live-sheet \{\s*margin-left: (\d+)px;/.exec(css);
  assert.ok(gutter, "the desktop row gutter is still stated as .live-sheet { margin-left: … }");

  const group = rule(css, ".sheet-group");
  assert.equal(
    px(group, "padding-right"),
    `${gutter[1]}px`,
    "the group must pad its right edge by the same gutter the table is pushed by, " +
      "or the last cell — the add-column cell — hangs past the scroller and cannot be clicked",
  );

  // A phone has no gutter, so it needs no compensation.
  const phone = phoneBlocks(css);
  assert.match(phone, /\.sheet-group \{\s*padding-right: 0;/);
});

test("the add-column cell is wide enough for a label, and carries one", async () => {
  const css = await read(GLOBALS);
  const cell = rule(css, ".sheet-add-column,\n.sheet-add-column-spacer");
  assert.ok(cell, "the header cell and its body spacer are still sized together");

  const width = Number.parseInt(px(cell, "width"), 10);
  assert.ok(
    width >= 120,
    `the add-column cell is ${width}px. It was 48px — icon-only — which is why nobody found it.`,
  );
  assert.equal(px(cell, "min-width"), px(cell, "width"));
  assert.equal(px(cell, "max-width"), px(cell, "width"));

  const button = rule(css, ".sheet-add-column > button");
  assert.ok(button);
  const label = rule(css, ".sheet-add-column > button::after");
  assert.ok(label, "the button draws its own label");
  assert.match(
    px(label, "content"),
    /^"Add column"$/,
    "the visible label must read the same as the button's accessible name",
  );
});

test("the control looks like a control in both themes", async () => {
  const css = await read(GLOBALS);
  const button = rule(css, ".sheet-add-column > button");

  assert.notEqual(
    px(button, "background"),
    "transparent",
    "a transparent glyph is what the owner could not see",
  );
  assert.match(px(button, "border"), /^1px dashed /, "the outline is what reads as 'add something here'");
  assert.ok(Number.parseInt(px(button, "border-radius"), 10) > 0);
  assert.ok(px(button, "font-size"), "the label needs a size of its own, not the cell's 8px heading type");
  assert.equal(px(button, "white-space"), "nowrap", "the label must not wrap inside its cell");

  // Dark theme is a first-class case, not an afterthought: the light chip on a
  // dark board was invisible until this rule existed.
  // The board's dark rules live in the LAST `body[data-theme="dark"]` block —
  // the native-nesting one near the end of the file, not the palette at the top.
  const dark = css.slice(css.lastIndexOf('body[data-theme="dark"] {'));
  const darkButton = rule(dark, ".sheet-add-column > button");
  assert.ok(darkButton, "the dark board restates the affordance in its own tones");
  assert.ok(px(darkButton, "background"));
  assert.ok(px(darkButton, "color"));
  assert.ok(px(darkButton, "border-color"));
});

test("it stays after the last column, never pinned over the data", async () => {
  const board = await read(BOARD);
  const css = await read(GLOBALS);

  // Rendered after the column loop closes, still inside the header row.
  const at = board.indexOf('<th className="sheet-add-column"');
  assert.ok(at > 0, "the cell is still the last <th> of the header row");
  assert.ok(
    board.lastIndexOf("})}", at) > board.lastIndexOf("{visibleGroupColumns", at) ||
      board.slice(at - 400, at).includes("})}"),
    "the cell comes after the mapped columns, not before them",
  );
  assert.match(board.slice(at, at + 260), /aria-label="Add column"/);

  // Only the header row's own vertical stickiness applies. Nothing here pins
  // the cell horizontally over the rows.
  const cell = rule(css, ".sheet-add-column,\n.sheet-add-column-spacer");
  assert.equal(px(cell, "position"), "relative", "the cell anchors the picker; the th rule handles top: 0");
  assert.equal(px(cell, "left"), null, "the add-column cell is never pinned to the left");
  assert.equal(px(cell, "right"), null, "the add-column cell is never pinned to the right");
});

test("it opens the picker the board already has — there is no second one", async () => {
  const board = await read(BOARD);
  const picker = await read(PICKER);

  // One creation path: the picker's onChoose, on both layouts.
  assert.equal(
    (board.match(/action: "create_column"/g) || []).length,
    1,
    "a column is created in exactly one place",
  );
  assert.ok(
    (board.match(/onChoose=\{createCustomColumn\}/g) || []).length >= 2,
    "the inline picker and the phone's portal both call the same creator",
  );
  assert.ok(picker.includes("export function ColumnPicker("), "there is one ColumnPicker component");

  // The button toggles the SAME state the column menu's "add column after"
  // uses, which is what routes the phone to the portalled picker.
  const th = board.slice(board.indexOf('<th className="sheet-add-column"'));
  assert.match(th.slice(0, 700), /openColumnPickerAfter\(group\.id, null\)/);
  assert.match(th.slice(0, 1400), /columnPickerGroupId === group\.id && !isMobile/);
  assert.match(
    board,
    /\{isMobile &&\s*\n\s*columnPickerGroupId &&\s*\n\s*createPortal\(/,
    "on a phone the same state opens the full-width picker instead",
  );
});
