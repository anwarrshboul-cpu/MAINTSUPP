/**
 * `/api/reports/preview` — compute the whole document without saving anything.
 *
 * The response is a `CombinedReportPayload` and the blockers it would hit. It
 * is the same value `POST /api/reports/documents` would store and the same one
 * the exporters render, so what is on screen before saving is what is in the
 * file afterwards.
 *
 * WRITES NOTHING. Not a draft, not a placeholder row, not an invoice number.
 * The one exception is the lazy creation of `billing_settings`, which is a row
 * of defaults, not a document — see `readBillingSettings`.
 *
 * `board.edit`, not `board.view`: a preview computes the whole estate's billing
 * position, which is the Operations Manager's screen. A Viewer sees finalised
 * documents through `/api/reports/documents` instead.
 */

import { finalisationBlockers, draftWarnings } from "../../../lib/reporting/blockers";
import { loadWaivedIssueKeys } from "../../../lib/reporting/waiver-repository";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
import { computeReport } from "../../../lib/reporting/engine";
import {
  badRequest,
  clientMismatch,
  guard,
  periodFromPayload,
  reportUnavailable,
  todayIso,
} from "../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["report.preview"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    /* Waived data issues stop being blockers; a revoked waiver puts the block back. */
    const waivedIssueKeys = await loadWaivedIssueKeys(scope.db, scope.orgId, null);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    /* Before anything is computed: a preview headed with one client's name and
       filled with another's figures is the one wrong answer this route can give
       that nobody would notice. See `clientMismatch`. */
    const mismatch = clientMismatch(body, scope);
    if (mismatch) return mismatch;

    const period = periodFromPayload(body);
    if (!period.ok) return badRequest(period.error);

    const payload = await computeReport({
      db: scope.db,
      organisationId: scope.orgId,
      organisationName: scope.organisation.name,
      period: period.period,
      todayIso: todayIso(),
      invoiceId: null,
      status: "Draft",
    });

    return Response.json({
      payload,
      /* `requireApproval: false` because a preview has no status to approve;
         the caller is asking "what would stop this being finalised", and
         "it has not been approved yet" is not a fault in the data. */
      blockers: finalisationBlockers({
        payload,
        waivedIssueKeys,
        confirmedPartialPeriod: Boolean(body.confirmPartialPeriod),
        requireApproval: false,
      }),
      warnings: draftWarnings(payload),
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}
