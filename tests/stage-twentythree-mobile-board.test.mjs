/**
 * Stage 23 — D. The board on a phone, and the Planned screen's first panel.
 *
 * A 390px screen used to get the grid: 783 rows and every column, at column
 * widths narrowed a little. Everything was present and nothing was reachable —
 * reading one job meant panning sideways across eleven columns, and the row
 * being read drifted out from under a thumb on the way back. `MobileBoardContext`
 * existed and only narrowed columns and opened cell sheets; the grid was still
 * a grid.
 *
 * monday does not do this. On a phone each item becomes a card carrying the
 * primary column and a few key values, and tapping opens the item.
 *
 * The grid is NOT removed — HARD RULE 1, and independently the right call: a
 * coordinator on a tablet may want the table, and a mobile view with no way out
 * is its own trap.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const LIST = "app/(app)/portal/board-mobile-list.tsx";
const BOARD = "app/(app)/portal/live-board.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";

test("a card answers the two questions somebody on site is asking", async () => {
  const source = await read(LIST);

  // "Which job is this" and "what do I do next".
  for (const field of [
    "request.title",
    "request.stage",
    "request.priority",
    "request.location",
    "request.requestedAt",
    "request.contractor",
  ]) {
    assert.ok(source.includes(field), `a card must carry ${field}`);
  }
  // Photographs are why an engineer opens a job at all.
  assert.match(source, /photoCountFor\(request\)/);
  // Nothing invented for the small screen: no field the desktop board lacks.
  assert.doesNotMatch(source, /Math\.random|placeholder|Lorem/i);
});

test("dates read the way somebody reads them on site", async () => {
  const source = await read(LIST);
  assert.match(source, /if \(days === 0\) return "Today";/);
  assert.match(source, /if \(days === 1\) return "Yesterday";/);
  // Past a week it becomes a date: "23 days ago" is arithmetic backwards.
  assert.match(source, /if \(days > 1 && days < 7\) return `\$\{days\} days ago`;/);
});

test("the grid is still there, and the way back is above the fold", async () => {
  const board = await read(BOARD);
  const list = await read(LIST);

  // `hidden`, not unmounted: column widths, scroll position and the drag
  // machinery survive the switch. The second clause is the other thing that
  // hides the grid — a view tab that is a section of its own — and it hides it
  // the same way, and for the same reason.
  assert.match(
    board,
    /hidden=\{\(isMobile && mobileLayout === "cards"\) \|\| gridReplaced\}/,
  );
  assert.doesNotMatch(
    board,
    /\{!gridReplaced && \(\s*\n\s*<div\s*\n\s*className="live-board-scroll"/,
    "the grid must be hidden rather than unmounted, whatever the reason",
  );
  // Desktop must never see either the cards or the switch — the whole section
  // is behind one `isMobile`.
  assert.match(board, /\{isMobile && !gridReplaced && \(\s*\n\s*<BoardMobileSection/);

  // The switch itself lives beside the list it switches; `live-board.tsx` is
  // held to 6,000 lines, and the two are one decision.
  assert.match(list, /Table\s*\n?\s*<\/button>/, "the switch back exists");
  assert.match(list, /aria-pressed=\{layout === "grid"\}/);
  assert.match(list, /\{layout === "cards" \? \(/);
});

test("the layout preference is read without a flash", async () => {
  const board = await read(BOARD);

  // An effect reading storage paints the default first and the stored choice a
  // frame later, so a phone that chose the table flashes the cards every time.
  assert.match(
    board,
    /if \(layoutFor\.boardId !== boardId\) setLayoutFor\(readMobileLayout\(boardId\)\);/,
  );
  assert.match(board, /useState\(\(\) => readMobileLayout\(boardId\)\)/);

  /*
   * The resolver moved out of this file, and the key it reads gained a version.
   *
   * An unversioned preference records WHICH layout was chosen and nothing about
   * which default it was chosen against, so the moment the Jobs default moved
   * from cards to the table every phone that had ever tapped "Cards" — when
   * that meant "stay where I am" — started reading as a deliberate override.
   * `board-mobile-layout.ts` carries the whole argument; what belongs here is
   * that the board no longer resolves this for itself, and no longer touches
   * the key that cannot be interpreted.
   */
  assert.match(
    board,
    /import \{ readMobileLayout, writeMobileLayout \} from "\.\/board-mobile-layout";/,
  );
  assert.doesNotMatch(board, /function readMobileLayout\(boardId: string\)/);
  assert.doesNotMatch(board, /`maintsupp:board:\$\{boardId\}:mobile-layout`/);
  // Per board: a choice made on the job board must not follow you to another.
  const resolver = await read("app/(app)/portal/board-mobile-layout.ts");
  assert.match(resolver, /`maintsupp:board:\$\{boardId\}:mobile-layout:v2`/);
});

test("subitems belong to their parent's card, not beside it", async () => {
  const board = await read(BOARD);
  assert.match(
    board,
    /rows: groupRows\(group\.id\)\.filter\(\(request\) => !request\.parentId\)/,
  );
});

test("the phone's chrome is reachable with a thumb", async () => {
  const css = await read("app/brand-overrides.css");

  /*
   * The board's CONTROLS, not its cells. A dense grid is the point of a board
   * and forcing 44px onto 24,000 cells would turn the job list into a scroll
   * nobody would use — monday's cells are 36px for the same reason. What has to
   * be reachable is the chrome.
   */
  for (const selector of [
    ".live-board-tool",
    ".sheet-group__more",
    ".custom-column-header__more",
    ".sheet-group__name",
  ]) {
    assert.ok(css.includes(selector), `${selector} must get a 44px target on a phone`);
  }
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?min-height: 44px;/);
});

test("Planned opens on the calendar", async () => {
  const portal = await read(PORTAL);

  const calendar = portal.indexOf('<section className="panel calendar-panel">');
  const register = portal.indexOf('<section className="panel planned-register-panel">');
  assert.ok(calendar > 0 && register > 0, "both panels must still exist");
  assert.ok(
    calendar < register,
    "the calendar must come first — the register answers 'what is scheduled', " +
      "the calendar answers 'scheduled WHEN', which is why the screen is opened",
  );
});
