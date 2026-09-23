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

/* ── 5. The independent security review's findings (2026-09-22) ─────────── */

test("the admin console's hand-built subjects carry the ceiling, and workspace access needs users.edit first", async () => {
  const users = code(await read("app/api/admin/users/route.ts"));
  const grant = users.slice(users.indexOf("async function mayGrantIn"), users.indexOf("function companyWorkspaces"));
  assert.match(grant, /siteRestricted: siteScopeInOrganisation\(context, id\) !== null,/, "mayGrantIn");
  const access = users.slice(users.indexOf('if (action === "workspace_access") {'));
  assert.match(access, /^if \(action === "workspace_access"\) \{\s*const deniedHere = requireCapability\(context\.subject, "users\.edit"\);\s*if \(deniedHere\) return deniedHere;/);
  assert.match(access, /siteRestricted: siteScopeInOrganisation\(context, workspace\.id\) !== null,/, "the remove check");
  const admin = code(await read("app/api/admin/admin-context.ts"));
  assert.match(admin, /siteRestricted: siteScopeInOrganisation\(context, row\.organisationId\) !== null,/, "accountWideRefusal (password reset, profile, deactivate)");
});

test("the audit log reads only the workspaces where audit.read holds under their own site scope", async () => {
  const audit = code(await read("app/api/audit/route.ts"));
  assert.match(audit, /const readable = scope\.crossOrganisation \? scope\.organisationIds : await auditReadable\(scope\);/);
  /* Re-pointed 2026-09-22 (the module-switch batch): the push is now guarded by
     two `continue`s rather than one `if`, because a workspace that has switched
     Audit OFF drops out of the list as well. The contract this pin protects is
     unchanged and still asserted — the capability is judged per workspace, with
     that workspace's own role and site scope. See `app/lib/module-guard.ts`. */
  assert.match(audit, /resolvePermissions\(scope\.db, id, role, siteScopeInOrganisation\(scope, id\)\);\s*if \(!can\(subject, "audit\.read"\)\) continue;/);
  assert.match(audit, /if \(await moduleSwitchedOff\(scope\.db, id, "audit"\)\) continue;\s*readable\.push\(id\);/);
});

test("the bin: restoring or purging structure is refused, and a purge's subitems are checked first", async () => {
  const trash = code(await read("app/api/trash/route.ts"));
  const restore = trash.slice(trash.indexOf("export async function POST"), trash.indexOf("export async function DELETE"));
  assert.ok(restore.indexOf('["group", "column", "board_view"].includes(entry.entityType)') < restore.indexOf("restoreFromBin(db, orgId, id)"));
  const purge = trash.slice(trash.indexOf("export async function DELETE"));
  const confine = purge.indexOf("const all = await confineBinEntries(db, orgId, siteScope, unconfined);");
  assert.ok(confine > 0);
  const after = purge.slice(confine);
  assert.match(after, /if \(siteScope\) \{\s*if \(all\.some\(\(entry\) => \["group", "column", "board_view"\]\.includes\(entry\.entityType\)\)\)/);
  assert.match(after, /subitemsOutsideMemberScope\(db, orgId, siteScope, jobIds, true\)/);
});

test("un-archiving a group or a board is structure", async () => {
  const archive = code(await read("app/api/account/archive/route.ts"));
  const post = archive.slice(archive.indexOf("export async function POST"));
  assert.ok(post.indexOf('if (kind !== "job") {\n      const structure = boardStructureRefusal(context.siteScope);') > 0);
  assert.ok(post.indexOf("boardStructureRefusal(") < post.indexOf(".update("), "before anything is un-archived");
});

test("what covers every site — the ledger, report documents, the contractor register — is refused to a restricted member", async () => {
  assert.equal(scope.everySiteRefusal(null, "x"), null);
  const refused = scope.everySiteRefusal(["s1"], "the finance ledger");
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).outsideSiteScope, true);
  const finance = code(await read("app/lib/finance/access.ts"));
  assert.match(finance, /if \(guard\.denied\) return guard;\s*const everySite = everySiteRefusal\(guard\.scope\.siteScope, "the finance ledger"\);\s*if \(everySite\) return \{ denied: everySite \};/);
  const search = code(await read("app/api/search/route.ts"));
  /* Re-pointed 2026-09-22 (the module-switch batch): one more condition now
     follows on the same expression — the workspace's Invoice Tracker switch —
     so the site-scope test is no longer the last line of it. The contract this
     pin protects is unchanged: a site-restricted member gets no finance group.
     `tests/module-api-enforcement.test.mjs` owns the switch half. */
  assert.match(search, /can\(subject, FINANCE_CAPABILITIES\["ledger\.read"\]\)\s*&& !scope\.siteScope\s*&& !\(await moduleOff\(scope, "invoice-tracker"\)\);/);
  const helpers = code(await read("app/lib/reporting/route-helpers.ts"));
  assert.match(helpers, /everySiteRefusal\(guarded\.scope\.siteScope, "a report document"\)/);
  const exports = code(await read("app/api/reports/exports/route.ts"));
  assert.equal((exports.match(/everySiteRefusal\(scope\.siteScope, "a report document"\)/g) ?? []).length, 2);
  const schedules = code(await read("app/api/reports/schedules/route.ts"));
  assert.equal((schedules.match(/everySiteRefusal\(guard\.scope\.siteScope, "a scheduled report"\)/g) ?? []).length, 4);
  const workspace = code(await read("app/api/workspace/route.ts"));
  assert.equal((workspace.match(/const everySite = contractorRegisterRefusal\(memberSiteScope, entity\);\s*if \(everySite\) return everySite;/g) ?? []).length, 3, "POST, PATCH, DELETE");
  assert.equal(scope.contractorRegisterRefusal(["s1"], "contractor").status, 403);
  assert.equal(scope.contractorRegisterRefusal(["s1"], "site"), null);
  assert.equal(scope.contractorRegisterRefusal(null, "contractor"), null);
  const aliases = code(await read("app/api/contractors/[id]/aliases/route.ts"));
  assert.equal((aliases.match(/everySiteRefusal\(guard\.scope\.siteScope, "the contractor register"\)/g) ?? []).length, 2);
  const values = code(await read("app/api/registers/values/route.ts"));
  assert.match(values, /if \(register === "contractors"\) \{\s*const everySite = everySiteRefusal\(scope\.siteScope, "the contractor register"\);/);
});

test("a restricted member's store rename rewrites only that store's jobs; a Super Admin is never site-confined", async () => {
  const board = code(await read("app/api/board/route.ts"));
  assert.match(board, /eq\(maintenanceRequests\.location, previousName\),\s*siteScope \? eq\(maintenanceRequests\.siteId, siteOptionId\) : undefined,/);
  const resolver = code(await read("app/lib/tenant-access.ts"));
  assert.match(resolver, /const siteScope = platformAdmin \|\| ownerHere \? null : \(grantHere\?\.siteScope \?\? null\);/);
});

/* ── 6. The re-review's residual reads, and the empty-scope fail-open ────── */

test("every site's spend and every rule's runs are refused to a restricted member", async () => {
  for (const file of ["app/api/overview/contractor-aliases/route.ts", "app/api/contractors/unlinked-names/route.ts"]) {
    const text = code(await read(file));
    const get = text.slice(text.indexOf("export async function GET"));
    assert.match(get, /everySiteRefusal\(\w+\.scope\.siteScope, "contractor linking"\)/, file);
  }
  const runs = code(await read("app/api/automations/runs/route.ts"));
  assert.match(runs.slice(runs.indexOf("export async function GET")), /boardStructureRefusal\(\w+\.scope\.siteScope\)/);
});

test("a contractor's own document is read through a link but never written by a restricted member", async () => {
  const byId = code(await read("app/api/files/[id]/route.ts"));
  const write = byId.slice(byId.indexOf("async function writeOutsideSiteScope"), byId.indexOf("export async function DELETE"));
  assert.match(write, /if \(!scope\.siteScope\) return false;\s*if \(!record\.siteId && !record\.unitId && !record\.requestId && record\.contractorId\) return true;/);
});

test("an EMPTY site scope reaches nothing anywhere — no call site reads it as unrestricted", async () => {
  const documents = code(await read("app/api/files/documents.ts"));
  assert.match(documents, /export async function outsideSiteScope\([\s\S]*?\): Promise<boolean> \{\s*if \(!siteScope\.length\) return true;/);
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  }
  await walk("app");
  const failOpen = [];
  for (const file of files) {
    const text = code(await read(file));
    if (/siteScope && (?:options\.)?siteScope\.length|!siteScope \|\| !siteScope\.length|!scope\.siteScope \|\| !scope\.siteScope\.length/.test(text)) failOpen.push(file);
  }
  assert.deepEqual(failOpen, [], "`[]` is a restriction to no site; use memberSiteCondition / siteOutsideMemberScope");
});
