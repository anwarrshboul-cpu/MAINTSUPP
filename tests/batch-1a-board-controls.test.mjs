/**
 * Batch 1A — the board's sort, filter, reorder, pin and Due Date, plus the
 * export gate, the actor-aware audit and the open/closed reconciliation.
 *
 * WHY SO MUCH OF THIS RUNS THE REAL CODE
 *
 * Sorting and filtering are the two features on this board whose defects are
 * invisible on screen: a subsort that never fires and a filter that quietly
 * matches nothing both look like "there are no such rows". So the engines are
 * transpiled and CALLED here with real rows, rather than being pattern-matched
 * in source. Where a check is unavoidably about wiring — which route holds a
 * capability, which file records an audit event — it says so.
 *
 * `board-sort.ts` and `board-filter.ts` import each other's neighbours, so each
 * dependency is substituted for its own data: URL before its importer loads.
 * The pattern and the reason are lifted from
 * `stage-twentyfour-compliance-provenance.test.mjs`.
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

/* ── The module graph, wired by hand ─────────────────────────────────────── */

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

const pinning = await import(
  asModule(
    transpile(await read("app/(app)/portal/board-pinning.ts")).replace(
      /from ["']\.\/board-format["']/g,
      `from "${formatUrl}"`,
    ),
  )
);

const dates = await import(formatDateUrl);
const meters = await import(
  asModule(transpile(await read("app/(app)/portal/dashboard-meters.ts")))
);

/* ── Fixtures ────────────────────────────────────────────────────────────── */

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

const customColumn = (id, type, settings = {}, extra = {}) => ({
  kind: "custom",
  column: {
    id,
    key: id,
    title: id,
    type,
    position: 100,
    width: 160,
    settings,
    system: false,
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

/* ── Sorting ─────────────────────────────────────────────────────────────── */

test("a primary sort orders the board, and a second breaks its ties", () => {
  const columns = [systemColumn("priority"), systemColumn("requested")];
  const rows = [
    row({ priority: "Low", requestedAt: "2026-08-03T09:00:00.000Z" }),
    row({ priority: "Low", requestedAt: "2026-08-01T09:00:00.000Z" }),
    row({ priority: "High", requestedAt: "2026-08-02T09:00:00.000Z" }),
  ];

  const primaryOnly = sort.sortBoardRows(
    rows,
    [{ columnId: "col-priority", direction: "asc" }],
    context(columns),
  );
  assert.equal(primaryOnly[0].priority, "High", "the primary rule decides first");

  const withTieBreak = sort.sortBoardRows(
    rows,
    [
      { columnId: "col-priority", direction: "asc" },
      { columnId: "col-requested", direction: "asc" },
    ],
    context(columns),
  );
  assert.deepEqual(
    withTieBreak.map((entry) => entry.requestedAt),
    [
      "2026-08-02T09:00:00.000Z",
      "2026-08-01T09:00:00.000Z",
      "2026-08-03T09:00:00.000Z",
    ],
    "the two Low rows are separated by the second rule, not by chance",
  );
});

test("a third rule breaks the ties the second leaves", () => {
  const columns = [
    systemColumn("priority"),
    systemColumn("engineer"),
    systemColumn("requester"),
  ];
  const rows = [
    row({ priority: "Low", engineer: "Handyman", requester: "Zoe" }),
    row({ priority: "Low", engineer: "Handyman", requester: "Adam" }),
  ];
  const ordered = sort.sortBoardRows(
    rows,
    [
      { columnId: "col-priority", direction: "asc" },
      { columnId: "col-engineer", direction: "asc" },
      { columnId: "col-requester", direction: "asc" },
    ],
    context(columns),
  );
  assert.deepEqual(ordered.map((entry) => entry.requester), ["Adam", "Zoe"]);
});

test("an option column sorts by the workspace's own order, not the alphabet", () => {
  // Priority on this board is Medium, Low, Urgent. Alphabetical would put Low
  // above Medium and present that as ascending, which is wrong in the only way
  // that matters on a maintenance board.
  const columns = [systemColumn("priority")];
  const order = new Map([
    ["Medium", 0],
    ["Low", 1],
    ["Urgent", 2],
  ]);
  const rows = [row({ priority: "Urgent" }), row({ priority: "Low" }), row({ priority: "Medium" })];
  const ordered = sort.sortBoardRows(
    rows,
    [{ columnId: "col-priority", direction: "asc" }],
    context(columns, { optionOrderFor: () => order }),
  );
  assert.deepEqual(
    ordered.map((entry) => entry.priority),
    ["Medium", "Low", "Urgent"],
  );
});

test("empty values sort last in BOTH directions", () => {
  const columns = [systemColumn("contractor")];
  const rows = [row({ contractor: null }), row({ contractor: "Alpha" }), row({ contractor: "Beta" })];
  for (const direction of ["asc", "desc"]) {
    const ordered = sort.sortBoardRows(
      rows,
      [{ columnId: "col-contractor", direction }],
      context(columns),
    );
    assert.equal(
      ordered.at(-1).contractor,
      null,
      `a blank is missing data, not the smallest value (${direction})`,
    );
  }
});

test("rows no rule separates keep the board's own order", () => {
  const columns = [systemColumn("priority")];
  const rows = [row({ priority: "Low" }), row({ priority: "Low" })];
  const positions = new Map([[rows[0].id, 5], [rows[1].id, 2]]);
  const ordered = sort.sortBoardRows(
    rows,
    [{ columnId: "col-priority", direction: "asc" }],
    context(columns, { positionOf: (id) => positions.get(id) ?? 0 }),
  );
  assert.deepEqual(ordered.map((entry) => entry.id), [rows[1].id, rows[0].id]);
});

test("rules are added, reordered, flipped and removed without losing the rest", () => {
  let rules = sort.replaceSortRules("a", "asc");
  assert.deepEqual(rules, [{ columnId: "a", direction: "asc" }]);

  rules = sort.addSortRule(rules, "b", "desc");
  rules = sort.addSortRule(rules, "c", "asc");
  assert.deepEqual(rules.map((rule) => rule.columnId), ["a", "b", "c"]);

  // Adding a column already in the sort changes its direction rather than
  // appending a rule that could never fire.
  rules = sort.addSortRule(rules, "a", "desc");
  assert.equal(rules.length, 3);
  assert.equal(sort.sortDirectionFor(rules, "a"), "desc");

  rules = sort.moveSortRule(rules, "c", -1);
  assert.deepEqual(rules.map((rule) => rule.columnId), ["a", "c", "b"]);

  // Out of range moves nothing rather than wrapping to the other end.
  assert.deepEqual(sort.moveSortRule(rules, "a", -1), rules);
  assert.deepEqual(sort.moveSortRule(rules, "b", 1), rules);

  rules = sort.flipSortRule(rules, "c");
  assert.equal(sort.sortDirectionFor(rules, "c"), "desc");

  rules = sort.removeSortRule(rules, "c");
  assert.deepEqual(rules.map((rule) => rule.columnId), ["a", "b"]);
  assert.equal(sort.sortRuleIndex(rules, "c"), -1);

  // And a header click still means "this column alone".
  assert.deepEqual(sort.replaceSortRules("b", "asc"), [
    { columnId: "b", direction: "asc" },
  ]);
});

test("the sort survives a reload, and a board saved before multi-sort still reads", () => {
  const columns = [
    systemColumn("priority", { id: "col-priority", position: 10, settings: { sort: "desc", sortPriority: 1 } }),
    systemColumn("status", { id: "col-status", position: 20, settings: { sort: "asc", sortPriority: 0 } }),
  ];
  assert.deepEqual(sort.readSortRules(columns), [
    { columnId: "col-status", direction: "asc" },
    { columnId: "col-priority", direction: "desc" },
  ]);

  // The single sort this replaced wrote `sort` and no priority. It reads back
  // as a one-rule list rather than as nothing.
  const legacy = [systemColumn("status", { id: "col-status", settings: { sort: "desc" } })];
  assert.deepEqual(sort.readSortRules(legacy), [
    { columnId: "col-status", direction: "desc" },
  ]);
});

test("a column dropped from the sort keeps neither half of it", () => {
  const rules = [
    { columnId: "a", direction: "asc" },
    { columnId: "b", direction: "desc" },
  ];
  assert.deepEqual(sort.sortSettingsFor({ wrap: true }, rules, "b"), {
    wrap: true,
    sort: "desc",
    sortPriority: 1,
  });
  assert.deepEqual(
    sort.sortSettingsFor({ wrap: true, sort: "asc", sortPriority: 3 }, rules, "z"),
    { wrap: true },
    "a priority with no direction orders nothing, so it goes with it",
  );
});

/* ── Filtering ───────────────────────────────────────────────────────────── */

const AND = (rules) => ({ join: "and", rules });
const OR = (rules) => ({ join: "or", rules });

test("a text filter narrows the board", () => {
  const columns = [systemColumn("description")];
  const rows = [
    row({ description: "Leaking tap in the back kitchen" }),
    row({ description: "Front door closer" }),
  ];
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-description", operator: "contains", values: ["tap"] }]),
    context(columns),
  );
  assert.equal(matched.length, 1);
  assert.match(matched[0].description, /Leaking tap/);
});

test("a numeric filter compares numbers, not text", () => {
  const columns = [systemColumn("cost")];
  const rows = [row({ cost: 90 }), row({ cost: 1000 }), row({ cost: null })];
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-cost", operator: "greater_than", values: ["100"] }]),
    context(columns),
  );
  assert.deepEqual(matched.map((entry) => entry.cost), [1000]);
});

test("a date filter reads the relative window a date column is filtered with", () => {
  const columns = [systemColumn("dueDate")];
  const today = new Date();
  const soon = new Date(today.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
  const rows = [row({ dueAt: soon }), row({ dueAt: later }), row({ dueAt: null })];
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-dueDate", operator: "within_the_next", values: ["7"] }]),
    context(columns),
  );
  assert.deepEqual(matched.map((entry) => entry.dueAt), [soon]);
});

test("an option filter matches the value the job carries", () => {
  const columns = [systemColumn("priority")];
  const rows = [row({ priority: "Urgent" }), row({ priority: "Low" })];
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-priority", operator: "any_of", values: ["Urgent"] }]),
    context(columns),
  );
  assert.deepEqual(matched.map((entry) => entry.priority), ["Urgent"]);
});

test("empty and non-empty are answerable", () => {
  const columns = [systemColumn("contractor")];
  const rows = [row({ contractor: null }), row({ contractor: "Alpha" })];
  assert.equal(
    filter.applyBoardFilter(
      rows,
      AND([{ columnId: "col-contractor", operator: "is_empty", values: [] }]),
      context(columns),
    ).length,
    1,
  );
  assert.equal(
    filter.applyBoardFilter(
      rows,
      AND([{ columnId: "col-contractor", operator: "is_not_empty", values: [] }]),
      context(columns),
    )[0].contractor,
    "Alpha",
  );
});

test("several rules combine with All, and with Any", () => {
  const columns = [systemColumn("priority"), systemColumn("engineer")];
  const rows = [
    row({ priority: "Urgent", engineer: "Handyman" }),
    row({ priority: "Low", engineer: "Electrician" }),
    row({ priority: "Urgent", engineer: "Electrician" }),
  ];
  const rules = [
    { columnId: "col-priority", operator: "any_of", values: ["Urgent"] },
    { columnId: "col-engineer", operator: "any_of", values: ["Electrician"] },
  ];
  assert.equal(
    filter.applyBoardFilter(rows, AND(rules), context(columns)).length,
    1,
    "All means both",
  );
  assert.equal(
    filter.applyBoardFilter(rows, OR(rules), context(columns)).length,
    3,
    "Any means either",
  );
});

test("a workspace column filters on what its cell SHOWS, not on the stored id", () => {
  const column = customColumn("col-type", "status", {
    choices: [
      { id: "choice-kiosk", label: "Kiosk", color: "#000" },
      { id: "choice-store", label: "Store", color: "#111" },
    ],
  });
  const rows = [row(), row()];
  const cells = {
    [`${rows[0].id}::col-type`]: "choice-kiosk",
    [`${rows[1].id}::col-type`]: "choice-store",
  };
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-type", operator: "any_of", values: ["Kiosk"] }]),
    context([column], { cells }),
  );
  assert.deepEqual(matched.map((entry) => entry.id), [rows[0].id]);
});

test("clearing the filter puts every row back", () => {
  const columns = [systemColumn("priority")];
  const rows = [row({ priority: "Urgent" }), row({ priority: "Low" })];
  assert.equal(
    filter.applyBoardFilter(rows, { join: "and", rules: [] }, context(columns)).length,
    2,
  );
  assert.deepEqual(filter.EMPTY_FILTER, { join: "and", rules: [] });
});

test("a rule naming a column the board no longer has cannot empty it", () => {
  const columns = [systemColumn("priority")];
  const rows = [row(), row()];
  const matched = filter.applyBoardFilter(
    rows,
    AND([{ columnId: "col-deleted", operator: "any_of", values: ["anything"] }]),
    context(columns),
  );
  assert.equal(matched.length, 2, "failing closed here would look like data loss");
});

test("the filter survives a reload, join included", () => {
  const columns = [
    customColumn("col-a", "text", {
      filter: { operator: "contains", values: ["tap"] },
      filterJoin: "or",
    }, { position: 10 }),
    customColumn("col-b", "text", {
      filter: { operator: "is_empty", values: [] },
      filterJoin: "or",
    }, { position: 20 }),
  ];
  const state = filter.readFilterState(columns);
  assert.equal(state.join, "or");
  assert.deepEqual(state.rules, [
    { columnId: "col-a", operator: "contains", values: ["tap"] },
    { columnId: "col-b", operator: "is_empty", values: [] },
  ]);

  // And what one column stores, including the join it mirrors.
  assert.deepEqual(
    filter.filterSettingsFor({ wrap: false }, state, "col-a"),
    { wrap: false, filter: { operator: "contains", values: ["tap"] }, filterJoin: "or" },
  );
  assert.deepEqual(
    filter.filterSettingsFor({ wrap: false, filter: {}, filterJoin: "or" }, state, "col-z"),
    { wrap: false },
    "a column with no rule carries no opinion about how rules combine",
  );
});

test("only sensible operators are offered for a column's kind", () => {
  const keys = (entry) => filter.operatorsFor(entry).map((operator) => operator.key);
  assert.deepEqual(keys(systemColumn("priority")), [
    "any_of",
    "not_any_of",
    "is_empty",
    "is_not_empty",
  ]);
  assert.ok(keys(systemColumn("cost")).includes("between"));
  assert.ok(
    !keys(systemColumn("dueDate")).includes("greater_than"),
    "the engine compares dates numerically, which for YYYY-MM-DD is NaN",
  );
  assert.ok(keys(systemColumn("dueDate")).includes("within_the_next"));
  assert.equal(
    filter.filterFieldFor(systemColumn("subitems")),
    null,
    "Subitems is an expander, not a value",
  );
  assert.equal(filter.filterFieldFor(systemColumn("dueDate")), "dueAt");
});

/* ── Freezing ────────────────────────────────────────────────────────────── */

test("pinned columns are laid out from the widths ahead of them", () => {
  const columns = [
    systemColumn("name", { id: "col-name", width: 200 }),
    systemColumn("status", { id: "col-status", width: 150, pinned: true }),
    systemColumn("cost", { id: "col-cost", width: 120 }),
    systemColumn("invoice", { id: "col-invoice", width: 130, pinned: true }),
  ];
  const offsets = pinning.stickyColumnOffsets(columns, false);

  assert.equal(offsets.get("col-name").left, pinning.STICKY_RUN_START);
  assert.equal(offsets.get("col-status").left, pinning.STICKY_RUN_START + 200);
  assert.equal(
    offsets.get("col-invoice").left,
    pinning.STICKY_RUN_START + 200 + 150,
    "a pin two columns away still stacks against the run, not against its neighbour",
  );
  assert.equal(offsets.has("col-cost"), false, "an unpinned column scrolls");

  // Later pins pass UNDER earlier ones as the grid scrolls sideways.
  assert.ok(
    pinning.stickyZIndex(offsets.get("col-status").order, false) >
      pinning.stickyZIndex(offsets.get("col-invoice").order, false),
  );
  // A header covers the rows sliding beneath it.
  assert.ok(pinning.stickyZIndex(0, true) > pinning.stickyZIndex(0, false));
});

test("a resize moves every pin to its right", () => {
  const wide = [
    systemColumn("name", { id: "col-name", width: 300 }),
    systemColumn("status", { id: "col-status", width: 150, pinned: true }),
  ];
  assert.equal(
    pinning.stickyColumnOffsets(wide, false).get("col-status").left,
    pinning.STICKY_RUN_START + 300,
  );
});

test("unpinning takes a column out of the run, and a phone freezes nothing", () => {
  const columns = [
    systemColumn("name", { id: "col-name", width: 200 }),
    systemColumn("status", { id: "col-status", width: 150, pinned: false }),
  ];
  const offsets = pinning.stickyColumnOffsets(columns, false);
  assert.equal(offsets.has("col-status"), false);
  assert.equal(offsets.has("col-name"), true, "the Items column is sticky either way");

  assert.equal(
    pinning.stickyColumnOffsets(columns, true).size,
    0,
    "two frozen columns on a 390px screen leave nothing to scroll",
  );
});

/* ── Dates ───────────────────────────────────────────────────────────────── */

test("every shared date form is en-GB, day before month", () => {
  assert.equal(dates.formatDate("2026-11-24"), "24/11/2026");
  assert.equal(dates.formatShortDate("2026-11-24"), "24 Nov 2026");
  assert.equal(dates.formatLongDate("2026-11-24"), "24 November 2026");
  assert.equal(dates.formatDayMonth("2026-11-24"), "24 Nov");
  assert.equal(dates.formatMonthYear("2026-11-24"), "November 2026");
  assert.equal(dates.formatDate(null), "—");
  assert.equal(dates.formatDate("not a date"), "—");
  assert.equal(dates.formatDate("", { fallback: "" }), "");
});

test("a date-only value cannot shift a day, whatever zone the reader is in", () => {
  /*
   * `new Date("2026-11-24")` is midnight UTC by specification, so a viewer west
   * of Greenwich renders it as the 23rd — which is how a PAT certificate came
   * to read a day early. The shared formatter splits a bare YYYY-MM-DD into
   * three numbers and formats them in UTC, so no zone can reach it.
   */
  assert.equal(dates.formatDate("2026-11-24", { timeZone: "America/New_York" }), "24/11/2026");
  assert.equal(dates.formatShortDate("2026-01-01", { timeZone: "Pacific/Auckland" }), "1 Jan 2026");
});

test("no UI writes a date through en-US any more", async () => {
  // Four of the nine formatters a completion audit found asked `Intl` for
  // en-US, including the one every date cell on the maintenance board used.
  for (const file of [
    "app/(app)/portal/board-format.ts",
    "app/(app)/portal/portal-app.tsx",
    "app/(app)/portal/live-board.tsx",
    "app/(app)/portal/views/view-model.ts",
    "app/lib/expiry-status.ts",
  ]) {
    const source = await read(file);
    assert.ok(
      !source.includes('"en-US"'),
      `${file} must not format a date in US order — this product is UK`,
    );
  }
});

/* ── Open and closed ─────────────────────────────────────────────────────── */

test("open and closed are one predicate, and they partition the rows", () => {
  const rows = [
    row({ stage: "Completed", status: "Pending Scheduling" }),
    row({ stage: "Incoming", status: "Job Completed" }),
    row({ stage: "Completed", status: "Job Completed" }),
    row({ stage: "Incoming", status: "Pending Scheduling" }),
  ];
  assert.equal(meters.isClosedRequest(rows[0]), true, "the stage alone closes a job");
  assert.equal(
    meters.isClosedRequest(rows[1]),
    true,
    "and so does the status alone — the imported rows carry no stage",
  );
  assert.equal(meters.isClosedRequest(rows[2]), true);
  assert.equal(meters.isOpenRequest(rows[3]), true);

  const open = rows.filter(meters.isOpenRequest);
  const closed = rows.filter(meters.isClosedRequest);
  assert.equal(open.length + closed.length, rows.length, "every row is one or the other");
  assert.equal(
    open.filter((entry) => closed.includes(entry)).length,
    0,
    "and never both",
  );
});

test("the dashboard reads the same predicate as the board's meters", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /import \{[\s\S]{0,200}isOpenRequest,[\s\S]{0,80}\} from "\.\/dashboard-meters"/,
    "Overview must not re-derive what finished means",
  );
  assert.match(portal, /const open = scopedRequests\.filter\(isOpenRequest\);/);
  assert.match(portal, /const completed = scopedRequests\.filter\(isClosedRequest\);/);
  assert.ok(
    !/scopedRequests\.filter\(\(request\) => request\.stage [!=]== "Completed"\)/.test(portal),
    "the stage-only test is what made the two screens disagree",
  );
});

/* ── Permissions, audit and the routes that hold them ────────────────────── */

test("the board's CSV is produced by a route that holds data.export", async () => {
  const route = await read("app/api/board/csv/route.ts");
  assert.match(route, /scopedDbWithCapability\(request, "data\.export"\)/);
  assert.match(route, /if \(guard\.denied\) return guard\.denied;/);
  assert.match(route, /action: "data\.exported"/, "an export is worth recording");

  // And the browser no longer assembles one out of rows it already holds.
  const exporter = await read("app/(app)/portal/board-export.ts");
  assert.match(exporter, /fetch\("\/api\/board\/csv"/);
  assert.ok(
    !exporter.includes("new Blob([csv]"),
    "a file built in the page cannot be gated by anything",
  );

  // The controls follow the same answer the server enforces with.
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /const canExport = useCapability\("data\.export"\)/);
  assert.match(board, /\{canExport !== false && \(/);
});

test("/api/context publishes the caller's own effective capabilities", async () => {
  const route = await read("app/api/context/route.ts");
  assert.match(route, /capabilities: effectiveCapabilities\(/);
  assert.match(route, /resolvePermissions\(context\.db, context\.orgId, context\.actor\.role\)/);
});

test("structural board changes record who made them", async () => {
  const board = await read("app/api/board/route.ts");
  // The verb, not the whole line: `delete_column` and `clear_column` share one
  // call and choose between two verbs in a ternary.
  for (const action of [
    "board.column_created",
    "board.column_updated",
    "board.column_deleted",
    "board.column_cleared",
    "board.group_created",
    "board.group_renamed",
    "board.group_reordered",
    "board.group_deleted",
  ]) {
    assert.ok(board.includes(`"${action}"`), `${action} must be recorded`);
  }
  // The actor, and whether they proved who they are, come from one helper.
  assert.match(board, /auditActor\(\{ actor, identityEmail, session \}\)/);

  const columns = await read("app/api/board/columns/route.ts");
  assert.match(columns, /action: "board\.columns_reordered"/);

  const views = await read("app/api/board/views/route.ts");
  for (const action of ["board.view_created", "board.view_updated", "board.view_deleted"]) {
    assert.match(views, new RegExp(`action: "${action}"`));
  }

  const navigation = await read("app/api/navigation/route.ts");
  assert.match(navigation, /action:\s*kind === "reset"\s*\?\s*"navigation\.default_reset"/);

  const dashboard = await read("app/api/dashboard-layout/route.ts");
  assert.match(dashboard, /action: "dashboard\.default_changed"/);

  const sections = await read("app/api/workspace-sections/route.ts");
  assert.match(sections, /"workspace\.section_created"/);
  assert.match(sections, /"workspace\.section_archived"/);
});

test("a width drag and a sort direction are deliberately NOT audited", async () => {
  /*
   * The noise/value trade W13-05 asks for. Both fire many times a minute and
   * are per-column preferences rather than structure; recording them would bury
   * the events somebody is actually looking for.
   */
  const board = await read("app/api/board/route.ts");
  const structural = board.slice(
    board.indexOf("function structuralColumnChange"),
    board.indexOf("function columnPayload"),
  );
  assert.ok(!structural.includes("width"), "a resize is not a structural change");
  assert.ok(!/before\.settings/.test(structural), "nor is a sort direction");
});

test("the audit viewer is reachable, and only by a role that may read it", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /audit: \{\s*label: "Audit",/, "it must be in the catalogue");
  assert.match(portal, /audit: "audit",/, "and have a destination");
  assert.match(
    portal,
    /return runtimeContext\?\.capabilities\?\.\["audit\.read"\] === true;/,
    "an organisation-wide record of who did what is not advertised to a role that may not read it",
  );
  assert.match(portal, /\{activeSurface === "audit" && <AuditLog \/>\}/);

  // The route still enforces it on the server, which is where the rule lives.
  const api = await read("app/api/audit/route.ts");
  assert.match(api, /requireCapability\(subject, "audit\.read"\)/);
});

test("item_activity has a reader", async () => {
  // It was written in one place and read in none. The drawer's Activity tab
  // merges it with activity_log, which is the only way a per-column before and
  // after reaches a screen.
  const route = await read("app/api/maintenance/route.ts");
  assert.match(route, /\.from\(itemActivity\)/);
  assert.match(route, /exposeItemActivity/);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /entry\.action === "column\.value_changed"/);
});

test("a board view goes to the recycle bin rather than to nothing", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  assert.match(bin, /export async function sendBoardViewToBin/);
  assert.match(bin, /entry\.entityType === "board_view"\) return restoreBoardView/);

  const views = await read("app/api/board/views/route.ts");
  assert.match(views, /sendBoardViewToBin\(/);
  assert.ok(
    !/\.delete\(boardViews\)/.test(views),
    "the DELETE handler must not still remove the row itself",
  );

  const trash = await read("app/api/trash/route.ts");
  assert.match(trash, /entityType === "board_view"/);
});

test("boardFilterOperatorsMatchTheEngine", async () => {
  /*
   * The board route keeps its own copy of the thirteen operator names so an API
   * route need not import a module out of the client graph to read thirteen
   * strings — the same trade `ROLE_RANK` in lib/permissions.ts makes, and named
   * in the comment beside it. Two copies are only safe while something checks
   * they agree, which is this.
   */
  const route = await read("app/api/board/route.ts");
  const block = route.slice(
    route.indexOf("const BOARD_FILTER_OPERATORS"),
    route.indexOf("function validOptionColor"),
  );
  const server = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();

  const engine = await read("app/(app)/portal/views/view-model.ts");
  const list = engine.slice(
    engine.indexOf("export const FILTER_OPERATORS"),
    engine.indexOf("function fieldValue"),
  );
  const client = [...list.matchAll(/key: "([a-z_]+)"/g)].map((match) => match[1]).sort();

  assert.equal(client.length, 13, "monday publishes thirteen operators");
  assert.deepEqual(server, client, "the server's copy has drifted from the engine");
});

/* ── The Due Date column ─────────────────────────────────────────────────── */

test("Due Date is the canonical field, not a cell beside it", async () => {
  const spec = await read("db/monday-board-spec.ts");
  assert.match(spec, /key: "dueDate", title: "Due Date", type: "date"/);

  const board = await read("app/(app)/portal/live-board.tsx");
  const cell = board.slice(board.indexOf('case "dueDate":'), board.indexOf('case "timeline":'));
  assert.match(cell, /value=\{request\.dueAt\}/, "it reads the job's own deadline");
  assert.match(cell, /onSave\(\{ dueAt \}\)/, "and writes the same field");
  assert.ok(
    !/onSaveCustom/.test(cell),
    "a cell of its own would be a second deadline the calendar cannot see",
  );

  // Sorting it and sorting Timeline must agree — they read one field.
  const ordering = await read("app/(app)/portal/board-ordering.ts");
  const block = ordering.slice(ordering.indexOf('case "timeline":'));
  assert.match(block.slice(0, 400), /case "dueDate":/);
});
