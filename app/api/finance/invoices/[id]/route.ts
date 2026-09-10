/**
 * `/api/finance/invoices/[id]` — one invoice, everything hanging off it, and the
 * one rule that makes the ledger trustworthy.
 *
 * ── IMMUTABILITY AFTER FINALISATION IS ENFORCED HERE, ON THE SERVER ────────
 *
 * §15.14: "corrections go through credit notes, never edits." §16 repeats it.
 * So once `finalised_at` is set, PATCH refuses any accounting field — the
 * amounts, the currency, the invoice number, the dates, the counterparty, the
 * quote, the site, the category, the cost centre, the retention. It is a 409
 * with the offending fields named, not a disabled form control: a disabled
 * control is a suggestion, and a `fetch` from the console is not bound by it.
 *
 * What a finalised invoice CAN still take is `notes`. A note is commentary and
 * changes no figure; refusing it would push people into editing the fields that
 * matter to record something they were only trying to write down.
 *
 * ── DELETE IS DRAFTS ONLY, AND `data.delete` ───────────────────────────────
 *
 * The capability this codebase deliberately withholds from `admin`, for the
 * reason its catalogue gives: archiving is reversible and deletion is not. A
 * finalised or voided invoice is a financial record and is refused whatever the
 * caller holds — VOID is how a real invoice is withdrawn, and the voided row is
 * the evidence that it was. An invoice with a payment or a credit note against
 * it is not a draft either, whatever its status column says.
 */

import { auditActor, changeDetail, recordAudit } from "../../../../lib/audit";
import { listAllocations } from "../../../../lib/finance/allocations";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../lib/finance/access";
import { invoiceBalanceFor } from "../../../../lib/finance/balance";
import { listApprovals, approvalProgress } from "../../../../lib/finance/approvals";
import { amountTriple, category, day, note, readBody, text } from "../../../../lib/finance/input";
import { listFlags, runMatch } from "../../../../lib/finance/matching";
import { financeStatusKey } from "../../../../lib/finance/model";
import {
  accountingFieldsIn,
  countCreditNotes,
  deleteDraftInvoice,
  listCreditNotes,
  listDisputes,
  listPaymentsForInvoice,
  listStatusHistory,
  readInvoice,
  updateInvoice,
  type InvoicePatch,
} from "../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;

    const invoice = await readInvoice(db, orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    const [allocations, flags, payments, credits, history, disputes, approvals, progress, balance] =
      await Promise.all([
        listAllocations(db, orgId, id),
        listFlags(db, orgId, id),
        listPaymentsForInvoice(db, orgId, id),
        listCreditNotes(db, orgId, id),
        listStatusHistory(db, orgId, id),
        listDisputes(db, orgId, id),
        listApprovals(db, orgId, id),
        approvalProgress(db, orgId, id),
        invoiceBalanceFor(db, orgId, id),
      ]);

    return Response.json({
      invoice,
      allocations,
      flags,
      payments,
      creditNotes: credits,
      history,
      disputes,
      approvals,
      approvalProgress: progress,
      /* Computed, never stored. §6, and the header of `app/lib/finance/balance.ts`. */
      balance,
    });
  } catch (error) {
    return financeUnavailable(error, "The invoice could not be read.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    const patch: InvoicePatch = {};
    if (body.invoiceNumber !== undefined) patch.invoiceNumber = text(body.invoiceNumber, 80);
    if (body.counterpartyId !== undefined) patch.counterpartyId = text(body.counterpartyId, 120);
    if (body.counterpartyName !== undefined) patch.counterpartyName = text(body.counterpartyName, 200);
    if (body.counterpartyType !== undefined) patch.counterpartyType = text(body.counterpartyType, 40);
    if (body.contractorId !== undefined) patch.contractorId = text(body.contractorId, 120);
    if (body.fromDepartment !== undefined) patch.fromDepartment = text(body.fromDepartment, 200);
    if (body.toDepartment !== undefined) patch.toDepartment = text(body.toDepartment, 200);
    if (body.faoContact !== undefined) patch.faoContact = text(body.faoContact, 200);
    if (body.quoteId !== undefined) patch.quoteId = text(body.quoteId, 120);
    if (body.poNumber !== undefined) patch.poNumber = text(body.poNumber, 80);
    if (body.siteId !== undefined) patch.siteId = text(body.siteId, 120);
    if (body.costCentre !== undefined) patch.costCentre = text(body.costCentre, 120);
    if (body.notes !== undefined) patch.notes = note(body.notes, 2000);

    if (body.category !== undefined) {
      const parsed = category(body.category);
      if (!parsed) return financeBadRequest("That is not a category this agreement covers.");
      patch.category = parsed;
    }
    for (const [field, column] of [
      ["invoiceDate", "invoiceDate"],
      ["receivedDate", "receivedDate"],
      ["sentDate", "sentDate"],
      ["retentionReleaseDate", "retentionReleaseDate"],
    ] as const) {
      if (body[field] === undefined) continue;
      const parsed = day(body[field]);
      if (!parsed) return financeBadRequest(`\`${field}\` must be a YYYY-MM-DD date.`);
      (patch as Record<string, unknown>)[column] = parsed;
    }
    if (body.dueDate !== undefined || body.dueAt !== undefined) {
      const parsed = day(body.dueDate ?? body.dueAt);
      if (!parsed) return financeBadRequest("`dueDate` must be a YYYY-MM-DD date.");
      patch.dueAt = parsed;
    }
    if (body.paymentTermsDays !== undefined) {
      const terms = Number(body.paymentTermsDays);
      if (!Number.isFinite(terms) || terms < 0) {
        return financeBadRequest("Payment terms are a whole number of days, zero or more.");
      }
      patch.paymentTermsDays = Math.trunc(terms);
    }

    const sendsAmounts = ["netPence", "vatPence", "grossPence", "net", "vat", "gross"].some(
      (field) => body[field] !== undefined,
    );
    if (sendsAmounts) {
      const amounts = amountTriple(body);
      if (typeof amounts === "string") return financeBadRequest(amounts);
      patch.netPence = amounts.netPence;
      patch.vatPence = amounts.vatPence;
      patch.grossPence = amounts.grossPence;
    }

    if (Object.keys(patch).length === 0) return financeBadRequest("Nothing in that body can be changed.");

    /* THE IMMUTABILITY CHECK. See the header — server-side, and named. */
    if (invoice.finalisedAt) {
      const frozen = accountingFieldsIn(patch);
      if (frozen.length > 0) {
        return financeConflict(
          `This invoice was finalised on ${invoice.finalisedAt.slice(0, 10)} and its accounting `
            + `fields cannot be edited. Raise a credit note instead. Refused: ${frozen.join(", ")}.`,
          { frozen, finalisedAt: invoice.finalisedAt },
        );
      }
    }
    if (invoice.voidedAt) {
      return financeConflict(
        "This invoice has been voided. A voided invoice keeps the figures it was issued with — "
          + "that is the evidence that it was issued.",
      );
    }

    await updateInvoice(scope.db, scope.orgId, id, patch);

    /*
     * A CHANGED AMOUNT, QUOTE, SITE OR JOB CHANGES WHAT THE MATCH SAYS, so the
     * match is re-run — otherwise an invoice edited from £900 to £9,000 keeps
     * the clean flags it was saved with and walks past §7 entirely.
     */
    const rematched = accountingFieldsIn(patch).length > 0
      ? await runMatch(scope.db, scope.orgId, id)
      : null;

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.invoice_updated",
      entityType: "invoice",
      entityId: id,
      summary: `Edited ${invoice.internalRef ?? id}: ${Object.keys(patch).join(", ")}.`,
      detail: changeDetail(
        invoice as unknown as Record<string, unknown>,
        patch as unknown as Record<string, unknown>,
      ),
      request,
    });

    const updated = await readInvoice(scope.db, scope.orgId, id);
    return Response.json({ invoice: updated, flags: rematched?.flags ?? null });
  } catch (error) {
    return financeUnavailable(error, "The invoice could not be changed.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.delete");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    if (invoice.finalisedAt || invoice.voidedAt) {
      return financeConflict(
        "A finalised or voided invoice is a financial record and is never deleted. Void it instead.",
      );
    }
    if (financeStatusKey(invoice.status) !== "draft") {
      return financeConflict(
        `Only a draft can be deleted. This invoice is ${invoice.status}; void it instead.`,
      );
    }

    const [payments, credits] = await Promise.all([
      listPaymentsForInvoice(scope.db, scope.orgId, id),
      countCreditNotes(scope.db, scope.orgId, id),
    ]);
    if (payments.length > 0 || credits > 0) {
      return financeConflict(
        "Money has already moved against this invoice, so it is not a draft whatever its status says. "
          + "Remove the payment or credit note first, or void the invoice.",
      );
    }

    await deleteDraftInvoice(scope.db, scope.orgId, id);
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.invoice_deleted",
      entityType: "invoice",
      entityId: id,
      summary: `Permanently deleted draft ${invoice.internalRef ?? id}.`,
      detail: { internalRef: invoice.internalRef, direction: invoice.direction },
      request,
    });
    return Response.json({ id, deleted: true });
  } catch (error) {
    return financeUnavailable(error, "The invoice could not be deleted.");
  }
}
