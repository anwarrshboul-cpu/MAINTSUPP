/**
 * Two Invoice Tracker faults found in QA on 2026-10-01, in a workspace whose
 * invoices had been approved and paid through the product's own routes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("an invoice with a payment opens: the panel reads allocations, not flat payments", async () => {
  const records = await read("app/(app)/portal/finance/finance-records.ts");
  assert.match(records, /payments: InvoicePaymentAllocation\[\];/);
  const panel = await read("app/(app)/portal/finance/finance-invoice-panel.tsx");
  assert.match(panel, /payments\.map\(\(\{ allocationId, allocatedPence, payment \}\) =>/);
  assert.match(panel, /<Money pence=\{allocatedPence\} \/>/);
  const repo = await read("app/lib/finance/repository.ts");
  assert.match(repo, /allocationId: paymentAllocations\.id,\s*allocatedPence: paymentAllocations\.amountPence,\s*payment: payments,/);
});

test("overdue means past its date AND still owed", async () => {
  const repo = await read("app/lib/finance/repository.ts");
  assert.match(repo, /if \(filters\.overdueOnly\) clauses\.push\(overdueInvoiceSql\(today\), outstandingInvoiceSql\(\)\);/);
  const balance = await read("app/lib/finance/balance.ts");
  assert.match(balance, /export function outstandingInvoiceSql\(\): SQL/);
  assert.match(balance, /coalesce\(\$\{invoices\.grossPence\}, \$\{invoices\.netPence\}, 0\)/, "gross, falling back to net, as invoiceBalance does");
  const ledger = await read("app/(app)/portal/finance/finance-ledger.tsx");
  assert.match(ledger, /\(balance\.balancePence \?\? 0\) > 0 \? <AgeBadge/);
});

test("the ledger and the invoice panel name the site", async () => {
  const route = await read("app/api/finance/invoices/route.ts");
  assert.match(route, /siteName: row\.siteId \? siteNames\.get\(row\.siteId\) \?\? null : null/);
  const ledger = await read("app/(app)/portal/finance/finance-ledger.tsx");
  assert.match(ledger, /\{row\.siteName \?\? row\.siteId\}/);
  const panel = await read("app/(app)/portal/finance/finance-invoice-panel.tsx");
  assert.match(panel, /\["Site", invoice\.siteName \?\? invoice\.siteId\]/);
});

/* Owner decision 2026-10-01: a payable is paid only once approved, and a
   payment moves the invoice to part_paid / paid (both keys existed in the
   ladder and nothing wrote them). Verified live: refused while under review;
   approved, half paid -> part_paid, rest paid -> paid. */
test("a payment needs an approved payable and moves the status to part paid or paid", async () => {
  const repo = await read("app/lib/finance/repository.ts");
  assert.match(repo, /const PAYABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set\(\["approved", "scheduled", "part_paid"\]\);/);
  assert.match(repo, /Approve it before recording a payment against it\./);
  assert.match(repo, /const next = balance\.balancePence <= 0 \? "paid" : "part_paid";/);
  assert.match(repo, /await recordStatusChange\(db, organisationId, \{\s*invoiceId: row\.invoiceId,/);
});
