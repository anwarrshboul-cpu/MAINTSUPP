"use client";

/**
 * ONE COLUMN HEADER ROW ON A PHONE, AND IT SAYS WHICH GROUP YOU ARE IN.
 *
 * The board renders one `<table>` per group, each with its own `<thead>`. On a
 * desktop that is invisible — a group is tall, and its header row is pinned at
 * the top of the scroller while you read it. On a phone it is 38px of column
 * headings repeated for every group on the board, stacked with a 42px group
 * bar above each one, on a viewport that has roughly 400px of grid to spend.
 * Scroll through four groups and you have paid 320px for the same eight words.
 *
 * monday's phone board does not do that. It draws the column headings ONCE,
 * pins them, and puts the name of the group you are currently looking at in
 * the frozen left-hand cell where the desktop writes "Item". The group bars
 * stay in the flow as thin dividers, so you can still see where one group ends
 * and the next begins, but you never see the word "Location" twice.
 *
 * This module is that row. Two exports, and they are a pair:
 *
 *   - `BoardColumnWidths` puts the widths in a `<colgroup>` so the per-group
 *     `<thead>` can be hidden without collapsing the table.
 *   - `MobileBoardStickyHeader` draws the single row.
 *
 * WHY THE COLGROUP IS NOT OPTIONAL. `.live-sheet` is `table-layout: fixed`,
 * and a fixed table takes its column widths from the first row — which is the
 * header row. Body cells carry no width of their own; only `<th>` and the
 * summary row do. So `display: none` on `thead` does not hide a header, it
 * destroys the grid: every column falls back to an equal share and a
 * 170px-wide attachment cell lands wherever it lands. Moving the same widths
 * into a `<col>` gives the table a source of truth that survives the header
 * being hidden, and because both are computed by `displayedBoardColumnWidth`
 * there is exactly one rule for how wide a column is.
 *
 * WHY A SCROLL HANDLER AND NOT AN IntersectionObserver. The question this row
 * answers is "which group is under the header line right now", which is a
 * question about one specific y-coordinate. An observer answers "how much of
 * this element is visible", which is a different question that needs a
 * threshold guessed per group height, and which reports nothing at all while a
 * group taller than the viewport is the only thing on screen — the exact case
 * the label matters most. Reading positions against the line is direct, and
 * costs one `getBoundingClientRect` per group per animation frame, on the four
 * to twelve groups a board actually has.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { displayedBoardColumnWidth } from "./board-format";
import type { BoardDisplayColumn } from "./board-model";
import type { MaintenanceGroup } from "../../lib/types";

/** The select-all gutter, `.sheet-check` in globals.css. */
const GUTTER_WIDTH = 38;
/** The trailing "+" cell, `.sheet-add-column` in globals.css. */
const ADD_COLUMN_WIDTH = 146;

/**
 * The widths, as a `<colgroup>`, for one board table.
 *
 * Rendered on every group table at every width — not only on a phone. A fixed
 * table that states its widths twice, identically, is not doing extra work;
 * a fixed table that states them in a row it is about to hide is broken. See
 * the note at the top of this file.
 */
export function BoardColumnWidths({
  columns,
  mobile,
}: {
  columns: BoardDisplayColumn[];
  mobile: boolean;
}) {
  return (
    <colgroup>
      <col style={{ width: GUTTER_WIDTH }} />
      {columns.map((entry) => (
        <col
          key={entry.column.id}
          style={{ width: displayedBoardColumnWidth(entry.column, mobile) }}
        />
      ))}
      <col style={{ width: ADD_COLUMN_WIDTH }} />
    </colgroup>
  );
}

/**
 * Which group sits under the header line, tracked while the board scrolls.
 *
 * Returns the id of the last group whose top edge has passed the line, which
 * is the group whose rows the reader is actually looking at. Before the first
 * group reaches the line — at the very top of the board — it returns the first
 * group, because "no group" is never the honest answer while rows are visible.
 *
 * The element list is read from the DOM rather than passed in as refs: the
 * board already stamps `data-board-group-id` on every group section for the
 * drag machinery, and borrowing it keeps this hook from adding a second
 * bookkeeping path through `live-board.tsx`, which has no room for one.
 */
function useGroupUnderHeader(
  rowRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  groupIds: string[],
): string | null {
  const [currentId, setCurrentId] = useState<string | null>(groupIds[0] ?? null);
  /*
   * The ids, readable from the scroll handler without making the handler a
   * new function on every render — which would re-subscribe the listener on
   * every scroll frame it caused.
   */
  const idsRef = useRef(groupIds);
  /*
   * Kept current in a LAYOUT effect, and declared BEFORE every effect that
   * reads it. Both halves of that sentence are load-bearing.
   *
   * A ref written during render is a side effect in a function React may call
   * more than once, which the compiler lint rejects — hence an effect. But the
   * first attempt used `useEffect`, and layout effects run before passive
   * ones: on the render where the groups first arrive, the measuring layout
   * effect below ran while this ref still held the PREVIOUS list, so the row
   * named whichever group had been first a render ago. On a board whose first
   * group had changed, it named the wrong one until the reader scrolled.
   *
   * `useLayoutEffect` here, declared first, means it is current before
   * anything measures. React runs layout effects in declaration order.
   */
  useLayoutEffect(() => {
    idsRef.current = groupIds;
  });

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const scroller = row.closest(".live-board-scroll");
    if (!scroller) return;
    /*
     * The line is the BOTTOM of the sticky row, not the top of the scroller.
     * A group whose bar has slid under the header is no longer the one being
     * read, and judging against the scroller's top edge names it for the 38px
     * it spends hidden behind the very row that is supposed to be naming its
     * successor.
     */
    const line = row.getBoundingClientRect().bottom;
    let found: string | null = idsRef.current[0] ?? null;
    for (const id of idsRef.current) {
      const section = scroller.querySelector(`[data-board-group-id="${id}"]`);
      if (!section) continue;
      const box = section.getBoundingClientRect();
      if (box.top <= line) found = id;
      /*
       * Groups are in document order, so the first one starting below the
       * line settles it and the rest cannot change the answer. On a board of
       * 38 groups this is what keeps the handler O(visible) rather than O(all).
       */
      else break;
    }
    setCurrentId((previous) => (previous === found ? previous : found));
  }, [rowRef]);

  useEffect(() => {
    if (!active) return;
    const row = rowRef.current;
    const scroller = row?.closest(".live-board-scroll");
    if (!scroller) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    /*
     * Collapsing a group, adding a row and filtering all move the boundaries
     * without scrolling anything. A resize observer on the canvas catches all
     * three for the price of one subscription.
     */
    const canvas = scroller.querySelector(".live-board-canvas");
    const observer = canvas ? new ResizeObserver(onScroll) : null;
    if (canvas && observer) observer.observe(canvas);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [active, measure, rowRef]);

  /*
   * Re-measure when the set of groups changes. `useLayoutEffect` rather than
   * `useEffect` so a filter that empties the group being named does not paint
   * one frame with a stale name over the rows that replaced it.
   */
  useLayoutEffect(() => {
    if (active) measure();
  }, [active, measure, groupIds.length]);

  return currentId;
}

/**
 * The single sticky header row for the phone board.
 *
 * Renders nothing at all when `active` is false, so the desktop board is
 * untouched — no extra element, no extra listener, no extra stacking context
 * near the grid's own carefully ordered sticky columns.
 *
 * It is a `<table>` rather than a row of `<div>`s so that the same
 * `table-layout: fixed` + `<colgroup>` arithmetic that lays out the group
 * tables lays out this row, with the same numbers from the same function. A
 * flex row would be a second layout model that has to be kept in agreement
 * with the first by hand, and column widths are editable by the user.
 */
export function MobileBoardStickyHeader({
  active,
  columns,
  groups,
}: {
  /** True only on a phone. The desktop board renders no part of this. */
  active: boolean;
  columns: BoardDisplayColumn[];
  groups: MaintenanceGroup[];
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const currentId = useGroupUnderHeader(
    rowRef,
    active,
    groups.map((group) => group.id),
  );

  if (!active || columns.length === 0) return null;

  const current = groups.find((group) => group.id === currentId) ?? groups[0];
  /*
   * WHICH CELL GETS THE GROUP NAME — the frozen one, not the first one.
   *
   * Columns are ordered by the user's stored `position`, and the Items column
   * is only first until somebody drags something in front of it. The cell that
   * is pinned to the left edge on a phone is chosen by class, not by index:
   * `.sheet-column--name` is what globals.css freezes. Naming the group in any
   * other cell would put it off-screen the moment the reader scrolled sideways
   * — which is most of the time, on a phone, on a board this wide.
   */
  const nameIndex = Math.max(
    columns.findIndex((entry) => entry.kind === "system" && entry.key === "name"),
    0,
  );

  return (
    <div className="board-mobile-head" ref={rowRef} aria-hidden="true">
      <table className="live-sheet board-mobile-head__grid">
        <BoardColumnWidths columns={columns} mobile />
        <thead>
          <tr>
            <th className="board-mobile-head__gutter" />
            {columns.map((entry, index) => {
              const naming = index === nameIndex && Boolean(current);
              const label = naming ? current.name : entry.column.title;
              return (
                <th
                  key={entry.column.id}
                  className={
                    naming
                      ? "sheet-column--name board-mobile-head__group"
                      : "board-mobile-head__col"
                  }
                  style={
                    naming
                      ? ({ "--group-color": current.color } as CSSProperties)
                      : undefined
                  }
                >
                  <span title={label}>{label}</span>
                </th>
              );
            })}
            <th className="board-mobile-head__spacer" />
          </tr>
        </thead>
      </table>
    </div>
  );
}
