/**
 * §15.6 — THE ACCOUNTING EXPORT, AND EVERY CSV THIS MODULE WRITES.
 *
 * "A mapped CSV for Xero, QuickBooks or Sage from day one. An API integration
 * can come later, but the export must exist or your bookkeeper does everything
 * twice."
 *
 * THIS IS AN EXPORT AND NOT AN INTEGRATION, and the distinction is stated
 * rather than blurred: nothing in this file or in `/api/finance/exports`
 * authenticates against Xero, QuickBooks or Sage, posts to any of them, or
 * knows whether a row was ever imported. It writes a file a person downloads
 * and uploads. Any wording anywhere in this product that suggests otherwise is
 * wrong.
 *
 * ═══ THE FIELD MAPPING ═════════════════════════════════════════════════════
 *
 * Each mapping targets the package's own documented invoice-import template.
 * The template a given tenant is served can differ by package version and by
 * region, so the header row is emitted verbatim and named here so a bookkeeper
 * can diff it against the template their tenant downloads. What is NOT
 * negotiable is on the left: which of our columns feeds which of theirs.
 *
 * ── XERO ── "Sales Invoices" / "Bills" precoded CSV template ───────────────
 *
 *   *ContactName        counterparty_name
 *   *InvoiceNumber      invoice_number, falling back to internal_ref
 *   *InvoiceDate        invoice_date          (DD/MM/YYYY — Xero is UK-region)
 *   *DueDate            due_at
 *   *Description        notes, falling back to "<direction> invoice <ref>"
 *   *Quantity           always 1 — this export is one line per invoice, not
 *                       per job. A per-job split belongs in tracking, below.
 *   *UnitAmount         net_pence, as pounds
 *   *AccountCode        left EMPTY. A nominal code is a decision about a chart
 *                       of accounts this product does not hold, and a guessed
 *                       code posts real money to the wrong nominal.
 *   *TaxType            "Tax on Sales" / "Tax on Purchases" when VAT was
 *                       charged, "No VAT" when it was not.
 *   TaxAmount           vat_pence, as pounds
 *   Currency            currency
 *   Reference           internal_ref
 *   TrackingName1       "Site"
 *   TrackingOption1     the invoice's site name
 *
 * ── QUICKBOOKS ── QuickBooks Online invoice/bill import CSV ────────────────
 *
 *   InvoiceNo           invoice_number, falling back to internal_ref
 *   Customer            counterparty_name
 *   InvoiceDate         invoice_date          (DD/MM/YYYY)
 *   DueDate             due_at
 *   Terms               "Net <payment_terms_days>", or empty
 *   Location            the invoice's site name
 *   Memo                notes
 *   Item(Product/Service)  the §4 category, title-cased
 *   ItemDescription     notes, falling back to the category
 *   ItemQuantity        1
 *   ItemRate            net_pence, as pounds
 *   ItemAmount          net_pence, as pounds
 *   ItemTaxCode         "S" (standard) when VAT was charged, "Z" when not.
 *                       QuickBooks' own UK codes; a tenant on a different code
 *                       set edits the column, which is a find-and-replace.
 *   ItemTaxAmount       vat_pence, as pounds
 *
 * ── SAGE ── Sage 50 "Audit Trail Transactions" import ──────────────────────
 *
 *   Type                SI for a receivable, PI for a payable.
 *   Account Reference   counterparty_id, falling back to a name-derived code.
 *                       Sage caps this at 8 characters and it must already
 *                       exist in the customer or supplier ledger — this export
 *                       does not create one.
 *   Nominal A/C Ref     left EMPTY, for the reason Xero's AccountCode is.
 *   Department Code     empty
 *   Date                invoice_date          (DD/MM/YYYY)
 *   Reference           invoice_number, falling back to internal_ref
 *   Details             notes, falling back to a generated description
 *   Net Amount          net_pence, as pounds
 *   Tax Code            T1 when VAT was charged, T0 when it was not — Sage's
 *                       UK defaults, and the same caveat as QuickBooks'.
 *   Tax Amount          vat_pence, as pounds
 *   Exchange Rate       1.00
 *   Extra Reference     internal_ref
 *   User Name           empty
 *   Project Refn        the job reference where the invoice names one job
 *   Cost Code Refn      empty
 *
 * ═══ CSV INJECTION ═════════════════════════════════════════════════════════
 *
 * A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is executed
 * as a formula by Excel, LibreOffice and Google Sheets. `=HYPERLINK(…)` and
 * `=cmd|…` are the two that matter: one exfiltrates the row a bookkeeper is
 * looking at, the other has historically executed a command. Every cell this
 * module writes goes through `csvCell`, which prefixes the dangerous ones with
 * an apostrophe — the literal-text marker every spreadsheet honours.
 *
 * WITH ONE EXCEPTION, AND IT IS DELIBERATE: a cell that is a plain number is
 * left alone, so `-1234.56` stays the number minus twelve hundred pounds rather
 * than becoming the text `'-1234.56`. A leading minus on a number is not a
 * formula — no spreadsheet evaluates it as one — and neutralising it would
 * break every credit note in an accounting import while protecting nobody.
 * `-1+1` is not a plain number and is neutralised. The test pins both halves.
 *
 * This file imports nothing but `./model`; see the header of `./ageing.ts`.
 */

import { dayOf, financeCategoryKey, type InvoiceDirection } from "./model";

/* ── The writer ───────────────────────────────────────────────────────────── */

/** Exactly a number: optional sign, digits, optional single decimal part. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** The characters a spreadsheet treats as the start of a formula. */
const FORMULA_STARTERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * One cell, neutralised and quoted.
 *
 * ALWAYS QUOTED, not only when it contains a comma. An unquoted apostrophe at
 * the head of a field is stripped by some readers and kept by others, and a
 * defence that half the world removes is not a defence. Quoting every field
 * also makes the output byte-identical whatever the data, which is what lets a
 * test pin a header row.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const neutralised = neutraliseCsvCell(raw);
  return `"${neutralised.replaceAll('"', '""')}"`;
}

/** The neutralisation on its own, so a test can assert it without the quotes. */
export function neutraliseCsvCell(raw: string): string {
  if (!raw) return raw;
  if (PLAIN_NUMBER.test(raw)) return raw;
  return FORMULA_STARTERS.includes(raw[0]) ? `'${raw}` : raw;
}

/**
 * A CSV document. CRLF and a BOM, because the audience is Excel.
 *
 * The BOM is what stops an accented supplier name arriving as mojibake, and
 * CRLF is what RFC 4180 asks for and what every accounting package's importer
 * was tested against. Both match `app/lib/csv.ts`, which this file deliberately
 * does not call: that writer quotes conditionally and does no formula
 * neutralisation at all, and adding either to it would change the bytes of the
 * site register and the board export, which are not this agent's to move.
 */
export function csvDocument(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function csvDownload(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename(filename)}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** A filename that cannot break out of the header it is written into. */
export function safeFilename(value: string): string {
  return (value || "export.csv").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

/* ── Money and dates, as an accounting package reads them ─────────────────── */

/**
 * Integer pence as `1234.56`, with no float anywhere in the conversion.
 *
 * `pence / 100` is a float and `(1999 / 100).toFixed(2)` happens to be right,
 * but the same expression on a nine-figure sum is not guaranteed to be. Integer
 * division and a remainder always are.
 */
export function poundsText(pence: number): string {
  const value = Math.trunc(pence || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` as `DD/MM/YYYY`. Every one of the three packages is UK-region here. */
export function ukDate(value: string | null | undefined): string {
  const day = dayOf(value ?? null);
  if (!day) return "";
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/* ── The three mappings ───────────────────────────────────────────────────── */

export const EXPORT_FORMATS = ["xero", "quickbooks", "sage"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** One invoice, as an accounting export needs it. */
export interface ExportInvoice {
  direction: InvoiceDirection;
  internalRef: string | null;
  invoiceNumber: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  invoiceDate: string | null;
  dueAt: string | null;
  paymentTermsDays: number | null;
  netPence: number | null;
  vatPence: number | null;
  grossPence: number | null;
  currency: string | null;
  category: string | null;
  notes: string | null;
  siteName: string | null;
  /** The job reference, where the invoice is allocated to exactly one job. */
  jobReference: string | null;
}

export const XERO_HEADERS = [
  "*ContactName",
  "*InvoiceNumber",
  "*InvoiceDate",
  "*DueDate",
  "*Description",
  "*Quantity",
  "*UnitAmount",
  "*AccountCode",
  "*TaxType",
  "TaxAmount",
  "Currency",
  "Reference",
  "TrackingName1",
  "TrackingOption1",
] as const;

export const QUICKBOOKS_HEADERS = [
  "InvoiceNo",
  "Customer",
  "InvoiceDate",
  "DueDate",
  "Terms",
  "Location",
  "Memo",
  "Item(Product/Service)",
  "ItemDescription",
  "ItemQuantity",
  "ItemRate",
  "ItemAmount",
  "ItemTaxCode",
  "ItemTaxAmount",
] as const;

export const SAGE_HEADERS = [
  "Type",
  "Account Reference",
  "Nominal A/C Ref",
  "Department Code",
  "Date",
  "Reference",
  "Details",
  "Net Amount",
  "Tax Code",
  "Tax Amount",
  "Exchange Rate",
  "Extra Reference",
  "User Name",
  "Project Refn",
  "Cost Code Refn",
] as const;

export function exportHeaders(format: ExportFormat): readonly string[] {
  if (format === "xero") return XERO_HEADERS;
  if (format === "quickbooks") return QUICKBOOKS_HEADERS;
  return SAGE_HEADERS;
}

export function accountingExport(
  format: ExportFormat,
  invoices: readonly ExportInvoice[],
): { headers: readonly string[]; rows: unknown[][]; csv: string } {
  const headers = exportHeaders(format);
  const map = format === "xero" ? xeroRow : format === "quickbooks" ? quickbooksRow : sageRow;
  const rows = invoices.map(map);
  return { headers, rows, csv: csvDocument(headers, rows) };
}

function reference(invoice: ExportInvoice): string {
  return (invoice.invoiceNumber ?? "").trim() || (invoice.internalRef ?? "").trim();
}

function description(invoice: ExportInvoice): string {
  const notes = (invoice.notes ?? "").trim();
  if (notes) return notes.slice(0, 400);
  const label = invoice.direction === "payable" ? "Purchase invoice" : "Sales invoice";
  return `${label} ${reference(invoice) || "(no reference)"}`.trim();
}

/** Net, falling back to gross where a row was typed as a single figure. */
function netOf(invoice: ExportInvoice): number {
  if (typeof invoice.netPence === "number") return Math.trunc(invoice.netPence);
  if (typeof invoice.grossPence === "number") return Math.trunc(invoice.grossPence);
  return 0;
}

function vatOf(invoice: ExportInvoice): number {
  return typeof invoice.vatPence === "number" ? Math.trunc(invoice.vatPence) : 0;
}

function xeroRow(invoice: ExportInvoice): unknown[] {
  const vat = vatOf(invoice);
  const taxType = vat === 0
    ? "No VAT"
    : invoice.direction === "receivable"
      ? "Tax on Sales"
      : "Tax on Purchases";
  return [
    (invoice.counterpartyName ?? "").trim(),
    reference(invoice),
    ukDate(invoice.invoiceDate),
    ukDate(invoice.dueAt),
    description(invoice),
    "1",
    poundsText(netOf(invoice)),
    "",
    taxType,
    poundsText(vat),
    (invoice.currency ?? "GBP").toUpperCase(),
    (invoice.internalRef ?? "").trim(),
    invoice.siteName ? "Site" : "",
    (invoice.siteName ?? "").trim(),
  ];
}

function quickbooksRow(invoice: ExportInvoice): unknown[] {
  const vat = vatOf(invoice);
  const category = financeCategoryKey(invoice.category);
  const item = category ? titleCase(category) : "";
  const terms = typeof invoice.paymentTermsDays === "number"
    ? `Net ${Math.max(0, Math.trunc(invoice.paymentTermsDays))}`
    : "";
  return [
    reference(invoice),
    (invoice.counterpartyName ?? "").trim(),
    ukDate(invoice.invoiceDate),
    ukDate(invoice.dueAt),
    terms,
    (invoice.siteName ?? "").trim(),
    (invoice.notes ?? "").trim().slice(0, 400),
    item,
    description(invoice),
    "1",
    poundsText(netOf(invoice)),
    poundsText(netOf(invoice)),
    vat === 0 ? "Z" : "S",
    poundsText(vat),
  ];
}

function sageRow(invoice: ExportInvoice): unknown[] {
  const vat = vatOf(invoice);
  return [
    invoice.direction === "receivable" ? "SI" : "PI",
    sageAccountCode(invoice),
    "",
    "",
    ukDate(invoice.invoiceDate),
    reference(invoice),
    description(invoice),
    poundsText(netOf(invoice)),
    vat === 0 ? "T0" : "T1",
    poundsText(vat),
    "1.00",
    (invoice.internalRef ?? "").trim(),
    "",
    (invoice.jobReference ?? "").trim(),
    "",
  ];
}

/**
 * Sage's `Account Reference`: 8 characters, upper case, alphanumeric.
 *
 * Derived from the counterparty id where there is one and from the NAME where
 * there is not, because Sage will reject the row outright rather than import it
 * unassigned. It is a suggestion: the code has to already exist in the tenant's
 * customer or supplier ledger and this export does not create one, which is
 * said out loud in the module header and in the route's response.
 */
export function sageAccountCode(invoice: ExportInvoice): string {
  const source = (invoice.counterpartyId ?? "").trim() || (invoice.counterpartyName ?? "").trim();
  const cleaned = source.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 8);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ── §13's bank-ready payment file ────────────────────────────────────────── */

export const PAYMENT_RUN_HEADERS = [
  "Payee name",
  "Payee sort code",
  "Payee account number",
  "Amount",
  "Currency",
  "Payment date",
  "Payment reference",
  "Invoice reference",
  "Debit account",
] as const;

export interface PaymentRunLine {
  payeeName: string | null;
  /** Always empty on this estate — see the note below. */
  payeeSortCode?: string | null;
  payeeAccountNumber?: string | null;
  amountPence: number;
  currency: string | null;
  paymentDay: string;
  paymentReference: string;
  invoiceReference: string;
  /** The workspace's own debit account, already masked or not by `./banking.ts`. */
  debitAccount: string;
}

/**
 * §13: "export as a bank-ready CSV".
 *
 * ── WHY THE TWO PAYEE BANK COLUMNS ARE EMPTY, AND WHY THAT IS NOT A GAP ────
 *
 * This schema records no supplier bank details anywhere. `db/schema.ts` says so
 * beside `payment_sources` in as many words — "`contractors` deliberately carries
 * no account number at all — this repository is public" — and §16 makes it a
 * rule: "Bank details appear only in settings, never in code." So the columns
 * are emitted, in the position every UK bulk-payment template puts them, and
 * left blank.
 *
 * That is how the file is actually used: a bulk payment at a UK bank is made
 * against SAVED BENEFICIARIES, matched on payee name and reference, and the
 * beneficiary's account details live at the bank rather than in the file. A
 * template with the columns present and empty imports; one with the columns
 * missing does not.
 *
 * The route says the same thing in its response so nobody discovers it by
 * opening the file at four o'clock on a Friday.
 */
export function paymentRunCsv(lines: readonly PaymentRunLine[]): string {
  return csvDocument(
    PAYMENT_RUN_HEADERS,
    lines.map((line) => [
      (line.payeeName ?? "").trim(),
      (line.payeeSortCode ?? "").trim(),
      (line.payeeAccountNumber ?? "").trim(),
      poundsText(line.amountPence),
      (line.currency ?? "GBP").toUpperCase(),
      ukDate(line.paymentDay),
      line.paymentReference,
      line.invoiceReference,
      line.debitAccount,
    ]),
  );
}

/* ── Reading a CSV somebody else wrote ────────────────────────────────────── */

/**
 * One column out of a parsed row, by any of several header spellings.
 *
 * A backfill CSV and a supplier statement are both written by somebody else, so
 * "Invoice No", "invoice_number" and "InvoiceNumber" are one column. Matching
 * on a normalised key rather than on an exact string is what stops a whole
 * import silently producing empty fields because a header had a space in it.
 */
export function pickColumn(
  row: Record<string, string>,
  ...names: readonly string[]
): string {
  const wanted = names.map(headerKey);
  for (const [header, value] of Object.entries(row)) {
    if (wanted.includes(headerKey(header))) {
      const trimmed = (value ?? "").trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

export function headerKey(value: string): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}
