/**
 * How this product writes a date. One place, en-GB, everywhere.
 *
 * WHY THIS FILE EXISTS
 *
 * A completion audit counted nine independent date formatters across the
 * portal, four of which asked `Intl` for **en-US** — including the one the
 * maintenance board itself used for every date cell. So the same day was
 * "Nov 24, 2026" on the board, "24/11/2026" in the alternative views,
 * "24 Nov 2026" on a certificate and "24 November 2026" in the expiry banner,
 * in a product sold to UK estates managers. None of that was a decision; it was
 * nine files each picking a locale on their own.
 *
 * WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT
 *
 * The LOCALE is shared and non-negotiable: en-GB. The FORM is not — a board
 * cell, a month heading and an audit timestamp genuinely want different
 * amounts of the same date. So this module offers named forms rather than one
 * function, and a screen picks the form it needs instead of building its own
 * `Intl.DateTimeFormat`. Adding a tenth private formatter is the thing this is
 * here to stop; adding a tenth *form* here is fine.
 *
 * A DATE-ONLY VALUE IS NOT A MOMENT IN TIME
 *
 * `new Date("2026-11-24")` is midnight UTC by specification, so a viewer west
 * of Greenwich renders it as the 23rd. Every function below therefore splits a
 * bare `YYYY-MM-DD` into three numbers and formats it in UTC, so no zone can
 * reach it — while a value carrying a time is a real moment and is rendered in
 * the viewer's own zone, because a job logged at 00:30 on 4 August in London is
 * not "3 August" because UTC says so.
 *
 * That is the rule `formatDate` in views/view-model.ts already documented at
 * length and `expiry-status.ts` arrived at separately. It is now written once.
 *
 * NOTHING HERE TOUCHES WHAT IS SENT TO THE API. This is display only; ISO
 * strings on the wire and in the database are unaffected.
 *
 * THE SHORT MONTH IS OURS, NOT THE RUNTIME'S — MEASURED 2026-09-23.
 *
 * Asking for en-GB is not enough, because the two runtimes this product renders
 * in do not agree about what en-GB says. Measured on the same instant:
 *
 *   · Chromium, and Node on a developer machine: `22 Sept 2026`
 *   · **Vercel's Node runtime in Production: `22 Sep 2026`**
 *
 * CLDR renamed en-GB's abbreviated September from "Sep" to "Sept"; Vercel's
 * bundled ICU predates that. So the SAME function printed two different words
 * depending on which side of the wire it ran on, and the portal renders these
 * labels on BOTH: the server sends the first paint, the browser hydrates it.
 * React refused the mismatch with error #418 ("the server rendered text didn't
 * match the client") on the Contractors and Reports screens of PRODUCTION —
 * found by a browser sweep on 2026-09-23, reproducible on builds going back at
 * least to #90, and invisible to every test in the suite because the suite's
 * Node agrees with the browser.
 *
 * The fix is not another locale argument. A product that has decided how it
 * writes a date cannot leave one of the words to whichever ICU its host happens
 * to ship: `SHORT_MONTHS` below is the answer, and `formatToParts` puts it in
 * the place ICU chose, so the order and the separators stay the locale's while
 * the word stays ours. Only September differed in the runtimes measured — the
 * table removes the whole class of difference rather than that one instance.
 *
 * The word chosen is **"Sep"**, which is what Production has always shown and
 * what this codebase's four other month tables already say, so nothing visible
 * changes: the defect was two answers, not the wrong answer.
 */

/** What every formatter prints when there is no date. */
export const NO_DATE = "—";

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

type Form =
  /* Internal: the month as a number, so `assemble` can index the table in the
     zone the label is rendered in. Never exported as a written form. */
  | "monthNumber"
  | "numeric"
  | "short"
  | "long"
  | "dayMonth"
  | "monthYear"
  | "monthShort"
  | "time"
  | "numericTime"
  | "shortTime";

const OPTIONS: Record<Form, Intl.DateTimeFormatOptions> = {
  monthNumber: { month: "numeric" },
  numeric: { day: "2-digit", month: "2-digit", year: "numeric" },
  short: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
  dayMonth: { day: "numeric", month: "short" },
  monthYear: { month: "long", year: "numeric" },
  monthShort: { month: "short" },
  time: { hour: "2-digit", minute: "2-digit", hour12: false },
  numericTime: {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  },
  shortTime: {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  },
};

/**
 * The abbreviated months, as this product writes them — exported so nothing has
 * to guess and nothing has to ask ICU.
 *
 * "Sep", not CLDR's current en-GB "Sept", and that is a decision rather than an
 * oversight: four hand-written tables in this codebase already say "Sep"
 * (`period-model.ts`, `dashboard-aggregates.ts`, `overview-aggregates.ts`,
 * `finance-landing.tsx`) and Production has always displayed "Sep", because
 * Vercel's ICU says so too. Taking CLDR's newer word here would have changed the
 * wording on board cells, tables and certificates across the estate to fix a
 * mismatch that is about determinism, not vocabulary. One word, everywhere, and
 * `tests/date-month-determinism.test.mjs` holds the five tables level.
 */
export const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Which forms print a month NAME in its short form, and so take the table. */
const SHORT_MONTH_FORMS = new Set<Form>(["short", "dayMonth", "monthShort", "shortTime"]);

/*
 * `Intl.DateTimeFormat` is expensive to construct and these are hot — the board
 * formats one per date cell per render. Cached by form and zone, which is the
 * only thing that varies.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(form: Form, timeZone: string | undefined) {
  const key = `${form}|${timeZone ?? ""}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat("en-GB", {
    ...OPTIONS[form],
    ...(timeZone ? { timeZone } : {}),
  });
  cache.set(key, made);
  return made;
}

export type DateFormatOptions = {
  /** Printed when the value is empty or unreadable. Defaults to an em dash. */
  fallback?: string;
  /**
   * Forces a zone for values that carry a time. Date-only values are always
   * read in UTC whatever this says — see the header.
   */
  timeZone?: string;
};

function render(
  value: string | Date | null | undefined,
  form: Form,
  options: DateFormatOptions = {},
): string {
  const fallback = options.fallback ?? NO_DATE;
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "string") {
    const dayOnly = DAY_ONLY.exec(value.trim());
    if (dayOnly) {
      const [, year, month, day] = dayOnly;
      const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      /* A bare day is read in UTC (see the header), so its month is the one the
         string names — no zone can move it. */
      return assemble(form, "UTC", utc, Number(month) - 1);
    }
  }

  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return fallback;
  return assemble(form, options.timeZone, when);
}

/**
 * The locale's layout with our month word in it.
 *
 * `formatToParts` is what makes this safe: the order, the separators and the
 * time are still exactly what `Intl` produced for en-GB, and only the token ICU
 * labelled `month` is replaced — and only for the forms that print it as a NAME
 * (a `2-digit` month is a number and is left alone). A form with no month part
 * never enters the loop.
 *
 * `monthIndex` is passed for a date-only value, whose month is in the string
 * itself. Otherwise it is read back through `Intl` in the SAME zone the label is
 * being rendered in, so a moment near midnight cannot take the month from one
 * zone and the day from another.
 */
function assemble(form: Form, timeZone: string | undefined, when: Date, monthIndex?: number): string {
  const parts = formatter(form, timeZone).formatToParts(when);
  if (!SHORT_MONTH_FORMS.has(form)) return parts.map((part) => part.value).join("");
  const index =
    monthIndex ??
    Number(formatter("monthNumber", timeZone).format(when)) - 1;
  const name = SHORT_MONTHS[index] ?? null;
  return parts
    .map((part) => (part.type === "month" && name ? name : part.value))
    .join("");
}

/** `24/11/2026` — the default written form, and what a form field echoes. */
export function formatDate(value: string | Date | null | undefined, options?: DateFormatOptions) {
  return render(value, "numeric", options);
}

/** `24 Nov 2026` — for tables and cells where the month must not be a number. */
export function formatShortDate(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "short", options);
}

/** `24 November 2026` — for a sentence a person reads once. */
export function formatLongDate(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "long", options);
}

/** `24 Nov` — for a dense strip where the year is already established. */
export function formatDayMonth(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "dayMonth", options);
}

/** `November 2026` — calendar and chart headings. */
export function formatMonthYear(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "monthYear", options);
}

/** `Nov` — an axis label. */
export function formatMonthShort(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "monthShort", options);
}

/** `14:05` — 24-hour, because that is what a UK work order carries. */
export function formatTimeOfDay(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "time", options);
}

/** `24/11/2026, 14:05` — an audit line or a signed-at stamp. */
export function formatDateTime(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "numericTime", options);
}

/** `24 Nov 2026, 14:05` — the same moment where the month must read as a word. */
export function formatShortDateTime(
  value: string | Date | null | undefined,
  options?: DateFormatOptions,
) {
  return render(value, "shortTime", options);
}
