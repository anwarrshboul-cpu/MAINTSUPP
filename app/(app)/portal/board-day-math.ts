/**
 * Moving a calendar day, in calendar terms.
 *
 * A LEAF, DELIBERATELY. It imports nothing, which is what lets
 * `tests/board-date-picker.test.mjs` load it and CALL it rather than assert its
 * spelling — the same reason `board-row-name.ts` is a leaf and says so in its
 * own header. Date arithmetic is exactly the kind of code that should be proved
 * against February, leap years and year ends rather than eyeballed.
 *
 * EVERYTHING IS `YYYY-MM-DD` IN, `YYYY-MM-DD` OUT. No instant is ever produced
 * or returned. `Date.UTC` is used only as a calendar calculator — it is the one
 * arithmetic in the standard library that cannot be pulled a day sideways by
 * the reader's timezone, which a local-time `new Date(y, m, d)` can across a
 * daylight-saving boundary.
 */

/** The day `amount` days away. Negative goes back. */
export function shiftBoardCalendarDay(value: string, amount: number) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return formatUtcDay(shifted);
}

/**
 * The day `amount` months away, CLAMPED to the target month's length.
 *
 * "A month after 31 January" is 28 February, not 3 March — a reader stepping a
 * calendar means the same day number where the month is long enough to have
 * one, and the last day where it is not. Unclamped `Date.UTC` rolls over into
 * the following month, which is how a picker skips February entirely.
 */
export function shiftBoardCalendarDayByMonth(value: string, amount: number) {
  const [year, month, day] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + amount, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return formatUtcDay(
    new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)),
    ),
  );
}

/** The first of the month `amount` years away, keeping the month. */
export function shiftBoardCalendarYear(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  return formatUtcDay(new Date(Date.UTC(year + amount, month - 1, 1)));
}

/** The first of the month a day belongs to. */
export function boardCalendarMonthOf(value: string) {
  return `${value.slice(0, 7)}-01`;
}

function formatUtcDay(date: Date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
