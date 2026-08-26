/**
 * Dragging a calendar event onto another date.
 *
 * WHAT THIS FILE CAN AND CANNOT REACH, STATED BEFORE THE FIRST ASSERTION.
 *
 * The half of a drag that matters most cannot be seen from Node. Whether a
 * finger swipe over the month grid scrolls the page or lifts a chip is decided
 * inside Chrome's gesture recogniser, at `touchstart`, from `touch-action` and
 * the non-passive listeners that exist at that instant — and no assertion here
 * can observe any of it. The measured browser run is what says the gesture
 * works, and it is written up in the batch report. What was measured, in
 * Chromium against the running dev server:
 *
 *   · desktop month, 1280 — a Due Date chip dragged from 2026-08-12 to
 *     2026-08-20 wrote `dueAt: 2026-08-20T00:00:00.000Z` and left
 *     `requestedAt` at 2026-08-11;
 *   · desktop week, 1280 on /dashboard/planned — 2026-08-25 to 2026-08-27,
 *     same result, same untouched second date;
 *   · touch, 390 — the same move from the agenda grip, and a plain finger
 *     swipe over the grid scrolled the page 0 → 271 with its `touchmove`
 *     events arriving `cancelable: false` and a `pointercancel` behind them,
 *     which is the browser claiming the pan exactly as it should;
 *   · Escape mid-drag, and a release over the page chrome, each wrote nothing.
 *
 * So this file covers the two things that ARE reachable without a browser:
 *
 *   · the ARITHMETIC — when a press becomes a drag, whether a drop changes
 *     anything, how fast the week creeps at its edge — by calling the real
 *     module with numbers;
 *   · the WIRING whose ABSENCE a browser test cannot notice. A browser test
 *     that drags a chip passes just as well when a hold timer has been left
 *     behind, when the date has been round-tripped through a `Date`, or when
 *     the write has quietly grown a second path that skips `commitDate`. Each
 *     of those is a defect that only shows up on somebody else's timezone,
 *     somebody else's field, or somebody else's permission — so the source is
 *     read for the shapes that must not appear.
 *
 * `calendar-event-drag.ts` imports React and two types, so its pure half is
 * lifted out by stripping the imports rather than by transpiling the app.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const DRAG = "app/(app)/portal/calendar-event-drag.ts";
const VIEWS = "app/(app)/portal/calendar-views.tsx";
const CSS = "app/(app)/portal/calendar-views.css";
const PANEL = "app/(app)/portal/calendar-surface.tsx";

const source = await read(DRAG);
const views = await read(VIEWS);
const css = await read(CSS);
const panel = await read(PANEL);

/*
 * The source with its prose removed.
 *
 * Every "this must NOT appear" assertion below reads THIS rather than the file,
 * because this file's own header talks at length about `new Date()`,
 * `elementFromPoint` and `board-row-drag.ts` — saying, correctly, that the
 * first two are absent and that the third is a citation and not an import. A
 * check that cannot tell an explanation from the thing it explains is a check
 * that punishes the comment for existing.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/*
 * The pure exports, run for real.
 *
 * Everything from `DRAG_HANDLE_SELECTOR` down needs React and a DOM; everything
 * above it is numbers. So the file is cut there and its imports stripped, which
 * leaves a module that runs in `node --test` with nothing mocked and nothing
 * re-implemented — these are the same functions the gesture calls.
 */
const arithmetic = source
  .slice(0, source.indexOf("const DRAG_HANDLE_SELECTOR"))
  .replace(/^import .*$/gm, "")
  .replace(/^"use client";$/m, "");

const drag = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(arithmetic, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

/* ── When a press becomes a drag ─────────────────────────────────────────── */

test("a finger that did not land on the grip is released, whatever it does", () => {
  /*
   * This is the whole touch story in one assertion. A finger anywhere on the
   * calendar but the grip belongs to the browser, and it is given up BEFORE
   * anything is prevented — not after a timer, not after a distance, not
   * conditionally. `board-row-drag.ts` records why: a drag armed part-way
   * through a touch sequence is armed against a gesture Chrome has already
   * marked non-blocking, so `preventDefault()` is a no-op, the compositor pans
   * anyway and `pointercancel` kills the drag.
   */
  for (const distance of [0, 3, 4, 40, 400]) {
    assert.equal(
      drag.calendarDragDecision({ pointerType: "touch", distance, fromHandle: false, buttons: 1 }),
      "release",
      `a ${distance}px finger swipe must be released`,
    );
  }
});

test("a finger ON the grip still has to clear the threshold, because the grip is a button", () => {
  const press = (distance) =>
    drag.calendarDragDecision({ pointerType: "touch", distance, fromHandle: true, buttons: 1 });
  assert.equal(press(0), "wait");
  assert.equal(press(3.9), "wait");
  // Pressing the grip without moving opens the date dialog, so a drag that
  // armed on contact would make that button unpressable.
  assert.equal(press(4), "drag");
  assert.equal(press(120), "drag");
});

test("a mouse gets four pixels and no hold timer", () => {
  const mouse = (distance, buttons = 1) =>
    drag.calendarDragDecision({ pointerType: "mouse", distance, fromHandle: false, buttons });
  assert.equal(drag.CALENDAR_DRAG_THRESHOLD, 4);
  assert.equal(mouse(0), "wait");
  assert.equal(mouse(3.99), "wait", "below the threshold the chip is still a click");
  assert.equal(mouse(4), "drag");
  // A mouse that lost its button ended the press somewhere this gesture did
  // not hear about; it must not be claimable afterwards.
  assert.equal(mouse(40, 0), "release");
});

test("there is no hold timer anywhere in the gesture", () => {
  /*
   * The row drag had one and it meant resting the cursor on a cell before
   * clicking it lifted the row. The only timers this file is allowed are the
   * zero-delay click guard and the settle animation's safety net, both of which
   * end a drag rather than starting one.
   */
  assert.doesNotMatch(code, /setTimeout\([^)]*\)[\s\S]{0,120}activate\(/);
  assert.doesNotMatch(code, /holdTimer|longPress|pressTimer/i);
  const timers = [...code.matchAll(/setTimeout\(/g)].length;
  assert.ok(timers <= 2, `expected at most two timers, found ${timers}`);
});

/* ── Whether a drop changes anything ─────────────────────────────────────── */

test("a drop on the day it came from, or on nothing, is not a reschedule", () => {
  assert.equal(drag.calendarDropChangesDate("2026-09-03", null), false);
  assert.equal(drag.calendarDropChangesDate("2026-09-03", "2026-09-03"), false);
  assert.equal(drag.calendarDropChangesDate("2026-09-03", "2026-09-04"), true);
  assert.equal(drag.calendarDropChangesDate("2026-09-03", "2026-09-02"), true);
});

test("the day is carried as the string it already is", () => {
  /*
   * `data-day` is `YYYY-MM-DD` and it is handed to the caller untouched.
   * Parsing a date-only string is midnight UTC, which is the previous day for
   * anybody west of Greenwich — dropping on 3 September would write the 2nd.
   * The one defence that cannot drift is never constructing a `Date` at all.
   */
  assert.doesNotMatch(code, /new Date\(/, "the gesture must never build a Date");
  assert.doesNotMatch(code, /Date\.parse|getTimezoneOffset|toISOString/);
  assert.match(code, /cell\?\.dataset\.day \?\? null/, "the target's own string, straight through");
});

/* ── The edge creep ──────────────────────────────────────────────────────── */

test("the week creeps only once the pointer is past the edge, and never faster than the cap", () => {
  assert.equal(drag.calendarEdgeSpeed(0), 0);
  assert.equal(drag.calendarEdgeSpeed(-30), 0);
  const floor = drag.CALENDAR_DRAG_MAX_SPEED * drag.CALENDAR_DRAG_MIN_SPEED_RATIO;
  assert.ok(drag.calendarEdgeSpeed(0.5) >= floor, "crossing the threshold at all is visible");
  assert.ok(
    drag.calendarEdgeSpeed(drag.CALENDAR_DRAG_EDGE) <= drag.CALENDAR_DRAG_MAX_SPEED + 1e-9,
  );
  assert.equal(
    drag.calendarEdgeSpeed(drag.CALENDAR_DRAG_EDGE * 10),
    drag.calendarEdgeSpeed(drag.CALENDAR_DRAG_EDGE),
    "past the edge it is capped, not unbounded",
  );
  // Monotonic, so easing towards the edge creeps and pressing into it moves.
  let previous = 0;
  for (let over = 1; over <= drag.CALENDAR_DRAG_EDGE; over += 5) {
    const speed = drag.calendarEdgeSpeed(over);
    assert.ok(speed >= previous, `speed fell at overshoot ${over}`);
    previous = speed;
  }
});

test("the preview is card-sized on a phone and on a desktop alike", () => {
  // A chip is ~90px and an agenda row is the width of the screen; neither is a
  // sensible thing to carry, so both are clamped into the same card.
  assert.equal(drag.calendarGhostWidth(90, 1440), drag.CALENDAR_GHOST_MIN_WIDTH);
  assert.equal(drag.calendarGhostWidth(1200, 1440), drag.CALENDAR_GHOST_MAX_WIDTH);
  // Never wider than the screen it is floating over.
  assert.ok(drag.calendarGhostWidth(1200, 320) <= 320 - 24);
});

/* ── The gesture's shape, read from the source ───────────────────────────── */

test("a non-handle touch is FORGOTTEN, not merely ignored", () => {
  /*
   * The distinction is the whole fix. `return` before a ref is written and
   * before a listener is added means the pan reaches the compositor with no
   * main-thread listener anywhere in its path; a press recorded and left
   * inactive can still be claimed by a later move.
   */
  assert.match(
    source,
    /if \(native\.pointerType === "touch" && !fromHandle\) return;[\s\S]{0,120}const pointer: CalendarDragPointer/,
    "the touch bail must come BEFORE the pointer record is allocated",
  );
});

test("a pointermove writes two numbers and returns", () => {
  const move = code.slice(code.indexOf("const move = (moveEvent"), code.indexOf("const up = (upEvent"));
  assert.doesNotMatch(move, /elementFromPoint|getBoundingClientRect|classList|style\./);
  assert.match(move, /current\.clientX = moveEvent\.clientX/);
  // Exactly one hit test in the file, and it is memoised on the box it came from.
  assert.equal([...code.matchAll(/elementFromPoint/g)].length, 1);
  assert.match(source, /let lastDayHit: DayHitCache \| null = null/);
});

test("the preview is a plain element on the body, and no React state is written mid-drag", () => {
  assert.doesNotMatch(code, /useState/, "a drag that renders is a drag that stutters");
  assert.match(source, /document\.body\.append\(root\)/);
  assert.match(source, /root\.className = "calendar-drag-ghost"/);
  // Geometry only — the colours are tokens in the stylesheet, because a hex
  // written here could not follow the dark theme.
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(source, /\.style\.(background|color|borderColor)/);
});

test("the destination is one class on one element", () => {
  assert.match(source, /const DROP_TARGET_CLASS = "is-calendar-drop"/);
  assert.match(source, /cell\?\.classList\.add\(DROP_TARGET_CLASS\)/);
});

test("Escape abandons the drag, in the capture phase, writing nothing", () => {
  assert.match(source, /keyEvent\.key !== "Escape"/);
  assert.match(source, /clearDrag\(true\)/);
  assert.match(source, /document\.addEventListener\("keydown", key, true\)/);
  const key = code.slice(code.indexOf("const key = (keyEvent"), code.indexOf("listenersRef.current ="));
  assert.doesNotMatch(key, /onDrop/, "Escape must not commit anything");
});

test("the gesture is the calendar's own and does not reach into the board's", () => {
  /*
   * `useBoardRowDrag` resolves a GAP BETWEEN TWO ROWS from a group, a row id
   * and a position. This resolves a DAY. Sharing the hook would mean teaching
   * it a second kind of target, and the board's row drag has passed a deep
   * audit that nothing here is allowed to disturb.
   */
  assert.doesNotMatch(code, /board-row-drag|board-column-drag|useBoardRowDrag/, "no import, no reuse");
  // But it does say, in prose, which measured conclusions it is following.
  assert.match(source, /THE TOUCH STORY/);
  assert.match(source, /board-row-drag\.ts/, "the citation must survive edits");
});

/* ── The wiring ──────────────────────────────────────────────────────────── */

test("the grip is the touch handle, it is labelled, and it lives on the agenda row", () => {
  assert.match(views, /data-calendar-drag-handle=""/);
  assert.match(views, /className="calendar-agenda__grip"/);
  assert.match(views, /aria-label=\{`Move \$\{event\.fieldLabel\} for \$\{event\.title\} to another date`\}/);
  // A grip that does nothing when pressed is a dead control; this one opens the
  // same dialog the Edit button opens.
  assert.match(views, /if \(drag\?\.didDrag\(\)\) return;\s*onEditDate\?\.\(event\);/);
});

test("the grip declares `touch-action: none` in the STYLESHEET, and the chip does not", () => {
  /*
   * Chrome reads `touch-action` once, at `touchstart`. Setting it when a drag
   * activates applies to the NEXT gesture, which is why the promise has to be
   * in the stylesheet and why the handle is the only touch drag there is.
   */
  const grip = css.slice(css.indexOf(".calendar-agenda__grip {"), css.indexOf(".calendar-agenda__grip:hover"));
  assert.match(grip, /touch-action: none;/);
  assert.match(grip, /width: 44px;/);
  assert.match(grip, /min-height: 44px;/);
  const chip = css.slice(css.indexOf(".calendar-chip {"), css.indexOf(".calendar-chip__lead"));
  assert.doesNotMatch(chip, /touch-action/, "a finger on a chip must stay a scroll");
});

test("the drag never dims the thing it lifted", () => {
  /*
   * It did, at `opacity: 0.45`, and axe measured one serious `color-contrast`
   * violation for as long as a finger was down — a chip title at 2.4:1. A drag
   * is not a moment when text may become unreadable, so the source wears a
   * dashed ring instead and keeps every bit of its contrast.
   */
  const block = css.slice(css.indexOf(".calendar-chip.is-calendar-dragging"));
  assert.doesNotMatch(block.slice(0, 200), /opacity/);
  assert.match(block, /outline: 2px dashed var\(--line-strong\)/);
});

test("nothing in the calendar stylesheet is a literal colour", () => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(withoutComments, /\brgba?\(/);
});

test("a chip is draggable on exactly the condition the Edit button is drawn on", () => {
  assert.match(views, /const draggable = Boolean\(drag\?\.enabled\) && event\.editable/);
  assert.match(views, /const canEdit = onEditDate !== null && event\.editable/);
  assert.match(views, /onPointerDown=\{\s*draggable \? \(pressed\) => drag\?\.onEventPointerDown\(event, pressed\) : undefined\s*\}/);
  // And the panel gates both on the same capability, with the same message.
  assert.match(panel, /onMoveDate=\{\s*canEditAnything/);
  assert.match(panel, /void commitDate\(event, day\)/);
});

test("the Edit button is still there, still works, and can never start a drag", () => {
  assert.match(views, /data-calendar-edit=""/, "the accessible path is not optional");
  assert.match(views, /aria-label=\{`Change \$\{event\.fieldLabel\} for \$\{event\.title\}`\}/);
  assert.match(panel, /<CalendarDateDialog/);
  assert.match(panel, /setEditing\(event\)/);
  // Excluded by name AND structurally: the pointer handlers live on the chip
  // and on the grip, never on the row, so a press on Edit never reaches them.
  assert.match(source, /\[data-calendar-edit\]/);
  assert.match(source, /const control = target\?\.closest\(NESTED_CONTROL_SELECTOR\);\s*if \(control && control !== element\) return;/);
});

test("the Day surface offers no grip, because it has no second date", () => {
  const day = views.slice(views.indexOf("function DayView("), views.indexOf("The two shared pieces"));
  assert.doesNotMatch(day, /draggable/, "Day passes no draggable flag");
  assert.match(views, /DRAG DOES NOT APPLY TO THE DAY SURFACE/, "and it says why");
  // Month and Week do, because both draw a grid of `[data-calendar-day]`.
  const month = views.slice(views.indexOf('className="calendar-month__agenda"'), views.indexOf("function MonthCell"));
  assert.match(month, /draggable/);
  const week = views.slice(views.indexOf('className="calendar-week__agenda"'), views.indexOf("function DayView("));
  assert.match(week, /draggable/);
});

test("a drop goes through commitDate and nowhere else", () => {
  /*
   * One write path. `commitDate` routes through `calendarWriteTarget`, so a Due
   * Date chip changes `dueAt` and never Date Requested however many sources are
   * on; it writes optimistically through the host, which rolls the record back
   * on refusal and reports it. A second path would be a second set of all of
   * that, silently diverging.
   */
  assert.equal([...panel.matchAll(/onJobDateChange\(/g)].length, 1);
  assert.equal([...panel.matchAll(/onComplianceDateChange\(/g)].length, 1);
  assert.match(panel, /const commitDate = async \(event: CalendarEvent, day: CalendarDay\)/);
  assert.match(panel, /const target = calendarWriteTarget\(event\);/);
  assert.doesNotMatch(views, /fetch\(/, "the views never write");
  assert.doesNotMatch(code, /fetch\(/, "and neither does the gesture");
});

test("the day cells still say which day they are, which is what the drop reads", () => {
  assert.match(views, /data-calendar-day=""/);
  assert.match(views, /data-day=\{day\}/);
  assert.match(source, /closest<HTMLElement>\("\[data-calendar-day\]"\)/);
});

/* ── The preview stays on the screen ─────────────────────────────────────── */

test("the drag preview cannot hang off either edge of the screen", async () => {
  /*
   * `calendarGhostWidth` bounds how wide the card may be and `grabX` bounds
   * where inside it the pointer holds it, but neither bounds where the card
   * lands. The grip sits at the RIGHT end of an agenda row, so on a phone the
   * card hung its tail off the screen — 37px lost at 320, cutting the title with
   * the screen edge rather than with its own ellipsis.
   */
  const source = await read("app/(app)/portal/calendar-event-drag.ts");
  assert.match(source, /export function calendarGhostLeft/, "the clamp exists");
  assert.match(
    source,
    /translate3d\(\$\{calendarGhostLeft\(/,
    "and the transform actually uses it",
  );
  assert.doesNotMatch(
    source,
    /translate3d\(\$\{Math\.round\(clientX - pointer\.grabX\)/,
    "the unclamped position must not come back",
  );
});
