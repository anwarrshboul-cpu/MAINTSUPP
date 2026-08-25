/**
 * Audit S4 — bulk "Delete selected" must survive the SQL variable limit.
 *
 * `sendJobsToBin` snapshots every doomed row into `recycle_bin` with ONE
 * multi-row INSERT. That insert binds 12 variables per row, but the loop
 * around it chunked by `chunkIds`' ninety — a budget sized for one-variable
 * `IN` lists — so a twenty-row delete bound 240 variables, D1 refused the
 * statement, and the route answered 503 "The board change could not be
 * saved." while a one-item delete worked. Selecting more than eight rows and
 * pressing Delete had therefore never worked on D1.
 *
 * The fix is `chunkRows`: divide the variable budget by the row's width. These
 * tests pin the arithmetic and the call site.
 *
 * Reads normalise CRLF first — this suite must pass on a Windows checkout.
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

const batching = await (async () => {
  const source = await read("app/lib/sql-batching.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

test("chunkRows divides the variable budget by the row width", () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({ n: i }));
  const chunks = batching.chunkRows(rows, 12);
  // 90 variables / 12 columns = 7 rows per statement.
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 7, `a chunk of ${chunk.length} rows binds ${chunk.length * 12} variables`);
  }
  // Every row survives, in order, exactly once.
  assert.deepEqual(chunks.flat().map((r) => r.n), rows.map((r) => r.n));
});

test("a row wider than the whole budget still moves one row at a time", () => {
  const rows = [{ a: 1 }, { a: 2 }];
  const chunks = batching.chunkRows(rows, 500);
  assert.deepEqual(chunks.map((c) => c.length), [1, 1]);
});

test("the recycle-bin snapshot insert is chunked by row width, not id count", async () => {
  const source = await read("app/lib/recycle-bin.ts");
  assert.match(
    source,
    /for \(const entryChunk of chunkRows\(binEntries, 12\)\) \{\n\s+await db\.insert\(recycleBin\)\.values\(entryChunk\);/,
    "sendJobsToBin must insert its bin entries through chunkRows — a plain .values(rows) 503s past eight rows",
  );
  // The count in the call must match the insert's real width: the entry
  // object binds exactly these properties.
  const entry = source.slice(source.indexOf("const binEntries"), source.indexOf("chunkRows(binEntries"));
  const boundColumns = [
    "id:", "organisationId:", "entityType:", "entityId:", "boardId:",
    "title:", "summary:", "placement:", "deletedByEmail:", "deletedByName:",
    "deletedAt,", "expiresAt,",
  ];
  for (const column of boundColumns) {
    assert.ok(entry.includes(column), `bin entry no longer binds ${column} — update the chunkRows width`);
  }
  assert.equal(boundColumns.length, 12, "the width named in the call site");
});
