/**
 * THE MODULE 5 TABLES, READ AND WRITTEN IN ONE PLACE.
 *
 * Every function here takes `(db, organisationId, …)` and every statement it
 * issues filters on that organisation as its first condition. The id comes from
 * `scopedDb()` / `scopedDbWithCapability()` and never from a request body —
 * `app/lib/tenant-db.ts` explains why that indirection exists, and RLS is
 * defence in depth behind it rather than the thing doing the work. There is no
 * function in this file that accepts an organisation as an argument the browser
 * controls.
 *
 * ── TOTALS ARE COMPUTED IN SQL, OVER THE WHOLE FILTERED SET ────────────────
 *
 * `listInvoices` returns a PAGE of rows and totals for every row the filter
 * matches, and the second is not derived from the first. Summing a page gives
 * "£40,120 outstanding" under a list showing the first fifty of four hundred
 * invoices, which is a wrong number presented as a right one. The outstanding
 * figure needs the payment and credit-note aggregates too, and those are two
 * more aggregates over a subquery — never a per-row read.
 *
 * ── DAY COMPARISONS ────────────────────────────────────────────────────────
 *
 * Bare `YYYY-MM-DD`, computed on the server, compared against `dateText()` of
 * the column. `julianday(` and `strftime(` are refused by name in
 * `db/sqlite-to-postgres.ts`, and `trim(date)` throws on Production where these
 * columns can be a real Postgres `date`. The technique and the reasoning are
 * `app/lib/dashboard-filters.ts`'s; this module borrows both rather than
 * inventing a second dialect story.
 */

import { and, asc, count, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  creditNotes,
  invoiceDisputes,
  invoiceFlags,
  invoiceStatusHistory,
  invoiceStatusMap,
  invoices,
  paymentAllocations,
  payments,
  quotations,
} from "../../../db/schema";
import { dateText } from "../dashboard-aggregates";
import { selectInChunks } from "../sql-batching";
import {
  UNLINKED_JOB_ID,
  dayOf,
  financeDay,
  financeStatusKey,
  quoteStatusKey,
  type InvoiceDirection,
} from "./model";
import { paymentAllocationState } from "./rules";

type Database = Awaited<ReturnType<typeof getDb>>;

export type InvoiceRow = typeof invoices.$inferSelect;
export type QuoteRow = typeof quotations.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type CreditNoteRow = typeof creditNotes.$inferSelect;

/** A page never returns the whole ledger by accident. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/* ── Invoices: filters ────────────────────────────────────────────────────── */

export interface InvoiceFilters {
  direction?: InvoiceDirection | null;
  /** Status KEYS, already normalised by `financeStatusKey`. */
  statuses?: readonly string[];
  counterpartyId?: string | null;
  siteId?: string | null;
  /** A job. Matches an allocation OR the legacy primary-job mirror. */
  requestId?: string | null;
  /** Only invoices past their due date with something still outstanding. */
  overdueOnly?: boolean;
  /** Only invoices carrying at least one OPEN flag. §10's "unmatched only". */
  unmatchedOnly?: boolean;
  /** Inclusive, on the invoice date, as `YYYY-MM-DD`. */
  from?: string | null;
  to?: string | null;
  /** Free text over the two references and the counterparty name. */
  search?: string | null;
  limit?: number;
  offset?: number;
  /** The server instant `overdueOnly` is measured against. */
  now?: Date;
}

/**
 * The WHERE clause for a filter set, and nothing else.
 *
 * Exported so the totals query and the page query provably use the same one.
 * Two hand-written copies of a filter is how a total comes to describe a
 * different set of rows than the list under it.
 */
export function invoiceConditions(organisationId: string, filters: InvoiceFilters): SQL {
  const clauses: SQL[] = [eq(invoices.organisationId, organisationId)];
  const today = financeDay(filters.now ?? new Date());

  if (filters.direction) clauses.push(eq(invoices.direction, filters.direction));
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(inArray(invoices.status, [...filters.statuses]));
  }
  if (filters.counterpartyId) clauses.push(eq(invoices.counterpartyId, filters.counterpartyId));
  if (filters.siteId) clauses.push(eq(invoices.siteId, filters.siteId));

  if (filters.requestId) {
    /* A job reaches an invoice two ways: through `invoice_job_alloc` (the
       authority) and through the legacy `request_id` mirror. Both are checked,
       because a row written before Module 5 has only the second. */
    clauses.push(
      sql`(${eq(invoices.requestId, filters.requestId)} or ${invoices.id} in (
        select invoice_id from invoice_job_alloc
         where organisation_id = ${organisationId} and request_id = ${filters.requestId}
      ))`,
    );
  }

  if (filters.from) clauses.push(gte(dateText(invoices.invoiceDate), filters.from));
  /* The end of a window is compared against the DAY, so an invoice dated on the
     last day of the range is inside it. `dateText` puts a `T` where a cast
     timestamp has a space, so a same-day instant sorts after the bare day —
     hence `<` against the day after rather than `<=` against the day. */
  if (filters.to) clauses.push(sql`${dateText(invoices.invoiceDate)} < ${nextDay(filters.to)}`);

  if (filters.overdueOnly) clauses.push(overdueInvoiceSql(today));

  if (filters.unmatchedOnly) {
    clauses.push(
      sql`${invoices.id} in (
        select invoice_id from invoice_flags
         where organisation_id = ${organisationId} and status = 'open'
      )`,
    );
  }

  const search = (filters.search ?? "").trim().toLowerCase();
  if (search) {
    const needle = `%${search.replace(/[%_]/g, "")}%`;
    clauses.push(
      or(
        sql`lower(coalesce(${invoices.invoiceNumber}, '')) like ${needle}`,
        sql`lower(coalesce(${invoices.internalRef}, '')) like ${needle}`,
        sql`lower(coalesce(${invoices.counterpartyName}, '')) like ${needle}`,
      ) as SQL,
    );
  }

  return and(...clauses) as SQL;
}

/**
 * PAST ITS DUE DATE, in a form both dialects accept.
 *
 * The twin of `overdueOpenSql` in `app/lib/dashboard-aggregates.ts` and it
 * borrows that function's rule verbatim: a BARE `YYYY-MM-DD` due date is not
 * late until its day is over, while a due date carrying a TIME is late the
 * moment the instant passes. Treating a bare date as UTC midnight marked every
 * invoice due today as overdue for anyone west of Greenwich.
 *
 * A voided invoice is never overdue — there is nothing to pay. Settlement is
 * NOT tested here: whether the money has arrived is a `payment_alloc` question
 * and belongs in `balance.ts`, so this clause narrows to "past its date" and
 * the caller filters on the balance it already has.
 */
export function overdueInvoiceSql(today: string): SQL {
  const due = dateText(invoices.dueAt);
  const instant = `${today}T23:59:59.999Z`;
  return sql`(${invoices.dueAt} is not null and ${due} <> '' and ${invoices.voidedAt} is null
    and ((length(${due}) <= 10 and substr(${due}, 1, 10) < ${today})
      or (length(${due}) > 10 and ${due} < ${instant})))`;
}

export interface InvoiceTotals {
  invoiceCount: number;
  netPence: number;
  vatPence: number;
  grossPence: number;
  paidPence: number;
  creditedPence: number;
  /** `gross − paid − credited` over the whole filtered set. Never a page sum. */
  outstandingPence: number;
}

export interface InvoicePage {
  rows: InvoiceRow[];
  totals: InvoiceTotals;
  limit: number;
  offset: number;
}

/** A page of the ledger, and totals for everything the filter matched. */
export async function listInvoices(
  db: Database,
  organisationId: string,
  filters: InvoiceFilters = {},
): Promise<InvoicePage> {
  const where = invoiceConditions(organisationId, filters);
  const limit = clampPage(filters.limit);
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));

  const rows = await db
    .select()
    .from(invoices)
    .where(where)
    .orderBy(desc(dateText(invoices.invoiceDate)), desc(invoices.createdAt), asc(invoices.id))
    .limit(limit)
    .offset(offset);

  const totals = await invoiceTotals(db, organisationId, filters);
  return { rows, totals, limit, offset };
}

/**
 * Three aggregates, over the filtered set, in SQL.
 *
 * The paid and credited figures use `IN (subquery)` rather than a join, because
 * a join to a one-to-many table multiplies the invoice rows and every `sum` in
 * the same statement is then wrong by the number of payments. Two extra
 * statements is the cheap, obviously-correct shape.
 */
export async function invoiceTotals(
  db: Database,
  organisationId: string,
  filters: InvoiceFilters = {},
): Promise<InvoiceTotals> {
  const where = invoiceConditions(organisationId, filters);
  const matching = db.select({ id: invoices.id }).from(invoices).where(where);

  const [headline] = await db
    .select({
      invoiceCount: count(),
      netPence: sql<number | string>`coalesce(sum(${invoices.netPence}), 0)`,
      vatPence: sql<number | string>`coalesce(sum(${invoices.vatPence}), 0)`,
      grossPence: sql<number | string>`coalesce(sum(coalesce(${invoices.grossPence}, ${invoices.netPence}, 0)), 0)`,
    })
    .from(invoices)
    .where(where);

  const [paidRow] = await db
    .select({ total: sql<number | string>`coalesce(sum(${paymentAllocations.amountPence}), 0)` })
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.organisationId, organisationId),
        inArray(paymentAllocations.invoiceId, matching),
      ),
    );

  const [creditedRow] = await db
    .select({ total: sql<number | string>`coalesce(sum(${creditNotes.amountPence}), 0)` })
    .from(creditNotes)
    .where(
      and(eq(creditNotes.organisationId, organisationId), inArray(creditNotes.invoiceId, matching)),
    );

  const grossPence = whole(headline?.grossPence);
  const paidPence = whole(paidRow?.total);
  const creditedPence = whole(creditedRow?.total);
  return {
    invoiceCount: headline?.invoiceCount ?? 0,
    netPence: whole(headline?.netPence),
    vatPence: whole(headline?.vatPence),
    grossPence,
    paidPence,
    creditedPence,
    outstandingPence: grossPence - paidPence - creditedPence,
  };
}

export async function readInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface NewInvoice {
  direction: InvoiceDirection;
  internalRef: string;
  invoiceNumber: string | null;
  counterpartyType: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  contractorId: string | null;
  fromDepartment: string | null;
  toDepartment: string | null;
  faoContact: string | null;
  quoteId: string | null;
  poNumber: string | null;
  siteId: string | null;
  requestId: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  sentDate: string | null;
  dueAt: string | null;
  paymentTermsDays: number | null;
  netPence: number;
  vatPence: number;
  grossPence: number;
  currency: string;
  costCentre: string | null;
  category: string | null;
  notes: string | null;
  status: string;
  source: string;
  createdBy: string | null;
}

/**
 * Write a new ledger row.
 *
 * `amount` is the legacy REAL and is written as ZERO, never as the money. The
 * schema comment beside it says it is "superseded by net_pence / vat_pence /
 * gross_pence" and "never read by the finance module"; it is NOT NULL and this
 * bootstrap performs no destructive ALTER, so it has to carry something, and
 * the one thing it must not carry is a float that looks like a total. A reader
 * who finds 0.0 there goes looking for the pence columns; a reader who finds
 * 1234.56 believes it.
 */
export async function createInvoice(
  db: Database,
  organisationId: string,
  input: NewInvoice,
  now: Date = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  await db.insert(invoices).values({
    id,
    organisationId,
    /* NOT NULL, and "no job" is a sentinel rather than a null — see
       `UNLINKED_JOB_ID`. Maintained afterwards as a mirror of the first
       allocation by `mirrorPrimaryJob`. */
    requestId: input.requestId?.trim() || UNLINKED_JOB_ID,
    contractorId: input.contractorId,
    invoiceNumber: input.invoiceNumber,
    amount: 0,
    status: input.status,
    dueAt: input.dueAt,
    createdAt: stamp,
    direction: input.direction,
    internalRef: input.internalRef,
    counterpartyType: input.counterpartyType,
    counterpartyId: input.counterpartyId,
    counterpartyName: input.counterpartyName,
    fromDepartment: input.fromDepartment,
    toDepartment: input.toDepartment,
    faoContact: input.faoContact,
    quoteId: input.quoteId,
    poNumber: input.poNumber,
    siteId: input.siteId,
    invoiceDate: input.invoiceDate,
    receivedDate: input.receivedDate,
    sentDate: input.sentDate,
    paymentTermsDays: input.paymentTermsDays,
    netPence: input.netPence,
    vatPence: input.vatPence,
    grossPence: input.grossPence,
    currency: input.currency,
    costCentre: input.costCentre,
    category: input.category,
    notes: input.notes,
    source: input.source,
    createdBy: input.createdBy,
    updatedAt: stamp,
  });
  return id;
}

export type InvoicePatch = Partial<
  Pick<
    typeof invoices.$inferInsert,
    | "invoiceNumber"
    | "counterpartyType"
    | "counterpartyId"
    | "counterpartyName"
    | "contractorId"
    | "fromDepartment"
    | "toDepartment"
    | "faoContact"
    | "quoteId"
    | "poNumber"
    | "siteId"
    | "invoiceDate"
    | "receivedDate"
    | "sentDate"
    | "dueAt"
    | "paymentTermsDays"
    | "netPence"
    | "vatPence"
    | "grossPence"
    | "currency"
    | "costCentre"
    | "category"
    | "notes"
    | "status"
    | "retentionPence"
    | "retentionReleaseDate"
    | "finalisedAt"
    | "finalisedBy"
    | "voidedAt"
    | "voidedBy"
    | "voidReason"
  >
>;

/**
 * The accounting fields §15.14 freezes at finalisation.
 *
 * Named here rather than in the route so that the list has ONE home and a
 * second caller cannot quietly permit a different subset. The rule is §15.14
 * and §16: "corrections go through credit notes, never edits", and it is
 * enforced on the SERVER — a disabled form field is not immutability.
 */
export const ACCOUNTING_FIELDS: readonly (keyof InvoicePatch)[] = [
  "netPence",
  "vatPence",
  "grossPence",
  "currency",
  "invoiceNumber",
  "invoiceDate",
  "dueAt",
  "paymentTermsDays",
  "counterpartyId",
  "counterpartyType",
  "counterpartyName",
  "contractorId",
  "quoteId",
  "siteId",
  "category",
  "costCentre",
  "retentionPence",
];

export function accountingFieldsIn(patch: InvoicePatch): string[] {
  return ACCOUNTING_FIELDS.filter((field) => patch[field] !== undefined).map(String);
}

export async function updateInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
  patch: InvoicePatch,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(invoices)
    .set({ ...patch, updatedAt: now.toISOString() })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
}

/**
 * Permanently remove a draft, and its allocations and flags with it.
 *
 * Only a draft, and the route enforces that as well as this — a finalised or
 * voided invoice is a financial record and voiding is how it is withdrawn.
 * Payments and credit notes are NOT swept: if either exists, this invoice is
 * not a draft and the caller has already refused.
 */
export async function deleteDraftInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<void> {
  await db
    .delete(invoiceFlags)
    .where(and(eq(invoiceFlags.organisationId, organisationId), eq(invoiceFlags.invoiceId, invoiceId)));
  await db
    .delete(invoiceStatusHistory)
    .where(
      and(
        eq(invoiceStatusHistory.organisationId, organisationId),
        eq(invoiceStatusHistory.invoiceId, invoiceId),
      ),
    );
  await db.run(sql`
    delete from invoice_job_alloc
     where organisation_id = ${organisationId} and invoice_id = ${invoiceId}
  `);
  await db
    .delete(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
}

/* ── Status history ───────────────────────────────────────────────────────── */

/**
 * Append one transition. §2: "This is the audit trail, and it is the point of
 * the module."
 *
 * Append-only by construction — there is no update or delete for this table
 * anywhere in the finance module, the same discipline `app/lib/audit.ts`
 * applies to `audit_events`.
 */
export async function recordStatusChange(
  db: Database,
  organisationId: string,
  input: {
    invoiceId: string;
    fromStatus: string | null;
    toStatus: string;
    actorEmail: string | null;
    actorUserId: string | null;
    reason?: string | null;
    now?: Date;
  },
): Promise<void> {
  await db.insert(invoiceStatusHistory).values({
    id: crypto.randomUUID(),
    organisationId,
    invoiceId: input.invoiceId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason?.slice(0, 400) ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}

export async function listStatusHistory(
  db: Database,
  organisationId: string,
  invoiceId: string,
) {
  return db
    .select()
    .from(invoiceStatusHistory)
    .where(
      and(
        eq(invoiceStatusHistory.organisationId, organisationId),
        eq(invoiceStatusHistory.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceStatusHistory.createdAt));
}

/**
 * The editable status vocabulary. §5.
 *
 * Returned raw so the caller can render an unmapped status grey with its own
 * label rather than dropping the row — "never disappear" is the rule and it
 * cannot be kept by a function that only returns what it recognises.
 */
export async function listStatusMap(
  db: Database,
  organisationId: string,
  direction?: InvoiceDirection,
) {
  const clauses: SQL[] = [eq(invoiceStatusMap.organisationId, organisationId)];
  if (direction) clauses.push(eq(invoiceStatusMap.direction, direction));
  return db
    .select()
    .from(invoiceStatusMap)
    .where(and(...clauses))
    .orderBy(asc(invoiceStatusMap.direction), asc(invoiceStatusMap.sortOrder));
}

/* ── Quotes ───────────────────────────────────────────────────────────────── */

export interface QuoteFilters {
  requestId?: string | null;
  contractorId?: string | null;
  siteId?: string | null;
  statuses?: readonly string[];
  /** Quotes whose `valid_until` has passed. §3 — an expired quote leaks money. */
  expiredOnly?: boolean;
  search?: string | null;
  limit?: number;
  offset?: number;
  now?: Date;
}

export async function listQuotes(
  db: Database,
  organisationId: string,
  filters: QuoteFilters = {},
): Promise<{ rows: QuoteRow[]; total: number; limit: number; offset: number }> {
  const clauses: SQL[] = [eq(quotations.organisationId, organisationId)];
  if (filters.requestId) clauses.push(eq(quotations.requestId, filters.requestId));
  if (filters.contractorId) clauses.push(eq(quotations.contractorId, filters.contractorId));
  if (filters.siteId) clauses.push(eq(quotations.siteId, filters.siteId));
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(inArray(quotations.status, [...filters.statuses]));
  }
  if (filters.expiredOnly) {
    const today = financeDay(filters.now ?? new Date());
    const validUntil = dateText(quotations.validUntil);
    clauses.push(
      sql`(${quotations.validUntil} is not null and ${validUntil} <> '' and substr(${validUntil}, 1, 10) < ${today})`,
    );
  }
  const search = (filters.search ?? "").trim().toLowerCase();
  if (search) {
    const needle = `%${search.replace(/[%_]/g, "")}%`;
    clauses.push(
      or(
        sql`lower(coalesce(${quotations.internalRef}, '')) like ${needle}`,
        sql`lower(coalesce(${quotations.supplierRef}, '')) like ${needle}`,
        sql`lower(coalesce(${quotations.description}, '')) like ${needle}`,
      ) as SQL,
    );
  }

  const where = and(...clauses) as SQL;
  const limit = clampPage(filters.limit);
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const rows = await db
    .select()
    .from(quotations)
    .where(where)
    .orderBy(desc(dateText(quotations.quoteDate)), desc(quotations.submittedAt), asc(quotations.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await db.select({ total: count() }).from(quotations).where(where);
  return { rows, total: totals?.total ?? 0, limit, offset };
}

export async function readQuote(
  db: Database,
  organisationId: string,
  quoteId: string,
): Promise<QuoteRow | null> {
  const rows = await db
    .select()
    .from(quotations)
    .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, quoteId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface NewQuote {
  internalRef: string;
  supplierRef: string | null;
  requestId: string;
  contractorId: string | null;
  siteId: string | null;
  description: string | null;
  netPence: number;
  vatPence: number;
  grossPence: number;
  quoteDate: string | null;
  validUntil: string | null;
  status: string;
  clientApprovalRequired: boolean;
  poNumber: string | null;
  createdBy: string | null;
}

/** `amount` is the legacy REAL — see `createInvoice` for why it is written as zero. */
export async function createQuote(
  db: Database,
  organisationId: string,
  input: NewQuote,
  now: Date = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  await db.insert(quotations).values({
    id,
    organisationId,
    requestId: input.requestId,
    contractorId: input.contractorId,
    amount: 0,
    status: input.status,
    submittedAt: stamp,
    internalRef: input.internalRef,
    supplierRef: input.supplierRef,
    siteId: input.siteId,
    description: input.description,
    netPence: input.netPence,
    vatPence: input.vatPence,
    grossPence: input.grossPence,
    quoteDate: input.quoteDate,
    validUntil: input.validUntil,
    clientApprovalRequired: input.clientApprovalRequired,
    poNumber: input.poNumber,
    createdBy: input.createdBy,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return id;
}

export type QuotePatch = Partial<typeof quotations.$inferInsert>;

export async function updateQuote(
  db: Database,
  organisationId: string,
  quoteId: string,
  patch: QuotePatch,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(quotations)
    .set({ ...patch, updatedAt: now.toISOString() })
    .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, quoteId)));
}

/**
 * APPROVE ONE QUOTE AND REJECT THE OTHERS ON THE SAME JOB. §3.
 *
 * "a single Approve this one action that rejects the others and records why."
 * The rejection reason is written on EACH loser, not implied by their status,
 * because "Rejected" with no reason six months later is indistinguishable from
 * a quote somebody rejected for cause.
 *
 * ── ORDER MATTERS, AND IT IS THE SAFE WAY ROUND ────────────────────────────
 *
 * The winner is approved FIRST. There is no interactive transaction available
 * on D1, so this cannot be atomic; what it can be is safe in the direction it
 * fails. Approving first means an interrupted run leaves an approved quote and
 * some competitors still open — visible, and the operator re-runs the action.
 * The other order would leave a job with every quote rejected and none
 * approved, which reads as a decision nobody took.
 */
export async function approveQuoteExclusively(
  db: Database,
  organisationId: string,
  quote: QuoteRow,
  input: { actorEmail: string | null; reason: string; now?: Date },
): Promise<{ approvedId: string; rejectedIds: string[] }> {
  const stamp = (input.now ?? new Date()).toISOString();

  await db
    .update(quotations)
    .set({
      status: "approved",
      approvedBy: input.actorEmail,
      approvedAt: stamp,
      updatedAt: stamp,
    })
    .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, quote.id)));

  const competitors = await db
    .select({ id: quotations.id, status: quotations.status })
    .from(quotations)
    .where(
      and(
        eq(quotations.organisationId, organisationId),
        eq(quotations.requestId, quote.requestId),
        ne(quotations.id, quote.id),
      ),
    );

  const rejectedIds: string[] = [];
  for (const competitor of competitors) {
    const key = quoteStatusKey(competitor.status);
    /* A quote already rejected or already superseded keeps the reason it was
       given. Rewriting it would replace a real decision with this one's
       boilerplate. */
    if (key === "rejected" || key === "superseded") continue;
    await db
      .update(quotations)
      .set({
        status: "rejected",
        rejectedReason: input.reason.slice(0, 400),
        rejectedBy: input.actorEmail,
        rejectedAt: stamp,
        supersededById: quote.id,
        updatedAt: stamp,
      })
      .where(and(eq(quotations.organisationId, organisationId), eq(quotations.id, competitor.id)));
    rejectedIds.push(competitor.id);
  }

  return { approvedId: quote.id, rejectedIds };
}

/* ── Payments ─────────────────────────────────────────────────────────────── */

export interface PaymentAllocationInput {
  invoiceId: string;
  amountPence: number;
}

export interface NewPayment {
  reference: string | null;
  direction: "in" | "out";
  amountPence: number;
  paymentDate: string;
  method: string;
  bankAccountId: string | null;
  note: string | null;
  recordedBy: string | null;
}

export type PaymentWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Record a payment and everything it settles. §6.
 *
 * "One invoice can have several payments; one payment can cover several
 * invoices" — both fall out of `payment_alloc` being its own table, and neither
 * is expressible with a `paid_at` column, which is why the legacy one is left
 * unread.
 *
 * THE ALLOCATIONS MUST SUM TO THE PAYMENT. Checked before anything is written,
 * and refused with the gap named. A payment allocated to £900 of a £1,000
 * transfer leaves £100 that has left the bank and settles nothing.
 *
 * EVERY INVOICE MUST BELONG TO THIS WORKSPACE, and the direction of the money
 * must match the direction of the obligation — money OUT settles a payable,
 * money IN settles a receivable. Checked here rather than assumed at read time,
 * so `balance.ts` can sum allocations plainly without asking which way each one
 * pointed.
 */
export async function createPayment(
  db: Database,
  organisationId: string,
  input: NewPayment,
  allocations: readonly PaymentAllocationInput[],
  now: Date = new Date(),
): Promise<PaymentWriteResult> {
  const cleaned = allocations
    .map((row) => ({ invoiceId: (row.invoiceId ?? "").trim(), amountPence: Math.trunc(row.amountPence || 0) }))
    .filter((row) => row.invoiceId);
  if (cleaned.length === 0) return { ok: false, error: "A payment has to settle at least one invoice." };

  const seen = new Set<string>();
  for (const row of cleaned) {
    if (seen.has(row.invoiceId)) {
      return {
        ok: false,
        error: "One invoice appears twice on this payment. Combine the two lines into one.",
      };
    }
    seen.add(row.invoiceId);
  }

  const state = paymentAllocationState(input.amountPence, cleaned);
  if (!state.balanced) {
    return {
      ok: false,
      error:
        `The allocations come to ${pounds(state.totalPence)} against a payment of `
        + `${pounds(state.targetPence)}. They have to match exactly.`,
    };
  }

  const targets = await selectInChunks([...seen], (chunk) =>
    db
      .select({ id: invoices.id, direction: invoices.direction, voidedAt: invoices.voidedAt })
      .from(invoices)
      .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, chunk))),
  );
  const byId = new Map(targets.map((row) => [row.id, row]));
  const wanted = input.direction === "out" ? "payable" : "receivable";
  for (const row of cleaned) {
    const invoice = byId.get(row.invoiceId);
    if (!invoice) return { ok: false, error: `${row.invoiceId} is not an invoice in this workspace.` };
    if (invoice.voidedAt) return { ok: false, error: `${row.invoiceId} has been voided and cannot take a payment.` };
    if ((invoice.direction ?? "payable") !== wanted) {
      return {
        ok: false,
        error:
          `${row.invoiceId} is a ${invoice.direction} invoice, which money ${input.direction} does not settle. `
          + `Money out settles payables; money in settles receivables.`,
      };
    }
  }

  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  await db.insert(payments).values({
    id,
    organisationId,
    reference: input.reference,
    direction: input.direction,
    amountPence: Math.trunc(input.amountPence),
    paymentDate: input.paymentDate,
    method: input.method,
    bankAccountId: input.bankAccountId,
    note: input.note,
    recordedBy: input.recordedBy,
    recordedAt: stamp,
  });
  for (const row of cleaned) {
    await db.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      organisationId,
      paymentId: id,
      invoiceId: row.invoiceId,
      amountPence: row.amountPence,
      createdAt: stamp,
    });
  }
  return { ok: true, id };
}

export async function readPayment(
  db: Database,
  organisationId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.organisationId, organisationId), eq(payments.id, paymentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPaymentAllocations(
  db: Database,
  organisationId: string,
  paymentId: string,
) {
  return db
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.organisationId, organisationId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    );
}

export async function listPaymentsForInvoice(
  db: Database,
  organisationId: string,
  invoiceId: string,
) {
  return db
    .select({
      allocationId: paymentAllocations.id,
      allocatedPence: paymentAllocations.amountPence,
      payment: payments,
    })
    .from(paymentAllocations)
    .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
    .where(
      and(
        eq(paymentAllocations.organisationId, organisationId),
        eq(paymentAllocations.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(payments.paymentDate));
}

export interface PaymentFilters {
  direction?: "in" | "out" | null;
  method?: string | null;
  from?: string | null;
  to?: string | null;
  invoiceId?: string | null;
  limit?: number;
  offset?: number;
}

export async function listPayments(
  db: Database,
  organisationId: string,
  filters: PaymentFilters = {},
): Promise<{ rows: PaymentRow[]; total: number; totalPence: number; limit: number; offset: number }> {
  const clauses: SQL[] = [eq(payments.organisationId, organisationId)];
  if (filters.direction) clauses.push(eq(payments.direction, filters.direction));
  if (filters.method) clauses.push(eq(payments.method, filters.method));
  if (filters.from) clauses.push(gte(dateText(payments.paymentDate), filters.from));
  if (filters.to) clauses.push(lte(sql`substr(${dateText(payments.paymentDate)}, 1, 10)`, filters.to));
  if (filters.invoiceId) {
    clauses.push(
      sql`${payments.id} in (
        select payment_id from payment_alloc
         where organisation_id = ${organisationId} and invoice_id = ${filters.invoiceId}
      )`,
    );
  }
  const where = and(...clauses) as SQL;
  const limit = clampPage(filters.limit);
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const rows = await db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(dateText(payments.paymentDate)), desc(payments.recordedAt), asc(payments.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await db
    .select({
      total: count(),
      totalPence: sql<number | string>`coalesce(sum(${payments.amountPence}), 0)`,
    })
    .from(payments)
    .where(where);
  return {
    rows,
    total: totals?.total ?? 0,
    totalPence: whole(totals?.totalPence),
    limit,
    offset,
  };
}

/** Removes a payment and the allocations that belong to it. `data.delete` only. */
export async function deletePayment(
  db: Database,
  organisationId: string,
  paymentId: string,
): Promise<void> {
  await db
    .delete(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.organisationId, organisationId),
        eq(paymentAllocations.paymentId, paymentId),
      ),
    );
  await db
    .delete(payments)
    .where(and(eq(payments.organisationId, organisationId), eq(payments.id, paymentId)));
}

/* ── Credit notes ─────────────────────────────────────────────────────────── */

export async function listCreditNotes(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<CreditNoteRow[]> {
  return db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.organisationId, organisationId), eq(creditNotes.invoiceId, invoiceId)))
    .orderBy(asc(creditNotes.issuedDate), asc(creditNotes.id));
}

export async function countCreditNotes(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(creditNotes)
    .where(and(eq(creditNotes.organisationId, organisationId), eq(creditNotes.invoiceId, invoiceId)));
  return row?.total ?? 0;
}

/**
 * A credit note against an invoice. §6 and §15.14.
 *
 * The invoice is NOT touched. That is the whole point: after finalisation the
 * accounting facts are immutable and a correction is a new document. The
 * balance moves because `balance.ts` subtracts credit notes at query time, so
 * nothing about the finalised row has to change for the ledger to be right.
 *
 * `amount_pence` is stored POSITIVE. What it does to a balance is decided in
 * one place — see `invoiceBalance` in `./rules.ts`, which also explains why the
 * sign is the same on both sides of the ledger.
 */
export async function createCreditNote(
  db: Database,
  organisationId: string,
  input: {
    invoiceId: string;
    reference: string;
    amountPence: number;
    reason: string;
    issuedDate: string;
    attachmentId?: string | null;
    createdBy: string | null;
  },
  now: Date = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(creditNotes).values({
    id,
    organisationId,
    reference: input.reference,
    invoiceId: input.invoiceId,
    amountPence: Math.trunc(input.amountPence),
    reason: input.reason.slice(0, 400),
    issuedDate: input.issuedDate,
    attachmentId: input.attachmentId ?? null,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
  });
  return id;
}

/* ── Disputes ─────────────────────────────────────────────────────────────── */

/** §15.9 — "a dispute has a record rather than living in an inbox". */
export async function listDisputes(
  db: Database,
  organisationId: string,
  invoiceId: string,
) {
  return db
    .select()
    .from(invoiceDisputes)
    .where(
      and(eq(invoiceDisputes.organisationId, organisationId), eq(invoiceDisputes.invoiceId, invoiceId)),
    )
    .orderBy(asc(invoiceDisputes.raisedAt));
}

export async function raiseDispute(
  db: Database,
  organisationId: string,
  input: {
    invoiceId: string;
    reason: string;
    detail: string | null;
    raisedBy: string | null;
    now?: Date;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(invoiceDisputes).values({
    id,
    organisationId,
    invoiceId: input.invoiceId,
    reason: input.reason.slice(0, 400),
    detail: input.detail?.slice(0, 2000) ?? null,
    status: "open",
    raisedBy: input.raisedBy,
    raisedAt: (input.now ?? new Date()).toISOString(),
  });
  return id;
}

export async function resolveDispute(
  db: Database,
  organisationId: string,
  invoiceId: string,
  input: { resolution: string; resolvedBy: string | null; now?: Date },
): Promise<number> {
  const open = await db
    .select({ id: invoiceDisputes.id })
    .from(invoiceDisputes)
    .where(
      and(
        eq(invoiceDisputes.organisationId, organisationId),
        eq(invoiceDisputes.invoiceId, invoiceId),
        eq(invoiceDisputes.status, "open"),
      ),
    );
  const stamp = (input.now ?? new Date()).toISOString();
  for (const row of open) {
    await db
      .update(invoiceDisputes)
      .set({
        status: "resolved",
        resolution: input.resolution.slice(0, 2000),
        resolvedBy: input.resolvedBy,
        resolvedAt: stamp,
      })
      .where(and(eq(invoiceDisputes.organisationId, organisationId), eq(invoiceDisputes.id, row.id)));
  }
  return open.length;
}

/* ── Small shared pieces ──────────────────────────────────────────────────── */

function clampPage(limit: number | undefined): number {
  const value = Math.trunc(limit ?? DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

/** The day AFTER a `YYYY-MM-DD`, so a range end can be exclusive and still inclusive of its day. */
function nextDay(day: string): string {
  const parsed = dayOf(day);
  if (!parsed) return day;
  const [year, month, date] = parsed.split("-").map(Number);
  return financeDay(new Date(Date.UTC(year, month - 1, date + 1)));
}

/**
 * `sum()` and `count()` come back as STRINGS from node-pg and numbers from D1.
 * Same coercion, same reason, as `balance.ts` — a total that is a string adds
 * as concatenation and the failure only appears deployed.
 */
function whole(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

/** Status keys are normalised on the way in, so a filter and a column agree. */
export function normaliseStatuses(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(financeStatusKey).filter(Boolean);
}

function pounds(pence: number): string {
  const value = Math.trunc(pence || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}£${Math.floor(absolute / 100).toLocaleString("en-GB")}.${String(
    absolute % 100,
  ).padStart(2, "0")}`;
}
