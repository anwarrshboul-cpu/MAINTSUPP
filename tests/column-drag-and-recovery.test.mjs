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
/*
 * The pointer handlers live here rather than in live-board.tsx, which
 * stage-eight-board-split.test.mjs holds under 6,000 lines. The board keeps the
 * ORDER — what a new arrangement means and how it is saved — and hands the
 * gesture the three things it needs.
 */
const gesture = await read("app/(app)/portal/board-column-drag-gesture.ts");
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
  assert.match(gesture, /suppressClickRef/, "the flag exists");
  assert.match(gesture, /suppressClickRef\.current = true;/, "set when a drag completes");
  assert.match(
    gesture,
    /if \(!suppressClickRef\.current\) return;\s*\n\s*suppressClickRef\.current = false;/,
    "and consumed by exactly one click",
  );
  assert.match(header, /onClickCapture=\{onColumnClickCapture\}/, "on the cell, in capture");
});

test("a press has to travel before it counts as a drag", () => {
  assert.equal(drag.COLUMN_DRAG_THRESHOLD, 4);
  assert.match(gesture, /COLUMN_DRAG_THRESHOLD/, "the gesture uses it");
});

test("the columns drawn before the snapshot lands cannot be dragged", () => {
  // Their ids are invented client-side, so a reorder would visibly undo itself
  // when the real columns arrived.
  assert.match(gesture, /if \(loading\) return;/, "the drag is refused while syncing");
  assert.match(board, /loading: loadingBoard/, "and the board is what knows it is syncing");
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
  assert.match(gesture, /if \(event\.pointerType === "touch"\) return;/);
  assert.match(header, /Move column left/, "the menu still offers it");
  assert.match(header, /Move column right/);
});

test("the board owns the order and the gesture owns the pointer", () => {
  // The seam that keeps live-board.tsx under its size ceiling. The gesture
  // reaches for exactly three things and answers with handlers; it does not
  // know what saving an order means, and the board does not know what a
  // pointer is doing.
  assert.match(board, /useColumnHeaderDrag\(\{/, "the board calls the hook");
  assert.match(board, /onReorder: \(order\) => void applyColumnOrder\(order\)/);
  assert.doesNotMatch(gesture, /fetch\(/, "the gesture saves nothing itself");
  assert.doesNotMatch(gesture, /withFrozenColumnsLeading/, "and decides no policy");
});

/* ── Recovery a person can reach ─────────────────────────────────────────── */

const portal = await read("app/(app)/portal/portal-app.tsx");
const workspace = await read("app/(app)/portal/views/account-workspace.tsx");
const bin = await read("app/lib/recycle-bin.ts");
const trashRoute = await read("app/api/trash/route.ts");
const columnsRoute = await read("app/api/board/columns/route.ts");
const boardRoute = await read("app/api/board/route.ts");
const init = await read("db/init.ts");
const schema = await read("db/schema.ts");

test("the recycle bin is a portal section, not only a menu item", () => {
  // The bin, its API and its screen all existed. What did not exist was a way
  // to find them, which is the whole of the second acceptance failure.
  assert.match(portal, /\| "recycle-bin";/, "the section exists");
  assert.match(portal, /"recycle-bin": \{\s*\n\s*label: "Recycle Bin"/, "and is labelled");
  assert.match(portal, /"recycle-bin": "recycle-bin",/, "and has a route");
  assert.match(portal, /activeSurface === "recycle-bin" && <RecycleBinSection/, "and renders");
  assert.match(
    portal,
    /"audit",\s*\n(?:\s*\/\/[^\n]*\n)*\s*"recycle-bin",\s*\n\];/,
    "and is placed in the sidebar rather than left to fall through",
  );
});

test("the bin's nav entry is offered to whoever can restore", () => {
  const block = portal.slice(
    portal.indexOf('if (entry.key === "recycle-bin")'),
    portal.indexOf('if (entry.key !== "audit")'),
  );
  assert.match(block, /capabilities\?\.\["board\.edit"\] === true/);
});

test("there is one bin, mounted twice, not two bins", async () => {
  // The one requirement stated as a prohibition: do not build a second trash.
  const section = await read("app/(app)/portal/views/recycle-bin-section.tsx");
  assert.match(section, /import \{ AccountTrashPanel \} from "\.\/account-workspace"/);
  assert.match(section, /<AccountTrashPanel /);
  assert.doesNotMatch(section, /fetch\("\/api\/trash/, "it must not fetch the bin itself");
  const shell = await read("app/(app)/portal/views/account-shell.tsx");
  assert.match(shell, /<AccountTrashPanel/, "the account rail still mounts the same panel");
});

test("every kind the bin can hold has a name on screen", () => {
  const labels = workspace.slice(
    workspace.indexOf("const BIN_KIND_LABEL"),
    workspace.indexOf("export function AccountTrashPanel"),
  );
  // A kind with no entry rendered its raw database value — "board_view".
  for (const [writer, kind] of [
    ["sendJobsToBin", "job"],
    ["sendGroupToBin", "group"],
    ["sendBoardViewToBin", "board_view"],
    ["sendColumnToBin", "column"],
  ]) {
    assert.ok(bin.includes(`export async function ${writer}`), `${writer} exists`);
    assert.match(labels, new RegExp(`${kind}: "`), `${kind} has a label`);
  }
});

test("the bin says which of its two verbs the reader actually holds", () => {
  assert.match(trashRoute, /canRestore: can\(subject, "board\.edit"\)/);
  assert.match(trashRoute, /canPurge: can\(subject, "data\.delete"\)/);
  assert.match(workspace, /bin\.canRestore !== false &&/, "restore is drawn only when held");
  assert.match(workspace, /bin\.canPurge !== false &&/, "and so is delete for good");
  // The docblock claimed a client could not reach GET. A client holds board.view.
  assert.doesNotMatch(
    trashRoute,
    /can therefore see\s*\n \* nothing here/,
    "the corrected docblock must not restate the false claim",
  );
});

/* ── Recoverable columns ─────────────────────────────────────────────────── */

test("a deleted column keeps its row, and the row says it is in the bin", () => {
  assert.match(
    schema,
    /deletedAt: text\("deleted_at"\),\s*\n\s*deletedBy: text\("deleted_by"\),\s*\n\s*createdAt/,
  );
  // Additive and guarded, so an existing database gains the field without a
  // migration step anybody has to remember to run.
  assert.match(init, /\["maintenance_board_columns", "deleted_at", "TEXT"\]/);
  assert.match(init, /\["maintenance_board_columns", "deleted_by", "TEXT"\]/);
});

test("sending a column to the bin deletes nothing", () => {
  const send = bin.slice(
    bin.indexOf("export async function sendColumnToBin"),
    bin.indexOf("/* ── Restoring"),
  );
  assert.ok(send.length > 200, "the function exists");
  assert.doesNotMatch(send, /\.delete\(/, "no row is deleted — that is the whole point");
  assert.match(send, /entityType: "column"/, "it goes in the bin as a column");
  assert.match(send, /deletedAt,\s*\n\s*deletedBy:/, "and the column row is flagged");
  assert.match(send, /kept/, "the entry says the values were kept");
});

test("restoring a column brings back its arrangement, not just its visibility", () => {
  const restore = bin.slice(
    bin.indexOf("async function restoreColumn"),
    bin.indexOf("async function restoreBoardView"),
  );
  assert.match(restore, /deletedAt: null/);
  for (const field of ["position", "width", "settings", "visible", "pinned", "summary"]) {
    assert.match(restore, new RegExp(`${field}:`), `${field} is restored`);
  }
  // A column that returns at the far right, 160px wide and unpinned, has been
  // re-added rather than restored.
  assert.match(restore, /live\.sort\(/, "and the board is renumbered so it has a slot");
});

test("a column's cells are destroyed in exactly one place", () => {
  // Everything before the purge is reversible; nothing after it is.
  assert.match(trashRoute, /async function purgeColumn/);
  const purge = trashRoute.slice(
    trashRoute.indexOf("async function purgeColumn"),
    trashRoute.indexOf("async function purgeJob"),
  );
  assert.match(purge, /\.delete\(attachments\)/, "its files");
  assert.match(purge, /\.delete\(maintenanceBoardCells\)/, "then its values");
  assert.match(purge, /\.delete\(maintenanceBoardColumns\)/, "then the column");
  assert.match(trashRoute, /entityType === "column"\) return purgeColumn/, "and it is dispatched");

  // The route that used to destroy them must not any more.
  const routeDelete = columnsRoute.slice(columnsRoute.indexOf("export async function DELETE"));
  assert.match(routeDelete, /sendColumnToBin\(/);
  assert.doesNotMatch(routeDelete, /\.delete\(maintenanceBoardCells\)/);
  assert.doesNotMatch(routeDelete, /\.delete\(maintenanceBoardColumns\)/);
});

test("clearing a column still destroys, because that is what clearing is", () => {
  const block = boardRoute.slice(
    boardRoute.indexOf('if (action === "clear_column" || action === "delete_column")'),
    boardRoute.indexOf('if (action === "move_item")'),
  );
  assert.match(block, /if \(action === "clear_column"\) \{[\s\S]{0,400}deleteFilesForColumn/);
  assert.match(block, /\} else \{[\s\S]{0,300}sendColumnToBin\(/, "deleting goes to the bin instead");
  assert.match(block, /recoverable: action === "delete_column"/, "and the audit tells them apart");
});

test("the board cannot see, export or edit a column that is in the bin", async () => {
  // Enumerated rather than guessed: a single missed predicate leaves a deleted
  // column on somebody's board or in their export.
  for (const [name, source] of [
    ["app/api/board/route.ts", boardRoute],
    ["app/api/board/columns/route.ts", columnsRoute],
  ]) {
    const guards = source.match(/isNull\(maintenanceBoardColumns\.deletedAt\)/g) ?? [];
    assert.ok(guards.length >= 4, `${name} filters the bin in ${guards.length} places`);
  }
  const csv = await read("app/api/board/csv/route.ts");
  assert.match(csv, /isNull\(maintenanceBoardColumns\.deletedAt\)/, "including the export");
  const items = await read("app/api/board/items/route.ts");
  assert.match(items, /isNull\(maintenanceBoardColumns\.deletedAt\)/, "and a cell write");
  assert.match(
    columnsRoute,
    /DELIBERATELY UNFILTERED[\s\S]{0,700}?UNIQUE on \(organisation, board,/,
    "and the one query that must NOT be filtered says why",
  );
});

test("the column delete confirmation stopped saying it cannot be undone", () => {
  const body = board.slice(
    board.indexOf("const deleteCustomColumn"),
    board.indexOf("const saveCustomCell"),
  );
  // The sentence the person actually reads, not the note above it explaining
  // why that sentence changed.
  const confirm = body.slice(body.indexOf("window.confirm("), body.indexOf("setColumnMenuInstance"));
  assert.doesNotMatch(confirm, /cannot be undone/, "because it can");
  assert.match(confirm, /Recycle Bin/);
  assert.match(confirm, /30 days/);
});

test("the documented recovery model matches what the code now does", async () => {
  const matrix = await read("app/api/account/trash/route.ts");
  const columns = matrix.slice(
    matrix.indexOf('entity: "Board columns"'),
    matrix.indexOf('entity: "Files and evidence"'),
  );
  assert.match(columns, /softDelete: true/);
  assert.doesNotMatch(columns, /There is no recovery/, "the old line goes with the old behaviour");
  assert.match(matrix, /entity: "Board views"/, "views are documented too");
  assert.match(matrix, /entity: "Contractors"/);
});

test("a restored column is filed against the right entity in the audit", () => {
  assert.match(trashRoute, /column: "maintenance_board_column",/);
  assert.match(trashRoute, /action: "trash\.restored"/);
  assert.match(trashRoute, /action: "trash\.purged"/);
});
