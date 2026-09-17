/**
 * Three levels of access: the MAINTSUPP platform, client companies, and the
 * workspaces inside them.
 *
 *   PLATFORM        Platform Super Admin   `platform_admins` — every company,
 *                                          every workspace, never a membership.
 *   CLIENT COMPANY  Owner                  `client_company_members` — every
 *                                          workspace of the companies they own,
 *                                          including ones created later.
 *   WORKSPACE       Admin, Manager, Client `memberships` — exactly the
 *                                          workspaces granted, nothing inherited.
 *
 * What this file holds in place:
 *
 *   1. The vocabulary and the assignment table (`app/lib/roles.ts`): authority
 *      depends on the LEVEL it comes from and its scope, not on rank alone.
 *   2. The resolver's answer per workspace (`roleInOrganisation`).
 *   3. The migration: additive, one company per existing workspace, platform
 *      authority carried over from active super-admin memberships, and never a
 *      guessed grouping.
 *   4. Invitations that encode the relationship, the company and the
 *      workspaces — and nothing the invitee can choose.
 *   5. Live, against a running dev server (skipped when nothing answers): two
 *      test companies, an Owner, an Admin, a Manager, a Client and a
 *      two-workspace person; a workspace created after they joined; every
 *      cross-company door tried and refused; landing per role. The fixtures
 *      are `@companies.test.maintsupp.com` accounts in two companies named
 *      "RBAC Test Company …", which are deactivated and archived at the end.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import "./reports-ts-loader.mjs";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};

const ORGANISATION_COOKIE = "maintsupp_demo_organisation";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const roles = await import("../app/lib/roles.ts");
const permissions = await import("../app/lib/permissions.ts");
// The pure halves: the per-workspace questions and the invitation's list.
const tenantAccess = await import("../app/lib/access-scope.ts");
const tokens = await import("../app/api/auth/invitations/invitation-scope.ts");

/* ================================================================== */
/* 1. Vocabulary and assignment                                        */
/* ================================================================== */

test("five roles on three levels, weakest first", () => {
  assert.deepEqual([...roles.ROLES], ["client", "manager", "admin", "owner", "super_admin"]);
  assert.deepEqual([...roles.MEMBERSHIP_ROLES], ["client", "manager", "admin"]);
  assert.equal(roles.ROLE_LEVEL.super_admin, "platform");
  assert.equal(roles.ROLE_LEVEL.owner, "company");
  for (const role of roles.MEMBERSHIP_ROLES) assert.equal(roles.ROLE_LEVEL[role], "workspace");
  assert.equal(roles.ROLE_LABELS.owner, "Owner");
  assert.equal(roles.isMembershipRole("owner"), false, "Owner is never a workspace membership");
  assert.equal(roles.isMembershipRole("super_admin"), false, "nor is Super Admin");
  assert.equal(roles.normaliseMembershipRole("super_admin"), null, "a legacy super_admin row is not a member");
});

test("the assignment table: who may give which role", () => {
  assert.deepEqual(roles.assignableRoles("super_admin"), ["client", "manager", "admin", "owner"]);
  assert.deepEqual(roles.assignableRoles("owner"), ["client", "manager", "admin"]);
  assert.deepEqual(roles.assignableRoles("admin"), ["client", "manager"]);
  assert.deepEqual(roles.assignableRoles("manager"), []);
  assert.deepEqual(roles.assignableRoles("client"), []);

  // Nobody appoints a Platform Super Admin through these flows.
  for (const actor of roles.ROLES) {
    assert.equal(roles.canAssignRole(actor, "super_admin"), false, `${actor} → super_admin`);
  }
  // Owners are appointed by the platform only — never by another Owner.
  assert.equal(roles.canAssignRole("owner", "owner"), false);
  assert.equal(roles.canAssignRole("admin", "owner"), false);
  assert.equal(roles.canAssignRole("owner", "admin"), true);

  // Acting on people: an Owner manages Admins; an Admin does not manage an Owner.
  assert.equal(roles.canManageRole("owner", "admin"), true);
  assert.equal(roles.canManageRole("owner", "owner"), false);
  assert.equal(roles.canManageRole("admin", "owner"), false);
  assert.equal(roles.canManageRole("super_admin", "owner"), true);
});

test("an Owner holds the Admin capability set, and nothing reserved", () => {
  const owner = permissions.effectiveCapabilities("owner", {});
  const admin = permissions.effectiveCapabilities("admin", {});
  assert.deepEqual(owner, admin, "company authority is scope, not extra capabilities");
  for (const reserved of ["clients.view_all", "roles.edit", "navigation.edit"]) {
    assert.equal(
      permissions.can({ role: "owner", capabilities: { [reserved]: true } }, reserved),
      false,
      `${reserved} stays the platform's even if a row grants it`,
    );
  }
  assert.equal(permissions.can({ role: "owner", capabilities: {} }, "navigation.personalise"), true);
});

/* ================================================================== */
/* 2. The resolver, per workspace                                      */
/* ================================================================== */

function access(overrides) {
  const organisations = [
    { id: "A1", clientCompanyId: "A" },
    { id: "A2", clientCompanyId: "A" },
    { id: "B1", clientCompanyId: "B" },
  ];
  return {
    platformAdmin: false,
    organisationIds: [],
    activeOrganisations: organisations,
    ownedCompanyIds: [],
    grants: [],
    unaffiliated: false,
    orgId: "A1",
    actor: { role: "client" },
    ...overrides,
  };
}

test("roleInOrganisation: platform everywhere, Owner across the company, members where granted", () => {
  const platform = access({ platformAdmin: true, organisationIds: ["A1", "A2", "B1"] });
  assert.equal(tenantAccess.roleInOrganisation(platform, "B1"), "super_admin");

  const owner = access({ ownedCompanyIds: ["A"], organisationIds: ["A1", "A2"] });
  assert.equal(tenantAccess.roleInOrganisation(owner, "A1"), "owner");
  assert.equal(tenantAccess.roleInOrganisation(owner, "A2"), "owner");
  assert.equal(tenantAccess.roleInOrganisation(owner, "B1"), null, "another company is nothing");

  const admin = access({
    organisationIds: ["A1"],
    grants: [{ organisationId: "A1", role: "admin" }],
  });
  assert.equal(tenantAccess.roleInOrganisation(admin, "A1"), "admin");
  assert.equal(tenantAccess.roleInOrganisation(admin, "A2"), null, "a sibling workspace is not inherited");

  // A grant for a workspace outside organisationIds never counts.
  const forged = access({
    organisationIds: ["A1"],
    grants: [{ organisationId: "A1", role: "client" }, { organisationId: "B1", role: "admin" }],
  });
  assert.equal(tenantAccess.roleInOrganisation(forged, "B1"), null);

  assert.equal(tenantAccess.administersCompany(owner, "A"), true);
  assert.equal(tenantAccess.administersCompany(owner, "B"), false);
  assert.equal(tenantAccess.administersCompany(platform, "B"), true);
  assert.equal(tenantAccess.companyOfOrganisation(owner, "A2"), "A");
});

test("an invitation's workspaces are read from the row, oldest format included", () => {
  assert.deepEqual(
    tokens.invitationWorkspaceIds({ workspace_ids: '["A1","A2","A1"]', organisation_id: "A1" }),
    ["A1", "A2"],
  );
  assert.deepEqual(tokens.invitationWorkspaceIds({ workspace_ids: null, organisation_id: "A1" }), ["A1"]);
  assert.deepEqual(tokens.invitationWorkspaceIds({ workspace_ids: "not json", organisation_id: "A1" }), ["A1"]);
  assert.deepEqual(tokens.invitationWorkspaceIds({ workspace_ids: "[]", organisation_id: "A1" }), ["A1"]);
});

/* ================================================================== */
/* 3. Schema and migration                                             */
/* ================================================================== */

test("the migration is additive: new tables, one new column each, no rewrite", async () => {
  const init = await read("db/init.ts");
  const block = init.slice(
    init.indexOf("async function ensureClientCompanies("),
    init.indexOf("async function ensureInvitationScope("),
  );
  assert.ok(block.length > 200, "ensureClientCompanies exists");
  assert.match(block, /CREATE TABLE IF NOT EXISTS client_companies/);
  assert.match(block, /CREATE TABLE IF NOT EXISTS client_company_members/);
  assert.match(block, /CREATE TABLE IF NOT EXISTS platform_admins/);
  assert.doesNotMatch(block, /DROP |RENAME|DELETE FROM/i, "nothing is removed or renamed");

  // One company per existing workspace — never a guessed grouping.
  assert.match(init, /SELECT 'company-' \|\| id, name, slug, 'active', id, 'migration:one-company-per-workspace'\s+FROM organisations\s+WHERE client_company_id IS NULL/);
  assert.match(init, /UPDATE organisations\s+SET client_company_id = 'company-' \|\| id\s+WHERE client_company_id IS NULL/);
  // Platform authority carried over from the memberships that meant it.
  assert.match(
    block,
    /INSERT OR IGNORE INTO platform_admins[\s\S]{0,200}FROM memberships[\s\S]{0,80}role ?= ?'super_admin'[\s\S]{0,40}status ?= ?'active'/,
  );
  // A workspace created outside the new path still gets a company, every boot.
  const repairs = init.slice(init.indexOf("async function repairInvariants("));
  assert.match(repairs.slice(0, 4000), /attachWorkspacesToCompanies\(d1\)/);

  // Invitations gain the company and the workspace list.
  assert.match(init, /async function ensureInvitationScope\(/);
  assert.match(init, /\["client_company_id", "TEXT"\],\s*\["workspace_ids", "TEXT"\]/);

  const schema = await read("db/schema.ts");
  assert.match(schema, /clientCompanyId: text\("client_company_id"\)/);
  assert.match(schema, /export const clientCompanies = sqliteTable\(\s*"client_companies"/);
  assert.match(schema, /export const clientCompanyMembers = sqliteTable\(\s*"client_company_members"/);
  assert.match(schema, /export const platformAdmins = sqliteTable\("platform_admins"/);
});

test("nothing derives an Owner or a Super Admin membership from a label any more", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /WHERE organisation_id IS NOT NULL AND lower\(role\) NOT IN \('owner', 'super admin'\)/);
  assert.doesNotMatch(init, /WHEN 'super admin' THEN 'super_admin'/, "a label never becomes a super_admin membership");
  assert.doesNotMatch(init, /everyOrganisation/, "the testing Super Admin is not widened into every workspace");

  const auth = await read("app/lib/auth-session.ts");
  assert.match(auth, /INSERT OR IGNORE INTO platform_admins \(user_id, status, granted_by\)\s+VALUES \(\?, 'active', 'owner-bootstrap'\)/);

  const workspace = await read("app/api/workspace/route.ts");
  assert.match(workspace, /if \(label === "super admin" \|\| label === "owner"\) continue;/);

  const demo = await read("db/demo-workspace.ts");
  assert.doesNotMatch(demo, /'demo-member-' \|\| m\.user_id/);
});

test("the resolver: platform sees everything, an Owner their companies, a member their grants", async () => {
  const source = await read("app/lib/tenant-access.ts");
  assert.match(source, /loadCompanyAuthority/);
  assert.match(source, /normaliseMembershipRole/, "legacy super_admin rows are not grants");
  assert.match(source, /crossOrganisation: platformAdmin|crossOrganisation = platformAdmin|crossOrganisation:\s*platformAdmin/);
  assert.match(source, /noAccess/);

  const db = await read("app/lib/tenant-db.ts");
  assert.match(db, /class NoWorkspaceAccessError/);
  assert.match(db, /noWorkspace: true/);
});

test("a new workspace starts with no members, and never copies a customer's store list", async () => {
  const source = await read("app/lib/client-companies.ts");
  assert.match(source, /const CUSTOMER_SPECIFIC_OPTION_SETS = new Set\(\["store_location"\]\)/);
  const create = source.slice(source.indexOf("export async function createWorkspace("));
  const memberships = create.slice(0, create.indexOf("export type CompanySummary"));
  // The only membership write is the development-only testing identities.
  const guard = memberships.indexOf("if (demoIdentityAllowed()) {");
  assert.ok(guard > 0);
  assert.equal(memberships.indexOf(".insert(memberships)"), memberships.indexOf(".insert(memberships)", guard));
});

/* ================================================================== */
/* 4. Invitations                                                      */
/* ================================================================== */

test("an invitation carries the relationship, the company and the workspaces", async () => {
  const route = await read("app/api/auth/invitations/route.ts");
  assert.match(route, /Platform Super Admins are not appointed by invitation\./);
  assert.match(route, /if \(!scope\.platformAdmin\) \{[\s\S]{0,120}Only a Super Admin can appoint a company Owner\./);
  assert.match(route, /The workspaces in one invitation must all belong to the same client company\./);
  assert.match(route, /const actingRole = roleInOrganisation\(scope, target\.id\);/);
  assert.match(route, /canAssignRole\(actingRole, role\)/);
  assert.match(route, /can\(subject, "users\.invite"\)/);
  assert.doesNotMatch(route, /invitingRole/);

  const tokenSource = await read("app/api/auth/invitations/invitation-tokens.ts");
  assert.match(tokenSource, /client_company_id, workspace_ids\)/);
  assert.match(tokenSource, /if \(!role \|\| role === "super_admin" \|\| !invitation\.organisation_id\) return null;/);

  const accept = await read("app/api/auth/invitations/[token]/route.ts");
  assert.match(accept, /INSERT INTO client_company_members/);
  assert.match(accept, /for \(const workspace of grant\.workspaces\)/);
  // Settled before the token is consumed, so a dead grant does not burn it.
  assert.ok(
    accept.indexOf("const grant = await invitationGrant(d1, invitation);", accept.indexOf("export async function POST")) <
      accept.indexOf("SET accepted_at = ?, accepted_user_id = ?"),
  );
});

/* ================================================================== */
/* 5. Live                                                             */
/* ================================================================== */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function mergeCookies(jar, response) {
  const next = new Map(
    (jar ?? "")
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.split("=")[0], pair]),
  );
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    next.set(pair.split("=")[0], pair);
  }
  return [...next.values()].join("; ");
}

function withCookie(jar, name, value) {
  const kept = (jar ?? "")
    .split("; ")
    .filter((pair) => pair && pair.split("=")[0] !== name);
  return [...kept, `${name}=${encodeURIComponent(value)}`].join("; ");
}

async function api(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text, response };
}

const post = (cookie, path, body) => api(cookie, path, { method: "POST", body: JSON.stringify(body) });
const patch = (cookie, path, body) => api(cookie, path, { method: "PATCH", body: JSON.stringify(body) });

const live = await serverIsUp();
const STAMP = `${Date.now()}`;
const PASSWORD = `companies fixture ${STAMP} ok`;
const created = [];
let platformCookie = null;

async function platform() {
  if (platformCookie) return platformCookie;
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!response.ok) return null;
  platformCookie = mergeCookies("", response);
  return platformCookie;
}

async function signIn(email) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `${email} signs in`);
  return mergeCookies("", response);
}

const tokenOf = (url) => String(url).split("/invite/")[1];

async function accept(token, label) {
  const response = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, fullName: `Companies ${label}` }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { body, cookie: mergeCookies("", response) };
}

const contextOf = async (cookie) => (await api(cookie, "/api/context")).body?.context;
const idsOf = (context) => (context?.organisations ?? []).map((item) => item.id).sort();

let fixtures = null;
async function world() {
  if (fixtures) return fixtures;
  const cookie = await platform();
  const companyA = await post(cookie, "/api/admin/companies", {
    action: "create_company",
    name: `RBAC Test Company A ${STAMP}`,
    workspaceName: `RBAC A1 ${STAMP}`,
  });
  assert.equal(companyA.status, 201, companyA.text);
  const companyB = await post(cookie, "/api/admin/companies", {
    action: "create_company",
    name: `RBAC Test Company B ${STAMP}`,
  });
  assert.equal(companyB.status, 201, companyB.text);
  const a2 = await post(cookie, "/api/admin/companies", {
    action: "create_workspace",
    clientCompanyId: companyA.body.company.id,
    name: `RBAC A2 ${STAMP}`,
  });
  assert.equal(a2.status, 201, a2.text);

  const A = companyA.body.company.id;
  const B = companyB.body.company.id;
  const A1 = companyA.body.workspace.id;
  const A2 = a2.body.workspace.id;
  const B1 = companyB.body.workspace.id;

  const invite = async (inviterCookie, body) => {
    const response = await post(inviterCookie, "/api/auth/invitations", body);
    assert.equal(response.status, 201, response.text);
    created.push(body.email);
    return response;
  };
  const email = (label) => `companies-${label}-${STAMP}@companies.test.maintsupp.com`;

  // Onboarding: the platform invites Owner A; Owner A lands in company A.
  const ownerInvite = await invite(cookie, { email: email("owner-a"), role: "owner", clientCompanyId: A });
  // Read what the link says BEFORE it is used — a used link describes nothing.
  const describeOwner = await api(null, `/api/auth/invitations/${tokenOf(ownerInvite.body.inviteUrl)}`);
  const ownerA = await accept(tokenOf(ownerInvite.body.inviteUrl), "Owner A");
  const ownerBInvite = await invite(cookie, { email: email("owner-b"), role: "owner", clientCompanyId: B });
  const ownerB = await accept(tokenOf(ownerBInvite.body.inviteUrl), "Owner B");

  // Owner A invites the workspace roles into A1, and one person into A1 + A2.
  const adminInvite = await invite(ownerA.cookie, { email: email("admin-a1"), role: "admin", organisationIds: [A1] });
  const managerInvite = await invite(ownerA.cookie, { email: email("manager-a1"), role: "manager", organisationIds: [A1] });
  const clientInvite = await invite(ownerA.cookie, { email: email("client-a1"), role: "client", organisationIds: [A1] });
  const multiInvite = await invite(ownerA.cookie, { email: email("multi"), role: "client", organisationIds: [A1, A2] });

  const describeMulti = await api(null, `/api/auth/invitations/${tokenOf(multiInvite.body.inviteUrl)}`);
  const usedLink = await api(null, `/api/auth/invitations/${tokenOf(ownerInvite.body.inviteUrl)}`);

  fixtures = {
    A, B, A1, A2, B1,
    ownerInvite,
    describeOwner,
    usedLink,
    describeMulti,
    ownerA: { ...ownerA, email: email("owner-a") },
    ownerB: { ...ownerB, email: email("owner-b") },
    admin: { ...(await accept(tokenOf(adminInvite.body.inviteUrl), "Admin A1")), email: email("admin-a1") },
    manager: { ...(await accept(tokenOf(managerInvite.body.inviteUrl), "Manager A1")), email: email("manager-a1") },
    client: { ...(await accept(tokenOf(clientInvite.body.inviteUrl), "Client A1")), email: email("client-a1") },
    multi: { ...(await accept(tokenOf(multiInvite.body.inviteUrl), "Multi")), email: email("multi") },
    companyA: companyA.body.company,
    companyB: companyB.body.company,
  };
  return fixtures;
}

after(async () => {
  if (!live || !platformCookie || !fixtures) return;
  // Deactivate every account this run created, then archive both companies
  // (their workspaces and outstanding invitations with them). Nothing is
  // deleted — the product does not delete people or workspaces.
  for (const organisationId of [fixtures.A1, fixtures.A2, fixtures.B1]) {
    const roster = await api(platformCookie, `/api/admin/users?organisationId=${organisationId}`);
    for (const user of roster.body?.users ?? []) {
      if (!created.includes(user.email) || !user.active) continue;
      await patch(platformCookie, "/api/admin/users", {
        userId: user.id,
        action: "deactivate",
        organisationId,
      });
    }
  }
  for (const company of [fixtures.companyA, fixtures.companyB]) {
    const companies = await api(platformCookie, "/api/admin/companies");
    const found = companies.body?.companies?.find((item) => item.id === company.id);
    if (!found) continue;
    await post(platformCookie, "/api/admin/companies", {
      action: "archive_company",
      clientCompanyId: company.id,
      confirm: found.name,
    });
  }
});

test("live: onboarding — company, first workspace, Owner invited and landed in their company", { skip: !live }, async (t) => {
  if (!(await platform())) return t.skip("the seeded owner could not sign in");
  const world_ = await world();

  // The invitation encodes the relationship and the company, not a workspace.
  const invitation = world_.ownerInvite.body.invitation;
  assert.equal(invitation.role, "owner");
  assert.equal(invitation.clientCompanyId, world_.A);
  assert.deepEqual(invitation.workspaces, []);
  assert.equal(world_.ownerInvite.body.delivery.status, process.env.INVITATION_EMAIL_MODE ? world_.ownerInvite.body.delivery.status : "disabled");

  assert.equal(world_.describeOwner.status, 200, world_.describeOwner.text);
  assert.equal(world_.usedLink.status, 410, "the Owner's link is single use");
  const described = world_.describeOwner.body.invitation;
  assert.equal(described.wholeCompany, true);
  assert.equal(described.companyName, world_.companyA.name);
  assert.equal(described.workspaceNames.length, 2, "the page lists the company's workspaces");

  // Accepting lands the Owner in the company's default workspace.
  assert.equal(world_.ownerA.body.role, "owner");
  assert.equal(world_.ownerA.body.organisationId, world_.A1);
  const context = await contextOf(world_.ownerA.cookie);
  assert.equal(context.actor.role, "owner");
  assert.equal(context.currentOrganisation.id, world_.A1);
  assert.deepEqual(idsOf(context), [world_.A1, world_.A2].sort(), "every workspace of company A, nothing else");
  assert.equal(context.identity.platformAdmin, false);
  assert.equal(context.identity.ownsCurrentCompany, true);
  assert.equal(context.identity.crossOrganisation, false);
  assert.deepEqual(context.companies.map((company) => company.id), [world_.A]);

  // An Owner of a one-workspace company lands there, with nothing to choose.
  const contextB = await contextOf(world_.ownerB.cookie);
  assert.deepEqual(idsOf(contextB), [world_.B1]);
  assert.equal(contextB.currentOrganisation.id, world_.B1);
});

test("live: workspace roles reach exactly the workspaces granted, nothing inherited", { skip: !live }, async (t) => {
  if (!(await platform())) return t.skip("the seeded owner could not sign in");
  const w = await world();

  for (const [label, person, role] of [
    ["Admin A1", w.admin, "admin"],
    ["Manager A1", w.manager, "manager"],
    ["Client A1", w.client, "client"],
  ]) {
    const context = await contextOf(person.cookie);
    assert.deepEqual(idsOf(context), [w.A1], `${label} reaches A1 only`);
    assert.equal(context.actor.role, role, `${label} acts as ${role}`);
    assert.equal(context.identity.ownsCurrentCompany, false);
    assert.equal(context.tenantSummary, null, `${label} gets no cross-client summary`);
  }

  const multi = await contextOf(w.multi.cookie);
  assert.deepEqual(idsOf(multi), [w.A1, w.A2].sort(), "a two-workspace person reaches both");
  assert.equal(w.describeMulti.body.invitation.workspaceNames.length, 2);
  assert.equal(w.describeMulti.body.invitation.wholeCompany, false);
});

test("live: a new workspace is seen by the platform and the company's Owners only", { skip: !live }, async (t) => {
  const cookie = await platform();
  if (!cookie) return t.skip("the seeded owner could not sign in");
  const w = await world();

  // Owner A creates A3 in their own company — through the switcher's route.
  const a3 = await post(w.ownerA.cookie, "/api/context", {
    action: "create_organisation",
    name: `RBAC A3 ${STAMP}`,
    clientCompanyId: w.A,
  });
  assert.equal(a3.status, 201, a3.text);
  const A3 = a3.body.organisation.id;
  assert.equal(a3.body.organisation.clientCompanyId, w.A);

  // A company id the Owner does not own is refused, and so is a new company.
  const elsewhere = await post(w.ownerA.cookie, "/api/context", {
    action: "create_organisation",
    name: `RBAC stray ${STAMP}`,
    clientCompanyId: w.B,
  });
  assert.equal(elsewhere.status, 403);
  const stray = await post(w.ownerA.cookie, "/api/admin/companies", {
    action: "create_workspace",
    clientCompanyId: w.B,
    name: `RBAC stray ${STAMP}`,
  });
  assert.equal(stray.status, 403);
  const newCompany = await post(w.ownerA.cookie, "/api/admin/companies", {
    action: "create_company",
    name: `RBAC stray ${STAMP}`,
  });
  assert.equal(newCompany.status, 403);
  for (const person of [w.admin, w.manager, w.client]) {
    const refused = await post(person.cookie, "/api/context", {
      action: "create_organisation",
      name: `RBAC stray ${STAMP}`,
      clientCompanyId: w.A,
    });
    assert.equal(refused.status, 403, "below Owner, no workspace is created");
  }

  // Automatically visible to the Owner (the cookie moved them there, too) …
  const ownerContext = await contextOf(w.ownerA.cookie);
  assert.ok(idsOf(ownerContext).includes(A3), "the Owner sees the new workspace");
  // … and to the platform …
  assert.ok(idsOf(await contextOf(cookie)).includes(A3));
  // … and to nobody else until they are given it.
  for (const person of [w.admin, w.manager, w.client, w.multi, w.ownerB]) {
    const context = await contextOf(person.cookie);
    assert.ok(!idsOf(context).includes(A3), `${person.email} does not see A3`);
    const forced = await api(withCookie(person.cookie, ORGANISATION_COOKIE, A3), "/api/context");
    assert.notEqual(forced.body?.context?.currentOrganisation?.id, A3, "a cookie does not open it");
  }
  const roster = await api(cookie, `/api/admin/users?organisationId=${A3}`);
  assert.equal(roster.status, 200);
  assert.deepEqual(
    roster.body.users.filter((user) => !user.companyOwner).map((user) => user.email).filter((e) => e.includes("companies.test")),
    [],
    "no workspace member was added",
  );
  assert.ok(roster.body.users.some((user) => user.email === w.ownerA.email && user.companyOwner));
});

test("live: every cross-company door is refused", { skip: !live }, async (t) => {
  if (!(await platform())) return t.skip("the seeded owner could not sign in");
  const w = await world();

  for (const person of [w.ownerA, w.admin, w.manager, w.client, w.multi]) {
    // Selecting a workspace of company B.
    const select = await post(person.cookie, "/api/context", { action: "select_organisation", organisationId: w.B1 });
    assert.ok(select.status >= 400, `${person.email}: select B1 → ${select.status}`);
    // Naming it on an admin route.
    const users = await api(person.cookie, `/api/admin/users?organisationId=${w.B1}`);
    assert.equal(users.status, 403, `${person.email}: B1's people`);
    // Forging the organisation cookie.
    const forged = await contextOf(withCookie(person.cookie, ORGANISATION_COOKIE, w.B1));
    assert.notEqual(forged.currentOrganisation.id, w.B1);
    assert.ok(!idsOf(forged).includes(w.B1));
    // Inviting into it.
    const invite = await post(person.cookie, "/api/auth/invitations", {
      email: `companies-cross-${STAMP}@companies.test.maintsupp.com`,
      role: "client",
      organisationIds: [w.B1],
    });
    assert.equal(invite.status, 403, `${person.email}: invite into B1`);
    // Its company.
    const companies = await api(person.cookie, "/api/admin/companies");
    assert.ok(
      !(companies.body?.companies ?? []).some((company) => company.id === w.B),
      `${person.email} never sees company B`,
    );
    const setDefault = await post(person.cookie, "/api/admin/companies", {
      action: "set_default_workspace",
      clientCompanyId: w.B,
      organisationId: w.B1,
    });
    assert.equal(setDefault.status, 403);
  }

  // The same person in both companies' pickers? Only the platform.
  const ownerB = await contextOf(w.ownerB.cookie);
  assert.deepEqual(idsOf(ownerB), [w.B1]);

  // A mixed invitation — one workspace of each company — is refused outright.
  const mixed = await post(await platform(), "/api/auth/invitations", {
    email: `companies-mixed-${STAMP}@companies.test.maintsupp.com`,
    role: "client",
    organisationIds: [w.A1, w.B1],
  });
  assert.equal(mixed.status, 400);

  // Global administration stays the platform's.
  for (const person of [w.ownerA, w.admin]) {
    assert.equal((await api(person.cookie, "/api/admin/clients")).status, 403);
    assert.equal((await api(person.cookie, "/api/admin/roles")).status, 403);
    const nav = await api(person.cookie, "/api/navigation", {
      method: "PUT",
      body: JSON.stringify({ scope: "workspace", items: [] }),
    });
    assert.ok([400, 403].includes(nav.status), `workspace sidebar: ${nav.status}`);
    assert.notEqual(nav.status, 200);
  }
});

test("live: who may invite whom, per level and scope", { skip: !live }, async (t) => {
  const cookie = await platform();
  if (!cookie) return t.skip("the seeded owner could not sign in");
  const w = await world();
  const address = (label) => `companies-x-${label}-${STAMP}@companies.test.maintsupp.com`;
  const attempt = (person, body) => post(person.cookie ?? person, "/api/auth/invitations", body);

  // Nobody appoints a Platform Super Admin by invitation.
  assert.equal((await attempt(cookie, { email: address("sa"), role: "super_admin", organisationIds: [w.A1] })).status, 403);
  // Owners appoint no Owners; Admins neither.
  assert.equal((await attempt(w.ownerA, { email: address("o1"), role: "owner", clientCompanyId: w.A })).status, 403);
  assert.equal((await attempt(w.admin, { email: address("o2"), role: "owner", clientCompanyId: w.A })).status, 403);
  // An Owner may give Admin anywhere in the company.
  const ownerGivesAdmin = await attempt(w.ownerA, { email: address("a2"), role: "admin", organisationIds: [w.A2] });
  assert.equal(ownerGivesAdmin.status, 201, ownerGivesAdmin.text);
  created.push(address("a2"));
  // An Admin gives Manager/Client in the workspace they administer …
  const adminGivesManager = await attempt(w.admin, { email: address("m1"), role: "manager", organisationIds: [w.A1] });
  assert.equal(adminGivesManager.status, 201, adminGivesManager.text);
  created.push(address("m1"));
  // … but not Admin, and not into a sibling workspace they do not administer.
  assert.equal((await attempt(w.admin, { email: address("a3"), role: "admin", organisationIds: [w.A1] })).status, 403);
  assert.equal((await attempt(w.admin, { email: address("c2"), role: "client", organisationIds: [w.A2] })).status, 403);
  assert.equal((await attempt(w.admin, { email: address("c3"), role: "client", organisationIds: [w.A1, w.A2] })).status, 403);
  // Managers and Clients invite nobody.
  for (const person of [w.manager, w.client, w.multi]) {
    assert.equal((await attempt(person, { email: address("c4"), role: "client", organisationIds: [w.A1] })).status, 403);
  }

  // A duplicate is refused; a resend must repeat the invitation as it was.
  const duplicate = await attempt(w.admin, { email: address("m1"), role: "manager", organisationIds: [w.A1] });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.pendingInvitation, true);
  const changed = await attempt(w.admin, { email: address("m1"), role: "client", organisationIds: [w.A1], resend: true });
  assert.equal(changed.status, 409, "a resend cannot change the role");
  const resent = await attempt(w.admin, { email: address("m1"), role: "manager", organisationIds: [w.A1], resend: true });
  assert.equal(resent.status, 201, resent.text);
  const oldLink = await api(null, `/api/auth/invitations/${tokenOf(adminGivesManager.body.inviteUrl)}`);
  assert.equal(oldLink.status, 410, "the first link died with the resend");

  // The Owner sees the company's workspace list with what they may give where.
  const ownerView = await api(w.ownerA.cookie, `/api/admin/users?organisationId=${w.A1}`);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body.company.id, w.A);
  for (const workspace of ownerView.body.companyWorkspaces) {
    assert.deepEqual(workspace.inviteRoles, ["client", "manager", "admin"]);
  }
  assert.equal(ownerView.body.roles.find((role) => role.key === "owner").assignable, false);
  const adminView = await api(w.admin.cookie, `/api/admin/users?organisationId=${w.A1}`);
  assert.equal(adminView.status, 200);
  assert.deepEqual(adminView.body.companyWorkspaces.map((workspace) => workspace.id), [w.A1]);
  assert.deepEqual(adminView.body.companyWorkspaces[0].inviteRoles, ["client", "manager"]);
  const platformView = await api(cookie, `/api/admin/users?organisationId=${w.A1}`);
  assert.equal(platformView.body.roles.find((role) => role.key === "owner").assignable, true);
  assert.equal(platformView.body.roles.find((role) => role.key === "super_admin").assignable, false);
});

test("live: workspace access is granted and removed one workspace at a time, within scope", { skip: !live }, async (t) => {
  if (!(await platform())) return t.skip("the seeded owner could not sign in");
  const w = await world();
  const roster = await api(w.ownerA.cookie, `/api/admin/users?organisationId=${w.A1}`);
  const clientRow = roster.body.users.find((user) => user.email === w.client.email);
  const ownerRow = roster.body.users.find((user) => user.email === w.ownerA.email);
  assert.ok(clientRow && ownerRow);
  assert.equal(ownerRow.role, "owner");
  assert.equal(ownerRow.companyOwner, true);

  const change = (person, body) =>
    patch(person.cookie, "/api/admin/users", { organisationId: w.A1, userId: clientRow.id, action: "workspace_access", ...body });

  // The Admin of A1 does not administer A2, so cannot open it for anybody.
  assert.equal((await change(w.admin, { workspaceId: w.A2, access: "grant", role: "client" })).status, 403);
  // Nor can a Manager; nor can anybody reach into company B.
  assert.equal((await change(w.manager, { workspaceId: w.A2, access: "grant", role: "client" })).status, 403);
  assert.equal((await change(w.ownerA, { workspaceId: w.B1, access: "grant", role: "client" })).status, 403);
  // The Owner can — and the role is still bounded.
  assert.equal((await change(w.ownerA, { workspaceId: w.A2, access: "grant", role: "owner" })).status, 400);
  const granted = await change(w.ownerA, { workspaceId: w.A2, access: "grant", role: "client" });
  assert.equal(granted.status, 200, granted.text);
  assert.deepEqual(idsOf(await contextOf(w.client.cookie)), [w.A1, w.A2].sort());

  const removed = await change(w.ownerA, { workspaceId: w.A2, access: "remove" });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(idsOf(await contextOf(w.client.cookie)), [w.A1]);
  // Their only workspace is not removed from here — that is deactivation.
  const last = await change(w.ownerA, { workspaceId: w.A1, access: "remove" });
  assert.equal(last.status, 409);

  // Nobody below the platform acts on an Owner's account.
  for (const person of [w.admin]) {
    const refused = await patch(person.cookie, "/api/admin/users", {
      organisationId: w.A1,
      userId: ownerRow.id,
      action: "deactivate",
    });
    assert.equal(refused.status, 403);
    const reset = await post(person.cookie, "/api/admin/users/password-reset", {
      organisationId: w.A1,
      userId: ownerRow.id,
    });
    assert.equal(reset.status, 403);
  }
  // An Owner's role is not a membership to edit.
  const reRole = await patch(await platform(), "/api/admin/users", {
    organisationId: w.A1,
    userId: ownerRow.id,
    action: "role",
    role: "client",
  });
  assert.equal(reRole.status, 409);
});

test("live: landing — last valid choice, company default, deterministic first; never a forged one", { skip: !live }, async (t) => {
  if (!(await platform())) return t.skip("the seeded owner could not sign in");
  const w = await world();

  // A member with one workspace lands in it.
  const admin = await signIn(w.admin.email);
  assert.equal((await contextOf(admin)).currentOrganisation.id, w.A1);

  // A two-workspace person: the last valid choice is kept …
  const multi = await signIn(w.multi.email);
  const choose = await post(multi, "/api/context", { action: "select_organisation", organisationId: w.A2 });
  assert.equal(choose.status, 200, choose.text);
  const chosen = mergeCookies(multi, choose.response);
  assert.equal((await contextOf(chosen)).currentOrganisation.id, w.A2);
  // … and a forged one is ignored for the deterministic first.
  const forged = await contextOf(withCookie(multi, ORGANISATION_COOKIE, w.B1));
  assert.ok([w.A1, w.A2].includes(forged.currentOrganisation.id));
  const unknown = await contextOf(withCookie(multi, ORGANISATION_COOKIE, "org_does_not_exist"));
  assert.ok([w.A1, w.A2].includes(unknown.currentOrganisation.id));

  // An Owner with no choice lands on the company default, which the Owner sets.
  const moved = await post(w.ownerA.cookie, "/api/admin/companies", {
    action: "set_default_workspace",
    clientCompanyId: w.A,
    organisationId: w.A2,
  });
  assert.equal(moved.status, 200, moved.text);
  const fresh = await signIn(w.ownerA.email);
  assert.equal((await contextOf(fresh)).currentOrganisation.id, w.A2);

  // Removing the Owner removes the company with it — and nothing is left over.
  const ownerRow = (await api(await platform(), `/api/admin/users?organisationId=${w.B1}`)).body.users.find(
    (user) => user.email === w.ownerB.email,
  );
  const removed = await post(await platform(), "/api/admin/companies", {
    action: "remove_owner",
    clientCompanyId: w.B,
    userId: ownerRow.id,
  });
  assert.equal(removed.status, 200, removed.text);
  const orphan = await api(w.ownerB.cookie, "/api/context");
  assert.equal(orphan.status, 403, "no workspace at all, not a fallback one");
  assert.equal(orphan.body.noWorkspace, true);
  const orphanUsers = await api(w.ownerB.cookie, `/api/admin/users?organisationId=${w.B1}`);
  assert.equal(orphanUsers.status, 403);
});
