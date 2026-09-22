/**
 * Site-restricted members: the owner's decisions of 2026-09-22.
 *
 * #83 and #87 confined every job-level read and write to a member's sites.
 * These rules are about what is NOT a site's:
 *   1. WORKSPACE-WIDE CAPABILITIES (settings, users, roles, teams, navigation,
 *      integrations, billing, import, the audit log) — a restricted member never
 *      holds them, withheld centrally in `can` (SITE_RESTRICTED_CEILING), with
 *      resolvePermissions REQUIRING the member's site scope so no route forgets;
 *   2. BOARD STRUCTURE under `board.edit` (columns, labels, groups, views, forms,
 *      register columns, automations, site groups) — refused per operation;
 *   3. SITE CREATION — refused, because a new site would be invisible to its
 *      creator;
 *   4. SUBITEM CASCADES — binning or restoring a job whose subitems include one
 *      at another site fails the whole operation.
 */
import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const permissions = await import("../app/lib/permissions.ts");
const scope = await import("../app/lib/job-site-scope.ts");
const access = await import("../app/lib/access-scope.ts");

/* ── 1. The ceiling ──────────────────────────────────────────────────────── */

test("a site-restricted member holds no workspace-wide capability, whatever their role", () => {
  for (const role of ["owner", "admin", "manager", "client"]) {
    const free = { role, capabilities: {} };
    const confined = { role, capabilities: {}, siteRestricted: true };
    for (const capability of permissions.SITE_RESTRICTED_CEILING) {
      assert.equal(permissions.can(confined, capability), false, `${role} restricted: ${capability}`);
    }
    // What a site's work needs is exactly what the role already gives.
    for (const capability of ["board.view", "board.edit", "sites.edit", "data.export", "users.view", "navigation.personalise"]) {
      assert.equal(permissions.can(confined, capability), permissions.can(free, capability), `${role}: ${capability} unchanged`);
    }
  }
});

test("the ceiling is the workspace-wide set, and Super Admin — the recovery role — is exempt", () => {
  assert.deepEqual(
    [...permissions.SITE_RESTRICTED_CEILING].sort(),
    ["audit.read", "billing.manage", "clients.view_all", "data.import", "integrations.manage", "navigation.edit",
      "roles.edit", "settings.edit", "teams.manage", "users.deactivate", "users.edit", "users.invite"],
  );
  const superAdmin = { role: "super_admin", capabilities: {}, siteRestricted: true };
  for (const capability of permissions.SITE_RESTRICTED_CEILING) {
    assert.equal(permissions.can(superAdmin, capability), true, capability);
  }
  const effective = permissions.effectiveCapabilities("admin", {}, true);
  assert.equal(effective["users.invite"], false, "what the browser is told matches can()");
  assert.equal(effective["board.edit"], true);
  assert.equal(permissions.effectiveCapabilities("admin", {})["users.invite"], true, "unrestricted: unchanged");
});

test("refused by the ceiling, the 403 says so in the site-scope shape; refused by the role, it does not", async () => {
  const byCeiling = permissions.requireCapability({ role: "admin", capabilities: {}, siteRestricted: true }, "settings.edit");
  assert.equal(byCeiling.status, 403);
  const body = await byCeiling.json();
  assert.equal(body.outsideSiteScope, true);
  assert.equal(body.capability, "settings.edit");
  assert.match(body.error, /limited to some sites/);
  const byRole = permissions.requireCapability({ role: "client", capabilities: {}, siteRestricted: true }, "settings.edit");
  const roleBody = await byRole.json();
  assert.equal(roleBody.outsideSiteScope, undefined, "a client never had it: the ordinary refusal");
  assert.equal(permissions.requireCapability({ role: "admin", capabilities: {}, siteRestricted: true }, "board.edit"), null);
});

test("resolvePermissions REQUIRES the site scope, and every caller passes one", async () => {
  const source = code(await read("app/lib/permissions.ts"));
  assert.match(source, /export async function resolvePermissions\(\s*db: Database,\s*organisationId: string,\s*role: WorkspaceRole,\s*siteScope: readonly string\[\] \| null,\s*\)/);
  assert.match(source, /return \{ role, capabilities: overrides\[role\], siteRestricted: siteScope !== null \};/);
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  }
  await walk("app");
  let calls = 0;
  for (const file of files) {
    const text = code(await read(file));
    for (const match of text.matchAll(/resolvePermissions\(([\s\S]*?)\)(?=[;,)\s])/g)) {
      if (/export async function/.test(text.slice(Math.max(0, match.index - 30), match.index))) continue;
      calls += 1;
      const args = match[1].split(",").map((part) => part.trim()).filter(Boolean);
      assert.ok(args.length >= 4, `${file}: resolvePermissions(${match[1].trim()}) passes the site scope`);
    }
  }
  assert.ok(calls >= 40, `every caller was found (${calls})`);
});

test("siteScopeInOrganisation answers a named workspace by the resolver's rules", () => {
  const base = { organisationIds: ["o1", "o2"], activeOrganisations: [{ id: "o1", clientCompanyId: "c1" }, { id: "o2", clientCompanyId: "c2" }], ownedCompanyIds: [], unaffiliated: false, orgId: "o1", actor: { role: "admin" } };
  const grants = [{ organisationId: "o1", role: "admin", siteScope: ["s1"] }, { organisationId: "o2", role: "admin", siteScope: null }];
  assert.deepEqual(access.siteScopeInOrganisation({ ...base, platformAdmin: false, grants }, "o1"), ["s1"]);
  assert.equal(access.siteScopeInOrganisation({ ...base, platformAdmin: false, grants }, "o2"), null);
  assert.equal(access.siteScopeInOrganisation({ ...base, platformAdmin: true, grants }, "o1"), null, "platform staff");
  assert.equal(access.siteScopeInOrganisation({ ...base, platformAdmin: false, grants, ownedCompanyIds: ["c1"] }, "o1"), null, "an owner of the company");
});

/* ── 2. Board structure ──────────────────────────────────────────────────── */

test("a structural board action is refused for a restricted member; a job action and a store rename are not", async () => {
  for (const action of scope.BOARD_STRUCTURE_ACTIONS) {
    const refusal = scope.boardActionStructureRefusal(["s1"], action, "opt-1");
    assert.equal(refusal?.status, 403, action);
    assert.equal((await refusal.json()).outsideSiteScope, true);
    assert.equal(scope.boardActionStructureRefusal(null, action, "opt-1"), null, `${action}: unrestricted`);
  }
  for (const action of ["update_cell", "create_item", "move_items", "archive_items", "delete_items", "duplicate_items", "sort_group", "clear_column"]) {
    assert.equal(scope.boardActionStructureRefusal(["s1"], action, null), null, `${action} is job work (confined by #87)`);
  }
  assert.equal(scope.boardActionStructureRefusal(["s1"], "update_option", "site-option-s1"), null, "renaming a store is a site edit");
  assert.equal(scope.boardStructureRefusal(null), null);
  assert.equal(scope.siteCreationRefusal(null), null);
  assert.equal(scope.siteCreationRefusal(["s1"]).status, 403);
});

test("every write handler of the structural routes refuses first, and /api/board asks before any action", async () => {
  const routes = [
    "app/api/board/columns/route.ts",
    "app/api/board/groups/route.ts",
    "app/api/options/route.ts",
    "app/api/board/form/route.ts",
    "app/api/board/views/route.ts",
    "app/api/registers/route.ts",
    "app/api/automations/route.ts",
    "app/api/sites/groups/route.ts",
  ];
  for (const file of routes) {
    const text = code(await read(file));
    const handlers = [...text.matchAll(/export async function (POST|PATCH|DELETE|PUT)\(/g)];
    assert.ok(handlers.length, file);
    for (const handler of handlers) {
      const body = text.slice(handler.index, text.indexOf("\nexport async function ", handler.index + 10) >>> 0 || undefined);
      const guard = body.search(/if \(\w+\.denied\) return \w+\.denied;/);
      const refusal = body.indexOf("boardStructureRefusal(");
      assert.ok(guard > 0 && refusal > guard && refusal - guard < 200, `${file} ${handler[1]}: refused right after the guard`);
    }
  }
  const board = code(await read("app/api/board/route.ts"));
  const dispatch = [...board.matchAll(/const action = trimString\(payload\.action, 40\);\s*const structureRefusal = boardActionStructureRefusal\(siteScope, action, payload\.optionId\);\s*if \(structureRefusal\) return structureRefusal;/g)];
  assert.equal(dispatch.length, 2, "POST and PATCH");
});

/* ── 3. Site creation ────────────────────────────────────────────────────── */

test("a restricted member creates no site, in either place a site is born", async () => {
  const sites = code(await read("app/api/sites/route.ts"));
  const post = sites.slice(sites.indexOf("export async function POST"));
  assert.ok(post.indexOf("siteCreationRefusal(guard.scope.siteScope)") > 0 && post.indexOf("siteCreationRefusal(") < post.indexOf("insert("), "/api/sites POST");
  const workspace = code(await read("app/api/workspace/route.ts"));
  const branch = workspace.slice(workspace.indexOf('if (entity === "site") {'));
  assert.ok(branch.indexOf("siteCreationRefusal(memberSiteScope)") > 0 && branch.indexOf("siteCreationRefusal(") < branch.indexOf("newId("), "/api/workspace site");
});

/* ── 4. Subitem cascades ─────────────────────────────────────────────────── */

function proxy(sqlite) {
  return drizzle(async (sql, params, method) => {
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
}

function estate() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE maintenance_requests (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, site_id TEXT, parent_id TEXT, deleted_at TEXT);
    INSERT INTO maintenance_requests VALUES
      ('p1', 'org', 'site-a', NULL, NULL),
      ('p1-own', 'org', 'site-a', 'p1', NULL),
      ('p2', 'org', 'site-a', NULL, NULL),
      ('p2-other', 'org', 'site-b', 'p2', NULL),
      ('p3', 'org', 'site-a', NULL, '2026-09-20T00:00:00Z'),
      ('p3-other-binned', 'org', 'site-b', 'p3', '2026-09-20T00:00:00Z');
  `);
  return proxy(sqlite);
}

const exploding = new Proxy({}, { get: () => { throw new Error("an unrestricted member must not query"); } });

test("a subitem at another site fails the whole bin or restore; one's own, or none, does not", async () => {
  const db = estate();
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], ["p1"], false), false, "own subitem");
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], ["p2"], false), true, "another site's subitem");
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], ["p1", "p2"], false), true, "one is enough to fail them all");
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], ["p3"], false), false, "binned children are not binned again");
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], ["p3"], true), true, "but a restore would bring them back");
  assert.equal(await scope.subitemsOutsideMemberScope(exploding, "org", null, ["p2"], false), false, "unrestricted: no query");
  assert.equal(await scope.subitemsOutsideMemberScope(db, "org", ["site-a"], [], false), false);
});

test("the bin and the restore both ask before they mutate anything", async () => {
  const board = code(await read("app/api/board/route.ts"));
  const deleting = board.slice(board.indexOf('action === "delete_items"'));
  assert.ok(deleting.indexOf("subitemsOutsideMemberScope(db, orgId, siteScope, requestIds, false)") < deleting.indexOf("sendJobsToBin("), "board delete_items");
  const trash = code(await read("app/api/trash/route.ts"));
  const restore = trash.slice(trash.indexOf("export async function POST"));
  assert.ok(restore.indexOf("subitemsOutsideMemberScope(db, orgId, siteScope, [entry.entityId], true)") > 0, "the restore asks");
  assert.ok(restore.indexOf("subitemsOutsideMemberScope(") < restore.indexOf("restoreFromBin(db, orgId, id)"), "before it restores");
});
