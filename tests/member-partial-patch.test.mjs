import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * A partial save of a member stops wrecking the account it was meant to edit.
 *
 * `text()` turns a missing key into "", and "" satisfies NOT NULL, so every
 * column the member PATCH named unconditionally was blanked by a request that
 * did not mention it. `users.email` is also UNIQUE, so the damage compounded:
 * the first member paused with `{ active: false }` lost their address, and the
 * second one paused the same way collided on the index and answered 400 with a
 * raw constraint error.
 *
 * `active` was the opposite problem. `booleanValue` falls back to TRUE, so an
 * omitted `active` silently restored access to somebody whose access had been
 * withdrawn — the one field here where the default is not what the caller
 * asked for. Both directions are asserted below.
 *
 * Source assertions run everywhere. The behavioural tests need a dev server and
 * skip without one, which is the bargain the rest of the suite already makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `memberpatch-${Date.now().toString(36)}`;
const QA_EMAIL = `${RUN}@qa.maintsupp.local`;
const QA_EMAIL_TWO = `${RUN}-two@qa.maintsupp.local`;
const QA_NAME = `${RUN} QA Member`;

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/context`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) {
        BASE_URL = candidate;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  return false;
}

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function call(method, path, orgId, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: `${cookie}; maintsupp_demo_organisation=${orgId}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

const workspace = (orgId) => call("GET", "/api/workspace", orgId);
const create = (orgId, entity, data) => call("POST", "/api/workspace", orgId, { entity, data });
const patch = (orgId, entity, id, data) => call("PATCH", "/api/workspace", orgId, { entity, id, data });
/**
 * One member, read straight from the development database.
 *
 * This asserted through `GET /api/workspace`, which assembles the whole
 * workspace — every site, every compliance row, every contractor — and costs
 * about a second. Called after each of a dozen refusals it dominated the run,
 * and a suite that ties up the one development server for a minute makes its
 * neighbours fail rather than itself. The columns below are the ones under
 * test; nothing about the assertion changes.
 */
async function readMember(orgId, id) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  let db;
  try {
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
    const row = db
      .prepare("SELECT full_name, email, role, active FROM users WHERE id = ? AND organisation_id = ?")
      .get(id, orgId);
    return row ? { name: row.full_name, email: row.email, role: row.role, active: !!row.active } : undefined;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
}

/**
 * Every fixture this file created, removed for good.
 *
 * Archiving a member only sets `active: false` — they are never deleted, which
 * is the product contract — so the row would otherwise survive its own cleanup
 * and accumulate across runs. Memberships go first: `memberships.user_id`
 * references `users.id`.
 */
after(async () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return;
  }
  if (!file) return;
  let db;
  try {
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    /*
     * The dev server holds this file open, so an unqualified write loses the
     * race and throws "database is locked". Wait for the writer rather than
     * leave the fixtures behind.
     */
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare(
      "DELETE FROM activity_log WHERE entity_id IN (SELECT id FROM users WHERE email LIKE ?)",
    ).run(`${RUN}%`);
    db.prepare("DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)").run(`${RUN}%`);
    db.prepare("DELETE FROM users WHERE email LIKE ?").run(`${RUN}%`);
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

test("the member PATCH writes only the keys it was sent", async () => {
  const route = await read("app/api/workspace/route.ts");
  const update = route.slice(route.indexOf("export async function PATCH"));
  const start = update.indexOf('entity === "member"');
  assert.ok(start > 0, "the PATCH member branch must exist");
  const branch = update.slice(start, update.indexOf("} else if", start + 20));

  assert.match(
    branch,
    /"name" in data \? \{ fullName: text\(data\.name, 120\) \} : \{\}/,
    "the payload key is `name` and the column is `fullName`, so `supplied` cannot spread it",
  );
  for (const column of ["email", "role", "active"]) {
    assert.match(
      branch,
      new RegExp(`supplied\\(data, "${column}"`),
      `PATCH member must write ${column} only when it was sent`,
    );
  }
  assert.doesNotMatch(
    branch,
    /booleanValue\(data\.active\)/,
    "an omitted `active` must not fall back to true and restore withdrawn access",
  );
  assert.doesNotMatch(
    branch,
    /email: text\(data\.email/,
    "an omitted email must not be written as '' into a NOT NULL UNIQUE column",
  );
});

test("a member's role is checked against the roles the Team tab can express", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /const MEMBER_ROLES = \["Super Admin", "Admin", "Client"\]/, "one allow-list");
  assert.match(route, /function memberRoleRefusal\(/, "one guard");

  /*
   * Both verbs. The create is the half that matters — a new member has no
   * membership, so `seedWorkspaceIfEmpty` derives one from this label; an edit
   * cannot reach that path because the insert leaves an existing membership
   * alone. Guarding only the edit would close the harmless half.
   */
  const create = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.match(create, /memberRoleRefusal\(data\)/, "the create must refuse an unknown role");
  const update = route.slice(route.indexOf("export async function PATCH"));
  assert.match(update, /memberRoleRefusal\(data\)/, "and so must the edit");

  assert.match(route, /status: 400/, "an unknown role is a 400");
});

test("a member's access is checked rather than guessed", async () => {
  /*
   * `booleanValue` falls back to TRUE, so before this guard `{"active": null}`,
   * `{"active": "no"}` and `{"active": "0"}` all RESTORED access that had been
   * withdrawn, while the number 0 correctly withdrew it. Fixing only the
   * omitted case would have left the field the comment calls the whole point
   * still guessing.
   */
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /function memberActiveRefusal\(/, "one guard");
  assert.match(route, /A member's access must be true or false\./);
  const update = route.slice(route.indexOf("export async function PATCH"));
  assert.match(update, /memberActiveRefusal\(data\)/, "the edit must use it");
});

// ---------------------------------------------------------------------------
// Behavioural — needs a dev server
// ---------------------------------------------------------------------------

test("a partial member PATCH preserves the fields it did not mention", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  // Fail closed: never fall back to a real member as the subject of a test
  // that mutates it.
  const created = await create(PRIMARY_ORGANISATION_ID, "member", {
    name: QA_NAME,
    email: QA_EMAIL,
    role: "Client",
    active: true,
  });
  assert.equal(created.status, 200, `fixture creation failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  // 1 — an unrelated field: email and role must both survive.
  const paused = await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: false });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  let member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.email, QA_EMAIL, "the email must survive a PATCH that did not mention it");
  assert.equal(member.role, "Client", "and so must the role");
  assert.equal(member.name, QA_NAME, "and the name");
  assert.equal(member.active, false, "while the field that WAS sent is written");

  // …and the other direction: an omitted `active` must not restore access.
  const renamed = await patch(PRIMARY_ORGANISATION_ID, "member", id, { name: `${QA_NAME} Renamed` });
  assert.equal(renamed.status, 200);
  member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.active, false, "an omitted `active` must not silently restore withdrawn access");
  assert.equal(member.email, QA_EMAIL, "and the email is still untouched");

  const restored = await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: true });
  assert.equal(restored.status, 200);
  assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).active, true, "an explicit restore still works");

  // 2 — email only.
  const emailed = await patch(PRIMARY_ORGANISATION_ID, "member", id, { email: QA_EMAIL_TWO });
  assert.equal(emailed.status, 200, JSON.stringify(emailed.body));
  member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.email, QA_EMAIL_TWO, "an explicit email updates");
  assert.equal(member.role, "Client", "without disturbing its neighbours");
  assert.equal(member.active, true, "and without pausing or restoring anybody");

  // 3 — role only.
  const promoted = await patch(PRIMARY_ORGANISATION_ID, "member", id, { role: "Admin" });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.role, "Admin", "an explicit role updates");
  assert.equal(member.email, QA_EMAIL_TWO, "the email must be untouched");
  await patch(PRIMARY_ORGANISATION_ID, "member", id, { role: "Client" });
});

test("an invalid member field is refused, and writes nothing at all", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  const email = `${RUN}-invalid@qa.maintsupp.local`;
  const created = await create(PRIMARY_ORGANISATION_ID, "member", {
    name: `${RUN} Invalid Subject`,
    email,
    role: "Client",
    active: true,
  });
  assert.equal(created.status, 200, `fixture creation failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  // 4 — an invalid email is refused and the stored one is untouched.
  for (const bad of ["", "not-an-email"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, "member", id, { email: bad });
    assert.equal(refused.status, 400, `an invalid email is a 400: ${JSON.stringify(bad)}`);
    assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).email, email, "a refused PATCH writes nothing");
  }

  // 5 — an unknown role is refused. "super_admin" is the AUTHORITY vocabulary,
  // not the label vocabulary this column takes, so it must be refused too.
  for (const bad of ["Owner", "super_admin"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, "member", id, { role: bad });
    assert.equal(refused.status, 400, `an unknown role is a 400: ${JSON.stringify(bad)}`);
    assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).role, "Client", "a refused PATCH writes nothing");
  }

  /*
   * An unreadable `active` is refused rather than guessed. Each of these used
   * to restore access that had been withdrawn, because `booleanValue` falls
   * back to true for anything it cannot read.
   */
  const paused = await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: false });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).active, false, "the member is paused");
  for (const bad of [null, "no", "0"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: bad });
    assert.equal(refused.status, 400, `an unreadable access value is a 400: ${JSON.stringify(bad)}`);
    assert.equal(
      (await readMember(PRIMARY_ORGANISATION_ID, id)).active,
      false,
      `a refused PATCH must not restore withdrawn access: ${JSON.stringify(bad)}`,
    );
  }
  // The values booleanValue can genuinely read still work.
  for (const [value, expected] of [[0, false], ["true", true]]) {
    const ok = await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: value });
    assert.equal(ok.status, 200, `a readable access value is accepted: ${JSON.stringify(value)}`);
    assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).active, expected);
  }
  await patch(PRIMARY_ORGANISATION_ID, "member", id, { active: true });

  // A body whose `data` is not a record is refused, not answered with a V8
  // message about the `in` operator.
  for (const bad of ["role"]) {
    const odd = await call("PATCH", "/api/workspace", PRIMARY_ORGANISATION_ID, { entity: "member", id, data: bad });
    assert.ok(odd.status < 500, `a primitive data must not 5xx: ${JSON.stringify(bad)}`);
    assert.doesNotMatch(
      JSON.stringify(odd.body),
      /in' operator/,
      `a primitive data must not leak an internal TypeError: ${JSON.stringify(bad)}`,
    );
  }

  // A valid role still lands.
  const promoted = await patch(PRIMARY_ORGANISATION_ID, "member", id, { role: "Super Admin" });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal((await readMember(PRIMARY_ORGANISATION_ID, id)).role, "Super Admin");
  await patch(PRIMARY_ORGANISATION_ID, "member", id, { role: "Client" });

  // Zero partial mutation: the valid half of a refused request must not land.
  const half = await patch(PRIMARY_ORGANISATION_ID, "member", id, {
    name: `${RUN} Renamed By A Refused Patch`,
    email: "nope",
  });
  assert.equal(half.status, 400, "the request is refused");
  assert.equal(
    (await readMember(PRIMARY_ORGANISATION_ID, id)).name,
    `${RUN} Invalid Subject`,
    "a refused PATCH must not write its valid half",
  );

  // The create refuses an unknown role too — the half that can grant authority.
  const badCreate = await create(PRIMARY_ORGANISATION_ID, "member", {
    name: `${RUN} Never Created`,
    email: `${RUN}-never@qa.maintsupp.local`,
    role: "Owner",
    active: true,
  });
  assert.equal(badCreate.status, 400, "creating a member with an unknown role is refused");
  const team = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.team;
  assert.equal(
    team.some((m) => m.email === `${RUN}-never@qa.maintsupp.local`),
    false,
    "a refused create must leave no row behind",
  );
});

test("a member cannot be edited without a session, or from another organisation", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  const email = `${RUN}-tenancy@qa.maintsupp.local`;
  const created = await create(PRIMARY_ORGANISATION_ID, "member", {
    name: `${RUN} Tenancy Subject`,
    email,
    role: "Client",
    active: true,
  });
  assert.equal(created.status, 200, `fixture creation failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  // 6 — no session at all.
  const anonymous = await fetch(`${BASE_URL}/api/workspace`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entity: "member", id, data: { role: "Super Admin", email: "hijack@example.com" } }),
  });
  assert.equal(anonymous.status, 401, "an unauthenticated caller cannot edit a member");
  let member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.role, "Client", "and nothing was written");
  assert.equal(member.email, email);

  /*
   * 7 — another tenant. The status is deliberately not asserted: the
   * organisation-scoped WHERE makes this a nought-row no-op, and the route
   * answers 200 for that today. What matters is that nothing moved.
   */
  const foreign = await patch(DEMO_ORGANISATION_ID, "member", id, {
    role: "Super Admin",
    email: "stolen@example.com",
    active: false,
  });
  member = await readMember(PRIMARY_ORGANISATION_ID, id);
  assert.equal(member.role, "Client", `another tenant's PATCH must not reach this member (status ${foreign.status})`);
  assert.equal(member.email, email, "nor its email");
  assert.equal(member.active, true, "nor its access");
  assert.equal(
    (await workspace(DEMO_ORGANISATION_ID)).body.workspace.team.some((m) => m.id === id),
    false,
    "and the member never appears in the other tenant",
  );
});
