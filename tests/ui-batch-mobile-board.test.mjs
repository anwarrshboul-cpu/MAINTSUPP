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
 * THE TABLE, ON EVERY BOARD, ON EVERY ENTRY — and no stored value at all.
 *
 * This test has now been rewritten twice by the same underlying mistake, which
 * is worth recording because the third time will look tempting too.
 *
 * FIRST the assertion was "a stored choice still wins". That was the bug
 * written down as a requirement: the key `maintsupp:board:<id>:mobile-layout`
 * recorded WHICH layout was chosen and nothing about which default it was
 * chosen against, so when Jobs moved from cards to the table every phone that
 * had ever tapped "Cards" — under a build where tapping Cards meant "yes, stay
 * where I am" — carried a value that then read as a deliberate override.
 *
 * SECOND it became "only a `:v2` value wins", on the reasoning that a versioned
 * key knows which generation it belongs to. True, and still not enough. The
 * owner's requirement is that entering a section on a phone shows the TABLE —
 * first entry, after navigating away and back, after a reload, after the
 * browser is closed and reopened. A stored preference that survives an entry is
 * a preference that must be ignored on entry, and a key nothing may honour is
 * exactly the trap the unversioned key set. So there is no `:v3`: a version
 * number would promise a generation of stored choices this build never writes.
 *
 * THE CONTRACT NOW. `defaultMobileLayout()` takes no board id and answers
 * "grid" for everything — a per-board default is what let Store Documentation
 * open on the cards while Jobs opened on the table. Tapping Cards still works
 * and is held in component state, so a remount IS a fresh entry and every one
 * of the owner's scenarios resets without any of them being special-cased.
 * Nothing is written to storage; both retired keys are deleted on sight.
 */
test("every board opens on the table on a phone, and nothing stored can override it", async () => {
  const mod = await read("app/(app)/portal/board-mobile-layout.ts");

  // One answer for the whole product, and no board argument to disagree with.
  assert.match(
    mod,
    /export function defaultMobileLayout\(\): MobileLayout \{\s*return "grid";\s*\}/,
    "the table is the default on every board, not just on Jobs",
  );

  // Both retired keys are deleted on sight, and neither can become the answer.
  assert.match(mod, /store\.removeItem\(legacyMobileLayoutKey\(boardId\)\);/);
  assert.match(mod, /store\.removeItem\(retiredMobileLayoutKey\(boardId\)\);/);

  const resolver = mod.slice(mod.indexOf("export function readMobileLayout"));
  assert.match(
    resolver,
    /return \{ boardId, layout: defaultMobileLayout\(\) \};/,
    "the resolver answers the default and nothing else",
  );
  assert.doesNotMatch(
    resolver,
    /layout: stored|stored === "cards"|stored === "grid"/,
    "a stored layout must never become the returned layout",
  );

  /*
   * NOTHING WRITES. `writeMobileLayout` is gone rather than kept and unused:
   * a writer with no reader is the next person's invitation to wire it back up.
   */
  assert.doesNotMatch(mod, /setItem/, "no layout preference may be persisted");
  assert.doesNotMatch(mod, /export function writeMobileLayout/);

  // A server render and a browser with storage switched off both still answer.
  assert.match(mod, /if \(typeof window === "undefined"\) return null;/);
});

/*
 * THE CALL SITE, which is where the previous version of this rule actually
 * leaked: the resolver is inert while the board still reaches for a key itself.
 */
test("live-board takes the layout from the resolver and persists nothing", async () => {
  const board = await read(BOARD);
  assert.match(
    board,
    /import \{ readMobileLayout \} from "\.\/board-mobile-layout";/,
    "the board imports the resolver, and no writer, because there is none",
  );
  assert.doesNotMatch(
    board,
    /writeMobileLayout/,
    "the board must not persist a layout choice",
  );
  assert.doesNotMatch(
    board,
    /`maintsupp:board:\$\{boardId\}:mobile-layout/,
    "neither retired key may be read or written from the board",
  );
  /*
   * Resolved during RENDER, not in an effect. An effect runs after paint by
   * definition, which is the cards appearing for a frame before the table
   * replaces them — the flicker the owner explicitly ruled out.
   */
  assert.match(
    board,
    /if \(layoutFor\.boardId !== boardId\) setLayoutFor\(readMobileLayout\(boardId\)\);/,
    "a board change re-resolves during render, so no layout flashes first",
  );
});

/*
 * WRITTEN AGAINST A BOARD IN A BROWSER, not against the stylesheet's intent.
 *
 * Measured on the running dev server at 320/360/375/390/430 in both themes:
 * before this change the phone froze TWO cells — the 42px selection gutter at
 * left 0 and the 150px Item column at left 42 — and left 125px of a 320px
 * screen to scroll the other twenty columns through. After it the gutter is an
 * ordinary cell and Item alone is frozen, at x=1 once `scrollLeft` passes 42,
 * with 167px to scroll at 320 and 237px at 390: 42px recovered at every width
 * tested.
 *
 * The assertions are structural, so a later edit that breaks the arrangement
 * fails here rather than on somebody's phone:
 *
 *   ONE rule freezes the header cell, the body cell and the combined
 *   add-item/summary cell together. Splitting them is how a left edge starts
 *   stepping in and out mid-scroll, and that is not a thing a reader reports
 *   clearly enough to find.
 *
 *   The gutter's unfreeze has to be written out. `.sheet-check` is sticky at
 *   `left: 0` for every width from an unmediated rule, so silence here would
 *   mean frozen, not free.
 *
 *   Nothing else in a phone block may say `position: relative` about the Item
 *   column. Two dead rules used to, a thousand lines before the rule that
 *   actually froze it, and the stylesheet therefore read as "nothing is frozen
 *   on a phone" while the phone froze two columns. One reviewer read it that
 *   way and briefed the work backwards.
 */
test("exactly one column is frozen on a phone, and it is the Item name", async () => {
  const phone = phoneBlocks(await read(GLOBALS));

  // The gutter is an ordinary cell: it leads the row and scrolls away with it.
  assert.match(
    phone,
    /\.live-sheet thead th\.sheet-check,\s*\n\s*\.live-sheet tbody td\.sheet-check \{\s*\n\s*position: relative !important;\s*\n\s*left: auto !important;\s*\n\s*z-index: auto !important;/,
  );

  // Header, body and the add-item/summary row, frozen at 0 by ONE rule.
  assert.match(
    phone,
    /\.live-sheet thead \.sheet-column--name,\s*\n\s*\.live-sheet tbody \.sheet-column--name,\s*\n\s*\.sheet-add-row__item \{\s*\n\s*position: sticky !important;\s*\n\s*left: 0 !important;\s*\n\s*\}/,
  );

  // No second opinion anywhere in a phone block.
  assert.doesNotMatch(
    phone,
    /\.sheet-column--name[^{}]*\{[^{}]*position: relative/,
    "a phone block must not also unfreeze the Item column",
  );
  assert.doesNotMatch(
    phone,
    /\.sheet-column--name \{\s*\n\s*min-width: 230px;/,
    "the width of a column is data — displayedBoardColumnWidth writes an " +
      "inline min-width of 150px on a phone, and a stylesheet floor never applied",
  );
  assert.doesNotMatch(
    phone,
    /left: 42px !important/,
    "nothing is offset by the gutter's width any more",
  );

  /*
   * The group bar's 1px rule has to run across the frozen cell. At the old
   * `+ 2` the frozen header — which sits at `+ 6` so rows pass beneath it —
   * painted over the first 150px of that line, and a rule that starts partway
   * across the screen reads as a broken left edge.
   */
  assert.match(
    phone,
    /\.sheet-group__header \{[\s\S]*?z-index: calc\(var\(--z-sticky\) \+ 8\);/,
  );

  /*
   * The dragged row's ghost is `z-index: 1400` (board-row-drag-gesture.ts).
   * Every frozen cell here is in the forties, so a frozen cell can never paint
   * over the row being dragged.
   */
  const tiers = [
    ...phone.matchAll(/z-index: calc\(var\(--z-sticky\) \+ (\d+)\) !important/g),
  ].map((match) => 40 + Number(match[1]));
  assert.ok(tiers.length >= 2, "the frozen cells must state their tier");
  assert.ok(Math.max(...tiers) < 1400, `a frozen cell reached ${Math.max(...tiers)}`);
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
