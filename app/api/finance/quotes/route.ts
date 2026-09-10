/**
 * `/api/finance/quotes` — quotes as first-class records. §3.
 *
 * "Track them as first-class records, not as attachments on a job." They live
 * in `quotations`, which already existed with the right shape and the right
 * NOT NULL constraint on `request_id` — §3's "Linked job: Required — a quote
 * with no job is an orphan" was already true of this table before Module 5
 * asked for it.
 *
 * GET supports the COMPARISON VIEW by taking `?job=MN-1234`: every quote on one
 * job, so a screen can put three prices side by side. §3 is explicit about why
 * that matters — "Three quotes on a £6,500 project is a very different
 * conversation with a client than one."
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import {
  financeBadRequest,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { amountTriple, day, flag, positiveInt, readBody, repeated, text } from "../../../lib/finance/input";
import { financeDay, financeStatusKey, quoteStatusKey } from "../../../lib/finance/model";
import { issueQuoteReference } from "../../../lib/finance/references";
import { createQuote, listQuotes } from "../../../lib/finance/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guardFinance(request, "quote.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;

    const params = new URL(request.url).searchParams;
    const now = new Date();
    const page = await listQuotes(db, orgId, {
      requestId: params.get("job"),
      contractorId: params.get("contractor"),
      siteId: params.get("site"),
      statuses: repeated(params, "status").map(financeStatusKey),
      expiredOnly: flag(params, "expired"),
      search: params.get("q"),
      limit: positiveInt(params.get("limit"), 50),
      offset: positiveInt(params.get("offset"), 0),
      now,
    });

    const today = financeDay(now);
    return Response.json({
      quotes: page.rows.map((row) => ({
        ...row,
        /* The key, beside the raw label. §5's unmapped rule applies to quotes
           too: a status this vocabulary has never heard of keeps its own words
           and is rendered grey rather than dropped. */
        statusKey: quoteStatusKey(row.status),
        expired: Boolean(row.validUntil && row.validUntil.slice(0, 10) < today),
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  } catch (error) {
    return financeUnavailable(error, "The quotes could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guardFinance(request, "quote.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const requestId = text(body.requestId ?? body.jobId, 120);
    if (!requestId) {
      return financeBadRequest("A quote has to name a job. A quote with no job is an orphan.");
    }

    const amounts = amountTriple(body);
    if (typeof amounts === "string") return financeBadRequest(amounts);

    const now = new Date();
    const quoteDate = day(body.quoteDate) ?? financeDay(now);
    const validUntil = day(body.validUntil);
    if (validUntil && validUntil < quoteDate) {
      return financeBadRequest("A quote cannot expire before the day it was given.");
    }

    const internalRef = await issueQuoteReference(scope.db, scope.orgId, yearOf(quoteDate));
    const status = quoteStatusKey(typeof body.status === "string" ? body.status : "received");

    /*
     * A NEW QUOTE IS NEVER "approved". §3 requires `approved_by` and
     * `approved_at` to move there, and both are recorded by the actions route
     * with the session behind them. Accepting "approved" in a create body would
     * be an approval with nobody's name on it.
     */
    const safeStatus = status === "approved" || status === "rejected" ? "received" : status;

    const quoteId = await createQuote(
      scope.db,
      scope.orgId,
      {
        internalRef,
        supplierRef: text(body.supplierRef ?? body.quoteReference, 80),
        requestId,
        contractorId: text(body.contractorId, 120),
        siteId: text(body.siteId, 120),
        description: text(body.description, 2000),
        netPence: amounts.netPence,
        vatPence: amounts.vatPence,
        grossPence: amounts.grossPence,
        quoteDate,
        validUntil,
        status: safeStatus,
        clientApprovalRequired: body.clientApprovalRequired === true,
        poNumber: text(body.poNumber, 80),
        createdBy: scope.identityEmail,
      },
      now,
    );

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.quote_created",
      entityType: "quotation",
      entityId: quoteId,
      summary: `Logged ${internalRef} against ${requestId} for ${amounts.grossPence}p.`,
      detail: { internalRef, requestId, grossPence: amounts.grossPence, validUntil },
      request,
    });

    return Response.json({ id: quoteId, internalRef, status: safeStatus }, { status: 201 });
  } catch (error) {
    return financeUnavailable(error, "The quote could not be recorded.");
  }
}

/** The year a reference counts within — the quote's own date, not the clock's. */
function yearOf(isoDay: string): number {
  const year = Number(isoDay.slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : new Date().getUTCFullYear();
}
