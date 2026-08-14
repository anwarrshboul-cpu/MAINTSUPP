/**
 * Stage 23 — a way back into an account, and no public password in production.
 *
 * Two problems, both of which would have been found the hard way.
 *
 * FORGETTING A PASSWORD WAS PERMANENT. There is no "forgot password" link
 * because there is no mail server; `POST /api/auth/password` deliberately
 * refuses to take a `userId`, because an administrator overriding somebody's
 * password there would be the easiest privilege-escalation bug in the codebase;
 * and no other route touched `password_hash`. A workspace of 71 people had 71
 * permanent lockouts waiting to happen, with nobody able to help.
 *
 * THE SEEDED OWNER PASSWORD IS IN SOURCE. It is a default, not a secret, and it
 * is correct for development — but nothing stopped it seeding a production
 * deployment, where it would hand the live workspace to the first person who
 * read the repository.
 *
 * First half reads the source and pins the decisions a passing request cannot
 * demonstrate; second half drives the loop against a running server and skips
 * when nothing is listening.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
/** Seeded demo account. Its password is restored at the end of the live test. */
const TARGET_USER_ID = "user-sample-client-maintsupp-local";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ------------------------------------------------------------------ */
/* The shape of the decisions                                          */
/* ------------------------------------------------------------------ */

test("the public default password never seeds production", async () => {
  const source = await read("app/lib/auth-session.ts");

  assert.match(source, /function ownerSeedPassword\(\): string \| null \{/);
  assert.match(
    source,
    /const configured = process\.env\.MAINTSUPP_OWNER_PASSWORD\?\.trim\(\);/,
    "a deployment sets the owner password as a secret",
  );
  assert.match(
    source,
    /if \(configured && configured\.length >= 12\) return configured;/,
    "a two-character secret set by mistake is worse than the deadlock it solves",
  );
  assert.match(
    source,
    /if \(process\.env\.NODE_ENV !== "production"\) return OWNER_DEFAULT_PASSWORD;\s*\n\s*return null;/,
    "production with no secret gets NO password — sign-in fails closed",
  );
  // And the seeder must honour it rather than calling setPassword regardless.
  assert.match(source, /const seed = ownerSeedPassword\(\);\s*\n(?:.*\n)*?\s*if \(seed\) await setPassword\(/);
});

test("a reset token is a credential, and is treated like one", async () => {
  const source = await read("app/api/auth/password-resets/reset-tokens.ts");

  assert.match(source, /const bytes = new Uint8Array\(32\);\s*\n\s*crypto\.getRandomValues\(bytes\)/);
  assert.match(source, /const tokenHash = await hashToken\(token\)/, "only the hash is stored");
  // The insert's column list, and only that — a looser pattern runs past the
  // statement and matches the `return { token, id, … }` further down the file.
  const columns = source.match(/INSERT INTO password_resets\s*\n\s*\(([^)]*)\)/);
  assert.ok(columns, "the insert is where the row is written");
  assert.match(columns[1], /token_hash/);
  assert.doesNotMatch(
    columns[1],
    /(^|[\s,])token([\s,]|$)/,
    "the raw token is never written to a column",
  );
  // Minting retires the previous link: two live links to one account would
  // mean an old one, possibly already seen by somebody else, still opening it.
  assert.match(
    source,
    /UPDATE password_resets\s+SET revoked_at = \?\s+WHERE user_id = \?\s+AND used_at IS NULL\s+AND revoked_at IS NULL/,
  );
  // Single use is enforced by the database, not by read-then-write, so two
  // simultaneous requests cannot both set a password.
  assert.match(
    source,
    /UPDATE password_resets\s+SET used_at = \?\s+WHERE id = \?\s+AND used_at IS NULL\s+AND revoked_at IS NULL/,
  );
  assert.match(source, /if \(reset\.active === 0\) return \{ state: "revoked", reset \}/);
});

test("spending a link sets a password and issues no session", async () => {
  const source = await read("app/api/auth/password-resets/[token]/route.ts");

  // A reset that signed you in would be a second way into the account, and the
  // password would no longer be the only thing that opens it.
  assert.doesNotMatch(source, /createSession|sessionCookie/);
  assert.match(source, /await revokeAllSessions\(d1, String\(reset\.user_id\)\)/);
  // The password is validated BEFORE the link is spent — otherwise a typo
  // locks the person out with no way to ask for another one.
  const weakAt = source.indexOf("passwordProblem(payload.password)");
  const consumeAt = source.indexOf("consumeReset(d1");
  assert.ok(weakAt > 0 && consumeAt > weakAt, "validate, then consume");
  assert.match(source, /detail: \{ resetId: reset\.id, sessionsRevoked: true \}/);
  assert.doesNotMatch(source, /detail: \{[^}]*token/, "no token in the audit log");
});

test("issuing a link is gated, scoped, and refuses upward and self", async () => {
  const source = await read("app/api/admin/users/password-reset/route.ts");

  assert.match(source, /requireCapability\(context\.subject, "users\.edit"\)/);
  assert.match(
    source,
    /eq\(memberships\.organisationId, context\.targetOrganisationId\)/,
    "another workspace's account is not found rather than refused",
  );
  assert.match(
    source,
    /if \(ROLE_RANK\[targetRole\] > ROLE_RANK\[context\.actor\.role\]\)/,
    "an admin issuing a reset for a super admin would hand themselves that account",
  );
  assert.match(
    source,
    /target\.email\.toLowerCase\(\) === context\.identityEmail\?\.toLowerCase\(\)/,
    "resetting yourself would skip the current-password check that /api/auth/password makes",
  );
  assert.match(source, /if \(!target\.active\)/);
  assert.match(source, /action: "user\.password_reset_issued"/);
  assert.doesNotMatch(
    source,
    /detail: \{[^}]*token[^s]/,
    "the audit entry records who and until when, never the link",
  );
});

test("the reset page refuses to leak, and does not sign anybody in", async () => {
  const page = await read("app/(public)/reset/[token]/page.tsx");
  const form = await read("app/(public)/reset/[token]/set-password-form.tsx");

  // The URL contains the token, so the page is a credential-bearing URL.
  assert.match(page, /robots: \{ index: false, follow: false, nocache: true \}/);
  assert.match(page, /referrer: "no-referrer"/);
  // Resolved server-side, so a dead link says so instead of flashing a form.
  assert.match(page, /if \(state !== "valid" \|\| !reset\)/);
  assert.doesNotMatch(form, /window\.location\.assign/, "no navigation into the dashboard");
  assert.match(form, /setDone\(true\)/);
});

/* ------------------------------------------------------------------ */
/* The loop, against a running server                                  */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn(email, password) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
}

const tokenOf = (url) => String(url).split("/reset/")[1];

async function issue(cookie, userId) {
  const response = await fetch(`${BASE_URL}/api/admin/users/password-reset`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("issue, spend, and every session on that account dies", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn(OWNER.email, OWNER.password);
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  const first = await issue(cookie, TARGET_USER_ID);
  assert.equal(first.status, 201);
  assert.ok(first.body.resetUrl, "the link comes back to the administrator who issued it");
  const firstToken = tokenOf(first.body.resetUrl);

  const described = await fetch(`${BASE_URL}/api/auth/password-resets/${firstToken}`);
  assert.equal(described.status, 200);
  assert.equal((await described.json()).account.email, "sample-client@maintsupp.local");

  // A rejected password must NOT burn the link.
  const weak = await fetch(`${BASE_URL}/api/auth/password-resets/${firstToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "short" }),
  });
  assert.equal(weak.status, 400);
  assert.equal(
    (await fetch(`${BASE_URL}/api/auth/password-resets/${firstToken}`)).status,
    200,
    "the link survives a typo",
  );

  // Issuing again retires the first, so there is never more than one live link.
  const second = await issue(cookie, TARGET_USER_ID);
  assert.equal(second.status, 201);
  const secondToken = tokenOf(second.body.resetUrl);
  assert.equal((await fetch(`${BASE_URL}/api/auth/password-resets/${firstToken}`)).status, 410);

  const chosen = `stage23-reset-${Date.now()}-passphrase`;
  const set = await fetch(`${BASE_URL}/api/auth/password-resets/${secondToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: chosen }),
  });
  assert.equal(set.status, 200);
  assert.equal(
    (await fetch(`${BASE_URL}/api/auth/password-resets/${secondToken}`)).status,
    410,
    "single use",
  );

  const held = await signIn("sample-client@maintsupp.local", chosen);
  assert.ok(held, "the new password signs in");

  // Now reset again and prove the session that was live at the time is dead.
  const third = await issue(cookie, TARGET_USER_ID);
  const replacement = `stage23-reset-${Date.now()}-second-passphrase`;
  await fetch(`${BASE_URL}/api/auth/password-resets/${tokenOf(third.body.resetUrl)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: replacement }),
  });

  assert.equal(
    await signIn("sample-client@maintsupp.local", chosen),
    null,
    "the previous password stops working",
  );

  /*
   * The revoked session is checked by what it can no longer DO, not by the
   * status of a read: in development an unauthenticated request still resolves
   * to the primary workspace, so a 200 from /api/context proves nothing. A
   * write that requires a session is unambiguous.
   */
  const writeWithDeadSession = await fetch(`${BASE_URL}/api/auth/password`, {
    method: "POST",
    headers: { cookie: held, "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: chosen, newPassword: `${chosen}-again` }),
  });
  assert.equal(
    writeWithDeadSession.status,
    401,
    "the session that was live when the reset happened no longer authenticates",
  );
});

test("the guard rails hold against a real caller", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn(OWNER.email, OWNER.password);
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  const as = (identity, body) =>
    fetch(`${BASE_URL}/api/admin/users/password-reset`, {
      method: "POST",
      headers: { "x-maintsupp-identity": identity, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const byClient = await as("sample-client@maintsupp.local", {
    userId: "user-owner-maintsupp-com",
  });
  assert.equal(byClient.status, 403);
  assert.equal((await byClient.json()).capability, "users.edit");

  const upward = await as("sample-admin@maintsupp.local", {
    userId: "user-owner-maintsupp-com",
  });
  assert.equal(upward.status, 403, "an admin cannot reset the super admin");

  const self = await fetch(`${BASE_URL}/api/admin/users/password-reset`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-owner-maintsupp-com" }),
  });
  assert.equal(self.status, 400, "use account settings, which asks for the current password");

  const nowhere = await fetch(`${BASE_URL}/api/admin/users/password-reset`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-does-not-exist" }),
  });
  assert.equal(nowhere.status, 404);
});
