"use client";

/**
 * Viewport-aware placement for the board's row and group menus.
 *
 * Its own file rather than a third primitive in `board-primitives.tsx`: that
 * file is the mobile context, the mobile sheet and the popover reveal, and
 * `stage-eight-board-split` holds it to 200 lines precisely so it stays that
 * short list. Menu placement is a separate concern from mobile presentation
 * and shares nothing with it but a caller.
 */
import { useLayoutEffect, useRef } from "react";

/** Breathing room kept between a menu and the edge of the viewport. */
const MENU_VIEWPORT_MARGIN = 12;

/**
 * The tallest a board menu is allowed to get, matching the cap the stylesheet
 * has always applied. Available space narrows this; it never widens it, so a
 * tall screen still gets a menu somebody can read rather than one running the
 * full height of the window.
 */
const MENU_MAX_HEIGHT = 560;

/** Below this a menu would be a sliver, so it scrolls instead of shrinking. */
const MENU_MIN_HEIGHT = 120;

/**
 * Keeps the row and group menus inside the viewport.
 *
 * Both menus are `position: absolute` and open downward from a fixed offset —
 * `.sheet-group__menu` at `top: 32px`, `.sheet-row-menu` at `top: 35px`. That
 * is correct for a trigger near the top of the screen and wrong for every
 * other one: measured at 1280x900 with the group trigger just above the fold,
 * the menu ran from y=877 to y=1437 and 537px of it — every entry below
 * "Rename group" — was off the bottom of the screen. `max-height` already caps
 * the box, but a cap does nothing about *where* the box starts.
 *
 * monday flips the menu above its trigger when there is no room below, so that
 * is what this does. Flipping rather than scrolling the page into range on the
 * menu's behalf: the menu belongs to a row somebody is pointing at, and
 * scrolling moves that row out from under the pointer — `useRevealBoardPopover`
 * can scroll because a cell popover is anchored to a cell the pointer has
 * already committed to, whereas these open from a one-click trigger.
 *
 * The available space also becomes the menu's `max-height`, so the flipped
 * direction cannot overflow the top edge the way the unflipped one overflowed
 * the bottom. Both menus keep `overflow-y: auto`, so a menu taller than the
 * space it has scrolls inside itself instead of escaping.
 *
 * Returns a ref to attach to the menu element itself. The measurement is taken
 * against `offsetParent`, which is the trigger's own containing block —
 * `.sheet-group__menu-wrap` for the group menu and `td.sheet-check` for the
 * row menu — so neither call site has to describe its own geometry.
 */
export function useBoardMenuFit(open: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = ref.current;
    if (!menu) return;

    const fit = () => {
      const anchor = menu.offsetParent as HTMLElement | null;
      if (!anchor) return;

      // Measure from the unshifted position, or each pass would compound the
      // last one's correction. Nothing paints between here and the write below.
      menu.style.setProperty("--board-menu-shift-x", "0px");

      const anchorBox = anchor.getBoundingClientRect();
      const viewportHeight = document.documentElement.clientHeight;
      const viewportWidth = document.documentElement.clientWidth;
      const spaceBelow = viewportHeight - anchorBox.bottom - MENU_VIEWPORT_MARGIN;
      const spaceAbove = anchorBox.top - MENU_VIEWPORT_MARGIN;

      // scrollHeight is the full content height even while max-height clips it,
      // so this asks "how tall does it want to be" without a reflow dance.
      const wanted = menu.scrollHeight;
      const flip = wanted > spaceBelow && spaceAbove > spaceBelow;
      const available = Math.max(
        Math.min(flip ? spaceAbove : spaceBelow, MENU_MAX_HEIGHT),
        MENU_MIN_HEIGHT,
      );

      // Sideways, the menu is anchored to its trigger and the trigger can sit
      // outside the viewport entirely — the board toolbar scrolls horizontally
      // on a phone, so "Hide" is often off to the right of the screen. At 390px
      // the columns panel opened at x=373 and 253px of a 270px panel was past
      // the right edge. Shift it back rather than re-anchor it, so it still
      // reads as belonging to the control that opened it.
      const box = menu.getBoundingClientRect();
      let shift = 0;
      if (box.right > viewportWidth - MENU_VIEWPORT_MARGIN) {
        shift = viewportWidth - MENU_VIEWPORT_MARGIN - box.right;
      }
      if (box.left + shift < MENU_VIEWPORT_MARGIN) {
        shift = MENU_VIEWPORT_MARGIN - box.left;
      }

      menu.classList.toggle("is-flipped", flip);
      menu.style.setProperty("--board-menu-max-height", `${Math.round(available)}px`);
      menu.style.setProperty("--board-menu-shift-x", `${Math.round(shift)}px`);
    };

    fit();
    // Anything that moves the trigger changes the answer. `true` for scroll so
    // the board's own scroll containers are heard, not just the document.
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [open]);

  return ref;
}
