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
 * React state is not written AT ALL between picking a row up and putting it
 * down. The preview, the caret in the gap and the dashed slot the row came out
 * of are three plain elements on the body, moved by writing `style.transform`;
 * the target group and row are marked with two class names. See
 * `paintDropTarget` for what that replaced and what it cost.
 *
 * FOUR: THE PREVIEW IS AN OBJECT, NOT A COPY OF A ROW.
 *
 * It used to be a 320px bar with a 4px radius, the same height and colour
 * family as the rows under it, which on a phone covered 82% of the screen and
 * read as a duplicate row rather than as something in the air. It is now a card
 * — derived width, 10px corners, an opaque surface, a two-layer shadow, and the
 * job reference alongside the name because on this board every row is called
 * "Manual" or "Incoming form answer". `createRowGhost` has the reasoning and
 * `ghostWidth` next door has the numbers.
 */

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { BoardDragItem, BoardDropTarget } from "./board-model";
import {
  anchorPoint,
  anchoredAt,
  edgeScrollVector,
  ghostHeight,
  ghostOffset,
  ghostWidth,
  rowDragDecision,
  rowDropTargetFrom,
  sameDropTarget,
  visibleRowLeft,
  type AnchoredPoint,
  type RowHit,
  type ScrollFrame,
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
  ghost: RowGhost | null;
  /** The insertion mark, and where in the grid it was last placed. */
  caret: HTMLElement | null;
  caretAt: AnchoredPoint | null;
  /** The dashed outline left behind at the row's own position. */
  slot: HTMLElement | null;
  slotAt: AnchoredPoint | null;
  /** The colour of the group the row was lifted OUT of. */
  sourceColor: string;
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
 * Whether the person has asked the operating system for less movement.
 *
 * Read at the moment each animation would start rather than cached, because
 * the setting can change while a tab is open and the next drag should honour
 * the new answer. Everything guarded by this is decoration: the drag itself is
 * identical either way, and nothing about where a row lands depends on it.
 */
function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The palette the preview and its two marks are drawn from. */
type GhostSkin = {
  dark: boolean;
  surface: string;
  ink: string;
  muted: string;
  ring: string;
  shadow: string;
};

function ghostSkin(): GhostSkin {
  const dark = document.body.dataset.theme === "dark";
  return dark
    ? {
        dark,
        surface: "#223244",
        ink: "#eaf1f9",
        muted: "rgba(213, 228, 243, 0.62)",
        ring: "rgba(255, 255, 255, 0.14)",
        shadow:
          "0 18px 34px -10px rgba(0, 0, 0, 0.72), 0 6px 12px -6px rgba(0, 0, 0, 0.6)",
      }
    : {
        dark,
        surface: "#ffffff",
        ink: "#1f2f3d",
        muted: "rgba(45, 68, 88, 0.6)",
        ring: "rgba(11, 37, 58, 0.14)",
        shadow:
          "0 18px 32px -12px rgba(11, 37, 58, 0.35), 0 5px 12px -6px rgba(11, 37, 58, 0.22)",
      };
}

/** The group colour a `[data-board-group-id]` element is painted with. */
function groupColor(group: HTMLElement | null) {
  const value = group
    ? getComputedStyle(group).getPropertyValue("--group-color").trim()
    : "";
  return value || "#6b7f8f";
}

type RowGhost = {
  root: HTMLElement;
  /** The child that scales, so the per-frame transform write stays on `root`. */
  lift: HTMLElement;
  /** The group-colour spine, recoloured when the drop crosses into a group. */
  spine: HTMLElement;
  width: number;
  height: number;
  lifted: boolean;
};

/**
 * THE LIFTED ROW, AND WHY IT IS NO LONGER A STRIP.
 *
 * A copy of the row rather than the row itself: moving the real `<tr>` out of
 * its table would collapse the column widths of every group it belongs to, and
 * a `<tr>` is not something that can be positioned anyway.
 *
 * What changed is what the copy LOOKS like. It was a 320px bar with a 4px
 * corner radius and one word in it — the same height, the same colour family
 * and very nearly the same silhouette as the rows it was floating over, which
 * on a phone covered 82% of the screen. Read back honestly, it was a duplicate
 * of a row rather than a thing being carried, and the complaint said exactly
 * that. Four decisions fix it, and they are all visible in the numbers:
 *
 *   · WIDTH is now derived — see `ghostWidth` next door. 300px on a desktop,
 *     55–70% of a phone, never wider than the screen minus a margin.
 *   · SHAPE is a card: 10px corners, a hairline ring, and a two-layer shadow
 *     with a negative spread so the elevation reads as height rather than as
 *     a smudge. Rows have square corners and no shadow, so nothing about this
 *     silhouette can be mistaken for one.
 *   · SURFACE is opaque in both themes — white on light, a raised slate on
 *     dark — because a translucent card over a grid picks up the grid lines
 *     and immediately looks like part of it again.
 *   · CONTENT carries identity rather than a label. On this board every row's
 *     Name is "Manual" or "Incoming form answer", so a preview showing only
 *     the name is genuinely ambiguous: the job reference is the only thing
 *     that says WHICH row is in the air. It sits at the trailing edge in muted
 *     type, and the grip glyph on the left says the same thing the reference
 *     product's preview says — this is the handle, this is what you are
 *     holding.
 */
function createRowGhost(
  row: HTMLTableRowElement,
  width: number,
  height: number,
): RowGhost {
  const skin = ghostSkin();
  const color = groupColor(row.closest<HTMLElement>("[data-board-group-id]"));
  const name =
    row.querySelector<HTMLElement>(".sheet-column--name")?.textContent?.trim() ||
    row.dataset.boardRowId ||
    "";
  const reference = row.dataset.boardRowId ?? "";

  const root = document.createElement("div");
  root.className = "board-row-ghost";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "1400",
    boxSizing: "border-box",
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: "none",
    userSelect: "none",
    willChange: "transform",
    // Hidden until the loop has placed it, so it never flashes at 0,0.
    opacity: "0",
    transform: "translate3d(-9999px, -9999px, 0)",
  } satisfies Partial<CSSStyleDeclaration>);

  const lift = document.createElement("div");
  lift.className = "board-row-ghost__lift";
  Object.assign(lift.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    paddingRight: "10px",
    borderRadius: "10px",
    overflow: "hidden",
    background: skin.surface,
    color: skin.ink,
    /*
     * Longhand, and this is not a style preference.
     *
     * The line it replaces was `font: "500 13px/1.2 inherit"`, and the `font`
     * shorthand does not take `inherit` as its family — `inherit` is only legal
     * as the ENTIRE value of a shorthand. So the declaration was dropped whole
     * and the preview inherited the body's 16px/24px, which is why a 40px card
     * looked stuffed. Set one property at a time and the family is simply never
     * mentioned, which is the same thing the shorthand was trying to say.
     */
    fontWeight: "600",
    fontSize: "13px",
    lineHeight: "1.25",
    boxShadow: `${skin.shadow}, 0 0 0 1px ${skin.ring}`,
    // The scale of the lift and the settle both live here, so the frame loop
    // can keep writing `root.style.transform` without ever fighting them.
    transformOrigin: "18px 50%",
    willChange: "transform",
  } satisfies Partial<CSSStyleDeclaration>);

  const spine = document.createElement("span");
  Object.assign(spine.style, {
    flex: "0 0 auto",
    alignSelf: "stretch",
    width: "4px",
    background: color,
    // Recoloured live when the drop target crosses into another group.
    transition: prefersReducedMotion() ? "none" : "background 140ms ease",
  } satisfies Partial<CSSStyleDeclaration>);

  const grip = document.createElement("span");
  Object.assign(grip.style, {
    flex: "0 0 auto",
    width: "6px",
    height: "14px",
    marginLeft: "7px",
    opacity: "0.5",
    // Two columns of dots, drawn rather than typed so no font can lose them.
    backgroundImage: "radial-gradient(currentColor 0.9px, transparent 1.1px)",
    backgroundSize: "3px 4px",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("span");
  Object.assign(label.style, {
    flex: "1 1 auto",
    minWidth: "0",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  label.textContent = name;

  const badge = document.createElement("span");
  Object.assign(badge.style, {
    flex: "0 0 auto",
    fontWeight: "500",
    fontSize: "11px",
    lineHeight: "1",
    letterSpacing: "0.02em",
    color: skin.muted,
    whiteSpace: "nowrap",
  } satisfies Partial<CSSStyleDeclaration>);
  badge.textContent = reference;

  lift.append(spine, grip, label);
  if (reference && reference !== name) lift.append(badge);
  root.append(lift);
  document.body.append(root);
  return { root, lift, spine, width, height, lifted: false };
}

/**
 * THE LIFT: a row leaves the ground, it does not teleport.
 *
 * Run once, on the first frame that has a real position to show — starting it
 * at creation would animate something parked at -9999px. A Web Animation
 * rather than a stylesheet keyframe because this element is built here and
 * belongs to nobody else, and rather than a CSS transition because a transition
 * cannot overshoot, and the small overshoot is what makes it read as weight.
 *
 * `prefers-reduced-motion: reduce` gets no transform animation at all — the
 * card simply appears at full size.
 */
function beginLift(ghost: RowGhost) {
  if (ghost.lifted) return;
  ghost.lifted = true;
  if (prefersReducedMotion() || typeof ghost.lift.animate !== "function") return;
  ghost.lift.animate(
    [
      { transform: "scale(0.9)", opacity: 0.4 },
      { transform: "scale(1.035)", opacity: 1, offset: 0.55 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 190, easing: "cubic-bezier(0.2, 0.75, 0.3, 1)" },
  );
}

/**
 * THE SETTLE: the preview lands in the gap instead of blinking out.
 *
 * The old drop removed the element on the same tick the board re-rendered, so
 * the row vanished from under the pointer and reappeared somewhere else in the
 * same frame — two events that are obviously one thing, shown as two. Here the
 * preview is handed over BEFORE teardown (the pointer's reference is cleared,
 * so nothing else will remove it) and flies to where the row is going.
 *
 * Every exit removes the element: the animation's finish, its cancel, and a
 * timer well past its duration, because an orphaned fixed-position card that
 * covers part of the board is a far worse failure than a missing flourish.
 */
function settleRowGhost(ghost: RowGhost, to: { x: number; y: number } | null) {
  const root = ghost.root;
  root.dataset.boardRowGhostSettling = "true";
  let removed = false;
  const finish = () => {
    if (removed) return;
    removed = true;
    root.remove();
  };
  if (!to || prefersReducedMotion() || typeof root.animate !== "function") {
    finish();
    return;
  }
  const from = root.style.transform;
  const animation = root.animate(
    [
      { transform: from, opacity: 1 },
      { transform: `translate3d(${Math.round(to.x)}px, ${Math.round(to.y)}px, 0)`, opacity: 0 },
    ],
    { duration: 165, easing: "cubic-bezier(0.25, 0.8, 0.35, 1)", fill: "forwards" },
  );
  ghost.lift.animate([{ transform: "scale(1)" }, { transform: "scale(0.97)" }], {
    duration: 165,
    easing: "cubic-bezier(0.25, 0.8, 0.35, 1)",
  });
  animation.onfinish = finish;
  animation.oncancel = finish;
  window.setTimeout(finish, 420);
}

/**
 * THE TWO MARKS THE DROP DRAWS, AND WHY THEY ARE NOT CSS.
 *
 * Before this there was one indicator and it was the row's own top border —
 * `border-top: 3px solid` on every `<td>` of the target row — which on a board
 * whose rows are 4,200px wide is a line running off both sides of the screen,
 * plus a dashed outline around the whole target GROUP, of which a phone shows
 * one stray edge floating in the middle of the board. Neither says "the item
 * goes HERE"; together they say "something, somewhere, is happening".
 *
 * These two do say it:
 *
 *   · THE CARET is a rounded bar exactly as wide as the preview, with a knob on
 *     its leading end, sitting in the gap the drop will use. It is the same
 *     width as the thing being carried, so the two read as one gesture.
 *   · THE SLOT is a dashed rounded outline left where the row was picked up, so
 *     "put it back" is a visible place rather than a memory.
 *
 * Both are plain elements on the body for the same reason the preview is: a
 * fixed-position child of a `content-visibility: auto` group is positioned
 * against the GROUP and clipped when it scrolls away. Both are positioned from
 * an anchor plus the scroll that has happened since, so neither costs a layout
 * read per frame and neither assumes the board is scrolled to its left edge.
 */
function createDropCaret(): HTMLElement {
  const caret = document.createElement("div");
  caret.className = "board-row-drop-caret";
  caret.setAttribute("aria-hidden", "true");
  Object.assign(caret.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "1399",
    height: "4px",
    borderRadius: "999px",
    pointerEvents: "none",
    willChange: "transform",
    opacity: "0",
    transform: "translate3d(-9999px, -9999px, 0)",
  } satisfies Partial<CSSStyleDeclaration>);
  const knob = document.createElement("span");
  Object.assign(knob.style, {
    position: "absolute",
    left: "-3px",
    top: "-4px",
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    background: "inherit",
  } satisfies Partial<CSSStyleDeclaration>);
  caret.append(knob);
  document.body.append(caret);
  return caret;
}

function createOriginSlot(width: number, height: number, color: string) {
  const skin = ghostSkin();
  const slot = document.createElement("div");
  slot.className = "board-row-drop-slot";
  slot.setAttribute("aria-hidden", "true");
  Object.assign(slot.style, {
    position: "fixed",
    top: "0",
    left: "0",
    zIndex: "1398",
    boxSizing: "border-box",
    width: `${width}px`,
    height: `${height}px`,
    borderRadius: "10px",
    border: `1px dashed ${color}`,
    background: skin.dark
      ? "rgba(255, 255, 255, 0.05)"
      : "rgba(11, 37, 58, 0.05)",
    pointerEvents: "none",
    willChange: "transform",
    opacity: "0",
    transform: "translate3d(-9999px, -9999px, 0)",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(slot);
  return slot;
}

/**
 * Where the END of a group is, for a drop that lands after everything.
 *
 * The last row's bottom edge rather than the group's own box: a group's box
 * includes its header, its add-item row and its summary footer, and a caret
 * drawn at the bottom of all that points at a place no item can occupy. A group
 * with no rows in it has no last row, and the answer is its `tbody` — which is
 * exactly the empty band an item dropped into it will fill.
 */
function lastRowRectOf(group: HTMLElement | null) {
  if (!group) return null;
  const rows = group.querySelectorAll<HTMLElement>("tbody tr[data-board-row-id]");
  const last = rows[rows.length - 1];
  if (last) return last.getBoundingClientRect();
  const body = group.querySelector<HTMLElement>("tbody");
  return body ? body.getBoundingClientRect() : null;
}

/** The board's scroll position and the page's, read together. */
function scrollFrameOf(scroller: HTMLElement | null): ScrollFrame {
  return {
    scrollLeft: scroller?.scrollLeft ?? 0,
    scrollTop: scroller?.scrollTop ?? 0,
    pageLeft: window.scrollX,
    pageTop: window.scrollY,
  };
}

/**
 * Move a mark to where its anchor now is, and reveal it the first time.
 *
 * `clampLeft` is the scroller's left edge, and it is not cosmetic. Both marks
 * are as wide as the preview and start at the ROW's left edge, which on a board
 * scrolled 1,933px right is at x -1,306 — so the caret telling you where the
 * item is about to land was drawn entirely off the left of the screen, at every
 * scroll position but zero. The row is still visible; what is visible of it is
 * its sticky gutter and Name column, sitting against the scroller's left edge.
 * That is where the marks belong, so that is where they are pinned when the row
 * itself has slid past it.
 */
function placeMark(
  mark: HTMLElement | null,
  anchor: AnchoredPoint | null,
  frame: ScrollFrame,
  clampLeft: number,
) {
  if (!mark) return;
  if (!anchor) {
    if (mark.style.opacity !== "0") mark.style.opacity = "0";
    return;
  }
  const at = anchoredAt(anchor, frame);
  const x = Math.max(at.x, clampLeft);
  mark.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(at.y)}px, 0)`;
  if (mark.style.opacity !== "1") mark.style.opacity = "1";
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
      rowLeft: rect.left,
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
      rowLeft: 0,
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
    rowLeft: rect.left,
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
  const paintedRef = useRef<{
    row: HTMLElement | null;
    group: HTMLElement | null;
    /** Whether the group is meant to be lit at all. See `paintDropTarget`. */
    crossing: boolean;
  }>({ row: null, group: null, crossing: false });
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
   * on the row and `.is-drop-target` / `.is-drop-at-end` on the group — and the
   * browser tests that assert them still assert exactly what a person sees.
   *
   * WHAT DID CHANGE IS WHEN THE GROUP ONE IS WORN.
   *
   * `.sheet-group.is-drop-target` draws a dashed outline around an entire
   * group. Inside the group you are already in, that is decoration around
   * something nobody is asking a question about: a phone shows one edge of it,
   * floating in the middle of the board, attached to nothing. So it is now put
   * on only when the drop would CROSS into a different group — which is the one
   * case where "this whole group is the destination" is the news — and the
   * ordinary reorder gets the caret alone. The same rule makes the cross-group
   * case unmistakable, because it is now the only case that lights a group up.
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

    const pointer = pointerRef.current;
    const crossing =
      Boolean(next) && next?.groupId !== pointer?.item.sourceGroupId;
    if (group) {
      group.classList.toggle("is-drop-target", crossing);
      group.classList.toggle(
        "is-drop-at-end",
        crossing && next?.beforeRequestId === null,
      );
    }
    paintedRef.current.crossing = crossing;

    /*
     * THE CARET, PLACED FROM THE ONE RECT THIS COSTS.
     *
     * Measured here rather than in the frame loop because the gap only moves
     * when the ANSWER changes, and the answer changes a dozen times in a drag
     * rather than sixty times a second. Between changes the loop carries it by
     * arithmetic on the scroll position — see `anchoredAt`.
     */
    if (!pointer?.caret) return;
    if (!next) {
      pointer.caretAt = null;
      return;
    }
    const edge = row
      ? row.getBoundingClientRect()
      : lastRowRectOf(group) ?? null;
    if (!edge) {
      pointer.caretAt = null;
      return;
    }
    const color = groupColor(group);
    pointer.caret.style.background = color;
    pointer.caretAt = anchorPoint(
      edge.left,
      (row ? edge.top : edge.bottom) - 2,
      scrollFrameOf(pointer.scroller),
    );
    // The spine follows the destination, so a cross-group drag says where it is
    // going on the thing in your hand rather than only on the board behind it.
    if (pointer.ghost) pointer.ghost.spine.style.background = color;
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
    const { row, group, crossing } = paintedRef.current;
    if (row && !row.classList.contains("is-drop-before")) {
      row.classList.add("is-drop-before");
    }
    if (group && crossing && !group.classList.contains("is-drop-target")) {
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
      pointer.ghost?.root.remove();
      pointer.caret?.remove();
      pointer.slot?.remove();
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
      pointer.caret = null;
      pointer.caretAt = null;
      pointer.slot = null;
      pointer.slotAt = null;
      pointer.active = false;
    },
    [],
  );

  /**
   * End the drag, optionally letting the preview fly home first.
   *
   * `home` is the abandon path — Escape, and a pointer the browser cancelled.
   * The preview is detached from the pointer BEFORE teardown runs, so teardown
   * will not remove the element it is animating, and it lands back on the
   * dashed slot the row was lifted out of. Every other caller gets the old
   * behaviour: gone, immediately.
   */
  const clearDrag = useCallback(
    (home = false) => {
      const pointer = pointerRef.current;
      let flying: RowGhost | null = null;
      let landing: { x: number; y: number } | null = null;
      if (home && pointer?.active && pointer.ghost) {
        flying = pointer.ghost;
        pointer.ghost = null;
        landing = pointer.slotAt
          ? anchoredAt(pointer.slotAt, scrollFrameOf(pointer.scroller))
          : null;
      }
      teardown(pointer);
      pointerRef.current = null;
      resetHitTest();
      targetRef.current = null;
      paintDropTarget(null);
      if (flying) settleRowGhost(flying, landing);
    },
    [paintDropTarget, teardown],
  );

  /*
   * A drag that outlives its component would leave a preview stranded on the
   * body and a non-passive touch listener wedged on the document, which would
   * stop the whole app scrolling. Unmounting mid-drag is not hypothetical: a
   * board switch during a drag does exactly that.
   *
   * A preview part-way through its settle belongs to no pointer any more, so it
   * is swept by selector — the one case where teardown cannot reach it.
   */
  useEffect(
    () => () => {
      teardown(pointerRef.current);
      for (const stray of document.querySelectorAll(
        ".board-row-ghost, .board-row-drop-caret, .board-row-drop-slot",
      )) {
        stray.remove();
      }
    },
    [teardown],
  );

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
    // One rect for the whole frame: the edge-scroll bands and the left edge the
    // two marks are pinned to are the same box, read once.
    const box = scroller ? scroller.getBoundingClientRect() : null;
    if (scroller && box) {
      /*
       * A ROW DRAG CREEPS VERTICALLY ONLY, AND THE HANDLE IS WHY.
       *
       * `edgeScrollVector` answers both axes — it is shared arithmetic and a
       * corner is genuinely diagonal for anything that can be dropped sideways.
       * A row cannot. `rowDropTargetFrom` resolves a drop from `clientY` alone:
       * the answer is a group and the gap above a row, and a row spans the whole
       * 4,000px width, so there is no horizontal position that changes where a
       * drop lands and nothing to reveal by scrolling towards one.
       *
       * Left alone, the x component did not merely do nothing — it destroyed the
       * reader's place in the board on every single phone drag. The one touch
       * handle a phone has is `.sheet-row-grip`, drawn at `left: 0` inside the
       * FROZEN Name cell (live-board.tsx). Once the 42px checkbox gutter has
       * scrolled off, that cell sticks to the scroller's left edge, so the grip
       * sits at x 1–25 — permanently 52px inside the 64px `ROW_DRAG_EDGE` band,
       * with no way for a finger to start a drag anywhere else. Measured in
       * Chromium at 430/390/375/360/320 with the board scrolled to `scrollLeft`
       * 1500: a PURE VERTICAL drag by the grip drove it 1472 → 1304 → 1136 → …
       * → 0 in about half a second, and cancelling the drag did not put it back.
       * A coordinator reordering rows while reading Status watched the board
       * teleport to the Name column, mid-gesture, every time.
       *
       * Dropping the axis here rather than in `edgeScrollVector` is deliberate:
       * the arithmetic stays pure and honest about corners, and the decision
       * that a ROW has no sideways drop lives with the gesture that knows it.
       */
      const velocity = edgeScrollVector(clientX, clientY, box);
      if (velocity.y) {
        const beforeTop = scroller.scrollTop;
        scroller.scrollTop += velocity.y;
        scrolled = scroller.scrollTop !== beforeTop;
      }
    }

    if (ghost) {
      const offset = ghostOffset(
        pointer.grabX,
        pointer.grabY,
        ghost.width,
        ghost.height,
      );
      ghost.root.style.transform = `translate3d(${Math.round(clientX - offset.x)}px, ${Math.round(
        clientY - offset.y,
      )}px, 0)`;
      if (ghost.root.style.opacity !== "1") {
        ghost.root.style.opacity = "1";
        // The first frame with a real position is the first frame worth
        // animating, so the lift starts here rather than at construction.
        beginLift(ghost);
      }
    }

    /*
     * The two marks, carried by arithmetic.
     *
     * No `getBoundingClientRect` and no `elementFromPoint`: each is a point
     * measured once, minus the scrolling that has happened since. That is what
     * keeps them right while the board creeps at the edge, and what keeps this
     * whole block off the layout-flush path.
     */
    const frame = scrollFrameOf(scroller);
    const clampLeft = box ? box.left : 0;
    placeMark(pointer.caret, pointer.caretAt, frame, clampLeft);
    placeMark(pointer.slot, pointer.slotAt, frame, clampLeft);

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

      /*
       * EVERY MEASUREMENT THE DRAG WILL EVER NEED, TAKEN HERE.
       *
       * Two rects and one computed style, once, at the instant the row leaves
       * the ground — after which nothing on the move path reads layout except
       * the hit test, which is memoised. The Name cell is the second rect and
       * it is what decides how wide the preview is; see `ghostWidth`.
       */
      const rect = pointer.element.getBoundingClientRect();
      const nameCell = pointer.element.querySelector<HTMLElement>(
        ".sheet-column--name",
      );
      /*
       * NOT `rect.left`. See `visibleRowLeft`: a row scrolled sideways begins
       * at a negative coordinate, and measuring either the grab or the Name
       * column from there put the preview 288px away from the finger and,
       * on a phone, made it 70% of the screen instead of 55%.
       */
      const origin = visibleRowLeft(
        rect.left,
        pointer.scroller?.getBoundingClientRect().left ?? rect.left,
      );
      const width = ghostWidth({
        rowWidth: rect.width,
        nameWidth: nameCell
          ? nameCell.getBoundingClientRect().right - origin
          : 0,
        viewportWidth: window.innerWidth,
      });
      const height = ghostHeight(rect.height);
      pointer.grabX = pointer.clientX - origin;
      pointer.grabY = pointer.clientY - rect.top;
      pointer.sourceColor = groupColor(
        pointer.element.closest<HTMLElement>("[data-board-group-id]"),
      );
      pointer.ghost = createRowGhost(pointer.element, width, height);
      pointer.caret = createDropCaret();
      pointer.caret.style.width = `${width}px`;
      pointer.slot = createOriginSlot(width, rect.height, pointer.sourceColor);
      pointer.slotAt = anchorPoint(
        rect.left,
        rect.top,
        scrollFrameOf(pointer.scroller),
      );
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
      const hit = hitTestRow(clientX, clientY);
      const target = rowDropTargetFrom(hit, clientY, item.sourceGroupId);

      /*
       * WHERE THE PREVIEW IS ABOUT TO LAND, worked out before anything is torn
       * down. The gap the drop resolved to, in client coordinates: the top of
       * the row it goes before, or that row's bottom when it goes after it. Off
       * a row entirely — the end of a group — the caret is already sitting on
       * the answer, so it is asked. With no target at all the preview has
       * nowhere to go and simply leaves, which is what a drag released over the
       * page chrome should look like.
       */
      let landing: { x: number; y: number } | null = null;
      if (target && hit.rowId) {
        const before = clientY <= hit.rowTop + hit.rowHeight / 2;
        landing = { x: hit.rowLeft, y: before ? hit.rowTop : hit.rowTop + hit.rowHeight };
      } else if (target && pointer.caretAt) {
        landing = anchoredAt(pointer.caretAt, scrollFrameOf(pointer.scroller));
      }
      const flying = pointer.ghost;
      pointer.ghost = null;

      justDroppedRef.current = true;
      window.setTimeout(() => {
        justDroppedRef.current = false;
      }, 0);
      clearDrag();
      if (target) onDrop(item, target);
      if (flying) settleRowGhost(flying, landing);
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
        caret: null,
        caretAt: null,
        slot: null,
        slotAt: null,
        sourceColor: "",
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
        clearDrag(true);
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
       *
       * The `true` is the abandon animation: the preview flies back to the
       * dashed slot it came from instead of blinking out where the pointer
       * happens to be, which is the difference between "cancelled" and "lost".
       */
      const key = (native: KeyboardEvent) => {
        if (native.key !== "Escape" || !pointerRef.current) return;
        native.preventDefault();
        native.stopPropagation();
        clearDrag(true);
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
      clearDrag(true);
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
