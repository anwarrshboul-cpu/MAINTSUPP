/**
 * Audit S1 — regression pins for the Main Table fixes verified in-browser
 * during the deep audit (tier bridge, saved-rule seeding gate, panel closers,
 * "Create new item below" verb, Recycle Bin confirm copy, blank-last sorting,
 * and the incomplete-filter-rule fix).
 *
 * The sort and filter engines are transpiled and CALLED with real rows — a
 * filter that quietly matches nothing and a sort that never fires both look
 * exactly like "there are no such rows" on screen, so only execution proves
 * them. The JSX wiring inside live-board.tsx (which state a document-level
 * closer resets, which verb a menu action uses) is pinned at source level, the
 * same way batch-1a-board-controls.test.mjs pins the export gate.
 *
 * Module-graph bootstrap lifted from tests/batch-1a-board-controls.test.mjs.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const specUrl = asModule(transpile(await read("db/monday-board-spec.ts")));
const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));
const expiryUrl = asModule(
  transpile(await read("app/lib/expiry-status.ts")).replace(
    /from ["']\.\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);
const modelUrl = asModule(
  transpile(await read("app/(app)/portal/board-model.ts")).replace(
    /from ["']\.\.\/\.\.\/\.\.\/db\/monday-board-spec["']/g,
    `from "${specUrl}"`,
  ),
);
const formatUrl = asModule(
  transpile(await read("app/(app)/portal/board-format.ts"))
    .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
    .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
    .replace(/from ["']\.\/board-model["']/g, `from "${modelUrl}"`),
);
const orderingUrl = asModule(transpile(await read("app/(app)/portal/board-ordering.ts")));
const viewModelUrl = asModule(
  transpile(await read("app/(app)/portal/views/view-model.ts")).replace(
    /from ["']\.\.\/\.\.\/\.\.\/lib\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);

const sort = await import(
  asModule(
    transpile(await read("app/(app)/portal/board-sort.ts"))
      .replace(/from ["']\.\/board-ordering["']/g, `from "${orderingUrl}"`)
      .replace(/from ["']\.\/board-format["']/g, `from "${formatUrl}"`),
  )
);

const filter = await import(
  asModule(
    transpile(await read("app/(app)/portal/board-filter.ts"))
      .replace(/from ["']\.\/board-format["']/g, `from "${formatUrl}"`)
      .replace(/from ["']\.\/board-ordering["']/g, `from "${orderingUrl}"`)
      .replace(/from ["']\.\/views\/view-model["']/g, `from "${viewModelUrl}"`),
  )
);

/* ── Fixtures (the batch-1a shape) ───────────────────────────────────────── */

let sequence = 0;
function row(overrides = {}) {
  sequence += 1;
  return {
    id: `MN-${1000 + sequence}`,
    source: "Portal form",
    title: `Job ${sequence}`,
    description: "",
    location: "Aldgate",
    siteId: "site-aldgate",
    requester: "Manager",
    contact: "",
    category: "Other",
    engineer: "Handyman",
    tier: 2,
    priority: "Medium",
    stage: "Incoming",
    status: "Pending Scheduling",
    contractor: null,
    assignee: null,
    requestedAt: "2026-08-01T09:00:00.000Z",
    dueAt: null,
    completedAt: null,
    nextUpdateAt: null,
    cost: null,
    attachmentCount: 0,
    commentCount: 0,
    cells: {},
    ...overrides,
  };
}

const systemColumn = (key, extra = {}) => ({
  kind: "system",
  key,
  column: {
    id: `col-${key}`,
    key,
    title: key,
    type: "text",
    position: 0,
    width: 160,
    settings: {},
    system: true,
    visible: true,
    ...extra,
  },
});

function context(columns, overrides = {}) {
  return {
    boardId: "maintenance",
    columnsById: new Map(columns.map((entry) => [entry.column.id, entry])),
    cells: {},
    fileCounts: {},
    optionOrderFor: () => undefined,
    positionOf: () => 0,
    ...overrides,
  };
}

/* ── Blank cells sort LAST in both directions ────────────────────────────── */

test("rows with no due date sink to the bottom of asc AND desc sorts", () => {
  // The system date columns spell "missing" as NEGATIVE_INFINITY
  // (board-ordering.ts systemColumnSortValue) while custom cells spell it "".
  // isEmptyValue must treat both as the same missing state, or reversing an
  // ascending Due Date sort floats every blank row to the top.
  const columns = [systemColumn("dueDate")];
  const rows = [
    row({ dueAt: "2026-08-27T09:00:00.000Z" }),
    row({ dueAt: null }),
    row({ dueAt: "2026-08-26T09:00:00.000Z" }),
    row({ dueAt: null }),
  ];

  const asc = sort.sortBoardRows(
    rows,
    [{ columnId: "col-dueDate", direction: "asc" }],
    context(columns),
  );
  assert.deepEqual(
    asc.map((entry) => entry.dueAt),
    ["2026-08-26T09:00:00.000Z", "2026-08-27T09:00:00.000Z", null, null],
    "ascending: dated rows first in date order, blanks last",
  );

  const desc = sort.sortBoardRows(
    rows,
    [{ columnId: "col-dueDate", direction: "desc" }],
    context(columns),
  );
  assert.deepEqual(
    desc.map((entry) => entry.dueAt),
    ["2026-08-27T09:00:00.000Z", "2026-08-26T09:00:00.000Z", null, null],
    "descending: blanks must STILL be last, not first",
  );
});

test("rows with no cost sink to the bottom of asc AND desc sorts", () => {
  const columns = [systemColumn("cost")];
  const rows = [row({ cost: 500 }), row({ cost: null }), row({ cost: 120 })];

  const asc = sort.sortBoardRows(
    rows,
    [{ columnId: "col-cost", direction: "asc" }],
    context(columns),
  );
  assert.deepEqual(asc.map((entry) => entry.cost), [120, 500, null]);

  const desc = sort.sortBoardRows(
    rows,
    [{ columnId: "col-cost", direction: "desc" }],
    context(columns),
  );
  assert.deepEqual(desc.map((entry) => entry.cost), [500, 120, null]);
});

/* ── Tier sorts by rank even though options are labelled "Tier N" ────────── */

test("a tier sort ranks 1<2<3<4 with the workspace's 'Tier N' option order", () => {
  // The board builds its option-order lookup from the "Tier 1".."Tier 4"
  // option VALUES and aliases the bare digits onto the same ranks
  // (live-board.tsx, tierDigits) because the FIELD stores the number. This
  // exercises the engine with exactly that aliased lookup.
  const order = new Map([
    ["Tier 1", 0], ["1", 0],
    ["Tier 2", 1], ["2", 1],
    ["Tier 3", 2], ["3", 2],
    ["Tier 4", 3], ["4", 3],
  ]);
  const columns = [systemColumn("tier")];
  const rows = [row({ tier: 3 }), row({ tier: 1 }), row({ tier: 4 }), row({ tier: 2 })];
  const ordered = sort.sortBoardRows(
    rows,
    [{ columnId: "col-tier", direction: "asc" }],
    context(columns, { optionOrderFor: () => order }),
  );
  assert.deepEqual(ordered.map((entry) => entry.tier), [1, 2, 3, 4]);
});

/* ── An incomplete filter rule must not blank the board ──────────────────── */

test("a rule with no values yet narrows nothing; a completed rule narrows", () => {
  // The panel commits {operator:"any_of", values:[]} the moment a column is
  // chosen — before any value is picked. any_of over an empty list matches
  // nothing, so that half-built rule used to hide every row on the spot and
  // then SAVE itself, greeting the next session with an empty board.
  const columns = [systemColumn("tier")];
  const rows = [row({ tier: 1 }), row({ tier: 2 }), row({ tier: 3 })];
  const ctx = context(columns);

  const incomplete = filter.applyBoardFilter(
    rows,
    { join: "and", rules: [{ columnId: "col-tier", operator: "any_of", values: [] }] },
    ctx,
  );
  assert.equal(incomplete.length, rows.length, "empty any_of is incomplete, not a match-nothing filter");

  const blankValue = filter.applyBoardFilter(
    rows,
    { join: "and", rules: [{ columnId: "col-tier", operator: "any_of", values: [""] }] },
    ctx,
  );
  assert.equal(blankValue.length, rows.length, "a lone empty string is still no value");

  const complete = filter.applyBoardFilter(
    rows,
    { join: "and", rules: [{ columnId: "col-tier", operator: "any_of", values: ["1"] }] },
    ctx,
  );
  assert.deepEqual(complete.map((entry) => entry.tier), [1], "a real value filters exactly");
});

test("is_empty / is_not_empty carry no values and still apply", () => {
  const columns = [systemColumn("contractor")];
  const rows = [row({ contractor: "PlumbCo" }), row({ contractor: null })];
  const ctx = context(columns);

  const empty = filter.applyBoardFilter(
    rows,
    { join: "and", rules: [{ columnId: "col-contractor", operator: "is_empty", values: [] }] },
    ctx,
  );
  assert.equal(empty.length, 1);
  assert.equal(empty[0].contractor, null);

  const notEmpty = filter.applyBoardFilter(
    rows,
    { join: "and", rules: [{ columnId: "col-contractor", operator: "is_not_empty", values: [] }] },
    ctx,
  );
  assert.equal(notEmpty.length, 1);
  assert.equal(notEmpty[0].contractor, "PlumbCo");
});

/* ── live-board.tsx wiring pins ──────────────────────────────────────────── */

test("the tier cell bridges number<->'Tier N' in all four places", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  // The cell resolves the stored number to the workspace option…
  assert.match(board, /tierCellValue\(String\(request\.tier\), optionSets\.tier\)/);
  // …saving refuses NaN and stores the bare number…
  assert.match(board, /const tier = Number\(tierDigits\(value\) \|\| value\);/);
  assert.match(board, /if \(Number\.isFinite\(tier\) && value\.trim\(\)\) onSave\(\{ tier \}\);/);
  // …the sort's option-order lookup aliases the digits…
  assert.match(board, /if \(key === "tier"\) \{\s*const digits = tierDigits\(choice\.value \?\? ""\);/);
  // …and the filter rule stores what the FIELD holds.
  assert.match(board, /entry\.key === "tier"\s*\?\s*tierDigits\(option\.value\) \|\| option\.value/);
});

test("saved sort/filter seeding waits for THIS board's real columns", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  // The gate: fallback columns are non-empty from the first render, so seeding
  // must wait for the loaded flag or it consumes itself reading zero rules.
  assert.match(board, /if \(columnsLoadedFor !== boardId\) return;/);
  assert.match(board, /setColumnsLoadedFor\(boardId\);/);
  const seedIndex = board.indexOf("setSortRules(readSortRules(allBoardColumns))");
  const gateIndex = board.indexOf("if (columnsLoadedFor !== boardId) return;");
  assert.ok(seedIndex > -1 && gateIndex > -1 && gateIndex < seedIndex,
    "the gate must run before the seed");
});

test("Escape and outside clicks close the sort and filter panels", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  // Both document-level closers must reset both panels. Two occurrences each:
  // the pointerdown path and the Escape path.
  const sortCloses = board.match(/setSortPanelOpen\(false\);/g) ?? [];
  const filterCloses = board.match(/setFilterPanelOpen\(false\);/g) ?? [];
  assert.ok(sortCloses.length >= 2, "sort panel must close from both closers");
  assert.ok(filterCloses.length >= 2, "filter panel must close from both closers");
});

test("'Create new item below' POSTs create_item (PATCH answers 400)", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const start = board.indexOf("const createItemBelow");
  assert.ok(start > -1);
  const body = board.slice(start, start + 1600);
  assert.match(body, /method: "POST"/);
  assert.match(body, /action: "create_item"/);
  assert.doesNotMatch(body, /method: "PATCH",\s*headers[\s\S]{0,200}create_item/);
});

test("the bulk-delete confirm speaks of the Recycle Bin, not permanence", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /Move \$\{requestIds\.length\} selected item[\s\S]{0,120}Recycle Bin/);
  assert.match(board, /moved to the Recycle Bin\./);
  assert.doesNotMatch(board, /selected item[\s\S]{0,80}This cannot be undone/);
});
