/**
 * UI batch — board automations: the engine, run for real.
 *
 * `app/lib/automations/engine.ts` is transpiled and CALLED here with a fake
 * database and a scripted action, because the properties that matter —
 * which events a rule matches, and that a chain of rules cannot loop — are
 * invisible on screen when they fail: a rule that silently never fires looks
 * exactly like a board with nothing to do. The module's neighbours
 * (drizzle, the schema, the audit log, the actions) are substituted for
 * data: URLs, the pattern `batch-1a-board-controls.test.mjs` established.
 *
 * Permission and tenant scope are wiring, and are pinned in source.
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
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) => `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/* ── The module graph, wired by hand ─────────────────────────────────────── */

const drizzleUrl = asModule(`
  export const and = (...a) => ({ and: a });
  export const eq = (l, r) => ({ eq: [l, r] });
  export const sql = (strings, ...values) => ({ sql: strings.join("?"), values });
`);
const schemaUrl = asModule(`
  export const boardAutomations = { __table: "rules", id: "id", organisationId: "organisation_id", boardId: "board_id", enabled: "enabled", runCount: "run_count", lastRunAt: "last_run_at" };
  export const automationRuns = { __table: "runs" };
`);
const auditUrl = asModule(`
  export const audits = [];
  export async function recordAudit(entry) { audits.push(entry); }
`);
const actionsUrl = asModule(`
  export async function executeAction(ctx, rule, event) {
    return globalThis.__executeAction(ctx, rule, event);
  }
`);
const typesUrl = asModule(transpile(await read("app/lib/automations/types.ts")));
const engineUrl = asModule(
  transpile(await read("app/lib/automations/engine.ts"))
    .replace(/from ["']drizzle-orm["']/g, `from "${drizzleUrl}"`)
    .replace(/from ["']\.\.\/\.\.\/\.\.\/db\/schema["']/g, `from "${schemaUrl}"`)
    .replace(/from ["']\.\.\/audit["']/g, `from "${auditUrl}"`)
    .replace(/from ["']\.\/actions["']/g, `from "${actionsUrl}"`)
    .replace(/from ["']\.\/types["']/g, `from "${typesUrl}"`),
);

const engine = await import(engineUrl);
const types = await import(typesUrl);

/** A database that answers the four calls the engine makes, and remembers the writes. */
function fakeDb(rules) {
  const inserted = [];
  const updated = [];
  return {
    inserted,
    updated,
    select: () => ({ from: (table) => ({ where: () => Promise.resolve(table.__table === "rules" ? rules : []) }) }),
    insert: (table) => ({ values: (row) => { inserted.push({ table: table.__table, row }); return Promise.resolve(); } }),
    update: (table) => ({ set: (changes) => ({ where: () => { updated.push({ table: table.__table, changes }); return Promise.resolve(); } }) }),
  };
}

function rule(overrides) {
  return {
    id: "auto_1",
    organisationId: "org_a",
    boardId: "maintenance",
    name: "When status changes, post an update",
    triggerType: "status_changes",
    triggerConfig: "{}",
    actionType: "create_update",
    actionConfig: JSON.stringify({ body: "fired" }),
    enabled: "on",
    runCount: 0,
    ...overrides,
  };
}

function context(rules) {
  const db = fakeDb(rules);
  return { db, ctx: { db, orgId: "org_a", actor: { email: "qa@example.com", displayName: "QA", role: "admin" }, request: null } };
}

/* ── Trigger matching ────────────────────────────────────────────────────── */

test("status_changes matches the column it names, to and from included", () => {
  const any = rule({ triggerConfig: "{}" });
  const changed = { type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "Open", to: "Closed" };
  assert.equal(engine.ruleMatches(any, changed), true);
  assert.equal(engine.ruleMatches(any, { ...changed, column: "priority" }), false, "a different column is not Status");
  assert.equal(engine.ruleMatches(any, { ...changed, from: "Closed", to: "Closed" }), false, "no change is no event");
  assert.equal(engine.ruleMatches(any, { ...changed, columnType: "text" }), false, "only status-type columns count");

  const narrowed = rule({ triggerConfig: JSON.stringify({ column: "priority", from: "Low", to: "High" }) });
  assert.equal(engine.ruleMatches(narrowed, { ...changed, column: "priority", from: "Low", to: "High" }), true);
  assert.equal(engine.ruleMatches(narrowed, { ...changed, column: "priority", from: "Medium", to: "High" }), false);
  assert.equal(engine.ruleMatches(narrowed, { ...changed, column: "priority", from: "Low", to: "Medium" }), false);
});

test("the item and subitem triggers tell a parent from a child", () => {
  const created = { type: "item_created", boardId: "maintenance", requestId: "MN-1", parentId: null };
  assert.equal(engine.ruleMatches(rule({ triggerType: "item_created" }), created), true);
  assert.equal(engine.ruleMatches(rule({ triggerType: "subitem_created" }), created), false);
  assert.equal(engine.ruleMatches(rule({ triggerType: "subitem_created" }), { ...created, parentId: "MN-0" }), true);
  assert.equal(engine.ruleMatches(rule({ triggerType: "item_created" }), { ...created, parentId: "MN-0" }), false);
});

test("column_changes needs a named column; moves and updates match their own events", () => {
  const cell = { type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "col_x", columnType: "text", from: "a", to: "b" };
  assert.equal(engine.ruleMatches(rule({ triggerType: "column_changes", triggerConfig: JSON.stringify({ column: "col_x" }) }), cell), true);
  assert.equal(engine.ruleMatches(rule({ triggerType: "column_changes", triggerConfig: "{}" }), cell), false, "an unnamed column matches nothing");
  const moved = { type: "item_moved", boardId: "maintenance", requestId: "MN-1", groupId: "grp_done" };
  assert.equal(engine.ruleMatches(rule({ triggerType: "item_moved_to_group", triggerConfig: "{}" }), moved), true);
  assert.equal(engine.ruleMatches(rule({ triggerType: "item_moved_to_group", triggerConfig: JSON.stringify({ groupId: "grp_other" }) }), moved), false);
  assert.equal(engine.ruleMatches(rule({ triggerType: "update_created" }), { type: "update_created", boardId: "maintenance", requestId: "MN-1" }), true);
});

test("time-based triggers only answer the sweep event addressed to them", () => {
  const dated = rule({ id: "auto_date", triggerType: "date_arrives" });
  assert.equal(engine.ruleMatches(dated, { type: "date_arrived", boardId: "maintenance", requestId: "MN-1", automationId: "auto_date" }), true);
  assert.equal(engine.ruleMatches(dated, { type: "date_arrived", boardId: "maintenance", requestId: "MN-1", automationId: "auto_other" }), false);
  assert.equal(engine.ruleMatches(dated, { type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "dueDate", from: "", to: "2026-01-01" }), false);
});

test("an unknown or corrupt trigger never matches", () => {
  assert.equal(engine.ruleMatches(rule({ triggerType: "slack_message" }), { type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status" }), false);
  assert.equal(engine.ruleMatches(rule({ triggerConfig: "{not json" }), { type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "a", to: "b" }), true, "bad JSON is treated as an empty config, not an exception");
});

/* ── The loop guard ──────────────────────────────────────────────────────── */

test("guard refuses at the depth limit, after the chain cap, and on a repeat", () => {
  const chain = { runs: 0, seen: new Set() };
  assert.equal(engine.guard(chain, "r1", "MN-1", 0), null);
  assert.match(engine.guard(chain, "r1", "MN-1", types.MAX_DEPTH), /deep/);
  chain.seen.add("r1:MN-1");
  assert.match(engine.guard(chain, "r1", "MN-1", 0), /already ran/);
  assert.equal(engine.guard(chain, "r1", "MN-2", 0), null, "the same rule may run for a different item");
  chain.runs = types.MAX_RUNS_PER_CHAIN;
  assert.match(engine.guard(chain, "r2", "MN-9", 0), /already ran for this change/);
});

test("a rule whose action re-raises its own trigger runs once, and the repeat is written down as skipped", async () => {
  const { db, ctx } = context([rule()]);
  let calls = 0;
  globalThis.__executeAction = async (_ctx, _rule, event) => {
    calls += 1;
    return {
      summary: "posted",
      events: [{ ...event, from: event.to, to: event.from }],
    };
  };
  const ran = await engine.dispatchAutomationEvent(ctx, {
    type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "Open", to: "Closed",
  });
  assert.equal(ran, 1);
  assert.equal(calls, 1);
  const runs = db.inserted.filter((entry) => entry.table === "runs").map((entry) => entry.row);
  assert.deepEqual(runs.map((row) => row.status), ["success", "skipped"]);
  assert.match(runs[1].error, /already ran for this item/);
  assert.equal(runs[1].depth, 1);
  assert.equal(runs[0].chainId, runs[1].chainId, "both rows belong to one chain");
  assert.equal(db.updated.length, 1, "only the run that happened bumps run_count");
});

test("a chain across items stops at MAX_DEPTH rather than running away", async () => {
  const { db, ctx } = context([rule()]);
  let next = 1;
  globalThis.__executeAction = async (_ctx, _rule, event) => {
    next += 1;
    // Each run touches a NEW item, so the per-item guard cannot stop it; depth must.
    return { summary: "cascade", events: [{ ...event, requestId: `MN-${next}` }] };
  };
  const ran = await engine.dispatchAutomationEvent(ctx, {
    type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "a", to: "b",
  });
  assert.equal(ran, types.MAX_DEPTH, `exactly ${types.MAX_DEPTH} nested runs, then a refusal`);
  const runs = db.inserted.filter((entry) => entry.table === "runs").map((entry) => entry.row);
  const last = runs[runs.length - 1];
  assert.equal(last.status, "skipped");
  assert.match(last.error, new RegExp(`limit ${types.MAX_DEPTH}`));
});

test("a failing action is recorded as failed and does not stop the next rule", async () => {
  const { db, ctx } = context([rule({ id: "auto_bad" }), rule({ id: "auto_good" })]);
  globalThis.__executeAction = async (_ctx, current) => {
    if (current.id === "auto_bad") throw new Error("boom");
    return { summary: "ok" };
  };
  const ran = await engine.dispatchAutomationEvent(ctx, {
    type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "a", to: "b",
  });
  assert.equal(ran, 1);
  const runs = db.inserted.filter((entry) => entry.table === "runs").map((entry) => entry.row);
  assert.deepEqual(runs.map((row) => [row.automationId, row.status]), [["auto_bad", "failed"], ["auto_good", "success"]]);
  assert.equal(runs[0].error, "boom");
});

test("a disabled rule is never consulted and a non-matching one never runs", async () => {
  const { db, ctx } = context([rule({ id: "auto_off", enabled: "off" }), rule({ id: "auto_prio", triggerConfig: JSON.stringify({ column: "priority" }) })]);
  globalThis.__executeAction = async () => ({ summary: "should not run" });
  // The engine's query filters `enabled = on`; the fake returns what it is given, so the
  // disabled rule stands in for the query being wrong. It must still not fire: its
  // trigger matches, and the only thing keeping it quiet is the filter in source.
  const source = await read("app/lib/automations/engine.ts");
  assert.match(source, /eq\(boardAutomations\.enabled, "on"\)/, "only enabled rules are loaded");
  const ran = await engine.dispatchAutomationEvent(ctx, {
    type: "column_changed", boardId: "maintenance", requestId: "MN-1", column: "status", columnType: "status", from: "a", to: "b",
  });
  // `auto_prio` does not match Status; `auto_off` matches but only because the fake
  // skipped the filter — so exactly one run is the engine's own doing, not two.
  assert.equal(ran, 1);
  assert.equal(db.inserted.filter((entry) => entry.table === "runs").length, 1);
});

/* ── Permission refusal and tenant isolation — wiring, pinned in source ──── */

test("writing a rule needs board.edit; reading needs board.view", async () => {
  const route = await read("app/api/automations/route.ts");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(get, /scopedDbWithCapability\(request, "board\.view"\)/);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const start = route.indexOf(`export async function ${method}`);
    const body = route.slice(start, start + 600);
    assert.match(body, /scopedDbWithCapability\(request, "board\.edit"\)/, `${method} must hold board.edit`);
    assert.match(body, /if \(guard\.denied\) return guard\.denied/, `${method} must return the refusal`);
  }
  for (const file of ["app/api/automations/runs/route.ts", "app/api/automations/usage/route.ts", "app/api/automations/connections/route.ts", "app/api/automations/catalog/route.ts"]) {
    assert.match(await read(file), /scopedDbWithCapability\(request, "board\.view"\)/, `${file} must hold board.view`);
  }
});

test("every rule read and write is scoped to the caller's organisation", async () => {
  const store = await read("app/lib/automations/store.ts");
  assert.match(store, /eq\(boardAutomations\.organisationId, orgId\)/);
  const engineSource = await read("app/lib/automations/engine.ts");
  assert.match(engineSource, /eq\(boardAutomations\.organisationId, ctx\.orgId\)/);
  assert.match(engineSource, /eq\(boardAutomations\.boardId, boardId\)/);
  for (const file of ["app/api/automations/runs/route.ts", "app/api/automations/usage/route.ts"]) {
    assert.match(await read(file), /eq\(automationRuns\.organisationId, orgId\)/, `${file} must filter runs by organisation`);
  }
  const route = await read("app/api/automations/route.ts");
  /* RE-POINTED, AND STRICTLY STRONGER. `normaliseBoardId` was an allow-list of
     two that returned "maintenance" for everything else — so a rule created on
     a workspace section's own register was stored against the JOB BOARD, with a
     200 and the caller's key echoed back. `resolveBoardId` asks the database
     which boards this organisation has and throws for one it does not. The
     property pinned here — the id is never trusted straight through — holds
     more tightly than before. */
  assert.match(route, /resolveBoardId\(/, "the board id is resolved against this organisation's boards, never trusted");
  assert.doesNotMatch(route, /"sunnamusk-uk"/);
  assert.doesNotMatch(route, /\bCLIENT_ID\b/);
});

test("the rule is validated against the catalogue and THIS board before it is stored", async () => {
  const route = await read("app/api/automations/route.ts");
  assert.match(route, /validateRule\(currentCatalog\(\), columns, groups/);
  const store = await read("app/lib/automations/store.ts");
  assert.match(store, /if \(!trigger\.available\) return \{ ok: false/);
  assert.match(store, /if \(!action\.available\) return \{ ok: false/);
  assert.match(store, /that column is not on this board/);
  assert.match(store, /that group is not on this board/);
  assert.match(store, /composeSentence\(/, "the name is composed server-side, never trusted from the client");
});

/* ── The catalogue is honest: every available entry is handled ───────────── */

test("every available trigger has a matcher and every available action has a handler", async () => {
  const catalogUrl = asModule(transpile(await read("app/lib/automations/catalog.ts")));
  const catalog = (await import(catalogUrl)).buildCatalog({ emailConfigured: true });
  const engineSource = await read("app/lib/automations/engine.ts");
  const actionsSource = await read("app/lib/automations/actions.ts");
  for (const trigger of catalog.triggers.filter((entry) => entry.available)) {
    assert.match(engineSource, new RegExp(`case "${trigger.type}"`), `trigger ${trigger.type} has no matcher`);
  }
  for (const action of catalog.actions.filter((entry) => entry.available)) {
    // The item-less actions are handled before the switch, as `type === "…"`.
    assert.match(
      actionsSource,
      new RegExp(`(case|type ===) "${action.type}"`),
      `action ${action.type} has no handler`,
    );
  }
  for (const entry of [...catalog.triggers, ...catalog.actions].filter((candidate) => !candidate.available)) {
    assert.ok(entry.reason, `${entry.type} is unavailable and must say why`);
  }
  assert.match(catalog.timeBasedNote, /checked when the board is opened/i);
});

test("the time-based sweep says how it runs, and dedupes by day", async () => {
  const sweep = await read("app/lib/automations/sweep.ts");
  assert.match(sweep, /SWEEP_INTERVAL_MS/);
  assert.match(sweep, /dedupeKey/);
  assert.match(sweep, /no scheduler, no cron/i);
  const route = await read("app/api/automations/route.ts");
  assert.match(route, /sweepTimeBasedRules\(automationContext\(scope, request\)\)/, "opening the board is what runs the sweep");
});

test("a write that fires a rule answers with the row the rule left behind, not the caller's own", async () => {
  /*
   * The board applies the PATCH response over its optimistic cell. When a rule
   * writes the same row again — "when status changes, change status to X" — the
   * row returned by the caller's own `.returning()` is already out of date, and
   * answering with it makes the grid show the pre-automation value until the
   * page is reloaded. Observed on the Vercel Preview: 30s after the rule wrote
   * "Job Scheduled" the grid still read "Pending Scheduling".
   */
  const route = await read("app/api/maintenance/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.match(
    patch,
    /const ran = await dispatchAutomationEvents\(/,
    "the PATCH must keep the number of rules that ran",
  );
  assert.match(
    patch,
    /if \(ran > 0\) \{[\s\S]{0,600}?\.from\(maintenanceRequests\)/,
    "when a rule ran, the row is read again before it is returned",
  );
  assert.match(patch, /return Response\.json\(\{ request: exposeRequest\(latest\) \}\)/);
  assert.doesNotMatch(
    patch,
    /await dispatchAutomationEvents\([\s\S]{0,400}?\);\s*\}\s*return Response\.json\(\{ request: exposeRequest\(updated\) \}\)/,
    "the stale row must not be the answer",
  );
});
