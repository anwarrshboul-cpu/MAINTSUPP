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

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

/* The seeded identities. Every one of these is a real `users` row with a real
   `memberships` row; nothing here invents an account. */
const SUPER_ADMIN = "super-admin@test.maintsupp.com";
const SECOND_SUPER_ADMIN = "superadmin@test.maintsupp.com";
const SUNNAMUSK_ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const SUNNAMUSK_CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
const DEMO_ADMIN = "admin@demo-client-ltd.test.maintsupp.com";
const DEMO_CLIENT = "client@demo-client-ltd.test.maintsupp.com";

const SUPER_ADMIN_ID = "user-super-admin-test-maintsupp-com";
const SECOND_SUPER_ADMIN_ID = "user-superadmin-test-maintsupp-com";
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

  // Exactly the three roles the rest of the system can represent. A fourth here
  // would be a matrix column that no membership row could ever match.
  assert.match(permissions, /ROLES: readonly WorkspaceRole\[\] = \["client", "admin", "super_admin"\]/);
  for (const role of ["super_admin", "admin", "client"]) {
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
});

test("the role list in permissions.ts matches the one tenancy grants", async () => {
  const access = await source("app/lib/tenant-access.ts");
  const permissions = await source("app/lib/permissions.ts");

  // `normaliseRole` in tenant-access.ts is the authority on which membership
  // roles survive. If the two lists drift, the matrix grows a column that can
  // never apply to anybody.
  const granted = [...access.matchAll(/value === "(super_admin|admin|client)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(granted)].sort(),
    ["admin", "client", "super_admin"],
    "tenant-access.ts must still grant exactly these three roles",
  );
  for (const role of granted) {
    assert.match(permissions, new RegExp(`"${role}"`));
  }
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
  const text = await source("app/api/admin/users/route.ts");
  assert.match(text, /set active = 0/);
  assert.match(text, /status = 'deactivated'/);
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

  const roles = await call(SUNNAMUSK_ADMIN, "/api/admin/roles");
  assert.equal(roles.status, 200);

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

  const roleChange = await patchUser(SUPER_ADMIN, {
    userId: SUPER_ADMIN_ID,
    action: "role",
    role: "admin",
    organisationId: PRIMARY_ORGANISATION_ID,
  });
  assert.equal(roleChange.status, 403);
  assert.equal(roleChange.body.denied, true);

  const deactivate = await patchUser(SUPER_ADMIN, {
    userId: SUPER_ADMIN_ID,
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

  const deactivate = await patchUser(SUNNAMUSK_ADMIN, {
    userId: SUPER_ADMIN_ID,
    action: "deactivate",
  });
  assert.equal(deactivate.status, 403, "an admin must not be able to switch off a super admin");

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
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  /*
   * The proof needs a workspace with exactly one super admin. This database is
   * shared with whatever else is being built against it, so the fixture is
   * neither assumed nor left behind: it is *discovered*, adjusted, and every
   * adjustment is undone in reverse in the `finally`.
   *
   * Only the empty second tenant is touched. `SECOND_SUPER_ADMIN` does the
   * demoting because nobody may change their own role, and it is promoted first
   * if something else has since demoted it.
   */
  const undo = [];
  const setRole = async (actor, userId, role) =>
    patchUser(actor, {
      userId,
      action: "role",
      role,
      organisationId: DEMO_ORGANISATION_ID,
    });

  const readSuperAdmins = async () => {
    const roster = await call(
      SUPER_ADMIN,
      `/api/admin/users?organisationId=${DEMO_ORGANISATION_ID}`,
    );
    assert.equal(roster.status, 200);
    return roster.body.users.filter((user) => user.role === "super_admin");
  };

  try {
    // Make sure the account that will be "the last one" actually holds the role.
    let superAdmins = await readSuperAdmins();
    if (!superAdmins.some((user) => user.id === SECOND_SUPER_ADMIN_ID)) {
      const promote = await setRole(SUPER_ADMIN, SECOND_SUPER_ADMIN_ID, "super_admin");
      assert.equal(promote.status, 200);
      undo.push([SUPER_ADMIN, SECOND_SUPER_ADMIN_ID, "admin"]);
      superAdmins = await readSuperAdmins();
    }

    for (const user of superAdmins) {
      if (user.id === SECOND_SUPER_ADMIN_ID) continue;
      const step = await setRole(SECOND_SUPER_ADMIN, user.id, "admin");
      assert.equal(step.status, 200, `demoting ${user.email} while others remain is allowed`);
      undo.push([SECOND_SUPER_ADMIN, user.id, "super_admin"]);
    }

    // One super admin left in this workspace. Now it must be immovable.
    const demote = await setRole(SUPER_ADMIN, SECOND_SUPER_ADMIN_ID, "admin");
    assert.equal(demote.status, 409);
    assert.equal(demote.body.guardRail, "last_super_admin");

    // Deactivation reaches every workspace this person belongs to, so it is
    // refused for the same reason even though the request names no organisation.
    const deactivate = await patchUser(SUPER_ADMIN, {
      userId: SECOND_SUPER_ADMIN_ID,
      action: "deactivate",
    });
    assert.equal(deactivate.status, 409);
    assert.equal(deactivate.body.guardRail, "last_super_admin");
  } finally {
    // Reverse order, so the promotions that made the demotions legal are undone
    // last — otherwise the restore would trip the very guard-rail under test.
    for (const [actor, userId, role] of undo.reverse()) {
      const restore = await setRole(actor, userId, role);
      assert.equal(restore.status, 200, "the fixture must be put back");
    }
  }
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
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const direct = await putRoles(SUNNAMUSK_ADMIN, {
    changes: [{ role: "admin", capability: "roles.edit", allowed: false }],
  });
  assert.equal(direct.status, 403);
  assert.equal(direct.body.guardRail, "self_lockout");

  // The same rule has to hold for the sideways route out: reverting the cell to
  // a built-in default that happens to deny is still a lockout.
  const grant = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "client", capability: "roles.edit", allowed: true }],
  });
  assert.equal(grant.status, 200);
  try {
    const revert = await putRoles(SUNNAMUSK_CLIENT, {
      changes: [{ role: "client", capability: "roles.edit", allowed: null }],
    });
    assert.equal(revert.status, 403);
    assert.equal(revert.body.guardRail, "self_lockout");
  } finally {
    const restore = await putRoles(SUPER_ADMIN, {
      changes: [{ role: "client", capability: "roles.edit", allowed: null }],
    });
    assert.equal(restore.status, 200);
  }
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

  const badRole = await putRoles(SUPER_ADMIN, {
    changes: [{ role: "manager", capability: "board.edit", allowed: true }],
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

  // The super admin belongs to both tenants, and a super admin may read both.
  const asSuper = await call(SUPER_ADMIN, "/api/admin/users");
  const superRow = asSuper.body.users.find((user) => user.id === SUPER_ADMIN_ID);
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
  const seenByAdmin = asAdmin.body.users.find((user) => user.id === SUPER_ADMIN_ID);
  assert.ok(seenByAdmin);
  assert.deepEqual(
    seenByAdmin.memberships.map((membership) => membership.organisationId),
    [PRIMARY_ORGANISATION_ID],
  );
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
