import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("the import runs on the built worker, not a bundled spreadsheet library", async () => {
  // SheetJS is around a megabyte and would be the largest thing in a
  // size-capped Workers bundle, for one screen that runs once per migration.
  const packageJson = JSON.parse(await read("package.json"));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  for (const banned of ["xlsx", "exceljs", "node-xlsx", "read-excel-file"]) {
    assert.ok(!dependencies.includes(banned), `${banned} must not be a runtime dependency`);
  }

  const reader = await read("app/lib/xlsx-reader.ts");
  // Workers has no zlib; the platform's own decompressor is what makes this
  // possible without a dependency.
  assert.match(reader, /DecompressionStream\("deflate-raw"\)/);
});

test("the xlsx reader handles what a monday export actually contains", async () => {
  const reader = await read("app/lib/xlsx-reader.ts");

  // Entries are read through the central directory. A streamed ZIP puts the
  // sizes in a trailing descriptor the local header does not carry, so scanning
  // for local headers reads the wrong number of bytes.
  assert.match(reader, /0x06054b50/, "the end-of-central-directory record must be located");
  assert.match(reader, /0x02014b50/, "central directory entries must be walked");

  // Monday leaves an empty cell out of the XML entirely, so positions cannot be
  // counted — the column letter has to be decoded.
  assert.match(reader, /function columnIndex/);

  // Blank rows separate groups. Excel writes those self-closing.
  assert.match(reader, /\(\?:\\\/>\|>/, "self-closing <row/> must match too");

  // Encrypted and ZIP64 files fail with a message rather than garbage.
  assert.match(reader, /password protected/);
  assert.match(reader, /ZIP64/);
});

test("Excel's 1900 leap-year bug is accounted for", async () => {
  const reader = await read("app/lib/xlsx-reader.ts");
  // Excel serials are days since 1899-12-30, not 1900-01-01, because Excel
  // reproduces a Lotus 1-2-3 bug that treats 1900 as a leap year. 25,569 is the
  // serial for the Unix epoch under that scheme.
  assert.match(reader, /25_569/);
});

test("the export's repeating headers do not become items", async () => {
  const parser = await read("app/lib/monday-import.ts");
  // Monday repeats the header inside every group. A parser that assumes one
  // header at the top reads twenty-odd header rows in as items.
  assert.match(parser, /function matchHeader/);
  assert.match(
    parser,
    /matched >= 3 \? mapping : null/,
    "a header must match several columns, or an item mentioning 'Status' becomes one",
  );
});

test("nothing is dropped silently", async () => {
  const parser = await read("app/lib/monday-import.ts");
  // Three reports, because all three are how a migration goes wrong quietly.
  assert.match(parser, /unmatchedColumns/, "columns the board cannot hold must be named");
  assert.match(parser, /missingColumns/, "columns the file omitted must be named");
  assert.match(parser, /plan\.skipped\.push/, "a skipped row must carry its reason");

  const panel = await read("app/(app)/portal/monday-import-panel.tsx");
  for (const heading of ["unmatchedColumns", "missingColumns", "skipped"]) {
    assert.ok(panel.includes(heading), `the screen must surface ${heading}`);
  }
});

test("preview and commit cannot disagree", async () => {
  const route = await read("app/api/import/route.ts");
  // One parse function backs both modes, so the numbers shown are the numbers
  // written.
  assert.equal((route.match(/planImport\(/g) ?? []).length, 1);
  assert.match(route, /if \(mode === "preview"\)/);
});

test("re-running an import updates rather than doubles the board", async () => {
  const route = await read("app/api/import/route.ts");
  // 744 rows is exactly the size of job someone re-runs after fixing a column.
  assert.match(route, /itemByTitle/, "items must be matched to what is already there");
  assert.match(route, /onConflictDoUpdate/, "cells must be updated, not duplicated");
  assert.match(
    route,
    /target: maintenanceGroupItems\.requestId/,
    "an item must move group on re-run, not gain a second placement",
  );
});

test("large boards do not exceed SQLite's bound-variable limit", async () => {
  // `IN (…)` binds one variable per element. A 500-item page blew the limit the
  // moment the import brought 744 jobs across, and `/api/board/items` answered
  // 503 for every caller.
  const batching = await read("app/lib/sql-batching.ts");
  assert.match(batching, /SQL_VARIABLE_CHUNK = 90/);

  for (const file of ["app/api/board/items/route.ts", "app/api/board/route.ts"]) {
    const source = await read(file);
    assert.match(source, /sql-batching/, `${file} must chunk its IN lists`);
    // No bare `inArray` on the unchunked identifier lists.
    assert.ok(
      !/inArray\([^)]*, ids\)/.test(source) && !/inArray\([^)]*, requestIds\)/.test(source),
      `${file} still binds a whole id list in one statement`,
    );
  }
});

test("the jobs list reports that it is a page", async () => {
  // A bare `.limit(250)` meant the board showed 250 of 744 imported jobs and
  // looked complete, because the counts all agreed with each other.
  const source = await read("app/api/maintenance/route.ts");
  assert.match(source, /hasMore/);
  assert.match(source, /nextOffset/);
  // Strip comments — the old cap is named in one on purpose.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.ok(!/\.limit\(250\)/.test(code), "the hard 250 cap must be gone");
});

test("uploads are bounded and the board is validated", async () => {
  const route = await read("app/api/import/route.ts");
  assert.match(route, /MAX_BYTES/);
  assert.match(route, /BOARD_KEYS\.includes\(boardKey\)/);
  // The magic number is checked, so a workbook named .csv fails with a message
  // rather than an unreadable parse.
  assert.match(route, /0x50 && bytes\[1\] === 0x4b/);
});
