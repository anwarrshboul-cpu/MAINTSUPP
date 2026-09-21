/**
 * The authorization boundaries fixed in the security batch.
 *
 * Three findings, all confirmed by reading the code rather than guessed at, and
 * all INTRA-tenant: none of them crosses an organisation, because
 * `resolveTenantAccess` decides `orgId` from memberships and never from the
 * request. What they had in common was a boundary that existed on paper and was
 * not applied on some path.
 *
 *   1. `board.view` was not enforced on a set of read routes, so withdrawing the
 *      capability did not withdraw the reading. See the capability matrix below.
 *   2. A document anchored only to a JOB escaped the membership's site
 *      restriction, because the check resolved two anchors and a job is a third.
 *   3. Sign-in throttling was keyed on email AND ip, so an attacker spread over
 *      N addresses had 5N attempts per quarter hour against one account.
 *
 * WHY SOME OF THIS IS PINNED TO SOURCE RATHER THAN DRIVEN OVER HTTP.
 *
 * `memberships.site_scope` has no write route — nothing in `app/api/**` sets it
 * — so a live test of finding 2 would have to hand-edit the shared Miniflare
 * database, and `CLAUDE.md` records that fixtures written that way have
 * "repeatedly eaten other fixtures". The property that actually matters is that
 * the catalogue and the bytes apply the SAME anchors, and that is a source
 * invariant, so it is asserted as one. Finding 3 is pinned for a different
 * reason: proving the account counter over HTTP costs thirty deliberate failed
 * sign-ins against a real address, which is thirty audit rows and a locked
 * account, for a constant this file can read directly.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ================================================================== */
/* 2. A job's evidence is a site's document                            */
/* ================================================================== */

test("the site restriction resolves the job anchor, not only site and asset", async () => {
  /*
   * Both paths used to justify skipping the job anchor with the same sentence:
   * a document naming neither a site nor an asset — "a contractor's insurance
   * certificate, a job's evidence" — "is not about a site".
   *
   * Half of that is right. A contractor's insurance certificate is not about a
   * site. A job's evidence is: `maintenance_requests.site_id` exists, so the
   * before and after photographs of a job at a fourth store are a site's
   * documents reached one hop sideways, and a member confined to three stores
   * could read them.
   */
  const byId = await read("app/api/files/[id]/route.ts");

  assert.match(
    byId,
    /requestId: string \| null/,
    "outsideSiteScope must receive the job anchor to be able to check it",
  );
  assert.match(
    byId,
    /if \(record\.requestId\) \{[\s\S]{0,600}?maintenanceRequests\.siteId/,
    "outsideSiteScope must resolve the job's site",
  );
  assert.match(
    byId,
    /if \(!job\) return true;/,
    "a job that does not resolve is not proof of permission — the same rule the " +
      "asset branch already applies",
  );
  /*
   * RE-POINTED (Phase 9, the owner's decision Q5 of 2026-09-21). This asserted
   * `if (!job.siteId) return false;` — "a job with no site is genuinely not
   * about one and must still be allowed". Q5 rules the other way: for a
   * site-restricted member, absent or ambiguous linkage DENIES, and a job that
   * names no site proves nothing about the member's stores. The contract moved
   * from "allowed" to "denied", deliberately, and the decision is the reason.
   */
  assert.match(
    byId,
    /\/\* Q5: a job with no site is absent linkage, not an exemption\. \*\/\s*if \(!job\.siteId\) return true;/,
    "a job with no site is absent linkage under Q5 and must be denied",
  );
  assert.doesNotMatch(
    byId.replace(/\/\*[\s\S]*?\*\//g, ""),
    /if \(!job\.siteId\) return false;/,
    "the exemption must be gone from the code",
  );

  assert.ok(
    !/neither — a contractor's insurance certificate, a job's evidence — is not\s+\*\s+about a site/.test(byId),
    "the old justification must not survive the fix that contradicts it",
  );
});

test("the catalogue and the bytes narrow by the same three anchors", async () => {
  /*
   * THE INVARIANT THAT MATTERS, and the reason this is worth a test of its own.
   *
   * `/api/files` filters the LISTING; `/api/files/[id]` guards the BYTES. An id
   * is the capability for the bytes, so if the two ever disagree the weaker one
   * decides: a listing filter alone leaves documents downloadable to anyone who
   * learns an id elsewhere, which is exactly the hole the site restriction was
   * extended to close in the first place.
   */
  const listing = await read("app/api/files/route.ts");
  const byId = await read("app/api/files/[id]/route.ts");

  for (const [name, anchor] of [
    ["site", /siteScopeFilter/],
    ["asset", /unitScopeFilter/],
    ["job", /requestScopeFilter/],
  ]) {
    assert.match(listing, anchor, `the listing must narrow by the ${name} anchor`);
  }
  assert.match(
    listing,
    /const where = and\([\s\S]{0,400}?requestScopeFilter,/,
    "the job filter must be part of the shared `where`, which the count query " +
      "reuses — a filter built and not applied is worse than none",
  );

  for (const [name, anchor] of [
    ["site", /if \(record\.siteId\)/],
    ["asset", /if \(record\.unitId\)/],
    ["job", /if \(record\.requestId\)/],
  ]) {
    assert.match(byId, anchor, `the bytes path must check the ${name} anchor`);
  }
});

/* ================================================================== */
/* 3. Distributed sign-in guessing                                     */
/* ================================================================== */

test("sign-in is throttled per address as well as per address-and-IP", async () => {
  const src = await read("app/lib/auth-session.ts");

  assert.match(src, /function accountKey\(email: string\)/, "an address-only key must exist");
  assert.match(
    src,
    /return `account\|\$\{normaliseEmail\(email\)\}`/,
    "the address-only key must be `account|<email>` — an email always contains " +
      "`@`, so it can never collide with the `<email>|<ip>` key space",
  );

  assert.match(
    src,
    /blockedSeconds\(d1, failureKey\(email, ip\)\)[\s\S]{0,120}blockedSeconds\(d1, accountKey\(email\)\)/,
    "both counters must be read before a password is verified",
  );
  assert.match(
    src,
    /return Math\.max\(perIp, perAccount\);/,
    "the longer of the two blocks must win",
  );

  assert.match(
    src,
    /bumpFailureCounter\([\s\S]{0,200}failureKey\(email, ip\)[\s\S]{0,400}bumpFailureCounter\([\s\S]{0,200}accountKey\(email\)/,
    "every failure must bump both counters",
  );

  assert.match(
    src,
    /DELETE FROM sign_in_failures WHERE key IN \(\?, \?\)/,
    "a successful sign-in must clear BOTH counters — that is what stops the " +
      "address-only counter being a denial-of-service tool",
  );
  assert.match(
    src,
    /\.bind\(failureKey\(email, ip\), accountKey\(email\)\)/,
    "clearing must name both keys",
  );
});

test("the throttle's numbers are a bounded trade, not a lockout", async () => {
  /*
   * The existing per-IP counter's comment rejects keying on email alone,
   * because at five attempts and a fifteen-minute lockout that hands anybody a
   * way to lock a colleague out. That reasoning is correct and the per-IP
   * counter is unchanged.
   *
   * The address-only counter is safe because of its NUMBERS, not its key, and
   * this test is what holds those numbers in place. If somebody later tightens
   * the account threshold towards the per-IP one, the denial-of-service the
   * original comment warned about comes back — so the relationships are
   * asserted rather than the values, and the reason travels with them.
   */
  const src = await read("app/lib/auth-session.ts");
  const constant = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(src);
    assert.ok(m, `${name} must exist`);
    /* A numeric literal expression such as `60 * 60_000`, evaluated because it
       is read straight out of the source: the alternative is this test holding a
       second copy of the very numbers it exists to check, which is how a pin
       comes to agree with itself and with nothing else. The input is a capture
       from a `const NAME = ...;` match in a file in this repository, never
       anything a request can influence. */
    return Function(`"use strict"; return (${m[1]});`)();
  };

  const perIpMax = constant("MAX_FAILURES");
  const perIpLockout = constant("LOCKOUT_MS");
  const accountMax = constant("ACCOUNT_MAX_FAILURES");
  const accountWindow = constant("ACCOUNT_WINDOW_MS");
  const accountLockout = constant("ACCOUNT_LOCKOUT_MS");

  assert.ok(
    accountMax > perIpMax * 3,
    `the account threshold (${accountMax}) must be far above the per-IP one ` +
      `(${perIpMax}), or an ordinary person mistyping their password trips it`,
  );
  assert.ok(
    accountLockout < perIpLockout / 5,
    `the account lockout (${accountLockout}ms) must be far shorter than the ` +
      `per-IP one (${perIpLockout}ms): a fifteen-minute lockout after five ` +
      "attempts is a denial-of-service tool, a one-minute pause after thirty is not",
  );
  assert.ok(
    accountLockout <= 120_000,
    "the worst a harasser may cost somebody is a short wait",
  );
  assert.ok(
    accountWindow >= 30 * 60_000,
    "the account window must be long enough that spreading attempts over an " +
      "hour does not evade the cap",
  );
});

test("the sweep cannot collect a counter that is still accumulating", async () => {
  /*
   * The pruning DELETE is shared by both counters. It used to bind the per-IP
   * window; with a second counter measuring over an hour, that would delete a
   * twenty-minute-old account row that was still counting and hand the attacker
   * their budget back. Collecting late is a storage question — the module says
   * so — and collecting early is a correctness one.
   */
  const src = await read("app/lib/auth-session.ts");
  assert.match(
    src,
    /DELETE FROM sign_in_failures\s*\n?\s*WHERE blocked_until < \?1 AND \?1 - first_at > \?2`,\s*\n?\s*\)[\s\S]{0,600}?\.bind\(now, ACCOUNT_WINDOW_MS\)/,
    "the sweep must bind the LONGER window",
  );
});

test("the throttle statement keeps the shape the Postgres shim rewrites", async () => {
  /*
   * `tests/sqlite-to-postgres.test.mjs` records what happened the last time this
   * statement changed shape: a numbered parameter the shim did not translate
   * meant the write always threw, the catch swallowed it, the table never grew,
   * and the 429 branch was unreachable in production while every test still
   * passed. Refactoring the two counters onto one helper must not disturb it.
   */
  const src = await read("app/lib/auth-session.ts");
  assert.match(
    src,
    /INSERT INTO sign_in_failures \(key, count, first_at, blocked_until\)\s*\n\s*VALUES \(\?1, 1, \?2, 0\)\s*\n\s*ON CONFLICT\(key\) DO UPDATE SET/,
    "the upsert must keep its numbered-parameter form",
  );
  assert.match(
    src,
    /\.bind\(key, now, windowMs, maxFailures, lockoutMs\)/,
    "the five bindings must stay positional and in order",
  );
});

/* ================================================================== */
/* 1. The capability matrix, driven over HTTP                          */
/* ================================================================== */

/*
 * THE LIVE HALF.
 *
 * Everything above reads source. This reads the product, because the finding it
 * covers is not "a call is missing" but "the switch does nothing", and only a
 * request can show that. The shape is the one `tests/users-access-rbac.test.mjs`
 * established: invite real accounts into the demonstration workspace, act as
 * them, and deactivate them afterwards. Nothing outside
 * `@sec.test.maintsupp.com` is touched, and the role matrix is put back.
 *
 * Skips rather than fails when no dev server answers, like the other ~32 live
 * files. Run it ALONE — `node --test` runs files in parallel and starves the one
 * server, which fabricates failures that look like assertions.
 */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const DEMO = "org_000000000000000000000002";
const STAMP = `${Date.now()}`;
const PASSWORD = `sec fixture ${STAMP} ok`;

/** Routes that `board.view` must now gate. */
const GATED = [
  "/api/sites",
  "/api/assets",
  "/api/files",
  /* `registers=all` because this route insists on being asked one question at a
     time and answers 400 otherwise — the capability guard runs BEFORE that
     parse, so a revoked client still meets 403 here, but the happy-path half of
     this test has to send a request the route accepts. */
  "/api/contractors?registers=all",
  "/api/options",
  "/api/board/items?board=maintenance",
  "/api/workspace",
];

/** Routes that must stay open to every signed-in member, capability or not. */
const SELF_SCOPED = [
  "/api/account",
  "/api/account/sessions",
  "/api/navigation",
  "/api/notifications",
  "/api/dashboard-layout?surface=overview",
];

function jar(existing, response) {
  const next = new Map(
    (existing ?? "").split("; ").filter(Boolean).map((p) => [p.split("=")[0], p]),
  );
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    next.set(pair.split("=")[0], pair);
  }
  return [...next.values()].join("; ");
}

async function call(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(4000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

let ownerCookie = null;
async function asOwner() {
  if (ownerCookie) return ownerCookie;
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!response.ok) return null;
  ownerCookie = jar("", response);
  return ownerCookie;
}

const invitedAccounts = [];
async function onboard(role, label) {
  const cookie = await asOwner();
  const email = `sec-${label}-${STAMP}@sec.test.maintsupp.com`;
  const created = await call(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role, organisationId: DEMO }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  invitedAccounts.push(email);
  const token = String(created.body.inviteUrl).split("/invite/")[1];
  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, fullName: `SEC ${label}` }),
  });
  assert.equal(accepted.status, 201);
  return { email, cookie: jar("", accepted) };
}

const setCapability = (cookie, role, capability, allowed) =>
  call(cookie, "/api/admin/roles", {
    method: "PUT",
    body: JSON.stringify({ organisationId: DEMO, changes: [{ role, capability, allowed }] }),
  });

after(async () => {
  if (!serverUp || !ownerCookie || !invitedAccounts.length) return;
  // Put the matrix back whatever happened above, then switch off every account
  // this run created. Never deleted — the product does not delete people.
  await setCapability(ownerCookie, "client", "board.view", null);
  const roster = await call(ownerCookie, `/api/admin/users?organisationId=${DEMO}`);
  for (const user of roster.body?.users ?? []) {
    if (!invitedAccounts.includes(user.email) || !user.active) continue;
    await call(ownerCookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: user.id, action: "deactivate", organisationId: DEMO }),
    });
  }
});

test(
  "live: revoking board.view actually closes the read routes it names",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");

    const client = await onboard("client", "client");
    const manager = await onboard("manager", "manager");

    /*
     * THE WHOLE POINT, IN TWO HALVES.
     *
     * Before this batch a `client` read every route below with `board.view`
     * withdrawn, because the routes resolved tenancy and never asked. The
     * capability was a switch in the matrix that closed `/api/board` and
     * `/api/maintenance` and left the site register, the asset register, the
     * document index and the dashboard's own read wide open.
     *
     * Note what this does NOT assert: that a default client is refused. Every
     * role holds `board.view` by default, so the first half proves the fix is
     * behaviour-preserving, and the second proves the switch now works.
     */
    for (const path of GATED) {
      const open = await call(client.cookie, path);
      assert.equal(open.status, 200, `a default client should still read ${path}`);
    }

    const revoked = await setCapability(ownerCookie, "client", "board.view", false);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

    for (const path of GATED) {
      const closed = await call(client.cookie, path);
      assert.equal(
        closed.status,
        403,
        `${path} must refuse a client whose board.view was withdrawn — before ` +
          "this batch it answered 200",
      );
    }

    /* The withdrawal is per role, not per workspace. */
    for (const path of GATED) {
      const still = await call(manager.cookie, path);
      assert.equal(still.status, 200, `a manager keeps ${path}`);
    }

    /* And the routes that must never need a capability still answer, or the
       fix would have locked a client out of their own account and sidebar. */
    for (const path of SELF_SCOPED) {
      const own = await call(client.cookie, path);
      assert.equal(
        own.status,
        200,
        `${path} is the caller's OWN data and must stay open even with ` +
          "board.view withdrawn",
      );
    }

    const restored = await setCapability(ownerCookie, "client", "board.view", null);
    assert.equal(restored.status, 200);
    const reopened = await call(client.cookie, GATED[0]);
    assert.equal(reopened.status, 200, "restoring the capability must reopen the route");
  },
);

test(
  "live: the staff directory is withheld from a reader who may not see people",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
    const client = await onboard("client", "pii");

    /*
     * `client` holds `board.view` and not `users.view`, which is the pairing
     * these three payloads are narrowed for. An Owner holds both, so the same
     * reads are asserted to still carry the directory — a narrowing that
     * withheld it from everybody would be a regression dressed as a fix.
     */
    const asClient = await call(client.cookie, "/api/workspace");
    assert.equal(asClient.status, 200);
    assert.deepEqual(
      asClient.body.workspace.team,
      [],
      "the dashboard's primary read must not ship the staff directory to a " +
        "client — every user row with email, role and lastActive",
    );
    for (const entry of asClient.body.workspace.activity ?? []) {
      assert.equal(entry.actorEmail, null, "the activity feed must not name colleagues");
    }

    const teams = await call(client.cookie, "/api/teams");
    assert.equal(teams.status, 200, "the rota stays legible");
    assert.deepEqual(
      teams.body.people,
      [],
      "`people` is the directory, and it exists for a picker only teams.manage can use",
    );

    const members = await call(client.cookie, "/api/board/members");
    assert.equal(members.status, 200, "the assignee picker must keep working");
    assert.ok(members.body.members.length > 0, "the picker needs names");
    for (const member of members.body.members) {
      assert.ok(member.name, "a picker entry still needs a name");
      if (!member.isMe) {
        assert.equal(
          member.email,
          null,
          "a colleague's address is not needed to assign work to them",
        );
      }
    }

    /* The Owner, who holds users.view, still sees all three. */
    const asOwnerWorkspace = await call(ownerCookie, "/api/workspace");
    assert.ok(
      asOwnerWorkspace.body.workspace.team.length > 0,
      "an owner must still see the roster — narrowing it for everybody would be " +
        "a regression, not a fix",
    );
    const ownerMembers = await call(ownerCookie, "/api/board/members");
    assert.ok(
      ownerMembers.body.members.some((m) => m.email),
      "an owner must still see addresses",
    );
  },
);

/* ================================================================== */
/* 5. The two account panels, narrowed in the payload                  */
/* ================================================================== */

test("the Trash panel's deletion history answers to audit.read", async () => {
  /*
   * The screen holds two different things and they have different boundaries.
   * The recovery matrix says WHAT can be brought back and from where, which is
   * useful to anybody who might have deleted something. `deletions` is up to two
   * hundred rows of `activity_log` and `audit_events`, each naming the colleague
   * who deleted a record — the deletion half of the audit log, served from an
   * avatar-menu panel with no role gate.
   *
   * `/api/audit` requires `audit.read` for the same rows. Two routes reading one
   * table and disagreeing about who may see it is not a boundary; the looser one
   * simply decides.
   */
  const src = await read("app/api/account/trash/route.ts");
  assert.match(
    src,
    /can\(subject, "audit\.read"\)/,
    "the history must ask the same capability /api/audit asks",
  );
  assert.match(
    src,
    /deletions: mayReadAudit \? deletions : \[\]/,
    "the history must be withheld from a reader without audit.read",
  );
  assert.match(
    src,
    /recoveryMatrix: RECOVERY_MATRIX,/,
    "the recovery matrix must stay open — it is the actionable half, and " +
      "ROLE_CEILINGS means a manager could never get it back",
  );
  assert.ok(
    !/scopedDbWithCapability\(request, "audit\.read"\)/.test(src),
    "it must be narrowed in the payload, not gated at the door: a manager can " +
      "never hold audit.read, so gating would take the recovery matrix away " +
      "from them permanently",
  );
});

test("the platform panel separates the workspace's figures from the installation's", async () => {
  /*
   * Everything counted in this route is the workspace's own — how many
   * contractor job links are live, expired or revoked, and how its notifications
   * were delivered. Three blocks are not: `support` carries the operator's inbox
   * addresses, `integrations` says which secrets are configured, and
   * `publicEndpoints` maps the two routes that accept an unauthenticated
   * request.
   *
   * Not a tenancy hole — every query is `eq(organisationId, orgId)`, checked —
   * but a description of the installation served to any member from a panel with
   * no role gate.
   */
  const src = await read("app/api/account/platform/route.ts");
  assert.match(src, /can\(subject, "settings\.edit"\)/);
  assert.match(
    src,
    /if \(mayReadPosture\) return Response\.json\(\{ platform \}\);/,
    "a permitted reader must get the whole thing",
  );
  for (const withheld of [/publicEndpoints: \[\]/, /integrations: \[\]/, /support: null/]) {
    assert.match(src, withheld, "the installation's description must be withheld");
  }
  assert.match(
    src,
    /developers: \{ \.\.\.platform\.developers/,
    "the workspace's own token counts must survive the narrowing",
  );
  assert.ok(
    !/scopedDbWithCapability\(request, "settings\.edit"\)/.test(src),
    "payload, not door: a manager can never hold settings.edit, and gating " +
      "would take the workspace's own figures away to withhold something that " +
      "is not about the workspace at all",
  );
});

test(
  "live: the account panels withhold the installation, not the workspace",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
    const client = await onboard("client", "panels");

    /* A client holds neither `audit.read` nor `settings.edit`. */
    const trash = await call(client.cookie, "/api/account/trash");
    assert.equal(trash.status, 200, "the recovery matrix must stay reachable");
    assert.ok(
      (trash.body.trash.recoveryMatrix ?? []).length > 0,
      "the actionable half must survive",
    );
    assert.deepEqual(trash.body.trash.deletions, [], "the audit history must not");
    assert.equal(trash.body.trash.canReadHistory, false);

    const platform = await call(client.cookie, "/api/account/platform");
    assert.equal(platform.status, 200, "the workspace's own figures stay reachable");
    assert.ok(
      (platform.body.platform.developers?.credentials ?? []).length > 0,
      "the workspace's contractor-link counts must survive",
    );
    assert.deepEqual(platform.body.platform.integrations, []);
    assert.deepEqual(platform.body.platform.developers.publicEndpoints, []);
    assert.equal(platform.body.platform.support, null);
    assert.equal(platform.body.platform.canReadPosture, false);

    /* And the owner, who holds both, still sees everything. */
    const ownerTrash = await call(ownerCookie, "/api/account/trash");
    assert.equal(ownerTrash.body.trash.canReadHistory, true);
    const ownerPlatform = await call(ownerCookie, "/api/account/platform");
    assert.ok(
      ownerPlatform.body.platform.support,
      "an owner must still see the operator's contact block — withholding it " +
        "from everybody would be a regression, not a fix",
    );
    assert.ok((ownerPlatform.body.platform.integrations ?? []).length > 0);
  },
);
