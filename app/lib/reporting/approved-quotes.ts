/**
 * THE APPROVED QUOTE ON A JOB, IN PENCE — what the maintenance report puts
 * beside the job's final cost.
 *
 * It used to be read from `quotations.amount`, the legacy REAL, through
 * `poundsToPence`. Nothing has written money to that column since Module 5:
 * the finance repository stores a quote's price as `net_pence` / `vat_pence` /
 * `gross_pence` and writes `amount` as ZERO (see `createQuote`). So every
 * quote raised through the finance module would have reported as £0.00 —
 * latent only because Production and Staging hold no quotations yet. The owner
 * approved moving the last float money read to integer pence (2026-09-22).
 *
 * WHICH FIGURE: net first, gross only when no net was recorded — the rule the
 * finance module itself uses to compare a quote with an invoice
 * (`comparableAmount` in `app/lib/finance/rules.ts`), so the report and the
 * ledger never disagree about what a quote was for.
 *
 * WHICH QUOTE: the most recently APPROVED one on the job, as before. A quote
 * awaiting approval is a price somebody sent, not a commitment. If that latest
 * approved quote carries no figure at all, the job has no approved quote
 * value — null, never a borrowed older figure and never a zero.
 */
import { comparableAmount } from "../finance/rules";

export type ApprovedQuoteRow = {
  requestId: string;
  netPence: number | null;
  grossPence: number | null;
  approvedAt: string | null;
};

export function approvedQuotePenceByJob(rows: readonly ApprovedQuoteRow[]): Map<string, number> {
  const latest = new Map<string, ApprovedQuoteRow>();
  for (const row of rows) {
    if (!row.approvedAt) continue;
    const held = latest.get(row.requestId);
    if (!held || (held.approvedAt ?? "") < row.approvedAt) latest.set(row.requestId, row);
  }
  const quotes = new Map<string, number>();
  for (const [requestId, row] of latest) {
    const agreed = comparableAmount(row.netPence, row.grossPence);
    if (agreed) quotes.set(requestId, agreed.amount);
  }
  return quotes;
}
