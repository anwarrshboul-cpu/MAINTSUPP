/**
 * `/api/finance/credit-notes` — how a finalised invoice is corrected. §6, §15.14.
 *
 * ── THE INVOICE IS NOT TOUCHED, AND THAT IS THE WHOLE POINT ────────────────
 *
 * §15.14: "corrections go through credit notes, never edits." §16: "A credit
 * note reduces the balance without editing the finalised invoice." Nothing in
 * this route writes to `invoices`. The balance moves because
 * `app/lib/finance/balance.ts` subtracts credit notes at query time — so an
 * invoice finalised in March still says exactly what it said in March, and the
 * ledger is still right.
 *
 * `amount_pence` is stored POSITIVE. What it does to a balance is decided in
 * exactly one place, `invoiceBalance` in `app/lib/finance/rules.ts`, which also
 * explains why the sign is the same on both sides of the ledger — a supplier
 * crediting us reduces what we owe, and us crediting a client reduces what they
 * owe, and neither direction ever increases a balance.
 *
 * ── A REASON IS REQUIRED ───────────────────────────────────────────────────
 *
 * `credit_notes.reason` is NOT NULL in the schema and this route refuses a
 * blank one before the insert would. A credit note with no reason is an
 * unexplained reduction in what somebody owes, which is the single hardest
 * thing to answer for in an audit.
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { invoiceBalanceFor } from "../../../lib/finance/balance";
import { day, money, note, readBody, text } from "../../../lib/finance/input";
import { financeDay } from "../../../lib/finance/model";
import { creditNoteReference } from "../../../lib/finance/references";
import {
  countCreditNotes,
  createCreditNote,
  listCreditNotes,
  readInvoice,
} from "../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guardFinance(request, "ledger.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    const invoiceId = new URL(request.url).searchParams.get("invoice");
    if (!invoiceId) return financeBadRequest("Name the invoice with `?invoice=`.");
    const invoice = await readInvoice(db, orgId, invoiceId);
    if (!invoice) return financeNotFound("That invoice does not exist.");
    return Response.json({
      creditNotes: await listCreditNotes(db, orgId, invoiceId),
      balance: await invoiceBalanceFor(db, orgId, invoiceId),
    });
  } catch (error) {
    return financeUnavailable(error, "The credit notes could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guardFinance(request, "credit_note.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const invoiceId = text(body.invoiceId, 120);
    if (!invoiceId) return financeBadRequest("A credit note has to name the invoice it credits.");

    const invoice = await readInvoice(scope.db, scope.orgId, invoiceId);
    if (!invoice) return financeNotFound("That invoice does not exist.");

    const amountPence = money(body.amountPence ?? body.amount);
    if (amountPence === null) {
      return financeBadRequest(
        "A credit note needs an amount above zero, as a whole number of pence. It is stored positive; "
          + "what it does to the balance is decided by the ledger.",
      );
    }

    const reason = note(body.reason, 400);
    if (!reason) {
      return financeBadRequest(
        "A credit note needs a reason. An unexplained reduction in what somebody owes is the hardest "
          + "thing there is to answer for later.",
      );
    }

    /*
     * A CREDIT NOTE MAY NOT EXCEED WHAT IS STILL OUTSTANDING.
     *
     * Crediting more than the balance turns an obligation into a liability
     * pointing the other way, which this ledger has no record type for — the
     * counterparty would owe US on an invoice WE raised. Refused with the
     * figure named, so the operator can see whether they meant a smaller credit
     * or a refund, which is a payment in the other direction.
     */
    const before = await invoiceBalanceFor(scope.db, scope.orgId, invoiceId);
    if (before && amountPence > before.balancePence) {
      return financeConflict(
        `That credit of ${amountPence}p is more than the ${before.balancePence}p still outstanding on `
          + `${invoice.internalRef ?? invoiceId}. Credit up to the balance, or record a refund as a `
          + `payment in the other direction.`,
        { balance: before },
      );
    }

    const now = new Date();
    const existing = await countCreditNotes(scope.db, scope.orgId, invoiceId);
    const reference = text(body.reference, 80) ?? creditNoteReference(invoice.internalRef, existing);
    const issuedDate = day(body.issuedDate) ?? financeDay(now);

    const id = await createCreditNote(
      scope.db,
      scope.orgId,
      {
        invoiceId,
        reference,
        amountPence,
        reason,
        issuedDate,
        attachmentId: text(body.attachmentId, 120),
        createdBy: scope.identityEmail,
      },
      now,
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.credit_note_issued",
      entityType: "credit_note",
      entityId: id,
      summary: `Issued ${reference} against ${invoice.internalRef ?? invoiceId} for ${amountPence}p. `
        + `Reason: ${reason}`,
      detail: {
        invoiceId,
        reference,
        amountPence,
        reason,
        issuedDate,
        invoiceFinalisedAt: invoice.finalisedAt,
      },
      request,
    });

    return Response.json(
      {
        id,
        reference,
        /* The invoice row is untouched; only the computed balance moves. */
        balance: await invoiceBalanceFor(scope.db, scope.orgId, invoiceId, { now }),
      },
      { status: 201 },
    );
  } catch (error) {
    return financeUnavailable(error, "The credit note could not be issued.");
  }
}
