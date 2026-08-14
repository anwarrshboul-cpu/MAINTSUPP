/**
 * Stage 23 — invitations that can actually be delivered, and taken back.
 *
 * The mechanism was complete before this: a token was minted, hashed, stored,
 * and `/invite/[token]` honoured it. What was missing was the *product*. The
 * admin screen sent an invitation, was told "Saved.", and dropped the one and
 * only copy of the link on the floor — `adminWrite` returned `{ok, message}`
 * and nothing else. Nobody could be told how to accept, and because only the
 * hash is stored, nothing could hand the link back afterwards. There was also
 * no way to withdraw a link sent to the wrong address: it stayed live in that
 * inbox until it expired, and the row sat in "Pending" looking normal.
 *
 * Two halves, following the Stage 20 pattern. The first reads the source and
 * pins the decisions a passing request cannot demonstrate — a screen that
 * discarded the link would still return 201. The second drives the real loop
 * against a running server and skips when nothing is listening.
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

test("the write helper carries the server's reply back to the caller", async () => {
  const source = await read("app/(app)/portal/views/admin-shell.tsx");

  // The bug, in one line: `{ ok: true, message: "Saved." }` with no payload.
  assert.match(
    source,
    /return \{ ok: true, message: "Saved\.", status: response\.status, payload \}/,
    "adminWrite must return the parsed payload — the invitation link rides on it",
  );
  assert.match(
    source,
    /method: "POST" \| "PATCH" \| "PUT" \| "DELETE"/,
    "withdrawing an invitation is a DELETE, so the helper has to speak it",
  );
  assert.match(
    source,
    /body === undefined \? undefined : JSON\.stringify\(body\)/,
    "a DELETE carries its arguments in the query string and must not be given a body",
  );
});

test("the invitation link is shown, and not as a message that fades", async () => {
  const source = await read("app/(app)/portal/views/admin-users.tsx");

  assert.match(source, /function IssuedLink\(/, "there is a panel for the link");
  assert.match(
    source,
    /navigator\.clipboard\.writeText\(issued\.url\)/,
    "one click copies it",
  );
  // Clipboard access is refused over plain http and by some policies. A button
  // that says "Copied" when nothing was copied loses the workspace's only copy.
  assert.match(
    source,
    /Copying was blocked/,
    "a refused copy must say so rather than claim success",
  );
  assert.match(
    source,
    /readOnly\s+value=\{issued\.url\}/,
    "the link is selectable, so it can be copied by hand when the clipboard is blocked",
  );
  // The screen must not claim to have sent an email. Nothing is sent.
  assert.doesNotMatch(
    source,
    /"Send invitation"|Sending…/,
    "no mail server exists — the button cannot promise delivery",
  );
});

test("the pending table treats expiry as a state, and offers both actions", async () => {
  const source = await read("app/(app)/portal/views/admin-users.tsx");

  assert.match(source, /admin-status-chip--expired/, "an expired invitation reads as expired");
  assert.match(source, /invitation\.expired \? "Send a new link" : "Get the link again"/);
  assert.match(source, /async function revoke\(invitation: Invitation\)/);
  assert.match(
    source,
    /\(data\?\.invitations \?\? \[\]\)\.filter\(\(invitation\) => !invitation\.expired\)\.length/,
    "a dead invitation is not somebody the workspace is waiting for",
  );
  // Both actions are gated in the UI as well as on the server.
  assert.match(source, /\{can\("users\.invite"\) \? \(\s*<td>/);
});

test("revoking is gated, scoped to the workspace, and keeps the row", async () => {
  const source = await read("app/api/admin/users/route.ts");

  assert.match(source, /export async function DELETE\(request: Request\)/);
  assert.match(
    source,
    /requireCapability\(context\.subject, "users\.invite"\)/,
    "the power to withdraw is the power to issue",
  );
  // The organisation is part of the lookup, so another tenant's id finds
  // nothing rather than being refused — which would confirm it exists.
  assert.match(
    source,
    /eq\(invitations\.organisationId, context\.targetOrganisationId\)/,
  );
  assert.match(
    source,
    /\.set\(\{ revokedAt: new Date\(\)\.toISOString\(\) \}\)/,
    "revoked, not deleted: who invited whom, and who called it back, survives",
  );
  assert.match(source, /action: "user\.invitation_revoked"/);
  assert.match(
    source,
    /expired: row\.expiresAt \? Date\.parse\(row\.expiresAt\) <= now : false/,
  );
});

test("reissuing cannot leave two live links to one workspace", async () => {
  const source = await read("app/api/auth/invitations/invitation-tokens.ts");

  // "Send a new link" is a second POST. It is only safe because minting one
  // revokes any outstanding invitation to the same address first.
  assert.match(
    source,
    /UPDATE invitations\s+SET revoked_at = \?\s+WHERE organisation_id = \?\s+AND lower\(email\) = \?\s+AND accepted_at IS NULL\s+AND revoked_at IS NULL/,
  );
});

/* ------------------------------------------------------------------ */
/* The loop, against a running server                                  */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(2_500),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!response.ok) return null;
  return (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
}

const json = async (cookie, path, init = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

test("invite, reissue, withdraw — and the link dies each time it should", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  // Unique per run: an invitation is single use, so the accept path cannot
  // reuse an address, and a leftover row would make the next run ambiguous.
  const email = `stage23-invite-${Date.now()}@stage23.test.maintsupp.com`;
  const tokenOf = (url) => String(url).split("/invite/")[1];

  const created = await json(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role: "client" }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.inviteUrl, "the link comes back to the admin who issued it");

  const first = tokenOf(created.body.inviteUrl);
  assert.equal(
    (await fetch(`${BASE_URL}/api/auth/invitations/${first}`)).status,
    200,
    "the link resolves to a real invitation",
  );

  const listed = await json(cookie, "/api/admin/users");
  const pending = listed.body.invitations.find((row) => row.email === email);
  assert.ok(pending, "and appears in the pending table");
  assert.equal(pending.expired, false);

  // Reissue. The new link works; the old one is gone, not merely hidden.
  const again = await json(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role: "client" }),
  });
  assert.equal(again.status, 201);
  const second = tokenOf(again.body.inviteUrl);
  assert.notEqual(second, first);
  assert.equal((await fetch(`${BASE_URL}/api/auth/invitations/${first}`)).status, 410);
  assert.equal((await fetch(`${BASE_URL}/api/auth/invitations/${second}`)).status, 200);

  const refreshed = await json(cookie, "/api/admin/users");
  const live = refreshed.body.invitations.find((row) => row.email === email);

  const withdrawn = await json(
    cookie,
    `/api/admin/users?invitationId=${encodeURIComponent(live.id)}`,
    { method: "DELETE" },
  );
  assert.equal(withdrawn.status, 200);
  assert.equal(
    (await fetch(`${BASE_URL}/api/auth/invitations/${second}`)).status,
    410,
    "withdrawing kills the link that is already in somebody's inbox",
  );

  // A second click is not an error, and an id from nowhere is not found.
  const twice = await json(
    cookie,
    `/api/admin/users?invitationId=${encodeURIComponent(live.id)}`,
    { method: "DELETE" },
  );
  assert.equal(twice.status, 200);
  assert.equal(twice.body.alreadyRevoked, true);

  const nowhere = await json(cookie, "/api/admin/users?invitationId=inv_nothing", {
    method: "DELETE",
  });
  assert.equal(nowhere.status, 404);

  const finally_ = await json(cookie, "/api/admin/users");
  assert.equal(
    finally_.body.invitations.filter((row) => row.email === email).length,
    0,
    "a withdrawn invitation leaves the pending list",
  );
});
