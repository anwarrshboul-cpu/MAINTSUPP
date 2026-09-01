import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const stripSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

test("stage 4 migration destroys no data", async () => {
  const sql = stripSqlComments(await read("drizzle/0009_stage_four_items.sql"));
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
    assert.ok(
      !sql.toUpperCase().includes(destructive),
      `Migration contains ${destructive}.`,
    );
  }
  // DROP INDEX is permitted — an index holds no data.
  assert.match(sql, /DROP INDEX IF EXISTS/, "index repairs are expected");
});

test("board indexes are organisation-scoped", async () => {
  const sql = await read("drizzle/0009_stage_four_items.sql");

  // The bug: UNIQUE (board_id, position) with every organisation on
  // board_id = 'maintenance' meant only one tenant could hold position 0.
  assert.match(sql, /DROP INDEX IF EXISTS maintenance_groups_board_position_idx/);
  assert.match(
    sql,
    /maintenance_groups_org_position_idx\s*\n?\s*ON maintenance_groups\(organisation_id/,
    "group positions must be unique per organisation, not globally",
  );

  for (const repaired of [
    "maintenance_board_columns_org_key_idx",
    "maintenance_board_options_org_value_idx",
    "maintenance_board_cells_org_value_idx",
  ]) {
    assert.match(sql, new RegExp(repaired), `${repaired} must exist`);
  }

  // None of the new unique indexes may key off the legacy client_id.
  const newIndexes = sql.match(/CREATE UNIQUE INDEX[^;]+/g) ?? [];
  for (const statement of newIndexes) {
    assert.ok(
      !statement.includes("client_id"),
      `A new unique index still keys off client_id:\n${statement}`,
    );
  }
});

test("stage 4 migration is registered", async () => {
  const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
  const entry = journal.entries.find((e) => e.tag === "0009_stage_four_items");
  assert.ok(entry, "migration 0009 must appear in the journal");
  assert.equal(entry.idx, 9);
});

test("existing databases get the index repairs too", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /ensureStageFourItems/);
  assert.match(init, /DROP INDEX IF EXISTS \$\{drop\}/);
  assert.match(init, /PRAGMA table_info\(maintenance_requests\)/);
});

test("seeded columns mirror the source board without its known faults", async () => {
  const seed = await read("db/monday-board-spec.ts");

  // The contact number is a numbers column on monday, which destroys the
  // leading zero on 07863234937.
  const contact = seed.slice(seed.indexOf('key: "number"'));
  assert.match(contact.slice(0, 300), /type: "phone"/, "contact must be a phone column");

  // Money is held in pence.
  const cost = seed.slice(seed.indexOf('key: "cost"'));
  assert.match(cost.slice(0, 300), /Held in pence/);

  // Close-out photos stay separate from the issue photos — merging them loses
  // the before-and-after pair the close-out check reads.
  assert.match(seed, /key: "issuePictures"/);
  assert.match(seed, /key: "completedPictures"/);

  // Both monday location columns are carried. The board replaces monday rather
  // than summarising it, so dropping the free-text one would strand the rows
  // that only ever filled that in.
  assert.match(seed, /key: "location"/);
  assert.match(seed, /key: "storeLocation"/);
});

test("the board's structure is declared exactly once", async () => {
  // Three copies of the same 25 columns used to exist: `systemBoardColumns` in
  // the board route, `seedColumns` in the database seed and `columnLabels` in
  // the board model. Two of them wrote into `maintenance_board_columns` under
  // different keys for the same fields, so a seeded board came up with 38
  // columns and a visibly duplicated header.
  for (const file of [
    "app/api/board/route.ts",
    "db/seed-board-structure.ts",
    "app/(app)/portal/board-model.ts",
  ]) {
    const source = await read(file);
    assert.match(
      source,
      /monday-board-spec/,
      `${file} must take its column set from the single capture`,
    );
  }

  const spec = await read("db/monday-board-spec.ts");
  const block = spec.slice(
    spec.indexOf("export const maintenanceColumns"),
    spec.indexOf("export const maintenanceUiColumns"),
  );
  const keys = [...block.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 25, "monday's Maintenance board carries 25 columns");
  assert.equal(new Set(keys).size, keys.length, "no column key may appear twice");
});

test("all 38 monday groups are seeded, with the archives collapsed", async () => {
  // Reversed from the earlier "only seed the 10 operational groups" rule. The
  // board replaces monday rather than summarising it, so the 28 per-store and
  // per-month archives have to come across or the work filed in them is lost.
  const spec = await read("db/monday-board-spec.ts");
  const groups = spec.slice(
    spec.indexOf("export const maintenanceGroups"),
    spec.indexOf("/* ── Maintenance — option sets"),
  );

  const keys = [...groups.matchAll(/key: "([a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.equal(keys.length, 38, "monday's Maintenance board carries 38 groups");
  assert.equal(new Set(keys).size, keys.length, "no group key may appear twice");

  const collapsed = (groups.match(/collapsed: true/g) ?? []).length;
  assert.equal(
    collapsed,
    28,
    "the 28 archive groups seed collapsed so the operational top of the board stays readable",
  );

  // The ten operational groups must NOT be collapsed — they are the board.
  const operational = groups.slice(0, groups.indexOf('key: "done-wood-green"'));
  assert.ok(
    !/collapsed: true/.test(operational),
    "no operational group may seed collapsed",
  );
});

test("obsolete seeded columns are cleaned up without losing data", async () => {
  const init = await read("db/init.ts");
  const fn = init.slice(init.indexOf("async function reconcileDuplicateColumns"));
  assert.match(fn, /system = 1/, "only seeded columns may be removed, never an admin's");
  assert.match(
    fn,
    /TRIM\(COALESCE\(value, ''\)\) <> ''/,
    "a column holding any value must be kept",
  );
  assert.match(fn, /if \(total > 0\) continue;/);
});

test("seeding is idempotent and never resurrects a deleted column", async () => {
  const init = await read("db/init.ts");
  const seedFn = init.slice(init.indexOf("export async function seedBoardStructure"));
  const inserts = seedFn.match(/INSERT[^`]*/g) ?? [];
  assert.ok(inserts.length >= 2, "columns and groups are both seeded");
  for (const statement of inserts) {
    assert.match(
      statement,
      /INSERT OR IGNORE/,
      "seeding must not overwrite an admin's edits on a later boot",
    );
  }
});

test("cell writes are validated through the column type registry", async () => {
  const source = await read("app/api/board/items/route.ts");
  /*
   * `normalizeBoardCellValue`, not `normaliseCellValue`: Workstream 7 moved cell
   * writes onto the shared normaliser the board's own editor and the automation
   * engine use, so a date written through the API is byte-identical to one
   * written from the grid. The claim this test makes is unchanged — a write goes
   * through the registry, not around it — only the registry's entry point moved.
   */
  assert.match(source, /normalizeBoardCellValue\(type, body\.value\)/);
  assert.match(source, /definition\?\.readOnly/, "computed columns must reject writes");
  assert.match(source, /column\.required && !value/, "required columns must reject blanks");
});

test("items are archived, never deleted", async () => {
  const source = await read("app/api/board/items/route.ts");
  const del = source.slice(source.indexOf("export async function DELETE"));
  assert.ok(
    !/db\s*\n?\s*\.delete\(maintenanceRequests\)/.test(del),
    "DELETE must not remove the row — jobs carry compliance evidence",
  );
  assert.match(del, /archived: true/);
});

test("a duplicated job does not inherit evidence", async () => {
  const source = await read("app/api/board/items/route.ts");
  const dup = source.slice(source.indexOf('body.intent === "duplicate"'));
  assert.match(dup.slice(0, 2000), /issueAttachmentCount: 0/);
  assert.match(dup.slice(0, 2000), /completedAttachmentCount: 0/);
  assert.match(
    dup.slice(0, 2000),
    /publicUploadTokenHash: null/,
    "a copy must not inherit a live contractor upload link",
  );
});

test("every change is written to the activity log", async () => {
  const source = await read("app/api/board/items/route.ts");
  for (const action of ["created", "changed", "moved", "archived", "duplicated"]) {
    assert.match(
      source,
      new RegExp(`"${action}"`),
      `the ${action} action must be recorded`,
    );
  }
});

test("the items route is organisation-scoped and degrades gracefully", async () => {
  const source = await read("app/api/board/items/route.ts");
  assert.match(source, /scopedDb\(request\)/);
  assert.match(source, /status: 503/);
  assert.doesNotMatch(source, /"sunnamusk-uk"/);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.match(source, new RegExp(`export async function ${method}\\b`));
  }
});

test("the Subitems column is rendered, not just declared", async () => {
  // Monday's 25th column. `parent_id` and the items API carried subitems from
  // Stage 4, but the grid had no cell for them, so the column was seeded and
  // then filtered back out — a capability with no way to reach it.
  const spec = await read("db/monday-board-spec.ts");
  assert.match(spec, /key: "subitems"[\s\S]{0,120}type: "subitems"/);

  for (const file of ["app/api/board/route.ts", "db/init.ts"]) {
    const source = await read(file);
    assert.ok(
      !/column\.type !== "subitems"/.test(source),
      `${file} must no longer filter the subitems column out of the seed`,
    );
  }

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /case "subitems":/, "the grid must draw a subitems cell");
  assert.match(board, /<SubitemRows/, "expanding must reveal the child rows");
});

test("subitems hang under their parent instead of beside it", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const grouped = board.slice(board.indexOf("const groupedRows = useMemo"));
  assert.match(
    grouped.slice(0, 900),
    /if \(request\.parentId\) continue;/,
    "a child must not also be placed as a top-level row",
  );
});

test("subitems carry monday's own four fields and three statuses", async () => {
  const panel = await read("app/(app)/portal/board-subitems.tsx");
  for (const heading of ["Subitem", "Owner", "Status", "Date"]) {
    assert.ok(panel.includes(`>${heading}<`), `the panel must show ${heading}`);
  }

  const spec = await read("db/monday-board-spec.ts");
  const options = spec.slice(
    spec.indexOf("export const maintenanceSubitemOptions"),
    spec.indexOf("/* ── Store Documentation UK"),
  );
  for (const label of ["Stuck", "Working on it", "Done"]) {
    assert.ok(options.includes(`opt("${label}"`), `${label} must be a subitem status`);
  }
  // The child board has three labels, not the parent board's twenty-three.
  assert.equal((options.match(/opt\(/g) ?? []).length, 3);
});

test("creating an item returns the row, not just its id", async () => {
  // The subitem editor has to draw what it just created. Three fields is not
  // enough to render a row without refetching the whole board.
  const source = await read("app/api/board/items/route.ts");
  assert.match(source, /item: created \?\? null/);
});
