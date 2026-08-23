"use client";

/**
 * The row drag, as a gesture: the refs, the four pointer handlers, the lifted
 * preview and the loop that carries it.
 *
 * The arithmetic is next door in `board-row-drag.ts`, and the reason this stopped
 * being a hold timer inside `live-board.tsx` is written at the top of that file.
 * Read it first. What follows is the part that needs a DOM, and it is built
 * around three claims that are each worth stating before the code.
 *
 * ONE: A FINGER ON A ROW IS A SCROLL, AND NOTHING HERE IS ALLOWED TO ARGUE.
 *
 * `preventDefault()` on a pointermove — which is what the old code did on every
 * single move — does not stop the compositor scrolling, and neither does a
 * non-passive `touchmove` listener added once a hold timer has fired: by then
 * Chrome has already marked the sequence non-blocking and the event is not
 * cancelable. Both were built and both were measured; the evidence is written
 * out under `THE TOUCH STORY` in `board-row-drag.ts`. So a touch that did not
 * begin on a handle is not merely ignored, it is never recorded at all —
 * `onRowPointerDown` returns before it allocates anything — and every pixel of
 * the resulting pan is handled by the compositor with no main-thread listener
 * anywhere in its path. The handle is the only touch drag, and it works because
 * `touch-action: none` is a promise made before the finger lands rather than an
 * argument had after it.
 *
 * TWO: A POINTERMOVE MUST NOT TOUCH THE DOM.
 *
 * Resolving a drop target costs an `elementFromPoint`, which forces a layout
 * flush. The old code did that on every pointermove, and moved the board by a
 * flat 24px in the same breath, so a drag along a row was a sequence of forced
 * layouts interleaved with scroll writes — a read/write/read/write thrash, once
 * per sample, at whatever rate the browser chose to sample. Here a pointermove
 * writes two numbers to a ref and returns. Everything that reads or writes the
 * DOM happens once per animation frame, in the loop below, in one order: read
 * the scroller box, write the scroll, hit-test, move the preview.
 *
 * THREE: THE PREVIEW IS NOT REACT.
 *
 * The board draws tens of thousands of cells. A preview positioned from React
 * state would re-render all of them sixty times a second, which is the same
 * mistake the column drag documents having made. The lifted row is a plain
 * element appended to `document.body` and moved by writing `style.transform`,
 * so carrying a row across the board costs no renders at all. `document.body`
 * rather than anywhere inside the grid is deliberate: `.sheet-group.is-deferred`
 * carries `content-visibility: auto` and `contain-intrinsic-size`, which makes
 * it a containment root — a fixed-position child of one is positioned against
 * the GROUP, not the viewport, and would be clipped away the moment the group
 * scrolled out of view.
 *
 * React state is written exactly twice per drag — once when it starts, once
 * when it ends — plus once per CHANGE of drop target, which is what draws the
 * indicator.
 */

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { BoardDragItem, BoardDropTarget } from "./board-model";
import {
  edgeScrollVector,
  ghostOffset,
  rowDragDecision,
  rowDropTargetFrom,
  sameDropTarget,
  type RowHit,
} from "./board-row-drag";

/**
 * Everything inside a row that a press must NOT lift the row by.
 *
 * The first entry is the marker the row menu and the two column menus already
 * carried. The rest is the fix for a complaint that read as "I cannot select
 * text in a cell" and "the keyboard closes as soon as I touch the field": a
 * press inside a form control was arming the drag, and once the drag armed it
 * swallowed the gesture the control needed. A control's own gesture is always
 * the one meant, so it always wins.
 */
const DRAG_IGNORE_SELECTOR =
  "[data-board-drag-ignore], input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * The opt-in grab affordance — the ONLY place a finger can start a drag.
 *
 * Two elements carry it: the gutter grip drawn on a phone, and the "⋮" row
 * actions button on a desktop. Both already declare `touch-action: none`, which
 * is what makes them safe; a press on either still has to clear the movement
 * threshold, because the "⋮" is a real button whose click opens the row menu.
 */
const DRAG_HANDLE_SELECTOR = "[data-board-row-handle]";

type RowDragPointer = {
  pointerId: number;
  pointerType: string;
  item: BoardDragItem;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  active: boolean;
  fromHandle: boolean;
  element: HTMLTableRowElement;
  scroller: HTMLElement | null;
  ghost: HTMLElement | null;
  grabX: number;
  grabY: number;
  frame: number | null;
  /** Set once the drop target has been recomputed for the current pointer position. */
  settled: boolean;
};

export type RowDragHandlers = {
  onRowPointerDown: (
    item: BoardDragItem,
    event: ReactPointerEvent<HTMLTableRowElement>,
  ) => void;
  /** True when the move was consumed by a drag, so the row can eat the click. */
  onRowPointerMove: (event: ReactPointerEvent<HTMLTableRowElement>) => boolean;
  onRowPointerUp: (event: ReactPointerEvent<HTMLTableRowElement>) => boolean;
  onRowPointerCancel: (event: ReactPointerEvent<HTMLTableRowElement>) => void;
};

/**
 * Belt and braces for a lifted drag: a second finger, or a browser that decided
 * the sequence was blocking after all, must not pan the board out from under a
 * row in the air. Registered only while a row is lifted, and a no-op on the
 * non-cancelable events Chrome hands us — `touch-action: none` on the handle is
 * what actually holds the pan off, and this cannot make things worse.
 */
function blockTouchScroll(event: TouchEvent) {
  if (event.cancelable) event.preventDefault();
}

/**
 * The lifted row, built once at activation.
 *
 * A copy of the row rather than the row itself: moving the real `<tr>` out of
 * its table would collapse the column widths of every group it belongs to, and
 * a `<tr>` is not something that can be positioned anyway. What is copied is
 * what the reference shows being carried — the item's name and its group's
 * colour — on a pale plate with a shadow, which is what makes it read as
 * floating ABOVE the grid lines rather than as another row among them.
 */
function createRowGhost(row: HTMLTableRowElement, width: number) {
  const dark = document.body.dataset.theme === "dark";
  const group = row.closest<HTMLElement>("[data-board-group-id]");
  const color = group
    ? getComputedStyle(group).getPropertyValue("--group-color").trim()
    : "";
  const name =
    row.querySelector<HTMLElement>(".sheet-column--name")?.textContent?.trim() ||
    row.dataset.boardRowId ||
    "";

  const ghost = document.createElement("div");
  ghost.className = "board-row-ghost";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "1400",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    boxSizing: "border-box",
    width: `${width}px`,
    height: `${Math.max(34, row.getBoundingClientRect().height)}px`,
    padding: "0 12px",
    borderRadius: "4px",
    borderLeft: `4px solid ${color || "#6b7f8f"}`,
    background: dark ? "#26364a" : "#e9eff5",
    color: dark ? "#dbe6f2" : "#33475a",
    font: "500 13px/1.2 inherit",
    boxShadow: dark
      ? "0 14px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08)"
      : "0 14px 30px rgba(7, 24, 38, 0.26), 0 0 0 1px rgba(7, 24, 38, 0.08)",
    pointerEvents: "none",
    userSelect: "none",
    willChange: "transform",
    // Hidden until the loop has placed it, so it never flashes at 0,0.
    opacity: "0",
    transform: "translate3d(-9999px, -9999px, 0)",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("span");
  Object.assign(label.style, {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  label.textContent = name;
  ghost.append(label);
  document.body.append(ghost);
  return ghost;
}

/**
 * One hit test, turned into numbers.
 *
 * The single forced layout in the whole gesture, and it happens at most once a
 * frame. `elementsFromPoint` is not used and neither is a cached row map: rows
 * move under the pointer as the board auto-scrolls, so the answer has to come
 * from where things actually are right now.
 */
type RowHitCache = {
  /** The box the answer is valid for; outside it, everything must be re-read. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  scrollLeft: number;
  scrollTop: number;
  hit: RowHit;
};

/** The row of `group` whose vertical band contains `clientY`, measured. */
function rowSpanning(group: HTMLElement, clientY: number): RowHit | null {
  const rows = group.querySelectorAll<HTMLElement>("tbody tr[data-board-row-id]");
  for (const [index, candidate] of rows.entries()) {
    const rect = candidate.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) continue;
    const next = rows[index + 1];
    lastHit = {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollLeft: 0,
      scrollTop: 0,
      hit: null as unknown as RowHit,
    };
    const hit: RowHit = {
      rowId: candidate.dataset.boardRowId ?? null,
      rowGroupId: candidate.dataset.boardRowGroupId ?? null,
      rowTop: rect.top,
      rowHeight: rect.height,
      nextRowId: next?.dataset.boardRowId ?? null,
      groupId: group.dataset.boardGroupId ?? null,
    };
    lastHit.hit = hit;
    return hit;
  }
  return null;
}

function hitTestRow(clientX: number, clientY: number): RowHit {
  const element = document.elementFromPoint(clientX, clientY);
  const row = element?.closest<HTMLElement>("[data-board-row-id]") ?? null;
  const group = element?.closest<HTMLElement>("[data-board-group-id]") ?? null;
  if (!row) {
    /*
     * THE HOLE THE LIFTED ROW LEAVES BEHIND.
     *
     * `.live-sheet tbody tr.is-dragging` carries `pointer-events: none`, so the
     * row being dragged is invisible to `elementFromPoint`: hover the gap it
     * came from and the answer is the `<table>`, not a row. Read naively that
     * says "this group, at the end", so picking a row up and putting it back
     * exactly where it was SENT IT TO THE BOTTOM OF ITS GROUP — a move nobody
     * asked for, a request nobody wanted, and an undo nobody had. Measured: one
     * PATCH for a drag that travelled 12px and came back.
     *
     * So a miss inside a group is answered geometrically instead. The rows of
     * ONE group are scanned for the band containing the pointer, which is at
     * most a couple of dozen rects and only on the miss path — over the add-item
     * row, or past the last row, nothing contains it and the answer really is
     * the end of the group.
     */
    const spanned = group ? rowSpanning(group, clientY) : null;
    if (spanned) return spanned;
    lastHit = null;
    return {
      rowId: null,
      rowGroupId: null,
      rowTop: 0,
      rowHeight: 0,
      nextRowId: null,
      groupId: group?.dataset.boardGroupId ?? null,
    };
  }
  const rect = row.getBoundingClientRect();
  lastHit = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    scrollLeft: 0,
    scrollTop: 0,
    hit: null as unknown as RowHit,
  };
  let sibling = row.nextElementSibling;
  while (sibling instanceof HTMLElement && !sibling.dataset.boardRowId) {
    sibling = sibling.nextElementSibling;
  }
  const hit: RowHit = {
    rowId: row.dataset.boardRowId ?? null,
    rowGroupId: row.dataset.boardRowGroupId ?? null,
    rowTop: rect.top,
    rowHeight: rect.height,
    nextRowId:
      sibling instanceof HTMLElement ? sibling.dataset.boardRowId ?? null : null,
    groupId: group?.dataset.boardGroupId ?? null,
  };
  lastHit.hit = hit;
  return hit;
}

/**
 * The same answer, without paying for it twice.
 *
 * `elementFromPoint` forces a layout flush and this board lays out 101,000
 * elements, so it is the single most expensive thing in the drag. But most
 * pointer movement during a drag is WITHIN one row — a hand is not steady, and
 * a 10px tremor cannot change which gap the drop lands in. So the box the last
 * answer came from is remembered, and while the pointer is still inside it and
 * the board has not scrolled underneath it, the answer is simply reused. Only
 * `clientY` is then re-applied, because which HALF of the row the pointer is in
 * is arithmetic, not a hit test.
 */
let lastHit: RowHitCache | null = null;

function hitTestRowCached(
  clientX: number,
  clientY: number,
  scroller: HTMLElement | null,
): RowHit {
  const scrollLeft = scroller?.scrollLeft ?? 0;
  const scrollTop = scroller?.scrollTop ?? 0;
  const cached = lastHit;
  if (
    cached &&
    cached.hit &&
    cached.scrollLeft === scrollLeft &&
    cached.scrollTop === scrollTop &&
    clientX >= cached.left &&
    clientX <= cached.right &&
    clientY >= cached.top &&
    clientY <= cached.bottom
  ) {
    return cached.hit;
  }
  const hit = hitTestRow(clientX, clientY);
  if (lastHit) {
    lastHit.scrollLeft = scrollLeft;
    lastHit.scrollTop = scrollTop;
  }
  return hit;
}

/** Forgets the memo, so a new drag never reads a box from the last one. */
function resetHitTest() {
  lastHit = null;
}

export function useBoardRowDrag({
  onDrop,
  onDragStart,
}: {
  /** Commit the move. The board owns what that means and how it is undone. */
  onDrop: (item: BoardDragItem, target: BoardDropTarget) => void;
  /** Fired once when a row lifts — the board uses it to shut its menus. */
  onDragStart?: () => void;
}): RowDragHandlers {
  const pointerRef = useRef<RowDragPointer | null>(null);
  const targetRef = useRef<BoardDropTarget | null>(null);
  /** The two elements currently carrying the indicator, so it can be lifted. */
  const paintedRef = useRef<{ row: HTMLElement | null; group: HTMLElement | null }>({
    row: null,
    group: null,
  });
  /*
   * THE GESTURE LIVES ON THE DOCUMENT, NOT ON THE ROW.
   *
   * The row's own React handlers can only see a pointer that is still over a
   * row, and a drag is mostly the opposite of that. Measured: press a row and
   * pull straight down past the end of its group, and the next seven moves land
   * on the add-item row, the group footer and the next group's header — none of
   * which is a `<tr>` — so not one `pointermove` reached the gesture and the row
   * did not lift until the pointer happened to cross another row 280px later.
   * The old code hid this behind its hold timer: the drag armed while the
   * pointer was still inside the row and `setPointerCapture` carried it from
   * there. With the timer gone, the arming move has to be heard from anywhere,
   * so these are attached at pointerdown and removed the moment the press ends.
   */
  const listenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
    key: (event: KeyboardEvent) => void;
  } | null>(null);
  /** True from the drop until the click it produces has been eaten. */
  const justDroppedRef = useRef(false);
  /**
   * THE DROP INDICATOR IS NOT REACT EITHER, AND THIS IS WHY.
   *
   * It was: one piece of state, written only when the gap CHANGED, which sounds
   * cheap and is not. The board draws 38 groups and ~101,000 elements, and a
   * drag that travels the length of a group crosses a dozen gaps — so a dozen
   * full re-renders. Measured in the dev build, dragging across twelve rows:
   * p95 frame 385ms and long tasks up to 517ms, against 27ms / 163ms for the
   * same pointer path with no drag at all. The indicator is two class names on
   * two elements, so it is drawn as two class names on two elements.
   *
   * The classes are the same ones the stylesheet already had — `.is-drop-before`
   * on the row and `.is-drop-target` / `.is-drop-at-end` on the group — so
   * nothing about how it LOOKS changed, and the browser tests that assert them
   * still assert exactly what a person sees.
   *
   * THE LIFTED ROW IS DRAWN THE SAME WAY, AND FOR A BIGGER REASON. Toggling
   * `.is-dragging` costs 75ms of style recalculation on its own — measured, and
   * see the note in `activate` — but re-rendering the board to decide WHICH row
   * gets it cost several hundred more, at the exact moment a person expects the
   * row to leave the ground. So the drag now writes no React state at all: not
   * one render between picking a row up and putting it down.
   */
  const paintDropTarget = useCallback((next: BoardDropTarget | null) => {
    const painted = paintedRef.current;
    const row =
      next && next.beforeRequestId
        ? document.querySelector<HTMLElement>(
            `tr[data-board-row-id="${CSS.escape(next.beforeRequestId)}"]`,
          )
        : null;
    const group = next
      ? document.querySelector<HTMLElement>(
          `.sheet-group[data-board-group-id="${CSS.escape(next.groupId)}"]`,
        )
      : null;
    if (painted.row && painted.row !== row) {
      painted.row.classList.remove("is-drop-before");
    }
    if (painted.group && painted.group !== group) {
      painted.group.classList.remove("is-drop-target", "is-drop-at-end");
    }
    painted.row = row;
    painted.group = group;
    row?.classList.add("is-drop-before");
    if (group) {
      group.classList.add("is-drop-target");
      group.classList.toggle("is-drop-at-end", next?.beforeRequestId === null);
    }
  }, []);

  /**
   * Put the indicator back if a render took it away.
   *
   * React owns the `className` of both elements and rewrites it whenever it
   * re-renders them with a different string — which happens once at the start
   * of every drag, when the source row gains `is-dragging`, and the source row
   * can also be the row the indicator sits on. One `classList.contains` per
   * frame buys immunity from the whole question.
   */
  const reassertDropTarget = useCallback(() => {
    const { row, group } = paintedRef.current;
    if (row && !row.classList.contains("is-drop-before")) {
      row.classList.add("is-drop-before");
    }
    if (group && !group.classList.contains("is-drop-target")) {
      group.classList.add("is-drop-target");
    }
    const lifted = pointerRef.current;
    if (lifted?.active && !lifted.element.classList.contains("is-dragging")) {
      lifted.element.classList.add("is-dragging");
    }
  }, []);

  /** Written only when the gap changes, and never to React. */
  const setDropTarget = useCallback(
    (next: BoardDropTarget | null) => {
      if (sameDropTarget(targetRef.current, next)) return;
      targetRef.current = next;
      paintDropTarget(next);
    },
    [paintDropTarget],
  );

  const teardown = useCallback(
    (pointer: RowDragPointer | null) => {
      const listeners = listenersRef.current;
      if (listeners) {
        document.removeEventListener("pointermove", listeners.move);
        document.removeEventListener("pointerup", listeners.up);
        document.removeEventListener("pointercancel", listeners.cancel);
        document.removeEventListener("keydown", listeners.key, true);
        listenersRef.current = null;
      }
      if (!pointer) return;
      if (pointer.frame !== null) window.cancelAnimationFrame(pointer.frame);
      pointer.ghost?.remove();
      if (pointer.active) {
        pointer.element.classList.remove("is-dragging");
        pointer.element.removeAttribute("aria-grabbed");
        document.removeEventListener("touchmove", blockTouchScroll);
        document.body.classList.remove("is-dragging-board-row");
        try {
          if (pointer.element.hasPointerCapture(pointer.pointerId)) {
            pointer.element.releasePointerCapture(pointer.pointerId);
          }
        } catch {
          // The pointer may already have ended; nothing left to release.
        }
      }
      pointer.frame = null;
      pointer.ghost = null;
      pointer.active = false;
    },
    [],
  );

  const clearDrag = useCallback(() => {
    teardown(pointerRef.current);
    pointerRef.current = null;
    resetHitTest();
    targetRef.current = null;
    paintDropTarget(null);
  }, [paintDropTarget, teardown]);

  /*
   * A drag that outlives its component would leave a preview stranded on the
   * body and a non-passive touch listener wedged on the document, which would
   * stop the whole app scrolling. Unmounting mid-drag is not hypothetical: a
   * board switch during a drag does exactly that.
   */
  useEffect(() => () => teardown(pointerRef.current), [teardown]);

  /**
   * THE LOOP. One frame's worth of work, in one read/write order.
   *
   * Runs while the drag is lifted regardless of whether the pointer moved,
   * which is what lets a finger held still at the edge keep the board creeping
   * — the old fixed-step scroll was driven by pointer events, so a stationary
   * finger at the edge moved the board not at all.
   */
  /*
   * The loop re-schedules itself through a ref rather than by naming itself.
   * A `useCallback` that closes over its own binding is read before it is
   * assigned, so a later render's version would never take over — and the lint
   * rule that says so is right, even though this particular loop only touches
   * refs and two stable callbacks.
   */
  const stepRef = useRef<() => void>(() => {});

  const step = useCallback(() => {
    const pointer = pointerRef.current;
    if (!pointer || !pointer.active) return;
    pointer.frame = window.requestAnimationFrame(() => stepRef.current());

    const { clientX, clientY, ghost, scroller } = pointer;
    let scrolled = false;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const velocity = edgeScrollVector(clientX, clientY, box);
      if (velocity.x || velocity.y) {
        const beforeLeft = scroller.scrollLeft;
        const beforeTop = scroller.scrollTop;
        scroller.scrollLeft += velocity.x;
        scroller.scrollTop += velocity.y;
        scrolled =
          scroller.scrollLeft !== beforeLeft || scroller.scrollTop !== beforeTop;
      }
    }

    if (ghost) {
      const offset = ghostOffset(
        pointer.grabX,
        pointer.grabY,
        ghost.offsetWidth,
        ghost.offsetHeight,
      );
      ghost.style.transform = `translate3d(${Math.round(clientX - offset.x)}px, ${Math.round(
        clientY - offset.y,
      )}px, 0)`;
      if (ghost.style.opacity !== "1") ghost.style.opacity = "1";
    }

    reassertDropTarget();

    // Hit-testing is the expensive half, so it is skipped on a frame where
    // nothing under the pointer can have moved.
    if (pointer.settled && !scrolled) return;
    pointer.settled = true;
    setDropTarget(
      rowDropTargetFrom(
        hitTestRowCached(clientX, clientY, scroller),
        clientY,
        pointer.item.sourceGroupId,
      ),
    );
  }, [reassertDropTarget, setDropTarget]);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const activate = useCallback(
    (pointer: RowDragPointer) => {
      if (pointer.active) return;
      pointer.active = true;
      try {
        pointer.element.setPointerCapture(pointer.pointerId);
      } catch {
        // The pointer may already have ended while the hold timer was firing.
      }
      document.addEventListener("touchmove", blockTouchScroll, { passive: false });
      document.body.classList.add("is-dragging-board-row");

      const rect = pointer.element.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), 320);
      pointer.grabX = pointer.clientX - rect.left;
      pointer.grabY = pointer.clientY - rect.top;
      pointer.ghost = createRowGhost(pointer.element, width);
      pointer.settled = false;
      resetHitTest();

      /*
       * `.live-board-scroll:has(.is-dragging)` in globals.css watches this
       * class, and a `:has()` over the scroller's whole subtree is not free:
       * measured at 72–82ms per toggle against 0–2ms for a class no `:has()`
       * watches, on a 21,249-element board. It is paid twice per drag — here
       * and in `teardown` — and an INTEGRATION REQUEST in the batch report asks
       * for that selector to key off `body.is-dragging-board-row`, which is set
       * on the line below and costs nothing to match.
       */
      pointer.element.classList.add("is-dragging");
      pointer.element.setAttribute("aria-grabbed", "true");
      setDropTarget(null);
      onDragStart?.();
      if (pointer.pointerType !== "mouse" && "vibrate" in navigator) {
        navigator.vibrate(12);
      }
      pointer.frame = window.requestAnimationFrame(step);
    },
    [onDragStart, setDropTarget, step],
  );

  /** The drop, measured from where the pointer actually let go. */
  const commit = useCallback(
    (pointer: RowDragPointer, clientX: number, clientY: number) => {
      const item = pointer.item;
      /*
       * Resolved here rather than reused from the frame loop: the loop's answer
       * can be one frame stale, and one frame is enough to land in the wrong gap
       * after a fast flick.
       */
      const target = rowDropTargetFrom(
        hitTestRow(clientX, clientY),
        clientY,
        item.sourceGroupId,
      );

      justDroppedRef.current = true;
      window.setTimeout(() => {
        justDroppedRef.current = false;
      }, 0);
      clearDrag();
      if (target) onDrop(item, target);
    },
    [clearDrag, onDrop],
  );

  const onRowPointerDown = useCallback(
    (item: BoardDragItem, event: ReactPointerEvent<HTMLTableRowElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      if (pointerRef.current) clearDrag();
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(DRAG_IGNORE_SELECTOR)) return;
      const fromHandle = Boolean(target?.closest(DRAG_HANDLE_SELECTOR));
      /*
       * THE LINE THAT FIXED HORIZONTAL SCROLLING.
       *
       * A finger that did not land on a handle is not a candidate for anything.
       * No ref is written, no listener is added, and the gesture reaches the
       * compositor exactly as it would on a page with no JavaScript on it.
       */
      if (event.pointerType === "touch" && !fromHandle) return;

      const pointer: RowDragPointer = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        item,
        startX: event.clientX,
        startY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        active: false,
        fromHandle,
        element: event.currentTarget,
        scroller: event.currentTarget.closest<HTMLElement>(".live-board-scroll"),
        ghost: null,
        grabX: 0,
        grabY: 0,
        frame: null,
        settled: false,
      };
      pointerRef.current = pointer;

      const move = (native: PointerEvent) => {
        const current = pointerRef.current;
        if (!current || current.pointerId !== native.pointerId) return;
        current.clientX = native.clientX;
        current.clientY = native.clientY;
        if (current.active) {
          // Nothing else. No hit test, no scroll write: the frame does the work.
          current.settled = false;
          return;
        }
        const decision = rowDragDecision({
          pointerType: current.pointerType,
          distance: Math.hypot(
            native.clientX - current.startX,
            native.clientY - current.startY,
          ),
          fromHandle: current.fromHandle,
          buttons: native.buttons,
        });
        if (decision === "wait") return;
        if (decision === "release") {
          // The press is forgotten outright rather than left inactive, so
          // nothing later in the gesture can claim it back.
          clearDrag();
          return;
        }
        activate(current);
      };
      const up = (native: PointerEvent) => {
        const current = pointerRef.current;
        if (!current || current.pointerId !== native.pointerId) return;
        if (!current.active) {
          clearDrag();
          return;
        }
        commit(current, native.clientX, native.clientY);
      };
      const cancel = (native: PointerEvent) => {
        if (pointerRef.current?.pointerId !== native.pointerId) return;
        clearDrag();
      };
      /*
       * Escape abandons the drag, and the row goes back where it came from.
       *
       * Without it the only way out of a drag you did not mean to start was to
       * complete it — `pointerup` commits wherever the pointer happens to be,
       * so letting go was a move, not an escape. Measured before this existed:
       * press Escape mid-drag, release, and the row had been reordered anyway.
       *
       * `clearDrag()` is the same teardown `pointercancel` uses, so nothing is
       * written; and `justDroppedRef` stays false because no drop happened.
       */
      const key = (native: KeyboardEvent) => {
        if (native.key !== "Escape" || !pointerRef.current) return;
        native.preventDefault();
        native.stopPropagation();
        clearDrag();
      };
      listenersRef.current = { move, up, cancel, key };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancel);
      // Capture phase: a drag must be abandonable even while a menu or dialog
      // elsewhere would otherwise swallow the key.
      document.addEventListener("keydown", key, true);
    },
    [activate, clearDrag, commit],
  );

  /*
   * The three below are what the ROW still hangs on its own handlers, and they
   * exist for one reason: telling it whether the gesture that just ended was a
   * drag, so it can eat the click the browser fires afterwards. They must not
   * call `stopPropagation` — React's synthetic version calls through to the
   * native event, which would stop the document listeners above from ever
   * hearing the pointerup and leave every drop uncommitted.
   */
  const onRowPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLTableRowElement>) =>
      pointerRef.current?.pointerId === event.pointerId &&
      pointerRef.current.active === true,
    [],
  );

  const onRowPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLTableRowElement>) =>
      justDroppedRef.current ||
      (pointerRef.current?.pointerId === event.pointerId &&
        pointerRef.current.active === true),
    [],
  );

  const onRowPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLTableRowElement>) => {
      if (pointerRef.current?.pointerId !== event.pointerId) return;
      clearDrag();
    },
    [clearDrag],
  );

  return {
    onRowPointerDown,
    onRowPointerMove,
    onRowPointerUp,
    onRowPointerCancel,
  };
}
