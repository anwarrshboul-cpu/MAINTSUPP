/**
 * `/api/finance/payments/[id]` — one payment and everything it settled.
 *
 * ── THERE IS NO PATCH, AND THAT IS DELIBERATE ──────────────────────────────
 *
 * A payment is a record of money that moved. Editing its amount without editing
 * its allocations breaks the sum §6 requires; editing both is indistinguishable
 * from deleting it and recording the right one, except that the wrong one
 * leaves no trace. So a mistake is DELETED — under `data.delete`, which this
 * codebase withholds from `admin` — and recorded again. Every balance is
 * computed from the allocations at query time, so removing them restores the
 * ledger exactly, with nothing stored to drift.
 *
 * A payment against a FINALISED invoice is still deletable, and that is not a
 * hole in §15.14: immutability protects what the invoice SAYS, and a payment
 * says nothing about the invoice — it says what the bank did. Correcting a
 * mis-keyed payment is not a correction to the invoice, which is why it does
 * not need a credit note.
 */

import { auditActor, recordAudit } from "../../../../lib/audit";
import {
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../lib/finance/access";
import { invoiceBalances } from "../../../../lib/finance/balance";
import {
  deletePayment,
  listPaymentAllocations,
  readPayment,
} from "../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "payment.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;

    const payment = await readPayment(db, orgId, id);
    if (!payment) return financeNotFound("That payment does not exist.");
    const allocations = await listPaymentAllocations(db, orgId, id);
    const balances = await invoiceBalances(
      db,
      orgId,
      allocations.map((row) => row.invoiceId),
    );
    return Response.json({
      payment,
      allocations,
      balances: Object.fromEntries(balances),
    });
  } catch (error) {
    return financeUnavailable(error, "The payment could not be read.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "payment.delete");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const payment = await readPayment(scope.db, scope.orgId, id);
    if (!payment) return financeNotFound("That payment does not exist.");
    const allocations = await listPaymentAllocations(scope.db, scope.orgId, id);

    await deletePayment(scope.db, scope.orgId, id);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.payment_deleted",
      entityType: "payment",
      entityId: id,
      summary: `Removed a ${payment.direction === "out" ? "payment out" : "receipt"} of `
        + `${payment.amountPence}p dated ${payment.paymentDate}. Every balance it touched is restored.`,
      detail: {
        reference: payment.reference,
        amountPence: payment.amountPence,
        paymentDate: payment.paymentDate,
        allocations: allocations.map((row) => ({
          invoiceId: row.invoiceId,
          amountPence: row.amountPence,
        })),
      },
      request,
    });

    const balances = await invoiceBalances(
      scope.db,
      scope.orgId,
      allocations.map((row) => row.invoiceId),
    );
    return Response.json({ id, deleted: true, balances: Object.fromEntries(balances) });
  } catch (error) {
    return financeUnavailable(error, "The payment could not be removed.");
  }
}
