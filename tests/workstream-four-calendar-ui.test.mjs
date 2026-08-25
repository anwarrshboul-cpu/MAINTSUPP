/**
 * Workstream 4 — the Calendar's user interface, and the promises it makes.
 *
 * `workstream-four-calendar-model.test.mjs` runs the pure model: day maths,
 * timing, filters, write targets. This file pins the things that only exist
 * once the model is wired to a screen — the four surfaces, the controls, the
 * permission gate, the write paths, and the DOM contract acceptance reads.
 *
 * WHY SOURCE ASSERTIONS AND NOT A RENDER
 *
 * These components are `"use client"` TSX inside a vinext app; rendering one
 * from `node --test` means transpiling it and its whole import graph, which is
 * what `stage-twentythree-mobile-board.test.mjs` and the other UI suites
 * decline to do for the same reason. What is checked here is therefore what a
 * reviewer would check by reading: that the wiring exists, goes to the right
 * endpoint, and cannot silently lose a guarantee. The behaviour behind it is
 * proven in the browser, and the model behind THAT has its own suite.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const PORTAL = "app/(app)/portal/portal-app.tsx";
const VIEWS = "app/(app)/portal/calendar-views.tsx";
const CONTROLS = "app/(app)/portal/calendar-controls.tsx";
const PREFS = "app/(app)/portal/calendar-preferences.ts";
/*
 * The panel both hosts mount — the Planned page and the board Calendar tab.
 * Everything from the control bar down to the grid moved here when the owner
 * found the board tab drawing a different calendar entirely; the assertions
 * below follow the code and still prove the same properties.
 */
const SURFACE = "app/(app)/portal/calendar-surface.tsx";
const MODEL = "app/(app)/portal/calendar-model.ts";

/* ── The three surfaces ──────────────────────────────────────────────────── */

test("month, week and day are three surfaces, not one rendered three ways", async () => {
  /*
   * A week view built out of month cells is seven month cards — five words a
   * day and a "+3 more" on every one of them, strictly worse than the month it
   * came from. The three share the chip and the agenda row and nothing else.
   */
  const views = await read(VIEWS);
  for (const surface of ["MonthView", "WeekView", "DayView"]) {
    assert.match(views, new RegExp(`function ${surface}\\(`), `${surface} must exist`);
  }
  assert.match(views, /if \(props\.mode === "day"\) return <DayView/);
  assert.match(views, /if \(props\.mode === "week"\) return <WeekView/);
});

test("an expanded busy day survives choosing that day", async () => {
  /*
   * "+12 more" took two presses. The expansion was keyed on the ANCHOR, and
   * `onExpand` selects the day first — which now moves the anchor, so the state
   * it had just written failed its own equality check on the next render. The
   * guard was only ever about paging to another month, so it keys on the month.
   */
  const views = await read(VIEWS);
  assert.match(views, /\{ month: string; day: CalendarDay \}/, "keyed by month, not anchor");
  assert.match(views, /expanded\.month === anchorMonth/);
  assert.doesNotMatch(views, /expanded\.anchor === anchor/, "the anchor guard is what broke");
  assert.match(views, /setExpanded\(\{ month: day\.slice\(0, 7\), day \}\)/, "the cell's own month");
});

test("the week is Monday-first and the month grid is always six rows", async () => {
  const model = await read(MODEL);
  assert.match(model, /export function calendarWeekDays/);
  assert.match(model, /export function calendarMonthGrid/);
  // 42 cells: six rows, so the grid never changes height between months.
  assert.match(model, /42/);
});

test("no surface invents a time, and none draws an all-day placeholder", async () => {
  /*
   * Every date this product stores is date-only — the clock component of a
   * seeded `due_at` is 04:33:26.755, which on a calendar would read as an
   * appointment somebody could quote to a contractor. `calendarTimeOfDay`
   * answers "" for all of them, so the surfaces must render nothing rather
   * than a placeholder, and must not fabricate one of their own.
   */
  const views = await read(VIEWS);
  assert.match(views, /event\.time \?/, "a time is rendered only when there is one");
  assert.doesNotMatch(views, /All day/i, "an all-day heading on every row is noise");
  // Comments stripped first: the file header explains at length WHY there is no
  // hour grid, and a test that cannot tell an explanation from an implementation
  // punishes the explanation.
  const code = views.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /09:00|9\s*am|hourGrid|hours\b/i, "no invented clock, no hour grid");
});

/* ── Navigation ──────────────────────────────────────────────────────────── */

test("previous and next step by the unit the mode is in", async () => {
  const views = await read(VIEWS);
  assert.match(views, /shiftCalendarMonth\(anchor, direction\)/);
  assert.match(views, /shiftCalendarDay\(anchor, direction \* 7\)/);
  assert.match(views, /shiftCalendarDay\(anchor, direction\)/);
  assert.match(views, /aria-label=\{`Previous \$\{unit\}`\}/, "the label names the unit");
  assert.match(views, /aria-label=\{`Next \$\{unit\}`\}/);
});

test("one anchor serves all three modes, so switching does not move the reader", async () => {
  /*
   * Anchored on 24 August, Week must open the week containing the 24th and Day
   * the 24th itself. A cursor per mode would lose the reader's place on every
   * switch, which is the one thing that makes a three-mode calendar feel
   * broken. So there is exactly one anchor and the mode only decides how it is
   * drawn.
   */
  const surface = await read(SURFACE);
  const anchors = [...surface.matchAll(/useState<CalendarDay>\(todayDay\)/g)];
  assert.equal(anchors.length, 2, "one anchor and one selected day, and no third cursor");
  assert.match(surface, /const \[anchor, setAnchor\] = useState<CalendarDay>\(todayDay\)/);
  assert.doesNotMatch(
    surface,
    /setAnchor\(todayDay\)[\s\S]{0,120}setMode|setMode[\s\S]{0,120}setAnchor\(todayDay\)/,
    "changing mode must not reset the anchor",
  );
});

/* ── The date sources ────────────────────────────────────────────────────── */

test("every date source names a field the API actually writes", async () => {
  const model = await read(MODEL);
  const fields = await read("app/lib/request-fields.ts");
  for (const field of ["dueAt", "requestedAt", "completedAt", "nextUpdateAt"]) {
    assert.match(model, new RegExp(`"${field}"`), `${field} is offered`);
    assert.match(
      fields,
      new RegExp(`"${field}"`),
      `${field} must be writable through requestFieldValues, or the calendar is offering an edit that cannot land`,
    );
  }
});

test("the picker prints a count per source, so an empty one is legible first", async () => {
  const controls = await read(CONTROLS);
  assert.match(controls, /counts\[source\.id\] \?\? 0/);
  const surface = await read(SURFACE);
  assert.match(surface, /counts\[event\.sourceId\] \+= 1/);
});

/* ── Preferences ─────────────────────────────────────────────────────────── */

test("the remembered choices use the product's own store, and say that they do", async () => {
  /*
   * There is no server-side preference store for arbitrary view settings —
   * `/api/dashboard-layout` records panel order and nothing else. `localStorage`
   * under a `maintsupp:` key is what the board already uses for collapsed
   * groups and the theme, and the tradeoff (per person per BROWSER, not per
   * account) is said out loud rather than implied.
   */
  const prefs = await read(PREFS);
  for (const key of ["mode", "sources", "filters", "colours"]) {
    assert.match(prefs, new RegExp(`"maintsupp:calendar:${key}"`), `${key} is remembered`);
  }
  assert.match(prefs, /per person per browser/i, "the tradeoff is stated, not implied");
  assert.match(prefs, /useSyncExternalStore/, "read as an external store, like the theme");
});

test("every stored value is validated, because the browser can write to it", async () => {
  const prefs = await read(PREFS);
  for (const decoder of [
    "decodeCalendarMode",
    "decodeCalendarSources",
    "decodeCalendarFilters",
    "decodeCalendarColours",
  ]) {
    assert.match(prefs, new RegExp(`export function ${decoder}`), `${decoder} exists`);
  }
  assert.match(prefs, /catch/, "corrupt JSON falls back rather than throwing");
});

/* ── Colours ─────────────────────────────────────────────────────────────── */

test("the ink is computed by the one contrast module, not a second copy", async () => {
  /*
   * `chip-ink.ts` already computes WCAG luminance for the board's data-coloured
   * chips, and its header is a long account of what a second copy costs. The
   * calendar's colours are user-chosen, so they need exactly that answer.
   */
  const prefs = await read(PREFS);
  assert.match(prefs, /from "\.\/chip-ink"/, "reuse, not reimplement");
  assert.doesNotMatch(
    prefs,
    /0\.2126|0\.7152|0\.0722/,
    "the luminance coefficients must appear once in this codebase, in chip-ink.ts",
  );
});

test("a colour nothing can be read on is warned about, not silently drawn", async () => {
  const prefs = await read(PREFS);
  assert.match(prefs, /export function calendarColourFails/);
  const controls = await read(CONTROLS);
  assert.match(controls, /calendarColourFails/, "the picker consumes the verdict");
});

test("colour is never the only thing telling a job from a certificate", async () => {
  const views = await read(VIEWS);
  assert.match(views, /KIND_ICON/, "a glyph per kind");
  assert.match(views, /job: "wrench"/);
  assert.match(views, /compliance: "shield"/);
  // And the type word leads the accessible name, so it survives with no colour
  // at all.
  assert.match(views, /\$\{typeLabel\(event\)\}: \$\{event\.title\}/);
  assert.match(views, /, overdue`/, "overdue is a word as well as a colour");
});

/* ── Changing a date ─────────────────────────────────────────────────────── */

test("there is a non-drag way to change a date, and it is in the default view", async () => {
  /*
   * The month view is what this screen opens on. A month chip is about ninety
   * pixels of usable width, so an edit control inside one would either crowd
   * out the title or hide behind a hover — neither of which a keyboard or a
   * touch user can find. The day number selects the day and the agenda beneath
   * the grid carries the control, at EVERY width.
   */
  const views = await read(VIEWS);
  assert.match(views, /data-calendar-edit/, "the control exists");
  assert.match(
    views,
    /className="calendar-month__num"[\s\S]{0,400}onClick=\{\(\) => onSelectDay\(day\)\}/,
    "the day number selects the day",
  );
  const css = await read("app/(app)/portal/calendar-views.css");
  const agenda = css.slice(css.indexOf(".calendar-month__agenda"));
  assert.doesNotMatch(
    agenda.slice(0, 200),
    /display:\s*none/,
    "the selected-day agenda must not be phone-only — it is where Change date lives",
  );
});

test("all three modes offer the date edit, not two of them", async () => {
  /*
   * Week shipped without one. The columns carry every event in full, so a
   * second listing beneath them looked like the same information twice — true
   * of READING and wrong about DOING, because the edit control lives on an
   * agenda row. A person looking at their week had to switch to Month or Day to
   * move something in it. A column is about 152px wide and is no place for an
   * edit button, so Week gets the same agenda the month grid has.
   */
  const views = await read(VIEWS);
  for (const surface of ["MonthView", "WeekView", "DayView"]) {
    const start = views.indexOf(`function ${surface}(`);
    const body = views.slice(start, start + 4000);
    assert.match(body, /onEditDate/, `${surface} must pass the edit callback through`);
  }
  assert.match(views, /className="calendar-month__agenda"/);
  assert.match(views, /className="calendar-week__agenda"/);
});

test("the edit dialog names the record and the field before it changes anything", async () => {
  const surface = await read(SURFACE);
  assert.match(surface, /function CalendarDateDialog/);
  assert.match(surface, /role="dialog"/);
  assert.match(surface, /aria-modal="true"/);
  assert.match(surface, /aria-labelledby="calendar-date-dialog-title"/);
  assert.match(surface, /\{event\.fieldLabel\}/, "the field being changed is named");
  assert.match(surface, /calendarDayLabel\(event\.day\)/, "and the date it holds now");
  assert.match(surface, /key === "Escape"/, "Escape cancels");
});

test("each write goes to the endpoint that actually holds that date", async () => {
  const portal = await read(PORTAL);

  // A job's own field.
  assert.match(portal, /persistRequestUpdate\(id, \{ fields: \{ \[field\]: day \} \}\)/);

  /*
   * A board-derived certificate expiry: the board cell it was read from, on the
   * board it was read from. `update_cell` reads the board from `?board=` and
   * lives on the PATCH handler — `/api/board` splits create/delete onto POST
   * and edit onto PATCH, and sending this one as a POST comes back 400
   * "Unknown board action". It shipped that way and only a real certificate
   * failing to move on a real board caught it, so the method is pinned here.
   */
  assert.match(portal, /\/api\/board\?board=\$\{encodeURIComponent\(target\.boardId\)\}/);
  assert.match(portal, /action: "update_cell"/);
  assert.match(portal, /columnId: target\.columnId/);
  const cellWrite = portal.slice(
    portal.indexOf("if (target.path === \"board-cell\")"),
    portal.indexOf("} else if (target.path === \"workspace-compliance\")"),
  );
  assert.match(cellWrite, /method: "PATCH"/, "update_cell is a PATCH, not a POST");
  assert.doesNotMatch(cellWrite, /method: "POST"/);
  // And the route really does serve it from PATCH, so this cannot drift.
  const board = await read("app/api/board/route.ts");
  const patchAt = board.indexOf("export async function PATCH(");
  assert.ok(patchAt > 0 && board.indexOf('action === "update_cell"') > patchAt);

  // A register-only record: the register row, with the columns that PATCH
  // replaces sent back unchanged.
  assert.match(portal, /entity: "compliance"/);
  assert.match(portal, /siteId: target\.siteId/);
  assert.match(portal, /kind: target\.kind/);
  assert.match(portal, /state: target\.state/);
});

test("a failed write puts the record back", async () => {
  /*
   * A date that appears to move and silently does not is the worst outcome
   * available on this screen: the operator leaves believing the job was
   * rescheduled.
   */
  const portal = await read(PORTAL);
  const handler = portal.slice(
    portal.indexOf("const changeJobDate"),
    portal.indexOf("const changeComplianceDate"),
  );
  assert.match(handler, /catch \(error\)/);
  assert.match(handler, /request\.id === id \? before : request/, "the row is restored");
  assert.match(handler, /throw error/, "and the caller is told, so it can say why");
});

test("the calendar does not bypass the audit trail or the capability check", async () => {
  const portal = await read(PORTAL);
  // Job edits go through the route the board and the drawer already call, which
  // is what records the activity row and fires the automations.
  assert.match(portal, /persistRequestUpdate\(id, \{ fields:/);
  /* And the affordance asks the same question the server enforces. That check
     sits with the panel, which is the thing that draws the control. */
  const surface = await read(SURFACE);
  assert.match(surface, /useCapability\("board\.edit"\)/);
  assert.match(surface, /useCapability\("sites\.edit"\)/);
  assert.match(surface, /calendarEditCapability\(event\)/);
  const maintenance = await read("app/api/maintenance/route.ts");
  assert.match(maintenance, /scopedDbWithCapability\(request, "board\.edit"\)/);
});

test("an unanswered capability is not a denial", async () => {
  /*
   * `useCapability` is three-valued. Treating "not answered yet" as false would
   * flash the edit control off on every page load, which reads as a permissions
   * bug — see the header of client-capabilities.ts.
   */
  const surface = await read(SURFACE);
  assert.match(surface, /!== false/, "null means unknown, and unknown is not no");
});

/* ── The DOM contract acceptance reads ───────────────────────────────────── */

test("every rendered event states its own identity, source and day", async () => {
  /*
   * Proving a date has not shifted means comparing three numbers: the day the
   * chip claims, the day of the cell it sits in, and the value on the source
   * record. Inferring the first two by walking parent nodes makes every one of
   * those checks a hostage to the markup.
   */
  const views = await read(VIEWS);
  for (const attribute of [
    "data-calendar-event",
    "data-key",
    "data-kind",
    "data-record-id",
    "data-source",
    "data-field",
    "data-day",
    "data-timing",
  ]) {
    assert.match(views, new RegExp(`"${attribute}"`), `${attribute} is on every event`);
  }
  // And the container states its own day, so the two can be compared.
  assert.match(views, /data-calendar-day=""/);
  assert.match(views, /data-day=\{day\}/);
});

test("the chrome is addressable by role rather than by its visible word", async () => {
  const views = await read(VIEWS);
  for (const attribute of [
    "data-calendar-mode",
    "data-calendar-prev",
    "data-calendar-next",
    "data-calendar-today-button",
    "data-calendar-edit",
    "data-calendar-overflow",
  ]) {
    assert.match(views, new RegExp(attribute), `${attribute} is addressable`);
  }
  const controls = await read(CONTROLS);
  for (const attribute of [
    "data-calendar-sources",
    "data-calendar-filters",
    "data-calendar-colours",
    "data-source-toggle",
    "data-colour-for",
    "data-facet",
  ]) {
    assert.match(controls, new RegExp(attribute), `${attribute} is addressable`);
  }
});

/* ── Honest silences, and no invented events ─────────────────────────────── */

test("the four silences are told apart, and none of them draws an example", async () => {
  const surface = await read(SURFACE);
  assert.match(surface, /No date field is selected/);
  assert.match(surface, /Nothing matches these filters/);
  assert.match(surface, /Nothing is scheduled here/);
  const views = await read(VIEWS);
  assert.match(views, /Nothing is scheduled for \{label\}/, "and one day at a time");
});

test("no fixture, sample or generated event can reach this screen", async () => {
  /*
   * W04-03. The calendar reads `requests` and the compliance register and
   * nothing else — there is no generator, no sample import, and no branch that
   * manufactures an event when the workspace is empty.
   */
  const model = await read(MODEL);
  assert.doesNotMatch(model, /mock-data|sample|Math\.random|faker/i);
  const views = await read(VIEWS);
  assert.doesNotMatch(views, /mock-data|Math\.random|faker/i);
});

/* ── The page's own range ────────────────────────────────────────────────── */

test("the range filters days, not only records, and says what it removed", async () => {
  /*
   * The prefilter keeps a job if ANY selected date is in the window — right,
   * and necessary with four job date fields. On its own it then drew all of
   * that job's dates, including the ones outside, and the count beside the
   * range knew nothing about them.
   */
  const surface = await read(SURFACE);
  assert.match(surface, /if \(!withinPeriod\(request\.dueAt\)\) continue;/, "the record prefilter");
  assert.match(surface, /const withinPeriodDay/, "and the day the event falls on");
  assert.match(surface, /selectedEvents\.filter\(\(event\) => withinPeriodDay\(event\.day\)\)/);
  assert.match(surface, /calendar-period-notice/, "and it says how many it removed");
  assert.match(surface, /Show all dates/, "with one click to clear it");
  /* The range itself belongs to the HOST, so the panel takes a window rather
     than owning a PeriodPicker — the board's Calendar tab has no such control
     and passes null, which shows every date the records carry. */
  assert.match(surface, /periodWindow\?: CalendarPeriodWindow/);
  const portal = await read(PORTAL);
  assert.match(portal, /<PeriodPicker value=\{period\}/, "and the Planned page supplies one");
});

test("the calendar does not open on a backward-looking range", async () => {
  /*
   * "Last 90 days" is `now - 90 days … now + 1 day` — right for the analytics
   * pages this control came from, and wrong for a planning calendar, where it
   * hid everything due after tomorrow. Rescheduling a job from the 11th to the
   * 27th made it disappear the moment it saved.
   */
  const portal = await read(PORTAL);
  /* The dialog moved to calendar-surface.tsx, so the Planned view now ends
     where DocumentsView begins. */
  const view = portal.slice(
    portal.indexOf("function CalendarView("),
    portal.indexOf("function DocumentsView("),
  );
  assert.doesNotMatch(
    view,
    /useState\("(7|30|90|180|365|12m)"\)/,
    "a rolling backward window must not be the calendar's starting state",
  );
});

test("the calendar's state is its own, and does not reach other pages", async () => {
  /*
   * This product's date ranges are per page by decision. The calendar's period,
   * anchor, mode, sources and filters are local state and local storage keyed
   * to the calendar; nothing here writes a shared range.
   */
  const portal = await read(PORTAL);
  /* The dialog moved to calendar-surface.tsx, so the Planned view now ends
     where DocumentsView begins. */
  const view = portal.slice(
    portal.indexOf("function CalendarView("),
    portal.indexOf("function DocumentsView("),
  );
  assert.match(view, /const \[period, setPeriod\] = useState\("all"\)/, "its own period");
  assert.doesNotMatch(view, /setSection\(/, "and it does not steer the rest of the app");
  const prefs = await read(PREFS);
  assert.doesNotMatch(prefs, /maintsupp:(dashboard|reports|board):/, "no shared key");
});

/* ── Nothing may widen the page ──────────────────────────────────────────── */

test("no calendar surface can push the page sideways", async () => {
  /*
   * `.calendar-grid` in globals.css sets `min-width: 805px` with no scrolling
   * ancestor, which is exactly how the old calendar pushed a phone sideways.
   * The month table takes its width from its container; the week columns get a
   * width back only inside the element that owns the horizontal scroll.
   */
  const css = await read("app/(app)/portal/calendar-views.css");
  assert.match(css, /table-layout: fixed/);
  const scrollers = [...css.matchAll(/overflow-x:\s*auto/g)];
  assert.equal(scrollers.length, 1, "exactly one horizontal scroller, and it is the week");
  assert.match(css, /\.calendar-week__scroll \{[^}]*overflow-x:\s*auto/);
  for (const sheet of [
    "app/(app)/portal/calendar-views.css",
    "app/(app)/portal/calendar-controls.css",
    "app/(app)/portal/calendar-page.css",
  ]) {
    const source = await read(sheet);
    assert.doesNotMatch(source, /^\s*(html|body)\s*\{/m, `${sheet} must not restyle the page`);
  }
});
