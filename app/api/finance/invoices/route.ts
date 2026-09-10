/**
 * `/api/finance/invoices` — the ledger, both directions, one table. §1 and §4.
 *
 * ── GET RETURNS A PAGE AND TOTALS FOR THE WHOLE FILTERED SET ───────────────
 *
 * The totals are computed in SQL over every row the filter matched, not by
 * adding up the fifty rows on the page. A summary that describes a page while
 * sitting under a list of four hundred is a wrong number presented as a right
 * one — see `invoiceTotals` in `app/lib/finance/repository.ts`.
 *
 * Balances, flags and allocations for the page are fetched in THREE batched
 * reads, never one per row.
 *
 * ── POST RUNS THE MATCH ON SAVE ────────────────────────────────────────────
 *
 * §7: the three-way match "runs on save". So creating a payable immediately
 * raises its flags, and the response carries them — the operator sees the
 * duplicate before they have moved on, which is the entire value of §7 over a
 * spreadsheet. It is not run on READ: a block that appears while somebody is
 * looking at the screen is a block nobody can trace.
 *
 * A new invoice is always a DRAFT and its allocations may not sum yet. §16's
 * "the allocation is forced to sum" is enforced at FINALISATION, in the actions
 * route, because a person building a four-way split is unbalanced for as long
 * as they are typing.
 */

import { auditActor, recordAudit } from "../../../lib/audit";
import { listAllocationsForInvoices, writeAllocations } from "../../../lib/finance/allocations";
import {
  financeBadRequest,
  financeUnavailable,
  guardFinance,
} from "../../../lib/finance/access";
import { cashPosition, invoiceBalances } from "../../../lib/finance/balance";
import {
  amountTriple,
  category,
  day,
  direction as parseDirection,
  flag,
  money,
  positiveInt,
  readBody,
  repeated,
  text,
} from "../../../lib/finance/input";
import { listFlagsForInvoices, runMatch } from "../../../lib/finance/matching";
import { dueDayFromTerms, financeDay, type InvoiceDirection } from "../../../lib/finance/model";
import { issueInvoiceReference } from "../../../lib/finance/references";
import {
  createInvoice,
  listInvoices,
  normaliseStatuses,
  recordStatusChange,
} from "../../../lib/finance/repository";
import { readFinanceSettings } from "../../../lib/finance/settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guardFinance(request, "ledger.read");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;

    const params = new URL(request.url).searchParams;
    const now = new Date();
    const page = await listInvoices(db, orgId, {
      direction: parseDirection(params.get("direction")),
      statuses: normaliseStatuses(repeated(params, "status")),
      counterpartyId: params.get("counterparty"),
      siteId: params.get("site"),
      requestId: params.get("job"),
      overdueOnly: flag(params, "overdue"),
      unmatchedOnly: flag(params, "unmatched"),
      from: day(params.get("from")),
      to: day(params.get("to")),
      search: params.get("q"),
      limit: positiveInt(params.get("limit"), 50),
      offset: positiveInt(params.get("offset"), 0),
      now,
    });

    const ids = page.rows.map((row) => row.id);
    const [balances, flags, allocations] = await Promise.all([
      invoiceBalances(db, orgId, ids, { now }),
      listFlagsForInvoices(db, orgId, ids),
      listAllocationsForInvoices(db, orgId, ids),
    ]);

    return Response.json({
      invoices: page.rows.map((row) => ({
        ...row,
        balance: balances.get(row.id) ?? null,
        flags: flags.get(row.id) ?? [],
        allocations: allocations.get(row.id) ?? [],
      })),
      totals: page.totals,
      /* §9's cash position, from the balances already in hand. A second pass
         over the database to add up numbers already in memory is how two cards
         on one screen come to disagree. */
      cashPosition: cashPosition(balances.values(), now),
      limit: page.limit,
      offset: page.offset,
    });
  } catch (error) {
    return financeUnavailable(error, "The ledger could not be read.");
  }
}

export async function POST(request: Request) {
  try {
    const guarded = await guardFinance(request, "ledger.write");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = await readBody(request);
    if (!body) return financeBadRequest("Send a JSON body.");

    const direction = parseDirection(body.direction);
    if (!direction) return financeBadRequest('`direction` must be "payable" or "receivable".');

    const amounts = amountTriple(body);
    if (typeof amounts === "string") return financeBadRequest(amounts);

    const now = new Date();
    const settings = await readFinanceSettings(scope.db, scope.orgId);
    const invoiceDate = day(body.invoiceDate) ?? financeDay(now);

    /*
     * TERMS DECIDE THE DUE DATE WHEN NOBODY TYPES ONE. §4: "14 / 30 / 60 days,
     * or on receipt", from supplier terms on a payable and agreement terms on a
     * receivable — which is why the two defaults come from different settings.
     * The arithmetic is JavaScript's, from the server day, because
     * `db/sqlite-to-postgres.ts` refuses `julianday(` by name.
     */
    const termsDays = typeof body.paymentTermsDays === "number"
      ? Math.max(0, Math.trunc(body.paymentTermsDays))
      : direction === "payable"
        ? settings.payableTermsDays
        : settings.receivableTermsDays;
    const dueAt = day(body.dueDate ?? body.dueAt) ?? dueDayFromTerms(invoiceDate, termsDays);

    const internalRef = await issueInvoiceReference(scope.db, scope.orgId, direction, yearOf(invoiceDate));

    const primaryJob = text(body.requestId ?? body.jobId, 120);

    const invoiceId = await createInvoice(
      scope.db,
      scope.orgId,
      {
        direction,
        internalRef,
        invoiceNumber: text(body.invoiceNumber, 80),
        counterpartyType: text(body.counterpartyType, 40) ?? defaultCounterpartyType(direction),
        counterpartyId: text(body.counterpartyId, 120),
        counterpartyName: text(body.counterpartyName, 200),
        contractorId: direction === "payable" ? text(body.contractorId, 120) : null,
        fromDepartment: direction === "payable" ? text(body.fromDepartment, 200) : null,
        toDepartment: direction === "receivable" ? text(body.toDepartment, 200) : null,
        faoContact: text(body.faoContact, 200),
        quoteId: text(body.quoteId, 120),
        poNumber: text(body.poNumber, 80),
        siteId: text(body.siteId, 120),
        requestId: primaryJob,
        invoiceDate,
        receivedDate: direction === "payable" ? day(body.receivedDate) : null,
        sentDate: direction === "receivable" ? day(body.sentDate) : null,
        dueAt,
        paymentTermsDays: termsDays,
        netPence: amounts.netPence,
        vatPence: amounts.vatPence,
        grossPence: amounts.grossPence,
        currency: text(body.currency, 3)?.toUpperCase() ?? settings.currency,
        costCentre: text(body.costCentre, 120),
        category: category(body.category),
        notes: text(body.notes, 2000),
        /*
         * ALWAYS A DRAFT, whatever the body asked for. §5's ladder starts at
         * Draft on both sides and every later status is reached through the
         * actions route, which is where the band, the flags and the history are
         * enforced. A create that could post straight to "approved" would be a
         * door round all three.
         */
        status: "draft",
        source: text(body.source, 40) ?? "manual",
        createdBy: scope.identityEmail,
      },
      now,
    );

    /*
     * ALLOCATIONS ARE ACCEPTED UNBALANCED HERE and refused at finalisation.
     * With none sent, the invoice's own job — where one was named — becomes its
     * single allocation, so the common one-job case needs no second call and
     * `no_linked_job` does not fire on an invoice that plainly has one.
     */
    const supplied = Array.isArray(body.allocations) ? body.allocations : null;
    const entries = supplied
      ? supplied.map((row) => {
          const entry = row as Record<string, unknown>;
          return {
            requestId: String(entry.requestId ?? entry.jobId ?? "").trim(),
            amountPence: money(entry.amountPence ?? entry.amount, { allowZero: true }) ?? 0,
            note: text(entry.note, 400),
          };
        })
      : primaryJob
        ? [{ requestId: primaryJob, amountPence: amounts.netPence, note: null }]
        : [];
    if (entries.length > 0) {
      const written = await writeAllocations(
        scope.db,
        scope.orgId,
        invoiceId,
        amounts.netPence,
        entries,
        { allowUnbalanced: true },
      );
      if (!written.ok) return financeBadRequest(written.error);
    }

    await recordStatusChange(scope.db, scope.orgId, {
      invoiceId,
      fromStatus: null,
      toStatus: "draft",
      actorEmail: scope.identityEmail,
      actorUserId: scope.session?.user.id ?? null,
      reason: null,
      now,
    });

    /* §7 — "runs on save". */
    const match = await runMatch(scope.db, scope.orgId, invoiceId, { now, settings });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "finance.invoice_created",
      entityType: "invoice",
      entityId: invoiceId,
      summary: `Recorded ${internalRef}, a ${direction} invoice for ${amounts.grossPence}p.`,
      detail: {
        direction,
        internalRef,
        grossPence: amounts.grossPence,
        flags: match.findings.map((finding) => finding.flagType),
      },
      request,
    });

    return Response.json(
      { id: invoiceId, internalRef, status: "draft", flags: match.flags, findings: match.findings },
      { status: 201 },
    );
  } catch (error) {
    return financeUnavailable(error, "The invoice could not be recorded.");
  }
}

/** The year a reference counts within — the invoice's own date, not the clock's. */
function yearOf(isoDay: string): number {
  const year = Number(isoDay.slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : new Date().getUTCFullYear();
}

/**
 * A payable comes from a contractor, a receivable goes to a client. §4.
 *
 * Stated as a default rather than forced, because a payable from a supplier who
 * is not in the contractor register is a real thing — a utility bill, a
 * landlord's service charge — and the field carries what it is.
 */
function defaultCounterpartyType(direction: InvoiceDirection): string {
  return direction === "payable" ? "contractor" : "client";
}
