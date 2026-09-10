/**
 * `/api/finance/invoices/[id]/allocations` — the multi-job split. §4.
 *
 * ── PUT THE WHOLE SET, NEVER A ROW AT A TIME ───────────────────────────────
 *
 * "Enforce the sum" is a property of the SET, and a per-row API makes it a
 * property nothing owns: every partial edit is a moment where it is false, and
 * the only place left to check it is a screen that can be closed halfway
 * through. Sending the whole set makes it checkable once, against one payload,
 * before anything is written.
 *
 * ── AN UNBALANCED SET IS REFUSED WITH THE GAP NAMED ────────────────────────
 *
 * Not "invalid allocation" — the actual sentence says what the lines come to,
 * what the invoice net is, and which way round the difference goes, because
 * that is the difference between a person fixing it in ten seconds and a person
 * re-typing four numbers to find out which one was wrong.
 *
 * A DRAFT may be saved unbalanced with `?draft=1`, because somebody building a
 * four-way split is unbalanced for as long as they are typing. Finalisation
 * refuses regardless — see the actions route.
 */

import { auditActor, recordAudit } from "../../../../../lib/audit";
import {
  listAllocations,
  writeAllocations,
} from "../../../../../lib/finance/allocations";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../../lib/finance/access";
import { money, readBody, text } from "../../../../../lib/finance/input";
import { runMatch } from "../../../../../lib/finance/matching";
import { readInvoice } from "../../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    const invoice = await readInvoice(db, orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");
    return Response.json({
      allocations: await listAllocations(db, orgId, id),
      targetPence: invoice.netPence ?? invoice.grossPence ?? 0,
    });
  } catch (error) {
    return financeUnavailable(error, "The allocations could not be read.");
  }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "ledger.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");
    if (!Array.isArray(body.allocations)) {
      return financeBadRequest("`allocations` must be an array of { requestId, amountPence }.");
    }

    const invoice = await readInvoice(scope.db, scope.orgId, id);
    if (!invoice) return financeNotFound("That invoice does not exist.");
    if (invoice.finalisedAt) {
      return financeConflict(
        "This invoice is finalised. Its allocations decide which job carries which cost and are "
          + "part of the accounting record — a correction goes through a credit note.",
      );
    }
    if (invoice.voidedAt) return financeConflict("A voided invoice cannot be re-allocated.");

    const entries = body.allocations.map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        requestId: String(entry.requestId ?? entry.jobId ?? "").trim(),
        amountPence: money(entry.amountPence ?? entry.amount, { allowZero: true }) ?? Number.NaN,
        note: text(entry.note, 400),
      };
    });
    const unreadable = entries.findIndex((entry) => !Number.isFinite(entry.amountPence));
    if (unreadable >= 0) {
      return financeBadRequest(
        `Line ${unreadable + 1} has no readable amount. Every line needs a whole number of pence.`,
      );
    }

    const allowUnbalanced = new URL(request.url).searchParams.get("draft") === "1";
    const target = invoice.netPence ?? invoice.grossPence ?? 0;
    const written = await writeAllocations(
      scope.db,
      scope.orgId,
      id,
      target,
      entries,
      { allowUnbalanced },
    );
    if (!written.ok) {
      return financeConflict(written.error, { allocation: written.state });
    }

    /* The split decides which job carries which cost, and `job_not_complete`
       and `site_mismatch` are both computed FROM it — so the match is re-run
       rather than left describing the previous set. */
    const match = await runMatch(scope.db, scope.orgId, id);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.allocations_written",
      entityType: "invoice",
      entityId: id,
      summary: `Allocated ${invoice.internalRef ?? id} across ${written.rows.length} `
        + `job${written.rows.length === 1 ? "" : "s"}, totalling ${written.state.totalPence}p.`,
      detail: {
        allocation: written.state,
        jobs: written.rows.map((row) => ({ requestId: row.requestId, amountPence: row.amountPence })),
      },
      request,
    });

    return Response.json({
      allocations: written.rows,
      allocation: written.state,
      flags: match.flags,
    });
  } catch (error) {
    return financeUnavailable(error, "The allocations could not be saved.");
  }
}
