/**
 * Sessions — Stage 20. The thing that finally makes "who are you" a fact.
 *
 * Until this file existed, identity was whatever the browser said it was: a
 * `maintsupp_demo_identity` cookie the client set for itself. Every tenancy rule
 * in `tenant-access.ts` was already correct and already enforced against the
 * database — they were just all anchored to a claim nobody checked. This module
 * supplies the missing anchor, and `resolveIdentityCandidates` now prefers it
 * over anything in a cookie.
 *
 * The shape of the guarantee:
 *
 *   - The cookie holds a 256-bit random token. The database holds only its
 *     SHA-256 hash. A stolen database dump therefore contains no usable
 *     credential — you cannot log in with a hash, and you cannot invert one.
 *   - The cookie is HttpOnly (script cannot read it, so an XSS bug cannot
 *     exfiltrate a session), SameSite=Lax (a third-party form post cannot ride
 *     it, which is the CSRF case that matters here) and Secure whenever the
 *     request arrived over https.
 *   - Two clocks. `expires_at` is absolute: a session dies thirty days after it
 *     was issued no matter how active it is, so a token that quietly leaked
 *     cannot be used forever. `last_seen_at` is the sliding one: seven days of
 *     silence ends the session, so an abandoned laptop stops being a way in.
 *   - Sign-out stamps `revoked_at`. It never deletes. A deleted row cannot be
 *     distinguished from a row that never existed, and "when did they sign out
 *     of that device" is exactly the question an audit trail has to answer.
 *
 * Everything here fails closed. Any error resolving a session is treated as
 * "not signed in" — never as "assume the previous answer", and emphatically
 * never as "assume an administrator". That is why every read path is wrapped
 * and returns null rather than propagating.
 *
 * WHY raw D1 rather than drizzle. The Stage 20 credential columns
 * (`password_hash`, `status`, `last_login_at`, …) were added to `users` by
 * `ensureStageTwentyAccounts` in `db/init.ts` and are not declared in
 * `db/schema.ts`, so drizzle's `users` object cannot see them. Reaching for the
 * D1 binding directly keeps this module honest about what it is reading instead
 * of half-using an ORM that is missing the half that matters.
 */

import { getD1 } from "../../db";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { workspaceCookieValue } from "./workspace-actor";

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

/** The session cookie. Named for the product so it is obvious in devtools. */
export const SESSION_COOKIE = "maintsupp_session";

/** Absolute ceiling. A session cannot outlive this even if used constantly. */
const ABSOLUTE_LIFETIME_MS = 30 * 86_400_000;

/** Sliding window. Silence for this long ends the session. */
const IDLE_LIFETIME_MS = 7 * 86_400_000;

/**
 * How stale `last_seen_at` may get before it is written again.
 *
 * Without this, every authenticated request would issue a write purely to
 * record that it happened. The sliding window is measured in days, so
 * five-minute granularity costs nothing and removes a write from the hot path.
 */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type SessionUser = {
  id: string;
  email: string;
  fullName: string | null;
  /** Best available human label — full name, else the local part of the email. */
  displayName: string;
  /** The free-text label on `users.role` ("Super Admin"). Not an authority. */
  role: string;
  /** The user's home organisation. Access still comes from `memberships`. */
  organisationId: string | null;
  status: string;
  jobTitle: string | null;
  phone: string | null;
  timezone: string;
  avatarColour: string | null;
  themePreference: string;
  workingStatus: string | null;
  lastLoginAt: string | null;
  passwordUpdatedAt: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  organisationId: string | null;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
};

/** What a valid session resolves to. The exported contract other routes use. */
export type AuthenticatedSession = {
  user: SessionUser;
  session: SessionRecord;
  /** The organisation this session last selected, if it has selected one. */
  organisationId: string | null;
};

/** Thrown by `requireSession`. Carries the status a route should return. */
export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * SHA-256, hex.
 *
 * The session token is already 256 bits of uniform randomness, so it is not
 * guessable and does not need a slow KDF the way a password does — the only job
 * here is to make the stored value useless if the table leaks. Same reasoning,
 * and same function, as the contractor job links in `job-tokens.ts`.
 */
export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 32 bytes from the CSPRNG, hex encoded.
 *
 * Returned to the caller exactly once, to be put in a cookie. It is never
 * stored, never logged and never included in a response body.
 */
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parses a timestamp column into epoch milliseconds.
 *
 * D1's `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone
 * marker, and `new Date()` reads that as *local* time. On a machine an hour off
 * UTC every expiry comparison in this file would silently shift by an hour —
 * in the wrong direction half the year. The zone is therefore made explicit
 * before parsing. Everything this module writes uses `toISOString()` so the
 * ambiguity does not arise for new rows either.
 */
function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** True when the request reached us over https, directly or via a proxy. */
function isSecureRequest(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The `Set-Cookie` value for a freshly issued session.
 *
 * `Secure` is conditional rather than always-on because local development is
 * plain http, and a `Secure` cookie is simply dropped there — which would make
 * sign-in appear to succeed and then silently do nothing. Conditioning it on
 * the scheme keeps production strict without making localhost unusable.
 */
export function sessionCookie(token: string, request: Request) {
  const maxAge = Math.floor(ABSOLUTE_LIFETIME_MS / 1000);
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** The `Set-Cookie` value that clears the session cookie. */
export function expiredSessionCookie(request: Request) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

/** The client IP, as far as the edge is willing to tell us. */
export function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function normaliseEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 200) : "";
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * Failed sign-in throttling, in the database.
 *
 * This was a `Map` in module scope, and the comment here said plainly what that
 * meant: one Worker isolate's memory. Cloudflare runs many isolates and
 * recycles them freely, so five attempts per isolate is not five attempts — an
 * attacker spread across enough connections gets a multiple of `MAX_FAILURES`,
 * and a redeploy zeroed every counter. It was a speed bump, and it is the one
 * security item that goes live the moment this deploys.
 *
 * D1 is the shared store the app already has. It is the same database every
 * isolate reads for the credential itself, so a counter there is seen by all of
 * them and survives both recycling and deployment. A Durable Object would give
 * stronger serialisation, but it needs a binding this project cannot add and
 * deploy today, and correctness here does not depend on it: the counter is
 * incremented by a single `ON CONFLICT DO UPDATE` statement, which SQLite
 * applies atomically, so two simultaneous failures cannot both read 4 and
 * write 5.
 *
 * Keyed on email *and* IP together: keying on email alone would let anyone
 * lock a colleague out by guessing at their address, converting a brute-force
 * defence into a denial-of-service tool.
 *
 * Every function takes `d1` rather than reaching for it, so the caller's
 * database — and therefore the caller's tenant — is the one that counts.
 */
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

/*
 * Pruning is probabilistic, roughly one write in twenty.
 *
 * The table is fed by attacker-chosen emails, so it has to be bounded, but a
 * DELETE on every failure doubles the write cost of the hot path. One in
 * twenty keeps the table swept without paying for it every time; expired rows
 * are ignored by the read regardless of whether they have been collected yet,
 * so a late sweep is a storage question, never a correctness one.
 */
const PRUNE_CHANCE = 0.05;

function failureKey(email: string, ip: string) {
  return `${normaliseEmail(email)}|${ip}`;
}

/** Seconds the caller must wait, or 0 when they may try now. */
export async function signInRetryAfter(
  d1: D1DatabaseLike,
  email: string,
  ip: string,
): Promise<number> {
  const row = (await d1
    .prepare("SELECT blocked_until FROM sign_in_failures WHERE key = ?")
    .bind(failureKey(email, ip))
    .first()
    .catch(() => null)) as { blocked_until?: number | null } | null;

  const blockedUntil = Number(row?.blocked_until ?? 0);
  const remaining = blockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export async function recordSignInFailure(
  d1: D1DatabaseLike,
  email: string,
  ip: string,
) {
  const now = Date.now();
  const key = failureKey(email, ip);

  /*
   * One statement, so the read-modify-write cannot interleave.
   *
   * The window restart, the increment and the lockout are all expressed as
   * CASE arms over the row's own columns. Doing this as SELECT-then-UPDATE in
   * two round trips is what would let two concurrent failures both observe
   * four and both write five, which is exactly the race the isolate-local Map
   * never had to think about and a shared store does.
   */
  await d1
    .prepare(
      `INSERT INTO sign_in_failures (key, count, first_at, blocked_until)
       VALUES (?1, 1, ?2, 0)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN ?2 - sign_in_failures.first_at > ?3 THEN 1
           WHEN sign_in_failures.count + 1 >= ?4 THEN 0
           ELSE sign_in_failures.count + 1
         END,
         first_at = CASE
           WHEN ?2 - sign_in_failures.first_at > ?3 THEN ?2
           WHEN sign_in_failures.count + 1 >= ?4 THEN ?2
           ELSE sign_in_failures.first_at
         END,
         blocked_until = CASE
           WHEN ?2 - sign_in_failures.first_at > ?3 THEN 0
           WHEN sign_in_failures.count + 1 >= ?4 THEN ?2 + ?5
           ELSE sign_in_failures.blocked_until
         END`,
    )
    .bind(key, now, FAILURE_WINDOW_MS, MAX_FAILURES, LOCKOUT_MS)
    .run()
    .catch(() => {
      // A throttling write that fails must not take sign-in down with it. The
      // attempt is still refused on its own merits by `checkPassword`; what is
      // lost is the counting, and losing that is better than locking every
      // account out of a working system.
    });

  if (Math.random() < PRUNE_CHANCE) {
    await d1
      .prepare(
        `DELETE FROM sign_in_failures
         WHERE blocked_until < ?1 AND ?1 - first_at > ?2`,
      )
      .bind(now, FAILURE_WINDOW_MS)
      .run()
      .catch(() => {});
  }
}

/** Clears the counter. Called on success, so normal use never accumulates. */
export async function clearSignInFailures(
  d1: D1DatabaseLike,
  email: string,
  ip: string,
) {
  await d1
    .prepare("DELETE FROM sign_in_failures WHERE key = ?")
    .bind(failureKey(email, ip))
    .run()
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Reading a session                                                   */
/* ------------------------------------------------------------------ */

type SessionRow = {
  session_id?: string;
  user_id?: string;
  session_organisation_id?: string | null;
  issued_at?: string;
  expires_at?: string;
  last_seen_at?: string | null;
  revoked_at?: string | null;
  email?: string;
  full_name?: string | null;
  role?: string;
  active?: number;
  user_organisation_id?: string | null;
  status?: string;
  job_title?: string | null;
  phone?: string | null;
  timezone?: string | null;
  avatar_colour?: string | null;
  theme_preference?: string | null;
  working_status?: string | null;
  last_login_at?: string | null;
  password_updated_at?: string | null;
};

const SESSION_SELECT = `
  SELECT s.id            AS session_id,
         s.user_id       AS user_id,
         s.organisation_id AS session_organisation_id,
         s.issued_at     AS issued_at,
         s.expires_at    AS expires_at,
         s.last_seen_at  AS last_seen_at,
         s.revoked_at    AS revoked_at,
         u.email         AS email,
         u.full_name     AS full_name,
         u.role          AS role,
         u.active        AS active,
         u.organisation_id AS user_organisation_id,
         u.status        AS status,
         u.job_title     AS job_title,
         u.phone         AS phone,
         u.timezone      AS timezone,
         u.avatar_colour AS avatar_colour,
         u.theme_preference AS theme_preference,
         u.working_status AS working_status,
         u.last_login_at AS last_login_at,
         u.password_updated_at AS password_updated_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = ?
   LIMIT 1`;

function toSessionUser(row: SessionRow): SessionUser {
  const email = String(row.email ?? "");
  const fullName = row.full_name ?? null;
  return {
    id: String(row.user_id ?? ""),
    email,
    fullName,
    displayName: fullName?.trim() || email.split("@")[0] || email,
    role: String(row.role ?? ""),
    organisationId: row.user_organisation_id ?? null,
    status: String(row.status ?? "active"),
    jobTitle: row.job_title ?? null,
    phone: row.phone ?? null,
    timezone: row.timezone ?? "Europe/London",
    avatarColour: row.avatar_colour ?? null,
    themePreference: row.theme_preference ?? "dark",
    workingStatus: row.working_status ?? null,
    lastLoginAt: row.last_login_at ?? null,
    passwordUpdatedAt: row.password_updated_at ?? null,
  };
}

/**
 * Resolves the session cookie to a user, or null.
 *
 * Null covers every failure identically — no cookie, unknown token, revoked,
 * absolutely expired, idle too long, deactivated user, database unreachable.
 * The caller cannot tell which, and more importantly cannot accidentally treat
 * "the database was down" as "carry on as whoever you were".
 */
export async function getSession(
  request: Request,
): Promise<AuthenticatedSession | null> {
  try {
    const token = workspaceCookieValue(request, SESSION_COOKIE);
    // A real token is 64 hex characters. Rejecting short values early avoids a
    // database round trip for the empty-cookie case without revealing anything.
    if (!token || token.length < 32) return null;

    const d1 = await getD1();
    const tokenHash = await hashToken(token);
    const result = await d1.prepare(SESSION_SELECT).bind(tokenHash).all();
    const [row] = (result.results ?? []) as SessionRow[];
    if (!row || !row.session_id) return null;

    // Sign-out and "sign out everywhere" both land here.
    if (row.revoked_at) return null;

    const now = Date.now();

    // Absolute expiry. An unparseable timestamp is treated as expired, because
    // the alternative is treating it as valid forever.
    const expiresAt = parseTimestamp(row.expires_at);
    if (expiresAt === null || expiresAt <= now) return null;

    // Sliding expiry. Falls back to issue time for a session never yet touched.
    const lastSeen = parseTimestamp(row.last_seen_at) ?? parseTimestamp(row.issued_at);
    if (lastSeen === null || now - lastSeen > IDLE_LIFETIME_MS) {
      // Stamp it revoked so the session list tells the truth about why it
      // ended. Happens at most once per dead session, not per request.
      await revokeSession(d1, String(row.session_id)).catch(() => {});
      return null;
    }

    // A deactivated account must lose its existing sessions immediately, not at
    // their next natural expiry. Checked on every request for that reason.
    if (row.active === 0 || (row.status && row.status !== "active")) return null;

    if (now - lastSeen > TOUCH_INTERVAL_MS) {
      await d1
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .bind(new Date(now).toISOString(), row.session_id)
        .run();
    }

    const session: SessionRecord = {
      id: String(row.session_id),
      userId: String(row.user_id ?? ""),
      organisationId: row.session_organisation_id ?? null,
      issuedAt: String(row.issued_at ?? ""),
      expiresAt: String(row.expires_at ?? ""),
      lastSeenAt: row.last_seen_at ?? null,
    };

    return {
      user: toSessionUser(row),
      session,
      organisationId: session.organisationId,
    };
  } catch {
    // Fail closed. Not signed in beats guessing.
    return null;
  }
}

/**
 * `getSession`, but insists.
 *
 * Throws `UnauthenticatedError` (which carries `status = 401`) so a route can
 * let it propagate to a shared catch rather than restating the 401 body in
 * every handler.
 */
export async function requireSession(
  request: Request,
): Promise<AuthenticatedSession> {
  const session = await getSession(request);
  if (!session) throw new UnauthenticatedError();
  return session;
}

/** The 401 a route should send when `requireSession` throws. */
export function unauthenticatedResponse(message = "Sign in to continue.") {
  return Response.json({ error: message }, { status: 401 });
}

/* ------------------------------------------------------------------ */
/* Writing a session                                                   */
/* ------------------------------------------------------------------ */

/**
 * Issues a session and returns its token exactly once.
 *
 * The token is generated here, hashed, and only the hash is written. The
 * plaintext exists only in the return value and in the `Set-Cookie` header the
 * caller builds from it — it is never persisted and never logged.
 */
export async function createSession(
  d1: D1DatabaseLike,
  input: {
    userId: string;
    organisationId?: string | null;
    request: Request;
  },
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const id = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_LIFETIME_MS).toISOString();

  await d1
    .prepare(
      `INSERT INTO sessions
         (id, user_id, token_hash, organisation_id, issued_at, expires_at, last_seen_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      tokenHash,
      input.organisationId ?? null,
      issuedAt,
      expiresAt,
      issuedAt,
      requestIp(input.request),
      // Bounded: a header is attacker-controlled and this column is read back
      // into a session list in the UI.
      (input.request.headers.get("user-agent") ?? "").slice(0, 300),
    )
    .run();

  return { token, sessionId: id, expiresAt };
}

/** Revokes one session. Idempotent — re-revoking keeps the original stamp. */
export async function revokeSession(d1: D1DatabaseLike, sessionId: string) {
  await d1
    .prepare(
      "UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
    )
    .bind(new Date().toISOString(), sessionId)
    .run();
}

/**
 * Revokes every live session a user has — "sign out everywhere".
 *
 * Deliberately not scoped to "except this one": the case it exists for is
 * "I think someone has my password", and in that case the current device is as
 * suspect as the rest. The caller signs back in.
 */
export async function revokeAllSessions(d1: D1DatabaseLike, userId: string) {
  await d1
    .prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(new Date().toISOString(), userId)
    .run();
}

/** Records which organisation a session is looking at. */
export async function setSessionOrganisation(
  d1: D1DatabaseLike,
  sessionId: string,
  organisationId: string | null,
) {
  await d1
    .prepare("UPDATE sessions SET organisation_id = ? WHERE id = ?")
    .bind(organisationId, sessionId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

type CredentialRow = {
  id?: string;
  email?: string;
  password_hash?: string | null;
  active?: number;
  status?: string | null;
  organisation_id?: string | null;
};

/**
 * Looks up the credential row for an email.
 *
 * Returns the row whether or not the account is usable. The *caller* must run
 * the password check regardless and only then decide, because branching on
 * "no such user" before doing the expensive comparison is precisely the timing
 * leak `verifyPassword`'s decoy path exists to close.
 */
async function findCredential(d1: D1DatabaseLike, email: string) {
  const result = await d1
    .prepare(
      `SELECT id, email, password_hash, active, status, organisation_id
         FROM users
        WHERE lower(email) = ?
        LIMIT 1`,
    )
    .bind(email)
    .all();
  const [row] = (result.results ?? []) as CredentialRow[];
  return row ?? null;
}

export type SignInOutcome =
  | { ok: true; userId: string; organisationId: string | null }
  | { ok: false };

/**
 * Checks an email and password.
 *
 * One boolean out, deliberately. There is no "wrong password" versus "no such
 * account" distinction available to the caller, because any such distinction
 * ends up in a response body or a timing difference and turns the sign-in form
 * into an account-enumeration oracle — a way to ask "does this person bank
 * here" for every email you have.
 *
 * A successful check with an out-of-date hash silently upgrades it. Sign-in is
 * the only moment the plaintext exists, so it is the only moment a rehash is
 * possible.
 */
export async function checkPassword(
  d1: D1DatabaseLike,
  rawEmail: string,
  password: string,
): Promise<SignInOutcome> {
  const email = normaliseEmail(rawEmail);
  const row = email ? await findCredential(d1, email) : null;

  // Always runs the full derivation — against the decoy when there is no row,
  // no password set, or the account is disabled — so every rejected attempt
  // costs the same wall-clock time as a real one.
  const usable =
    !!row && row.active !== 0 && (!row.status || row.status === "active");
  const stored = usable ? (row?.password_hash ?? null) : null;
  const matches = await verifyPassword(password, stored);

  if (!row || !usable || !matches) return { ok: false };

  if (needsRehash(row.password_hash)) {
    await setPassword(d1, String(row.id), password).catch(() => {
      // An upgrade that fails must not fail the sign-in — the existing hash is
      // still valid, just older than we would like.
    });
  }

  return {
    ok: true,
    userId: String(row.id),
    organisationId: row.organisation_id ?? null,
  };
}

/** Writes a new password hash. The plaintext is not retained anywhere. */
export async function setPassword(
  d1: D1DatabaseLike,
  userId: string,
  password: string,
) {
  const hash = await hashPassword(password);
  await d1
    .prepare(
      "UPDATE users SET password_hash = ?, password_updated_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(hash, new Date().toISOString(), new Date().toISOString(), userId)
    .run();
}

/** Stamps a successful sign-in. */
export async function recordLogin(d1: D1DatabaseLike, userId: string) {
  await d1
    .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), userId)
    .run();
}

/* ------------------------------------------------------------------ */
/* The seeded owner account                                            */
/* ------------------------------------------------------------------ */

/**
 * The account that makes the workspace usable the moment authentication is on.
 *
 * Without it, enabling real sign-in would lock everybody out of a system whose
 * only route to a first account is an invitation that only an existing admin
 * can send — the classic bootstrapping deadlock.
 *
 * The password below is a *default*, not a secret: it is in source, so it must
 * be treated as public. Three things follow, and all three are implemented:
 *
 *   1. It is only ever written when `password_hash` is NULL. Once the owner
 *      changes it through `POST /api/auth/password`, this seeder will never
 *      reset it — re-running it is a no-op, not a downgrade.
 *   2. It never reaches production. `ownerSeedPassword` below prefers the
 *      `MAINTSUPP_OWNER_PASSWORD` secret, falls back to the public default only
 *      outside production, and in production without a secret writes no
 *      password at all — sign-in fails closed rather than accepting a
 *      credential that is printed in a public repository.
 *   3. It should be changed on first use. Stated in the report; the account UI
 *      owns any rotation screen.
 */
export const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_USER_ID = "user-owner-maintsupp-com";
const OWNER_FULL_NAME = "MAINTSUPP Owner";
const OWNER_DEFAULT_PASSWORD = "Sunnamusk-Owner-2026";

/**
 * The password to seed the owner account with, or nothing.
 *
 * Three answers, in order:
 *
 *   - `MAINTSUPP_OWNER_PASSWORD`, when the deployment sets it. That is the
 *     production route: a Worker secret, known to whoever deployed and to
 *     nobody reading the repository.
 *   - The public default, in development. A local checkout that could not sign
 *     in would be useless, and there is nothing to protect there.
 *   - Nothing, in production with no secret set. The account is created with a
 *     NULL `password_hash`, and `checkPassword` refuses those outright, so the
 *     deployment has no owner sign-in until a secret is set — which is the
 *     correct failure. The alternative, seeding a password anybody can read in
 *     source, hands the live workspace to the first person who tries it.
 *
 * A short secret is ignored rather than accepted, because a two-character
 * `MAINTSUPP_OWNER_PASSWORD` set by mistake would be worse than the deadlock it
 * was meant to solve.
 */
function ownerSeedPassword(): string | null {
  const configured = process.env.MAINTSUPP_OWNER_PASSWORD?.trim();
  if (configured && configured.length >= 12) return configured;
  if (process.env.NODE_ENV !== "production") return OWNER_DEFAULT_PASSWORD;
  return null;
}

/** Sunnamusk UK — the organisation the owner's account is homed in. */
const OWNER_ORGANISATION_SLUG = "sunnamusk-uk";

type OrganisationRow = { id?: string; slug?: string };

/**
 * Creates the owner account and its memberships if they are missing.
 *
 * Idempotent and additive, following the same rule as every seeder in
 * `db/init.ts`: it runs on paths that are hit repeatedly, so it must never
 * assume it is running for the first time. Memberships are re-checked on every
 * call so that an organisation created *after* the owner still gets one — which
 * is what "membership in every organisation" has to mean for a super admin who
 * outlives the workspaces they administer.
 */
export async function ensureOwnerAccount(d1: D1DatabaseLike) {
  const organisationResult = await d1
    .prepare(
      "SELECT id, slug FROM organisations WHERE status = 'active' ORDER BY created_at ASC",
    )
    .all();
  const organisations = (organisationResult.results ?? []) as OrganisationRow[];
  if (!organisations.length) {
    /* Nothing to attach an owner to yet. Not a fault on a database whose
       seeding has not run, but it is indistinguishable from a failed bootstrap
       from the outside, so it says so. */
    console.error("[auth] owner bootstrap skipped: no active organisation exists yet");
    return;
  }

  const home =
    organisations.find((row) => row.slug === OWNER_ORGANISATION_SLUG) ??
    organisations[0];

  await d1
    .prepare(
      `INSERT OR IGNORE INTO users (id, organisation_id, email, full_name, role, active)
       VALUES (?, ?, ?, ?, 'Super Admin', 1)`,
    )
    .bind(OWNER_USER_ID, home.id ?? null, OWNER_EMAIL, OWNER_FULL_NAME)
    .run();

  // Only hash when there is nothing to preserve. Hashing unconditionally would
  // burn 210,000 iterations on a path that runs on every visit to /login, and
  // would overwrite a password the owner had deliberately changed.
  const credential = await findCredential(d1, OWNER_EMAIL);
  if (credential && !credential.password_hash) {
    const seed = ownerSeedPassword();
    // No seed in production without a secret. The row stays password-less and
    // sign-in fails closed — see `ownerSeedPassword`.
    if (seed) await setPassword(d1, String(credential.id), seed);
    else {
      /*
       * THE ONE STATE THAT LOOKS EXACTLY LIKE A WRONG PASSWORD.
       *
       * A password-less owner row is refused by `checkPassword`, so sign-in
       * answers "That email and password do not match an account" — which
       * sends whoever holds the correct password off to check the password.
       * On a fresh Production database this is the difference between "the
       * secret is missing" and "the secret is wrong", and nothing said which.
       * No value is logged, only the decision.
       */
      console.error(
        "[auth] owner row has no password and no seed is available: " +
          "MAINTSUPP_OWNER_PASSWORD is unset, shorter than 12 characters, or " +
          "not reaching this runtime. Sign-in will fail closed until it is set.",
      );
    }
  }

  const userId = credential?.id ? String(credential.id) : OWNER_USER_ID;
  for (const organisation of organisations) {
    if (!organisation.id) continue;
    await d1
      .prepare(
        `INSERT OR IGNORE INTO memberships
           (id, user_id, organisation_id, role, status, accepted_at)
         VALUES (?, ?, ?, 'super_admin', 'active', ?)`,
      )
      .bind(
        `membership-${userId}-${organisation.id}`,
        userId,
        organisation.id,
        new Date().toISOString(),
      )
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Redirect safety                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sanitises a post-sign-in redirect target.
 *
 * `?next=` is attacker-supplied. Left unchecked it is an open redirect: a link
 * to our own trusted sign-in page that lands the user on somebody else's copy
 * of it, at which point the phishing does itself. Only same-site absolute paths
 * survive, and the sign-in pages themselves are excluded so a successful login
 * cannot bounce back to the form it just came from.
 */
export function safeRedirectPath(value: unknown, fallback = "/dashboard") {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  // `//host` and `/\host` are protocol-relative URLs, not local paths.
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const url = new URL(value, "https://maintsupp.invalid");
    if (url.origin !== "https://maintsupp.invalid") return fallback;
    if (url.pathname === "/login" || url.pathname.startsWith("/invite")) {
      return fallback;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
