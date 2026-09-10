/**
 * `/api/finance/payments` — a payment is its own record. §6.
 *
 * "One invoice can have several payments; one payment can cover several
 * invoices." Both fall out of `payment_alloc` being its own table, and neither
 * is expressible as a `paid_at` column on the invoice — which is why the legacy
 * one is left unread.
 *
 * ── THE ALLOCATIONS MUST SUM TO THE PAYMENT ────────────────────────────────
 *
 * Checked before anything is written, and refused with the gap named. A payment
 * allocated to £900 of a £1,000 transfer leaves £100 that has left the bank and
 * settles nothing — and no report can find it afterwards, because the only
 * record of the difference is the arithmetic nobody did.
 *
 * ── THE DIRECTION OF THE MONEY MUST MATCH THE OBLIGATION ───────────────────
 *
 * Money OUT settles a payable; money IN settles a receivable. Enforced on the
 * way in — see `createPayment` — so that `balance.ts` can sum allocations
 * plainly at read time without asking which way each one pointed.
 *
 * ── BANK DETAILS ARE NOT HERE ──────────────────────────────────────────────
 *
 * §16: "Bank details appear only in settings, never in code." A payment carries
 * a `payment_source_id` and nothing else; the account itself lives in
 * `payment_sources`, typed by an administrator, and this repository is public.
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { invoiceBalances } from "../../../lib/finance/balance";
import {
  METHOD_LIST,
  day,
  method as parseMethod,
  money,
  note,
  paymentDirection,
  positiveInt,
  readBody,
  text,
} from "../../../lib/finance/input";
import { financeDay } from "../../../lib/finance/model";
import { createPayment, listPayments } from "../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guardFinance(request, "payment.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    const params = new URL(request.url).searchParams;

    const page = await listPayments(db, orgId, {
      direction: paymentDirection(params.get("direction")),
      method: params.get("method"),
      from: day(params.get("from")),
      to: day(params.get("to")),
      invoiceId: params.get("invoice"),
      limit: positiveInt(params.get("limit"), 50),
      offset: positiveInt(params.get("offset"), 0),
    });
    return Response.json(page);
  } catch (error) {
    return financeUnavailable(error, "The payments could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guardFinance(request, "payment.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const direction = paymentDirection(body.direction);
    if (!direction) return financeBadRequest('`direction` must be "in" or "out".');

    const amountPence = money(body.amountPence ?? body.amount);
    if (amountPence === null) {
      return financeBadRequest("A payment needs an amount above zero, as a whole number of pence.");
    }

    const method = parseMethod(body.method) ?? "bank_transfer";
    if (body.method !== undefined && !parseMethod(body.method)) {
      return financeBadRequest(`\`method\` must be one of: ${METHOD_LIST}.`);
    }

    const now = new Date();
    const paymentDate = day(body.paymentDate) ?? financeDay(now);
    if (!Array.isArray(body.allocations)) {
      return financeBadRequest(
        "`allocations` must be an array of { invoiceId, amountPence } summing to the payment.",
      );
    }

    const allocations = body.allocations.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        invoiceId: String(entry.invoiceId ?? "").trim(),
        amountPence: money(entry.amountPence ?? entry.amount, { allowZero: true }) ?? Number.NaN,
      };
    });
    const unreadable = allocations.findIndex((row) => !Number.isFinite(row.amountPence));
    if (unreadable >= 0) {
      return financeBadRequest(
        `Allocation ${unreadable + 1} has no readable amount. Every line needs a whole number of pence.`,
      );
    }

    const written = await createPayment(
      scope.db,
      scope.orgId,
      {
        reference: text(body.reference, 80),
        direction,
        amountPence,
        paymentDate,
        method,
        paymentSourceId: text(body.paymentSourceId, 120),
        note: note(body.note, 2000),
        recordedBy: scope.identityEmail,
      },
      allocations,
      now,
    );
    if (!written.ok) return financeBadRequest(written.error);

    /*
     * The balances AFTER the payment, so the caller can move an invoice on
     * without a second round trip and without computing a balance itself —
     * §6's "never store a balance" is only worth anything if nothing else is
     * tempted to work one out.
     */
    const balances = await invoiceBalances(
      scope.db,
      scope.orgId,
      allocations.map((row) => row.invoiceId),
      { now },
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.payment_recorded",
      entityType: "payment",
      entityId: written.id,
      summary: `Recorded a ${direction === "out" ? "payment out" : "receipt"} of ${amountPence}p on `
        + `${paymentDate} across ${allocations.length} invoice${allocations.length === 1 ? "" : "s"}.`,
      detail: { direction, amountPence, method, paymentDate, allocations },
      request,
    });

    return Response.json(
      { id: written.id, balances: Object.fromEntries(balances) },
      { status: 201 },
    );
  } catch (error) {
    return financeUnavailable(error, "The payment could not be recorded.");
  }
}
