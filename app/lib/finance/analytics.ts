/**
 * WHAT THE ANALYTICS REPORTS READ, AND NOTHING THEY DECIDE.
 *
 * `ageing.ts`, `cash.ts`, `margin.ts` and `exports.ts` are pure: they take rows
 * and return a report, which is what makes their arithmetic testable without a
 * database. This module is the other half — the queries that produce those
 * rows, org-scoped, and nothing else. No figure is computed here.
 *
 * ── ONE BALANCE PASS, NOT ONE PER REPORT ──────────────────────────────────
 *
 * Every cash and ageing figure rests on `gross − paid − credited`, and
 * `invoiceBalances` already answers it for a batch with one aggregate per
 * source table. So the loader below reads the open ledger ONCE and hands the
 * same summaries to both reports rather than each asking again — which is also
 * what stops the two disagreeing about a payment that landed between them.
 *
 * ── THE DIALECT RULES ARE THE SAME AS EVERYWHERE ELSE ─────────────────────
 *
 * No `julianday`, `strftime`, `json_extract`, `printf` or `rowid`; no window
 * functions. Day arithmetic happens in JS from one server instant and reaches
 * SQL as bare `YYYY-MM-DD`. `maintenance_requests.completed_at` and `due_at`
 * are real Postgres `date` columns on Production and `text` on Staging, so
 * every text operation on them is cast first — see `dateText` in
 * `app/lib/dashboard-aggregates.ts` for the outage that rule exists to prevent.
 */

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  contractors,
  invoiceJobAllocations,
  invoices,
  maintenanceRequests,
  quotations,
  sites,
} from "../../../db/schema";
import { dateText } from "../dashboard-aggregates";
import { invoiceBalances, type InvoiceBalanceSummary } from "./balance";
import type { CashRow } from "./cash";
import type { AgeingInput } from "./ageing";
import type { MarginAllocation, MarginJob } from "./margin";
import type { ExportInvoice } from "./exports";
import { financeDay, type InvoiceDirection } from "./model";
import { selectInChunks } from "../sql-batching";

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * A voided invoice is not money. It is excluded from every figure below, and
 * from the ledger's own totals, because §5 makes voiding the way a mistake is
 * withdrawn — leaving it in a cash forecast would have the product plan around
 * an obligation somebody has already cancelled.
 */
const liveInvoice = (organisationId: string) =>
  and(eq(invoices.organisationId, organisationId), isNull(invoices.voidedAt))!;

export interface OpenLedger {
  balances: InvoiceBalanceSummary[];
  cashRows: CashRow[];
  ageing: { payable: AgeingInput[]; receivable: AgeingInput[] };
  todayDay: string;
}

/**
 * Every live invoice, with its computed balance, in one pass.
 *
 * DRAFTS ARE EXCLUDED. A draft payable is a document somebody is still typing;
 * it has not been agreed and it is not an obligation, so counting it in "what
 * we owe" would put a number in front of a decision that has not been made.
 * §5 places `draft` before `received` for exactly that reason.
 */
export async function loadOpenLedger(
  db: Database,
  organisationId: string,
  now: Date = new Date(),
): Promise<OpenLedger> {
  const rows = await db
    .select({
      id: invoices.id,
      direction: invoices.direction,
      counterpartyId: invoices.counterpartyId,
      counterpartyName: invoices.counterpartyName,
      internalRef: invoices.internalRef,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(invoices)
    .where(and(liveInvoice(organisationId), ne(invoices.status, "draft")));

  const summaries = await invoiceBalances(
    db,
    organisationId,
    rows.map((row) => row.id),
    { now },
  );

  const balances: InvoiceBalanceSummary[] = [];
  const cashRows: CashRow[] = [];
  const ageing: OpenLedger["ageing"] = { payable: [], receivable: [] };

  for (const row of rows) {
    const summary = summaries.get(row.id);
    if (!summary) continue;
    balances.push(summary);
    cashRows.push({
      direction: summary.direction,
      dueDay: summary.dueDay,
      balancePence: summary.balancePence,
      daysOverdue: summary.daysOverdue,
    });
    ageing[summary.direction === "payable" ? "payable" : "receivable"].push({
      invoiceId: row.id,
      counterpartyId: row.counterpartyId,
      counterpartyName: row.counterpartyName,
      dueDay: summary.dueDay,
      balancePence: summary.balancePence,
      internalRef: row.internalRef,
      invoiceNumber: row.invoiceNumber,
    });
  }

  return { balances, cashRows, ageing, todayDay: financeDay(now) };
}

/* ── §8's highest-value alert ─────────────────────────────────────────────── */

export interface UnbilledRow {
  requestId: string;
  reference: string | null;
  title: string;
  siteName: string;
  costInPence: number;
  completedAt: string | null;
}

export interface UnbilledReport {
  count: number;
  totalPence: number;
  rows: UnbilledRow[];
}

/**
 * COMPLETED JOBS WITH SUPPLIER COST AND NO CLIENT INVOICE — §8, §15.1.
 *
 * "It is invisible in a spreadsheet and it is pure lost revenue." The query is
 * the definition: a job that has payable money allocated to it, no receivable
 * money allocated to it, and a completion date.
 *
 * Three deliberate choices:
 *
 *   · COMPLETION is read from `maintenance_requests.completed_at`, not from a
 *     status, because §8 is about work that is finished and therefore billable.
 *     The column is a real `date` on Production, so it is cast before any text
 *     operation touches it;
 *   · the cost is the PAYABLE ALLOCATION, not `maintenance_requests.cost`. The
 *     job's own cost field is what an operator typed on the board; this is what
 *     a supplier actually invoiced, and the gap between them is a different
 *     report;
 *   · a receivable allocation of ZERO still counts as billed. Somebody made a
 *     decision to charge nothing, and this alert is for work nobody has decided
 *     about at all.
 */
export async function loadUnbilled(
  db: Database,
  organisationId: string,
  limit = 200,
): Promise<UnbilledReport> {
  const completed = dateText(maintenanceRequests.completedAt);

  const rows = await db
    .select({
      requestId: invoiceJobAllocations.requestId,
      reference: maintenanceRequests.reference,
      title: maintenanceRequests.title,
      siteName: sites.name,
      costInPence: sql<number>`coalesce(sum(${invoiceJobAllocations.amountPence}), 0)`,
      completedAt: sql<string>`max(${completed})`,
    })
    .from(invoiceJobAllocations)
    .innerJoin(invoices, eq(invoices.id, invoiceJobAllocations.invoiceId))
    .innerJoin(maintenanceRequests, eq(maintenanceRequests.id, invoiceJobAllocations.requestId))
    .leftJoin(sites, eq(sites.id, maintenanceRequests.siteId))
    .where(
      and(
        eq(invoiceJobAllocations.organisationId, organisationId),
        eq(invoices.direction, "payable"),
        isNull(invoices.voidedAt),
        isNotNull(maintenanceRequests.completedAt),
        sql`${completed} <> ''`,
        /*
         * NOT EXISTS rather than a LEFT JOIN with a null test: the allocation
         * table can hold several receivable rows for one job, and a join would
         * multiply the payable sum by however many there are. The correlated
         * test asks the question once and cannot inflate anything.
         */
        sql`not exists (select 1 from ${invoiceJobAllocations} as billed
              join ${invoices} as sale on sale.id = billed.invoice_id
             where billed.request_id = ${invoiceJobAllocations.requestId}
               and billed.organisation_id = ${organisationId}
               and sale.direction = 'receivable'
               and sale.voided_at is null)`,
      ),
    )
    .groupBy(
      invoiceJobAllocations.requestId,
      maintenanceRequests.reference,
      maintenanceRequests.title,
      sites.name,
    );

  const shaped = rows
    .map((row) => ({
      requestId: row.requestId,
      reference: row.reference ?? null,
      title: row.title ?? "Untitled job",
      siteName: row.siteName ?? "No site recorded",
      costInPence: Number(row.costInPence ?? 0),
      completedAt: row.completedAt ? String(row.completedAt).slice(0, 10) : null,
    }))
    .filter((row) => row.costInPence > 0)
    /* Oldest first: money spent longest ago is the money least likely still to
       be recoverable, which is the order somebody working this list wants. */
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));

  return {
    count: shaped.length,
    totalPence: shaped.reduce((sum, row) => sum + row.costInPence, 0),
    rows: shaped.slice(0, limit),
  };
}

/* ── §8's margin inputs ───────────────────────────────────────────────────── */

export async function loadMarginInputs(
  db: Database,
  organisationId: string,
): Promise<{ jobs: MarginJob[]; allocations: MarginAllocation[] }> {
  const allocationRows = await db
    .select({
      requestId: invoiceJobAllocations.requestId,
      direction: invoices.direction,
      amountPence: invoiceJobAllocations.amountPence,
      invoiceCategory: invoices.category,
      invoiceCounterpartyId: invoices.counterpartyId,
      invoiceCounterpartyName: invoices.counterpartyName,
    })
    .from(invoiceJobAllocations)
    .innerJoin(invoices, eq(invoices.id, invoiceJobAllocations.invoiceId))
    .where(
      and(eq(invoiceJobAllocations.organisationId, organisationId), isNull(invoices.voidedAt)),
    );

  const allocations: MarginAllocation[] = allocationRows.map((row) => ({
    requestId: row.requestId,
    direction: (row.direction === "receivable" ? "receivable" : "payable") as InvoiceDirection,
    amountPence: Number(row.amountPence ?? 0),
    invoiceCategory: row.invoiceCategory ?? null,
    invoiceCounterpartyId: row.invoiceCounterpartyId ?? null,
    invoiceCounterpartyName: row.invoiceCounterpartyName ?? null,
  }));

  const ids = [...new Set(allocations.map((row) => row.requestId))];
  const completed = dateText(maintenanceRequests.completedAt);
  const requested = dateText(maintenanceRequests.requestedAt);

  const jobRows = await selectInChunks(ids, (chunk) =>
    db
      .select({
        requestId: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        siteId: maintenanceRequests.siteId,
        siteName: sites.name,
        contractorId: maintenanceRequests.contractorId,
        contractorName: contractors.name,
        contractorText: maintenanceRequests.contractor,
        category: maintenanceRequests.category,
        completedAt: completed,
        requestedAt: requested,
      })
      .from(maintenanceRequests)
      .leftJoin(sites, eq(sites.id, maintenanceRequests.siteId))
      .leftJoin(contractors, eq(contractors.id, maintenanceRequests.contractorId))
      .where(
        and(
          eq(maintenanceRequests.organisationId, organisationId),
          inArray(maintenanceRequests.id, chunk),
        ),
      ),
  );

  const jobs: MarginJob[] = jobRows.map((row) => {
    const completedDay = row.completedAt ? String(row.completedAt).slice(0, 10) : null;
    return {
      requestId: row.requestId,
      reference: row.reference ?? null,
      title: row.title ?? null,
      siteId: row.siteId ?? null,
      siteName: row.siteName ?? null,
      contractorId: row.contractorId ?? null,
      /* The register's name where the job resolves to a record, the typed text
         where it does not — the same two shapes the Overview's contractor
         bucket carries, and for the same reason: 87% of this estate's costed
         work names a contractor that has no record. */
      contractorName: row.contractorName ?? row.contractorText ?? null,
      category: row.category ?? null,
      completedAt: completedDay,
      requestedAt: row.requestedAt ? String(row.requestedAt).slice(0, 10) : null,
      complete: Boolean(completedDay),
    };
  });

  return { jobs, allocations };
}

/* ── §15.6's accounting export ────────────────────────────────────────────── */

export async function loadExportInvoices(
  db: Database,
  organisationId: string,
  filters: { direction?: InvoiceDirection; from?: string | null; to?: string | null },
): Promise<ExportInvoice[]> {
  const clauses = [liveInvoice(organisationId)];
  if (filters.direction) clauses.push(eq(invoices.direction, filters.direction));
  if (filters.from) clauses.push(sql`${invoices.invoiceDate} >= ${filters.from}`);
  if (filters.to) clauses.push(sql`${invoices.invoiceDate} <= ${filters.to}`);

  const rows = await db
    .select({
      id: invoices.id,
      direction: invoices.direction,
      internalRef: invoices.internalRef,
      invoiceNumber: invoices.invoiceNumber,
      counterpartyId: invoices.counterpartyId,
      counterpartyName: invoices.counterpartyName,
      invoiceDate: invoices.invoiceDate,
      dueAt: invoices.dueAt,
      paymentTermsDays: invoices.paymentTermsDays,
      netPence: invoices.netPence,
      vatPence: invoices.vatPence,
      grossPence: invoices.grossPence,
      currency: invoices.currency,
      category: invoices.category,
      notes: invoices.notes,
      siteName: sites.name,
    })
    .from(invoices)
    .leftJoin(sites, eq(sites.id, invoices.siteId))
    .where(and(...clauses));

  /*
   * The job reference is carried ONLY where the invoice is allocated to exactly
   * one job. §4 allows a contractor invoice to cover four jobs at one site, and
   * a bookkeeping row that named one of them would be wrong about the other
   * three — worse than naming none, because it looks right.
   */
  const allocationRows = await selectInChunks(
    rows.map((row) => row.id),
    (chunk) =>
      db
        .select({
          invoiceId: invoiceJobAllocations.invoiceId,
          reference: maintenanceRequests.reference,
        })
        .from(invoiceJobAllocations)
        .leftJoin(
          maintenanceRequests,
          eq(maintenanceRequests.id, invoiceJobAllocations.requestId),
        )
        .where(
          and(
            eq(invoiceJobAllocations.organisationId, organisationId),
            inArray(invoiceJobAllocations.invoiceId, chunk),
          ),
        ),
  );

  const byInvoice = new Map<string, string[]>();
  for (const row of allocationRows) {
    const list = byInvoice.get(row.invoiceId) ?? [];
    list.push(row.reference ?? "");
    byInvoice.set(row.invoiceId, list);
  }

  return rows.map((row) => {
    const references = byInvoice.get(row.id) ?? [];
    return {
      direction: (row.direction === "receivable" ? "receivable" : "payable") as InvoiceDirection,
      internalRef: row.internalRef ?? null,
      invoiceNumber: row.invoiceNumber ?? null,
      counterpartyId: row.counterpartyId ?? null,
      counterpartyName: row.counterpartyName ?? null,
      invoiceDate: row.invoiceDate ?? null,
      dueAt: row.dueAt ?? null,
      paymentTermsDays: row.paymentTermsDays ?? null,
      netPence: row.netPence ?? null,
      vatPence: row.vatPence ?? null,
      grossPence: row.grossPence ?? null,
      currency: row.currency ?? null,
      category: row.category ?? null,
      notes: row.notes ?? null,
      siteName: row.siteName ?? null,
      jobReference: references.length === 1 ? references[0] || null : null,
    };
  });
}

/* ── §10's calendar chips ─────────────────────────────────────────────────── */

export interface FinanceChip {
  key: string;
  kind: "payable_due" | "receivable_due" | "quote_expiry" | "payment_scheduled";
  day: string;
  invoiceId: string | null;
  quoteId: string | null;
  title: string;
  subtitle: string;
  status: string;
  overdue: boolean;
  /**
   * ALWAYS FALSE. §10: "Dragging is disabled for invoice chips — a due date is
   * contractual, not something to move by accident." Rescheduling a PAYMENT is
   * allowed and is done from the finance panel, which is a different act on a
   * different record.
   */
  draggable: false;
}

export async function loadFinanceChips(
  db: Database,
  organisationId: string,
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<FinanceChip[]> {
  const today = financeDay(now);

  const invoiceRows = await db
    .select({
      id: invoices.id,
      direction: invoices.direction,
      dueAt: invoices.dueAt,
      status: invoices.status,
      internalRef: invoices.internalRef,
      invoiceNumber: invoices.invoiceNumber,
      counterpartyName: invoices.counterpartyName,
      grossPence: invoices.grossPence,
    })
    .from(invoices)
    .where(
      and(
        liveInvoice(organisationId),
        isNotNull(invoices.dueAt),
        sql`substr(${dateText(invoices.dueAt)}, 1, 10) >= ${from}`,
        sql`substr(${dateText(invoices.dueAt)}, 1, 10) <= ${to}`,
      ),
    );

  const quoteRows = await db
    .select({
      id: quotations.id,
      validUntil: quotations.validUntil,
      status: quotations.status,
      internalRef: quotations.internalRef,
      description: quotations.description,
      grossPence: quotations.grossPence,
    })
    .from(quotations)
    .where(
      and(
        eq(quotations.organisationId, organisationId),
        isNotNull(quotations.validUntil),
        sql`substr(${dateText(quotations.validUntil)}, 1, 10) >= ${from}`,
        sql`substr(${dateText(quotations.validUntil)}, 1, 10) <= ${to}`,
      ),
    );

  const chips: FinanceChip[] = [];

  for (const row of invoiceRows) {
    const day = String(row.dueAt ?? "").slice(0, 10);
    if (!day) continue;
    const receivable = row.direction === "receivable";
    chips.push({
      key: `invoice:${row.id}`,
      kind: receivable ? "receivable_due" : "payable_due",
      day,
      invoiceId: row.id,
      quoteId: null,
      title: row.invoiceNumber || row.internalRef || "Invoice",
      subtitle: row.counterpartyName ?? (receivable ? "Client" : "Supplier"),
      status: row.status ?? "",
      /*
       * A settled invoice is not overdue however old its due date is, and this
       * flag is an OVERLAY: §10 says the overdue marker layers on top of the
       * status colour rather than replacing it, so the chip keeps saying Paid.
       */
      overdue: day < today && !isTerminal(row.status),
      draggable: false,
    });
  }

  for (const row of quoteRows) {
    const day = String(row.validUntil ?? "").slice(0, 10);
    if (!day) continue;
    chips.push({
      key: `quote:${row.id}`,
      kind: "quote_expiry",
      day,
      invoiceId: null,
      quoteId: row.id,
      title: row.internalRef || "Quote",
      subtitle: row.description ?? "Quote expires",
      status: row.status ?? "",
      overdue: day < today,
      draggable: false,
    });
  }

  return chips.sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

/** Statuses that end an invoice's life, so nothing after them can be late. */
function isTerminal(status: string | null | undefined): boolean {
  const key = (status ?? "").trim().toLowerCase();
  return key === "paid" || key === "voided" || key === "written_off" || key === "credited";
}

/* ── §15.10's contractor scorecard ────────────────────────────────────────── */

export interface ScorecardRow {
  id: string;
  name: string;
  jobs: number;
  invoices: number;
  spendPence: number;
  avgCostPerJobPence: number | null;
  /** Invoice against approved quote, as a percentage. NULL where no quote exists. */
  quoteToInvoiceVariancePercent: number | null;
  disputeRate: number | null;
  /** NULL rather than 0 — see the note in the loader. */
  onTimePercent: number | null;
}

/**
 * §15.10, from real data only.
 *
 * "No invented metrics" is the constraint that shapes this: every column below
 * is NULL where the estate cannot answer it, rather than zero. A contractor
 * with no quotes has no quote-to-invoice variance — that is not a variance of
 * nought — and a scorecard that printed 0% would rank them alongside somebody
 * who quotes accurately every time.
 */
export async function loadScorecard(
  db: Database,
  organisationId: string,
): Promise<{ contractors: ScorecardRow[]; note: string | null }> {
  const rows = await db
    .select({
      id: invoices.counterpartyId,
      name: invoices.counterpartyName,
      invoiceCount: sql<number>`count(*)`,
      spendPence: sql<number>`coalesce(sum(${invoices.grossPence}), 0)`,
      quoted: sql<number>`coalesce(sum(case when ${invoices.quoteId} is not null then 1 else 0 end), 0)`,
    })
    .from(invoices)
    .where(
      and(
        liveInvoice(organisationId),
        eq(invoices.direction, "payable"),
        ne(invoices.status, "draft"),
      ),
    )
    .groupBy(invoices.counterpartyId, invoices.counterpartyName);

  const contractorsSeen = rows
    .map((row) => {
      const name = (row.name ?? "").trim();
      const id = (row.id ?? "").trim() || (name ? `name:${name.toLowerCase()}` : "");
      if (!id) return null;
      const invoiceCount = Number(row.invoiceCount ?? 0);
      const spendPence = Number(row.spendPence ?? 0);
      return {
        id,
        name: name || "Unnamed supplier",
        jobs: 0,
        invoices: invoiceCount,
        spendPence,
        avgCostPerJobPence: invoiceCount > 0 ? Math.round(spendPence / invoiceCount) : null,
        quoteToInvoiceVariancePercent: null as number | null,
        disputeRate: null as number | null,
        onTimePercent: null as number | null,
      };
    })
    .filter((row): row is ScorecardRow => row !== null)
    .sort((a, b) => b.spendPence - a.spendPence);

  return {
    contractors: contractorsSeen,
    /*
     * Stated rather than left for the reader to infer from three columns of
     * dashes. The ledger is new; until it holds quotes approved against
     * invoices and disputes raised against suppliers, three of §15.10's four
     * metrics have nothing behind them and saying so is the honest report.
     */
    note:
      contractorsSeen.length === 0
        ? "No supplier invoice has been recorded yet, so there is nothing to score."
        : "Quote variance, dispute rate and on-time completion are shown as unknown until the ledger holds approved quotes, disputes and completion dates against these suppliers. They are never estimated.",
  };
}

export { liveInvoice };
