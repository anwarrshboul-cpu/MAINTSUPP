/**
 * THE REPORTING PERIOD, as a pair of calendar dates.
 *
 * ── WHY THIS IS NOT `period-model.ts` ──────────────────────────────────────
 *
 * `app/(app)/portal/period-model.ts` already owns the DASHBOARD's period
 * vocabulary, and nothing here replaces or competes with it. The two are
 * measuring different things and the difference is not stylistic:
 *
 *   · `period-model` resolves a period to a pair of TIMESTAMPS in LOCAL time,
 *     because it is filtering rows on a screen — "yesterday" has to mean the
 *     reader's yesterday, and its header explains at length why local midnights
 *     are the only honest answer for a dashboard.
 *   · This module resolves a period to a pair of CALENDAR DATES, because an
 *     invoice for March is March. It is a commercial term on a document that
 *     will be read in another country a year from now, and it must not shift by
 *     a day depending on where the browser that generated it was sitting.
 *
 * So this module never reads a clock and never constructs a local `Date`.
 * Every date is a `YYYY-MM-DD` string, all arithmetic is done through
 * `Date.UTC`, and "today" arrives as an argument. That makes every function
 * here a pure function of its inputs — which is what lets the tests assert a
 * month boundary without pinning `TZ` in a child process, the device
 * `workstream-eight-reports-range.test.mjs` needs for the dashboard.
 *
 * ── STORED STAMPS ARE TWO SHAPES, AND `dateOnly` IS WHY THAT IS FINE ───────
 *
 * `maintenance_requests.requested_at` holds naive wall-clock text in two forms
 * — a bare `2026-08-03` on 634 imported rows, `2026-08-09 07:39:18` on 142 —
 * and not one row carries a zone. Parsing those with `new Date()` reads the
 * first as UTC midnight and the second as local, so the same row lands on
 * different days in different zones. `dateOnly` takes the leading ten
 * characters instead. It cannot be wrong about which calendar day a stamp
 * names, because the stamp names one and only one, and no timezone is
 * consulted to find out which.
 *
 * ── WORKING DAYS ARE MONDAY TO FRIDAY, AND NOTHING ELSE ───────────────────
 *
 * There is no bank-holiday calendar anywhere in this product, and inventing one
 * would put a number on a client's SLA report that no agreement supports.
 * `workingDaysInclusive` therefore counts weekdays, the SLA appendix says so in
 * as many words, and a holiday calendar is a change to this file made against a
 * calendar somebody has actually agreed.
 */

import type { IsoDate, ReportPeriod, ReportPeriodPreset } from "./contract";

const DAY_MS = 86_400_000;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The calendar day a stored stamp names, whatever shape it was stored in.
 *
 * See the header. Returns null for anything that does not begin with a
 * plausible ISO date, which is a data-quality finding rather than a guess.
 */
export function dateOnly(value: string | null | undefined): IsoDate | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 10);
  if (!ISO_DATE.test(candidate)) return null;
  // A syntactically valid string can still name 31 February. Round-tripping
  // through UTC is the cheapest exact check: an invalid day rolls forward and
  // the strings no longer match.
  return fromUtcMs(toUtcMs(candidate)) === candidate ? candidate : null;
}

/** Midnight UTC of an ISO date, in milliseconds. */
export function toUtcMs(iso: IsoDate): number {
  const match = ISO_DATE.exec(iso);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** The ISO date at a UTC millisecond. */
export function fromUtcMs(ms: number): IsoDate {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && dateOnly(value) === value;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(iso) + days * DAY_MS);
}

export function addMonths(iso: IsoDate, months: number): IsoDate {
  const match = ISO_DATE.exec(iso);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]) - 1 + months;
  const day = Number(match[3]);
  // Clamp rather than roll: 31 January plus one month is the end of February,
  // not the 3rd of March. A period boundary that rolls silently moves an
  // invoice into a month it does not belong to.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(year, month, Math.min(day, lastDay)));
}

export function startOfMonth(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: IsoDate): IsoDate {
  const match = ISO_DATE.exec(iso);
  if (!match) return "";
  return fromUtcMs(Date.UTC(Number(match[1]), Number(match[2]), 0));
}

export function startOfYear(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 4)}-01-01`;
}

export function endOfYear(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 4)}-12-31`;
}

export function startOfQuarter(iso: IsoDate): IsoDate {
  const month = Number(iso.slice(5, 7));
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return `${iso.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
}

export function endOfQuarter(iso: IsoDate): IsoDate {
  return endOfMonth(addMonths(startOfQuarter(iso), 2));
}

/** Monday, matching `startOfWeek` in `period-model.ts` — one week, one edge. */
export function startOfWeek(iso: IsoDate): IsoDate {
  const weekday = (new Date(toUtcMs(iso)).getUTCDay() + 6) % 7;
  return addDays(iso, -weekday);
}

/** Inclusive day count. A one-day period is 1, never 0. */
export function daysInclusive(start: IsoDate, end: IsoDate): number {
  const span = (toUtcMs(end) - toUtcMs(start)) / DAY_MS;
  return Number.isFinite(span) ? Math.floor(span) + 1 : 0;
}

/**
 * Weekdays between two dates, inclusive of both. Monday to Friday only — see
 * the header for why there is no holiday calendar.
 */
export function workingDaysInclusive(start: IsoDate, end: IsoDate): number {
  const from = toUtcMs(start);
  const to = toUtcMs(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  let count = 0;
  for (let ms = from; ms <= to; ms += DAY_MS) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

/** Whether the range is exactly one whole calendar month. */
export function isWholeCalendarMonth(start: IsoDate, end: IsoDate): boolean {
  return start === startOfMonth(start) && end === endOfMonth(start) && start.slice(0, 7) === end.slice(0, 7);
}

export function isWholeCalendarYear(start: IsoDate, end: IsoDate): boolean {
  return start === startOfYear(start) && end === endOfYear(start) && start.slice(0, 4) === end.slice(0, 4);
}

/** Two closed date ranges overlap. Either end may be open (null). */
export function rangesOverlap(
  aStart: IsoDate | null,
  aEnd: IsoDate | null,
  bStart: IsoDate,
  bEnd: IsoDate,
): boolean {
  if (aStart && aStart > bEnd) return false;
  if (aEnd && aEnd < bStart) return false;
  return true;
}

/** A closed range wholly contains a period — used for the partial-month test. */
export function rangeCovers(
  windowStart: IsoDate | null,
  windowEnd: IsoDate | null,
  periodStart: IsoDate,
  periodEnd: IsoDate,
): boolean {
  if (windowStart && windowStart > periodStart) return false;
  if (windowEnd && windowEnd < periodEnd) return false;
  return true;
}

export function withinPeriod(iso: IsoDate | null, period: { start: IsoDate; end: IsoDate }): boolean {
  return iso !== null && iso >= period.start && iso <= period.end;
}

/* --------------------------------------------------------------- presets -- */

/**
 * What a preset is called on a document.
 *
 * A concrete calendar label wins where the range is one: a filed invoice headed
 * "Last month" is unreadable the moment it is filed, while "March 2026" is
 * still true in a year. Anything that is not a whole calendar month or year
 * keeps the preset's own name, and a hand-entered range is "Custom range" — the
 * exact wording the contract asks for.
 */
export function periodLabel(preset: ReportPeriodPreset, start: IsoDate, end: IsoDate): string {
  if (isWholeCalendarMonth(start, end)) {
    return `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
  }
  if (isWholeCalendarYear(start, end)) return start.slice(0, 4);
  const named: Record<ReportPeriodPreset, string> = {
    today: "Today",
    "this-week": "This week",
    "this-month": "This month",
    "last-month": "Last month",
    "this-quarter": "This quarter",
    "this-year": "This year",
    "last-12-months": "Last 12 months",
    custom: "Custom range",
  };
  return named[preset] ?? "Custom range";
}

export type PeriodResolution =
  | { ok: true; period: ReportPeriod }
  | { ok: false; error: string };

/**
 * A preset (and, for `custom`, a pair of dates) resolved to a `ReportPeriod`.
 *
 * `todayIso` is an argument rather than a clock read, so the same call in a
 * test, on a server and in a snapshot produces the same window. Callers pass
 * the UTC date; see the header.
 *
 * `partialMonth` is TRUE whenever the range is not exactly one calendar month.
 * That includes a quarter and a year, and that is intentional: the flag drives
 * the confirmation the owner asked for before a fee that is quoted per month is
 * charged against a range that is not one, and a quarter is exactly such a
 * range.
 */
export function resolveReportPeriod(input: {
  preset: ReportPeriodPreset;
  todayIso: IsoDate;
  start?: string | null;
  end?: string | null;
}): PeriodResolution {
  const today = dateOnly(input.todayIso);
  if (!today) return { ok: false, error: "Today's date could not be read." };

  let start: IsoDate;
  let end: IsoDate;

  switch (input.preset) {
    case "today":
      start = today;
      end = today;
      break;
    case "this-week":
      start = startOfWeek(today);
      end = addDays(start, 6);
      break;
    case "this-month":
      start = startOfMonth(today);
      end = endOfMonth(today);
      break;
    case "last-month": {
      const previous = addMonths(startOfMonth(today), -1);
      start = startOfMonth(previous);
      end = endOfMonth(previous);
      break;
    }
    case "this-quarter":
      start = startOfQuarter(today);
      end = endOfQuarter(today);
      break;
    case "this-year":
      start = startOfYear(today);
      end = endOfYear(today);
      break;
    case "last-12-months":
      // Twelve whole months ending with the month just gone, not a rolling 365
      // days: a monthly service fee is charged by the month, and a window that
      // ends mid-month would price a month nobody has finished.
      end = endOfMonth(addMonths(startOfMonth(today), -1));
      start = startOfMonth(addMonths(startOfMonth(end), -11));
      break;
    case "custom": {
      const from = dateOnly(input.start);
      const to = dateOnly(input.end);
      if (!from || !to) {
        return { ok: false, error: "A custom range needs a start date and an end date, both as YYYY-MM-DD." };
      }
      if (from > to) {
        return { ok: false, error: "The start date is after the end date." };
      }
      start = from;
      end = to;
      break;
    }
    default:
      return { ok: false, error: "That is not a reporting period." };
  }

  return {
    ok: true,
    period: {
      start,
      end,
      label: periodLabel(input.preset, start, end),
      partialMonth: !isWholeCalendarMonth(start, end),
    },
  };
}

/**
 * The period this one is compared against.
 *
 * A whole calendar month compares with the month before it and a whole calendar
 * year with the year before; anything else compares with the window of the same
 * length that ends the day before this one starts. Nothing is scaled or
 * pro-rated to make the two comparable — an eleven-day period is compared with
 * eleven days, and if the reader wanted a month they should have asked for one.
 */
export function previousComparablePeriod(period: ReportPeriod): ReportPeriod {
  if (isWholeCalendarMonth(period.start, period.end)) {
    const previous = addMonths(period.start, -1);
    const start = startOfMonth(previous);
    const end = endOfMonth(previous);
    return { start, end, label: periodLabel("custom", start, end), partialMonth: false };
  }
  if (isWholeCalendarYear(period.start, period.end)) {
    const start = `${Number(period.start.slice(0, 4)) - 1}-01-01`;
    const end = `${Number(period.start.slice(0, 4)) - 1}-12-31`;
    return { start, end, label: periodLabel("custom", start, end), partialMonth: true };
  }
  const length = daysInclusive(period.start, period.end);
  const end = addDays(period.start, -1);
  const start = addDays(end, -(length - 1));
  return {
    start,
    end,
    label: "Preceding period",
    partialMonth: !isWholeCalendarMonth(start, end),
  };
}
