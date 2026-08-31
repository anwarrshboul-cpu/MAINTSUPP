import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * A Store Documentation certificate that is nothing at all stops counting as
 * one, and the large-file route stops calling a bad request an outage.
 *
 * ── WHY AN EMPTY FILE IS A COMPLIANCE DEFECT AND NOT A TIDINESS ONE ─────────
 *
 * The register never asks whether a certificate is any good. It asks whether
 * the slot's file column holds anything:
 *
 *     const held = input.fileCount > 0;      // store-documentation-register.ts
 *
 * and `fileCount` is `COUNT(*)` over `attachments` for that column
 * (compliance-register.ts, `readStoreDocumentationRows`). So one row is one
 * certificate, whatever is inside it. Measured against the running server
 * before the fix: a 0-byte `W7QA-empty-cert.pdf` posted to the PAT Test
 * Certificate column of a Store Documentation row answered `201` with
 * `byteSize: 0`, and `/api/board`'s file count for that column went from 7 to
 * 8. On the three undated slots — RAMS, the Fire Risk Assessment and the
 * Drawing, which have `expiryColumn: null` — holding a file is the WHOLE
 * question, so an empty upload moves them to "Compliant" permanently and the
 * digest stops chasing them. There is no expiry date to rescue the answer.
 *
 * The multipart route has refused this since it was written — `byteSize < 1` is
 * one of the four conditions behind its 415 — so the two upload paths disagreed
 * about the same file, and the one that accepted it is the one a small
 * certificate takes. That is the class of defect this workstream keeps finding:
 * a rule enforced on one write path and not on its sibling.
 *
 * BOTH DIRECTIONS ARE ASSERTED. An empty file must be refused; a one-byte file
 * must still be accepted. A fix that raises the floor to "some sensible size"
 * would refuse legitimate small files — an 8-byte CSV is a real upload in this
 * suite — and is the same defect pointing the other way.
 *
 * ── AND THE MULTIPART ROUTE'S BODY GUARD ────────────────────────────────────
 *
 * Measured on the same server: `POST /api/files/multipart` with an empty body
 * answered `503 "Unexpected end of JSON input"`, with a body of literal `null`
 * answered `503 "Cannot read properties of null (reading 'action')"`, and with
 * malformed JSON answered `503` carrying V8's parser message. A 503 tells a
 * browser to retry something no retry can fix, and the appended string is an
 * internal runtime message handed to the caller. `/api/board` has guarded its
 * body in exactly this way for exactly this reason.
 *
 * The behavioural tests need a dev server and skip without one, the bargain the
 * rest of this suite already makes. Every fixture is prefixed `W7QA-` and every
 * attachment it creates is deleted in `after()` — an attachment is hard-deleted
 * by the product, so cleanup is the same verb the product uses.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

const RUN = `W7QA-${Date.now().toString(36)}`;
const DOCUMENTATION_BOARD = "store-documentation";

/** Everything this file created, for `after()`. */
const attachments = [];
const items = [];

/*
 * Probed once and remembered.
 *
 * Re-probing per test is how a passing test becomes a silently skipped one: a
 * `/api/context` that answers in 300 ms cold and 6 s while a large upload is in
 * flight will time out on the second test and report "no development server"
 * about a server this file has already been talking to. A skip is worse than a
 * failure because nobody looks at it.
 */
let serverFound = null;
async function serverIsUp() {
  if (serverFound !== null) return serverFound;
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/context`, { signal: AbortSignal.timeout(20000) });
      if (response.ok) {
        BASE_URL = candidate;
        serverFound = true;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  serverFound = false;
  return false;
}

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function json(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/** A Store Documentation row of this run's own, and one of its file columns. */
async function documentationFixture() {
  const board = await json("GET", `/api/board?board=${DOCUMENTATION_BOARD}`);
  assert.equal(board.status, 200, "the documentation board did not load");
  const group = (board.body.groups ?? []).find((entry) => !entry.deletedAt && !entry.archived);
  const column = (board.body.columns ?? []).find((entry) => entry.key === "patCertificate");
  assert.ok(group, "the documentation board has no usable group");
  assert.ok(column, "the documentation board has no PAT certificate column");

  const created = await json("POST", "/api/board/items", {
    board: DOCUMENTATION_BOARD,
    title: `${RUN} store`,
    groupId: group.id,
  });
  assert.equal(created.status, 201, `creating the fixture row answered ${created.status}`);
  items.push(created.body.id);
  return { requestId: created.body.id, columnId: column.id };
}

async function upload(requestId, columnId, name, type, bytes) {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  form.set("requestId", requestId);
  form.set("kind", "general");
  form.set("columnId", columnId);
  const response = await fetch(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  if (response.status === 201 && parsed.file?.id) attachments.push(parsed.file.id);
  return { status: response.status, body: parsed };
}

/** How many files the board reports for one column of one row. */
async function fileCountFor(requestId, columnId) {
  const board = await json("GET", `/api/board?board=${DOCUMENTATION_BOARD}`);
  const entry = (board.body.fileCounts ?? []).find(
    (row) => row.requestId === requestId && row.columnId === columnId,
  );
  return entry?.count ?? 0;
}

test("an empty file is refused by both upload paths, and a one-byte file is not", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server on any candidate port");
    return;
  }
  if (!(await signIn())) {
    t.skip("could not sign in to the development server");
    return;
  }

  const { requestId, columnId } = await documentationFixture();
  assert.equal(await fileCountFor(requestId, columnId), 0, "the fixture slot did not start empty");

  // The direct path, which used to accept this.
  const empty = await upload(requestId, columnId, `${RUN}-empty.pdf`, "application/pdf", new Uint8Array(0));
  assert.equal(
    empty.status,
    400,
    `a 0-byte certificate answered ${empty.status}: ${JSON.stringify(empty.body)}`,
  );
  assert.equal(
    await fileCountFor(requestId, columnId),
    0,
    "an empty upload still counts as a held certificate on the register",
  );

  // The multipart path, which always refused it. Asserted so the two paths
  // cannot drift apart again in the other direction.
  const start = await json("POST", "/api/files/multipart", {
    action: "start",
    requestId,
    kind: "general",
    columnId,
    originalName: `${RUN}-empty.pdf`,
    contentType: "application/pdf",
    byteSize: 0,
  });
  assert.ok(
    start.status >= 400 && start.status < 500,
    `the multipart path accepted a 0-byte start: ${start.status}`,
  );

  // The other direction: small is not empty. An 8-byte CSV is a real upload.
  const tiny = await upload(
    requestId,
    columnId,
    `${RUN}-tiny.csv`,
    "text/csv",
    new TextEncoder().encode("a,b\n1,2\n"),
  );
  assert.equal(tiny.status, 201, `a legitimate 8-byte file was refused: ${JSON.stringify(tiny.body)}`);
  assert.equal(tiny.body.file.byteSize, 8, "the stored size is not the size sent");
  assert.equal(
    await fileCountFor(requestId, columnId),
    1,
    "a real certificate did not reach the register",
  );
});

test("the large-file route refuses a malformed body rather than reporting an outage", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server on any candidate port");
    return;
  }
  if (!(await signIn())) {
    t.skip("could not sign in to the development server");
    return;
  }

  for (const [label, body] of [
    ["an empty body", ""],
    ["a body of literal null", "null"],
    ["malformed JSON", "{oops"],
    ["an array", "[1,2,3]"],
  ]) {
    const response = await fetch(`${BASE_URL}/api/files/multipart`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    const raw = await response.text();
    assert.ok(
      response.status >= 400 && response.status < 500,
      `${label} answered ${response.status}, which tells a browser to retry a request no retry can fix`,
    );
    /*
     * And it must not carry the runtime's own words out to the caller. In
     * development the handler appends `error.message`, which is how "Cannot
     * read properties of null (reading 'action')" reached a browser.
     */
    assert.doesNotMatch(
      raw,
      /Unexpected end of JSON|Cannot read properties|JSON at position/,
      `${label} leaked an internal parser message: ${raw.slice(0, 120)}`,
    );
  }
});

test("both upload routes state the same rule about an empty file", async () => {
  const direct = await read("app/api/files/route.ts");
  const multipart = await read("app/api/files/multipart/route.ts");

  assert.match(
    direct,
    /file\.size\s*<\s*1/,
    "the direct upload route has no empty-file guard",
  );
  assert.match(
    multipart,
    /byteSize\s*<\s*1/,
    "the multipart route lost its empty-file guard",
  );
  /*
   * The message a coordinator sees on the path every file over 900 KB takes.
   * It said "video" — this route was written for video and is now the general
   * large-file path, so a PDF that failed was described as a video that failed.
   */
  assert.doesNotMatch(
    multipart,
    /The video (part )?could not be uploaded/,
    "the large-file route still calls every upload a video",
  );
});

/** Hard-deleted, the same verb the product uses for an attachment. */
after(async () => {
  if (cookie) {
    for (const id of attachments) {
      try {
        await fetch(`${BASE_URL}/api/files/${id}`, { method: "DELETE", headers: { cookie } });
      } catch {
        console.warn(`fixture attachment ${id} could not be deleted and must be removed by hand`);
      }
    }
  }
  if (!items.length) return;

  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
    const file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
    if (!file) return;
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch {
    return;
  }

  try {
    try {
      db.exec("PRAGMA busy_timeout = 15000");
    } catch {
      // An older binding without the pragma still gets the retry below.
    }
    for (const id of items) {
      for (const statement of [
        "DELETE FROM attachments WHERE request_id = ?",
        "DELETE FROM maintenance_board_cells WHERE request_id = ?",
        "DELETE FROM maintenance_group_items WHERE request_id = ?",
        "DELETE FROM item_activity WHERE request_id = ?",
        "DELETE FROM activity_log WHERE entity_type = 'maintenance_request' AND entity_id = ?",
        "DELETE FROM maintenance_requests WHERE id = ?",
      ]) {
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            db.prepare(statement).run(id);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            // A table this build does not have is not a cleanup failure; a lock is.
            if (!/lock|busy/i.test(String(error?.message ?? error))) {
              lastError = null;
              break;
            }
            const until = Date.now() + 200 * (attempt + 1);
            while (Date.now() < until) {
              // `after()` is synchronous enough that a timer would not be awaited.
            }
          }
        }
        if (lastError) {
          console.warn(`fixture cleanup could not run "${statement}" for ${id}: ${lastError.message}`);
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
