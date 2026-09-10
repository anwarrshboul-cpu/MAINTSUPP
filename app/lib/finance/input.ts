/**
 * WHAT A REQUEST IS ALLOWED TO SAY, PARSED ONCE.
 *
 * Eleven finance routes read the same twenty fields off a JSON body, and a
 * validator written eleven times is eleven chances for one of them to accept a
 * float where the others take pence. So every field a client can set has
 * exactly one reader here, and every one of them REFUSES rather than defaulting
 * — an amount that cannot be parsed is a 400, never a silent zero, because an
 * invoice for nothing looks exactly like an invoice somebody meant.
 *
 * `text` and `pence` from `app/lib/reporting/route-helpers.ts` are reused
 * rather than re-implemented; this module adds the finance vocabulary on top.
 */

import { dateOnly } from "../reporting/period";
import { text } from "../reporting/route-helpers";
import {
  FINANCE_CATEGORIES,
  INVOICE_DIRECTIONS,
  PAYMENT_METHODS,
  dayOf,
  financeCategoryKey,
  financeStatusKey,
  isInvoiceDirection,
  isPaymentDirection,
  isPaymentMethod,
  penceFromInput,
  type FinanceCategory,
  type InvoiceDirection,
  type PaymentDirection,
  type PaymentMethod,
} from "./model";

export { text } from "../reporting/route-helpers";

export type Body = Record<string, unknown>;

/** The body, or null when it was not JSON. Every route answers 400 on null. */
export async function readBody(request: Request): Promise<Body | null> {
  return (await request.json().catch(() => null)) as Body | null;
}

/**
 * A whole number of pence, refusing anything that is not one.
 *
 * Goes through `penceFromInput`, which decides pounds-versus-pence by the SHAPE
 * of the value rather than by its magnitude — see the long note there. A
 * negative amount is refused: a negative invoice is a credit note, and §6 says
 * so, with its own record type and its own reason.
 */
export function money(value: unknown, options: { allowZero?: boolean } = {}): number | null {
  const parsed = penceFromInput(value);
  if (parsed === null) return null;
  if (parsed < 0) return null;
  if (parsed === 0 && !options.allowZero) return null;
  return parsed;
}

/** A bare `YYYY-MM-DD`, or null. Refuses 31 February — `dateOnly` round-trips it. */
export function day(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return dateOnly(value) ?? dayOf(value);
}

export function direction(value: unknown): InvoiceDirection | null {
  return isInvoiceDirection(value) ? value : null;
}

export function paymentDirection(value: unknown): PaymentDirection | null {
  return isPaymentDirection(value) ? value : null;
}

export function method(value: unknown): PaymentMethod | null {
  return isPaymentMethod(value) ? value : null;
}

/**
 * A §4 category, normalised.
 *
 * Refuses one the product does not bill for, rather than storing it and letting
 * `outside_agreement` flag every invoice that carries it. The flag is for data
 * that arrived some other way — an import, an email intake — not for a typo a
 * form could have refused.
 */
export function category(value: unknown): FinanceCategory | null {
  const key = financeCategoryKey(typeof value === "string" ? value : null);
  return (FINANCE_CATEGORIES as readonly string[]).includes(key) ? (key as FinanceCategory) : null;
}

/** A status key. Never validated against the ladder here — §5's map is the authority. */
export function status(value: unknown): string | null {
  const key = financeStatusKey(typeof value === "string" ? value : null);
  return key || null;
}

/** Repeated query parameters, the convention `dashboard-filters.ts` established. */
export function repeated(params: URLSearchParams, name: string): string[] {
  return params.getAll(name).map((value) => value.trim()).filter(Boolean);
}

export function flag(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  return value === "1" || value === "true" || value === "yes";
}

export function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * The net / VAT / gross triple, made consistent.
 *
 * A client may send any two of the three. Deriving the third here rather than
 * trusting all three is what stops a row where `net + vat <> gross`, which is
 * unarguable when it happens and impossible to fix afterwards without knowing
 * which of the three the person meant.
 *
 * Where all three are sent and they do not agree, the request is REFUSED. The
 * alternative — silently preferring one — books a figure nobody typed.
 */
export function amountTriple(body: Body): { netPence: number; vatPence: number; grossPence: number } | string {
  const net = body.netPence === undefined && body.net === undefined ? null : money(body.netPence ?? body.net, { allowZero: true });
  const vat = body.vatPence === undefined && body.vat === undefined ? null : money(body.vatPence ?? body.vat, { allowZero: true });
  const gross = body.grossPence === undefined && body.gross === undefined ? null : money(body.grossPence ?? body.gross, { allowZero: true });

  if (net !== null && vat !== null && gross !== null) {
    if (net + vat !== gross) {
      return `Net ${net}p plus VAT ${vat}p is ${net + vat}p, not the gross of ${gross}p. Send two of the three and the third is worked out.`;
    }
    return { netPence: net, vatPence: vat, grossPence: gross };
  }
  if (net !== null && vat !== null) return { netPence: net, vatPence: vat, grossPence: net + vat };
  if (net !== null && gross !== null) return { netPence: net, vatPence: gross - net, grossPence: gross };
  if (vat !== null && gross !== null) return { netPence: gross - vat, vatPence: vat, grossPence: gross };
  if (net !== null) return { netPence: net, vatPence: 0, grossPence: net };
  if (gross !== null) return { netPence: gross, vatPence: 0, grossPence: gross };
  return "Send an amount: net and VAT, or a gross.";
}

/** Every direction the vocabulary knows, for an error message that helps. */
export const DIRECTION_LIST = INVOICE_DIRECTIONS.join(", ");
export const METHOD_LIST = PAYMENT_METHODS.join(", ");
export const CATEGORY_LIST = FINANCE_CATEGORIES.join(", ");

/** A bounded free-text note. Re-exported spelling so routes import one module. */
export function note(value: unknown, max = 2000): string | null {
  return text(value, max);
}
