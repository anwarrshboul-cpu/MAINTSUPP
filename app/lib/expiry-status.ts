/**
 * Certificate expiry — one threshold, one classifier, one place.
 *
 * This used to live inside `app/(app)/portal/cells/expiry-cell.tsx`, a "use
 * client" React component. That put the only date-based compliance verdict in
 * the codebase behind a component import, so the two places that decide whether
 * a certificate is in date on the *server* — `/api/workspace` and the compliance
 * digest — could not reach it and each invented its own answer. `/api/workspace`
 * invented the worst one: it passed the stored `compliance_documents.status`
 * string straight through, so "Compliant" written in 2026 stayed "Compliant"
 * for ever and a document stored "Expiring soon" with 86 days left was counted
 * as expiring on /dashboard/compliance while the Compliance Tracker, which does
 * read the date, counted the same document as in date. Two screens, ten stores,
 * 31 versus 32.
 *
 * So the policy and the classifier are pure and live in app/lib, importable from
 * a route handler, a React view and a test alike. `expiry-cell.tsx` re-exports
 * them, so every existing importer is untouched.
 *
 * Nothing here reads a clock of its own: `today` is always injected, so a whole
 * board can be classified against one instant instead of drifting across the
 * loop, and a test can pin the date.
 */

import { formatLongDate, formatShortDate } from "./format-date";

/* ── Policy ───────────────────────────────────────────────────────────────── */

/**
 * How many days before expiry a certificate turns amber ("due soon") — THE
 * DEFAULT WARNING WINDOW, 90 days.
 *
 * Ninety is the approved Compliance specification's window ("Warning window is
 * a config value in Settings (default 90 days)"), with its renewal countdown in
 * three equal bands: 0–30, 31–60 and 61–90 days. The product shipped at sixty
 * for a while; that was a global default typed here, never a value any
 * organisation saved, so moving the default moves every organisation that has
 * not chosen otherwise and overrides nobody's choice.
 *
 * The reasoning is operational, not regulatory: none of these certificates can
 * be renewed in-house. Each one needs a third party booked — an insurance
 * broker for PLI, an electrical contractor for PAT and the wiring certificate,
 * the fire safety partner for the extinguisher, alarm, emergency lighting,
 * sprinkler and fire door tests, the water hygiene partner for the L8 test (see
 * `storeDocumentationResponsibility`). Quote, purchase order, site visit and
 * the certificate coming back is a multi-week round trip, and it can only start
 * once someone notices. Ninety days spans three monthly compliance reviews, so
 * a certificate is flagged amber on at least three consecutive reviews before
 * it can lapse.
 *
 * AN ORGANISATION MAY CHOOSE ITS OWN WINDOW in Settings
 * (`workspace_settings.settings.compliancePolicy.warningWindowDays`, read by
 * `compliance-policy.ts`). The server classifies every register with the
 * organisation's window — `readComplianceRegister` resolves it once and every
 * compliance surface reads that register — and hands it to the browser, which
 * classifies its own cells through `setBrowserWarningWindow` below.
 *
 * Anything that prints a window in words must print the window it classified
 * with — this constant, or the organisation's value where one is in hand. The
 * Compliance Tracker used to declare its own `DUE_SOON_DAYS = 30`, label a tile
 * "Due within 30 days" and then fill it from `expiryStatus`, which was 60 — a
 * certificate 45 days out was counted in a tile that said 30.
 */
export const EXPIRY_DUE_SOON_DAYS = 90;

/** The narrowest and widest window an organisation may choose. */
export const MIN_WARNING_WINDOW_DAYS = 7;
export const MAX_WARNING_WINDOW_DAYS = 365;

/**
 * A warning window from anything a settings row or a form may hold: a whole
 * number of days inside the bounds, or the default. Total, because it is read
 * on the path of every compliance screen, and a malformed settings row must
 * degrade to the default rather than take the register down.
 */
export function normaliseWarningWindow(value: unknown): number {
  const days = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof days !== "number" || !Number.isFinite(days)) return EXPIRY_DUE_SOON_DAYS;
  const whole = Math.round(days);
  if (whole < MIN_WARNING_WINDOW_DAYS || whole > MAX_WARNING_WINDOW_DAYS) return EXPIRY_DUE_SOON_DAYS;
  return whole;
}

/*
 * THE BROWSER'S WINDOW.
 *
 * Board cells, the Compliance Tracker, the expiry calendar and the document
 * register classify in the browser, one cell at a time, with no request context
 * to carry an organisation's setting through dozens of props. The shell sets it
 * once from the workspace settings it already loads; every `expiryStatus` call
 * that does not pass a window then uses it.
 *
 * NEVER ON THE SERVER. One server process answers many organisations, so a
 * module-level value there would let one tenant's setting classify another
 * tenant's register. The setter is inert outside a browser and the reader
 * returns the default there, so every server classification either passes the
 * organisation's window explicitly or uses the product default.
 */
let browserWindowDays = EXPIRY_DUE_SOON_DAYS;

/** Called by the portal shell when the workspace settings arrive. Inert on the server. */
export function setBrowserWarningWindow(value: unknown): void {
  if (typeof window === "undefined") return;
  browserWindowDays = normaliseWarningWindow(value);
}

/** The window an `expiryStatus` call uses when none is passed. */
export function activeWarningWindow(): number {
  return typeof window === "undefined" ? EXPIRY_DUE_SOON_DAYS : browserWindowDays;
}

/* ── The compliance day ───────────────────────────────────────────────────── */

/**
 * WHICH CALENDAR DAY IT IS, FOR COMPLIANCE: the day in Europe/London.
 *
 * A certificate "due today" is due on the UK calendar day, and it expires when
 * that day ends in the UK — not at UTC midnight, which during British Summer
 * Time is 1am the next morning. Reading the UTC calendar here classified a
 * certificate due on the 10th as still in date until 00:59 BST on the 11th, and
 * put the flip from "Expires today" to "Expired" an hour after the day it
 * named had ended. Stored timestamps stay UTC; only the question "what is
 * today's date" is asked in London.
 *
 * `Intl` with an explicit `timeZone` is the whole mechanism — it knows the BST
 * transitions, so no offset is hand-computed and none can be an hour out twice
 * a year. One formatter, built on first use and reused. If the platform cannot
 * supply the zone at all, the UTC calendar is the fallback: never a throw on a
 * compliance screen.
 */
export const COMPLIANCE_TIME_ZONE = "Europe/London";

let londonDayFormatter: Intl.DateTimeFormat | null = null;

/** `YYYY-MM-DD` for the calendar day `at` falls on in Europe/London. */
export function complianceDay(at: Date = new Date()): string {
  const instant = Number.isFinite(at.getTime()) ? at : new Date();
  try {
    londonDayFormatter ??= new Intl.DateTimeFormat("en-GB", {
      timeZone: COMPLIANCE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = londonDayFormatter.formatToParts(instant);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  } catch {
    /* No time-zone data on this platform — fall through to the UTC calendar. */
  }
  return instant.toISOString().slice(0, 10);
}

/* ── Date-only values ─────────────────────────────────────────────────────── */

/**
 * The `YYYY-MM-DD` inside anything a board date column stores.
 *
 * Accepts the three shapes the board writes: a bare `YYYY-MM-DD`, a full ISO
 * timestamp, and the serialised date metadata JSON. Anything else returns "",
 * which every caller treats as "no date recorded" — the safe direction, because
 * it surfaces as an open finding rather than as a pass.
 *
 * `rawDateInputValue` in board-format.ts delegates here rather than keeping a
 * second copy: the board grid and the compliance screens must agree about what
 * a date column says, down to the malformed cases.
 */
export function dateOnlyValue(value: string | null | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return typeof parsed.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : "";
    } catch {
      return "";
    }
  }
  const date = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

/* ── Pure status helper ───────────────────────────────────────────────────── */

/** The RAG state of a single certificate expiry. */
export type ExpiryState = "expired" | "due-soon" | "valid" | "not-recorded";

export type ExpiryStatus = {
  /** RAG bucket. `not-recorded` means no date is on file — an open finding. */
  state: ExpiryState;
  /** The normalised `YYYY-MM-DD` the state came from, or null when unrecorded. */
  date: string | null;
  /**
   * Whole days from today to the expiry date. Negative once expired, 0 on the
   * final valid day, null when nothing is recorded.
   */
  daysRemaining: number | null;
  /** Short state word. Always rendered alongside the colour, never instead. */
  label: string;
  /**
   * Sentence for the accessible name, e.g. "expired 12 March 2026, 118 days
   * ago". Reads correctly when prefixed with the column title.
   */
  description: string;
};

const MS_PER_DAY = 86_400_000;

/**
 * Day index for a `YYYY-MM-DD` value, counted in whole UTC days.
 *
 * A date-only expiry has no time and no zone. Parsing it with `new Date(iso)`
 * would anchor it to UTC midnight and then render it in local time, which
 * silently moves a certificate a day earlier for anyone west of Greenwich — the
 * difference between "expires today" and "expired yesterday". Splitting the
 * string and going through `Date.UTC` keeps the calendar day exactly as typed.
 */
function utcDayIndex(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/**
 * Today as the same kind of day index: the Europe/London calendar day `today`
 * falls on, counted like an expiry date. See `complianceDay` — a certificate's
 * last valid day ends at midnight in the UK, in winter and in summer alike.
 */
function todayDayIndex(today: Date): number {
  return utcDayIndex(complianceDay(today));
}

/**
 * en-GB rendering of a date-only value — "12 March 2026" or "12 Mar 2026".
 *
 * Formatted in UTC for the reason given on `utcDayIndex`: a date-only value
 * must never shift a day on its way to the screen. The shared formatter in
 * app/lib/format-date.ts holds that rule for the whole platform now — a bare
 * `YYYY-MM-DD` is split into three numbers there and never reaches `Date` —
 * so the two `Intl` instances this file kept have gone rather than being a
 * tenth copy of the same decision.
 *
 * `dateOnlyValue` still runs first, because it is what decides which malformed
 * values count as no date at all, and that answer has to match the cells.
 */
export function formatExpiryDate(
  isoDate: string,
  style: "long" | "short" = "long",
): string {
  const date = dateOnlyValue(isoDate);
  if (!date) return "";
  return style === "long"
    ? formatLongDate(date, { fallback: "" })
    : formatShortDate(date, { fallback: "" });
}

function pluraliseDays(count: number): string {
  return count === 1 ? "1 day" : `${count} days`;
}

/**
 * Classify a certificate expiry date.
 *
 * Pure: no clock, no DOM, no state. `today` is injectable so tests can pin it
 * and so the Compliance Tracker can classify a whole board against one instant
 * instead of drifting across the loop.
 *
 * `iso` accepts anything the board stores in a date column — a bare
 * `YYYY-MM-DD`, a full ISO timestamp, or the serialised date metadata JSON —
 * because those are the three shapes `dateOnlyValue` normalises. Anything
 * unparseable is treated as not recorded, which is the safe direction: it
 * surfaces as an open finding rather than as a pass.
 *
 * `windowDays` is the organisation's warning window. A server caller passes
 * the one its register was resolved with; a browser caller may omit it and get
 * the window the shell set (`activeWarningWindow`).
 */
export function expiryStatus(
  iso: string | null | undefined,
  today: Date = new Date(),
  windowDays: number = activeWarningWindow(),
): ExpiryStatus {
  const window = Number.isFinite(windowDays) ? windowDays : EXPIRY_DUE_SOON_DAYS;
  const date = dateOnlyValue(iso);

  if (!date) {
    return {
      state: "not-recorded",
      date: null,
      daysRemaining: null,
      label: "Not recorded",
      description: "no expiry date recorded",
    };
  }

  const daysRemaining = utcDayIndex(date) - todayDayIndex(today);
  const longDate = formatExpiryDate(date, "long");

  if (daysRemaining < 0) {
    return {
      state: "expired",
      date,
      daysRemaining,
      label: "Expired",
      description: `expired ${longDate}, ${pluraliseDays(-daysRemaining)} ago`,
    };
  }

  if (daysRemaining <= window) {
    return {
      state: "due-soon",
      date,
      daysRemaining,
      label: daysRemaining === 0 ? "Expires today" : "Due soon",
      description:
        daysRemaining === 0
          ? `expires today, ${longDate}`
          : `expires ${longDate}, in ${pluraliseDays(daysRemaining)}`,
    };
  }

  return {
    state: "valid",
    date,
    daysRemaining,
    label: "Valid",
    description: `valid until ${longDate}, ${pluraliseDays(daysRemaining)} remaining`,
  };
}

/* ── Dates that exist ─────────────────────────────────────────────────────── */

/**
 * Whether a `YYYY-MM-DD` names a day that is actually on the calendar.
 *
 * `dateOnlyValue` above answers a different question, and deliberately so: it
 * asks whether a value has the SHAPE of a date, because its job is to normalise
 * the three forms a board date column stores and it must not start rejecting
 * cells that are already in the database.
 *
 * Shape is not existence. `2027-13-45` matches `^\d{4}-\d{2}-\d{2}$` perfectly
 * and is not a date — there is no thirteenth month. Left alone it does not fail
 * loudly either, which is the dangerous part: `Date.UTC(2027, 12, 45)` rolls the
 * overflow forward and yields a real instant in February 2028, so a certificate
 * filed with a typo silently acquires an expiry date nobody chose, three months
 * from the one they meant, and every screen agrees about it.
 *
 * The round trip is the check — parse the three numbers, build the UTC day, and
 * require it to render back to the same three numbers. Anything that rolled over
 * comes back different. Note that Postgres's own CHECK constraint on
 * `attachments.expiry_date` is the same shape-only regex, so the database will
 * not catch this either; it has to be refused at the API boundary.
 *
 * Used by the write paths, which can refuse. Readers keep using `dateOnlyValue`,
 * because a value already stored has to render somehow.
 */
export function isRealCalendarDate(value: string | null | undefined): boolean {
  const date = dateOnlyValue(value);
  if (!date) return false;
  const [year, month, day] = date.split("-").map(Number);
  const built = new Date(Date.UTC(year, month - 1, day));
  return (
    built.getUTCFullYear() === year &&
    built.getUTCMonth() === month - 1 &&
    built.getUTCDate() === day
  );
}
