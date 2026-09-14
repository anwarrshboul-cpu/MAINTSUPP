/**
 * THE MAINTENANCE REPORT COUNTS MAINTENANCE JOBS — AND NO INVOICE TOTAL MOVES.
 *
 * Approved decision: Store Documentation register rows, and rows on a section's
 * own board, are not maintenance jobs. The generated report's job population
 * (`liveWorkOrder` in app/lib/reporting/engine.ts) now carries the same
 * `jobsBoardCondition()` every dashboard and the Jobs board use.
 *
 * It had been held back because the population "feeds generated invoices". It
 * does not reach a payable figure: `computeInvoiceSection` is priced from site
 * fees and is never handed a job. This file pins that separation three ways —
 * by source, by calling the invoice builder with a fixed-fee fixture, and
 * against the running estate — so a future change that DID route jobs into an
 * invoice total would fail here rather than bill somebody differently.
 *
 * Measured when the change was made (dev estate, 1–11 Sep 2026, a temporary
 * £250 default site fee): invoice total £28,250.00 before AND after; job log
 * 64 → 45, the 19 removed being Store Documentation and section-board rows.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── By source ────────────────────────────────────────────────────────────── */

test("the report's job population is the Jobs board's", async () => {
  const engine = codeOnly(await read("app/lib/reporting/engine.ts"));
  assert.match(engine, /import \{ jobsBoardCondition \} from "\.\.\/dashboard-filters";/);
  const predicate = engine.slice(engine.indexOf("function liveWorkOrder"), engine.indexOf("const LIVE_INVOICE_STATUSES"));
  for (const clause of [
    /eq\(maintenanceRequests\.organisationId, organisationId\)/,
    /isNull\(maintenanceRequests\.deletedAt\)/,
    /eq\(maintenanceRequests\.archived, false\)/,
    /isNull\(maintenanceRequests\.parentId\)/,
    /jobsBoardCondition\(\)/,
  ]) {
    assert.match(predicate, clause);
  }
  /* Both periods — current and comparison — come through the one predicate. */
  assert.match(engine, /liveWorkOrder\(organisationId\),/);
});

test("an invoice is priced without a single job", async () => {
  const engine = codeOnly(await read("app/lib/reporting/engine.ts"));
  const start = engine.indexOf("computeInvoiceSection({");
  assert.ok(start > 0);
  /* The argument object, up to the header block that closes it. */
  const call = engine.slice(start, engine.indexOf("const dataQuality", start));
  for (const jobInput of [/\bjobs\b/, /previousJobs/, /jobRows/, /\bquotes\b/, /holds/]) {
    assert.doesNotMatch(call, jobInput, `the invoice builder is not handed ${jobInput}`);
  }
  const compute = codeOnly(await read("app/lib/reporting/invoice-compute.ts"));
  const input = compute.slice(compute.indexOf("export type InvoiceComputeInput"), compute.indexOf("export function computeInvoiceSection"));
  assert.doesNotMatch(input, /\bjobs?\b|ReportJob/, "and its input type has no job in it at all");
});

/* ── By calling the invoice builder ───────────────────────────────────────── */

const { computeInvoiceSection } = await import("../app/lib/reporting/invoice-compute.ts");

const MARCH = { start: "2026-03-01", end: "2026-03-31", label: "March 2026", partialMonth: false };
const site = (id) => ({
  id,
  name: `Site ${id}`,
  reference: id.toUpperCase(),
  status: "active",
  active: true,
  billable: true,
  billingActiveFrom: null,
  billingActiveTo: null,
});
const invoiceFor = (sites) =>
  computeInvoiceSection({
    period: MARCH,
    clientName: "Fixed-fee client",
    config: {
      currency: "GBP",
      defaultSiteFeePence: 25_000,
      vatEnabled: true,
      vatRateBasisPoints: 2000,
      vatNumber: "GB123456789",
      paymentTermsDays: 30,
      paymentTermsNote: null,
      billingAddress: "1 Example Street",
      invoiceNumberPrefix: "MS",
      proRataEnabled: false,
    },
    sites,
    clientFees: [],
    siteOverrides: [],
    existingCharges: [],
    decisions: [],
    adjustments: [],
    header: {
      invoiceId: null,
      invoiceNumber: null,
      status: "Draft",
      invoiceDate: "2026-04-01",
      dueAt: "2026-05-01",
      billingAddress: "1 Example Street",
      clientReference: null,
      purchaseOrder: null,
      internalReference: null,
      paymentTerms: "30 days",
      clientNote: null,
      internalNote: null,
    },
  });

test("a fixed-fee invoice is the site fees and VAT — the same whatever the job log holds", () => {
  const invoice = invoiceFor([site("a"), site("b"), site("c")]);
  assert.equal(invoice.totals.includedSites, 3);
  assert.equal(invoice.totals.subtotalPence, 75_000, "three sites at £250");
  assert.equal(invoice.totals.vatPence, 15_000, "20% VAT per line");
  assert.equal(invoice.totals.totalPence, 90_000);
  /* The same call is the only thing an invoice is built from; with no job input
     there is no job population that could produce a different total. */
  assert.deepEqual(invoiceFor([site("a"), site("b"), site("c")]).totals, invoice.totals);
});

/* ── Against the running estate ───────────────────────────────────────────── */

const BASE = "http://localhost:5173";

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Live rows placed on a board that is not the Jobs board, from the dev database. */
async function rowsOffTheJobsBoard() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT mr.id, mr.reference, substr(mr.requested_at, 1, 10) AS raised
           FROM maintenance_requests mr
           JOIN maintenance_group_items gi ON gi.request_id = mr.id AND gi.organisation_id = mr.organisation_id
          WHERE gi.board_id <> 'maintenance' AND mr.deleted_at IS NULL AND mr.parent_id IS NULL
            AND coalesce(mr.archived, 0) = 0 AND mr.organisation_id = 'org_000000000000000000000001'
          ORDER BY mr.requested_at DESC LIMIT 200`,
      )
      .all();
  } finally {
    db.close();
  }
}

test("LIVE a register or section row never reaches the maintenance report's job log", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const offBoard = await rowsOffTheJobsBoard();
  if (!offBoard || offBoard.length === 0) {
    t.skip("no Store Documentation or section rows on this estate to prove the exclusion with");
    return;
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!login.ok) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const days = offBoard.map((row) => row.raised).filter(Boolean).sort();
  const response = await fetch(`${BASE}/api/reports/preview`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ start: days[0], end: days[days.length - 1] }),
  });
  assert.equal(response.status, 200);
  const { payload } = await response.json();
  const logged = JSON.stringify(payload.maintenance.jobLog);
  for (const row of offBoard) {
    assert.ok(!logged.includes(`"${row.id}"`), `${row.id} is not a maintenance job`);
  }
  /* The invoice is its lines: included site subtotals, VAT, adjustments, credits. */
  const totals = payload.invoice.totals;
  const lineSubtotal = payload.invoice.lines
    .filter((line) => line.included)
    .reduce((sum, line) => sum + (line.lineSubtotalPence ?? line.subtotalPence ?? 0), 0);
  assert.equal(totals.subtotalPence, lineSubtotal, "the subtotal is the site lines, nothing else");
  assert.equal(totals.totalPence, totals.subtotalPence + totals.vatPence + totals.adjustmentPence - totals.creditPence);
});
