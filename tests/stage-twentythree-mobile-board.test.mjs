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

test("the layout is resolved during render, so no layout flashes first", async () => {
  const board = await read(BOARD);

  // An effect runs after paint by definition, so a layout chosen in one paints
  // the other first. Both the initial state and the board-change reset are
  // therefore resolved during render.
  assert.match(
    board,
    /if \(layoutFor\.boardId !== boardId\) setLayoutFor\(readMobileLayout\(boardId\)\);/,
  );
  assert.match(board, /useState\(\(\) => readMobileLayout\(boardId\)\)/);

  /*
   * THE PREFERENCE IS NO LONGER STORED AT ALL, which is the third and final
   * position this rule has held.
   *
   * It began unversioned, which recorded WHICH layout was chosen and nothing
   * about which default it was chosen against — so when the Jobs default moved
   * from cards to the table, every phone that had ever tapped "Cards" back when
   * that meant "stay where I am" started reading as a deliberate override. It
   * then became a `:v2` key, on the reasoning that a versioned value knows its
   * own generation. Also true, also not enough: the requirement is that
   * ENTERING a section on a phone shows the table — first entry, back from
   * another section, after a reload, after the browser is closed and reopened —
   * and a value that survives an entry is a value that must be ignored on
   * entry. So both keys are retired and deleted, nothing is written, and the
   * choice lives in component state where a remount is genuinely a fresh entry.
   *
   * `board-mobile-layout.ts` carries the full argument. What belongs HERE is
   * that the board does not resolve any of it for itself.
   */
  assert.match(
    board,
    /import \{ readMobileLayout \} from "\.\/board-mobile-layout";/,
  );
  assert.doesNotMatch(board, /function readMobileLayout\(boardId: string\)/);
  assert.doesNotMatch(board, /`maintsupp:board:\$\{boardId\}:mobile-layout/);
  assert.doesNotMatch(board, /writeMobileLayout/);

  const resolver = await read("app/(app)/portal/board-mobile-layout.ts");
  assert.doesNotMatch(resolver, /setItem/, "no layout preference may be persisted");
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

  /*
   * The calendar panel is `OperationsCalendarPanel` now — the board's Calendar
   * view tab mounts the same component, which is what the owner was opening
   * when they reported the calendar missing. The ORDER on this page is what
   * this test is about and is unchanged: the panel is still rendered above the
   * register.
   */
  const calendar = portal.indexOf("<OperationsCalendarPanel");
  const register = portal.indexOf('<section className="panel planned-register-panel">');
  assert.ok(calendar > 0 && register > 0, "both panels must still exist");
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(
    surface,
    /<section className="panel calendar-panel">/,
    "and the panel is still the calendar section it always was",
  );
  assert.ok(
    calendar < register,
    "the calendar must come first — the register answers 'what is scheduled', " +
      "the calendar answers 'scheduled WHEN', which is why the screen is opened",
  );
});
