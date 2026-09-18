/**
 * The board's date cells open a MAINTSUPP calendar, not Chromium's.
 *
 * WHAT WAS WRONG. Date Requested, Date Completed, Next Update and Due Date were
 * a bare `<input type="date">`. Pressing one opened the browser's own popup —
 * on Windows Chromium a white panel with a blue selected day, sitting on the
 * navy board looking like a different application.
 *
 * WHY IT COULD NOT BE STYLED. That popup is not in the document: no node, no
 * shadow root a page may pierce, no stylesheet that applies. `accent-color` is
 * the single hook a page gets, it tints only some controls on some platforms,
 * and the screenshot that prompted this shows the day still in the default blue
 * with `accent-color: var(--brand-fill)` already shipped. So this is not a
 * styling change; the popup had to be replaced.
 *
 * The two halves below are this suite's usual pair: source pins for the
 * decisions a passing request cannot demonstrate, and real unit tests for the
 * day arithmetic, which is a leaf module precisely so it can be CALLED.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boardCalendarMonthOf,
  shiftBoardCalendarDay,
  shiftBoardCalendarDayByMonth,
  shiftBoardCalendarYear,
} from "../app/(app)/portal/board-day-math.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The same file with its comments removed — see owner-part-five-assignee-picker. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. The native popup is gone                                         */
/* ------------------------------------------------------------------ */

test("the desktop date cell is a button and a branded panel, not a native input", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const cell = cells.slice(
    cells.indexOf("export function DateCell("),
    cells.indexOf("export function TimelineCell("),
  );
  const desktop = cell.slice(cell.lastIndexOf('className="sheet-date"'));

  assert.match(desktop, /<button\s+ref=\{triggerRef\}/, "the cell itself is the trigger");
  assert.match(desktop, /className=\{`sheet-date__trigger/);
  assert.match(desktop, /<BoardDatePicker/, "and it opens the product's own picker");
  assert.doesNotMatch(
    desktop,
    /<input[\s\S]{0,80}type="date"/,
    "a date input in the cell is what summoned the browser's grey popup",
  );
  // The trigger is a real button, so Enter and Space open it for free.
  assert.match(desktop, /aria-haspopup="dialog"/);
  assert.match(desktop, /aria-expanded=\{open\}/);
});

test("the picker's only calendar is the one the rest of the product draws", async () => {
  const picker = codeOnly(await source("app/(app)/portal/cells/board-date-picker.tsx"));
  assert.match(picker, /import \{ MobileBoardCalendar/, "one grid, not a second");
  assert.match(picker, /<MobileBoardCalendar/);
  assert.doesNotMatch(
    picker,
    /boardCalendarDays\(/,
    "a second grid built here is how two calendars come to disagree",
  );
  // And it reuses the board's own overlay rather than positioning itself.
  assert.match(picker, /<AnchoredPopover/);
  assert.doesNotMatch(
    picker,
    /getBoundingClientRect|position: "fixed"/,
    "no second positioning implementation",
  );
});

test("the browser's picker button is hidden, so its popup cannot be summoned", async () => {
  const css = await source("app/(app)/portal/cells/board-date-picker.css");
  assert.match(
    css,
    /\.sheet-date-input::-webkit-calendar-picker-indicator \{[^}]*display: none/,
    "that indicator is the remaining way a pointer reaches the grey panel",
  );
});

/* ------------------------------------------------------------------ */
/* 1b. The Timeline editor opens the same picker                       */
/* ------------------------------------------------------------------ */

test("Set timeline's Start and End open the board's calendar, not the browser's", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const editor = cells.slice(
    cells.indexOf('className="sheet-timeline-popover"'),
    /* The mobile sheet's own class — an unambiguous end for this slice, where
       "open && mobile" also appears in DateCell far above. */
    cells.indexOf("mobile-timeline-sheet"),
  );
  assert.match(editor, /<TimelineDateField[\s\S]{0,200}label="Start date"/);
  assert.match(editor, /<TimelineDateField[\s\S]{0,200}label="End date"/);
  assert.doesNotMatch(
    editor,
    /<input[\s\S]{0,80}type="date"/,
    "a date input here is what opened Chromium's grey popup on this panel",
  );
});

test("the Timeline field is the same component the date columns use", async () => {
  const picker = codeOnly(await source("app/(app)/portal/cells/board-date-picker.tsx"));
  const tail = picker.slice(picker.indexOf("export function TimelineDateField"));
  /* The field's own body, not the rest of the file — `BoardDatePicker` below it
     legitimately draws the grid, and an unbounded slice would include it. */
  const field = tail.slice(0, tail.indexOf("export function BoardDatePicker"));
  assert.match(
    field,
    /<BoardDatePicker/,
    "the field must open the SAME panel, not a second calendar",
  );
  // One calendar in the product: the field owns no grid of its own.
  assert.doesNotMatch(field, /MobileBoardCalendar|boardCalendarDays/);
});

test("the Timeline editor is not dismissed by a press inside the calendar", async () => {
  /*
   * THE NESTED-POPOVER TRAP. `BoardDatePicker` portals its panel into the
   * shared layer host, so a press on a day is a press OUTSIDE the timeline
   * popover — and this editor closes on any outside press. Left alone, picking
   * a date closed the whole editor before the date could be taken.
   * `LayerPortal` stamps `data-board-popover` on that host for exactly this,
   * and the rest of the board already skips it.
   */
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const timeline = cells.slice(cells.indexOf("export function TimelineCell("));
  assert.match(
    timeline.slice(0, 2000),
    /closest\("\[data-board-popover\]"\)/,
    "the dismissal must skip anything inside a portalled board popover",
  );
});

test("the end-before-start rule is untouched, and nothing is silently swapped", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const save = cells.slice(cells.indexOf("const saveTimeline = () =>"));
  assert.match(
    save.slice(0, 420),
    /if \(draftStart && endToSave && endToSave < draftStart\) \{\s*setError\(/,
    "an end before the start is refused, not reordered",
  );
  assert.match(cells, /The end date must be on or after the start date\./);
  // The fields write the draft only; "Save dates" is still what commits.
  const editor = cells.slice(
    cells.indexOf('className="sheet-timeline-popover"'),
    /* The mobile sheet's own class — an unambiguous end for this slice, where
       "open && mobile" also appears in DateCell far above. */
    cells.indexOf("mobile-timeline-sheet"),
  );
  assert.match(editor, /onClick=\{saveTimeline\}/);
  assert.doesNotMatch(editor, /onSave\(/, "a field must not commit behind the Save button");
});

test("the strip still reads the saved dates, so the sync fix is not undone", async () => {
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const timeline = cells.slice(cells.indexOf("export function TimelineCell("));
  assert.match(timeline, /const savedStart = dateInputValue\(start\);/);
  assert.match(timeline, /const savedEnd = dateInputValue\(end\);/);
  const label = timeline.slice(timeline.indexOf("const label ="), timeline.indexOf("const saveTimeline"));
  assert.doesNotMatch(label, /draftStart|draftEnd/, "no draft state in the strip's label");
});

test("the picker's stylesheet ships whether or not a panel is open", async () => {
  /*
   * IT DID NOT, AND EVERY DATE CELL PAID FOR IT. The stylesheet also carries
   * `.sheet-date__trigger`, and the component returned `null` before reaching
   * the `<link>` — so on first paint the board's date cells were unstyled and
   * only snapped into shape once a reader opened a picker. Measured in a
   * browser: `display: block` before, `display: flex` after.
   */
  const picker = codeOnly(await source("app/(app)/portal/cells/board-date-picker.tsx"));
  const closed = picker.indexOf("if (!open) return");
  const link = picker.indexOf("rel=\"stylesheet\"");
  assert.ok(link !== -1, "the picker must ship its stylesheet");
  assert.ok(link < closed, "the stylesheet must be built BEFORE the closed early return");
  assert.match(picker, /if \(!open\) return stylesheet;/);
});

/* ------------------------------------------------------------------ */
/* 2. Navigation, keyboard and the rules the cell already had          */
/* ------------------------------------------------------------------ */

test("a month and a year can be stepped, both named for a screen reader", async () => {
  const picker = await source("app/(app)/portal/cells/board-date-picker.tsx");
  for (const label of ["Previous year", "Previous month", "Next month", "Next year"]) {
    assert.ok(picker.includes(`aria-label="${label}"`), `the panel must offer ${label}`);
  }
  // The month on show is announced when the arrows move it.
  assert.match(picker, /<strong aria-live="polite">/);
});

test("the grid is one tab stop and the arrow keys walk it", async () => {
  const calendar = codeOnly(await source("app/(app)/portal/board-calendar.tsx"));
  assert.match(
    calendar,
    /tabIndex=\{date === focusable \? 0 : -1\}/,
    "42 tab stops is why a date grid uses a roving tabindex",
  );
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    assert.ok(calendar.includes(key), `${key} must move between days`);
  }
  assert.match(calendar, /PageUp/);
  assert.match(calendar, /event\.key === "Home"/);
  assert.match(calendar, /event\.key === "End"/);
  // Leaving the month shows it, then focuses the day once it exists.
  assert.match(calendar, /pendingFocus\.current = next;/);
  assert.match(calendar, /aria-current=\{date === today \? "date" : undefined\}/);
});

test("Clear is still offered only where the column allows it", async () => {
  const picker = codeOnly(await source("app/(app)/portal/cells/board-date-picker.tsx"));
  assert.match(picker, /\{clearable && value && \(/, "the panel does not soften the rule");
  // And the cell refuses a clear on a column that forbids one.
  const cells = codeOnly(await source("app/(app)/portal/board-cells.tsx"));
  const pick = cells.slice(cells.indexOf("const pick = (date: string | null)"));
  assert.match(pick.slice(0, 260), /if \(!date\) \{\s*if \(clearable\) onSave\(null, ""\);/);
  // Date Requested is the timeline's start, so it still passes clearable={false}.
  const board = codeOnly(await source("app/(app)/portal/live-board.tsx"));
  const requested = board.slice(board.indexOf('case "requested":'), board.indexOf('case "completed":'));
  assert.match(requested, /clearable=\{false\}/);
});

test("the panel is drawn in tokens, never in colours of its own", async () => {
  const css = await source("app/(app)/portal/cells/board-date-picker.css");
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    declarations,
    /#[0-9a-f]{3,8}\b/i,
    "a hex here is a second palette beside the theme's",
  );
  // The selected day and today wear the same pair the phone sheet wears.
  assert.match(declarations, /background: var\(--brand-primary\)/);
  assert.match(declarations, /color: var\(--on-brand-primary\)/);
  assert.match(declarations, /box-shadow: inset 0 0 0 1px var\(--brand-fill\)/);
  assert.match(declarations, /outline: 2px solid var\(--focus-ring\)/);
});

/* ------------------------------------------------------------------ */
/* 3. The day arithmetic, called rather than read                      */
/* ------------------------------------------------------------------ */

test("a day steps without ever becoming an instant", () => {
  assert.equal(shiftBoardCalendarDay("2026-09-18", 1), "2026-09-19");
  assert.equal(shiftBoardCalendarDay("2026-09-18", -1), "2026-09-17");
  assert.equal(shiftBoardCalendarDay("2026-09-18", 7), "2026-09-25");
  assert.equal(shiftBoardCalendarDay("2026-09-18", -7), "2026-09-11");
  // Month ends in both directions.
  assert.equal(shiftBoardCalendarDay("2026-09-30", 1), "2026-10-01");
  assert.equal(shiftBoardCalendarDay("2026-10-01", -1), "2026-09-30");
  // Year ends.
  assert.equal(shiftBoardCalendarDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftBoardCalendarDay("2027-01-01", -1), "2026-12-31");
  // Leap day, and the year either side of it.
  assert.equal(shiftBoardCalendarDay("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftBoardCalendarDay("2028-02-29", 1), "2028-03-01");
  assert.equal(shiftBoardCalendarDay("2026-02-28", 1), "2026-03-01");
  /*
   * THE DAYLIGHT-SAVING TRAP. On the UK clock change, a local-time "+1 day" is
   * 23 or 25 hours and lands on the same day or skips one. These are the two
   * 2026 boundaries; the answers are the calendar's, not the clock's.
   */
  assert.equal(shiftBoardCalendarDay("2026-03-29", 1), "2026-03-30");
  assert.equal(shiftBoardCalendarDay("2026-03-28", 1), "2026-03-29");
  assert.equal(shiftBoardCalendarDay("2026-10-25", 1), "2026-10-26");
  assert.equal(shiftBoardCalendarDay("2026-10-24", 1), "2026-10-25");
});

test("a month step keeps the day, or the last one the month has", () => {
  assert.equal(shiftBoardCalendarDayByMonth("2026-09-18", 1), "2026-10-18");
  assert.equal(shiftBoardCalendarDayByMonth("2026-09-18", -1), "2026-08-18");
  // Clamped rather than rolled over: this is the whole reason it exists.
  assert.equal(shiftBoardCalendarDayByMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftBoardCalendarDayByMonth("2028-03-31", -1), "2028-02-29");
  assert.equal(shiftBoardCalendarDayByMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftBoardCalendarDayByMonth("2026-05-31", 1), "2026-06-30");
  // Across a year boundary, in both directions.
  assert.equal(shiftBoardCalendarDayByMonth("2026-12-15", 1), "2027-01-15");
  assert.equal(shiftBoardCalendarDayByMonth("2026-01-15", -1), "2025-12-15");
});

test("a year step lands on the same month, and on the first of it", () => {
  assert.equal(shiftBoardCalendarYear("2026-09-01", 1), "2027-09-01");
  assert.equal(shiftBoardCalendarYear("2026-09-01", -1), "2025-09-01");
  assert.equal(shiftBoardCalendarYear("2026-09-18", 1), "2027-09-01");
  // February survives a leap year in either direction.
  assert.equal(shiftBoardCalendarYear("2028-02-01", -1), "2027-02-01");
  assert.equal(shiftBoardCalendarYear("2027-02-01", 1), "2028-02-01");
});

test("the month a day belongs to is the first of it", () => {
  assert.equal(boardCalendarMonthOf("2026-09-18"), "2026-09-01");
  assert.equal(boardCalendarMonthOf("2026-01-01"), "2026-01-01");
  assert.equal(boardCalendarMonthOf("2026-12-31"), "2026-12-01");
});

test("the arithmetic module stays a leaf, so it can keep being called", async () => {
  const math = await source("app/(app)/portal/board-day-math.ts");
  assert.doesNotMatch(math, /^import /m, "an import here takes this test away");
  assert.doesNotMatch(math, /"use client"/);
  /*
   * EVERY `new Date(` HERE IS A `Date.UTC(` — counted rather than matched with
   * a negative lookahead, which JavaScript's backtracking quietly satisfies at
   * the newline in a wrapped call. A local-time `new Date(y, m, d)` is the
   * timezone bug this module exists to avoid.
   */
  const code = codeOnly(math);
  const constructed = (code.match(/new Date\(/g) ?? []).length;
  const utc = (code.match(/new Date\(\s*Date\.UTC\(/g) ?? []).length;
  assert.ok(constructed > 0, "the arithmetic must actually be exercised");
  assert.equal(utc, constructed, "only Date.UTC — never a local-time Date");
});
