/**
 * Tenancy isolation, proved against a real database.
 *
 * These are the tests that replace row-level security. Because the API now
 * connects to Postgres as a single role, nothing below the application layer
 * will stop a missing `where` clause from returning another client's jobs — so
 * the predicates in `access.ts` are exercised here directly, against real rows,
 * rather than reviewed by eye.
 *
 * Each case states what the caller must NOT see as well as what they must, and
 * the negative half is the half that matters.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import {
  canActOnMember,
  canDecideQuotes,
  canGrantRole,
  canManageMembers,
  canSeeMoney,
  scopeFor,
  siteScopeFor,
  withScope,
  type Actor,
  type Role,
} from "../src/lib/access.ts";
import { hashPassword, verifyPassword, needsRehash } from "../src/lib/passwords.ts";
import {
  createSession,
  hashToken,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "../src/lib/sessions.ts";

let db: Db;
const ids: Record<string, string> = {};

before(async () => {
  db = await createTestDb();

  const org = async (name: string, slug: string) =>
    (
      await db.query<{ id: string }>(
        "insert into organisations (name, slug) values ($1,$2) returning id::text",
        [name, slug],
      )
    )[0].id;

  const site = async (orgId: string, name: string) =>
    (
      await db.query<{ id: string }>(
        "insert into sites (organisation_id, name) values ($1,$2) returning id::text",
        [orgId, name],
      )
    )[0].id;

  ids.orgA = await org("Client A", "client-a");
  ids.orgB = await org("Client B", "client-b");
  ids.siteA1 = await site(ids.orgA, "A — Bullring");
  ids.siteA2 = await site(ids.orgA, "A — Touchwood");
  ids.siteB1 = await site(ids.orgB, "B — Meadowhall");

  ids.contractor1 = (
    await db.query<{ id: string }>(
      "insert into contractors (name) values ('Acme Repairs') returning id::text",
    )
  )[0].id;
  ids.contractor2 = (
    await db.query<{ id: string }>(
      "insert into contractors (name) values ('Rival Repairs') returning id::text",
    )
  )[0].id;

  const job = async (
    orgId: string,
    siteId: string | null,
    title: string,
    contractorId: string | null = null,
  ) =>
    (
      await db.query<{ id: string }>(
        `insert into jobs (organisation_id, site_id, title, description, contractor_id)
         values ($1,$2,$3,'seed',$4) returning id::text`,
        [orgId, siteId, title, contractorId],
      )
    )[0].id;

  ids.jobA1 = await job(ids.orgA, ids.siteA1, "A1 lock", ids.contractor1);
  ids.jobA2 = await job(ids.orgA, ids.siteA2, "A2 light");
  ids.jobB1 = await job(ids.orgB, ids.siteB1, "B1 glass", ids.contractor2);
});

after(async () => {
  await db.close();
});

const actor = (over: Partial<Actor> & { role: Role }): Actor => ({
  profileId: "00000000-0000-0000-0000-000000000001",
  email: "test@example.com",
  status: "active",
  organisationId: null,
  contractorId: null,
  siteIds: [],
  ...over,
});

/** Runs a scoped `select` and returns the job titles that came back. */
async function visibleJobs(a: Actor): Promise<string[]> {
  const predicate = scopeFor(a, "j");
  const { sql, params } = withScope(
    "select j.title from jobs j",
    [],
    predicate,
  );
  const rows = await db.query<{ title: string }>(
    `${sql} order by j.title`,
    params,
  );
  return rows.map((r) => r.title);
}

describe("job visibility", () => {
  test("staff see every organisation", async () => {
    for (const role of ["owner", "super_admin", "admin"] as const) {
      assert.deepEqual(await visibleJobs(actor({ role })), [
        "A1 lock",
        "A2 light",
        "B1 glass",
      ]);
    }
  });

  test("client_admin sees their organisation and NOT the other", async () => {
    const seen = await visibleJobs(
      actor({ role: "client_admin", organisationId: ids.orgA }),
    );
    assert.deepEqual(seen, ["A1 lock", "A2 light"]);
    assert.ok(!seen.includes("B1 glass"), "client A read client B's job");
  });

  test("client_user sees only their own site", async () => {
    const seen = await visibleJobs(
      actor({
        role: "client_user",
        organisationId: ids.orgA,
        siteIds: [ids.siteA1],
      }),
    );
    assert.deepEqual(seen, ["A1 lock"]);
    // The sibling site inside the SAME organisation must not leak.
    assert.ok(!seen.includes("A2 light"), "client_user saw another site");
  });

  test("contractor sees only jobs assigned to them", async () => {
    const seen = await visibleJobs(
      actor({ role: "contractor", contractorId: ids.contractor1 }),
    );
    assert.deepEqual(seen, ["A1 lock"]);
    assert.ok(!seen.includes("B1 glass"), "contractor saw another contractor's job");
    assert.ok(!seen.includes("A2 light"), "contractor saw an unassigned job");
  });

  test("a pending or suspended account sees nothing, whatever its role", async () => {
    for (const status of ["pending_approval", "suspended"] as const) {
      assert.deepEqual(
        await visibleJobs(actor({ role: "owner", status })),
        [],
        `a ${status} owner still saw jobs`,
      );
    }
  });

  test("a client role with no scope is denied, not unrestricted", async () => {
    // The dangerous failure mode: a missing organisation falling through to
    // "no filter" and returning everything.
    assert.deepEqual(await visibleJobs(actor({ role: "client_admin" })), []);
    assert.deepEqual(
      await visibleJobs(actor({ role: "client_user", organisationId: ids.orgA })),
      [],
    );
    assert.deepEqual(await visibleJobs(actor({ role: "contractor" })), []);
  });

  test("a client_user cannot reach a site outside their organisation", async () => {
    // Scoped to a site they do not own — the organisation check must still bite.
    const seen = await visibleJobs(
      actor({
        role: "client_user",
        organisationId: ids.orgA,
        siteIds: [ids.siteB1],
      }),
    );
    assert.deepEqual(seen, []);
  });
});

describe("site visibility", () => {
  const siteNames = async (a: Actor) => {
    const { sql, params } = withScope(
      "select s.name from sites s",
      [],
      siteScopeFor(a, "s"),
    );
    const rows = await db.query<{ name: string }>(`${sql} order by s.name`, params);
    return rows.map((r) => r.name);
  };

  test("client_admin sees their sites only", async () => {
    assert.deepEqual(
      await siteNames(actor({ role: "client_admin", organisationId: ids.orgA })),
      ["A — Bullring", "A — Touchwood"],
    );
  });

  test("a contractor gets no site register at all", async () => {
    assert.deepEqual(
      await siteNames(actor({ role: "contractor", contractorId: ids.contractor1 })),
      [],
    );
  });
});

describe("capabilities", () => {
  test("contractors never see money", () => {
    assert.equal(canSeeMoney(actor({ role: "contractor", contractorId: "x" })), false);
    assert.equal(canSeeMoney(actor({ role: "client_user" })), true);
    assert.equal(canSeeMoney(actor({ role: "admin" })), true);
  });

  test("only staff and client_admin decide quotes", () => {
    assert.equal(canDecideQuotes(actor({ role: "client_admin" })), true);
    assert.equal(canDecideQuotes(actor({ role: "admin" })), true);
    assert.equal(canDecideQuotes(actor({ role: "client_user" })), false);
    assert.equal(canDecideQuotes(actor({ role: "contractor" })), false);
  });

  test("only staff manage members", () => {
    assert.equal(canManageMembers(actor({ role: "admin" })), true);
    assert.equal(canManageMembers(actor({ role: "client_admin" })), false);
  });
});

describe("the owner account is untouchable", () => {
  const owner = actor({ role: "owner", email: "anwarrshboul@gmail.com" });

  test("nobody may modify it — including the owner", () => {
    for (const who of ["owner", "super_admin", "admin"] as const) {
      const result = canActOnMember(actor({ role: who }), {
        email: "anwarrshboul@gmail.com",
        role: "owner",
      });
      assert.equal(result.allowed, false, `${who} was allowed to modify the owner`);
    }
    // Case and whitespace must not be a way around it.
    assert.equal(
      canActOnMember(owner, { email: "  Anwarrshboul@Gmail.com  ", role: "owner" })
        .allowed,
      false,
    );
  });

  test("an admin cannot act on a super_admin", () => {
    assert.equal(
      canActOnMember(actor({ role: "admin" }), {
        email: "s@x.com",
        role: "super_admin",
      }).allowed,
      false,
    );
  });

  test("two admins cannot deactivate each other", () => {
    assert.equal(
      canActOnMember(actor({ role: "admin" }), { email: "a2@x.com", role: "admin" })
        .allowed,
      false,
    );
  });

  test("an admin may act on client roles", () => {
    assert.equal(
      canActOnMember(actor({ role: "admin" }), {
        email: "c@x.com",
        role: "client_admin",
      }).allowed,
      true,
    );
  });
});

describe("privilege escalation is refused", () => {
  test("nobody can grant owner", () => {
    for (const who of ["owner", "super_admin", "admin"] as const) {
      assert.equal(canGrantRole(actor({ role: who }), "owner"), false);
    }
  });

  test("an admin cannot invite a super_admin or another admin", () => {
    const admin = actor({ role: "admin" });
    assert.equal(canGrantRole(admin, "super_admin"), false);
    assert.equal(canGrantRole(admin, "admin"), false);
    assert.equal(canGrantRole(admin, "client_admin"), true);
  });

  test("a client_admin cannot grant anything", () => {
    for (const role of ["admin", "client_admin", "client_user"] as const) {
      assert.equal(canGrantRole(actor({ role: "client_admin" }), role), false);
    }
  });
});

describe("passwords", () => {
  test("a correct password verifies and a wrong one does not", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
    assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
  });

  test("no password never verifies", async () => {
    // An invited user before they choose one. "No password" must not mean
    // "any password".
    for (const stored of [null, undefined, "", "garbage", "scrypt$x"]) {
      assert.equal(await verifyPassword("anything", stored), false);
    }
  });

  test("the same password hashes differently each time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same input"),
      hashPassword("same input"),
    ]);
    assert.notEqual(a, b, "salts are not random");
    assert.equal(await verifyPassword("same input", a), true);
    assert.equal(await verifyPassword("same input", b), true);
  });

  test("weaker stored parameters are flagged for rehash", async () => {
    assert.equal(needsRehash(await hashPassword("x")), false);
    assert.equal(needsRehash("scrypt$1024$8$1$c2FsdA$aGFzaA"), true);
    assert.equal(needsRehash("pbkdf2$210000$..."), true);
  });
});

describe("sessions", () => {
  let userId: string;

  before(async () => {
    userId = (
      await db.query<{ id: string }>(
        "insert into users (email, password_hash) values ('sess@test.local','x') returning id::text",
      )
    )[0].id;
    await db.query(
      `insert into profiles (id, email, role, status, organisation_id)
       values ($1, 'sess@test.local', 'client_admin', 'active', $2)`,
      [userId, ids.orgA],
    );
    await db.query(
      "insert into profile_sites (profile_id, site_id) values ($1,$2)",
      [userId, ids.siteA1],
    );
  });

  test("a fresh token resolves to the right actor and scope", async () => {
    const { token } = await createSession(db, userId, { persistent: true });
    const resolved = await resolveSession(db, token);
    assert.ok(resolved, "a valid session did not resolve");
    assert.equal(resolved.actor.role, "client_admin");
    assert.equal(resolved.actor.organisationId, ids.orgA);
    assert.deepEqual(resolved.actor.siteIds, [ids.siteA1]);
  });

  test("garbage and absent tokens resolve to null", async () => {
    assert.equal(await resolveSession(db, undefined), null);
    assert.equal(await resolveSession(db, ""), null);
    assert.equal(await resolveSession(db, "not-a-real-token"), null);
  });

  test("the raw token is never stored", async () => {
    const { token } = await createSession(db, userId);
    const hit = await db.query(
      "select 1 from sessions where token_hash = $1",
      [token],
    );
    assert.equal(hit.length, 0, "the raw token was stored");
    assert.ok(await resolveSession(db, token), "but it still authenticates");
  });

  test("a revoked session stops working immediately", async () => {
    const { token } = await createSession(db, userId);
    const resolved = await resolveSession(db, token);
    assert.ok(resolved);
    await revokeSession(db, resolved.sessionId);
    assert.equal(await resolveSession(db, token), null);
  });

  test("sign out everywhere revokes every session", async () => {
    const a = await createSession(db, userId);
    const b = await createSession(db, userId);
    await revokeAllSessions(db, userId);
    assert.equal(await resolveSession(db, a.token), null);
    assert.equal(await resolveSession(db, b.token), null);
  });

  test("an expired session does not resolve", async () => {
    const { token } = await createSession(db, userId);
    // Hashed through the module's own helper rather than re-implemented in SQL:
    // a second copy of the hashing rule in a test is a copy that can disagree
    // with the one being tested.
    await db.query(
      "update sessions set expires_at = now() - interval '1 second' where token_hash = $1",
      [hashToken(token)],
    );
    assert.equal(await resolveSession(db, token), null);
  });

  test("a user with no profile row does not authenticate", async () => {
    const orphan = (
      await db.query<{ id: string }>(
        "insert into users (email) values ('orphan@test.local') returning id::text",
      )
    )[0].id;
    const { token } = await createSession(db, orphan);
    assert.equal(
      await resolveSession(db, token),
      null,
      "an unprovisioned user got a live session",
    );
  });
});
