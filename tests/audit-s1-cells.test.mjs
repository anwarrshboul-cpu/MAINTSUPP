/**
 * Audit S1 — board cell editing contracts.
 *
 * Browser-verified 2026-08-25 on QA fixtures (see the audit report): text
 * valid/Escape/click-away, contractor blank->null, date set/clear, priority,
 * status, assignee, rapid consecutive edits, and rollback on a failed PATCH.
 * These pins hold the two contracts that were actually broken or nearly so.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("an unparseable cost is refused, not saved as null", async () => {
  // Number("abc") is NaN and JSON.stringify({cost: NaN}) is '{"cost":null}',
  // which the server obediently treats as "clear the cost" — so before the
  // guard, a typo in the cost cell DELETED the recorded amount. Blank still
  // clears deliberately; only a finite number may travel.
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(
    board,
    /const cost = value\.trim\(\) \? Number\(value\) : null;\s*\n\s*if \(cost === null \|\| Number\.isFinite\(cost\)\) onSave\(\{ cost \}\);/,
    "the cost cell must gate NaN before onSave",
  );
});

test("a failed field save rolls the row back and tells the user", async () => {
  // saveFields paints the optimistic row first; the catch must restore the
  // original row (onRequestChange(request)) — browser-verified by aborting the
  // PATCH: the cell reverted and a toast reported the failure.
  const board = await read("app/(app)/portal/live-board.tsx");
  const start = board.indexOf("const saveFields = async (");
  assert.ok(start > -1);
  const body = board.slice(start, start + 1200);
  assert.match(body, /const optimistic = \{ \.\.\.request, \.\.\.fields \};/);
  assert.match(body, /catch \(error\) \{\s*onRequestChange\(request\);/);
});

test("inline text cells commit on change only and revert on Escape", async () => {
  const cells = await read("app/(app)/portal/board-cells.tsx");
  assert.match(cells, /if \(next !== value\) onSave\(next\);/);
  assert.match(cells, /if \(event\.key === "Escape"\) \{\s*setDraft\(value\);\s*setEditing\(false\);/);
});
