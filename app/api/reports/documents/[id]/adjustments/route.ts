/**
 * `/api/reports/documents/[id]/adjustments` — authorised adjustments and credits.
 *
 * `settings.edit`, not `board.edit`. An adjustment moves the invoice total
 * without any site or job behind it, so it is the Finance authority in this
 * workspace's capability model, and every one of them carries a REASON and the
 * email of whoever authorised it. A credit is stored as a positive magnitude
 * and subtracted by `computeInvoiceTotals`; storing a signed value as well
 * would give two ways to say one thing, and one of them would eventually be
 * wrong.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import { addAdjustment, listAdjustments, removeAdjustment } from "../../../../../lib/billing/repository";
import { REPORT_CAPABILITIES } from "../../../../../lib/reporting/access";
import { draftWarnings, finalisationBlockers } from "../../../../../lib/reporting/blockers";
import { loadWaivedIssueKeys } from "../../../../../lib/reporting/waiver-repository";
import {
  documentPayload,
  documentStatus,
  persistComputed,
  readInvoice,
} from "../../../../../lib/reporting/documents";
import {
  badRequest,
  guard,
  notFound,
  pence,
  reportUnavailable,
  text,
  todayIso,
} from "../../../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

function locked(status: string) {
  return status === "Finalised" || status === "Voided";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.adjust"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    /* Waived data issues stop being blockers; a revoked waiver puts the block back. */
    const waivedIssueKeys = await loadWaivedIssueKeys(scope.db, scope.orgId, id);

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (locked(status)) {
      return Response.json(
        { error: `A ${status} document is locked. Raise a credit note against it rather than adjusting it.` },
        { status: 409 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");
    const kind = body.kind === "credit" ? "credit" : "adjustment";
    const amount = pence(body.amountPence);
    if (amount === null || amount === 0) return badRequest("An adjustment needs an amount in whole pence.");
    const reason = text(body.reason, 400);
    if (!reason) return badRequest("An adjustment needs a reason. It appears on the document.");

    const adjustmentId = await addAdjustment(
      scope.db,
      scope.orgId,
      id,
      { kind, amountPence: amount, reason },
      scope.identityEmail,
    );

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });
    await persistComputed(scope.db, scope.orgId, id, result.payload);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.adjustment_added",
      entityType: "invoice_adjustment",
      entityId: adjustmentId,
      summary: `Added a ${kind} of ${Math.abs(amount)}p. Reason: ${reason}`,
      detail: { kind, amountPence: Math.abs(amount), reason },
      request,
    });

    return Response.json(
      {
        adjustments: await listAdjustments(scope.db, scope.orgId, id),
        payload: result.payload,
        blockers: finalisationBlockers({
          payload: result.payload,
          waivedIssueKeys,
          confirmedPartialPeriod: false,
          requireApproval: true,
        }),
        warnings: draftWarnings(result.payload),
      },
      { status: 201 },
    );
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.adjust"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    /* Waived data issues stop being blockers; a revoked waiver puts the block back. */
    const waivedIssueKeys = await loadWaivedIssueKeys(scope.db, scope.orgId, id);

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (locked(status)) {
      return Response.json({ error: `A ${status} document is locked.` }, { status: 409 });
    }

    const url = new URL(request.url);
    const adjustmentId = url.searchParams.get("adjustmentId");
    if (!adjustmentId) return badRequest("Name the adjustment to remove.");

    const removed = await removeAdjustment(scope.db, scope.orgId, id, adjustmentId);
    if (!removed) return notFound("That adjustment is not on this document.");

    const result = await documentPayload(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      invoice,
      todayIso: todayIso(),
    });
    if ("error" in result) return Response.json({ error: result.error }, { status: 500 });
    await persistComputed(scope.db, scope.orgId, id, result.payload);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.adjustment_removed",
      entityType: "invoice_adjustment",
      entityId: adjustmentId,
      summary: `Removed a ${removed.kind} of ${removed.amountPence}p. Its reason was: ${removed.reason}`,
      detail: removed,
      request,
    });

    return Response.json({
      adjustments: await listAdjustments(scope.db, scope.orgId, id),
      payload: result.payload,
      blockers: finalisationBlockers({
        payload: result.payload,
        waivedIssueKeys,
        confirmedPartialPeriod: false,
        requireApproval: true,
      }),
      warnings: draftWarnings(result.payload),
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}
