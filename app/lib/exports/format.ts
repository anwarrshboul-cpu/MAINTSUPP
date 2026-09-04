/**
 * How a payload figure becomes a string, once, for every format.
 *
 * The contract is explicit that nothing crossing it is pre-formatted: money is
 * integer pence, percentages are whole numbers, dates are ISO. That is right —
 * a payload carrying "£1,690.00" cannot be summed by the Excel exporter — and
 * it leaves exactly one job that every renderer still has to do identically.
 * This file is that job.
 *
 * If the preview rounds a half-penny up and the PDF rounds it down, the owner
 * has four documents that disagree by a penny and no way to tell which is the
 * invoice. So there is one `formatMoney`, one `formatIsoDate`, one
 * `formatPercent`, and the renderers are not allowed their own.
 *
 * DATES ARE EUROPE/LONDON, AND ONLY INSTANTS NEED TO BE
 *
 * An `IsoDate` is a calendar date with no time and no zone — 2026-03-31 is the
 * 31st of March in every zone, and formatting it through a zone-aware API is
 * how a bare date becomes the 30th for a reader west of Greenwich. It is split
 * on the hyphens instead. An `IsoInstant` genuinely is a point in time and IS
 * converted, to Europe/London, because "approved at 00:30 on 1 April" and
 * "approved at 23:30 on 31 March" can fall on opposite sides of a reporting
 * period boundary and the second one is what the owner's clock said.
 */

import type { IsoDate, IsoInstant, Pence } from "../reporting/contract";

/* ── Money ───────────────────────────────────────────────────────────────── */

/**
 * Integer pence to a display string.
 *
 * Division by 100 and NOT `Intl` on a float built elsewhere: pence are exact,
 * and the only place a rounding decision is taken is here, on a value that
 * already has no fraction to lose.
 */
export function formatMoney(pence: Pence, currency = "GBP"): string {
  const negative = pence < 0;
  const absolute = Math.abs(Math.trunc(pence));
  const pounds = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = pounds.toLocaleString("en-GB");
  const symbol = currencySymbol(currency);
  return `${negative ? "-" : ""}${symbol}${grouped}.${String(remainder).padStart(2, "0")}`;
}

/**
 * The symbol, or the code when there is no symbol worth guessing.
 *
 * Deliberately three currencies and a fallback rather than a table of the
 * world's: an unknown code renders as "USD 1,690.00", which is unambiguous,
 * where a wrong symbol is a document that says the wrong thing confidently.
 */
export function currencySymbol(currency: string): string {
  const code = (currency || "GBP").toUpperCase();
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  if (code === "USD") return "$";
  return `${code} `;
}

/** Pence as a plain number of pounds — what a spreadsheet cell holds. */
export function poundsOf(pence: Pence): number {
  return Math.trunc(pence) / 100;
}

/** The Excel number format for a currency, matching `formatMoney`'s symbol. */
export function currencyNumberFormat(currency: string): string {
  const symbol = currencySymbol(currency);
  if (symbol.endsWith(" ")) return `"${symbol.trim()} "#,##0.00`;
  return `"${symbol}"#,##0.00`;
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

const DISPLAY_DATE_LENGTH = 10;

/**
 * `YYYY-MM-DD` to `DD/MM/YYYY`, with no zone conversion. See the header.
 *
 * Anything that is not a well-formed ISO date comes back as the fallback rather
 * than as `Invalid Date` or a silently reinterpreted string — a report is not
 * the place to discover that a column held free text.
 */
export function formatIsoDate(
  value: IsoDate | null | undefined,
  fallback = "",
): string {
  if (typeof value !== "string" || value.length < DISPLAY_DATE_LENGTH) return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return fallback;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

const LONDON_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const LONDON_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** An instant as the date it was, in London. */
export function formatInstantDate(
  value: IsoInstant | null | undefined,
  fallback = "",
): string {
  const stamp = parseInstant(value);
  return stamp === null ? fallback : LONDON_DATE.format(stamp);
}

/** An instant as date and time, in London. Used where "when" is the point. */
export function formatInstant(
  value: IsoInstant | null | undefined,
  fallback = "",
): string {
  const stamp = parseInstant(value);
  return stamp === null ? fallback : LONDON_DATE_TIME.format(stamp).replace(", ", " ");
}

function parseInstant(value: IsoInstant | null | undefined): Date | null {
  if (typeof value !== "string" || !value) return null;
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? null : stamp;
}

/**
 * The Excel serial number for an ISO date.
 *
 * Excel's epoch is 1899-12-30 — not 1900-01-01 — because the format reproduces
 * Lotus 1-2-3's belief that 1900 was a leap year, and every implementation has
 * copied the bug ever since. Computing from a UTC midnight keeps the serial an
 * integer; a local-midnight difference lands on 44,286.958333 in a zone east of
 * Greenwich and Excel then shows a time under a date format.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

export function excelSerialFromIsoDate(value: IsoDate | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round((utc - EXCEL_EPOCH_MS) / 86_400_000);
}

/* ── Numbers ─────────────────────────────────────────────────────────────── */

/** A count, grouped. `null` is a dash, never a nought — they mean different things. */
export function formatCount(value: number | null | undefined, fallback = "—"): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-GB")
    : fallback;
}

/**
 * A whole-number percentage from the payload, printed with one decimal.
 *
 * `null` is "no measurable job in the period" and reads as a dash. The contract
 * is emphatic that it is not zero, and 0% is a finding — it says every single
 * job missed its target.
 */
export function formatPercent(value: number | null | undefined, fallback = "—"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** Basis points to a display percentage: 2000 -> "20%". */
export function formatBasisPoints(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

/** Basis points as the fraction a spreadsheet's percent format expects. */
export function basisPointsAsFraction(basisPoints: number): number {
  return basisPoints / 10_000;
}

/** "Yes" / "No". Written out, because a spreadsheet full of TRUE reads as noise. */
export function formatBoolean(value: boolean): string {
  return value ? "Yes" : "No";
}
