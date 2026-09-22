/**
 * Stage 20 — real authentication.
 *
 * Two halves, following the pattern set by the Stage 19 isolation suite.
 *
 * The first half reads the source and pins the *shape* of the security
 * decisions: that only hashes reach the database, that the comparison is
 * constant time, that the session cookie carries the flags it must, that a
 * session outranks the testing cookies, and that no failure path can be
 * mistaken for a success. These are properties that a passing request cannot
 * demonstrate — a system that stored plaintext passwords would sign people in
 * perfectly well — so they are asserted against the code that implements them.
 *
 * The second half talks to a running dev server and drives the real flows:
 * sign in, invite, accept, change password, sign out, sign out everywhere. It
 * skips when nothing is listening, so the suite still passes without a server.
 *
 * NOTE ON TEST DATA. The live invitation test creates one account per run, at a
 * uniquely-suffixed `@stage20.test.maintsupp.com` address in Demo Client Ltd.
 * That is deliberate: an invitation is single use by design, so exercising the
 * real accept path cannot reuse an address. The rows are inert and clearly
 * labelled, and no operational data is written.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
// Resolves the extensionless imports inside app/lib/*.ts for the unit checks.
import "./reports-ts-loader.mjs";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = "Sunnamusk-Owner-2026";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * The same file with its comments removed.
 *
 * Needed for the "must NOT contain" assertions below. These files explain their
 * own security decisions at length, so a prose sentence like "there is no
 * `node:crypto` in the Workers runtime" would otherwise fail a check that the
 * *code* does not import it. Stripping comments keeps those assertions aimed at
 * what actually executes.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

test("passwords are hashed with a salted, iterated KDF from WebCrypto", async () => {
  const text = await source("app/lib/password.ts");

  // WebCrypto only. Node's crypto module and native addons do not exist in the
  // Workers runtime, so reaching for one would fail in production and pass
  // nowhere useful.
  assert.doesNotMatch(codeOnly(text), /node:crypto/);
  assert.doesNotMatch(codeOnly(text), /require\(/);
  assert.match(text, /crypto\.subtle\.deriveBits/);
  assert.match(text, /name: "PBKDF2"/);

  // Per-password salt from the CSPRNG, never a constant and never the email.
  assert.match(text, /crypto\.getRandomValues\(salt\)/);
  assert.match(text, /const SALT_BYTES = 16/);

  // A real work factor. A "hash" nobody has to spend time on is a lookup table.
  assert.match(text, /const ITERATIONS = 210_000/);

  // Self-describing, so the cost can be raised without a flag day.
  assert.match(text, /\$\{ALGORITHM\}\$\$\{DIGEST\}\$\$\{ITERATIONS\}\$/);
  assert.match(text, /export function needsRehash/);
});

test("password comparison is constant time and never short-circuits", async () => {
  const text = await source("app/lib/password.ts");

  const compare = text.slice(
    text.indexOf("function constantTimeEqual"),
    text.indexOf("type ParsedHash"),
  );
  assert.ok(compare.length > 0, "constantTimeEqual must exist");

  // XOR-accumulate over every byte, with no early `return` inside the loop.
  assert.match(compare, /difference \|= left\[index\] \^ right\[index\]/);
  assert.match(compare, /return difference === 0/);
  assert.doesNotMatch(
    compare,
    /if \(left\[index\][^)]*\)\s*return/,
    "the comparison must not return early on the first differing byte",
  );

  // No `===` on the derived keys anywhere — that would undo the whole thing.
  assert.doesNotMatch(text, /candidate === parsed\.key/);
});

test("verifying an unknown account still does the full work", async () => {
  const text = await source("app/lib/password.ts");

  // The decoy is what makes "no such account" cost the same as "wrong
  // password". Without it the response time answers the question the response
  // body refuses to.
  assert.match(text, /DECOY_HASH/);
  assert.match(text, /const parsed = \(usable \? parseHash\(stored\) : null\) \?\? parseHash\(DECOY_HASH\)/);
  assert.match(text, /const matches = constantTimeEqual\(candidate, parsed\.key\)/);
});

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

test("only the hash of a session token is ever stored", async () => {
  const text = await source("app/lib/auth-session.ts");

  assert.match(text, /crypto\.subtle\.digest\(\s*"SHA-256"/);
  assert.match(text, /crypto\.getRandomValues\(bytes\)/);

  // The INSERT binds `tokenHash`, never `token`.
  const insert = text.slice(
    text.indexOf("export async function createSession"),
    text.indexOf("/** Revokes one session"),
  );
  assert.ok(insert.length > 0);
  assert.match(insert, /token_hash/);
  assert.match(insert, /\.bind\(\s*id,\s*input\.userId,\s*tokenHash,/);
  assert.doesNotMatch(
    insert,
    /\.bind\([^)]*\btoken\b\s*[,)]/,
    "the plaintext token must never be bound into a statement",
  );
});

test("the session cookie is HttpOnly, SameSite=Lax and Secure over https", async () => {
  const text = await source("app/lib/auth-session.ts");

  assert.match(text, /HttpOnly; SameSite=Lax\$\{secure\}/);
  assert.match(text, /isSecureRequest\(request\) \? "; Secure" : ""/);
  // Cleared with Max-Age=0 rather than left to rot.
  assert.match(text, /export function expiredSessionCookie/);
  assert.match(text, /Max-Age=0/);
});

test("sessions have both a sliding and an absolute expiry", async () => {
  const text = await source("app/lib/auth-session.ts");

  assert.match(text, /const ABSOLUTE_LIFETIME_MS = 30 \* 86_400_000/);
  assert.match(text, /const IDLE_LIFETIME_MS = 7 \* 86_400_000/);

  // Both are actually checked, not merely declared.
  assert.match(text, /if \(expiresAt === null \|\| expiresAt <= now\) return null/);
  assert.match(text, /now - lastSeen > IDLE_LIFETIME_MS/);

  // An unparseable timestamp must read as expired, never as valid forever.
  assert.match(text, /expiresAt === null/);
});

test("sign-out revokes and never deletes", async () => {
  const text = await source("app/lib/auth-session.ts");

  assert.match(text, /UPDATE sessions SET revoked_at/);
  assert.match(
    text,
    /UPDATE sessions SET revoked_at = \? WHERE user_id = \? AND revoked_at IS NULL/,
    "sign out everywhere must revoke every live session for the user",
  );
  assert.doesNotMatch(
    text,
    /DELETE FROM sessions/,
    "a revoked session must stay visible in the audit trail",
  );
});

test("resolving a session fails closed", async () => {
  const text = await source("app/lib/auth-session.ts");

  const body = text.slice(
    text.indexOf("export async function getSession"),
    text.indexOf("export async function requireSession"),
  );
  assert.ok(body.length > 0);

  // Every rejection is the same `null`, including the catch-all.
  assert.match(body, /if \(row\.revoked_at\) return null/);
  assert.match(body, /row\.active === 0 \|\| \(row\.status && row\.status !== "active"\)/);
  assert.match(body, /\} catch \{[\s\S]*?return null;[\s\S]*?\}/);

  // Nothing in the failure path can widen access.
  assert.doesNotMatch(body, /super_admin/);
});

/* ------------------------------------------------------------------ */
/* Identity feeds tenancy                                              */
/* ------------------------------------------------------------------ */

test("a real session outranks every testing cookie", async () => {
  const text = await source("app/lib/tenant-access.ts");

  assert.match(text, /import \{ getSession/);
  assert.match(text, /const session = await getSession\(request\)/);

  // The session email is the FIRST candidate, ahead of header and cookie.
  const candidates = text.slice(
    text.indexOf("const candidates = ["),
    text.indexOf("const seen = new Set<string>()"),
  );
  assert.ok(candidates.length > 0);
  const order = candidates
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(","));
  assert.match(order[0], /session\?\.user\.email/, "the session must be candidate zero");
  assert.ok(
    order.findIndex((line) => /header/.test(line)) > 0,
    "the testing header must come after the session",
  );
  assert.ok(
    order.findIndex((line) => /cookie/.test(line)) > 0,
    "the testing cookie must come after the session",
  );
});

test("a signed-in account cannot be widened by a membership it does not hold", async () => {
  const text = await source("app/lib/tenant-access.ts");

  // With a session, the identity is the session's email — the `find` that
  // walks candidates looking for one with a membership is skipped, or a
  // signed-in user with no grants would inherit a testing identity's access.
  assert.match(
    text,
    /const identityEmail = session\s*\?\s*session\.user\.email\.trim\(\)\.toLowerCase\(\)/,
  );

  // And the role fallback must not reach for the cookie role, which defaults
  // to super_admin when the cookie is absent. Re-pointed: only the
  // development `unaffiliated` fallback (never set with a session) keeps the
  // cookie role; a session with no access is refused outright (`noAccess`).
  assert.match(text, /grantHere\?\.role \?\? \(unaffiliated \? actor\.role : "client"\)/);
  assert.match(text, /if \(session\) \{\s*organisationIds = \[\];\s*noAccess = true;/);
});

test("the Stage 19 tenancy rules are untouched", async () => {
  const text = await source("app/lib/tenant-access.ts");

  // The organisation cookie is still filtered through the allowed set, and the
  // session's own organisation is a request on exactly the same terms.
  assert.match(text, /Boolean\(id && allowed\.has\(id\)\)/);
  assert.match(text, /isAllowed\(session\?\.organisationId\)/);
  // Cross-organisation reach: `role === "super_admin"`, then the strongest
  // membership anywhere, and since the three-level batch platform authority
  // (`platform_admins`), which no membership row can grant.
  assert.match(text, /const platformAdmin = authority\?\.platformAdmin \?\? false;/);
  assert.match(text, /crossOrganisation: platformAdmin/);
  // The membership reader now lives in `tenant-grants.ts`.
  assert.match(await source("app/lib/tenant-grants.ts"), /eq\(memberships\.status, "active"\)/);
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

test("sign-in cannot be used to discover which emails have accounts", async () => {
  const text = await source("app/api/auth/login/route.ts");

  // Exactly one rejection message, used for every credential failure.
  assert.match(text, /const REJECTED = /);
  const code = codeOnly(text);
  const rejections = code.match(/status: 401/g) ?? [];
  assert.equal(rejections.length, 1, "there must be a single 401 path");
  assert.match(code, /Response\.json\(\{ error: REJECTED \}, \{ status: 401 \}\)/);

  // No branch may say anything more specific.
  assert.doesNotMatch(code, /no such (account|user)/i);
  assert.doesNotMatch(code, /not recognised|unknown email|incorrect password/i);
});

test("repeated sign-in failures are throttled per email and IP", async () => {
  const login = await source("app/api/auth/login/route.ts");
  const session = await source("app/lib/auth-session.ts");

  assert.match(login, /signInRetryAfter\(d1, email, ip\)/);
  assert.match(login, /recordSignInFailure\(d1, email, ip\)/);
  assert.match(login, /status: 429/);

  // Keyed on both, so guessing at somebody's email cannot lock them out.
  assert.match(session, /function failureKey\(email: string, ip: string\)/);
  assert.match(session, /\$\{normaliseEmail\(email\)\}\|\$\{ip\}/);

  // The throttle is checked BEFORE the expensive derivation.
  const guard = login.indexOf("signInRetryAfter");
  const check = login.indexOf("checkPassword(d1");
  assert.ok(guard < check, "the rate limit must be checked before hashing");

  /*
   * The counter is durable, not isolate-local.
   *
   * This assertion used to read `assert.match(session, /HONEST LIMITATION/)` —
   * it pinned the comment admitting the limiter was a module-scope `Map`, which
   * meant five attempts per Worker isolate across an unknown number of them,
   * reset by every deploy. The limitation is now fixed rather than documented,
   * so the test asserts the fix: no in-memory counter survives, and the state
   * lives in a table every isolate reads.
   */
  assert.doesNotMatch(
    session,
    /const failures = new Map/,
    "the limiter must not keep counters in isolate memory",
  );
  assert.match(session, /FROM sign_in_failures WHERE key = \?/);
  assert.match(session, /INSERT INTO sign_in_failures/);

  /*
   * One statement for the increment.
   *
   * A shared counter read in one round trip and written in another lets two
   * concurrent failures both observe four and both write five — a race the
   * isolate-local Map never had. `ON CONFLICT DO UPDATE` is what makes the
   * read-modify-write atomic, so its absence is a real regression.
   */
  assert.match(session, /ON CONFLICT\(key\) DO UPDATE SET/);
});

test("accepting an invitation cannot escalate the role", async () => {
  const accept = await source("app/api/auth/invitations/[token]/route.ts");

  // The role comes out of the invitation row, never out of the request body.
  // Re-pointed: `invitationGrant` reads the row (role, company, workspaces).
  assert.match(accept, /const grant = await invitationGrant\(d1, invitation\);/);
  assert.match(accept, /const role = grant\.role;/);
  const tokens = await source("app/api/auth/invitations/invitation-tokens.ts");
  assert.match(tokens, /const role = normaliseRole\(invitation\.role\);/);
  assert.doesNotMatch(
    accept,
    /payload\.role/,
    "the accept endpoint must not read a role from the request",
  );

  // The membership INSERT binds that same `role`, once per granted workspace.
  assert.match(accept, /INSERT INTO memberships/);
  assert.match(accept, /workspace\.id,\s*\n\s*role,/);

  // Single use, enforced as a compare-and-set rather than a read-then-write.
  assert.match(accept, /WHERE id = \? AND accepted_at IS NULL AND revoked_at IS NULL/);
  assert.match(accept, /if \(!claim\?\.meta\?\.changes\) return gone\("accepted"\)/);

  // An invitation must never overwrite an existing account's password.
  assert.match(accept, /const holdsPassword = !!existing\?\.password_hash/);
  assert.match(accept, /if \(!holdsPassword\) await setPassword/);
});

test("only an admin may invite, and never above their own role", async () => {
  const create = await source("app/api/auth/invitations/route.ts");

  assert.match(create, /requireSession\(request\)/);
  // Re-pointed: `invitingRole` is gone; the tenancy resolver answers, per
  // target workspace, which role the caller holds there.
  assert.match(create, /scope = await scopedDb\(request\);/);
  assert.match(create, /const actingRole = roleInOrganisation\(scope, target\.id\);/);
  /*
   * "Only an admin" is now the permission matrix's answer, not a rank test.
   *
   * This pinned `ROLE_RANK[granting] < ROLE_RANK.admin`, which ignored the
   * matrix: an admin whose `users.invite` had been withdrawn could still invite
   * by calling this route directly. The route now resolves the caller's
   * permissions IN THE TARGET WORKSPACE and asks `can(…, "users.invite")`, and
   * the built-in defaults are what keep it to admins — checked below.
   */
  assert.match(
    create,
    /* Re-pointed 2026-09-22: resolvePermissions now takes the member's site scope (required 4th argument, for SITE_RESTRICTED_CEILING). */
    /const subject = await resolvePermissions\(db, target\.id, actingRole, siteScopeInOrganisation\(scope, target\.id\)\);\s*if \(!can\(subject, "users\.invite"\)\)/,
  );
  const permissions = await import("../app/lib/permissions.ts");
  assert.equal(permissions.defaultAllows("admin", "users.invite"), true);
  assert.equal(permissions.defaultAllows("manager", "users.invite"), false);
  assert.equal(permissions.defaultAllows("client", "users.invite"), false);
  // `ROLE_RANK[role] > ROLE_RANK[granting]` until the owner's assignment
  // decision: an Admin may no longer grant Admin (equal rank), and a Manager
  // grants nothing although a Client ranks below them. The rule is the table
  // in `canAssignRole`, and it is still applied before anything is written.
  assert.match(
    create,
    /if \(!canAssignRole\(actingRole, role\)\) \{/,
    "an inviter must not be able to grant a role their table does not allow",
  );
  const roles = await import("../app/lib/roles.ts");
  assert.equal(roles.canAssignRole("admin", "super_admin"), false);
  assert.equal(roles.canAssignRole("admin", "admin"), false);

  // The authority is memberships (and company/platform rows), not the display
  // label on users.role. Re-pointed: the inviter's authority is read by the
  // tenancy resolver, which the route asks; neither file reads users.role.
  const helpers = await source("app/api/auth/invitations/invitation-tokens.ts");
  const resolver = await source("app/lib/tenant-grants.ts");
  assert.match(resolver, /from\(memberships\)/);
  assert.doesNotMatch(helpers, /FROM users\s+WHERE[\s\S]{0,80}role/);
  assert.doesNotMatch(create, /FROM users\s+WHERE[\s\S]{0,80}role/);
});

test("changing a password requires the current one and ends other sessions", async () => {
  const text = await source("app/api/auth/password/route.ts");

  assert.match(text, /requireSession\(request\)/);
  assert.match(text, /checkPassword\(d1, current\.user\.email, currentPassword\)/);
  assert.match(text, /passwordProblem\(newPassword\)/);
  assert.match(text, /revokeAllSessions\(d1, current\.user\.id\)/);

  // No `userId` parameter — this route can only ever change your own password.
  assert.doesNotMatch(
    text,
    /payload\.userId/,
    "there must be no way to target another account",
  );
});

/*
 * RE-POINTED 2026-09-16, not weakened.
 *
 * This forbade `console.*` outright in all nine files. That was a proxy for the
 * property in the test's own name — no auth route logs a SECRET — and the proxy
 * and the property came apart when `auth-session.ts` gained three deliberate
 * diagnostics (7e151b5 "A password-less owner row now says so", 10f8aaa "Say
 * whether owner recovery would work, while it can still be checked"). Both
 * commits say in the source, twice, "No value is logged": they report a
 * CONFIGURATION decision — that MAINTSUPP_OWNER_PASSWORD is missing, so sign-in
 * will fail closed — on a fresh Production database where the alternative is a
 * silent wrong-password message that sends the operator to check the password.
 * Removing them to satisfy a blanket rule would delete a deliberate operability
 * fix; that would be changing the product to suit the test.
 *
 * A NINTH CALL WAS HIDING BEHIND THE EIGHTH. The old loop threw on
 * `auth-session.ts`, which is second in the list, so files three to nine were
 * never reached — and `app/api/auth/login/route.ts` has logged
 * `console.error("[auth] owner bootstrap failed", error)` since 4565cd3 without
 * this test ever seeing it. Its comment gives the same reason: swallowed
 * silently, a bootstrap failure is indistinguishable from a wrong password,
 * which is how the first Production bootstrap presented on 2026-09-05.
 *
 * HARDENED 2026-09-16. `login/route.ts` no longer passes the caught error. The
 * shim in `db/node-pg-d1.ts` builds every failure as
 * `D1_ERROR: <driver message>: <translated SQL>` and attaches the raw driver
 * error as `cause`, so printing that object put statement text, the driver's own
 * detail and a stack trace into the logs of the UNAUTHENTICATED sign-in route.
 * It logs a static sentence now, which is what the 2026-09-05 incident actually
 * needed — that the bootstrap failed at all, rather than a wrong-password
 * message. So both logging files carry literals only, and the weaker
 * "may carry a value as long as it is not called `password`" tier is gone
 * rather than left lying around for something to drift back into: a rule that
 * permits `error` permits whatever `error` happens to hold.
 *
 * TWO RULES, and the second is the strict one:
 *
 *  - every auth file that logs nothing keeps the blanket ban;
 *  - the two that do log may emit STRING LITERALS AND NOTHING ELSE — strip the
 *    double-quoted literals and the call must come out empty, so no template
 *    literal, no concatenated variable, no identifier of any kind, and no
 *    `error`, `cause` or `stack`.
 *
 * Literals are stripped before the check on purpose — one of the
 * `auth-session.ts` messages contains the word "password" as prose, and the
 * rule is about values, not about what the sentence is allowed to say.
 *
 * THE FILE LIST IS READ OFF DISK, not typed out. Two password-reset files —
 * `password-resets/[token]/route.ts` and `password-resets/reset-tokens.ts` —
 * existed for this entire test's life and were never in the hand-written list,
 * so a `console.error(token)` on the password-reset path would not have been
 * caught. Enumerating `app/api/auth` fixes the class rather than those two
 * instances: a route added tomorrow is covered the day it lands.
 */
const LITERAL_ONLY_LOGGING = new Set([
  "app/lib/auth-session.ts",
  "app/api/auth/login/route.ts",
]);

/** Every `.ts` under `app/api/auth`, plus the two libraries the routes sign in through. */
async function authSurface() {
  const dir = new URL("../app/api/auth/", import.meta.url);
  const entries = await readdir(dir, { recursive: true });
  const routes = entries
    .map((entry) => entry.split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `app/api/auth/${entry}`);
  return [...routes.sort(), "app/lib/password.ts", "app/lib/auth-session.ts"];
}

/** Every `console.*` argument list, with double-quoted string literals removed. */
function consoleArgumentsWithoutLiterals(code) {
  const stripped = code.replace(/"(?:[^"\\]|\\.)*"/g, "");
  return [...stripped.matchAll(/console\.(?:log|info|warn|error|debug)\s*\(([^)]*)\)/g)].map(
    ([, args]) => args,
  );
}

test("no auth route logs a secret", async () => {
  const files = await authSurface();

  /*
   * The walk is the thing protecting every other assertion here, so it is
   * itself asserted: a rename that empties it would otherwise turn this whole
   * test green while checking nothing. Both password-reset files are named
   * explicitly because they are the ones the old hand-written list missed.
   */
  assert.ok(files.length >= 11, `the auth surface should not shrink: found ${files.length}`);
  for (const required of [
    "app/api/auth/login/route.ts",
    "app/api/auth/password/route.ts",
    "app/api/auth/password-resets/[token]/route.ts",
    "app/api/auth/password-resets/reset-tokens.ts",
    "app/lib/auth-session.ts",
  ]) {
    assert.ok(files.includes(required), `${required} must be covered by this check`);
  }

  for (const path of files) {
    const text = codeOnly(await source(path));
    if (!LITERAL_ONLY_LOGGING.has(path)) {
      assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)/, `${path} must not log`);
      continue;
    }
    for (const args of consoleArgumentsWithoutLiterals(text)) {
      assert.equal(
        args.replace(/[\s+,]/g, ""),
        "",
        `${path} may log string literals only — this call carries a value: ${args.trim()}`,
      );
    }
  }
});

test("the sign-in page is a real form and is not indexable", async () => {
  const page = await source("app/(app)/login/page.tsx");
  const form = await source("app/(app)/login/sign-in-form.tsx");

  assert.doesNotMatch(page, /^\s*redirect\("\/dashboard"\);\s*$/m);
  assert.match(page, /robots: \{ index: false/);
  assert.match(page, /<SignInForm next=\{next\} \/>/);

  // Posted as JSON, so the password never reaches the URL the way a GET form
  // would have put it.
  assert.match(form, /method: "POST"/);
  assert.match(form, /type="password"/);
  assert.match(form, /autoComplete="current-password"/);

  // The redirect comes from the server's sanitised value, not the raw `next`.
  assert.match(form, /payload\.redirectTo \?\? "\/dashboard"/);
  assert.match(page, /safeRedirectPath\(rawNext\)/);
});

test("the post-sign-in redirect cannot be pointed off-site", async () => {
  const text = await source("app/lib/auth-session.ts");
  const body = text.slice(text.indexOf("export function safeRedirectPath"));

  assert.match(body, /!value\.startsWith\("\/"\)/);
  assert.match(body, /value\.startsWith\("\/\/"\)/);
  assert.match(body, /url\.origin !== "https:\/\/maintsupp\.invalid"/);
  // And it cannot bounce back to the form it came from.
  assert.match(body, /url\.pathname === "\/login"/);
});

/* ------------------------------------------------------------------ */
/* Live, against the running dev server                                */
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

function sessionTokenFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const cookie = cookies.find((value) => value.startsWith("maintsupp_session="));
  if (!cookie) return null;
  const value = cookie.slice("maintsupp_session=".length).split(";")[0];
  return { value, cookie };
}

async function signIn(email, password) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { response, body: await response.json(), token: sessionTokenFrom(response) };
}

async function asSession(token, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Cookie: `maintsupp_session=${token}`,
    },
  });
  return { status: response.status, body: await response.json().catch(() => ({})), response };
}

test("the seeded owner can sign in and is a super admin everywhere", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { response, body, token } = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(token, "a session cookie must be issued");

  // The cookie flags that make the token hard to steal.
  assert.match(token.cookie, /HttpOnly/);
  assert.match(token.cookie, /SameSite=Lax/);
  assert.match(token.cookie, /Path=\//);
  assert.match(token.value, /^[0-9a-f]{64}$/);

  // Nothing secret in the body.
  assert.equal(body.token, undefined);
  assert.equal(body.password, undefined);

  const context = await asSession(token.value, "/api/context");
  assert.equal(context.body.context.identity.email, OWNER_EMAIL);
  assert.equal(context.body.context.actor.role, "super_admin");
  assert.equal(context.body.context.identity.crossOrganisation, true);
  const ids = context.body.context.identity.organisationIds;
  assert.ok(ids.includes(PRIMARY_ORGANISATION_ID));
  assert.ok(ids.includes(DEMO_ORGANISATION_ID));
});

test("a wrong password and an unknown email are indistinguishable", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const wrong = await signIn(OWNER_EMAIL, "this-is-not-the-password-at-all");
  const unknown = await signIn(
    `definitely-nobody-${Date.now()}@example.com`,
    "this-is-not-the-password-at-all",
  );

  assert.equal(wrong.response.status, 401);
  assert.equal(unknown.response.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);
  assert.equal(wrong.token, null, "a failed sign-in must not set a cookie");
  assert.equal(unknown.token, null);
});

test("a live session outranks the testing identity header and cookie", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { token } = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.ok(token);

  // The exact Stage 19 attack, now attempted from inside a real session: claim
  // to be somebody else via the testing header and the demo cookies.
  const forged = await fetch(`${BASE_URL}/api/context`, {
    headers: {
      Cookie: [
        `maintsupp_session=${token.value}`,
        "maintsupp_demo_identity=client@demo-client-ltd.test.maintsupp.com",
        "maintsupp_demo_role=client",
      ].join("; "),
      "x-maintsupp-identity": "client@demo-client-ltd.test.maintsupp.com",
    },
  });
  const body = await forged.json();
  assert.equal(
    body.context.identity.email,
    OWNER_EMAIL,
    "the session must decide the identity, not the header or cookie",
  );
  assert.equal(body.context.actor.role, "super_admin");
});

test("the testing switcher still works when there is no session", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // Stage 19's behaviour must survive: this is how the dashboard is demoed.
  const response = await fetch(`${BASE_URL}/api/context`, {
    headers: { "x-maintsupp-identity": "client@demo-client-ltd.test.maintsupp.com" },
  });
  const body = await response.json();
  assert.equal(
    body.context.identity.email,
    "client@demo-client-ltd.test.maintsupp.com",
  );
  assert.equal(body.context.actor.role, "client");
  assert.equal(body.context.currentOrganisation.id, DEMO_ORGANISATION_ID);
});

test("an invitation carries its role, is single use, and confines the invitee", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { token } = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.ok(token);

  const invitee = `stage20-probe-${Date.now()}@stage20.test.maintsupp.com`;
  const created = await asSession(token.value, "/api/auth/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: invitee,
      role: "client",
      organisationId: DEMO_ORGANISATION_ID,
    }),
  });
  assert.equal(created.status, 201);
  const inviteUrl = created.body.inviteUrl;
  assert.match(inviteUrl, /\/invite\/[0-9a-f]{64}$/);
  const inviteToken = inviteUrl.split("/invite/")[1];

  // Inspecting the invitation needs no account — the token is the credential —
  // but it discloses only what the holder was already sent.
  const inspected = await fetch(`${BASE_URL}/api/auth/invitations/${inviteToken}`);
  const inspectedBody = await inspected.json();
  assert.equal(inspected.status, 200);
  assert.equal(inspectedBody.invitation.email, invitee);
  assert.equal(inspectedBody.invitation.role, "client");
  assert.equal(inspectedBody.invitation.organisationName, "Demo Client Ltd");
  assert.equal(inspectedBody.existingAccount, false);
  assert.equal(inspectedBody.invitation.token, undefined);

  // Accept, asking for super_admin while doing it. The role in the body is not
  // read at all, so this changes nothing.
  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${inviteToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "a-long-enough-invitee-password",
      fullName: "Stage 20 Probe",
      role: "super_admin",
      organisationId: PRIMARY_ORGANISATION_ID,
    }),
  });
  const acceptedBody = await accepted.json();
  assert.equal(accepted.status, 201);
  assert.equal(acceptedBody.role, "client", "the invitation's role must win");
  assert.equal(acceptedBody.organisationId, DEMO_ORGANISATION_ID);

  const inviteeSession = sessionTokenFrom(accepted);
  assert.ok(inviteeSession, "accepting must sign the invitee in");

  // The invitee is confined to the organisation the invitation named, even
  // while forging every testing cookie there is.
  const forged = await fetch(`${BASE_URL}/api/context`, {
    headers: {
      Cookie: [
        `maintsupp_session=${inviteeSession.value}`,
        "maintsupp_demo_role=super_admin",
        `maintsupp_demo_organisation=${PRIMARY_ORGANISATION_ID}`,
        "maintsupp_demo_identity=super-admin@test.maintsupp.com",
      ].join("; "),
    },
  });
  const context = (await forged.json()).context;
  assert.equal(context.identity.email, invitee);
  assert.equal(context.actor.role, "client");
  assert.equal(context.currentOrganisation.id, DEMO_ORGANISATION_ID);
  assert.deepEqual(context.identity.organisationIds, [DEMO_ORGANISATION_ID]);
  assert.equal(context.tenantSummary, null, "a client gets no cross-tenant view");

  // A client cannot invite anybody, let alone a super admin.
  const escalation = await asSession(
    inviteeSession.value,
    "/api/auth/invitations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "attacker@example.com", role: "super_admin" }),
    },
  );
  assert.equal(escalation.status, 403);

  // Single use: the link is dead, and says so.
  const replay = await fetch(`${BASE_URL}/api/auth/invitations/${inviteToken}`);
  assert.equal(replay.status, 410);
  const replayBody = await replay.json();
  assert.equal(replayBody.state, "accepted");
  assert.match(replayBody.error, /already been used/);
});

test("an unknown invitation token fails closed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const response = await fetch(`${BASE_URL}/api/auth/invitations/${"f".repeat(64)}`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.state, "unknown");
  assert.match(body.error, /not valid/);
  assert.equal(body.invitation, undefined);
});

test("signing out revokes the token, not just the cookie", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { token } = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.ok(token);

  const before = await asSession(token.value, "/api/context");
  assert.equal(before.body.context.identity.email, OWNER_EMAIL);

  const out = await asSession(token.value, "/api/auth/logout", { method: "POST" });
  assert.equal(out.status, 200);
  const cleared = out.response.headers.getSetCookie?.() ?? [];
  assert.ok(
    cleared.some((value) => value.startsWith("maintsupp_session=;")),
    "sign-out must clear the cookie",
  );

  // Replaying the copied token must fail: the row is revoked server side.
  const after = await asSession(token.value, "/api/context");
  assert.notEqual(after.body.context.identity.email, OWNER_EMAIL);
});

test("sign out everywhere ends sessions on other devices", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const first = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  const second = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.ok(first.token && second.token);
  assert.notEqual(first.token.value, second.token.value);

  const out = await asSession(first.token.value, "/api/auth/logout-all", {
    method: "POST",
  });
  assert.equal(out.status, 200);

  for (const token of [first.token.value, second.token.value]) {
    const context = await asSession(token, "/api/context");
    assert.notEqual(
      context.body.context.identity.email,
      OWNER_EMAIL,
      "every device must be signed out, including the one that asked",
    );
  }
});

test("protected auth routes refuse anonymous callers", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const invitations = await fetch(`${BASE_URL}/api/auth/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "x@example.com", role: "client" }),
  });
  assert.equal(invitations.status, 401);

  const password = await fetch(`${BASE_URL}/api/auth/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      currentPassword: "whatever",
      newPassword: "a-long-enough-password",
    }),
  });
  assert.equal(password.status, 401);

  const logoutAll = await fetch(`${BASE_URL}/api/auth/logout-all`, { method: "POST" });
  assert.equal(logoutAll.status, 401);

  // Plain sign-out is deliberately forgiving: nothing to protect, and a 401
  // would leave a browser holding a cookie it was told to drop.
  const logout = await fetch(`${BASE_URL}/api/auth/logout`, { method: "POST" });
  assert.equal(logout.status, 200);
});

test("a weak password is refused when accepting an invitation", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const { token } = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
  assert.ok(token);

  const invitee = `stage20-weak-${Date.now()}@stage20.test.maintsupp.com`;
  const created = await asSession(token.value, "/api/auth/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: invitee,
      role: "client",
      organisationId: DEMO_ORGANISATION_ID,
    }),
  });
  assert.equal(created.status, 201);
  const inviteToken = created.body.inviteUrl.split("/invite/")[1];

  const weak = await fetch(`${BASE_URL}/api/auth/invitations/${inviteToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "short" }),
  });
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /at least 12 characters/);

  // Refused, and NOT consumed — the invitee gets to try again.
  const still = await fetch(`${BASE_URL}/api/auth/invitations/${inviteToken}`);
  assert.equal(still.status, 200);
});
