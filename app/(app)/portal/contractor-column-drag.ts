"use client";

/**
 * W13 — DRAGGING A CONTRACTOR-REGISTER HEADER TO A NEW PLACE.
 *
 * The owner asked for the register's columns to be reorderable "by holding and
 * dragging the header", not only through the Move left / Move right items in
 * the header menu. This is the gesture half of that: refs, one piece of state,
 * and the five pointer handlers a `<th>` hangs on.
 *
 * ── WHY THIS IS NOT A THIRD DRAG IMPLEMENTATION ──────────────────────────
 *
 * The ARITHMETIC is imported from `board-column-drag.ts` and not re-derived
 * here. That module is pure, is tested against numbers, and already answers the
 * three questions this gesture has:
 *
 *   `columnDropIndex`   — which gap the pointer is over, compared against each
 *                         header's MIDPOINT so the indicator flips when the
 *                         pointer crosses the middle of a column rather than
 *                         when it leaves the previous one;
 *   `columnDropMarker`  — which header the indicator is drawn on and which side
 *                         of it, and null when the drop would change nothing;
 *   `COLUMN_DRAG_THRESHOLD` — the four pixels that keep a click a click.
 *
 * Those three are generic over `{ column: { id: string } }`, so a register
 * column is adapted to them with one `.map` in the caller rather than by
 * widening anything in the board's files. `moveColumnTo` is deliberately NOT
 * used: the register persists a TOTAL order over every column, hidden ones
 * included, and `orderAfterMove` in `register-client.ts` is the function that
 * knows how to splice into that list without disturbing the columns nobody can
 * see. Two ideas of what a reorder is would be the whole point of this comment.
 *
 * ── WHY IT IS A SEPARATE FILE FROM `board-column-drag-gesture.ts` ────────
 *
 * That hook is welded to the board: it is typed to `BoardDisplayColumn`, it
 * looks for a `.live-board-scroll` scroller by class name, and it reads the
 * board's `loading` flag. Making it serve both surfaces means at minimum a
 * scroller SELECTOR parameter and a structural type in place of
 * `BoardDisplayColumn` — a change in a file this workstream does not own. The
 * proposal for that consolidation is written up in the handover; until it is
 * made, this file is deliberately a close sibling and the shared part is the
 * arithmetic, which is where the bugs actually live.
 *
 * ── WHY POINTER EVENTS AND NOT HTML5 DRAG-AND-DROP ──────────────────────
 *
 * The same reason `board-column-drag.ts` gives, plus one of this table's own:
 * the header carries a `…` menu button and a resize separator, and the resize
 * separator ALREADY owns `pointerdown`. A native `dragstart` would fight it for
 * the same press. Here there is one owner of the gesture and one place that
 * says which children it must not swallow — see `DRAG_IGNORE_SELECTOR`.
 */

import { useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  COLUMN_DRAG_THRESHOLD,
  columnDropIndex,
  columnDropMarker,
  type ColumnBox,
  type ColumnDropMarker,
} from "./board-column-drag";

/**
 * The header children a press must NOT be read as the start of a drag.
 *
 * The resize separator, because it has its own `pointerdown` and a drag that
 * also resized would be two gestures on one press. The menu anchor, because the
 * `…` button opens a popover on `click` and a 4px twitch while pressing it
 * would otherwise eat that click — the popover would appear not to open, which
 * is the least debuggable class of "it does nothing".
 *
 * The TITLE is not here. It is most of the cell, and a grab area with a hole in
 * the middle of it is not one a person can use.
 */
const DRAG_IGNORE_SELECTOR =
  ".contractor-register__resize, .contractor-register__menu-anchor, [data-column-drag-ignore]";

/** What the drag is doing right now, for the table to draw. */
export type RegisterColumnDragState = {
  /** The register column being carried, by its database id. */
  columnId: string;
  /** The gap it would land in, as an index into the CURRENT drawn order. */
  insertBefore: number;
  /** Which header the insertion line is painted on, and which side. */
  marker: ColumnDropMarker;
} | null;

export type RegisterColumnDragHandlers = {
  drag: RegisterColumnDragState;
  /** True while a press has travelled far enough to be a drag. */
  dragging: boolean;
  onHeaderPointerDown: (
    columnId: string,
    event: ReactPointerEvent<HTMLTableCellElement>,
  ) => void;
  onHeaderPointerMove: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onHeaderPointerUp: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onHeaderPointerCancel: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onHeaderClickCapture: (event: ReactMouseEvent<HTMLTableCellElement>) => void;
};

/**
 * Nudge the register sideways when a drag reaches its edge.
 *
 * Without this a column can only be carried as far as the visible width, and
 * this table is thirty-one columns wide on a seeded organisation — about a
 * fifth of it fits at 1440. Same shape as the board's `autoScrollColumns`; the
 * scroller is passed in rather than found by class name, because this table's
 * is a `.table-scroll` and the board's is a `.live-board-scroll`, and hunting
 * for either by name is exactly what makes a gesture unshareable.
 */
function nudgeScroller(scroller: HTMLElement | null, pointerX: number) {
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const edge = 64;
  if (pointerX < box.left + edge) {
    scroller.scrollLeft -= Math.max(8, (box.left + edge - pointerX) / 2);
  } else if (pointerX > box.right - edge) {
    scroller.scrollLeft += Math.max(8, (pointerX - (box.right - edge)) / 2);
  }
}

export function useRegisterColumnDrag({
  /**
   * The lanes on screen, in the order they are drawn, adapted to the shape the
   * board's pure helpers take. `column.id` is the register column's database
   * id, which is what `onDrop` is answered with.
   */
  order,
  /** False while the snapshot has not landed, or while the reader may not configure. */
  enabled,
  /** Which column ids may not be picked up — the frozen lane, and measurements. */
  immovable,
  /** The horizontally scrolling ancestor to nudge at the edges. */
  scrollerSelector = ".table-scroll",
  /** `columnId` was dropped into the gap at `insertBefore`. Save it. */
  onDrop,
}: {
  /*
   * MUTABLE rather than `readonly`, and not by preference. `columnDropMarker`
   * in `board-column-drag.ts` is generic over `T[]`; it only ever reads, but
   * the signature was written before anything needed to pass it a frozen list,
   * and widening it there is a change in a file this workstream does not own.
   * Taking the array as it is declared costs nothing here and keeps the two
   * modules connected by a type rather than by a cast.
   */
  order: { column: { id: string } }[];
  enabled: boolean;
  immovable?: (columnId: string) => boolean;
  scrollerSelector?: string;
  onDrop: (columnId: string, insertBefore: number) => void;
}): RegisterColumnDragHandlers {
  const dragRef = useRef<{
    pointerId: number;
    columnId: string;
    startX: number;
    active: boolean;
    element: HTMLTableCellElement;
    /** Every header in the row the drag started in, measured once. */
    boxes: ColumnBox[];
    scroller: HTMLElement | null;
  } | null>(null);

  /**
   * Set when a drag completes, cleared by the click that follows it.
   *
   * The browser fires a `click` after every press-and-release, including one
   * that travelled 300px. Without this the drop would ALSO be a click on
   * whatever the press started on — and on this table the whole row is a press
   * that opens a contractor, so a header drag that leaked a click would open a
   * profile. A ref rather than state: it is consumed by the very next event and
   * must not cost a render.
   */
  const suppressClickRef = useRef(false);

  /**
   * Written only when the drop index CHANGES, not on every pointer move.
   *
   * Thirty-one headers and up to a few hundred cells re-render on each write.
   * The board learned this the expensive way — see the note on `columnDrag` in
   * `board-column-drag-gesture.ts` — and the same rule is why this feels
   * attached to the pointer rather than a frame behind it.
   */
  const [drag, setDrag] = useState<RegisterColumnDragState>(null);

  const onHeaderPointerDown = (
    columnId: string,
    event: ReactPointerEvent<HTMLTableCellElement>,
  ) => {
    if (!enabled) return;
    if (!event.isPrimary || event.button !== 0) return;
    /*
     * TOUCH IS DELIBERATELY EXCLUDED, and this is the same call the board made.
     *
     * Swallowing touch on the header would cost the horizontal scroll that is
     * the ONLY way a phone reads a thirty-one-column table, and this table also
     * stops being a table below 767px — `.analytics-table--mobile-cards` turns
     * the body into cards and hides `thead` outright, so there is no header to
     * press. Move left / Move right in the header menu is the reliable route on
     * touch, and it is untouched by any of this.
     */
    if (event.pointerType === "touch") return;
    if (immovable?.(columnId)) return;
    if (
      event.target instanceof Element &&
      event.target.closest(DRAG_IGNORE_SELECTOR)
    ) {
      return;
    }
    const row = event.currentTarget.parentElement;
    if (!row) return;
    const boxes: ColumnBox[] = [
      ...row.querySelectorAll<HTMLElement>("th[data-column-id]"),
    ]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.dataset.columnId ?? "", left: rect.left, right: rect.right };
      })
      .filter((box) => box.id);
    // Nothing to reorder against. Two is the smallest table where a drop can
    // mean anything at all.
    if (boxes.length < 2) return;

    dragRef.current = {
      pointerId: event.pointerId,
      columnId,
      startX: event.clientX,
      active: false,
      element: event.currentTarget,
      boxes,
      scroller: event.currentTarget.closest<HTMLElement>(scrollerSelector),
    };
  };

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;

    if (!current.active) {
      // A press that has not travelled far enough is still a press, and the
      // header's own controls must behave exactly as they always have.
      if (Math.abs(event.clientX - current.startX) < COLUMN_DRAG_THRESHOLD) return;
      // The button came up somewhere this element never heard about.
      if (event.buttons !== 1) {
        dragRef.current = null;
        return;
      }
      current.active = true;
      try {
        current.element.setPointerCapture(current.pointerId);
      } catch {
        // The pointer may already have ended; the move below still works.
      }
      document.body.classList.add("is-dragging-register-column");
    }

    // Selecting the header text mid-drag leaves a blue smear behind the gesture
    // and on some browsers cancels the pointer capture outright.
    event.preventDefault();
    nudgeScroller(current.scroller, event.clientX);

    const insertBefore = columnDropIndex(event.clientX, current.boxes);
    setDrag((live) => {
      if (live && live.insertBefore === insertBefore) return live;
      return {
        columnId: current.columnId,
        insertBefore,
        marker: columnDropMarker(order, current.columnId, insertBefore),
      };
    });
  };

  const endDrag = () => {
    const current = dragRef.current;
    dragRef.current = null;
    document.body.classList.remove("is-dragging-register-column");
    setDrag(null);
    if (current?.active) {
      try {
        current.element.releasePointerCapture(current.pointerId);
      } catch {
        // Already released with the pointer.
      }
    }
    return current;
  };

  const onHeaderPointerUp = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const insertBefore = current.active
      ? columnDropIndex(event.clientX, current.boxes)
      : -1;
    const columnId = current.columnId;
    const wasActive = current.active;
    endDrag();
    if (!wasActive || insertBefore < 0) return;

    /*
     * A completed drag must not also read as a click. On this table that is not
     * a nicety: the row's own handler opens the contractor's profile.
     */
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;

    onDrop(columnId, insertBefore);
  };

  const onHeaderPointerCancel = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDrag();
  };

  /** Eats exactly one click, the one the browser fires after a drop. */
  const onHeaderClickCapture = (event: ReactMouseEvent<HTMLTableCellElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    drag,
    dragging: drag !== null,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
    onHeaderPointerCancel,
    onHeaderClickCapture,
  };
}
