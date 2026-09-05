/**
 * `/api/reports/documents/[id]` — read one document, or edit its header.
 *
 * ── GET RETURNS THE SNAPSHOT ONCE FINALISED ────────────────────────────────
 *
 * `documentPayload()` decides: a Finalised or Voided document is served from
 * `report_snapshots`, anything earlier is recomputed. That is what makes a
 * finalised invoice immutable — a fee edited in April cannot restate an invoice
 * issued in March, because the March document is a value that was written down
 * rather than a query that happens to return the same answer.
 *
 * A finalised document whose snapshot cannot be read is an ERROR, not a licence
 * to recompute. Falling back would present today's numbers as the ones that
 * were approved, which is precisely the failure the snapshot exists to prevent.
 *
 * ── PATCH IS THE HEADER ONLY ───────────────────────────────────────────────
 *
 * Dates, references, notes and the VAT toggle. It cannot change a fee, a line
 * or a total — those are computed. It refuses outright once the document is
 * Finalised or Voided: the financials are locked, and "locked" has to mean the
 * API refuses, not that the form is disabled.
 */

import { and, eq } from "drizzle-orm";
import {
  invoiceAdjustments,
  invoiceApprovals,
  invoiceExports,
  reportSnapshots,
  serviceInvoiceLines,
  serviceInvoices,
} from "../../../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../../../lib/audit";
import { listAdjustments } from "../../../../lib/billing/repository";
import { REPORT_CAPABILITIES } from "../../../../lib/reporting/access";
import { draftWarnings, finalisationBlockers } from "../../../../lib/reporting/blockers";
import { loadWaivedIssueKeys } from "../../../../lib/reporting/waiver-repository";
import {
  documentPayload,
  documentStatus,
  listTransitions,
  persistComputed,
  readInvoice,
} from "../../../../lib/reporting/documents";
import { dateOnly } from "../../../../lib/reporting/period";
import {
  badRequest,
  guard,
  notFound,
  reportUnavailable,
  text,
  todayIso,
  visibleStatuses,
} from "../../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.read"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    /* Waived data issues stop being blockers; a revoked waiver puts the block back. */
    const waivedIssueKeys = await loadWaivedIssueKeys(scope.db, scope.orgId, id);

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();

    /* The Viewer narrowing, enforced here as well as in the list. A draft's id
       guessed by hand must not open a document with figures nobody approved. */
    const statuses = await visibleStatuses(scope);
    if (!statuses.includes(documentStatus(invoice))) return notFound();

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });

    return Response.json({
      document: invoice,
      payload: result.payload,
      fromSnapshot: result.fromSnapshot,
      blockers: finalisationBlockers({
          waivedIssueKeys,
        payload: result.payload,
        confirmedPartialPeriod: false,
        requireApproval: true,
      }),
      warnings: draftWarnings(result.payload),
      history: await listTransitions(scope.db, scope.orgId, id),
      adjustments: await listAdjustments(scope.db, scope.orgId, id),
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.edit"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    /* Waived data issues stop being blockers; a revoked waiver puts the block back. */
    const waivedIssueKeys = await loadWaivedIssueKeys(scope.db, scope.orgId, id);

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (status === "Finalised" || status === "Voided") {
      return Response.json(
        { error: `A ${status} document is locked and cannot be edited.` },
        { status: 409 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const patch: Partial<typeof serviceInvoices.$inferInsert> = {};
    if ("invoiceDate" in body) {
      const value = body.invoiceDate === null ? null : dateOnly(String(body.invoiceDate));
      if (body.invoiceDate !== null && !value) return badRequest("The invoice date must be YYYY-MM-DD.");
      patch.invoiceDate = value;
    }
    if ("dueAt" in body) {
      const value = body.dueAt === null ? null : dateOnly(String(body.dueAt));
      if (body.dueAt !== null && !value) return badRequest("The due date must be YYYY-MM-DD.");
      patch.dueAt = value;
    }
    if ("periodStart" in body || "periodEnd" in body) {
      const start = dateOnly(String(body.periodStart ?? invoice.periodStart));
      const end = dateOnly(String(body.periodEnd ?? invoice.periodEnd));
      if (!start || !end) return badRequest("The service period dates must be YYYY-MM-DD.");
      if (start > end) return badRequest("The service period starts after it ends.");
      patch.periodStart = start;
      patch.periodEnd = end;
    }
    if ("purchaseOrder" in body) patch.purchaseOrder = text(body.purchaseOrder, 120);
    if ("clientReference" in body) patch.clientReference = text(body.clientReference, 120);
    if ("internalReference" in body) patch.internalReference = text(body.internalReference, 120);
    if ("paymentTerms" in body) patch.paymentTerms = text(body.paymentTerms, 400);
    if ("clientNote" in body) patch.clientNote = text(body.clientNote, 2000);
    if ("internalNote" in body) patch.internalNote = text(body.internalNote, 2000);
    if ("billingAddress" in body) patch.billingAddress = text(body.billingAddress, 600);

    if (Object.keys(patch).length === 0) return badRequest("Nothing to change.");
    patch.updatedAt = new Date().toISOString();

    await scope.db
      .update(serviceInvoices)
      .set(patch)
      .where(and(eq(serviceInvoices.organisationId, scope.orgId), eq(serviceInvoices.id, id)));

    /* Changing the period changes the whole document, so it is recomputed and
       re-persisted rather than left showing the old lines under new dates. */
    const updated = await readInvoice(scope.db, scope.orgId, id);
    if (!updated) return notFound();
    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice: updated,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });
    await persistComputed(scope.db, scope.orgId, id, result.payload);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.dates_changed",
      entityType: "service_invoice",
      entityId: id,
      summary: `Edited the document header (${Object.keys(patch).filter((key) => key !== "updatedAt").join(", ")}).`,
      detail: changeDetail(
        invoice as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
      ),
      request,
    });

    return Response.json({
      document: updated,
      payload: result.payload,
      blockers: finalisationBlockers({
          waivedIssueKeys,
        payload: result.payload,
        confirmedPartialPeriod: false,
        requireApproval: true,
      }),
      warnings: draftWarnings(result.payload),
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

/**
 * Permanently remove a WORKING document. Draft and Ready for Review only.
 *
 * ── WHY THIS EXISTS AND WHY IT IS SO NARROW ────────────────────────────────
 *
 * A draft raised for the wrong month is clutter that will one day be mistaken
 * for a record, and there is otherwise no way to be rid of it — void leaves a
 * Voided document behind, which is exactly right for something that was issued
 * and exactly wrong for something that never should have been raised.
 *
 * It refuses on Approved, Finalised and Voided, whatever capability the caller
 * holds. Those three have been through a decision somebody made: a finalised
 * invoice has a number that was issued from a counter and may have been sent,
 * and a voided one is the evidence that it was withdrawn. Void is how a
 * finalised document is undone; deletion is not, and no flag turns it into one.
 *
 * `data.delete` — the capability this codebase withholds from `admin` on
 * purpose, because archiving is reversible and this is not.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.delete"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (status !== "Draft" && status !== "Ready for Review") {
      return Response.json(
        {
          error: `A ${status} document cannot be deleted. Void it instead — a document that was issued must leave a record that it was.`,
        },
        { status: 409 },
      );
    }

    /* Children first, so a failure part way through cannot orphan rows behind a
       parent that no longer exists. Every delete carries the organisation as
       well as the id: an id alone would be enough for the database and is not
       enough for a tenancy boundary. */
    await scope.db
      .delete(serviceInvoiceLines)
      .where(
        and(
          eq(serviceInvoiceLines.organisationId, scope.orgId),
          eq(serviceInvoiceLines.invoiceId, id),
        ),
      );
    await scope.db
      .delete(invoiceAdjustments)
      .where(
        and(
          eq(invoiceAdjustments.organisationId, scope.orgId),
          eq(invoiceAdjustments.invoiceId, id),
        ),
      );
    await scope.db
      .delete(reportSnapshots)
      .where(
        and(
          eq(reportSnapshots.organisationId, scope.orgId),
          eq(reportSnapshots.invoiceId, id),
        ),
      );
    await scope.db
      .delete(invoiceExports)
      .where(
        and(eq(invoiceExports.organisationId, scope.orgId), eq(invoiceExports.invoiceId, id)),
      );
    await scope.db
      .delete(invoiceApprovals)
      .where(
        and(
          eq(invoiceApprovals.organisationId, scope.orgId),
          eq(invoiceApprovals.invoiceId, id),
        ),
      );
    await scope.db
      .delete(serviceInvoices)
      .where(and(eq(serviceInvoices.organisationId, scope.orgId), eq(serviceInvoices.id, id)));

    /* The audit event outlives the rows. That is the whole reason a permanent
       delete is allowed to be permanent: `audit_events` still records that this
       document existed, who removed it and when. */
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.document_deleted",
      entityType: "service_invoice",
      entityId: id,
      summary: `Permanently deleted a ${status} combined report for ${invoice.periodStart} to ${invoice.periodEnd}.`,
      detail: {
        status,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        totalPence: invoice.totalPence,
      },
      request,
    });

    return Response.json({ deleted: id });
  } catch (error) {
    return reportUnavailable(error);
  }
}
