"use client";

/**
 * The view-tab strip's two bits of chrome: its scroll arrows, and the rule that
 * its menus close when you click away from them.
 *
 * Extracted from `board-chrome.tsx`, which `stage-eight-board-split` holds to
 * 500 lines. Both were added together and both are about the strip's furniture
 * rather than about views, so they leave together.
 *
 * The arrows were also written twice — same `scrollBy`, same reduced-motion
 * check, same 0.8-of-a-screen step, once per direction. One component taking a
 * direction is the whole reason a second one was worth extracting rather than
 * copying.
 */

import { useEffect, type RefObject } from "react";
import { Icon } from "../../components";

/**
 * How much of the strip one press moves.
 *
 * Slightly less than a full screen so a tab stays visible across the jump —
 * paging by exactly 100% leaves the reader with no shared landmark between
 * before and after, which is how people lose their place in a tab strip.
 */
const PAGE_FRACTION = 0.8;

/**
 * One of the strip's scroll arrows.
 *
 * `direction` decides the class as well as the sign, because CSS shows each
 * button off a different `data-overflow` state on the strip — "start" for back,
 * "end" for forward, "both" for either. See views/scroll-affordance.css.
 *
 * `aria-hidden` with `tabIndex={-1}` on purpose: every tab this scrolls to is
 * already a real focusable button inside the strip, and the browser scrolls a
 * focused tab into view by itself. A keyboard user reaches everything without
 * these, so announcing them would be announcing furniture.
 */
export function BoardViewsScroll({
  direction,
  stripRef,
}: {
  direction: "back" | "forward";
  stripRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <button
      type="button"
      className={direction === "back" ? "board-views__back" : "board-views__forward"}
      aria-hidden="true"
      tabIndex={-1}
      onClick={() => {
        const strip = stripRef.current;
        if (!strip) return;
        const step = strip.clientWidth * PAGE_FRACTION;
        strip.scrollBy({
          left: direction === "back" ? -step : step,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }}
    >
      <Icon name="chevron" size={16} />
    </button>
  );
}

/**
 * Closes the strip's menus on a click anywhere else, and on Escape.
 *
 * "All", "+" and a tab's own "…" each toggled only themselves, so the only way
 * to dismiss one was to press the same control a second time. Clicking anywhere
 * else — including straight onto a DIFFERENT one of the three — left the first
 * hanging open, and two menus could sit on screen at once.
 *
 * `live-board.tsx` has done this since Stage 8 with a `pointerdown` listener
 * that spares anything inside `[data-board-popover]`. This is the same handler
 * for the chrome's own menus, which that one never covered because it lives in
 * a different component. The `data-board-popover` markers on the three wrappers
 * are what make a press on a trigger, or inside an open menu, not count as
 * "outside".
 *
 * `pointerdown` rather than `click`, matching the original: it fires before
 * focus moves, so a menu cannot flicker shut and reopen from one press.
 *
 * `close` is called on every outside press and every Escape, so it must be
 * stable — the caller passes a `useCallback` — or this rebinds each render.
 */
export function useDismissOnOutside(close: () => void) {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-board-popover]")) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);
}
