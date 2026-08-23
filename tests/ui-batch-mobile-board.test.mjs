/**
 * UI batch — the board on a phone.
 *
 * What the owner circled on a 430px screenshot, pinned so it cannot come back:
 *
 *   - the Jobs board opens on the TABLE unless the phone has chosen otherwise;
 *   - the row gutter's "…" is gone on a phone — the table starts at the edge —
 *     and the item's actions are behind a "⋮" at the top right of the item
 *     drawer, carrying the SAME verbs the row menu carries;
 *   - the search field fills its box and shrinks with the screen;
 *   - the Cards | Table segments are equal, padded and never clipped;
 *   - the "+ Add new group" bar no longer covers the last row or card.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const BOARD = "app/(app)/portal/live-board.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";
const ACTIONS = "app/(app)/portal/overlay/item-actions.tsx";
const GLOBALS = "app/globals.css";

/** Every `@media (max-width: 760px)` block in `css`, brace-matched, joined. */
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

test("the Jobs board opens on the table on a phone; a stored choice still wins", async () => {
  const board = await read(BOARD);
  const fn = board.slice(board.indexOf("function readMobileLayout(boardId: string)"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /if \(stored === "cards" \|\| stored === "grid"\) return \{ boardId, layout: stored \};/);
  assert.match(
    body,
    /return \{ boardId, layout: boardId === "maintenance" \? "grid" : "cards" \};/,
    "Jobs defaults to the grid; every other board keeps the cards",
  );
});

test("the row gutter trigger is gone on a phone, gutter and all", async () => {
  const phone = phoneBlocks(await read(GLOBALS));
  assert.match(phone, /\.sheet-row-more,\s*\n\s*\.live-sheet \.sheet-check::before \{\s*display: none;/);
  assert.match(phone, /\.sheet-group__header,\s*\n\s*\.live-sheet \{\s*margin-left: 0;/);
  assert.match(phone, /\.live-sheet \{\s*--sheet-gutter-width: 0px;/);

  // And not rendered at all: a hidden button is still a button to a reader.
  const board = await read(BOARD);
  assert.match(board, /\{!mobile && \(\s*\n\s*<button\s*\n\s*ref=\{moreRef\}\s*\n\s*className="sheet-row-more"/);
});

test("the item's actions live behind a ⋮ in the drawer header, top right", async () => {
  const portal = await read(PORTAL);
  const header = portal.slice(
    portal.indexOf('<div className="detail-drawer__header">'),
    portal.indexOf('<nav className="detail-drawer__tabs"'),
  );
  assert.match(header, /<div className="detail-drawer__actions">/);
  assert.match(header, /<ItemActionsMenu request=\{request\} actions=\{itemActions\} \/>/);
  // The ⋮ comes BEFORE Close, so it reads "actions, then close" left to right.
  assert.ok(
    header.indexOf("<ItemActionsMenu") < header.indexOf('aria-label="Close details"'),
    "the actions trigger sits beside, and before, Close",
  );

  // Every verb the row menu offers (bar "Open item", which the drawer IS).
  const actions = await read(ACTIONS);
  for (const label of [
    "Open in new tab",
    "Copy item link",
    "Duplicate item",
    "Create new item below",
    "Add subitem",
    "Convert to subitem",
    "Move to",
    "Archive item",
    "Delete item",
  ]) {
    assert.ok(actions.includes(label), `the drawer menu must offer "${label}"`);
  }
  // Relocated, not reimplemented: the drawer's verbs are the board's handlers.
  assert.doesNotMatch(actions, /fetch\(/, "the drawer menu must not talk to the API on its own");
  const board = await read(BOARD);
  assert.match(board, /buildBoardItemActions\(boardId, \(\) => itemActionSources\.current\)/);
  for (const handler of [
    "openItemInNewTab",
    "copyItemLink",
    "createItemBelow",
    "addSubitem",
    "convertToSubitem",
    "moveItem",
    "runBulkAction",
  ]) {
    assert.match(
      board.slice(board.indexOf("itemActionSources.current = {")),
      new RegExp(`\\b${handler},`),
      `the board must publish ${handler}`,
    );
  }
  // Subitems are a Jobs concept; a store gets none.
  assert.match(actions, /supportsSubitems: !\(read\(\)\?\.storeDocumentation/);
  // Both boards feed the drawer.
  assert.match(portal, /onItemActionsChange=\{setBoardItemActions\}[\s\S]*onItemActionsChange=\{setBoardItemActions\}/);
  assert.match(await read("app/(app)/portal/views/store-documentation-board.tsx"), /onItemActionsChange=\{onItemActionsChange\}/);
});

test("the search field fills its box and shrinks with the screen", async () => {
  const phone = phoneBlocks(await read(GLOBALS));
  const search = phone.slice(phone.indexOf("  .live-board-search {\n    flex: 0 0 auto;"));
  assert.match(search, /width: clamp\(150px, 42vw, 230px\);/);
  assert.match(search, /\.live-board-search input \{[^}]*height: 100%;[^}]*min-height: 0;/);
  // The 44px floor that made the input taller than its label is gone.
  const brand = await read("app/brand-overrides.css");
  assert.doesNotMatch(
    brand,
    /\.live-board-toolbar input\[type="search"\],/,
    "the search input must not carry its own min-height floor",
  );
  // One line for "New item" / "New store".
  assert.match(phone, /\.live-board-split > \.primary-button \{[^}]*white-space: nowrap;/);
});

test("the Cards | Table segments are equal, padded and never clipped", async () => {
  const css = await read(GLOBALS);
  const rule = css.slice(css.indexOf(".board-mobile__switch button {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /flex: 1 1 0;/);
  assert.match(body, /min-width: 0;/);
  assert.match(body, /padding: 0 12px;/);
  assert.match(body, /white-space: nowrap;/);
  const on = css.slice(css.indexOf(".board-mobile__switch button.is-on {"));
  assert.match(on.slice(0, on.indexOf("}")), /box-shadow: inset 0 0 0 1px var\(--teal-600\);/);
});

test("the Add new group bar leaves the last row and the last card clear", async () => {
  const phone = phoneBlocks(await read(GLOBALS));
  assert.match(phone, /\.live-board-footer \{\s*min-height: calc\(55px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(
    phone,
    /\.live-board-panel \.board-mobile \{\s*padding-bottom: calc\(55px \+ 16px \+ env\(safe-area-inset-bottom\)\);/,
  );
  assert.match(
    phone,
    /\.live-board-panel \.live-board-scroll \{\s*padding-bottom: calc\(55px \+ 24px \+ env\(safe-area-inset-bottom\)\);/,
  );
});
