/**
 * Workstream 9 — the document workflow, and the boundaries that hold it.
 *
 * Two kinds of check, and the split is deliberate.
 *
 * 1. LIVE. A complete draft lifecycle against the running dev server: create,
 *    recalculate, exclude a site with a reason, adjust, credit, and delete.
 *    Every one of those is reversible, and the test removes the document it
 *    created before it finishes. It stops short of APPROVING or FINALISING on
 *    purpose: finalising issues a real invoice number from the organisation's
 *    counter and writes an immutable snapshot, and a test that leaves those
 *    behind in a shared workspace is a test that manufactures records somebody
 *    will one day mistake for a client's.
 *
 *    That path was verified by hand against this server before this file was
 *    written, and the numbers are recorded here so the claim is checkable
 *    rather than asserted: thirteen active sites at £120 with VAT at 20% gave
 *    £1,560 + £312 = £1,872; excluding one site and adding a £50 adjustment and
 *    a £20 credit gave £1,758.00; finalising issued MS-00001; the organisation
 *    default fee was then more than doubled to £250 and the finalised document
 *    still read £1,758.00 with a £120 line fee, served `fromSnapshot: true`;
 *    every mutation against it answered 409. Those rows were then removed by
 *    exact id and the settings restored.
 *
 * 2. SOURCE. The invariants a live call cannot demonstrate cheaply — that the
 *    exporters cannot reach a database, that a finalised document is never
 *    recomputed, that this engine's idea of a live work order is the same three
 *    clauses the workspace route uses. These are read, because that is what a
 *    reviewer would do, and because the failure they guard against is a future
 *    edit rather than a wrong answer today.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Source with its comments removed.
 *
 * These files explain themselves at length, and several of the assertions below
 * are looking for the ABSENCE of a construct. A comment naming the construct in
 * order to say why it must not be used would fail such an assertion, which is
 * the one way a test can punish a file for being well documented.
 */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ─────────────────────────────────── the layering that makes totals match ─ */

test("nothing that computes a number can reach the database", async () => {
  /*
   * The contract's own header: "the engine computes ONCE … No renderer is
   * permitted a database handle." That is only true while the pure modules
   * stay pure. `engine.ts`, `documents.ts` and `route-helpers.ts` are the
   * three that are allowed a handle, and they are named here so that adding a
   * fourth is a deliberate edit to this list.
   */
  const allowed = new Set(["engine.ts", "documents.ts", "route-helpers.ts"]);
  const files = await readdir(path.join(root, "app/lib/reporting"));
  const pure = files.filter((file) => file.endsWith(".ts") && !allowed.has(file));
  assert.ok(pure.length >= 9, "the pure modules are the bulk of the engine");
  for (const file of pure) {
    const source = await read(`app/lib/reporting/${file}`);
    for (const forbidden of ["db/schema", "db/init", "tenant-db", "drizzle-orm", "getDb"]) {
      assert.ok(
        !new RegExp(`^import[^;]*${forbidden.replace("/", "\\/")}`, "m").test(source),
        `${file} imports ${forbidden}; a module that decides a number must not be able to ask a second question`,
      );
    }
  }
});

test("the contract computes nothing and imports nothing", async () => {
  const source = await read("app/lib/reporting/contract.ts");
  assert.ok(!/^import\s/m.test(source), "types only — that is the whole point of it existing");
});

test("a finalised document is served from its snapshot and never recomputed", async () => {
  const source = await read("app/lib/reporting/documents.ts");
  assert.match(
    source,
    /if \(status === "Finalised" \|\| status === "Voided"\) \{\s*const snapshot = await readSnapshot/,
    "documentPayload must branch on the status BEFORE it recomputes",
  );
  // And an unreadable snapshot is an error rather than a licence to recompute:
  // falling back would present today's numbers as the ones that were approved.
  assert.match(source, /must not be recomputed/);
  assert.ok(
    !/catch[\s\S]{0,200}computeReport/.test(source),
    "there must be no path from a snapshot failure to a recomputation",
  );
});

test("finalisation issues the number, freezes the payload, then moves the status", async () => {
  const source = await read("app/lib/reporting/documents.ts");
  const finalise = source.slice(source.indexOf("export async function finaliseDocument"));
  const numberAt = finalise.indexOf("issueInvoiceNumber(");
  const snapshotAt = finalise.indexOf("insert(reportSnapshots)");
  const statusAt = finalise.indexOf("update(serviceInvoices)");
  assert.ok(numberAt > 0, "an invoice number is issued");
  assert.ok(snapshotAt > numberAt, "the number is issued before the snapshot is written");
  assert.ok(statusAt > snapshotAt, "the status moves last, so a failure leaves nothing half-finalised");
});

test("the invoice number is advanced by compare-and-swap, not read-modify-write", async () => {
  const source = await read("app/lib/billing/settings.ts");
  assert.match(
    source,
    /eq\(billingSettings\.invoiceSequence, current\)/,
    "the update must match on the sequence that was read, or two documents can take one number",
  );
  assert.match(source, /\.returning\(/, "and the caller has to be able to tell whether it won");
});

test("this engine's live work order is the same three clauses as the workspace route", async () => {
  /*
   * `liveWorkOrder` is declared twice — once in `app/api/workspace/route.ts`,
   * where it is a private const inside a route module, and once here. The
   * duplication is deliberate (a library importing a route inverts the
   * dependency and drags the whole workspace handler into this bundle), so the
   * two are pinned together instead. A job that is archived, binned or a
   * subitem is not work, on either surface.
   */
  const engine = await read("app/lib/reporting/engine.ts");
  const workspace = await read("app/api/workspace/route.ts");
  for (const clause of [
    /isNull\(maintenanceRequests\.deletedAt\)/,
    /eq\(maintenanceRequests\.archived, false\)/,
    /isNull\(maintenanceRequests\.parentId\)/,
  ]) {
    assert.match(engine, clause, "engine.ts");
    assert.match(workspace, clause, "app/api/workspace/route.ts");
  }
});

test("the period filter is coarse in SQL and exact in JavaScript", async () => {
  /*
   * `requested_at` is TEXT in two shapes on SQLite and a `timestamptz` on
   * Postgres. A comparison that is right in one dialect is wrong in the other,
   * so SQL narrows with a day of margin and `dateOnly` decides membership.
   */
  const source = await read("app/lib/reporting/engine.ts");
  assert.match(source, /gte\(maintenanceRequests\.requestedAt, addDays\(period\.start, -1\)\)/);
  assert.match(source, /lt\(maintenanceRequests\.requestedAt, addDays\(period\.end, 2\)\)/);
  assert.match(source, /rows\.filter\(\(row\) => \{[\s\S]*dateOnly\(row\.requestedAt\)/);
  assert.ok(
    !/substr\(/.test(codeOnly(source)),
    "substr() on a timestamptz is a runtime error in Postgres",
  );
});

test("the routes gate on capabilities, and never on a role literal", async () => {
  const files = [
    "app/api/reports/settings/route.ts",
    "app/api/reports/fees/route.ts",
    "app/api/reports/sla-rules/route.ts",
    "app/api/reports/holds/route.ts",
    "app/api/reports/preview/route.ts",
    "app/api/reports/documents/route.ts",
    "app/api/reports/documents/[id]/route.ts",
    "app/api/reports/documents/[id]/lines/route.ts",
    "app/api/reports/documents/[id]/adjustments/route.ts",
    "app/api/reports/documents/[id]/actions/route.ts",
  ];
  for (const file of files) {
    const source = await read(file);
    assert.match(source, /REPORT_CAPABILITIES\[/, `${file} must resolve its capability from the table`);
    for (const literal of ['role === "admin"', 'role === "super_admin"', 'role === "client"']) {
      assert.ok(!source.includes(literal), `${file} compares a role literal instead of a capability`);
    }
  }
});

test("no route sends anything anywhere — store and download only", async () => {
  const dir = path.join(root, "app/api/reports");
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(next)));
      else if (entry.name.endsWith(".ts")) found.push(next);
    }
    return found;
  };
  for (const file of await walk(dir)) {
    const source = await readFile(file, "utf8");
    for (const forbidden of ["sendNotification", "notificationTargets", "nodemailer", "resend"]) {
      assert.ok(
        !source.includes(forbidden),
        `${path.relative(root, file)} references ${forbidden}; the owner asked for no automatic email, sharing or reminders`,
      );
    }
  }
});

/* ────────────────────────────────────────────────── the live draft lifecycle ─ */

const BASE_URL = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";

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

const call = async (path, init = {}) => {
  const response = await fetch(`${BASE_URL}/api/reports${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: init.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

test("LIVE a draft can be created, recalculated, adjusted and removed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const preview = await call("/preview", {
    method: "POST",
    body: JSON.stringify({ preset: "last-month" }),
  });
  assert.equal(preview.status, 200);
  const payload = preview.body.payload;

  /* The payload is the contract, verbatim. If a field named here disappears,
     an exporter that renders it breaks — and this is where that is noticed. */
  assert.equal(payload.schemaVersion, 1);
  for (const key of ["generatedAt", "organisationId", "organisationName", "period", "invoice", "maintenance"]) {
    assert.ok(key in payload, `the payload must carry ${key}`);
  }
  for (const key of ["lines", "adjustments", "totals", "servicePeriod", "currency", "status"]) {
    assert.ok(key in payload.invoice, `the invoice section must carry ${key}`);
  }
  for (const key of ["kpis", "executive", "siteSummary", "siteSummaryTotals", "spend", "sla", "holds", "openPastTarget", "criticalOpen", "specialProjects", "jobLog", "dataQuality", "slaRules"]) {
    assert.ok(key in payload.maintenance, `the maintenance section must carry ${key}`);
  }
  assert.equal(payload.maintenance.jobLog.length, 7, "seven groups, always, even when empty");
  assert.ok(Array.isArray(payload.maintenance.executive.narrative));

  /* The invariant the whole design exists for: the lines sum to the totals. */
  const included = payload.invoice.lines.filter((line) => line.included);
  assert.equal(
    payload.invoice.totals.subtotalPence,
    included.reduce((sum, line) => sum + line.lineSubtotalPence, 0),
  );
  assert.equal(
    payload.invoice.totals.vatPence,
    included.reduce((sum, line) => sum + line.lineVatPence, 0),
  );
  assert.equal(payload.invoice.totals.includedSites, included.length);

  let invoiceId = null;
  try {
    const created = await call("/documents", {
      method: "POST",
      body: JSON.stringify({
        preset: "last-month",
        internalNote: "w9-report-documents.test.mjs — deleted before this test finishes",
      }),
    });
    assert.equal(created.status, 201);
    invoiceId = created.body.invoiceId;
    assert.ok(invoiceId, "a draft must come back with its id so it can be cleaned up");

    const listed = await call("/documents");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.documents.some((row) => row.invoiceId === invoiceId));

    const recalculated = await call(`/documents/${invoiceId}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "recalculate" }),
    });
    assert.equal(recalculated.status, 200);
    assert.equal(recalculated.body.status, "Draft");

    /* Excluding a site needs a reason, and refusing without one is the check —
       an unexplained exclusion on an invoice is money nobody can account for. */
    const site = recalculated.body.payload.invoice.lines.find((line) => line.included);
    if (site) {
      const noReason = await call(`/documents/${invoiceId}/lines`, {
        method: "PATCH",
        body: JSON.stringify({ siteId: site.siteId, included: false }),
      });
      assert.equal(noReason.status, 400);

      const excluded = await call(`/documents/${invoiceId}/lines`, {
        method: "PATCH",
        body: JSON.stringify({
          siteId: site.siteId,
          included: false,
          reason: "w9 test — excluded and then restored",
        }),
      });
      assert.equal(excluded.status, 200);
      const line = excluded.body.payload.invoice.lines.find((entry) => entry.siteId === site.siteId);
      assert.equal(line.included, false);
      assert.ok(line.excludedByEmail, "the decision records who made it");
      assert.equal(
        excluded.body.payload.invoice.totals.subtotalPence,
        recalculated.body.payload.invoice.totals.subtotalPence - site.feePence,
        "the total moves by exactly the excluded fee",
      );
    }

    const adjustmentNoReason = await call(`/documents/${invoiceId}/adjustments`, {
      method: "POST",
      body: JSON.stringify({ kind: "adjustment", amountPence: 5000 }),
    });
    assert.equal(adjustmentNoReason.status, 400, "an adjustment without a reason is refused");

    const adjusted = await call(`/documents/${invoiceId}/adjustments`, {
      method: "POST",
      body: JSON.stringify({ kind: "credit", amountPence: 2000, reason: "w9 test" }),
    });
    assert.equal(adjusted.status, 201);
    assert.equal(adjusted.body.payload.invoice.totals.creditPence, 2000);

    const read = await call(`/documents/${invoiceId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.fromSnapshot, false, "a draft is recomputed, not frozen");
    assert.ok(
      read.body.blockers.some((blocker) => blocker.code === "status.not_approved"),
      "an unapproved document cannot be finalised, and says so",
    );
    assert.ok(Array.isArray(read.body.history) && read.body.history.length > 0, "every transition is recorded");
  } finally {
    if (invoiceId) {
      const deleted = await call(`/documents/${invoiceId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200, "the test must not leave a document behind");
      const gone = await call(`/documents/${invoiceId}`);
      assert.equal(gone.status, 404);
    }
  }
});

test("LIVE the SLA rules start empty and the response says what that means", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const { status, body } = await call("/sla-rules");
  assert.equal(status, 200);
  assert.equal(body.seeded, false, "a seeded target is indistinguishable from an agreed one");
  if (body.rules.length === 0) {
    assert.match(body.note, /No SLA rules are configured/);
  }
});
