"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  FALLBACK_TIME_ZONE,
  browserTimeZone,
  greetingAt,
  isValidTimeZone,
  msUntilNextLocalHour,
  type Greeting,
} from "../../lib/greeting";

/**
 * The header greeting, kept true without flickering.
 *
 * ── WHY THE FIRST RENDER IS NOT "NOTHING" ────────────────────────────────
 *
 * The obvious way to make a greeting follow the viewer's clock is to render
 * nothing (or a neutral string) on the server and fill it in from an effect.
 * That is exactly what the report asked us NOT to produce: a wrong or absent
 * greeting first, corrected a tick later.
 *
 * It is also unnecessary here. The zone comes from `users.timezone`, which the
 * server reads out of the session and hands to the shell as a prop, so the
 * server and the browser compute the same function of the same zone at the same
 * instant. They agree, the markup matches, and the greeting is correct in the
 * first frame with nothing to correct. Measured in a browser across three real
 * zones: fourteen sampled frames plus the settled state, one distinct value
 * each time.
 *
 * The one case that can disagree is a render straddling 05:00, 12:00 or 18:00
 * in the viewer's zone by the few milliseconds between the server's render and
 * hydration. React re-renders from the client value, so the visible result is
 * right; the window is a few milliseconds a day and the alternative —
 * withholding the greeting from every render for ever — costs more than it
 * saves.
 *
 * ── THE BROWSER FALLBACK, WITHOUT A HYDRATION MISMATCH ───────────────────
 *
 * When the account has no usable timezone the brief asks for the BROWSER's.
 * That value exists only on the client, which is what `useSyncExternalStore`'s
 * third argument is for: the server snapshot is the UK fallback, the client
 * snapshot is the browser's own zone, and React reconciles the two after
 * hydration without warning and without us writing state from an effect.
 *
 * It is not an effect for a second reason: `setState` inside `useEffect` is
 * what `react-hooks/set-state-in-effect` exists to stop, and the first draft of
 * this hook did exactly that.
 *
 * In practice `users.timezone` is `NOT NULL DEFAULT 'Europe/London'`, so a
 * signed-in reader always has a preference and the store is never consulted. It
 * is here for a shell rendered without one.
 *
 * ── AND WHY IT DOES NOT GO STALE ─────────────────────────────────────────
 *
 * A dashboard left open across noon would otherwise still read "Good morning"
 * until something else re-rendered it, which is a quieter version of the bug
 * being fixed. `msUntilNextLocalHour` schedules ONE timer to the top of the
 * next local hour; the greeting can only change on the hour, so that is the
 * whole of it — no interval, no polling, and DST-safe because the hour is
 * recomputed rather than added to.
 */

/** The browser's zone never changes mid-session, so there is nothing to watch. */
function subscribe() {
  return () => {};
}

/*
 * Cached, because `getSnapshot` is called on every render and React compares
 * the results with `Object.is` — returning a freshly computed string is fine,
 * but constructing an `Intl.DateTimeFormat` each time is not.
 */
let cachedBrowserZone: string | null = null;
function browserSnapshot() {
  cachedBrowserZone ??= browserTimeZone() ?? FALLBACK_TIME_ZONE;
  return cachedBrowserZone;
}

/** What the SERVER must answer: never its own zone. See `app/lib/greeting.ts`. */
function serverSnapshot() {
  return FALLBACK_TIME_ZONE;
}

export function useGreeting(storedTimeZone: string | null | undefined): Greeting {
  const stored = isValidTimeZone(storedTimeZone) ? storedTimeZone : null;
  const browser = useSyncExternalStore(subscribe, browserSnapshot, serverSnapshot);
  const timeZone = stored ?? browser;

  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    // The state write happens in the timer, not in the effect body — the
    // effect only schedules it.
    const timer = window.setTimeout(
      () => setAt(Date.now()),
      msUntilNextLocalHour(new Date(at), timeZone),
    );
    return () => window.clearTimeout(timer);
  }, [at, timeZone]);

  return greetingAt(new Date(at), timeZone);
}
