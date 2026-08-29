/**
 * Stage 22 — the contractor share link, end to end.
 *
 * Stage 9 built the link and Stage 10 built its coordinator panel, but the
 * thing had never actually been walked through by somebody with no account.
 * Four separate faults each broke it on their own:
 *
 *  1. The page never sent `requestId`, which `/api/files` requires, so every
 *     upload from a shared link was answered 400.
 *  2. The photo query filtered on `attachments.kind = 'issue'`, and the 1,149
 *     imported "Pictures of Maintenance Issue" carry `board_column_id` with
 *     `kind` left at its default — so a link for a job with three photographs
 *     reported `"issuePhotos": []`.
 *  3. "nameplate" is a grant word, not a storable `attachments.kind`, and
 *     `/api/files` coerced it to `"issue"` and then refused it against a link
 *     that had never been granted issue evidence.
 *  4. Completion evidence was stored with no `board_column_id`, and the board
 *     draws its photo cells by column — so an uploaded photograph was invisible
 *     on the job's own row.
 *
 * Two halves, following the Stage 20 pattern. The first reads the source and
 * pins the decisions a passing request cannot demonstrate — that the link never
 * closes a job, never exposes cost. The second drives the real flows against a
 * running dev server and skips when nothing is listening.
 *
 * NOTE ON TEST DATA. The live half signs in as the seeded owner, issues a link
 * against a real job, uploads one 78-byte PNG, posts one comment, and then
 * revokes the link and deletes the file it uploaded. What it cannot undo is the
 * comment: `item_updates` and `activity_log` are append-only by design, so one
 * clearly-labelled row per run is left behind on the job it names.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = "Sunnamusk-Owner-2026";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * The same file with its comments removed.
 *
 * These files explain themselves at length, so a "must NOT contain" assertion
 * would otherwise be answered by a sentence of prose rather than by code.
 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* The shape of the fixes                                              */
/* ------------------------------------------------------------------ */

test("the shared page sends the work order id it is given", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(
    api,
    /requestId: scope\.requestId/,
    "the page cannot upload without being told which job it is on",
  );

  /*
   * THE PAGE NO LONGER BUILDS THE FormData ITSELF — and the contract this test
   * guards survived the change, which is why it is rewritten rather than
   * deleted.
   *
   * It used to `fetch("/api/files")` with a hand-built body. That worked up to
   * the platform's request ceiling and then stopped dead: measured through the
   * real page, 1.01 MB was accepted and 1.92 MB came back 413, shown to the
   * contractor as "Upload failed" with no reason. A photograph off any current
   * phone is 2–5 MB, so the ordinary case was the broken one. It now goes
   * through `uploadEvidenceFile`, the same helper the dashboard's file cell
   * uses, which chunks anything over 900 KB through `/api/files/multipart`.
   *
   * The two fields this test has always been about are still sent — they are
   * named arguments now instead of form fields.
   */
  const view = codeOnly(await source("app/(public)/j/[token]/contractor-job-view.tsx"));
  assert.match(
    view,
    /uploadEvidenceFile\(\{/,
    "a bare POST cannot carry a phone photograph; the shared helper chunks",
  );
  assert.match(
    view,
    /requestId: data\.requestId/,
    "/api/files answers 400 without it",
  );
  assert.match(view, /uploadToken: token/);
  assert.doesNotMatch(
    view,
    /fetch\("\/api\/files"/,
    "posting directly is what capped uploads at the request-body limit",
  );
});

test("the page uploads the storage kind the server names, not the slot's word", async () => {
  const tokens = await source("app/lib/job-tokens.ts");
  assert.match(tokens, /nameplate: "general"/, "nameplate is not a storable kind");
  assert.match(tokens, /export function storageKindFor/);

  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /storageKind/, "the server decides where each kind goes");

  const view = codeOnly(await source("app/(public)/j/[token]/contractor-job-view.tsx"));
  // Same contract, now a named argument to the shared uploader — see above.
  assert.match(view, /kind: slot\.storageKind/);
  assert.doesNotMatch(
    view,
    /kind: kind,/,
    "sending the slot's own word is what produced the nameplate 403",
  );
});

test("issue photos are matched by board column as well as by kind", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /issuePictures/, "the imported photographs carry the column");
  assert.match(
    api,
    /or\(\s*eq\(attachments\.kind, "issue"\)/,
    "kind alone returned nothing for every imported job",
  );
  assert.match(
    api,
    /boardKeyForRequest/,
    "the column must come from the board the job is actually on",
  );
});

test("the page renders thumbnails rather than filenames", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /thumb=1/, "the originals run to several megabytes each");

  const view = await source("app/(public)/j/[token]/contractor-job-view.tsx");
  assert.match(view, /photo\.thumbUrl/);
  assert.match(view, /photo\.url/, "the tile must open the full image");
});

test("a comment lands everywhere the app reads comments from", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /itemUpdates/, "the comment table");
  assert.match(
    api,
    /action: "request\.note_added"/,
    "the drawer's Updates tab renders activity, not item_updates",
  );
  assert.match(
    api,
    /commentCount: sql`\$\{maintenanceRequests\.commentCount\} \+ 1`/,
    "the board row's bubble is a counter",
  );
});

test("the contractor's date is recorded without closing the job", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /completionRequestedAt: finishedOn/);
  const code = codeOnly(api);
  assert.doesNotMatch(
    code,
    /completedAt:/,
    "every meter and insight counts a job closed by completed_at",
  );
  assert.doesNotMatch(
    code,
    /set\(\{[^}]*status:/s,
    "a public link must never set the job status",
  );
  assert.doesNotMatch(code, /stage:/, "nor move it between groups");
});

test("completion evidence is filed onto the column the board draws", async () => {
  const api = await source("app/api/job-link/[token]/route.ts");
  assert.match(api, /completedPictures/);
  assert.match(
    api,
    /isNull\(attachments\.boardColumnId\)/,
    "a photo a coordinator already filed must not be moved",
  );
  assert.match(
    api,
    /eq\(attachments\.kind, "completion"\)/,
    "and the kind must survive, so the drawer and the counters still agree",
  );
});

test("the widened payload is still a whitelist", async () => {
  const tokens = await source("app/lib/job-tokens.ts");
  const safe = tokens.slice(tokens.indexOf("export function contractorSafeJob"));
  assert.match(safe, /location:/, "the store the engineer must attend");
  assert.match(safe, /status:/);
  for (const forbidden of ["cost", "invoice", "approvedBy", "assignee", "contact"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}:`).test(safe),
      `${forbidden} must not be exposed through a shared link`,
    );
  }
});

test("a malformed grant cannot take the page down", async () => {
  const tokens = await source("app/lib/job-tokens.ts");
  assert.match(tokens, /function parseKinds/);
  assert.doesNotMatch(
    codeOnly(tokens),
    /sanitiseKinds\(JSON\.parse\(/,
    "an unparseable column would 503 the whole shared page",
  );
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
  return cookie.slice("maintsupp_session=".length).split(";")[0];
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
 * A request as the owner, re-authenticating once if the session has been cut
 * out from under it.
 *
 * `stage-twenty-auth` tests "sign out everywhere" — as the OWNER, which is the
 * account every suite here signs in as. When the two run together, that test
 * revokes the session this one is holding and everything afterwards answers
 * 401. It is a correct test of a correct feature; the fault is that two suites
 * share one account.
 *
 * Retrying once with a fresh sign-in is the smallest fix that does not weaken
 * either. It is not a blanket retry: only a 401 is retried, and only once, so
 * a genuine authorisation failure still fails rather than being papered over
 * by a loop.
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

/** A job with issue photographs on it, so "the photos appear" means something. */
async function jobWithPhotos(session) {
  const board = await asOwner(session, "/api/board");
  const issueColumn = (board.body.columns ?? []).find(
    (column) => column.key === "issuePictures",
  );
  if (!issueColumn) return null;
  const withPhotos = (board.body.fileCounts ?? []).find(
    (entry) => entry.columnId === issueColumn.id && entry.count > 0,
  );
  return withPhotos?.requestId ?? null;
}

/** A 78-byte PNG. Small enough to be obviously a probe. */
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);

test("a stranger with the link sees the job and its photographs", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  assert.ok(session, "the seeded owner must be able to sign in");

  const requestId = await jobWithPhotos(session);
  assert.ok(requestId, "no job on the board carries issue photographs");

  const issued = await asOwner(session, "/api/board/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, label: "Stage 22 automated check" }),
  });
  assert.equal(issued.status, 201);
  const token = issued.body.url.split("/j/")[1];

  // No cookie header at all. This is the whole point of the link.
  const shared = await fetch(`${BASE_URL}/api/job-link/${token}`);
  assert.equal(shared.status, 200);
  const payload = await shared.json();

  assert.equal(payload.requestId, requestId, "the page is told which job it is on");
  assert.ok(payload.job.title, "a title");
  assert.ok(payload.job.location || payload.site, "somewhere to go");
  assert.ok(payload.issuePhotos.length > 0, "the photographs must be listed");
  assert.ok(payload.uploadSlots.length > 0, "and somewhere to upload evidence");

  for (const photo of payload.issuePhotos.slice(0, 3)) {
    const bytes = await fetch(`${BASE_URL}${photo.thumbUrl}`);
    assert.equal(bytes.status, 200, `thumbnail for ${photo.name}`);
    assert.ok(
      Number(bytes.headers.get("content-length")) > 0,
      "a thumbnail with no bytes is a broken image",
    );
  }

  // The page itself, with no session.
  const page = await fetch(`${BASE_URL}/j/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);

  await asOwner(session, `/api/board/links?id=${issued.body.id}`, { method: "DELETE" });
});

test("the engineer's photo, comment and date reach the job", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  const requestId = await jobWithPhotos(session);
  assert.ok(requestId);

  const issued = await asOwner(session, "/api/board/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, label: "Stage 22 automated check" }),
  });
  const token = issued.body.url.split("/j/")[1];

  // What the job looked like before a public link touched it. Compared rather
  // than asserted against null, because a job on this board may legitimately
  // already carry a completion date the coordinator set.
  const before = await asOwner(session, `/api/maintenance?id=${requestId}`);
  const wasClosedOn = before.body.request.completedAt;
  const wasAtStage = before.body.request.stage;
  const wasAtStatus = before.body.request.status;

  const shared = await (await fetch(`${BASE_URL}/api/job-link/${token}`)).json();
  const slot = shared.uploadSlots.find((entry) => entry.kind === "completion");
  assert.ok(slot, "a contractor link must offer a completion slot");

  const form = new FormData();
  form.append("file", new Blob([PROBE_PNG], { type: "image/png" }), "stage22-probe.png");
  form.append("requestId", shared.requestId);
  form.append("kind", slot.storageKind);
  if (slot.columnId) form.append("columnId", slot.columnId);
  form.append("uploadToken", token);

  const uploaded = await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form });
  const uploadBody = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));

  /*
   * From here on, cleanup runs whatever happens.
   *
   * A failing assertion used to leave the probe photograph attached to a real
   * job and the link live — which is how this suite left a `stage22-probe.png`
   * on the board the first time it ran red. A test that only tidies up when it
   * passes is a test that litters exactly when somebody is debugging.
   */
  try {
    const posted = await fetch(`${BASE_URL}/api/job-link/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "complete",
        note: "Stage 22 automated check — please ignore.",
        by: "Stage 22 Check",
        completedOn: "2026-08-07",
      }),
    });
    const result = await posted.json();
    assert.equal(posted.status, 200, JSON.stringify(result));
    assert.equal(result.recorded, "completion-requested");
    assert.equal(result.completionRequestedAt, "2026-08-07T00:00:00.000Z");

    // The comment, as the job drawer's Updates tab reads it.
    const job = await asOwner(session, `/api/maintenance?id=${requestId}`);
    const notes = (job.body.activities ?? []).filter(
      (entry) => entry.action === "request.note_added",
    );
    assert.ok(
      notes.some((entry) =>
        String(entry.detail.note).includes("Stage 22 automated check"),
      ),
      "the contractor's comment must appear on the job",
    );
    assert.ok(
      notes.some((entry) => String(entry.detail.note).includes("07/08/2026")),
      "and so must the date they gave",
    );

    // The completion date, as the drawer's contractor panel reads it.
    const links = await asOwner(session, `/api/board/links?requestId=${requestId}`);
    assert.equal(links.body.completion.completionRequestedAt, "2026-08-07T00:00:00.000Z");
    assert.equal(links.body.completion.completionRequestedBy, "Stage 22 Check");

    // The job must not have been closed or moved by a public link.
    assert.equal(job.body.request.completedAt, wasClosedOn, "a link may not close a job");
    assert.equal(job.body.request.stage, wasAtStage, "nor move it between groups");
    assert.equal(job.body.request.status, wasAtStatus, "nor change its status");

    // The photograph, in the cell the board actually draws.
    const board = await asOwner(session, "/api/board");
    const completedColumn = (board.body.columns ?? []).find(
      (column) => column.key === "completedPictures",
    );
    const cell = (board.body.fileCounts ?? []).find(
      (entry) => entry.requestId === requestId && entry.columnId === completedColumn.id,
    );
    assert.ok(
      cell && cell.count > 0,
      "the photo must appear in Picture of completed works",
    );
  } finally {
    await asOwner(session, `/api/files/${uploadBody.file.id}`, { method: "DELETE" });
    await asOwner(session, `/api/board/links?id=${issued.body.id}`, { method: "DELETE" });
  }
});

test("a link reaches its own job and nothing else", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  const board = await asOwner(session, "/api/board");
  const ids = (board.body.items ?? []).map((item) => item.requestId);
  const [first, second] = [ids[0], ids.find((id) => id !== ids[0])];
  assert.ok(first && second, "two jobs are needed to test isolation");

  const links = [];
  for (const requestId of [first, second]) {
    const issued = await asOwner(session, "/api/board/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, label: "Stage 22 isolation check" }),
    });
    /*
     * The status is checked before the body is read.
     *
     * This used to go straight to `issued.body.url.split(...)`, so a mint that
     * did not return 201 surfaced as `Cannot read properties of undefined
     * (reading 'split')` — which says nothing about what happened. Under the
     * full suite the dev server occasionally answers this route with something
     * other than 201 while thirty other suites are hitting it, and the useful
     * thing for whoever sees that next is the status and the server's own
     * words, not a TypeError twelve frames deep.
     */
    assert.equal(
      issued.status,
      201,
      `minting a link answered ${issued.status}: ${JSON.stringify(issued.body).slice(0, 200)}`,
    );
    assert.ok(issued.body?.url, "a minted link must carry its url");
    links.push({ id: issued.body.id, token: issued.body.url.split("/j/")[1], requestId });
  }

  for (const link of links) {
    const payload = await (await fetch(`${BASE_URL}/api/job-link/${link.token}`)).json();
    assert.equal(payload.requestId, link.requestId, "a link opens its own job");
  }

  // The second job's token, pointed at the first job's id.
  const form = new FormData();
  form.append("file", new Blob([PROBE_PNG], { type: "image/png" }), "stage22-probe.png");
  form.append("requestId", links[0].requestId);
  form.append("kind", "completion");
  form.append("uploadToken", links[1].token);
  const crossed = await fetch(`${BASE_URL}/api/files`, { method: "POST", body: form });
  assert.equal(crossed.status, 403, "a link for one job must not upload to another");

  for (const link of links) {
    await asOwner(session, `/api/board/links?id=${link.id}`, { method: "DELETE" });
  }
});

test("an unknown, malformed or revoked link is refused, indistinguishably", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  const board = await asOwner(session, "/api/board");
  const requestId = (board.body.items ?? [])[0]?.requestId;
  assert.ok(requestId);

  const issued = await asOwner(session, "/api/board/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, label: "Stage 22 revocation check" }),
  });
  const token = issued.body.url.split("/j/")[1];
  assert.equal((await fetch(`${BASE_URL}/api/job-link/${token}`)).status, 200);

  await asOwner(session, `/api/board/links?id=${issued.body.id}`, { method: "DELETE" });

  const refusals = [];
  for (const candidate of [token, "0".repeat(64), "nonsense", "f".repeat(31)]) {
    const response = await fetch(`${BASE_URL}/api/job-link/${candidate}`);
    assert.equal(response.status, 403, `refused: ${candidate.slice(0, 12)}`);
    refusals.push((await response.json()).error);
  }
  assert.equal(
    new Set(refusals).size,
    1,
    "revoked, unknown and malformed must be indistinguishable",
  );
});
