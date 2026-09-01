import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * WORKSTREAM 7 — W07-07 (document relationships), W07-08/W07-09 (the register
 * behind the Dashboard, and one expiry definition) and W07-13 (a removal reaches
 * every connected view).
 *
 * Mixed on purpose. Some of these claims are about what an endpoint returns and
 * are asserted against a running server; others are about there being ONLY ONE
 * definition of something, and a single definition is a structural fact that no
 * amount of response-checking can prove — a second classifier added tomorrow
 * would agree with the first on every value the tests happen to try, right up
 * until it did not. Those are asserted on the source.
 *
 * The server-driven tests skip cleanly when it is not up, as
 * tests/workstream-six-contractor-scope.test.mjs does.
 */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function signIn() {
  let response;
  try {
    response = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  cookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return Boolean(cookie);
}

/* ── W07-09 — one expiry definition ──────────────────────────────────────── */

test("W07-09 — the site detail screen has no expiry classifier of its own", async () => {
  /*
   * It had one, and it disagreed with the platform on BOTH axes at once: a
   * 30-day amber window against `EXPIRY_DUE_SOON_DAYS = 60`, and its own five
   * sentence-labels ("Expires in 12 days", "Valid to 15/10/2026") against the
   * register's five words. So a certificate 45 days from expiry was "Expiring
   * soon" everywhere in the product and reassuring green on the page for the
   * individual store.
   *
   * The screen now renders the state the server derived and asks `expiryStatus`
   * only for the sentence. What this asserts is the absence: no local ladder, no
   * local threshold, no locally-built verdict.
   */
  const view = await read("app/(app)/portal/sites/site-detail.tsx");
  const code = view
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(code, /days <= 30/, "no local 30-day amber window");
  assert.doesNotMatch(code, /function expiryState\(/, "no local classifier");
  assert.doesNotMatch(code, /daysUntil\(/, "no local day arithmetic");
  assert.match(code, /expiryStatus\(/, "the shared classifier supplies the sentence");
  assert.match(
    code,
    /record\.status/,
    "and the visible verdict is the one the server derived",
  );
});

test("W07-09 — the compliance digest owns no date parser and no threshold of its own", async () => {
  const route = await read("app/api/notifications/compliance/route.ts");
  const code = route
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  /*
   * The digest used to own `daysBetween`, built on `new Date(iso)`. A value that
   * parser rejected was `continue`d, so the document silently stopped alerting
   * FOR EVER while still rendering on screen through the register's own parser.
   */
  assert.doesNotMatch(code, /function daysBetween\(/, "no private date parser");
  assert.match(
    code,
    /expiryStatus\([^)]*\)\.daysRemaining/,
    "the shared classifier counts the days",
  );

  /*
   * The 90/60/30/14/7/0 ladder STAYS. It is an alert cadence, not a RAG state —
   * a different question from "is this certificate in date" — and it is the
   * promise the marketing pages make in as many words. Keeping it is the point;
   * what must not happen is it being mistaken for a status.
   */
  assert.match(code, /STAGES = \[90, 60, 30, 14, 7, 0\]/, "the reminder cadence is unchanged");
});

test("W07-09 — a stored status string can no longer reach a screen", async () => {
  /*
   * `readComplianceRegister` had one surviving path where it did: a register-only
   * row with no expiry date served `row.status` verbatim, through an unchecked
   * `as ComplianceState` cast. Since the PATCH accepted arbitrary text for
   * `state`, the value that cast produced could be any string at all — including
   * one no screen has a colour for.
   */
  const lib = await read("app/lib/compliance-register.ts");
  const code = lib
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  assert.doesNotMatch(
    code,
    /\(row\.status as ComplianceState\)/,
    "the stored status is not a fallback for a missing expiry date",
  );
  assert.match(
    code,
    /complianceStateFor\(\{/,
    "every state is computed by the shared classifier",
  );
});

test("W07-09 — a date-shaped string that is not a real date is refused at the write", async () => {
  /*
   * `dateOnlyValue` checks SHAPE, deliberately: it normalises what board cells
   * already hold and must not start rejecting stored values. But `2027-13-45`
   * matches that shape and is not a date, and `Date.UTC(2027, 12, 45)` rolls the
   * overflow forward silently into February 2028 rather than failing — so a typo
   * became a real expiry date that nobody chose and every screen agreed about.
   * Postgres will not catch it either: the CHECK on `attachments.expiry_date` is
   * the same shape-only regex.
   */
  const lib = await read("app/lib/expiry-status.ts");
  assert.match(lib, /export function isRealCalendarDate\(/, "existence is checked separately");

  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /isRealCalendarDate\(/, "and the write path uses it");
});

/* ── W07-07 — the relationships ──────────────────────────────────────────── */

test("W07-07 — a contractor's documents are reachable from the contractor", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const { json } = await call("GET", "/api/workspace");
  const contractors = json?.workspace?.contractors ?? [];
  if (contractors.length === 0) return t.skip("this workspace has no contractors");

  /*
   * Before W07-07 there was no link to reach: `attachments` could name a job, a
   * site and a unit, and the contractor register held insurance and
   * certification as free text with no file behind either. A count of zero is a
   * real answer; a MISSING count means the relationship is not being served.
   */
  for (const contractor of contractors) {
    assert.equal(
      typeof contractor.documentCount,
      "number",
      `${contractor.name} must carry a document count, even when it is zero`,
    );
    assert.ok(contractor.documentCount >= 0, "and it cannot be negative");
  }
});

test("W07-07 — a site's compliance documents carry their board provenance", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const stores = (await call("GET", "/api/workspace")).json?.workspace?.stores ?? [];
  if (stores.length === 0) return t.skip("this workspace has no sites");

  const { json } = await call("GET", `/api/sites?id=${encodeURIComponent(stores[0].id)}`);
  const rows = json?.compliance ?? [];
  if (rows.length === 0) return t.skip("this site has no compliance rows");

  for (const row of rows) {
    // The four fields the screen reads, unchanged from the old raw-row shape.
    for (const field of ["id", "kind", "expiryDate", "notRequired"]) {
      assert.ok(field in row, `the screen's \`${field}\` is still served`);
    }
    // And the enrichment that made the swap worth doing.
    for (const field of ["state", "fileCount", "itemId", "slotKey", "tracksExpiry"]) {
      assert.ok(field in row, `the derived \`${field}\` is served`);
    }
    assert.equal(row.status, row.state, "the two names for the verdict agree");
  }
});

test("W07-07 — the site payload no longer publishes the register's internal columns", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const stores = (await call("GET", "/api/workspace")).json?.workspace?.stores ?? [];
  if (stores.length === 0) return t.skip("this workspace has no sites");

  const { json } = await call("GET", `/api/sites?id=${encodeURIComponent(stores[0].id)}`);
  const rows = json?.compliance ?? [];
  if (rows.length === 0) return t.skip("this site has no compliance rows");

  /*
   * The old reader was `db.select()` with no projection — SELECT * — so the
   * browser was handed `organisationId`, `legacyClientId`, `lastAlertAt`,
   * `lastAlertStage`, `createdAt` and `updatedAt` for every row, for no reason.
   */
  for (const leaked of [
    "organisationId",
    "legacyClientId",
    "lastAlertAt",
    "lastAlertStage",
    "createdAt",
    "updatedAt",
  ]) {
    assert.ok(!(leaked in rows[0]), `\`${leaked}\` is internal and is not published`);
  }
});

/* ── W07-13 — a removal or a replacement reaches the connected views ─────── */

test("W07-13 — a site's Documents tab lists only live, current versions", async () => {
  /*
   * This selected every attachment carrying the site id, which was right while a
   * document was one immutable upload. With versions and archiving it is not: a
   * lease replaced four times listed five times, with nothing on the row saying
   * which was in force, and a document archived on purpose went on being listed.
   */
  const route = await read("app/api/sites/route.ts");
  const at = route.indexOf(".from(attachments)");
  assert.ok(at > 0, "the site's attachments query is findable");
  const query = route.slice(at, route.indexOf(".limit(", at));
  assert.match(query, /isNull\(attachments\.archivedAt\)/, "archived documents are excluded");
  assert.match(query, /eq\(attachments\.isCurrent, true\)/, "superseded versions are excluded");
});

test("W07-13 — the contractor document count uses the same liveness rule", async () => {
  /*
   * Two screens must not disagree about what "has documents" means. If the site
   * tab hides archived and superseded rows and the contractor count includes
   * them, a contractor reads "3 documents" and opens a panel showing one.
   */
  const route = await read("app/api/workspace/route.ts");
  const at = route.indexOf("contractorId: attachments.contractorId");
  assert.ok(at > 0, "the contractor document count is findable");
  const query = route.slice(at, route.indexOf(".groupBy(", at));
  assert.match(query, /isNull\(attachments\.archivedAt\)/, "archived documents are excluded");
  assert.match(query, /eq\(attachments\.isCurrent, true\)/, "superseded versions are excluded");
});

/* ── The digest's estate scope ───────────────────────────────────────────── */

test("the operational estate is defined once, and the DIGEST applies it — not the register", async () => {
  const lib = await read("app/lib/compliance-register.ts");
  const digest = await read("app/api/notifications/compliance/route.ts");

  assert.match(lib, /export function withinOperationalEstate\(/, "one definition, in the register");

  /*
   * Applied in the scan and NOWHERE ELSE. This is the whole shape of the owner's
   * decision: Europe and placeholder rows never alert, and a closed store stays
   * fully readable — on the board, in the register, on the tracker, in the CSV —
   * while generating no CURRENT operational alert. Filtering inside
   * `readComplianceRegister` would have deleted those rows from every screen,
   * which is a different and much worse product.
   */
  assert.match(digest, /withinOperationalEstate\(row\)/, "the digest skips out-of-scope rows");
  const scanAt = lib.indexOf("export async function readComplianceRegister");
  const reader = lib.slice(scanAt);
  assert.ok(
    !/if \(!withinOperationalEstate/.test(reader),
    "the register itself must keep returning every row, whatever its group",
  );
});

test("the estate scope reads the board GROUP, because region cannot separate anything", async () => {
  /*
   * Every one of the client's 31 sites is `region = 'UK'` in the database. The
   * two non-UK rows — Mall of Netherlands and the placeholder "Item 5" — are
   * identified by sitting in the board's Europe group and by nothing else, so a
   * region-based scope would be a filter that never fires.
   */
  const lib = await read("app/lib/compliance-register.ts");
  assert.match(lib, /NON_OPERATIONAL_GROUPS/, "the groups are named");
  assert.match(lib, /"europe"/, "Europe is out of the operational digest");
  assert.match(lib, /"closed"/, "and so is a closed store");
  assert.match(
    lib,
    /groupId: maintenanceGroupItems\.groupId/,
    "the group travels with the placement the register already reads",
  );
  assert.match(
    lib,
    /boardGroup/,
    "and is carried on the row rather than re-queried by the digest",
  );
});

/* ── W07-09/W07-03 — the register counts DOCUMENTS, not rows ─────────────── */

/** The Store Documentation board's PAT certificate column, and a row on it. */
async function patCertificateSlot() {
  const board = (await call("GET", "/api/board?board=store-documentation")).json ?? {};
  const column = (board.columns ?? []).find((entry) => entry.key === "patCertificate");
  if (!column) return { reason: `no patCertificate column (${(board.columns ?? []).length} columns read)` };
  const workspace = await workspaceOf();
  /*
   * ANY row the register can see. The assertions below are on the DELTA, not on
   * an absolute, so this does not need a pristine slot — which matters, because
   * this development server is shared and a suite that demands a clean fixture
   * is a suite that skips exactly when somebody else is working. Measuring the
   * change is also the stronger claim: it is the arithmetic of replacement that
   * was wrong, not the starting number.
   */
  const entry = workspace.compliance.find(
    (row) => row.itemId && row.kind === "PAT Test",
  );
  return entry
    ? { columnId: column.id, requestId: entry.itemId }
    : { reason: `no PAT Test row the register can see (${workspace.compliance.length} register rows)` };
}

/**
 * The register's own view of one board slot.
 *
 * Retried, and it throws rather than returning undefined when the payload
 * cannot be read at all. This suite shares a development server with other
 * work, and `/api/workspace` is the heaviest read in the product; a request
 * that loses its connection under load would otherwise surface as
 * `undefined !== 1` and read exactly like the defect being tested. A flaky
 * read must fail as a flaky read.
 */
async function workspaceOf() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = (await call("GET", "/api/workspace")).json?.workspace;
    if (workspace?.compliance) return workspace;
  }
  throw new Error("the workspace payload could not be read after three attempts");
}

async function registerFileCount(requestId) {
  const workspace = await workspaceOf();
  return workspace.compliance.find(
    (row) => row.itemId === requestId && row.kind === "PAT Test",
  );
}

async function upload({ requestId, columnId }, body, replaces) {
  const form = new FormData();
  form.set("file", new Blob([body], { type: "text/plain" }), `${body}.txt`);
  form.set("requestId", requestId);
  form.set("columnId", columnId);
  form.set("kind", "general");
  if (replaces) form.set("replaces", replaces);
  const response = await fetch(`${BASE}/api/files`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
  const json = await response.json().catch(() => null);
  return json?.file?.id ?? null;
}

test("W07-09 — a certificate replaced twice is ONE held document, and archiving it releases the slot", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const slot = await patCertificateSlot();
  if (slot.reason) return t.skip(slot.reason);

  /*
   * THE DEFECT THIS PINS. The register's file-count scan grouped rows off
   * `attachments` with no version or archive predicate, so it counted ROWS, and
   * a row stopped being a document the moment documents got versions:
   *
   *     upload → 1     replace → 2     replace → 3     archive the head → 3
   *
   * That number is not cosmetic. `complianceStateFor` decides a slot is HELD by
   * asking `fileCount > 0`, so a slot stayed "Compliant" on the strength of
   * superseded certificates — including ones superseded precisely BECAUSE they
   * had expired — and an archived certificate went on holding its slot open.
   * The predicate existed and was correct in two of the four readers of this
   * table; it was simply never applied here.
   */
  const created = [];
  try {
    const before = await registerFileCount(slot.requestId);
    const base = before?.fileCount ?? 0;

    const v1 = await upload(slot, "W7OFF-lineage-v1");
    assert.ok(v1, "the first version uploaded");
    created.push(v1);
    assert.equal(
      (await registerFileCount(slot.requestId))?.fileCount,
      base + 1,
      "one certificate on file is one document",
    );

    const v2 = await upload(slot, "W7OFF-lineage-v2", v1);
    assert.ok(v2, "the replacement uploaded");
    created.push(v2);
    assert.equal(
      (await registerFileCount(slot.requestId))?.fileCount,
      base + 1,
      "REPLACING a certificate does not give the store two of them",
    );

    await call("PATCH", `/api/files/${v2}`, { archived: true });
    const archived = await registerFileCount(slot.requestId);
    assert.equal(
      archived?.fileCount,
      base,
      "archiving the current version releases it — a superseded row is not a fallback",
    );
    /*
     * The STATE claim only holds when the file count is what decides the state.
     * For a dated slot like PAT, `complianceStateFor` asks the expiry date
     * first: a certificate whose recorded expiry is still in the future is
     * "Compliant" whether or not a file is attached, because the date is the
     * stronger evidence. The held/not-held fallback — and therefore the return
     * to "Missing" — is only reached when no date is on file at all.
     */
    if (base === 0 && !archived?.expiry) {
      assert.equal(
        archived?.state,
        "Missing",
        "an undated slot with nothing live held goes back to Missing rather than staying open on an archived document",
      );
    }

    await call("PATCH", `/api/files/${v2}`, { archived: false });
    assert.equal(
      (await registerFileCount(slot.requestId))?.fileCount,
      base + 1,
      "and restoring it holds the slot again",
    );
  } finally {
    for (const id of created.reverse()) await call("DELETE", `/api/files/${id}`);
  }
});

test("W07-09 — the register's file count uses the SHARED liveness predicate, not a copy", async () => {
  /*
   * Four readers count this table and they must agree. Two were correct
   * (`reconcileAttachmentCounts` and `GET /api/files`) and two were not, and the
   * reason the two diverged is that the condition was written out by hand where
   * it was needed instead of being imported. A third hand-written
   * `is_current AND archived_at IS NULL` is how it happens again, so what is
   * pinned here is the IMPORT, not the behaviour — behaviour is pinned by the
   * test above.
   */
  const lib = await read("app/lib/compliance-register.ts");
  assert.match(
    lib,
    /import \{ liveAttachmentRows \} from "\.\/attachment-counts"/,
    "the predicate is imported from the module that owns it",
  );
  const at = lib.indexOf("columnId: attachments.boardColumnId");
  assert.ok(at > 0, "the file-count scan is findable");
  const query = lib.slice(at, lib.indexOf(".groupBy(", at));
  assert.match(query, /liveAttachmentRows\(\)/, "and the scan applies it");
  assert.ok(
    !/isNull\(attachments\.archivedAt\)/.test(query),
    "and does NOT re-type the condition beside it",
  );
});
