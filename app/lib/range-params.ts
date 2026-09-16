/**
 * ONE ANSWER TO "2026-13-01", FOR EVERY BLOCK ON THE OVERVIEW.
 *
 * The Overview's three sections take the SAME `from` and `to` from the same
 * address bar, and they disagreed about what an impossible date was:
 *
 *   · `/api/overview/metrics` validated with `isCalendarDay`, which round-trips
 *     the value through `Date` and so knows that month 13 does not exist. A bad
 *     date fell back to the default window and answered 200.
 *   · `/api/reports/metrics` validated with a bare `/^\d{4}-\d{2}-\d{2}$/`,
 *     which is a SHAPE and not a date. "2026-13-01" and "2026-02-30" passed it,
 *     reached `shiftDays`, and threw `RangeError: Invalid time value` inside
 *     `new Date(...).toISOString()` — caught and returned as **503**.
 *
 * So one query string produced a working section beside a section reporting a
 * database outage, and the 503 said the server had failed when the request was
 * simply wrong. A caller cannot tell those apart, and the 5xx is what a monitor
 * pages somebody about.
 *
 * Both routes now refuse a malformed date the same way and with a 4xx, which is
 * what it is: the client sent something impossible. The lib-level fallbacks
 * inside `loadOverviewMetrics` and `resolveReportsRange` stay exactly as they
 * are — this is a guard in front of them, not a replacement for them, and a
 * caller that reaches those functions another way still degrades gracefully
 * rather than throwing.
 *
 * ABSENT IS NOT INVALID. A missing parameter is how you ask for the default
 * window, and always was; only a parameter that is present and cannot be a day
 * is refused. The Overview's own UI sanitises before it fetches
 * (`oiIsCalendarDay` in `oi-dash.tsx`), so the page cannot trip this — it exists
 * for a typed URL, a stale bookmark and a script.
 */

import { isCalendarDay } from "./overview-intel";

/** The date parameters every dashboard block reads from the address bar. */
const RANGE_KEYS = ["from", "to"] as const;

/**
 * `null` when the range parameters are usable, or a ready 400 when one of them
 * is present and is not a real calendar day.
 */
export function refuseBadRange(url: URL): Response | null {
  for (const key of RANGE_KEYS) {
    const raw = url.searchParams.get(key);
    /* Absent, or explicitly blank, means "use the default window". */
    if (raw === null || raw.trim() === "") continue;
    if (!isCalendarDay(raw)) {
      return Response.json(
        {
          error: `"${key}" must be a real calendar day in YYYY-MM-DD form.`,
        },
        { status: 400 },
      );
    }
  }
  return null;
}
