/**
 * `/api/finance/payment-runs` — §13. "Nobody should pay 30 invoices one at a
 * time."
 *
 * A run is a batch of APPROVED payables grouped under one payment date. It
 * exports as a bank-ready CSV and marks the batch scheduled, and those two are
 * one act rather than two: a run that could be exported without being marked
 * would be a file somebody pays from twice.
 *
 * ── WHAT A RUN MAY CONTAIN ────────────────────────────────────────────────
 *
 * Approved payables with money still outstanding, and nothing else. Each is
 * re-checked at the moment the run is created rather than trusted from the
 * browser's list, because between a reader ticking a box and pressing the
 * button an invoice can be voided, credited or paid — and a run built from a
 * stale list is a payment nobody authorised.
 *
 * ── THE BANK DETAILS ARE NOT IN THE FILE THIS ROUTE BUILDS ────────────────
 *
 * §16: they live in settings. A run names a `bank_account_id`; the export
 * resolves it, and only for somebody who may see it.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeConflict,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { invoiceBalances } from "../../../lib/finance/balance";
import { financeDay } from "../../../lib/finance/model";
import { invoices, paymentRuns } from "../../../../db/schema";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "payment.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const runs = await db
      .select()
      .from(paymentRuns)
      .where(eq(paymentRuns.organisationId, orgId));

    /*
     * The candidates, alongside the runs, so the screen that builds a run and
     * the screen that lists them are one round trip. Approved payables with a
     * balance — the same test the POST re-applies.
     */
    const approved = await db
      .select({
        id: invoices.id,
        internalRef: invoices.internalRef,
        invoiceNumber: invoices.invoiceNumber,
        counterpartyName: invoices.counterpartyName,
        dueAt: invoices.dueAt,
        grossPence: invoices.grossPence,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, orgId),
          eq(invoices.direction, "payable"),
          eq(invoices.status, "approved"),
          isNull(invoices.voidedAt),
        ),
      );

    const balances = await invoiceBalances(db, orgId, approved.map((row) => row.id));
    const candidates = approved
      .map((row) => ({ ...row, balancePence: balances.get(row.id)?.balancePence ?? 0 }))
      .filter((row) => row.balancePence > 0)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));

    return Response.json({
      runs: runs.sort((a, b) => (b.paymentDate ?? "").localeCompare(a.paymentDate ?? "")),
      candidates,
      today: financeDay(new Date()),
    });
  } catch (error) {
    return financeUnavailable(error, "Payment runs could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    /*
     * `payment.write` is `board.edit`. Scheduling money to leave is not the same
     * act as APPROVING it — every invoice in the batch has already been through
     * `invoice.approve`, which is `settings.edit`, and this cannot add one that
     * has not.
     */
    const guard = await guardFinance(request, "payment.write");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return financeBadRequest("Send a JSON body.");

    const paymentDate = String(body.paymentDate ?? "").trim();
    if (!DAY.test(paymentDate)) return financeBadRequest("A run needs a payment date (YYYY-MM-DD).");

    const ids = Array.isArray(body.invoiceIds)
      ? [...new Set(body.invoiceIds.filter((id): id is string => typeof id === "string" && !!id))]
      : [];
    if (ids.length === 0) return financeBadRequest("Choose at least one approved payable.");
    if (ids.length > 200) return financeBadRequest("A run holds at most 200 invoices.");

    /*
     * RE-CHECKED HERE, not trusted from the list the browser sent. Between the
     * tick and the button an invoice can be voided, credited or paid.
     */
    const rows = await db
      .select({ id: invoices.id, status: invoices.status, direction: invoices.direction })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, orgId),
          inArray(invoices.id, ids),
          isNull(invoices.voidedAt),
        ),
      );

    const rejected = ids.filter((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      return !row || row.direction !== "payable" || row.status !== "approved";
    });
    if (rejected.length > 0) {
      return financeConflict(
        "Some of those are no longer approved payables, so the run was not created.",
        { rejected },
      );
    }

    const balances = await invoiceBalances(db, orgId, ids);
    const unsettled = ids.filter((id) => (balances.get(id)?.balancePence ?? 0) > 0);
    if (unsettled.length !== ids.length) {
      return financeConflict("Some of those have already been settled.", {
        settled: ids.filter((id) => !unsettled.includes(id)),
      });
    }

    const totalPence = unsettled.reduce(
      (sum, id) => sum + (balances.get(id)?.balancePence ?? 0),
      0,
    );
    const id = `prun_${crypto.randomUUID()}`;
    const reference = `PR-${paymentDate.replace(/-/g, "")}-${id.slice(-6).toUpperCase()}`;

    await db.insert(paymentRuns).values({
      id,
      organisationId: orgId,
      reference,
      paymentDate,
      status: "draft",
      bankAccountId: typeof body.bankAccountId === "string" ? body.bankAccountId : null,
      totalPence,
      invoiceCount: unsettled.length,
      createdBy: scope.identityEmail,
    });

    /*
     * The membership is the invoices' own `payment_run_id`… which they do not
     * have. `payments.payment_run_id` links a PAYMENT to a run, and a run is
     * created before any payment exists. So the batch is recorded in the audit
     * detail and re-derived at export time from the same approved-and-unsettled
     * test — which is also what keeps a run honest if an invoice is settled
     * between creating it and exporting it.
     */
    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "finance.payment_run_created",
      entityType: "payment_run",
      entityId: id,
      summary: `Created payment run ${reference} for ${unsettled.length} invoice${
        unsettled.length === 1 ? "" : "s"
      }.`,
      detail: { reference, paymentDate, invoiceIds: unsettled, totalPence },
      request,
    });

    return Response.json(
      { id, reference, paymentDate, totalPence, invoiceCount: unsettled.length, status: "draft" },
      { status: 201 },
    );
  } catch (error) {
    return financeUnavailable(error, "The payment run could not be created.");
  }
}
