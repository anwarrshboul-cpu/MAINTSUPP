import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("the row menu offers everything monday's does", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const menu = board.slice(
    board.indexOf('<div className="sheet-row-menu"'),
    board.indexOf('<div className="sheet-row-menu"') + 3000,
  );
  for (const label of [
    "Open item",
    "Open in new tab",
    "Copy item link",
    "Duplicate item",
    "Create new item below",
    "Add subitem",
    "Convert to subitem",
    "Move to",
    "Archive item",
    "Delete item",
  ]) {
    assert.ok(menu.includes(label), `the row menu must offer "${label}"`);
  }
});

test("the column menu offers everything monday's does", async () => {
  /*
   * The heading and its menu live in board-column-header.tsx since Batch 1A —
   * live-board.tsx is held under 6,000 lines and the sort, filter, pin and
   * reorder controls took it past that. Nothing about the menu's contents
   * moved; four entries were ADDED, and they are asserted here too so the
   * board cannot quietly lose one of them either.
   */
  const menu = await read("app/(app)/portal/board-column-header.tsx");
  for (const label of [
    "Rename column",
    "Wrap text",
    "Sort ascending",
    "Add column to the right",
    "Duplicate column",
    "Collapse column",
    "Group by this column",
    "Change column type",
    "Hide column",
    "Delete column",
    // Batch 1A.
    "Add as a tie-breaker",
    "Filter this column",
    "Freeze column to the left",
    "Move column left",
  ]) {
    assert.ok(menu.includes(label), `the column menu must offer "${label}"`);
  }
});

test("a lossy column-type change asks before clearing values", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const fn = board.slice(board.indexOf("const changeColumnType = async"));
  // The API refuses until the caller confirms. Silently emptying cells is the
  // failure this exists to prevent.
  assert.match(fn.slice(0, 2500), /lossy-conversion/);
  assert.match(fn.slice(0, 2500), /window\.confirm/);
  assert.match(fn.slice(0, 2500), /changeColumnType\(column, type, true\)/);
});

test("collapsing a column narrows it rather than hiding it", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /const COLLAPSED_COLUMN_WIDTH = \d+;/);
  // Applied once where the columns are derived, so the header, the cells and
  // the summary row cannot disagree about a column's width.
  assert.match(board, /collapsedColumns\.has\(entry\.column\.id\)/);
  // Hide is still its own separate action — in the column menu, which lives in
  // board-column-header.tsx since Batch 1A split it out of live-board.tsx.
  const menu = await read("app/(app)/portal/board-column-header.tsx");
  assert.match(menu, /Hide column/);
  assert.match(menu, /Collapse column/);
});

test("grouping by a column writes nothing", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const fn = board.slice(board.indexOf("const displayGroups = useMemo"));
  assert.match(fn.slice(0, 1800), /synthetic: true/);
  // Renaming or deleting a column value cannot mean anything, so the controls
  // that would write are not drawn.
  assert.match(board, /\{!synthetic && \(/);
  // Switching it off must restore the stored grouping untouched.
  assert.match(board, /setGroupByColumn\(event\.target\.value \|\| null\)/);
});

test("re-parenting cannot corrupt the item tree", async () => {
  const route = await read("app/api/maintenance/route.ts");
  const block = route.slice(route.indexOf('if (typeof fields.parentId === "string"'));
  assert.match(block.slice(0, 2500), /An item cannot be its own parent/);
  assert.match(block.slice(0, 2500), /That parent item does not exist/);
  assert.match(block.slice(0, 2500), /Subitems cannot themselves have subitems/);
  assert.match(block.slice(0, 2500), /it cannot become one/);
});

test("Fix Tracker is the engineer dashboard, not a kanban", async () => {
  // `board-view-pane.tsx` since the chrome's view dispatch moved out of
  // `board-chrome.tsx` to keep it under its 500-line limit. Same branches.
  const pane = await read("app/(app)/portal/board-view-pane.tsx");
  // Keyed on the view's key, so an admin's own kanban views stay kanbans.
  assert.match(pane, /activeView\.key === "fix-tracker" && \(\s*<FixTrackerView/);
  assert.match(pane, /activeView\.key !== "fix-tracker" && \(\s*<KanbanView/);

  const view = await read("app/(app)/portal/views/fix-tracker.tsx");
  assert.match(view, /Maintenance Engineer Dashboard/);
  for (const label of ["Incoming Requests", "Jobs Booked"]) {
    assert.ok(view.includes(label), `the dashboard must have a ${label} tab`);
  }
  for (const label of [
    "Search by description",
    "All Locations",
    "Copy Link",
    "Issue Pictures",
    "Upload Completed Work Picture",
    "Date Completed",
    "Add Comment",
    "Submit Comment",
  ]) {
    assert.ok(view.includes(label), `the job panel must have "${label}"`);
  }
});

test("the Fix Tracker writes through the board's own endpoints", async () => {
  const view = await read("app/(app)/portal/views/fix-tracker.tsx");
  // A change made by an engineer is the same change made on the board — no
  // second write path to fall out of step.
  assert.match(view, /"\/api\/maintenance"/);
  assert.match(view, /uploadEvidenceFile/);
  assert.match(view, /kind: "completion"/);
  assert.match(view, /onChanged\?\.\(\)/);
});

test("board items expose the fields the views read", async () => {
  // The board passes MaintenanceRequest objects straight through. These three
  // were missing from the type, so a view that needed them reached into
  // `cells` — keyed by column id, not column key — and read nothing.
  const model = await read("app/(app)/portal/views/view-model.ts");
  for (const field of ["location?", "description?", "requester?"]) {
    assert.ok(model.includes(field), `BoardItem must declare ${field}`);
  }
});

test("the Fix Tracker panel is not covered by its own backdrop", async () => {
  const css = await read("app/brand-overrides.css");
  // `.modal-scrim` is redefined three times across the stylesheets — 90, 0,
  // then 500 — so the scrim is scoped down here rather than the panel being
  // raised to some number that happens to win today.
  assert.match(css, /\.fix-tracker__overlay \.modal-scrim \{\s*z-index: 0;/);
});
