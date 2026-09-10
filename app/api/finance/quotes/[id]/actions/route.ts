/**
 * `/api/finance/quotes/[id]/actions` — §3's lifecycle, one door.
 *
 * `{ action: "receive" | "review" | "approve" | "reject" | "expire"
 *          | "client_approve" }`
 *
 * Requested → Received → Under review → **Approved** / **Rejected** → Expired /
 * Superseded, and the two states that need evidence get it:
 *
 *   APPROVED needs `approved_by` and `approved_at`. §3 says "Required to move
 *            to Approved", and both come from the session, never from the body.
 *   REJECTED needs a reason. §3 again — and a "Rejected" with no reason six
 *            months later is indistinguishable from a quote somebody rejected
 *            for cause.
 *
 * ── APPROVING ONE REJECTS THE OTHERS, AND RECORDS WHY ON EACH ──────────────
 *
 * §3: "a single Approve this one action that rejects the others and records
 * why." The reason is written onto every loser rather than implied by their
 * status, and `superseded_by_id` records WHICH quote beat them — so the
 * comparison view can still be reconstructed a year later.
 *
 * The winner is approved FIRST. There is no interactive transaction available
 * here, so `approveQuoteExclusively` is ordered to fail safely: an interrupted
 * run leaves an approved quote with some competitors still open, which is
 * visible and re-runnable. The other order would leave a job with every quote
 * rejected and none approved, which reads as a decision nobody took.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
  type FinanceOperation,
} from "../../../../../lib/finance/access";
import { note, readBody } from "../../../../../lib/finance/input";
import { quoteStatusKey } from "../../../../../lib/finance/model";
import {
  approveQuoteExclusively,
  readQuote,
  updateQuote,
} from "../../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

const ACTIONS = ["receive", "review", "approve", "reject", "expire", "client_approve"] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_OPERATION: Record<Action, FinanceOperation> = {
  receive: "quote.write",
  review: "quote.write",
  approve: "quote.approve",
  reject: "quote.approve",
  expire: "quote.write",
  client_approve: "quote.approve",
};

const SIMPLE_STATUS: Partial<Record<Action, string>> = {
  receive: "received",
  review: "under_review",
  expire: "expired",
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

    const quote = await readQuote(scope.db, scope.orgId, id);
    if (!quote) return financeNotFound("That quote does not exist.");
    const from = quoteStatusKey(quote.status);
    const now = new Date();
    const reason = note(body.reason, 400);

    if (from === "superseded" && action !== "expire") {
      return financeConflict(
        "This quote was superseded when another on the same job was approved. Log a new quote instead.",
      );
    }

    /* ── APPROVE: the winner, and the losers, in one action ────────────────── */
    if (action === "approve") {
      if (from === "approved") return financeConflict("This quote is already approved.");
      if (from === "rejected") {
        return financeConflict(
          `This quote was rejected${quote.rejectedReason ? `: ${quote.rejectedReason}` : ""}. `
            + "Log a new quote rather than reversing a recorded decision.",
        );
      }
      if (quote.clientApprovalRequired && !(quote.clientApprovedBy && quote.clientApprovedAt)) {
        return financeConflict(
          "This quote is marked as needing the client's sign-off, and none is recorded. "
            + "Record the client approval first.",
        );
      }

      const rejectionReason = reason
        ?? `${quote.internalRef ?? "Another quote"} was approved for this job instead.`;
      const outcome = await approveQuoteExclusively(scope.db, scope.orgId, quote, {
        actorEmail: scope.identityEmail,
        reason: rejectionReason,
        now,
      });

      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.quote_approved",
        entityType: "quotation",
        entityId: id,
        summary: `Approved ${quote.internalRef ?? id} for ${quote.requestId}`
          + (outcome.rejectedIds.length
            ? `, rejecting ${outcome.rejectedIds.length} competing quote${outcome.rejectedIds.length === 1 ? "" : "s"}.`
            : "."),
        detail: {
          requestId: quote.requestId,
          grossPence: quote.grossPence,
          rejected: outcome.rejectedIds,
          rejectionReason,
        },
        request,
      });

      return Response.json({
        status: "approved",
        approvedBy: scope.identityEmail,
        rejected: outcome.rejectedIds,
        rejectionReason,
      });
    }

    /* ── REJECT: needs a reason, always ────────────────────────────────────── */
    if (action === "reject") {
      if (!reason) {
        return financeBadRequest(
          "Rejecting a quote needs a reason. It is recorded against the quote and it is what a "
            + "client asks about later.",
        );
      }
      if (from === "approved") {
        return financeConflict(
          "This quote is approved and an invoice may already be matched against it. "
            + "Log a replacement quote rather than reversing the decision.",
        );
      }
      await updateQuote(scope.db, scope.orgId, id, {
        status: "rejected",
        rejectedReason: reason,
        rejectedBy: scope.identityEmail,
        rejectedAt: now.toISOString(),
      }, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.quote_rejected",
        entityType: "quotation",
        entityId: id,
        summary: `Rejected ${quote.internalRef ?? id}: ${reason}`,
        detail: { from, reason },
        request,
      });
      return Response.json({ status: "rejected", reason });
    }

    /* ── CLIENT SIGN-OFF: §3 and §13's above-£5,000 requirement ────────────── */
    if (action === "client_approve") {
      await updateQuote(scope.db, scope.orgId, id, {
        clientApprovedBy: note(body.clientApprovedBy, 200) ?? scope.identityEmail,
        clientApprovedAt: now.toISOString(),
        clientApprovalRequired: true,
      }, now);
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "finance.quote_client_approved",
        entityType: "quotation",
        entityId: id,
        summary: `Recorded the client's sign-off on ${quote.internalRef ?? id}.`,
        detail: { clientApprovedBy: note(body.clientApprovedBy, 200) ?? scope.identityEmail },
        request,
      });
      return Response.json({ clientApprovedAt: now.toISOString() });
    }

    /* ── The three that only move the status ───────────────────────────────── */
    const to = SIMPLE_STATUS[action];
    if (!to) return financeBadRequest(`\`${action}\` is not a quote transition.`);
    if (from === "approved" || from === "rejected") {
      return financeConflict(`A ${from} quote cannot be moved back to ${to.replace("_", " ")}.`);
    }
    await updateQuote(scope.db, scope.orgId, id, { status: to }, now);
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.quote_status_changed",
      entityType: "quotation",
      entityId: id,
      summary: `Moved ${quote.internalRef ?? id} from ${from || "unset"} to ${to}.`,
      detail: { from, to, reason },
      request,
    });
    return Response.json({ status: to });
  } catch (error) {
    return financeUnavailable(error, "That change to the quote could not be made.");
  }
}
