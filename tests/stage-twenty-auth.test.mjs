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
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  // to super_admin when the cookie is absent.
  assert.match(text, /:\s*session\s*\n?\s*\?\s*"client"\s*\n?\s*:\s*actor\.role/);
});

test("the Stage 19 tenancy rules are untouched", async () => {
  const text = await source("app/lib/tenant-access.ts");

  // The organisation cookie is still filtered through the allowed set, and the
  // session's own organisation is a request on exactly the same terms.
  assert.match(text, /allowed\.has\(requestedId\)/);
  assert.match(text, /session\?\.organisationId/);
  assert.match(text, /crossOrganisation: role === "super_admin"/);
  assert.match(text, /eq\(memberships\.status, "active"\)/);
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
  assert.match(accept, /const role = normaliseRole\(invitation\.role\)/);
  assert.doesNotMatch(
    accept,
    /payload\.role/,
    "the accept endpoint must not read a role from the request",
  );

  // The membership INSERT binds that same `role`.
  assert.match(accept, /INSERT INTO memberships/);
  assert.match(accept, /invitation\.organisation_id,\s*\n\s*role,/);

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
  assert.match(create, /invitingRole\(d1, current\.user\.id, organisationId\)/);
  assert.match(create, /ROLE_RANK\[granting\] < ROLE_RANK\.admin/);
  assert.match(
    create,
    /ROLE_RANK\[role\] > ROLE_RANK\[granting\]/,
    "an inviter must not be able to grant a role above their own",
  );

  // The authority is memberships, not the display label on users.role.
  const helpers = await source("app/api/auth/invitations/invitation-tokens.ts");
  assert.match(helpers, /FROM memberships/);
  assert.doesNotMatch(helpers, /FROM users\s+WHERE[\s\S]{0,80}role/);
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

test("no auth route logs a secret", async () => {
  const files = [
    "app/lib/password.ts",
    "app/lib/auth-session.ts",
    "app/api/auth/login/route.ts",
    "app/api/auth/logout/route.ts",
    "app/api/auth/logout-all/route.ts",
    "app/api/auth/password/route.ts",
    "app/api/auth/invitations/route.ts",
    "app/api/auth/invitations/[token]/route.ts",
    "app/api/auth/invitations/invitation-tokens.ts",
  ];
  for (const path of files) {
    const text = codeOnly(await source(path));
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)/, `${path} must not log`);
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
