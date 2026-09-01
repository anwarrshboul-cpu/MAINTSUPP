/**
 * W07-01 authorised upload, and W07-07 what a document belongs to.
 *
 * THE FAULT. Both upload routes decided authorisation like this:
 *
 *     const isOperator = authenticated || demoIdentityAllowed();
 *
 * and then gated every check below on `!isOperator`. That reads as a guard and
 * is the opposite of one — `authenticated` answers "did you prove who you are",
 * never "may you" — so any signed-in principal of ANY role reached the R2 put.
 * A `client`, whose capabilities are `board.view` and `data.export` and nothing
 * else, was answered 201 by `POST /api/files` and 403 by
 * `DELETE /api/files/[id]` on the very same resource: the destructive verb was
 * guarded and the creating verb was not.
 *
 * WHY THE OBVIOUS FIX IS WRONG. "If you are signed in you must hold
 * `board.edit`" inverts the product. A signed-in `client` who opens a public
 * form link in the same browser would be REFUSED while an anonymous stranger
 * holding the identical link is ALLOWED — signing in would take a permission
 * away. So the token is consulted BEFORE the session, and the capability check
 * is reached only by a caller who presented no grant at all. That ordering is
 * the fix, and the live half below proves both directions of it.
 *
 * W07-07 was a CONFLICT rather than a gap: the route required a `requestId`, so
 * a contractor's insurance certificate — a fact about the contractor, not
 * evidence about a work order — had no id to give and was refused outright. A
 * job is now one of four anchors and at least one is required, so nothing floats
 * free and nothing has to be invented to satisfy a column.
 *
 * Two halves, following the Stage 20/22 pattern. The first reads the source and
 * pins decisions a passing request cannot demonstrate; the second drives the
 * real thing against a running dev server and skips when nothing answers.
 *
 * NOTE ON TEST DATA. The live half signs in as the seeded owner, uploads a
 * handful of tiny text files prefixed `W7OFF-` and deletes every one of them,
 * and issues one contractor link. Its negative probes are refusals, so they
 * write nothing by construction. It never touches MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";

/** The job the owner has asked never to be used as a fixture. */
const RESERVED = new Set(["MN-1049"]);

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * The same file with its comments removed.
 *
 * These files explain themselves at length, so a "must NOT contain" assertion
 * would otherwise be satisfied by a sentence of prose describing the very thing
 * that was removed.
 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const UPLOAD_ROUTES = [
  "app/api/files/route.ts",
  "app/api/files/multipart/route.ts",
];

/* ------------------------------------------------------------------ */
/* 1. Source: the branch that never checked permission is gone         */
/* ------------------------------------------------------------------ */

test("W07-01 no upload route decides authorisation from `authenticated`", async () => {
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /isOperator/,
      `${path} still carries \`isOperator\`, which answers "who are you" and never "may you"`,
    );
    assert.doesNotMatch(
      code,
      /authenticated\s*\|\|\s*demoIdentityAllowed\(\)/,
      `${path} still treats any session, or any local caller, as authorised`,
    );
  }
});

test("W07-01 both upload routes authorise through the one shared module", async () => {
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.match(
      code,
      /resolveUploadAuthority\(/,
      `${path} does not call the shared authority`,
    );
    assert.match(
      code,
      /resolveUploadTenant\(/,
      `${path} does not resolve the tenant from the token before looking the job up`,
    );
  }
});

test("W07-01 the authority requires a real capability, not a session", async () => {
  const code = codeOnly(await source("app/api/files/upload-authority.ts"));
  assert.match(code, /requireCapability\(subject,\s*"board\.edit"\)/);
  assert.match(code, /resolvePermissions\(scope\.db, orgId, scope\.actor\.role\)/);
  /*
   * The authentication floor still has to be there: `resolvePermissions` would
   * otherwise resolve a role for a caller who proved nothing, and in production
   * that is a stranger.
   */
  assert.match(code, /!scope\.authenticated && !demoIdentityAllowed\(\)/);
});

test("W07-01 the token is consulted BEFORE the capability, or the product inverts", async () => {
  const whole = codeOnly(await source("app/api/files/upload-authority.ts"));
  /*
   * Sliced to the function body: `requireCapability` also appears in the import
   * list at the top of the file, which sits before every branch and would make
   * this assertion pass for the wrong reason — or, as it did first time, fail
   * for one.
   */
  const code = whole.slice(whole.indexOf("export async function resolveUploadAuthority"));
  const jobToken = code.indexOf("if (jobToken)");
  const requestToken = code.indexOf("if (uploadToken && workOrder)");
  const capability = code.indexOf("requireCapability(subject");
  assert.ok(jobToken > 0, "the job-token branch must exist");
  assert.ok(requestToken > 0, "the request-token branch must exist");
  assert.ok(capability > 0, "the capability branch must exist");
  assert.ok(
    jobToken < requestToken && requestToken < capability,
    "a presented token must answer before a session's capability, or a signed-in client is refused where an anonymous one passes",
  );
});

test("W07-01 the review queue is keyed on the grant, not on the absence of a session", async () => {
  const shared = codeOnly(await source("app/api/files/upload-authority.ts"));
  assert.match(shared, /export function pendingReview/);
  assert.match(shared, /via === "job-token"/);
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.match(
      code,
      /pending: pendingReview\(/,
      `${path} must key \`pending\` on the grant — a signed-in client using a contractor link must still queue for review`,
    );
  }
});

test("W07-01 `scopedDbWithCapability` is deliberately NOT used on the upload path", async () => {
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /scopedDbWithCapability/,
      `${path} must not use it: it calls scopedDb WITHOUT allowAnonymous and therefore throws for the contractor and public-form callers this route has to keep serving`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. Source: W07-07 anchors                                           */
/* ------------------------------------------------------------------ */

test("W07-07 a job is no longer mandatory, but an anchor is", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export function anchorRefusal/);
  assert.match(
    shared,
    /anchors\.requestId \|\|\s*anchors\.siteId \|\|\s*anchors\.unitId \|\|\s*anchors\.contractorId/,
    "all four anchors must satisfy the rule",
  );
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.match(code, /anchorRefusal\(/, `${path} does not enforce the anchor rule`);
    assert.doesNotMatch(
      code,
      /A file and work order ID are required/,
      `${path} still insists on a work order, which is what left a contractor's certificate with no home`,
    );
  }
});

test("W07-07 every anchor is validated in code, because the database will not", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export async function anchorReferencesRefusal/);
  // Each of the three id anchors is looked up, scoped by organisation.
  for (const table of ["sites", "units", "contractors"]) {
    assert.match(
      shared,
      new RegExp(`from\\(${table}\\)`),
      `${table} is never checked, so a typo or another tenant's id would simply be stored`,
    );
    assert.match(
      shared,
      new RegExp(`eq\\(${table}\\.organisationId, orgId\\)`),
      `${table} is not organisation-scoped, so a cross-tenant id would resolve`,
    );
  }
  for (const path of UPLOAD_ROUTES) {
    assert.match(
      codeOnly(await source(path)),
      /anchorReferencesRefusal\(/,
      `${path} stores anchors without checking they name anything`,
    );
  }
});

test("W07-07 an explicit site wins over the job's inherited one", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export function resolveSiteId/);
  assert.match(shared, /return explicitSiteId \|\| workOrderSiteId \|\| null/);
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.match(
      code,
      /resolveSiteId\(/,
      `${path} does not honour an explicit site`,
    );
    assert.doesNotMatch(
      code,
      /siteId: workOrder\.siteId,/,
      `${path} still writes the job's site unconditionally, which is why every pre-migration row carried a site identical to its job's`,
    );
  }
});

test("W07-07 unit and contractor are written, not merely declared", async () => {
  for (const path of UPLOAD_ROUTES) {
    const code = codeOnly(await source(path));
    assert.match(code, /unitId:/, `${path} never writes unit_id`);
    assert.match(code, /contractorId:/, `${path} never writes contractor_id`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. Source: the two routes must not drift again                      */
/* ------------------------------------------------------------------ */

test("the document payload is defined once, not once per route", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export function attachmentPayload/);
  for (const path of [...UPLOAD_ROUTES, "app/api/files/[id]/route.ts"]) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /function attachmentPayload\(/,
      `${path} declares its own copy — the two upload routes already drifted over uploadedByEmail, so which fields a caller received depended on how big their file was`,
    );
    assert.match(
      code,
      /attachmentPayload/,
      `${path} must serve documents through the shared payload`,
    );
  }
});

test("the token hash is computed in one place", async () => {
  assert.match(
    codeOnly(await source("app/api/files/upload-authority.ts")),
    /async function sha256/,
  );
  assert.doesNotMatch(
    codeOnly(await source("app/api/files/route.ts")),
    /async function sha256/,
    "a second copy is a second chance to hash the same token differently",
  );
});

/* ------------------------------------------------------------------ */
/* 4. Live: the two directions of the fix                              */
/* ------------------------------------------------------------------ */

/**
 * A request, retried while the database says "busy".
 *
 * The dev server runs one Miniflare D1, and a 5xx from it is a LOCK, not an
 * answer: measured, `create_item` returned 503 five times and then 201 with no
 * change to the request. Every assertion below is about a route's DECISION —
 * 403 or 201, 404 or 400 — and a decision cannot be read off a reply that says
 * the workspace was too busy to make one. Without this the suite fails
 * intermittently and blames the code under test for contention with whatever
 * else is running.
 *
 * Bounded, and only on 5xx: a 4xx is an answer and is returned immediately, so
 * this can never turn a refusal into a pass by retrying until something else
 * happens.
 */
const BUSY_ATTEMPTS = 5;
async function sendRetrying(url, init) {
  let response;
  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
    response = await fetch(url, init);
    if (response.status < 500) return response;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return response;
}

/**
 * Whether a dev server is answering, decided ONCE.
 *
 * Cached because every live test below asks, and the probe is not free: the
 * board endpoint assembles a whole board and took over four seconds on a cold
 * Miniflare, so a 4s timeout reported "no dev server" against a server that was
 * plainly running and skipped every live assertion in the file. A generous
 * timeout and one memoised answer, rather than a cheaper endpoint, because this
 * is the same reachability check the rest of the suite uses.
 */
let serverUp = null;
async function serverIsUp() {
  if (serverUp !== null) return serverUp;
  try {
    await fetch(`${BASE_URL}/api/board?compact=1`, {
      signal: AbortSignal.timeout(30000),
    });
    /*
     * ANY reply means the server is up, INCLUDING a 5xx.
     *
     * This used to require `status < 500`, and that is a different question: a
     * 503 from this endpoint is the local D1 saying it is busy, not the server
     * saying it is absent. Under load — several agents on one Miniflare — the
     * probe therefore reported "no dev server" and every live assertion in the
     * file skipped, silently, while the server was plainly answering. Only a
     * network error or the timeout below means nothing is there.
     *
     * Plain `fetch` rather than `sendRetrying`: retrying a 30-second probe five
     * times would spend two and a half minutes deciding something one reply
     * already settled.
     */
    serverUp = true;
  } catch {
    serverUp = false;
  }
  return serverUp;
}

function sessionTokenFrom(response) {
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
    value.startsWith("maintsupp_session="),
  );
  return cookie ? cookie.slice("maintsupp_session=".length).split(";")[0] : null;
}

async function signInAsOwner() {
  const response = await sendRetrying(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  return sessionTokenFrom(response);
}

async function asOwner(session, path, init = {}) {
  const send = (token) =>
    sendRetrying(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: `maintsupp_session=${token}` },
    });
  let response = await send(session);
  if (response.status === 401) {
    const fresh = await signInAsOwner();
    if (fresh) response = await send(fresh);
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function upload(name, body, fields) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/plain" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

/** Every id this file creates, removed in the teardown whatever happened. */
const created = new Set();

test("live: a view-only client is refused, an editor is not", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }

  /*
   * Any job will do — this test is about the capability check, not about which
   * board the job sits on. It used to read the Store Documentation board
   * specifically and skipped outright when that board happened to be empty,
   * which is how the assertion that actually proves W07-01 silently stopped
   * running.
   */
  const board = await asOwner(session, "/api/board");
  const row = (board.body.requests ?? []).find(
    (item) => !RESERVED.has(item.id) && !item.deletedAt,
  );
  if (!row) {
    t.skip("the workspace has no job to file a document against");
    return;
  }

  /*
   * The demo role cookie is how a local run reaches a `client`'s permissions.
   * It carries no authority — `workspaceRoleFromRequest` ignores it outright in
   * production, and `resolveTenantAccess` refuses to let it widen a real
   * session — but it does resolve to the `client` role, and the role is what the
   * capability check reads. So this probe exercises the SAME code path a real
   * signed-in client takes in production.
   */
  const refused = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { Cookie: "maintsupp_demo_role=client" },
    body: upload("W7OFF-refused.txt", "x", { requestId: row.id, kind: "general" }),
  });
  assert.equal(
    refused.status,
    403,
    "a client with no capability and no token must be refused the upload",
  );
  const refusal = await refused.json().catch(() => ({}));
  assert.match(
    JSON.stringify(refusal),
    /board\.edit/,
    "the refusal must name the capability, not merely deny",
  );

  const allowed = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-allowed.txt", "hello", {
      requestId: row.id,
      kind: "general",
    }),
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body).slice(0, 200));
  if (allowed.body.file?.id) created.add(allowed.body.file.id);
});

test("live: both multipart handlers refuse the same client", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  /*
   * A REAL job id, because the job is looked up before the grant is resolved —
   * the kind the grant is checked against is not known until the column is, and
   * the column is scoped to the job's board. So an invented id answers 404 and
   * proves nothing about the capability check. (That ordering also means an
   * unauthorised caller can tell a real job id from an invented one; it predates
   * this change, and a `client` holds `board.view` and can list every job
   * anyway, so it discloses nothing to the role this test is about.)
   */
  const board = await asOwner(session, "/api/board");
  const job = (board.body.requests ?? []).find(
    (item) => !RESERVED.has(item.id) && !item.deletedAt,
  );
  if (!job) {
    t.skip("no maintenance job to probe against");
    return;
  }

  const start = await sendRetrying(`${BASE_URL}/api/files/multipart`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: "maintsupp_demo_role=client",
    },
    body: JSON.stringify({
      action: "start",
      requestId: job.id,
      kind: "general",
      originalName: "W7OFF-mp.txt",
      contentType: "text/plain",
      byteSize: 10,
    }),
  });
  assert.equal(start.status, 403, "multipart start must check the capability too");

  const part = await sendRetrying(`${BASE_URL}/api/files/multipart`, {
    method: "PUT",
    headers: {
      Cookie: "maintsupp_demo_role=client",
      "X-Upload-Request-Id": job.id,
      "X-Upload-Kind": "general",
      "X-Upload-Key": "irrelevant",
      "X-Upload-Id": "irrelevant",
      "X-Upload-Part": "1",
    },
    body: "z",
  });
  assert.equal(
    part.status,
    403,
    "the part handler is the path every file over ~900 KB takes and must be guarded as well",
  );
});

test("live: a token beats a session — the inversion the fix must not cause", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }

  const board = await asOwner(session, "/api/board");
  const job = (board.body.requests ?? []).find(
    (item) => !RESERVED.has(item.id) && !item.deletedAt,
  );
  if (!job) {
    t.skip("no maintenance job to issue a link against");
    return;
  }

  const minted = await asOwner(session, "/api/board/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: job.id,
      audience: "contractor",
      allowedKinds: ["issue", "completion"],
    }),
  });
  if (minted.status !== 201) {
    t.skip(`could not mint a contractor link (${minted.status})`);
    return;
  }
  /* The plaintext token appears only inside the URL, by design. */
  const token = String(minted.body.url ?? "").split("/j/")[1] ?? "";
  assert.ok(token.length >= 32, "the minted token must be a real credential");

  const anonymous = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    body: upload("W7OFF-link-anon.txt", "evidence", {
      requestId: job.id,
      kind: "issue",
      uploadToken: token,
    }),
  });
  assert.equal(
    anonymous.status,
    201,
    "an anonymous contractor holding a valid link must still be able to upload",
  );
  const anonBody = await anonymous.json().catch(() => ({}));
  if (anonBody.file?.id) created.add(anonBody.file.id);

  /*
   * THE INVERSION. The same link, in a browser that also holds a `client`
   * identity. Under a naive "signed in means you need board.edit" this is a 403
   * while the anonymous request above is a 201 — signing in would take a
   * permission away.
   */
  const signedInClient = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { Cookie: "maintsupp_demo_role=client" },
    body: upload("W7OFF-link-client.txt", "evidence", {
      requestId: job.id,
      kind: "issue",
      uploadToken: token,
    }),
  });
  assert.equal(
    signedInClient.status,
    201,
    "a signed-in client exercising a link's grant must be allowed exactly as an anonymous holder is",
  );
  const clientBody = await signedInClient.json().catch(() => ({}));
  if (clientBody.file?.id) created.add(clientBody.file.id);

  /* And the same client WITHOUT the link is still refused. */
  const withoutLink = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { Cookie: "maintsupp_demo_role=client" },
    body: upload("W7OFF-nolink.txt", "x", { requestId: job.id, kind: "issue" }),
  });
  assert.equal(withoutLink.status, 403, "the hole must stay closed");

  /* The link's own limits still hold. */
  const wrongKind = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    body: upload("W7OFF-badkind.txt", "x", {
      requestId: job.id,
      kind: "general",
      uploadToken: token,
    }),
  });
  assert.equal(
    wrongKind.status,
    403,
    "a link must not write a kind of evidence it was not granted",
  );

  const cannotReplace = await sendRetrying(`${BASE_URL}/api/files`, {
    method: "POST",
    body: upload("W7OFF-linkreplace.txt", "x", {
      requestId: job.id,
      kind: "issue",
      uploadToken: token,
      replaces: anonBody.file?.id ?? "none",
    }),
  });
  assert.equal(
    cannotReplace.status,
    403,
    "a link grants adding evidence, never superseding a document somebody else filed",
  );

  await asOwner(session, `/api/board/links?id=${minted.body.id}`, {
    method: "DELETE",
  });
});

test("live: a document may belong to a contractor and to no job at all", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const workspace = await asOwner(session, "/api/workspace");
  const contractor = (workspace.body.workspace?.contractors ?? [])[0];
  if (!contractor) {
    t.skip("no contractor in the workspace to file a certificate against");
    return;
  }

  const nothing = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-floating.txt", "x", { kind: "general" }),
  });
  assert.equal(
    nothing.status,
    400,
    "a document naming no anchor at all must be refused — nothing may float free",
  );

  const certificate = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-pli.txt", "insurance", {
      kind: "general",
      contractorId: contractor.id,
      title: "W7OFF PLI certificate",
      documentType: "Public Liability",
      expiryDate: "2027-06-30",
    }),
  });
  assert.equal(
    certificate.status,
    201,
    `a contractor's certificate must be storable with no work order: ${JSON.stringify(certificate.body).slice(0, 200)}`,
  );
  const file = certificate.body.file;
  created.add(file.id);
  assert.equal(file.contractorId, contractor.id);
  assert.equal(file.requestId, null, "it belongs to the contractor, not to a job");
  assert.equal(file.expiryDate, "2027-06-30");
  assert.equal(file.versionNo, 1);
  assert.equal(file.isCurrent, true);

  const unknown = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-ghost.txt", "x", {
      kind: "general",
      contractorId: "contractor-does-not-exist",
    }),
  });
  assert.equal(
    unknown.status,
    404,
    "an anchor naming nothing must be refused in code — the deployed DDL has no foreign key to catch it",
  );
});

test("teardown: every document this file created is removed", async (t) => {
  if (!created.size) return;
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in to clean up");
    return;
  }
  for (const id of created) {
    await asOwner(session, `/api/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  /*
   * Scoped to the ids THIS file created, not to every W7OFF-named document in
   * the workspace. A shared prefix is how residue is found by hand; asserting on
   * it here would make this teardown fail because a sibling suite, or an
   * abandoned manual probe, left something behind — a true statement about the
   * database and a false one about this file, reported against the wrong code.
   */
  const remaining = await asOwner(session, "/api/files?q=W7OFF&limit=100&archived=all");
  const mine = (remaining.body.files ?? []).filter((file) => created.has(file.id));
  assert.deepEqual(
    mine.map((file) => file.originalName),
    [],
    "this file left QA residue behind",
  );
});
