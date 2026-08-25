/**
 * Audit — the exported CSV writes dates the way this product writes dates.
 *
 * `board-csv.ts` reused `dateInputValue`, the helper that feeds
 * `<input type="date">`. That helper must keep returning ISO, because a date
 * input accepts nothing else — but a spreadsheet is not a date input, and the
 * file handed to a UK estates manager printed `2026-11-24` for every date in a
 * product whose date doctrine (app/lib/format-date.ts) is "one place, en-GB,
 * everywhere".
 *
 * So the export formats at the export layer: `24/11/2026`, with an empty cell
 * for a missing value rather than format-date's em dash, and the board's own
 * cells left untouched. Verified against a generated file as well as here.
 *
 * Reads normalise CRLF first — this is a Windows checkout.
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

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (js) =>
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

const formatDate = await import(
  asModule(transpile(await read("app/lib/format-date.ts")))
);

test("the shared formatter is what en-GB means here", () => {
  assert.equal(formatDate.formatDate("2026-11-24", { fallback: "" }), "24/11/2026");
  // A bare date must not drift a day for a reader west of Greenwich.
  assert.equal(formatDate.formatDate("2026-01-01", { fallback: "" }), "01/01/2026");
  // A missing value is an empty cell in a spreadsheet, not an em dash.
  assert.equal(formatDate.formatDate(null, { fallback: "" }), "");
  assert.equal(formatDate.formatDate("", { fallback: "" }), "");
});

test("the export formats dates rather than echoing the date input's ISO", async () => {
  const source = await read("app/lib/board-csv.ts");

  assert.match(
    source,
    /function csvDate\(value: string \| null \| undefined\) \{\s*return formatDate\(value, \{ fallback: "" \}\);/,
    "the CSV needs its own date form with an empty fallback",
  );
  // Every system date column goes through it.
  for (const field of ["requestedAt", "completedAt", "dueAt", "nextUpdateAt"]) {
    assert.ok(
      source.includes("csvDate(request." + field + ")"),
      field + " must be written, not echoed as ISO",
    );
  }
  assert.match(
    source,
    /csvDate\(request\.requestedAt\)\} to \$\{csvDate\(request\.dueAt\)/,
    "both ends of the timeline column are dates too",
  );
  // And the raw input helper is no longer what the file prints.
  assert.doesNotMatch(
    source.replace(/\/\*[\s\S]*?\*\//g, ""),
    /dateInputValue\(/,
    "dateInputValue feeds date inputs, not spreadsheets",
  );
});

test("workspace-added date and timeline columns are written too", async () => {
  const source = await read("app/lib/board-csv.ts");
  const table = source.slice(source.indexOf("export function boardCsvTable"));
  assert.match(table, /if \(entry\.column\.type === "date"\)/);
  assert.match(table, /csvDate\(metadata\.date\)/);
  assert.match(table, /if \(entry\.column\.type === "timeline"\)/);
  assert.match(table, /\.map\(csvDate\)/);
});

test("the board's own cells still get ISO, because a date input demands it", async () => {
  // The guard against 'fixing' the export by changing what the grid renders.
  const format = await read("app/(app)/portal/board-format.ts");
  const display = format.slice(
    format.indexOf("export function customCellDisplay"),
    format.indexOf("export function serializeCustomCellValue"),
  );
  assert.doesNotMatch(display, /formatDate|toLocaleDateString/,
    "customCellDisplay feeds the grid's date inputs and must stay ISO");
});

test("a value with a comma or a quote is still escaped", async () => {
  const csv = await import(asModule(transpile(await read("app/lib/csv.ts"))));
  const line = csv.rowsToCsv(["Name"], [['He said "stop, now"']]);
  assert.match(line, /"He said ""stop, now"""/);
});
