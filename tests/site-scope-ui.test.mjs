/**
 * The site-restriction UI (owner decision, 2026-09-22): the smallest proper
 * administrative screen over `memberships.site_scope`, for the authority that
 * already manages access. The server is authoritative; these pin the rule in
 * `PATCH /api/admin/users` (`action: "site_scope"`), what the roster sends, and
 * that the screen draws the choice only where a change could be accepted.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const route = code(await read("app/api/admin/users/route.ts"));
const action = route.slice(route.indexOf('if (action === "site_scope") {'), route.indexOf('if (action === "role") {'));

test("site access is access management: users.edit, and never yourself, an Owner or a Super Admin", () => {
  assert.ok(action.length > 200, "the action exists, before the role action");
  const order = ['requireCapability(context.subject, "users.edit")', "if (isSelf)", 'targetRole === "owner" || targetRole === "super_admin"'];
  let at = 0;
  for (const step of order) {
    const found = action.indexOf(step);
    assert.ok(found >= at, `${step} is checked, in order`);
    at = found;
  }
  assert.ok(action.indexOf('targetRole === "owner"') < action.indexOf(".update(memberships)"), "every refusal comes before the write");
  // The "may manage this person" rail every PATCH action passes runs before the dispatch.
  assert.ok(route.indexOf("!canManageRole(context.actor.role, targetRole)") < route.indexOf('if (action === "site_scope") {'));
});

test("the list: null is every site; otherwise a non-empty set of this workspace's own sites", () => {
  assert.match(action, /if \(body\.siteScope !== null\) \{\s*if \(!Array\.isArray\(body\.siteScope\)\)/);
  assert.match(action, /if \(!named\.length\) \{[\s\S]*?status: 400/);
  assert.match(action, /const known = new Set\(\(await workspaceSites\(context\)\)\.map\(\(site\) => site\.id\)\);/);
  assert.match(action, /const unknown = named\.filter\(\(id\) => !known\.has\(id\)\);\s*if \(unknown\.length\) \{[\s\S]*?status: 400/);
  assert.match(action, /\.set\(\{ siteScope: next === null \? null : JSON\.stringify\(next\), updatedAt:/);
  assert.match(action, /eq\(memberships\.organisationId, context\.targetOrganisationId\)/, "this workspace's membership only");
  assert.match(action, /action: "user\.site_scope_changed"[\s\S]*?detail: \{ from: before, to: next \}/, "audited, from and to");
});

test("the roster sends each member's scope parsed (fail-closed) and the workspace's sites", () => {
  assert.match(route, /siteScope: parseSiteScope\(row\.siteScope\),/);
  assert.match(route, /sites: await workspaceSites\(context\),/);
  const sites = route.slice(route.indexOf("async function workspaceSites"), route.indexOf("async function roster"));
  assert.match(sites, /eq\(sites\.organisationId, context\.targetOrganisationId\)/);
  assert.match(sites, /registerScopeFilter\(sites\.boardId, CANONICAL_REGISTER\)/, "the canonical register, as the request form offers");
});

test("the screen draws Sites only where a change could be accepted, and the dialog behaves as a modal", async () => {
  const view = code(await read("app/(app)/portal/views/admin-users.tsx"));
  assert.match(view, /<th>Sites<\/th>/);
  assert.match(
    view,
    /can\("users\.edit"\) &&\s*user\.manageable !== false &&\s*!user\.isSelf &&\s*!user\.companyOwner &&\s*!user\.platformAdmin &&\s*workspaceRoles\.some\(\(role\) => role\.key === user\.role\) \? \(\s*<button[\s\S]*?onClick=\{\(\) => setSiteAccess\(user\)\}/,
  );
  assert.match(view, /run\(\{ userId: siteAccess\.id, action: "site_scope", siteScope: next \}, siteAccess\.id\)/);
  const dialog = code(await read("app/(app)/portal/views/site-access-dialog.tsx"));
  assert.match(dialog, /const \{ surface, onKeyDown \} = useDialogBehaviour\(true, onClose\);/);
  assert.match(dialog, /role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{titleId\}/);
  assert.match(dialog, /Every site in this workspace/);
  assert.match(dialog, /Only the sites chosen below/);
  assert.match(dialog, /The server\s*enforces this; nothing is merely hidden\./, "the warning about operational scope");
  assert.match(dialog, /disabled=\{saving \|\| invalid\}/, "an empty restriction cannot be saved");
});
