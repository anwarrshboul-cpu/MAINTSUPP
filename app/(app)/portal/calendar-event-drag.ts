"use client";

/**
 * DRAGGING AN EVENT ONTO ANOTHER DATE.
 *
 * The calendar already had one way to reschedule — the "Change date" dialog on
 * an agenda row, which is the accessible method and is not going anywhere. This
 * adds the convenience next to it: pick a chip up and put it on another day.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is not `useBoardRowDrag`. That gesture is built around board groups, row
 * ids and positions, and its drop target is a GAP BETWEEN TWO ROWS; the target
 * here is a DAY, named by `data-day` on a `[data-calendar-day]` element, and
 * there is no ordering, no group and no position anywhere in it. Sharing the
 * hook would have meant teaching it a second kind of target, which is how a
 * gesture that was measured into shape stops being measurable.
 *
 * WHAT IT DOES TAKE, WITHOUT RE-LITIGATING ANY OF IT
 *
 * Everything about HOW a pointer becomes a drag is settled, and it is settled
 * by measurement rather than by taste. The evidence is written out in
 * `board-row-drag.ts` under `THE TOUCH STORY` and in the header of
 * `board-row-drag-gesture.ts`. Read those; this file follows their four
 * conclusions and adds no opinions of its own:
 *
 *   ONE — A TOUCH DRAG CANNOT BE WON BY REACTING. Chrome decides at
 *   `touchstart` whether a sequence is blocking, from `touch-action` and from
 *   the non-passive listeners that exist at that instant. A `preventDefault()`
 *   on a later `touchmove` is a no-op (`cancelable === false`), the compositor
 *   pans anyway and `pointercancel` kills the drag. Setting `touch-action` at
 *   activation does not help either — it is read once. So a touch drag must
 *   begin from an element that ALREADY says `touch-action: none` in the
 *   stylesheet, and there is no long-press alternative; it was built, measured
 *   and it fails. Here that element is `[data-calendar-drag-handle]`, the grip
 *   on an agenda row (`.calendar-agenda__grip` in calendar-views.css). A finger
 *   anywhere else on the calendar is never recorded at all: `onEventPointerDown`
 *   returns before it allocates anything, so an ordinary swipe over the month
 *   grid or a week column reaches the compositor exactly as it would on a page
 *   with no JavaScript on it.
 *
 *   TWO — A MOUSE GETS A 4px THRESHOLD AND NO HOLD TIMER. A hold timer means
 *   resting the cursor on a chip before clicking it lifts the chip. Below the
 *   threshold the gesture is still a click, so a chip still opens its record.
 *
 *   THREE — A POINTERMOVE MUST NOT TOUCH THE DOM. `move` writes two numbers to
 *   a ref and returns. Every hit test, every class toggle and every transform
 *   write happens once per animation frame, in `step`, in one read/write order.
 *
 *   FOUR — THE PREVIEW IS NOT REACT. It is a plain element appended to
 *   `document.body` and moved by writing `style.transform`. No React state is
 *   written between picking an event up and putting it down, so carrying one
 *   across a month costs zero renders. Its colours live in calendar-views.css
 *   as tokens; this file writes only geometry, because a literal hex here could
 *   not follow the dark theme.
 *
 * THE DATE IS A STRING, START TO FINISH.
 *
 * The drop target's `data-day` is already `YYYY-MM-DD` and it is handed to the
 * caller untouched. There is no `new Date()` anywhere in this file. Parsing a
 * date-only string yields midnight UTC, which prints — and would write — as the
 * previous day for anyone west of Greenwich; `calendar-views.tsx` documents the
 * same trap at `dayOfMonth`. Dropping on 3 September 2026 writes 2026-09-03.
 *
 * AND THE FIELD IS THE EVENT'S OWN.
 *
 * A drop hands back the `CalendarEvent` that was picked up, which carries its
 * own `sourceId`/`field`. The caller routes it through `calendarWriteTarget`
 * exactly as the dialog does, so dragging a Due Date chip changes `dueAt` and
 * nothing else, however many date sources are switched on.
 */

import { createContext, useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CalendarDay, CalendarEvent } from "./calendar-model";

/* -------------------------------------------------------------------------
   The arithmetic — no DOM, no state, so it can be tested against numbers
   ------------------------------------------------------------------------- */

/**
 * How far a MOUSE must move before a press becomes a drag.
 *
 * Four pixels, the same number the row drag and the column drag use, and for
 * the same reason: below it every control inside the calendar behaves as it
 * always has, so a chip still opens its record on a click and the grip still
 * opens the date dialog. There is deliberately no hold timer — see conclusion
 * TWO above.
 */
export const CALENDAR_DRAG_THRESHOLD = 4;

/** How close to the week scroller's edge the pointer must come to creep. */
export const CALENDAR_DRAG_EDGE = 56;

/** The fastest it creeps, in CSS pixels per animation frame. */
export const CALENDAR_DRAG_MAX_SPEED = 16;

/** The slowest it creeps once it creeps at all, as a fraction of the max. */
export const CALENDAR_DRAG_MIN_SPEED_RATIO = 0.15;

/**
 * What a press should do next.
 *
 * `"wait"` — not enough has happened; keep watching.
 * `"drag"` — lift the event.
 * `"release"` — this gesture belongs to the browser. The caller must FORGET the
 *   press rather than leave it inactive, so nothing later can claim it back.
 */
export type CalendarDragDecision = "wait" | "drag" | "release";

/**
 * Should this press become a drag, stay a press, or go back to the browser?
 *
 *   · A finger that did not land on the grip is released at once and
 *     unconditionally. On touch this is the only answer that is not a race, and
 *     giving the gesture up before anything is prevented is what keeps a swipe
 *     over the calendar a native 1:1 scroll.
 *   · Everything else is the 4px threshold. A press on the grip still has to
 *     clear it, because the grip is a real button whose click opens the date
 *     dialog.
 *   · A mouse that has lost its button has ended the press.
 */
export function calendarDragDecision(input: {
  pointerType: string;
  /** Total distance travelled since the press, in pixels. */
  distance: number;
  /** True when the press began on `[data-calendar-drag-handle]`. */
  fromHandle: boolean;
  /** `PointerEvent.buttons`. */
  buttons: number;
}): CalendarDragDecision {
  if (!input.fromHandle && input.pointerType === "touch") return "release";
  if (input.distance < CALENDAR_DRAG_THRESHOLD) return "wait";
  if (input.pointerType === "touch") return "drag";
  return input.buttons === 1 ? "drag" : "release";
}

/**
 * Would this drop change anything?
 *
 * Dropping an event back on the day it already sits on is not a reschedule, and
 * writing it anyway would cost a PATCH, a toast and an audit line that say a
 * date moved when it did not. A missing target is not a change either — that is
 * a drag released over the page chrome, which must cancel rather than guess.
 */
export function calendarDropChangesDate(
  from: CalendarDay,
  to: CalendarDay | null,
): boolean {
  return to !== null && to !== from;
}

/**
 * How fast to creep, given how far PAST the edge threshold the pointer is.
 *
 * A speed per FRAME rather than a step per pointer event: a finger held still
 * at the edge of the week scroller must keep it moving, and an event-driven
 * step is zero in exactly that case. Ramped quadratically, with a floor so that
 * crossing the threshold at all is visible. The same shape the row drag uses,
 * restated here rather than imported so the calendar's gesture does not reach
 * into the board's.
 */
export function calendarEdgeSpeed(
  overshoot: number,
  edge = CALENDAR_DRAG_EDGE,
  max = CALENDAR_DRAG_MAX_SPEED,
) {
  if (overshoot <= 0) return 0;
  const ramp = Math.min(1, overshoot / edge);
  return (
    max *
    (CALENDAR_DRAG_MIN_SPEED_RATIO +
      (1 - CALENDAR_DRAG_MIN_SPEED_RATIO) * ramp * ramp)
  );
}

/** How wide the preview is: the thing that was grabbed, kept card-sized. */
export const CALENDAR_GHOST_MIN_WIDTH = 132;
export const CALENDAR_GHOST_MAX_WIDTH = 260;
export const CALENDAR_GHOST_VIEWPORT_MARGIN = 24;

export function calendarGhostWidth(sourceWidth: number, viewportWidth: number) {
  const clamped = Math.min(
    Math.max(sourceWidth, CALENDAR_GHOST_MIN_WIDTH),
    CALENDAR_GHOST_MAX_WIDTH,
  );
  return Math.round(
    Math.max(1, Math.min(clamped, viewportWidth - CALENDAR_GHOST_VIEWPORT_MARGIN)),
  );
}

/**
 * Where the preview's LEFT edge sits, kept inside the screen.
 *
 * `calendarGhostWidth` above bounds how WIDE the card may be, and `grabX` bounds
 * where inside the card the pointer holds it — but neither bounds where the card
 * ends up, and on a phone that is the one that shows. The grip is at the RIGHT
 * end of an agenda row, so `clientX - grabX` puts a 132px card mostly to the
 * left of the finger and hangs its tail off the screen: measured 15px lost at
 * 430, 23px at 390, 26px at 375, 29px at 360 and 37px at 320, where the title
 * was cut by the screen edge rather than by its own ellipsis. The left-hand
 * overhang had been thought about; this end had not.
 *
 * Half the margin at each side, matching the 12px `grabX` already uses. The
 * upper bound cannot cross the lower one because `calendarGhostWidth` has
 * already guaranteed `viewportWidth - width >= CALENDAR_GHOST_VIEWPORT_MARGIN`.
 *
 * Nothing about the DROP depends on this — the drop is resolved from the
 * pointer, not from the card — so this only ever moves what the reader sees.
 */
export function calendarGhostLeft(
  clientX: number,
  grabX: number,
  ghostWidth: number,
  viewportWidth: number,
) {
  const gutter = CALENDAR_GHOST_VIEWPORT_MARGIN / 2;
  const furthest = viewportWidth - ghostWidth - gutter;
  return Math.round(Math.max(gutter, Math.min(clientX - grabX, furthest)));
}

/* -------------------------------------------------------------------------
   The gesture — the part that needs a DOM
   ------------------------------------------------------------------------- */

/**
 * The grip: the ONLY place a finger may start a drag.
 *
 * One element carries it — `.calendar-agenda__grip`, drawn on every agenda row
 * that the viewer may edit — and it declares `touch-action: none` in
 * calendar-views.css. That declaration is a promise made before the finger
 * lands, which is the only kind the compositor accepts; see conclusion ONE.
 */
const DRAG_HANDLE_SELECTOR = "[data-calendar-drag-handle]";

/**
 * Everything a press must NOT lift an event by.
 *
 * `[data-calendar-edit]` is the "Change date" button, and it is named here
 * explicitly as well as being structurally out of reach: the pointer handlers
 * live on the chip and on the grip, never on the agenda row, so a press on the
 * Edit button never reaches this gesture in the first place. It is stated twice
 * because the accessible path must not become droppable by accident if the
 * markup is ever rearranged.
 */
const DRAG_IGNORE_SELECTOR =
  "[data-calendar-edit], [data-calendar-drag-ignore], input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** Any control nested INSIDE the pressed element, which owns its own gesture. */
const NESTED_CONTROL_SELECTOR = "button, a[href], input, textarea, select, [role='button']";

/** The class a `[data-calendar-day]` wears while it is the destination. */
const DROP_TARGET_CLASS = "is-calendar-drop";

type CalendarDragPointer = {
  pointerId: number;
  pointerType: string;
  event: CalendarEvent;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  active: boolean;
  fromHandle: boolean;
  /** The chip or the grip that was pressed. */
  element: HTMLElement;
  /** `.calendar-week__scroll`, when the press happened inside a week. */
  scroller: HTMLElement | null;
  ghost: HTMLElement | null;
  ghostWidth: number;
  ghostHeight: number;
  grabX: number;
  grabY: number;
  /** Where the preview flies back to when the drag is abandoned. */
  homeX: number;
  homeY: number;
  frame: number | null;
  /** Set once the destination has been recomputed for the current position. */
  settled: boolean;
};

export type CalendarDragHandlers = {
  /**
   * Whether the viewer may reschedule anything at all.
   *
   * The SAME condition the "Change date" button is drawn on — the panel's
   * `canEditAnything`, narrowed per event by `event.editable`. A drag and a
   * dialog are two ways to make one write, so they are offered together or not
   * at all. The server remains the authority: this only decides what to draw.
   */
  enabled: boolean;
  onEventPointerDown: (
    event: CalendarEvent,
    native: ReactPointerEvent<HTMLElement>,
  ) => void;
  /** True while the click a completed drag produces is still pending. */
  didDrag: () => boolean;
};

/**
 * How the chip and the agenda grip reach the gesture.
 *
 * A context rather than nine more props: `CalendarSurface` dispatches to three
 * surfaces, each of which nests a cell or a column around the chip, and the
 * agenda is two components below that. Threading the handlers through all of
 * them would put drag plumbing in the signature of every presentational piece
 * in the file. `null` is a calendar rendered without the provider, which is
 * simply a calendar with no drag on it.
 */
export const CalendarDragContext = createContext<CalendarDragHandlers | null>(
  null,
);

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Belt and braces while an event is in the air: a second finger, or a browser
 * that decided the sequence was blocking after all, must not scroll the page
 * out from under a preview. A no-op on the non-cancelable events Chrome hands
 * us — `touch-action: none` on the grip is what actually holds the pan off.
 */
function blockTouchScroll(nativeEvent: TouchEvent) {
  if (nativeEvent.cancelable) nativeEvent.preventDefault();
}

/**
 * THE PREVIEW, AND WHY IT CARRIES THE FIELD NAME.
 *
 * A chip on this grid says a title and — in a week column — a subtitle. What it
 * does not say is WHICH date of that job is in your hand, and one job can be on
 * the grid up to four times at once: raised, due, updated, completed. So the
 * preview prints the field label under the title. That is the one fact a person
 * needs to be sure the thing they are about to move is the thing they meant.
 *
 * Every colour comes from `.calendar-drag-ghost` in calendar-views.css, which
 * is written in tokens. This function sets geometry and nothing else: a literal
 * hex here would be pinned to one theme, which is the exact failure the
 * stylesheet's header records.
 */
function createGhost(event: CalendarEvent, width: number): HTMLElement {
  const root = document.createElement("div");
  root.className = "calendar-drag-ghost";
  root.setAttribute("aria-hidden", "true");
  root.style.width = `${width}px`;
  // Parked off-screen so it never flashes at 0,0 before the loop places it.
  root.style.transform = "translate3d(-9999px, -9999px, 0)";
  root.style.opacity = "0";

  const title = document.createElement("span");
  title.className = "calendar-drag-ghost__title";
  title.textContent = event.title;

  const field = document.createElement("span");
  field.className = "calendar-drag-ghost__field";
  field.textContent = event.fieldLabel;

  root.append(title, field);
  document.body.append(root);
  return root;
}

/**
 * The preview lands somewhere instead of blinking out.
 *
 * `to` is where it is going: the destination cell on a drop, the chip it came
 * from on an abandon, and `null` when a drag was released over nothing at all —
 * which is the one case where vanishing is the honest answer.
 *
 * Every exit removes the element: the animation's finish, its cancel, and a
 * timer past its duration. An orphaned fixed-position card floating over the
 * month is a far worse failure than a missing flourish.
 */
function settleGhost(ghost: HTMLElement, to: { x: number; y: number } | null) {
  let removed = false;
  const finish = () => {
    if (removed) return;
    removed = true;
    ghost.remove();
  };
  if (!to || prefersReducedMotion() || typeof ghost.animate !== "function") {
    finish();
    return;
  }
  const animation = ghost.animate(
    [
      { transform: ghost.style.transform, opacity: 1 },
      {
        transform: `translate3d(${Math.round(to.x)}px, ${Math.round(to.y)}px, 0) scale(0.94)`,
        opacity: 0,
      },
    ],
    { duration: 160, easing: "cubic-bezier(0.25, 0.8, 0.35, 1)", fill: "forwards" },
  );
  animation.onfinish = finish;
  animation.oncancel = finish;
  window.setTimeout(finish, 420);
}

/**
 * ONE HIT TEST, MEMOISED ON THE BOX IT CAME FROM.
 *
 * `elementFromPoint` forces a layout flush, so it is the most expensive thing
 * in the drag and it happens at most once a frame. Most movement during a drag
 * is WITHIN one day cell — a hand is not steady, and a 10px tremor cannot
 * change which date the drop lands on — so the cell's box is remembered and the
 * answer reused while the pointer is still inside it and the week has not
 * scrolled underneath it.
 */
type DayHitCache = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  scrollLeft: number;
  cell: HTMLElement;
};

let lastDayHit: DayHitCache | null = null;

function hitTestDay(
  clientX: number,
  clientY: number,
  scroller: HTMLElement | null,
): HTMLElement | null {
  const scrollLeft = scroller?.scrollLeft ?? 0;
  const cached = lastDayHit;
  if (
    cached &&
    cached.scrollLeft === scrollLeft &&
    clientX >= cached.left &&
    clientX <= cached.right &&
    clientY >= cached.top &&
    clientY <= cached.bottom &&
    cached.cell.isConnected
  ) {
    return cached.cell;
  }
  const under = document.elementFromPoint(clientX, clientY);
  const cell = under?.closest<HTMLElement>("[data-calendar-day]") ?? null;
  if (!cell || !cell.dataset.day) {
    lastDayHit = null;
    return null;
  }
  const rect = cell.getBoundingClientRect();
  lastDayHit = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    scrollLeft,
    cell,
  };
  return cell;
}

/** Forgets the memo, so a new drag never reads a box from the last one. */
function resetDayHit() {
  lastDayHit = null;
}

export function useCalendarEventDrag({
  enabled,
  onDrop,
  onDragStart,
}: {
  /** The panel's `canEditAnything`. False draws no grip and lifts nothing. */
  enabled: boolean;
  /**
   * Commit the reschedule. The panel owns what that means — it routes through
   * `calendarWriteTarget`, writes optimistically, rolls back on refusal and
   * reports through `onNotify`. This gesture deliberately knows none of that.
   */
  onDrop: (event: CalendarEvent, day: CalendarDay) => void;
  /** Fired once when an event lifts, so a host can shut anything open. */
  onDragStart?: () => void;
}): CalendarDragHandlers {
  const pointerRef = useRef<CalendarDragPointer | null>(null);
  /** The cell currently wearing the highlight, so it can be lifted again. */
  const paintedRef = useRef<HTMLElement | null>(null);
  const listenersRef = useRef<{
    move: (native: PointerEvent) => void;
    up: (native: PointerEvent) => void;
    cancel: (native: PointerEvent) => void;
    key: (native: KeyboardEvent) => void;
  } | null>(null);
  /** True from the drop until the click it produces has been eaten. */
  const justDraggedRef = useRef(false);

  /**
   * The destination, drawn as ONE class name on ONE element.
   *
   * Not React state. The board records what a state-driven drop indicator cost
   * there — a full re-render per gap crossed — and a calendar is cheaper only
   * in degree: a month is 42 cells and a drag across it crosses a dozen of
   * them. A class toggle is a class toggle, so it is written as one.
   */
  const paintDropTarget = useCallback((cell: HTMLElement | null) => {
    const painted = paintedRef.current;
    if (painted === cell) return;
    painted?.classList.remove(DROP_TARGET_CLASS);
    paintedRef.current = cell;
    cell?.classList.add(DROP_TARGET_CLASS);
  }, []);

  const teardown = useCallback((pointer: CalendarDragPointer | null) => {
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
      pointer.element.classList.remove("is-calendar-dragging");
      pointer.element.removeAttribute("aria-grabbed");
      document.removeEventListener("touchmove", blockTouchScroll);
      document.body.classList.remove("is-dragging-calendar-event");
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
  }, []);

  /**
   * End the drag, optionally letting the preview fly home first.
   *
   * `home` is the abandon path — Escape, a pointer the browser cancelled, and a
   * release over nothing. The preview is detached from the pointer BEFORE
   * teardown runs, so teardown will not remove the element it is animating, and
   * it lands back on the chip it was lifted from. That is the difference
   * between "cancelled" and "lost".
   */
  const clearDrag = useCallback(
    (home = false) => {
      const pointer = pointerRef.current;
      let flying: HTMLElement | null = null;
      let landing: { x: number; y: number } | null = null;
      if (home && pointer?.active && pointer.ghost) {
        flying = pointer.ghost;
        pointer.ghost = null;
        landing = { x: pointer.homeX, y: pointer.homeY };
      }
      teardown(pointer);
      pointerRef.current = null;
      resetDayHit();
      paintDropTarget(null);
      if (flying) settleGhost(flying, landing);
    },
    [paintDropTarget, teardown],
  );

  /*
   * A drag that outlives its component would strand a preview on the body and
   * wedge a non-passive touch listener on the document, which would stop the
   * whole app scrolling. Switching board view mid-drag does exactly that.
   */
  useEffect(
    () => () => {
      teardown(pointerRef.current);
      paintedRef.current?.classList.remove(DROP_TARGET_CLASS);
      paintedRef.current = null;
      for (const stray of document.querySelectorAll(".calendar-drag-ghost")) {
        stray.remove();
      }
    },
    [teardown],
  );

  /*
   * The loop re-schedules itself through a ref rather than by naming itself: a
   * `useCallback` that closes over its own binding is read before it is
   * assigned, so a later render's version would never take over.
   */
  const stepRef = useRef<() => void>(() => {});

  const step = useCallback(() => {
    const pointer = pointerRef.current;
    if (!pointer || !pointer.active) return;
    pointer.frame = window.requestAnimationFrame(() => stepRef.current());

    const { clientX, clientY, ghost, scroller } = pointer;
    let moved = false;

    /*
     * THE WEEK CREEPS SIDEWAYS, AND NOTHING ELSE CREEPS AT ALL.
     *
     * Below 1024px the seven week columns take a fixed 152px and
     * `.calendar-week__scroll` carries them — 1,064px of columns inside a 360px
     * phone — so a column three days away is genuinely off screen and a drag
     * that could not reach it would be a drag that only works on the days you
     * can already see. That scroller is the ONE horizontal scroller on this
     * screen, which is why the x-axis is the only axis it gets.
     *
     * The page creeps vertically instead, because on a phone the month grid and
     * the agenda the grip lives on are stacked and only one of them may be in
     * view. `window` is the page scroller here — `.portal-content` sets a
     * min-height and no overflow — so this is the real thing rather than a
     * guess at a container.
     */
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const left = calendarEdgeSpeed(box.left + CALENDAR_DRAG_EDGE - clientX);
      const right = calendarEdgeSpeed(clientX - (box.right - CALENDAR_DRAG_EDGE));
      const velocity = right - left;
      if (velocity) {
        const before = scroller.scrollLeft;
        scroller.scrollLeft += velocity;
        moved = scroller.scrollLeft !== before;
      }
    }
    const up = calendarEdgeSpeed(CALENDAR_DRAG_EDGE - clientY);
    const down = calendarEdgeSpeed(
      clientY - (window.innerHeight - CALENDAR_DRAG_EDGE),
    );
    const pageVelocity = down - up;
    if (pageVelocity) {
      const before = window.scrollY;
      window.scrollBy(0, pageVelocity);
      if (window.scrollY !== before) moved = true;
    }

    if (ghost) {
      ghost.style.transform = `translate3d(${calendarGhostLeft(
        clientX,
        pointer.grabX,
        pointer.ghostWidth,
        window.innerWidth,
      )}px, ${Math.round(clientY - pointer.grabY)}px, 0)`;
      if (ghost.style.opacity !== "1") ghost.style.opacity = "1";
    }

    /*
     * React owns the `className` of every day cell and rewrites it whenever it
     * re-renders one. Nothing in this gesture writes React state, but the host
     * can re-render for its own reasons, so one `classList.contains` per frame
     * buys immunity from the whole question.
     */
    const painted = paintedRef.current;
    if (painted && !painted.classList.contains(DROP_TARGET_CLASS)) {
      painted.classList.add(DROP_TARGET_CLASS);
    }

    // Hit-testing is the expensive half, so it is skipped on a frame where
    // nothing under the pointer can have moved.
    if (pointer.settled && !moved) return;
    pointer.settled = true;
    if (moved) resetDayHit();
    paintDropTarget(hitTestDay(clientX, clientY, scroller));
  }, [paintDropTarget]);

  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const activate = useCallback(
    (pointer: CalendarDragPointer) => {
      if (pointer.active) return;
      pointer.active = true;
      try {
        pointer.element.setPointerCapture(pointer.pointerId);
      } catch {
        // The pointer may already have ended.
      }
      document.addEventListener("touchmove", blockTouchScroll, { passive: false });
      document.body.classList.add("is-dragging-calendar-event");

      /*
       * EVERY MEASUREMENT THE DRAG WILL NEED, TAKEN HERE — one rect, once, at
       * the instant the event leaves the ground. After this nothing on the move
       * path reads layout except the memoised hit test.
       */
      const rect = pointer.element.getBoundingClientRect();
      const width = calendarGhostWidth(rect.width, window.innerWidth);
      pointer.ghostWidth = width;
      pointer.ghostHeight = Math.round(Math.max(rect.height, 34));
      /*
       * Where the preview sits relative to the pointer. Clamped into the
       * preview's own width so grabbing a wide agenda row by its right-hand
       * grip does not hang the card most of a screen away to the left.
       */
      pointer.grabX = Math.min(Math.max(pointer.clientX - rect.left, 12), width - 12);
      pointer.grabY = Math.min(
        Math.max(pointer.clientY - rect.top, 0),
        pointer.ghostHeight,
      );
      pointer.homeX = Math.round(rect.left);
      pointer.homeY = Math.round(rect.top);
      pointer.ghost = createGhost(pointer.event, width);
      pointer.settled = false;
      resetDayHit();

      pointer.element.classList.add("is-calendar-dragging");
      pointer.element.setAttribute("aria-grabbed", "true");
      paintDropTarget(null);
      onDragStart?.();
      if (pointer.pointerType !== "mouse" && "vibrate" in navigator) {
        navigator.vibrate(12);
      }
      pointer.frame = window.requestAnimationFrame(() => stepRef.current());
    },
    [onDragStart, paintDropTarget],
  );

  /** The drop, measured from where the pointer actually let go. */
  const commit = useCallback(
    (pointer: CalendarDragPointer, clientX: number, clientY: number) => {
      const event = pointer.event;
      /*
       * Resolved here rather than reused from the frame loop: the loop's answer
       * can be one frame stale, and one frame is enough to land on the wrong
       * date after a fast flick.
       */
      resetDayHit();
      const cell = hitTestDay(clientX, clientY, pointer.scroller);
      const day = cell?.dataset.day ?? null;
      const landing = cell
        ? (() => {
            const rect = cell.getBoundingClientRect();
            return { x: Math.round(rect.left + 4), y: Math.round(rect.top + 4) };
          })()
        : null;

      const changing = day !== null && calendarDropChangesDate(event.day, day);
      const flying = pointer.ghost;
      pointer.ghost = null;

      justDraggedRef.current = true;
      window.setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
      clearDrag();
      /*
       * A drop on nothing, or back on the day it started from, writes NOTHING.
       * The preview flies home in both cases so the gesture visibly undoes
       * itself rather than simply stopping.
       */
      if (changing) {
        onDrop(event, day);
        if (flying) settleGhost(flying, landing);
        return;
      }
      if (flying) {
        settleGhost(flying, { x: pointer.homeX, y: pointer.homeY });
      }
    },
    [clearDrag, onDrop],
  );

  const onEventPointerDown = useCallback(
    (event: CalendarEvent, native: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !event.editable) return;
      if (!native.isPrimary || native.button !== 0) return;
      if (pointerRef.current) clearDrag();
      const target = native.target instanceof Element ? native.target : null;
      const element = native.currentTarget;
      /*
       * THE EDIT BUTTON, AND ANY OTHER CONTROL, ALWAYS WINS.
       *
       * A control's own gesture is the one that was meant. `[data-calendar-edit]`
       * is named outright, and a nested control of any kind is excluded by
       * comparing what was pressed against the element the handler is on — so
       * the grip's own press passes and anything inside a chip would not.
       */
      if (target?.closest(DRAG_IGNORE_SELECTOR)) return;
      const control = target?.closest(NESTED_CONTROL_SELECTOR);
      if (control && control !== element) return;

      const fromHandle = Boolean(target?.closest(DRAG_HANDLE_SELECTOR));
      /*
       * THE LINE THAT KEEPS SCROLLING NATIVE.
       *
       * A finger that did not land on the grip is not a candidate for anything.
       * No ref is written, no listener is added, and the swipe reaches the
       * compositor untouched. See conclusion ONE.
       */
      if (native.pointerType === "touch" && !fromHandle) return;

      const pointer: CalendarDragPointer = {
        pointerId: native.pointerId,
        pointerType: native.pointerType,
        event,
        startX: native.clientX,
        startY: native.clientY,
        clientX: native.clientX,
        clientY: native.clientY,
        active: false,
        fromHandle,
        element,
        /* The grip lives BELOW the week scroller, not inside it, and the
           columns it drops onto are inside — so a press that is not itself
           within a scroller still looks for the one on screen. */
        scroller:
          element.closest<HTMLElement>(".calendar-week__scroll") ??
          document.querySelector<HTMLElement>(".calendar-week__scroll"),
        ghost: null,
        ghostWidth: 0,
        ghostHeight: 0,
        grabX: 0,
        grabY: 0,
        homeX: 0,
        homeY: 0,
        frame: null,
        settled: false,
      };
      pointerRef.current = pointer;

      /*
       * THE GESTURE LIVES ON THE DOCUMENT, NOT ON THE CHIP.
       *
       * A chip is about ninety pixels wide and a grip is forty-four; a drag is
       * mostly the opposite of being over either of them. Handlers on the
       * element itself would hear the first move and then nothing, so they are
       * attached here and removed the moment the press ends.
       */
      const move = (moveEvent: PointerEvent) => {
        const current = pointerRef.current;
        if (!current || current.pointerId !== moveEvent.pointerId) return;
        current.clientX = moveEvent.clientX;
        current.clientY = moveEvent.clientY;
        if (current.active) {
          // Nothing else. No hit test, no scroll write: the frame does the work.
          current.settled = false;
          return;
        }
        const decision = calendarDragDecision({
          pointerType: current.pointerType,
          distance: Math.hypot(
            moveEvent.clientX - current.startX,
            moveEvent.clientY - current.startY,
          ),
          fromHandle: current.fromHandle,
          buttons: moveEvent.buttons,
        });
        if (decision === "wait") return;
        if (decision === "release") {
          clearDrag();
          return;
        }
        activate(current);
      };
      const up = (upEvent: PointerEvent) => {
        const current = pointerRef.current;
        if (!current || current.pointerId !== upEvent.pointerId) return;
        if (!current.active) {
          // Below the threshold this was a click, and the click is the chip's
          // own — opening the record, or opening the date dialog from the grip.
          clearDrag();
          return;
        }
        commit(current, upEvent.clientX, upEvent.clientY);
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (pointerRef.current?.pointerId !== cancelEvent.pointerId) return;
        clearDrag(true);
      };
      /*
       * Escape abandons the drag and nothing is written.
       *
       * Without it the only way out of a drag you did not mean to start is to
       * finish it, because `pointerup` commits wherever the pointer happens to
       * be. Capture phase, so a drag stays abandonable even while a dialog
       * elsewhere would otherwise swallow the key.
       */
      const key = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape" || !pointerRef.current) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        clearDrag(true);
      };
      listenersRef.current = { move, up, cancel, key };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", cancel);
      document.addEventListener("keydown", key, true);
    },
    [activate, clearDrag, commit, enabled],
  );

  const didDrag = useCallback(() => justDraggedRef.current, []);

  return { enabled, onEventPointerDown, didDrag };
}
