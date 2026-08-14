import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("stage 3 migration is additive", async () => {
  const raw = await read("drizzle/0008_stage_three_board_engine.sql");
  // Strip -- comments so the file's own "no DROP TABLE" note is not a false hit.
  const sql = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
    assert.ok(
      !sql.toUpperCase().includes(destructive),
      `Migration contains ${destructive}. Stage 3 must not discard existing data.`,
    );
  }
  assert.match(raw, /CREATE TABLE IF NOT EXISTS boards/);
  assert.match(raw, /INSERT OR IGNORE INTO boards/, "the implicit board must be materialised");
});

test("stage 3 migration is registered in the journal", async () => {
  const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
  const entry = journal.entries.find((e) => e.tag === "0008_stage_three_board_engine");
  assert.ok(entry, "migration 0008 must appear in the journal");
  assert.equal(entry.idx, 8);
});

test("existing databases get the same schema without a migration run", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /ensureStageThreeBoardEngine/, "compatibility path must exist");
  assert.match(init, /CREATE TABLE IF NOT EXISTS boards/);
  // Every ALTER must be guarded by a column-existence check, or a second boot fails.
  assert.match(init, /PRAGMA table_info/);
});

test("column type registry covers the core set required for parity", async () => {
  const source = await read("app/lib/column-types.ts");
  const core = [
    "text", "long_text", "number", "currency", "single_select", "multi_select",
    "person", "date", "date_range", "file", "link", "email", "phone",
    "checkbox", "relation",
  ];
  for (const key of core) {
    assert.match(
      source,
      new RegExp(`define\\(\\s*"${key}"`),
      `column type "${key}" is required by N2`,
    );
  }
});

test("phone is stored as text so a leading zero survives", async () => {
  const source = await read("app/lib/column-types.ts");
  const phone = source.slice(source.search(/define\(\s*"phone"/));
  assert.match(
    phone.slice(0, 500),
    /"string"/,
    "phone must use string storage — numeric storage drops the leading zero on 07863234937",
  );
});

test("currency is held in pence as an integer", async () => {
  const source = await read("app/lib/column-types.ts");
  assert.match(source, /Math\.round\(numeric\)/, "currency must be rounded to whole pence");
  assert.match(source, /pence/i);
});

test("computed column types are never written by a user", async () => {
  const source = await read("app/lib/column-types.ts");
  assert.match(
    source,
    /if \(definition\.readOnly\) return null;/,
    "normaliseCellValue must reject writes to read-only types",
  );
});

test("destructive column operations require explicit confirmation", async () => {
  const source = await read("app/api/board/columns/route.ts");
  assert.match(source, /lossy-conversion/, "a lossy type change must be refused by default");
  assert.match(source, /has-data/, "deleting a populated column must be refused by default");
  assert.match(source, /body\.force !== true/, "conversion needs an explicit override");
  assert.match(source, /confirm.*===.*"true"/, "deletion needs an explicit confirmation");
});

test("a group holding items cannot be silently deleted", async () => {
  const source = await read("app/api/board/groups/route.ts");
  assert.match(source, /has-items/);
  assert.match(source, /moveTo/, "items must be relocated rather than orphaned");
});

test("board engine routes are organisation-scoped and degrade gracefully", async () => {
  for (const route of ["app/api/board/columns/route.ts", "app/api/board/groups/route.ts"]) {
    const source = await read(route);
    assert.match(source, /scopedDb\(request\)/, `${route} must resolve a scoped database`);
    assert.match(source, /status: 503/, `${route} must degrade rather than throw`);
    const methods = ["GET", "POST", "PATCH", "DELETE"];
    for (const method of methods) {
      assert.match(
        source,
        new RegExp(`export async function ${method}\\b`),
        `${route} must expose ${method}`,
      );
    }
  }
});

test("item references are issued atomically", async () => {
  const source = await read("app/lib/board-registry.ts");
  assert.match(
    source,
    /referenceCounter: sql`\$\{boards\.referenceCounter\} \+ 1`/,
    "the counter must increment in SQL, not be read-then-written",
  );
  assert.match(source, /padStart\(4, "0"\)/, "references are zero-padded to four digits");
});

test("no fixed tenant identifier in the new board engine", async () => {
  for (const file of [
    "app/lib/board-registry.ts",
    "app/lib/column-types.ts",
    "app/api/board/columns/route.ts",
    "app/api/board/groups/route.ts",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /"sunnamusk-uk"/, `${file} must not name a client`);
    assert.doesNotMatch(source, /\bCLIENT_ID\b\s*=/, `${file} must use scopedDb`);
  }
});
