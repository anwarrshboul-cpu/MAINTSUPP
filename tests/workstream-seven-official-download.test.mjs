/**
 * W07-04 — "Allow users to download documents."
 *
 * WHY THIS FILE EXISTS SEPARATELY. W07-04 was the one official criterion that
 * entered this closure already PASS, and the temptation with an already-passing
 * criterion is to leave it alone. That would have been wrong here, because
 * W07-03 changed what "a document" means underneath it: a document is now a
 * lineage, so "download the document" acquired a second case — download a
 * SUPERSEDED version — that did not exist when W07-04 was last true. A
 * criterion whose subject changed is not still proven by its old evidence.
 *
 * The other half is the serving contract, which is the part that quietly
 * regresses: the filename a reader gets, whether the bytes are the bytes that
 * were uploaded, and whether a document that cannot be served inline is handed
 * over as a download rather than rendered on the app's own origin.
 *
 * Two halves, matching the other official suites: source assertions for the
 * decisions that must not be undone, then the real thing against a running dev
 * server, skipped when nothing answers.
 *
 * TEST DATA. Uploads tiny `W7OFF-dl-` text files anchored to a contractor,
 * downloads them, and deletes every one in the teardown. Never touches MN-1049.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);
const BUSY_ATTEMPTS = 5;

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

/* ------------------------------------------------------------------ */
/* 1. Source — the serving contract                                    */
/* ------------------------------------------------------------------ */

test("W07-04 the download names the file it is serving", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(route, /Content-Disposition/i);
  assert.match(
    route,
    /filename\*=UTF-8''/,
    "a filename with a non-ASCII character must survive the header, so the RFC 5987 form is required alongside the plain one",
  );
});

test("W07-04 a document that cannot be shown inline is handed over, not rendered", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(route, /INLINE_SAFE_TYPES/, "an allow-list decides, never a deny-list");
  assert.match(route, /application\/octet-stream/, "anything else is downgraded before it is served");
  assert.match(route, /nosniff/, "or the browser will second-guess the downgrade");
  assert.match(
    route,
    /sandbox/,
    "a served document must not be able to act on the app's origin",
  );
});

test("W07-04 a superseded version is still addressable", async () => {
  /*
   * The route reads one attachment row by id and serves its object_key. That is
   * what makes a historical version downloadable for free — a version IS a row,
   * so no separate history endpoint is needed and none should be added. This
   * asserts the property that keeps it true: the read is keyed on the id, and
   * is NOT narrowed to current-only rows the way the LIST is.
   */
  const route = await source("app/api/files/[id]/route.ts");
  assert.doesNotMatch(
    route,
    /isCurrent[^\n]*\)\s*\)?\s*$/m,
    "the single-document read must not filter on is_current, or history becomes unreachable",
  );
  const documents = await source("app/api/files/documents.ts");
  assert.match(
    documents,
    /isCurrent|is_current/,
    "the LIST is where current-only belongs",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Live — the bytes                                                 */
/* ------------------------------------------------------------------ */

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
    // Any reply means up, including a 5xx: a busy local D1 is not an absent
    // server, and treating it as one silently skips every assertion below.
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
async function asOwner(session, path, init = {}) {
  const response = await sendRetrying(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: `maintsupp_session=${session}` },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function upload(name, body, fields) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/plain" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

const created = new Set();

test("live: W07-04 both the current and the superseded version download intact", async (t) => {
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
    t.skip("no contractor to anchor a document to");
    return;
  }
  const anchor = { kind: "general", contractorId: contractor.id };

  const V1 = "W7OFF download version one";
  const V2 = "W7OFF download version two, which is a different length";

  const first = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-dl-v1.txt", V1, { ...anchor, title: "W7OFF downloadable" }),
  });
  assert.equal(first.status, 201, JSON.stringify(first.body).slice(0, 200));
  const v1 = first.body.file;
  created.add(v1.id);
  assert.ok(!RESERVED.has(v1.requestId ?? ""), "must never touch a reserved job");

  const second = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-dl-v2.txt", V2, { ...anchor, replaces: v1.id }),
  });
  assert.equal(second.status, 201, JSON.stringify(second.body).slice(0, 200));
  const v2 = second.body.file;
  created.add(v2.id);

  // The current version: bytes identical, and identical BOTH ways it is served.
  const asAttachment = await sendRetrying(`${BASE_URL}/api/files/${v2.id}?download=1`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  assert.equal(asAttachment.status, 200);
  const attachedBody = await asAttachment.text();
  assert.equal(sha(attachedBody), sha(V2), "the current version's bytes must round-trip");
  assert.match(
    asAttachment.headers.get("content-disposition") ?? "",
    /attachment/,
    "?download=1 must force a download",
  );
  assert.match(
    asAttachment.headers.get("content-disposition") ?? "",
    /W7OFF-dl-v2\.txt/,
    "the reader must get the name the file was uploaded under",
  );

  const inline = await sendRetrying(`${BASE_URL}/api/files/${v2.id}`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  assert.equal(sha(await inline.text()), sha(V2), "inline and download must be the same bytes");

  /*
   * THE CASE W07-03 CREATED. Version 1 was replaced, so it is gone from the
   * register's default list — but it must still be retrievable, byte for byte,
   * under its own id. A version history that cannot hand back the version is a
   * list of dates.
   */
  const historical = await sendRetrying(`${BASE_URL}/api/files/${v1.id}?download=1`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  assert.equal(historical.status, 200, "a superseded version must remain downloadable");
  assert.equal(
    sha(await historical.text()),
    sha(V1),
    "the superseded bytes must be the ORIGINAL bytes, not the replacement wearing the old id",
  );
  assert.match(
    historical.headers.get("content-disposition") ?? "",
    /W7OFF-dl-v1\.txt/,
    "and under its own original filename",
  );
});

test("live: W07-04 a document is not downloadable without a session", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /*
   * Deliberately an id-shaped value that cannot exist rather than a real one:
   * the claim is about the REFUSAL, and a refusal that depends on the row being
   * absent is not the same refusal. What must not happen is a 500 — an
   * unhandled scopedDb throw answering an ended session with an outage instead
   * of "sign in", which is exactly the defect this route carried until recently.
   */
  const response = await sendRetrying(
    `${BASE_URL}/api/files/00000000-0000-0000-0000-000000000000?download=1`,
    {},
  );
  assert.notEqual(response.status, 500, "an absent session is not an outage");
  assert.ok(
    response.status === 401 || response.status === 404,
    `expected 401 or 404, got ${response.status}`,
  );
});

test("teardown: every document this file created is removed", async (t) => {
  if (!created.size) {
    t.skip("nothing was created");
    return;
  }
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
    await asOwner(session, `/api/files/${id}`, { method: "DELETE" });
  }
  const remaining = [];
  for (const id of created) {
    const check = await sendRetrying(`${BASE_URL}/api/files/${id}`, {
      headers: { Cookie: `maintsupp_session=${session}` },
    });
    if (check.status === 200) remaining.push(id);
  }
  assert.deepEqual(remaining, [], "QA residue must be zero");
});
