/**
 * Phase 9 — the security findings that were still open on `9ff0806`.
 *
 * Every one was reproduced before it was fixed. `6b21a76` had already closed
 * the per-address sign-in counter and `board.view` on twenty-two read routes;
 * what remained, and what this file holds:
 *
 *   #3  A document with no site, asset or job anchor — a contractor's — escaped
 *       a site-restricted member's scope, and so did one on a job naming no
 *       site. The owner's decision Q5 (2026-09-21, option B): allowed only
 *       through a contractor genuinely linked to one of the member's sites;
 *       absent or ambiguous linkage denies.
 *   #4  The public form doors — lookup, password, submit — had no throttle.
 *   #5  The default share link carried a 48-bit token.
 *   #6  `billing.manage` ignored the workspace's roles matrix.
 *   #8  `requestIp` believed a `cf-connecting-ip` header the CALLER writes,
 *       on a platform with no Cloudflare in front of it. Reproduced on a
 *       Preview: a forged address was recorded against the session.
 *   and four read doors `6b21a76` missed: the file bytes, the board roster,
 *   the teams payload's addresses, and `contractor-sites`.
 *
 * Where a rule can be CALLED it is — `requestIp` and `outsideSiteScope` are
 * transpiled out of their files and run against inputs, so the matrix below is
 * the product's own decision, not a re-implementation of it. The rest reads
 * source; re-point a pin at the contract's new home, never delete it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";

const ts = (await import("typescript")).default;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** One top-level function, by name, up to its closing brace at column zero. */
function fnSource(source, name) {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} has moved; fix this test`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2).replace(/^export /, "");
}

const js = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/* ================================================================== */
/* #8 — the client address comes from the edge, not from the caller    */
/* ================================================================== */

test("#8 on Vercel a caller-written cf-connecting-ip is ignored", async () => {
  const source = await read("app/lib/auth-session.ts");
  const make = (env) =>
    new Function("process", `${js(fnSource(source, "requestIp"))}; return requestIp;`)({ env });
  const request = (headers) => new Request("https://maintsupp.com/", { headers });

  const onVercel = make({ VERCEL: "1" });
  assert.equal(
    onVercel(request({ "cf-connecting-ip": "203.0.113.77", "x-real-ip": "198.51.100.4" })),
    "198.51.100.4",
    "the address Vercel's edge wrote wins over the one the caller wrote",
  );
  assert.equal(
    onVercel(request({ "cf-connecting-ip": "203.0.113.77", "x-forwarded-for": "198.51.100.5, 10.0.0.1" })),
    "198.51.100.5",
  );
  assert.equal(onVercel(request({ "cf-connecting-ip": "203.0.113.77" })), "unknown");

  /* A bundle built where `VERCEL` was absent still recognises the edge. */
  const unsetEnv = make({});
  assert.equal(
    unsetEnv(request({ "x-vercel-id": "fra1::abc", "cf-connecting-ip": "203.0.113.77", "x-real-ip": "198.51.100.6" })),
    "198.51.100.6",
  );

  /* Local development runs on the Workers runtime, whose header is its own. */
  assert.equal(unsetEnv(request({ "cf-connecting-ip": "127.0.0.1" })), "127.0.0.1");
});

/* ================================================================== */
/* #3 — Q5: documents and the site restriction                          */
/* ================================================================== */

/**
 * `outsideSiteScope`, run against a stub database.
 *
 * The drizzle helpers are replaced by markers and the three tables by column
 * names, so the function's own control flow decides every case. Rows:
 *   units      u-in  -> site s-in,   u-out -> site s-out
 *   jobs       j-in  -> site s-in,   j-out -> site s-out,  j-none -> no site
 *   links      c-linked -> s-in,     c-elsewhere -> s-out
 */
async function loadOutsideSiteScope() {
  /* RE-POINTED (site-scope reads, 2026-09-22): the rule moved, body unchanged,
     from `app/api/files/[id]/route.ts` to `app/api/files/documents.ts` so the
     two upload doors ask it too — one rule, not a second copy. */
  const source = await read("app/api/files/documents.ts");
  const table = (name, ...cols) =>
    Object.fromEntries([["__name", name], ...cols.map((col) => [col, `${name}.${col}`])]);
  const units = table("units", "id", "siteId", "organisationId");
  const maintenanceRequests = table("jobs", "id", "siteId", "organisationId");
  const contractorSites = table("links", "id", "contractorId", "siteId", "organisationId");
  const rows = {
    units: [
      { id: "u-in", siteId: "s-in" },
      { id: "u-out", siteId: "s-out" },
    ],
    jobs: [
      { id: "j-in", siteId: "s-in" },
      { id: "j-out", siteId: "s-out" },
      { id: "j-none", siteId: null },
    ],
    links: [
      { id: "l1", contractorId: "c-linked", siteId: "s-in" },
      { id: "l2", contractorId: "c-elsewhere", siteId: "s-out" },
    ],
  };
  const eq = (col, value) => ({ op: "eq", col, value });
  const inArray = (col, values) => ({ op: "in", col, values });
  const and = (...parts) => ({ op: "and", parts });
  const matches = (row, cond) => {
    if (cond.op === "and") return cond.parts.every((part) => matches(row, part));
    const field = cond.col.split(".")[1];
    if (field === "organisationId") return cond.value === "org";
    if (cond.op === "eq") return row[field] === cond.value;
    return cond.values.includes(row[field]);
  };
  const db = {
    select: () => ({
      from: (t) => ({
        where: (cond) => ({
          limit: async () => rows[t.__name].filter((row) => matches(row, cond)).slice(0, 1),
        }),
      }),
    }),
  };
  const fn = new Function(
    "and",
    "eq",
    "inArray",
    "units",
    "maintenanceRequests",
    "contractorSites",
    `${js(fnSource(source, "outsideSiteScope"))}; return outsideSiteScope;`,
  )(and, eq, inArray, units, maintenanceRequests, contractorSites);
  return (record) =>
    fn(db, "org", ["s-in"], {
      siteId: null,
      unitId: null,
      requestId: null,
      contractorId: null,
      ...record,
    });
}

test("#3 Q5: a restricted member reaches a document only through their own sites", async () => {
  const outside = await loadOutsideSiteScope();
  const cases = [
    /* the anchors that were already honoured */
    [{ siteId: "s-in" }, false, "a document at a permitted site"],
    [{ siteId: "s-out" }, true, "a document at another site"],
    [{ unitId: "u-in" }, false, "an asset at a permitted site"],
    [{ unitId: "u-out" }, true, "an asset at another site"],
    [{ unitId: "u-gone" }, true, "an asset that does not resolve is not proof"],
    [{ requestId: "j-in" }, false, "a job at a permitted site"],
    [{ requestId: "j-out" }, true, "a job at another site"],
    [{ requestId: "j-gone" }, true, "a job that does not resolve is not proof"],
    /* Q5 — what changed */
    [{ requestId: "j-none" }, true, "a job naming no site is absent linkage, and denies"],
    [{ contractorId: "c-linked" }, false, "a contractor linked to a permitted site"],
    [{ contractorId: "c-elsewhere" }, true, "a contractor linked only elsewhere"],
    [{ contractorId: "c-unlinked" }, true, "a contractor with no link at all"],
    [{}, true, "a document with no anchor at all"],
    /* every anchor must agree, not the first one present */
    [{ siteId: "s-in", requestId: "j-out" }, true, "a permitted site does not excuse a forbidden job"],
    [{ siteId: "s-in", unitId: "u-out" }, true, "nor a forbidden asset"],
    [{ siteId: "s-in", requestId: "j-in" }, false, "every anchor permitted"],
    [{ siteId: "s-in", contractorId: "c-elsewhere" }, false, "a site anchor decides; the contractor rule is for contractor-only documents"],
  ];
  for (const [record, denied, why] of cases) {
    assert.equal(await outside(record), denied, why);
  }
});

test("#3 Q5: the listing applies the same rule as the bytes", async () => {
  const listing = code(await read("app/api/files/route.ts"));
  assert.match(
    listing,
    /const unanchoredScopeFilter = permittedSites\s*\?\s*or\(\s*isNotNull\(attachments\.siteId\),\s*isNotNull\(attachments\.unitId\),\s*isNotNull\(attachments\.requestId\),\s*inArray\(\s*attachments\.contractorId,[\s\S]{0,200}?\.from\(contractorSites\)/,
    "a document with no site, asset or job is listed only through a contractor_sites link",
  );
  assert.match(
    listing,
    /requestScopeFilter,\s*unanchoredScopeFilter,/,
    "and the filter is part of the shared `where` the count query reuses",
  );
  const requestFilter = listing.slice(
    listing.indexOf("const requestScopeFilter"),
    listing.indexOf("const unanchoredScopeFilter"),
  );
  assert.doesNotMatch(
    requestFilter,
    /isNull\(maintenanceRequests\.siteId\)/,
    "a job naming no site is no longer admitted",
  );
});

test("#3 the write doors refuse a document outside the member's sites", async () => {
  const byId = await read("app/api/files/[id]/route.ts");
  const handler = (name) => {
    const start = byId.indexOf(`export async function ${name}(`);
    return byId.slice(start, byId.indexOf("\n}\n", start));
  };
  for (const name of ["PATCH", "PUT", "DELETE"]) {
    assert.match(
      handler(name),
      /writeOutsideSiteScope\(guard\.scope, (record|located)\)/,
      `${name} must ask the site restriction before it changes anything`,
    );
  }
  /* PUT used to select only the object key, which carries no anchor. */
  assert.match(handler("PUT"), /contractorId: attachments\.contractorId,/);
});

/* ================================================================== */
/* The read doors 6b21a76 missed                                       */
/* ================================================================== */

test("the file bytes ask for board.view on the session path, before the lookup", async () => {
  const byId = code(await read("app/api/files/[id]/route.ts"));
  const get = byId.slice(byId.indexOf("export async function GET("), byId.indexOf("\n}\n", byId.indexOf("export async function GET(")));
  const gate = get.indexOf('requireCapability(subject, "board.view")');
  const lookup = get.indexOf(".from(attachments)");
  assert.ok(gate > 0, "the bytes must ask what the listing asks");
  assert.ok(gate < lookup, "before the row lookup, so a refusal says nothing about the id");
  assert.match(get, /if \(!linkScope\) \{\s*const subject = await resolvePermissions/, "the contractor job link has no role and stays exempt");
});

test("the board roster asks for board.view; the teams payload withholds addresses", async () => {
  const members = code(await read("app/api/board/members/route.ts"));
  assert.match(members, /const viewRefusal = requireCapability\(subject, "board\.view"\);\s*if \(viewRefusal\) return viewRefusal;/);

  const teams = code(await read("app/api/teams/route.ts"));
  assert.match(teams, /const mayReadAddresses = mayManage \|\| can\(subject, "users\.view"\);/);
  assert.match(teams, /member\.userId === me \? member : \{ \.\.\.member, email: null \}/);
  assert.match(teams, /teams: legible,/);
  assert.doesNotMatch(
    teams,
    /scopedDbWithCapability\(request, "users\.view"\)/,
    "payload, not door: users.view is unholdable by a manager",
  );
  const screen = await read("app/(app)/portal/views/teams-manager.tsx");
  assert.match(screen, /email: string \| null;/, "the Team screen tolerates a withheld address");
});

test("contractor-sites honours the site restriction on read, link and unlink", async () => {
  const route = code(await read("app/api/contractor-sites/route.ts"));
  assert.match(route, /const allowed = memberSiteSet\(scope\.siteScope\);/);
  assert.match(route, /\)\.filter\(\(row\) => withinMemberScope\(allowed, row\.id\)\);/, "a contractor's sites, inside the reach only");
  assert.match(route, /if \(!existing \|\| !withinMemberScope\(memberSiteSet\(scope\.siteScope\), existing\.siteId\)\)/);
});

/* ================================================================== */
/* #4 / #5 — the public form doors                                      */
/* ================================================================== */

test("#4 every public form door is throttled before it does work", async () => {
  const lookupAndPassword = code(await read("app/api/forms/[token]/route.ts"));
  const submit = code(await read("app/api/forms/[token]/submit/route.ts"));

  for (const [name, source] of [["form route", lookupAndPassword], ["submit", submit]]) {
    assert.match(
      source,
      /const missWait = await publicRetryAfter\(d1, FORM_LOOKUP_MISSES, ip\);\s*if \(missWait > 0\) return tooManyAttempts\(missWait\);\s*const record = await loadFormByToken\(db, token\);\s*if \(!record\) \{\s*await recordPublicAttempt\(d1, FORM_LOOKUP_MISSES, ip\);/,
      `${name}: a guessed token counts against the address, and a blocked address is refused before the lookup`,
    );
  }

  const submitWait = submit.indexOf("publicRetryAfter(d1, FORM_SUBMISSIONS, submitter)");
  const counted = submit.indexOf("recordPublicAttempt(d1, FORM_SUBMISSIONS, submitter)");
  const firstGate = submit.indexOf("formAvailability(record)");
  const firstWrite = submit.indexOf("createSubmission(");
  assert.ok(submitWait > 0 && counted > submitWait, "checked, then counted");
  assert.ok(counted < firstGate, "every attempt that reaches a real form counts, accepted or not");
  assert.ok(firstWrite < 0 || counted < firstWrite);

  const post = lookupAndPassword.slice(lookupAndPassword.indexOf("export async function POST("));
  const passwordWait = post.indexOf("publicRetryAfter(d1, FORM_PASSWORD_FAILURES, subject)");
  const derive = post.indexOf("verifyFormPassword(");
  assert.ok(passwordWait > 0 && passwordWait < derive, "a blocked caller spends no PBKDF2");
  assert.match(post, /await recordPublicAttempt\(d1, FORM_PASSWORD_FAILURES, subject\);\s*return Response\.json\(\{ error: "That password is not right\." \}/);
});

test("#4 the throttles share sign-in's table without sharing its key space", async () => {
  const auth = await read("app/lib/auth-session.ts");
  assert.match(auth, /return `throttle:\$\{throttle\.name\}\|\$\{subject\}`;/);
  assert.match(
    code(fnSource(auth, "recordPublicAttempt")),
    /bumpFailureCounter\(\s*d1,\s*throttleKey\(throttle, subject\),\s*now,\s*Math\.min\(throttle\.windowMs, ACCOUNT_WINDOW_MS\),/,
    "the same one-statement upsert, and no window longer than the sweep honours",
  );

  const throttles = await read("app/lib/form-throttle.ts");
  const windows = [...throttles.matchAll(/windowMs: (\d+) \* 60_000/g)].map((m) => Number(m[1]));
  /* Re-pointed 3 → 4 for the direct-upload batch: `REPORT_JOB_SUBMISSIONS`
     throttles the home page's anonymous report door, whose upload token is now
     worth up to 50 MB of storage. The lock still makes every addition visible. */
  /* Re-pointed 4 → 6 for the public intake batch: `LEAD_SUBMISSIONS` and
     `CONTRACTOR_APPLICATIONS` throttle the marketing site's other two anonymous
     doors, which had a honeypot and nothing respectively. */
  assert.equal(windows.length, 6);
  for (const minutes of windows) assert.ok(minutes <= 60, "within the sweep's hour");
  /* Keyed per address, never per form alone — a per-form cap is a way to close
     a client's fault form to everybody. */
  const submit = await read("app/api/forms/[token]/submit/route.ts");
  assert.match(submit, /const submitter = `\$\{record\.id\}\|\$\{ip\}`;/);
  const report = await read("app/api/report-job/route.ts");
  assert.match(report, /publicRetryAfter\(d1, REPORT_JOB_SUBMISSIONS, address\)/, "the report door is keyed per address too");
});

test("#4 the public form says 'wait', not 'wrong password', when throttled", async () => {
  const page = await read("app/(public)/f/[token]/public-form.tsx");
  assert.match(page, /response\.status === 429 && result\.error \? result\.error : "That password is not right\."/);
});

test("#5 new short links carry 64 bits; existing ones keep working", async () => {
  const config = await read("app/lib/form-config.ts");
  const make = new Function(`${js(fnSource(config, "generateShortToken"))}; return generateShortToken;`)();
  const token = make();
  assert.match(token, /^[0-9a-f]{16}$/);
  assert.notEqual(make(), token);
  assert.match(
    config,
    /if \(!shareToken \|\| !\/\^\[a-f0-9\]\{10,64\}\$\/i\.test\(shareToken\)\) return null;/,
    "twelve-character links already handed out must still resolve",
  );
});

/* ================================================================== */
/* #6 — billing.manage answers from the matrix                          */
/* ================================================================== */

test("#6 billing.manage is answered by the workspace's matrix, and the ceilings still hold", async () => {
  const route = code(await read("app/api/finance/settings/route.ts"));
  /* Re-pointed 2026-09-22: resolvePermissions now takes the member's site scope (required 4th argument, for SITE_RESTRICTED_CEILING). */
  assert.match(route, /const subject = await resolvePermissions\(scope\.db, scope\.orgId, scope\.actor\.role, scope\.siteScope\);\s*return can\(subject, "billing\.manage"\);/);
  assert.doesNotMatch(route, /Only a workspace owner/, "an Owner is the one role the ceilings bar from it");
  const permissions = await read("app/lib/permissions.ts");
  assert.match(permissions, /owner: new Set<Capability>\(\["billing\.manage", "data\.delete"\]\)/);
  assert.doesNotMatch(
    permissions,
    /masks every account number/,
    "the catalogue must not describe a mask over digits the product no longer stores",
  );
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

/*
 * Same shape as `security-authorization-boundaries`: invite real accounts into
 * the demonstration workspace, act as them, put the matrix back and deactivate
 * them. Nothing outside `@sec.test.maintsupp.com` is touched. The form
 * throttles are NOT driven here: thirty deliberate misses would lock the dev
 * server's one address out of every public form for ten minutes, and every
 * other live file that opens a form would fail for a reason that is not theirs.
 * They are driven against a deployed Preview instead (see the handoff).
 */
const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const DEMO = "org_000000000000000000000002";
const STAMP = `${Date.now()}`;
const PASSWORD = `p9 fixture ${STAMP} ok`;

function jar(existing, response) {
  const next = new Map((existing ?? "").split("; ").filter(Boolean).map((p) => [p.split("=")[0], p]));
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

const invited = [];
async function onboard(role, label) {
  const cookie = await asOwner();
  const email = `p9-${label}-${STAMP}@sec.test.maintsupp.com`;
  const created = await call(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role, organisationId: DEMO }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  invited.push(email);
  const token = String(created.body.inviteUrl).split("/invite/")[1];
  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, fullName: `P9 ${label}` }),
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
  if (!serverUp || !ownerCookie || !invited.length) return;
  await setCapability(ownerCookie, "client", "board.view", null);
  await setCapability(ownerCookie, "admin", "billing.manage", null);
  const roster = await call(ownerCookie, `/api/admin/users?organisationId=${DEMO}`);
  for (const user of roster.body?.users ?? []) {
    if (!invited.includes(user.email) || !user.active) continue;
    await call(ownerCookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: user.id, action: "deactivate", organisationId: DEMO }),
    });
  }
});

test("live: withdrawing board.view closes the roster and the file bytes too", { skip: !serverUp }, async (t) => {
  if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
  const client = await onboard("client", "bytes");

  const listing = await call(ownerCookie, "/api/files?limit=1");
  const fileId = listing.body?.files?.[0]?.id ?? null;

  assert.equal((await call(client.cookie, "/api/board/members")).status, 200, "a default client keeps the roster");
  if (fileId) {
    const open = await call(client.cookie, `/api/files/${fileId}?thumb=1`);
    assert.notEqual(open.status, 403, "a default client keeps the bytes");
  }

  assert.equal((await setCapability(ownerCookie, "client", "board.view", false)).status, 200);
  assert.equal((await call(client.cookie, "/api/board/members")).status, 403, "the roster follows the board");
  if (fileId) {
    assert.equal((await call(client.cookie, `/api/files/${fileId}`)).status, 403, "the bytes follow the listing");
  }
  assert.equal((await call(client.cookie, "/api/files/not-a-real-id")).status, 403, "refused before the lookup: no existence oracle");

  assert.equal((await setCapability(ownerCookie, "client", "board.view", null)).status, 200);
  assert.equal((await call(client.cookie, "/api/board/members")).status, 200, "restoring reopens it");
});

test("live: a colleague's address on the Team screen needs users.view", { skip: !serverUp }, async (t) => {
  if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
  const client = await onboard("client", "teams");
  const asClient = await call(client.cookie, "/api/teams");
  assert.equal(asClient.status, 200, "the rota stays legible");
  for (const team of asClient.body.teams ?? []) {
    for (const member of team.members ?? []) {
      assert.equal(member.email, null, "a client does not read colleagues' addresses");
    }
  }
  const asOwnerTeams = await call(ownerCookie, "/api/teams");
  const everyone = (asOwnerTeams.body.teams ?? []).flatMap((team) => team.members ?? []);
  if (everyone.length) assert.ok(everyone.some((member) => member.email), "an owner still does");
});

test("live: granting billing.manage to Administrators in the matrix now means something", { skip: !serverUp }, async (t) => {
  if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
  const admin = await onboard("admin", "billing");
  const before = await call(admin.cookie, "/api/finance/settings");
  if (before.status !== 200) return t.skip(`finance settings answered ${before.status} for an admin`);
  assert.equal(before.body.canSeeBankDetails, false, "the default is super_admin alone");

  assert.equal((await setCapability(ownerCookie, "admin", "billing.manage", true)).status, 200);
  const granted = await call(admin.cookie, "/api/finance/settings");
  assert.equal(granted.body.canSeeBankDetails, true, "the matrix cell is no longer a switch that changes nothing");

  assert.equal((await setCapability(ownerCookie, "admin", "billing.manage", null)).status, 200);
  const restored = await call(admin.cookie, "/api/finance/settings");
  assert.equal(restored.body.canSeeBankDetails, false);
});
