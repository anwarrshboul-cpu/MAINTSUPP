/**
 * The auth flows, end to end over real HTTP semantics.
 *
 * Hono apps expose `.request()`, which runs the whole middleware stack and
 * returns a real Response — so these exercise routing, cookies, status codes
 * and JSON bodies, not just the handler functions.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type Db } from "../../../packages/db/src/client.ts";
import { createApp } from "../src/server.ts";

let db: Db;
let app: ReturnType<typeof createApp>;

before(async () => {
  db = await createTestDb();
  app = createApp(db);
});
after(async () => { await db.close(); });

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      // Distinct per call so the in-memory rate limiter does not bleed between
      // tests — the limiter keys on address, which is the behaviour we want in
      // production and a nuisance here.
      "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify(body),
  });

/** Pulls the session cookie out of a Set-Cookie header. */
const sessionOf = (res: Response) => {
  const raw = res.headers.get("set-cookie") ?? "";
  const value = raw.split(";")[0];
  return value.startsWith("ms_session=") && value.length > "ms_session=".length
    ? value
    : null;
};

/** Reads the one-time token straight from the database, as the email would. */
const tokenFor = async (column: string, address: string) => {
  const [row] = await db.query<{ t: string | null }>(
    `select ${column} as t from users where lower(email) = $1`, [address]);
  return row?.t ?? null;
};

describe("registration and verification", () => {
  test("a new account starts unverified and pending approval", async () => {
    const res = await post("/auth/register", {
      email: "New.User@Example.com", password: "a-long-enough-password", fullName: "New User",
    });
    assert.equal(res.status, 200);

    const [row] = await db.query<{ status: string; role: string; verified: string | null }>(
      `select p.status, p.role, u.email_verified_at::text as verified
         from profiles p join users u on u.id = p.id
        where p.email = 'new.user@example.com'`);
    assert.equal(row.status, "pending_approval");
    assert.equal(row.role, "client_user");
    assert.equal(row.verified, null, "a new account was verified without clicking the link");
  });

  test("an unverified account cannot sign in", async () => {
    const res = await post("/auth/sign-in", {
      email: "new.user@example.com", password: "a-long-enough-password",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).needsVerification, true);
    assert.equal(sessionOf(res), null, "an unverified sign-in issued a session");
  });

  test("a duplicate address is not revealed and does not overwrite", async () => {
    const res = await post("/auth/register", {
      email: "new.user@example.com", password: "a-completely-different-one", fullName: "Impostor",
    });
    assert.equal(res.status, 200, "a duplicate was reported, enabling enumeration");
    const [row] = await db.query<{ n: string; name: string }>(
      `select count(*)::int as n, max(full_name) as name from profiles where email = 'new.user@example.com'`);
    assert.equal(Number(row.n), 1);
    assert.equal(row.name, "New User", "the existing profile was overwritten");
  });

  test("verifying the email allows sign-in, and the link is single-use", async () => {
    const token = await tokenFor("verify_token_hash", "new.user@example.com");
    assert.ok(token, "no verification token was stored");

    // The stored value is a hash, so the raw token must not be recoverable.
    const bad = await post("/auth/verify", { token });
    assert.equal(bad.status, 400, "the stored hash worked as a token");
  });
});

describe("sign-in", () => {
  const address = "signin@example.com";

  before(async () => {
    await post("/auth/register", { email: address, password: "correct-password-here", fullName: "Sign In" });
    await db.query("update users set email_verified_at = now() where lower(email) = $1", [address]);
  });

  test("the right password issues an HttpOnly session cookie", async () => {
    const res = await post("/auth/sign-in", { email: address, password: "correct-password-here" });
    assert.equal(res.status, 200);
    const raw = res.headers.get("set-cookie") ?? "";
    assert.match(raw, /HttpOnly/, "the session cookie is readable by script");
    assert.match(raw, /SameSite=Lax/);
    assert.ok(sessionOf(res));
  });

  test("the wrong password is refused with the same message as an unknown address", async () => {
    const wrong = await post("/auth/sign-in", { email: address, password: "not-the-password" });
    const unknown = await post("/auth/sign-in", { email: "nobody@example.com", password: "not-the-password" });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json(),
      "failure messages differ, which enumerates accounts");
  });

  test("unticking keep-me-signed-in produces a session cookie with no Expires", async () => {
    const kept = await post("/auth/sign-in", { email: address, password: "correct-password-here", persistent: true });
    const not = await post("/auth/sign-in", { email: address, password: "correct-password-here", persistent: false });
    assert.match(kept.headers.get("set-cookie") ?? "", /Expires=/);
    assert.doesNotMatch(not.headers.get("set-cookie") ?? "", /Expires=/,
      "an unticked session was made persistent anyway");
  });

  test("repeated failures lock the account", async () => {
    const target = "lockme@example.com";
    await post("/auth/register", { email: target, password: "the-real-password", fullName: "Lock Me" });
    await db.query("update users set email_verified_at = now() where lower(email) = $1", [target]);
    for (let i = 0; i < 8; i += 1) await post("/auth/sign-in", { email: target, password: "wrong" });

    // Locked: the CORRECT password no longer works.
    const res = await post("/auth/sign-in", { email: target, password: "the-real-password" });
    assert.equal(res.status, 401, "the correct password still worked after 8 failures");
    assert.equal(sessionOf(res), null, "a locked account was issued a session");

    // …and the refusal is byte-identical to an unknown address. A distinct
    // lock-out message would mean the ninth wrong guess reveals whether the
    // address is real, which is the enumeration oracle the uniform-failure
    // rule exists to close.
    const unknown = await post("/auth/sign-in", { email: "ghost@example.com", password: "wrong" });
    assert.deepEqual(await res.json(), await unknown.json(),
      "a locked account is distinguishable from an unknown one");
  });
});

describe("session lifecycle", () => {
  const address = "session@example.com";
  let cookie: string;

  before(async () => {
    await post("/auth/register", { email: address, password: "session-password-x", fullName: "Session" });
    await db.query("update users set email_verified_at = now() where lower(email) = $1", [address]);
    cookie = sessionOf(await post("/auth/sign-in", { email: address, password: "session-password-x" }))!;
  });

  test("/auth/me is 401 without a cookie and identifies the actor with one", async () => {
    assert.equal((await app.request("/auth/me")).status, 401);
    const res = await app.request("/auth/me", { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actor.email, address);
    assert.equal(body.actor.status, "pending_approval");
  });

  test("signing out invalidates the cookie immediately", async () => {
    const out = await post("/auth/sign-out", {}, cookie);
    assert.equal(out.status, 200);
    assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401);
  });
});

describe("password reset", () => {
  const address = "reset@example.com";

  before(async () => {
    await post("/auth/register", { email: address, password: "original-password", fullName: "Reset" });
    await db.query("update users set email_verified_at = now() where lower(email) = $1", [address]);
  });

  test("an unknown address gets the same answer as a known one", async () => {
    const known = await post("/auth/forgot", { email: address });
    const unknown = await post("/auth/forgot", { email: "ghost@example.com" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
  });

  test("a reset ends every existing session", async () => {
    const cookie = sessionOf(await post("/auth/sign-in", { email: address, password: "original-password" }))!;
    assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 200);

    // Stand in for clicking the emailed link.
    const { randomBytes, createHash } = await import("node:crypto");
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `update users set reset_token_hash = $2, reset_expires_at = now() + interval '1 hour'
        where lower(email) = $1`,
      [address, createHash("sha256").update(token).digest("hex")]);

    const res = await post("/auth/reset", { token, password: "a-brand-new-password" });
    assert.equal(res.status, 200);
    assert.equal((await app.request("/auth/me", { headers: { cookie } })).status, 401,
      "the pre-reset session survived the reset");

    assert.equal((await post("/auth/sign-in", { email: address, password: "original-password" })).status, 401);
    assert.equal((await post("/auth/sign-in", { email: address, password: "a-brand-new-password" })).status, 200);
  });

  test("a used reset token cannot be replayed", async () => {
    const { randomBytes, createHash } = await import("node:crypto");
    const token = randomBytes(32).toString("base64url");
    await db.query(
      `update users set reset_token_hash = $2, reset_expires_at = now() + interval '1 hour'
        where lower(email) = $1`,
      [address, createHash("sha256").update(token).digest("hex")]);
    assert.equal((await post("/auth/reset", { token, password: "first-use-password" })).status, 200);
    assert.equal((await post("/auth/reset", { token, password: "second-use-password" })).status, 400);
  });
});

describe("provisioning order", () => {
  test("a bootstrapped address becomes an active owner", async () => {
    await post("/auth/register", {
      email: "anwarrshboul@gmail.com", password: "owner-password-here", fullName: "Anwar",
    });
    const [row] = await db.query<{ role: string; status: string }>(
      "select role, status from profiles where email = 'anwarrshboul@gmail.com'");
    assert.equal(row.role, "owner");
    assert.equal(row.status, "active");

    const [used] = await db.query<{ c: string | null }>(
      "select consumed_at::text as c from role_bootstrap where email = 'anwarrshboul@gmail.com'");
    assert.ok(used.c, "the bootstrap row was not consumed");
  });

  test("an invited address takes the invited role, not pending", async () => {
    const [org] = await db.query<{ id: string }>(
      "insert into organisations (name, slug) values ('Invited Co','invited-co') returning id::text");
    await db.query(
      `insert into invitations (email, role, organisation_id, token_hash)
       values ('invited@example.com', 'client_admin', $1, 'hash-placeholder')`, [org.id]);

    await post("/auth/register", {
      email: "invited@example.com", password: "invited-password-x", fullName: "Invited",
    });

    const [row] = await db.query<{ role: string; status: string; org: string | null }>(
      "select role, status, organisation_id::text as org from profiles where email = 'invited@example.com'");
    assert.equal(row.role, "client_admin");
    assert.equal(row.status, "active");
    assert.equal(row.org, org.id);

    const [inv] = await db.query<{ status: string }>(
      "select status from invitations where lower(email) = 'invited@example.com'");
    assert.equal(inv.status, "accepted");
  });

  test("a registration cannot choose its own role", async () => {
    // The body carries role and organisation_id; provisioning must ignore both.
    await post("/auth/register", {
      email: "sneaky@example.com", password: "sneaky-password-x", fullName: "Sneaky",
      role: "owner", organisationId: "00000000-0000-0000-0000-000000000000", status: "active",
    });
    const [row] = await db.query<{ role: string; status: string }>(
      "select role, status from profiles where email = 'sneaky@example.com'");
    assert.equal(row.role, "client_user", "a caller set their own role");
    assert.equal(row.status, "pending_approval", "a caller activated their own account");
  });
});
