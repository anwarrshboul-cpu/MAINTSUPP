/**
 * `/api/finance/statements` — §15.4, supplier statement reconciliation.
 *
 * "Paste a supplier's statement, match against your ledger, list what they
 * think you owe that you have no record of. Catches lost invoices before they
 * become a dispute."
 *
 * ── NOTHING IS EVER CREATED FROM A STATEMENT ──────────────────────────────
 *
 * A statement is a supplier's assertion, not a document. This route stores what
 * they claimed and reports how it compares; it never writes an invoice, because
 * an invoice created from a counterparty's own file is a payable nobody in this
 * workspace has seen. The `supplier_only` rows are the output — they are the
 * whole point of the exercise — and acting on one is a human opening the
 * invoice form.
 *
 * ── FOUR OUTCOMES, AND EACH IS A DIFFERENT CONVERSATION ───────────────────
 *
 *   · `matched`        — same reference, same amount. Nothing to do.
 *   · `amount_differs` — same reference, different amount. One of you is wrong,
 *                        and the difference is the size of the argument.
 *   · `supplier_only`  — they have a reference the ledger does not. Either a
 *                        lost invoice or one they never sent.
 *   · `ledger_only`    — the ledger holds an unsettled invoice their statement
 *                        does not mention. Reported alongside, because a
 *                        supplier who has forgotten to bill you is a liability
 *                        that arrives later, not a saving.
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { invoiceBalances } from "../../../lib/finance/balance";
import { penceFromInput } from "../../../lib/finance/model";
import { invoices, supplierStatementLines, supplierStatements } from "../../../../db/schema";

export const dynamic = "force-dynamic";

/** Compared on a normalised copy: a supplier's own reference has been typed twice. */
const refKey = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase().replace(/[\s/\\-]+/g, "");

export async function GET(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.read");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const statements = await db
      .select()
      .from(supplierStatements)
      .where(eq(supplierStatements.organisationId, orgId));

    const lines = await db
      .select()
      .from(supplierStatementLines)
      .where(eq(supplierStatementLines.organisationId, orgId));

    return Response.json({
      statements: statements.sort((a, b) =>
        (b.statementDate ?? "").localeCompare(a.statementDate ?? ""),
      ),
      lines,
    });
  } catch (error) {
    return financeUnavailable(error, "Supplier statements could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guard = await guardFinance(request, "ledger.write");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const { db, orgId } = scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return financeBadRequest("Send a JSON body.");

    const statementDate = String(body.statementDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(statementDate)) {
      return financeBadRequest("A statement needs its date (YYYY-MM-DD).");
    }
    const counterpartyId = typeof body.counterpartyId === "string" ? body.counterpartyId : null;
    const counterpartyName = String(body.counterpartyName ?? "").trim().slice(0, 160) || null;
    if (!counterpartyId && !counterpartyName) {
      return financeBadRequest("Say whose statement this is.");
    }

    const rawLines = Array.isArray(body.lines) ? body.lines : null;
    if (!rawLines || rawLines.length === 0) return financeBadRequest("A statement needs lines.");
    if (rawLines.length > 500) return financeBadRequest("At most 500 lines in one statement.");

    const claimed = rawLines.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        supplierRef: String(row.supplierRef ?? "").trim().slice(0, 120) || null,
        invoiceDate: String(row.invoiceDate ?? "").trim().slice(0, 10) || null,
        amountPence: penceFromInput(row.amount ?? row.amountPence) ?? 0,
      };
    });

    /* The ledger's own unsettled payables for this counterparty. */
    const ledgerRows = await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        internalRef: invoices.internalRef,
        counterpartyId: invoices.counterpartyId,
        counterpartyName: invoices.counterpartyName,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, orgId),
          eq(invoices.direction, "payable"),
          isNull(invoices.voidedAt),
          ne(invoices.status, "draft"),
        ),
      );

    const theirs = counterpartyId
      ? ledgerRows.filter((row) => row.counterpartyId === counterpartyId)
      : ledgerRows.filter(
          (row) => refKey(row.counterpartyName) === refKey(counterpartyName),
        );

    const balances = await invoiceBalances(db, orgId, theirs.map((row) => row.id));
    const byRef = new Map<string, (typeof theirs)[number]>();
    for (const row of theirs) {
      const key = refKey(row.invoiceNumber) || refKey(row.internalRef);
      if (key) byRef.set(key, row);
    }

    const statementId = `stmt_${crypto.randomUUID()}`;
    const matchedIds = new Set<string>();
    const lineValues = claimed.map((line) => {
      const match = line.supplierRef ? byRef.get(refKey(line.supplierRef)) : undefined;
      let matchState: string = "supplier_only";
      if (match) {
        matchedIds.add(match.id);
        const outstanding = balances.get(match.id)?.balancePence ?? 0;
        matchState = outstanding === line.amountPence ? "matched" : "amount_differs";
      }
      return {
        id: `stln_${crypto.randomUUID()}`,
        organisationId: orgId,
        statementId,
        supplierRef: line.supplierRef,
        invoiceDate: line.invoiceDate,
        amountPence: line.amountPence,
        matchedInvoiceId: match?.id ?? null,
        matchState,
        note: null,
      };
    });

    /*
     * What the ledger holds and the statement does not. Written as lines too,
     * so one query returns the whole comparison and the UI does not have to
     * subtract two lists to find the interesting half.
     */
    for (const row of theirs) {
      if (matchedIds.has(row.id)) continue;
      const outstanding = balances.get(row.id)?.balancePence ?? 0;
      if (outstanding <= 0) continue;
      lineValues.push({
        id: `stln_${crypto.randomUUID()}`,
        organisationId: orgId,
        statementId,
        supplierRef: row.invoiceNumber ?? row.internalRef ?? null,
        invoiceDate: null,
        amountPence: outstanding,
        matchedInvoiceId: row.id,
        matchState: "ledger_only",
        note: null,
      });
    }

    const claimedTotalPence = claimed.reduce((sum, line) => sum + line.amountPence, 0);

    await db.insert(supplierStatements).values({
      id: statementId,
      organisationId: orgId,
      counterpartyId,
      counterpartyName,
      statementDate,
      claimedTotalPence,
      sourceFilename: String(body.sourceFilename ?? "").trim().slice(0, 200) || null,
      uploadedBy: scope.identityEmail,
    });
    for (const value of lineValues) await db.insert(supplierStatementLines).values(value);

    const summary = {
      matched: lineValues.filter((line) => line.matchState === "matched").length,
      amountDiffers: lineValues.filter((line) => line.matchState === "amount_differs").length,
      supplierOnly: lineValues.filter((line) => line.matchState === "supplier_only").length,
      ledgerOnly: lineValues.filter((line) => line.matchState === "ledger_only").length,
    };
    const ledgerTotalPence = theirs.reduce(
      (sum, row) => sum + Math.max(0, balances.get(row.id)?.balancePence ?? 0),
      0,
    );

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(scope),
      action: "finance.statement_reconciled",
      entityType: "supplier_statement",
      entityId: statementId,
      summary: `Reconciled a statement from ${counterpartyName ?? "a supplier"}: ${summary.matched} matched, ${summary.supplierOnly} not in the ledger.`,
      detail: { statementDate, claimedTotalPence, ledgerTotalPence, ...summary },
      request,
    });

    return Response.json(
      {
        id: statementId,
        statementDate,
        counterpartyName,
        claimedTotalPence,
        ledgerTotalPence,
        /* The number the conversation is actually about. */
        differencePence: claimedTotalPence - ledgerTotalPence,
        summary,
        lines: lineValues,
      },
      { status: 201 },
    );
  } catch (error) {
    return financeUnavailable(error, "The statement could not be reconciled.");
  }
}
