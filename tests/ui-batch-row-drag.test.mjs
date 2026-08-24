/**
 * The row drag: the arithmetic, and the invariants that keep a swipe a swipe.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT CLAIM
 *
 * The defect this batch exists to fix could not be seen from Node. Dragging a
 * row on a phone half-worked: the row buzzed, faded, and died, and the board
 * scrolled or did not depending on how long a finger had rested before it
 * moved. Every part of that lives in the browser's gesture recogniser — in
 * whether a `touchmove` arrives `cancelable`, and in when Chrome decides a touch
 * sequence is blocking. No assertion here can reach it, and none pretends to;
 * the measured browser run in the batch report is what says the gesture works.
 *
 * So this file covers the two things that ARE reachable without a browser:
 *
 *   · the ARITHMETIC — drop targets, the gap a drop lands in, the order that
 *     comes out, the auto-scroll ramp — by calling the real module with
 *     numbers;
 *   · the WIRING whose ABSENCE a browser test cannot notice. A browser test
 *     that drags a row from a grip passes just as well when a hold timer has
 *     been left behind on the row beside it, and that timer is the whole bug.
 *     So the source is read for the shapes that must not come back: a hold
 *     timer, a fixed-step `scrollBy`, a per-move `elementFromPoint`, a touch
 *     press armed anywhere but a handle.
 *
 * `board-row-drag.ts` imports only a type, so it transpiles and runs alone.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

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

/*
 * `board-pinning.ts` imports a width helper for the OFFSETS half of the file.
 * Only the z-index half is under test here and it takes two numbers, so the
 * import is stripped rather than the whole board-format layer dragged in.
 */
const { stickyZIndex: pinningZ } = await import(
  asModule(
    transpile(
      (await read("app/(app)/portal/board-pinning.ts")).replace(
        /^import .*$/gm,
        "",
      ),
    ),
  )
);

/** A row under the pointer, as the gesture measures one. */
const hit = (over) => ({
  rowId: null,
  rowGroupId: null,
  rowTop: 0,
  rowHeight: 40,
  nextRowId: null,
  groupId: null,
  ...over,
});

/* ── Where a drop lands ──────────────────────────────────────────────────── */

test("the top half of a row drops before it, the bottom half after", () => {
  const over = hit({ rowId: "b", rowGroupId: "g1", rowTop: 100, rowHeight: 40, nextRowId: "c" });
  assert.deepEqual(drag.rowDropTargetFrom(over, 101), { groupId: "g1", beforeRequestId: "b" });
  assert.deepEqual(drag.rowDropTargetFrom(over, 119), { groupId: "g1", beforeRequestId: "b" });
  // Exactly the midpoint still counts as "before", so the boundary is decided
  // rather than left to whichever comparison ran first.
  assert.deepEqual(drag.rowDropTargetFrom(over, 120), { groupId: "g1", beforeRequestId: "b" });
  assert.deepEqual(drag.rowDropTargetFrom(over, 121), { groupId: "g1", beforeRequestId: "c" });
  assert.deepEqual(drag.rowDropTargetFrom(over, 139), { groupId: "g1", beforeRequestId: "c" });
});

test("the bottom half of the LAST row drops at the end of the group", () => {
  const over = hit({ rowId: "z", rowGroupId: "g1", rowTop: 0, rowHeight: 40, nextRowId: null });
  assert.deepEqual(drag.rowDropTargetFrom(over, 39), { groupId: "g1", beforeRequestId: null });
});

test("a group with no row under the pointer takes the drop at its end", () => {
  // This is the add-item row, the group footer and the empty group — all of
  // which must read as "put it at the bottom of this group" rather than as
  // nothing, or a drag onto an empty group could never land.
  assert.deepEqual(drag.rowDropTargetFrom(hit({ groupId: "g2" }), 500), {
    groupId: "g2",
    beforeRequestId: null,
  });
});

test("a row carries its own group, so a cross-group drop is resolved by the ROW", () => {
  // The row's group wins over the section the pointer is geometrically inside:
  // a sticky header or an overlapping outline can put the pointer inside one
  // section while it is over a row belonging to another.
  const over = hit({ rowId: "b", rowGroupId: "target", rowTop: 0, nextRowId: "c", groupId: "wrong" });
  assert.equal(drag.rowDropTargetFrom(over, 1).groupId, "target");
});

test("over nothing at all there is no target, so a drag released there cancels", () => {
  assert.equal(drag.rowDropTargetFrom(hit({}), 10), null);
  // …unless the drag itself supplies where it came from.
  assert.deepEqual(drag.rowDropTargetFrom(hit({}), 10, "home"), {
    groupId: "home",
    beforeRequestId: null,
  });
});

test("two targets naming the same gap compare equal, which is the render dedupe", () => {
  const a = { groupId: "g", beforeRequestId: "x" };
  assert.equal(drag.sameDropTarget(a, { groupId: "g", beforeRequestId: "x" }), true);
  assert.equal(drag.sameDropTarget(a, { groupId: "g", beforeRequestId: "y" }), false);
  assert.equal(drag.sameDropTarget(a, { groupId: "h", beforeRequestId: "x" }), false);
  assert.equal(drag.sameDropTarget(null, null), true);
  assert.equal(drag.sameDropTarget(a, null), false);
});

/* ── The order that comes out ────────────────────────────────────────────── */

test("a row dropped one place DOWN lands one place down", () => {
  // The classic off-by-one: lifting the row out shifts every index past it, so
  // an index-based move drops it back where it started and the row "refuses" to
  // move. Naming the gap by the row above it is what makes this hold.
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c", "d"], "a", "c"), ["b", "a", "c", "d"]);
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c", "d"], "b", "d"), ["a", "c", "b", "d"]);
});

test("a row dropped one place UP lands one place up", () => {
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c", "d"], "c", "b"), ["a", "c", "b", "d"]);
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c", "d"], "d", "a"), ["d", "a", "b", "c"]);
});

test("a null gap means the end of the group", () => {
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c"], "a", null), ["b", "c", "a"]);
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b", "c"], "c", null), ["a", "b", "c"]);
});

test("a move that changes nothing returns the SAME array, so callers can skip the save", () => {
  const order = ["a", "b", "c"];
  assert.equal(drag.rowOrderAfterMove(order, "b", "c"), order, "into its own trailing gap");
  assert.equal(drag.rowOrderAfterMove(order, "b", "b"), order, "onto itself");
  assert.equal(drag.rowOrderAfterMove(order, "c", null), order, "the last row to the end");
  assert.notEqual(drag.rowOrderAfterMove(order, "a", "c"), order, "a real move is a new array");
});

test("a row arriving from another group is inserted, not lost", () => {
  assert.deepEqual(drag.rowOrderAfterMove(["a", "b"], "new", "b"), ["a", "new", "b"]);
  assert.deepEqual(drag.rowOrderAfterMove([], "new", null), ["new"]);
});

test("the gap index is the length when the named row has already gone", () => {
  assert.equal(drag.rowDropIndex(["a", "b", "c"], "b"), 1);
  assert.equal(drag.rowDropIndex(["a", "b", "c"], null), 3);
  assert.equal(drag.rowDropIndex(["a", "b", "c"], "gone"), 3);
});

test("a cross-group drop always changes something; a same-place one does not", () => {
  const base = { order: ["a", "b", "c"], requestId: "b", sourceGroupId: "g1", targetGroupId: "g1" };
  assert.equal(drag.rowDropChangesOrder({ ...base, beforeRequestId: "c" }), false);
  assert.equal(drag.rowDropChangesOrder({ ...base, beforeRequestId: "b" }), false);
  assert.equal(drag.rowDropChangesOrder({ ...base, beforeRequestId: "a" }), true);
  assert.equal(
    drag.rowDropChangesOrder({ ...base, beforeRequestId: "c", targetGroupId: "g2" }),
    true,
    "the same position in a different group is still a move",
  );
});

/* ── When a press becomes a drag ─────────────────────────────────────────── */

test("A FINGER ANYWHERE BUT A HANDLE IS RELEASED TO THE BROWSER, ALWAYS", () => {
  // The invariant the whole batch turns on. Not "released unless it rested
  // first" — released, at every distance, including none, so that no branch can
  // ever prevent a pan that the compositor has already been promised.
  for (const distance of [0, 1, 3, 8, 40, 400]) {
    assert.equal(
      drag.rowDragDecision({ pointerType: "touch", distance, fromHandle: false, buttons: 1 }),
      "release",
      `a touch that has moved ${distance}px must belong to the scroller`,
    );
  }
});

test("a finger ON a handle drags, once it has travelled", () => {
  assert.equal(
    drag.rowDragDecision({ pointerType: "touch", distance: 1, fromHandle: true, buttons: 1 }),
    "wait",
  );
  assert.equal(
    drag.rowDragDecision({ pointerType: "touch", distance: 9, fromHandle: true, buttons: 1 }),
    "drag",
  );
});

test("a mouse press is a threshold and nothing else", () => {
  const press = (distance, buttons = 1) =>
    drag.rowDragDecision({ pointerType: "mouse", distance, fromHandle: false, buttons });
  assert.equal(press(0), "wait", "a stationary press is a click, however long it is held");
  assert.equal(press(3.9), "wait");
  assert.equal(press(4), "drag");
  assert.equal(press(40, 0), "release", "a mouse that lost its button has ended the press");
});

test("the handle threshold is the same one, so the actions button stays clickable", () => {
  // The desktop handle is the row's "..." button. A drag that armed on contact
  // would mean that button could never be clicked again.
  assert.equal(
    drag.rowDragDecision({ pointerType: "mouse", distance: 0, fromHandle: true, buttons: 1 }),
    "wait",
  );
});

/* ── The auto-scroll ramp ────────────────────────────────────────────────── */

test("the board does not creep until the pointer is inside the edge band", () => {
  assert.equal(drag.edgeScrollSpeed(0), 0);
  assert.equal(drag.edgeScrollSpeed(-30), 0);
});

test("THE SPEED RAMPS WITH PROXIMITY — it is not a fixed step", () => {
  // The old code moved the board 24px for every pointer event it happened to
  // receive, which is not a speed: it was zero for a still finger and whatever
  // the sample rate was for a moving one. Three samples across the band must be
  // strictly increasing, and the deepest must be far faster than the shallowest.
  const shallow = drag.edgeScrollSpeed(8);
  const middle = drag.edgeScrollSpeed(32);
  const deep = drag.edgeScrollSpeed(64);
  assert.ok(shallow > 0, "crossing the threshold at all must be visible");
  assert.ok(middle > shallow, `${middle} must exceed ${shallow}`);
  assert.ok(deep > middle, `${deep} must exceed ${middle}`);
  assert.ok(deep > shallow * 4, `the ramp must be steep: ${shallow} -> ${deep}`);
  assert.equal(deep, drag.ROW_DRAG_MAX_SPEED, "the band's far end is the top speed");
  assert.equal(drag.edgeScrollSpeed(4000), drag.ROW_DRAG_MAX_SPEED, "and it is a cap");
});

test("the middle of the board is still in both axes", () => {
  const box = { left: 0, top: 0, right: 1000, bottom: 800 };
  assert.deepEqual(drag.edgeScrollVector(500, 400, box), { x: 0, y: 0 });
});

test("a corner scrolls diagonally rather than picking an axis", () => {
  const box = { left: 0, top: 0, right: 1000, bottom: 800 };
  const corner = drag.edgeScrollVector(998, 798, box);
  assert.ok(corner.x > 0 && corner.y > 0, JSON.stringify(corner));
  const topLeft = drag.edgeScrollVector(2, 2, box);
  assert.ok(topLeft.x < 0 && topLeft.y < 0, JSON.stringify(topLeft));
});

test("the preview is clamped into its own width, so a wide row does not fling it away", () => {
  // A board row can be 4,000px wide and the preview is 320. An unclamped grab
  // offset would leave the preview a screen and a half from the pointer.
  assert.deepEqual(drag.ghostOffset(3800, 20, 320, 40), { x: 308, y: 20 });
  assert.deepEqual(drag.ghostOffset(140, 20, 320, 40), { x: 140, y: 20 });
  assert.deepEqual(drag.ghostOffset(0, -50, 320, 40), { x: 12, y: 0 });
});

test("THE PREVIEW'S WIDTH IS DERIVED, AND THE 320px CONSTANT IS GONE", () => {
  /*
   * `Math.min(Math.max(rect.width, 180), 320)` could only ever return 320:
   * `rect.width` is the whole row, ~4,200px on this board. So every preview on
   * every device was the same size — 22% of a 1440 desktop and 82% of a 390
   * phone, which is the "long flat duplicate strip" the complaint described.
   */
  const desktop = drag.ghostWidth({ rowWidth: 4961, nameWidth: 372, viewportWidth: 1440 });
  const phone = drag.ghostWidth({ rowWidth: 4208, nameWidth: 192, viewportWidth: 390 });
  assert.equal(desktop, 300, "a desktop preview is the ceiling, not the row");
  assert.ok(desktop / 1440 < 0.25, `${desktop} is ${Math.round((desktop / 1440) * 100)}% of a desktop`);
  assert.ok(
    phone / 390 >= 0.55 && phone / 390 <= 0.7,
    `${phone} is ${Math.round((phone / 390) * 100)}% of a phone, which must sit between 55% and 70%`,
  );
  // A person who widens the Name column gets a wider preview, up to the cap.
  assert.ok(
    drag.ghostWidth({ rowWidth: 4961, nameWidth: 240, viewportWidth: 1440 }) <
      drag.ghostWidth({ rowWidth: 4961, nameWidth: 290, viewportWidth: 1440 }),
  );
  // And on a very small screen it never touches the edges.
  const tiny = drag.ghostWidth({ rowWidth: 4208, nameWidth: 400, viewportWidth: 280 });
  assert.ok(tiny <= 280 - drag.GHOST_VIEWPORT_MARGIN, `${tiny} on a 280px screen`);
});

test("the preview is as tall as its row, floored and capped", () => {
  assert.equal(drag.ghostHeight(40), 40, "a desktop row");
  assert.equal(drag.ghostHeight(51), 48, "a phone row, capped so it stays a card");
  assert.equal(drag.ghostHeight(12), 38, "and a collapsed row is still a card");
});

test("A SCROLLED ROW DOES NOT START AT ITS OWN LEFT EDGE", () => {
  /*
   * The bug this pins: with the board scrolled 1,933px right, the row's
   * `rect.left` is -1,620 — a coordinate no pixel of it occupies. Measuring the
   * grab from there said the row had been grabbed 1,914px in, so `ghostOffset`
   * clamped it to the preview's width and hung the card 288px to the LEFT of
   * the finger. Measured before the fix: pointer at x 349, preview at x 61.
   */
  assert.equal(drag.visibleRowLeft(-1620, 279), 279, "the scroller's edge, once the row has slid past it");
  assert.equal(drag.visibleRowLeft(313, 279), 313, "and the row's own edge when it has not");
  // What that does to the grab offset, which is the number a person feels.
  const grabbedAt = 294;
  const bad = drag.ghostOffset(grabbedAt - -1620, 20, 300, 40).x;
  const good = drag.ghostOffset(grabbedAt - drag.visibleRowLeft(-1620, 279), 20, 300, 40).x;
  assert.equal(bad, 288, "the old measurement pinned the preview to its far edge");
  assert.equal(good, 15, "the new one keeps it under the finger");
});

test("THE DROP MARKS MOVE WITH THE BOARD, WITHOUT MEASURING IT AGAIN", () => {
  /*
   * The caret and the origin slot are attached to the GRID, and the grid moves
   * — the drag auto-scrolls at the edges. Re-measuring them per frame would be
   * a `getBoundingClientRect` per mark per frame on the one path that must not
   * touch layout. Nothing reflows during a drag, so a point measured once moves
   * by exactly minus the scroll since.
   */
  const frame = { scrollLeft: 0, scrollTop: 0, pageLeft: 0, pageTop: 0 };
  const mark = drag.anchorPoint(313, 545, frame);
  assert.deepEqual(drag.anchoredAt(mark, frame), { x: 313, y: 545 }, "still where it was");
  assert.deepEqual(
    drag.anchoredAt(mark, { scrollLeft: 700, scrollTop: 0, pageLeft: 0, pageTop: 0 }),
    { x: -387, y: 545 },
    "the board scrolled right, so the mark went left by the same amount",
  );
  assert.deepEqual(
    drag.anchoredAt(mark, { scrollLeft: 0, scrollTop: 120, pageLeft: 0, pageTop: 0 }),
    { x: 313, y: 425 },
  );
  // The window scrolling counts too, and in the same direction.
  assert.deepEqual(
    drag.anchoredAt(mark, { scrollLeft: 0, scrollTop: 0, pageLeft: 0, pageTop: 60 }),
    { x: 313, y: 485 },
  );
});

/* ── The wiring a browser test cannot see the absence of ─────────────────── */

test("THERE IS NO HOLD TIMER ANYWHERE IN THE ROW DRAG", async () => {
  // The regression that would undo the batch: any timer that can promote a
  // press to a drag re-creates the race with the compositor, and the browser
  // test would still pass because the handle would still work.
  assert.doesNotMatch(gesture, /setTimeout\([^)]*ROW_DRAG_HOLD|holdTimer/);
  assert.doesNotMatch(gesture, /HOLD_MS/);
  assert.doesNotMatch(board, /holdTimer/, "and none left behind in the board either");
});

test("a touch press that is not on a handle is never even recorded", () => {
  assert.match(
    gesture,
    /if \(event\.pointerType === "touch" && !fromHandle\) return;/,
    "the guard must be in pointerdown, before any state is written",
  );
});

test("the handle is the only touch drag, and both handles exist", async () => {
  assert.match(gesture, /\[data-board-row-handle\]/);
  // The phone grip and the desktop actions button both carry the attribute.
  const handles = board.match(/data-board-row-handle/g) ?? [];
  assert.equal(handles.length, 2, "one grip for touch, one for the pointer that has a cursor");
  // The grip's `touch-action` is load-bearing, so it is written where it cannot
  // be lost to a stylesheet edit in another lane.
  assert.match(board, /touchAction: "none"/);
});

test("THE TOUCH GRIP LIVES IN THE FROZEN COLUMN, NOT IN THE GUTTER", () => {
  /*
   * A phone freezes ONE column and it is the Name cell. The grip used to sit in
   * the 42px checkbox gutter beside it, which is no longer frozen — so the
   * handle rode away with the row: measured at x 1, -41, -599 and -1999 as
   * `scrollLeft` went 0, 42, 600, 2000. Past 42px of sideways scroll there was
   * no way to begin a touch drag at all, on a board 3,800px wider than the
   * screen. Whatever is frozen is where the handle has to be.
   */
  const grip = board.indexOf('className="sheet-row-grip"');
  const nameCase = board.indexOf('case "name": {');
  const itemCell = board.indexOf('<div className="sheet-item-cell">');
  const gutter = board.indexOf('<td className="sheet-check" data-board-popover>');
  assert.ok(grip > 0 && nameCase > 0 && itemCell > 0 && gutter > 0, "all four anchors exist");
  assert.ok(grip > nameCase, "the grip is inside the Name cell");
  assert.ok(grip < itemCell, "and it is the first thing in it, before the name itself");
  assert.ok(grip < gutter, "and it is no longer in the checkbox gutter");
  // Whatever moves, these two do not: the marker the gesture looks for and the
  // declaration that makes a touch drag possible at all.
  assert.match(board, /className="sheet-row-grip"\s+data-board-row-handle/);
  assert.match(board, /touchAction: "none"/);
  // Still exactly one grip, and still only drawn on a phone.
  assert.equal((board.match(/sheet-row-grip/g) ?? []).length, 1);
  assert.match(board, /\{mobile && \(\s+<button\s+type="button"\s+className="sheet-row-grip"/);
});

test("cell editing and text selection are no longer swallowed by the drag", () => {
  for (const control of ["input", "textarea", "select", "contenteditable"]) {
    assert.ok(
      gesture.includes(control),
      `${control} must be excluded from the drag grab area`,
    );
  }
  assert.match(gesture, /data-board-drag-ignore/, "and the existing marker still counts");
});

test("THE MOVE PATH TOUCHES NO DOM — the hit test is once a frame, not once a move", () => {
  // `elementFromPoint` forces a layout flush. Doing it per pointermove, and
  // writing a scroll in the same breath, is the read/write thrash that made a
  // drag along a row stutter.
  const move = gesture.slice(gesture.indexOf("const move = (native: PointerEvent)"));
  const body = move.slice(0, move.indexOf("const up = (native: PointerEvent)"));
  assert.doesNotMatch(body, /elementFromPoint|getBoundingClientRect|scrollLeft|scrollTop/);
  // It happens in the frame loop instead.
  assert.match(gesture, /requestAnimationFrame\(\(\) => stepRef\.current\(\)\)/);
  assert.match(gesture, /hitTestRow\(clientX, clientY\)/);
});

test("THE FIXED-STEP scrollBy IS GONE FROM THE BOARD", async () => {
  assert.doesNotMatch(board, /autoScrollBoardForDrag/);
  assert.doesNotMatch(board, /scrollBy\(0, -?verticalStep\)|horizontalStep/);
  // And the ramp is what replaced it.
  assert.match(gesture, /edgeScrollVector/);
});

test("the preview is a plain element on the body, not React state per move", () => {
  /* The preview became an OBJECT (`RowGhost`) rather than one bare div, so the
     element that lands on the body is its `root` and the transform is written
     through it. Same contract — a plain element on <body>, moved by transform,
     never React state — expressed against the new shape. */
  assert.match(gesture, /document\.body\.append\(root\)/);
  assert.match(gesture, /ghost\.root\.style\.transform = /);
});

test("NOTHING IN THE MOVE PATH WRITES REACT STATE — the indicator is classes", () => {
  /*
   * Measured in the dev build, dragging across twelve rows: with the indicator
   * in React state (written only when the gap CHANGED, which sounds cheap) the
   * p95 frame was 385ms and long tasks reached 517ms, against 27ms / none for
   * the same pointer path with no drag. Painting two class names instead took
   * the p95 to 106ms. So the only `useState` left may be the lifted row, which
   * changes twice in a whole drag.
   */
  assert.doesNotMatch(gesture, /useState/, "not one render between pick-up and put-down");
  assert.doesNotMatch(gesture, /setDropTargetState/);
  // The lifted row is painted the same way, for the same reason.
  assert.match(gesture, /classList\.add\("is-dragging"\)/);
  assert.match(gesture, /setAttribute\("aria-grabbed", "true"\)/);
  assert.match(gesture, /classList\.remove\("is-dragging"\)/);
  // The classes are the stylesheet's existing ones, so nothing about the look
  // changed with the mechanism.
  assert.match(gesture, /classList\.add\("is-drop-before"\)/);
  assert.match(gesture, /classList\.add\("is-drop-target"\)/);
  /* Formatted across lines once the call grew a third argument. */
  assert.match(gesture, /classList\.toggle\(\s*"is-drop-at-end"/);
  // And a render that rewrites className cannot silently drop it.
  assert.match(gesture, /reassertDropTarget/);
});

test("the board no longer recomputes the indicator for 38 groups per gap", () => {
  assert.doesNotMatch(board, /const isDropTarget =/);
  assert.doesNotMatch(board, /dropBefore/);
  assert.doesNotMatch(board, /draggingRequestId/);
  assert.doesNotMatch(board, /" is-dragging"/);
  // The class names may still be NAMED in the comment that explains where they
  // went; what must be gone is any expression that puts one in a className.
  assert.doesNotMatch(board, /" is-drop-at-end"/);
  assert.doesNotMatch(board, /" is-drop-target"/);
  assert.match(board, /are missing on purpose: the drag\s+\* writes both directly/);
});

test("DROPPING A ROW BACK WHERE IT STARTED MOVES NOTHING", () => {
  /*
   * `.live-sheet tbody tr.is-dragging` carries `pointer-events: none`, so the
   * lifted row is invisible to `elementFromPoint` and the gap it left reads as
   * the bare `<table>`. Taken at face value that is "this group, at the end",
   * so picking a row up and putting it straight back sent it to the BOTTOM of
   * its group. Measured before the fix: one PATCH for a drag that travelled
   * 12px and came back; after: none.
   */
  assert.match(gesture, /function rowSpanning\(group: HTMLElement, clientY: number\)/);
  assert.match(gesture, /const spanned = group \? rowSpanning\(group, clientY\) : null;/);
  assert.match(gesture, /if \(spanned\) return spanned;/);
  // And the pure side already refuses a drop onto the row's own place.
  assert.equal(
    drag.rowDropChangesOrder({
      order: ["a", "b", "c"],
      requestId: "b",
      beforeRequestId: "b",
      sourceGroupId: "g",
      targetGroupId: "g",
    }),
    false,
  );
});

test("THE HIT TEST IS MEMOISED — a tremor inside a row costs no layout flush", () => {
  // `elementFromPoint` forces layout over 101,000 elements. Most movement in a
  // drag is within one row, where the answer cannot have changed.
  assert.match(gesture, /function hitTestRowCached\(/);
  assert.match(gesture, /cached\.scrollLeft === scrollLeft/, "a scroll invalidates it");
  assert.match(gesture, /clientY <= cached\.bottom/, "so does leaving the box");
  assert.match(gesture, /function resetHitTest\(\)/, "and a new drag starts clean");
  assert.match(gesture, /hitTestRowCached\(clientX, clientY, scroller\)/);
});

test("THE TWO DROP MARKS ARE PINNED TO WHAT IS ON SCREEN", () => {
  /*
   * Both marks are as wide as the preview and start at the ROW's left edge,
   * which on a board scrolled 1,933px right is x -1,306: the caret telling you
   * where the item lands was drawn entirely off the left of the screen at every
   * scroll position but zero. What IS visible of the row there is its sticky
   * gutter and Name column, against the scroller's left edge, so that is the
   * floor. Measured after: caret at x 279 = the scroller's own left edge, at
   * scrollLeft 1,933 and 3,865 alike.
   */
  assert.match(gesture, /const x = Math\.max\(at\.x, clampLeft\);/);
  assert.match(gesture, /placeMark\(pointer\.caret, pointer\.caretAt, frame, clampLeft\)/);
  assert.match(gesture, /placeMark\(pointer\.slot, pointer\.slotAt, frame, clampLeft\)/);
  // And the box it comes from is the one the edge-scroll bands already read,
  // so the frame still costs exactly one rect.
  assert.match(gesture, /const box = scroller \? scroller\.getBoundingClientRect\(\) : null;/);
});

test("a lifted row is animated, and NOT when the person asked for less motion", () => {
  assert.match(gesture, /function prefersReducedMotion\(\)/);
  assert.match(gesture, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  // Both the lift and the settle bail out before they animate a transform.
  assert.match(gesture, /if \(prefersReducedMotion\(\) \|\| typeof ghost\.lift\.animate !== "function"\) return;/);
  assert.match(gesture, /if \(!to \|\| prefersReducedMotion\(\) \|\| typeof root\.animate !== "function"\)/);
  /* The per-frame transform write stays on the ROOT and the scale lives on the
     child, so a running lift can never fight the loop for one property. */
  assert.match(gesture, /ghost\.root\.style\.transform = /);
  assert.match(gesture, /ghost\.lift\.animate\(/);
});

test("an abandoned drag flies home, and a committed one lands in the gap", () => {
  // Escape and pointercancel both ask for the return trip; a plain release does
  // not, because it has a real destination to settle into.
  assert.match(gesture, /clearDrag\(true\)/);
  assert.match(gesture, /const clearDrag = useCallback\(\s*\(home = false\) => \{/);
  // The preview is detached from the pointer BEFORE teardown, or teardown would
  // remove the element the animation is running on.
  assert.match(gesture, /const flying = pointer\.ghost;\s*pointer\.ghost = null;/);
  // Which means a settling preview belongs to nobody, so unmount sweeps it.
  assert.match(gesture, /\.board-row-ghost, \.board-row-drop-caret, \.board-row-drop-slot/);
});

test("the drag is torn down on unmount, drop and cancel alike", () => {
  /* The unmount cleanup gained a sweep for stray preview elements, so it is no
     longer a one-line effect — pin the teardown call and the sweep instead. */
  assert.match(gesture, /useEffect\(\s*\(\) => \(\) => \{\s*teardown\(pointerRef\.current\);/);
  assert.match(
    gesture,
    /\.board-row-ghost, \.board-row-drop-caret, \.board-row-drop-slot/,
    "unmount must remove any preview element left on the body",
  );
  assert.match(gesture, /cancelAnimationFrame\(pointer\.frame\)/);
  assert.match(gesture, /pointer\.ghost\?\.root\.remove\(\)/);
  assert.match(gesture, /removeEventListener\("pointermove", listeners\.move\)/);
});

test("the gesture is heard from the document, not only from the row it started on", () => {
  // A drag pulled straight out of a group passes over the add-item row, the
  // group footer and the next group's header, none of which is a `<tr>`. Rows
  // alone cannot hear it, and the row would not lift until the pointer crossed
  // another one.
  assert.match(gesture, /document\.addEventListener\("pointermove", move\)/);
  assert.match(gesture, /document\.addEventListener\("pointerup", up\)/);
  assert.match(gesture, /document\.addEventListener\("pointercancel", cancel\)/);
});

test("persistence is untouched: the board still owns move_item and its rollback", () => {
  assert.match(board, /action: "move_item"/);
  assert.match(board, /setItems\(beforeItems\)/, "the optimistic rollback stays");
  assert.match(board, /useBoardRowDrag\(\{/);
  assert.match(board, /onDrop: \(item, target\) =>/);
});

/* ── The frozen columns the scroll slides under ──────────────────────────── */

test("A FROZEN HEADER OUTRANKS AN ORDINARY ONE", async () => {
  // `.live-sheet th` is `calc(var(--z-sticky) + 1)` = 41. The old base was 15,
  // so every unpinned header painted OVER the pinned header it was supposed to
  // slide beneath — which is the left edge going wrong halfway through a scroll.
  const css = await read("app/globals.css");
  assert.match(css, /--z-sticky:\s*40;/, "the token this arithmetic is pinned to");
  for (let order = 0; order < 12; order += 1) {
    const z = pinningZ(order, true);
    assert.ok(z > 41, `a frozen header at order ${order} is ${z}, under an ordinary header`);
    assert.ok(z < 46, `a frozen header at order ${order} is ${z}, over the Items header`);
  }
});

test("a frozen cell never falls behind the rows scrolling under it", () => {
  // The old expression went negative at eleven pins, which would have dropped a
  // frozen cell below the unpositioned cells entirely.
  for (let order = 0; order < 40; order += 1) {
    assert.ok(pinningZ(order, false) > 0, `order ${order} must stay positive`);
    assert.ok(pinningZ(order, false) < 42, `order ${order} must stay under the Items column`);
  }
});

test("earlier frozen columns still sit above later ones", () => {
  assert.ok(pinningZ(0, true) > pinningZ(1, true));
  assert.ok(pinningZ(0, false) > pinningZ(1, false));
  assert.ok(pinningZ(1, true) > pinningZ(2, true));
});

test("the add-item cell is given the frozen offsets the rest of the row has", () => {
  // It was the one cell nobody passed them to, and it got away with it only
  // because `.sheet-column--name { left: 72px }` happens to equal what
  // `stickyColumnOffsets` computes for Items when Items is frozen first.
  assert.match(board, /const stickyCellStyle = \(columnId: string\)/);
  assert.match(board, /\.\.\.stickyCellStyle\(column\.id\),/);
  assert.match(board, /sheet-column--name sheet-add-row__item/);
});

test("the popover no longer scrolls the board when it is already on screen", async () => {
  const primitives = await read("app/(app)/portal/board-primitives.tsx");
  assert.match(primitives, /rect\.left >= box\.left/);
  assert.match(primitives, /return;\s*\n\s*\}\s*\n\s*\}\s*\n\s*popover\.scrollIntoView/);
});
