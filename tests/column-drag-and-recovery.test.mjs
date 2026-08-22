/**
 * The Batch 1A acceptance correction: column drag, and recovery a person can
 * actually reach.
 *
 * WHAT A TEST HERE CAN AND CANNOT SAY
 *
 * The defect this file exists for passed every automated check that came before
 * it. `dragstart` was wired correctly, the reorder call was correct, and the
 * arithmetic was correct — and in a real browser nothing moved, because the
 * element carrying `draggable` was pointer-transparent. No unit test was ever
 * going to catch that, and none here claims to: the browser matrix in the
 * acceptance run is what says the gesture works.
 *
 * So this file tests the two things that ARE testable without a browser, and
 * says which is which:
 *
 *   · the ARITHMETIC — drop indices, the off-by-one when a column moves right,
 *     the frozen-region rule — by calling the real module with numbers;
 *   · the WIRING that the browser test cannot see the absence of: that the
 *     grab area is the cell and not the overlay, that a control's click is
 *     suppressed only after a real drag, that the fallback columns cannot be
 *     dragged, and that recovery is reachable from the portal navigation.
 *
 * `board-column-drag.ts` imports only a type, so it transpiles and runs alone.
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
  asModule(transpile(await read("app/(app)/portal/board-column-drag.ts")))
);

const header = await read("app/(app)/portal/board-column-header.tsx");
const board = await read("app/(app)/portal/live-board.tsx");
const css = await read("app/globals.css");

/** A column list shaped like the board's, thin enough to read in a failure. */
const columns = (...ids) =>
  ids.map((id) => ({
    kind: id === "name" ? "system" : "custom",
    key: id === "name" ? "name" : undefined,
    column: { id, pinned: false },
  }));

const ids = (list) => list.map((entry) => entry.column.id).join(",");

/* ── The arithmetic ──────────────────────────────────────────────────────── */

test("the drop index flips at the midpoint of a column, not at its edge", () => {
  const boxes = [
    { id: "a", left: 0, right: 100 },
    { id: "b", left: 100, right: 200 },
    { id: "c", left: 200, right: 300 },
  ];
  assert.equal(drag.columnDropIndex(10, boxes), 0);
  assert.equal(drag.columnDropIndex(49, boxes), 0);
  assert.equal(drag.columnDropIndex(51, boxes), 1, "past a's midpoint");
  assert.equal(drag.columnDropIndex(149, boxes), 1);
  assert.equal(drag.columnDropIndex(151, boxes), 2, "past b's midpoint");
  assert.equal(drag.columnDropIndex(999, boxes), 3, "after everything");
});

test("a column dropped one place right lands one place right", () => {
  // The off-by-one that makes a column look like it refuses to move: the gap
  // index counts the dragged column, the destination index does not.
  const order = columns("a", "b", "c", "d");
  assert.equal(ids(drag.moveColumnTo(order, "b", 3)), "a,c,b,d");
});

test("a column dropped one place left lands one place left", () => {
  const order = columns("a", "b", "c", "d");
  assert.equal(ids(drag.moveColumnTo(order, "c", 1)), "a,c,b,d");
});

test("a column can be carried across several positions in one drag", () => {
  const order = columns("a", "b", "c", "d", "e");
  assert.equal(ids(drag.moveColumnTo(order, "e", 1)), "a,e,b,c,d");
  assert.equal(ids(drag.moveColumnTo(order, "a", 5)), "b,c,d,e,a");
});

test("a drop that changes nothing returns the very same array", () => {
  const order = columns("a", "b", "c");
  // Identity, not equality: the caller uses it to decide whether to save.
  assert.equal(drag.moveColumnTo(order, "b", 1), order, "into its own left gap");
  assert.equal(drag.moveColumnTo(order, "b", 2), order, "into its own right gap");
  assert.equal(drag.moveColumnTo(order, "missing", 0), order, "unknown column");
});

test("nothing is lost or duplicated by a move", () => {
  const order = columns("a", "b", "c", "d", "e");
  for (let insertBefore = 0; insertBefore <= order.length; insertBefore += 1) {
    for (const id of ["a", "c", "e"]) {
      const next = drag.moveColumnTo(order, id, insertBefore);
      assert.equal(next.length, order.length, `length at ${id}->${insertBefore}`);
      assert.equal(
        [...next.map((entry) => entry.column.id)].sort().join(","),
        "a,b,c,d,e",
        `contents at ${id}->${insertBefore}`,
      );
    }
  }
});

/* ── The frozen leading region ───────────────────────────────────────────── */

test("the Items column and any pinned column count as frozen", () => {
  const [name, plain] = columns("name", "other");
  assert.equal(drag.isFrozenColumn(name), true, "Items is sticky by construction");
  assert.equal(drag.isFrozenColumn(plain), false);
  assert.equal(
    drag.isFrozenColumn({ kind: "custom", column: { id: "p", pinned: true } }),
    true,
    "pinned by request",
  );
});

test("frozen columns are pulled back to the front of the order", () => {
  const order = [
    { kind: "custom", column: { id: "a", pinned: false } },
    { kind: "system", key: "name", column: { id: "name", pinned: false } },
    { kind: "custom", column: { id: "p", pinned: true } },
    { kind: "custom", column: { id: "b", pinned: false } },
  ];
  // A frozen column between two scrolling ones cannot be drawn: its left offset
  // would sit on top of whatever scrolled under it.
  assert.equal(ids(drag.withFrozenColumnsLeading(order)), "name,p,a,b");
});

test("the frozen rule keeps the relative order inside each half", () => {
  const order = [
    { kind: "custom", column: { id: "p2", pinned: true } },
    { kind: "custom", column: { id: "b", pinned: false } },
    { kind: "custom", column: { id: "p1", pinned: true } },
    { kind: "custom", column: { id: "a", pinned: false } },
  ];
  assert.equal(ids(drag.withFrozenColumnsLeading(order)), "p2,p1,b,a");
});

test("with nothing pinned the frozen rule is the identity", () => {
  const order = columns("a", "b", "c");
  assert.equal(drag.withFrozenColumnsLeading(order), order);
});

test("the board says so when the frozen rule overrides the gesture", () => {
  // Silently disagreeing with a drag is what makes a board feel broken.
  assert.match(
    board,
    /Frozen columns stay at the left of the board\./,
    "a notice when the drop is corrected",
  );
  assert.match(board, /withFrozenColumnsLeading\(/, "and the rule is applied");
});

/* ── The drop indicator ──────────────────────────────────────────────────── */

test("the indicator names the header it would land before", () => {
  const order = columns("a", "b", "c", "d");
  assert.deepEqual(drag.columnDropMarker(order, "a", 2), {
    columnId: "c",
    side: "before",
  });
});

test("the indicator sits on the trailing edge for a drop at the end", () => {
  const order = columns("a", "b", "c");
  assert.deepEqual(drag.columnDropMarker(order, "a", 3), {
    columnId: "c",
    side: "after",
  });
});

test("there is no indicator for a drop that would change nothing", () => {
  const order = columns("a", "b", "c");
  assert.equal(drag.columnDropMarker(order, "b", 1), null);
  assert.equal(drag.columnDropMarker(order, "b", 2), null);
});

/* ── The wiring a browser test cannot see the absence of ─────────────────── */

test("the grab area is the header cell, never the centring overlay", () => {
  // The whole defect in one assertion: `strong` is absolutely positioned and
  // pointer-transparent, so a drag hung on it can never begin.
  assert.match(
    css,
    /\.custom-column-header > strong \{[^}]*pointer-events: none;/,
    "the overlay is still pointer-transparent",
  );
  assert.doesNotMatch(header, /<strong[^>]*\bdraggable\b/, "no draggable title");
  assert.doesNotMatch(header, /onDragStart|onDragOver|onDrop=/, "no HTML5 drag API");
  assert.match(header, /data-column-id=\{column\.id\}/, "the cell is identified");
  assert.match(header, /onPointerDown=\{onColumnPointerDown\}/, "and it is the grab area");
});

test("only the resize handle and an open menu refuse to start a drag", () => {
  // The sort arrow sits at the middle of a narrow header. Excluding it left the
  // grab area with a hole in it, which is how this failed the second time.
  const ignored = [...header.matchAll(/data-column-drag-ignore/g)];
  assert.equal(ignored.length, 2, "exactly two no-drag zones");
  assert.match(
    header,
    /className="custom-column-menu" data-column-drag-ignore/,
    "an open menu",
  );
  assert.match(
    header,
    /className="column-resize-handle"[\s\S]{0,400}?data-column-drag-ignore/,
    "and the resize handle",
  );
  assert.doesNotMatch(
    header,
    /className=\{`column-sort-indicator[\s\S]{0,120}?data-column-drag-ignore/,
    "the sort arrow is draggable",
  );
});

test("a real drag swallows the click that follows it, a press alone does not", () => {
  assert.match(board, /suppressColumnClickRef/, "the flag exists");
  assert.match(
    board,
    /suppressColumnClickRef\.current = true;/,
    "set when a drag completes",
  );
  assert.match(
    board,
    /if \(!suppressColumnClickRef\.current\) return;\s*\n\s*suppressColumnClickRef\.current = false;/,
    "and consumed by exactly one click",
  );
  assert.match(header, /onClickCapture=\{onColumnClickCapture\}/, "on the cell, in capture");
});

test("a press has to travel before it counts as a drag", () => {
  assert.equal(drag.COLUMN_DRAG_THRESHOLD, 4);
  assert.match(board, /COLUMN_DRAG_THRESHOLD/, "the board uses it");
});

test("the columns drawn before the snapshot lands cannot be dragged", () => {
  // Their ids are invented client-side, so a reorder would visibly undo itself
  // when the real columns arrived.
  assert.match(board, /if \(loadingBoard\) return;/, "the drag is refused while syncing");
  assert.match(board, /live-sheet\$\{loadingBoard \? " is-syncing" : ""\}/, "and says so");
  assert.match(
    css,
    /\.live-sheet\.is-syncing thead th\[data-column-id\] \{\s*cursor: progress;/,
    "with a waiting cursor rather than a grab one",
  );
});

test("touch keeps the menu's Move Left and Move Right, which stay wired", () => {
  // A pointer drag is a mouse gesture; the menu is the fallback, and the one
  // route a keyboard has to reordering.
  assert.match(board, /if \(event\.pointerType === "touch"\) return;/);
  assert.match(header, /Move column left/, "the menu still offers it");
  assert.match(header, /Move column right/);
});
