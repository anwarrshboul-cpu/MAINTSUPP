/**
 * Owner Part 7 — a Fix Tracker submission updates the canonical Main Table.
 *
 * THE THREE MAPPINGS THE OWNER ASKED FOR:
 *
 *   Fix Tracker "Upload Completed Work Picture" -> "Picture of completed works"
 *   Fix Tracker "Date Completed"                -> "Date Completed"
 *   Fix Tracker "Add Comment"                   -> "Contractor Comments"
 *
 * The first two already reached the job and are pinned here so they cannot
 * silently stop: the upload goes through `uploadEvidenceFile` with
 * `kind: "completion"`, which `/api/board` counts under the completed-pictures
 * cell, and the date goes through `PATCH /api/maintenance { fields:
 * { completedAt } }`, which is the field the board's own Date Completed column
 * draws. The third did not exist: a comment reached `item_updates`,
 * `activity_log` and the row's comment COUNT — none of which is a column — so
 * the board showed a number and no words. `app/lib/contractor-comments.ts` is
 * the new part, and its header says why the column is a board cell rather than
 * `completion_note`.
 *
 * Browser-verified 2026-09-04 on a QA job created and binned by exact id
 * (never MN-1049). Through the real Fix Tracker panel: uploaded a PNG, saved
 * 2026-09-12, submitted a comment; then a FULL RELOAD of the Main Table showed
 * "Picture of completed works" = "5 files", the issue column still "Add", the
 * Date Completed input = `2026-09-12`, and the Contractor Comments cell holding
 * every comment newest-first — including one made through the PUBLIC contractor
 * link — with no earlier comment lost and no internal drawer note in it. Zero
 * console errors; 0px horizontal overflow at 1440/1280/1024/768/430/390/320;
 * the row stayed 40px tall.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* The product's modules import each other without a file extension, which the
   bundler resolves and Node's ESM resolver does not. Borrowed verbatim from
   `w2-store-documentation-instance.test.mjs`. */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = dirname(fileURLToPath(context.parentURL));
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        const candidate = resolvePath(base, specifier + extension);
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

const here = new URL("../", import.meta.url).href;
const {
  appendContractorComment,
  CONTRACTOR_COMMENTS_KEY,
  CONTRACTOR_COMMENTS_LIMIT,
  CONTRACTOR_COMMENTS_TITLE,
} = await import(`${here}app/lib/contractor-comment-log.ts`);

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";

/** The job the owner has asked never to be used as a fixture. */
const RESERVED = new Set(["MN-1049"]);

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const AT = new Date("2026-09-04T10:00:00.000Z");

/* ------------------------------------------------------------------ */
/* 1. The log preserves history                                        */
/* ------------------------------------------------------------------ */

test("a second comment does not replace the first", () => {
  const one = appendContractorComment("", { body: "Valve replaced.", author: "Dave", at: AT });
  const two = appendContractorComment(one, { body: "Gasket fitted.", author: "Dave", at: AT });
  assert.match(two, /Valve replaced\./, "the earlier comment must survive");
  assert.match(two, /Gasket fitted\./);
  // Newest first: a board cell shows its first line, and the first line a
  // coordinator wants is the latest thing the contractor said.
  assert.ok(two.indexOf("Gasket fitted.") < two.indexOf("Valve replaced."));
});

test("each entry is stamped with the day and the person", () => {
  const log = appendContractorComment("", { body: "Attended site.", author: "Dave", at: AT });
  assert.match(log, /^04\/09\/2026 · Dave\nAttended site\.$/, "en-GB, through the shared formatter");
  // An unnamed writer is "Contractor" rather than a blank or an "undefined".
  assert.match(
    appendContractorComment("", { body: "Attended.", author: null, at: AT }),
    /· Contractor\n/,
  );
  assert.match(
    appendContractorComment("", { body: "Attended.", author: "   ", at: AT }),
    /· Contractor\n/,
  );
});

test("an empty comment writes nothing and destroys nothing", () => {
  const log = appendContractorComment("", { body: "First.", author: "Dave", at: AT });
  assert.equal(appendContractorComment(log, { body: "   ", author: "Dave", at: AT }), log);
  assert.equal(appendContractorComment(null, { body: "", author: null, at: AT }), "");
});

test("past the cell's ceiling the OLDEST entries fall off, and the cell says so", () => {
  // `normalizeBoardCellValue` trims a long_text cell at 5,000 characters, and
  // trimming a LOG at an arbitrary character is how the newest comment ends
  // mid-word. This trims at an entry boundary instead.
  let log = "";
  for (let i = 0; i < 60; i += 1) {
    log = appendContractorComment(log, {
      body: `Visit ${i}: ${"x".repeat(200)}`,
      author: "Dave",
      at: AT,
    });
  }
  assert.ok(log.length <= CONTRACTOR_COMMENTS_LIMIT, `log grew to ${log.length}`);
  assert.match(log, /Visit 59:/, "the newest comment must be there");
  assert.doesNotMatch(log, /Visit 0:/, "the oldest must have fallen off");
  assert.match(log, /older comments are not shown here/, "and the cell must say so");
  // The marker is not history and must not accumulate.
  assert.equal(log.match(/older comments are not shown here/g).length, 1);
});

test("a single comment longer than the whole cell is cut, and only then", () => {
  const log = appendContractorComment("", {
    body: "y".repeat(CONTRACTOR_COMMENTS_LIMIT * 2),
    author: "Dave",
    at: AT,
  });
  assert.equal(log.length, CONTRACTOR_COMMENTS_LIMIT);
});

/* ------------------------------------------------------------------ */
/* 2. One canonical job, one column                                    */
/* ------------------------------------------------------------------ */

test("the column is a board cell, and deliberately NOT a system column", async () => {
  const module = codeOnly(await source("app/lib/contractor-comments.ts"));
  assert.equal(CONTRACTOR_COMMENTS_KEY, "contractorComments");
  assert.equal(CONTRACTOR_COMMENTS_TITLE, "Contractor Comments");
  assert.match(module, /system: false/, "update_cell refuses a system column outright");
  assert.match(module, /type: "long_text"/);
  // Written through the one cell writer, shared with the board's own editor and
  // the automation engine.
  assert.match(module, /import \{ setBoardCell \} from "\.\/board-mutations"/);
  // And onto the board the job is actually placed on, never the literal
  // "maintenance" — the same rule `pictureColumnsFor` follows.
  assert.match(module, /boardKeyForRequest\(db, orgId, requestId\)/);
});

test("`completion_note` is left alone — it is a value, not a log", async () => {
  // Two decisions this repository already recorded, and which an append-only
  // log in that column would have broken:
  //   · counters-origin-and-write-path: "completion_note is a single column,
  //     not a log", and request-fields.ts deliberately does not expose it;
  //   · the job-link route replaces it on purpose ("ONLY WHAT WAS SENT").
  const fields = codeOnly(await source("app/lib/request-fields.ts"));
  assert.doesNotMatch(fields, /completionNote/, "the field editor must still not expose it");
  const module = codeOnly(await source("app/lib/contractor-comments.ts"));
  assert.doesNotMatch(module, /completionNote/, "the log must not be written into that field");
});

test("the seeder puts the column on the board before the first comment", async () => {
  const route = codeOnly(await source("app/api/board/route.ts"));
  assert.match(route, /ensureContractorCommentsColumn\(db, orgId, boardId\)/);
  assert.match(
    route,
    /if \(!existingColumnKeys\.has\(CONTRACTOR_COMMENTS_KEY\)\)/,
    "guarded by the same key set as the system-column seeder, so a warm load costs a Set.has",
  );
});

test("the Fix Tracker's three actions all write the canonical job", async () => {
  const panel = codeOnly(await source("app/(app)/portal/views/fix-tracker.tsx"));

  // 1. The picture, through the shared uploader — which owns the ~1 MiB direct
  //    ceiling, the multipart fallback above DIRECT_UPLOAD_LIMIT and the
  //    thumbnail. A hand-rolled fetch("/api/files") loses all three.
  assert.match(panel, /import \{ uploadEvidenceFile \} from "\.\.\/\.\.\/\.\.\/lib\/client-upload"/);
  assert.match(
    panel,
    /uploadEvidenceFile\(\{ file, requestId: item\.id, kind: "completion" \}\)/,
    'the completed-work photo must be filed as completion evidence, not as an issue photo',
  );
  assert.doesNotMatch(panel, /fetch\("\/api\/files"/, "no hand-rolled upload");

  // 2. The date, onto the job's own `completed_at` — the field the board's
  //    Date Completed column draws and the calendar reads.
  assert.match(panel, /fields: \{ completedAt: completedAt \|\| null \}/);

  // 3. The comment, flagged so it reaches the Main Table column.
  assert.match(panel, /note, noteFrom: "contractor"/);
});

test("an ordinary note is NOT filed as something a contractor said", async () => {
  const route = codeOnly(await source("app/api/maintenance/route.ts"));
  assert.match(
    route,
    /if \(note && trimString\(payload\.noteFrom, 20\) === "contractor"\)/,
    "an opt-in flag, never a guess about which screen sent the request",
  );
});

test("a public contractor link files its comment onto the board too", async () => {
  const route = codeOnly(await source("app/api/job-link/[token]/route.ts"));
  assert.match(route, /recordContractorComment\(db, scope\.organisationId, scope\.requestId/);
  // The routing invariant this route lives by: the job and the tenant come from
  // the TOKEN, never from the body.
  assert.doesNotMatch(
    route,
    /body\.(requestId|jobId|organisationId|orgId)/,
    "the request body must never be able to choose the job or the tenant",
  );
});

test("a token may still do only what it authorises", async () => {
  const route = codeOnly(await source("app/api/job-link/[token]/route.ts"));
  assert.match(route, /if \(scope\.audience === "viewer"\) \{\s*return bad\("This link is view-only\.", 403\);/);
  assert.match(route, /if \(!scope\.canRequestCompletion\) \{\s*return bad\("This link cannot mark work complete\.", 403\);/);
  assert.match(route, /if \(!scope\.canComment\) return bad\("This link cannot add notes\.", 403\);/);
  // Nothing here widens a grant: the comment writer is only ever reached from
  // inside `recordComment`, which the guards above stand in front of.
  const uses = route.match(/recordContractorComment\(/g) ?? [];
  assert.equal(uses.length, 1, "one call site, behind the existing guards");
});

test("the completed-work photo lands in the completed column, not the issue one", async () => {
  // The board counts the two photo columns by `board_column_id` PLUS rows that
  // carry only the matching KIND and no column — the app's own uploads store
  // the kind. `kind: "completion"` is therefore what puts a Fix Tracker upload
  // in "Picture of completed works" and keeps it out of the issue cell.
  const counts = codeOnly(await source("app/lib/attachment-counts.ts"));
  assert.match(counts, /issuePictures: "issue"/);
  assert.match(counts, /completedPictures: "completion"/);
  const board = codeOnly(await source("app/api/board/route.ts"));
  assert.match(board, /inArray\(attachments\.kind, \[\.\.\.kindColumns\.keys\(\)\]\)/);
});

/* ------------------------------------------------------------------ */
/* 3. The live half                                                    */
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

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** One disposable job. A persistent 503 is BUSY, not a failure — see CLAUDE.md. */
async function qaJob(session) {
  const groups = await asOwner(session, "/api/board?compact=1");
  const group = (groups.body.groups ?? []).find((row) => !row.archived && !row.deletedAt);
  if (!group) return { busy: true, why: "no board group answered" };
  const attempts = [
    ["/api/board/items?board=maintenance", { groupId: group.id, title: "contractor comment fixture" }],
    ["/api/board?board=maintenance", { action: "create_item", groupId: group.id }],
  ];
  let last = { status: 0, body: {} };
  for (let round = 0; round < 3; round += 1) {
    for (const [path, body] of attempts) {
      last = await asOwner(session, path, post(body));
      const id = last.body?.request?.id ?? last.body?.id;
      if (id && !RESERVED.has(id)) return { id };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { busy: true, why: `creating a job answered ${last.status}` };
}

test("live: a contractor's comments accumulate in the Main Table column", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  assert.ok(session);

  const fixture = await qaJob(session);
  if (fixture.busy) {
    t.skip(`the dev database would not take a fixture write — ${fixture.why}`);
    return;
  }
  const { id } = fixture;
  assert.ok(!RESERVED.has(id));
  let linkId = null;

  try {
    // The column is on the board before anybody comments.
    const board = await asOwner(session, "/api/board");
    const column = (board.body.columns ?? []).find((c) => c.key === CONTRACTOR_COMMENTS_KEY);
    assert.ok(column, "the Main Table must carry a Contractor Comments column");
    assert.equal(column.title, CONTRACTOR_COMMENTS_TITLE);
    assert.equal(column.system, false, "a system cell would be refused by update_cell");

    const cellFor = async () => {
      const state = await asOwner(session, "/api/board");
      const cell = (state.body.cells ?? []).find(
        (c) => c.requestId === id && c.columnId === column.id,
      );
      return cell?.value ?? "";
    };

    // Two comments through the Fix Tracker's own call.
    await asOwner(session, "/api/maintenance", patch({ id, note: "Valve replaced.", noteFrom: "contractor" }));
    await asOwner(session, "/api/maintenance", patch({ id, note: "Gasket fitted.", noteFrom: "contractor" }));
    // ...and one ordinary drawer note, which must NOT be filed as a contractor's.
    await asOwner(session, "/api/maintenance", patch({ id, note: "INTERNAL: chase the landlord." }));

    let value = await cellFor();
    assert.match(value, /Valve replaced\./, "the first comment must survive the second");
    assert.match(value, /Gasket fitted\./);
    assert.ok(value.indexOf("Gasket fitted.") < value.indexOf("Valve replaced."), "newest first");
    assert.doesNotMatch(value, /INTERNAL: chase the landlord/, "an ordinary note is not a contractor comment");

    // The date the Fix Tracker saves is the board's own Date Completed field.
    const dated = await asOwner(session, "/api/maintenance", patch({ id, fields: { completedAt: "2026-09-12" } }));
    assert.equal(dated.status, 200);
    assert.match(String(dated.body.request.completedAt), /^2026-09-12/);

    // ── the public contractor link ────────────────────────────────────────
    const minted = await asOwner(
      session,
      "/api/board/links",
      post({ requestId: id, audience: "contractor", label: "part-seven fixture", expiryDays: 1 }),
    );
    assert.ok(minted.status < 300, `minting a link answered ${minted.status}`);
    linkId = minted.body.id;
    const token = String(minted.body.url).split("/").pop();

    const posted = await fetch(`${BASE_URL}/api/job-link/${token}`, post({
      note: "Attended site, parts ordered.",
      by: "Dave the Contractor",
    }));
    assert.equal(posted.status, 200);
    value = await cellFor();
    assert.match(value, /Dave the Contractor/, "a public-link comment must reach the same column");
    assert.match(value, /Valve replaced\./, "and must not replace what was already there");

    // ── and a token may still do only what it authorises ──────────────────
    const readOnly = await asOwner(
      session,
      "/api/board/links",
      post({
        requestId: id,
        audience: "contractor",
        canComment: false,
        canRequestCompletion: false,
        label: "part-seven read-only",
        expiryDays: 1,
      }),
    );
    const readOnlyToken = String(readOnly.body.url).split("/").pop();
    const refusedNote = await fetch(`${BASE_URL}/api/job-link/${readOnlyToken}`, post({
      note: "MUST NOT APPEAR",
      by: "Rogue",
    }));
    assert.equal(refusedNote.status, 403);
    const refusedDone = await fetch(`${BASE_URL}/api/job-link/${readOnlyToken}`, post({
      intent: "complete",
      note: "MUST NOT APPEAR",
    }));
    assert.equal(refusedDone.status, 403);

    const viewer = await asOwner(
      session,
      "/api/board/links",
      post({ requestId: id, audience: "viewer", label: "part-seven viewer", expiryDays: 1 }),
    );
    const viewerToken = String(viewer.body.url).split("/").pop();
    const refusedViewer = await fetch(`${BASE_URL}/api/job-link/${viewerToken}`, post({
      note: "MUST NOT APPEAR",
    }));
    assert.equal(refusedViewer.status, 403);

    // An unknown token is refused identically, so a stale link cannot probe.
    const unknown = await fetch(`${BASE_URL}/api/job-link/${"0".repeat(64)}`, post({ note: "MUST NOT APPEAR" }));
    assert.equal(unknown.status, 403);

    value = await cellFor();
    assert.doesNotMatch(value, /MUST NOT APPEAR/, "a refused write must leave nothing behind");

    await asOwner(session, `/api/board/links?id=${readOnly.body.id}`, { method: "DELETE" });
    await asOwner(session, `/api/board/links?id=${viewer.body.id}`, { method: "DELETE" });
  } finally {
    if (linkId) await asOwner(session, `/api/board/links?id=${linkId}`, { method: "DELETE" });
    // Binned by its EXACT id — never by a title sweep.
    await asOwner(session, "/api/board?board=maintenance", post({ action: "delete_items", requestIds: [id] }));
  }
});
