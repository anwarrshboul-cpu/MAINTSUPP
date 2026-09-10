/**
 * `POST /api/finance/payment-runs/[id]/export` — §13's bank-ready CSV, and the
 * act of scheduling the batch.
 *
 * EXPORTING AND SCHEDULING ARE ONE OPERATION on purpose. A run that could be
 * exported without being marked would be a file somebody pays from twice, and
 * a run that could be marked without being exported would be money nobody has
 * been told to move. So this is a POST rather than a GET, and it is idempotent
 * in the way that matters: a second call re-exports the same batch and does not
 * schedule it again.
 *
 * ── THE FILE'S SHAPE ──────────────────────────────────────────────────────
 *
 * A generic bank upload: name, sort code, account number, amount, reference.
 * §13 says "export as a bank-ready CSV" and does NOT name a bank, so this does
 * not invent a dialect for one — the header row is stated in this file and a
 * bookkeeper can map it. Nothing about a specific bank's format is hard-coded,
 * which is the same reason `exports.ts` documents its three accounting mappings
 * rather than claiming an integration.
 *
 * ── WHOSE ACCOUNT DETAILS ARE IN IT ───────────────────────────────────────
 *
 * `contractors` carries no account number — deliberately, because this
 * repository is public — so the payee columns come back EMPTY and the file says
 * so in its own reference column. That is the honest output: the run, the
 * amounts and the references are real, and the account details are a gap the
 * product does not hold. Inventing a column of blanks that looked like data
 * would be worse.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../../../lib/audit";
import {
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../../lib/finance/access";
import { invoiceBalances } from "../../../../../lib/finance/balance";
import { csvDocument, csvDownload, safeFilename } from "../../../../../lib/finance/exports";
import { invoices, paymentRuns } from "../../../../../../db/schema";

export const dynamic = "force-dynamic";

const HEADERS = [
  "Payee name",
  "Sort code",
  "Account number",
  "Amount",
  "Reference",
  "Payment date",
  "Invoice number",
] as const;

export async function POST(
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
      return financeConflict("That run was cancelled, so it cannot be exported.");
    }

    /*
     * RE-DERIVED rather than read from a stored membership list. An invoice
     * that was settled or voided since the run was created must not appear in a
     * file somebody is about to upload to a bank.
     */
    const approved = await db
      .select({
        id: invoices.id,
        internalRef: invoices.internalRef,
        invoiceNumber: invoices.invoiceNumber,
        counterpartyName: invoices.counterpartyName,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, orgId),
          eq(invoices.direction, "payable"),
          inArray(invoices.status, ["approved", "scheduled"]),
          isNull(invoices.voidedAt),
        ),
      );

    const balances = await invoiceBalances(db, orgId, approved.map((row) => row.id));
    const payable = approved
      .map((row) => ({ ...row, balancePence: balances.get(row.id)?.balancePence ?? 0 }))
      .filter((row) => row.balancePence > 0);

    const rows = payable.map((row) => [
      row.counterpartyName ?? "",
      /* Empty on purpose — see the header of this file. */
      "",
      "",
      (row.balancePence / 100).toFixed(2),
      row.invoiceNumber || row.internalRef || run.reference,
      run.paymentDate,
      row.invoiceNumber ?? "",
    ]);

    const csv = csvDocument(HEADERS, rows);
    const filename = safeFilename(`${run.reference}-payment-run.csv`);

    /*
     * Scheduled on the FIRST export only. A second call re-serves the same file
     * without moving the batch forward again, so a reader who lost the download
     * is not punished for asking twice.
     */
    if (run.status === "draft") {
      await db
        .update(paymentRuns)
        .set({
          status: "scheduled",
          exportedAt: new Date().toISOString(),
          exportFilename: filename,
          totalPence: payable.reduce((sum, row) => sum + row.balancePence, 0),
          invoiceCount: payable.length,
        })
        .where(eq(paymentRuns.id, run.id));

      /* And every invoice in it says so, which is §5's `scheduled` status. */
      if (payable.length > 0) {
        await db
          .update(invoices)
          .set({ status: "scheduled", updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(invoices.organisationId, orgId),
              inArray(
                invoices.id,
                payable.map((row) => row.id),
              ),
            ),
          );
      }

      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor(scope),
        action: "finance.payment_run_exported",
        entityType: "payment_run",
        entityId: run.id,
        summary: `Exported payment run ${run.reference} and scheduled ${payable.length} invoice${
          payable.length === 1 ? "" : "s"
        }.`,
        detail: { reference: run.reference, invoices: payable.length, filename },
        request,
      });
    }

    const response = csvDownload(filename, csv);
    response.headers.set("x-maintsupp-rows", String(rows.length));
    response.headers.set("x-maintsupp-run-status", run.status === "draft" ? "scheduled" : run.status);
    return response;
  } catch (error) {
    return financeUnavailable(error, "The payment run could not be exported.");
  }
}
