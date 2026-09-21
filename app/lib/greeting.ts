/**
 * "Good morning" — and whether it is actually morning.
 *
 * THE BUG THIS EXISTS FOR. At 16:44 BST on 14 September 2026 the live dashboard
 * header read "Good morning, MAINTSUPP", while the same browser reported local
 * hour 16 in Europe/London.
 *
 * THE ROOT CAUSE WAS THE FIRST OF THE THREE THE REPORT ASKED ABOUT, AND THE
 * DULLEST: the string was HARDCODED. `sectionMeta.overview.title` in
 * portal-app.tsx was the literal `"Good morning"`, printed by the topbar as
 * `${meta.title}, ${firstName}`. It was not the server's clock, not a fixed
 * timezone and not a cached render — no clock was consulted at all, at any
 * hour, in any timezone, by anybody. The other two hypotheses were checked and
 * are both false here: the route is `dynamic = "force-dynamic"` and the
 * component is a client component, so nothing about it is cached or prerendered.
 *
 * ── WHICH CLOCK THE GREETING IS ALLOWED TO READ ──────────────────────────
 *
 * Never the server's. `app/lib/dashboard-aggregates.ts` already makes the same
 * point about compliance figures, and it is more obviously true of a greeting:
 * this deploys to a serverless platform whose region is not the reader's, and
 * "morning" computed in us-east is the exact symptom that was reported.
 *
 * So the order is:
 *
 *   1. THE ACCOUNT'S OWN TIMEZONE. `users.timezone` is a real, editable
 *      preference — `NOT NULL DEFAULT 'Europe/London'`, surfaced on the
 *      profile screen, carried on every session by `getSession`. It is the
 *      right answer because it is the reader's own stated answer, and because
 *      it is the SAME value on the server and in the browser, which is what
 *      makes the greeting render once and stay put instead of flickering from
 *      one string to another after hydration.
 *   2. THE BROWSER'S ZONE, via `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 *      when there is no stored preference. `browserTimeZone()` is deliberately
 *      a separate function rather than a fallback inside `resolveTimeZone`:
 *      calling it on the server would return the SERVER's zone, which is the
 *      one thing this module exists to avoid, so it cannot be reached from a
 *      path the server also runs.
 *   3. EUROPE/LONDON. The business operates in the UK — MAINTSUPP LTD, UK
 *      retail portfolios, service hours quoted in UK time — so when nothing is
 *      known about the reader, UK local time is the likeliest to be right and
 *      the least surprising to be wrong in.
 *
 * Nothing here caches a "today" or an "hour". Every function takes the instant
 * it should answer for, so a page left open across a boundary is a re-render
 * away from being right rather than stale for ever.
 */

/**
 * Where the greeting lands when nothing else is known.
 *
 * The UK, because that is where the business is: MAINTSUPP LTD is registered in
 * England and Wales, the portfolios are UK retail, and the published service
 * hours are UK local. A reader we know nothing about is far more likely to be
 * in that timezone than in the one the server happens to run in.
 */
export const FALLBACK_TIME_ZONE = "Europe/London";

export type Greeting = "Good morning" | "Good afternoon" | "Good evening";

/**
 * The buckets, on the LOCAL hour.
 *
 *   05:00–11:59  Good morning
 *   12:00–17:59  Good afternoon
 *   18:00–04:59  Good evening
 *
 * Evening wraps midnight, so it is the fall-through rather than a range — a
 * `hour >= 18 && hour <= 4` would be empty and is the usual way to get this
 * wrong.
 */
export function greetingForHour(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Whether `Intl` will accept this as a timezone. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    // RangeError: an unknown zone. A stored value can be anything.
    return false;
  }
}

/**
 * The stored preference if it is usable, else the UK.
 *
 * Safe to call on the server AND in the browser, and it returns the same answer
 * in both — which is the property the greeting depends on to render once.
 */
export function resolveTimeZone(stored: string | null | undefined): string {
  return isValidTimeZone(stored) ? stored : FALLBACK_TIME_ZONE;
}

/**
 * The zone this BROWSER is in.
 *
 * Client-only by construction. On the server `resolvedOptions()` reports the
 * server's own zone, which is precisely the wrong answer, so this must never be
 * called from a path the server also takes — see the note at the top.
 */
export function browserTimeZone(): string | null {
  if (typeof Intl === "undefined") return null;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/*
 * `Intl.DateTimeFormat` is expensive to construct and this is read on every
 * render of the shell, so instances are kept per zone — the same reasoning, and
 * the same shape, as the cache in `app/lib/format-date.ts`.
 */
const clocks = new Map<string, Intl.DateTimeFormat>();

function clockFor(timeZone: string) {
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      /*
       * h23, not `hour12: false`. They are not the same: with `hour12: false`
       * several locales render midnight as "24", and `Number("24")` lands
       * outside every bucket and falls through to "Good evening" — right by
       * accident at midnight and wrong the moment the buckets change. h23 is
       * 0–23 and says so.
       */
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clocks.set(timeZone, clock);
  }
  return clock;
}

function partsIn(timeZone: string, at: Date) {
  const parts = clockFor(timeZone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { hour: read("hour"), minute: read("minute"), second: read("second") };
}

/** The hour of the day, 0–23, as it reads in `timeZone`. */
export function localHourIn(timeZone: string, at: Date = new Date()): number {
  const { hour } = partsIn(timeZone, at);
  return Number.isNaN(hour) ? new Date(at).getUTCHours() : hour;
}

/** The greeting for an instant, in a zone. */
export function greetingAt(at: Date, timeZone: string): Greeting {
  return greetingForHour(localHourIn(timeZone, at));
}

/**
 * How long until the local hour ticks over, in milliseconds.
 *
 * The greeting can only change on the hour, so a shell left open is refreshed
 * at the top of each local hour rather than on a poll. Hourly rather than at
 * 05:00/12:00/18:00 exactly because recomputing the hour is DST-safe and
 * arithmetic across a DST jump is not: at most 24 wake-ups a day, each of them
 * one `formatToParts`.
 *
 * The MINUTE AND SECOND ARE READ IN THE TARGET ZONE, not from the Date. Most
 * zones share them with UTC, and India (+05:30), Nepal (+05:45) and Chatham
 * (+12:45) do not — reading them locally is what makes the wake-up land on the
 * hour there too.
 *
 * Floored at a second so a clock that lands exactly on the boundary cannot
 * produce a zero-delay timer that spins.
 */
export function msUntilNextLocalHour(at: Date, timeZone: string): number {
  const { minute, second } = partsIn(timeZone, at);
  if (Number.isNaN(minute) || Number.isNaN(second)) return 60_000;
  const remaining =
    ((59 - minute) * 60 + (60 - second)) * 1000 - (at.getTime() % 1000);
  return Math.max(1_000, remaining);
}
