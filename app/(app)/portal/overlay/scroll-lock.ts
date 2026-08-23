"use client";

/**
 * The one body scroll lock.
 *
 * Moved here from `portal-app.tsx` so the overlay primitive can take the same
 * lock the job drawer and the phone's nav drawer take, rather than growing a
 * second counter that would disagree with the first about when the page is
 * free to move. `portal-app.tsx` keeps its `useScrollLock` name as a thin alias
 * of `useBodyScrollLock`, so every existing call site reads as before.
 *
 * A COUNTER, NOT A FLAG. Two overlays can be open at once — the nav drawer over
 * an open job drawer — and with independent flags whichever closed first would
 * unlock the page while the other was still up, and would restore ITS saved
 * offset over the other's. The offset is captured on the first lock and handed
 * back on the last release.
 *
 * `position: fixed` on the body, not `overflow: hidden` alone (see
 * `body.is-scroll-locked` in globals.css). On iOS Safari — every engineer
 * standing in a shop — `overflow: hidden` on the body is not reliably honoured
 * for touch scrolling, and taking the body out of flow is the technique that
 * actually holds. Because that collapses the scroll position to 0, the offset
 * is re-applied as a negative `top` so the page does not visibly jump, then
 * restored on release. The restore is explicitly `instant`: `html` carries
 * `scroll-behavior: smooth`, so a default-behaviour restore would animate
 * ~90,000px back into place.
 */

import { useEffect } from "react";

let scrollLockDepth = 0;
let scrollLockOffset = 0;

/** Takes the lock. Returns the release; releasing twice is harmless. */
export function acquireBodyScrollLock(): () => void {
  if (scrollLockDepth === 0) {
    scrollLockOffset = window.scrollY;
    document.body.style.setProperty(
      "--scroll-lock-offset",
      `-${scrollLockOffset}px`,
    );
    document.body.classList.add("is-scroll-locked");
  }
  scrollLockDepth += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLockDepth = Math.max(0, scrollLockDepth - 1);
    if (scrollLockDepth > 0) return;
    document.body.classList.remove("is-scroll-locked");
    document.body.style.removeProperty("--scroll-lock-offset");
    window.scrollTo({ top: scrollLockOffset, left: 0, behavior: "instant" });
  };
}

/** How deep the lock currently is — for tests and diagnostics only. */
export function bodyScrollLockDepth() {
  return scrollLockDepth;
}

/** Holds the lock for as long as `active` is true. */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    return acquireBodyScrollLock();
  }, [active]);
}
