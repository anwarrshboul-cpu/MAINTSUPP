/**
 * Audit — the board's phone controls are big enough to hit.
 *
 * Measured in Chromium at 390 and 320, every interactive control on the phone
 * board was under the 24px WCAG 2.5.8 asks for: the row/group checkbox at
 * 13x13, the drag grip 18 wide, the open-item button 22x26, the header sort
 * button 22x22. The grid's density is deliberate and is not changed here —
 * only the controls' own boxes grow, inside containers that already had the
 * room (a 42x38 header cell, a 168px name cell, a 151px header).
 *
 * The resize handle stays at 18px on purpose: it is an edge-anchored drag
 * affordance, not one of the tap targets, and widening it would push it under
 * the next column's sort button and eat the horizontal-scroll gesture.
 *
 * Source-pinned rather than measured, because the measurement needs a browser;
 * the browser run is what found these, and this is what keeps them.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

async function phoneBlock() {
  const css = await read("app/globals.css");
  const marker = "TOUCH TARGETS ON THE BOARD.";
  const at = css.indexOf(marker);
  assert.ok(at > 0, "the touch-target block has been removed");
  return css.slice(at);
}

test("the phone band the block uses is the board's own", async () => {
  const block = await phoneBlock();
  assert.ok(
    block.includes("@media (max-width: 760px)"),
    "the board's phone rules live at 760px in this file; the block must match",
  );
});

test("every control a finger has to hit is at least 24px", async () => {
  const block = await phoneBlock();
  const rule = (selector) => {
    const at = block.indexOf(selector + " {");
    assert.ok(at > 0, selector + " lost its touch-target rule");
    return block.slice(at, block.indexOf("}", at));
  };

  const checkbox = rule(".sheet-check input");
  assert.ok(checkbox.includes("width: 24px"), "the checkbox was 13x13");
  assert.ok(checkbox.includes("height: 24px"));

  assert.ok(
    rule(".sheet-row-grip").includes("min-width: 24px"),
    "the drag grip was 18 wide — a mis-hit starts a drag nobody asked for",
  );

  const open = rule(".sheet-open-item");
  assert.ok(open.includes("width: 24px"), "the open-item button was 22 wide");

  const sort = rule(".column-sort-indicator");
  assert.ok(sort.includes("width: 24px"), "the header sort button was 22x22");
  assert.ok(
    sort.includes("flex: 0 0 24px"),
    "the flex basis carries the width in that header row, so it has to move too",
  );
});

test("the resize handle is left alone, and the reason is written down", async () => {
  const block = await phoneBlock();
  assert.ok(
    block.includes("resize handle is deliberately left"),
    "if the handle is ever widened, the reason it was not must be revisited",
  );
  const at = block.indexOf("@media (max-width: 760px)");
  assert.ok(
    !block.slice(at).includes(".column-resize-handle"),
    "widening it would sit under the next column's sort button",
  );
});
