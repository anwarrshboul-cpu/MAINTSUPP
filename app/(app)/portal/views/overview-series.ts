/**
 * Series maths for the Dashboard Overview cards.
 *
 * These live outside portal-app.tsx because the sparkline and the trade bars
 * were the two places on the Overview where something that was not a
 * measurement still reached the screen, and both needed a rule that can be
 * argued about on its own. Keeping the rule in a plain module means it can be
 * tested against a fixture without booting a client component, and it means
 * the reasoning below sits next to the arithmetic it justifies rather than
 * three hundred lines away in a JSX attribute.
 */

import type { ComplianceItem, MaintenanceRequest } from "../../../lib/types";

const WEEK_MS = 7 * 86_400_000;

/**
 * The compliance card's sparkline.
 *
 * This used to be a literal `[72, 74, 73, 76, 78, 77, 81, 82, 84, 86, 88, …]`
 * — eleven invented percentages drawn as a rising line under a number that was
 * really 26%. A compliance manager reading that card would have seen a year of
 * steady improvement that never happened.
 *
 * There is no status history to replay instead. `compliance_documents` keeps one
 * current `status` per requirement and overwrites it, so "what was our score in
 * April" is recorded nowhere. Nor can the statuses be recomputed for a past
 * date: "Expiring soon" is set by hand, not by a day threshold — the two rows
 * carrying it are 11 and 88 days out — so there is no rule to run backwards.
 *
 * What is recorded is `expiry_date`, and it drives the one status change that
 * happens on its own: a certificate lapsing. So the series starts from today's
 * measured figure — the same count the card prints — and walks it backwards by
 * the certificates that have lapsed since each week. If the Solihull PAT test
 * expired on 20 July, then three weeks ago it was still in date and the count
 * was one higher. Each step is a recorded date passing, not an estimate, and
 * the last reading is today's number by construction, so the line and the
 * headline can never disagree.
 *
 * The limit worth stating: this sees lapses, not gains. A certificate uploaded
 * last week reads as compliant twelve weeks ago too, because nothing in the row
 * says when it arrived. The line is therefore a view of expiry pressure rather
 * than an audit trail, which is the honest extent of what the table stores.
 */
export function complianceTrend(
  items: ComplianceItem[],
  now: number,
  points = 12,
): number[] {
  // A flat zero line rather than an empty array: `Sparkline` swaps a series of
  // one or fewer values for its own decorative default, so returning nothing
  // for an empty workspace would put a fake rising curve back on the card.
  if (!items.length) return Array.from({ length: points }, () => 0);

  const compliantNow = items.filter((item) => item.state === "Compliant").length;

  return Array.from({ length: points }, (_, index) => {
    const at = now - (points - 1 - index) * WEEK_MS;
    // Requirements that were still in date at `at` but have lapsed since.
    const lapsedSince = items.filter((item) => {
      if (!item.expiry) return false;
      const expiry = new Date(item.expiry).getTime();
      return Number.isFinite(expiry) && expiry > at && expiry <= now;
    }).length;
    const compliant = Math.min(compliantNow + lapsedSince, items.length);
    return Math.round((compliant / items.length) * 100);
  });
}

/**
 * Shown when a job carries no trade. The board's `engineer` column is optional
 * and the bulk-imported jobs arrived without it, so a third of the portfolio
 * has nothing recorded.
 *
 * The bars used to key straight off `request.engineer`, which meant those jobs
 * became a bar with an empty label — the tallest one in the panel, wider than
 * every named trade, captioned with nothing at all. Naming the gap costs the
 * same pixels and tells the reader the true thing: the work exists, the trade
 * against it does not. Dropping the rows instead would have been worse, since
 * the panel would then quietly account for ten jobs out of forty-one.
 */
export const UNRECORDED_TRADE = "Trade not recorded";

export type TradeRow = { label: string; value: number; color: string };

/**
 * Jobs grouped by trade, biggest first.
 *
 * Colour is assigned after the sort, not before, so the palette runs in the
 * order the bars are actually drawn. The unrecorded bucket is pinned to the
 * muted slate rather than taking a turn in the rotation — it is the absence of
 * a trade, and giving it the same confident teal as "Electrician" would read as
 * one more category.
 */
export function tradeBreakdown(
  requests: MaintenanceRequest[],
  limit = 6,
): TradeRow[] {
  const palette = ["#12b4a8", "#f26a21", "#f0a91f", "#5c82af", "#6f8190"];
  const counts = new Map<string, number>();
  for (const request of requests) {
    const label = request.engineer?.trim() || UNRECORDED_TRADE;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label, value], index) => ({
      label,
      value,
      color: label === UNRECORDED_TRADE ? "#6f8190" : palette[index % palette.length],
    }));
}
