/**
 * §38 — version history for workspace settings: brand colours and fonts, the
 * portal modules, the default sidebar and the default dashboards.
 *
 * The owner's rule, held here: EVERY version is kept, and a restore never
 * rewrites or removes history — it writes the old state back through the
 * setting's own save route (today's validation, permissions and audit apply)
 * and is recorded as a NEW version saying where it came from.
 *
 * The model is called directly; the storage logic runs against a REAL SQLite
 * (node:sqlite behind drizzle's sqlite-proxy) built from the migration's own
 * DDL; the routes' ordering is pinned in their source; the live half restores a
 * real version through the dev server and skips when none answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const model = await import("../app/lib/config-versions-model.ts");
const store = await import("../app/lib/config-versions.ts");

/* ================================================================== */
/* The model                                                           */
/* ================================================================== */

test("equal states serialise — and so hash — the same, whatever the key order", async () => {
  assert.equal(model.canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), model.canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
  assert.equal(await store.stateDigest({ x: 1, y: 2 }), await store.stateDigest({ y: 2, x: 1 }));
  assert.notEqual(await store.stateDigest({ x: 1 }), await store.stateDigest({ x: 2 }));
});

test("a theme restore sets every token today's catalogue knows: the version's value, or a reset", () => {
  const snapshot = model.themeSnapshot({ "brand.primary": "#123456" });
  assert.deepEqual(model.themeRestoreTokens(snapshot, ["brand.primary", "brand.accent"]), { "brand.primary": "#123456", "brand.accent": null });
  const retired = model.themeRestoreTokens(model.themeSnapshot({ "old.token": "#000000" }), ["brand.primary"]);
  assert.deepEqual(retired, { "brand.primary": null }, "a token retired since is not sent");
});

test("a modules restore switches on everything the version left on", () => {
  const snapshot = model.modulesSnapshot({ reports: false, planned: true, finance: false });
  assert.deepEqual(snapshot, { disabled: ["finance", "reports"] });
  assert.deepEqual(model.modulesRestoreSwitches(snapshot, ["reports", "planned", "finance", "sites"]), { reports: false, planned: true, finance: false, sites: true });
});

test("a sidebar with no workspace default is a version too, restored through reset", () => {
  assert.deepEqual(model.navigationSnapshot(null), { present: false, items: [], locked: [] });
  assert.equal(model.summariseChange("navigation", null, model.navigationSnapshot(null)), "Reset to the built-in order.");
  assert.deepEqual(model.navigationSnapshot({ items: [{ key: "jobs" }], locked: ["b", "a"] }).locked, ["a", "b"], "locks are sorted, so order never makes a new version");
});

test("summaries name what changed", () => {
  assert.equal(
    model.summariseChange("theme", model.themeSnapshot({ "brand.primary": "#111111", "brand.accent": "#222222" }), model.themeSnapshot({ "brand.primary": "#333333" })),
    "Changed brand.primary; reset brand.accent",
  );
  assert.equal(model.summariseChange("portal_modules", model.modulesSnapshot({ reports: false }), model.modulesSnapshot({ finance: false })), "Switched off finance; switched on reports");
  assert.match(model.summariseChange("dashboard", null, model.dashboardSnapshot("overview", [{ key: "a" }, { key: "b", hidden: true }])), /2 widgets, 1 hidden/);
});

test("only named settings have a history, and a restore goes to the setting's own save route", () => {
  assert.deepEqual(model.versionSubject("theme", "tokens"), { subject: "theme", key: "tokens" });
  assert.equal(model.versionSubject("theme", "other"), null);
  assert.equal(model.versionSubject("api_tokens", "x"), null, "credentials are never versioned");
  assert.deepEqual(model.restoreRequest("navigation", "workspace", 3), { url: "/api/navigation", body: { scope: "workspace", restoreVersion: 3 } });
  assert.deepEqual(model.restoreRequest("dashboard", "reports", 2), { url: "/api/dashboard-layout", body: { scope: "workspace", surface: "reports", restoreVersion: 2 } });
  assert.equal(model.restoreVersionFrom({ restoreVersion: 0 }), null);
  assert.equal(model.restoreVersionFrom({ restoreVersion: "3" }), null);
  assert.equal(model.restoreVersionFrom({ restoreVersion: 3 }), 3);
});

/* ================================================================== */
/* Storage — a real SQLite                                              */
/* ================================================================== */

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE organisations (id TEXT PRIMARY KEY); INSERT INTO organisations VALUES ('org_a'), ('org_b');");
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS config_versions \([\s\S]*?\))`/)[1]);
  for (const index of init.matchAll(/"(CREATE UNIQUE INDEX IF NOT EXISTS config_versions_[^"]+)"/g)) sqlite.exec(index[1]);
  const db = drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
  return { sqlite, db };
}

const themeA = { organisationId: "org_a", subject: "theme", key: "tokens" };
const actor = { email: "owner@example.com", userId: "u1" };

test("versions are numbered per setting and per workspace", async () => {
  const { db } = await database();
  assert.equal(await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "one", actor }), 1);
  assert.equal(await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "2" } }, summary: "two", actor }), 2);
  assert.equal(await store.recordConfigVersion(db, { ...themeA, organisationId: "org_b" }, { snapshot: { tokens: {} }, summary: "b", actor }), 1);
  assert.equal(await store.recordConfigVersion(db, { organisationId: "org_a", subject: "portal_modules", key: "switches" }, { snapshot: { disabled: [] }, summary: "m", actor }), 1);
});

test("two concurrent records get two numbers, never the same one", async () => {
  const { db, sqlite } = await database();
  const numbers = await Promise.all([
    store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "x" } }, summary: "x", actor }),
    store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "y" } }, summary: "y", actor }),
  ]);
  assert.deepEqual([...numbers].sort(), [1, 2]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM config_versions").get().n, 2);
});

test("installation-wide rows are unique too (the partial index)", async () => {
  const { sqlite } = await database();
  const insert = sqlite.prepare("INSERT INTO config_versions (id, organisation_id, subject_type, subject_key, version_no, snapshot, digest) VALUES (?, NULL, 'site_page', 'home', 1, '{}', 'd')");
  insert.run("a");
  assert.throws(() => insert.run("b"), /UNIQUE/);
});

test("the baseline is written once, before history's first write", async () => {
  const { db, sqlite } = await database();
  await store.ensureConfigBaseline(db, themeA, { tokens: { a: "old" } }, actor);
  await store.ensureConfigBaseline(db, themeA, { tokens: { a: "older still" } }, actor);
  const rows = sqlite.prepare("SELECT version_no, change_kind FROM config_versions").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ version_no: 1, change_kind: "baseline" }]);
});

test("a save that changed nothing is not a version; a restore always is", async () => {
  const { db } = await database();
  await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "s", actor });
  assert.equal(await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "again", actor }), null);
  assert.equal(await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "restored", restoredFrom: 1, actor }), 2);
  const list = await store.listConfigVersions(db, themeA);
  assert.equal(list.versions[0].kind, "restored");
  assert.equal(list.versions[0].restoredFromVersion, 1);
});

test("a workspace's list is its own, newest first, marks the live state, and carries no snapshot", async () => {
  const { db } = await database();
  await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "one", actor });
  await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "2" } }, summary: "two", actor });
  await store.recordConfigVersion(db, { ...themeA, organisationId: "org_b" }, { snapshot: { tokens: { secret: "b" } }, summary: "b's", actor });
  await store.recordConfigVersion(db, { ...themeA, organisationId: null }, { snapshot: { tokens: {} }, summary: "installation", actor });
  const list = await store.listConfigVersions(db, themeA, { liveDigest: await store.stateDigest({ tokens: { a: "1" } }) });
  assert.deepEqual(list.versions.map((row) => row.version), [2, 1]);
  assert.deepEqual(list.versions.map((row) => row.summary), ["two", "one"], "never another workspace's or the installation's rows");
  assert.deepEqual(list.versions.map((row) => row.current), [false, true], "current by digest, not by being newest");
  for (const row of list.versions) assert.equal("snapshot" in row, false);
  const paged = await store.listConfigVersions(db, themeA, { limit: 1 });
  assert.equal(paged.hasMore, true);
  assert.deepEqual((await store.listConfigVersions(db, themeA, { limit: 5, before: 2 })).versions.map((row) => row.version), [1]);
});

test("a restore loads only this workspace's version, and never a deletion marker", async () => {
  const { db, sqlite } = await database();
  await store.recordConfigVersion(db, themeA, { snapshot: { tokens: { a: "1" } }, summary: "one", actor });
  assert.deepEqual(await store.loadRestoreSnapshot(db, themeA, 1), { ok: true, snapshot: { tokens: { a: "1" } } });
  assert.equal((await store.loadRestoreSnapshot(db, { ...themeA, organisationId: "org_b" }, 1)).status, 404, "another workspace's number restores nothing");
  assert.equal((await store.loadRestoreSnapshot(db, themeA, 9)).status, 404);
  sqlite.prepare("INSERT INTO config_versions (id, organisation_id, subject_type, subject_key, version_no, change_kind, snapshot, digest) VALUES ('d', 'org_a', 'theme', 'tokens', 2, 'deleted', '{}', 'x')").run();
  assert.equal((await store.loadRestoreSnapshot(db, themeA, 2)).status, 409);
});

/* ================================================================== */
/* Source contracts                                                    */
/* ================================================================== */

test("the migration is additive, runs after the webhooks stage, and is not a repair", async () => {
  const init = await read("db/init.ts");
  const apply = init.slice(init.indexOf("async function applyMigrations"));
  assert.ok(apply.indexOf("await ensureWebhooks(d1);") < apply.indexOf("await ensureConfigVersions(d1);"));
  const repairs = init.slice(init.indexOf("async function repairInvariants"), init.indexOf("async function applyMigrations"));
  assert.doesNotMatch(repairs, /ensureConfigVersions/);
  const stage = init.slice(init.indexOf("async function ensureConfigVersions"), init.indexOf("THE WEBSITE CMS"));
  assert.doesNotMatch(stage, /DROP|ALTER|DELETE|UPDATE\s/i);
  assert.match(stage, /WHERE organisation_id IS NULL/);
});

test("nothing in the app rewrites or removes a version", async () => {
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = code(await read(next));
        if (/\.(update|delete)\(configVersions\)|(UPDATE|DELETE FROM)\s+config_versions/i.test(source)) offenders.push(next);
      }
    }
  }
  await walk("app");
  assert.deepEqual(offenders, []);
});

test("each route: gate, then restore load, then validation; baseline, then write, then record", async () => {
  const theme = code(await read("app/api/theme/route.ts"));
  const put = theme.slice(theme.indexOf("export async function PUT"));
  assert.ok(put.indexOf('requireCapability(subject, "settings.edit")') < put.indexOf("loadRestoreSnapshot("));
  assert.ok(put.indexOf("loadRestoreSnapshot(") < put.indexOf("validateThemeToken(key, raw)"), "a restored palette is validated like any other");
  assert.ok(put.indexOf("ensureConfigBaseline(") < put.indexOf("await writeThemeOverride(") && put.indexOf("await writeThemeOverride(") < put.indexOf("recordConfigVersion("));

  const modules = code(await read("app/api/portal-modules/route.ts"));
  const mput = modules.slice(modules.indexOf("export async function PUT"));
  assert.ok(mput.indexOf('requireCapability(subject, "navigation.edit")') < mput.indexOf("loadRestoreSnapshot("));
  assert.ok(mput.indexOf("loadRestoreSnapshot(") < mput.indexOf("!definition.disableable"), "a module that can no longer be switched off refuses the restore");
  assert.ok(mput.indexOf("ensureConfigBaseline(") < mput.indexOf("await writeModuleEnabled(") && mput.indexOf("await writeModuleEnabled(") < mput.indexOf("recordConfigVersion("));

  const navigation = code(await read("app/api/navigation/route.ts"));
  const nput = navigation.slice(navigation.indexOf("export async function PUT"));
  assert.ok(nput.indexOf("mayEditDefault(context)") < nput.indexOf("loadRestoreSnapshot("));
  assert.ok(nput.indexOf("loadRestoreSnapshot(") < nput.indexOf("isIconName(item.icon)"), "a restored sidebar passes the icon and lock checks");
  assert.match(nput, /if \(scope !== "workspace"\) \{\s*return Response\.json\(\{ error: "Only the workspace default sidebar has a version history\." \}/);
  assert.ok(nput.indexOf("ensureConfigBaseline(context.db, versionTarget, workspaceSnapshot(), versionActor);\n    await writeRow(") > 0);

  const dashboard = code(await read("app/api/dashboard-layout/route.ts"));
  assert.ok(dashboard.indexOf('can(subject, "settings.edit")') < dashboard.indexOf("loadRestoreSnapshot("));
  assert.ok(dashboard.indexOf("loadRestoreSnapshot(") < dashboard.indexOf("const items = cleanItems(payload.items);"));
  for (const route of [theme, modules, navigation, dashboard]) assert.match(route, /action: "config\.version_restored"/);
});

test("the history list: the caller's workspace only, the setting's own capability, never a snapshot", async () => {
  const route = code(await read("app/api/versions/route.ts"));
  assert.doesNotMatch(route, /searchParams\.get\("(organisation|org|orgId|organisationId)"\)/);
  assert.match(route, /requireCapability\(permissions, VERSION_SUBJECTS\[target\.subject\]\.capability\)/);
  assert.match(route, /organisationId: scope\.orgId/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, "restore lives on each setting's own route");
  const store = code(await read("app/lib/config-versions.ts"));
  const list = store.slice(store.indexOf("export async function listConfigVersions"), store.indexOf("export async function loadRestoreSnapshot"));
  assert.doesNotMatch(list, /snapshot: configVersions\.snapshot/);
});

test("the history panel asks before restoring and says nothing is removed", async () => {
  const view = await read("app/(app)/portal/views/version-history.tsx");
  assert.match(view, /Nothing is removed from the history — version \$\{row\.version\}'s state is saved as a new version\./);
  assert.match(view, /restoreRequest\(subject, subjectKey, row\.version\)/);
  const nav = await read("app/(app)/portal/views/nav-icons-panel.tsx");
  assert.match(nav, /subject="navigation"[\s\S]{0,200}forgetNavigation\(\);/);
  for (const [file, subject] of [
    ["app/(app)/portal/views/brand-colours-panel.tsx", "theme"],
    ["app/(app)/portal/views/portal-modules-panel.tsx", "portal_modules"],
    ["app/(app)/portal/dashboard-widgets.tsx", "dashboard"],
  ]) {
    assert.match(await read(file), new RegExp(`<VersionHistory[\\s\\S]{0,60}subject="${subject}"`), file);
  }
  const css = await read("app/(app)/portal/views/version-history.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|@media/i, "theme tokens only");
});

/* ================================================================== */
/* The live half                                                       */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

async function call(pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: a client may not read a setting's history", { skip: !serverUp }, async () => {
  const refused = await call("/api/versions?subject=theme&key=tokens", { headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" } });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal((await call("/api/versions?subject=api_tokens&key=x")).status, 400);
});

test("live: two sidebar saves are two versions, and restoring one adds a third naming it", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  const current = await call("/api/navigation", as);
  assert.equal(current.status, 200, JSON.stringify(current.body).slice(0, 200));
  /* The workspace default, or — when there is none yet — the effective layout
     serialised back into an arrangement, the way the editor does it. */
  const layout = await import("../app/api/navigation/layout.ts");
  const hadDefault = (current.body.arrangement?.workspace ?? []).length > 0;
  const items = hadDefault ? current.body.arrangement.workspace : layout.toArrangement(current.body.layout.groups);
  if (!Array.isArray(items) || items.length < 2) return t.skip("no sidebar arrangement to vary here");
  const original = items.map((item) => ({ ...item }));
  const renamed = original.map((item, index) => (index === 0 ? { ...item, label: `P38-QA ${Date.now()}` } : item));
  try {
    assert.equal((await call("/api/navigation", { ...as, method: "PUT", body: JSON.stringify({ scope: "workspace", items: renamed }) })).status, 200);
    assert.equal((await call("/api/navigation", { ...as, method: "PUT", body: JSON.stringify({ scope: "workspace", items: original }) })).status, 200);
    const history = await call("/api/versions?subject=navigation&key=workspace&limit=5", as);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const [newest, previous] = history.body.versions;
    assert.ok(newest.version > previous.version, "newest first");
    assert.equal(newest.current, true);
    const restored = await call("/api/navigation", { ...as, method: "PUT", body: JSON.stringify({ scope: "workspace", restoreVersion: previous.version }) });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const after = await call("/api/versions?subject=navigation&key=workspace&limit=5", as);
    assert.equal(after.body.versions[0].restoredFromVersion, previous.version);
    assert.equal(after.body.versions[0].current, true);
    assert.ok(after.body.versions.some((row) => row.version === newest.version), "nothing was removed");
    const missing = await call("/api/navigation", { ...as, method: "PUT", body: JSON.stringify({ scope: "workspace", restoreVersion: 999999 }) });
    assert.equal(missing.status, 404);
    const personal = await call("/api/navigation", { ...as, method: "PUT", body: JSON.stringify({ scope: "user", restoreVersion: previous.version }) });
    assert.equal(personal.status, 400, "a personal sidebar has no history");
  } finally {
    /* Put the workspace back as it was: its own default, or none. */
    await call("/api/navigation", {
      ...as,
      method: "PUT",
      body: JSON.stringify(hadDefault ? { scope: "workspace", items: original } : { scope: "workspace", reset: true }),
    });
  }
});
