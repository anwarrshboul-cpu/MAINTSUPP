/**
 * THE DOCUMENT — saved, recalculated, approved, finalised, voided.
 *
 * ── WHAT FINALISATION ACTUALLY DOES ────────────────────────────────────────
 *
 * Three things, in this order, and the order is the point:
 *
 *   1. issue an invoice number from `billing_settings.invoice_sequence`, by
 *      compare-and-swap (`issueInvoiceNumber`);
 *   2. write the computed `CombinedReportPayload` verbatim into
 *      `report_snapshots.payload`;
 *   3. move the status to Finalised and stamp who and when.
 *
 * After that, `documentPayload()` returns the SNAPSHOT and never recomputes. A
 * fee edited in April cannot restate an invoice issued in March, because the
 * March document is no longer a query — it is a value that was written down.
 * `tests/w9-report-documents.test.mjs` proves exactly that: finalise, change a
 * fee, re-read, and require the totals not to have moved.
 *
 * ── WHY THE LINES ARE STORED AS WELL AS THE SNAPSHOT ───────────────────────
 *
 * `service_invoice_lines` is not a duplicate of the snapshot. It carries the
 * operator's DECISIONS — which sites were excluded, by whom, and why — and
 * those have to survive a recalculation. `recalculate` therefore reads the
 * decisions off the existing lines, recomputes, and re-applies them, so
 * pressing Recalculate does not silently re-include a site somebody removed on
 * purpose.
 *
 * It is also the enforcement point for "the same site cannot be charged twice
 * on one invoice": the partial UNIQUE index on `(invoice_id, site_id)`. Across
 * two invoices that is not a constraint the database can hold — two invoices
 * for two periods are legitimate — so that one is the validator's, in
 * `invoice-compute.ts`.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  invoiceApprovals,
  invoiceExports,
  reportSnapshots,
  serviceInvoiceLines,
  serviceInvoices,
} from "../../../db/schema";
import { chunkRows } from "../sql-batching";
import { listAdjustments, listSlaRules, slaRulesVersion } from "../billing/repository";
import { issueInvoiceNumber } from "../billing/settings";
import { canTransition } from "./access";
import type {
  CombinedReportPayload,
  DocumentListRow,
  ExportFormat,
  InvoiceStatus,
  IsoDate,
  ReportPeriod,
} from "./contract";
import { computeReport } from "./engine";
import type { LineDecision } from "./inputs";
import { dateOnly } from "./period";

type Database = Awaited<ReturnType<typeof getDb>>;

export type ServiceInvoiceRow = typeof serviceInvoices.$inferSelect;

const COLUMNS_PER_LINE = 24;

function isStatus(value: string): value is InvoiceStatus {
  return (
    value === "Draft" ||
    value === "Ready for Review" ||
    value === "Approved" ||
    value === "Finalised" ||
    value === "Voided"
  );
}

export function documentStatus(row: ServiceInvoiceRow): InvoiceStatus {
  return isStatus(row.status) ? row.status : "Draft";
}

/** The period a stored document describes, rebuilt from its own columns. */
export function documentPeriod(row: ServiceInvoiceRow): ReportPeriod {
  const start = dateOnly(row.periodStart) ?? row.periodStart;
  const end = dateOnly(row.periodEnd) ?? row.periodEnd;
  const wholeMonth =
    start.slice(8) === "01" &&
    start.slice(0, 7) === end.slice(0, 7) &&
    end === new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0))
      .toISOString()
      .slice(0, 10);
  return {
    start,
    end,
    label: `${start} to ${end}`,
    partialMonth: !wholeMonth,
  };
}

/* --------------------------------------------------------------- reading -- */

export async function readInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<ServiceInvoiceRow | null> {
  const rows = await db
    .select()
    .from(serviceInvoices)
    .where(
      and(eq(serviceInvoices.organisationId, organisationId), eq(serviceInvoices.id, invoiceId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The operator's own inclusion decisions, read off the stored lines.
 *
 * Only lines carrying an `excluded_by_email` count. A line excluded because the
 * site is closed is a COMPUTED exclusion and must be recomputed, not preserved:
 * if the site reopens, the invoice should include it again.
 */
export async function readLineDecisions(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<LineDecision[]> {
  const rows = await db
    .select()
    .from(serviceInvoiceLines)
    .where(
      and(
        eq(serviceInvoiceLines.organisationId, organisationId),
        eq(serviceInvoiceLines.invoiceId, invoiceId),
      ),
    );
  return rows
    .filter((row) => row.siteId !== null && row.excludedByEmail !== null)
    .map((row) => ({
      siteId: row.siteId as string,
      included: Boolean(row.included),
      reason: row.exclusionReason ?? null,
      byEmail: row.excludedByEmail ?? null,
      at: row.excludedAt ?? null,
    }));
}

export async function readSnapshot(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<CombinedReportPayload | null> {
  const rows = await db
    .select()
    .from(reportSnapshots)
    .where(
      and(
        eq(reportSnapshots.organisationId, organisationId),
        eq(reportSnapshots.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(reportSnapshots.createdAt))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].payload) as CombinedReportPayload;
  } catch {
    /* An unreadable snapshot is a fault, not a licence to recompute: silently
       falling back would present today's numbers as the ones that were
       approved. The caller turns null into an error the reader can act on. */
    return null;
  }
}

/**
 * The payload for a document: the SNAPSHOT once finalised, a recomputation
 * before. This is the function that makes a finalised document immutable, and
 * it is the only one any read path may call.
 */
export async function documentPayload(
  db: Database,
  input: {
    organisationId: string;
    organisationName: string;
    invoice: ServiceInvoiceRow;
    todayIso: IsoDate;
  },
): Promise<{ payload: CombinedReportPayload; fromSnapshot: boolean } | { error: string }> {
  const status = documentStatus(input.invoice);
  if (status === "Finalised" || status === "Voided") {
    const snapshot = await readSnapshot(db, input.organisationId, input.invoice.id);
    if (!snapshot) {
      return {
        error:
          "This document is finalised but its stored snapshot cannot be read. It must not be recomputed — the figures would not be the ones that were approved.",
      };
    }
    return { payload: snapshot, fromSnapshot: true };
  }

  const payload = await computeReport({
    db,
    organisationId: input.organisationId,
    organisationName: input.organisationName,
    period: documentPeriod(input.invoice),
    todayIso: input.todayIso,
    invoiceId: input.invoice.id,
    invoiceNumber: input.invoice.invoiceNumber,
    status,
    header: {
      invoiceDate: input.invoice.invoiceDate,
      dueAt: input.invoice.dueAt,
      billingAddress: input.invoice.billingAddress,
      clientReference: input.invoice.clientReference,
      purchaseOrder: input.invoice.purchaseOrder,
      internalReference: input.invoice.internalReference,
      paymentTerms: input.invoice.paymentTerms,
      clientNote: input.invoice.clientNote,
      internalNote: input.invoice.internalNote,
    },
    decisions: await readLineDecisions(db, input.organisationId, input.invoice.id),
    adjustments: await listAdjustments(db, input.organisationId, input.invoice.id),
  });
  return { payload, fromSnapshot: false };
}

export async function listDocuments(
  db: Database,
  organisationId: string,
  statuses: readonly InvoiceStatus[],
): Promise<DocumentListRow[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select()
    .from(serviceInvoices)
    .where(
      and(
        eq(serviceInvoices.organisationId, organisationId),
        inArray(serviceInvoices.status, [...statuses]),
      ),
    )
    .orderBy(desc(serviceInvoices.createdAt));

  const exportRows = rows.length
    ? await db
        .select({ invoiceId: invoiceExports.invoiceId, format: invoiceExports.format })
        .from(invoiceExports)
        .where(eq(invoiceExports.organisationId, organisationId))
    : [];
  const formats = new Map<string, Set<ExportFormat>>();
  for (const row of exportRows) {
    if (row.format !== "docx" && row.format !== "pdf" && row.format !== "xlsx") continue;
    const set = formats.get(row.invoiceId) ?? new Set<ExportFormat>();
    set.add(row.format);
    formats.set(row.invoiceId, set);
  }

  return rows.map((row) => ({
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    clientName: "",
    period: documentPeriod(row),
    invoiceDate: dateOnly(row.invoiceDate),
    dueAt: dateOnly(row.dueAt),
    activeSitesBilled: row.billableSiteCount,
    invoiceTotalPence: row.totalPence,
    maintenanceSpendPence: row.maintenanceSpendPence,
    status: documentStatus(row),
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt,
    approvedByEmail: row.approvedByEmail,
    finalisedAt: row.finalisedAt,
    formats: [...(formats.get(row.id) ?? [])].sort(),
  }));
}

/* --------------------------------------------------------------- writing -- */

/**
 * Write the computed totals and lines onto a stored document.
 *
 * The lines are REPLACED, not merged. They are derived from the payload, the
 * payload is derived from the estate, and a merge would leave a line for a site
 * that has since been removed from the register — a charge with nothing behind
 * it. The operator's decisions survive because they are read BEFORE the
 * recomputation and passed into it, not because the old rows are kept.
 */
export async function persistComputed(
  db: Database,
  organisationId: string,
  invoiceId: string,
  payload: CombinedReportPayload,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(serviceInvoices)
    .set({
      currency: payload.invoice.currency,
      vatEnabled: payload.invoice.vatEnabled,
      vatRateBasisPoints: payload.invoice.vatRateBasisPoints,
      billingAddress: payload.invoice.billingAddress,
      paymentTerms: payload.invoice.paymentTerms,
      billableSiteCount: payload.invoice.totals.includedSites,
      subtotalPence: payload.invoice.totals.subtotalPence,
      vatPence: payload.invoice.totals.vatPence,
      adjustmentPence: payload.invoice.totals.adjustmentPence,
      creditPence: payload.invoice.totals.creditPence,
      totalPence: payload.invoice.totals.totalPence,
      maintenanceSpendPence: payload.maintenance.spend.completedMaintenancePence,
      updatedAt: now,
    })
    .where(
      and(eq(serviceInvoices.organisationId, organisationId), eq(serviceInvoices.id, invoiceId)),
    );

  await db
    .delete(serviceInvoiceLines)
    .where(
      and(
        eq(serviceInvoiceLines.organisationId, organisationId),
        eq(serviceInvoiceLines.invoiceId, invoiceId),
      ),
    );

  const values = payload.invoice.lines.map((line) => ({
    id: crypto.randomUUID(),
    organisationId,
    invoiceId,
    lineNo: line.lineNo,
    siteId: line.siteId,
    siteName: line.siteName,
    siteReference: line.siteReference,
    description: `Fixed service fee, ${payload.period.start} to ${payload.period.end}`,
    periodStart: payload.period.start,
    periodEnd: payload.period.end,
    quantity: 1,
    feePence: line.feePence,
    feeSource: line.feeSource,
    feeRecordId: line.feeRecordId,
    vatRateBasisPoints: line.vatRateBasisPoints,
    lineSubtotalPence: line.lineSubtotalPence,
    lineVatPence: line.lineVatPence,
    lineTotalPence: line.lineTotalPence,
    included: line.included,
    exclusionReason: line.exclusionReason,
    excludedByEmail: line.excludedByEmail,
    excludedAt: line.excludedAt,
    validation: line.validation.length ? JSON.stringify(line.validation) : null,
    createdAt: now,
  }));

  // D1 binds one variable per COLUMN per row, so a 24-column insert of 31 sites
  // is 744 variables against a ~100 floor. `chunkRows` divides the budget by
  // the row width; see `app/lib/sql-batching.ts`.
  for (const chunk of chunkRows(values, COLUMNS_PER_LINE)) {
    await db.insert(serviceInvoiceLines).values(chunk);
  }
}

export interface CreateDraftInput {
  organisationId: string;
  organisationName: string;
  period: ReportPeriod;
  todayIso: IsoDate;
  actorEmail: string | null;
  actorUserId: string | null;
  header?: {
    invoiceDate?: string | null;
    dueAt?: string | null;
    purchaseOrder?: string | null;
    clientReference?: string | null;
    internalReference?: string | null;
    clientNote?: string | null;
    internalNote?: string | null;
  };
}

export async function createDraft(
  db: Database,
  input: CreateDraftInput,
): Promise<{ invoiceId: string; payload: CombinedReportPayload }> {
  const payload = await computeReport({
    db,
    organisationId: input.organisationId,
    organisationName: input.organisationName,
    period: input.period,
    todayIso: input.todayIso,
    invoiceId: null,
    status: "Draft",
    header: {
      invoiceDate: input.header?.invoiceDate ?? input.todayIso,
      dueAt: input.header?.dueAt ?? null,
      purchaseOrder: input.header?.purchaseOrder ?? null,
      clientReference: input.header?.clientReference ?? null,
      internalReference: input.header?.internalReference ?? null,
      clientNote: input.header?.clientNote ?? null,
      internalNote: input.header?.internalNote ?? null,
    },
  });

  const invoiceId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(serviceInvoices).values({
    id: invoiceId,
    organisationId: input.organisationId,
    invoiceNumber: null,
    status: "Draft",
    periodStart: input.period.start,
    periodEnd: input.period.end,
    invoiceDate: payload.invoice.invoiceDate,
    dueAt: payload.invoice.dueAt,
    currency: payload.invoice.currency,
    vatEnabled: payload.invoice.vatEnabled,
    vatRateBasisPoints: payload.invoice.vatRateBasisPoints,
    purchaseOrder: payload.invoice.purchaseOrder,
    clientReference: payload.invoice.clientReference,
    internalReference: payload.invoice.internalReference,
    paymentTerms: payload.invoice.paymentTerms,
    clientNote: payload.invoice.clientNote,
    internalNote: payload.invoice.internalNote,
    billingAddress: payload.invoice.billingAddress,
    createdByEmail: input.actorEmail,
    createdByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });

  // The payload was computed before the row existed, so its `invoiceId` is
  // null. Re-point it rather than recomputing: recomputing would read the
  // estate a second time and could produce a different document from the one
  // whose totals were just written.
  const stamped: CombinedReportPayload = {
    ...payload,
    invoice: { ...payload.invoice, invoiceId },
  };
  await persistComputed(db, input.organisationId, invoiceId, stamped);
  await recordTransition(db, {
    organisationId: input.organisationId,
    invoiceId,
    action: "created",
    fromStatus: null,
    toStatus: "Draft",
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: null,
  });
  return { invoiceId, payload: stamped };
}

/* ------------------------------------------------------------- workflow -- */

export async function recordTransition(
  db: Database,
  input: {
    organisationId: string;
    invoiceId: string;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorEmail: string | null;
    actorUserId: string | null;
    reason: string | null;
  },
): Promise<void> {
  await db.insert(invoiceApprovals).values({
    id: crypto.randomUUID(),
    organisationId: input.organisationId,
    invoiceId: input.invoiceId,
    action: input.action,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  });
}

export async function listTransitions(
  db: Database,
  organisationId: string,
  invoiceId: string,
) {
  return db
    .select()
    .from(invoiceApprovals)
    .where(
      and(
        eq(invoiceApprovals.organisationId, organisationId),
        eq(invoiceApprovals.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceApprovals.createdAt));
}

export type TransitionResult =
  | { ok: true; status: InvoiceStatus; invoiceNumber?: string | null }
  | { ok: false; status: number; error: string };

/** Move a document between states. A transition not in the table is refused. */
export async function moveStatus(
  db: Database,
  input: {
    organisationId: string;
    invoice: ServiceInvoiceRow;
    to: InvoiceStatus;
    action: string;
    actorEmail: string | null;
    actorUserId: string | null;
    reason: string | null;
  },
): Promise<TransitionResult> {
  const from = documentStatus(input.invoice);
  if (!canTransition(from, input.to)) {
    return {
      ok: false,
      status: 409,
      error: `A ${from} document cannot move to ${input.to}.`,
    };
  }
  const now = new Date().toISOString();
  const patch: Partial<typeof serviceInvoices.$inferInsert> = {
    status: input.to,
    updatedAt: now,
  };
  if (input.to === "Approved") {
    patch.approvedByEmail = input.actorEmail;
    patch.approvedAt = now;
  }
  if (input.to === "Voided") {
    patch.voidedByEmail = input.actorEmail;
    patch.voidedAt = now;
    patch.voidReason = input.reason;
  }
  await db
    .update(serviceInvoices)
    .set(patch)
    .where(
      and(
        eq(serviceInvoices.organisationId, input.organisationId),
        eq(serviceInvoices.id, input.invoice.id),
      ),
    );
  await recordTransition(db, {
    organisationId: input.organisationId,
    invoiceId: input.invoice.id,
    action: input.action,
    fromStatus: from,
    toStatus: input.to,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
  return { ok: true, status: input.to };
}

/**
 * Finalise: issue the number, freeze the payload, lock the financials.
 *
 * The caller has already checked the blockers. This performs the three steps in
 * the order the header states and records the transition. It does NOT re-check
 * the blockers, because the payload it is handed is the one that was checked —
 * re-deriving it here would open the gap between "what was validated" and "what
 * was frozen" that the whole snapshot design exists to close.
 */
export async function finaliseDocument(
  db: Database,
  input: {
    organisationId: string;
    invoice: ServiceInvoiceRow;
    payload: CombinedReportPayload;
    actorEmail: string | null;
    actorUserId: string | null;
  },
): Promise<TransitionResult> {
  const from = documentStatus(input.invoice);
  if (!canTransition(from, "Finalised")) {
    return { ok: false, status: 409, error: `A ${from} document cannot be finalised.` };
  }

  let invoiceNumber: string;
  try {
    invoiceNumber = await issueInvoiceNumber(db, input.organisationId);
  } catch {
    return {
      ok: false,
      status: 503,
      error: "An invoice number could not be issued. Nothing has been finalised; try again.",
    };
  }

  const rules = await listSlaRules(db, input.organisationId);
  const now = new Date().toISOString();
  const frozen: CombinedReportPayload = {
    ...input.payload,
    invoice: {
      ...input.payload.invoice,
      invoiceId: input.invoice.id,
      invoiceNumber,
      status: "Finalised",
    },
  };

  await db.insert(reportSnapshots).values({
    id: crypto.randomUUID(),
    organisationId: input.organisationId,
    invoiceId: input.invoice.id,
    payload: JSON.stringify(frozen),
    slaRulesVersion: slaRulesVersion(rules),
    jobIds: JSON.stringify(
      frozen.maintenance.jobLog.flatMap((group) => group.rows.map((row) => row.requestId)),
    ),
    siteIds: JSON.stringify(frozen.invoice.lines.map((line) => line.siteId)),
    feeIds: JSON.stringify(frozen.invoice.lines.map((line) => line.feeRecordId)),
    createdByEmail: input.actorEmail,
    createdAt: now,
  });

  await db
    .update(serviceInvoices)
    .set({
      status: "Finalised",
      invoiceNumber,
      finalisedByEmail: input.actorEmail,
      finalisedAt: now,
      subtotalPence: frozen.invoice.totals.subtotalPence,
      vatPence: frozen.invoice.totals.vatPence,
      adjustmentPence: frozen.invoice.totals.adjustmentPence,
      creditPence: frozen.invoice.totals.creditPence,
      totalPence: frozen.invoice.totals.totalPence,
      billableSiteCount: frozen.invoice.totals.includedSites,
      maintenanceSpendPence: frozen.maintenance.spend.completedMaintenancePence,
      updatedAt: now,
    })
    .where(
      and(
        eq(serviceInvoices.organisationId, input.organisationId),
        eq(serviceInvoices.id, input.invoice.id),
      ),
    );

  await recordTransition(db, {
    organisationId: input.organisationId,
    invoiceId: input.invoice.id,
    action: "finalised",
    fromStatus: from,
    toStatus: "Finalised",
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: null,
  });

  return { ok: true, status: "Finalised", invoiceNumber };
}
