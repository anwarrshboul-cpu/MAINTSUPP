/**
 * What a Timeline cell's range MEANS — start, end, and how long that is.
 *
 * WHAT THIS CLOSES. The Timeline column renders `08-20 → 08-23` and nothing
 * else: no year, no month name and, above all, no length. Reading a duration
 * off that strip is arithmetic the reader has to do in their head, across a
 * month boundary, from a value that does not even say which year it is in.
 * Monday answers it on hover, and so does this.
 *
 * PURE, AND HERE RATHER THAN IN THE COMPONENT. Same reasoning as the rest of
 * `board-format.ts`: a duration has a right answer, and a test can hand this
 * two strings and assert the sentence. It is a separate file because
 * `board-format.ts` is at 397 lines against an enforced ceiling of 400, and the
 * reasoning below is worth more than the lines it costs.
 *
 * INCLUSIVE, WHICH IS WHAT A WORK ORDER MEANS. A job that starts and finishes
 * on the 20th took a day, not none; a job from the 20th to the 23rd occupies
 * four days of somebody's diary, not three. That is also what monday shows, and
 * the number a coordinator is checking against an engineer's day rate. The
 * alternative — a difference — reads "0 days" for the single-day case, which is
 * the specific nonsense this exists to avoid.
 *
 * THE DATES ARE NOT RE-INTERPRETED. Both values go through `dateInputValue`,
 * the same reader every other board date cell uses, and are rendered by
 * `formatShortDate`, the same en-GB form. This tells the reader what the cell
 * already holds; it never invents a date, and it never adjusts one to make a
 * nicer sentence.
 */

import { formatShortDate } from "../../lib/format-date";
import { dateInputValue } from "./board-format";

export type TimelineSummary = {
  /** `24 Nov 2026`, or null when there is no start date. */
  startLabel: string | null;
  /** `27 Nov 2026`, or null when there is no end date. */
  endLabel: string | null;
  /** `4 days`, `1 day`, or null when a duration cannot be stated. */
  durationLabel: string | null;
  /** The whole number of days the range covers, inclusive. Null when unknown. */
  days: number | null;
  /**
   * What is missing, or what is wrong, in the words the tooltip shows. Null
   * when the range is complete and well ordered.
   *
   * NEVER "NaN", and never a date this did not receive: an unreadable value is
   * reported as a missing one, because that is what it is to the reader.
   */
  note: string | null;
  /** True when there is nothing at all to describe. */
  empty: boolean;
};

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` as a UTC epoch, or NaN. Never a local midnight — see format-date.ts. */
function utcDay(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function timelineSummary(
  start: string | null | undefined,
  end: string | null | undefined,
): TimelineSummary {
  const from = dateInputValue(start);
  const to = dateInputValue(end);

  if (!from && !to) {
    return {
      startLabel: null,
      endLabel: null,
      durationLabel: null,
      days: null,
      note: "No dates set yet.",
      empty: true,
    };
  }

  const startLabel = from ? formatShortDate(from) : null;
  const endLabel = to ? formatShortDate(to) : null;

  if (!from || !to) {
    return {
      startLabel,
      endLabel,
      durationLabel: null,
      days: null,
      // Says which half is missing, rather than a blank where a number goes.
      note: from ? "No end date set, so there is no duration yet." : "No start date set, so there is no duration yet.",
      empty: false,
    };
  }

  const span = utcDay(to) - utcDay(from);
  if (!Number.isFinite(span)) {
    return {
      startLabel,
      endLabel,
      durationLabel: null,
      days: null,
      note: "One of these dates cannot be read.",
      empty: false,
    };
  }

  /*
   * AN END BEFORE ITS START IS REPORTED, NOT ARITHMETIC.
   *
   * The cell's own editor refuses to save one, but the column can still hold
   * it: `preserveStartOnClear` writes the two halves independently, the monday
   * import wrote whatever monday held, and `due_at` is set by three other
   * screens that know nothing about the start. Showing "-2 days" would dress a
   * data problem up as a measurement.
   */
  if (span < 0) {
    return {
      startLabel,
      endLabel,
      durationLabel: null,
      days: null,
      note: "The end date is before the start date.",
      empty: false,
    };
  }

  const days = Math.round(span / DAY_MS) + 1;
  return {
    startLabel,
    endLabel,
    durationLabel: `${days} ${days === 1 ? "day" : "days"}`,
    days,
    note: null,
    empty: false,
  };
}

/**
 * The whole thing as one sentence, for a `title` attribute and for the phone.
 *
 * A tooltip is a picture; this is the same facts as text, so a screen reader,
 * a native hover and the mobile sheet all say what the popover says. Kept here
 * rather than in the component so the two can never drift.
 */
export function timelineSummaryText(summary: TimelineSummary): string {
  if (summary.empty) return summary.note ?? "No dates set yet.";
  const parts: string[] = [];
  parts.push(summary.startLabel ? `Starts ${summary.startLabel}` : "No start date");
  parts.push(summary.endLabel ? `ends ${summary.endLabel}` : "no end date");
  if (summary.durationLabel) parts.push(summary.durationLabel);
  const sentence = `${parts.join(", ")}.`;
  return summary.note ? `${sentence} ${summary.note}` : sentence;
}
