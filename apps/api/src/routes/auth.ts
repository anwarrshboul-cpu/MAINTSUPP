import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "../../../../packages/db/src/client.ts";
import {
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from "../lib/passwords.ts";
import {
  createSession,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "../lib/sessions.ts";
import { hashOneTimeToken, provisionProfile } from "../lib/provision.ts";
import { sendMailBestEffort, templates } from "../lib/mail.ts";
import {
  clearSessionCookieHeader,
  clientIp,
  email as normaliseEmail,
  isEmail,
  padTo,
  rateLimit,
  readSessionCookie,
  sessionCookieHeader,
  str,
} from "../lib/http.ts";

type Env = { Variables: { db: Db } };

const webUrl = () =>
  (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/** Sign-in throttling. Locks the account, not just the address. */
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

export const auth = new Hono<Env>();

/* ------------------------------------------------------------- register -- */

auth.post("/register", async (c) => {
  const startedAt = Date.now();
  const db = c.get("db");
  const body = await c.req.json().catch(() => ({}));

  const address = normaliseEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = str(body.fullName, 120);
  const phone = str(body.phone, 40);

  // Honeypot: hidden from people, irresistible to bots. Answered with the same
  // shape a real signup gets, so there is nothing to learn from the difference.
  if (str(body.company, 100)) return c.json({ ok: true, verificationSent: true });

  const limit = rateLimit(`register:${clientIp(c) ?? "unknown"}`, 5, 60 * 60_000);
  if (!limit.ok) {
    return c.json(
      { error: "Too many attempts. Try again later." },
      429,
      { "retry-after": String(limit.retryAfter) },
    );
  }

  if (!isEmail(address)) return c.json({ error: "Enter a valid email address." }, 400);
  if (!fullName) return c.json({ error: "Enter your full name." }, 400);
  const problem = passwordProblem(password);
  if (problem) return c.json({ error: problem }, 400);

  const passwordHash = await hashPassword(password);
  const verifyToken = randomBytes(32).toString("base64url");

  let created = false;
  await db.transaction(async (tx) => {
    const [existing] = await tx.query<{ id: string }>(
      "select id::text from users where lower(email) = $1",
      [address],
    );
    // An address that already exists is not reported back — that would turn
    // this endpoint into an account-enumeration oracle. The real owner gets an
    // email telling them someone tried.
    if (existing) return;

    const [user] = await tx.query<{ id: string }>(
      `insert into users (email, password_hash, verify_token_hash, verify_expires_at)
       values ($1, $2, $3, now() + interval '24 hours') returning id::text`,
      [address, passwordHash, hashOneTimeToken(verifyToken)],
    );

    await provisionProfile(tx, user.id, address);
    await tx.query(
      "update profiles set full_name = $2, phone = nullif($3,'') where id = $1",
      [user.id, fullName, phone],
    );
    created = true;
  });

  if (created) {
    sendMailBestEffort({
      to: address,
      ...templates.verifyEmail(`${webUrl()}/portal/verify?token=${verifyToken}`),
    });
  } else {
    sendMailBestEffort({
      to: address,
      subject: "Someone tried to create a MAINTSUPP account with your address",
      text: `An account already exists for this address. If that was you, sign in at ${webUrl()}/portal — or reset your password from that page.`,
    });
  }

  await padTo(startedAt);
  return c.json({ ok: true, verificationSent: true });
});

/* -------------------------------------------------------------- sign in -- */

auth.post("/sign-in", async (c) => {
  const startedAt = Date.now();
  const db = c.get("db");
  const body = await c.req.json().catch(() => ({}));

  const address = normaliseEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  // Checked by default: absent means ticked, not unticked.
  const persistent = body.persistent !== false;

  const limit = rateLimit(`signin:${clientIp(c) ?? "unknown"}`, 20, 15 * 60_000);
  if (!limit.ok) {
    return c.json(
      { error: "Too many attempts. Try again shortly." },
      429,
      { "retry-after": String(limit.retryAfter) },
    );
  }

  if (!address || !password) {
    await padTo(startedAt);
    return c.json({ error: "Enter your email address and password." }, 400);
  }

  const [user] = await db.query<{
    id: string;
    password_hash: string | null;
    email_verified_at: string | null;
    failed_attempts: number;
    locked_until: string | null;
  }>(
    `select id::text, password_hash, email_verified_at::text,
            failed_attempts, locked_until::text
       from users where lower(email) = $1`,
    [address],
  );

  /*
   * One failure message for every cause.
   *
   * No such account, wrong password and no password set are indistinguishable
   * from out here. Telling them apart is what lets somebody test a list of
   * addresses against the product to find out who the client's staff are.
   */
  const refuse = async () => {
    await padTo(startedAt);
    return c.json(
      { error: "That email address and password do not match an account." },
      401,
    );
  };

  if (!user) return refuse();

  /*
   * A locked account answers exactly as a wrong password does.
   *
   * `failed_attempts` only increments for rows that exist, so a distinct
   * lock-out message meant the ninth wrong guess told an attacker whether the
   * address was real — undoing the uniform-failure rule this handler spends a
   * comment block establishing. The lock still applies; it is just no longer
   * announced. Someone genuinely locked out uses the reset link, which is
   * offered on the sign-in page to everybody regardless.
   */
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return refuse();
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const attempts = user.failed_attempts + 1;
    /*
     * Every placeholder is cast explicitly.
     *
     * Without the casts Postgres sees `$2` as both an integer column value and
     * one side of a comparison, cannot deduce a single type, and rejects the
     * statement with "inconsistent types deduced for parameter $2" — which
     * surfaces as a 500 on the sign-in path, turning a wrong password into a
     * server error and defeating the uniform-failure rule above.
     */
    await db.query(
      `update users
          set failed_attempts = $2::int,
              locked_until = case
                when $2::int >= $3::int
                then now() + make_interval(mins => $4::int)
                else null
              end
        where id = $1`,
      [user.id, attempts, MAX_FAILURES, LOCK_MINUTES],
    );
    return refuse();
  }

  // Email verification is required, but it is told apart from a bad password:
  // the user demonstrably knows their own credentials, and leaving them at
  // "wrong password" when the password was right is a support ticket.
  if (!user.email_verified_at) {
    await padTo(startedAt);
    return c.json(
      {
        error: "Confirm your email address first — check your inbox for the link.",
        needsVerification: true,
      },
      403,
    );
  }

  await db.query(
    "update users set failed_attempts = 0, locked_until = null, last_seen_at = now() where id = $1",
    [user.id],
  );

  // Transparent upgrade: the cost parameters can be raised later without
  // locking anybody out or asking them to change their password.
  if (needsRehash(user.password_hash)) {
    await db.query("update users set password_hash = $2 where id = $1", [
      user.id,
      await hashPassword(password),
    ]);
  }

  const session = await createSession(db, user.id, {
    persistent,
    userAgent: c.req.header("user-agent"),
    ip: clientIp(c),
  });

  const resolved = await resolveSession(db, session.token);
  c.header(
    "set-cookie",
    sessionCookieHeader(session.token, session.expiresAt, persistent),
  );

  if (!resolved) {
    // Authenticated but unprovisioned. Fails closed rather than handing over a
    // session whose capabilities nothing has decided.
    return c.json({ ok: true, status: "pending_approval" });
  }

  return c.json({
    ok: true,
    status: resolved.actor.status,
    profile: {
      role: resolved.actor.role,
      email: resolved.actor.email,
      organisationId: resolved.actor.organisationId,
    },
  });
});

/* -------------------------------------------------------------- session -- */

auth.get("/me", async (c) => {
  const db = c.get("db");
  const resolved = await resolveSession(db, readSessionCookie(c));
  if (!resolved) return c.json({ authenticated: false }, 401);

  const [profile] = await db.query<{ full_name: string | null; phone: string | null }>(
    "select full_name, phone from profiles where id = $1",
    [resolved.actor.profileId],
  );

  return c.json({
    authenticated: true,
    actor: resolved.actor,
    fullName: profile?.full_name ?? null,
    phone: profile?.phone ?? null,
  });
});

auth.post("/sign-out", async (c) => {
  const db = c.get("db");
  const resolved = await resolveSession(db, readSessionCookie(c));
  if (resolved) await revokeSession(db, resolved.sessionId);
  // The cookie is cleared either way: a request with an already-invalid session
  // should still leave the browser in a signed-out state.
  c.header("set-cookie", clearSessionCookieHeader());
  return c.json({ ok: true });
});

auth.post("/sign-out-everywhere", async (c) => {
  const db = c.get("db");
  const resolved = await resolveSession(db, readSessionCookie(c));
  if (!resolved) return c.json({ error: "Not signed in." }, 401);
  const count = await revokeAllSessions(db, resolved.actor.profileId);
  c.header("set-cookie", clearSessionCookieHeader());
  return c.json({ ok: true, revoked: count });
});

/* --------------------------------------------------------- verification -- */

auth.post("/verify", async (c) => {
  const db = c.get("db");
  const token = str((await c.req.json().catch(() => ({}))).token, 200);
  if (!token) return c.json({ error: "That link was not complete." }, 400);

  const [user] = await db.query<{ id: string }>(
    `update users set email_verified_at = now(),
            verify_token_hash = null, verify_expires_at = null
      where verify_token_hash = $1 and verify_expires_at > now()
      returning id::text`,
    [hashOneTimeToken(token)],
  );

  if (!user) {
    return c.json(
      { error: "That link has expired or was already used." },
      400,
    );
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------ password recovery -- */

auth.post("/forgot", async (c) => {
  const startedAt = Date.now();
  const db = c.get("db");
  const address = normaliseEmail((await c.req.json().catch(() => ({}))).email);

  const limit = rateLimit(`forgot:${clientIp(c) ?? "unknown"}`, 5, 60 * 60_000);
  if (!limit.ok) {
    return c.json({ error: "Too many requests. Try again later." }, 429);
  }
  if (!isEmail(address)) return c.json({ error: "Enter a valid email address." }, 400);

  const token = randomBytes(32).toString("base64url");
  const [user] = await db.query<{ id: string }>(
    `update users set reset_token_hash = $2, reset_expires_at = now() + interval '1 hour'
      where lower(email) = $1 returning id::text`,
    [address, hashOneTimeToken(token)],
  );

  if (user) {
    sendMailBestEffort({
      to: address,
      ...templates.passwordReset(`${webUrl()}/portal/reset?token=${token}`),
    });
  }

  // Identical answer whether or not the address exists — see /register.
  await padTo(startedAt);
  return c.json({ ok: true });
});

auth.post("/reset", async (c) => {
  const db = c.get("db");
  const body = await c.req.json().catch(() => ({}));
  const token = str(body.token, 200);
  const password = typeof body.password === "string" ? body.password : "";

  if (!token) return c.json({ error: "That link was not complete." }, 400);
  const problem = passwordProblem(password);
  if (problem) return c.json({ error: problem }, 400);

  const passwordHash = await hashPassword(password);
  const [user] = await db.query<{ id: string }>(
    `update users
        set password_hash = $2,
            reset_token_hash = null,
            reset_expires_at = null,
            failed_attempts = 0,
            locked_until = null,
            -- Completing a reset proves control of the mailbox, so it also
            -- verifies the address. Otherwise an invited user who resets
            -- before verifying is stuck in a loop with no way out.
            email_verified_at = coalesce(email_verified_at, now())
      where reset_token_hash = $1 and reset_expires_at > now()
      returning id::text`,
    [hashOneTimeToken(token), passwordHash],
  );

  if (!user) {
    return c.json({ error: "That link has expired or was already used." }, 400);
  }

  /*
   * Every other session is ended.
   *
   * A password reset is what someone does when they think an account is
   * compromised. Leaving the intruder's session alive through it would make
   * the reset theatre.
   */
  await revokeAllSessions(db, user.id);
  return c.json({ ok: true });
});
