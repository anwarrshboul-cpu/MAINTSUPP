import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const CSS = "app/(app)/portal/board-visibility.css";
const MODULE = "app/(app)/portal/board-visibility.ts";
const BOARD = "app/(app)/portal/live-board.tsx";
const GLOBALS = "app/globals.css";

/**
 * The board draws 745 rows across 38 groups and 101,516 elements, and measured
 * in Chrome the browser spent 2,285ms recalculating style and 777ms in layout
 * before the board appeared — 55% of the total, none of it React. Off-screen
 * groups are skipped with `content-visibility: auto` so that work is only done
 * for what is on screen.
 */
test("expanded groups are skipped while off screen", async () => {
  const css = await read(CSS);
  const rule = css.slice(css.indexOf(".sheet-group.is-deferred {"));
  assert.match(rule.slice(0, 600), /content-visibility: auto/);

  const board = await read(BOARD);
  assert.match(board, /DEFERRED_GROUP_CLASS/, "the board must opt groups in");
  assert.match(
    board,
    /isCollapsed \? "" : ` \$\{DEFERRED_GROUP_CLASS\}`/,
    "a collapsed group has no table to skip, and the height formula would be wrong for it",
  );
});

/**
 * A skipped group still has to occupy the right space or the scrollbar lies and
 * the page jumps as groups render — the failure mode that makes bad windowing
 * worse than none. The height is computed rather than estimated, and this ties
 * the constants to the stylesheet they were measured from, so a change to the
 * row height breaks this test instead of silently mis-sizing the scroll.
 */
test("the intrinsic height is derived from the real row geometry", async () => {
  const css = await read(CSS);
  assert.match(css, /contain-intrinsic-height: auto var\(--group-height/);

  const source = await read(MODULE);
  const constant = (name) => {
    const found = source.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(found, `${name} must be a plain number this test can check`);
    return Number(found[1]);
  };

  const globals = await read(GLOBALS);
  /*
   * The last TOP-LEVEL block for the selector that sets a height — top-level
   * because the same selector reappears indented inside `@media (max-width:
   * 760px)`, where the grid is replaced by the card list and the heights do not
   * apply, and last because the desktop grid's sizes are a later override of
   * the original Stage 3 block.
   */
  const heightIn = (selector) => {
    const blocks = globals.split(`\n${selector}`).slice(1);
    assert.ok(blocks.length, `${selector} must exist at the top level of globals.css`);
    const heights = blocks
      .map((block) => block.slice(0, block.indexOf("}")).match(/height: (\d+)px/))
      .filter(Boolean)
      .map((found) => Number(found[1]));
    assert.ok(heights.length, `${selector} must set a fixed height`);
    return heights[heights.length - 1];
  };

  // Every cell has a fixed height and the table is `table-layout: fixed`, which
  // is why no row can be a different height from any other.
  assert.match(globals, /table-layout: fixed/);
  assert.equal(constant("ROW_HEIGHT"), heightIn(".live-sheet th,\n.live-sheet td {"));
  assert.equal(constant("ADD_ROW_HEIGHT"), constant("ROW_HEIGHT"));
  assert.equal(constant("COLUMN_HEADER_HEIGHT"), heightIn(".live-sheet th {"));
  assert.equal(constant("GROUP_HEADER_HEIGHT"), heightIn(".sheet-group__header {"));

  // Measured in Chrome across all 38 groups, the residual against this formula
  // was exactly 0 with no spread: 43 + 38 + rows * 40 + 40.
  const chrome = 43 + 38 + 40;
  assert.equal(constant("GROUP_HEADER_HEIGHT") + constant("COLUMN_HEADER_HEIGHT") + constant("ADD_ROW_HEIGHT"), chrome);
});

/**
 * `content-visibility: auto` also applies `contain: layout style paint` while
 * the group is on screen. Paint containment clips to the group's box and makes
 * it a containing block for `position: fixed` children, so any popover that can
 * paint outside its group must cancel it — a status dropdown on a group's last
 * row overflows by 211px and a row menu by 331px, both measured.
 *
 * This is the test that matters when somebody adds a twelfth popover: it fails
 * unless the new one is either listed or provably cannot escape its group.
 */
test("every popover that can escape its group cancels the containment", async () => {
  const css = await read(CSS);
  const escape = css.slice(css.indexOf(".sheet-group.is-deferred:has("));
  assert.match(escape, /content-visibility: visible/);

  const globals = await read(GLOBALS);

  /*
   * Every class inside a group that is absolutely or fixed positioned. Read out
   * of globals.css rather than listed here, so a new one shows up on its own.
   * The exclusions are the elements that provably stay inside the group's box:
   * `sheet-row-more` sits in the 34px gutter the table's own margin leaves,
   * `sheet-check::before` and `sheet-custom-checkbox input` are cell
   * decorations, and `mobile-cell-sheet` is portalled to document.body.
   */
  const INSIDE_THE_GROUP = [
    "sheet-row-more",
    "sheet-check::before",
    "sheet-custom-checkbox input",
    "column-resize-handle",
    "custom-column-header > strong",
    "sheet-update-icon > small",
  ];

  const positioned = new Set();
  let selector = null;
  for (const line of globals.split("\n")) {
    // Indented selectors inside @media reset it too, or their declarations get
    // credited to whichever top-level rule came last.
    if (/^\s*\.[a-z][\w-]*/.test(line) && line.includes("{")) {
      selector = line.replace(/[{,].*$/, "").trim();
    }
    if (/position: (absolute|fixed);/.test(line) && selector) {
      if (/^\.(sheet|custom-column|column)-/.test(selector)) positioned.add(selector.slice(1));
    }
  }

  const missing = [...positioned].filter((name) => {
    if (INSIDE_THE_GROUP.some((skip) => name.startsWith(skip))) return false;
    if (name.includes("__")) return false; // a part of a popover, not the popover
    return !escape.slice(0, 500).includes(name);
  });

  assert.deepEqual(
    missing,
    [],
    `these are positioned inside a board group but do not cancel paint containment: ${missing.join(", ")}`,
  );
});

/** The Store Documentation board is the same component and inherits all of it. */
test("Store Documentation shares the board and so shares the fix", async () => {
  const store = await read("app/(app)/portal/views/store-documentation-board.tsx");
  assert.match(store, /import \{ LiveMaintenanceBoard \} from "\.\.\/live-board"/);
});
