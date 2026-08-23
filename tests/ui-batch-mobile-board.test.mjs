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

/*
 * REWRITTEN, and the reason is the defect this batch was opened for.
 *
 * The old assertion — "a stored choice still wins" — was the bug written down
 * as a requirement. The key it honoured, `maintsupp:board:<id>:mobile-layout`,
 * recorded WHICH layout was chosen and nothing about which default it was
 * chosen against. So when Jobs moved from cards to the table in bebf419, every
 * phone that had ever tapped "Cards" — under the old build, where tapping Cards
 * meant "yes, stay where I already am" — carried a value that now read as a
 * deliberate override. Measured in a browser against the running build: clean
 * storage lands on Table, the same build with `…:mobile-layout = "cards"`
 * seeded lands on Cards.
 *
 * The contract changes, so this test changes with it. Only a VERSIONED value is
 * an explicit choice; the unversioned one is ignored and deleted; and the
 * resolver lives in its own file, because `live-board.tsx` sits a few dozen
 * lines under the ceiling `stage-eight-board-split.test.mjs` holds it to.
 */
test("the Jobs board opens on the table on a phone; only a v2 choice overrides it", async () => {
  const mod = await read("app/(app)/portal/board-mobile-layout.ts");

  // The versioned key is the only one read.
  assert.match(mod, /`maintsupp:board:\$\{boardId\}:mobile-layout:v2`/);
  assert.match(
    mod,
    /return boardId === "maintenance" \? "grid" : "cards";/,
    "Jobs defaults to the grid; every other board keeps the cards",
  );
  assert.match(
    mod,
    /if \(stored === "cards" \|\| stored === "grid"\) return \{ boardId, layout: stored \};/,
  );

  // The legacy key is retired, not honoured: removed, and never returned.
  assert.match(mod, /store\.removeItem\(legacyMobileLayoutKey\(boardId\)\);/);
  const resolver = mod.slice(mod.indexOf("export function readMobileLayout"));
  assert.doesNotMatch(
    resolver.slice(0, resolver.indexOf("\n}\n")),
    /stored = store\.getItem\(legacyMobileLayoutKey/,
    "a legacy value must never become the returned layout",
  );

  // Only the versioned key is ever written.
  assert.match(mod, /store\.setItem\(mobileLayoutKey\(boardId\), layout\);/);

  // A server render and a browser with storage switched off both answer.
  assert.match(mod, /if \(typeof window === "undefined"\) return null;/);
});

/*
 * THIS ONE LANDS WITH THE live-board.tsx CALL-SITE PATCH and is the acceptance
 * for it: the resolver above is inert until the board stops reading the
 * unversioned key for itself. Red between the two commits, by design.
 */
test("live-board reads the layout through the versioned resolver", async () => {
  const board = await read(BOARD);
  assert.match(
    board,
    /import \{ readMobileLayout, writeMobileLayout \} from "\.\/board-mobile-layout";/,
  );
  assert.doesNotMatch(
    board,
    /`maintsupp:board:\$\{boardId\}:mobile-layout`/,
    "the unversioned key must not be read or written from the board any more",
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
