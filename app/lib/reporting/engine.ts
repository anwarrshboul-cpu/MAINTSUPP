/**
 * THE ENGINE — the only module in this feature that reads the database.
 *
 * It loads rows, normalises them once, hands them to the pure modules and
 * returns a `CombinedReportPayload`. Everything downstream — the preview, the
 * Word document, the PDF, the workbook — renders that value and is forbidden a
 * database handle, which is what makes "ALL FORMAT TOTALS MUST MATCH" a
 * property of the design rather than a test that has to keep passing.
 *
 * ── WHICH JOBS COUNT AS WORK ───────────────────────────────────────────────
 *
 * `liveWorkOrder` below is the twin of the predicate of the same name in
 * `app/api/workspace/route.ts` and of `countsAsWorkOrder` in
 * `portal-app.tsx` — three exclusions, and all three matter:
 *
 *   · `deleted_at IS NULL`  — a binned job is not work.
 *   · `archived = false`    — a row somebody took off the board.
 *   · `parent_id IS NULL`   — a SUBITEM is a full row of this table whose
 *                             parent is another row. Counting them made one job
 *                             split into three visits read as four work orders
 *                             and summed its parts cost alongside its parent's.
 *
 * It is re-declared here rather than imported because the original is a private
 * const inside a route module. Re-declaring is the smaller evil: importing a
 * route into a library inverts the dependency and drags the whole workspace
 * handler into this bundle. `tests/w9-report-engine.test.mjs` pins the three
 * clauses in both files so they cannot drift apart silently.
 *
 * ── WHY THE PERIOD FILTER IS COARSE IN SQL AND EXACT IN JAVASCRIPT ─────────
 *
 * `requested_at` is TEXT holding naive wall-clock in two shapes on SQLite
 * (`2026-08-03` on 634 imported rows, `2026-08-09 07:39:18` on 142) and a
 * `timestamptz` on Postgres. A comparison that is exactly right in one dialect
 * is subtly wrong in the other — a text `<= '2026-03-31'` drops every row
 * stamped with a time on that day in SQLite, and `substr()` on a `timestamptz`
 * is a runtime error in Postgres.
 *
 * So SQL does a COARSE range with a day of margin at each end, which is what
 * uses `maintenance_org_requested_idx`, and membership is then decided in
 * JavaScript by `dateOnly` — the same function every other part of this feature
 * uses. One rule decides which period a job is in, and no dialect can change
 * the answer.
 */

import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  bankHolidays as bankHolidaysTable,
  contractors,
  maintenanceRequests,
  quotations,
  serviceInvoiceLines,
  serviceInvoices,
  sites as sitesTable,
} from "../../../db/schema";
import { bankHolidayCalendar, DEFAULT_JURISDICTION } from "./bank-holidays";
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
} from "../register-scope";
import { selectInChunks } from "../sql-batching";
import { listHolds, listSlaRules } from "../billing/repository";
import {
  listClientFees,
  listSiteOverrides,
} from "../billing/repository";
import { billingConfiguration, readBillingSettings } from "../billing/settings";
import type {
  CombinedReportPayload,
  InvoiceStatus,
  IsoDate,
  ReportPeriod,
} from "./contract";
import { computeDataQuality } from "./data-quality";
import { listWaivers } from "./waiver-repository";
import { waiverNotesForReport } from "./waivers";
import type {
  ExistingCharge,
  LineDecision,
  ReportJob,
  ReportSite,
} from "./inputs";
import { computeInvoiceSection } from "./invoice-compute";
import { computeMaintenanceSection } from "./maintenance-compute";
import { poundsToPence } from "./money";
import { addDays, dateOnly, previousComparablePeriod } from "./period";

type Database = Awaited<ReturnType<typeof getDb>>;

/** See the header. The twin of `liveWorkOrder` in `app/api/workspace/route.ts`. */
function liveWorkOrder(organisationId: string) {
  return and(
    eq(maintenanceRequests.organisationId, organisationId),
    isNull(maintenanceRequests.deletedAt),
    eq(maintenanceRequests.archived, false),
    isNull(maintenanceRequests.parentId),
  );
}

/**
 * Statuses that still hold a claim on a site's period. Voided ones do not.
 *
 * Drafts are read too, but they arrive marked `committed: false` and only
 * WARN — `ExistingCharge` explains why blocking on a draft made it impossible
 * to raise a second document for a month.
 */
const LIVE_INVOICE_STATUSES: InvoiceStatus[] = [
  "Draft",
  "Ready for Review",
  "Approved",
  "Finalised",
];

/** A decision to charge, as opposed to a document somebody is still writing. */
const COMMITTED_INVOICE_STATUSES = new Set<string>(["Approved", "Finalised"]);

async function loadJobs(
  db: Database,
  organisationId: string,
  period: ReportPeriod,
): Promise<Array<typeof maintenanceRequests.$inferSelect>> {
  const rows = await db
    .select()
    .from(maintenanceRequests)
    .where(
      and(
        liveWorkOrder(organisationId),
        // Coarse, with a day of margin either side. See the header.
        gte(maintenanceRequests.requestedAt, addDays(period.start, -1)),
        lt(maintenanceRequests.requestedAt, addDays(period.end, 2)),
      ),
    )
    .orderBy(asc(maintenanceRequests.requestedAt));
  // Exact membership, decided once, by the same rule everywhere.
  return rows.filter((row) => {
    const raised = dateOnly(row.requestedAt);
    return raised !== null && raised >= period.start && raised <= period.end;
  });
}

async function loadApprovedQuotes(
  db: Database,
  organisationId: string,
  requestIds: readonly string[],
): Promise<Map<string, number>> {
  if (requestIds.length === 0) return new Map();
  const rows = await selectInChunks(requestIds, (chunk) =>
    db
      .select({
        requestId: quotations.requestId,
        amount: quotations.amount,
        approvedAt: quotations.approvedAt,
      })
      .from(quotations)
      .where(
        and(
          eq(quotations.organisationId, organisationId),
          inArray(quotations.requestId, chunk),
        ),
      ),
  );
  const latest = new Map<string, { amount: number; approvedAt: string }>();
  for (const row of rows) {
    // Only an APPROVED quote is a commitment. A quote awaiting approval is a
    // price somebody sent, and putting it in a spend total would report money
    // nobody has agreed to.
    if (!row.approvedAt) continue;
    const held = latest.get(row.requestId);
    if (!held || row.approvedAt > held.approvedAt) {
      latest.set(row.requestId, { amount: row.amount, approvedAt: row.approvedAt });
    }
  }
  const quotes = new Map<string, number>();
  for (const [requestId, entry] of latest) {
    const pence = poundsToPence(entry.amount);
    if (pence !== null) quotes.set(requestId, pence);
  }
  return quotes;
}

async function loadExistingCharges(
  db: Database,
  organisationId: string,
  excludeInvoiceId: string | null,
): Promise<ExistingCharge[]> {
  const rows = await db
    .select({
      siteId: serviceInvoiceLines.siteId,
      invoiceId: serviceInvoices.id,
      invoiceNumber: serviceInvoices.invoiceNumber,
      status: serviceInvoices.status,
      periodStart: serviceInvoices.periodStart,
      periodEnd: serviceInvoices.periodEnd,
      included: serviceInvoiceLines.included,
    })
    .from(serviceInvoiceLines)
    .innerJoin(serviceInvoices, eq(serviceInvoices.id, serviceInvoiceLines.invoiceId))
    .where(
      and(
        eq(serviceInvoiceLines.organisationId, organisationId),
        inArray(serviceInvoices.status, LIVE_INVOICE_STATUSES),
      ),
    );
  return rows
    .filter((row) => row.siteId !== null && row.included && row.invoiceId !== excludeInvoiceId)
    .map((row) => ({
      siteId: row.siteId as string,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      status: row.status,
      committed: COMMITTED_INVOICE_STATUSES.has(row.status),
      periodStart: dateOnly(row.periodStart) ?? row.periodStart,
      periodEnd: dateOnly(row.periodEnd) ?? row.periodEnd,
    }));
}

function toReportSite(row: typeof sitesTable.$inferSelect): ReportSite {
  return {
    id: row.id,
    name: row.name,
    reference: row.code ?? null,
    status: row.status,
    active: Boolean(row.active),
    billable: Boolean(row.billable),
    billingActiveFrom: dateOnly(row.billingActiveFrom),
    billingActiveTo: dateOnly(row.billingActiveTo),
  };
}

function toReportJob(
  row: typeof maintenanceRequests.$inferSelect,
  siteNames: Map<string, string>,
  contractorNames: Map<string, string>,
  quotes: Map<string, number>,
): ReportJob {
  const rawCost = row.cost;
  const costPence = poundsToPence(rawCost);
  return {
    id: row.id,
    reference: row.reference ?? null,
    title: row.title,
    description: row.description,
    siteId: row.siteId ?? null,
    siteName: row.siteId ? siteNames.get(row.siteId) ?? "" : "",
    recordedSiteName: row.location || null,
    status: row.status,
    stage: row.stage,
    priority: row.priority,
    tier: row.tier,
    /*
     * The board has ONE categorisation column — monday's "Label", which
     * `request-fields.ts` maps to `maintenance_requests.category`. It is
     * therefore both the SLA classification and the job type; there is no
     * second column to read and inventing a distinction between them would put
     * two headings over one fact. When a separate type column exists, it maps
     * to `jobType` here and nothing else changes.
     */
    classification: row.category || null,
    jobType: row.category || null,
    contractor: row.contractor ?? null,
    contractorId: row.contractorId ?? null,
    contractorRegisterName: row.contractorId
      ? contractorNames.get(row.contractorId) ?? null
      : null,
    assignee: row.assignee ?? null,
    requester: row.requester || null,
    requestedOn: dateOnly(row.requestedAt),
    targetOn: dateOnly(row.dueAt),
    completedOn: dateOnly(row.completedAt),
    costPence,
    costInvalid: rawCost !== null && rawCost !== undefined && costPence === null,
    approvedQuotePence: quotes.get(row.id) ?? null,
    invoice: row.invoice ?? null,
    approvedBy: row.approvedBy ?? null,
    notes: row.completionNote ?? null,
    blockedReason: row.blockedReason ?? null,
    nextUpdateOn: dateOnly(row.nextUpdateAt),
  };
}

export interface ComputeReportInput {
  db: Database;
  organisationId: string;
  organisationName: string;
  period: ReportPeriod;
  /** Today, as a UTC calendar date. Supplied so the engine never reads a clock. */
  todayIso: IsoDate;
  /** The document being computed, when there is one. Excluded from duplicates. */
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  status?: InvoiceStatus;
  header?: Partial<{
    invoiceDate: string | null;
    dueAt: string | null;
    billingAddress: string | null;
    clientReference: string | null;
    purchaseOrder: string | null;
    internalReference: string | null;
    paymentTerms: string | null;
    clientNote: string | null;
    internalNote: string | null;
  }>;
  decisions?: readonly LineDecision[];
  adjustments?: CombinedReportPayload["invoice"]["adjustments"];
}

/**
 * Compute the whole document. Reads; writes nothing.
 *
 * Called by preview, by save-draft, by recalculate and by finalise. Finalise
 * serialises what this returns into `report_snapshots.payload`, and every read
 * after that returns the snapshot rather than calling this again — which is
 * what stops a fee edited in April restating an invoice issued in March.
 */
export async function computeReport(
  input: ComputeReportInput,
): Promise<CombinedReportPayload> {
  const { db, organisationId, period } = input;
  const previousPeriod = previousComparablePeriod(period);

  const settingsRow = await readBillingSettings(db, organisationId);
  const config = billingConfiguration(settingsRow);

  const siteRows = await db
    .select()
    .from(sitesTable)
    .where(
      and(
        eq(sitesTable.organisationId, organisationId),
        // The canonical Sites register, not every instance — a section created
        // from the Sites template is a separate register and its rows are not
        // this organisation's billable estate.
        registerScopeFilter(sitesTable.boardId, CANONICAL_REGISTER),
      ),
    )
    .orderBy(asc(sitesTable.position), asc(sitesTable.name));
  const sites = siteRows.map(toReportSite);
  const siteNames = new Map(siteRows.map((row) => [row.id, row.name]));

  const [jobRows, previousJobRows] = await Promise.all([
    loadJobs(db, organisationId, period),
    loadJobs(db, organisationId, previousPeriod),
  ]);

  const contractorIds = [
    ...new Set(
      [...jobRows, ...previousJobRows]
        .map((row) => row.contractorId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const contractorRows = contractorIds.length
    ? await selectInChunks(contractorIds, (chunk) =>
        db
          .select({ id: contractors.id, name: contractors.name })
          .from(contractors)
          .where(
            and(
              eq(contractors.organisationId, organisationId),
              inArray(contractors.id, chunk),
            ),
          ),
      )
    : [];
  const contractorNames = new Map(contractorRows.map((row) => [row.id, row.name]));

  const jobIds = jobRows.map((row) => row.id);
  const [
    quotes,
    previousQuotes,
    holds,
    slaRules,
    clientFees,
    siteOverrides,
    existingCharges,
    holidayRows,
  ] = await Promise.all([
    loadApprovedQuotes(db, organisationId, jobIds),
    loadApprovedQuotes(db, organisationId, previousJobRows.map((row) => row.id)),
    listHolds(db, organisationId, jobIds),
    listSlaRules(db, organisationId),
    listClientFees(db, organisationId),
    listSiteOverrides(db, organisationId),
    loadExistingCharges(db, organisationId, input.invoiceId ?? null),
    /*
     * The holiday calendar, read WHOLE rather than filtered to the period.
     *
     * A hold, an open job's age and the previous period's comparison all reach
     * outside the reporting window, so a set trimmed to the period would give a
     * different answer depending on which of those was asking. Forty rows is
     * cheaper than being subtly wrong at the edges. Not organisation-scoped: a
     * bank holiday is a fact about the country, not about a tenant.
     */
    db.select().from(bankHolidaysTable).where(eq(bankHolidaysTable.jurisdiction, DEFAULT_JURISDICTION)),
  ]);
  const holidayCalendar = bankHolidayCalendar(holidayRows, DEFAULT_JURISDICTION);

  const jobs = jobRows.map((row) => toReportJob(row, siteNames, contractorNames, quotes));
  const previousJobs = previousJobRows.map((row) =>
    toReportJob(row, siteNames, contractorNames, previousQuotes),
  );

  const invoice = computeInvoiceSection({
    period,
    clientName: input.organisationName,
    config,
    sites,
    clientFees,
    siteOverrides,
    existingCharges,
    decisions: input.decisions ?? [],
    adjustments: input.adjustments ?? [],
    header: {
      invoiceId: input.invoiceId ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      status: input.status ?? "Draft",
      invoiceDate: input.header?.invoiceDate ?? input.todayIso,
      dueAt:
        input.header?.dueAt ??
        addDays(input.header?.invoiceDate ?? input.todayIso, config.paymentTermsDays),
      billingAddress: input.header?.billingAddress ?? null,
      clientReference: input.header?.clientReference ?? null,
      purchaseOrder: input.header?.purchaseOrder ?? null,
      internalReference: input.header?.internalReference ?? null,
      paymentTerms:
        input.header?.paymentTerms ??
        config.paymentTermsNote ??
        `Payment due within ${config.paymentTermsDays} days.`,
      clientNote: input.header?.clientNote ?? null,
      internalNote: input.header?.internalNote ?? null,
    },
  });

  const dataQuality = computeDataQuality({
    period,
    jobs,
    sites,
    holds,
    slaRules,
    invoiceLines: invoice.lines,
    existingCharges,
    vatEnabled: config.vatEnabled,
    vatNumber: config.vatNumber,
    vatRateBasisPoints: config.vatRateBasisPoints,
    defaultSiteFeePence: config.defaultSiteFeePence,
  });

  /*
   * WAIVED ISSUES ARE PRINTED, NOT MERELY STORED.
   *
   * Module 4 §6 requires the waiver, its reason, its author and its timestamp
   * to appear "in the report's data quality notes", and §10 makes it an
   * acceptance criterion. A waiver that lives only in a table is an override
   * with no trace on the document a client and an auditor actually read —
   * which is most of the reason the waiver mechanism was allowed to exist at
   * all.
   *
   * They are appended as `info` findings rather than given a section of their
   * own, so every renderer already carries them: the live preview, the Word
   * export, the PDF and the workbook all draw `dataQuality` and none of them
   * needed changing. An `info` severity is right — a recorded waiver is a note,
   * not a fault, and it must not re-block the finalisation it was granted for.
   */
  const waiverNotes = waiverNotesForReport(
    /*
     * No document, no waivers — and no query. A preview that has not been saved
     * has nothing to have waived, and asking with an empty id is a round trip
     * that can never match. `loadWaivedIssueKeys` short-circuits the same way.
     */
    (input.invoiceId ? await listWaivers(db, organisationId, input.invoiceId) : []).map((waiver) => ({
      issueCode: waiver.issueCode,
      subjectId: waiver.subjectId,
      reason: waiver.reason,
      waivedByEmail: waiver.waivedByEmail,
      waivedAt: waiver.waivedAt,
      revokedAt: null,
    })),
  );
  for (const note of waiverNotes) {
    dataQuality.push({
      severity: "info",
      code: "data.issue_waived",
      message: note,
      entityType: "invoice",
      entityId: input.invoiceId ?? null,
      href: null,
    });
  }

  const maintenance = computeMaintenanceSection({
    period,
    previousPeriod,
    // The measurement is taken as at the end of the period, or today when the
    // period has not ended yet — a report for "this month" must not claim a job
    // has been open for the whole month on the 3rd.
    asOf: input.todayIso < period.end ? input.todayIso : period.end,
    jobs,
    previousJobs,
    sites,
    holds,
    slaRules,
    invoiceTotals: invoice.totals,
    bankHolidays: holidayCalendar,
    invoiceLines: invoice.lines,
    dataQuality,
    currency: config.currency,
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    organisationId,
    organisationName: input.organisationName,
    period,
    previousPeriod,
    invoice,
    maintenance,
  };
}
