/**
 * WHO MAY DO WHAT IN THE INVOICE TRACKER — one table, no new capabilities.
 *
 * The same argument `app/lib/reporting/access.ts` makes, applied to the same
 * catalogue: this workspace has three roles and ONE capability list, and
 * inventing a second for finance would mean two systems disagreeing about who
 * an Administrator is. `app/lib/permissions.ts` is not edited by this feature.
 *
 *   Viewer / anybody who can open a board  ->  `board.view`
 *       read the ledger, an invoice, a quote, the flags on one.
 *   Operations                             ->  `board.edit`
 *       create and edit a draft, allocate it across jobs, record a payment,
 *       raise a credit note, submit for approval, raise a dispute.
 *   Administrator / Finance                ->  `settings.edit`
 *       approve, reject, schedule, finalise, void, waive a flag, resolve a
 *       dispute. Everything that ends an argument about money.
 *   Destruction                            ->  `data.delete`
 *       permanently removing a draft or a payment. Deliberately withheld from
 *       `admin` by the catalogue, and that is the right shape here: voiding is
 *       how a real invoice is withdrawn, and a voided row is the evidence that
 *       it was.
 *
 * WHY NOT `billing.manage`: it exists and its catalogue entry says it "grants
 * nothing today", and its built-in default is `super_admin` ONLY. Wiring
 * approval to it would ship a workspace Administrator who cannot approve their
 * own invoices. Re-pointing it is a product decision with a migration attached,
 * not a side effect of adding a screen.
 */

import type { Capability } from "../permissions";
import { anonymousRefusal, busyRefusal, scopedDbWithCapability, type ScopedDatabase } from "../tenant-db";
import { ensureDatabase } from "../../../db/init";

/** Every distinct thing a caller can ask the invoice tracker to do. */
export type FinanceOperation =
  | "ledger.read"
  | "ledger.write"
  | "ledger.delete"
  | "invoice.submit"
  | "invoice.approve"
  | "invoice.finalise"
  | "invoice.void"
  | "invoice.rematch"
  | "invoice.dispute"
  | "invoice.resolve_dispute"
  | "flag.waive"
  | "quote.read"
  | "quote.write"
  | "quote.approve"
  | "payment.read"
  | "payment.write"
  | "payment.delete"
  | "credit_note.write";

/**
 * The capability each operation requires.
 *
 * One table, so a reviewer can read the whole authorisation model of this
 * feature in twenty lines rather than by grepping for
 * `scopedDbWithCapability` across eleven route files.
 */
export const FINANCE_CAPABILITIES: Record<FinanceOperation, Capability> = {
  "ledger.read": "board.view",
  "ledger.write": "board.edit",
  "ledger.delete": "data.delete",
  "invoice.submit": "board.edit",
  "invoice.approve": "settings.edit",
  "invoice.finalise": "settings.edit",
  "invoice.void": "settings.edit",
  "invoice.rematch": "board.edit",
  "invoice.dispute": "board.edit",
  "invoice.resolve_dispute": "settings.edit",
  /*
   * WAIVING IS `settings.edit`, and that is the sharp end of §7.
   *
   * A waiver is the one action that lets money out past a block the match
   * engine raised — a possible duplicate payment, an invoice over its quote.
   * The person who raises the invoice must not also be the person who waives
   * the objection to it, which is the same maker/checker instinct §13 applies
   * to approvals, expressed as a capability rather than as a rule.
   */
  "flag.waive": "settings.edit",
  "quote.read": "board.view",
  "quote.write": "board.edit",
  "quote.approve": "settings.edit",
  "payment.read": "board.view",
  "payment.write": "board.edit",
  "payment.delete": "data.delete",
  "credit_note.write": "board.edit",
};

/** `scopedDbWithCapability`, with the database bootstrapped first. */
export async function guardFinance(
  request: Request,
  operation: FinanceOperation,
): Promise<{ denied: Response; scope?: never } | { denied?: never; scope: ScopedDatabase }> {
  await ensureDatabase();
  return scopedDbWithCapability(request, FINANCE_CAPABILITIES[operation]);
}

/**
 * THE THREE REFUSALS, IN THE ORDER THEY HAVE TO BE TRIED.
 *
 *   1. `anonymousRefusal` — 401 with `signIn: true`. A session that has ended
 *      is not a workspace that is down: 503 means "retry later", so a browser
 *      and a person both wait for a recovery that will never come.
 *   2. `busyRefusal` — 503 with `retry: true` and `Retry-After`. Supabase's
 *      session pooler enforces a per-project client limit and every route that
 *      touches Postgres fails at once when it is hit. Collapsed into a blanket
 *      503 it reads as a defect in the feature; it is capacity, and the same
 *      click works shortly.
 *   3. The generic 503, with the consequence spelled out.
 *
 * `error.message` is NEVER returned outside development. A raw driver message
 * on a finance route leaks table and column names to anyone who can make a
 * request fail, and tells the reader nothing they can act on.
 */
export function financeUnavailable(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[finance] request failed", error);
  return Response.json(
    {
      error: `${consequence} The invoice tracker is temporarily unavailable.`,
      ...(isDevelopment() ? { detail: messageOf(error) } : {}),
    },
    { status: 503 },
  );
}

export function financeBadRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export function financeNotFound(message = "That record does not exist."): Response {
  return Response.json({ error: message }, { status: 404 });
}

export function financeConflict(message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status: 409 });
}

function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
