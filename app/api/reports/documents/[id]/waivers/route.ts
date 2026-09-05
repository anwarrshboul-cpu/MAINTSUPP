/**
 * `/api/reports/documents/[id]/waivers` — an approver's documented way past a
 * blocking data issue.
 *
 * ── WHY A WAIVER EXISTS AT ALL ─────────────────────────────────────────────
 *
 * Module 4 §6 rejects both of the obvious designs, and it is worth restating
 * because a later reader will be tempted by one of them. Blocking on every
 * finding means somebody eventually stops using the gate — they raise the
 * invoice outside the system, or they edit the data until the check goes quiet.
 * Warning on every finding means wrong numbers reach a client with nothing in
 * the way. The waiver keeps the block real while leaving a documented route
 * through it: one issue, one approver, one typed reason, printed in the
 * report's own data-quality notes.
 *
 * ── THE REASON IS MANDATORY, AND ENFORCED IN THREE PLACES ──────────────────
 *
 * `report_issue_waivers.reason` is NOT NULL, `waiverRequiresReason` refuses
 * whitespace, and this route checks before writing. Three, because the reason
 * is the entire product of the waiver: without it the row records that
 * somebody overrode a check and nothing about why, which is worse than no
 * record — it looks like an audit trail and answers no audit question.
 *
 * ── WAIVING IS NOT AN EDIT, SO IT NEEDS THE APPROVER'S CAPABILITY ──────────
 *
 * `document.approve`, deliberately not `document.edit`. Whoever prepares a document
 * must not be able to dismiss the checks on their own work; the specification
 * says "waived individually by an approver" and this is what makes that true
 * rather than aspirational.
 *
 * Revocation is a soft act — `revoked_at`, never a delete — because the fact
 * that a waiver once existed is part of the document's history. Revoking puts
 * the block straight back, which `loadWaivedIssueKeys` gets right by excluding
 * revoked rows at the source rather than filtering them later.
 */

import { and, eq } from "drizzle-orm";
import { reportIssueWaivers } from "../../../../../../db/schema";
import { auditActor, recordAudit } from "../../../../../lib/audit";
import { REPORT_CAPABILITIES } from "../../../../../lib/reporting/access";
import { badRequest, guard, reportUnavailable, text } from "../../../../../lib/reporting/route-helpers";
import { listWaivers } from "../../../../../lib/reporting/waiver-repository";
import { waiverRequiresReason } from "../../../../../lib/reporting/waivers";

export const dynamic = "force-dynamic";

function newId(): string {
  return `wvr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["document.read"]);
    if (guarded.denied) return guarded.denied;
    const { id } = await context.params;
    const waivers = await listWaivers(guarded.scope.db, guarded.scope.orgId, id);
    return Response.json({ waivers });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    /*
     * The APPROVER's capability, not the preparer's. See the header.
     */
    const guarded = await guard(request, REPORT_CAPABILITIES["document.approve"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const { id } = await context.params;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const issueCode = text(body.issueCode, 120);
    if (!issueCode) return badRequest("Name the data issue being waived.");
    const subjectId = text(body.subjectId, 120) || null;
    const reason = typeof body.reason === "string" ? body.reason : "";

    const validation = waiverRequiresReason({ reason });
    if (!validation.ok) {
      return badRequest(validation.error);
    }

    await scope.db.insert(reportIssueWaivers).values({
      id: newId(),
      organisationId: scope.orgId,
      invoiceId: id,
      issueCode,
      subjectId,
      reason: reason.trim(),
      waivedByEmail: scope.identityEmail ?? null,
      waivedAt: new Date().toISOString(),
    });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.issue_waived",
      entityType: "invoice",
      entityId: id,
      summary: `Waived the data issue ${issueCode}${subjectId ? ` on ${subjectId}` : ""}. Reason: ${reason.trim()}`,
      detail: { issueCode, subjectId, reason: reason.trim() },
      request,
    });

    const waivers = await listWaivers(scope.db, scope.orgId, id);
    return Response.json({ ok: true, waivers });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["document.approve"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const { id } = await context.params;
    const url = new URL(request.url);
    const waiverId = text(url.searchParams.get("waiverId"), 120);
    if (!waiverId) return badRequest("Name the waiver to revoke.");

    /* Soft. The fact that a waiver once existed is part of the history. */
    await scope.db
      .update(reportIssueWaivers)
      .set({
        revokedAt: new Date().toISOString(),
        revokedByEmail: scope.identityEmail ?? null,
      })
      .where(
        and(
          eq(reportIssueWaivers.id, waiverId),
          eq(reportIssueWaivers.organisationId, scope.orgId),
          eq(reportIssueWaivers.invoiceId, id),
        ),
      );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "report.issue_waiver_revoked",
      entityType: "invoice",
      entityId: id,
      summary: `Revoked a data-issue waiver. The issue blocks finalisation again.`,
      detail: { waiverId },
      request,
    });

    const waivers = await listWaivers(scope.db, scope.orgId, id);
    return Response.json({ ok: true, waivers });
  } catch (error) {
    return reportUnavailable(error);
  }
}
