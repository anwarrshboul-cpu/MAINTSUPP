/**
 * Invoices and quotations: money is integer pence end to end, and the legacy
 * `amount` REAL is neither read nor sent anywhere (owner decision, 2026-09-22).
 *
 * Measured first (the owner's precondition): Production and Staging both hold
 * ZERO invoices and ZERO quotations, so nothing needed converting in place, and
 * no migration is made. Since Module 5 the money has lived in `net_pence` /
 * `vat_pence` / `gross_pence`; `amount` is a NOT NULL float that both inserts
 * write as zero. Two things still used it:
 *   · the maintenance report's approved-quote figure read it, so a quote raised
 *     through the finance module would have reported as £0.00;
 *   · every finance read spread the whole row into its API response, so each
 *     invoice and quote went out with `amount: 0` beside its real price.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const quotes = await import("../app/lib/reporting/approved-quotes.ts");

const row = (requestId, approvedAt, netPence, grossPence) => ({ requestId, approvedAt, netPence, grossPence });

test("an approved quote reports its net pence, gross only when no net was recorded", () => {
  const map = quotes.approvedQuotePenceByJob([
    row("j1", "2026-09-01T10:00:00Z", 100_000, 120_000),
    row("j2", "2026-09-01T10:00:00Z", null, 60_000),
  ]);
  assert.equal(map.get("j1"), 100_000, "net, the finance module's own comparison basis");
  assert.equal(map.get("j2"), 60_000, "gross when that is all there is");
});

test("the latest APPROVED quote on a job wins; one awaiting approval is not a commitment", () => {
  const map = quotes.approvedQuotePenceByJob([
    row("j1", "2026-09-01T10:00:00Z", 50_000, 60_000),
    row("j1", "2026-09-10T10:00:00Z", 70_000, 84_000),
    row("j1", null, 999_999, 999_999),
    row("j2", null, 10_000, 12_000),
  ]);
  assert.equal(map.get("j1"), 70_000);
  assert.equal(map.has("j2"), false, "never approved: no committed figure");
});

test("a latest approved quote with no figure is no figure: not an older quote's, not zero", () => {
  const map = quotes.approvedQuotePenceByJob([
    row("j1", "2026-09-01T10:00:00Z", 50_000, 60_000),
    row("j1", "2026-09-10T10:00:00Z", null, null),
  ]);
  assert.equal(map.has("j1"), false);
  assert.equal(quotes.approvedQuotePenceByJob([]).size, 0);
});

test("the report reads the quote's pence, never the legacy float", async () => {
  const engine = code(await read("app/lib/reporting/engine.ts"));
  const loader = engine.slice(engine.indexOf("async function loadApprovedQuotes"), engine.indexOf("async function loadExistingCharges"));
  assert.match(loader, /netPence: quotations\.netPence/);
  assert.match(loader, /grossPence: quotations\.grossPence/);
  assert.doesNotMatch(loader, /quotations\.amount/);
  assert.match(loader, /return approvedQuotePenceByJob\(rows\);/);
  const rule = code(await read("app/lib/reporting/approved-quotes.ts"));
  assert.match(rule, /import \{ comparableAmount \} from "\.\.\/finance\/rules";/, "the ledger's own comparison rule, not a copy");
});

test("no code anywhere reads invoices.amount or quotations.amount", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
    }
  }
  await walk("app");
  await walk("worker");
  const readers = [];
  for (const file of files) {
    if (/\b(invoices|quotations)\.amount\b/.test(code(await read(file)))) readers.push(file);
  }
  assert.deepEqual(readers, [], "the legacy float is not money any more");
});

test("finance reads leave the legacy float out, and the inserts write it as zero", async () => {
  const repository = code(await read("app/lib/finance/repository.ts"));
  assert.match(repository, /const INVOICE_COLUMNS = withoutLegacyAmount\(getTableColumns\(invoices\)\);/);
  assert.match(repository, /const QUOTE_COLUMNS = withoutLegacyAmount\(getTableColumns\(quotations\)\);/);
  assert.match(repository, /export type InvoiceRow = Omit<typeof invoices\.\$inferSelect, "amount">;/);
  assert.match(repository, /export type QuoteRow = Omit<typeof quotations\.\$inferSelect, "amount">;/);
  assert.doesNotMatch(repository, /\.select\(\)\s*\.from\((invoices|quotations)\)/, "every invoice and quote read names its columns");
  assert.equal((repository.match(/\.select\(INVOICE_COLUMNS\)/g) ?? []).length, 2, "listInvoices and readInvoice");
  assert.equal((repository.match(/\.select\(QUOTE_COLUMNS\)/g) ?? []).length, 2, "listQuotes and readQuote");
  assert.equal((repository.match(/^\s*amount: 0,$/gm) ?? []).length, 2, "both inserts still satisfy NOT NULL with zero, never money");
});
