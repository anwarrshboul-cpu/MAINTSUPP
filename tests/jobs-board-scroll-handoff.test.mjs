import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * The grid must hand a vertical scroll on to the page.
 *
 * With `overscroll-behavior: contain` on both axes the wheel was trapped: page
 * parked part-way down, grid at its own top, and no number of wheel-ups over
 * the grid brought the meter cards back. Measured in a real browser at 1440x900
 * before the change (page stayed at y=420 through sixteen wheel-ups) and after
 * it (page returned to y=0 and the cards re-expanded, document height 1380px
 * throughout).
 */
const css = readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n");

function baseRule() {
  const match = css.match(/\n\.live-board-scroll \{\n([^}]*)\}/);
  assert.ok(match, "the base .live-board-scroll rule exists");
  return match[1];
}

test("the grid passes a finished vertical scroll up to the page", () => {
  assert.match(baseRule(), /overscroll-behavior:\s*contain auto;/);
});

test("the grid is not contained on the block axis by a later desktop rule", () => {
  assert.doesNotMatch(baseRule(), /overscroll-behavior(-y)?:\s*contain;/);
});
