"use client";

/**
 * KEEPING THE SIX JOB METERS REACHABLE — the collapsing sticky strip.
 *
 * THE DEFECT. Measured on /dashboard/jobs at 1440x900: the page scrolls 480px,
 * the board is a nested scroller holding 36,838px of rows in a 645px window,
 * and once the page is at the bottom the meter cards sit 128px ABOVE the
 * viewport. Everything a reader does inside the grid happens in that nested
 * scroller, which never moves the page, so the only way back to the numbers is
 * the outer scrollbar at the edge of the screen. On a phone it is worse: the
 * card list is 89,220px of page scroll and the meters are one screen in a
 * hundred and six.
 *
 * WHAT WAS RULED OUT. Locking the page so that only the grid scrolls was tried
 * and measured: the furniture above the grid is ~570px of a 900px screen, so it
 * left the grid 236px tall on a desktop and 165px on a phone — about six rows.
 * Shrinking or dropping a heading was not an option either; nothing on this
 * page may be removed.
 *
 * WHAT THIS DOES NOW (owner's decision, 2026-10-03). The meters are the STRIP
 * at every scroll position — one row of label-and-figure chips, 46px — and the
 * full cards are a thing the reader asks for with "Show meter detail" and gets
 * until they put them away again. Nothing about the section's size depends on
 * where the page is scrolled to. The section is still `position: sticky` under
 * the page's top bar, so the six figures ride down the page with the reader.
 * The same six cards, the same six numbers, the same DOM: the strip is CSS on
 * elements that were already on the page, so it cannot come to disagree with
 * the cards it stands in for.
 *
 * WHAT IT REPLACED, AND WHY. Until then the cards were drawn in full at the top
 * of the page and collapsed into the strip the moment they pinned. That worked
 * as measured — see the two notes below — but the page visibly re-arranged
 * itself part-way through a scroll, and together with a grid that swallowed the
 * wheel at its own top (globals.css, `.live-board-scroll`) it read as a fault:
 * the cards went away and would not come back. A size that never changes with
 * scroll cannot be mistaken for one. The two notes are kept because `stuck`
 * still comes from the same trigger, and because they are the reason the size
 * must never be tied to scroll position again.
 *
 * WHY THE TRIGGER IS THE HEADING ABOVE, NOT THE SECTION ITSELF. A stuck element
 * reports the same rectangle at every scroll position, so it cannot tell you
 * when it became stuck. The page heading above it is never sticky and — this is
 * the load-bearing part — nothing between it and the top of the document
 * changes size when the meters collapse, so its position in the document is
 * invariant under the very effect it triggers.
 *
 * WHY THE SIZE MUST NOT FOLLOW THE SCROLL (history; superseded as a mechanism).
 *
 * The first version simply let the section shrink from 168px to 46px, and it
 * oscillated. Chrome's scroll anchoring watches for content above the reader
 * changing size and compensates by moving the scroll position — so collapsing
 * took 122px out of the page and the browser subtracted 122 from `scrollY` to
 * hold the view still. That moved the trigger back down across its own line,
 * which expanded the section, which gave the 122px back, which moved the
 * trigger up again. Measured on the real page: parked at y=200 the strip
 * flipped on and off and the scroll position alternated 200/78 indefinitely.
 *
 * The second version made the collapse a pure repaint — the strip's height
 * plus a bottom margin of the difference — so the document was the same height
 * in both states. That held, at the price of an empty 122px band under the
 * strip. Both are gone: with the size decided by the reader's click and by
 * nothing else, scrolling changes only `is-stuck`, which is a background and a
 * shadow and not one pixel of layout, so there is no loop to break.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components";

export type CollapsingMeters = {
  /** The page column. It carries both measured lengths as custom properties. */
  pageRef: (node: HTMLDivElement | null) => void;
  /**
   * Read by the CSS, and three-valued on purpose.
   *
   * "off" — no meters on this board; the phone's bars sit where they always did.
   * "on"  — the strip; they step down by the strip's height.
   * "open"— expanded to the full cards by the reader, which is taller than the
   *         strip. Treating this as "off" was a real bug: the board's identity
   *         bar snapped back under the top bar and the cards, still pinned and
   *         still 141px tall, drew straight over it.
   *
   * It no longer follows `stuck`. The offsets it drives are sticky `top`s,
   * which do nothing until their bar pins — and by then the strip above has
   * pinned too — so "on" at the top of the page costs nothing and keeps the
   * strip's own height (`--jobs-rail-h`) defined before the first scroll.
   */
  railState: "on" | "off" | "open";
  /** Goes on the heading ABOVE the meters — the trigger. See above. */
  anchorRef: (node: HTMLElement | null) => void;
  /** The meters section itself. */
  sectionRef: (node: HTMLElement | null) => void;
  sectionClassName: string;
  collapsed: boolean;
  stuck: boolean;
  toggle: () => void;
};

export function useCollapsingMeters(enabled: boolean): CollapsingMeters {
  const page = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const [stuck, setStuck] = useState(false);
  /* The reader's choice, and the ONLY thing that decides the size. */
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded;

  /*
   * Callback refs rather than object refs, because both observers below have to
   * be (re)attached the moment their element exists. With `useRef` alone the
   * effect can run before React has committed the node on a route that mounts
   * the board in a second pass, and the observer silently watches nothing.
   */
  const [nodes, setNodes] = useState(0);
  const bump = useCallback(() => setNodes((count) => count + 1), []);
  const pageRef = useCallback(
    (node: HTMLDivElement | null) => {
      page.current = node;
      bump();
    },
    [bump],
  );
  const anchorRef = useCallback(
    (node: HTMLElement | null) => {
      anchor.current = node;
      bump();
    },
    [bump],
  );
  const sectionRef = useCallback(
    (node: HTMLElement | null) => {
      section.current = node;
      bump();
    },
    [bump],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const trigger = anchor.current;
    if (!trigger || typeof IntersectionObserver === "undefined") return undefined;

    let observer: IntersectionObserver | null = null;
    const watch = () => {
      observer?.disconnect();
      /*
       * The line is MEASURED off the top bar rather than restated as a number.
       * That bar is 71px on a desktop and 64px under 430px, and between those
       * two widths its height and the `--mobile-topbar-height` token do not
       * agree — a constant here would be flush at some widths and 7px out at
       * others. One reading feeds both the observer's threshold and the strip's
       * own `top`, so those two cannot disagree either.
       */
      const bar = document.querySelector(".portal-topbar");
      const line = Math.round(bar?.getBoundingClientRect().height ?? 71);
      page.current?.style.setProperty("--jobs-rail-top", `${line}px`);
      observer = new IntersectionObserver(
        ([entry]) => {
          /* Pinned or not, and nothing else. This used to put the cards back
             on the way up; the size is the reader's now, so a scroll in either
             direction leaves it exactly as they set it. */
          setStuck(!entry.isIntersecting);
        },
        { rootMargin: `-${line + 1}px 0px 0px 0px`, threshold: 0 },
      );
      observer.observe(trigger);
    };

    watch();
    window.addEventListener("resize", watch);
    return () => {
      window.removeEventListener("resize", watch);
      observer?.disconnect();
    };
  }, [enabled, nodes]);

  /*
   * The expanded height, measured.
   *
   * It cannot be written down: the cards are six across at 1440, three across
   * in two rows under 1380 and a horizontal scroller under 760, so "the height
   * of the expanded section" is three numbers today and would be a fourth the
   * next time the grid is tuned. The observer runs only while the section is
   * expanded, which is the only time the height it reads means anything.
   */
  useEffect(() => {
    const element = section.current;
    const column = page.current;
    if (!enabled || !element || !column || collapsed) return undefined;
    const record = () => {
      /*
       * The class, not the React state. A ResizeObserver delivers its callback
       * straight after layout while React runs an effect's cleanup after paint,
       * so the collapse fires this observer once more before it is
       * disconnected — and without this guard the "natural" height recorded was
       * 46px: the strip's own. The margin then computed to zero, the page
       * shrank after all, and the oscillation this exists to prevent came back.
       */
      if (element.classList.contains("is-collapsed")) return;
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) column.style.setProperty("--jobs-rail-natural", `${height}px`);
    };
    record();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(record);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed, enabled, nodes]);

  return {
    pageRef,
    railState: enabled ? (collapsed ? "on" : "open") : "off",
    anchorRef,
    sectionRef,
    /*
     * Two classes, not one. `is-stuck` is true whenever the section is pinned,
     * including while a reader has expanded it back to the full cards, and it
     * is what gives the section an opaque ground: pinned without one, the board
     * rows scrolling underneath showed through the gaps between the six cards.
     * `is-collapsed` is the strip proper.
     */
    sectionClassName: `analytics-metric-grid analytics-metric-grid--six live-job-metrics${
      stuck ? " is-stuck" : ""
    }${collapsed ? " is-collapsed" : ""}`,
    collapsed,
    stuck,
    toggle: () => setExpanded((current) => !current),
  };
}

/**
 * The one control the strip adds.
 *
 * Always rendered, because the strip is now the resting state at every scroll
 * position and this is the only way to the detail. Expanded, it is taken out of
 * flow by the CSS, so it is never a seventh cell in a six-column grid.
 *
 * It restores the cards IN PLACE rather than scrolling to them. On a phone the
 * top of this page is eighty-nine thousand pixels away, and a control that
 * answers "show me the detail" by throwing away the reader's position in a
 * 745-card list has not answered it.
 */
export function JobsMeterToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show meter detail" : "Collapse meters";
  return (
    <button
      className="live-job-metrics__toggle"
      type="button"
      aria-expanded={!collapsed}
      /* Named on the element, because the strip drops the words on a phone —
         171px of button on a 390px screen is most of the room the six figures
         need — and an icon on its own says nothing. */
      aria-label={label}
      onClick={onToggle}
    >
      <Icon name="chevron" size={15} />
      <span>{label}</span>
    </button>
  );
}
