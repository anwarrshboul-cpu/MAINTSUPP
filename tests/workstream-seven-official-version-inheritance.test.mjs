/**
 * W07-03 / W07-07 — A NEW VERSION INHERITS WHAT ITS DOCUMENT IS FILED AGAINST.
 *
 * THE DEFECT, as the owner met it. A document detail visibly showing
 * "Site: Highcross Leicester" and "Work order: MN-1058" answered "Upload new
 * version" with:
 *
 *     A document must be filed against a work order, a site, a unit or a
 *     contractor.
 *
 * It was an ORDERING bug, not a missing feature, and both upload routes had it.
 * `POST /api/files` called `anchorRefusal(anchors)` on the SUPPLIED anchors 216
 * lines before `planVersion` had looked at the predecessor at all, while the
 * insert below it already inherited correctly —
 * `requestId || version.plan.carried.requestId`, `resolveSiteId(...)` and the
 * rest. So a replacement that did not needlessly re-send relationships nobody
 * asked it to change was refused on half the facts. The multipart route was
 * worse: `authorizeUpload` runs for `start`, every part, `complete` and `abort`,
 * and the lineage was read inside `complete` alone, so a replacement over
 * ~900 KB — every photograph a phone takes — was refused at `start`, before one
 * byte moved.
 *
 * THE RULE THIS FILE PINS. An ORIGINAL still needs an anchor: that is W07-07 and
 * it is not weakened here. A REPLACEMENT is judged on SUPPLIED-OR-INHERITED
 * anchors, decided after the lineage is resolved and still before any bytes are
 * stored. Nothing is invented: a replacement whose predecessor is itself
 * unanchored is refused with the identical message.
 *
 * AND THE KEY, which is the half that goes quietly wrong. The object key is
 * named after what the document is filed against. A replacement that inherits
 * its filing must inherit its key prefix too, or a >900 KB new version of an
 * MN-1058 document sits in the bucket under `.../maintenance/unfiled/...` while
 * the row it created names MN-1058 — measured, before `anchorsForKey` existed.
 * `start` therefore has to see `replaces`, which means the client has to send it
 * on `start`, on every part and on `abort`, not on `complete` alone.
 *
 * Two halves, as elsewhere in this suite: source assertions for the decisions,
 * then the real thing against a running dev server, skipped when nothing
 * answers. The live half signs in as the seeded owner, marks every fixture in
 * the document TITLE — `W7VI-<run>` — and deletes every id it created. It never
 * touches MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);
const MISSING_ANCHOR =
  "A document must be filed against a work order, a site, a unit or a contractor.";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. Source: one rule, in one place, for both routes                  */
/* ------------------------------------------------------------------ */

test("the inheritance rule lives in documents.ts, not twice in two routes", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(
    shared,
    /export function effectiveAnchors\(/,
    "there is no shared rule for what a replacement is filed against",
  );
  /*
   * Supplied wins, the predecessor's value is the floor. The same precedence the
   * inserts use, expressed once so the check and the write cannot disagree.
   */
  for (const field of ["requestId", "siteId", "unitId", "contractorId"]) {
    assert.match(
      shared,
      new RegExp(`${field}: anchors\\.${field} \\|\\| carried\\.${field}`),
      `${field} is not inherited from the predecessor`,
    );
  }
  assert.match(
    shared,
    /if \(!carried\) return anchors;/,
    "an original has no parent, so its effective anchors must be exactly what it supplied",
  );
});

test("inheritance cannot invent an anchor", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const fn = shared.slice(
    shared.indexOf("export function effectiveAnchors("),
    shared.indexOf("export type AnchorSource"),
  );
  assert.ok(fn.length > 0, "effectiveAnchors is not where this test expects it");
  /*
   * Every value comes from `anchors` or from `carried`. A literal fallback here
   * would be the `site-unassigned` sentinel all over again: an id referencing no
   * row in any table that everything downstream has to be taught to ignore.
   */
  assert.doesNotMatch(
    fn,
    /\|\|\s*"[a-z]/i,
    "a string literal is being used as an anchor fallback, which invents a relationship",
  );
  assert.match(
    codeOnly(await source("app/api/files/documents.ts")),
    /export function anchorRefusal/,
    "the rule that a document belongs to something must still exist",
  );
});

test("the anchor rule is decided AFTER the lineage on the single-shot route", async () => {
  const code = codeOnly(await source("app/api/files/route.ts"));
  const guarded = code.indexOf("if (!replacesId) {");
  const plan = code.indexOf("planVersion(db, orgId, replacesId)");
  const effective = code.indexOf("effectiveAnchors(");
  const put = code.indexOf("BUCKET.put(");
  assert.ok(guarded > 0, "the original-only guard is gone, so a replacement is refused early again");
  assert.ok(guarded < plan, "the original's refusal must stay where it was, before any lookup");
  assert.ok(
    plan < effective,
    "the effective anchors are computed before the predecessor is known, so they cannot include it",
  );
  const deferred = code.indexOf("anchorRefusal(filedAgainst)");
  assert.ok(deferred > plan, "a replacement is never checked against its inherited anchors");
  assert.ok(
    deferred < put,
    "the refusal happens after the bytes are stored, which leaves an orphan in the bucket",
  );
});

test("the single-shot key is named after the anchors the ROW will carry", async () => {
  const code = codeOnly(await source("app/api/files/route.ts"));
  assert.match(
    code,
    /const key = `\$\{orgId\}\/maintenance\/\$\{anchorSegment\(filedAgainst\)\}/,
    "the key is derived from the supplied anchors, so an inheriting replacement is stored under /unfiled/",
  );
  assert.match(
    code,
    /requestId: filedAgainst\.requestId,/,
    "the object's own metadata still names a job the row does not, or none at all",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Source: the multipart route, where `start` names the key         */
/* ------------------------------------------------------------------ */

test("multipart refuses an unanchored ORIGINAL early and a replacement never", async () => {
  const code = codeOnly(await source("app/api/files/multipart/route.ts"));
  assert.match(
    code,
    /if \(!replacesId\) \{\s*const missingAnchor = anchorRefusal\(anchors\);/,
    "start refuses on the supplied anchors alone, which refuses every replacement",
  );
  /* And the guard that actually protects the row, in `complete`. */
  const plan = code.indexOf("planVersion(db, orgId, replacesId)");
  const effective = code.indexOf("effectiveAnchors(");
  const refusal = code.indexOf("anchorRefusal(filedAgainst)");
  const stand = code.indexOf("standDownPredecessor(db, orgId, version.predecessor.id)");
  assert.ok(plan > 0 && effective > plan, "complete does not judge the inherited anchors");
  assert.ok(refusal > effective, "complete does not enforce the rule at all");
  assert.ok(
    refusal < stand,
    "the predecessor is stood down before the refusal, so a refused replacement leaves the lineage with no current version",
  );
});

test("multipart names its key by the same rule as the single-shot route", async () => {
  const code = codeOnly(await source("app/api/files/multipart/route.ts"));
  assert.match(
    code,
    /export async function anchorsForKey|anchorsForKey\(db, orgId, anchors, replacesId\)/,
    "nothing resolves the anchors a replacement's key should be named after",
  );
  assert.match(
    code,
    /anchorSegment\(keyAnchors\)/,
    "start still names the key from the supplied anchors, so a >900 KB replacement lands under /unfiled/",
  );
  /*
   * `start`, every part and `abort` must derive the identical prefix or a
   * resumed upload is refused at every chunk. One expression, one call.
   */
  assert.doesNotMatch(
    code,
    /validUploadKey\(key, orgId, anchors, kind\)/,
    "the part check re-derives the prefix from the supplied anchors and will disagree with the key start reserved",
  );
  assert.match(code, /validUploadKey\(key, orgId, keyAnchors, kind\)/);
  assert.match(code, /authorization\.keyAnchors/);
  assert.match(
    code,
    /X-Upload-Replaces/,
    "the part handler cannot see `replaces`, so it computes a different prefix",
  );
});

test("resolving a `replaces` for the key is not a way to probe another tenant", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const fn = shared.slice(
    shared.indexOf("export async function anchorsForKey("),
    shared.length,
  );
  assert.ok(fn.length > 0, "anchorsForKey is not where this test expects it");
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  /*
   * It answers an unresolvable id by returning the supplied anchors — the same
   * key an unanchored upload would get — rather than 404. A refusal here would
   * tell `start` and every part handler which ids exist in another workspace.
   * The real refusals are unchanged and still come from `planVersion` at
   * `complete`.
   */
  assert.doesNotMatch(
    body,
    /Response\.json/,
    "anchorsForKey refuses, which turns the key lookup into a cross-tenant oracle",
  );
  assert.match(
    body,
    /eq\(attachments\.organisationId, orgId\)/,
    "the predecessor is read without an organisation scope",
  );
  /*
   * And it reads ONLY the four anchor columns, which no route writes after
   * insert — `PATCH /api/files/[id]` changes the title, type, description,
   * expiry and archive flag. That is what makes `start` and a part sent twenty
   * minutes later agree. Deliberately no `isCurrent`/`archivedAt` condition: if
   * the parent is archived or superseded mid-upload the parts must keep matching
   * the key, and `complete` is where that is refused.
   */
  assert.doesNotMatch(
    body,
    /isCurrent|archivedAt/,
    "a liveness condition here makes a mid-upload archive refuse every remaining part instead of the upload",
  );
});

test("the client sends `replaces` on every call that names the key", async () => {
  const code = codeOnly(await source("app/lib/client-upload.ts"));
  assert.match(
    code,
    /keyHeaders\["X-Upload-Replaces"\] = options\.replaces/,
    "the parts do not carry `replaces`, so each one re-derives a prefix that disagrees with the key",
  );
  assert.match(
    code,
    /\.\.\.\(options\.replaces \? \{ replaces: options\.replaces \} : \{\}\),/,
    "`replaces` is missing from the shared key fields",
  );
  /* start, parts and abort all spread the same object. */
  const start = code.indexOf('action: "start"');
  const abort = code.indexOf('action: "abort"');
  assert.ok(start > 0 && abort > 0);
  assert.ok(
    code.indexOf("...keyBody,", start) > start && code.indexOf("...keyBody,", start) < abort,
    "the start body does not carry the fields the key is named after",
  );
  assert.ok(
    code.indexOf("...keyBody,", abort) > abort,
    "abort re-validates the key and would be refused for a replacement",
  );
  assert.match(
    code,
    /\.\.\.keyHeaders,/,
    "the part PUT does not carry the fields the key is named after",
  );
});

/* ------------------------------------------------------------------ */
/* 3. Live                                                             */
/* ------------------------------------------------------------------ */

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
let serverUp = null;
async function serverIsUp() {
  if (serverUp !== null) return serverUp;
  try {
    await fetch(`${BASE_URL}/api/board?compact=1`, { signal: AbortSignal.timeout(30000) });
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
async function rawAsOwner(session, path, init = {}) {
  return sendRetrying(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: `maintsupp_session=${session}` },
  });
}
async function asOwner(session, path, init = {}) {
  const response = await rawAsOwner(session, path, init);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function upload(name, body, fields) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/plain" }));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.set(key, value);
  }
  return form;
}

/**
 * The QA marker lives in the TITLE, not only in the filename.
 *
 * Two lanes in this programme have already deleted each other's fixtures with a
 * filename substring sweep. A title is the document's own identity and is what
 * the teardown reports on; the ids it created are what it actually deletes.
 */
const RUN_MARK = `W7VI-${Date.now().toString(36)}`;
const created = new Set();

test("live: a new version inherits every anchor its document already had", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }

  const site = ((await asOwner(session, "/api/sites?limit=50")).body.sites ?? [])[0];
  const workspace = (await asOwner(session, "/api/workspace")).body.workspace ?? {};
  const contractor = (workspace.contractors ?? [])[0];
  const unit = (workspace.units ?? [])[0];
  const job = ((await asOwner(session, "/api/maintenance?limit=20")).body.requests ?? []).find(
    (row) => !RESERVED.has(row.id),
  );
  if (!site || !contractor || !unit || !job) {
    t.skip("the workspace has no site, contractor, unit and work order to anchor against");
    return;
  }

  /*
   * Each anchor on its own, and all four together. Independently, because the
   * bug was in the ORDER the request was judged in and would reappear for any
   * one of them the moment someone re-guarded the check on `requestId`.
   */
  const cases = [
    ["site-and-job", { siteId: site.id, requestId: job.id }],
    ["site-only", { siteId: site.id }],
    ["work-order-only", { requestId: job.id }],
    ["unit-only", { unitId: unit.id }],
    ["contractor-only", { contractorId: contractor.id }],
    [
      "every-anchor",
      { siteId: site.id, requestId: job.id, unitId: unit.id, contractorId: contractor.id },
    ],
  ];

  for (const [label, anchors] of cases) {
    const title = `${RUN_MARK} ${label}`;
    const first = await asOwner(session, "/api/files", {
      method: "POST",
      body: upload(`${RUN_MARK}-${label}-v1.txt`, "version one", {
        kind: "general",
        ...anchors,
        title,
      }),
    });
    assert.equal(first.status, 201, `${label}: ${JSON.stringify(first.body).slice(0, 200)}`);
    const v1 = first.body.file;
    created.add(v1.id);

    /* THE REPRODUCTION: `replaces` and nothing about filing. */
    const second = await asOwner(session, "/api/files", {
      method: "POST",
      body: upload(`${RUN_MARK}-${label}-v2.txt`, "version two", {
        kind: "general",
        replaces: v1.id,
      }),
    });
    assert.equal(
      second.status,
      201,
      `${label}: a new version of an anchored document was refused — ${JSON.stringify(second.body).slice(0, 200)}`,
    );
    const v2 = second.body.file;
    created.add(v2.id);

    for (const field of ["requestId", "siteId", "unitId", "contractorId"]) {
      assert.equal(
        v2[field] ?? null,
        v1[field] ?? null,
        `${label}: ${field} was not carried forward, so the new version is filed somewhere else`,
      );
    }
    assert.equal(v2.title, title, `${label}: a new version is the same document`);
    assert.equal(v2.versionNo, 2);
    assert.equal(v2.rootDocumentId, v1.id, `${label}: version 1 is the lineage root`);

    const history = await asOwner(
      session,
      `/api/files?versionsOf=${encodeURIComponent(v1.id)}`,
    );
    const rows = history.body.files ?? [];
    const heads = rows.filter((row) => row.isCurrent);
    assert.equal(rows.length, 2, `${label}: the lineage is not two rows`);
    assert.deepEqual(
      heads.map((row) => row.id),
      [v2.id],
      `${label}: there must be exactly one current head, and it is the new version`,
    );
  }
});

test("live: an ORIGINAL with no anchor at all is still refused, unchanged", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const refused = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload(`${RUN_MARK}-orphan.txt`, "x", {
      kind: "general",
      title: `${RUN_MARK} orphan`,
    }),
  });
  if (refused.status === 201) created.add(refused.body.file?.id);
  assert.equal(
    refused.status,
    400,
    "W07-07 was weakened: a document with no anchor at all was accepted",
  );
  assert.equal(refused.body.error, MISSING_ANCHOR);
});

test("live: a replacement naming a document this tenant does not hold is refused", async (t) => {
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
   * `planVersion` scopes the predecessor by organisation, so another workspace's
   * id and an id that never existed are the same answer — which is the point.
   * Deferring the anchor check must not have turned a 400 into a 201.
   */
  const refused = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload(`${RUN_MARK}-foreign.txt`, "x", {
      kind: "general",
      replaces: "att-not-in-this-tenant-00000",
    }),
  });
  if (refused.status === 201) created.add(refused.body.file?.id);
  assert.equal(refused.status, 404, JSON.stringify(refused.body).slice(0, 200));
});

test("live: a file over 900 KB replaces without re-sending its anchors", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const site = ((await asOwner(session, "/api/sites?limit=50")).body.sites ?? [])[0];
  const job = ((await asOwner(session, "/api/maintenance?limit=20")).body.requests ?? []).find(
    (row) => !RESERVED.has(row.id),
  );
  if (!site || !job) {
    t.skip("no site and work order to anchor against");
    return;
  }

  /*
   * Driven by hand rather than through `uploadEvidenceFile`, because that needs a
   * browser. The three calls carry exactly what `app/lib/client-upload.ts` sends:
   * `replaces` on `start`, on the part header and on `complete`, and no anchors
   * at all.
   */
  const bytes = "W".repeat(1_150_000);
  const post = (payload) =>
    asOwner(session, "/api/files/multipart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const parent = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload(`${RUN_MARK}-big-v1.txt`, "version one", {
      kind: "general",
      siteId: site.id,
      requestId: job.id,
      title: `${RUN_MARK} large replacement`,
    }),
  });
  assert.equal(parent.status, 201, JSON.stringify(parent.body).slice(0, 200));
  const v1 = parent.body.file;
  created.add(v1.id);

  const start = await post({
    action: "start",
    kind: "general",
    originalName: `${RUN_MARK}-big-v2.txt`,
    contentType: "text/plain",
    byteSize: bytes.length,
    replaces: v1.id,
  });
  assert.equal(
    start.status,
    201,
    `start refused a replacement that named no anchors — ${JSON.stringify(start.body).slice(0, 200)}`,
  );

  const part = await rawAsOwner(session, "/api/files/multipart", {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Upload-Request-Id": "",
      "X-Upload-Kind": "general",
      "X-Upload-Key": start.body.key,
      "X-Upload-Id": start.body.uploadId,
      "X-Upload-Part": "1",
      "X-Upload-Replaces": v1.id,
    },
    body: bytes,
  });
  assert.equal(
    part.status,
    200,
    "the part handler derived a different key prefix from the one `start` reserved",
  );
  const uploaded = await part.json();

  const done = await post({
    action: "complete",
    kind: "general",
    key: start.body.key,
    uploadId: start.body.uploadId,
    parts: [uploaded.part],
    replaces: v1.id,
  });
  assert.equal(done.status, 201, JSON.stringify(done.body).slice(0, 200));
  const v2 = done.body.file;
  created.add(v2.id);
  assert.equal(v2.siteId, site.id, "the large new version lost its site");
  assert.equal(v2.requestId, job.id, "the large new version lost its work order");
  assert.equal(v2.rootDocumentId, v1.id);
  assert.equal(v2.versionNo, 2);
  assert.equal(v2.byteSize, bytes.length);

  /*
   * The bytes come back, which is the only proof from out here that `start`, the
   * part and `complete` agreed about the key — a prefix mismatch stores the
   * object somewhere the row does not point.
   */
  const served = await rawAsOwner(session, `/api/files/${encodeURIComponent(v2.id)}?download=1`);
  assert.equal(served.status, 200, "the row points at an object key nothing was written to");
  assert.equal((await served.text()).length, bytes.length);

  const rows =
    (await asOwner(session, `/api/files?versionsOf=${encodeURIComponent(v1.id)}`)).body.files ?? [];
  assert.deepEqual(
    rows.filter((row) => row.isCurrent).map((row) => row.id),
    [v2.id],
    "exactly one current head, and it is the new version",
  );
});

test("live: multipart still refuses an unanchored ORIGINAL at start, before any bytes", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const start = await asOwner(session, "/api/files/multipart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "start",
      kind: "general",
      originalName: `${RUN_MARK}-big-orphan.txt`,
      contentType: "text/plain",
      byteSize: 1_150_000,
    }),
  });
  assert.equal(start.status, 400, "an unanchored original reserved a key it may never complete");
  assert.equal(start.body.error, MISSING_ANCHOR);
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
    await asOwner(session, `/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  /*
   * Scoped to the ids THIS run created, matched on the title marker rather than
   * on a filename: a filename substring sweep is how two lanes in this programme
   * deleted each other's fixtures. Asserting on every `W7VI-` document in the
   * workspace would also fail this file for somebody else's residue, which is a
   * true statement about the database and a false one about this code.
   */
  const remaining = await asOwner(
    session,
    `/api/files?q=${encodeURIComponent(RUN_MARK)}&limit=100&archived=all`,
  );
  const mine = (remaining.body.files ?? []).filter((file) => created.has(file.id));
  assert.deepEqual(mine.map((file) => file.id), [], "this file left QA residue behind");
});
