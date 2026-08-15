"use client";

/**
 * Tells a horizontally scrolling strip to say so.
 *
 * Two strips in this app hold more tabs than a phone is wide — the board's view
 * tabs and the account rail — and both scrolled silently. A contractor at 320px
 * sees "All" at the right-hand end of the board strip and has no way to know
 * that eleven views sit behind it: there is no scrollbar on a touch device, the
 * strips explicitly hide the one a desktop would draw, and the last tab lands
 * flush against the edge rather than half-cut. Measured on the board strip at
 * 320px: 1327px of tabs in a 218px box, 1109px of it invisible and unannounced.
 *
 * What this manages is the SCROLL STATE, not the decoration. It writes a
 * `data-overflow` attribute the stylesheet reacts to, so the fade can only ever
 * appear when there is genuinely something past the edge — an always-on gradient
 * would be a lie at the end of the scroll, which is exactly the moment a reader
 * needs to be told they have seen everything.
 *
 * THE ATTRIBUTE IS WRITTEN DIRECTLY, NOT THROUGH STATE, and that is the reason
 * this is a hook rather than four lines inline. A `setState` in a scroll
 * listener re-renders the component that owns the strip on every frame of every
 * scroll, and the component that owns the board's strip is `BoardChrome` —
 * which renders the whole view pane beneath it, kanban, calendar, chart and
 * all. The affordance is a presentational attribute on one element; React never
 * needs to hear about it.
 *
 * It is deliberately attached to a real element rather than wrapped around one.
 * Both strips are flex/grid children whose sizing their parents own, and
 * slipping a wrapper between them would have re-flowed two layouts that
 * currently measure zero horizontal overflow.
 *
 * Re-measured on three signals because each one alone is insufficient: `scroll`
 * for the reader moving, `ResizeObserver` for the viewport changing, and a
 * `MutationObserver` for the CONTENT changing — the board's tabs arrive from
 * `/api/board/views` after first paint, so a strip measured on mount only would
 * report "nothing to scroll" for the entire life of the page.
 */

import { useEffect, useRef } from "react";
import "./scroll-affordance.css";

/**
 * A pixel of slack either side. Sub-pixel layout and fractional zoom leave
 * `scrollLeft` a hair short of `scrollWidth - clientWidth` at the very end of a
 * scroll, and without the tolerance the end fade never quite switches off —
 * which is the one state the affordance exists to communicate.
 */
const EPSILON = 1;

export function useScrollOverflow<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const furthest = element.scrollWidth - element.clientWidth;
      const past = element.scrollLeft > EPSILON;
      const before = furthest > EPSILON && element.scrollLeft < furthest - EPSILON;
      element.dataset.overflow =
        past && before ? "both" : past ? "start" : before ? "end" : "none";
    };

    measure();
    element.addEventListener("scroll", measure, { passive: true });

    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutations = new MutationObserver(measure);
    mutations.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      element.removeEventListener("scroll", measure);
      resize.disconnect();
      mutations.disconnect();
      /*
       * The strip outlives this effect in React's strict-mode double-invoke and
       * on any re-mount, so the attribute is cleared rather than left behind:
       * a stale "end" with no listener behind it is a fade that never goes off.
       */
      delete element.dataset.overflow;
    };
  }, []);

  return ref;
}
