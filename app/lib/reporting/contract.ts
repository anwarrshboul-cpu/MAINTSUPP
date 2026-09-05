/**
 * THE ONE SHAPE A COMBINED DOCUMENT HAS.
 *
 * Types only. Nothing in this file computes anything, imports a component or
 * touches the database, and that is the whole point of it existing.
 *
 * WHY A CONTRACT FILE AT ALL
 *
 * The owner's requirement that decided this design is one line long: "ALL
 * FORMAT TOTALS MUST MATCH." The preview on screen, the Word document, the PDF
 * and the Excel workbook must show the same numbers, and the way that goes
 * wrong is never a wrong sum — it is four renderers that each went back to the
 * database and asked a slightly different question. One of them filters
 * archived jobs, one counts a cancelled job as open, one reads the fee as it is
 * today rather than as it was when the invoice was approved, and the four
 * disagree by amounts too small to notice until a client does.
 *
 * So the engine computes ONCE, into `CombinedReportPayload`. The preview
 * renders that value. Every exporter renders that same value. No renderer is
 * permitted a database handle. Reconciliation stops being something to test for
 * and becomes something the type system makes hard to break: if a number is not
 * in the payload, no format can show it, and if it is, they all show the same
 * one.
 *
 * WHY A FINALISED DOCUMENT IS THIS, VERBATIM
 *
 * `report_snapshots.payload` stores a serialised `CombinedReportPayload`. That
 * is what "preserve an immutable source snapshot" means here in practice: after
 * finalisation the exporters read the snapshot instead of recomputing, so a fee
 * changed in March cannot restate an invoice issued in February. A finalised
 * document is not a query that happens to return the same answer — it is a
 * value that was written down.
 *
 * MONEY
 *
 * Every monetary field in this file is INTEGER PENCE and is named `…Pence` so
 * that a float can never be assigned to one by accident. Percentages are whole
 * numbers or basis points, never fractions. Dates crossing this boundary are
 * ISO `YYYY-MM-DD`; instants are ISO UTC. Nothing here is pre-formatted for
 * display — DD/MM/YYYY and the pound sign are a renderer's business, and a
 * payload carrying "£1,690.00" cannot be summed by the Excel exporter.
 */

/** Integer pence. Never a float, never a formatted string. */
export type Pence = number;

/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** ISO instant in UTC. */
export type IsoInstant = string;

/* ------------------------------------------------------------- the period -- */

export interface ReportPeriod {
  start: IsoDate;
  end: IsoDate;
  /** The preset that produced it, or "Custom range". For the document header. */
  label: string;
  /** True when the range is not a whole calendar month — drives the warning. */
  partialMonth: boolean;
}

export const REPORT_PERIOD_PRESETS = [
  "today",
  "this-week",
  "this-month",
  "last-month",
  "this-quarter",
  "this-year",
  "last-12-months",
  "custom",
] as const;

export type ReportPeriodPreset = (typeof REPORT_PERIOD_PRESETS)[number];

/* ---------------------------------------------------------------- billing -- */

/**
 * Which level of the hierarchy priced a line. Site override beats client fee
 * beats organisation default; the line records which one won so that a reader
 * can see why two sites in the same invoice carry different money.
 */
export type FeeSource = "Site override" | "Client fee" | "Organisation default";

export type LineValidationSeverity = "blocking" | "warning" | "info";

export interface LineValidation {
  severity: LineValidationSeverity;
  code: string;
  message: string;
}

export interface BillableSiteLine {
  lineNo: number;
  siteId: string | null;
  siteName: string;
  siteReference: string | null;
  /** The site's own status word, not a re-derived one. */
  activeStatus: string;
  activeFrom: IsoDate | null;
  activeTo: IsoDate | null;
  billable: boolean;
  feePence: Pence;
  /** Null when no valid fee was found — which is a blocking validation. */
  feeSource: FeeSource | null;
  feeRecordId: string | null;
  vatRateBasisPoints: number;
  lineSubtotalPence: Pence;
  lineVatPence: Pence;
  lineTotalPence: Pence;
  included: boolean;
  exclusionReason: string | null;
  excludedByEmail: string | null;
  excludedAt: IsoInstant | null;
  validation: LineValidation[];
}

export interface InvoiceTotals {
  totalSites: number;
  includedSites: number;
  excludedSites: number;
  subtotalPence: Pence;
  vatPence: Pence;
  adjustmentPence: Pence;
  creditPence: Pence;
  totalPence: Pence;
  /**
   * `singleFeePence` is non-null only when every included line carries the same
   * fee. The KPI card shows "Fixed Fee per Site" when it is set and "Average
   * Site Fee" when it is not — the owner's instruction was that one number
   * across mixed fees is misleading, so the payload decides, not the renderer.
   */
  singleFeePence: Pence | null;
  averageFeePence: Pence;
}

export type InvoiceStatus =
  | "Draft"
  | "Ready for Review"
  | "Approved"
  | "Finalised"
  | "Voided";

export interface InvoiceAdjustmentEntry {
  id: string;
  kind: "adjustment" | "credit";
  amountPence: Pence;
  reason: string;
  authorisedByEmail: string | null;
  createdAt: IsoInstant;
}

export interface InvoiceSection {
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: InvoiceStatus;
  invoiceDate: IsoDate | null;
  dueAt: IsoDate | null;
  servicePeriod: ReportPeriod;
  clientName: string;
  billingAddress: string | null;
  clientReference: string | null;
  purchaseOrder: string | null;
  internalReference: string | null;
  currency: string;
  paymentTerms: string | null;
  vatEnabled: boolean;
  vatRateBasisPoints: number;
  vatNumber: string | null;
  clientNote: string | null;
  /** Never rendered into a client-facing export. Preview and Excel only. */
  internalNote: string | null;
  lines: BillableSiteLine[];
  adjustments: InvoiceAdjustmentEntry[];
  totals: InvoiceTotals;
}

/* ------------------------------------------------------------ maintenance -- */

export type SlaResult = "Within" | "Outside" | "Excluded";

export interface SlaOutcomeRow {
  requestId: string;
  reference: string | null;
  siteName: string;
  description: string;
  classification: string | null;
  targetWorkingDays: number | null;
  elapsedWorkingDays: number | null;
  approvedHoldDays: number;
  adjustedWorkingDays: number | null;
  result: SlaResult;
  /** Required whenever `result` is "Excluded". Never invented. */
  exclusionReason: string | null;
}

export interface HoldRow {
  holdId: string;
  requestId: string;
  reference: string | null;
  siteName: string;
  description: string;
  classification: string | null;
  targetWorkingDays: number | null;
  elapsedWorkingDays: number | null;
  approvedHoldDays: number;
  adjustedWorkingDays: number | null;
  slaResult: SlaResult;
  reason: string | null;
  category: string | null;
  startAt: IsoDate | null;
  endAt: IsoDate | null;
  approved: boolean;
  approvedBy: string | null;
  approvalDate: IsoDate | null;
  note: string | null;
}

export interface OpenPastTargetRow {
  requestId: string;
  reference: string | null;
  siteName: string;
  issue: string;
  priority: string;
  classification: string | null;
  raisedOn: IsoDate | null;
  targetOn: IsoDate | null;
  workingDaysOpen: number | null;
  daysPastTarget: number | null;
  status: string;
  contractor: string | null;
  blocker: string | null;
  nextAction: string | null;
  responsibleUser: string | null;
}

export interface SpecialProjectRow {
  requestId: string;
  title: string;
  siteName: string;
  scope: string | null;
  plannedStart: IsoDate | null;
  plannedEnd: IsoDate | null;
  actualStart: IsoDate | null;
  actualEnd: IsoDate | null;
  status: string;
  contractor: string | null;
  requestedBy: string | null;
  approvedQuotePence: Pence | null;
  finalCostPence: Pence | null;
  variancePence: Pence | null;
  outcome: string | null;
  notes: string | null;
}

export interface JobLogRow {
  requestId: string;
  reference: string | null;
  siteName: string;
  issue: string;
  jobType: string | null;
  classification: string | null;
  priority: string;
  raisedOn: IsoDate | null;
  targetOn: IsoDate | null;
  completedOn: IsoDate | null;
  status: string;
  slaResult: SlaResult | null;
  contractor: string | null;
  recordedCostPence: Pence | null;
  quotedCostPence: Pence | null;
  holdDays: number;
  notes: string | null;
}

/** The Full Job Log is grouped by status, in the owner's stated order. */
export const JOB_LOG_GROUPS = [
  "New",
  "Assigned",
  "In Progress",
  "Awaiting Approval",
  "On Hold",
  "Completed",
  "Cancelled",
] as const;

export type JobLogGroup = (typeof JOB_LOG_GROUPS)[number];

export interface SiteSummaryRow {
  siteId: string | null;
  siteName: string;
  jobsRaised: number;
  completed: number;
  open: number;
  cancelled: number;
  onHold: number;
  pastTarget: number;
  critical: number;
  completedCostPence: Pence;
  openQuotedCostPence: Pence;
  fixedServiceFeePence: Pence;
  billable: boolean;
}

export interface MaintenanceKpis {
  jobsRecorded: number;
  completedJobs: number;
  openJobs: number;
  openJobsPastTarget: number;
  /** Null when no job in the period was measurable — not zero. */
  slaPerformancePercent: number | null;
  jobsOnHold: number;
  criticalOpenJobs: number;
  completedMaintenanceSpendPence: Pence;
}

/**
 * The five expenditure figures the owner insisted stay separately labelled.
 * `serviceFeePence` is the invoice total and is NEVER added to the others.
 */
export interface SpendAnalysis {
  serviceFeePence: Pence;
  completedMaintenancePence: Pence;
  openCommittedPence: Pence;
  projectPence: Pence;
  routinePence: Pence;
  previousCompletedMaintenancePence: Pence | null;
}

export interface ExecutiveCounts {
  totalJobs: number;
  activeSites: number;
  sitesWithJobs: number;
  completedJobs: number;
  openJobs: number;
  cancelledJobs: number;
  measurableJobs: number;
  withinSla: number;
  outsideSla: number;
  slaPercent: number | null;
  jobsWithApprovedHolds: number;
  openPastTarget: number;
  criticalOpen: number;
  previousTotalJobs: number | null;
}

export interface ExecutiveSummary {
  counts: ExecutiveCounts;
  /**
   * Sentences generated from `counts` and `spend`. Every sentence must be
   * derivable from a number in this payload; a sentence with no supporting
   * figure is not written at all. There is no canned paragraph — an empty
   * period produces a short summary saying so, not a confident one saying
   * nothing happened for reasons it invented.
   */
  narrative: string[];
}

/* ----------------------------------------------------------- data quality -- */

export type DataQualitySeverity = "blocking" | "warning" | "info";

export interface DataQualityFinding {
  severity: DataQualitySeverity;
  code: string;
  message: string;
  entityType: "job" | "site" | "contractor" | "settings" | "invoice" | null;
  entityId: string | null;
  /** In-app link to the offending record, when one can be built. */
  href: string | null;
}

export interface SlaRuleRow {
  classification: string;
  targetWorkingDays: number;
  version: number;
  note: string | null;
}

export interface MaintenanceSection {
  kpis: MaintenanceKpis;
  executive: ExecutiveSummary;
  siteSummary: SiteSummaryRow[];
  siteSummaryTotals: Omit<SiteSummaryRow, "siteId" | "siteName" | "billable">;
  spend: SpendAnalysis;
  sla: SlaOutcomeRow[];
  holds: HoldRow[];
  openPastTarget: OpenPastTargetRow[];
  criticalOpen: OpenPastTargetRow[];
  /** Empty array means the section is omitted entirely, never rendered blank. */
  specialProjects: SpecialProjectRow[];
  jobLog: Array<{ group: JobLogGroup; rows: JobLogRow[] }>;
  dataQuality: DataQualityFinding[];
  slaRules: SlaRuleRow[];
}

/* ------------------------------------------------------------- the payload -- */

export interface CombinedReportPayload {
  /** Bumped when the shape changes, so an old snapshot still renders. */
  schemaVersion: 1;
  generatedAt: IsoInstant;
  organisationId: string;
  organisationName: string;
  period: ReportPeriod;
  previousPeriod: ReportPeriod | null;
  invoice: InvoiceSection;
  maintenance: MaintenanceSection;
}

/* -------------------------------------------------------------- workflow -- */

/**
 * What stops a document being finalised. Warnings never appear here — they may
 * accompany a draft, which is the whole distinction the owner asked for.
 */
export interface FinalisationBlocker {
  code: string;
  message: string;
}

/**
 * WHICH OF THE TWO DOCUMENTS IS BEING ASKED FOR.
 *
 * One stored row still produces both halves — the payload is unchanged and its
 * `schemaVersion` stays 1 — but the reader now chooses which half they are
 * looking at and which half they are downloading. `combined` is what every
 * caller that predates the split means, so it is the default everywhere and the
 * old behaviour is reachable without saying anything.
 *
 * The mapping onto `DocSection.part` is in `document-model.ts`, which is the
 * module that owns what a part contains. This type is here because
 * `exportFilename` needs it and the filename is the contract's.
 */
export const DOCUMENT_KINDS = ["report", "invoice", "combined"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export interface DocumentListRow {
  invoiceId: string;
  invoiceNumber: string | null;
  /**
   * Which document this row IS, once the register learns to record it.
   *
   * Optional and unpopulated today: every stored row predates the split and
   * carries both parts, so the list route returns nothing here and the
   * Documents tab treats `undefined` as "open the Report". Declared now so the
   * screen reads a field rather than a cast, and so the day the column exists
   * nothing but the query has to change.
   */
  kind?: DocumentKind | null;
  clientName: string;
  period: ReportPeriod;
  invoiceDate: IsoDate | null;
  dueAt: IsoDate | null;
  activeSitesBilled: number;
  invoiceTotalPence: Pence;
  maintenanceSpendPence: Pence;
  status: InvoiceStatus;
  createdByEmail: string | null;
  createdAt: IsoInstant;
  approvedByEmail: string | null;
  finalisedAt: IsoInstant | null;
  formats: ExportFormat[];
}

export const EXPORT_FORMATS = ["docx", "pdf", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The download name, per document kind. Shared so that the three exporters, the
 * download route and the Generated Documents table cannot drift from one
 * another.
 *
 *   combined  MAINTSUPP_[ClientName]_[StartDate]_[EndDate]_[InvoiceNumber]
 *   report    MAINTSUPP_Report_[ClientName]_[YYYY-MM]_v[n]
 *   invoice   MAINTSUPP_Invoice_[ClientName]_[InvoiceNumber or DRAFT-YYYY-MM]
 *
 * ── WHY THE KIND IS IN THE NAME AND NOT ONLY IN THE FILE ──────────────────
 *
 * Before the split there was one document per client per period, so its period
 * identified it. There are now two, and both are downloaded into the same
 * folder from the same screen on the same afternoon. A name that omitted the
 * kind would have the Report and the Invoice for March collide — the second
 * download silently becoming `…(1).docx`, or overwriting the first — and the
 * reader would have no way to tell from the folder which file is which. The
 * word is therefore in the name, second, where it sorts the two apart.
 *
 * `combined` keeps the old shape byte for byte. It is the default, so a caller
 * that predates the split is named exactly as it was.
 *
 * Sanitising is deliberately aggressive and unchanged: anything outside the
 * allowed set becomes a single hyphen. A client legitimately called
 * "Smith & Co. (UK)/EU" must not be able to produce a path separator, a leading
 * dot, or a Windows reserved character in a filename the owner will download.
 */
export function exportFilename(input: {
  clientName: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  invoiceNumber: string | null;
  format: ExportFormat;
  /** Defaults to `combined`, which is the name this function always produced. */
  kind?: DocumentKind;
  /** The report's revision. Defaults to 1 until the register stores one. */
  version?: number | null;
}): string {
  const safe = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unknown";
  // The month the period starts in. A report is a month even when its range is
  // a fortnight, and `YYYY-MM` is what the owner's spec names.
  const yearMonth = /^(\d{4})-(\d{2})/.exec(input.periodStart);
  const month = yearMonth ? `${yearMonth[1]}-${yearMonth[2]}` : input.periodStart;
  const version = Number.isFinite(input.version) && (input.version ?? 0) > 0
    ? Math.floor(input.version as number)
    : 1;

  const parts =
    input.kind === "report"
      ? ["MAINTSUPP", "Report", safe(input.clientName), safe(month), `v${version}`]
      : input.kind === "invoice"
        ? [
            "MAINTSUPP",
            "Invoice",
            safe(input.clientName),
            // A draft invoice has no number, and two drafts for two months must
            // still be two files, so the month stands in for the reference.
            safe(input.invoiceNumber ?? `DRAFT-${month}`),
          ]
        : [
            "MAINTSUPP",
            safe(input.clientName),
            safe(input.periodStart),
            safe(input.periodEnd),
            safe(input.invoiceNumber ?? "DRAFT"),
          ];
  return `${parts.join("_")}.${input.format}`;
}
