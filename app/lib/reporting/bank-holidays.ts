/**
 * BANK HOLIDAYS — data the product is handed, never a calendar it derives.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ──────────────────────────────────────────
 *
 * `period.ts` used to record, in its own header, that there was no bank-holiday
 * calendar anywhere in this product and that inventing one would put a number
 * on a client's SLA report that no agreement supports. That was the right call
 * for as long as it held. On 5 September 2026 the owner agreed the calendar —
 * Module 4 §4.2 requires it in terms, "excluding weekends and England & Wales
 * bank holidays … maintain a `bank_holidays` table; do not compute them in
 * code" — and `db/init.ts` now creates and seeds that table. This module is the
 * bridge between the rows in it and the arithmetic that spends them.
 *
 * ── NOT ONE DATE IS WRITTEN HERE ───────────────────────────────────────────
 *
 * There is no holiday list in this file and there is deliberately no function
 * that computes one. The English calendar carries substitute days, a spring
 * bank holiday that has twice been moved by statute, and one-off royal
 * holidays; an algorithm that derives it is wrong in exactly the years a reader
 * remembers, and it is wrong silently, on a document a client is judged by.
 * The dates live in `bank_holidays` — transcribed from GOV.UK, one row each,
 * substitute days named as substitutes — and extending them is a data edit
 * rather than a deploy. Seeding them there and reading them here also means
 * there is ONE answer to "is the 28th a working day" for the whole product.
 *
 * ── AN ABSENT CALENDAR IS WEEKDAYS, NOT A GUESS ────────────────────────────
 *
 * Every function here takes the calendar as an argument and treats "no
 * calendar" as "no holidays". That is not a degraded fallback: it returns
 * exactly the weekday count this product returned before the table existed,
 * which is a figure somebody can reconcile, where a half-populated calendar
 * invented on the spot is not. A caller that wants holidays subtracted has to
 * have read the table, and that is the point.
 *
 * ── PURE, AND IT HAS TO STAY THAT WAY ──────────────────────────────────────
 *
 * No database handle, no clock, no `new Date()` on a local zone. Reading the
 * rows is the caller's job — `SELECT holiday_date FROM bank_holidays WHERE
 * jurisdiction = ?` — and `bankHolidayCalendar` turns whatever comes back into
 * the set. That is what lets the working-day arithmetic be tested against a
 * hand-written Christmas without a database anywhere near it.
 */

import type { IsoDate } from "./contract";
import { toUtcMs } from "./period";

/*
 * The arithmetic lives in `period.ts` and is re-exported rather than copied.
 *
 * `period.ts` already owns every calendar-date primitive in the reporting tree
 * — `toUtcMs`, `fromUtcMs`, the ISO shape — and a second day-stepping loop over
 * here would be a second place for an off-by-one to live. It is surfaced from
 * this module as well because this is where a reader looking for "working days
 * minus bank holidays" will come, and sending them to two imports to ask one
 * question is how one of the two gets forgotten.
 */
export { workingDaysInclusive } from "./period";

/**
 * A resolved calendar: the set of dates that are NOT working days, as
 * `YYYY-MM-DD` strings.
 *
 * A `Set` of strings rather than a list of rows, because the only question ever
 * asked of it is membership, once per day of a range, and because comparing
 * `YYYY-MM-DD` text needs no timezone to be correct.
 */
export type BankHolidayCalendar = ReadonlySet<IsoDate>;

/**
 * A row of `bank_holidays`, in either shape it arrives in.
 *
 * The raw D1/Postgres path returns `holiday_date`; drizzle returns
 * `holidayDate`. Both are accepted because both are real — the seeder writes
 * through raw SQL and the read paths do not all agree — and a builder that
 * silently produced an EMPTY calendar from the wrong key would turn every
 * holiday back into a working day with nothing on screen to say so.
 */
export interface BankHolidayRow {
  holiday_date?: string | null;
  holidayDate?: string | null;
  jurisdiction?: string | null;
  title?: string | null;
}

/** What the table is seeded with, and the only jurisdiction the report claims. */
export const DEFAULT_JURISDICTION = "england-and-wales";

/** No calendar. Shared so callers do not each allocate their own empty set. */
export const EMPTY_BANK_HOLIDAY_CALENDAR: BankHolidayCalendar = new Set<IsoDate>();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function rowDate(row: BankHolidayRow): string | null {
  const value = row.holiday_date ?? row.holidayDate ?? null;
  if (typeof value !== "string") return null;
  // The stamp may carry a time if somebody stored one; the leading ten
  // characters name the calendar day and no zone is consulted to find out
  // which — the same rule `dateOnly` applies in `period.ts`.
  const candidate = value.trim().slice(0, 10);
  return ISO_DATE.test(candidate) ? candidate : null;
}

/**
 * The set of holiday dates, from rows read out of `bank_holidays`.
 *
 * `jurisdiction` filters, and defaults to England & Wales because that is what
 * the agreement is written against. Passing `null` takes every row, which is
 * what a caller that has already filtered in SQL should do — filtering twice on
 * a value one of the two spells differently is how a calendar quietly empties.
 *
 * A row whose date is unreadable is SKIPPED rather than guessed at. It is one
 * fewer holiday, which makes a working-day count too high by a day — visible,
 * arguable, and correctable — where a guessed date is wrong in a way nobody can
 * see.
 */
export function bankHolidayCalendar(
  rows: readonly BankHolidayRow[] | null | undefined,
  jurisdiction: string | null = DEFAULT_JURISDICTION,
): BankHolidayCalendar {
  if (!rows || rows.length === 0) return EMPTY_BANK_HOLIDAY_CALENDAR;
  const wanted = jurisdiction === null ? null : jurisdiction.trim().toLowerCase();
  const dates = new Set<IsoDate>();
  for (const row of rows) {
    if (wanted !== null) {
      const rowJurisdiction = (row.jurisdiction ?? DEFAULT_JURISDICTION).trim().toLowerCase();
      if (rowJurisdiction !== wanted) continue;
    }
    const date = rowDate(row);
    if (date) dates.add(date);
  }
  return dates;
}

/** Whether a date is in the calendar. A missing calendar holds nothing. */
export function isBankHoliday(
  iso: IsoDate,
  calendar?: BankHolidayCalendar | null,
): boolean {
  return Boolean(calendar && calendar.has(iso));
}

/**
 * Whether a date is a working day: Monday to Friday, and not a bank holiday.
 *
 * The weekday half is read in UTC through `toUtcMs`, for the reason `period.ts`
 * gives at length — an invoice for March is March, and which day of the week
 * the 3rd was must not depend on where the browser that asked was sitting.
 */
export function isWorkingDay(
  iso: IsoDate,
  calendar?: BankHolidayCalendar | null,
): boolean {
  const ms = toUtcMs(iso);
  if (!Number.isFinite(ms)) return false;
  const day = new Date(ms).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !isBankHoliday(iso, calendar);
}
