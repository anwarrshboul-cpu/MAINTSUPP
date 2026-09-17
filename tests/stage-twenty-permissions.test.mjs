/**
 * Stage 20 — a role is a boundary, not a label.
 *
 * Stage 19 proved one client cannot read another client's rows. It deliberately
 * said nothing about what a person may *do* inside the workspace they can
 * legitimately read, and the answer at that point was "anything": every actor
 * hit the same write routes, so "admin" and "client" were words on a sidebar.
 *
 * Two halves, the same shape as the Stage 19 suite.
 *
 * The first reads the source and pins the *shape* of the rule: that capabilities
 * are declared in one module, that every admin route resolves its organisation
 * through `adminContext` rather than from a cookie, and that no route decides a
 * permission by comparing role strings on the spot.
 *
 * The second talks to a running dev server, because a permission that reads
 * correctly is not evidence. It drives the real endpoints as five real seeded
 * identities and checks the actual status codes — including every guard-rail,
 * which is the part that cannot be verified by reading.
 *
 * The live half restores whatever it changes. Where it cannot avoid mutating
 * (the last-super-admin proof needs a workspace with exactly one super admin),
 * the restore is in a `finally` so a failure mid-test still puts the database
 * back.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
// Resolves the extensionless imports inside app/lib/*.ts for the unit checks.
import "./reports-ts-loader.mjs";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

/* The seeded identities. Every one of these is a real `users` row with a real
   `memberships` row — except SUPER_ADMIN, which since the three-level batch is
   a `platform_admins` row and a member of nothing. The second super admin this
   file used for the last-super-admin proof is no longer needed; see that test. */
const SUPER_ADMIN = "super-admin@test.maintsupp.com";
const SUNNAMUSK_ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const SUNNAMUSK_CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
const DEMO_ADMIN = "admin@demo-client-ltd.test.maintsupp.com";
const DEMO_CLIENT = "client@demo-client-ltd.test.maintsupp.com";

const SUPER_ADMIN_ID = "user-super-admin-test-maintsupp-com";
const SUNNAMUSK_ADMIN_ID = "user-admin-sunnamusk-uk-test-maintsupp-com";
const SAMPLE_CLIENT_ID = "user-sample-client-maintsupp-local";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const adminRoutes = [
  "app/api/admin/users/route.ts",
  "app/api/admin/roles/route.ts",
  "app/api/admin/clients/route.ts",
];

/* ------------------------------------------------------------------ */
/* Shape: the rule lives in one place                                  */
/* ------------------------------------------------------------------ */

test("the capability set is declared once, with a default for every role", async () => {
  const permissions = await source("app/lib/permissions.ts");

  // The capabilities the product promised. A missing one is a screen with no
  // server-side gate behind it.
  for (const capability of [
    "board.edit",
    "users.invite",
    "users.deactivate",
    "roles.edit",
    "data.import",
    "data.delete",
    "audit.read",
    "clients.view_all",
    "billing.manage",
  ]) {
    assert.match(
      permissions,
      new RegExp(`key: "${capability.replace(".", "\\.")}"`),
      `${capability} must be in the catalogue`,
    );
  }

  /*
   * Exactly the roles the rest of the system can represent — FOUR since the
   * roles-and-access batch added `manager`, FIVE since the three-level batch
   * added the client company's `owner` (held through `client_company_members`,
   * which the tenancy resolver reads, so it is a column somebody can match).
   *
   * This asserted the three-role list inside permissions.ts, with the warning
   * that a fourth here "would be a matrix column that no membership row could
   * ever match". That warning is why the list moved rather than grew in place:
   * it is defined once in `roles.ts`, and permissions.ts, the tenancy resolver
   * and the invitation service all import it (pinned by the next test), so a
   * role in the matrix is a role a membership can hold.
   */
  const roles = await source("app/lib/roles.ts");
  assert.match(
    roles,
    /ROLES: readonly WorkspaceRole\[\] = \["client", "manager", "admin", "owner", "super_admin"\]/,
  );
  assert.match(permissions, /from "\.\/roles"/, "permissions.ts takes the role list from roles.ts");
  assert.doesNotMatch(
    permissions,
    /export const ROLES: readonly WorkspaceRole\[\] = \[/,
    "and does not define a second one",
  );
  for (const role of ["super_admin", "owner", "admin", "manager", "client"]) {
    assert.match(
      permissions,
      new RegExp(`${role}: `),
      `${role} must have a built-in default set`,
    );
  }

  // The fallback rule: a capability with no row takes the built-in default, so
  // an empty table is a working system rather than a locked-out one.
  assert.match(permissions, /if \(typeof override === "boolean"\) return override;/);
  assert.match(permissions, /return defaultAllows\(actor\.role, capability\);/);

  // And the recovery path: the top role is never decided by the table.
  assert.match(permissions, /if \(actor\.role === IMMUTABLE_ROLE\) return true;/);

  // Reserved capabilities are refused below Super Admin BEFORE any override is
  // read, so no row in the table can grant them.
  // `isForbiddenForRole` covers both the reservations and the manager ceiling.
  const reserved = permissions.indexOf("if (isForbiddenForRole(actor.role, capability)) return false;");
  const override = permissions.indexOf("const override = actor.capabilities[capability];");
  assert.ok(reserved > 0 && override > reserved, "the reservation is checked before overrides");
  for (const capability of ["clients.view_all", "roles.edit", "navigation.edit"]) {
    assert.match(
      permissions.slice(permissions.indexOf("export const SUPER_ADMIN_ONLY")),
      new RegExp(`"${capability.replace(".", "\\.")}"`),
      `${capability} is reserved for Super Admin`,
    );
  }
});

test("the role list in permissions.ts matches the one tenancy grants", async () => {
  const access = await source("app/lib/tenant-access.ts");
  const permissions = await source("app/lib/permissions.ts");
  const invitations = await source("app/api/auth/invitations/invitation-tokens.ts");
  const actor = await source("app/lib/workspace-actor.ts");

  /*
   * `normaliseRole` is the authority on which membership roles survive. If the
   * lists drift, the matrix grows a column that can never apply to anybody.
   *
   * This used to read the three `value === "…"` comparisons out of
   * tenant-access.ts's private normaliser. There is no private normaliser any
   * more: the tenancy resolver, the permission module, the invitation service
   * and the actor type all import the ONE list in roles.ts. So the drift this
   * test guards against is now pinned as "nobody keeps their own copy" — which
   * is the stronger form of "the copies agree".
   */
  // Re-pointed: the resolver now keeps only membership roles from a
  // membership row (`normaliseMembershipRole`) — a legacy super_admin row is
  // not a grant — and still takes the vocabulary from roles.ts.
  // …and since the membership reader moved to `tenant-grants.ts`, that is
  // where the import lives; tenant-access.ts takes the reader from there.
  const grants = await source("app/lib/tenant-grants.ts");
  assert.match(grants, /import \{ normaliseMembershipRole, type MembershipRole \} from "\.\/roles"/);
  assert.match(access, /from "\.\/tenant-grants"/);
  assert.match(permissions, /from "\.\/roles"/);
  assert.match(invitations, /from "\.\.\/\.\.\/\.\.\/lib\/roles"/);
  assert.match(actor, /export type \{ WorkspaceRole \} from "\.\/roles"/);
  for (const [name, text] of [
    ["tenant-access.ts", access],
    ["permissions.ts", permissions],
    ["invitation-tokens.ts", invitations],
  ]) {
    assert.doesNotMatch(
      text,
      /value === "super_admin" \|\| value === "admin"/,
      `${name} must not carry its own role normaliser`,
    );
    assert.doesNotMatch(
      text,
      /client: 0,\s*admin: 1,/,
      `${name} must not carry its own three-role rank table`,
    );
  }

  const roles = await import("../app/lib/roles.ts");
  assert.deepEqual([...roles.ROLES], ["client", "manager", "admin", "owner", "super_admin"]);
  for (const role of roles.ROLES) assert.equal(roles.normaliseRole(role), role);
  assert.equal(roles.normaliseRole("director"), null, "an unknown role is discarded");
  assert.equal(roles.normaliseRole("Admin"), null, "labels are not roles");
  // Only three of the five can be a workspace membership.
  assert.equal(roles.normaliseMembershipRole("owner"), null);
  assert.equal(roles.normaliseMembershipRole("super_admin"), null);
});

test("every admin route resolves tenancy and capability, and neither by hand", async () => {
  for (const path of adminRoutes) {
    const text = await source(path);

    // Tenancy: through the shared resolver, which validates the requested
    // organisation against the actor's own membership list.
    assert.match(text, /adminContext\(request/, `${path} must resolve adminContext`);
    assert.match(text, /isRefusal\(context\)\) return context/, `${path} must stop on refusal`);

    // Capability: through `can()`, never by comparing role strings on the spot.
    assert.match(
      text,
      /requireCapability\(context\.subject, "/,
      `${path} must gate on a named capability`,
    );

    // The Stage 19 rules, restated for the routes that did not exist then.
    assert.doesNotMatch(
      text,
      /maintsupp_demo_organisation/,
      `${path} must not read the organisation cookie itself`,
    );
    assert.doesNotMatch(
      text,
      /workspaceRoleFromRequest/,
      `${path} must use the role the database granted, not the role cookie`,
    );
  }
});

test("the shared admin resolver refuses an organisation the actor is not in", async () => {
  const text = await source("app/api/admin/admin-context.ts");
  assert.match(text, /access\.organisationIds\.includes\(requested\)/);
  assert.match(text, /return organisationDenied\(requested\)/);
  assert.match(text, /scopedDb\(request\)/);
});

test("deactivation never deletes", async () => {
  // Re-pointed: the write moved to `deactivateAccountGuarded`, which carries
  // the last-Owner rule inside the UPDATE. Still a flag, never a DELETE.
  const text = await source("app/api/admin/users/route.ts");
  assert.match(text, /await deactivateAccountGuarded\(await getD1\(\), target\.id\)/);
  const guarded = await source("app/lib/company-owners.ts");
  assert.match(guarded, /SET active = 0,/);
  assert.match(guarded, /status = 'deactivated'/);
  assert.doesNotMatch(guarded, /DELETE FROM users/i);
  assert.doesNotMatch(
    text,
    /\bdelete\(users\)|DELETE FROM users/i,
    "a user row must never be deleted by this route",
  );
  assert.doesNotMatch(
    text,
    /\bdelete\(memberships\)/,
    "deactivation must leave the memberships intact so reactivation restores them",
  );
});

test("the owner console is gated on a capability and still bounded by tenancy", async () => {
  const text = await source("app/api/admin/clients/route.ts");
  assert.match(text, /requireCapability\(context\.subject, "clients\.view_all"\)/);
  // Gate two: the rows are still the actor's own organisation list.
  assert.match(text, /const ids = context\.organisationIds/);
  assert.match(text, /ids\.includes\(item\.id\)/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

async function call(identity, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "x-maintsupp-identity": identity,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const patchUser = (identity, body) =>
  call(identity, "/api/admin/users", { method: "PATCH", body: JSON.stringify(body) });
const putRoles = (identity, body) =>
  call(identity, "/api/admin/roles", { method: "PUT", body: JSON.stringify(body) });

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test("a client is refused by the API, not merely by a hidden button", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  for (const path of ["/api/admin/users", "/api/admin/roles", "/api/admin/clients"]) {
    for (const identity of [SUNNAMUSK_CLIENT, DEMO_CLIENT]) {
      const result = await call(identity, path);
      assert.equal(result.status, 403, `${identity} must be refused ${path}`);
      assert.equal(result.body.denied, true);
      // The refusal names the capability, so an operator can act on it.
      assert.ok(result.body.capability, "the 403 must name the missing capability");
      assert.equal(result.body.role, "client");
    }
  }
});

test("an admin runs their own workspace but not the platform", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const users = await call(SUNNAMUSK_ADMIN, "/api/admin/users");
  assert.equal(users.status, 200);
  assert.equal(users.body.organisation.id, PRIMARY_ORGANISATION_ID);
  assert.ok(users.body.users.length > 0, "the seeded workspace has members");

  /*
   * The permission matrix is Super Admin's since the roles-and-access batch.
   * This asserted 200: an admin could open and rewrite what every role means
   * in their workspace — including handing `manager` any power admin held.
   * `roles.edit` is now reserved (`SUPER_ADMIN_ONLY`), so an admin is refused
   * by the server, with the capability named.
   */
  const roles = await call(SUNNAMUSK_ADMIN, "/api/admin/roles");
  assert.equal(roles.status, 403);
  assert.equal(roles.body.capability, "roles.edit");

  const clients = await call(SUNNAMUSK_ADMIN, "/api/admin/clients");
  assert.equal(clients.status, 403);
  assert.equal(clients.body.capability, "clients.view_all");
});

test("a super admin sees every workspace, with counts from real rows", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const result = await call(SUPER_ADMIN, "/api/admin/clients");
  assert.equal(result.status, 200);
  const ids = result.body.clients.map((client) => client.id).sort();
  assert.deepEqual(ids, [PRIMARY_ORGANISATION_ID, DEMO_ORGANISATION_ID].sort());

  const sunnamusk = result.body.clients.find((c) => c.id === PRIMARY_ORGANISATION_ID);
  const demo = result.body.clients.find((c) => c.id === DEMO_ORGANISATION_ID);

  assert.ok(sunnamusk.jobs > 0, "Sunnamusk still holds its imported jobs");
  assert.ok(sunnamusk.sites > 0);
  assert.ok(demo.users > 0, "the demo tenant does have people");
  for (const client of result.body.clients) {
    assert.equal(typeof client.planTier, "string");
    assert.ok("lastActivityAt" in client);
  }

  /*
   * Every number is counted, not invented. Checked against `/api/context`'s
   * `tenantSummary`, which answers the same two questions from a separate query
   * written by a separate stage — so agreement between them is evidence the
   * console is reading real rows rather than reporting something plausible.
   */
  const context = await call(SUPER_ADMIN, "/api/context");
  const summary = new Map(
    context.body.context.tenantSummary.map((item) => [item.id, item]),
  );
  for (const client of result.body.clients) {
    const independent = summary.get(client.id);
    assert.ok(independent, `${client.name} must appear in both cross-tenant views`);
    assert.equal(client.jobs, independent.maintenanceRequests);
    assert.equal(client.sites, independent.sites);
  }
});

test("naming another workspace is refused rather than quietly ignored", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  for (const path of ["/api/admin/users", "/api/admin/roles"]) {
    const result = await call(
      DEMO_ADMIN,
      `${path}?organisationId=${PRIMARY_ORGANISATION_ID}`,
    );
    assert.equal(result.status, 403, `${path} must refuse a foreign organisationId`);
    assert.equal(result.body.denied, true);
  }

  // …and the same admin's own workspace still answers, so the refusal is about
  // the organisation and not about the route being broken.
  const own = await call(DEMO_ADMIN, "/api/admin/users");
  assert.equal(own.status, 200);
  assert.equal(own.body.organisation.id, DEMO_ORGANISATION_ID);

  // A forged cookie claiming another tenant and a higher role changes nothing.
  const forged = await call(DEMO_ADMIN, "/api/admin/users", {
    headers: {
      Cookie: `maintsupp_demo_organisation=${PRIMARY_ORGANISATION_ID}; maintsupp_demo_role=super_admin`,
    },
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.organisation.id, DEMO_ORGANISATION_ID);
  assert.equal(forged.body.actor.role, "admin");
});

test("GUARD-RAIL: you cannot edit yourself out of your own workspace", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * Re-pointed for the three-level batch. This drove the testing Super Admin
   * against its own membership row; a Platform Super Admin has no membership
   * any more, so it is not on a workspace roster to act on. The live proof is
   * now a member acting on themselves, and the self guards — which a Platform
   * Super Admin holding a membership would still meet — are pinned in source.
   */
  const route = await source("app/api/admin/users/route.ts");
  const roleAction = route.indexOf('if (action === "role") {');
  assert.ok(
    route.indexOf("You cannot change your own role.", roleAction) <
      route.indexOf(".update(memberships)", roleAction),
    "self-promotion is refused before the write",
  );
  assert.ok(
    route.indexOf("You cannot deactivate your own account.") <
      route.indexOf("await deactivateAccountGuarded("),
    "self-deactivation is refused before the write",
  );

  const roleChange = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SUNNAMUSK_ADMIN_ID,
    action: "role",
    role: "client",
    organisationId: PRIMARY_ORGANISATION_ID,
  });
  assert.equal(roleChange.status, 403);
  assert.equal(roleChange.body.denied, true);

  const deactivate = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SUNNAMUSK_ADMIN_ID,
    action: "deactivate",
  });
  assert.equal(deactivate.status, 403);
  assert.equal(deactivate.body.denied, true);
});

test("GUARD-RAIL: an admin cannot act on, or create, a super admin", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * A Platform Super Admin is not a member of the admin's workspace, so the
   * admin cannot even address the account from there: 404, the answer a
   * stranger's id gets. (It was 403 while the Super Admin held a membership
   * row.) Either way nothing is written — checked below.
   */
  const deactivate = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SUPER_ADMIN_ID,
    action: "deactivate",
  });
  assert.ok(
    [403, 404].includes(deactivate.status),
    `an admin must not be able to switch off a super admin (${deactivate.status})`,
  );
  const stillThere = await call(SUPER_ADMIN, "/api/context");
  assert.equal(stillThere.status, 200, "the Super Admin can still work");
  assert.equal(stillThere.body.context.identity.platformAdmin, true);

  const promote = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SUNNAMUSK_ADMIN_ID,
    action: "role",
    role: "super_admin",
    organisationId: PRIMARY_ORGANISATION_ID,
  });
  assert.equal(promote.status, 403, "an admin must not be able to mint a super admin");

  const invite = await call(SUNNAMUSK_ADMIN, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: "escalation@example.com", role: "super_admin" }),
  });
  assert.equal(invite.status, 403, "…nor invite one");
  assert.equal(invite.body.denied, true);
});

test("GUARD-RAIL: the last super admin cannot be demoted or deactivated", async (t) => {
  /*
   * Re-pointed for the three-level batch. This used to build a workspace with
   * exactly one super_admin MEMBERSHIP, demote around it and restore. Super
   * Admin is now platform authority (`platform_admins`), not a membership, so:
   *
   *   - it cannot be DEMOTED through a membership at all: a membership role is
   *     Admin, Manager or Client, and `super_admin` is refused as one;
   *   - the last one cannot be DEACTIVATED: `isLastPlatformAdmin` is asked
   *     before the account is switched off.
   *
   * Reaching "the last one" live would mean deactivating platform staff in a
   * shared database, so that half is pinned in source instead.
   */
  const route = await source("app/api/admin/users/route.ts");
  assert.match(route, /async function isLastPlatformAdmin\(context: AdminContext, targetUserId: string\)/);
  assert.match(route, /\.from\(platformAdmins\)\s*\.innerJoin\(users, eq\(users\.id, platformAdmins\.userId\)\)/);
  assert.ok(
    route.indexOf("if (await isLastPlatformAdmin(context, target.id)) {") > 0 &&
      route.indexOf("if (await isLastPlatformAdmin(context, target.id)) {") <
        route.indexOf("await deactivateAccountGuarded("),
    "the last-Super-Admin question is asked before the account is switched off",
  );
  assert.match(route, /guardRail: "last_super_admin"/);
  assert.match(route, /if \(!isMembershipRole\(role\)\) \{/, "super_admin is not a membership role");

  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const promote = await patchUser(SUPER_ADMIN, {
    userId: SUNNAMUSK_ADMIN_ID,
    action: "role",
    role: "super_admin",
    organisationId: PRIMARY_ORGANISATION_ID,
  });
  // Not even a Super Admin grants Super Admin through a membership: refused.
  assert.equal(promote.status, 403, "Super Admin is not a role a membership can be given");
  assert.equal(promote.body.denied, true);
});

test("GUARD-RAIL: the Super Admin row of the matrix cannot be narrowed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const result = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "super_admin", capability: "roles.edit", allowed: false }],
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.guardRail, "immutable_role");
});

test("GUARD-RAIL: nobody can remove their own role's ability to edit roles", async (t) => {
  /*
   * The rule itself, as a pure function. It still holds and is still written
   * the same way — but since the roles-and-access batch no live caller below
   * Super Admin can reach it, because `roles.edit` is reserved: an admin is
   * refused the matrix outright, and the Super Admin row is immutable.
   */
  const permissions = await import("../app/lib/permissions.ts");
  // Writing the cell at all is refused first — the capability is reserved…
  assert.match(
    String(permissions.roleCapabilityWriteRefusal("admin", "admin", "roles.edit", false)),
    /reserved for Super Admin/,
  );
  // …and a revert (`null`, which deletes a row and so is not a reserved write)
  // still meets the lockout rule, exactly as before.
  assert.match(
    String(permissions.roleCapabilityWriteRefusal("client", "client", "roles.edit", null)),
    /cannot remove your own role's ability/,
    "reverting to a default that denies is still a lockout",
  );

  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // Live: this used to be answered with the self-lockout guard-rail. The
  // stronger answer now is that an admin may not write the matrix at all.
  const direct = await putRoles(SUNNAMUSK_ADMIN, {
    changes: [{ role: "admin", capability: "roles.edit", allowed: false }],
  });
  assert.equal(direct.status, 403);
  assert.equal(direct.body.capability, "roles.edit");

  // And the sideways route this test used to build — granting `client` the
  // matrix so a client could then lock itself out — no longer exists: the
  // grant itself is refused, because the capability is reserved.
  const grant = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "client", capability: "roles.edit", allowed: true }],
  });
  assert.equal(grant.status, 403);
  assert.equal(grant.body.guardRail, "reserved_capability");
  const clientTry = await putRoles(SUNNAMUSK_CLIENT, {
    changes: [{ role: "client", capability: "roles.edit", allowed: null }],
  });
  assert.equal(clientTry.status, 403);
});

test("an invented role or capability is refused", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const badCapability = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "admin", capability: "everything.always", allowed: true }],
  });
  assert.equal(badCapability.status, 400);

  /*
   * `manager` was this test's invented role, then `owner`. Both are real roles
   * now (the roles-and-access and three-level batches), so the invention is
   * `director` — another word somebody might plausibly try to write.
   */
  const badRole = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "director", capability: "board.edit", allowed: true }],
  });
  assert.equal(badRole.status, 400);
});

test("role_capabilities overrides the default, per workspace, and reverts cleanly", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // Before: the built-in default denies a client the roster.
  assert.equal((await call(SUNNAMUSK_CLIENT, "/api/admin/users")).status, 403);

  const grant = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "client", capability: "users.view", allowed: true }],
  });
  assert.equal(grant.status, 200);

  try {
    // After: the same client, the same request, allowed — because a row now
    // exists, not because anything was redeployed.
    assert.equal((await call(SUNNAMUSK_CLIENT, "/api/admin/users")).status, 200);

    // …and the override is scoped to the workspace it was written in. The other
    // tenant's client is untouched.
    assert.equal((await call(DEMO_CLIENT, "/api/admin/users")).status, 403);
  } finally {
    const revert = await putRoles(SUPER_ADMIN, {
      changes: [{ role: "client", capability: "users.view", allowed: null }],
    });
    assert.equal(revert.status, 200);
    // Reverting deletes the row rather than storing a denial, so the matrix
    // reports no override at all for that cell.
    assert.equal(revert.body.overrides.client["users.view"], undefined);
  }

  assert.equal((await call(SUNNAMUSK_CLIENT, "/api/admin/users")).status, 403);
});

test("deactivation is reversible and does not remove the person", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const before = await call(SUNNAMUSK_ADMIN, "/api/admin/users");
  const target = before.body.users.find((user) => user.id === SAMPLE_CLIENT_ID);
  assert.ok(target, "the seeded sample client must be present");

  const off = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SAMPLE_CLIENT_ID,
    action: "deactivate",
  });
  assert.equal(off.status, 200);

  try {
    const during = await call(SUNNAMUSK_ADMIN, "/api/admin/users");
    const stillListed = during.body.users.find((user) => user.id === SAMPLE_CLIENT_ID);
    assert.ok(stillListed, "a deactivated person must still be listed, not deleted");
    assert.equal(stillListed.active, false);
    assert.equal(stillListed.status, "deactivated");
    assert.ok(stillListed.deactivatedAt, "the moment access was suspended is recorded");
    // The membership survives, which is what makes reactivation restore exactly
    // the access that was there before rather than a guess at it.
    assert.equal(stillListed.role, target.role);
  } finally {
    const on = await patchUser(SUNNAMUSK_ADMIN, {
      userId: SAMPLE_CLIENT_ID,
      action: "reactivate",
    });
    assert.equal(on.status, 200);
  }

  const after = await call(SUNNAMUSK_ADMIN, "/api/admin/users");
  const restored = after.body.users.find((user) => user.id === SAMPLE_CLIENT_ID);
  assert.equal(restored.active, true);
  assert.equal(restored.status, "active");
  assert.equal(restored.deactivatedAt, null);
});

test("a user's other workspaces are shown, but only ones the caller may see", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * Re-pointed for the three-level batch. The multi-workspace person was the
   * testing Super Admin, whose membership rows reached both tenants; platform
   * authority is no longer a membership, so that person is on no roster. The
   * test now makes its own: one account invited into both tenants (two
   * companies), accepting the second while signed in. It is deactivated at
   * the end.
   */
  const owner = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!owner.ok) return t.skip("the seeded owner could not sign in");
  const ownerCookie = (owner.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const email = `stage20-two-tenants-${Date.now()}@stage20.test.maintsupp.com`;
  const password = `two tenants ${Date.now()} ok`;
  const invite = async (organisationId) => {
    const response = await fetch(`${BASE_URL}/api/auth/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ email, role: "client", organisationIds: [organisationId] }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).inviteUrl.split("/invite/")[1];
  };
  const first = await fetch(`${BASE_URL}/api/auth/invitations/${await invite(PRIMARY_ORGANISATION_ID)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, fullName: "Stage 20 two tenants" }),
  });
  assert.equal(first.status, 201);
  const personCookie = (first.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const second = await fetch(`${BASE_URL}/api/auth/invitations/${await invite(DEMO_ORGANISATION_ID)}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: personCookie },
    body: JSON.stringify({}),
  });
  assert.equal(second.status, 200);

  try {
    // A Super Admin may read both tenants, and sees both memberships.
    const asSuper = await call(SUPER_ADMIN, "/api/admin/users");
    const superRow = asSuper.body.users.find((user) => user.email === email);
    assert.ok(superRow);
    const seenBySuper = superRow.memberships.map((membership) => membership.organisationId);
    for (const id of [PRIMARY_ORGANISATION_ID, DEMO_ORGANISATION_ID]) {
      assert.ok(
        seenBySuper.includes(id),
        "the multi-workspace membership must be visible to somebody who can see both",
      );
    }

    // The same person seen by an admin of one tenant shows only that tenant —
    // otherwise the admin has learned another client's name from a user row.
    const asAdmin = await call(SUNNAMUSK_ADMIN, "/api/admin/users");
    const seenByAdmin = asAdmin.body.users.find((user) => user.email === email);
    assert.ok(seenByAdmin);
    assert.deepEqual(
      seenByAdmin.memberships.map((membership) => membership.organisationId),
      [PRIMARY_ORGANISATION_ID],
    );
  } finally {
    const row = (await call(SUPER_ADMIN, "/api/admin/users")).body.users.find((user) => user.email === email);
    if (row) {
      await patchUser(SUPER_ADMIN, {
        userId: row.id,
        action: "deactivate",
        organisationId: PRIMARY_ORGANISATION_ID,
      });
    }
  }
});

test("inviting is delegated to the invitation service rather than done here", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const text = await source("app/api/admin/users/route.ts");
  assert.match(text, /new URL\("\/api\/auth\/invitations", request\.url\)/);
  assert.doesNotMatch(
    text,
    /insert\(invitations\)/,
    "this route must never mint an invitation token itself",
  );

  // Live: the request reaches the invitation service and its own answer is
  // passed through. Anything but a 404 proves the delegation arrived; the
  // service's own refusal (it wants a real session, not a test header) is the
  // honest result rather than something this route papers over.
  const result = await call(SUNNAMUSK_ADMIN, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: "delegated@example.com", role: "client" }),
  });
  assert.notEqual(result.status, 404, "the invitation service must have been reached");
  assert.ok(result.status < 500, `unexpected ${result.status} from the invitation service`);
});
