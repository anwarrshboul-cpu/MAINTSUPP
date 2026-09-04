/**
 * Workstream 9 — the Generated Documents register, and the write path that
 * fills it.
 *
 * ── WHY THIS FILE EXISTS ALONGSIDE `w9-report-documents.test.mjs` ──────────
 *
 * That file proves the document WORKFLOW: create, recalculate, exclude, adjust,
 * delete. This one proves the REGISTER — what the Generated Documents table can
 * show and what it must never show — and the four defects found while working
 * out whether an empty table was the truth or a fault:
 *
 *   1. the generator's period vocabulary was not the contract's, so seven of
 *      the eight presets and every hand-typed range silently produced a
 *      LAST-MONTH document;
 *   2. a stored document rebuilt its own period label by hand, so the register
 *      read "2026-08-01 to 2026-08-31" where the preview of the same period
 *      said "August 2026";
 *   3. `clientId` was accepted and ignored, so a screen naming one client could
 *      raise a document for another;
 *   4. the export route forwarded only the cookie, so a caller whose identity
 *      was not in a cookie became, in development, a super admin of every
 *      organisation — and downloaded another client's finalised invoice.
 *
 * ── WHAT IS LIVE AND WHAT IS READ ─────────────────────────────────────────
 *
 * Everything reversible is LIVE: a draft is created, listed, exported and then
 * deleted by its exact id in a `finally`. Nothing here approves or finalises,
 * for the reason the sibling file states — finalising issues a real invoice
 * number from the organisation's counter, and a test must not leave a record
 * somebody could one day mistake for a client's.
 *
 * The finalised-snapshot invariants are therefore READ rather than exercised.
 * They were verified by hand against this server on 2026-09-05 and the figures
 * are written down so the claim is checkable: seventeen active sites at £120
 * gave £2,040.00, finalising issued MS-00001, the organisation default fee was
 * then more than doubled to £250 and the finalised document still read
 * £2,040.00 with a £120 line fee and `fromSnapshot: true`; the PDF it exported
 * carried the same £2,040.00; recalculate, PATCH and DELETE all answered 409.
 * Those rows were removed by exact id afterwards.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const BASE_URL = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";

/**
 * The workspace that owns the fixtures, and one that must never see them.
 *
 * `IDENTITY_HEADER` is `app/lib/tenant-access.ts`'s non-production affordance,
 * repeated as a literal rather than imported: this file loads no app modules,
 * and the header's name is part of the contract it is testing.
 */
const IDENTITY_HEADER = "x-maintsupp-identity";
const OTHER_ORG_IDENTITY = "admin@demo-client-ltd.test.maintsupp.com";

/** Marks every row this file creates, in a field a human will read. */
const FIXTURE_NOTE = "w9-report-register.test.mjs — deleted before this test finishes";

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/reports/settings`, {
      signal: AbortSignal.timeout(8000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const call = async (route, init = {}) => {
  const response = await fetch(`${BASE_URL}/api/reports${route}`, {
    signal: AbortSignal.timeout(30000),
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

/** Create a draft, hand it to `run`, then delete it by its exact id. */
async function withDraft(payload, run) {
  const created = await call("/documents", {
    method: "POST",
    body: JSON.stringify({ internalNote: FIXTURE_NOTE, ...payload }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const invoiceId = created.body.invoiceId;
  assert.ok(invoiceId, "a draft must come back with its id so it can be cleaned up");
  try {
    return await run(invoiceId, created.body);
  } finally {
    const deleted = await call(`/documents/${invoiceId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, "the test must not leave a document behind");
    const gone = await call(`/documents/${invoiceId}`);
    assert.equal(gone.status, 404);
  }
}

/* ───────────────────────────────── the period the operator actually chose ─ */

test("every preset the generator can send maps onto a contract period", async () => {
  /*
   * The screen speaks `period-model.ts`'s tokens — `mtd`, `month-1`, `12m` —
   * because every other date control in the product does. The contract speaks
   * `this-month`, `last-month`, `last-12-months`. Only the word "today" is in
   * both, so without a translation table seven of the eight presets fell
   * through to the `"last-month"` default and the operator was never told.
   *
   * Pinned as source rather than exercised one token at a time so that ADDING a
   * ninth preset to the screen fails here, at the place the translation lives.
   */
  const screen = await read("app/(app)/portal/reports/generator-setup.tsx");
  const block = screen.slice(
    screen.indexOf("export const GENERATOR_PERIOD_PRESETS"),
    screen.indexOf("export interface GeneratorDraft"),
  );
  const tokens = [...block.matchAll(/value:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(tokens.length, 8, "the owner named eight reporting periods");

  const helpers = await read("app/lib/reporting/route-helpers.ts");
  const aliases = helpers.slice(
    helpers.indexOf("const PRESET_ALIASES"),
    helpers.indexOf("const RANGE_TOKEN"),
  );
  const contract = await read("app/lib/reporting/contract.ts");
  const presets = contract.slice(
    contract.indexOf("export const REPORT_PERIOD_PRESETS"),
    contract.indexOf("export type ReportPeriodPreset"),
  );

  for (const token of tokens) {
    /* An alias key is quoted only when it has to be (`"month-1"`, `"12m"`), so
       both spellings count. */
    const escaped = token.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    const known =
      new RegExp(`(^|[\\s{])"?${escaped}"?\\s*:`, "m").test(aliases) ||
      new RegExp(`^\\s*"${escaped}",`, "m").test(presets);
    assert.ok(
      known,
      `the generator offers "${token}" and periodFromPayload cannot place it; it would resolve to last month`,
    );
  }
});

test("the range may arrive under either name, and a token carries its own dates", async () => {
  const helpers = await read("app/lib/reporting/route-helpers.ts");
  const body = helpers.slice(helpers.indexOf("export function periodFromPayload"));
  assert.match(
    body,
    /firstIsoDate\(body\.start, body\.periodStart/,
    "the browser sends periodStart; PATCH /api/reports/documents/[id] already reads that name",
  );
  assert.match(
    body,
    /firstIsoDate\(body\.end, body\.periodEnd/,
    "and the same for the end of the range",
  );
  assert.match(
    helpers,
    /\^range:\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\\\.\\\.\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\$/,
    "rangeToken() in period-model.ts writes `range:from..to`; this is where it is read back",
  );
});

test("an unrecognised period is refused rather than quietly turned into last month", async () => {
  const helpers = await read("app/lib/reporting/route-helpers.ts");
  const body = helpers.slice(helpers.indexOf("export function periodFromPayload"));
  assert.match(
    body,
    /is not a reporting period/,
    "the function's own header promises it refuses rather than defaults; this is that refusal",
  );
});

test("LIVE each generator preset resolves to its own window, not to last month", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /*
   * Preview only: it writes nothing, so a dozen calls leave nothing behind.
   *
   * Each one computes the whole estate's billing position, which is expensive
   * enough that a busy dev server refuses some of them — see CLAUDE.md on
   * starvation. A refusal is skipped with a diagnostic rather than failed,
   * because it says nothing about the mapping; what is asserted is the shape of
   * the answers that DID arrive, and one of those is enough to catch the defect
   * this test exists for.
   */
  const windowOf = (body) => `${body.payload.period.start}..${body.payload.period.end}`;
  const answered = new Map();
  const ask = async (question) => {
    const { status, body } = await call("/preview", {
      method: "POST",
      body: JSON.stringify(question),
    });
    if (status !== 200) {
      t.diagnostic(`${JSON.stringify(question)} → ${status}; the engine refused, nothing to compare`);
      return null;
    }
    return body;
  };

  const lastMonth = await ask({ preset: "month-1" });
  if (!lastMonth) {
    t.skip("the engine refused the baseline period; nothing to compare against");
    return;
  }
  const lastMonthWindow = windowOf(lastMonth);

  for (const token of ["today", "week", "mtd", "quarter", "ytd", "12m"]) {
    const body = await ask({ preset: token });
    if (!body) continue;
    answered.set(token, windowOf(body));
    /* THE DEFECT, stated directly: every one of these fell through to the
       "last-month" default, so the operator's choice never reached the engine.
       None of these windows can legitimately equal one whole calendar month
       ending yesterday's month, so equality here is the bug and nothing else. */
    assert.notEqual(
      answered.get(token),
      lastMonthWindow,
      `"${token}" resolved to last month (${lastMonthWindow}) instead of its own window`,
    );
  }
  if (answered.size > 1) {
    assert.equal(
      new Set(answered.values()).size,
      answered.size,
      `each preset must name its own window: ${JSON.stringify([...answered])}`,
    );
  }

  /* And a hand-typed range means itself, sent either way the screen sends it. */
  let rangesChecked = 0;
  for (const question of [
    { preset: "range", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
    { preset: "range:2026-03-01..2026-03-31" },
    { start: "2026-03-01", end: "2026-03-31" },
  ]) {
    const body = await ask(question);
    if (!body) continue;
    rangesChecked += 1;
    assert.equal(body.payload.period.start, "2026-03-01", JSON.stringify(question));
    assert.equal(body.payload.period.end, "2026-03-31", JSON.stringify(question));
    assert.equal(body.payload.period.label, "March 2026", "a whole month is named, not spelled out");
  }
  assert.ok(rangesChecked > 0, "not one explicit range was answered; re-run against a quiet tree");

  const junk = await call("/preview", {
    method: "POST",
    body: JSON.stringify({ preset: "not-a-period" }),
  });
  assert.equal(junk.status, 400, "a period nobody defined must be refused, not defaulted");
});

/* ─────────────────────────────────────────── a preview is not a document ─ */

test("LIVE Generate Preview creates no document", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const before = await call("/documents");
  assert.equal(before.status, 200);

  const preview = await call("/preview", {
    method: "POST",
    body: JSON.stringify({ preset: "last-month" }),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.payload.invoice.invoiceId, null, "a preview has no document id");
  assert.equal(preview.body.payload.invoice.invoiceNumber, null, "and never an invoice number");

  const after = await call("/documents");
  assert.equal(after.status, 200);
  assert.deepEqual(
    after.body.documents.map((row) => row.invoiceId).sort(),
    before.body.documents.map((row) => row.invoiceId).sort(),
    "the register moved when nothing was saved",
  );
});

test("the preview route has no write in it at all", async () => {
  const source = await read("app/api/reports/preview/route.ts");
  for (const verb of ["createDraft", "persistComputed", "finaliseDocument", "moveStatus"]) {
    assert.ok(!source.includes(verb), `preview must not reach ${verb}`);
  }
});

/* ──────────────────────────────────────── a saved draft is a real record ─ */

test("LIVE Save Draft persists, lists and survives a re-read", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await withDraft(
    { preset: "range:2026-07-01..2026-07-31", clientReference: "w9-register-fixture" },
    async (invoiceId, created) => {
      assert.equal(created.payload.period.start, "2026-07-01");
      assert.equal(created.payload.period.end, "2026-07-31");

      const listed = await call("/documents");
      assert.equal(listed.status, 200);
      const row = listed.body.documents.find((entry) => entry.invoiceId === invoiceId);
      assert.ok(row, "the draft must appear in the register");

      /* Every column the Generated Documents table draws, from one read. A
         column the list cannot supply is a column that renders "—" forever. */
      for (const column of [
        "invoiceNumber",
        "clientName",
        "period",
        "invoiceDate",
        "dueAt",
        "activeSitesBilled",
        "invoiceTotalPence",
        "maintenanceSpendPence",
        "status",
        "createdByEmail",
        "createdAt",
        "approvedByEmail",
        "finalisedAt",
        "formats",
      ]) {
        assert.ok(column in row, `the register cannot fill the "${column}" column`);
      }
      assert.equal(row.status, "Draft");
      assert.ok(row.clientName, "the client is the organisation and is always named");
      assert.equal(row.period.start, "2026-07-01", "the register shows the period that was asked for");
      assert.equal(row.period.label, "July 2026", "a whole month is named, not spelled out");
      assert.equal(row.invoiceTotalPence, created.payload.invoice.totals.totalPence);
      assert.equal(row.activeSitesBilled, created.payload.invoice.totals.includedSites);

      /* A second, independent read: the row is stored, not remembered. */
      const again = await call(`/documents/${invoiceId}`);
      assert.equal(again.status, 200);
      assert.equal(again.body.fromSnapshot, false, "a draft is recomputed, not frozen");
      assert.equal(again.body.document.periodStart, "2026-07-01");
    },
  );
});

/* ───────────────────────────────── the formats column is not a constant ─ */

test("the register's formats come from invoice_exports", async () => {
  const source = await read("app/lib/reporting/documents.ts");
  const list = source.slice(source.indexOf("export async function listDocuments"));
  assert.match(
    list,
    /from\(invoiceExports\)/,
    "the formats a row advertises must be the exports that were actually produced",
  );
  assert.ok(
    !/EXPORT_FORMATS/.test(list),
    "advertising the three formats as a constant offers a download that was never made",
  );
});

test("LIVE a document advertises a format only once that file has been produced", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await withDraft({ preset: "last-month" }, async (invoiceId) => {
    const before = await call("/documents");
    const fresh = before.body.documents.find((row) => row.invoiceId === invoiceId);
    assert.deepEqual(fresh.formats, [], "nothing has been exported, so nothing is offered");

    const download = await fetch(
      `${BASE_URL}/api/reports/exports?documentId=${invoiceId}&format=xlsx`,
      { signal: AbortSignal.timeout(30000) },
    );
    assert.equal(download.status, 200);
    assert.ok((await download.arrayBuffer()).byteLength > 1000, "an empty file is not an export");

    const after = await call("/documents");
    const row = after.body.documents.find((entry) => entry.invoiceId === invoiceId);
    assert.deepEqual(row.formats, ["xlsx"], "the produced format, and only it");
  });
});

/* ─────────────────────────────────────────────────── one client, one row ─ */

test("LIVE another organisation cannot see, read or export the row", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const stranger = { headers: { [IDENTITY_HEADER]: OTHER_ORG_IDENTITY } };
  const reachable = await call("/documents", stranger);
  if (reachable.status !== 200) {
    t.skip(`the second organisation's identity is not resolvable here (${reachable.status})`);
    return;
  }

  await withDraft({ preset: "last-month" }, async (invoiceId) => {
    const listed = await call("/documents", stranger);
    assert.equal(listed.status, 200);
    assert.ok(
      !listed.body.documents.some((row) => row.invoiceId === invoiceId),
      "a document leaked into another organisation's register",
    );

    const read = await call(`/documents/${invoiceId}`, stranger);
    assert.equal(read.status, 404, "an id guessed by hand must not open another tenant's document");

    const exported = await fetch(
      `${BASE_URL}/api/reports/exports?documentId=${invoiceId}&format=pdf`,
      { headers: { [IDENTITY_HEADER]: OTHER_ORG_IDENTITY }, signal: AbortSignal.timeout(30000) },
    );
    assert.equal(
      exported.status,
      404,
      "the export route was handed another organisation's document as a file",
    );
  });
});

test("LIVE a document cannot be raised for a client this session is not billing", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const context = await fetch(`${BASE_URL}/api/context`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!context.ok) {
    t.skip("no context to name a second organisation from");
    return;
  }
  const body = await context.json();
  const current = body.context?.currentOrganisation?.id;
  const other = (body.context?.organisations ?? []).find((entry) => entry.id !== current);
  if (!current || !other) {
    t.skip("this workspace has only one organisation, so there is nothing to confuse it with");
    return;
  }

  const mismatched = await call("/preview", {
    method: "POST",
    body: JSON.stringify({ preset: "last-month", clientId: other.id }),
  });
  assert.equal(
    mismatched.status,
    409,
    "a preview headed with one client and filled with another's figures must be refused",
  );

  const saved = await call("/documents", {
    method: "POST",
    body: JSON.stringify({ preset: "last-month", clientId: other.id }),
  });
  assert.equal(saved.status, 409, "and a document raised under the wrong name never gets written");

  /* The scope's own client is fine, and is the only one that is. */
  const matched = await call("/preview", {
    method: "POST",
    body: JSON.stringify({ preset: "last-month", clientId: current }),
  });
  assert.equal(matched.status, 200);
});

test("the scope decides the organisation; clientId only ever narrows or refuses", async () => {
  const helpers = await read("app/lib/reporting/route-helpers.ts");
  const guard = helpers.slice(
    helpers.indexOf("export function clientMismatch"),
    helpers.indexOf("export async function visibleStatuses"),
  );
  assert.match(guard, /clientId === scope\.orgId/, "the only accepted client is the scope's own");
  assert.ok(
    !/orgId\s*=\s*clientId|organisationId:\s*clientId/.test(guard),
    "a clientId from the request must never select the organisation — that is scopedDb's job",
  );
  for (const route of ["app/api/reports/preview/route.ts", "app/api/reports/documents/route.ts"]) {
    const source = await read(route);
    assert.match(source, /clientMismatch\(body, scope\)/, `${route} must refuse a mismatched client`);
    assert.match(
      source,
      /scopedDbWithCapability|guard\(request/,
      `${route} must resolve its organisation through the scope`,
    );
  }
});

test("the export route forwards the caller's identity, not only their cookie", async () => {
  /*
   * The subrequest inherits the document endpoint's permission check, its
   * finals-only narrowing and its snapshot behaviour — but only if it arrives
   * as the same caller. Development lets an identity live in a header instead
   * of a cookie, and an anonymous request there resolves to a seeded super
   * admin of every organisation, so dropping the header did not make the
   * subrequest weaker-but-safe, it made it stronger.
   */
  const source = await read("app/api/reports/exports/route.ts");
  const forward = source.slice(
    source.indexOf("function forwardedHeaders"),
    source.indexOf("async function readDocumentPayload"),
  );
  assert.match(forward, /headers\.set\("cookie", cookie\)/);
  assert.match(forward, /headers\.set\(IDENTITY_HEADER, identity\)/, "the identity header too");
  assert.ok(
    !/new Headers\(request\.headers\)/.test(forward),
    "copying the whole header set carries content-length into a subrequest with a different body",
  );
});

/* ─────────────────────────────────────── a finalised document is a value ─ */

test("a finalised document is served from its snapshot, and the register agrees", async () => {
  const documents = await read("app/lib/reporting/documents.ts");

  const payload = documents.slice(
    documents.indexOf("export async function documentPayload"),
    documents.indexOf("export async function listDocuments"),
  );
  assert.match(
    payload,
    /status === "Finalised" \|\| status === "Voided"/,
    "the branch that makes a finalised invoice immutable",
  );
  assert.ok(
    payload.indexOf("readSnapshot") < payload.indexOf("computeReport"),
    "the snapshot is read before anything is recomputed",
  );

  /* The register reads the STORED totals — the columns finalisation froze — and
     never recomputes to fill a row. A list that recomputed would show a
     finalised invoice moving whenever a fee changed. */
  const list = documents.slice(
    documents.indexOf("export async function listDocuments"),
    documents.indexOf("/* --------------------------------------------------------------- writing -- */"),
  );
  assert.ok(list.length > 200, "the listDocuments slice is bounded by the writing banner");
  assert.ok(
    !/computeReport|documentPayload/.test(list),
    "listDocuments must read the stored columns, not recompute seventeen documents",
  );
  assert.match(list, /invoiceTotalPence: row\.totalPence/);
  assert.match(list, /maintenanceSpendPence: row\.maintenanceSpendPence/);
});

test("a stored document describes its period with the same rules that chose it", async () => {
  /*
   * `documentPeriod` used to rebuild the label as `${start} to ${end}` and test
   * for a whole month with its own `Date.UTC` arithmetic. The register then
   * read "2026-08-01 to 2026-08-31" for the very period whose preview said
   * "August 2026" — two answers to one question, from two copies of one rule.
   */
  const source = await read("app/lib/reporting/documents.ts");
  const body = source.slice(
    source.indexOf("export function documentPeriod"),
    source.indexOf("/* --------------------------------------------------------------- reading -- */"),
  );
  assert.match(body, /isWholeCalendarMonth\(start, end\)/, "period.ts owns the calendar rules");
  assert.match(body, /periodLabel\("custom", start, end\)/, "and period.ts owns the label");
  assert.ok(
    !/Date\.UTC/.test(body),
    "a second hand-rolled month test here is how the two answers diverged",
  );
});

test("approving answers with the status it just set", async () => {
  /*
   * The payload is computed before the move, and `finalisationBlockers` reads
   * `payload.invoice.status`. Returned unstamped, the answer to "approve" was
   * `status: "Approved"` beside "The document must be approved before it can be
   * finalised" — the screen telling the operator their approval did not happen.
   */
  const source = await read("app/api/reports/documents/[id]/actions/route.ts");
  const branch = source.slice(
    source.indexOf('if (action === "submit" || action === "approve")'),
    source.indexOf("/* finalise */"),
  );
  assert.match(branch, /const settled = \{ \.\.\.payload, invoice: \{ \.\.\.payload\.invoice, status: to \} \}/);
  assert.match(branch, /payload: settled/);
  assert.match(branch, /finalisationBlockers\(\{\s*payload: settled/);
  assert.ok(
    !/computeReport/.test(branch),
    "stamped, not recomputed: a second read of the estate could return a different document",
  );
});
