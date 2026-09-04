/**
 * THE THIRTEEN SECTIONS, DERIVED ONCE.
 *
 * The contract stops the four renderers going back to the database. It does not
 * on its own stop them disagreeing about what to DO with what they were given —
 * which columns the site table has, which rows a totals line sums, whether a
 * null SLA percentage prints as a dash or as 0%. Four hand-written renderers
 * over one payload still drift; they just drift more slowly.
 *
 * So the payload is turned into a document ONCE, here, and the renderers become
 * dumb. The preview walks these sections and emits DOM. The `.docx` walks them
 * and emits WordprocessingML. The `.xlsx` walks them and emits a sheet each.
 * The `.pdf` walks them and lays them out on Helvetica. None of them decides
 * what a column is called or what a total is, because none of them computes
 * one: every figure below is read straight out of the payload, and where a
 * total appears it is the payload's total, never a re-summed column.
 *
 * That last point is the one worth being pedantic about. `siteSummaryTotals`
 * exists in the contract precisely so no renderer has to add up `siteSummary`,
 * and the invoice totals row is `invoice.totals`, not `lines.reduce(...)`. A
 * re-summed column is how a document ends up disagreeing with itself about
 * excluded lines.
 *
 * CELLS CARRY A VALUE AND A STRING, DELIBERATELY
 *
 * Excel must receive a NUMBER for money and a SERIAL for a date, or the workbook
 * is a screenshot in cells and cannot be filtered, formatted or summed — which
 * is the one thing the owner said the spreadsheet must not be. The PDF and Word
 * need the string. Carrying both on the cell means the two can never describe
 * different quantities, and `kind` tells the spreadsheet which number format to
 * apply without any renderer parsing "£1,690.00" back into a number.
 *
 * AUDIENCE
 *
 * `internalNote` is marked "never rendered into a client-facing export" by the
 * contract. That is a property of the CONTENT, so it is recorded on the content
 * — `audience: "internal"` — and the two client-facing renderers drop it. A
 * rule that lived in the Word writer instead would be a rule the PDF writer did
 * not have.
 */

import type {
  CombinedReportPayload,
  DataQualityFinding,
  ExecutiveCounts,
  InvoiceSection,
  MaintenanceSection,
  Pence,
} from "../reporting/contract";
import {
  basisPointsAsFraction,
  excelSerialFromIsoDate,
  formatBasisPoints,
  formatBoolean,
  formatCount,
  formatInstant,
  formatIsoDate,
  formatMoney,
  formatPercent,
  poundsOf,
} from "./format";

/* ── The model ───────────────────────────────────────────────────────────── */

export type CellKind =
  | "text"
  | "money"
  | "number"
  | "percent"
  | "date"
  | "boolean";

export type CellAlign = "left" | "right" | "center";

/** Who may see a piece of content. See the header. */
export type Audience = "all" | "internal";

export interface DocCell {
  kind: CellKind;
  /** What a human reads. Already formatted by `./format`, by that module alone. */
  text: string;
  /**
   * What a spreadsheet stores: pounds for money, a fraction for a percentage,
   * an Excel serial for a date, the number itself for a count. `null` where the
   * value is genuinely absent — which is not the same as zero and must not
   * become one.
   */
  value: number | null;
  emphasis?: boolean;
  /** Severity tint for validation and data-quality cells. */
  tone?: "blocking" | "warning" | "info" | "good";
}

export interface DocColumn {
  key: string;
  header: string;
  kind: CellKind;
  align: CellAlign;
  /** Width in characters. The spreadsheet uses it directly; the others scale it. */
  width: number;
}

export interface DocTable {
  columns: DocColumn[];
  rows: DocCell[][];
  /** The payload's own totals line, or null where a total is meaningless. */
  totals: DocCell[] | null;
  /** Sub-headings inside one table — the Full Job Log's status groups. */
  groups?: Array<{ label: string; from: number; count: number }>;
}

export interface DocKeyValue {
  label: string;
  value: string;
  audience: Audience;
  emphasis?: boolean;
}

export interface DocSection {
  /** Stable id — the anchor in the preview and the key in a test. */
  id: string;
  /** 1-13, printed in the document. */
  number: number;
  title: string;
  /** Where this section sits: the invoice, or the maintenance report. */
  part: 1 | 2;
  /** At most 31 characters and unique — an Excel worksheet name. */
  sheetName: string;
  /** A sentence explaining what the reader is looking at, when one is owed. */
  note: string | null;
  paragraphs: string[];
  keyValues: DocKeyValue[];
  table: DocTable | null;
  /** Printed instead of an empty table. Never a blank section. */
  emptyMessage: string | null;
  audience: Audience;
}

export interface ReportDocument {
  title: string;
  organisationName: string;
  clientName: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  invoiceNumber: string;
  status: string;
  generatedAt: string;
  currency: string;
  /** The two part headings, in order. */
  parts: Array<{ number: 1 | 2; title: string; subtitle: string }>;
  sections: DocSection[];
}

/* ── Cell constructors ───────────────────────────────────────────────────── */

const EMPTY = "—";

export function textCell(
  value: string | null | undefined,
  options: { emphasis?: boolean; tone?: DocCell["tone"]; fallback?: string } = {},
): DocCell {
  const text = typeof value === "string" && value.trim() ? value.trim() : (options.fallback ?? EMPTY);
  return { kind: "text", text, value: null, emphasis: options.emphasis, tone: options.tone };
}

export function moneyCell(
  pence: Pence | null | undefined,
  currency: string,
  options: { emphasis?: boolean } = {},
): DocCell {
  if (typeof pence !== "number" || !Number.isFinite(pence)) {
    return { kind: "money", text: EMPTY, value: null, emphasis: options.emphasis };
  }
  return {
    kind: "money",
    text: formatMoney(pence, currency),
    value: poundsOf(pence),
    emphasis: options.emphasis,
  };
}

export function numberCell(
  value: number | null | undefined,
  options: { emphasis?: boolean } = {},
): DocCell {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { kind: "number", text: EMPTY, value: null, emphasis: options.emphasis };
  }
  return { kind: "number", text: formatCount(value), value, emphasis: options.emphasis };
}

export function percentCell(percent: number | null | undefined): DocCell {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return { kind: "percent", text: EMPTY, value: null };
  }
  return { kind: "percent", text: formatPercent(percent), value: percent / 100 };
}

export function basisPointCell(basisPoints: number): DocCell {
  return {
    kind: "percent",
    text: formatBasisPoints(basisPoints),
    value: basisPointsAsFraction(basisPoints),
  };
}

export function dateCell(value: string | null | undefined): DocCell {
  const text = formatIsoDate(value, EMPTY);
  return { kind: "date", text, value: excelSerialFromIsoDate(value) };
}

export function booleanCell(value: boolean): DocCell {
  return { kind: "boolean", text: formatBoolean(value), value: value ? 1 : 0 };
}

function blank(kind: CellKind = "text"): DocCell {
  return { kind, text: "", value: null };
}

const column = (
  key: string,
  header: string,
  kind: CellKind,
  width: number,
  align: CellAlign = kind === "text" || kind === "boolean" ? "left" : "right",
): DocColumn => ({ key, header, kind, align, width });

function toneOfSeverity(severity: "blocking" | "warning" | "info"): DocCell["tone"] {
  return severity;
}

/* ── Section 1 — Invoice Summary ─────────────────────────────────────────── */

function invoiceSummary(payload: CombinedReportPayload): DocSection {
  const invoice = payload.invoice;
  const currency = invoice.currency;
  const totals = invoice.totals;
  const feeLabel = totals.singleFeePence === null ? "Average Site Fee" : "Fixed Fee per Site";
  const feePence = totals.singleFeePence ?? totals.averageFeePence;

  const keyValues: DocKeyValue[] = [
    { label: "Invoice number", value: invoice.invoiceNumber ?? "Not yet issued", audience: "all", emphasis: true },
    { label: "Status", value: invoice.status, audience: "all" },
    { label: "Client", value: invoice.clientName, audience: "all" },
    { label: "Billing address", value: invoice.billingAddress ?? EMPTY, audience: "all" },
    { label: "Invoice date", value: formatIsoDate(invoice.invoiceDate, "Not set"), audience: "all" },
    { label: "Payment due", value: formatIsoDate(invoice.dueAt, "Not set"), audience: "all" },
    {
      label: "Service period",
      value: `${formatIsoDate(invoice.servicePeriod.start)} to ${formatIsoDate(invoice.servicePeriod.end)}`,
      audience: "all",
    },
    { label: "Purchase order", value: invoice.purchaseOrder ?? EMPTY, audience: "all" },
    { label: "Client reference", value: invoice.clientReference ?? EMPTY, audience: "all" },
    { label: "Internal reference", value: invoice.internalReference ?? EMPTY, audience: "internal" },
    { label: "Payment terms", value: invoice.paymentTerms ?? EMPTY, audience: "all" },
    { label: "Currency", value: currency, audience: "all" },
    {
      label: "VAT",
      value: invoice.vatEnabled
        ? `Charged at ${formatBasisPoints(invoice.vatRateBasisPoints)}`
        : "Not charged",
      audience: "all",
    },
    { label: "VAT number", value: invoice.vatNumber ?? EMPTY, audience: "all" },
  ];
  if (invoice.clientNote) {
    keyValues.push({ label: "Note", value: invoice.clientNote, audience: "all" });
  }
  if (invoice.internalNote) {
    keyValues.push({ label: "Internal note", value: invoice.internalNote, audience: "internal" });
  }

  const columns = [
    column("measure", "Measure", "text", 32),
    column("value", "Value", "money", 18),
  ];
  const rows: DocCell[][] = [
    [textCell("Billable active sites"), numberCell(totals.includedSites)],
    [textCell(feeLabel), moneyCell(feePence, currency)],
    [textCell("Invoice subtotal"), moneyCell(totals.subtotalPence, currency)],
  ];
  if (totals.adjustmentPence) {
    rows.push([textCell("Adjustments"), moneyCell(totals.adjustmentPence, currency)]);
  }
  if (totals.creditPence) {
    rows.push([textCell("Credits"), moneyCell(-Math.abs(totals.creditPence), currency)]);
  }
  rows.push([
    textCell(invoice.vatEnabled ? `VAT at ${formatBasisPoints(invoice.vatRateBasisPoints)}` : "VAT"),
    moneyCell(totals.vatPence, currency),
  ]);

  const adjustmentNote = invoice.adjustments.length
    ? invoice.adjustments
        .map(
          (entry) =>
            `${entry.kind === "credit" ? "Credit" : "Adjustment"} of ${formatMoney(entry.amountPence, currency)} — ${entry.reason}` +
            (entry.authorisedByEmail ? ` (authorised by ${entry.authorisedByEmail})` : ""),
        )
        .join(" ")
    : null;

  return {
    id: "invoice-summary",
    number: 1,
    part: 1,
    title: "Invoice Summary",
    sheetName: "Invoice Summary",
    note:
      totals.singleFeePence === null
        ? "The included sites do not all carry the same fee, so an average is shown rather than a single site fee."
        : null,
    paragraphs: adjustmentNote ? [adjustmentNote] : [],
    keyValues,
    table: {
      columns,
      rows,
      totals: [textCell("Total payable", { emphasis: true }), moneyCell(totals.totalPence, currency, { emphasis: true })],
    },
    emptyMessage: null,
    audience: "all",
  };
}

/* ── Section 2 — Site Charges ────────────────────────────────────────────── */

function siteCharges(invoice: InvoiceSection): DocSection {
  const currency = invoice.currency;
  const columns = [
    column("line", "#", "number", 5),
    column("site", "Site name", "text", 30),
    column("reference", "Site reference", "text", 16),
    column("status", "Active status", "text", 14),
    column("from", "Active from", "date", 13),
    column("to", "Active to", "date", 13),
    column("billable", "Billable", "boolean", 10),
    column("fee", "Applied fee", "money", 14),
    column("source", "Fee source", "text", 20),
    column("vat", "VAT rate", "percent", 10),
    column("subtotal", "Line subtotal", "money", 15),
    column("inclusion", "Inclusion", "text", 26),
    column("validation", "Validation", "text", 44),
  ];

  const rows = invoice.lines.map((line) => {
    const worst = worstSeverity(line.validation.map((entry) => entry.severity));
    return [
      numberCell(line.lineNo),
      textCell(line.siteName),
      textCell(line.siteReference),
      textCell(line.activeStatus),
      dateCell(line.activeFrom),
      dateCell(line.activeTo),
      booleanCell(line.billable),
      moneyCell(line.feePence, currency),
      textCell(line.feeSource, { tone: line.feeSource ? undefined : "blocking", fallback: "No fee found" }),
      basisPointCell(line.vatRateBasisPoints),
      moneyCell(line.lineSubtotalPence, currency),
      textCell(inclusionText(line.included, line.exclusionReason, line.excludedByEmail, line.excludedAt)),
      textCell(
        line.validation.length
          ? line.validation.map((entry) => `${entry.severity}: ${entry.message}`).join(" • ")
          : "",
        { tone: worst ?? "good", fallback: "Clear" },
      ),
    ];
  });

  return {
    id: "site-charges",
    number: 2,
    part: 1,
    title: "Site Charges",
    sheetName: "Site Charges",
    note: "One line per site considered for this period. An excluded line keeps its row so the exclusion is visible, and is not counted in the totals.",
    paragraphs: [],
    keyValues: [],
    table: {
      columns,
      rows,
      // The payload's totals, NOT a re-sum of the column above. An excluded
      // line's subtotal is in the rows and not in the total, and re-summing
      // would quietly put it back.
      totals: [
        textCell(`${invoice.totals.totalSites} sites`, { emphasis: true }),
        textCell(`${invoice.totals.includedSites} included`, { emphasis: true }),
        textCell(`${invoice.totals.excludedSites} excluded`, { emphasis: true }),
        blank(),
        blank("date"),
        blank("date"),
        blank("boolean"),
        blank("money"),
        blank(),
        blank("percent"),
        moneyCell(invoice.totals.subtotalPence, currency, { emphasis: true }),
        textCell(`VAT ${formatMoney(invoice.totals.vatPence, currency)}`, { emphasis: true }),
        textCell(`Total ${formatMoney(invoice.totals.totalPence, currency)}`, { emphasis: true }),
      ],
    },
    emptyMessage: "No site was billable in this period, so the invoice carries no lines.",
    audience: "all",
  };
}

function inclusionText(
  included: boolean,
  reason: string | null,
  byEmail: string | null,
  at: string | null,
): string {
  if (included) return "Included";
  const who = byEmail ? ` by ${byEmail}` : "";
  const when = at ? ` on ${formatInstant(at)}` : "";
  return `Excluded${who}${when}${reason ? ` — ${reason}` : ""}`;
}

function worstSeverity(
  severities: Array<"blocking" | "warning" | "info">,
): DocCell["tone"] | null {
  if (severities.includes("blocking")) return "blocking";
  if (severities.includes("warning")) return "warning";
  if (severities.includes("info")) return "info";
  return null;
}

/* ── Section 3 — Executive Summary ───────────────────────────────────────── */

function executiveSummary(maintenance: MaintenanceSection, currency: string): DocSection {
  const counts = maintenance.executive.counts;
  const columns = [
    column("measure", "Measure", "text", 34),
    column("value", "This period", "number", 14),
    column("previous", "Previous period", "number", 16),
  ];
  const rows: DocCell[][] = [
    [textCell("Jobs recorded"), numberCell(counts.totalJobs), numberCell(counts.previousTotalJobs)],
    [textCell("Active sites"), numberCell(counts.activeSites), blank("number")],
    [textCell("Sites with jobs"), numberCell(counts.sitesWithJobs), blank("number")],
    [textCell("Completed jobs"), numberCell(counts.completedJobs), blank("number")],
    [textCell("Open jobs"), numberCell(counts.openJobs), blank("number")],
    [textCell("Cancelled jobs"), numberCell(counts.cancelledJobs), blank("number")],
    [textCell("Jobs measurable against an SLA"), numberCell(counts.measurableJobs), blank("number")],
    [textCell("Within SLA"), numberCell(counts.withinSla), blank("number")],
    [textCell("Outside SLA"), numberCell(counts.outsideSla), blank("number")],
    [textCell("SLA performance"), percentCell(counts.slaPercent), blank("percent")],
    [textCell("Jobs with an approved hold"), numberCell(counts.jobsWithApprovedHolds), blank("number")],
    [textCell("Open past target"), numberCell(counts.openPastTarget), blank("number")],
    [textCell("Critical and open"), numberCell(counts.criticalOpen), blank("number")],
  ];

  return {
    id: "executive-summary",
    number: 3,
    part: 2,
    title: "Executive Summary",
    sheetName: "Executive Summary",
    note: null,
    // Every sentence here was generated from a figure in this payload; see the
    // contract's note on `narrative`. Nothing is added to them.
    paragraphs: maintenance.executive.narrative,
    keyValues: [
      {
        label: "Completed maintenance expenditure",
        value: formatMoney(maintenance.spend.completedMaintenancePence, currency),
        audience: "all",
        emphasis: true,
      },
      {
        label: "MAINTSUPP service fee (billed separately)",
        value: formatMoney(maintenance.spend.serviceFeePence, currency),
        audience: "all",
      },
    ],
    table: { columns, rows, totals: null },
    emptyMessage: null,
    audience: "all",
  };
}

/* ── Section 4 — Site Performance ────────────────────────────────────────── */

function sitePerformance(maintenance: MaintenanceSection, currency: string): DocSection {
  const columns = [
    column("site", "Site", "text", 30),
    column("raised", "Jobs raised", "number", 12),
    column("completed", "Completed", "number", 11),
    column("open", "Open", "number", 9),
    column("cancelled", "Cancelled", "number", 11),
    column("hold", "On hold", "number", 10),
    column("past", "Past target", "number", 12),
    column("critical", "Critical", "number", 10),
    column("completedCost", "Completed spend", "money", 16),
    column("openCost", "Open or committed", "money", 18),
    column("fee", "Service fee", "money", 14),
    column("billable", "Billable", "boolean", 10),
  ];
  const rows = maintenance.siteSummary.map((site) => [
    textCell(site.siteName),
    numberCell(site.jobsRaised),
    numberCell(site.completed),
    numberCell(site.open),
    numberCell(site.cancelled),
    numberCell(site.onHold),
    numberCell(site.pastTarget),
    numberCell(site.critical),
    moneyCell(site.completedCostPence, currency),
    moneyCell(site.openQuotedCostPence, currency),
    moneyCell(site.fixedServiceFeePence, currency),
    booleanCell(site.billable),
  ]);
  const totals = maintenance.siteSummaryTotals;

  return {
    id: "site-performance",
    number: 4,
    part: 2,
    title: "Site Performance Summary",
    sheetName: "Site Performance",
    note: "The service fee column is the invoice charge for that site. It is shown beside maintenance spend for reference and is never added to it.",
    paragraphs: [],
    keyValues: [],
    table: {
      columns,
      rows,
      // `siteSummaryTotals` exists so this line is never a re-sum. See header.
      totals: [
        textCell("All sites", { emphasis: true }),
        numberCell(totals.jobsRaised, { emphasis: true }),
        numberCell(totals.completed, { emphasis: true }),
        numberCell(totals.open, { emphasis: true }),
        numberCell(totals.cancelled, { emphasis: true }),
        numberCell(totals.onHold, { emphasis: true }),
        numberCell(totals.pastTarget, { emphasis: true }),
        numberCell(totals.critical, { emphasis: true }),
        moneyCell(totals.completedCostPence, currency, { emphasis: true }),
        moneyCell(totals.openQuotedCostPence, currency, { emphasis: true }),
        moneyCell(totals.fixedServiceFeePence, currency, { emphasis: true }),
        blank("boolean"),
      ],
    },
    emptyMessage: "No site recorded a job in this period.",
    audience: "all",
  };
}

/* ── Section 5 — Spend Analysis ──────────────────────────────────────────── */

/**
 * The five figures the owner insisted stay apart, with the labels they were
 * given. The service fee sits FIRST and is labelled as the invoice, so that a
 * reader scanning the column cannot take the biggest number in it for
 * maintenance expenditure — which is the exact confusion the separation exists
 * to prevent.
 */
export const SPEND_LABELS = {
  serviceFee: "MAINTSUPP Service Fee",
  completed: "Completed Maintenance Expenditure",
  openCommitted: "Open or Committed Maintenance Cost",
  project: "Project Expenditure",
  routine: "Routine Maintenance Expenditure",
} as const;

function spendAnalysis(maintenance: MaintenanceSection, currency: string): DocSection {
  const spend = maintenance.spend;
  const columns = [
    column("figure", "Figure", "text", 38),
    column("amount", "Amount", "money", 16),
    column("basis", "What it counts", "text", 56),
  ];
  const rows: DocCell[][] = [
    [
      textCell(SPEND_LABELS.serviceFee, { emphasis: true }),
      moneyCell(spend.serviceFeePence, currency, { emphasis: true }),
      textCell("The invoice total for this period. Billed by MAINTSUPP and not maintenance expenditure."),
    ],
    [
      textCell(SPEND_LABELS.completed),
      moneyCell(spend.completedMaintenancePence, currency),
      textCell("Recorded cost of jobs completed in this period."),
    ],
    [
      textCell(SPEND_LABELS.openCommitted),
      moneyCell(spend.openCommittedPence, currency),
      textCell("Quoted or committed cost of jobs still open at the end of the period."),
    ],
    [
      textCell(SPEND_LABELS.project),
      moneyCell(spend.projectPence, currency),
      textCell("Special project expenditure, included in the completed figure above where the project completed."),
    ],
    [
      textCell(SPEND_LABELS.routine),
      moneyCell(spend.routinePence, currency),
      textCell("Routine and planned maintenance expenditure."),
    ],
  ];
  if (spend.previousCompletedMaintenancePence !== null) {
    const change = spend.completedMaintenancePence - spend.previousCompletedMaintenancePence;
    rows.push([
      textCell("Previous period, completed maintenance"),
      moneyCell(spend.previousCompletedMaintenancePence, currency),
      textCell(
        `${change === 0 ? "No change" : change > 0 ? `Up ${formatMoney(change, currency)}` : `Down ${formatMoney(-change, currency)}`} against the equivalent previous period.`,
      ),
    ]);
  }

  return {
    id: "spend-analysis",
    number: 5,
    part: 2,
    title: "Spend Analysis",
    sheetName: "Spend Analysis",
    note: "These figures are reported separately and are NOT additive. The service fee is what MAINTSUPP invoices; the others are what the portfolio spent on maintenance.",
    paragraphs: [],
    keyValues: [],
    // No totals row, on purpose: a total across these five would be a number
    // that means nothing and would read as combined expenditure.
    table: { columns, rows, totals: null },
    emptyMessage: null,
    audience: "all",
  };
}

/* ── Section 6 — SLA Performance ─────────────────────────────────────────── */

function slaPerformance(maintenance: MaintenanceSection): DocSection {
  const columns = [
    column("reference", "Reference", "text", 14),
    column("site", "Site", "text", 26),
    column("description", "Job", "text", 40),
    column("classification", "Classification", "text", 20),
    column("target", "Target working days", "number", 18),
    column("elapsed", "Elapsed working days", "number", 19),
    column("hold", "Approved hold days", "number", 18),
    column("adjusted", "Adjusted working days", "number", 20),
    column("result", "Result", "text", 12),
    column("reason", "Exclusion reason", "text", 36),
  ];
  const rows = maintenance.sla.map((row) => [
    textCell(row.reference ?? row.requestId),
    textCell(row.siteName),
    textCell(row.description),
    textCell(row.classification),
    numberCell(row.targetWorkingDays),
    numberCell(row.elapsedWorkingDays),
    numberCell(row.approvedHoldDays),
    numberCell(row.adjustedWorkingDays),
    textCell(row.result, {
      tone: row.result === "Within" ? "good" : row.result === "Outside" ? "warning" : "info",
    }),
    textCell(row.exclusionReason),
  ]);

  const counts = maintenance.executive.counts;
  return {
    id: "sla-performance",
    number: 6,
    part: 2,
    title: "SLA Performance",
    sheetName: "SLA Performance",
    note: "An excluded job carries the reason it was excluded. A job with no reason is never excluded.",
    paragraphs: [],
    keyValues: [
      { label: "Measurable jobs", value: formatCount(counts.measurableJobs), audience: "all" },
      { label: "Within SLA", value: formatCount(counts.withinSla), audience: "all" },
      { label: "Outside SLA", value: formatCount(counts.outsideSla), audience: "all" },
      {
        label: "SLA performance",
        value: formatPercent(counts.slaPercent, "No measurable job in this period"),
        audience: "all",
        emphasis: true,
      },
    ],
    table: { columns, rows, totals: null },
    emptyMessage: "No job in this period could be measured against an SLA target.",
    audience: "all",
  };
}

/* ── Section 7 — Delays and Holds ────────────────────────────────────────── */

function delaysAndHolds(maintenance: MaintenanceSection): DocSection {
  const columns = [
    column("reference", "Reference", "text", 14),
    column("site", "Site", "text", 26),
    column("description", "Job", "text", 36),
    column("reason", "Hold reason", "text", 30),
    column("category", "Category", "text", 18),
    column("start", "Hold from", "date", 13),
    column("end", "Hold to", "date", 13),
    column("days", "Approved hold days", "number", 18),
    column("approved", "Approved", "boolean", 10),
    column("approvedBy", "Approved by", "text", 22),
    column("approvalDate", "Approval date", "date", 14),
    column("target", "Target working days", "number", 18),
    column("adjusted", "Adjusted working days", "number", 20),
    column("sla", "SLA result", "text", 12),
    column("note", "Note", "text", 36),
  ];
  const rows = maintenance.holds.map((hold) => [
    textCell(hold.reference ?? hold.requestId),
    textCell(hold.siteName),
    textCell(hold.description),
    textCell(hold.reason),
    textCell(hold.category),
    dateCell(hold.startAt),
    dateCell(hold.endAt),
    numberCell(hold.approvedHoldDays),
    booleanCell(hold.approved),
    textCell(hold.approvedBy),
    dateCell(hold.approvalDate),
    numberCell(hold.targetWorkingDays),
    numberCell(hold.adjustedWorkingDays),
    textCell(hold.slaResult),
    textCell(hold.note),
  ]);

  return {
    id: "delays-and-holds",
    number: 7,
    part: 2,
    title: "Delays and Holds",
    sheetName: "Delays and Holds",
    note: "Only an approved hold adjusts an SLA measurement. An unapproved hold is listed here and changes nothing.",
    paragraphs: [],
    keyValues: [],
    table: { columns, rows, totals: null },
    emptyMessage: "No job was placed on hold in this period.",
    audience: "all",
  };
}

/* ── Sections 8 and 9 — open past target, critical open ──────────────────── */

const OPEN_COLUMNS = [
  column("reference", "Reference", "text", 14),
  column("site", "Site", "text", 26),
  column("issue", "Issue", "text", 40),
  column("priority", "Priority", "text", 14),
  column("classification", "Classification", "text", 20),
  column("raised", "Raised", "date", 12),
  column("target", "Target", "date", 12),
  column("open", "Working days open", "number", 17),
  column("past", "Days past target", "number", 16),
  column("status", "Status", "text", 16),
  column("contractor", "Contractor", "text", 24),
  column("blocker", "Blocker", "text", 30),
  column("next", "Next action", "text", 30),
  column("owner", "Responsible", "text", 22),
];

function openRow(row: {
  requestId: string;
  reference: string | null;
  siteName: string;
  issue: string;
  priority: string;
  classification: string | null;
  raisedOn: string | null;
  targetOn: string | null;
  workingDaysOpen: number | null;
  daysPastTarget: number | null;
  status: string;
  contractor: string | null;
  blocker: string | null;
  nextAction: string | null;
  responsibleUser: string | null;
}): DocCell[] {
  return [
    textCell(row.reference ?? row.requestId),
    textCell(row.siteName),
    textCell(row.issue),
    textCell(row.priority),
    textCell(row.classification),
    dateCell(row.raisedOn),
    dateCell(row.targetOn),
    numberCell(row.workingDaysOpen),
    numberCell(row.daysPastTarget),
    textCell(row.status),
    textCell(row.contractor),
    textCell(row.blocker),
    textCell(row.nextAction),
    textCell(row.responsibleUser),
  ];
}

function openPastTarget(maintenance: MaintenanceSection): DocSection {
  return {
    id: "open-past-target",
    number: 8,
    part: 2,
    title: "Open Items Past Target",
    sheetName: "Open Items Past Target",
    note: null,
    paragraphs: [],
    keyValues: [],
    table: {
      columns: OPEN_COLUMNS,
      rows: maintenance.openPastTarget.map(openRow),
      totals: null,
    },
    emptyMessage: "Every open job in this period is inside its target.",
    audience: "all",
  };
}

function criticalOpen(maintenance: MaintenanceSection): DocSection {
  return {
    id: "critical-open",
    number: 9,
    part: 2,
    title: "Critical Open Items",
    sheetName: "Critical Open Items",
    note: null,
    paragraphs: [],
    keyValues: [],
    table: {
      columns: OPEN_COLUMNS,
      rows: maintenance.criticalOpen.map(openRow),
      totals: null,
    },
    emptyMessage: "No critical job was open at the end of this period.",
    audience: "all",
  };
}

/* ── Section 10 — Special Projects ───────────────────────────────────────── */

function specialProjects(maintenance: MaintenanceSection, currency: string): DocSection {
  const columns = [
    column("title", "Project", "text", 34),
    column("site", "Site", "text", 26),
    column("scope", "Scope", "text", 44),
    column("plannedStart", "Planned start", "date", 14),
    column("plannedEnd", "Planned end", "date", 14),
    column("actualStart", "Actual start", "date", 14),
    column("actualEnd", "Actual end", "date", 14),
    column("status", "Status", "text", 16),
    column("contractor", "Contractor", "text", 24),
    column("requestedBy", "Requested by", "text", 22),
    column("quote", "Approved quote", "money", 16),
    column("final", "Final cost", "money", 14),
    column("variance", "Variance", "money", 14),
    column("outcome", "Outcome", "text", 30),
    column("notes", "Notes", "text", 36),
  ];
  const rows = maintenance.specialProjects.map((project) => [
    textCell(project.title),
    textCell(project.siteName),
    textCell(project.scope),
    dateCell(project.plannedStart),
    dateCell(project.plannedEnd),
    dateCell(project.actualStart),
    dateCell(project.actualEnd),
    textCell(project.status),
    textCell(project.contractor),
    textCell(project.requestedBy),
    moneyCell(project.approvedQuotePence, currency),
    moneyCell(project.finalCostPence, currency),
    moneyCell(project.variancePence, currency),
    textCell(project.outcome),
    textCell(project.notes),
  ]);

  return {
    id: "special-projects",
    number: 10,
    part: 2,
    title: "Special Projects",
    sheetName: "Special Projects",
    note: null,
    paragraphs: [],
    keyValues: [],
    table: { columns, rows, totals: null },
    // The contract says an empty array means the section is omitted entirely.
    // `omitWhenEmpty` below is what acts on that; this message is for the
    // preview, which shows the section so the reader can see it was considered.
    emptyMessage: "No special project ran in this period.",
    audience: "all",
  };
}

/* ── Section 11 — Full Job Log ───────────────────────────────────────────── */

function fullJobLog(maintenance: MaintenanceSection, currency: string): DocSection {
  const columns = [
    column("reference", "Reference", "text", 14),
    column("site", "Site", "text", 26),
    column("issue", "Issue", "text", 40),
    column("type", "Job type", "text", 18),
    column("classification", "Classification", "text", 20),
    column("priority", "Priority", "text", 14),
    column("raised", "Raised", "date", 12),
    column("target", "Target", "date", 12),
    column("completed", "Completed", "date", 12),
    column("status", "Status", "text", 16),
    column("sla", "SLA", "text", 11),
    column("contractor", "Contractor", "text", 24),
    column("recorded", "Recorded cost", "money", 15),
    column("quoted", "Quoted cost", "money", 14),
    column("hold", "Hold days", "number", 11),
    column("notes", "Notes", "text", 36),
  ];
  const rows: DocCell[][] = [];
  const groups: Array<{ label: string; from: number; count: number }> = [];
  for (const group of maintenance.jobLog) {
    if (!group.rows.length) continue;
    groups.push({ label: group.group, from: rows.length, count: group.rows.length });
    for (const job of group.rows) {
      rows.push([
        textCell(job.reference ?? job.requestId),
        textCell(job.siteName),
        textCell(job.issue),
        textCell(job.jobType),
        textCell(job.classification),
        textCell(job.priority),
        dateCell(job.raisedOn),
        dateCell(job.targetOn),
        dateCell(job.completedOn),
        textCell(group.group),
        textCell(job.slaResult),
        textCell(job.contractor),
        moneyCell(job.recordedCostPence, currency),
        moneyCell(job.quotedCostPence, currency),
        numberCell(job.holdDays),
        textCell(job.notes),
      ]);
    }
  }

  return {
    id: "full-job-log",
    number: 11,
    part: 2,
    title: "Full Job Log",
    sheetName: "Full Job Log",
    note: "Grouped by status, in the order the workflow runs. The Status column repeats the group so a filtered or re-sorted spreadsheet still says which group a row came from.",
    paragraphs: [],
    keyValues: [],
    table: { columns, rows, totals: null, groups },
    emptyMessage: "No job was recorded in this period.",
    audience: "all",
  };
}

/* ── Section 12 — Data Quality ───────────────────────────────────────────── */

function dataQuality(findings: DataQualityFinding[]): DocSection {
  const columns = [
    column("severity", "Severity", "text", 12),
    column("code", "Code", "text", 22),
    column("message", "Finding", "text", 60),
    column("entity", "Record type", "text", 14),
    column("id", "Record", "text", 26),
  ];
  const rows = findings.map((finding) => [
    textCell(finding.severity, { tone: toneOfSeverity(finding.severity) }),
    textCell(finding.code),
    textCell(finding.message),
    textCell(finding.entityType),
    textCell(finding.entityId),
  ]);
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  const warning = findings.filter((finding) => finding.severity === "warning").length;
  const info = findings.filter((finding) => finding.severity === "info").length;

  return {
    id: "data-quality",
    number: 12,
    part: 2,
    title: "Data Quality",
    sheetName: "Data Quality",
    note: "A blocking finding stops finalisation. A warning does not, and is reported so the reader knows what the figures rest on.",
    paragraphs: [],
    keyValues: [
      { label: "Blocking", value: formatCount(blocking), audience: "all", emphasis: blocking > 0 },
      { label: "Warnings", value: formatCount(warning), audience: "all" },
      { label: "Information", value: formatCount(info), audience: "all" },
    ],
    table: { columns, rows, totals: null },
    emptyMessage: "Nothing was found wrong with the data behind this report.",
    audience: "all",
  };
}

/* ── Section 13 — SLA Rules ──────────────────────────────────────────────── */

function slaRules(maintenance: MaintenanceSection): DocSection {
  const columns = [
    column("classification", "Classification", "text", 26),
    column("target", "Target working days", "number", 19),
    column("version", "Rule version", "number", 13),
    column("note", "Note", "text", 50),
  ];
  const rows = maintenance.slaRules.map((rule) => [
    textCell(rule.classification),
    numberCell(rule.targetWorkingDays),
    numberCell(rule.version),
    textCell(rule.note),
  ]);

  return {
    id: "sla-rules",
    number: 13,
    part: 2,
    title: "SLA Rules Applied",
    sheetName: "SLA Rules",
    note: "The rules as they stood when this report was produced. A finalised document keeps the version it was measured against.",
    paragraphs: [],
    keyValues: [],
    table: { columns, rows, totals: null },
    emptyMessage: "No SLA rule is configured for this workspace, so no job was measurable.",
    audience: "all",
  };
}

/* ── The document ────────────────────────────────────────────────────────── */

/**
 * Build the thirteen sections from a payload.
 *
 * Pure, synchronous, and with no access to anything but its argument — which is
 * what lets a test assert that the Word total and the Excel total are the same
 * object rather than two computations that happen to agree today.
 */
export function buildReportDocument(payload: CombinedReportPayload): ReportDocument {
  const currency = payload.invoice.currency;
  const sections: DocSection[] = [
    invoiceSummary(payload),
    siteCharges(payload.invoice),
    executiveSummary(payload.maintenance, currency),
    sitePerformance(payload.maintenance, currency),
    spendAnalysis(payload.maintenance, currency),
    slaPerformance(payload.maintenance),
    delaysAndHolds(payload.maintenance),
    openPastTarget(payload.maintenance),
    criticalOpen(payload.maintenance),
    specialProjects(payload.maintenance, currency),
    fullJobLog(payload.maintenance, currency),
    dataQuality(payload.maintenance.dataQuality),
    slaRules(payload.maintenance),
  ];

  return {
    title: "Invoice and Maintenance Performance Report",
    organisationName: payload.organisationName,
    clientName: payload.invoice.clientName,
    periodLabel: payload.period.label,
    periodStart: formatIsoDate(payload.period.start),
    periodEnd: formatIsoDate(payload.period.end),
    invoiceNumber: payload.invoice.invoiceNumber ?? "Draft — not yet issued",
    status: payload.invoice.status,
    generatedAt: formatInstant(payload.generatedAt),
    currency,
    parts: [
      { number: 1, title: "Part 1 — Invoice", subtitle: "MAINTSUPP service fee for the period" },
      {
        number: 2,
        title: "Part 2 — Maintenance Performance Report",
        subtitle: "What the portfolio did, and what it spent doing it",
      },
    ],
    sections,
  };
}

/**
 * The sections a given renderer prints.
 *
 * A client-facing export drops internal content. The Special Projects section
 * is dropped when empty because the contract says so in as many words — "empty
 * array means the section is omitted entirely, never rendered blank" — and that
 * is the only section with that instruction, so it is the only one that gets
 * it. Every other empty section prints its `emptyMessage`, because a missing
 * SLA section and an SLA section saying "nothing was measurable" are different
 * statements and the second is the true one.
 *
 * THE OMISSION IS CLIENT-FACING ONLY, and that is a deliberate reading rather
 * than a loophole. The contract's instruction is about a document a client
 * reads, where a heading over nothing is noise. The workbook is not that
 * document — it is the owner's working copy, its sections are TABS, and a
 * missing tab does not read as "no projects", it reads as "the workbook is
 * incomplete". So the internal audience keeps all thirteen and the tab says in
 * words that no project ran.
 */
export function sectionsFor(
  document: ReportDocument,
  audience: Audience,
): DocSection[] {
  return document.sections.filter((section) => {
    if (audience === "all" && section.audience === "internal") return false;
    if (
      audience === "all" &&
      section.id === "special-projects" &&
      !section.table?.rows.length
    ) {
      return false;
    }
    return true;
  });
}

/** Key/value pairs a given audience may see. */
export function keyValuesFor(section: DocSection, audience: Audience): DocKeyValue[] {
  return section.keyValues.filter(
    (entry) => audience === "internal" || entry.audience === "all",
  );
}

/** Every excluded line, for the exclusions note under the site table. */
export function excludedLines(payload: CombinedReportPayload) {
  return payload.invoice.lines.filter((line) => !line.included);
}

/** The maintenance KPI cards, as the generator and the preview both show them. */
export function maintenanceKpiRows(
  payload: CombinedReportPayload,
): Array<{ key: string; label: string; value: string; drill: string }> {
  const kpis = payload.maintenance.kpis;
  const currency = payload.invoice.currency;
  return [
    { key: "jobsRecorded", label: "Jobs Recorded", value: formatCount(kpis.jobsRecorded), drill: "all" },
    { key: "completedJobs", label: "Completed Jobs", value: formatCount(kpis.completedJobs), drill: "completed" },
    { key: "openJobs", label: "Open Jobs", value: formatCount(kpis.openJobs), drill: "open" },
    {
      key: "openJobsPastTarget",
      label: "Open Jobs Past Target",
      value: formatCount(kpis.openJobsPastTarget),
      drill: "past-target",
    },
    {
      key: "slaPerformance",
      label: "SLA Performance",
      value: formatPercent(kpis.slaPerformancePercent),
      drill: "sla",
    },
    { key: "jobsOnHold", label: "Jobs on Hold", value: formatCount(kpis.jobsOnHold), drill: "hold" },
    {
      key: "criticalOpenJobs",
      label: "Critical Open Jobs",
      value: formatCount(kpis.criticalOpenJobs),
      drill: "critical",
    },
    {
      key: "completedMaintenanceSpend",
      label: "Completed Maintenance Spend",
      value: formatMoney(kpis.completedMaintenanceSpendPence, currency),
      drill: "completed",
    },
  ];
}

/** The invoice KPI cards. The fee card renames itself; see `InvoiceTotals`. */
export function invoiceKpiRows(
  payload: CombinedReportPayload,
): Array<{ key: string; label: string; value: string; note?: string }> {
  const totals = payload.invoice.totals;
  const currency = payload.invoice.currency;
  const mixed = totals.singleFeePence === null;
  return [
    {
      key: "billableSites",
      label: "Billable Active Sites",
      value: formatCount(totals.includedSites),
      note: totals.excludedSites ? `${totals.excludedSites} excluded` : undefined,
    },
    {
      key: "siteFee",
      label: mixed ? "Average Site Fee" : "Fixed Fee per Site",
      value: formatMoney(mixed ? totals.averageFeePence : (totals.singleFeePence ?? 0), currency),
      note: mixed ? "Fees differ across the included sites" : undefined,
    },
    { key: "subtotal", label: "Invoice Subtotal", value: formatMoney(totals.subtotalPence, currency) },
    {
      key: "vat",
      label: "VAT",
      value: formatMoney(totals.vatPence, currency),
      note: payload.invoice.vatEnabled
        ? `At ${formatBasisPoints(payload.invoice.vatRateBasisPoints)}`
        : "Not charged",
    },
    { key: "total", label: "Total Payable", value: formatMoney(totals.totalPence, currency) },
  ];
}

/** Counts used by more than one caller, so they are not counted twice. */
export function severityCounts(payload: CombinedReportPayload): {
  blocking: number;
  warning: number;
  info: number;
} {
  const findings: Array<{ severity: string }> = [
    ...payload.maintenance.dataQuality,
    ...payload.invoice.lines.flatMap((line) => line.validation),
  ];
  return {
    blocking: findings.filter((finding) => finding.severity === "blocking").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    info: findings.filter((finding) => finding.severity === "info").length,
  };
}

export type { ExecutiveCounts };
