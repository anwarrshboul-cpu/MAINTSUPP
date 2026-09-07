/**
 * CALENDAR — tapping a day on a phone opens the same Add Item the desktop opens.
 *
 * The desktop shortcut is a click on the EMPTY part of a month cell. A phone has
 * no empty part: the whole cell is one button, and its tap is also the only way
 * to point the agenda below the grid at a day. So the phone takes two taps —
 * select, then act — and the second one calls `onCreateOnDay`, the handler the
 * desktop cell already calls.
 *
 * What these assertions are really protecting is the SINGLENESS of that path.
 * There is one dialog, one create flow, one date. The failure this file exists
 * to catch is somebody adding a second, phone-only creation form, or wiring the
 * phone's tap to a date other than the cell's own.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Line endings are per file here and there is no .gitattributes, so normalise
   on the way in: every pattern below is written with bare newlines. */
const load = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const cssCode = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

const VIEWS = "app/(app)/portal/calendar-views.tsx";
const SURFACE = "app/(app)/portal/calendar-surface.tsx";
const DIALOG = "app/(app)/portal/manual-event-dialog.tsx";
const DIALOG_CSS = "app/(app)/portal/manual-event-dialog.css";

/** The `.calendar-month__pick` button — the phone's whole day cell. */
async function phoneDayButton() {
  const source = codeOnly(await load(VIEWS));
  const at = source.indexOf('className="calendar-month__pick"');
  assert.ok(at > 0, "the phone still draws one button per day");
  return source.slice(at, source.indexOf("</button>", at));
}

/* ------------------------------------------------- A + B. the tap and its day */

test("A: tapping the selected day opens Add Item, through the desktop's own handler", async () => {
  const button = await phoneDayButton();

  assert.match(
    button,
    /if \(selected && onCreateOnDay\) \{\s*\n\s*onCreateOnDay\(day\);/,
    "the second tap on an already-selected day opens the dialog, and it does so by calling onCreateOnDay — the same handler the desktop cell calls, not a phone-only copy",
  );
  assert.match(
    button,
    /onSelectDay\(day\)/,
    "and the first tap still selects, because that is the only way to point the agenda below the grid at a day",
  );
});

test("B: the date used is the cell's own day, never a shared cursor", async () => {
  const button = await phoneDayButton();

  assert.doesNotMatch(
    button,
    /onCreateOnDay\((?!day\))/,
    "the handler is called with this cell's `day` and nothing else — passing `selectedDay`, `anchor` or a formatted string is how an off-by-one appears",
  );

  const surface = codeOnly(await load(SURFACE));
  assert.match(
    surface,
    /onCreateOnDay=\{[\s\S]{0,220}\(day\) => \{\s*\n\s*setSelectedDay\(day\);/,
    "the surface selects the tapped day before opening, so the dialog opens on the cell that was tapped",
  );
  assert.match(
    surface,
    /defaultDay=\{selectedDay\}/,
    "and the dialog's default date reads that same selected day",
  );

  const dialog = codeOnly(await load(DIALOG));
  assert.match(
    dialog,
    /useState\(item\?\.startsOn \?\? defaultDay\)/,
    "which the form takes verbatim as its start date. A `new Date(...)` round trip here is where a tapped 15th becomes the 14th in a western timezone.",
  );
  assert.doesNotMatch(
    dialog,
    /new Date\(defaultDay\)/,
    "the day is a plain YYYY-MM-DD string end to end; parsing it into a Date and back is the off-by-one",
  );
});

/* --------------------------------------------- C. an existing job is not a day */

test("C: opening an existing entry never falls through to Add Item", async () => {
  const source = codeOnly(await load(VIEWS));

  assert.match(
    source,
    /if \(clicked\.target !== clicked\.currentTarget\) return;/,
    "on the desktop cell, only a click that landed on the cell itself creates — a click on a chip, the day number or '+N more' has a different target and falls through to that control",
  );

  const button = await phoneDayButton();
  assert.doesNotMatch(
    button,
    /<EventChip|onOpen\(/,
    "and the phone's day button contains no entry control to be confused with: these cells draw shape markers, and an existing job is opened from the agenda below the grid",
  );
});

/* ------------------------------------------- D + E. one create flow, one cancel */

test("D: there is one creation path, and the phone uses it", async () => {
  const surface = codeOnly(await load(SURFACE));

  assert.equal(
    (surface.match(/setManualEditing\("new"\)/g) ?? []).length,
    2,
    'exactly two openers — the toolbar "Add item" button and the calendar-day handler — and both set the same state',
  );
  assert.equal(
    (surface.match(/<ManualEventDialog/g) ?? []).length,
    1,
    "and one dialog renders it. A second phone-only form would be a second create flow to keep in step.",
  );

  const dialog = codeOnly(await load(DIALOG));
  assert.doesNotMatch(
    dialog,
    /isMobile|useMobile|window\.innerWidth/,
    "the dialog is responsive in CSS, not branched in JavaScript — a phone branch is two forms wearing one name",
  );
});

test("E: cancelling closes and writes nothing", async () => {
  const surface = codeOnly(await load(SURFACE));
  assert.match(
    surface,
    /onCancel=\{\(\) => setManualEditing\(null\)\}/,
    "cancel only clears the state that opened it",
  );
});

/* ------------------------------------------------- F. the sheet on a phone */

test("F: the mobile sheet is bounded, scrollable and clear of the chrome", async () => {
  const css = cssCode(await load(DIALOG_CSS));
  const at = css.indexOf("@media (max-width: 640px)");
  assert.ok(at > 0, "the phone treatment is still at the agreed 640 boundary");
  const phone = css.slice(at);

  assert.match(phone, /place-items: end stretch/, "it is a bottom sheet, not a shrunken desktop popover");
  assert.match(phone, /max-height: 92vh;\s*\n\s*max-height: 92dvh;/, "dvh second so it wins where it exists: on iOS Safari `vh` is the URL-bar-hidden viewport, which puts the bottom of the sheet — where Save is — under the browser chrome");
  assert.match(phone, /overflow-y: auto/, "a form taller than the sheet scrolls inside it");
  assert.match(
    phone,
    /padding-bottom: calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    "and the home indicator does not sit over the last control",
  );
  assert.match(phone, /min-height: 44px/, "the confirmations are a touch target");
  assert.match(
    phone,
    /flex-direction: column-reverse/,
    "with the primary action nearest the thumb",
  );
});

/* --------------------------------------------------- I + J. what must not move */

test("I: the Unscheduled tray is untouched by any of this", async () => {
  const tray = codeOnly(await load("app/(app)/portal/unscheduled-tray.tsx"));
  assert.match(tray, /function readCollapsedOnServer\(\): boolean \{\s*\n\s*return true;/, "still collapsed on first paint");
  assert.doesNotMatch(tray, /localStorage/, "still remembering nothing");

  const trayCss = cssCode(await load("app/(app)/portal/unscheduled-tray.css"));
  assert.match(trayCss, /touch-action: pan-y/, "a row still pans the list");
  assert.match(trayCss, /touch-action: none/, "and only the grip takes a touch drag");
});

test("J: the desktop cell keeps its own one-click shortcut", async () => {
  const source = codeOnly(await load(VIEWS));
  const desk = source.slice(source.indexOf('className="calendar-month__desk"'));
  assert.match(
    desk.slice(0, 600),
    /onClick: \(clicked: React\.MouseEvent<HTMLDivElement>\) => \{/,
    "the desktop still creates from a click on the empty part of the cell, in one gesture rather than two",
  );

  assert.match(
    source,
    /aria-pressed=\{selected\}/,
    "and both day controls still report their selected state to assistive technology",
  );
  const button = await phoneDayButton();
  assert.match(
    button,
    /Activate again to add an item/,
    "the phone's label says what the second activation does, so the two-step is not a secret",
  );
});
