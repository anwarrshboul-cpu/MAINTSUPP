/**
 * `/api/reports/documents` — the Generated Documents table, and saving a draft.
 *
 * ── THE VIEWER RULE IS A WHERE CLAUSE ──────────────────────────────────────
 *
 * A caller without `board.edit` sees FINALISED documents and nothing else. That
 * is `visibleStatuses`, and it is applied to the query rather than to the
 * rendering — a Viewer who calls this endpoint directly gets the same narrowed
 * list the screen shows them, and a draft's id guessed by hand is answered 404
 * by the sibling route rather than returning a working document with figures
 * nobody has approved.
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
import { draftWarnings, finalisationBlockers } from "../../../lib/reporting/blockers";
import { createDraft, listDocuments } from "../../../lib/reporting/documents";
import {
  badRequest,
  guard,
  periodFromPayload,
  reportUnavailable,
  text,
  todayIso,
  visibleStatuses,
} from "../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["document.list"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const statuses = await visibleStatuses(scope);
    const documents = await listDocuments(scope.db, scope.orgId, statuses);
    return Response.json({
      /* `clientName` is the organisation, filled here rather than joined in the
         query: "client" IS `organisations` in this product — there is no
         separate clients table — so the name is already on the scope. */
      documents: documents.map((row) => ({ ...row, clientName: scope.organisation.name })),
      visibleStatuses: statuses,
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["document.create"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const period = periodFromPayload(body);
    if (!period.ok) return badRequest(period.error);

    const { invoiceId, payload } = await createDraft(scope.db, {
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      period: period.period,
      todayIso: todayIso(),
      actorEmail: scope.identityEmail,
      actorUserId: scope.session?.user.id ?? null,
      header: {
        invoiceDate: text(body.invoiceDate, 10),
        dueAt: text(body.dueAt, 10),
        purchaseOrder: text(body.purchaseOrder, 120),
        clientReference: text(body.clientReference, 120),
        internalReference: text(body.internalReference, 120),
        clientNote: text(body.clientNote, 2000),
        internalNote: text(body.internalNote, 2000),
      },
    });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.document_created",
      entityType: "service_invoice",
      entityId: invoiceId,
      summary: `Created a draft combined report for ${period.period.label} (${period.period.start} to ${period.period.end}).`,
      detail: {
        period: period.period,
        includedSites: payload.invoice.totals.includedSites,
        totalPence: payload.invoice.totals.totalPence,
      },
      request,
    });

    return Response.json(
      {
        invoiceId,
        payload,
        blockers: finalisationBlockers({
          payload,
          confirmedPartialPeriod: false,
          requireApproval: true,
        }),
        warnings: draftWarnings(payload),
      },
      { status: 201 },
    );
  } catch (error) {
    return reportUnavailable(error);
  }
}
