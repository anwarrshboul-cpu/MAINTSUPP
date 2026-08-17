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

/**
 * The strings that are the wreckage of a value rather than a value.
 *
 * "[object Object]" was appearing on the Overview as a trade — a labelled bar,
 * in the palette, counted alongside "Electrician" — and it is not a trade, it
 * is what `String(x)` prints when `x` is a plain object. The object never
 * reaches this function: by the time the panel reads it, `engineer` is a `text`
 * column in `portal.maintenance_requests` holding those exact sixteen
 * characters, so nothing here can look inside it. What can be established is
 * where it came from and what it stood for, and both are on record.
 *
 * The two rows are `external_id` 1637964658 and 1670571226, `source = "monday
 * import"`. On the monday board, "Engineer Required" is the status column
 * `single_select`, and the API returns a status cell as a pair: `text`, the
 * label, and `value`, a JSON object `{"index":…,"post_id":…,"changed_at":…}`.
 * Exactly two of the board's 744 items have `text: null` with `value` present,
 * and they are those two — the legacy importer fell through the empty `text` to
 * the parsed `value` and stringified the object. The same fault, from the same
 * fallback, put "[object Object]" into `priority` on 22 rows (there are
 * likewise exactly 22 items with a blank `text` on the Priority status column)
 * and into `category` on 1. Three columns, 25 rows, one line of legacy code.
 *
 * So what did it MEAN? `index: 5` on a four-label column. `engineer_required`
 * in db/monday-board-spec.ts declares four labels at indices 0-3, and the note
 * on `priority` in that same file records what index 5 is: monday's blank "no
 * value" chip, which monday itself hides from the dropdown and renders as an
 * empty cell. The source value was an unset column. "Trade not recorded" is
 * therefore not a shrug at an unreadable string — it is the correct reading of
 * what the board actually held, and it puts these two jobs in the bucket monday
 * would have put them in.
 *
 * `"undefined"` and `"null"` are here for the same reason and not because they
 * have been seen: they are the other two things a template literal or a bare
 * `String()` produces from an absent value, and a bar captioned "undefined"
 * would be the identical defect wearing a different word.
 *
 * Matched case-insensitively, since `String(Object.create(null))` and a
 * hand-typed variant differ only in case. Compare `chipLabel` in
 * ../fix-tracker.tsx, which makes the same judgement for the job card's
 * priority chip; the two are deliberately separate because they answer
 * differently — that one omits the chip, this one must still count the job.
 */
const UNUSABLE_TRADE_VALUES = new Set([
  "[object object]",
  "undefined",
  "null",
]);

/**
 * The bar's caption for one job.
 *
 * Non-strings are folded in rather than trusted, and that is a real repair, not
 * belt-and-braces: the previous expression was `request.engineer?.trim()`, and
 * `?.` guards `null` and `undefined` only. Had the field ever arrived holding a
 * live object — which is precisely what the importer was mishandling upstream —
 * `.trim` would have been `undefined` and the whole Overview would have thrown
 * on render rather than drawn one wrong bar.
 */
export function tradeLabel(value: unknown): string {
  if (typeof value !== "string") return UNRECORDED_TRADE;
  const text = value.trim();
  if (!text || UNUSABLE_TRADE_VALUES.has(text.toLowerCase())) {
    return UNRECORDED_TRADE;
  }
  return text;
}

export type TradeRow = { label: string; value: number; color: string };

/**
 * Jobs grouped by trade, biggest first.
 *
 * Colour is assigned after the sort, not before, so the palette runs in the
 * order the bars are actually drawn. The unrecorded bucket is pinned to the
 * muted slate rather than taking a turn in the rotation — it is the absence of
 * a trade, and giving it the same confident teal as "Electrician" would read as
 * one more category.
 *
 * `tradeLabel` decides what each job is called; see the note above it for why
 * two of this workspace's 776 jobs move out of a bar of their own and into the
 * unrecorded bucket. No other job changes bucket: every remaining value in the
 * column is an ordinary label that trims to itself, so the totals below are the
 * same arithmetic on the same rows.
 */
export function tradeBreakdown(
  requests: MaintenanceRequest[],
  limit = 6,
): TradeRow[] {
  const palette = ["#12b4a8", "#f26a21", "#f0a91f", "#5c82af", "#6f8190"];
  const counts = new Map<string, number>();
  for (const request of requests) {
    const label = tradeLabel(request.engineer);
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
