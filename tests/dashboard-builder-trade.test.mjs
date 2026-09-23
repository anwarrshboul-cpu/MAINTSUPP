/**
 * THE DASHBOARD BUILDER AND THE TRADE — the owner's decision O.
 *
 *   - A supported widget can be ADDED, REMOVED, REORDERED, CONFIGURED and
 *     RESTORED, on the dashboard system that already exists: one
 *     `dashboard_layouts` row per person per surface, the same capabilities,
 *     and §38 versioning of the workspace default. No second engine.
 *   - A panel's configuration is presentation only — what this workspace calls
 *     it and how wide it sits — so a layout can never become a second source of
 *     truth for a figure.
 *   - TRADE is a real controlled field: the `engineer_required` option set the
 *     product already seeds, mirrors on the board, renames and reassigns. What
 *     was missing was the control, and an unconfigured value is now refused at
 *     the doors that used to trim it. Nothing reads a contractor's name.
 *
 * The rules are CALLED; the trade gate runs against a REAL SQLite built from the
 * migration's own DDL; the doors and the editor are pinned in their source; the
 * live half saves, versions and restores a configured layout through the dev
 * server and skips when none answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const trade = await import("../app/lib/job-trade.ts");
const options = await import("../app/lib/options-repository.ts");
const filters = await import("../app/lib/dashboard-filters.ts");
const layout = await import("../app/(app)/portal/widget-layout.ts");

/* ================================================================== */
/* A panel's configuration                                              */
/* ================================================================== */

test("a configuration carries a name and a width, and nothing else", () => {
  const { cleanWidgetConfig, WIDGET_TITLE_LIMIT } = layout;
  assert.equal(cleanWidgetConfig(undefined), undefined);
  assert.equal(cleanWidgetConfig({}), undefined, "an empty configuration is not stored");
  assert.equal(cleanWidgetConfig({ title: "   " }), undefined);
  assert.deepEqual(cleanWidgetConfig({ title: "  Spend  " }), { title: "Spend" });
  assert.deepEqual(cleanWidgetConfig({ width: "full" }), { width: "full" });
  assert.deepEqual(cleanWidgetConfig({ width: "enormous" }), undefined, "a width outside the two is dropped");
  assert.deepEqual(
    cleanWidgetConfig({ title: "Trade", width: "half", period: "last-year", sites: ["a"] }),
    { title: "Trade", width: "half" },
    "a filter cannot be smuggled into the arrangement",
  );
  assert.equal(cleanWidgetConfig({ title: "x".repeat(200) }).title.length, WIDGET_TITLE_LIMIT);
});

test("the arrangement keeps each panel's configuration, and existence still comes from the registry", () => {
  const registry = [
    { key: "a", label: "A", render: () => null },
    { key: "b", label: "B", render: () => null },
    { key: "new", label: "New", render: () => null },
  ];
  const merged = layout.mergeLayout(registry, [
    { key: "b", hidden: true, config: { title: "Ours", width: "full" } },
    { key: "gone", hidden: false, config: { title: "Retired" } },
    { key: "a", hidden: false, config: { junk: true } },
  ]);
  assert.deepEqual(merged, [
    { key: "b", hidden: true, config: { title: "Ours", width: "full" } },
    { key: "a", hidden: false },
    { key: "new", hidden: false },
  ]);
});

test("the route stores the same two answers, and caps them", async () => {
  const route = code(await read("app/api/dashboard-layout/route.ts"));
  assert.match(route, /const TITLE_LIMIT = 60;/);
  assert.match(route, /record\.width === "full" \|\| record\.width === "half"/);
  assert.match(route, /const config = cleanConfig\(record\.config\);/);
  assert.match(route, /items\.push\(\{ key, hidden: record\.hidden === true, \.\.\.\(config \? \{ config \} : \{\}\) \}\);/);
  assert.match(route, /if \(items\.length >= 60\) break;/, "the list is still capped");
  /* The arrangement — configuration included — is what §38 snapshots. */
  assert.match(route, /dashboardSnapshot\(surface, items\)/);
  /* And the capabilities are unchanged: a workspace default is settings.edit. */
  assert.match(route, /can\(subject, "settings\.edit"\)/);
});

test("the editor adds, removes, reorders and configures — and the grid obeys the width", async () => {
  const editor = await read("app/(app)/portal/dashboard-widgets.tsx");
  assert.match(editor, /Tick a panel to add it to your dashboard and untick it to remove it/);
  assert.match(editor, /aria-label=\{`Name for \$\{widget\.label\}`\}/);
  assert.match(editor, /aria-label=\{`Width of \$\{widget\.label\}`\}/);
  assert.match(editor, /aria-label=\{`Move \$\{widget\.label\} up`\}/);
  assert.match(editor, /const wide = item\.config\?\.width \? item\.config\.width === "full" : Boolean\(widget\.wide\);/);
  assert.match(editor, /<WidgetConfigProvider config=\{item\.config \?\? null\}>\{widget\.render\(\)\}<\/WidgetConfigProvider>/);
  assert.match(code(editor), /void persist\(next, "user"\);/, "a configuration saves as a move does");
  /* The name is read in one place, so a panel added later inherits it. */
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(insights, /const named = useWidgetTitle\(\) \?\? title;/);
  assert.match(insights, /<h3>\{named\}<\/h3>/);
  const css = await read("app/brand-overrides.css");
  const block = css.slice(css.indexOf(".widget-editor__config"), css.indexOf(".widget-editor__moves {"));
  assert.match(block, /min-height: 44px;/, "the new controls keep the touch minimum");
  assert.doesNotMatch(block, /@media/, "no breakpoint of its own");
});

/* ================================================================== */
/* The trade — controlled                                               */
/* ================================================================== */

async function database(values) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a');");
  const init = await read("db/init.ts");
  for (const table of ["option_sets", "option_values"]) {
    sqlite.exec(init.match(new RegExp("`(CREATE TABLE IF NOT EXISTS " + table + " \\([\\s\\S]*?\\))`"))[1]);
  }
  sqlite.prepare("INSERT INTO option_sets (id, organisation_id, key, name) VALUES (?, ?, ?, ?)").run("set_a", "org_a", "engineer_required", "Engineer required");
  const insert = sqlite.prepare(
    "INSERT INTO option_values (id, organisation_id, option_set_id, value, label, colour_hex, position, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  values.forEach(([value, active], index) => insert.run(`ov_${index}`, "org_a", "set_a", value, value, "#12b4a8", index, active ? 1 : 0));
  const db = drizzle(async (statement, params, method) => {
    const prepared = sqlite.prepare(statement);
    const bound = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      prepared.run(...bound);
      return { rows: [] };
    }
    prepared.setReturnArrays?.(true);
    const rows = prepared.all(...bound).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  options.invalidateOptionCache("org_a");
  return { sqlite, db };
}

test("a trade this workspace does not offer is refused; the one a job already holds may stay", async () => {
  const { db } = await database([["Electrician", true], ["Handyman", true], ["Roofer", false]]);
  assert.equal(await trade.tradeWriteRefusal(db, "org_a", "Electrician", null), null, "a configured trade");
  assert.equal(await trade.tradeWriteRefusal(db, "org_a", "", "Electrician"), null, "clearing it is allowed");
  assert.equal(await trade.tradeWriteRefusal(db, "org_a", undefined, "Plummer"), null, "an untouched field");
  assert.equal(await trade.tradeWriteRefusal(db, "org_a", "Plummer", "Plummer"), null, "an imported job keeps its own spelling");
  const invented = await trade.tradeWriteRefusal(db, "org_a", "plumberr", "Electrician");
  assert.match(invented ?? "", /is not one of this workspace's trades/);
  assert.match(invented ?? "", /add it to the Trade list on the board/, "the refusal says where the list is");
  assert.ok(await trade.tradeWriteRefusal(db, "org_a", "Roofer", "Electrician"), "a retired trade may not be newly chosen");
  assert.deepEqual((await trade.listTrades(db, "org_a")).map((row) => row.value), ["Electrician", "Handyman"]);
  assert.equal(trade.TRADE_OPTION_SET, "engineer_required");
  assert.equal(trade.TRADE_FIELD, "engineer");
});

test("a workspace with no trade list is not frozen by the gate", async () => {
  /* Measured in Production on 2026-09-23: 2 of 4 active workspaces have no
     `engineer_required` register (one created without a template, and the
     demonstration workspace, which keeps its own vocabulary). Before this case
     existed, the gate refused EVERY trade there, including the chips on the
     workspace's own board. */
  const { db } = await database([]);
  assert.equal(await trade.tradeWriteRefusal(db, "org_a", "Cleaning", "Electrical"), null, "an empty register controls nothing");
  assert.equal(await trade.tradeWriteRefusal(db, "org_without_a_set", "Plumbing", null), null, "nor does an absent one");
  const retired = await database([["Roofer", false]]);
  assert.equal(await trade.tradeWriteRefusal(retired.db, "org_a", "Roofer", null), null, "every trade retired is the same as none");
  assert.deepEqual(await trade.listTrades(db, "org_a"), [], "and the dialog sees the same empty list, so it offers its fallback");
  /* The moment a list exists, it is enforced. */
  const listed = await database([["Electrician", true]]);
  assert.ok(await trade.tradeWriteRefusal(listed.db, "org_a", "Cleaning", "Electrical"));
});

test("the doors that used to trim a trade now refuse an invented one", async () => {
  const whole = code(await read("app/api/maintenance/route.ts"));
  const route = whole.slice(whole.indexOf("export async function PATCH"));
  const gate = route.indexOf("tradeWriteRefusal(db, orgId, fields.engineer, before?.engineer)");
  assert.ok(gate > 0, "PATCH /api/maintenance consults the gate");
  assert.ok(gate < route.indexOf(".update(maintenanceRequests)"), "before anything is written");
  const actions = code(await read("app/lib/automations/actions.ts"));
  assert.match(actions, /if \(entry\.field === TRADE_FIELD\) \{\s*const refusal = await tradeWriteRefusal\(ctx\.db, ctx\.orgId, values\[entry\.field\], item\.engineer\);/);
  /* The intake doors already canonicalise against the same register. */
  assert.match(code(await read("app/lib/submission-service.ts")), /canonicalSubmissionOption\(/);
  /* And a cell route still refuses a system column outright, so there is no
     third way in. */
  assert.match(code(await read("app/api/board/items/route.ts")), /That column is a field on the job\. Use PATCH \/api\/maintenance/);
});

test("the trade is the job's own field — never a contractor's name, never free text", async () => {
  const panel = await read("app/(app)/portal/dashboard-insights.tsx");
  const block = panel.slice(panel.indexOf("export function JobsByTrade"), panel.indexOf("export function SiteAttention"));
  assert.match(block, /tradeBreakdown\(requests, 8\)/, "it reuses the tested helper");
  assert.doesNotMatch(block, /contractor/i, "no contractor name is read");
  assert.match(block, /Engineer Required column/, "and it says which column it groups by");
  const lib = await read("app/lib/job-trade.ts");
  assert.doesNotMatch(code(lib), /contractor/i);
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /key: "jobs-by-trade",\n\s*label: "Jobs by trade",/, "a supported widget, in the registry the layout arranges");
  const oi = await read("app/(app)/portal/ops/oi-dash.tsx");
  assert.match(oi, /<OiCard title="Jobs by Trade" pill="Field · Engineer Required">/, "the Overview names the concept and the column");
});

test("the raise-a-job dialog offers this workspace's trades, not a list written into the page", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  /*
   * WHY THIS IS PART OF DECISION O. The dialog offered five trades written into
   * portal-app.tsx while `createSubmission` canonicalised the answer against the
   * `engineer_required` register and fell back to "Other" for anything it did
   * not recognise. In a workspace that had renamed its trades, picking
   * "Electrician" here therefore STORED "Other" — a controlled field is not
   * controlled if the picker in front of it offers values the register does not
   * hold.
   */
  assert.match(
    portal,
    /trades=\{runtimeContext\?\.requestConfiguration\?\.engineers \?\? \[\]\}/,
    "the dialog is handed the register, through the one context read the shell already makes",
  );
  /* `runtimeContext` IS the shared read: the state `fetchRuntimeContext` fills.
     That there is exactly one GET of /api/context in this file is the contract
     tests/shared-context-and-navigation-reads.test.mjs owns, and it is not
     restated here — two tests asserting one rule is how the weaker one ends up
     being the one that gets relaxed. */
  assert.match(portal, /engineer: defaultTrade\(trades\)/, "a new job starts on a value the register holds");
  assert.match(portal, /\{tradeChoicesFor\(trades\)\.map\(\(choice\) => \(/, "and the picker draws that list");
  /* The five survive as the fallback for a workspace that has configured none,
     and for the moment before the context answers — but never as JSX again. */
  assert.match(portal, /const BUILT_IN_TRADES = \["Electrician", "Handyman", "HVAC", "Plumber", "Specialist"\];/);
  assert.doesNotMatch(portal, /<option>Electrician<\/option>/, "a hard-coded picker must not come back");
});

test("a filter can be written as trade, and is serialised that way", () => {
  const parsed = filters.parseFilters("https://x.test/?trade=Electrician&trade=Handyman");
  assert.deepEqual(parsed.engineers, ["Electrician", "Handyman"]);
  const legacy = filters.parseFilters("https://x.test/?engineer=Electrician");
  assert.deepEqual(legacy.engineers, ["Electrician"], "an older link still filters");
  const both = filters.parseFilters("https://x.test/?trade=Electrician&engineer=Electrician&engineer=Roofer");
  assert.deepEqual(both.engineers.sort(), ["Electrician", "Roofer"], "the same dimension, de-duplicated");
  assert.match(filters.serialiseFilters({ ...parsed }), /trade=Electrician&trade=Handyman/);
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

async function call(cookie, pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: a configured layout is stored, versioned and restored, and junk is dropped", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const mine = async () => (await call(cookie, "/api/dashboard-layout?surface=reports")).body;
  const before = await mine();
  try {
    const items = [
      { key: "jobs-by-trade", hidden: false, config: { title: "O-QA trades", width: "full", period: "last-year" } },
      { key: "spend-matrix", hidden: true },
    ];
    const saved = await call(cookie, "/api/dashboard-layout", { method: "PUT", body: JSON.stringify({ surface: "reports", items, scope: "user" }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stored = (await mine()).items;
    assert.deepEqual(stored[0], { key: "jobs-by-trade", hidden: false, config: { title: "O-QA trades", width: "full" } }, "the configuration is kept and the filter is not");
    assert.deepEqual(stored[1], { key: "spend-matrix", hidden: true }, "a removed panel stays removed");

    /* The workspace default is versioned with its configuration. */
    const asDefault = await call(cookie, "/api/dashboard-layout", { method: "PUT", body: JSON.stringify({ surface: "reports", items, scope: "workspace" }) });
    assert.equal(asDefault.status, 200, JSON.stringify(asDefault.body));
    const versions = await call(cookie, "/api/versions?subject=dashboard&key=reports&limit=5");
    assert.equal(versions.status, 200, JSON.stringify(versions.body));
    assert.ok(versions.body.versions.length >= 1, "the workspace default has a history");
  } finally {
    /* Both fixtures: this person's own layout and the workspace default the
       version check needed. Removing the default is itself a version, which is
       the honest record §38 keeps. */
    await call(cookie, "/api/dashboard-layout?surface=reports&scope=workspace", { method: "DELETE" });
    await call(cookie, "/api/dashboard-layout?surface=reports", { method: "DELETE" });
    if (before?.items?.length) {
      await call(cookie, "/api/dashboard-layout", { method: "PUT", body: JSON.stringify({ surface: "reports", items: before.items, scope: "user" }) });
    }
  }
});

test("live: a trade nobody configured is refused, a configured one is accepted", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const created = await call(cookie, "/api/board/items", { method: "POST", body: JSON.stringify({ board: "maintenance", title: `O-QA trade ${Date.now()}` }) });
  const id = created.body?.request?.id ?? created.body?.item?.requestId ?? created.body?.id;
  if (!id) return t.skip("a QA job could not be raised");
  try {
    const trades = (await call(cookie, "/api/options")).body;
    const set = (trades?.sets ?? trades?.optionSets ?? []).find((entry) => entry.key === "engineer_required");
    const first = set?.values?.find((value) => value.active)?.value;
    const invented = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, fields: { engineer: "o-qa-not-a-trade" } }) });
    assert.equal(invented.status, 400, JSON.stringify(invented.body));
    assert.match(invented.body.error, /not one of this workspace's trades/);
    if (first) {
      const accepted = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, fields: { engineer: first } }) });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.equal(accepted.body.request.engineer, first);
    }
  } finally {
    await call(cookie, `/api/board/items?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }
});
