/**
 * `DELETE /api/finance/payment-runs/[id]` — cancelling a batch before it goes
 * to the bank, and releasing the invoices it was holding.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * A run now CLAIMS its invoices: `invoices.payment_run_id` is written when the
 * run is created, and the export reads that claim rather than re-deriving a
 * list. That is what stops the same invoice reaching two bank files — but it
 * also means a draft run nobody ever exports would hold its invoices out of
 * every future run, permanently, with no way to get them back. A claim without
 * a release is a trap, so this is the release.
 *
 * ── ONLY A DRAFT ──────────────────────────────────────────────────────────
 *
 * A run that has been exported has produced a file somebody may already have
 * uploaded. Cancelling it here would return its invoices to the candidate list
 * and invite a second payment — the exact fault this membership was added to
 * prevent. So an exported run is refused, and the way to undo one is to record
 * what actually happened at the bank.
 */

import { and, eq } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../../lib/audit";
import {
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../lib/finance/access";
import { invoices, paymentRuns } from "../../../../../db/schema";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await guardFinance(request, "payment.write");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;
    const { id } = await context.params;

    const found = await db
      .select()
      .from(paymentRuns)
      .where(and(eq(paymentRuns.organisationId, orgId), eq(paymentRuns.id, id)))
      .limit(1);
    const run = found[0];
    if (!run) return financeNotFound("That payment run does not exist.");
    if (run.status === "cancelled") {
      return financeConflict("That run was already cancelled.");
    }
    if (run.status !== "draft") {
      return financeConflict(
        "That run has already been exported, so it cannot be cancelled here. "
          + "Record what the bank actually did instead.",
      );
    }

    /* Released first. If the second statement failed after the run was marked
       cancelled, the invoices would be held by a run that no longer claims
       them and nothing would ever let go. */
    const held = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.organisationId, orgId), eq(invoices.paymentRunId, id)));

    await db
      .update(invoices)
      .set({ paymentRunId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(invoices.organisationId, orgId), eq(invoices.paymentRunId, id)));

    await db
      .update(paymentRuns)
      .set({ status: "cancelled" })
      .where(and(eq(paymentRuns.organisationId, orgId), eq(paymentRuns.id, id)));

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "finance.payment_run_cancelled",
      entityType: "payment_run",
      entityId: id,
      summary: `Cancelled payment run ${run.reference} and released ${held.length} invoice${
        held.length === 1 ? "" : "s"
      }.`,
      detail: { reference: run.reference, released: held.map((row) => row.id) },
      request,
    });

    return Response.json({ id, status: "cancelled", released: held.length });
  } catch (error) {
    return financeUnavailable(error, "The payment run could not be cancelled.");
  }
}
