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

/* ===========================================================================
 * THE FIVE JOB METERS ON THE OVERVIEW — 2026-09-04.
 *
 * The owner asked for five Main Table columns to be readable as distributions
 * without opening the board: Tier Level, Engineer Required, Priority, Label and
 * Status.
 *
 * WHY THIS IS ARITHMETIC IN A PLAIN MODULE AND NOT JSX.
 *
 * The same reason `tradeBreakdown` above is. A meter is a claim about every job
 * in the window, and the way it goes wrong is silent: a value that does not
 * match a configured option gets dropped, the bars still add to a full bar, and
 * nothing on screen says that four jobs went missing. So the bucketing is here,
 * where a fixture can be fed to it, and the rule below is the one that matters:
 *
 *   NOTHING IS EVER DROPPED. Every job lands in exactly one segment. A value
 *   the option set does not know about keeps its own segment in a neutral
 *   colour rather than disappearing, and a blank one joins an explicit
 *   "Not recorded" segment. `segments` therefore always sums to `total`, which
 *   is asserted rather than hoped for.
 *
 * WHY THE COLOURS COME FROM THE DATABASE.
 *
 * The board paints these five columns with the option colours an administrator
 * configured — Tier 1 red, Tier 2 amber, Tier 3 blue, and so on. A meter that
 * invented its own palette would be the same data in different colours one
 * click away, which is exactly how a reader learns not to trust either. So the
 * caller passes the configured options in and the segment takes its colour from
 * them; where an option is unknown the segment is muted slate, the same
 * treatment `tradeBreakdown` gives the unrecorded bucket.
 * ======================================================================== */

/** The five Main Table columns the Overview summarises, in the board's order. */
export const JOB_METER_COLUMNS = [
  { key: "tier", title: "Tier Level", optionSetKey: "tier_level" },
  { key: "engineer", title: "Engineer Required", optionSetKey: "engineer_required" },
  { key: "priority", title: "Priority", optionSetKey: "priority" },
  { key: "label", title: "Label", optionSetKey: "maintenance_label" },
  { key: "status", title: "Status", optionSetKey: "maintenance_status" },
] as const;

export type JobMeterKey = (typeof JOB_METER_COLUMNS)[number]["key"];

/** The muted slate used for absence, matching `tradeBreakdown`'s bucket. */
export const METER_UNRECORDED_COLOR = "#6f8190";
/** A value the option set does not know about. Distinct from absence. */
export const METER_UNKNOWN_COLOR = "#8a94a6";
export const METER_UNRECORDED_LABEL = "Not recorded";

/**
 * ONE JOB'S VALUE IN ONE OF THE FIVE COLUMNS.
 *
 * This mapping is not obvious from the field names and getting it wrong would
 * make a meter lie confidently, so it is written down once here and imported by
 * everything that needs it — including the board's own column summary, which
 * previously carried its own copy.
 *
 * The one that surprises people: the board column titled "Label" reads
 * `request.category`. There is no `label` field on a maintenance request; the
 * column key and the storage column were named at different times.
 */
export function jobColumnValue(
  request: MaintenanceRequest,
  key: JobMeterKey,
): unknown {
  switch (key) {
    case "tier":
      return request.tier;
    case "engineer":
      return request.engineer;
    case "priority":
      return request.priority;
    case "label":
      // Not a typo. See the note above.
      return request.category;
    case "status":
      return request.status;
  }
}

/** One configured option, in the shape `/api/options` returns it. */
export interface MeterOption {
  value: string;
  label: string;
  colourHex: string;
  textColour: string;
  position: number;
}

export interface JobMeterSegment {
  /** The raw stored value, or "" for the not-recorded bucket. */
  value: string;
  label: string;
  count: number;
  /** Of the whole window, 0..1. Segments sum to 1 when `total` is non-zero. */
  share: number;
  color: string;
  textColor: string;
  /** True when the option set has no entry for this value. */
  unknown: boolean;
}

export interface JobMeter {
  key: JobMeterKey;
  title: string;
  total: number;
  recorded: number;
  unrecorded: number;
  segments: JobMeterSegment[];
}

/**
 * The values that mean "nobody answered", folded together.
 *
 * Deliberately the same set `tradeLabel` uses, plus the numeric zero a Tier
 * column carries when it has never been set. A tier of 0 is not "Tier 0" — the
 * option set starts at 1 — it is the default an untouched row was created with.
 */
function meterValueText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? String(raw) : "";
  }
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text || UNUSABLE_TRADE_VALUES.has(text.toLowerCase())) return "";
  return text;
}

/**
 * Build all five meters from one pass over the jobs already scoped to the
 * portfolio and the period.
 *
 * `optionsByKey` may be missing or partial — the Overview can paint before the
 * option sets have loaded, and a meter with no configured colours is still a
 * correct meter. In that case every segment falls back to the muted palette and
 * keeps its raw value as its label, which is honest: it shows what is stored.
 */
export function buildJobMeters(
  requests: MaintenanceRequest[],
  optionsByKey: Partial<Record<JobMeterKey, readonly MeterOption[]>> = {},
): JobMeter[] {
  return JOB_METER_COLUMNS.map(({ key, title }) => {
    const options = optionsByKey[key] ?? [];
    const byValue = new Map<string, MeterOption>();
    /*
     * THE TIER BRIDGE. `maintenance_requests.tier` stores the bare number 1-4 —
     * the SLA rules key on it — while the `tier_level` option set stores
     * "Tier 1".."Tier 4" as the option VALUES. Verified against the live
     * /api/options on 2026-09-04.
     *
     * Without this the meter still counted correctly, and every tier segment
     * drew grey and captioned itself "3" — right number, anonymous label, wrong
     * colour. live-board.tsx calls the same mapping "the one bridge" and does
     * it with `tierCellValue` over `tierDigits` from board-sort.ts.
     *
     * This is a deliberate second copy of that one-line rule rather than an
     * import, and the reason is module resolution, not taste: this file must
     * stay importable by `node --test`, which resolves no extensionless
     * specifiers, and board-sort.ts reaches board-ordering and board-format
     * behind them. A test pins the two spellings together so they cannot drift.
     */
    const byTierDigits = new Map<string, MeterOption>();
    for (const option of options) {
      byValue.set(option.value.trim().toLowerCase(), option);
      if (key === "tier") {
        const digits = option.value.replace(/\D+/g, "");
        if (digits) byTierDigits.set(digits, option);
      }
    }
    const optionFor = (raw: string) =>
      byValue.get(raw.toLowerCase()) ??
      (key === "tier" ? byTierDigits.get(raw.replace(/\D+/g, "")) : undefined);

    const counts = new Map<string, number>();
    let unrecorded = 0;
    for (const request of requests) {
      const text = meterValueText(jobColumnValue(request, key));
      if (!text) {
        unrecorded += 1;
        continue;
      }
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }

    const total = requests.length;
    const recorded = total - unrecorded;
    const denominator = total || 1;

    const segments: JobMeterSegment[] = Array.from(counts)
      .map(([value, count]) => {
        const option = optionFor(value);
        return {
          value,
          label: option?.label ?? value,
          count,
          share: count / denominator,
          color: option?.colourHex ?? METER_UNKNOWN_COLOR,
          textColor: option?.textColour ?? "#ffffff",
          unknown: !option,
        };
      })
      /*
       * Biggest first, and ties broken by the administrator's own ordering
       * rather than by insertion order — so two labels on three jobs each keep
       * the sequence they have on the board instead of the sequence the rows
       * happened to arrive in.
       */
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        const leftPos = optionFor(left.value)?.position ?? Number.MAX_SAFE_INTEGER;
        const rightPos = optionFor(right.value)?.position ?? Number.MAX_SAFE_INTEGER;
        if (leftPos !== rightPos) return leftPos - rightPos;
        return left.label.localeCompare(right.label);
      });

    // Absence goes last and is always named when present — never merged into a
    // real category and never silently omitted.
    if (unrecorded > 0) {
      segments.push({
        value: "",
        label: METER_UNRECORDED_LABEL,
        count: unrecorded,
        share: unrecorded / denominator,
        color: METER_UNRECORDED_COLOR,
        textColor: "#ffffff",
        unknown: false,
      });
    }

    return { key, title, total, recorded, unrecorded, segments };
  });
}
