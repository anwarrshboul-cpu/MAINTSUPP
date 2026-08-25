/**
 * Deep-audit D1 regressions: the row drag's sideways creep, and the two pieces
 * of copy/configuration that disagreed with the gesture they describe.
 *
 * WHAT THESE PIN, AND WHY THEY ARE SOURCE READS
 *
 * All three defects were found in a real browser (Chromium, touch context via
 * CDP `Input.dispatchTouchEvent`, at 430/390/375/360/320) and the measurements
 * live in the batch report. None of them can be *reproduced* from Node: the
 * first needs a compositor and a sticky cell, the other two are what a phone's
 * keyboard and tooltip do. So what is pinned here is the SHAPE whose absence a
 * browser test cannot notice — the same approach, and for the same stated
 * reason, as `tests/ui-batch-row-drag.test.mjs`.
 *
 * These are additive. Nothing in the existing row-drag suite is weakened; in
 * particular `edgeScrollVector` is deliberately left two-axis and its
 * "a corner scrolls diagonally" test still passes, because the arithmetic was
 * never wrong — it is the ROW gesture that has no sideways drop.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
/* CRLF-safe: this repo has been bitten by a baseline that only matched on LF. */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const drag = await import(
  asModule(transpile(await read("app/(app)/portal/board-row-drag.ts")))
);
const gesture = await read("app/(app)/portal/board-row-drag-gesture.ts");
const board = await read("app/(app)/portal/live-board.tsx");

/** The frame loop, as a string — everything the drag does once per animation frame. */
const step = (() => {
  const start = gesture.indexOf("const step = useCallback(");
  assert.ok(start > 0, "the frame loop should still be called `step`");
  const end = gesture.indexOf("const activate = useCallback(", start);
  assert.ok(end > start, "…and `activate` should still follow it");
  return gesture.slice(start, end);
})();

/*
 * DEFECT D1-2. The phone's only touch handle is `.sheet-row-grip`, drawn at
 * `left: 0` inside the FROZEN Name cell. Once the 42px checkbox gutter has
 * scrolled off, that cell sticks to the scroller's left edge and the grip sits
 * at x 1–25 — permanently inside the 64px `ROW_DRAG_EDGE` band, with nowhere
 * else for a finger to start. So applying the x component of the edge-scroll
 * was not an occasional annoyance: it ran on EVERY phone drag. Measured at
 * `scrollLeft` 1500, a pure vertical grip drag drove it to 0 in about half a
 * second, at all five widths, and cancelling did not put it back.
 */
test("a row drag creeps vertically only — the frame loop never writes scrollLeft", () => {
  assert.ok(
    !/scroller\.scrollLeft\s*[+-]?=/.test(step),
    "the row drag's frame loop must not write scroller.scrollLeft: the touch " +
      "handle lives permanently inside the left edge-scroll band, so any " +
      "sideways creep fires on every phone drag and throws the reader back to " +
      "the Name column mid-gesture.",
  );
  assert.ok(
    /scroller\.scrollTop\s*\+=\s*velocity\.y/.test(step),
    "…while the VERTICAL creep must stay: that is how a drag reaches a group " +
      "that is off the bottom of the screen.",
  );
  assert.ok(
    !/velocity\.x/.test(step),
    "the x component must not be consumed at all, so it cannot creep back in",
  );
});

test("the drop target is a function of clientY alone, which is why x may be dropped", () => {
  /*
   * The justification for the assertion above, expressed as arithmetic rather
   * than as a claim: two hits that differ ONLY in horizontal position resolve
   * to the same gap. If this ever stops being true, dropping the x axis stops
   * being safe and the test above must be revisited rather than deleted.
   */
  const hit = {
    rowId: "MN-2",
    rowGroupId: "g1",
    rowTop: 100,
    rowHeight: 40,
    rowLeft: 0,
    nextRowId: "MN-3",
    groupId: "g1",
  };
  const near = drag.rowDropTargetFrom({ ...hit, rowLeft: 0 }, 110, null);
  const far = drag.rowDropTargetFrom({ ...hit, rowLeft: -3800 }, 110, null);
  assert.deepEqual(near, far);
  assert.deepEqual(near, { groupId: "g1", beforeRequestId: "MN-2" });
});

test("edgeScrollVector itself is left alone, two-axis and honest about corners", () => {
  /*
   * Explicitly NOT weakened. The shared arithmetic still answers both axes —
   * it is right, and something that can be dropped sideways would need it.
   * The decision that a ROW has no sideways drop belongs to the gesture.
   */
  const box = { left: 0, top: 0, right: 1000, bottom: 800 };
  const topLeft = drag.edgeScrollVector(2, 2, box);
  assert.ok(topLeft.x < 0 && topLeft.y < 0, JSON.stringify(topLeft));
});

/*
 * DEFECT D1-1. Every `<tr>` carried
 * "Drag to move this row; on a touch screen, press and hold first".
 * `rowDragDecision` returns "release" for any touch that did not begin on a
 * handle, however long it rests, so press-and-hold is precisely the gesture
 * that does nothing — the tooltip instructed the failure the rewrite existed
 * to remove.
 */
test("the row tooltip does not tell a finger to press and hold", () => {
  const title = /<tr[\s\S]{0,2000}?title="([^"]*)"/.exec(board);
  assert.ok(title, "the board row should still carry a title");
  assert.ok(
    !/press and hold/i.test(title[1]),
    `the row tooltip still says "press and hold": ${title[1]}`,
  );
  assert.match(title[1], /grip/i, "…and should point a finger at the grip instead");
});

test("a touch that did not start on a handle is still released, whatever it does", () => {
  /* The behaviour the tooltip now describes, asserted against the real module. */
  for (const distance of [0, 3, 4, 40, 400]) {
    assert.equal(
      drag.rowDragDecision({
        pointerType: "touch",
        distance,
        fromHandle: false,
        buttons: 1,
      }),
      "release",
      `a finger off the handle must be released at distance ${distance}`,
    );
  }
  /* And from the handle it still has to travel, so the "⋮" stays clickable. */
  const onHandle = (distance) =>
    drag.rowDragDecision({ pointerType: "touch", distance, fromHandle: true, buttons: 1 });
  assert.equal(onHandle(3), "wait");
  assert.equal(onHandle(4), "drag");
});

/*
 * DEFECT D1-4. The `number` column is of type `phone` and is backed by
 * `request.contact`, but its hard-coded cell passed no `inputMode`, so a phone
 * raised the alphabetic keyboard. The generic custom-column path in the same
 * file already maps phone -> "tel"; only the system case disagreed.
 */
test("the phone-number cell asks for a telephone keypad", () => {
  const start = board.indexOf('case "number":');
  assert.ok(start > 0, "the number column should still have its own case");
  const block = board.slice(start, start + 900);
  assert.match(
    block,
    /inputMode="tel"/,
    'the "number" column is a phone column; without inputMode="tel" a phone ' +
      "shows the alphabetic keyboard for a phone number",
  );
  assert.match(block, /request\.contact/, "…and it should still be the contact field");
});

test("the money cell still asks for a numeric keypad", () => {
  /* The neighbour that was already right, pinned so a refactor cannot drop it. */
  const start = board.indexOf('case "cost":');
  assert.ok(start > 0);
  assert.match(board.slice(start, start + 900), /inputMode="decimal"/);
});
