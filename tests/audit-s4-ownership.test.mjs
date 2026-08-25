/**
 * Audit S4R — ownership, malformed bodies, and silent no-ops on the board APIs.
 *
 * Proven against the running dev server before the fixes:
 *
 *  - `PATCH /api/board/items` intent "cell" never looked the item up. The
 *    column was org-scoped, but an invented or foreign `itemId` sailed into
 *    the insert and was answered 200, leaving an orphan cell row behind.
 *  - The same path accepted a SYSTEM column: writing `contractor` stored a
 *    cell that shadowed the job's own field without setting it — the exact
 *    divergence `PATCH /api/board`'s update_cell refuses with "that column is
 *    a field on the job". Only the date decoration may be stored as a cell.
 *  - A request body of literal `null` PARSES — `request.json()`'s catch never
 *    fires — so `body.action` threw and `/api/board` POST/PATCH, POST
 *    /api/trash and /api/board/items answered 503 for what is a 400.
 *  - `duplicate_items`, `move_items` and `archive_items` answered 200/201
 *    with empty arrays when every id was foreign, invented or binned — a
 *    silent no-op that read as success (and the only place Stage 23's "a
 *    binned job cannot be duplicated" was just a comment). `sort_group`
 *    answered 200 for a foreign group id with an empty order.
 *  - `GET /api/board/items?limit=-5`: SQLite reads a negative LIMIT as "no
 *    limit", so the 500-row cap was bypassable.
 *
 * These tests pin the guards in source, and the date-decoration contract by
 * executing the shared helper. Reads normalise CRLF first — this suite must
 * pass on a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const itemsRoute = await read("app/api/board/items/route.ts");
const boardRoute = await read("app/api/board/route.ts");
const trashRoute = await read("app/api/trash/route.ts");

/* ------------------------------------------------------------------ */
/* items route — intent "cell"                                         */
/* ------------------------------------------------------------------ */

test("items-route cell writes look the item up in the caller's organisation first", () => {
  const cell = itemsRoute.slice(
    itemsRoute.indexOf('body.intent === "cell"'),
    itemsRoute.indexOf('body.intent === "move"'),
  );
  assert.ok(cell.length > 0, "the cell intent block was not found");
  // The org-scoped work-order lookup, refused with a 404 …
  assert.match(
    cell,
    /eq\(maintenanceRequests\.id, requestId\),\s*\n\s*eq\(maintenanceRequests\.organisationId, orgId\)/,
    "the item lookup must filter on the organisation",
  );
  assert.match(
    cell,
    /if \(!workOrder\) return bad\("Item not found\.", 404\);/,
    "an unknown or foreign item id must 404, not write an orphan cell",
  );
  // … and it happens BEFORE anything is written.
  const lookup = cell.indexOf("Item not found.");
  const write = cell.search(/db\s*\.insert\(maintenanceBoardCells\)|\.update\(maintenanceBoardCells\)/);
  assert.ok(lookup >= 0 && write > lookup, "the 404 must come before the cell write");
});

test("items-route cell writes refuse system columns except the date decoration", () => {
  const cell = itemsRoute.slice(
    itemsRoute.indexOf('body.intent === "cell"'),
    itemsRoute.indexOf('body.intent === "move"'),
  );
  assert.match(
    cell,
    /if \(column\.system\) \{/,
    "system columns must take a different path from custom cells",
  );
  assert.match(
    cell,
    /dateDecorationValue\(column\.type as BoardColumnType, body\.value\)/,
    "the one thing a system column may store is the shared date decoration",
  );
  assert.match(
    cell,
    /That column is a field on the job\. Use PATCH \/api\/maintenance/,
    "everything else must be pointed at the job's own fields",
  );
});

/* ------------------------------------------------------------------ */
/* Malformed bodies are 400s, not 503s                                 */
/* ------------------------------------------------------------------ */

test("a null or unparseable body is a 400 on every board write", () => {
  // /api/board POST and PATCH both guard the parse and the null.
  const guards = boardRoute.match(
    /request\.json\(\)\.catch\(\(\) => null\)\) as\s*\n?\s*\| Record<string, unknown>\s*\n?\s*\| null;/g,
  );
  assert.ok(
    guards && guards.length >= 2,
    "/api/board POST and PATCH must both catch broken JSON and treat null as absent",
  );
  const refusals = boardRoute.match(
    /The request body must be a JSON object\./g,
  );
  assert.ok(refusals && refusals.length >= 2, "both verbs must answer 400 for it");

  // /api/board/items reads `(json … ?? {})`, so a literal-null body cannot
  // reach `body.intent`.
  assert.match(
    itemsRoute,
    /\(await request\.json\(\)\.catch\(\(\) => null\)\) \?\? \{\}/,
    "the items route must survive a body of literal null",
  );

  // POST /api/trash the same.
  assert.match(
    trashRoute,
    /\(\(await request\.json\(\)\.catch\(\(\) => null\)\) \?\? \{\}\) as \{ id\?: unknown \}/,
    "the trash restore must survive a body of literal null",
  );
});

/* ------------------------------------------------------------------ */
/* Silent no-ops refuse instead                                        */
/* ------------------------------------------------------------------ */

test("duplicate, move and archive refuse when no id named a row on this board", () => {
  const duplicate = boardRoute.slice(
    boardRoute.indexOf('action === "duplicate_items"'),
    boardRoute.indexOf('action === "move_items"'),
  );
  assert.match(
    duplicate,
    /if \(!outcome\.requests\.length\) \{\s*\n\s*return Response\.json\(\s*\n\s*\{ error: "Those items are not on this board, or are in the recycle bin\." \},\s*\n\s*\{ status: 404 \}/,
    "duplicate_items must 404 when nothing was copied — this is where the Stage 23 binned-row refusal becomes real",
  );
  const move = boardRoute.slice(
    boardRoute.indexOf('action === "move_items" || action === "archive_items"'),
    boardRoute.indexOf('action === "delete_items"'),
  );
  assert.match(
    move,
    /if \(!outcome\.items\.length\) \{\s*\n\s*return Response\.json\(\s*\n\s*\{ error: "Those items are not on this board, or are in the recycle bin\." \},\s*\n\s*\{ status: 404 \}/,
    "move_items/archive_items must 404 when nothing moved",
  );
});

test("sort_group refuses a group this organisation does not have", () => {
  const sort = boardRoute.slice(
    boardRoute.indexOf('action === "sort_group"'),
    boardRoute.indexOf('action === "delete_group"'),
  );
  assert.match(
    sort,
    /eq\(maintenanceGroups\.id, groupId\),\s*\n\s*eq\(maintenanceGroups\.organisationId, orgId\)/,
    "the sort target must be resolved inside the organisation",
  );
  assert.match(
    sort,
    /if \(!sortTarget\) \{\s*\n\s*return Response\.json\(\{ error: "Group not found\." \}, \{ status: 404 \}\);/,
    "a foreign group id must 404 instead of answering an empty 200",
  );
});

/* ------------------------------------------------------------------ */
/* Pagination bounds                                                   */
/* ------------------------------------------------------------------ */

test("the items page size is clamped from both ends", () => {
  assert.match(
    itemsRoute,
    /Math\.min\(Math\.max\(Number\(url\.searchParams\.get\("limit"\)\) \|\| 100, 1\), 500\)/,
    "a negative limit reaches SQLite as LIMIT -n — 'no limit' — bypassing the 500 cap",
  );
  assert.match(
    itemsRoute,
    /Math\.max\(Number\(url\.searchParams\.get\("cursor"\)\) \|\| 0, 0\)/,
    "a negative cursor must clamp to the first page",
  );
});

/* ------------------------------------------------------------------ */
/* The decoration contract, executed                                   */
/* ------------------------------------------------------------------ */

const cellValues = await (async () => {
  const source = await read("app/lib/board-cell-values.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

test("a date decoration stores marker and time, never a date, never another type", () => {
  const { dateDecorationValue } = cellValues;
  // A time-of-day decoration is the one permitted system-column cell.
  assert.equal(
    dateDecorationValue("date", JSON.stringify({ time: "09:30" })),
    JSON.stringify({ time: "09:30", icon: "" }),
  );
  // A decoration carrying a date IS the shadow the guard exists to prevent.
  assert.equal(dateDecorationValue("date", JSON.stringify({ date: "2026-01-01" })), null);
  // Any non-date system column has no decoration form at all.
  assert.equal(dateDecorationValue("text", "SHADOW"), null);
  // An empty value clears the decoration rather than failing.
  assert.equal(dateDecorationValue("date", ""), "");
});
