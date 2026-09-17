/**
 * Users, invitations, workspace access and RBAC — the roles-and-access batch.
 *
 * What this batch changed, and what this file holds in place:
 *
 *   1. A fourth role, `manager`, between Admin and Client, defined once in
 *      `app/lib/roles.ts` and given the least operational capability set.
 *   2. Capabilities reserved for Super Admin (`clients.view_all`, `roles.edit`,
 *      `navigation.edit`) that no override row can grant to anybody else.
 *   3. The acting role is the role held in the SELECTED workspace. It used to
 *      be the strongest role held anywhere, which let an Admin of one client
 *      act as an Admin inside another client where they were only a Client.
 *   4. Account-wide changes (password reset, deactivation, profile) need the
 *      caller to administer every workspace the account belongs to.
 *   5. Invitations CAN be emailed from `MAINTSUPP <admin@maintsupp.com>`
 *      through the existing Resend path, but that is switched OFF unless
 *      `INVITATION_EMAIL_MODE=live` — real delivery is a deferred follow-up.
 *      The invitation is created first, the link is always returned, and
 *      `delivery` says what happened. A duplicate invite is refused (409);
 *      resending is explicit.
 *   6. The invitation page's password fields can be revealed, without the
 *      password ever being written into the DOM as an attribute.
 *   7. The sidebar, the workspace switcher and the admin navigation show a
 *      non-Super-Admin only what they can use.
 *   8. The owner's assignment table: a Super Admin assigns any role, an Admin
 *      assigns only Manager and Client (and acts on no Admin), a Manager and a
 *      Client assign nothing. A Manager has a hard capability ceiling.
 *   9. The workspace sidebar is Super Admin's; everyone may arrange their OWN
 *      sidebar, which never touches the workspace default.
 *  10. Since the three-level batch, a fifth role — the client company's Owner —
 *      sits between Admin and Super Admin, and Super Admin is platform
 *      authority rather than a membership. `tests/client-companies.test.mjs`
 *      holds that model; the pins below were re-pointed where it moved them.
 *
 * Three halves: behaviour of the pure modules (imported directly), the shape
 * of the decisions a passing request cannot show, and the real lifecycle
 * against a running dev server — which skips, rather than fails, when nothing
 * answers. The live half only ever creates `@rbac.test.maintsupp.com`
 * accounts in the local database, invites them, and deactivates them again.
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
const PRIMARY = "org_000000000000000000000001";
const DEMO = "org_000000000000000000000002";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const roles = await import("../app/lib/roles.ts");
const permissions = await import("../app/lib/permissions.ts");

/* ================================================================== */
/* 1. The role hierarchy                                               */
/* ================================================================== */

test("the hierarchy is Super Admin > Owner > Admin > Manager > Client, defined once", () => {
  // Re-pointed for the three-level model: Owner (the client company's) sits
  // between Admin and the platform's Super Admin.
  assert.deepEqual([...roles.ROLES], ["client", "manager", "admin", "owner", "super_admin"]);
  const ranks = roles.ROLES.map((role) => roles.ROLE_RANK[role]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "ROLES is weakest first");
  assert.equal(new Set(ranks).size, 5, "no two roles share a rank");
  assert.equal(roles.ROLE_LABELS.manager, "Manager");
  assert.equal(roles.roleLabel("nonsense"), "Client", "an unknown value reads as the weakest");
});

test("a role picker offers exactly the roles the caller may grant", () => {
  // The owner's table, as the three-level batch left it: a Super Admin
  // appoints Owners and every workspace role but never another Super Admin
  // (platform authority is not handed out through these flows); an Owner
  // assigns Admin, Manager and Client.
  assert.deepEqual(roles.assignableRoles("super_admin"), ["client", "manager", "admin", "owner"]);
  assert.deepEqual(roles.assignableRoles("owner"), ["client", "manager", "admin"]);
  assert.deepEqual(roles.assignableRoles("admin"), ["client", "manager"]);
  assert.deepEqual(roles.assignableRoles("manager"), [], "a Manager assigns nothing");
  assert.deepEqual(roles.assignableRoles("client"), [], "a Client assigns nothing");
  assert.deepEqual(roles.assignableRoles("director"), [], "an unknown role grants nothing");
  assert.deepEqual(roles.assignableRoles(null), []);

  for (const target of ["admin", "manager", "client"]) {
    assert.equal(roles.canAssignRole("super_admin", target), true, `Super Admin → ${target}`);
  }
  assert.equal(roles.canAssignRole("admin", "manager"), true);
  assert.equal(roles.canAssignRole("admin", "client"), true);
  assert.equal(roles.canAssignRole("admin", "admin"), false, "an Admin may not assign Admin");
  assert.equal(roles.canAssignRole("admin", "super_admin"), false);
  for (const actor of ["manager", "client"]) {
    for (const target of roles.ROLES) {
      assert.equal(roles.canAssignRole(actor, target), false, `${actor} → ${target}`);
    }
  }

  // Acting on an account follows the same table: an Admin manages Managers and
  // Clients, never another Admin or a Super Admin.
  assert.equal(roles.canManageRole("admin", "manager"), true);
  assert.equal(roles.canManageRole("admin", "client"), true);
  assert.equal(roles.canManageRole("admin", "admin"), false);
  assert.equal(roles.canManageRole("admin", "super_admin"), false);
  assert.equal(roles.canManageRole("super_admin", "admin"), true);
  assert.equal(roles.canManageRole("manager", "client"), false);
  assert.equal(roles.withArticle("admin"), "an Admin");
  assert.equal(roles.withArticle("manager"), "a Manager");
});

/* ================================================================== */
/* 2. The permission matrix                                            */
/* ================================================================== */

/**
 * The shipped matrix, stated in full. A change to any cell is a product
 * decision and should fail here, where it is visible, rather than in a screen.
 */
const EXPECTED = {
  super_admin: "*",
  admin: [
    "board.view",
    "board.edit",
    "sites.edit",
    "data.import",
    "data.export",
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "teams.manage",
    "audit.read",
    "settings.edit",
    "navigation.personalise",
  ],
  manager: ["board.view", "board.edit", "sites.edit", "data.export", "navigation.personalise"],
  client: ["board.view", "data.export", "navigation.personalise"],
};
// An Owner holds exactly the Admin set; their extra authority is SCOPE (every
// workspace of their company), not extra capabilities.
EXPECTED.owner = EXPECTED.admin;

test("each role's built-in capabilities are exactly the documented set", () => {
  for (const role of roles.ROLES) {
    const effective = permissions.effectiveCapabilities(role, {});
    const granted = Object.keys(effective).filter((key) => effective[key]).sort();
    const expected = EXPECTED[role] === "*" ? [...permissions.CAPABILITIES].sort() : [...EXPECTED[role]].sort();
    assert.deepEqual(granted, expected, `${role}'s effective capabilities`);
  }
});

test("reserved capabilities cannot be held below Super Admin, whatever a row says", () => {
  for (const capability of ["clients.view_all", "roles.edit", "navigation.edit"]) {
    assert.equal(permissions.isReservedCapability(capability), true);
    for (const role of ["owner", "admin", "manager", "client"]) {
      assert.equal(
        permissions.can({ role, capabilities: { [capability]: true } }, capability),
        false,
        `an override row must not give ${role} ${capability}`,
      );
    }
    assert.equal(permissions.can({ role: "super_admin", capabilities: {} }, capability), true);
  }
});

test("the matrix refuses to store a reserved capability for any other role", () => {
  for (const target of ["owner", "admin", "manager", "client"]) {
    for (const allowed of [true, false]) {
      assert.match(
        String(permissions.roleCapabilityWriteRefusal("super_admin", target, "navigation.edit", allowed)),
        /reserved for Super Admin/,
      );
    }
    // Deleting a stale row is allowed — that is how one is cleaned out.
    assert.equal(
      permissions.roleCapabilityWriteRefusal("super_admin", target, "clients.view_all", null),
      null,
    );
  }
  // A Super Admin may still widen a client per workspace (no ceiling there),
  // but not past the manager ceiling — see the next test.
  assert.equal(permissions.roleCapabilityWriteRefusal("super_admin", "client", "users.invite", true), null);
  assert.ok(permissions.roleCapabilityWriteRefusal("super_admin", "manager", "users.invite", true));
  // …and the Super Admin row itself stays immutable.
  assert.ok(permissions.roleCapabilityWriteRefusal("super_admin", "super_admin", "board.view", false));
});

test("a manager's ceiling holds whatever the matrix says", () => {
  const ceiling = [
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "teams.manage",
    "settings.edit",
    "data.import",
    "audit.read",
    "billing.manage",
    "roles.edit",
    "navigation.edit",
    "clients.view_all",
  ];
  const grantedAll = Object.fromEntries(ceiling.map((key) => [key, true]));
  const effective = permissions.effectiveCapabilities("manager", grantedAll);
  for (const capability of ceiling) {
    assert.equal(effective[capability], false, `an override must not give a manager ${capability}`);
    assert.ok(
      permissions.roleCapabilityWriteRefusal("super_admin", "manager", capability, true),
      `the matrix refuses to store ${capability} for manager`,
    );
  }
  // …while the operational set can still be narrowed per workspace.
  assert.equal(permissions.roleCapabilityWriteRefusal("super_admin", "manager", "board.edit", false), null);
  // A client has no ceiling beyond the reservations — the product has always
  // let a Super Admin widen a client per workspace.
  assert.equal(permissions.can({ role: "client", capabilities: { "users.view": true } }, "users.view"), true);
});

test("a manager holds no administrative security capability", () => {
  const manager = permissions.effectiveCapabilities("manager", {});
  for (const capability of [
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "roles.edit",
    "settings.edit",
    "clients.view_all",
    "navigation.edit",
    "audit.read",
    "billing.manage",
    "data.delete",
  ]) {
    assert.equal(manager[capability], false, `manager must not hold ${capability}`);
  }
});

/* ================================================================== */
/* 3. Invitation email                                                 */
/* ================================================================== */

const notifications = await import("../app/lib/notifications.ts");

test("invitations are sent as MAINTSUPP <admin@maintsupp.com>, replies to the same inbox", () => {
  assert.equal(notifications.INVITATION_SENDER, "MAINTSUPP <admin@maintsupp.com>");
  assert.equal(notifications.INVITATION_REPLY_TO, "admin@maintsupp.com");
});

test("invitation email is OFF unless INVITATION_EMAIL_MODE is exactly live", async () => {
  const saved = process.env.INVITATION_EMAIL_MODE;
  try {
    for (const value of [undefined, "", "off", "sink", "log", "true", "1", "LIVE-ish"]) {
      if (value === undefined) delete process.env.INVITATION_EMAIL_MODE;
      else process.env.INVITATION_EMAIL_MODE = value;
      assert.equal(notifications.invitationEmailEnabled(), false, `"${value}" must not switch it on`);
    }
    process.env.INVITATION_EMAIL_MODE = " Live ";
    assert.equal(notifications.invitationEmailEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.INVITATION_EMAIL_MODE;
    else process.env.INVITATION_EMAIL_MODE = saved;
  }

  // And the route checks it BEFORE the mail path is reached at all.
  const route = await read("app/api/auth/invitations/route.ts");
  const deliver = route.slice(route.indexOf("async function deliverInvitation"));
  const gate = deliver.indexOf("if (!invitationEmailEnabled()) {");
  const send = deliver.indexOf("sendNotification(");
  assert.ok(gate > 0 && send > gate, "switched off, nothing is attempted");
  assert.match(deliver.slice(gate, send), /status: "disabled"/);
});

test("the invitation email says who, where, what role and until when — and nothing secret", () => {
  const url = "https://maintsupp.com/invite/" + "a".repeat(64);
  const email = notifications.invitationEmailTemplate({
    workspaceName: 'Acme <script>alert("x")</script> Ltd',
    roleLabel: "Manager",
    inviterName: "Jo <b>Bloggs</b>",
    inviteUrl: url,
    expiresAt: "2026-09-23T10:00:00.000Z",
    message: "Welcome <img src=x onerror=alert(1)>",
  });

  // Branding, workspace, role, expiry and the call to action.
  assert.match(email.body, /MAINT<\/span><span[^>]*>SUPP/);
  assert.match(email.body, /Acme &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; Ltd/);
  assert.match(email.body, />Manager</);
  assert.match(email.body, /23 Sept 2026/);
  assert.match(email.body, />Accept invitation<\/a>/);
  assert.match(email.text, /Your role: Manager/);
  assert.match(email.text, /Link expires: 23 Sept 2026/);

  // Everything typed by a person is escaped.
  assert.doesNotMatch(email.body, /<script>|<img |<b>Bloggs/);
  assert.match(email.body, /Jo &lt;b&gt;Bloggs&lt;\/b&gt;/);

  // The link appears exactly where it must — the button and the fallback —
  // and nowhere else. It is never in the subject, which is logged.
  assert.equal(email.body.split(url).length - 1, 2);
  assert.equal(email.text.split(url).length - 1, 1);
  assert.doesNotMatch(email.subject, /invite\/|a{16}/);
  assert.match(email.subject, /invited to join Acme/);

  // No password, no internal ids.
  assert.doesNotMatch(email.body + email.text, /password:|password_hash|org_|user-|inv_/i);
});

/** A stand-in for the drizzle handle `sendNotification` writes its log through. */
function fakeDb() {
  const inserted = [];
  const updated = [];
  return {
    inserted,
    updated,
    insert: () => ({ values: async (row) => void inserted.push(row) }),
    update: () => ({ set: (row) => ({ where: async () => void updated.push(row) }) }),
  };
}

async function withEmailEnv(env, run) {
  const saved = {
    EMAIL_MODE: process.env.EMAIL_MODE,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    fetch: globalThis.fetch,
  };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const key of ["EMAIL_MODE", "RESEND_API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = saved.fetch;
  }
}

const invitationRequest = () => ({
  organisationId: DEMO,
  channel: "email",
  event: "user.invited",
  subjectType: "invitation",
  subjectId: "inv_test",
  to: "new.client@example.com",
  from: notifications.INVITATION_SENDER,
  replyTo: notifications.INVITATION_REPLY_TO,
  subject: "You're invited to join Demo on MAINTSUPP",
  body: "<p>link</p>",
  text: "link",
});

test("a live send goes once, from admin@, to the invitee, and the log keeps no body", async () => {
  await withEmailEnv({ EMAIL_MODE: "live", RESEND_API_KEY: "test-only-not-a-key" }, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "provider-1" }), { status: 200 });
    };
    const db = fakeDb();
    const result = await notifications.sendNotification(db, invitationRequest());

    assert.equal(result.status, "sent");
    assert.equal(calls.length, 1, "exactly one provider call");
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].body.from, "MAINTSUPP <admin@maintsupp.com>");
    assert.deepEqual(calls[0].body.reply_to, ["admin@maintsupp.com"]);
    assert.deepEqual(calls[0].body.to, ["new.client@example.com"]);

    // The log row names the recipient and subject, and carries no body.
    assert.equal(db.inserted[0].recipient, "new.client@example.com");
    assert.equal(db.inserted[0].subjectType, "invitation");
    assert.equal("body" in db.inserted[0], false);
    assert.equal(db.updated[0].status, "sent");
  });
});

test("a provider failure is recorded as failed and never throws", async () => {
  await withEmailEnv({ EMAIL_MODE: "live", RESEND_API_KEY: "test-only-not-a-key" }, async () => {
    globalThis.fetch = async () => new Response("domain not verified", { status: 403 });
    const db = fakeDb();
    const result = await notifications.sendNotification(db, invitationRequest());
    assert.equal(result.status, "failed");
    assert.equal(result.ok, false);
    assert.equal(db.updated[0].status, "failed");

    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    const offline = await notifications.sendNotification(fakeDb(), invitationRequest());
    assert.equal(offline.status, "failed");
  });
});

test("sink, log and an absent key never reach the invitee", async () => {
  await withEmailEnv({ EMAIL_MODE: "sink", RESEND_API_KEY: "test-only-not-a-key" }, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    };
    await notifications.sendNotification(fakeDb(), invitationRequest());
    assert.equal(calls.length, 1);
    assert.notDeepEqual(calls[0].to, ["new.client@example.com"], "sink redirects the address");
    assert.match(calls[0].subject, /^\[SINK\]/);
  });

  await withEmailEnv({ EMAIL_MODE: "log", RESEND_API_KEY: "test-only-not-a-key" }, async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}");
    };
    const result = await notifications.sendNotification(fakeDb(), invitationRequest());
    assert.equal(result.status, "suppressed");
    assert.equal(called, false);
  });

  await withEmailEnv({ EMAIL_MODE: "live", RESEND_API_KEY: undefined }, async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}");
    };
    const result = await notifications.sendNotification(fakeDb(), invitationRequest());
    assert.equal(result.status, "skipped");
    assert.equal(called, false);
  });
});

test("a failed invitation email is not replayed with a body that has no link", async () => {
  const source = await read("app/lib/notifications.ts");
  const replay = source.slice(source.indexOf("export async function replayFailed"));
  assert.match(replay, /\$\{notificationLog\.subjectType\} <> 'invitation'/);
});

/* ================================================================== */
/* 4. The shape of the server decisions                                */
/* ================================================================== */

test("the invitation service: capability in the target workspace, one live invite, email second", async () => {
  const route = await read("app/api/auth/invitations/route.ts");
  const at = (needle) => {
    const index = route.indexOf(needle);
    assert.ok(index > 0, `missing: ${needle}`);
    return index;
  };

  assert.ok(
    at('if (!can(subject, "users.invite"))') < at("const invitation = await createInvitation("),
    "the capability is checked before anything is written",
  );
  assert.ok(
    at("if (outstanding && !resend)") < at("const invitation = await createInvitation("),
    "a duplicate is refused before a second link is minted",
  );
  assert.ok(
    at("const invitation = await createInvitation(") < at("const delivery = await deliverInvitation("),
    "the invitation exists before the email is attempted",
  );
  // Re-pointed: a resend now repeats the role AND the workspace set, and the
  // assignment table is asked with the role held in EACH target workspace.
  assert.match(route, /if \(outstanding\.role !== role \|\| !sameWorkspaces\) \{/, "a resend cannot change the role");
  assert.match(route, /if \(!canAssignRole\(actingRole, role\)\) \{/, "the owner's assignment table decides");
  assert.match(route, /const inviteUrl = publicUrl\(request, `\/invite\/\$\{token\}`\);/);
  assert.match(route, /inviteUrl,\s*delivery,/, "the link is returned whatever happened to the email");

  // The audit line records who and what — never the token or the link.
  const audit = route.slice(at("await recordAudit({"), at("const inviteUrl"));
  assert.doesNotMatch(audit, /token|inviteUrl/);
  // The provider's error text is not returned to the screen.
  assert.doesNotMatch(route.slice(at("async function deliverInvitation")), /result\.error/);
});

test("accepting an invitation takes the role and workspace from the row, and lands you there", async () => {
  const accept = await read("app/api/auth/invitations/[token]/route.ts");
  // Re-pointed: what the row grants (role, company, workspaces, landing) is
  // read by `invitationGrant`, from the database, before the token is used.
  assert.match(accept, /const grant = await invitationGrant\(d1, invitation\);/);
  assert.match(accept, /const role = grant\.role;/);
  assert.doesNotMatch(accept, /payload\.(role|organisationId|organisation|workspace|company)/, "nothing in the body decides access");
  assert.match(accept, /WHERE id = \? AND accepted_at IS NULL AND revoked_at IS NULL/, "single use");
  assert.match(accept, /`\$\{ORGANISATION_COOKIE\}=\$\{encodeURIComponent\(landingId\)\}; `/);
  assert.equal((accept.match(/response\.headers\.append\("Set-Cookie", workspaceCookie\)/g) ?? []).length, 2);
});

test("the acting role is the role in the selected workspace", async () => {
  // Re-pointed: the per-workspace question moved to the pure `access-scope.ts`,
  // which tenant-access.ts re-exports.
  const resolver = await read("app/lib/tenant-access.ts");
  assert.match(resolver, /export \{ administersCompany, companyOfOrganisation, roleInOrganisation \} from "\.\/access-scope";/);
  const access = await read("app/lib/access-scope.ts");
  assert.match(access, /export function roleInOrganisation\(/);
  // Re-pointed: platform authority is `platformAdmin`, not a membership.
  assert.match(access, /if \(access\.platformAdmin\) return "super_admin";/);
  assert.match(access, /if \(grant\) return grant\.role;/);
  const admin = await read("app/api/admin/admin-context.ts");
  assert.match(admin, /grantedRoleIn\(access, targetOrganisationId\)/);
});

test("account-wide changes are refused unless the caller administers every workspace involved", async () => {
  const context = await read("app/api/admin/admin-context.ts");
  assert.match(context, /export async function accountWideRefusal\(/);
  // Re-pointed: a Platform Super Admin, and now also a company Owner, is only
  // changed by a Super Admin.
  assert.match(context, /if \(standing\.platformAdmin\) \{/);
  assert.match(context, /if \(standing\.ownedCompanyIds\.length\) \{/);
  assert.match(context, /guardRail: "other_workspace"/);

  const users = await read("app/api/admin/users/route.ts");
  assert.match(users, /accountWideRefusal\(context, target\.id, "users\.edit"\)/, "profile");
  assert.match(users, /accountWideRefusal\(context, target\.id, "users\.deactivate"\)/, "deactivation");
  assert.match(users, /const targetRole = await effectiveTargetRole\(context, target\.id, target\.role\);/);

  const reset = await read("app/api/admin/users/password-reset/route.ts");
  assert.match(reset, /accountWideRefusal\(context, target\.id, "users\.edit"\)/);
  assert.match(reset, /const targetRole = await effectiveTargetRole\(context, target\.id, target\.role\);/);
});

test("switching workspace is open to members, creating one is not", async () => {
  const route = await read("app/api/context/route.ts");
  const select = route.indexOf('if (action === "select_organisation")');
  const create = route.indexOf('if (action === "create_organisation")');
  assert.ok(select > 0 && create > select, "select, then create");
  // Re-pointed: creating is gated INSIDE create — a Platform Super Admin, or an
  // Owner of the company it goes into — rather than by a rank gate before it.
  const gate = route.indexOf("if (context.platformAdmin) {", create);
  const ownerGate = route.indexOf("!context.ownedCompanyIds.includes(companyId)", create);
  const write = route.indexOf("await createWorkspace(", create);
  assert.ok(gate > create && ownerGate > gate && write > ownerGate, "the gate comes before the write");
  assert.match(route, /Only a Super Admin or the company's Owner can create workspaces\./);
  assert.match(route, /!context\.organisationIds\.includes\(organisation\.id\)/);
});

test("finance stays internal: managers are refused along with clients", async () => {
  const access = await read("app/lib/finance/access.ts");
  assert.match(access, /if \(ROLE_RANK\[guard\.scope\.actor\.role\] < ROLE_RANK\.admin\) \{/);
});

/* ================================================================== */
/* 5. The screens                                                      */
/* ================================================================== */

test("the invitation page can reveal a password without writing it into the DOM", async () => {
  const field = await read("app/(public)/invite/[token]/password-input.tsx");
  const form = await read("app/(public)/invite/[token]/accept-invite-form.tsx");

  assert.match(field, /type=\{shown \? "text" : "password"\}/);
  assert.match(field, /aria-label=\{`\$\{shown \? "Hide" : "Show"\} \$\{revealLabel\}`\}/);
  assert.match(field, /<button\s+type="button"/, "the control never submits the form");
  assert.match(field, /aria-controls=\{id\}/);
  assert.match(field, /autoComplete="new-password"/);
  assert.match(field, /defaultValue=""/, "uncontrolled: no value attribute mirrors the password");
  assert.doesNotMatch(field, /\bvalue=\{/);
  assert.match(field, /aria-hidden="true"/, "the icons are decoration");

  assert.match(form, /revealLabel="password"/);
  assert.match(form, /revealLabel="password confirmation"/);
  assert.doesNotMatch(form, /useState\(""\);\s*const \[confirm/, "passwords are not held in state");
  assert.doesNotMatch(form, /value=\{password\}|value=\{confirm\}/);
  assert.match(form, /passwordRef\.current\?\.value/);
  assert.match(form, /password !== confirm/, "mismatch is still caught before sending");
  assert.match(
    form,
    /setShown\(\{ password: false, confirm: false \}\);\s*setPending\(true\);/,
    "both fields are hidden again before anything is sent",
  );
  assert.doesNotMatch(form, /console\.|localStorage|sessionStorage|searchParams/);

  const css = await read("app/(public)/invite/[token]/invite.css");
  assert.match(css, /\.invite__reveal:focus-visible/);
  assert.match(css, /::-ms-reveal/);
});

test("the Users screen offers only assignable roles and no controls over people who outrank you", async () => {
  const view = await read("app/(app)/portal/views/admin-users.tsx");
  assert.match(view, /\(data\?\.roles \?\? \[\]\)\.filter\(\(role\) => role\.assignable\)/);
  // Re-pointed: a membership's role picker offers the assignable WORKSPACE
  // roles (Owner and Super Admin are not membership roles).
  assert.match(view, /const workspaceRoles = assignable\.filter\(/);
  assert.match(view, /\{workspaceRoles\.map\(\(role\) => \(/);
  assert.doesNotMatch(view, /disabled=\{!role\.assignable\}/, "unassignable roles are not listed at all");
  assert.match(view, /user\.manageable !== false/);
  assert.match(view, /invitationId: invitation\.id/);
  assert.match(
    view,
    /\{invitation\.manageable \?\? assignable\.some\(\(role\) => role\.key === invitation\.role\) \? \(\s*<span className="admin-actions">/,
    "resend and withdraw are offered only for invitations the caller could issue",
  );
  assert.doesNotMatch(view, /\{invitation\.role\}\s*<\/span>/, "the pending table shows a label, not the raw key");

  const route = await read("app/api/admin/users/route.ts");
  assert.match(route, /manageable: canManageRole\(context\.actor\.role, effectiveRole\)/);
  assert.match(
    route,
    /!canManageRole\(context\.actor\.role, targetRole\) &&\s*!\(isSelf && action === "profile"\)/,
    "PATCH refuses acting on a role the caller may not manage",
  );
  assert.match(view, /\{can\("users\.invite"\) && assignable\.length > 0 \? \(/);
  assert.match(route, /const administrable = await administrableOrganisations\(context\);/);
  assert.match(route, /organisations: administrable\.map\(/);
  assert.match(route, /invitedBy: row\.invitedBy \? \(inviters\.get\(row\.invitedBy\) \?\? null\) : null/);
  // Re-pointed: withdrawing is the power to issue, asked in every workspace
  // the invitation grants (`mayGrantIn`), before anything is written.
  const withdraw = route.slice(route.indexOf("export async function DELETE"));
  assert.ok(
    withdraw.indexOf("await mayGrantIn(") > 0 &&
      withdraw.indexOf("await mayGrantIn(") < withdraw.indexOf(".set({ revokedAt:"),
    "withdrawing is refused above the caller's authority, before anything is written",
  );
});

test("the sidebar shows a non-Super-Admin only their own workspaces and no menu administration", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /const isSuperAdmin = runtimeContext\?\.actor\.role === "super_admin";/);
  assert.match(portal, /const canSwitchWorkspace = isSuperAdmin \|\| switchableOrganisations\.length > 1;/);
  // Re-pointed: the add button is for a Super Admin, or an Owner adding to
  // their own company — never for anybody else.
  assert.match(portal, /const canAddWorkspace = isSuperAdmin \|\| \(ownsCurrentCompany && Boolean\(currentCompany\)\);/);
  assert.match(portal, /\{canAddWorkspace && \(\s*<button\s+className="workspace-switcher__add"/);
  assert.match(portal, /\{isSuperAdmin && runtimeContext\?\.tenantSummary/);
  assert.doesNotMatch(portal, /demoRole === "super_admin"/, "the testing selector decides nothing");
  for (const [key, capability] of [
    ["admin-users", "users.view"],
    ["admin-roles", "roles.edit"],
    ["admin-clients", "clients.view_all"],
  ]) {
    assert.match(
      portal,
      new RegExp(
        `entry\\.key === "${key}"\\) \\{\\s*return runtimeContext\\?\\.capabilities\\?\\.\\["${capability.replace(".", "\\.")}"\\] === true;`,
      ),
      `${key} is listed only with ${capability}`,
    );
  }

  // The finance screen refuses every role below Admin, so it is not listed for them.
  assert.match(
    portal,
    /entry\.key === "invoice-tracker"\) \{[\s\S]{0,500}ROLE_RANK\[runtimeContext\.actor\.role\] >= ROLE_RANK\.admin/,
  );

  const nav = await read("app/(app)/portal/sidebar-nav.tsx");
  assert.match(nav, /const \[canCustomise, setCanCustomise\] = useState\(false\);/);
  assert.match(nav, /\{\(canCustomise \|\| editing\) && \(/);
  assert.match(nav, /\{onManageSections && canEditDefault && \(/, "sections are not offered to a personal arrangement");

  const navRoute = await read("app/api/navigation/route.ts");
  assert.match(navRoute, /editDefault: can\(subject, "navigation\.edit"\)/);
  assert.match(navRoute, /personalise: can\(subject, "navigation\.personalise"\)/);
  assert.match(navRoute, /if \(scope === "workspace" && !\(await mayEditDefault\(context\)\)\)/);

  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /item\.key !== "admin" \|\| canAdminister === true/);

  const explore = await read("app/(app)/portal/views/account-explore.tsx");
  // Re-pointed: Owner is appointed to a company, not from this form.
  assert.match(explore, /const roles = assignableRoles\(snapshot\.role\)\.filter\(\(entry\) => entry !== "owner"\);/);
  assert.doesNotMatch(explore, /<option value="super_admin">/);

  const modal = await read("app/(app)/portal/board-actions/invite-modal.tsx");
  assert.match(modal, /organisationId: payload\?\.organisation\.id/, "the dialog names the workspace it shows");
});

/* ================================================================== */
/* 6. Live: the lifecycle, isolation and escalation                    */
/* ================================================================== */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** A tiny cookie jar: later Set-Cookie headers replace earlier ones by name. */
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

const live = await serverIsUp();
const STAMP = `${Date.now()}`;
const PASSWORD = `rbac fixture ${STAMP} ok`;
const created = [];
let ownerCookie = null;

async function owner() {
  if (ownerCookie) return ownerCookie;
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!response.ok) return null;
  ownerCookie = mergeCookies("", response);
  return ownerCookie;
}

const tokenOf = (url) => String(url).split("/invite/")[1];

/** Invite as the owner, accept as the invitee; returns the invitee's cookie. */
async function onboard(role, organisationId, label) {
  const cookie = await owner();
  const email = `rbac-${label}-${STAMP}@rbac.test.maintsupp.com`;
  const invited = await api(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role, organisationId }),
  });
  assert.equal(invited.status, 201, invited.text);
  created.push(email);
  const token = tokenOf(invited.body.inviteUrl);

  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, fullName: `RBAC ${label}` }),
  });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 201, JSON.stringify(acceptedBody));
  return { email, token, invited, accepted: acceptedBody, cookie: mergeCookies("", accepted) };
}

let fixtures = null;
async function world() {
  if (fixtures) return fixtures;
  const client = await onboard("client", DEMO, "client");
  const manager = await onboard("manager", DEMO, "manager");
  const admin = await onboard("admin", DEMO, "admin");
  fixtures = { client, manager, admin };
  return fixtures;
}

after(async () => {
  if (!live || !created.length || !ownerCookie) return;
  // Deactivate every account this run created. Never deleted — the product
  // does not delete people — but switched off, in the workspace they joined.
  const roster = await api(ownerCookie, `/api/admin/users?organisationId=${DEMO}`);
  for (const user of roster.body?.users ?? []) {
    if (!created.includes(user.email) || !user.active) continue;
    await api(ownerCookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: user.id, action: "deactivate", organisationId: DEMO }),
    });
  }
});

test("live: client, manager and admin invitations each land in the invited workspace and nowhere else", { skip: !live }, async (t) => {
  if (!(await owner())) return t.skip("the seeded owner could not sign in");
  const { client, manager, admin } = await world();

  for (const [role, person] of [["client", client], ["manager", manager], ["admin", admin]]) {
    // The invitation reply: where it went, and what happened to the email.
    const invitation = person.invited.body;
    assert.equal(invitation.invitation.role, role);
    assert.equal(invitation.invitation.organisationId, DEMO);
    assert.equal(invitation.delivery.to, person.email);
    assert.equal(invitation.delivery.from, "admin@maintsupp.com");
    assert.ok(
      ["disabled", "sent", "sink", "failed", "skipped", "suppressed"].includes(invitation.delivery.status),
    );
    if (!process.env.INVITATION_EMAIL_MODE) {
      // The local server is not opted in, so nothing may have been attempted.
      assert.equal(invitation.delivery.status, "disabled", "no email is attempted without opting in");
    }
    assert.ok(invitation.inviteUrl.includes("/invite/"), "the link is still handed back to share");

    // Acceptance answers with the invited role and workspace, and no token.
    assert.equal(person.accepted.role, role);
    assert.equal(person.accepted.organisationId, DEMO);
    assert.doesNotMatch(JSON.stringify(person.accepted), new RegExp(person.token));
    assert.match(person.cookie, new RegExp(`maintsupp_demo_organisation=${DEMO}`));

    // A second use of the link is refused.
    const replay = await api(null, `/api/auth/invitations/${person.token}`, {
      method: "POST",
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(replay.status, 410, `${role}: an invitation works once`);

    // The first sign-in stands in the invited workspace, with that role only.
    const context = await api(person.cookie, "/api/context");
    assert.equal(context.status, 200);
    const { actor, currentOrganisation, organisations, identity, tenantSummary, capabilities } =
      context.body.context;
    assert.equal(actor.role, role);
    assert.equal(currentOrganisation.id, DEMO);
    assert.deepEqual(organisations.map((item) => item.id), [DEMO], `${role} sees one workspace`);
    assert.equal(identity.crossOrganisation, false);
    assert.equal(tenantSummary, null, `${role} gets no cross-client summary`);
    assert.equal(capabilities["navigation.edit"], false);
    assert.equal(capabilities["roles.edit"], false);
    assert.equal(capabilities["clients.view_all"], false);
    assert.equal(capabilities["users.view"], role === "admin");
    assert.equal(capabilities["board.edit"], role !== "client");

    assert.equal(capabilities["navigation.personalise"], true);
    const navigation = await api(person.cookie, "/api/navigation");
    assert.equal(navigation.body.canEditDefault, false, `${role} cannot touch the workspace sidebar`);
    assert.equal(navigation.body.canEditOwn, true, `${role} may arrange their own sidebar`);
    assert.equal(navigation.body.canCustomise, true);
  }

  // Nothing was sent: no invitation appears in the workspace's delivery log.
  if (!process.env.INVITATION_EMAIL_MODE) {
    const log = await api(await owner(), "/api/notifications/replay", {
      headers: { cookie: `${await owner()}; maintsupp_demo_organisation=${DEMO}` },
    });
    assert.equal(log.status, 200);
    const mine = (log.body.notifications ?? []).filter((row) =>
      [client.email, manager.email, admin.email].includes(row.recipient),
    );
    assert.deepEqual(mine, [], "no email was attempted for these invitations");
  }
});

test("live: a non-Super-Admin cannot reach another workspace by cookie, id, URL or API", { skip: !live }, async (t) => {
  if (!(await owner())) return t.skip("the seeded owner could not sign in");
  const { client, manager, admin } = await world();
  // REPLACE the workspace cookie acceptance set, rather than appending a second
  // one: the resolver reads the first match, so an appended forgery would be
  // ignored for the wrong reason and prove nothing.
  const forged = (cookie) =>
    [
      ...cookie.split("; ").filter((pair) => !pair.startsWith("maintsupp_demo_organisation=")),
      `maintsupp_demo_organisation=${PRIMARY}`,
    ].join("; ");

  // A job that exists in the primary workspace, found by the owner.
  const jobs = await api(await owner(), "/api/maintenance?limit=1", {
    headers: { cookie: `${await owner()}; maintsupp_demo_organisation=${PRIMARY}` },
  });
  const foreignJob = jobs.body?.requests?.[0]?.id ?? null;

  for (const person of [client, manager, admin]) {
    const context = await api(forged(person.cookie), "/api/context");
    assert.equal(context.body.context.currentOrganisation.id, DEMO, "a forged cookie changes nothing");

    const select = await api(person.cookie, "/api/context", {
      method: "POST",
      body: JSON.stringify({ action: "select_organisation", organisationId: PRIMARY }),
    });
    assert.equal(select.status, 404, "switching to a workspace you are not in is refused");

    const create = await api(person.cookie, "/api/context", {
      method: "POST",
      body: JSON.stringify({ action: "create_organisation", name: `RBAC ${STAMP}` }),
    });
    assert.equal(create.status, 403, "only a Super Admin creates workspaces");

    const named = await api(person.cookie, `/api/admin/users?organisationId=${PRIMARY}`);
    assert.equal(named.status, 403);
    assert.doesNotMatch(named.text, /sunnamusk/i, "the refusal does not describe the other workspace");

    for (const path of ["/api/admin/clients", "/api/admin/roles", `/api/admin/roles?organisationId=${PRIMARY}`]) {
      assert.equal((await api(person.cookie, path)).status, 403, path);
    }

    if (foreignJob) {
      const updates = await api(forged(person.cookie), `/api/updates?requestId=${foreignJob}`);
      assert.equal(updates.status, 404, "another workspace's job is not found");
      const links = await api(person.cookie, `/api/board/links?requestId=${foreignJob}`);
      assert.deepEqual(links.body.links, [], "and its links come back empty");
      assert.equal(links.body.completion, null);
    }

    // A stale or invented workspace id is refused the same way.
    const stale = await api(person.cookie, "/api/admin/users?organisationId=org_does_not_exist");
    assert.equal(stale.status, 403);
  }
});

test("live: menu and role administration are Super Admin's alone", { skip: !live }, async (t) => {
  if (!(await owner())) return t.skip("the seeded owner could not sign in");
  const { client, manager, admin } = await world();
  // The arrangement shape `/api/navigation` stores (see stage-twenty-navigation).
  const heading = (label) => ({ key: "group:operations", kind: "group", label, hidden: false, group: null, position: 0 });
  const entry = (key, position, extra = {}) => ({
    key,
    kind: "section",
    label: null,
    hidden: false,
    group: "group:operations",
    position,
    ...extra,
  });
  const layout = JSON.stringify({ scope: "workspace", items: [heading("Operations"), entry("overview", 1)] });
  const ownerInDemo = `${await owner()}; maintsupp_demo_organisation=${DEMO}`;
  const workspaceDefault = async () => {
    const seen = await api(ownerInDemo, "/api/navigation");
    return JSON.stringify({ items: seen.body.arrangement.workspace, locked: seen.body.locked });
  };
  const before = await workspaceDefault();

  for (const [index, person] of [client, manager, admin].entries()) {
    const mine = `Mine ${index + 1}`;
    const workspace = await api(person.cookie, "/api/navigation", { method: "PUT", body: layout });
    assert.equal(workspace.status, 403, "the workspace sidebar is Super Admin's");
    assert.equal(workspace.body.capability, "navigation.edit");

    // Their OWN sidebar they may arrange — and it goes nowhere else. A
    // smuggled `locked` list and a `workspace`-looking payload change nothing.
    const own = await api(person.cookie, "/api/navigation", {
      method: "PUT",
      body: JSON.stringify({
        scope: "user",
        locked: ["overview"],
        items: [heading(mine), entry("reports", 1), entry("overview", 2)],
      }),
    });
    assert.equal(own.status, 200, `${person.email} may arrange their own sidebar`);
    const theirs = await api(person.cookie, "/api/navigation");
    assert.equal(theirs.body.source, "user");
    assert.equal(theirs.body.layout.groups[0].label, mine);
    assert.equal(await workspaceDefault(), before, "a personal arrangement never touches the default");
    const others = await api(ownerInDemo, "/api/navigation");
    assert.notEqual(others.body.layout.groups[0]?.label, mine, "nor anyone else's sidebar");

    const reset = await api(person.cookie, "/api/navigation", { method: "DELETE" });
    assert.equal(reset.status, 200, "resetting their own arrangement stays open");
    assert.notEqual((await api(person.cookie, "/api/navigation")).body.source, "user");

    const section = await api(person.cookie, "/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ label: `RBAC ${STAMP}` }),
    });
    assert.equal(section.status, 403);
    assert.equal(section.body.capability, "navigation.edit");

    const matrix = await api(person.cookie, "/api/admin/roles", {
      method: "PUT",
      body: JSON.stringify({ changes: [{ role: "manager", capability: "users.invite", allowed: true }] }),
    });
    assert.equal(matrix.status, 403);
  }

  // The Super Admin can read the matrix, which now has a Manager column.
  const ownerMatrix = await api(await owner(), `/api/admin/roles?organisationId=${DEMO}`);
  assert.equal(ownerMatrix.status, 200);
  // Re-pointed: the matrix has an Owner column since the three-level batch,
  // and the reservation locks it like every other role below Super Admin.
  assert.deepEqual(ownerMatrix.body.roles.map((role) => role.key), ["client", "manager", "admin", "owner", "super_admin"]);
  const reserved = ownerMatrix.body.lockedCells.filter((cell) => cell.capability === "navigation.edit");
  assert.deepEqual(reserved.map((cell) => cell.role).sort(), ["admin", "client", "manager", "owner", "super_admin"]);
  const ceiling = ownerMatrix.body.lockedCells.filter(
    (cell) => cell.role === "manager" && cell.capability === "users.invite",
  );
  assert.equal(ceiling.length, 1, "the manager ceiling is shown as locked");

  // Even a Super Admin cannot write past the manager ceiling.
  const past = await api(await owner(), "/api/admin/roles", {
    method: "PUT",
    body: JSON.stringify({
      organisationId: DEMO,
      changes: [{ role: "manager", capability: "data.import", allowed: true }],
    }),
  });
  assert.equal(past.status, 403);
  assert.equal(past.body.guardRail, "role_ceiling");
  assert.equal(await workspaceDefault(), before, "and nothing above moved the workspace default");
});

test("live: every self-promotion and escalation attempt is refused", { skip: !live }, async (t) => {
  if (!(await owner())) return t.skip("the seeded owner could not sign in");
  const { client, manager, admin } = await world();
  const roster = await api(admin.cookie, "/api/admin/users");
  assert.equal(roster.status, 200);
  const idOf = (email) => roster.body.users.find((user) => user.email === email)?.id;
  const ownerRow = roster.body.users.find((user) => user.email === OWNER.email);

  // The admin's picker offers Manager and Client, nothing else.
  assert.deepEqual(
    roster.body.roles.filter((role) => role.assignable).map((role) => role.key),
    ["client", "manager"],
  );
  assert.deepEqual(roster.body.organisations.map((item) => item.id), [DEMO]);
  if (ownerRow) assert.equal(ownerRow.manageable, false, "a Super Admin is not manageable by an Admin");

  const patch = (cookie, body) =>
    api(cookie, "/api/admin/users", { method: "PATCH", body: JSON.stringify({ organisationId: DEMO, ...body }) });

  // Client → Manager / Admin, Manager → Admin: none of them may even edit people.
  for (const [person, role] of [[client, "manager"], [client, "admin"], [manager, "admin"]]) {
    const self = await patch(person.cookie, { userId: idOf(person.email), action: "role", role });
    assert.equal(self.status, 403, `${person.email} → ${role}`);
  }
  // …and neither may assign a role to anybody else.
  assert.equal((await patch(manager.cookie, { userId: idOf(client.email), action: "role", role: "manager" })).status, 403);
  assert.equal((await patch(client.cookie, { userId: idOf(manager.email), action: "role", role: "client" })).status, 403);

  // Admin → Admin is refused: for a Manager, and by invitation.
  const toAdmin = await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "admin" });
  assert.equal(toAdmin.status, 403, "an Admin may not assign Admin");
  const inviteAdmin = await api(admin.cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: `rbac-peer-${STAMP}@rbac.test.maintsupp.com`, role: "admin" }),
  });
  assert.equal(inviteAdmin.status, 403, "nor invite one");
  const inviteAdminDirect = await api(admin.cookie, "/api/auth/invitations", {
    method: "POST",
    body: JSON.stringify({ email: `rbac-peer-${STAMP}@rbac.test.maintsupp.com`, role: "admin" }),
  });
  assert.equal(inviteAdminDirect.status, 403, "…through either route");

  // An Admin acts on no other Admin: a second Admin, made by the Super Admin.
  const peer = await onboard("admin", DEMO, "peer-admin");
  const withPeer = await api(admin.cookie, "/api/admin/users");
  const peerRow = withPeer.body.users.find((user) => user.email === peer.email);
  assert.equal(peerRow.manageable, false, "another Admin is not manageable by an Admin");
  for (const body of [
    { userId: peerRow.id, action: "role", role: "client" },
    { userId: peerRow.id, action: "deactivate" },
    { userId: peerRow.id, action: "profile", fullName: "Renamed by a peer" },
  ]) {
    const refused = await patch(admin.cookie, body);
    assert.equal(refused.status, 403, `admin → admin ${body.action}`);
  }
  const peerReset = await api(admin.cookie, "/api/admin/users/password-reset", {
    method: "POST",
    body: JSON.stringify({ userId: peerRow.id, organisationId: DEMO }),
  });
  assert.equal(peerReset.status, 403, "an Admin cannot take over another Admin's account");
  // Their own profile is still theirs to edit.
  const ownProfile = await patch(admin.cookie, { userId: idOf(admin.email), action: "profile", fullName: "RBAC admin" });
  assert.equal(ownProfile.status, 200);
  // Admin → Super Admin, for themselves and for somebody else.
  assert.equal((await patch(admin.cookie, { userId: idOf(admin.email), action: "role", role: "super_admin" })).status, 403);
  assert.equal((await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "super_admin" })).status, 403);
  // Owner is real since the three-level batch, and above an Admin's reach.
  assert.equal((await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "owner" })).status, 403);
  // An invented role in a manipulated payload.
  assert.equal((await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "director" })).status, 400);

  // Acting on the Super Admin.
  if (ownerRow) {
    assert.equal((await patch(admin.cookie, { userId: ownerRow.id, action: "deactivate" })).status, 403);
    assert.equal((await patch(admin.cookie, { userId: ownerRow.id, action: "role", role: "client" })).status, 403);
    const reset = await api(admin.cookie, "/api/admin/users/password-reset", {
      method: "POST",
      body: JSON.stringify({ userId: ownerRow.id, organisationId: DEMO }),
    });
    assert.equal(reset.status, 403);
  }

  // Inviting upwards, or into a workspace you do not hold.
  const upward = await api(admin.cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: `rbac-up-${STAMP}@rbac.test.maintsupp.com`, role: "super_admin" }),
  });
  assert.equal(upward.status, 403);
  const elsewhere = await api(admin.cookie, "/api/auth/invitations", {
    method: "POST",
    body: JSON.stringify({ email: `rbac-else-${STAMP}@rbac.test.maintsupp.com`, role: "client", organisationId: PRIMARY }),
  });
  assert.equal(elsewhere.status, 403);
  for (const person of [client, manager]) {
    const direct = await api(person.cookie, "/api/auth/invitations", {
      method: "POST",
      body: JSON.stringify({ email: `rbac-x-${STAMP}@rbac.test.maintsupp.com`, role: "client" }),
    });
    assert.equal(direct.status, 403, "only a role holding users.invite may invite");
    assert.equal((await api(person.cookie, "/api/admin/users")).status, 403, "and People is not theirs");
  }

  // Re-pointed for the three-level batch: nobody invites a Super Admin any
  // more, the Super Admin included — platform authority is not handed out by
  // link.
  const noSuperAdmin = await api(await owner(), "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email: `rbac-lofty-sa-${STAMP}@rbac.test.maintsupp.com`, role: "super_admin", organisationId: DEMO }),
  });
  assert.equal(noSuperAdmin.status, 403, "Super Admin is not invited, by anybody");

  // A pending Owner or Admin invitation is outside the admin's table: it can
  // be neither resent nor withdrawn by them. An Owner invitation is company
  // business and is not even listed to them. (Created and withdrawn by the
  // Super Admin.)
  for (const role of ["owner", "admin"]) {
    const address = `rbac-lofty-${role}-${STAMP}@rbac.test.maintsupp.com`;
    const lofty = await api(await owner(), "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: address, role, organisationId: DEMO }),
    });
    assert.equal(lofty.status, 201, "a Super Admin may invite this role");
    try {
      const seenByAdmin = (await api(admin.cookie, "/api/admin/users")).body.invitations.find(
        (row) => row.email === address,
      );
      const listed =
        role === "owner"
          ? (await api(await owner(), `/api/admin/users?organisationId=${DEMO}`)).body.invitations.find(
              (row) => row.email === address,
            )
          : seenByAdmin;
      if (role === "owner") assert.equal(seenByAdmin, undefined, "an Admin is not shown an Owner invitation");
      assert.ok(listed, "the invitation is pending");
      const resend = await api(admin.cookie, "/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ invitationId: listed.id }),
      });
      assert.equal(resend.status, 403, `an admin cannot resend a ${role} invitation`);
      const withdraw = await api(admin.cookie, `/api/admin/users?invitationId=${encodeURIComponent(listed.id)}`, {
        method: "DELETE",
      });
      assert.equal(withdraw.status, 403, "…nor withdraw it");
      assert.equal(
        (await api(null, `/api/auth/invitations/${tokenOf(lofty.body.inviteUrl)}`)).status,
        200,
        "and the refused requests changed nothing",
      );
    } finally {
      const listed = (await api(await owner(), `/api/admin/users?organisationId=${DEMO}`)).body.invitations.find(
        (row) => row.email === address,
      );
      if (listed) {
        await api(await owner(), `/api/admin/users?organisationId=${DEMO}&invitationId=${encodeURIComponent(listed.id)}`, {
          method: "DELETE",
        });
      }
    }
  }

  // A Super Admin assigns Admin, Manager and Client.
  const ownerSession = await owner();
  const ownerPatch = (body) =>
    api(ownerSession, "/api/admin/users", { method: "PATCH", body: JSON.stringify({ organisationId: DEMO, ...body }) });
  for (const role of ["admin", "client", "manager"]) {
    const changed = await ownerPatch({ userId: idOf(manager.email), action: "role", role });
    assert.equal(changed.status, 200, `Super Admin → ${role}`);
    assert.equal(changed.body.role, role);
  }

  // Inside their own workspace an admin still manages lower roles.
  const down = await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "client" });
  assert.equal(down.status, 200);
  const up = await patch(admin.cookie, { userId: idOf(manager.email), action: "role", role: "manager" });
  assert.equal(up.status, 200);
});

test("live: a duplicate invite is refused, a resend is explicit, a withdrawal kills the link", { skip: !live }, async (t) => {
  const cookie = await owner();
  if (!cookie) return t.skip("the seeded owner could not sign in");
  const email = `rbac-resend-${STAMP}@rbac.test.maintsupp.com`;
  const first = await api(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role: "manager", organisationId: DEMO }),
  });
  assert.equal(first.status, 201);
  const firstToken = tokenOf(first.body.inviteUrl);

  const again = await api(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role: "manager", organisationId: DEMO }),
  });
  assert.equal(again.status, 409, "a second click does not send a second invitation");

  const pending = (await api(cookie, `/api/admin/users?organisationId=${DEMO}`)).body.invitations.find(
    (row) => row.email === email,
  );
  assert.equal(pending.roleLabel, "Manager");
  assert.doesNotMatch(String(pending.invitedBy), /^user-/, "the inviter is a name, not an id");

  const resent = await api(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ invitationId: pending.id, organisationId: DEMO, role: "super_admin" }),
  });
  assert.equal(resent.status, 201);
  assert.equal(resent.body.invitation.role, "manager", "a resend repeats the stored role");
  const secondToken = tokenOf(resent.body.inviteUrl);
  assert.equal((await api(null, `/api/auth/invitations/${firstToken}`)).status, 410);

  const described = await api(null, `/api/auth/invitations/${secondToken}`);
  assert.equal(described.status, 200);
  // Re-pointed: the description now names the company and the workspaces it
  // grants (names, never ids) and whether it is the whole company.
  assert.deepEqual(
    Object.keys(described.body.invitation).sort(),
    [
      "companyName",
      "email",
      "expiresAt",
      "message",
      "organisationName",
      "role",
      "roleLabel",
      "wholeCompany",
      "workspaceNames",
    ],
    "the public description carries no ids",
  );
  assert.doesNotMatch(described.text, /org_[0-9a-z]{6,}|company[-_]/i, "no workspace or company id");

  const listed = (await api(cookie, `/api/admin/users?organisationId=${DEMO}`)).body.invitations.find(
    (row) => row.email === email,
  );
  const withdrawn = await api(
    cookie,
    `/api/admin/users?organisationId=${DEMO}&invitationId=${encodeURIComponent(listed.id)}`,
    { method: "DELETE" },
  );
  assert.equal(withdrawn.status, 200);
  assert.equal((await api(null, `/api/auth/invitations/${secondToken}`)).status, 410);
});

test("live: a person who belongs to two workspaces is only as strong as each membership", { skip: !live }, async (t) => {
  const cookie = await owner();
  if (!cookie) return t.skip("the seeded owner could not sign in");
  const { client, admin } = await world();

  // Add the DEMO admin to the PRIMARY workspace as a Client, and the DEMO
  // client to PRIMARY as a Client too — both accept while signed in, which is
  // the existing-account path: membership added, password untouched.
  for (const person of [admin, client]) {
    const invited = await api(cookie, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: person.email, role: "client", organisationId: PRIMARY }),
    });
    assert.equal(invited.status, 201, invited.text);
    const accepted = await api(person.cookie, `/api/auth/invitations/${tokenOf(invited.body.inviteUrl)}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.role, "client");
    person.cookie = mergeCookies(person.cookie, accepted.response);
  }

  try {
    // Accepting moved the admin into PRIMARY — where they are a Client.
    const there = await api(admin.cookie, "/api/context");
    assert.equal(there.body.context.currentOrganisation.id, PRIMARY);
    assert.equal(there.body.context.actor.role, "client", "the role is the one held HERE");
    assert.equal(there.body.context.capabilities["board.edit"], false);
    assert.deepEqual(there.body.context.organisations.map((item) => item.id).sort(), [PRIMARY, DEMO].sort());

    // THE ESCALATION THIS BATCH CLOSED: an Admin elsewhere writing here.
    const write = await api(admin.cookie, "/api/board/groups", { method: "POST", body: JSON.stringify({}) });
    assert.equal(write.status, 403, "Admin of DEMO must not write to PRIMARY, where they are a Client");
    assert.equal((await api(admin.cookie, "/api/admin/users")).status, 403);

    // …and the People screen only offers the workspace they administer.
    const people = await api(admin.cookie, `/api/admin/users?organisationId=${DEMO}`);
    assert.equal(people.status, 200);
    assert.deepEqual(people.body.organisations.map((item) => item.id), [DEMO]);

    // Switching between their OWN workspaces is allowed, and restores Admin.
    const back = await api(admin.cookie, "/api/context", {
      method: "POST",
      body: JSON.stringify({ action: "select_organisation", organisationId: DEMO }),
    });
    assert.equal(back.status, 200);
    admin.cookie = mergeCookies(admin.cookie, back.response);
    const home = await api(admin.cookie, "/api/context");
    assert.equal(home.body.context.actor.role, "admin");
    assert.equal(home.body.context.tenantSummary, null);

    // Account-wide changes to somebody who is ALSO in a workspace this admin
    // does not administer are refused; the membership-scoped change is not.
    const clientId = people.body.users.find((user) => user.email === client.email).id;
    for (const [path, method, body] of [
      ["/api/admin/users/password-reset", "POST", { userId: clientId, organisationId: DEMO }],
      ["/api/admin/users", "PATCH", { userId: clientId, organisationId: DEMO, action: "deactivate" }],
      ["/api/admin/users", "PATCH", { userId: clientId, organisationId: DEMO, action: "profile", fullName: "Renamed" }],
    ]) {
      const refused = await api(admin.cookie, path, { method, body: JSON.stringify(body) });
      assert.equal(refused.status, 403, `${method} ${path} ${body.action ?? ""}`);
      assert.equal(refused.body.guardRail, "other_workspace");
      assert.doesNotMatch(refused.text, /sunnamusk/i, "without naming the other workspace");
    }
    const scoped = await api(admin.cookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: clientId, organisationId: DEMO, action: "role", role: "manager" }),
    });
    assert.equal(scoped.status, 200, "a role in this workspace is still this admin's to set");
    await api(admin.cookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: clientId, organisationId: DEMO, action: "role", role: "client" }),
    });
  } finally {
    // The PRIMARY memberships are part of the fixture: the owner deactivates
    // the accounts in `after`, which removes access everywhere at once.
  }
});
