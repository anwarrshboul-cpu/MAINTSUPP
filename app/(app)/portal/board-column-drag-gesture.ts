"use client";

/**
 * The column-header drag, as a gesture: refs, state and the four pointer
 * handlers the header cell hangs on.
 *
 * WHY IT IS A FILE AND NOT A HUNDRED LINES OF live-board.tsx.
 *
 * `stage-eight-board-split.test.mjs` holds live-board.tsx under 6,000 lines,
 * and this gesture is what pushed it over. It is also a good seam on its own
 * terms: everything here is one interaction, it reaches for exactly three
 * things from the board — the columns on screen, whether the snapshot has
 * landed, and where to send a new order — and it answers with six handlers and
 * one piece of state. Nothing else in the board can perturb it.
 *
 * The arithmetic is next door in `board-column-drag.ts`, which is pure and
 * tested against numbers. This file is the part that needs a DOM: measuring,
 * capturing the pointer, nudging the scroller, and deciding when a press has
 * become a drag. Read that file's header first — it is where the reason this
 * is not HTML5 drag-and-drop is written down.
 */

import { useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { BoardDisplayColumn } from "./board-model";
import {
  COLUMN_DRAG_THRESHOLD,
  columnDropIndex,
  columnDropMarker,
  moveColumnTo,
  type ColumnBox,
  type ColumnDropMarker,
} from "./board-column-drag";

/** What the drag is doing right now, for the board to draw. */
export type ColumnDragState = {
  columnId: string;
  insertBefore: number;
  marker: ColumnDropMarker;
} | null;

export type ColumnDragHandlers = {
  columnDrag: ColumnDragState;
  onColumnPointerDown: (
    entry: BoardDisplayColumn,
    event: ReactPointerEvent<HTMLTableCellElement>,
  ) => void;
  onColumnPointerMove: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnPointerUp: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnPointerCancel: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnClickCapture: (event: ReactMouseEvent<HTMLTableCellElement>) => void;
};

/**
 * Nudge the board sideways when a drag reaches its edge.
 *
 * Without this a column can only be moved as far as the visible width, which on
 * a 26-column board is about a third of it.
 */
function autoScrollColumns(scroller: HTMLElement | null, pointerX: number) {
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const edge = 64;
  if (pointerX < box.left + edge) {
    scroller.scrollLeft -= Math.max(8, (box.left + edge - pointerX) / 2);
  } else if (pointerX > box.right - edge) {
    scroller.scrollLeft += Math.max(8, (pointerX - (box.right - edge)) / 2);
  }
}

export function useColumnHeaderDrag({
  columns,
  loading,
  onReorder,
}: {
  /** The columns on screen, in the order they are drawn. */
  columns: BoardDisplayColumn[];
  /** True while the board is still drawing the client-side fallback. */
  loading: boolean;
  /** Given a new order, save it. The board owns what "save" means. */
  onReorder: (order: BoardDisplayColumn[]) => void;
}): ColumnDragHandlers {
  const dragRef = useRef<{
    pointerId: number;
    columnId: string;
    startX: number;
    active: boolean;
    element: HTMLTableCellElement;
    /** Every header in the row the drag started in, measured once. */
    boxes: ColumnBox[];
    /** The scroller to nudge when the pointer reaches the edge of the board. */
    scroller: HTMLElement | null;
  } | null>(null);

  /**
   * Set when a drag completes, cleared by the click that follows it.
   *
   * The browser dispatches a `click` after every press-and-release, including
   * one that travelled 300px across the board. If the press began on the sort
   * arrow — which it will, because that arrow covers the middle of a narrow
   * header — that click would sort the column the drag just moved. A ref rather
   * than state: it is consumed by the very next event and must not cost a
   * render.
   */
  const suppressClickRef = useRef(false);

  /**
   * What the drag is doing, as one piece of state.
   *
   * One object rather than two so a move that changes both the marker and the
   * dragged column is a single render. It is written ONLY when the drop index
   * changes: the board draws 1,102 header cells, and setting state on every
   * pointer move re-rendered all of them sixty times a second, which is what
   * made the first attempt feel broken even where it fired.
   */
  const [columnDrag, setColumnDrag] = useState<ColumnDragState>(null);

  /**
   * A press on a column header.
   *
   * Records where it started and nothing else — a press is a click until it has
   * moved far enough to be a drag. Touch is deliberately excluded: making the
   * header swallow touch gestures would cost the horizontal scroll that is how
   * a phone reads this board at all, and Move left / Move right in the column
   * menu is the reliable route there.
   */
  const onColumnPointerDown = (
    entry: BoardDisplayColumn,
    event: ReactPointerEvent<HTMLTableCellElement>,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (event.pointerType === "touch") return;
    /*
     * NOT WHILE THE BOARD IS STILL SYNCING.
     *
     * Until the snapshot lands the grid is drawn from `fallbackSystemColumns`,
     * whose ids are invented client-side (`column-system-tier`) and match no
     * row in the database. A drag in that window would send those invented ids
     * to the order endpoint, which cannot place them, and the snapshot would
     * then arrive and put the column back — a reorder that visibly undoes
     * itself, which is one of the ways this was reported as not working. The
     * board already says "Syncing board" while this is true, and the header
     * takes a waiting cursor to match.
     */
    if (loading) return;
    /*
     * Only the resize handle and an open menu are excluded. The sort arrow and
     * the `…` button are NOT: they sit at the right of a flex row with
     * `margin-left: auto`, so on a narrow column they cover the middle of the
     * header, and a grab area with a hole in the middle of it is not one a
     * person can use. A press on either still starts a drag; a press that never
     * moves is a click and does exactly what the button says.
     */
    if (
      event.target instanceof Element &&
      event.target.closest("[data-column-drag-ignore]")
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
    if (boxes.length < 2) return;

    dragRef.current = {
      pointerId: event.pointerId,
      columnId: entry.column.id,
      startX: event.clientX,
      active: false,
      element: event.currentTarget,
      boxes,
      scroller: event.currentTarget.closest<HTMLElement>(".live-board-scroll"),
    };
  };

  const onColumnPointerMove = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.active) {
      // A press that has not travelled far enough is still a press, and the
      // header's own controls must keep behaving exactly as they always have.
      if (Math.abs(event.clientX - drag.startX) < COLUMN_DRAG_THRESHOLD) return;
      if (event.buttons !== 1) {
        dragRef.current = null;
        return;
      }
      drag.active = true;
      try {
        drag.element.setPointerCapture(drag.pointerId);
      } catch {
        // The pointer may already have ended; the move below still works.
      }
      document.body.classList.add("is-dragging-board-column");
    }

    // Selecting the header text mid-drag would leave a blue smear behind the
    // gesture, and on some browsers cancels the pointer capture outright.
    event.preventDefault();
    autoScrollColumns(drag.scroller, event.clientX);

    const insertBefore = columnDropIndex(event.clientX, drag.boxes);
    setColumnDrag((current) => {
      if (current && current.insertBefore === insertBefore) return current;
      return {
        columnId: drag.columnId,
        insertBefore,
        marker: columnDropMarker(columns, drag.columnId, insertBefore),
      };
    });
  };

  const endColumnDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    document.body.classList.remove("is-dragging-board-column");
    setColumnDrag(null);
    if (drag?.active) {
      try {
        drag.element.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released with the pointer.
      }
    }
    return drag;
  };

  const onColumnPointerUp = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const insertBefore = drag.active ? columnDropIndex(event.clientX, drag.boxes) : -1;
    const columnId = drag.columnId;
    const wasActive = drag.active;
    endColumnDrag();
    if (!wasActive || insertBefore < 0) return;

    /*
     * A completed drag must not also read as a click — this is the whole reason
     * a drop does not sort the column it just moved, given that the press very
     * often begins on the sort arrow.
     */
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = true;

    const requested = moveColumnTo(columns, columnId, insertBefore);
    if (requested === columns) return;
    onReorder(requested);
  };

  const onColumnPointerCancel = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endColumnDrag();
  };

  /** Eats exactly one click, the one the browser fires after a drop. */
  const onColumnClickCapture = (event: ReactMouseEvent<HTMLTableCellElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    columnDrag,
    onColumnPointerDown,
    onColumnPointerMove,
    onColumnPointerUp,
    onColumnPointerCancel,
    onColumnClickCapture,
  };
}
