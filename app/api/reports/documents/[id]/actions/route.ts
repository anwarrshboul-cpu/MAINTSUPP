/**
 * `/api/reports/documents/[id]/actions` — the document state machine, one door.
 *
 * `{ action: "recalculate" | "submit" | "approve" | "finalise" | "void" }`.
 *
 * ── WHY ONE ENDPOINT AND NOT FIVE ──────────────────────────────────────────
 *
 * The transitions share a precondition (the document exists, in this
 * organisation, in a status the move is legal from) and a postcondition (an
 * `invoice_approvals` row and an audit event). Five routes would be five copies
 * of both, and the copy that drifts is the one nobody reads. `canTransition`
 * in `access.ts` is the table; this file is the only thing that consults it.
 *
 * ── THE CAPABILITY DEPENDS ON THE ACTION, NOT THE ROUTE ────────────────────
 *
 * `recalculate` and `submit` are `board.edit` — an Operations Manager working a
 * draft. `approve`, `finalise` and `void` are `settings.edit` — the
 * Administrator / Finance authority. The check therefore happens AFTER the
 * action is parsed, which is why this route does not open with a single guard.
 *
 * ── FINALISATION IS CHECKED AGAINST THE PAYLOAD IT FREEZES ─────────────────
 *
 * The blockers are computed from the very `CombinedReportPayload` that is then
 * written into `report_snapshots`. Nothing is read again in between. That
 * closes the gap between "what was validated" and "what was stored", which is
 * the gap every reconciliation bug in a system like this lives in.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import { REPORT_CAPABILITIES, type ReportOperation } from "../../../../../lib/reporting/access";
import { draftWarnings, finalisationBlockers } from "../../../../../lib/reporting/blockers";
import type { InvoiceStatus } from "../../../../../lib/reporting/contract";
import {
  documentPayload,
  documentStatus,
  finaliseDocument,
  moveStatus,
  persistComputed,
  readInvoice,
} from "../../../../../lib/reporting/documents";
import {
  badRequest,
  guard,
  notFound,
  reportUnavailable,
  text,
  todayIso,
} from "../../../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

const ACTIONS = ["recalculate", "submit", "approve", "finalise", "void"] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_OPERATION: Record<Action, ReportOperation> = {
  recalculate: "document.recalculate",
  submit: "document.submit",
  approve: "document.approve",
  finalise: "document.finalise",
  void: "document.void",
};

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !isAction(body.action)) {
      return badRequest(`\`action\` must be one of: ${ACTIONS.join(", ")}.`);
    }
    const action = body.action;

    const guarded = await guard(request, REPORT_CAPABILITIES[ACTION_OPERATION[action]]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    const reason = text(body.reason, 400);

    /* Void first: it is the only action legal from Finalised, and it must not
       recompute anything — a voided document keeps the figures it was issued
       with, which is the evidence that it was issued. */
    if (action === "void") {
      if (!reason) return badRequest("Voiding a document needs a reason. It is recorded against the document.");
      const moved = await moveStatus(scope.db, {
        organisationId: scope.orgId,
        invoice,
        to: "Voided",
        action: "voided",
        actorEmail: scope.identityEmail,
        actorUserId: scope.session?.user.id ?? null,
        reason,
      });
      if (!moved.ok) return Response.json({ error: moved.error }, { status: moved.status });
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "report.voided",
        entityType: "service_invoice",
        entityId: id,
        summary: `Voided ${invoice.invoiceNumber ?? "a draft document"}. Reason: ${reason}`,
        detail: { from: status, to: "Voided", reason },
        request,
      });
      return Response.json({ status: "Voided" });
    }

    if (status === "Finalised" || status === "Voided") {
      return Response.json(
        { error: `A ${status} document cannot be ${action}d.` },
        { status: 409 },
      );
    }

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });
    const payload = result.payload;

    if (action === "recalculate") {
      await persistComputed(scope.db, scope.orgId, id, payload);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "report.recalculated",
        entityType: "service_invoice",
        entityId: id,
        summary: `Recalculated the document: ${payload.invoice.totals.includedSites} sites, total ${payload.invoice.totals.totalPence}p.`,
        detail: payload.invoice.totals,
        request,
      });
      return Response.json({
        status,
        payload,
        blockers: finalisationBlockers({ payload, confirmedPartialPeriod: false, requireApproval: true }),
        warnings: draftWarnings(payload),
      });
    }

    if (action === "submit" || action === "approve") {
      const to: InvoiceStatus = action === "submit" ? "Ready for Review" : "Approved";
      /* An approval is a statement that the figures are right, so the stored
         totals are refreshed first — approving a document whose lines were
         computed before a fee changed would approve numbers nobody has seen. */
      await persistComputed(scope.db, scope.orgId, id, payload);
      const moved = await moveStatus(scope.db, {
        organisationId: scope.orgId,
        invoice,
        to,
        action: action === "submit" ? "submitted" : "approved",
        actorEmail: scope.identityEmail,
        actorUserId: scope.session?.user.id ?? null,
        reason,
      });
      if (!moved.ok) return Response.json({ error: moved.error }, { status: moved.status });

      /* The payload was computed BEFORE the move, so its `status` is the old
         one — and `finalisationBlockers` reads that status. Left as it was, the
         answer to "approve" carried `status: "Approved"` and, beside it,
         "The document must be approved before it can be finalised.", which is
         the screen telling the operator their approval did not happen. Stamped
         rather than recomputed: a second computation here would read the estate
         again and could return a document different from the one whose totals
         were just written. */
      const settled = { ...payload, invoice: { ...payload.invoice, status: to } };
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: action === "submit" ? "report.submitted" : "report.approved",
        entityType: "service_invoice",
        entityId: id,
        summary:
          action === "submit"
            ? "Submitted the combined report for review."
            : `Approved the combined report: ${payload.invoice.totals.includedSites} sites, total ${payload.invoice.totals.totalPence}p.`,
        detail: { from: status, to, totals: payload.invoice.totals, reason },
        request,
      });
      return Response.json({
        status: to,
        payload: settled,
        blockers: finalisationBlockers({
          payload: settled,
          confirmedPartialPeriod: false,
          requireApproval: true,
        }),
        warnings: draftWarnings(settled),
      });
    }

    /* finalise */
    const blockers = finalisationBlockers({
      payload,
      confirmedPartialPeriod: Boolean(body.confirmPartialPeriod),
      requireApproval: true,
    });
    if (blockers.length > 0) {
      return Response.json(
        {
          error: "This document cannot be finalised yet.",
          blockers,
          warnings: draftWarnings(payload),
        },
        { status: 409 },
      );
    }

    await persistComputed(scope.db, scope.orgId, id, payload);
    const finalised = await finaliseDocument(scope.db, {
      organisationId: scope.orgId,
      invoice,
      payload,
      actorEmail: scope.identityEmail,
      actorUserId: scope.session?.user.id ?? null,
    });
    if (!finalised.ok) return Response.json({ error: finalised.error }, { status: finalised.status });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.finalised",
      entityType: "service_invoice",
      entityId: id,
      summary: `Finalised the combined report as ${finalised.invoiceNumber}. ${payload.invoice.totals.includedSites} sites, total ${payload.invoice.totals.totalPence}p. The figures are now locked to a snapshot.`,
      detail: {
        invoiceNumber: finalised.invoiceNumber,
        totals: payload.invoice.totals,
        period: payload.period,
      },
      request,
    });

    const stored = await readInvoice(scope.db, scope.orgId, id);
    return Response.json({
      status: "Finalised",
      invoiceNumber: finalised.invoiceNumber,
      document: stored,
      payload: {
        ...payload,
        invoice: { ...payload.invoice, invoiceNumber: finalised.invoiceNumber ?? null, status: "Finalised" },
      },
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}
