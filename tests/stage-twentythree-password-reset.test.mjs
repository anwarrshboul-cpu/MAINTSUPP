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
  // A rank comparison until the owner's role decision; now the assignment
  // table, which ALSO keeps an Admin from resetting another Admin.
  assert.match(
    source,
    /if \(!canManageRole\(context\.actor\.role, targetRole\)\)/,
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

/*
 * SOMEBODY SETTING A PASSWORD THEY CANNOT SEE IS THE PERSON WHO MOST NEEDS TO
 * CHECK IT. These two fields were plain masked inputs with no way to reveal
 * them, while the invitation page next door — the same reader, holding the same
 * kind of handed-out link — had a reveal control on both of its own. This pins
 * the second half of that: one implementation, used by both pages.
 */
test("both fields on the reset page reveal, through the invitation's own control", async () => {
  const form = await read("app/(public)/reset/[token]/set-password-form.tsx");
  const invite = await read("app/(public)/invite/[token]/accept-invite-form.tsx");
  const field = await read("app/(public)/password-input.tsx");

  // The same module, not a second copy of it.
  assert.match(form, /import \{ PasswordInput \} from "\.\.\/\.\.\/password-input";/);
  assert.match(invite, /import \{ PasswordInput \} from "\.\.\/\.\.\/password-input";/);
  assert.match(form, /revealLabel="password"/);
  assert.match(form, /revealLabel="password confirmation"/, "each control says what it reveals");
  assert.match(form, /id="reset-password"/);
  assert.match(form, /id="reset-confirm"/);
  // Each field has its own state, so revealing one does not reveal the other.
  assert.match(form, /shown=\{shown\.password\}/);
  assert.match(form, /shown=\{shown\.confirm\}/);

  // Uncontrolled, like the invitation's: a controlled password field keeps the
  // typed value in the markup. This form used to hold both in React state.
  assert.doesNotMatch(form, /value=\{password\}|value=\{confirm\}/);
  assert.match(form, /passwordRef\.current\?\.value/);
  assert.match(form, /confirmRef\.current\?\.value/);
  assert.match(form, /password !== confirm/, "mismatch is still caught before sending");
  assert.match(
    form,
    /setShown\(\{ password: false, confirm: false \}\);\s*setPending\(true\);/,
    "both fields are hidden again before anything is sent",
  );
  assert.match(form, /clearPasswords\(\);/, "a refused password is not left on screen");
  assert.doesNotMatch(form, /console\.|localStorage|sessionStorage|searchParams/);

  // The control itself: a real button that cannot submit, named for what it
  // will do, with no password in any attribute.
  assert.match(field, /type=\{shown \? "text" : "password"\}/);
  assert.match(field, /<button\s+type="button"/);
  assert.match(field, /aria-label=\{`\$\{shown \? "Hide" : "Show"\} \$\{revealLabel\}`\}/);
  assert.match(field, /defaultValue=""/);
  assert.match(field, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/, "focus stays in the field");

  // And the page reaches the styles for it: its stylesheet is the invitation's,
  // which is where `.invite__reveal` is drawn.
  assert.match(await read("app/(public)/reset/reset.css"), /@import "\.\.\/invite\/\[token\]\/invite\.css";/);
  assert.match(await read("app/(public)/invite/[token]/invite.css"), /\.invite__reveal/);
});

/*
 * THE CARET SURVIVES THE TOGGLE, AND WHY THIS PIN IS SHAPED LIKE THIS.
 *
 * Changing an input's `type` makes the browser drop the selection: the caret
 * went to 0, so the next character typed after pressing the eye landed at the
 * FRONT of the password ("abcdef|123456" became "Xabcdef123456"). Preventing
 * `mousedown` keeps focus in the field, which is why it looked fine until
 * somebody typed.
 *
 * Chromium clears the selection AFTER the type change, so a restore made
 * synchronously is itself undone — measured, not assumed. The component
 * therefore restores twice: once for the frame being painted, and again on the
 * next animation frame, which is the one that holds. Both halves are pinned
 * because dropping either brings the bug back, and the browser proof that
 * shows it lives in this batch's scratchpad script, `caret_check.py`
 * (183 checks across both pages, both fields and three widths; 111 of them
 * fail on the implementation this replaced).
 */
test("the reveal control gives the caret back exactly where it was", async () => {
  const field = await read("app/(public)/password-input.tsx");

  assert.match(field, /const \{ selectionStart, selectionEnd, selectionDirection \} = node;/,
    "the position is read from the input as the control is pressed");
  assert.match(field, /direction: selectionDirection \?\? "none"/, "including which way a selection runs");
  assert.match(field, /focused: document\.activeElement === node/, "and whether the field had focus at all");
  assert.match(field, /node\.setSelectionRange\(saved\.start, saved\.end, saved\.direction\)/,
    "the whole range goes back, not a collapsed caret");
  assert.match(field, /const frame = requestAnimationFrame\(restore\);/,
    "the restore that survives the browser's own reset");
  assert.match(field, /return \(\) => cancelAnimationFrame\(frame\);/, "and it is cancelled if this unmounts");
  assert.match(field, /\}, \[shown, id\]\);/, "it runs when, and only when, the visibility changes");
  assert.match(field, /if \(saved\.focused && document\.activeElement !== node\) node\.focus\(\{ preventScroll: true \}\);/,
    "a keyboard user is left on the control they pressed");
  // Selection APIs are not available on every input in every browser, and a
  // reader pressing an eye is not a reason to throw.
  assert.equal((field.match(/\} catch \{/g) ?? []).length, 2, "both selection calls fail safely");
  // Still nothing about the password itself leaves the component.
  assert.doesNotMatch(field, /console\.|localStorage|sessionStorage|fetch\(/);
  assert.doesNotMatch(field, /value=\{/, "and it stays uncontrolled");
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

/*
 * THE ACCOUNT BEING RESET IS ONE THESE TESTS MAKE.
 *
 * It used to be `user-sample-client-maintsupp-local`, which no migrated
 * database has. That row comes from `seedWorkspaceIfEmpty` in
 * `app/api/workspace/route.ts`, which only fills a workspace holding NO users —
 * and `db/init.ts` seeds testing identities into every workspace, so the
 * condition is false on any estate built since. The account survived only on
 * long-lived local databases, created back when that seeding did not exist. So
 * these two tests passed for whoever had an old database and failed on a fresh
 * one, for a reason with nothing to do with resets.
 *
 * A reset is scoped to the workspace the caller administers, so the target has
 * to be IN it. Rather than hope one is, the fixture invites an account into the
 * caller's own workspace and accepts the invitation to give it a password, then
 * switches it off afterwards. The flow below then has a real account to work
 * on: one that can sign in, hold a session, and lose it.
 */
async function inviteResetTarget(cookie, role = "client") {
  const context = await (await fetch(`${BASE_URL}/api/context`, { headers: { cookie } })).json();
  const organisationId = context?.context?.currentOrganisation?.id;
  const clientCompanyId = (context?.context?.organisations ?? []).find(
    (organisation) => organisation.id === organisationId,
  )?.clientCompanyId;
  if (!organisationId || !clientCompanyId) return null;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `stage23-reset-${stamp}@accounts.test.maintsupp.com`;
  const password = `stage23 fixture ${stamp} passphrase`;
  const invited = await fetch(`${BASE_URL}/api/auth/invitations`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email, role, clientCompanyId, workspaceIds: [organisationId] }),
  });
  if (invited.status !== 201) return null;
  const token = String((await invited.json()).inviteUrl ?? "").split("/invite/")[1];
  if (!token) return null;

  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, fullName: `Stage 23 ${role} fixture` }),
  });
  if (!accepted.ok) return null;

  /* Acceptance answers with where the person landed, not who they now are, so
     the id is read back from the roster the caller can already see. */
  const roster = await (
    await fetch(`${BASE_URL}/api/admin/users`, { headers: { cookie } })
  ).json();
  const row = (roster.users ?? []).find(
    (user) => user.email.toLowerCase() === email.toLowerCase(),
  );
  return row ? { userId: row.id, email, password, role } : null;
}

/** Switched off rather than deleted — the product has no delete, and an
    account that is off opens nothing with whatever password it ended on. */
async function retireResetTarget(cookie, userId) {
  await fetch(`${BASE_URL}/api/admin/users`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "deactivate", userId }),
  });
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

  const target = await inviteResetTarget(cookie);
  if (!target) {
    t.skip("this workspace would not take an invited fixture account");
    return;
  }

  try {
  const first = await issue(cookie, target.userId);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok(first.body.resetUrl, "the link comes back to the administrator who issued it");
  const firstToken = tokenOf(first.body.resetUrl);

  const described = await fetch(`${BASE_URL}/api/auth/password-resets/${firstToken}`);
  assert.equal(described.status, 200);
  assert.equal((await described.json()).account.email, target.email);

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
  const second = await issue(cookie, target.userId);
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

  const held = await signIn(target.email, chosen);
  assert.ok(held, "the new password signs in");

  // Now reset again and prove the session that was live at the time is dead.
  const third = await issue(cookie, target.userId);
  const replacement = `stage23-reset-${Date.now()}-second-passphrase`;
  await fetch(`${BASE_URL}/api/auth/password-resets/${tokenOf(third.body.resetUrl)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: replacement }),
  });

  assert.equal(
    await signIn(target.email, chosen),
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
  } finally {
    await retireResetTarget(cookie, target.userId);
  }
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

  /*
   * THE CALLERS AND THE TARGET ARE THIS TEST'S OWN, for the same reason the
   * reset target above is: the two accounts it used to name (`sample-client@`
   * and `sample-admin@`) exist only on a database old enough to predate the
   * seeded testing identities, and a request made as nobody answers 404 —
   * which would pass a "refused" assertion for entirely the wrong reason.
   *
   * The target is an Admin rather than the platform's own account, and that is
   * the rule as it now stands: platform authority is not a membership, so a
   * Platform Super Admin is not IN the workspace and an admin asking to reset
   * one is told no such account is here. What an Admin must not be able to do
   * inside the workspace is reset another Admin, and that is what this asks.
   */
  const clientCaller = await inviteResetTarget(cookie, "client");
  const adminCaller = await inviteResetTarget(cookie, "admin");
  const adminTarget = await inviteResetTarget(cookie, "admin");
  if (!clientCaller || !adminCaller || !adminTarget) {
    t.skip("this workspace would not take the invited fixture accounts");
    return;
  }

  try {
    const byClient = await as(clientCaller.email, { userId: adminTarget.userId });
    assert.equal(byClient.status, 403, "a client holds no users.edit");
    assert.equal((await byClient.json()).capability, "users.edit");

    const sideways = await as(adminCaller.email, { userId: adminTarget.userId });
    assert.equal(sideways.status, 403, "an admin cannot reset another admin");

    const ownAccount = await as(adminCaller.email, { userId: adminCaller.userId });
    assert.equal(
      ownAccount.status,
      400,
      "use account settings, which asks for the current password",
    );

    const nowhere = await fetch(`${BASE_URL}/api/admin/users/password-reset`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-does-not-exist" }),
    });
    assert.equal(nowhere.status, 404);

    /* And the authority that DOES hold still works, so none of the above is
       passing because issuing is broken for everybody. */
    const allowed = await issue(cookie, adminTarget.userId);
    assert.equal(allowed.status, 201, "the platform may still issue a link in its own workspace");
  } finally {
    for (const fixture of [clientCaller, adminCaller, adminTarget]) {
      await retireResetTarget(cookie, fixture.userId);
    }
  }
});

test("live: a valid link renders two revealable fields; a dead one still refuses", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn(OWNER.email, OWNER.password);
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  /*
   * A target read from the caller's own roster rather than a fixed seeded id:
   * a reset is scoped to the workspace the caller is in, and which seeded
   * account sits in it differs between a fresh database and a long-lived one.
   * Only a test address, and only one this caller may already manage.
   */
  const roster = await (
    await fetch(`${BASE_URL}/api/admin/users`, { headers: { cookie } })
  ).json();
  const target = (roster.users ?? []).find(
    (user) =>
      user.manageable &&
      user.active &&
      !user.isSelf &&
      /(@|\.)(test|local)\b|\.test\./i.test(user.email),
  );
  if (!target) {
    t.skip("no manageable test account in this workspace");
    return;
  }

  /* Issued, never spent: this test is about what the page offers, so no
     account's password is touched and the link simply expires. */
  const issued = await issue(cookie, target.id);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const token = tokenOf(issued.body.resetUrl);

  const response = await fetch(`${BASE_URL}/reset/${token}`);
  assert.equal(response.status, 200);
  const html = await response.text();

  for (const [id, label] of [
    ["reset-password", "Show password"],
    ["reset-confirm", "Show password confirmation"],
  ]) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} is on the page`);
    assert.match(input, /type="password"/, "masked until the reader asks otherwise");
    assert.match(input, /autocomplete="new-password"/i);
    /* The field is uncontrolled, so the only `value` the markup can carry is
       the empty one React renders for `defaultValue` — never anything typed.
       That typing leaves the attribute alone is proved in a real browser. */
    assert.doesNotMatch(input, /\svalue="[^"]+"/, "no password can reach the markup");

    const button = html.match(new RegExp(`<button[^>]*aria-controls="${id}"[^>]*>`))?.[0];
    assert.ok(button, `${id} has a reveal control`);
    assert.match(button, /type="button"/, "it cannot submit the form");
    assert.match(button, new RegExp(`aria-label="${label}"`), "named for what it will do");
  }

  // The page it was served from still says nothing about the account to
  // anybody holding a spent or invented link.
  const dead = await fetch(`${BASE_URL}/reset/${"f".repeat(64)}`);
  assert.equal(dead.status, 200);
  const deadHtml = await dead.text();
  assert.match(deadHtml, /This link cannot be used/);
  assert.doesNotMatch(deadHtml, /id="reset-password"/, "and offers no form");
});
