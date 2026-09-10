/**
 * `/api/finance/quotes/[id]` — one quote, and the others on its job beside it.
 *
 * GET returns the COMPARISON SET, not just the row asked for: §3's comparison
 * view is "where a job has more than one quote, show them side by side with
 * amounts, dates and validity". Returning the siblings here means the panel
 * needs one call and cannot draw a comparison that is missing a competitor
 * because a second request had not landed yet.
 *
 * PATCH edits the commercial detail while the quote is still live. An APPROVED
 * or REJECTED quote is refused: the decision was recorded with a name and a
 * time against those figures, and editing the figures underneath it would make
 * the record describe a price nobody approved. The way back is a new quote,
 * which is what `superseded_by_id` exists for.
 */

import { auditActor, changeDetail, recordAudit } from "../../../../lib/audit";
import {
  financeBadRequest,
  financeConflict,
  financeNotFound,
  financeUnavailable,
  guardFinance,
} from "../../../../lib/finance/access";
import { amountTriple, day, readBody, text } from "../../../../lib/finance/input";
import { financeDay, quoteStatusKey } from "../../../../lib/finance/model";
import { listQuotes, readQuote, updateQuote, type QuotePatch } from "../../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "quote.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;

    const quote = await readQuote(db, orgId, id);
    if (!quote) return financeNotFound("That quote does not exist.");

    const siblings = await listQuotes(db, orgId, { requestId: quote.requestId, limit: 50 });
    const today = financeDay(new Date());
    return Response.json({
      quote: { ...quote, statusKey: quoteStatusKey(quote.status) },
      /* §3's comparison view: every quote on the same job, this one included. */
      comparison: siblings.rows.map((row) => ({
        id: row.id,
        internalRef: row.internalRef,
        supplierRef: row.supplierRef,
        contractorId: row.contractorId,
        netPence: row.netPence,
        grossPence: row.grossPence,
        quoteDate: row.quoteDate,
        validUntil: row.validUntil,
        statusKey: quoteStatusKey(row.status),
        status: row.status,
        expired: Boolean(row.validUntil && row.validUntil.slice(0, 10) < today),
        rejectedReason: row.rejectedReason,
      })),
    });
  } catch (error) {
    return financeUnavailable(error, "The quote could not be read.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const guarded = await guardFinance(request, "quote.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const quote = await readQuote(scope.db, scope.orgId, id);
    if (!quote) return financeNotFound("That quote does not exist.");

    const key = quoteStatusKey(quote.status);
    if (key === "approved" || key === "rejected") {
      return financeConflict(
        `This quote was ${key} on ${(quote.approvedAt ?? quote.rejectedAt ?? "").slice(0, 10) || "a recorded date"} `
          + "and its figures are part of that decision. Log a new quote instead; the old one is superseded.",
      );
    }

    const patch: QuotePatch = {};
    if (body.supplierRef !== undefined) patch.supplierRef = text(body.supplierRef, 80);
    if (body.description !== undefined) patch.description = text(body.description, 2000);
    if (body.contractorId !== undefined) patch.contractorId = text(body.contractorId, 120);
    if (body.siteId !== undefined) patch.siteId = text(body.siteId, 120);
    if (body.poNumber !== undefined) patch.poNumber = text(body.poNumber, 80);
    if (body.clientApprovalRequired !== undefined) {
      patch.clientApprovalRequired = body.clientApprovalRequired === true;
    }
    for (const field of ["quoteDate", "validUntil"] as const) {
      if (body[field] === undefined) continue;
      const parsed = day(body[field]);
      if (!parsed) return financeBadRequest(`\`${field}\` must be a YYYY-MM-DD date.`);
      patch[field] = parsed;
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

    const quoteDate = (patch.quoteDate ?? quote.quoteDate) as string | null;
    const validUntil = (patch.validUntil ?? quote.validUntil) as string | null;
    if (quoteDate && validUntil && validUntil < quoteDate) {
      return financeBadRequest("A quote cannot expire before the day it was given.");
    }

    await updateQuote(scope.db, scope.orgId, id, patch);
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.quote_updated",
      entityType: "quotation",
      entityId: id,
      summary: `Edited ${quote.internalRef ?? id}: ${Object.keys(patch).join(", ")}.`,
      detail: changeDetail(
        quote as unknown as Record<string, unknown>,
        patch as unknown as Record<string, unknown>,
      ),
      request,
    });

    return Response.json({ quote: await readQuote(scope.db, scope.orgId, id) });
  } catch (error) {
    return financeUnavailable(error, "The quote could not be changed.");
  }
}
