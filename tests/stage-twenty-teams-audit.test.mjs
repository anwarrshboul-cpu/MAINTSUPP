/**
 * Stage 20 — teams, and an audit log that cannot be rewritten.
 *
 * Two halves, for two different kinds of claim.
 *
 * The first reads the source. "Append only" is a statement about what the code
 * is *able* to do, and no amount of exercising an API proves the absence of a
 * path — you can only prove that by looking. So these tests sweep the tree for
 * any UPDATE or DELETE against `audit_events`, in every form the codebase could
 * express one, and fail if a single one exists anywhere outside the table's own
 * declaration.
 *
 * The second half talks to the running dev server, because source that reads
 * correctly is not evidence that the routes behave. It creates a team, edits
 * it, moves somebody in and out, and then checks the log recorded all of it,
 * in order, with before and after values — and that nothing it did ever made
 * the log shorter. The live half skips when nothing is listening, so the suite
 * still passes in an environment without a server.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

const SUPER_ADMIN = "super-admin@test.maintsupp.com";
const SUNNAMUSK_CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
const DEMO_ADMIN = "admin@demo-client-ltd.test.maintsupp.com";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Every .ts/.tsx file under `app/`, so the sweeps cannot miss a new route. */
async function appSources() {
  const root = new URL("../app/", import.meta.url);
  const found = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      const label = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next, `${label}/`);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push({ path: `app/${label}`, text: await readFile(next, "utf8") });
      }
    }
  }
  await walk(root, "");
  return found;
}

/* ------------------------------------------------------------------ */
/* The audit log is append-only, by construction.                      */
/* ------------------------------------------------------------------ */

test("the audit helper's only write is an insert", async () => {
  const audit = await source("app/lib/audit.ts");

  assert.match(audit, /export async function recordAudit/);
  assert.match(audit, /\.insert\(auditEvents\)/, "recordAudit must insert");

  // The two operations that would make the log a lie.
  assert.doesNotMatch(audit, /\.update\(auditEvents\)/);
  assert.doesNotMatch(audit, /\.delete\(auditEvents\)/);
  assert.doesNotMatch(audit, /\bUPDATE\s+audit_events\b/i);
  assert.doesNotMatch(audit, /\bDELETE\s+FROM\s+audit_events\b/i);
});

test("nothing anywhere in app/ updates or deletes an audit event", async () => {
  const forbidden = [
    /\.update\(\s*auditEvents\s*\)/,
    /\.delete\(\s*auditEvents\s*\)/,
    /\bUPDATE\s+audit_events\b/i,
    /\bDELETE\s+FROM\s+audit_events\b/i,
  ];
  for (const file of await appSources()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        file.text,
        pattern,
        `${file.path} must not rewrite the audit log (${pattern})`,
      );
    }
  }
});

test("the audit API is read-only — there is no handler that could write one", async () => {
  const route = await source("app/api/audit/route.ts");
  assert.match(route, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(
      route,
      new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`),
      `/api/audit must not export ${method}: the log is written by recordAudit, never by a caller`,
    );
  }
  // And it must not be able to insert either — a browser-supplied event is a
  // forged event.
  assert.doesNotMatch(route, /\.insert\(auditEvents\)/);
});

test("recording an event can never fail the action it describes", async () => {
  const audit = await source("app/lib/audit.ts");
  const body = audit.slice(audit.indexOf("export async function recordAudit"));

  assert.match(body, /try\s*{/, "recordAudit must wrap its work in try/catch");
  assert.match(body, /catch\s*\(error\)/);
  // Swallowed, but never silently: the lost event has to be visible somewhere.
  assert.match(body, /console\.error\(/);
  // Nothing may be re-thrown out of the catch.
  assert.doesNotMatch(body, /catch[\s\S]*?\bthrow\b/);
  assert.match(body, /Promise<string \| null>/, "it must resolve rather than reject");
});

/* ------------------------------------------------------------------ */
/* Route shape.                                                        */
/* ------------------------------------------------------------------ */

test("the Stage 20 routes are organisation-scoped and match the contract", async () => {
  const teams = await source("app/api/teams/route.ts");
  const members = await source("app/api/teams/members/route.ts");
  const audit = await source("app/api/audit/route.ts");

  for (const [path, text] of [
    ["app/api/teams/route.ts", teams],
    ["app/api/teams/members/route.ts", members],
    ["app/api/audit/route.ts", audit],
  ]) {
    /*
     * `scopedDb(request)` OR `scopedDbWithCapability(request, …)`.
     *
     * The property under test is tenancy: this route must never choose its own
     * organisation. Both helpers satisfy it — the second calls the first and
     * then asks a capability question on top — so a route that gained a
     * capability guard has become stricter, not less scoped, and pinning the
     * literal call was pinning the wrong thing.
     */
    assert.match(
      text,
      /scopedDb\(request\)|scopedDbWithCapability\(request, "/,
      `${path} must resolve an organisation-scoped database`,
    );
    assert.doesNotMatch(
      text,
      /maintsupp_demo_organisation/,
      `${path} must not read the organisation cookie itself`,
    );
  }

  for (const method of ["GET", "POST", "PATCH"]) {
    assert.match(teams, new RegExp(`export async function ${method}\\b`));
  }
  for (const method of ["POST", "DELETE"]) {
    assert.match(members, new RegExp(`export async function ${method}\\b`));
  }
});

test("the gates are capabilities, not role literals", async () => {
  const audit = await source("app/api/audit/route.ts");
  const teams = await source("app/api/teams/route.ts");
  const members = await source("app/api/teams/members/route.ts");

  assert.match(audit, /requireCapability\(/);
  assert.match(audit, /"audit\.read"/);
  assert.match(teams, /requireCapability\(/);
  assert.match(members, /requireCapability\(/);
  for (const [path, text] of [
    ["app/api/audit/route.ts", audit],
    ["app/api/teams/route.ts", teams],
    ["app/api/teams/members/route.ts", members],
  ]) {
    // A role compared by hand is a rule restated per route, which is the rule
    // that eventually gets restated wrongly in one of them.
    assert.doesNotMatch(
      text,
      /role\s*===\s*"(admin|super_admin|client)"/,
      `${path} must ask permissions.ts rather than compare a role`,
    );
  }
});

test("deleting a team means archiving it", async () => {
  const teams = await source("app/api/teams/route.ts");
  // No handler may remove a team row, and none may remove its membership
  // history either — an archived team keeps the people who were on it.
  assert.doesNotMatch(teams, /\.delete\(\s*teams\s*\)/);
  assert.doesNotMatch(teams, /\.delete\(\s*teamMembers\s*\)/);
  assert.doesNotMatch(
    teams,
    /export async function DELETE\b/,
    "/api/teams must not expose a delete: archiving is the delete",
  );
  assert.match(teams, /archived/);
});

/* ------------------------------------------------------------------ */
/* Live, against the running dev server.                               */
/* ------------------------------------------------------------------ */

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

async function call(path, identity, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "x-maintsupp-identity": identity,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

test("only a permitted role may read the audit log", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const admin = await call("/api/audit", SUPER_ADMIN);
  assert.equal(admin.status, 200);
  assert.ok(Array.isArray(admin.body.events));

  const client = await call("/api/audit", SUNNAMUSK_CLIENT);
  assert.equal(client.status, 403, "a client must not read the audit log");
  assert.ok(!client.body.events);
});

test("the audit endpoint refuses every write method", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${BASE_URL}/api/audit`, {
      method,
      headers: { "x-maintsupp-identity": SUPER_ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ action: "forged.event", summary: "This must not be stored." }),
    });
    assert.equal(response.status, 405, `${method} /api/audit must not be routable`);
  }

  // And the forgery attempt left nothing behind.
  const after = await call("/api/audit?action=forged", SUPER_ADMIN);
  assert.equal(after.status, 200);
  assert.equal(after.body.total, 0, "no caller may put an event into the log");
});

test("a team's whole life is recorded, and the log only ever grows", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const before = await call("/api/audit", SUPER_ADMIN);
  assert.equal(before.status, 200);
  const startingTotal = before.body.total;
  const startingIds = new Set(before.body.events.map((event) => event.id));

  /*
   * A fixed name, reused across runs.
   *
   * Deleting a team is deliberately impossible, so a test that creates a fresh
   * one every run silently fills the workspace with litter. Reusing the same
   * fixture caps that at one clearly-named archived row — and makes a stronger
   * point than a fresh row would: on the second run the `team.created` event
   * this test asserts on is one written *by an earlier run*, which is the
   * append-only claim demonstrated rather than restated.
   */
  const name = "Stage 20 test team";
  const existing = (await call("/api/teams", SUPER_ADMIN)).body.teams.find(
    (entry) => entry.name === name || entry.name === `${name} renamed`,
  );
  let teamId;
  if (existing) {
    teamId = existing.id;
    const restored = await call("/api/teams", SUPER_ADMIN, {
      method: "PATCH",
      body: JSON.stringify({ id: teamId, name, archived: false }),
    });
    assert.equal(restored.status, 200);
  } else {
    const created = await call("/api/teams", SUPER_ADMIN, {
      method: "POST",
      body: JSON.stringify({ name, description: "Created by the Stage 20 test." }),
    });
    assert.equal(created.status, 201);
    teamId = created.body.team.id;
  }

  // Alternate the colour so the edit always moves two fields, whichever colour
  // the fixture was left on by the previous run.
  const current = (await call("/api/teams", SUPER_ADMIN)).body.teams.find(
    (entry) => entry.id === teamId,
  );
  const nextColour = current.colourHex.toUpperCase() === "#F08B23" ? "#3E8FD8" : "#F08B23";
  const renamed = await call("/api/teams", SUPER_ADMIN, {
    method: "PATCH",
    body: JSON.stringify({ id: teamId, name: `${name} renamed`, colourHex: nextColour }),
  });
  assert.equal(renamed.status, 200);

  const listing = await call("/api/teams", SUPER_ADMIN);
  const person = listing.body.people[0];
  assert.ok(person, "the workspace must have at least one person to put on a team");

  const added = await call("/api/teams/members", SUPER_ADMIN, {
    method: "POST",
    body: JSON.stringify({ teamId, userId: person.userId, teamRole: "lead" }),
  });
  assert.equal(added.status, 201);

  const withMember = await call("/api/teams", SUPER_ADMIN);
  const team = withMember.body.teams.find((entry) => entry.id === teamId);
  assert.equal(team.members.length, 1);
  assert.equal(team.members[0].teamRole, "lead");

  const removed = await call("/api/teams/members", SUPER_ADMIN, {
    method: "DELETE",
    body: JSON.stringify({ teamId, userId: person.userId }),
  });
  assert.equal(removed.status, 200);

  const archived = await call("/api/teams", SUPER_ADMIN, {
    method: "PATCH",
    body: JSON.stringify({ id: teamId, archived: true }),
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.team.archived, true);

  // Archiving hides, it does not remove: the row is still there to be read.
  const afterArchive = await call("/api/teams", SUPER_ADMIN);
  assert.ok(
    afterArchive.body.teams.some((entry) => entry.id === teamId),
    "an archived team must still exist",
  );

  /*
   * Each action is asked for by name rather than filtered out of one page of
   * the family. `team.created` is the *oldest* event this fixture has, and the
   * log is newest-first, so on a workspace with a few runs behind it a single
   * page would have paged it off — which is the log working, not failing.
   */
  for (const expected of ["team.created", "team.renamed", "team.archived"]) {
    const hit = await call(
      `/api/audit?action=${expected}&entityId=${teamId}`,
      SUPER_ADMIN,
    );
    assert.ok(hit.body.total > 0, `the log must record ${expected}`);
    assert.equal(hit.body.events[0].entityId, teamId);
  }

  const trail = await call(
    `/api/audit?action=team&entityId=${teamId}&pageSize=200`,
    SUPER_ADMIN,
  );

  // The rename carries what actually changed, not just that something did.
  const rename = trail.body.events.find((event) => event.action === "team.renamed");
  assert.deepEqual(rename.detail.changed.sort(), ["colourHex", "name"]);
  assert.equal(rename.detail.before.name, name);
  assert.equal(rename.detail.after.name, `${name} renamed`);

  // Membership history survives the person leaving the team.
  const membership = await call(
    "/api/audit?action=team.member_removed&pageSize=200",
    SUPER_ADMIN,
  );
  const removal = membership.body.events.find(
    (event) => event.action === "team.member_removed" && event.detail?.teamId === teamId,
  );
  assert.ok(removal, "removing somebody from a team must leave a trace");
  assert.equal(removal.detail.email, person.email);
  assert.equal(removal.detail.before.teamRole, "lead");

  // Nothing above shortened the log, and nothing rewrote what was already in it.
  const after = await call("/api/audit", SUPER_ADMIN);
  assert.ok(
    after.body.total > startingTotal,
    "the six actions above must have added events",
  );
  const stillPresent = await call(`/api/audit?pageSize=200`, SUPER_ADMIN);
  const presentIds = new Set(stillPresent.body.events.map((event) => event.id));
  for (const id of startingIds) {
    assert.ok(presentIds.has(id), `event ${id} must still be in the log`);
  }
});

test("the log reads newest first whichever way a row was timestamped", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { body } = await call("/api/audit?pageSize=100", SUPER_ADMIN);
  // Rows are written both as ISO ("…T14:35:37.123Z") and by the column default
  // ("… 14:35:37"). Compared raw, every ISO row sorts above every default row
  // whatever the date, so the route normalises the separator; this asserts the
  // result rather than the technique.
  const stamps = body.events.map((event) => event.createdAt.replace("T", " ").replace("Z", ""));
  for (let index = 1; index < stamps.length; index += 1) {
    assert.ok(
      stamps[index - 1] >= stamps[index],
      `event ${index} (${stamps[index]}) must not be newer than the one above it (${stamps[index - 1]})`,
    );
  }
});

test("an admin of one workspace cannot read another workspace's events", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const demo = await call("/api/audit?pageSize=200", DEMO_ADMIN);
  if (demo.status === 403) {
    t.skip("the demo workspace has no admin identity seeded");
    return;
  }
  assert.equal(demo.status, 200);
  assert.equal(demo.body.viewer.crossOrganisation, false);
  const foreign = demo.body.events.filter(
    (event) => !demo.body.workspaces.some((workspace) => workspace.id === event.organisationId),
  );
  assert.deepEqual(foreign, [], "an admin must only see their own workspaces' events");
});

test("the audit filters narrow the log without reordering it", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const all = await call("/api/audit?pageSize=200", SUPER_ADMIN);
  if (!all.body.total) {
    t.skip("the log is empty on this database — nothing to filter");
    return;
  }

  const family = await call("/api/audit?action=team&pageSize=200", SUPER_ADMIN);
  assert.equal(family.status, 200);
  assert.ok(
    family.body.events.every((event) => event.action.startsWith("team.")),
    "an action filter without a dot must match the whole family",
  );
  assert.ok(family.body.total <= all.body.total);

  const actor = all.body.events.find((event) => event.actorEmail)?.actorEmail;
  if (actor) {
    const byActor = await call(
      `/api/audit?actor=${encodeURIComponent(actor)}&pageSize=200`,
      SUPER_ADMIN,
    );
    assert.ok(byActor.body.events.every((event) => event.actorEmail === actor));
  }

  // A date range in the future has no events, and says so honestly.
  const future = await call("/api/audit?from=2099-01-01&to=2099-12-31", SUPER_ADMIN);
  assert.equal(future.body.total, 0);
  assert.deepEqual(future.body.events, []);
});
