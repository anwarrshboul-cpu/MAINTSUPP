/**
 * Stage 28 — relative dates on the maintenance date cells.
 *
 * The last open item from the 9 August brief: "Relative date display ('Today',
 * 'In 3 days') is on the Store Documentation expiry cells but not the
 * maintenance date cells."
 *
 * It was true. The Store Documentation expiry columns have carried a temporal
 * read since Stage 15 — "Expires today", "Due soon", "Expired" — while Date
 * Requested, Date Completed and Next Update rendered a bare
 * `<input type="date">`. On Next Update, the column that drives the chase
 * carried over from monday, the only thing worth knowing about the value is
 * whether it is behind you, and the cell made the reader work it out.
 *
 * The logic is a pure function so it can be checked here against a fixed today,
 * rather than by rendering a grid and hoping the clock cooperates.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/*
 * The module is TypeScript and imports nothing, so rather than add a build step
 * for one function the source is compiled in place: the type annotations are
 * stripped and the body evaluated. If the function ever grows a dependency this
 * throws loudly rather than testing a stale copy.
 */
async function loadRelativeDayLabel() {
  const source = await read("app/(app)/portal/board-format.ts");
  const start = source.indexOf("export function relativeDayLabel");
  assert.ok(start > 0, "relativeDayLabel has moved; fix this test");

  const dateInputValue = (value) => {
    if (!value) return "";
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  };

  const body = source
    .slice(start)
    .replace(/^export function relativeDayLabel\([^)]*\)[^{]*\{/, "function relativeDayLabel(value, now) {");
  // Take just this function, to its closing brace at column 0.
  const end = body.indexOf("\n}\n");
  const fn = body.slice(0, end + 3).replace(/: string \| null/g, "").replace(/: Date/g, "");
  // eslint-disable-next-line no-new-func
  return new Function("dateInputValue", `${fn}; return relativeDayLabel;`)(dateInputValue);
}

const TODAY = new Date(2026, 7, 13); // 13 August 2026, local midnight.

test("today, tomorrow and yesterday are named rather than counted", async () => {
  const label = await loadRelativeDayLabel();
  assert.equal(label("2026-08-13", TODAY), "Today");
  assert.equal(label("2026-08-14", TODAY), "Tomorrow");
  assert.equal(label("2026-08-12", TODAY), "Yesterday");
});

test("the fortnight either side counts, and beyond it says nothing", async () => {
  const label = await loadRelativeDayLabel();
  assert.equal(label("2026-08-16", TODAY), "In 3 days");
  assert.equal(label("2026-08-08", TODAY), "5 days ago");
  assert.equal(label("2026-08-27", TODAY), "In 14 days", "the window is inclusive");
  assert.equal(label("2026-07-30", TODAY), "14 days ago");

  /*
   * Outside it, null — and the cell then shows the date alone.
   * "In 94 days" is arithmetic nobody wants to run backwards, and a board with
   * 744 rows would carry hundreds of them.
   */
  assert.equal(label("2026-08-28", TODAY), null);
  assert.equal(label("2026-07-29", TODAY), null);
  assert.equal(label("2026-11-15", TODAY), null);
});

test("a timestamp is the day it falls on, not the day after", async () => {
  const label = await loadRelativeDayLabel();
  /*
   * The column holds two shapes — a plain date from the importer and an ISO
   * timestamp from the app. Compared at local midnight on both sides, so an
   * afternoon entry today reads "Today" rather than "Tomorrow" west of UTC.
   */
  assert.equal(label("2026-08-13T16:40:00.000Z", TODAY), "Today");
  assert.equal(label("2026-08-14T00:30:00.000Z", TODAY), "Tomorrow");
});

test("empty and malformed values are silent, not wrong", async () => {
  const label = await loadRelativeDayLabel();
  for (const value of [null, undefined, "", "not a date", "2026-13-45"]) {
    assert.equal(label(value, TODAY), null, `${String(value)} must not produce a label`);
  }
});

test("the maintenance date cell renders it, and the expiry cell is untouched", async () => {
  const cells = await read("app/(app)/portal/board-cells.tsx");

  assert.match(cells, /relativeDayLabel,/, "imported from board-format");
  assert.match(cells, /const relative = relativeDayLabel\(currentDate, new Date\(\)\)/);
  assert.match(cells, /className="sheet-date__relative"/);
  assert.match(
    cells,
    /aria-hidden="true"/,
    "the input already announces its value; the hint must not be read twice",
  );

  /*
   * The expiry cells keep their own verdict. They answer a different question —
   * a legal position rather than a schedule — and doubling the two would put
   * "Expired" and "5 days ago" in the same 145px cell.
   */
  const expiry = await read("app/(app)/portal/cells/expiry-cell.tsx");
  assert.doesNotMatch(expiry, /relativeDayLabel/, "expiry cells keep their RAG verdict");
});

test("the hint cannot swallow a click meant for the input", async () => {
  const css = await read("app/globals.css");
  const rule = css.slice(css.indexOf(".sheet-date__relative"), css.indexOf(".sheet-date__relative") + 260);
  assert.match(rule, /pointer-events: none/, "the cell must still click through to the date input");
});
