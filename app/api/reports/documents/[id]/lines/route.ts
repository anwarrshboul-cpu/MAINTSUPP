/**
 * `/api/reports/documents/[id]/lines` — include or exclude one site.
 *
 * ── AN EXCLUSION IS A DECISION, AND IS RECORDED AS ONE ─────────────────────
 *
 * Excluding a site needs a REASON, and the reason, the person and the time are
 * written onto the line (`exclusion_reason`, `excluded_by_email`,
 * `excluded_at`) as well as into `audit_events`. That is what makes the
 * decision survive a recalculation: `readLineDecisions` looks for a line
 * carrying an `excluded_by_email`, and only those are re-applied. An exclusion
 * the ENGINE made — a closed site, a site outside its billing window — is
 * recomputed every time, so the site comes back the moment the fact changes.
 *
 * ── RE-INCLUDING CANNOT SMUGGLE A DUPLICATE PAST THE FINALISER ─────────────
 *
 * Including a site that the computation excluded for a BLOCKING reason (already
 * charged on another invoice) leaves the blocking validation on the line, so
 * `finalisationBlockers` still refuses. The operator can put the line back on
 * the preview; they cannot issue the document.
 */

import { and, eq } from "drizzle-orm";
import { serviceInvoiceLines } from "../../../../../../db/schema";
import { auditActor, recordAudit } from "../../../../../lib/audit";
import { REPORT_CAPABILITIES } from "../../../../../lib/reporting/access";
import { draftWarnings, finalisationBlockers } from "../../../../../lib/reporting/blockers";
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
  reportUnavailable,
  text,
  todayIso,
} from "../../../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const guarded = await guard(request, REPORT_CAPABILITIES["document.edit"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return notFound();
    const status = documentStatus(invoice);
    if (status === "Finalised" || status === "Voided") {
      return Response.json(
        { error: `A ${status} document is locked and its lines cannot be changed.` },
        { status: 409 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");
    const siteId = text(body.siteId, 120);
    if (!siteId) return badRequest("Name the site line to change.");
    const included = Boolean(body.included);
    const reason = text(body.reason, 400);
    if (!included && !reason) {
      return badRequest("Excluding a site from an invoice needs a reason.");
    }

    const now = new Date().toISOString();
    const updated = await scope.db
      .update(serviceInvoiceLines)
      .set({
        included,
        exclusionReason: included ? null : reason,
        /* The email is what marks this as an OPERATOR decision rather than a
           computed one, so it is cleared on re-inclusion — see the header. */
        excludedByEmail: included ? null : scope.identityEmail,
        excludedAt: included ? null : now,
      })
      .where(
        and(
          eq(serviceInvoiceLines.organisationId, scope.orgId),
          eq(serviceInvoiceLines.invoiceId, id),
          eq(serviceInvoiceLines.siteId, siteId),
        ),
      )
      .returning({ id: serviceInvoiceLines.id, siteName: serviceInvoiceLines.siteName });
    if (updated.length === 0) return notFound("That site is not on this document.");

    /* Re-including has no stored decision to carry, so it must be recorded as
       one for the audit trail before the recomputation drops the row. */
    const decisions = included
      ? []
      : [
          {
            siteId,
            included: false,
            reason,
            byEmail: scope.identityEmail,
            at: now,
          },
        ];

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
      action: included ? "report.line_included" : "report.line_excluded",
      entityType: "service_invoice_line",
      entityId: updated[0].id,
      summary: included
        ? `Included ${updated[0].siteName ?? siteId} on the invoice.`
        : `Excluded ${updated[0].siteName ?? siteId} from the invoice. Reason: ${reason}`,
      detail: { siteId, included, reason, decisions },
      request,
    });

    return Response.json({
      payload: result.payload,
      blockers: finalisationBlockers({
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
