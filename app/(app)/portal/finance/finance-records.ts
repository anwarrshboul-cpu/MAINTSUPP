/**
 * WHAT THE MODULE 5 ROUTES ACTUALLY SEND, TYPED ONCE. No JSX, no fetch.
 *
 * Six tabs read the same four payloads. Declaring their shape in each of them
 * would be four chances to get a field name wrong and no compiler able to say
 * which one is right, so the vocabulary lives here beside `finance-status.ts`
 * and every component imports it.
 *
 * These interfaces describe the WIRE, not the database: they are what
 * `app/api/finance/**` puts in a `Response.json`, which is drizzle's
 * `$inferSelect` for the row plus the three things the ledger route batches
 * alongside it — the balance, the flags and the allocations.
 *
 * ── THE ONE PIECE OF ARITHMETIC IN THIS FILE IS BORROWED ───────────────────
 *
 * §6: "Never store a balance field — always compute it." `recordBalance` below
 * therefore does not add anything up. It hands the three figures the server
 * measured — gross, allocated, credited — to `invoiceBalance` in
 * `app/lib/finance/rules.ts`, which is the same function the server's own
 * balance came out of. A component that subtracted for itself would be a second
 * answer to a question with exactly one right answer, and the two would
 * disagree the first time a credit note's sign was reasoned about twice.
 */

import { invoiceBalance, type InvoiceBalance } from "../../../lib/finance/rules";
import type { InvoiceDirection } from "../../../lib/finance/model";

/* ── The ledger ───────────────────────────────────────────────────────────── */

export interface InvoiceRecord {
  id: string;
  direction: InvoiceDirection | string;
  internalRef: string | null;
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
  netPence: number | null;
  vatPence: number | null;
  grossPence: number | null;
  currency: string | null;
  costCentre: string | null;
  category: string | null;
  status: string | null;
  notes: string | null;
  source: string | null;
  createdBy: string | null;
  createdAt: string | null;
  finalisedAt: string | null;
  finalisedBy: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  retentionPence: number | null;
  retentionReleaseDate: string | null;
  updatedAt: string | null;
}

/** `InvoiceBalanceSummary` from `app/lib/finance/balance.ts`, over the wire. */
export interface BalanceSummary {
  invoiceId: string;
  direction: InvoiceDirection | string;
  currency: string;
  grossPence: number;
  paidPence: number;
  creditedPence: number;
  balancePence: number;
  overpaidPence: number;
  settled: boolean;
  dueDay: string | null;
  ageingBucket: string;
  daysOverdue: number;
  cashPositionPence: number;
}

export interface FlagRecord {
  id: string;
  invoiceId: string;
  flagType: string;
  severity: string;
  detail: string | null;
  status: string;
  waivedBy: string | null;
  waiveReason: string | null;
  waivedAt: string | null;
  clearedAt: string | null;
  createdAt: string | null;
}

export interface AllocationRecord {
  id: string;
  invoiceId: string;
  requestId: string;
  amountPence: number;
  note: string | null;
}

export interface PaymentRecord {
  id: string;
  reference: string | null;
  direction: string;
  amountPence: number;
  paymentDate: string;
  method: string;
  bankAccountId: string | null;
  paymentRunId: string | null;
  attachmentId: string | null;
  note: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
}

export interface CreditNoteRecord {
  id: string;
  reference: string | null;
  invoiceId: string;
  amountPence: number;
  reason: string;
  issuedDate: string;
  attachmentId: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface StatusChange {
  id: string;
  invoiceId: string;
  fromStatus: string | null;
  toStatus: string;
  actorEmail: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface DisputeRecord {
  id: string;
  invoiceId: string;
  reason: string;
  detail: string | null;
  status: string;
  raisedBy: string | null;
  raisedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  approverEmail: string;
  decision: string;
  basis: string | null;
  ruleId: string | null;
  createdAt: string | null;
}

export interface ApprovalBand {
  id: string;
  direction: string;
  minAmountPence: number;
  maxAmountPence: number | null;
  approversRequired: number;
  requiresClient: boolean;
  makerCheckerFromPence: number | null;
  active: boolean;
  sortOrder: number;
}

/** One row of `GET /api/finance/invoices`, with what the route batches beside it. */
export interface LedgerRow extends InvoiceRecord {
  balance: BalanceSummary | null;
  flags: FlagRecord[];
  allocations: AllocationRecord[];
}

export interface LedgerTotals {
  invoiceCount: number;
  netPence: number;
  vatPence: number;
  grossPence: number;
  paidPence: number;
  creditedPence: number;
  outstandingPence: number;
}

export interface LedgerPayload {
  invoices: LedgerRow[];
  totals: LedgerTotals;
  cashPosition: CashPositionPayload | null;
  limit: number;
  offset: number;
}

/** `GET /api/finance/invoices/[id]`. */
export interface InvoiceDetail {
  invoice: InvoiceRecord;
  allocations: AllocationRecord[];
  flags: FlagRecord[];
  payments: PaymentRecord[];
  creditNotes: CreditNoteRecord[];
  history: StatusChange[];
  disputes: DisputeRecord[];
  approvals: ApprovalRecord[];
  approvalProgress: {
    required: number;
    held: number;
    satisfied: boolean;
    band: ApprovalBand | null;
  } | null;
  balance: BalanceSummary | null;
}

/* ── Quotes ───────────────────────────────────────────────────────────────── */

export interface QuoteRecord {
  id: string;
  internalRef: string | null;
  supplierRef: string | null;
  requestId: string;
  contractorId: string | null;
  siteId: string | null;
  description: string | null;
  netPence: number | null;
  vatPence: number | null;
  grossPence: number | null;
  quoteDate: string | null;
  validUntil: string | null;
  status: string;
  statusKey?: string;
  expired?: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  clientApprovalRequired: boolean;
  clientApprovedBy: string | null;
  clientApprovedAt: string | null;
  poNumber: string | null;
  supersededById: string | null;
  createdBy: string | null;
  submittedAt: string | null;
}

export interface QuotePayload {
  quotes: QuoteRecord[];
  total: number;
  limit: number;
  offset: number;
}

/* ── §9's cash position, in either of the two shapes the server may send ──── */

/**
 * TWO SPELLINGS, ONE FIGURE, AND WHY BOTH ARE READ.
 *
 * `app/lib/finance/balance.ts` calls the due windows `dueNext7Pence` and
 * `app/lib/finance/cash.ts` calls them `due7`. Both are real, both are
 * exported, and which one arrives depends on whether the payload came from the
 * ledger route — which composes `cashPosition` — or from `/api/finance/summary`,
 * which composes `cashSummary`. `readCashPosition` accepts either and returns
 * one shape, so no tab carries a fallback chain and no card can print a zero
 * merely because it read the key the other module uses.
 */
export interface DueWindowPayload {
  in: number;
  out: number;
}

export interface CashPositionPayload {
  receivableOutstandingPence: number;
  receivableOverduePence: number;
  payableOutstandingPence: number;
  payableOverduePence: number;
  netPositionPence: number;
  dueNext7Pence?: DueWindowPayload;
  dueNext14Pence?: DueWindowPayload;
  dueNext30Pence?: DueWindowPayload;
  due7?: DueWindowPayload;
  due14?: DueWindowPayload;
  due30?: DueWindowPayload;
}

export interface CashPositionView {
  receivableOutstandingPence: number;
  receivableOverduePence: number;
  payableOutstandingPence: number;
  payableOverduePence: number;
  netPositionPence: number;
  due7: DueWindowPayload;
  due14: DueWindowPayload;
  due30: DueWindowPayload;
}

const NO_WINDOW: DueWindowPayload = { in: 0, out: 0 };

export function readCashPosition(
  payload: Partial<CashPositionPayload> | null | undefined,
): CashPositionView | null {
  if (!payload) return null;
  /*
   * A payload that carries none of the three headline figures is not a cash
   * position that happens to be zero — it is a different payload, or a route
   * that answered something else. Returning zeros for it would put £0.00 under
   * "Owed to you" on a workspace that is owed forty thousand pounds, which is
   * the one failure mode this whole card is written to avoid.
   */
  if (
    payload.receivableOutstandingPence === undefined
    && payload.payableOutstandingPence === undefined
    && payload.netPositionPence === undefined
  ) {
    return null;
  }
  return {
    receivableOutstandingPence: whole(payload.receivableOutstandingPence),
    receivableOverduePence: whole(payload.receivableOverduePence),
    payableOutstandingPence: whole(payload.payableOutstandingPence),
    payableOverduePence: whole(payload.payableOverduePence),
    netPositionPence: whole(payload.netPositionPence),
    due7: payload.dueNext7Pence ?? payload.due7 ?? NO_WINDOW,
    due14: payload.dueNext14Pence ?? payload.due14 ?? NO_WINDOW,
    due30: payload.dueNext30Pence ?? payload.due30 ?? NO_WINDOW,
  };
}

/* ── §9's forecast, §8's unbilled work, §9's ageing ───────────────────────── */

export interface ForecastPoint {
  day: string;
  inPence: number;
  outPence: number;
}

export interface ForecastPayload {
  points: ForecastPoint[];
  overdueInPence: number;
  overdueOutPence: number;
  beyondHorizonInPence: number;
  beyondHorizonOutPence: number;
  undatedInPence: number;
  undatedOutPence: number;
}

export interface UnbilledRow {
  requestId: string;
  reference: string | null;
  title: string | null;
  siteName: string | null;
  costInPence: number;
  completedAt: string | null;
}

export interface UnbilledPayload {
  count: number;
  totalPence: number;
  rows: UnbilledRow[];
}

/**
 * `GET /api/finance/summary`, whose cash figures are FLAT at the top level.
 *
 * The route composes `cashSummary` and spreads it, so `due7`/`due14`/`due30`
 * and the five headline figures sit beside `forecast` and `unbilled` rather
 * than under a `cashPosition` key. `readCashPosition` is fed the payload itself,
 * and still accepts the ledger route's `dueNext7Pence` spelling because that
 * route composes the other module.
 */
export interface SummaryPayload extends Partial<CashPositionPayload> {
  today?: string;
  forecast?: ForecastPayload;
  horizonDays?: number;
  unbilled?: UnbilledPayload;
  /** How many invoices carry an open flag, and how much they come to. */
  flagsOpen?: number;
  flagsOpenTotal?: number;
  quotesExpiring?: number;
}

export interface AgeingCounterparty {
  id: string;
  name: string;
  current: number;
  b1_30: number;
  b31_60: number;
  b61_90: number;
  b90: number;
  totalPence: number;
  invoiceCount: number;
  invoiceIds: string[];
}

export interface AgeingPayload {
  buckets: string[];
  counterparties: AgeingCounterparty[];
  totals: Omit<AgeingCounterparty, "id" | "name" | "invoiceIds">;
  direction?: string;
}

/* ── §8's margin ──────────────────────────────────────────────────────────── */

export interface MarginRowPayload {
  key: string;
  label: string;
  costInPence: number;
  chargedOutPence: number;
  marginPence: number;
  marginPercent: number | null;
  recoveryRatePercent: number | null;
  jobs: number;
  jobsCharged: number;
  coverage: number;
  lossMaking: boolean;
}

export interface MarginPayload {
  groupBy: string;
  rows: MarginRowPayload[];
  totals: Omit<MarginRowPayload, "key" | "label" | "lossMaking">;
}

/* ── The arithmetic, borrowed rather than repeated ────────────────────────── */

/**
 * One invoice's balance, from the figures the server measured. §6.
 *
 * The gross falls back to the invoice's own column when no balance summary came
 * with the row — a create response, for instance — and paid and credited fall
 * back to zero, because a row with no balance summary has had no payment
 * batched with it. Nothing here adds up a list of payments.
 */
export function recordBalance(row: {
  grossPence?: number | null;
  balance?: BalanceSummary | null;
}): InvoiceBalance {
  const measured = row.balance ?? null;
  return invoiceBalance({
    grossPence: measured?.grossPence ?? row.grossPence ?? 0,
    paidPence: measured?.paidPence ?? 0,
    creditedPence: measured?.creditedPence ?? 0,
  });
}

/** The direction a row carries, narrowed, with payable as the safe default. */
export function directionOf(value: string | null | undefined): InvoiceDirection {
  return value === "receivable" ? "receivable" : "payable";
}

function whole(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
