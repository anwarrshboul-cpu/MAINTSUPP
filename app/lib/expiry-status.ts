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

/* ── Policy ───────────────────────────────────────────────────────────────── */

/**
 * How many days before expiry a certificate turns amber ("due soon").
 *
 * Sixty days, and it is a policy number rather than a derived one, so it lives
 * here as the single place to change it.
 *
 * The reasoning is operational, not regulatory: none of these certificates can
 * be renewed in-house. Each one needs a third party booked — an insurance
 * broker for PLI, an electrical contractor for PAT and the wiring certificate,
 * the fire safety partner for the extinguisher, alarm, emergency lighting,
 * sprinkler and fire door tests, the water hygiene partner for the L8 test (see
 * `storeDocumentationResponsibility`). Quote, purchase order, site visit and
 * the certificate coming back is a multi-week round trip, and it can only start
 * once someone notices. Sixty days spans two monthly compliance reviews, so a
 * certificate is flagged amber on at least two consecutive reviews before it
 * can lapse — one to raise it and one to catch it if the first was missed.
 *
 * Raise it if renewals are being chased late; lower it if the board is
 * permanently amber and the warning has stopped meaning anything.
 *
 * Anything that prints a window in words must print it from this constant. The
 * Compliance Tracker used to declare its own `DUE_SOON_DAYS = 30`, label a tile
 * "Due within 30 days" and then fill it from `expiryStatus`, which is 60 — a
 * certificate 45 days out was counted in a tile that said 30.
 */
export const EXPIRY_DUE_SOON_DAYS = 60;

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
 * Today as the same kind of day index, read from `today`'s UTC calendar fields.
 *
 * `todayBoardDate()` in board-format.ts already defines "today" for this board
 * in UTC — it is what highlights the current day in `MobileBoardCalendar`. This
 * matches it so the cell and the calendar can never disagree about which day it
 * is.
 */
function todayDayIndex(today: Date): number {
  return (
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) /
    MS_PER_DAY
  );
}

const enGbLong = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const enGbShort = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * en-GB rendering of a date-only value — "12 March 2026" or "12 Mar 2026".
 *
 * Formatted in UTC for the reason given on `utcDayIndex`: a date-only value
 * must never shift a day on its way to the screen.
 */
export function formatExpiryDate(
  isoDate: string,
  style: "long" | "short" = "long",
): string {
  const date = dateOnlyValue(isoDate);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  return (style === "long" ? enGbLong : enGbShort).format(value);
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
 */
export function expiryStatus(
  iso: string | null | undefined,
  today: Date = new Date(),
): ExpiryStatus {
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

  if (daysRemaining <= EXPIRY_DUE_SOON_DAYS) {
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
