/**
 * THE FINANCE RULEBOOK — every decision Module 5 makes, as pure functions.
 *
 * What a balance is, which ageing bucket an invoice falls in, whether an
 * allocation set sums, whether an invoice is over its quote, whether it
 * duplicates one already in the ledger, and which approval band it lands in.
 *
 * ── WHY THEY ARE HERE AND NOT IN THE FILES THAT USE THEM ───────────────────
 *
 * `balance.ts`, `allocations.ts`, `matching.ts` and `approvals.ts` each reach
 * drizzle, and a module that reaches drizzle cannot be loaded by `node --test`
 * — see the header of `./model.ts`. So each of those files keeps the SQL and
 * re-exports its own decision from here, and the test suite calls the shipped
 * function rather than a copy of it. This module imports `./model` and nothing
 * else, which is the one specifier a `data:`-URL loader can rewrite.
 *
 * Nothing here reads a clock. Every function that needs "today" takes it as a
 * `YYYY-MM-DD` argument, computed once from the server instant by the caller —
 * the rule the whole product follows, because a figure a client is judged by
 * must not depend on which machine answered.
 */

import {
  daysBetweenDays,
  financeCategoryKey,
  financeStatusKey,
  type FinanceFlagType,
  type InvoiceDirection,
} from "./model";

/* ── Balance ──────────────────────────────────────────────────────────────── */

export interface BalanceInputs {
  grossPence: number;
  /** Sum of every `payment_alloc` row pointing at this invoice. */
  paidPence: number;
  /** Sum of every `credit_notes` row against this invoice. Always positive. */
  creditedPence: number;
}

export interface InvoiceBalance extends BalanceInputs {
  balancePence: number;
  /** Nothing left owing. True at exactly zero and at an over-payment. */
  settled: boolean;
  /** How much more was paid than was owed. Zero unless something went wrong. */
  overpaidPence: number;
}

/**
 * WHAT REMAINS OWED ON ONE INVOICE.
 *
 *     balance = gross − payments allocated − credit notes
 *
 * ── THE SPEC PRINTS A PLUS AND MEANS A MINUS ───────────────────────────────
 *
 * §6 renders the formula as `gross − sum(allocations) + sum(credit notes)`.
 * That plus is a typo, and it is contradicted by §6's own prose one sentence
 * earlier — credit notes are "linked to the original invoice, REDUCING the
 * balance" — and by §16, "a credit note reduces the balance without editing the
 * finalised invoice". `credit_notes.amount_pence` is stored positive (the
 * schema says so out loud), so the sign has to be applied here, and it is a
 * minus. Taken literally the spec's plus would make a £200 credit against a
 * £1,000 invoice leave £1,200 outstanding, which is the opposite of a credit.
 *
 * ── THE SIGN IS THE SAME IN BOTH DIRECTIONS, AND THAT IS NOT AN OVERSIGHT ──
 *
 * "Balance" here means "what is still outstanding on this obligation, measured
 * in the invoice's own direction". On a payable that is what we still owe the
 * supplier; on a receivable it is what the client still owes us. A payment
 * reduces it on both sides — money out settles a payable, money in settles a
 * receivable — and so does a credit note: a supplier crediting us reduces what
 * we owe, and us crediting a client reduces what they owe. There is no
 * direction on which a credit note increases a balance, so there is no
 * direction on which the sign flips.
 *
 * Where direction DOES matter is the cash position (§9), which adds the two
 * sides together and therefore needs them signed against each other. That is
 * `signedForCashPosition` below, deliberately a separate function so that a
 * per-invoice balance can never accidentally come back negative merely because
 * it is a payable.
 *
 * ── OVER-PAYMENT IS REPORTED, NOT CLAMPED ──────────────────────────────────
 *
 * A £1,000 invoice with £1,200 allocated to it returns a balance of −£200 and
 * `overpaidPence: 20000`. Clamping to zero would hide a real and expensive
 * event — an invoice paid twice is exactly what §7's duplicate check exists to
 * prevent, and swallowing the evidence after the fact would be the second half
 * of the same failure.
 */
export function invoiceBalance(inputs: BalanceInputs): InvoiceBalance {
  const grossPence = Math.trunc(inputs.grossPence || 0);
  const paidPence = Math.trunc(inputs.paidPence || 0);
  const creditedPence = Math.trunc(inputs.creditedPence || 0);
  const balancePence = grossPence - paidPence - creditedPence;
  return {
    grossPence,
    paidPence,
    creditedPence,
    balancePence,
    settled: balancePence <= 0,
    overpaidPence: balancePence < 0 ? -balancePence : 0,
  };
}

/**
 * One invoice's contribution to the NET cash position. §9.
 *
 * A receivable is money coming in and counts positive; a payable is money going
 * out and counts negative. This is the only place the two directions are added
 * together, and it is separate from `invoiceBalance` on purpose — see there.
 */
export function signedForCashPosition(direction: InvoiceDirection, balancePence: number): number {
  return direction === "receivable" ? balancePence : -balancePence;
}

/* ── Ageing ───────────────────────────────────────────────────────────────── */

/** §9's five, in order. */
export const AGEING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export interface Ageing {
  ageingBucket: AgeingBucket;
  /** Whole days past the due date. Zero on the due day itself, never negative. */
  daysOverdue: number;
}

/**
 * WHICH §9 BUCKET AN INVOICE IS IN, from its due day against today's.
 *
 * The boundaries, spelled out because an off-by-one here moves money between
 * two columns of an aged-debtor report and nobody can see which:
 *
 *   due today or later  ->  current   (0 days overdue)
 *   1 … 30 days late    ->  1-30
 *   31 … 60             ->  31-60
 *   61 … 90             ->  61-90
 *   91 and beyond       ->  90+
 *
 * A bare `YYYY-MM-DD` due date is NOT late until its day is over — the rule
 * `duePassed` in `portal-app.tsx` encodes and four tests already pin. Working
 * in whole days rather than instants is what makes that automatic here: an
 * invoice due today is zero days overdue, not "overdue by fourteen hours".
 *
 * NO DUE DATE IS `current`, not `90+`. An invoice with no contractual due date
 * cannot be late — there is nothing for it to be late against — and defaulting
 * the other way would put every draft in the worst bucket on the landing page.
 *
 * SETTLEMENT IS NOT CONSIDERED. A paid invoice still has a real due date and
 * still gets its true bucket; what makes it contribute nothing to an ageing
 * total is that its BALANCE is zero. Every aged-debtor and aged-creditor figure
 * must be weighted by `balancePence`, never counted by row — which is a rule
 * worth stating once here rather than re-deciding in each report.
 */
export function ageingFor(dueDay: string | null, todayDay: string): Ageing {
  if (!dueDay) return { ageingBucket: "current", daysOverdue: 0 };
  const elapsed = daysBetweenDays(dueDay, todayDay);
  if (elapsed <= 0) return { ageingBucket: "current", daysOverdue: 0 };
  if (elapsed <= 30) return { ageingBucket: "1-30", daysOverdue: elapsed };
  if (elapsed <= 60) return { ageingBucket: "31-60", daysOverdue: elapsed };
  if (elapsed <= 90) return { ageingBucket: "61-90", daysOverdue: elapsed };
  return { ageingBucket: "90+", daysOverdue: elapsed };
}

/* ── Allocation ───────────────────────────────────────────────────────────── */

export interface AllocationLike {
  requestId: string;
  amountPence: number;
}

export interface AllocationState {
  totalPence: number;
  targetPence: number;
  balanced: boolean;
  /** `total − target`. Positive means over-allocated, negative under. */
  difference: number;
  count: number;
}

/**
 * WHETHER A SPLIT SUMS TO WHAT IT IS SPLITTING. §4: "Enforce the sum."
 *
 * The target is the invoice NET, which is §14's own annotation on
 * `invoice_job_alloc` — "must sum to invoice.net" — and it is the right choice
 * rather than gross: VAT is a pass-through that belongs to nobody's job cost,
 * and allocating it across four jobs would put reclaimable tax into the margin
 * of each. §8's "cost in" is a net figure for the same reason.
 *
 * Exact integer equality, no tolerance. A penny of tolerance is a penny that
 * lands on no job, and four invoices later it is fourpence nobody can find.
 * That is affordable precisely because everything here is integer pence.
 */
export function allocationState(
  targetPence: number,
  allocations: readonly AllocationLike[],
): AllocationState {
  const target = Math.trunc(targetPence || 0);
  const totalPence = allocations.reduce((sum, row) => sum + Math.trunc(row.amountPence || 0), 0);
  return {
    totalPence,
    targetPence: target,
    balanced: totalPence === target,
    difference: totalPence - target,
    count: allocations.length,
  };
}

/** The same arithmetic for a payment across several invoices. §6. */
export function paymentAllocationState(
  paymentPence: number,
  allocations: readonly { invoiceId: string; amountPence: number }[],
): AllocationState {
  return allocationState(
    paymentPence,
    allocations.map((row) => ({ requestId: row.invoiceId, amountPence: row.amountPence })),
  );
}

/* ── Over quote ───────────────────────────────────────────────────────────── */

/**
 * §7's tolerance: "5% or £50, whichever is greater", both configurable.
 *
 * `basisPoints` because every other rate in this codebase is basis points — 5%
 * is 500 — and an integer rate against an integer amount is exact where a 0.05
 * multiplier is not. The floor is plain pence.
 *
 * "Whichever is greater" is a MAXIMUM of the two, and the direction is worth
 * being sure of: on a £100 quote, 5% is £5 and the floor is £50, so the
 * tolerance is £50 — small jobs get slack in absolute terms. On a £2,000 quote,
 * 5% is £100 and beats the floor. The crossover is at £1,000.
 */
export function overQuoteTolerancePence(
  quoteAmountPence: number,
  basisPoints: number,
  floorPence: number,
): number {
  const proportion = Math.trunc((Math.trunc(quoteAmountPence || 0) * Math.trunc(basisPoints || 0)) / 10_000);
  return Math.max(proportion, Math.trunc(floorPence || 0));
}

export interface OverQuoteInputs {
  /** The invoice's net, or its gross where no net was recorded. See `comparableAmount`. */
  invoiceAmountPence: number;
  quoteAmountPence: number;
  basisPoints: number;
  floorPence: number;
}

export interface OverQuoteResult {
  over: boolean;
  tolerancePence: number;
  excessPence: number;
}

/**
 * Whether an invoice exceeds its approved quote beyond tolerance.
 *
 * At EXACTLY the tolerance it is not over. "Exceeds … by more than a
 * configurable tolerance" is the spec's wording and a strict `>` is what makes
 * it true; a `>=` would flag an invoice that came in at precisely the agreed
 * allowance, which is the one case an operator has explicitly permitted.
 */
export function overQuote(inputs: OverQuoteInputs): OverQuoteResult {
  const tolerancePence = overQuoteTolerancePence(
    inputs.quoteAmountPence,
    inputs.basisPoints,
    inputs.floorPence,
  );
  const excessPence = Math.trunc(inputs.invoiceAmountPence || 0) - Math.trunc(inputs.quoteAmountPence || 0);
  return { over: excessPence > tolerancePence, tolerancePence, excessPence };
}

/**
 * NET AGAINST NET, falling back to gross when either side has no net.
 *
 * A quote is a price for work; VAT on top of it is a rate the supplier does not
 * choose and we reclaim. Comparing gross to gross would raise `over_quote` on
 * every invoice issued after a VAT rate change even though the price never
 * moved, and comparing net to gross would raise it on all of them. Where one
 * side genuinely has no net recorded — a legacy quote row, an invoice typed as
 * a single figure — gross to gross is the only comparison available and is used
 * with both sides taken the same way.
 */
export function comparableAmount(
  netPence: number | null | undefined,
  grossPence: number | null | undefined,
): { amount: number; basis: "net" | "gross" } | null {
  if (typeof netPence === "number" && Number.isFinite(netPence)) return { amount: Math.trunc(netPence), basis: "net" };
  if (typeof grossPence === "number" && Number.isFinite(grossPence)) return { amount: Math.trunc(grossPence), basis: "gross" };
  return null;
}

/* ── Duplicates ───────────────────────────────────────────────────────────── */

export interface DuplicateCandidate {
  id: string;
  /** The supplier, normalised — id where there is one, name otherwise. */
  counterpartyKey: string;
  /** The supplier's own invoice number, normalised. Empty when they gave none. */
  invoiceNumberKey: string;
  grossPence: number;
  /** `YYYY-MM-DD`, or null where no invoice date was recorded. */
  invoiceDay: string | null;
}

export interface DuplicateFinding {
  matchId: string;
  /** `number` — the supplier reused their own reference. `amount` — same money, same window. */
  basis: "number" | "amount";
  detail: string;
}

/**
 * §7's duplicate rule, and §15.2 — "the most expensive routine failure in AP".
 *
 * Two ways in, and BOTH require the same supplier:
 *
 *   1. THE SAME SUPPLIER INVOICE NUMBER, reused. Requiring the same supplier is
 *      not pedantry: "INV-001" is the first invoice every small trader ever
 *      raises, and matching on the number alone would flag half the ledger
 *      against the other half on the day a second contractor joined.
 *   2. THE SAME AMOUNT within `windowDays` of the same supplier's other
 *      invoice. §7's default window is 30 days.
 *
 * NEVER AUTO-DELETES, and nothing here removes or merges a row. It returns a
 * finding; the caller raises a flag; a human decides. A system that silently
 * dropped the second copy would be wrong exactly as often as a monthly retainer
 * is billed at the same figure two months running.
 *
 * A candidate with no invoice date can still match on the NUMBER, but not on
 * the amount — there is no window to be inside of, and treating "no date" as
 * "within 30 days of everything" would flag every repeat charge in the ledger.
 */
export function duplicateFinding(
  candidate: DuplicateCandidate,
  others: readonly DuplicateCandidate[],
  windowDays: number,
): DuplicateFinding | null {
  const window = Math.max(0, Math.trunc(windowDays || 0));
  for (const other of others) {
    if (other.id === candidate.id) continue;
    if (!other.counterpartyKey || other.counterpartyKey !== candidate.counterpartyKey) continue;

    if (candidate.invoiceNumberKey && other.invoiceNumberKey === candidate.invoiceNumberKey) {
      return {
        matchId: other.id,
        basis: "number",
        detail: `The same supplier invoice number is already on this ledger.`,
      };
    }

    if (
      candidate.grossPence === other.grossPence
      && candidate.invoiceDay
      && other.invoiceDay
      && Math.abs(daysBetweenDays(other.invoiceDay, candidate.invoiceDay)) <= window
    ) {
      return {
        matchId: other.id,
        basis: "amount",
        detail: `Same supplier, same amount, invoice dates within ${window} days.`,
      };
    }
  }
  return null;
}

/** The supplier, as one comparable key. Id where there is one; the name otherwise. */
export function counterpartyKey(
  counterpartyId: string | null | undefined,
  counterpartyName: string | null | undefined,
): string {
  const id = (counterpartyId ?? "").trim();
  if (id) return `id:${id.toLowerCase()}`;
  const name = financeStatusKey(counterpartyName);
  return name ? `name:${name}` : "";
}

/** A supplier's own reference, normalised. Punctuation and case are theirs, not ours. */
export function referenceKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s/\\.-]+/g, "");
}

/* ── Outside the agreement ────────────────────────────────────────────────── */

export interface AgreementInputs {
  category: string | null | undefined;
  /** `sites.billable`, or null when the invoice names no site. */
  siteBillable: boolean | null;
  siteBillingFrom: string | null;
  siteBillingTo: string | null;
  /** The invoice date, `YYYY-MM-DD`, or null. */
  invoiceDay: string | null;
}

/**
 * §7's `outside_agreement`, keyed on what this schema actually records.
 *
 * ── WHAT IT KEYS ON, AND WHY IT IS NOT WHAT §7 LITERALLY SAYS ──────────────
 *
 * §7 says "Category not covered by the client agreement". There is no client
 * agreement table in this schema and no per-client list of covered categories,
 * so that check as written is not computable and guessing one would be an
 * invented rule with real money behind it. Two things ARE recorded, and both
 * are genuinely "outside the agreement":
 *
 *   1. THE CATEGORY IS NOT ONE THE PRODUCT BILLS FOR. `FINANCE_CATEGORIES` in
 *      `./model.ts` is §4's closed list and the only written statement of what
 *      work this product invoices. A category outside it is outside the
 *      agreement in the only sense the data supports. A BLANK category raises
 *      nothing — "not stated" is not evidence of anything.
 *   2. THE SITE IS NOT CHARGEABLE, or the invoice falls outside its billing
 *      window. `sites.billable` and `billing_active_from` / `billing_active_to`
 *      exist precisely to say "this site is outside the agreement" — the schema
 *      comment on those columns uses that phrase — and they are maintained by
 *      the people who negotiate it.
 *
 * When a real agreement table arrives, this function is where it plugs in and
 * the two rules above become its fallback.
 */
export function outsideAgreement(inputs: AgreementInputs): string | null {
  const category = financeCategoryKey(inputs.category);
  if (category && !AGREEMENT_CATEGORIES.has(category)) {
    return `"${String(inputs.category).slice(0, 40)}" is not one of the categories this agreement covers.`;
  }
  if (inputs.siteBillable === false) {
    return "The site on this invoice is recorded as not chargeable.";
  }
  const day = inputs.invoiceDay;
  if (day && inputs.siteBillingFrom && day < inputs.siteBillingFrom) {
    return `The invoice date is before this site's billing window opened on ${inputs.siteBillingFrom}.`;
  }
  if (day && inputs.siteBillingTo && day > inputs.siteBillingTo) {
    return `The invoice date is after this site's billing window closed on ${inputs.siteBillingTo}.`;
  }
  return null;
}

const AGREEMENT_CATEGORIES = new Set<string>([
  "electrical",
  "fire",
  "water",
  "hvac",
  "general",
  "project",
  "retainer",
  "performance",
]);

/* ── Flags ────────────────────────────────────────────────────────────────── */

export interface FlagLike {
  flagType: string;
  severity: string;
  status: string;
}

/**
 * The open, blocking flags — the ones that stop "Approved for payment".
 *
 * §7: flags "block Approved for payment until cleared or waived with a typed
 * reason". So the two ways past a flag are both recorded states of the ROW —
 * `cleared` (the engine found the cause gone) and `waived` (a person typed why)
 * — and neither is a computation this function performs. It only reads.
 */
export function blockingFlags<T extends FlagLike>(flags: readonly T[]): T[] {
  return flags.filter((flag) => flag.status === "open" && flag.severity === "blocking");
}

/**
 * Every §7 flag blocks, and the `severity` column is why that is a default
 * rather than a constant.
 *
 * §7 does not grade its eight — the sentence is blanket, and the two the
 * acceptance criteria call out by name (duplicate, over-quote) are the two an
 * operator would most want to be stopped by. So the engine writes `blocking`
 * for all eight and a workspace that decides `site_mismatch` is advisory can
 * downgrade that row without a deploy, which is exactly what a column can do
 * and a hard-coded map cannot.
 */
export const DEFAULT_FLAG_SEVERITY: Record<FinanceFlagType, "blocking" | "warning"> = {
  no_approved_quote: "blocking",
  over_quote: "blocking",
  job_not_complete: "blocking",
  site_mismatch: "blocking",
  possible_duplicate: "blocking",
  no_linked_job: "blocking",
  vat_anomaly: "blocking",
  outside_agreement: "blocking",
};

/* ── Approval bands ───────────────────────────────────────────────────────── */

export interface ApprovalRuleLike {
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

/**
 * The band an amount falls in, or null when the ladder has a hole in it.
 *
 * HALF-OPEN ON THE UPPER BOUND, which is the schema's own annotation: a
 * `max_amount_pence` of 100000 means "up to but not including £1,000", and NULL
 * means "and above". §13's worked example seeds 0–£250, £250–£1,000,
 * £1,000–£5,000 and £5,000+, and half-open is what makes exactly £250 land in
 * the second band rather than in both or neither.
 *
 * Returns NULL rather than a default when nothing matches. A missing band is an
 * administrator having edited the ladder into a gap, and inventing "one
 * approver" for an amount nobody has a rule for is how a £40,000 invoice gets
 * signed off by one person. The caller refuses instead.
 */
export function resolveApprovalBand<T extends ApprovalRuleLike>(
  rules: readonly T[],
  direction: InvoiceDirection,
  amountPence: number,
): T | null {
  const amount = Math.trunc(amountPence || 0);
  const candidates = rules
    .filter((rule) => rule.active && rule.direction === direction)
    .filter((rule) => amount >= Math.trunc(rule.minAmountPence || 0))
    .filter((rule) => rule.maxAmountPence === null || amount < Math.trunc(rule.maxAmountPence))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.minAmountPence - b.minAmountPence);
  return candidates[0] ?? null;
}

export interface ApprovalDecisionInputs {
  band: ApprovalRuleLike;
  amountPence: number;
  /** Emails of approvers who have already recorded an `approved` decision. */
  approvedBy: readonly string[];
  actorEmail: string;
  /** `quotations.approved_by` on the quote this invoice is billed against. */
  quoteApprovedBy: string | null;
  /** Whether the quote carries a recorded client sign-off. §13. */
  clientSignedOff: boolean;
}

export interface ApprovalDecision {
  allowed: boolean;
  /** Why not, in a sentence a person can act on. Null when allowed. */
  refusal: string | null;
  /** The sentence recorded on the approval row: which band, how many approvers. */
  basis: string;
  approversRequired: number;
  approvalsHeld: number;
  /** Whether this approval completes the band. */
  completesBand: boolean;
}

/**
 * MAKER / CHECKER, AND THE BAND. §13.
 *
 * Two separate refusals, and they fail for different reasons:
 *
 *   · THE SAME PERSON TWICE. `invoice_approval_records` has a UNIQUE index on
 *     (invoice, approver), so a second row from one approver cannot exist — but
 *     the index would surface as a 503 rather than a sentence, so it is refused
 *     here first. Two approvers required means two PEOPLE.
 *
 *   · THE PERSON WHO APPROVED THE QUOTE. §13: "An approver cannot approve an
 *     invoice against a quote they themselves approved above a configurable
 *     value." `maker_checker_from_pence` is that value and it is per-band. The
 *     comparison is `>=`: a threshold of £1,000 means the control applies AT a
 *     thousand pounds, because a threshold you are exactly on is a threshold
 *     you have met — the reading that errs towards more control, which is the
 *     right way for a control to err.
 *
 * Case- and space-insensitive on the email, because the quote's `approved_by`
 * was written by one route and the session's identity by another, and a capital
 * letter is not a different person.
 */
export function approvalDecision(inputs: ApprovalDecisionInputs): ApprovalDecision {
  const required = Math.max(0, Math.trunc(inputs.band.approversRequired || 0));
  const held = inputs.approvedBy.length;
  const actor = emailKey(inputs.actorEmail);
  const basis = approvalBasis(inputs.band, inputs.amountPence, held + 1);

  if (inputs.approvedBy.some((email) => emailKey(email) === actor)) {
    return {
      allowed: false,
      refusal: "You have already approved this invoice. A second approval has to come from someone else.",
      basis,
      approversRequired: required,
      approvalsHeld: held,
      completesBand: false,
    };
  }

  const threshold = inputs.band.makerCheckerFromPence;
  const amount = Math.trunc(inputs.amountPence || 0);
  if (
    typeof threshold === "number"
    && amount >= threshold
    && inputs.quoteApprovedBy
    && emailKey(inputs.quoteApprovedBy) === actor
  ) {
    return {
      allowed: false,
      refusal:
        "You approved the quote this invoice is billed against, so you cannot also approve the invoice at this value. Someone else has to check it.",
      basis,
      approversRequired: required,
      approvalsHeld: held,
      completesBand: false,
    };
  }

  if (inputs.band.requiresClient && !inputs.clientSignedOff) {
    return {
      allowed: false,
      refusal:
        "This band needs the client's sign-off recorded against the quote before the invoice can be approved.",
      basis,
      approversRequired: required,
      approvalsHeld: held,
      completesBand: false,
    };
  }

  return {
    allowed: true,
    refusal: null,
    basis,
    approversRequired: required,
    approvalsHeld: held,
    completesBand: held + 1 >= required,
  };
}

/** "£1,200.00 falls in the £1,000.00–£5,000.00 band: 2 approvers. This is approval 1 of 2." */
export function approvalBasis(
  band: ApprovalRuleLike,
  amountPence: number,
  approvalNumber: number,
): string {
  const upper = band.maxAmountPence === null ? "and above" : `to ${poundsWord(band.maxAmountPence)}`;
  const required = Math.max(0, Math.trunc(band.approversRequired || 0));
  const window = band.maxAmountPence === null
    ? `${poundsWord(band.minAmountPence)} ${upper}`
    : `${poundsWord(band.minAmountPence)} ${upper}`;
  const client = band.requiresClient ? " Client sign-off is required on the quote." : "";
  if (required === 0) {
    return `${poundsWord(amountPence)} falls in the ${window} band, which auto-approves on a clean match.${client}`;
  }
  return `${poundsWord(amountPence)} falls in the ${window} band, which needs ${required} ${
    required === 1 ? "approver" : "approvers"
  }. This is approval ${approvalNumber} of ${required}.${client}`;
}

/**
 * `£1,200.00`, for a sentence.
 *
 * Not `formatPence` from `./model`: that one drops the pence above £1,000 for a
 * dashboard card, and a recorded approval basis is a legal-ish statement about
 * a specific figure. It keeps every penny.
 */
function poundsWord(pence: number): string {
  const value = Math.trunc(pence || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}£${Math.floor(absolute / 100).toLocaleString("en-GB")}.${String(
    absolute % 100,
  ).padStart(2, "0")}`;
}

function emailKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
