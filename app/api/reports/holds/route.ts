/**
 * `/api/reports/holds` — the periods a job's clock was paused, and who agreed.
 *
 * ── RECORDING AND APPROVING ARE DIFFERENT ACTS ─────────────────────────────
 *
 * POST records a hold and CANNOT approve one: `recordHold` writes
 * `approved: false` and there is no parameter that changes it. PATCH approves,
 * and requires `settings.edit` rather than `board.edit`.
 *
 * That asymmetry is the whole point. An approved hold is subtracted from the
 * elapsed time a client judges the service by, so it has to be somebody's
 * decision with their name against it — not something typed into a box by
 * whoever was closing the job. An unapproved hold changes no number and is
 * reported as a data-quality finding until it is either approved or removed.
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import { approveHold, listHolds, recordHold } from "../../../lib/billing/repository";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
import { dateOnly } from "../../../lib/reporting/period";
import {
  badRequest,
  guard,
  reportUnavailable,
  text,
} from "../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["holds.read"]);
    if (guarded.denied) return guarded.denied;
    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");
    const holds = await listHolds(
      guarded.scope.db,
      guarded.scope.orgId,
      requestId ? [requestId] : undefined,
    );
    return Response.json({ holds });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["holds.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const requestId = text(body.requestId, 120);
    if (!requestId) return badRequest("Name the job this hold is against.");
    const startAt = dateOnly(String(body.startAt ?? ""));
    if (!startAt) return badRequest("A hold needs a start date, as YYYY-MM-DD.");
    const endAt = body.endAt === null || body.endAt === undefined ? null : dateOnly(String(body.endAt));
    if (body.endAt && !endAt) return badRequest("The end date must be YYYY-MM-DD.");
    if (endAt && endAt < startAt) return badRequest("The hold ends before it starts.");

    const id = await recordHold(
      scope.db,
      scope.orgId,
      {
        requestId,
        startAt,
        endAt,
        reason: text(body.reason, 400),
        category: text(body.category, 120),
        note: text(body.note, 800),
      },
      scope.identityEmail,
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.hold_recorded",
      entityType: "job_hold",
      entityId: id,
      summary: `Recorded a hold on job ${requestId} from ${startAt} to ${endAt ?? "an open end"}. Not approved.`,
      detail: { requestId, startAt, endAt, approved: false },
      request,
    });

    return Response.json({ id, approved: false }, { status: 201 });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    /* Approving is `settings.edit`, not `board.edit`. See the header. */
    const guarded = await guard(request, REPORT_CAPABILITIES["holds.approve"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const id = text(body.id, 120);
    if (!id) return badRequest("Name the hold to approve.");
    const approved = Boolean(body.approved);
    const reason = text(body.reason, 400);
    if (!approved && !reason) {
      return badRequest("Withdrawing an approval needs a reason.");
    }

    const changed = await approveHold(scope.db, scope.orgId, id, approved, scope.identityEmail);
    if (!changed) return badRequest("That hold does not belong to this workspace.");

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.hold_approved",
      entityType: "job_hold",
      entityId: id,
      summary: approved
        ? "Approved a hold; its days are now removed from the measured duration."
        : `Withdrew the approval of a hold. Reason: ${reason}`,
      detail: { id, approved, reason },
      request,
    });

    return Response.json({ id, approved });
  } catch (error) {
    return reportUnavailable(error);
  }
}
