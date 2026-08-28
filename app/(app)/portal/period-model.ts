/**
 * The reporting period: one vocabulary, one window, one place.
 *
 * WHY THIS IS ITS OWN FILE, AND NOT A NEW ONE
 *
 * `analyticsWindow` in dashboard-meters.ts already answered "what pair of
 * timestamps does the period control mean" for two tokens — a number of days,
 * and "all". Everything downstream — `withinAnalyticsPeriod`, the meter trend
 * buckets, the row scope on every dashboard — is built on that answer. The
 * owner asked for eleven more shapes of period (a named month, a quarter, a
 * single date, a custom range …), and the one thing that must not happen is a
 * second vocabulary growing alongside the first, because then two controls on
 * two screens mean two different things by "this period".
 *
 * So this file *extends* that vocabulary rather than replacing it. Every token
 * `analyticsWindow` understood still resolves here to the identical window,
 * down to the one-day grace on the end that a rolling window carries; the tests
 * assert that equivalence directly. New tokens are added around it.
 *
 * NO REACT, ON PURPOSE
 *
 * Same reason dashboard-meters.ts has none: the period decides every figure on
 * the Spend and reporting screen, so which rows are in it has to be assertable
 * against rows without rendering a page. tests/stage-twentythree-period.test.mjs
 * transpiles and calls this module directly — those are real calls into the
 * shipped code, not a re-implementation that could agree with itself while the
 * screen is wrong.
 *
 * TIME IS LOCAL, DELIBERATELY
 *
 * `maintenance_requests.requested_at` holds naive wall-clock text — 634 rows
 * are a bare `2026-08-03` and 142 are `2026-08-09 07:39:18`, and not one row in
 * the workspace carries a zone. `new Date()` reads those two forms in two
 * different zones: a bare date is parsed as UTC midnight, a date-and-time as
 * local. So a calendar period ("July", "yesterday") built from local midnights
 * and compared against `new Date(value)` is comparing two different clocks, and
 * the rows on the edge of the window fall on the wrong side of it. `parseStamp`
 * reads both forms as the wall-clock they plainly are, which is also what makes
 * a SQL check against `substr(requested_at, 1, 10)` come out equal.
 */

import { analyticsWindow } from "./dashboard-meters";

export const DAY_MS = 86_400_000;

/** How many buckets a sparkline draws. Matches `meterTrendBuckets`. */
export const PERIOD_TREND_BUCKETS = 12;

export interface PeriodWindow {
  /** Inclusive lower bound, ms. `-Infinity` means "no lower bound". */
  start: number;
  /** Inclusive upper bound, ms. `Infinity` means "no upper bound". */
  end: number;
  /** The window in words, built from the same parts the bounds were built from. */
  label: string;
  /**
   * False when the token names a shape no window can be built from — a custom
   * range with one end filled in, a month field left blank. The screen prints
   * `reason` and draws nothing, because a half-specified range is not an empty
   * period and must not be reported as one.
   */
  recognised: boolean;
  /** Why not. Empty when `recognised`. */
  reason: string;
}

/* ── Reading what the database holds ─────────────────────────────────────── */

const NAIVE_STAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

/**
 * A stored timestamp as the wall-clock it is written as.
 *
 * Anything carrying a zone (`Z`, `+01:00`) is handed to `Date` untouched — that
 * string means a specific instant and must not be re-interpreted. Everything
 * else is naive text and is read in the local calendar.
 */
export function parseStamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const trimmed = value.trim();
  const match = NAIVE_STAMP.exec(trimmed);
  if (!match) return new Date(trimmed).getTime();
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ).getTime();
}

/* ── Calendar edges ──────────────────────────────────────────────────────── */

export function startOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * The last millisecond of the day, not the first of the next one.
 *
 * Every bound in this file is inclusive at both ends, so a period can be tested
 * with `stamp >= start && stamp <= end` and two adjacent periods can never both
 * claim the same row.
 */
export function endOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

/**
 * N days later, by the CALENDAR rather than by arithmetic.
 *
 * `ms + n * 86_400_000` is a day only where every day is 24 hours long. On the
 * two days a year a zone changes offset it is 23 or 25, and the difference is
 * not cosmetic: stepping back one `DAY_MS` from midnight after a spring-forward
 * lands at 23:00 on the day BEFORE the one intended, so "Yesterday" became a
 * 59-minute window over the wrong date and captioned itself confidently. Every
 * bound and every bucket edge in this file is a local wall-clock day, so all of
 * them move the DATE and let `Date` hold the time at midnight — which is what
 * `startOfWeek` below has always done.
 */
export function addDays(ms: number, days: number) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Monday. The UK working week, and what "this week" means to the owner. */
export function startOfWeek(ms: number) {
  const date = new Date(startOfDay(ms));
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday);
  return date.getTime();
}

/** `month` may be out of range; `Date` rolls the year, which is what we want. */
function monthStart(year: number, month: number) {
  return new Date(year, month, 1, 0, 0, 0, 0).getTime();
}

function monthEnd(year: number, month: number) {
  return new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
}

/* ── Words ───────────────────────────────────────────────────────────────── */

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A date in words, from the local parts the bounds were built from.
 *
 * Deliberately not `Intl` with a fixed `timeZone`. The bounds above are local
 * midnights; formatting them in a different zone would print a caption that
 * disagrees with the window actually being applied, which is the one thing a
 * caption under a period control must never do.
 */
export function formatStampDate(ms: number) {
  const date = new Date(ms);
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function isMonthStart(ms: number) {
  const date = new Date(ms);
  return date.getDate() === 1 && startOfDay(ms) === ms;
}

function isMonthEnd(ms: number) {
  const date = new Date(ms);
  return ms === monthEnd(date.getFullYear(), date.getMonth());
}

export function windowLabel(start: number, end: number) {
  if (!Number.isFinite(start) && !Number.isFinite(end)) return "All records";
  if (!Number.isFinite(start)) return `Everything up to ${formatStampDate(end)}`;
  if (!Number.isFinite(end)) return `${formatStampDate(start)} onwards`;

  const from = new Date(start);
  const to = new Date(end);
  if (startOfDay(start) === startOfDay(end)) return formatStampDate(start);

  if (isMonthStart(start) && isMonthEnd(end)) {
    if (from.getFullYear() === to.getFullYear()) {
      if (from.getMonth() === to.getMonth()) {
        return `${LONG_MONTHS[from.getMonth()]} ${from.getFullYear()}`;
      }
      if (from.getMonth() === 0 && to.getMonth() === 11) {
        return String(from.getFullYear());
      }
    }
  }
  return `${formatStampDate(start)} – ${formatStampDate(end)}`;
}

/* ── The vocabulary ──────────────────────────────────────────────────────── */

/** What kind of token this is, so a picker knows which extra field to show. */
export type PeriodShape = "preset" | "month" | "year" | "date" | "range";

export function periodShape(period: string): PeriodShape {
  const token = (period ?? "").trim();
  if (token.startsWith("month:") || token === "month") return "month";
  if (token.startsWith("year:") || token === "year") return "year";
  if (token.startsWith("date:") || token === "date") return "date";
  if (token.startsWith("range:") || token === "range") return "range";
  return "preset";
}

/** The `YYYY-MM`, `YYYY` or `YYYY-MM-DD` a token carries, or "". */
export function periodArgument(period: string): string {
  const token = (period ?? "").trim();
  const colon = token.indexOf(":");
  return colon < 0 ? "" : token.slice(colon + 1);
}

/** The two ends of a `range:` token, either of which may be "". */
export function periodRangeParts(period: string): { from: string; to: string } {
  const [from = "", to = ""] = periodArgument(period).split("..");
  return { from, to };
}

export const monthToken = (value: string) => `month:${value}`;
export const yearToken = (value: string) => `year:${value}`;
export const dateToken = (value: string) => `date:${value}`;
export const rangeToken = (from: string, to: string) => `range:${from}..${to}`;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const ISO_YEAR = /^(\d{4})$/;

function unreadable(reason: string): PeriodWindow {
  // Not an empty window. An empty window would be filtered against and would
  // come out as "nothing in this period", which is a claim about the data; this
  // is a claim about the control, and the screen says so instead of drawing.
  return { start: Number.NaN, end: Number.NaN, label: "—", recognised: false, reason };
}

function made(start: number, end: number): PeriodWindow {
  return { start, end, label: windowLabel(start, end), recognised: true, reason: "" };
}

/**
 * The window a period token describes.
 *
 * The legacy tokens are first and are byte-for-byte the old maths:
 *   • "all" — no lower bound. `withinAnalyticsPeriod` short-circuits on that,
 *     so every row is in scope including one whose date would not parse.
 *   • a number of days — `now - days` to `now + one day`. The grace on the end
 *     is why a row raised a few hours into the future (monday's form writes
 *     local dates) does not drop out of its own period.
 *
 * Calendar tokens get exact calendar edges instead, because "July" has a last
 * day and lending it a day of someone else's month would double-count a row.
 * The to-date tokens ("month to date", "year to date") end at the end of today
 * rather than at this instant, so a job raised an hour ago is inside the month
 * it was raised in.
 */
export function resolvePeriod(period: string, now: number): PeriodWindow {
  const token = (period ?? "").trim();
  const clock = new Date(now);
  const year = clock.getFullYear();
  const month = clock.getMonth();
  const today = startOfDay(now);
  const toDate = endOfDay(now);

  if (!token || token === "all") {
    return {
      // From `analyticsWindow`, not a second `-Infinity` written out here.
      start: analyticsWindow("all", now).start,
      // Left open at the top, unlike `analyticsWindow`, which closes it a day
      // out. Nothing downstream of this file divides by the span — `resolveBounds`
      // closes both ends against the rows actually in hand before any chart sees
      // them — and "All records" that quietly drops a row dated next week is not
      // all records. `analyticsWindow` keeps its own closed end for the meters,
      // which do divide.
      end: Number.POSITIVE_INFINITY,
      label: "All records",
      recognised: true,
      reason: "",
    };
  }

  const days = Number(token);
  if (Number.isFinite(days)) {
    // Called, not copied. The rolling windows and the one-day grace on their end
    // are `analyticsWindow`'s and stay `analyticsWindow`'s, so the board's period
    // control keeps meaning exactly what it has always meant.
    const { start, end } = analyticsWindow(token, now);
    return { start, end, label: `Last ${days} days`, recognised: true, reason: "" };
  }

  switch (token) {
    case "today":
      return made(today, endOfDay(today));
    case "yesterday": {
      const start = addDays(today, -1);
      return made(start, endOfDay(start));
    }
    case "week":
      return made(startOfWeek(now), toDate);
    case "week-1": {
      const start = addDays(startOfWeek(now), -7);
      return made(start, endOfDay(addDays(start, 6)));
    }
    case "mtd":
      return made(monthStart(year, month), toDate);
    case "month-1":
      return made(monthStart(year, month - 1), monthEnd(year, month - 1));
    case "quarter": {
      const first = Math.floor(month / 3) * 3;
      return made(monthStart(year, first), toDate);
    }
    case "quarter-1": {
      const first = Math.floor(month / 3) * 3 - 3;
      return made(monthStart(year, first), monthEnd(year, first + 2));
    }
    case "6m":
      return made(monthStart(year, month - 5), toDate);
    case "12m":
      return made(monthStart(year, month - 11), toDate);
    case "ytd":
      return made(monthStart(year, 0), toDate);
    case "year-1":
      return made(monthStart(year - 1, 0), monthEnd(year - 1, 11));
    default:
      break;
  }

  const argument = periodArgument(token).trim();
  const shape = periodShape(token);

  if (shape === "month") {
    const match = ISO_MONTH.exec(argument);
    if (!match) return unreadable("Pick a month to report on.");
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    if (m < 0 || m > 11) return unreadable("That is not a month.");
    return made(monthStart(y, m), monthEnd(y, m));
  }

  if (shape === "year") {
    const match = ISO_YEAR.exec(argument);
    if (!match) return unreadable("Pick a year to report on.");
    const y = Number(match[1]);
    return made(monthStart(y, 0), monthEnd(y, 11));
  }

  if (shape === "date") {
    const stamp = parseStamp(argument);
    if (!ISO_DAY.test(argument) || !Number.isFinite(stamp)) {
      return unreadable("Pick a date to report on.");
    }
    return made(startOfDay(stamp), endOfDay(stamp));
  }

  if (shape === "range") {
    const { from, to } = periodRangeParts(token);
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) {
      return unreadable("Choose both a start and an end date for the range.");
    }
    const first = parseStamp(from);
    const last = parseStamp(to);
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      return unreadable("Choose both a start and an end date for the range.");
    }
    // Entered the wrong way round is a typo, not an empty period. Reading it in
    // the order the two dates fall gives the reader what they meant.
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    return made(startOfDay(start), endOfDay(end));
  }

  return unreadable("That period is not one this report can read.");
}

/** Whether a stored timestamp falls inside the period. */
export function stampWithinPeriod(value: string, period: string, now: number) {
  const window = resolvePeriod(period, now);
  if (!window.recognised) return false;
  // "All records" keeps its old contract: in scope by definition, even when the
  // import left the date unparseable.
  if (!Number.isFinite(window.start)) return true;
  const stamp = parseStamp(value);
  if (!Number.isFinite(stamp)) return false;
  return stamp >= window.start && stamp <= window.end;
}

/* ── The options the picker offers ───────────────────────────────────────── */

export interface PeriodOption {
  value: string;
  label: string;
}

export interface PeriodOptionGroup {
  label: string;
  options: PeriodOption[];
}

/**
 * Everything the owner asked for, grouped the way the question is asked.
 *
 * "A specific month", "A specific date" and "A custom range" are tokens with no
 * argument yet. They resolve to `recognised: false` until the second control is
 * filled in, which is what makes the screen say "choose both dates" instead of
 * silently reporting on nothing.
 */
export const periodOptionGroups: PeriodOptionGroup[] = [
  {
    label: "Day",
    options: [
      { value: "today", label: "Today" },
      { value: "yesterday", label: "Yesterday" },
      { value: "date", label: "A specific date…" },
    ],
  },
  {
    label: "Week",
    options: [
      { value: "week", label: "This week" },
      { value: "week-1", label: "Last week" },
      { value: "7", label: "Last 7 days" },
    ],
  },
  {
    label: "Month",
    options: [
      { value: "mtd", label: "Month to date" },
      { value: "month-1", label: "Last month" },
      { value: "month", label: "A specific month…" },
      { value: "30", label: "Last 30 days" },
    ],
  },
  {
    label: "Quarter",
    options: [
      { value: "quarter", label: "This quarter" },
      { value: "quarter-1", label: "Last quarter" },
      { value: "90", label: "Last 90 days" },
    ],
  },
  {
    label: "Year",
    options: [
      { value: "6m", label: "Last 6 months" },
      { value: "12m", label: "Last 12 months" },
      { value: "ytd", label: "Year to date" },
      { value: "year-1", label: "Last year" },
      { value: "year", label: "A specific year…" },
      { value: "365", label: "Last 365 days" },
    ],
  },
  {
    label: "Anything",
    options: [
      { value: "range", label: "A custom range…" },
      { value: "all", label: "All records" },
    ],
  },
];

/** The flat list, for a caller that wants one `<select>` with no groups. */
export const periodOptions: PeriodOption[] = periodOptionGroups.flatMap(
  (group) => group.options,
);

/**
 * The value the `<select>` should show for a token.
 *
 * `month:2026-07` is chosen from the "A specific month…" row, so the select
 * has to show that row while the month field carries the argument.
 */
export function periodSelectValue(period: string) {
  const shape = periodShape(period);
  return shape === "preset" ? (period || "all") : shape;
}

/* ── Buckets ─────────────────────────────────────────────────────────────── */

export interface PeriodBucket {
  key: string;
  /** "" for a tick that should carry no label — see `periodBuckets`. */
  label: string;
  start: number;
  /** Exclusive, so consecutive buckets cannot both claim one row. */
  end: number;
}

/**
 * The window with its open ends closed against the rows actually in hand.
 *
 * "All records" has no lower bound, and a chart cannot draw from minus
 * infinity. The earliest row in view is the honest substitute — it is where the
 * data starts. With no rows at all there is nothing to plot and the caller is
 * expected to say so rather than draw a year of zeroes, but a usable pair is
 * still returned so nothing divides by zero.
 */
export function resolveBounds(period: string, now: number, stamps: number[]) {
  const window = resolvePeriod(period, now);
  if (!window.recognised) return { start: Number.NaN, end: Number.NaN };
  const usable = stamps.filter((stamp) => Number.isFinite(stamp));
  const start = Number.isFinite(window.start)
    ? window.start
    : usable.length
      ? Math.min(...usable)
      : startOfDay(now) - 365 * DAY_MS;
  const end = Number.isFinite(window.end)
    ? window.end
    : usable.length
      ? Math.max(Math.max(...usable), start + DAY_MS)
      : endOfDay(now);
  return { start, end: Math.max(end, start + 1) };
}

/**
 * Buckets across the period, at a granularity the period earns.
 *
 * A day gets four-hour bars; a fortnight gets days; a quarter gets weeks; a
 * year gets calendar months. The alternative — one fixed granularity — is what
 * the old `monthlySpendSeries` did, and on "Today" it drew six months of empty
 * bars with one thin mark at the end.
 *
 * Labels thin out past eight ticks rather than the bars doing so: every bar is
 * still a real bucket of real rows, only some of the axis text is dropped, so
 * nothing is aggregated away to make the axis fit a phone.
 */
export function rawPeriodBuckets(
  period: string,
  now: number,
  stamps: number[],
): PeriodBucket[] {
  const { start, end } = resolveBounds(period, now, stamps);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const spanDays = (end - start) / DAY_MS;

  const buckets: PeriodBucket[] = [];

  if (spanDays <= 2.05) {
    const step = 4 * 3_600_000;
    for (let edge = startOfDay(start); edge <= end; edge += step) {
      if (edge + step <= start) continue;
      const at = new Date(edge);
      buckets.push({
        key: String(edge),
        label: `${String(at.getHours()).padStart(2, "0")}:00`,
        start: edge,
        end: edge + step,
      });
    }
  } else if (spanDays <= 62) {
    for (let edge = startOfDay(start); edge <= end; edge = addDays(edge, 1)) {
      const at = new Date(edge);
      buckets.push({
        key: String(edge),
        label: `${at.getDate()} ${SHORT_MONTHS[at.getMonth()]}`,
        start: edge,
        end: addDays(edge, 1),
      });
    }
  } else if (spanDays <= 120) {
    for (let edge = startOfWeek(start); edge <= end; edge = addDays(edge, 7)) {
      const at = new Date(edge);
      buckets.push({
        key: String(edge),
        label: `${at.getDate()} ${SHORT_MONTHS[at.getMonth()]}`,
        start: edge,
        end: addDays(edge, 7),
      });
    }
  } else {
    const from = new Date(start);
    const to = new Date(end);
    const months =
      (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth());
    const multiYear = to.getFullYear() !== from.getFullYear();
    for (let index = 0; index <= months; index += 1) {
      const at = new Date(from.getFullYear(), from.getMonth() + index, 1);
      const next = new Date(from.getFullYear(), from.getMonth() + index + 1, 1);
      buckets.push({
        key: `${at.getFullYear()}-${at.getMonth()}`,
        label: multiYear
          ? `${SHORT_MONTHS[at.getMonth()]} ${String(at.getFullYear()).slice(2)}`
          : SHORT_MONTHS[at.getMonth()],
        start: at.getTime(),
        end: next.getTime(),
      });
    }
  }

  if (!buckets.length) return buckets;

  /*
   * Clamp the two outer edges to the window.
   *
   * Daily, weekly and monthly buckets are built on calendar edges, so the first
   * one starts before the period does — "Last quarter" begins on 1 April and
   * its first weekly bucket begins on Monday 30 March. No out-of-period row can
   * get in (the rows were scoped before they reached here), but the axis would
   * carry a label three days older than the window, and a reader comparing the
   * chart with the caption above it would find them disagreeing.
   */
  const first = buckets[0];
  if (first.start < start) {
    const at = new Date(start);
    first.start = start;
    first.label = spanDays <= 2.05
      ? `${String(at.getHours()).padStart(2, "0")}:00`
      : spanDays <= 120
        ? `${at.getDate()} ${SHORT_MONTHS[at.getMonth()]}`
        : first.label;
  }
  const last = buckets[buckets.length - 1];
  if (last.end > end) last.end = end + 1;

  return buckets;
}

/**
 * What a merged bucket calls itself: the span it actually COVERS.
 *
 * It used to be `${first.label}–${last.label}`, which names the last MEMBER's
 * start, not the merged bucket's end. Measured on the Overview at "Last 90
 * days": three weekly buckets beginning 27 May, 1 Jun and 8 Jun merged into a
 * column labelled "27 May–8 Jun" while holding rows through 14 Jun, and the
 * next column began "15 Jun" — so the axis showed six days that appeared to
 * belong to no column, and a job raised on 12 Jun was counted under a label
 * that excludes it.
 *
 * Month-sized members keep first–last: a month's name already denotes the
 * whole month, so "Jan 25–Mar 25" covers exactly what it says. Day- and
 * week-sized members get the real last covered day (`end` is exclusive, so
 * that is `end - 1`). Sub-day members get the exclusive end time, which is how
 * a time range is conventionally written.
 */
function mergedLabel(first: PeriodBucket, last: PeriodBucket) {
  // Month labels ("Aug", "Aug 25") start with a letter; day and hour labels
  // with a digit. Judged from the label rather than the width because the
  // final bucket's `end` is clamped to the window, so its width says nothing
  // about its granularity.
  if (/^[A-Za-z]/.test(last.label)) return `${first.label}–${last.label}`;
  const width = last.end - last.start;
  if (width < DAY_MS && first.label.includes(":")) {
    const boundary = new Date(last.end);
    return `${first.label}–${String(boundary.getHours()).padStart(2, "0")}:00`;
  }
  const end = new Date(last.end - 1);
  return `${first.label}–${end.getDate()} ${SHORT_MONTHS[end.getMonth()]}`;
}

/**
 * Adjacent buckets merged until there are at most `max`, keeping every row.
 *
 * A merged bucket says which span it covers rather than borrowing the label of
 * its first member, so the reader is never shown a quarter labelled as a month.
 */
function mergeBuckets(buckets: PeriodBucket[], max: number): PeriodBucket[] {
  if (buckets.length <= max) return buckets;
  const per = Math.ceil(buckets.length / max);
  const merged: PeriodBucket[] = [];
  for (let index = 0; index < buckets.length; index += per) {
    const group = buckets.slice(index, index + per);
    const first = group[0];
    const last = group[group.length - 1];
    merged.push({
      key: first.key,
      label: group.length === 1 ? first.label : mergedLabel(first, last),
      start: first.start,
      end: last.end,
    });
  }
  return merged;
}

/**
 * How many points a line chart is allowed. "All records" on this workspace
 * spans eleven years, and 132 monthly points is a fringe, not a trend.
 */
const MAX_CHART_BUCKETS = 36;

/**
 * The same buckets with the axis text thinned to what will fit.
 *
 * Every bar stays a real bucket of real rows; only some of the labels are
 * dropped. Aggregating instead would be the easy fix and the wrong one — it
 * changes the shape of the data to make the axis fit a phone. (Past
 * `MAX_CHART_BUCKETS` there is no choice, and then the merged bucket says so
 * in its own label.)
 */
export function periodBuckets(
  period: string,
  now: number,
  stamps: number[],
): PeriodBucket[] {
  const buckets = mergeBuckets(
    rawPeriodBuckets(period, now, stamps),
    MAX_CHART_BUCKETS,
  );
  if (!buckets.length) return buckets;
  // Twelve short labels fit; sixty-two days of them do not.
  const every = buckets.length <= 12 ? 1 : Math.ceil(buckets.length / 8);
  return buckets.map((bucket, index) => ({
    ...bucket,
    // The last tick always keeps its label — it is the one the eye lands on.
    label:
      index === buckets.length - 1 || index % every === 0 ? bucket.label : "",
  }));
}

/**
 * At most `max` columns, for a panel whose columns are table headings.
 *
 * A matrix cannot draw sixty-two of anything. Where the natural granularity
 * gives more columns than the table can hold, adjacent buckets are merged and
 * the merged column says which span it covers — so the reader is told the
 * column is a fortnight rather than being shown a fortnight labelled as a day.
 */
export function periodColumns(
  period: string,
  now: number,
  stamps: number[],
  max = 6,
): PeriodBucket[] {
  return mergeBuckets(rawPeriodBuckets(period, now, stamps), max);
}

/** Which bucket a stamp falls in, or -1. Exported for the insight panels. */
export function bucketFor(buckets: PeriodBucket[], stamp: number) {
  for (let index = 0; index < buckets.length; index += 1) {
    if (stamp >= buckets[index].start && stamp < buckets[index].end) return index;
  }
  // A row inside the period but past the final bucket edge — the last bucket of
  // a to-date period ends at midnight tonight. It belongs to the last bucket,
  // not nowhere.
  if (buckets.length && stamp >= buckets[buckets.length - 1].start) {
    return buckets.length - 1;
  }
  return -1;
}

export interface PeriodSeriesPoint {
  label: string;
  value: number;
}

/**
 * Total cost per bucket, across the period.
 *
 * `cost` is POUNDS — a `real` on `maintenance_requests`, never pence. Summing
 * it and handing it to a money formatter that also takes pounds is the whole
 * contract; the one place that divided by 100 was the bug `formatMoney` in
 * views/view-model.ts was fixed for.
 */
export function periodSpendSeries<T extends { requestedAt: string; cost: number | null }>(
  rows: T[],
  period: string,
  now: number,
): PeriodSeriesPoint[] {
  const stamps = rows.map((row) => parseStamp(row.requestedAt));
  const buckets = periodBuckets(period, now, stamps);
  /*
   * Every caller scopes its rows before calling, and none of them has to.
   * These two are exported for the insight panels, and a panel handed the
   * whole board with a period of "July" drew December's spend on 31 July —
   * silently, because `bucketFor` sweeps anything past the final edge into the
   * last bucket. That sweep is deliberate and stays: a to-date period ends at
   * midnight tonight and a job logged this afternoon belongs on the last bar.
   * It simply has no upper limit, so the period is tested here, where it is
   * known. "All records" keeps its open ends, so this excludes nothing there.
   */
  const window = resolvePeriod(period, now);
  const totals = new Array<number>(buckets.length).fill(0);
  rows.forEach((row, index) => {
    const stamp = stamps[index];
    if (stamp < window.start || stamp > window.end) return;
    const at = bucketFor(buckets, stamp);
    if (at < 0) return;
    totals[at] += row.cost ?? 0;
  });
  return buckets.map((bucket, index) => ({
    label: bucket.label,
    value: totals[index],
  }));
}

/**
 * A sparkline's twelve buckets — across the selected period, not a fixed 84
 * days.
 *
 * The defect this replaces: `requestTrend` in portal-app.tsx built twelve
 * seven-day buckets ending at `Date.now()` and never saw the period at all. On
 * "Last 30 days" eight of the twelve were empty by construction, so every card
 * drew the same flat-then-cliff shape; on "This year", "Last 12 months" or any
 * named month before May the rows were all older than 84 days and every
 * sparkline was a flat line at zero underneath a number in the thousands.
 * dashboard-meters.ts had already fixed exactly this for the board's own
 * meters — see `trendSpan` — and this is that fix, applied to the cards.
 */
export function periodTrend<T extends { requestedAt: string }>(
  rows: T[],
  predicate: (row: T) => boolean,
  period: string,
  now: number,
): number[] {
  const counts = new Array<number>(PERIOD_TREND_BUCKETS).fill(0);
  const stamps = rows.map((row) => parseStamp(row.requestedAt));
  const { start, end } = resolveBounds(period, now, stamps);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return counts;
  const size = Math.max((end - start) / PERIOD_TREND_BUCKETS, 1);
  rows.forEach((row, index) => {
    if (!predicate(row)) return;
    const stamp = stamps[index];
    if (!Number.isFinite(stamp)) return;
    // The clamp below places an out-of-window row on the first or last bar
    // rather than dropping it, so the window has to be tested before it.
    if (stamp < start || stamp > end) return;
    const at = Math.min(
      PERIOD_TREND_BUCKETS - 1,
      Math.max(0, Math.floor((stamp - start) / size)),
    );
    counts[at] += 1;
  });
  return counts;
}

/* ── Sorting ─────────────────────────────────────────────────────────────── */

export type SortDirection = "desc" | "asc";

/**
 * Highest first by default, because "Top sites by spend" is a question about
 * the top. Reversing it answers a different and equally real question — which
 * sites are cheap to run — so it is a control, not a hidden default.
 */
export function sortBySpend<T extends { value: number }>(
  items: T[],
  direction: SortDirection,
): T[] {
  const sorted = [...items].sort((left, right) => right.value - left.value);
  return direction === "asc" ? sorted.reverse() : sorted;
}
