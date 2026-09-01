/**
 * Three faults found together, because they are the same fault twice and a
 * near-miss.
 *
 *  1. THE COUNTERS LIED. `maintenance_requests.issue_attachment_count` and its
 *     siblings are denormalised, and `db/init.ts` re-derived the issue counter
 *     from the undifferentiated total on every cold start. Job MN-1055 on the
 *     preview workspace reported three fault photographs, one completion and
 *     one general — five — against three rows in `attachments`, exactly one of
 *     which was a fault photograph. The public job page, which counts rows,
 *     showed the truth; the coordinator's table showed the counter.
 *
 *  2. THE LINKS POINTED AT A FROZEN BUILD. Both public links were minted from
 *     `new URL(request.url).origin`. Vercel keeps every deployment alive at its
 *     own permanent hostname for ever, so a link copied while the dashboard was
 *     on a deployment URL pinned its recipient — a contractor, weeks later,
 *     with no way to be told otherwise — to that build.
 *
 *  3. THE BIG-FILE UPLOAD PATH SKIPPED THE REVIEW QUEUE. `/api/files` files a
 *     public link's evidence as `pending`, awaiting a coordinator.
 *     `/api/files/multipart` — the path every file over ~900 KB takes, which is
 *     every phone photograph — did not, and attributed it to an internal
 *     address as well.
 *
 * Two halves, following the Stage 20/22 pattern. The first reads the source and
 * pins the decisions a passing request cannot demonstrate; the second drives
 * the real thing against a running dev server and skips when nothing answers.
 *
 * NOTE ON TEST DATA. The live half signs in as the seeded owner, uploads one
 * 78-byte PNG and deletes it again, and issues one link which it revokes. Its
 * negative probes are refusals, so they write nothing by construction. It never
 * touches MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

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
 * would otherwise be satisfied by a sentence of prose describing the thing that
 * was removed. Borrowed verbatim from `stage-twentytwo-share-link.test.mjs`.
 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. The counters are counted, never adjusted                         */
/* ------------------------------------------------------------------ */

test("no file route increments or decrements an attachment counter", async () => {
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/[id]/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/board/route.ts",
  ]) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /(issue|completed|general)AttachmentCount\}\s*[+-]/i,
      `${path} still adjusts a counter instead of counting the rows`,
    );
    assert.doesNotMatch(
      code,
      /attachmentCount\}\s*\+\s*1/,
      `${path} still increments the total instead of counting the rows`,
    );
  }
});

test("every writer that changes attachments reconciles from the rows", async () => {
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/[id]/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/board/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /reconcileAttachmentCounts\(/,
      `${path} inserts or deletes attachments without recounting`,
    );
  }
});

test("the reconciler counts by kind in one statement", async () => {
  const code = codeOnly(await source("app/lib/attachment-counts.ts"));
  const reconciler = code.slice(code.indexOf("export async function reconcileAttachmentCounts"));
  assert.ok(reconciler, "the reconciler must exist");
  assert.match(reconciler, /select count\(\*\) from \$\{attachments\}/);
  assert.match(reconciler, /const issue = bucket\(columns\.issue, "issue"\)/);
  assert.match(reconciler, /const completion = bucket\(columns\.completion, "completion"\)/);
  assert.match(
    reconciler,
    /attachmentCount: total,/,
    "the total must be a COUNT of the job's rows",
  );
  /*
   * One statement, not a read followed by a write: a second upload landing in
   * between would otherwise be counted out again. (The map-building query above
   * it is a read by design and is not part of this slice.)
   */
  assert.doesNotMatch(
    reconciler,
    /\.select\(/,
    "the reconciler must not read before it writes",
  );
  assert.equal(
    (reconciler.match(/await db\b/g) ?? []).length,
    1,
    "the reconciler must reach the database exactly once",
  );
});

test("the board overrules the stored counters before serving a request row", async () => {
  const code = codeOnly(await source("app/api/board/route.ts"));
  assert.match(code, /attachmentCountsByRequest\(db, orgId, placedIds, \{/);
  assert.match(
    code,
    /exposeRequest\(withCountedAttachments\(row, countedAttachments, row\.id\)\)/,
    "the counted values must be applied before the redaction, not after",
  );
  // The counter and the cell must be derived from the SAME two column ids, or
  // the row and the cell it sits in can disagree about the same photographs.
  assert.match(code, /issue: kindColumns\.get\("issue"\) \?\? null/);
  assert.match(code, /completion: kindColumns\.get\("completion"\) \?\? null/);
});

test("counting follows the board's rule: column first, then kind", async () => {
  const code = codeOnly(await source("app/lib/attachment-counts.ts"));
  const bucket = code.slice(code.indexOf("function bucketFor"), code.indexOf("export async function attachmentCountsByRequest"));
  assert.match(bucket, /if \(columnId\) \{/, "a filed column decides first");
  assert.match(bucket, /columns\.issue && columnId === columns\.issue/);
  assert.match(bucket, /columns\.completion && columnId === columns\.completion/);
  assert.match(
    bucket,
    /return "general";[\s\S]*if \(kind === "issue"\)/,
    "only a row with no column falls through to its kind",
  );

  // The three must always sum to the total, or a surface can show four numbers
  // that do not add up.
  const reconciler = code.slice(code.indexOf("export async function reconcileAttachmentCounts"));
  assert.match(
    reconciler,
    /generalAttachmentCount: sql`\$\{total\} - \$\{issue\} - \$\{completion\}`/,
    "general must be the remainder, not a fourth independent predicate",
  );
});

test("the boot-time back-fill that caused this is named in the code", async () => {
  const prose = (await source("app/lib/attachment-counts.ts"))
    .replace(/\s*\*\s*/g, " ")
    .replace(/\s+/g, " ");
  assert.match(
    prose,
    /issue_attachment_count = attachment_count/,
    "the statement that corrupts the counters must be recorded here",
  );
});

/* ------------------------------------------------------------------ */
/* 2. The canonical public origin                                      */
/* ------------------------------------------------------------------ */

test("both public links are minted through one helper", async () => {
  for (const path of ["app/api/board/links/route.ts", "app/lib/form-config.ts"]) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /new URL\(request\.url\)\.origin/,
      `${path} still mints a link from the host the operator happened to be on`,
    );
    assert.match(code, /publicUrl\(request,/, `${path} must use the helper`);
  }
});

test("the origin is configuration, and the fallback is the request", async () => {
  const code = codeOnly(await source("app/lib/public-origin.ts"));
  assert.match(code, /PUBLIC_APP_ORIGIN/, "one named environment variable");
  assert.match(
    code,
    /if \(configured\) return configured;\s*return new URL\(request\.url\)\.origin;/,
    "an unset variable must leave the previous behaviour exactly as it was",
  );
});

test("no preview or production hostname is compiled into the source", async () => {
  const code = codeOnly(await source("app/lib/public-origin.ts"));
  assert.doesNotMatch(
    code,
    /https?:\/\/[a-z0-9.-]+/i,
    "a hardcoded origin would follow the code into the wrong environment",
  );
});

test("a malformed origin falls back rather than minting a broken link", async (t) => {
  /*
   * The one behavioural check in the source half.
   *
   * Loading a `.ts` module directly relies on the runtime stripping its types,
   * which Node does from 22.6 and by default from 22.18. Older runtimes skip
   * rather than fail: the rules below are also pinned by the assertions above,
   * and a suite that cannot run on the CI's Node is worse than one that says so.
   */
  let normalisePublicOrigin;
  try {
    ({ normalisePublicOrigin } = await import("../app/lib/public-origin.ts"));
  } catch {
    t.skip(`this runtime (${process.version}) cannot import TypeScript directly`);
    return;
  }
  for (const good of [
    ["https://maintsupp-preview.vercel.app", "https://maintsupp-preview.vercel.app"],
    ["https://maintsupp-preview.vercel.app/", "https://maintsupp-preview.vercel.app"],
    ["  https://maintsupp.com  ", "https://maintsupp.com"],
    ["http://localhost:3000", "http://localhost:3000"],
  ]) {
    assert.equal(normalisePublicOrigin(good[0]), good[1], good[0]);
  }
  for (const bad of [
    undefined,
    null,
    "",
    "   ",
    "maintsupp.com",
    "//maintsupp.com",
    "ftp://maintsupp.com",
    "javascript:alert(1)",
    "https://maintsupp.com/portal",
    "https://maintsupp.com?a=1",
    "https://maintsupp.com#x",
    "https://user:pass@maintsupp.com",
  ]) {
    assert.equal(normalisePublicOrigin(bad), null, `${bad} must be ignored`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. A token writes to its own job, in its own tenant, or nothing     */
/* ------------------------------------------------------------------ */

test("both upload routes bind a token to one job and one tenant", async () => {
  /*
   * THE GUARD MOVED, AND THE CLAIM GOT STRONGER.
   *
   * This used to require the same three expressions inside BOTH routes, which
   * is the shape of assertion you write when a rule is copied. W7 lifted the
   * decision into one module — `app/api/files/upload-authority.ts` — so the
   * honest pin is now: the binding exists ONCE, and neither route decides for
   * itself. Two copies agreeing today is exactly how they came to disagree
   * before; a single definition cannot.
   */
  const authority = codeOnly(await source("app/api/files/upload-authority.ts"));
  assert.match(
    authority,
    /jobToken\.requestId !== workOrder\.id/,
    "a link for one job must not upload to another",
  );
  assert.match(
    authority,
    /jobToken\.organisationId !== workOrder\.organisationId/,
    "a link from one tenant must not upload into another",
  );
  assert.match(
    authority,
    /export async function resolveUploadTenant/,
    "the tenant must come from the token, and it must be resolved before the job is looked up",
  );

  for (const path of ["app/api/files/route.ts", "app/api/files/multipart/route.ts"]) {
    const code = codeOnly(await source(path));
    assert.match(
      code,
      /resolveUploadAuthority/,
      `${path}: must delegate the decision rather than making its own`,
    );
    assert.doesNotMatch(
      code,
      /jobToken\.requestId !== workOrder\.id/,
      `${path}: must not re-implement the binding it delegates`,
    );
  }
});

test("a file column decides the kind, and the grant is checked against it", async () => {
  const direct = codeOnly(await source("app/api/files/route.ts"));
  assert.match(
    direct,
    /kind = kindForColumnKey\(column\.key\);/,
    "an issue photograph filed in the issue column must stay an issue photograph",
  );
  assert.doesNotMatch(
    direct,
    /kind = "general";/,
    "coercing every column-filed upload to general made the issue slot unusable",
  );

  const multipart = codeOnly(await source("app/api/files/multipart/route.ts"));
  assert.match(multipart, /storedKind = kindForColumnKey\(column\.key\);/);
  /*
   * The grant check itself now lives beside the binding, in
   * upload-authority.ts, and reads the kind that will ACTUALLY be written
   * rather than the one the client asked for.
   */
  const authority = codeOnly(await source("app/api/files/upload-authority.ts"));
  assert.match(
    authority,
    /allowedKinds\.includes\(storedKind as EvidenceKind\)/,
    "the grant must be checked against what will actually be written",
  );
  assert.doesNotMatch(
    multipart,
    /Custom file columns require the general file section/,
    "the large-file path refused the issue column outright",
  );
  /*
   * The ORDER still matters, but it is now a fact about two files rather than
   * one. The grant check moved into the authority module, so what this route
   * has to get right is that it resolves the column's kind BEFORE it hands the
   * decision over — a `storedKind` computed after the call would be checked
   * against nothing. Asserting the call site rather than the comparison keeps
   * the original claim ("resolved before checked") true at its new seam.
   */
  assert.ok(
    multipart.indexOf("storedKind = kindForColumnKey") <
      multipart.indexOf("resolveUploadAuthority({"),
    "the column must be resolved before the grant is checked, not after",
  );
  assert.match(
    multipart,
    /storedKind,/,
    "and the resolved kind must actually be the one handed to the authority",
  );

  // One mapping, in one place, shared with the counting rule.
  const counts = codeOnly(await source("app/lib/attachment-counts.ts"));
  assert.match(counts, /issuePictures: "issue"/);
  assert.match(counts, /completedPictures: "completion"/);
  assert.match(counts, /files: "general"/);
});

test("the large-file path files public evidence for review, like the small one", async () => {
  const code = codeOnly(await source("app/api/files/multipart/route.ts"));
  /*
   * `Boolean(scopedToken)` became `pendingReview(via)`: a signed-in operator
   * holding a stale token is not filing public evidence, so the queue keys on
   * the GRANT that answered rather than on a token merely being present. Both
   * routes call the same helper, which is the point of pinning the call.
   */
  assert.match(code, /pending: pendingReview\(/);
  assert.match(code, /submittedVia: scopedToken \? scopedToken\.id : null/);
  const direct = codeOnly(await source("app/api/files/route.ts"));
  assert.match(
    direct,
    /pending: pendingReview\(/,
    "the small path must queue public evidence the same way",
  );
  assert.match(
    code,
    /uploadedByEmail = scopedToken\s*\?\s*`contractor-link:\$\{scopedToken\.id\}`/,
    "the link that produced the photograph must be recorded, not the preview identity",
  );
});

test("the job link route can only ever write to the job its token names", async () => {
  const route = await source("app/api/job-link/[token]/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const code = codeOnly(post);

  // Every write is keyed on the resolved scope, and the scope alone.
  const wheres = code.match(/eq\(maintenanceRequests\.id, [^)]+\)/g) ?? [];
  assert.ok(wheres.length >= 3, "the POST handler writes to the job in three places");
  for (const where of wheres) {
    assert.equal(
      where,
      "eq(maintenanceRequests.id, scope.requestId)",
      "a write keyed on anything but the token's own job id",
    );
  }
  const orgs = code.match(/eq\(maintenanceRequests\.organisationId, [^)]+\)/g) ?? [];
  assert.equal(orgs.length, wheres.length, "every write must also be tenant-scoped");
  for (const org of orgs) {
    assert.equal(org, "eq(maintenanceRequests.organisationId, scope.organisationId)");
  }

  // And the body cannot name a job at all, which is why the above is airtight.
  assert.doesNotMatch(
    code,
    /body\.(requestId|jobId|organisationId|orgId)/,
    "the request body must never be able to choose the job or the tenant",
  );
});

test("the job link route writes canonical completion columns, and never the status", async () => {
  const code = codeOnly(await source("app/api/job-link/[token]/route.ts"));
  for (const column of [
    "completionRequestedAt",
    "completionRequestedBy",
    "completionSignedAt",
    "completionSignedBy",
    "completionNote",
    "blockedReason",
  ]) {
    assert.match(code, new RegExp(`\\b${column}:`), `${column} must be written by name`);
  }
  assert.doesNotMatch(
    code,
    /set\(\{[^}]*\bstatus:/s,
    "a public link must never set the job status",
  );
  assert.doesNotMatch(
    code,
    /set\(\{[^}]*\bstage:/s,
    "a public link must never move the job between stages",
  );
  assert.doesNotMatch(
    code,
    /set\(\{[^}]*\bcompletedAt:/s,
    "closing the job stays the coordinator's to do",
  );
});

/* ------------------------------------------------------------------ */
/* The live half                                                       */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/board?compact=1`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function sessionTokenFrom(response) {
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
    value.startsWith("maintsupp_session="),
  );
  return cookie ? cookie.slice("maintsupp_session=".length).split(";")[0] : null;
}

async function signInAsOwner() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  return sessionTokenFrom(response);
}

/**
 * A request as the owner, re-authenticating once if the session was cut out
 * from under it.
 *
 * `stage-twenty-auth` tests "sign out everywhere" as the OWNER, which is the
 * account every live half here signs in as, so when the suites run together it
 * revokes the session this one holds. Only a 401 is retried, and only once —
 * see the same helper in `stage-twentytwo-share-link.test.mjs`.
 */
async function asOwner(session, path, init = {}) {
  const send = (token) =>
    fetch(`${BASE_URL}${path}`, {
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

/** A 78-byte PNG. Small enough to be obviously a probe. */
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);

/** Two different jobs, neither of them the one that must not be touched. */
async function twoJobs(session) {
  const board = await asOwner(session, "/api/board");
  const ids = (board.body.requests ?? [])
    .map((row) => row.id)
    .filter((id) => id && !RESERVED.has(id));
  return ids.length >= 2 ? [ids[0], ids[1]] : null;
}

/**
 * Whether this server hands an anonymous caller an identity.
 *
 * `demoIdentityAllowed()` is true for every `NODE_ENV !== "production"` build,
 * and `/api/files` reads it as `isOperator` — so on a dev server the token
 * guards below are not merely passed, they are never reached, and a probe that
 * "should be refused" is answered 201 by an anonymous request that the server
 * has decided is a super admin of every tenant. That is the documented
 * affordance working as designed; it is not this route being open.
 *
 * The negative probe therefore runs only where identity comes from the session,
 * which is the deployment it needs to be true on anyway. Point
 * `MAINTSUPP_BASE_URL` at the preview to exercise it.
 */
async function anonymousIsRefused() {
  try {
    const response = await fetch(`${BASE_URL}/api/maintenance?limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    return response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

test("a link for one job is refused when it names another", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await anonymousIsRefused())) {
    t.skip(
      `${BASE_URL} grants anonymous callers the preview identity, so the token guard is unreachable`,
    );
    return;
  }
  const session = await signInAsOwner();
  assert.ok(session, "the seeded owner must be able to sign in");

  const jobs = await twoJobs(session);
  assert.ok(jobs, "this check needs two jobs on the board");
  const [mine, theirs] = jobs;

  const issued = await asOwner(session, "/api/board/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: mine, label: "write-path negative probe" }),
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const token = issued.body.url.split("/j/")[1];

  try {
    /*
     * A real multipart body, because `/api/files` reads `FormData` and a JSON
     * one throws before authorisation is ever reached — answering 503, which
     * looks like an outage and reads like a pass if you only check "not 201".
     */
    const form = new FormData();
    form.append("file", new Blob([PROBE_PNG], { type: "image/png" }), "negative-probe.png");
    form.append("requestId", theirs);
    form.append("kind", "completion");
    form.append("uploadToken", token);

    const refused = await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form });
    const body = await refused.json().catch(() => ({}));
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.match(String(body.error), /does not belong to that job/);

    // And nothing was written: the other job's file list is unchanged.
    const files = await asOwner(session, `/api/files?requestId=${theirs}&limit=100`);
    assert.ok(
      !(files.body.files ?? []).some((file) => file.name === "negative-probe.png"),
      "a refused upload must leave no row behind",
    );

    /*
     * The job-link route is probed by READING, not by writing.
     *
     * Its POST cannot be redirected — the handler never reads a job id from the
     * body, which the source half asserts by enumerating every `WHERE` in it —
     * and the only way to demonstrate that live would be to make it write a
     * note. `completion_note` is a single column, not a log: a note probe
     * overwrites whatever a coordinator had put there, and `/api/maintenance`
     * PATCH cannot put it back, because `request-fields.ts` deliberately does
     * not expose that column to the field editor. Proving a routing invariant
     * by destroying a coordinator's note is not a trade worth making, so what
     * runs here is the read: the token answers for its own job and no other.
     */
    const shared = await (await fetch(`${BASE_URL}/api/job-link/${token}`)).json();
    assert.equal(shared.requestId, mine, "a token must answer only for its own job");
    assert.notEqual(shared.requestId, theirs);
  } finally {
    await asOwner(session, `/api/board/links?id=${issued.body.id}`, { method: "DELETE" });
  }
});

test("the counters a job reports match the files it holds", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  assert.ok(session);

  const jobs = await twoJobs(session);
  assert.ok(jobs);
  const [requestId] = jobs;

  const form = new FormData();
  form.append("file", new Blob([PROBE_PNG], { type: "image/png" }), "counter-probe.png");
  form.append("requestId", requestId);
  form.append("kind", "issue");

  const uploaded = await fetch(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { Cookie: `maintsupp_session=${session}` },
    body: form,
  });
  const uploadBody = await uploaded.json().catch(() => ({}));
  assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));

  try {
    // The route's own answer, recounted from the rows it just wrote.
    const listed = await asOwner(session, `/api/files?requestId=${requestId}&limit=100`);
    const rows = listed.body.files ?? [];
    const byKind = (kind) => rows.filter((file) => file.kind === kind).length;

    for (const [label, reported, actual] of [
      ["total", uploadBody.request?.attachmentCount, rows.length],
      ["issue", uploadBody.request?.issueAttachmentCount, byKind("issue")],
      ["completion", uploadBody.request?.completedAttachmentCount, byKind("completion")],
      ["general", uploadBody.request?.generalAttachmentCount, byKind("general")],
    ]) {
      assert.equal(reported, actual, `${label}: the counter must equal the rows`);
    }

    // And the board says the same thing, which is the surface the owner read.
    const board = await asOwner(session, "/api/board");
    const row = (board.body.requests ?? []).find((entry) => entry.id === requestId);
    assert.ok(row, "the job must be on the board");
    assert.equal(row.issueAttachmentCount, byKind("issue"));
    assert.equal(row.completedAttachmentCount, byKind("completion"));
    assert.equal(row.generalAttachmentCount, byKind("general"));
    assert.equal(row.attachmentCount, rows.length);
  } finally {
    if (uploadBody.file?.id) {
      await asOwner(session, `/api/files/${uploadBody.file.id}`, { method: "DELETE" });
    }
  }
});
