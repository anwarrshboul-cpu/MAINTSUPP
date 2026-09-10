/**
 * MODULE 5's VOCABULARY AND ITS MONEY. Nothing else, and nothing imported.
 *
 * ── WHY THIS FILE IMPORTS NOTHING AT ALL ───────────────────────────────────
 *
 * Every other module in `app/lib/finance/` reaches drizzle, and a module that
 * reaches drizzle cannot be loaded by `node --test` — `db/schema.ts` is
 * imported without a file extension, which native ESM refuses, and the
 * `data:`-URL transpile trick the suite uses elsewhere cannot resolve a bare
 * specifier like `drizzle-orm` either. So the rules that are worth testing by
 * CALLING them live here and in `./rules.ts` (which imports only this file),
 * and `balance.ts`, `allocations.ts`, `matching.ts` and `approvals.ts` re-export
 * their own pure half from there. A test therefore exercises shipped code
 * rather than a re-implementation that could agree with itself while the
 * product is wrong.
 *
 * ── THE STATUS KEYS ARE A FALLBACK, NOT THE TRUTH ──────────────────────────
 *
 * §5 puts the status vocabulary in an editable `invoice_status_map` table, and
 * that table is the authority: a workspace may rename "Query raised", recolour
 * it, or retire it. What lives here is only the KEY LADDER — the order the
 * seeds are in, which is the order a status moves through — so that a route can
 * decide whether a transition is legal without a second database read, and so
 * that an unmapped status has somewhere to fall back to instead of vanishing.
 * §5: "Unmapped statuses render grey with the raw label and raise an admin
 * notice, never disappear."
 *
 * ── MONEY IS INTEGER PENCE, ALWAYS ─────────────────────────────────────────
 *
 * There is no float anywhere in this module. `penceFromInput` is the one door
 * an outside number comes through and it is deliberately explicit about which
 * unit it was handed — see its own note, because guessing that is how an
 * invoice gets booked at a hundredth of its value.
 */

/* ── Direction ────────────────────────────────────────────────────────────── */

export const INVOICE_DIRECTIONS = ["payable", "receivable"] as const;
export type InvoiceDirection = (typeof INVOICE_DIRECTIONS)[number];

export function isInvoiceDirection(value: unknown): value is InvoiceDirection {
  return typeof value === "string" && (INVOICE_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The direction of money that settles an invoice of this direction.
 *
 * A payable is settled by money going OUT; a receivable by money coming IN.
 * `payments.direction` is `in | out` and `invoices.direction` is
 * `payable | receivable`, and the two vocabularies are deliberately different
 * words for different things — a payment is an event, an invoice is an
 * obligation. This is the only translation between them, so a route never has
 * to remember which way round it goes.
 */
export const PAYMENT_DIRECTIONS = ["in", "out"] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export function settlingDirection(direction: InvoiceDirection): PaymentDirection {
  return direction === "payable" ? "out" : "in";
}

export function isPaymentDirection(value: unknown): value is PaymentDirection {
  return typeof value === "string" && (PAYMENT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * "THIS INVOICE HAS NO JOB", written into a NOT NULL column.
 *
 * §7's `no_linked_job` flag — "Invoice with no job at all" — is only raisable if
 * such an invoice can be STORED, and `invoices.request_id` is NOT NULL and
 * predates Module 5 by a long way. `db/init.ts` performs no destructive ALTER,
 * so the column cannot be relaxed; the schema comment beside it says the same.
 *
 * A sentinel is the way out, and it is safe rather than lucky: the bootstrap
 * DDL creates `request_id` with no REFERENCES clause (`db/init.ts`, the
 * `CREATE TABLE IF NOT EXISTS invoices` near the top), and the deployed
 * Postgres agrees — `portal.invoices` carries exactly one foreign key and it is
 * on `organisation_id`. Measured on Staging rather than assumed, because a
 * sentinel that a foreign key rejects is the classic passes-locally-fails-
 * deployed fault this codebase's two dialects invite.
 *
 * It mirrors `UNASSIGNED_SITE_ID` ("site-unassigned"), which solves the same
 * problem on the same estate. Nothing joins on it: `no_linked_job` is decided
 * from `invoice_job_alloc` being EMPTY, not from this value, so a reader that
 * has never heard of the sentinel still gets the right answer.
 */
export const UNLINKED_JOB_ID = "job-unlinked";

export function hasLinkedJob(requestId: string | null | undefined): boolean {
  const value = (requestId ?? "").trim();
  return value.length > 0 && value !== UNLINKED_JOB_ID;
}

/* ── Statuses ─────────────────────────────────────────────────────────────── */

/**
 * §5's payable ladder, as keys. The labels and colours live in the database.
 *
 * Order is meaningful: it is the order `db/init.ts` seeds them in, it is the
 * `sort_order` a screen groups by, and `financeStatusRank` below reads it.
 */
export const PAYABLE_STATUS_KEYS = [
  "draft",
  "received",
  "under_review",
  "query_raised",
  "approved",
  "scheduled",
  "part_paid",
  "paid",
  "disputed",
  "voided",
  "credited",
] as const;

/** §5's receivable ladder, as keys. */
export const RECEIVABLE_STATUS_KEYS = [
  "draft",
  "issued",
  "sent",
  "viewed",
  "overdue",
  "part_paid",
  "paid",
  "disputed",
  "written_off",
  "voided",
  "credited",
] as const;

export type PayableStatusKey = (typeof PAYABLE_STATUS_KEYS)[number];
export type ReceivableStatusKey = (typeof RECEIVABLE_STATUS_KEYS)[number];
export type FinanceStatusKey = PayableStatusKey | ReceivableStatusKey;

export function statusLadder(direction: InvoiceDirection): readonly FinanceStatusKey[] {
  return direction === "payable" ? PAYABLE_STATUS_KEYS : RECEIVABLE_STATUS_KEYS;
}

/**
 * The colour an unmapped status renders in, and the reason it is grey.
 *
 * §5 again: grey with the raw label, never disappearing. A screen that hides a
 * status it does not recognise hides the invoice with it.
 */
export const UNMAPPED_STATUS_COLOUR = "#64748B";

/**
 * A status label, normalised to the key `invoice_status_map` stores.
 *
 * MIRRORS `statusKey()` in `app/lib/job-metrics.ts` — trim, lowercase, collapse
 * runs of whitespace — for exactly the reason given there: these labels have
 * been through a spreadsheet, a CSV round trip and a human, and "Under review",
 * "under  review" and "UNDER REVIEW" are one status. It then adds one step that
 * `statusKey` does not need: the separator becomes an underscore, because
 * `invoice_status_map.status_key` is snake_case (`under_review`) while the
 * label a person types is spaced ("Under review"). Hyphens fold the same way,
 * so "part-paid" and "Part paid" are the same key.
 *
 * It is NOT a validator. An unrecognised key is returned normalised rather than
 * rejected, so the caller can render it grey with its raw label instead of
 * losing the row — which is the whole of §5's unmapped rule.
 */
export function financeStatusKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Where a status sits on its ladder, or -1 when the ladder has never heard of it. */
export function financeStatusRank(direction: InvoiceDirection, status: string | null | undefined): number {
  return (statusLadder(direction) as readonly string[]).indexOf(financeStatusKey(status));
}

/** The statuses that mean the invoice is finished with, either way. */
export const TERMINAL_STATUS_KEYS: readonly string[] = ["paid", "voided", "credited", "written_off"];

export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUS_KEYS.includes(financeStatusKey(status));
}

/* ── Payment methods ──────────────────────────────────────────────────────── */

/** §6. `offset` is a contra — one counterparty's invoice settling another's. */
export const PAYMENT_METHODS = [
  "bank_transfer",
  "card",
  "direct_debit",
  "cheque",
  "offset",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/* ── Categories ───────────────────────────────────────────────────────────── */

/**
 * §4's eight, and they are a closed list on purpose.
 *
 * `outside_agreement` in §7 has to decide whether a category is "covered by the
 * client agreement", and this schema records no per-client agreement — see the
 * note in `rules.ts` on `outsideAgreementFinding`. This list is therefore the
 * only written statement of what work the product bills for, which makes it the
 * only defensible thing that check can key on. Adding a ninth category is a
 * product decision that belongs here, in one place, rather than in a `case`.
 */
export const FINANCE_CATEGORIES = [
  "electrical",
  "fire",
  "water",
  "hvac",
  "general",
  "project",
  "retainer",
  "performance",
] as const;
export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];

/** The same normalisation statuses get, so "Fire Safety " and "fire" are not two categories. */
export function financeCategoryKey(value: string | null | undefined): string {
  return financeStatusKey(value);
}

export function isFinanceCategory(value: unknown): value is FinanceCategory {
  return typeof value === "string"
    && (FINANCE_CATEGORIES as readonly string[]).includes(financeCategoryKey(value));
}

/* ── Flags ────────────────────────────────────────────────────────────────── */

/** §7's eight, in the order the table lists them. */
export const FINANCE_FLAG_TYPES = [
  "no_approved_quote",
  "over_quote",
  "job_not_complete",
  "site_mismatch",
  "possible_duplicate",
  "no_linked_job",
  "vat_anomaly",
  "outside_agreement",
] as const;
export type FinanceFlagType = (typeof FINANCE_FLAG_TYPES)[number];

export function isFinanceFlagType(value: unknown): value is FinanceFlagType {
  return typeof value === "string" && (FINANCE_FLAG_TYPES as readonly string[]).includes(value);
}

export const FLAG_STATUSES = ["open", "cleared", "waived"] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/* ── Quote lifecycle ──────────────────────────────────────────────────────── */

/** §3's seven, as keys. `quotations.status` also carries legacy prose — see `quoteStatusKey`. */
export const QUOTE_STATUS_KEYS = [
  "requested",
  "received",
  "under_review",
  "approved",
  "rejected",
  "expired",
  "superseded",
] as const;
export type QuoteStatusKey = (typeof QUOTE_STATUS_KEYS)[number];

/**
 * A quote's status key, with the ONE legacy label this table already carries.
 *
 * `quotations.status` defaults to "Awaiting approval" and rows created before
 * Module 5 hold exactly that. It is §3's "Under review" in different words, and
 * translating it here rather than migrating the column is the additive choice
 * `db/init.ts` is built around: no destructive UPDATE, and an old row reads
 * correctly the first time a screen opens it.
 */
export function quoteStatusKey(value: string | null | undefined): string {
  const key = financeStatusKey(value);
  if (key === "awaiting_approval") return "under_review";
  return key;
}

export function isQuoteStatusKey(value: unknown): value is QuoteStatusKey {
  return typeof value === "string" && (QUOTE_STATUS_KEYS as readonly string[]).includes(value);
}

/* ── Money ────────────────────────────────────────────────────────────────── */

/**
 * A whole number of pence from something a client sent, or null.
 *
 * ── THE ONE RULE, STATED ONCE ──────────────────────────────────────────────
 *
 * **A value carrying a decimal fraction or a currency symbol is POUNDS. A bare
 * integer is PENCE.**
 *
 * That is a decision, not a guess, and it is written down because the guess is
 * the expensive part. `123456` could be £1,234.56 or £123,456 and no amount of
 * cleverness can tell; a system that decides by magnitude ("large numbers are
 * probably pence") books a £2,000 invoice at £20 the first time somebody types
 * a round figure. So the SHAPE decides, always:
 *
 *   1234.56   -> 123456p   a fraction cannot be pence, so it is pounds
 *   "1234.56" -> 123456p   same
 *   "£1,234"  -> 123400p   a currency symbol says pounds out loud
 *   123456    -> 123456p   a bare integer is what every column here stores
 *   "123456"  -> 123456p   same rule, so a string and a number never disagree
 *
 * Callers that ALWAYS mean pounds — a form field labelled "£" — should use
 * `poundsToPence` and not rely on the shape at all. Routes reading a field
 * named `…Pence` should use `pence()` from `app/lib/reporting/route-helpers.ts`,
 * which accepts numbers only. This function is for the one case in between: an
 * amount a person typed.
 *
 * Refuses rather than defaulting. `NaN`, `Infinity`, an empty string, a
 * negative-looking string with letters in it and anything that is not a number
 * or a string all return null, and the caller answers 400 — because a money
 * field that silently becomes zero is an invoice for nothing.
 */
export function penceFromInput(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) return value;
    return roundHalfAwayFromZero(value * 100);
  }
  if (typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw) return null;

  /* A symbol or a grouping comma is a person writing pounds. Recorded before
     they are stripped, because stripping them is what makes the number
     parseable and would otherwise erase the evidence of the unit. */
  const looksLikePounds = /[£$€,]/.test(raw) || raw.includes(".");
  const cleaned = raw.replace(/[£$€,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  if (!looksLikePounds) return Math.trunc(parsed);
  return roundHalfAwayFromZero(parsed * 100);
}

/** Pounds to pence, for a caller that knows its unit. */
export function poundsToPence(pounds: number): number | null {
  if (typeof pounds !== "number" || !Number.isFinite(pounds)) return null;
  return roundHalfAwayFromZero(pounds * 100);
}

/**
 * Half away from zero, and not `Math.round`.
 *
 * `Math.round(-0.5)` is `-0`, which rounds a half-penny TOWARDS zero on the
 * negative side and away from it on the positive — so a credit note and the
 * invoice it credits could round in opposite directions and leave a penny that
 * nothing accounts for. Away from zero on both sides is what accountants call
 * commercial rounding and it is symmetric, which is the property that matters.
 *
 * Also guards the float: `19.99 * 100` is `1998.9999999999998`, so the
 * multiplication is nudged back onto the penny it plainly means before the
 * rounding decision is taken.
 */
function roundHalfAwayFromZero(value: number): number {
  const nudged = Number(value.toFixed(6));
  return nudged < 0 ? -Math.round(-nudged) : Math.round(nudged);
}

export interface FormatPenceOptions {
  /**
   * The small-screen form. Dashboard master prompt §3.7: "abbreviate on small
   * screens with full value on tap", and §1.9: the accessible label states the
   * full value, never the abbreviated one — so a caller that abbreviates must
   * also render the un-abbreviated string somewhere a screen reader reaches it.
   */
  abbreviate?: boolean;
  /** GBP unless a foreign supplier turns up. §15.7 keeps the field for that day. */
  currency?: string;
}

/**
 * Integer pence as the string a screen shows.
 *
 * Dashboard master prompt §3.7 is the rule and it is one sentence: "Currency
 * GBP; no decimals above £1,000, two below". So £12.34 keeps its pence and
 * £1,234.56 does not, because on a card full of five-figure sums the pence are
 * noise, and on a £12 sum they are the number.
 *
 * The pence are never LOST — this is a formatter, and every caller still holds
 * the exact integer. Nothing in `balance.ts` or `repository.ts` calls it.
 */
export function formatPence(pence: number, options: FormatPenceOptions = {}): string {
  const symbol = currencySymbolFor(options.currency ?? "GBP");
  const value = Math.trunc(Number.isFinite(pence) ? pence : 0);
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);

  if (options.abbreviate && absolute >= 100_000_000) {
    return `${sign}${symbol}${trimZero(absolute / 100_000_000)}m`;
  }
  if (options.abbreviate && absolute >= 1_000_000) {
    return `${sign}${symbol}${trimZero(absolute / 100_000)}k`;
  }

  /* £1,000 is 100,000 pence, and the boundary is INCLUSIVE of the decimals:
     £1,000.00 still prints its pence, £1,000.01 does not. "Above £1,000" is
     read literally — a figure that is exactly a thousand pounds is not above
     it — so the switch happens one penny later than a `>=` would put it. */
  if (absolute <= 100_000) {
    const pounds = Math.floor(absolute / 100);
    const remainder = absolute % 100;
    return `${sign}${symbol}${pounds.toLocaleString("en-GB")}.${String(remainder).padStart(2, "0")}`;
  }

  const rounded = Math.round(absolute / 100);
  return `${sign}${symbol}${rounded.toLocaleString("en-GB")}`;
}

/** One decimal, and no trailing `.0` — `£1.2k`, `£3k`, `£12.5m`. */
function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * The symbol, or the code when there is no symbol worth guessing.
 *
 * The same three-and-a-fallback as `currencySymbol` in
 * `app/lib/exports/format.ts`, and for the reason written there: an unknown
 * code renders as "USD 1,690.00", which is unambiguous, where a wrong symbol is
 * a document that says the wrong thing confidently. Not imported from that
 * module because it reaches `../reporting/contract` for its types and this file
 * imports nothing — see the header.
 */
export function currencySymbolFor(currency: string): string {
  const code = (currency || "GBP").toUpperCase();
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  if (code === "USD") return "$";
  return `${code} `;
}

/**
 * Net + VAT, with VAT derived from basis points when it was not supplied.
 *
 * Basis points, like every other rate in this codebase: 20% is 2000. An integer
 * rate against an integer net is exact, where a 0.2 multiplier is not.
 */
export function vatFromBasisPoints(netPence: number, basisPoints: number): number {
  return roundHalfAwayFromZero((Math.trunc(netPence) * Math.trunc(basisPoints)) / 10_000);
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

/**
 * DAY ARITHMETIC HAPPENS HERE, IN JAVASCRIPT, FROM ONE SERVER `now`.
 *
 * `db/sqlite-to-postgres.ts` refuses `julianday(`, `strftime(` and
 * `unixepoch(` BY NAME, and there is no expression that computes a day
 * difference in both dialects. So every boundary this module needs is computed
 * from the server instant and reaches SQL as a bare `YYYY-MM-DD` comparison —
 * the technique documented at the head of `app/lib/dashboard-filters.ts`, which
 * holds the same three functions and cannot be imported here because it reaches
 * drizzle at module scope. See this file's own header for why that matters.
 */

/** `YYYY-MM-DD` for an instant, in UTC. Never shifts a day west of Greenwich. */
export function financeDay(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * The calendar day inside a value that may be either shape.
 *
 * `invoices.due_at` carries a bare `YYYY-MM-DD` on rows the app wrote, a full
 * ISO instant on rows an importer wrote, `YYYY-MM-DD HH:MM:SS` from SQLite's
 * `CURRENT_TIMESTAMP`, and on Production it is a real Postgres `date` that
 * arrives already cast to text. All four begin with the ten characters that
 * matter, which is why this is a slice and not a parse.
 */
export function dayOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

/** `YYYY-MM-DD` a whole number of days from another one. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return financeDay(new Date(Date.UTC(year, month - 1, date + days)));
}

/**
 * Whole days from `from` to `to`, positive when `to` is later.
 *
 * Both arguments are calendar days, so this is exact: no hours, no timezone,
 * no daylight saving. `Date.UTC` on a bare day is midnight UTC and the
 * difference of two midnights is always a whole number of 86,400,000s.
 */
export function daysBetweenDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Payment terms to a due day. §4: 14 / 30 / 60 days, or on receipt (0). */
export function dueDayFromTerms(invoiceDay: string, termsDays: number | null | undefined): string {
  const days = typeof termsDays === "number" && Number.isFinite(termsDays) ? Math.trunc(termsDays) : 0;
  return shiftDay(invoiceDay, days);
}
