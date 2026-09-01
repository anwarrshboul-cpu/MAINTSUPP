/**
 * W07-04, second pass — WHAT A DOCUMENT IS CALLED ONCE IT LEAVES THE APP.
 *
 * WHY THIS FILE EXISTS. The owner's manual test of Documents found the defect
 * that `workstream-seven-official-download.test.mjs` had written down as correct
 * behaviour: rename a document in Documents, press Download, and the file lands
 * on disk as `IMG_7560.jpeg`. Every screen in the product called it "Highcross
 * completion photo"; the one artefact that leaves the product called it what the
 * uploader's phone called it. A criterion can be PASS and the product still
 * wrong when the test asserts the bug.
 *
 * THE POLICY THIS FILE PINS, which is a choice and not a detail:
 *
 *   1. The user-facing name IS the download filename. `documentName` in
 *      app/(app)/portal/views/document-register.ts is the single rule — the
 *      `title` when one is set, the stored filename otherwise — and the server
 *      applies THAT rule rather than a second one of its own.
 *   2. The REAL EXTENSION SURVIVES. A title is prose. The extension comes from
 *      `original_name`, which is the byte-truth, and is appended unless the
 *      title already ends in it.
 *   3. `original_name` and `object_key` ARE NOT REWRITTEN. Provenance is what a
 *      version history, an audit event and a forensic question are answered
 *      from, and the object key is unique, embeds the attachment id, and is
 *      served `immutable`.
 *   4. A NON-CURRENT VERSION carries " (vN)" before the extension. `planVersion`
 *      carries the title forward, so every row in a lineage shares one title;
 *      without the marker, downloading three versions of one certificate leaves
 *      `cert.pdf`, `cert (1).pdf`, `cert (2).pdf` numbered by click order.
 *   5. THE HEADER IS SANITISED. A title is free text an operator typed and it
 *      reaches a response header, so CR/LF, NUL, path separators and quotes are
 *      removed at the source, and both `filename=` and `filename*=UTF-8''` are
 *      always sent so a non-ASCII title survives.
 *
 * AND THE BOARD (BUG 3, server half): `/api/board` used to send only
 * `original_name` in a file cell's preview, so a renamed document kept its
 * upload name on the board while Documents showed the new one. The payload now
 * carries `title` beside it — both facts, so the CLIENT applies the one rule and
 * the server does not grow a second copy of it.
 *
 * TEST DATA. Every fixture this file creates carries the marker `F-SUB2-QA` in
 * its document TITLE as well as its filename, because a filename sweep by
 * another lane has already deleted a neighbour's fixtures in this programme.
 * Everything created is deleted in the teardown. Never touches MN-1049.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);
const MARK = "F-SUB2-QA";
const BUSY_ATTEMPTS = 5;

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
/** Comments are where the policy is explained; code is where it is enforced. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/* ------------------------------------------------------------------ */
/* 1. Source — the naming rule                                         */
/* ------------------------------------------------------------------ */

test("the download name is RESOLVED from the row, not read off original_name", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(
    code,
    /contentDisposition\(servedFileName\(record\), forceAttachment\)/,
    "the header must be built from the resolved name",
  );
  assert.doesNotMatch(
    code,
    /contentDisposition\(record\.originalName/,
    "serving original_name directly IS the defect: a renamed document downloaded under its upload name",
  );
});

test("the server applies the register's rule and does not invent a second one", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(
    route,
    /document-register/,
    "the route must name the canonical rule it is agreeing with, or the two are free to drift apart",
  );
  const code = codeOnly(route);
  assert.match(
    code,
    /const title = sanitiseFileName\(record\.title \?\? ""\)/,
    "the title is the name when it has one",
  );
  assert.match(
    code,
    /const stored = sanitiseFileName\(record\.originalName\) \|\| "document"/,
    "and the stored filename is the fallback, exactly as documentName defines it",
  );
});

test("the real extension survives a rename", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(
    code,
    /const extension = fileExtension\(record\.originalName\)/,
    "the extension comes from the byte-truth, never from the prose title",
  );
  assert.match(
    code,
    /title\.toLowerCase\(\)\.endsWith\(extension\.toLowerCase\(\)\)/,
    "a title that already ends in the extension must not be given a second one",
  );
  assert.match(
    code,
    /\/\^\\\.\[A-Za-z0-9\]\{1,12\}\$\//,
    "an extension is short and alphanumeric — 'Site report v1.2 final' has a dot and no extension",
  );
});

test("provenance is not rewritten to make a header read better", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  const code = codeOnly(route);
  const patch = code.slice(
    code.indexOf("export async function PATCH"),
    code.indexOf("const MAX_THUMBNAIL_BYTES"),
  );
  assert.ok(patch.length > 200, "the PATCH handler must be findable");
  assert.doesNotMatch(
    patch,
    /originalName\s*[:=][^=]/,
    "original_name is the byte-truth and an edit must never assign to it",
  );
  assert.doesNotMatch(
    patch,
    /objectKey\s*[:=][^=]/,
    "the object key embeds the attachment id and is served immutable; renaming it for display would invalidate that",
  );
  assert.match(
    route,
    /object_key/,
    "and the reason must be written down where the next person renaming things will read it",
  );
});

test("a superseded version is named by its own row, and says which version it is", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(
    code,
    /if \(!record\.isCurrent\) \{/,
    "the marker is decided from the row being served, not from a lineage lookup",
  );
  assert.match(
    code,
    /\(v\$\{record\.versionNo\}\)/,
    "a historical download must be able to say which version it is",
  );
  const route = await source("app/api/files/[id]/route.ts");
  assert.match(
    route,
    /HISTORICAL VERSIONS/,
    "a policy choice that is not written down is a policy nobody can keep",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Source — the header is a header                                  */
/* ------------------------------------------------------------------ */

test("a filename reaching a response header is sanitised at the source", async () => {
  const route = await source("app/api/files/[id]/route.ts");
  const code = codeOnly(route);
  assert.ok(
    code.includes('.replace(/[\\u0000-\\u001F\\u007F]+/g, " ")'),
    "CR, LF and NUL in a free-text title are a header-injection vector",
  );
  assert.ok(
    code.includes('.replace(/[\\\\/:*?"<>|]+/g, "-")'),
    "path separators are a traversal in a save dialog; the rest Windows refuses outright",
  );
  assert.match(
    code,
    /\.replace\(\/\[\.\\s\]\+\$\/, ""\)/,
    "Windows drops a trailing dot or space silently, which would eat the extension",
  );
});

test("both filename forms are still sent, so a non-ASCII title survives", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(code, /filename\*=UTF-8''/, "RFC 5987 is what carries a non-ASCII name");
  assert.match(code, /filename="\$\{ascii\}"/, "and the plain form is the fallback");
  assert.match(
    code,
    /replace\(\/\["\\\\\]\/g, "-"\)/,
    "a quote or a backslash inside a quoted header value must not survive",
  );
});

test("the serving hardening is untouched", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  for (const guard of [
    /INLINE_SAFE_TYPES/,
    /application\/octet-stream/,
    /nosniff/,
    /sandbox/,
    /immutable/,
  ]) {
    assert.match(code, guard, `renaming a download must not weaken ${guard}`);
  }
});

test("the single-document read is still scoped to one organisation", async () => {
  const code = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(
    code,
    /eq\(attachments\.id, id\), eq\(attachments\.organisationId, readableOrgId\)/,
    "another workspace's document must read as absent, not as forbidden",
  );
});

/* ------------------------------------------------------------------ */
/* 3. Source — the board carries the title                             */
/* ------------------------------------------------------------------ */

test("the board's file preview carries the title beside the filename", async () => {
  const code = codeOnly(await source("app/api/board/route.ts"));
  assert.equal(
    (code.match(/title: attachments\.title,/g) ?? []).length,
    2,
    "BOTH preview scans — column-filed and kind-filed — must select it, or one kind of cell keeps the old name",
  );
  /*
   * Matched as a PAIR rather than counted on its own: `title: row.title` also
   * appears in this file's group and column payloads, where it means a board
   * column's own heading and has nothing to do with a document. The adjacency to
   * `originalName` is what identifies a preview row, and it doubles as the
   * assertion that original_name STAYS — the chip's type glyph falls back to the
   * extension when R2 stored octet-stream, and a prose title has none.
   */
  assert.equal(
    (code.match(/originalName: row\.originalName,\s*\n\s*title: row\.title,/g) ?? []).length,
    2,
    "both preview pushes must carry the title BESIDE the filename, not instead of it",
  );
});

test("the board resolves no display name of its own", async () => {
  const board = await source("app/api/board/route.ts");
  assert.doesNotMatch(
    codeOnly(board),
    /title\s*\|\|\s*row\.originalName|row\.title\s*\?\?\s*row\.originalName/,
    "resolving the name here would be a second copy of documentName on the server, free to drift from the client's",
  );
  assert.match(
    board,
    /documentName/,
    "the payload must name the one rule its two fields are fed to",
  );
});

test("the compact encoding gains an OPTIONAL sixth slot, and no version bump", async () => {
  const code = codeOnly(await source("app/api/board/route.ts"));
  assert.match(
    code,
    /file\.title\s*\n?\s*\?\s*\(\[/,
    "the title slot is emitted only when there is a title — a trailing null on every preview row is not free",
  );
  assert.match(
    code,
    /compact: 1 as const/,
    "an append-only slot degrades in both directions and needs no marker bump: an old decoder ignores it, a new one reads undefined",
  );
});

/* ------------------------------------------------------------------ */
/* 4. Live                                                             */
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

/**
 * A real 1x1 JPEG, so the row stores `image/jpeg` and the serving path takes the
 * inline-safe branch. The point of the fixture is the EXTENSION and the bytes;
 * 160 bytes is enough of both.
 */
const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

const created = new Set();

async function upload(session, filename, fields) {
  const form = new FormData();
  form.set("file", new File([JPEG_BYTES], filename, { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const result = await asOwner(session, "/api/files", { method: "POST", body: form });
  if (result.body.file?.id) created.add(result.body.file.id);
  return result;
}
const retitle = (session, id, title) =>
  asOwner(session, `/api/files/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
async function download(session, id) {
  const response = await sendRetrying(`${BASE_URL}/api/files/${id}?download=1`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  return {
    status: response.status,
    disposition: response.headers.get("content-disposition") ?? "",
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

/** The anchor every fixture below hangs off: a contractor, never a job. */
async function anchor(session) {
  const workspace = await asOwner(session, "/api/workspace");
  const contractor = (workspace.body.workspace?.contractors ?? [])[0];
  return contractor ? { kind: "general", contractorId: contractor.id } : null;
}

test("live: a renamed document downloads under its new name, extension intact", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const where = await anchor(session);
  if (!where) {
    t.skip("no contractor to anchor a document to");
    return;
  }

  const uploaded = await upload(session, "IMG_7560.jpeg", {
    ...where,
    title: `${MARK} before the rename`,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 200));
  const file = uploaded.body.file;
  assert.ok(!RESERVED.has(file.requestId ?? ""), "must never touch a reserved job");
  assert.equal(file.originalName, "IMG_7560.jpeg", "the upload name is what it was");

  const renamed = await retitle(session, file.id, `${MARK} Highcross completion photo`);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body).slice(0, 200));
  assert.equal(
    renamed.body.file.originalName,
    "IMG_7560.jpeg",
    "PROVENANCE: a rename must not rewrite original_name",
  );

  const got = await download(session, file.id);
  assert.equal(got.status, 200);
  assert.match(
    got.disposition,
    /attachment/,
    "?download=1 must still force a download",
  );
  assert.ok(
    got.disposition.includes(`filename="${MARK} Highcross completion photo.jpeg"`),
    `the reader must get the name the OWNER gave it, with .jpeg intact — got ${got.disposition}`,
  );
  assert.ok(
    got.disposition.includes(
      `filename*=UTF-8''${encodeURIComponent(`${MARK} Highcross completion photo.jpeg`)}`,
    ),
    `and the RFC 5987 form must agree with it — got ${got.disposition}`,
  );
  assert.equal(
    sha(got.bytes),
    sha(JPEG_BYTES),
    "renaming a document must not touch a single byte of it",
  );
});

test("live: a hostile title cannot reach the header, and a non-ASCII one survives", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const where = await anchor(session);
  if (!where) {
    t.skip("no contractor to anchor a document to");
    return;
  }

  const uploaded = await upload(session, "IMG_7561.jpeg", {
    ...where,
    title: `${MARK} hostile fixture`,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 200));
  const id = uploaded.body.file.id;

  /*
   * Every character the policy names, in one title: a forward slash, a
   * backslash, a double quote, a CR and an LF, and two non-ASCII scripts. The
   * CR/LF pair is the injection: unsanitised it would end the Content-
   * Disposition header and let the rest of the title become a header of its own.
   */
  const hostile = `${MARK} a/b\\c"d\r\nX-Injected: yeséالعربية`;
  const patched = await retitle(session, id, hostile);
  assert.equal(patched.status, 200, "a hostile title is stored as typed; it is the OUTPUT that is safe");
  assert.equal(patched.body.file.title, hostile, "nothing is silently rewritten in the database");

  const got = await download(session, id);
  assert.equal(got.status, 200, "a hostile title must not break the response");

  /*
   * THE HEADER FIRST. A CR or an LF anywhere in the value is the injection
   * itself — it ends this header and turns the rest of the title into a header
   * of its own — so those two are checked against the WHOLE string.
   */
  for (const [label, needle] of [
    ["a carriage return", "\r"],
    ["a line feed", "\n"],
  ]) {
    assert.ok(
      !got.disposition.includes(needle),
      `${label} reached the Content-Disposition header: ${JSON.stringify(got.disposition)}`,
    );
  }

  /*
   * THEN THE NAME. The quotes around `filename="…"` are the header's own
   * delimiters, so these are checked against the value INSIDE them — a quote
   * there would close the parameter early, and a separator there is a traversal
   * in a save dialog.
   */
  const plain = /filename="([^"]*)"/.exec(got.disposition);
  assert.ok(plain, `the plain form must still parse — got ${JSON.stringify(got.disposition)}`);
  for (const [label, needle] of [
    ["a forward slash", "/"],
    ["a backslash", "\\"],
    ["a double quote", '"'],
  ]) {
    assert.ok(
      !plain[1].includes(needle),
      `${label} survived into the filename: ${JSON.stringify(plain[1])}`,
    );
  }
  assert.ok(
    !/X-Injected:/i.test(got.disposition),
    "the injected text may survive as inert characters, but never with the colon that makes it a header",
  );
  assert.ok(
    plain[1].endsWith(".jpeg"),
    `the extension must survive sanitisation — got ${plain[1]}`,
  );

  /*
   * And the other half: `filename*` is percent-encoded, so the non-ASCII title
   * arrives intact rather than folded to hyphens the way the ASCII form must be.
   */
  const encoded = /filename\*=UTF-8''(\S+)$/.exec(got.disposition);
  assert.ok(encoded, `the RFC 5987 form must be present — got ${got.disposition}`);
  const decoded = decodeURIComponent(encoded[1]);
  assert.ok(
    decoded.includes("é") && decoded.includes("العربية"),
    `a non-ASCII title must survive the header — got ${decoded}`,
  );
  assert.ok(
    !/[\r\n\\/"]/.test(decoded),
    `and the decoded name must still be safe to write to a disk — got ${decoded}`,
  );
  assert.equal(sha(got.bytes), sha(JPEG_BYTES), "and the bytes are still the bytes");
});

test("live: a document with no title still downloads under its stored filename", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const where = await anchor(session);
  if (!where) {
    t.skip("no contractor to anchor a document to");
    return;
  }

  /*
   * Uploaded WITH a marker title so a sweep can find it, then cleared — which is
   * also the case `documentName` is explicit about: "an operator who clears the
   * box means 'go back to the filename', not 'call this document nothing at
   * all'". The server has to agree, or clearing a title produces a nameless
   * download.
   */
  const uploaded = await upload(session, "IMG_7562.jpeg", {
    ...where,
    title: `${MARK} about to be cleared`,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 200));
  const id = uploaded.body.file.id;

  for (const emptyish of ["   ", null]) {
    const cleared = await retitle(session, id, emptyish);
    assert.equal(cleared.status, 200);
    const got = await download(session, id);
    assert.equal(got.status, 200);
    assert.ok(
      got.disposition.includes('filename="IMG_7562.jpeg"'),
      `a title of ${JSON.stringify(emptyish)} must fall back to the stored filename — got ${got.disposition}`,
    );
  }
});

test("live: a superseded version downloads under its own name and says which version", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const where = await anchor(session);
  if (!where) {
    t.skip("no contractor to anchor a document to");
    return;
  }

  const title = `${MARK} Highcross PAT certificate`;
  const first = await upload(session, "IMG_7563.jpeg", { ...where, title });
  assert.equal(first.status, 201, JSON.stringify(first.body).slice(0, 200));
  const v1 = first.body.file;

  const second = await upload(session, "scan-2027.jpeg", { ...where, replaces: v1.id });
  assert.equal(second.status, 201, JSON.stringify(second.body).slice(0, 200));
  const v2 = second.body.file;
  assert.equal(v2.title, title, "planVersion carries the title forward — that is what makes the marker necessary");

  const head = await download(session, v2.id);
  assert.equal(head.status, 200);
  assert.ok(
    head.disposition.includes(`filename="${title}.jpeg"`),
    `the current version is never marked — got ${head.disposition}`,
  );

  const historical = await download(session, v1.id);
  assert.equal(historical.status, 200, "a superseded version must remain downloadable");
  assert.equal(
    sha(historical.bytes),
    sha(JPEG_BYTES),
    "the superseded bytes must be the ORIGINAL bytes, not the replacement wearing the old id",
  );
  assert.ok(
    historical.disposition.includes(`filename="${title} (v1).jpeg"`),
    `a historical download is named from its OWN row, plus the version it is — got ${historical.disposition}`,
  );
  assert.notEqual(
    head.disposition,
    historical.disposition,
    "two versions of one document must not land on a disk under one name",
  );
});

test("live: the board payload carries the title a renamed document is known by", async (t) => {
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
   * A file cell is keyed on (request, column), so a preview row needs BOTH — the
   * board's own file column and one of its rows. Store Documentation rather than
   * the maintenance board: 31 rows against 744, and it is the board the owner
   * reported the stale name on.
   */
  const board = await asOwner(session, "/api/board?board=store-documentation");
  if (board.status !== 200) {
    t.skip(`board unavailable (${board.status})`);
    return;
  }
  const column = (board.body.columns ?? []).find((entry) => entry.type === "files");
  const row = (board.body.requests ?? []).find((entry) => !RESERVED.has(entry.id));
  if (!column || !row) {
    t.skip("no file column or no row to file a document against");
    return;
  }

  const title = `${MARK} renamed on the board`;
  const uploaded = await upload(session, "IMG_7564.jpeg", {
    kind: "general",
    requestId: row.id,
    columnId: column.id,
    title,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 300));
  const id = uploaded.body.file.id;

  const full = await asOwner(session, "/api/board?board=store-documentation");
  const preview = (full.body.fileCounts ?? [])
    .flatMap((entry) => entry.preview ?? [])
    .find((entry) => entry.id === id);
  assert.ok(preview, "the document must appear in its cell's preview at all");
  assert.equal(
    preview.title,
    title,
    "BUG 3: without the title the cell can only draw the upload filename, which is what the owner saw",
  );
  assert.equal(
    preview.originalName,
    "IMG_7564.jpeg",
    "and original_name stays beside it — the chip's glyph falls back to the extension",
  );

  const compact = await asOwner(session, "/api/board?board=store-documentation&compact=1");
  assert.equal(compact.body.compact, 1, "the grid reads the compact encoding, so it must carry it too");
  const tuple = (compact.body.fileCounts ?? [])
    .flatMap((entry) => entry[3] ?? [])
    .find((entry) => entry[0] === id);
  assert.ok(tuple, "the compact payload must contain the document");
  assert.equal(tuple.length, 6, "a titled document takes the sixth slot");
  assert.equal(tuple[5], title, "and the sixth slot is the title");
  assert.equal(tuple[2], "IMG_7564.jpeg", "slot 3 is still original_name — nothing moved");

  const untitled = (compact.body.fileCounts ?? [])
    .flatMap((entry) => entry[3] ?? [])
    .filter((entry) => entry.length === 5);
  assert.ok(
    untitled.length === 0 || untitled.every((entry) => typeof entry[4] === "string"),
    "an untitled preview row is the SHORT tuple, not a tuple with a null glued on",
  );
});

test("live: an absent session and an unknown id are refused, not 500", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /*
   * The download name is resolved AFTER the row is read and the tenant predicate
   * has already decided, so this is the regression guard for the refusals the
   * rename must not have moved. An id-shaped value that cannot exist rather than
   * a real one: the claim is about the REFUSAL, and a refusal that depends on the
   * row being absent is a different refusal.
   *
   * A genuinely cross-ORGANISATION fetch is not measurable from here — this dev
   * server has one signed-in tenant and no second workspace's credentials — so
   * the tenant predicate itself is asserted from source above
   * ("the single-document read is still scoped to one organisation") and the
   * unreachable-id behaviour is measured here. Said plainly rather than dressed
   * up as a cross-tenant test that was not run.
   */
  const anonymous = await sendRetrying(
    `${BASE_URL}/api/files/00000000-0000-0000-0000-000000000000?download=1`,
    {},
  );
  assert.notEqual(anonymous.status, 500, "an absent session is not an outage");
  assert.ok(
    anonymous.status === 401 || anonymous.status === 404,
    `expected 401 or 404, got ${anonymous.status}`,
  );

  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const missing = await sendRetrying(
    `${BASE_URL}/api/files/00000000-0000-0000-0000-000000000000?download=1`,
    { headers: { Cookie: `maintsupp_session=${session}` } },
  );
  assert.equal(
    missing.status,
    404,
    "a row this session cannot see reads as absent — the same answer another tenant's row gets",
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

  /*
   * And nothing wearing the marker may survive, including a row an earlier
   * failed run left behind. The sweep is on the TITLE, not on the filename: two
   * lanes in this programme have already deleted each other's fixtures with a
   * filename sweep, and `IMG_75xx.jpeg` is exactly the kind of name a real
   * photograph has.
   */
  const sweep = `/api/files?archived=all&limit=100&q=${encodeURIComponent(MARK)}`;
  const register = await asOwner(session, sweep);
  const stragglers = (register.body.files ?? []).filter((file) =>
    (file.title ?? "").includes(MARK),
  );
  for (const file of stragglers) {
    await asOwner(session, `/api/files/${file.id}`, { method: "DELETE" });
  }
  const after = await asOwner(session, sweep);
  assert.deepEqual(
    (after.body.files ?? [])
      .filter((file) => (file.title ?? "").includes(MARK))
      .map((file) => file.id),
    [],
    "no document carrying this file's QA marker may be left on the register",
  );
});
