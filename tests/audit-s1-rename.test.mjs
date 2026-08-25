/**
 * Audit S1R-4 — renaming a board row has to survive.
 *
 * Every rename surface (the grid's ItemNameEditor, the mobile edit sheet)
 * saves through `PATCH /api/board` `update_cell` on the SYSTEM name column.
 * That handler refuses system columns, because a system cell SHADOWS the job
 * field it draws — the contractor divergence its own comment describes. The
 * name column is the deliberate exception: `boardItemName` reads the CELL
 * first and only falls back to the title or the arrival form where no cell
 * exists, which is exactly how a rename is meant to work.
 *
 * So every rename 400ed, reverted, and showed the route's developer hint as a
 * toast, and there was not one name cell in the database on any board. This
 * pins the exception AND the doctrine it lives inside: name is stored, every
 * other system column is still refused.
 *
 * Reads normalise CRLF — this suite runs on a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

test("the name column is stored as a cell, not refused as a field", async () => {
  const source = await read("app/api/board/route.ts");
  assert.match(
    source,
    /if \(column\.system && column\.key === "name"\) \{/,
    "update_cell must take the name column before the system-column refusal",
  );
  const branch = source.slice(
    source.indexOf('if (column.system && column.key === "name")'),
    source.indexOf("} else if (column.system) {"),
  );
  assert.match(
    branch,
    /value = normalizeCellValue\(type, payload\.value\);/,
    "a rename stores the normalised text value like any other text cell",
  );
});

test("every other system column is still refused, so a cell cannot shadow a field", async () => {
  const source = await read("app/api/board/route.ts");
  const refusal = source.slice(
    source.indexOf("} else if (column.system) {"),
    source.indexOf("} catch (error) {", source.indexOf("} else if (column.system) {")),
  );
  assert.match(refusal, /dateDecorationValue\(type, payload\.value\)/);
  assert.match(
    refusal,
    /That column is a field on the job\./,
    "the contractor/status doctrine must survive the name exception",
  );
});

test("the client still prefers the cell it can now write", async () => {
  // If boardItemName ever stopped reading the cell first, storing it would be
  // pointless — the rename would save and never appear.
  const ordering = await read("app/(app)/portal/board-ordering.ts");
  const fn = ordering.slice(ordering.indexOf("export function boardItemName"));
  assert.match(
    fn.slice(0, 400),
    /const edited = cellValue\?\.trim\(\);\n\s+if \(edited\) return edited;/,
    "the Name cell must win wherever one exists",
  );
});
