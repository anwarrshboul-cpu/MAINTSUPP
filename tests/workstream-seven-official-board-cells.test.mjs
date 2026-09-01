/**
 * Two board defects found while closing Workstream 7, both in the file/board
 * API lane, both invisible in the worst possible way: each one answered with a
 * message describing a DIFFERENT problem.
 *
 * 1. `PATCH /api/board/items` `intent:"cell"` COULD NOT WRITE 23 OF THE STORE
 *    DOCUMENTATION BOARD'S 25 COLUMNS. Measured against the running server, one
 *    PATCH per column: 2 wrote, 23 were refused. Two independent causes:
 *
 *    a. `text(body.columnId, 64)` — `text()` TRUNCATES rather than rejecting.
 *       Store Documentation column ids are
 *       `seed-<orgId>-store-documentation-<key>`, 58 to 77 characters, and
 *       nineteen of the twenty-five are over 64. The id was silently shortened,
 *       the lookup missed, and the answer was 404 "Column not found." — which is
 *       exactly what this route says about a column that has been DELETED. So a
 *       truncated id looked like a stale client. Perfect correlation: every id
 *       over 64 failed, every id at or under 64 did not.
 *       `PATCH /api/board`'s `update_cell` uses 100 and writes all 25.
 *
 *    b. TWO VOCABULARIES. `getColumnType` resolves against
 *       `app/lib/column-types.ts`, whose keys are the N2/N3 design set —
 *       `single_select`, `file`, `person`, `date_range`. The DATABASE stores the
 *       board's set — `dropdown`, `files`, `people`, `timeline`, `status`,
 *       `subitems`. They overlap on eight types, so this route answered 409
 *       `Column type "dropdown" is not known` for a column the board's own
 *       editor writes without complaint.
 *
 *    The consequence was not cosmetic: the certificate expiry dates the
 *    compliance register runs on could not be set through this endpoint at all.
 *
 * 2. `/api/board/form` IGNORED `?board=`. `loadForm(db, orgId)` defaults its
 *    `boardId` argument to the literal "maintenance", and neither handler passed
 *    one — so opening the form builder on Store Documentation loaded, displayed
 *    and SAVED the maintenance board's form. A PATCH from that screen silently
 *    rewrote a different board's public form: the operator's own board appeared
 *    to have no form however many times they configured it, and the form real
 *    submitters were filling in changed under them.
 *
 * WHAT MUST NOT CHANGE. Widening what `intent:"cell"` accepts must not make a
 * file column, a system column or a calculated column writable. A file column's
 * contents are `attachments` rows; a cell value shadowing them would be a
 * second, disagreeing answer to "what documents are in this slot" — and the
 * compliance register counts the rows, so the cell would be invisible to it
 * while showing on the board.
 *
 * NOTE ON TEST DATA. The live half writes cell values prefixed `W7OFF` to one
 * Store Documentation row and clears every one of them again. It never touches
 * MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. Source: the truncation                                           */
/* ------------------------------------------------------------------ */

test("intent:cell reads a column id wide enough to hold one", async () => {
  const code = codeOnly(await source("app/api/board/items/route.ts"));
  const cell = code.slice(code.indexOf('if (body.intent === "cell")'));
  assert.match(
    cell,
    /const columnId = text\(body\.columnId, 100\)/,
    "64 truncates 19 of the Store Documentation board's 25 column ids and answers 404",
  );
  assert.doesNotMatch(
    cell,
    /text\(body\.columnId, 64\)/,
    "the truncation is back",
  );
});

test("the two routes that write a cell agree about the id width", async () => {
  const items = codeOnly(await source("app/api/board/items/route.ts"));
  const board = codeOnly(await source("app/api/board/route.ts"));
  const itemsWidth = items.match(/text\(body\.columnId,\s*(\d+)\)/)?.[1];
  const boardWidth = board.match(/trimString\(payload\.columnId,\s*(\d+)\)/)?.[1];
  assert.ok(itemsWidth, "the items route must read a column id");
  assert.ok(boardWidth, "the board route must read a column id");
  assert.equal(
    itemsWidth,
    boardWidth,
    `the items route reads ${itemsWidth} characters and the board route ${boardWidth} — the narrower one silently refuses columns the wider one writes`,
  );
});

test("the upload routes use the same width for the same ids", async () => {
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /slice\(0, 100\)/,
      `${path} must read a board column id at the same width`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. Source: one vocabulary                                           */
/* ------------------------------------------------------------------ */

test("intent:cell validates against the type set the database actually stores", async () => {
  const code = codeOnly(await source("app/api/board/items/route.ts"));
  const cell = code.slice(code.indexOf('if (body.intent === "cell")'));
  assert.match(
    cell,
    /BOARD_COLUMN_TYPES\.has\(type\)/,
    "the board's own set is the one the column rows carry",
  );
  assert.match(
    cell,
    /normalizeBoardCellValue\(type, body\.value\)/,
    "the shared normaliser, so a date written here is identical to one written from the grid",
  );
  assert.doesNotMatch(
    cell,
    /normaliseCellValue\(/,
    "the registry normaliser speaks a different vocabulary and returns null for a dropdown",
  );
});

test("the shared normaliser is the one module three callers use", async () => {
  const shared = await source("app/lib/board-cell-values.ts");
  assert.match(shared, /export const BOARD_COLUMN_TYPES/);
  assert.match(shared, /export function normalizeBoardCellValue/);
  for (const path of [
    "app/api/board/route.ts",
    "app/api/board/items/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /board-cell-values/,
      `${path} does not go through the shared normaliser`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 3. Source: what must stay refused                                   */
/* ------------------------------------------------------------------ */

test("a file column is still not a cell", async () => {
  const code = codeOnly(await source("app/api/board/items/route.ts"));
  const cell = code.slice(code.indexOf('if (body.intent === "cell")'));
  assert.match(
    cell,
    /type === "files" \|\| type === "subitems"/,
    "widening the accepted set must not make a file column writable — its contents are attachments rows",
  );
  assert.match(
    cell,
    /This column cannot be edited as a regular cell/,
    "and the message must be the one the board route already gives, so the two routes cannot be told apart",
  );
});

test("a system column is still a field on the job", async () => {
  const code = codeOnly(await source("app/api/board/items/route.ts"));
  const cell = code.slice(code.indexOf('if (body.intent === "cell")'));
  assert.match(cell, /if \(column\.system\)/);
  assert.match(cell, /dateDecorationValue\(/, "only the date decoration may be stored");
  assert.match(cell, /That column is a field on the job/);
});

test("a calculated column is still read-only", async () => {
  const code = codeOnly(await source("app/api/board/items/route.ts"));
  const cell = code.slice(code.indexOf('if (body.intent === "cell")'));
  assert.match(
    cell,
    /definition\?\.readOnly/,
    "the registry is still asked about read-only types, so widening the accepted set cannot make a derived value writable",
  );
  assert.match(cell, /is calculated and cannot be edited/);
});

/* ------------------------------------------------------------------ */
/* 4. Source: the form route honours the board                         */
/* ------------------------------------------------------------------ */

test("/api/board/form reads ?board= and passes it to every load", async () => {
  const code = codeOnly(await source("app/api/board/form/route.ts"));
  assert.match(code, /searchParams\.get\("board"\)/, "the query parameter is still ignored");
  assert.match(code, /BOARD_IDS\.includes\(/, "an unknown board must fall back, not resolve to none");
  const loads = [...code.matchAll(/loadForm\(db, orgId([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(loads.length >= 3, `expected three loadForm calls, found ${loads.length}`);
  for (const argument of loads) {
    assert.match(
      argument,
      /,\s*boardId/,
      "a loadForm call with no board defaults to the literal \"maintenance\", which is how a Store Documentation save rewrote the maintenance form",
    );
  }
});

test("the board key list is not transcribed a third time", async () => {
  const code = await source("app/api/board/form/route.ts");
  assert.doesNotMatch(
    code,
    /\["maintenance",\s*"store-documentation"\]/,
    "a third copy of the same two strings is a third place to forget a board",
  );
  assert.match(code, /from "\.\.\/\.\.\/\.\.\/lib\/automations\/store"/);
});

/* ------------------------------------------------------------------ */
/* 5. Live                                                             */
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
const writeCell = (session, columnId, itemId, value) =>
  asOwner(session, "/api/board/items?board=store-documentation", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: "cell",
      board: "store-documentation",
      itemId,
      columnId,
      value,
    }),
  });

/**
 * A Store Documentation row to write against — borrowed, or made.
 *
 * The defect this file guards is a function of the Store Documentation board's
 * COLUMN ID LENGTH, so no other board can stand in for it. Depending on a row
 * happening to exist made the whole live half skip on an empty board, which is
 * the failure mode where a test reports success by not running: it must make its
 * own fixture rather than wait for one.
 *
 * Returns `{ id, borrowed }` so the teardown removes only what it created.
 */
async function storeDocumentationRow(session, board) {
  const existing = (board.body.requests ?? []).find((item) => !RESERVED.has(item.id));
  if (existing) return { id: existing.id, borrowed: true };
  const group = (board.body.groups ?? []).find(
    (row) => row.boardId === "store-documentation",
  );
  if (!group) return null;
  const created = await asOwner(session, "/api/board?board=store-documentation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_item", groupId: group.id }),
  });
  return created.body.request?.id
    ? { id: created.body.request.id, borrowed: false }
    : null;
}

/**
 * Removes a row this file created, bin entry and all.
 *
 * `delete_items` is a SOFT delete and can fail with a 503 that is not
 * contention: `recycle_bin` carries a UNIQUE index on
 * (organisation_id, entity_type, entity_id), and job ids are minted from a count
 * of LIVE rows — so a fresh row can be handed an id the bin is still holding
 * from an older, long-purged fixture, and binning it then violates that index.
 * When that happens the stale entry is purged first and the delete retried, so a
 * test never leaves a row behind because of somebody else's residue.
 */
async function removeRow(session, id) {
  const bin = async () =>
    asOwner(session, "/api/board?board=store-documentation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
    });
  let result = await bin();
  if (result.status !== 200) {
    const trash = await asOwner(session, "/api/trash");
    const stale = (trash.body.bin?.entries ?? []).find(
      (entry) => entry.entityId === id,
    );
    if (stale) {
      await asOwner(session, `/api/trash?id=${stale.id}`, { method: "DELETE" });
      return;
    }
    result = await bin();
  }
  const trash = await asOwner(session, "/api/trash");
  const entry = (trash.body.bin?.entries ?? []).find((row) => row.entityId === id);
  if (entry) {
    await asOwner(session, `/api/trash?id=${entry.id}`, { method: "DELETE" });
  }
}

test("live: every editable Store Documentation column can be written, and no other", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const board = await asOwner(session, "/api/board?board=store-documentation");
  const columns = board.body.columns ?? [];
  if (!columns.length) {
    t.skip("the Store Documentation board has no columns on this database");
    return;
  }
  const fixture = await storeDocumentationRow(session, board);
  if (!fixture) {
    t.skip("could not borrow or create a Store Documentation row");
    return;
  }
  const row = { id: fixture.id };

  /* The defect was a function of id LENGTH, so the fixture must contain both. */
  const overLimit = columns.filter((column) => column.id.length > 64);
  assert.ok(
    overLimit.length > 0,
    "this board no longer has a column id over 64 characters, so the regression it guards cannot be observed here",
  );

  const written = [];
  const results = [];
  for (const column of columns) {
    const value = column.type === "date" ? "2027-05-05" : "W7OFF cell";
    const { status, body } = await writeCell(session, column.id, row.id, value);
    results.push({ column, status, body });
    if (status === 200) written.push(column);
  }

  const notFound = results.filter((result) => result.status === 404);
  assert.deepEqual(
    notFound.map((result) => `${result.column.columnKey}(${result.column.id.length})`),
    [],
    "a column sitting on the board answered 404 — the id was truncated before the lookup",
  );

  const unknownType = results.filter((result) =>
    String(result.body?.error ?? "").includes("is not known"),
  );
  assert.deepEqual(
    unknownType.map((result) => `${result.column.columnKey}:${result.column.type}`),
    [],
    "a column type the database stores was rejected as unknown — two vocabularies again",
  );

  /* Everything editable writes. */
  const editable = columns.filter(
    (column) => !column.system && column.type !== "files" && column.type !== "subitems",
  );
  const failed = results.filter(
    (result) =>
      editable.includes(result.column) && result.status !== 200,
  );
  assert.deepEqual(
    failed.map((result) => [result.column.columnKey, result.status, result.body?.error]),
    [],
    "an editable column was refused",
  );
  assert.ok(editable.length >= 10, `only ${editable.length} editable columns found`);

  /* And nothing that should not. */
  for (const result of results) {
    if (result.column.type === "files") {
      assert.equal(
        result.status,
        400,
        `${result.column.columnKey} is a file column and must not be writable as a cell`,
      );
      assert.match(String(result.body?.error ?? ""), /cannot be edited as a regular cell/);
    }
    if (result.column.system) {
      assert.equal(
        result.status,
        400,
        `${result.column.columnKey} is a system column — it is a field on the job, not a cell`,
      );
    }
  }

  /*
   * Left exactly as it was found: a borrowed row has its cells cleared, a row
   * this test created is removed altogether.
   */
  if (fixture.borrowed) {
    for (const column of written) {
      await writeCell(session, column.id, row.id, "");
    }
  } else {
    await removeRow(session, fixture.id);
  }
});

test("live: an unknown column is still an honest 404", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const board = await asOwner(session, "/api/board?board=store-documentation");
  const fixture = await storeDocumentationRow(session, board);
  if (!fixture) {
    t.skip("could not borrow or create a Store Documentation row");
    return;
  }
  const row = { id: fixture.id };
  /*
   * Widening the limit must not turn a genuinely missing column into a silent
   * success — 404 has to keep meaning what it says.
   */
  const { status } = await writeCell(
    session,
    "seed-org_000000000000000000000001-store-documentation-thisColumnDoesNotExistAnywhere",
    row.id,
    "W7OFF",
  );
  assert.equal(status, 404, "a column that really is absent must still be a 404");
  if (!fixture.borrowed) await removeRow(session, fixture.id);
});

test("live: the two boards do not share one form", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const maintenance = await asOwner(session, "/api/board/form?board=maintenance");
  const stores = await asOwner(session, "/api/board/form?board=store-documentation");
  if (maintenance.status !== 200) {
    t.skip("the maintenance board has no form on this database");
    return;
  }
  /*
   * Either Store Documentation has a form of its own — in which case it must be
   * a DIFFERENT one — or it has none, in which case the honest answer is 404.
   * What must never happen again is the maintenance form being served, and
   * saved, under another board's name.
   */
  if (stores.status === 200) {
    assert.notEqual(
      stores.body.form?.id,
      maintenance.body.form?.id,
      "the Store Documentation builder is still editing the maintenance board's form",
    );
  } else {
    assert.equal(
      stores.status,
      404,
      `expected a form of its own or an honest 404, got ${stores.status}`,
    );
  }
});
