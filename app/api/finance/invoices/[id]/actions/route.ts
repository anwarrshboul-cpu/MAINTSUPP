/**
 * `/api/finance/invoices/[id]/actions` — the §5 state machine, one door.
 *
 * `{ action: "submit" | "approve" | "reject" | "schedule" | "finalise" | "void"
 *          | "rematch" | "dispute" | "resolve_dispute" }`
 *
 * ── WHY ONE ENDPOINT AND NOT NINE ──────────────────────────────────────────
 *
 * Every transition shares a precondition (the invoice exists, in this
 * organisation, in a status the move is legal from) and a postcondition (a row
 * in `invoice_status_history` and an audit event). Nine routes would be nine
 * copies of both, and the copy that drifts is the one nobody reads. This is the
 * shape `app/api/reports/documents/[id]/actions/route.ts` already uses.
 *
 * ── THE CAPABILITY DEPENDS ON THE ACTION, NOT THE ROUTE ────────────────────
 *
 * `submit`, `rematch` and `dispute` are `board.edit` — operations working an
 * invoice. `approve`, `reject`, `schedule`, `finalise`, `void` and
 * `resolve_dispute` are `settings.edit` — the Administrator / Finance
 * authority. The guard therefore runs AFTER the action is parsed.
 *
 * ── WHAT BLOCKS WHAT ───────────────────────────────────────────────────────
 *
 *   APPROVE   — the band (§13) and maker/checker, plus every OPEN BLOCKING
 *               flag (§7). §16: "An invoice exceeding its approved quote beyond
 *               tolerance blocks approval until cleared or waived with a
 *               reason", and "a duplicate invoice is flagged before it can be
 *               approved for payment".
 *   FINALISE  — the allocations must SUM (§4, §16) and no blocking flag may be
 *               open. Finalisation is the moment the accounting facts freeze,
 *               so it is the last moment either can be checked.
 *   VOID      — needs a reason, and is legal from anywhere. A voided invoice
 *               keeps its figures; that is the evidence it was raised.
 *
 * The counters are NOT wound back by a void. See the head of
 * `app/lib/finance/references.ts` for why that is not negotiable.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import { listAllocations } from "../../../../../lib/finance/allocations";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
  type FinanceOperation,
} from "../../../../../lib/finance/access";
import { canApprove, recordApproval } from "../../../../../lib/finance/approvals";
import { day, note, readBody, text } from "../../../../../lib/finance/input";
import { blockingFlags, listFlags, runMatch } from "../../../../../lib/finance/matching";
import { allocationState } from "../../../../../lib/finance/rules";
import { financeStatusKey } from "../../../../../lib/finance/model";
import {
  raiseDispute,
  readInvoice,
  recordStatusChange,
  resolveDispute,
  updateInvoice,
} from "../../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

const ACTIONS = [
  "submit",
  "approve",
  "reject",
  "schedule",
  "finalise",
  "void",
  "rematch",
  "dispute",
  "resolve_dispute",
] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_OPERATION: Record<Action, FinanceOperation> = {
  submit: "invoice.submit",
  approve: "invoice.approve",
  reject: "invoice.approve",
  schedule: "invoice.approve",
  finalise: "invoice.finalise",
  void: "invoice.void",
  rematch: "invoice.rematch",
  dispute: "invoice.dispute",
  resolve_dispute: "invoice.resolve_dispute",
};

/**
 * The status each action moves an invoice to, per direction. §5.
 *
 * `null` means the action changes no status — `rematch` recomputes flags and
 * `resolve_dispute` closes a dispute record; neither is a place on the ladder.
 */
const TARGET_STATUS: Record<Action, { payable: string | null; receivable: string | null }> = {
  submit: { payable: "under_review", receivable: "issued" },
  approve: { payable: "approved", receivable: "sent" },
  reject: { payable: "query_raised", receivable: "disputed" },
  schedule: { payable: "scheduled", receivable: "sent" },
  /*
   * FINALISE DOES NOT APPROVE. It used to, and that was a hole straight
   * through §13.
   *
   * Finalising means "the document is complete and every penny lands on a
   * job" — it locks the accounting fields. It says nothing about whether
   * anybody has AGREED to pay it. With `approved` as the target, one holder of
   * `settings.edit` (which the built-in `admin` role has) could take a £1,200
   * payable from `draft` to `approved` in a single call: no `canApprove`
   * check, `approvals: []`, `approvalProgress {required: 2, held: 0}`, and the
   * invoice immediately appeared as a payment-run candidate. The approver
   * count, maker/checker and client sign-off were all defeated at once, and
   * the only route that enforces them — `approve` — was simply not on the path.
   *
   * `under_review` is where a finalised payable belongs: ready to be approved,
   * by the ladder, through the action that runs it.
   */
  finalise: { payable: "under_review", receivable: "issued" },
  void: { payable: "voided", receivable: "voided" },
  rematch: { payable: null, receivable: null },
  dispute: { payable: "disputed", receivable: "disputed" },
  resolve_dispute: { payable: null, receivable: null },
};

function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readBody(request);
    if (!body || !isAction(body.action)) {
      return financeBadRequest(`\`action\` must be one of: ${ACTIONS.join(", ")}.`);
    }
    const action = body.action;

    const guarded = await guardFinance(request, ACTION_OPERATION[action]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    const direction = invoice.direction === "receivable" ? "receivable" : "payable";
    const from = financeStatusKey(invoice.status);
    const reason = note(body.reason, 400);
    const now = new Date();
    const actorUserId = scope.session?.user.id ?? null;

    /* ── VOID first: legal from anywhere, and it recomputes nothing ────────── */
    if (action === "void") {
      if (!reason) {
        return financeBadRequest(
          "Voiding an invoice needs a reason. It is recorded against the invoice permanently.",
        );
      }
      if (invoice.voidedAt) return financeConflict("This invoice is already voided.");
      await updateInvoice(scope.db, scope.orgId, id, {
        status: "voided",
        voidedAt: now.toISOString(),
        voidedBy: scope.identityEmail,
        voidReason: reason,
      });
      await recordStatusChange(scope.db, scope.orgId, {
        invoiceId: id,
        fromStatus: from,
        toStatus: "voided",
        actorEmail: scope.identityEmail,
        actorUserId,
        reason,
        now,
      });
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_voided",
        entityType: "invoice",
        entityId: id,
        summary: `Voided ${invoice.internalRef ?? id}. Reason: ${reason}`,
        detail: { from, to: "voided", reason, referenceKept: invoice.internalRef },
        request,
      });
      return Response.json({ status: "voided", reason });
    }

    if (invoice.voidedAt) {
      return financeConflict(`A voided invoice cannot be ${action.replace("_", " ")}d.`);
    }

    /* ── REMATCH: recompute §7's flags without touching the status ─────────── */
    if (action === "rematch") {
      const match = await runMatch(scope.db, scope.orgId, id, { now });
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_rematched",
        entityType: "invoice",
        entityId: id,
        summary: `Re-ran the three-way match on ${invoice.internalRef ?? id}: `
          + `${match.findings.length} finding${match.findings.length === 1 ? "" : "s"}.`,
        detail: { findings: match.findings.map((finding) => finding.flagType) },
        request,
      });
      return Response.json({ status: invoice.status, flags: match.flags, findings: match.findings });
    }

    /* ── DISPUTES: their own record, not just a status. §15.9 ──────────────── */
    if (action === "dispute") {
      if (!reason) return financeBadRequest("A dispute needs a reason. It is the record.");
      const disputeId = await raiseDispute(scope.db, scope.orgId, {
        invoiceId: id,
        reason,
        detail: note(body.detail, 2000),
        raisedBy: scope.identityEmail,
        now,
      });
      await moveTo(scope, id, from, "disputed", reason, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_disputed",
        entityType: "invoice",
        entityId: id,
        summary: `Raised a dispute on ${invoice.internalRef ?? id}: ${reason}`,
        detail: { disputeId, reason },
        request,
      });
      return Response.json({ status: "disputed", disputeId });
    }

    if (action === "resolve_dispute") {
      const resolution = note(body.resolution ?? body.reason, 2000);
      if (!resolution) return financeBadRequest("Say how the dispute was resolved. It is the record.");
      const closed = await resolveDispute(scope.db, scope.orgId, id, {
        resolution,
        resolvedBy: scope.identityEmail,
        now,
      });
      if (closed === 0) return financeConflict("There is no open dispute on this invoice.");
      /*
       * The status returns to `under_review`, not to whatever it was before the
       * dispute. The ledger does not store the pre-dispute status and inventing
       * one would put an invoice back into "approved" that nobody has re-read
       * since the argument started — which is the opposite of what resolving a
       * dispute should mean.
       */
      const back = direction === "payable" ? "under_review" : "issued";
      await moveTo(scope, id, from, back, resolution, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.dispute_resolved",
        entityType: "invoice",
        entityId: id,
        summary: `Resolved ${closed} dispute${closed === 1 ? "" : "s"} on ${invoice.internalRef ?? id}.`,
        detail: { resolution, closed },
        request,
      });
      return Response.json({ status: back, resolved: closed });
    }

    /* ── REJECT: a query raised, with the reason on the invoice ────────────── */
    if (action === "reject") {
      if (!reason) return financeBadRequest("Rejecting an invoice needs a reason.");
      const to = TARGET_STATUS.reject[direction]!;
      await moveTo(scope, id, from, to, reason, now);
      await recordApproval(scope.db, scope.orgId, {
        invoiceId: id,
        approverEmail: scope.identityEmail,
        approverUserId: actorUserId,
        decision: "rejected",
        basis: reason,
        ruleId: null,
        now,
      }).catch(() => undefined);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_rejected",
        entityType: "invoice",
        entityId: id,
        summary: `Raised a query on ${invoice.internalRef ?? id}: ${reason}`,
        detail: { from, to, reason },
        request,
      });
      return Response.json({ status: to, reason });
    }

    /* ── SUBMIT: into review, and the match runs again on the way ──────────── */
    if (action === "submit") {
      const to = TARGET_STATUS.submit[direction]!;
      const match = await runMatch(scope.db, scope.orgId, id, { now });
      await moveTo(scope, id, from, to, reason, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_submitted",
        entityType: "invoice",
        entityId: id,
        summary: `Submitted ${invoice.internalRef ?? id} for review.`,
        detail: { from, to, findings: match.findings.map((finding) => finding.flagType) },
        request,
      });
      return Response.json({ status: to, flags: match.flags });
    }

    /* ── APPROVE: the band, maker/checker, and every open blocking flag ────── */
    if (action === "approve") {
      const blocked = blockingFlags(await listFlags(scope.db, scope.orgId, id));
      if (blocked.length > 0) {
        return financeConflict(
          `This invoice cannot be approved for payment while ${blocked.length} `
            + `flag${blocked.length === 1 ? "" : "s"} ${blocked.length === 1 ? "is" : "are"} open. `
            + `Clear or waive ${blocked.length === 1 ? "it" : "them"} with a typed reason first.`,
          { flags: blocked },
        );
      }

      const assessment = await canApprove(scope.db, scope.orgId, id, scope.identityEmail);
      if (!assessment.ok) return financeConflict(assessment.error, { band: assessment.band });

      await recordApproval(scope.db, scope.orgId, {
        invoiceId: id,
        approverEmail: scope.identityEmail,
        approverUserId: actorUserId,
        decision: "approved",
        basis: assessment.decision.basis,
        ruleId: assessment.band.id,
        now,
      });

      /*
       * TWO APPROVERS MEANS THE STATUS MOVES ON THE SECOND ONE. The first
       * approval is recorded and the invoice stays where it is, because an
       * invoice sitting in "Approved for payment" with one of two signatures is
       * a payment run waiting to pick it up.
       */
      const to = assessment.decision.completesBand ? TARGET_STATUS.approve[direction]! : from;
      if (assessment.decision.completesBand) {
        await moveTo(scope, id, from, to, assessment.decision.basis, now);
      }

      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_approved",
        entityType: "invoice",
        entityId: id,
        summary: `Approved ${invoice.internalRef ?? id}. ${assessment.decision.basis}`,
        detail: {
          basis: assessment.decision.basis,
          ruleId: assessment.band.id,
          approvalsHeld: assessment.decision.approvalsHeld + 1,
          approversRequired: assessment.decision.approversRequired,
        },
        request,
      });

      return Response.json({
        status: to,
        basis: assessment.decision.basis,
        approvalsHeld: assessment.decision.approvalsHeld + 1,
        approversRequired: assessment.decision.approversRequired,
        complete: assessment.decision.completesBand,
      });
    }

    /* ── SCHEDULE: a date the money is going out on ────────────────────────── */
    if (action === "schedule") {
      if (financeStatusKey(invoice.status) !== "approved" && direction === "payable") {
        return financeConflict(
          "Only an invoice approved for payment can be scheduled. Approve it first.",
        );
      }
      const scheduledFor = day(body.paymentDate ?? body.scheduledDate);
      if (!scheduledFor) return financeBadRequest("`paymentDate` must be a YYYY-MM-DD date.");
      const to = TARGET_STATUS.schedule[direction]!;
      await moveTo(scope, id, from, to, `Scheduled for ${scheduledFor}.`, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.invoice_scheduled",
        entityType: "invoice",
        entityId: id,
        summary: `Scheduled ${invoice.internalRef ?? id} for payment on ${scheduledFor}.`,
        detail: { from, to, scheduledFor },
        request,
      });
      return Response.json({ status: to, scheduledFor });
    }

    /* ── FINALISE: the sum must balance and no flag may block ──────────────── */
    const allocations = await listAllocations(scope.db, scope.orgId, id);
    const target = invoice.netPence ?? invoice.grossPence ?? 0;
    const state = allocationState(target, allocations);
    if (allocations.length === 0 || !state.balanced) {
      return financeConflict(
        allocations.length === 0
          ? "This invoice is not allocated to any job. Every penny has to land on a job before it is finalised."
          : `The job allocations come to ${state.totalPence}p against an invoice net of `
            + `${state.targetPence}p. They have to match exactly before this invoice can be finalised.`,
        { allocation: state },
      );
    }

    const openBlocking = blockingFlags(await listFlags(scope.db, scope.orgId, id));
    if (openBlocking.length > 0) {
      return financeConflict(
        `This invoice cannot be finalised while ${openBlocking.length} `
          + `flag${openBlocking.length === 1 ? "" : "s"} ${openBlocking.length === 1 ? "is" : "are"} open.`,
        { flags: openBlocking },
      );
    }

    /*
     * Finalising must never move an invoice BACKWARDS either. An invoice that
     * has already been approved, scheduled or paid keeps the status it earned;
     * finalise only carries a draft forward to the review stage. So the target
     * is applied when the invoice is still a draft, and is otherwise left
     * exactly where the ladder put it.
     */
    const finaliseTarget = TARGET_STATUS.finalise[direction]!;
    const nextStatus = from === "draft" ? finaliseTarget : from;
    await updateInvoice(scope.db, scope.orgId, id, {
      finalisedAt: now.toISOString(),
      finalisedBy: scope.identityEmail,
      status: nextStatus,
    });
    await recordStatusChange(scope.db, scope.orgId, {
      invoiceId: id,
      fromStatus: from,
      toStatus: nextStatus,
      actorEmail: scope.identityEmail,
      actorUserId,
      reason: text(body.reason, 400) ?? "Finalised. The accounting fields are now immutable.",
      now,
    });
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.invoice_finalised",
      entityType: "invoice",
      entityId: id,
      summary: `Finalised ${invoice.internalRef ?? id}. Corrections now go through credit notes.`,
      detail: { allocation: state, netPence: invoice.netPence, grossPence: invoice.grossPence },
      request,
    });
    return Response.json({
      status: nextStatus,
      finalisedAt: now.toISOString(),
      allocation: state,
    });
  } catch (error) {
    return financeUnavailable(error, "That change to the invoice could not be made.");
  }
}

/** Move the status and append the history row. §2 — the two always go together. */
async function moveTo(
  scope: { db: Parameters<typeof updateInvoice>[0]; orgId: string; identityEmail: string; session?: { user: { id: string } } | null },
  invoiceId: string,
  from: string,
  to: string,
  reason: string | null,
  now: Date,
): Promise<void> {
  await updateInvoice(scope.db, scope.orgId, invoiceId, { status: to }, now);
  await recordStatusChange(scope.db, scope.orgId, {
    invoiceId,
    fromStatus: from,
    toStatus: to,
    actorEmail: scope.identityEmail,
    actorUserId: scope.session?.user.id ?? null,
    reason,
    now,
  });
}
