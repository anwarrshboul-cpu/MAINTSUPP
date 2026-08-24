/**
 * Dragging a ROW to a new place — the arithmetic, without React and without a DOM.
 *
 * WHY THIS FILE EXISTS, AND WHY THE GESTURE NEXT DOOR HAD TO BE REWRITTEN.
 *
 * The row drag used to live inside `live-board.tsx` as a hold timer and four
 * handlers. It worked with a mouse and it fought the board with a finger, for a
 * reason that is worth writing down because it is not obvious from either half:
 *
 *   · `onPointerDragStart` armed a 300ms hold timer on ANY primary pointerdown
 *     anywhere in the row. A person panning the board sideways puts their
 *     finger on a row — there is nothing else to put it on — so every pan
 *     started a candidate drag.
 *   · When that timer won the race, the row buzzed, took `.is-dragging`, and
 *     every subsequent move called `event.preventDefault()` on a React
 *     `pointermove`. THAT DOES NOTHING TO SCROLLING. Pointer events are not
 *     cancelable for the purpose of panning; the compositor had already been
 *     told by `touch-action: pan-x pan-y` that this region scrolls, so it
 *     claimed the gesture and fired `pointercancel`, which cleared the drag.
 *     The user felt a buzz, watched the row fade, and got neither a drag nor a
 *     clean scroll.
 *   · When the browser won the race instead, the pan happened and the drag was
 *     dropped. Which of the two you got depended on how long your finger rested
 *     before it moved, which is why the same gesture behaved differently run to
 *     run.
 *
 * The repair is not a better timer. It is that a finger anywhere on a row is
 * now a SCROLL, decided at pointerdown, and a touch drag begins from a handle
 * that declares `touch-action: none` — the one thing a compositor cannot argue
 * with. The measurement that forced that conclusion is written out below, at
 * `THE TOUCH STORY`. What lives here is everything the decision needs that can
 * be settled from numbers alone: when a press becomes a drag, where a drop
 * lands, whether a drop would change anything, and how fast the board should
 * creep when the pointer is held at its edge.
 *
 * Everything here is pure — same input, same output, no DOM and no state — so
 * the parts that used to be untestable because they were entangled with
 * `elementFromPoint` are now tested against numbers in
 * `tests/ui-batch-row-drag.test.mjs`.
 */

import type { BoardDropTarget } from "./board-model";

/**
 * How far a MOUSE must move before a press becomes a drag.
 *
 * Four pixels, matching the column drag next door. Below it the gesture is
 * still a click and every control inside the row behaves as it always has.
 *
 * There is deliberately no mouse HOLD any more. The old code activated a drag
 * after 170ms of a stationary press, which meant resting the cursor on a cell
 * before clicking it lifted the row; a threshold alone cannot do that and is
 * what the column header has always used.
 */
export const ROW_DRAG_MOUSE_THRESHOLD = 4;

/**
 * THE TOUCH STORY, AND WHY THERE IS NO LONG PRESS.
 *
 * The obvious repair for the old gesture was to keep the hold timer and make
 * the drag block the pan once it fired — arm a non-passive `touchmove` listener
 * at activation and `preventDefault()` it, which is what the drag-and-drop
 * libraries do. That was built, and then measured in Chromium, and it does not
 * work. The events the board actually receives during a swipe over a row are:
 *
 *     pointerdown  touchstart!  pointermove  touchmove!  POINTERCANCEL  touchmove! …
 *
 * where `!` marks `cancelable === false`. Chrome decides whether a touch
 * sequence is BLOCKING at `touchstart`, from the non-passive listeners that
 * exist at that instant and from `touch-action`. `.live-board-scroll` says
 * `touch-action: pan-x pan-y` and nothing on the row is non-passive, so the
 * whole sequence is marked non-blocking before a line of our code runs. A
 * listener added 280ms later is registered against a gesture that can no longer
 * be cancelled: `preventDefault()` on a non-cancelable event is a no-op, the
 * compositor pans anyway, and `pointercancel` kills the drag — which is exactly
 * the buzz-then-fade the original bug produced, reproduced faithfully by its
 * own fix. Setting `touch-action` at activation fares no better; Chrome reads
 * it once, at touchstart, and a change mid-gesture applies to the next one.
 *
 * So a touch drag CANNOT be won by reacting. It has to be declared before the
 * finger lands, which means it has to start somewhere that already says
 * `touch-action: none`. That is what `[data-board-row-handle]` is: the gutter
 * grip on a phone, and the "⋮" button on a desktop, both of which carry
 * `touch-action: none` in the stylesheet, so the compositor never considers
 * panning from them and no race exists to lose.
 *
 * Everywhere else on a row, a finger is a scroll. Not "a scroll unless it
 * rests first" — a scroll, decided at pointerdown, with the browser's own
 * recogniser untouched and every pixel of the pan handled on the compositor.
 * That is the whole reason the board now tracks a finger 1:1 instead of
 * staircasing 24px at a time.
 */

/** How close to the scroller's edge the pointer must come to start creeping. */
export const ROW_DRAG_EDGE = 64;

/** The fastest the board creeps, in CSS pixels per animation frame. */
export const ROW_DRAG_MAX_SPEED = 20;

/** The slowest it creeps once it is creeping at all, as a fraction of the max. */
export const ROW_DRAG_MIN_SPEED_RATIO = 0.15;

/**
 * What a press should do next.
 *
 * `"wait"` — not enough has happened yet; keep watching.
 * `"drag"` — lift the row.
 * `"release"` — this gesture belongs to the browser. Let go of it completely:
 *   the caller must forget the press rather than merely leave it inactive, so
 *   that nothing in the rest of the gesture can claim it back.
 */
export type RowDragDecision = "wait" | "drag" | "release";

/**
 * Should this press become a drag, stay a press, or be handed to the browser?
 *
 * Three rules, in the order they are read:
 *
 *   · A press that did not begin on a handle and is a FINGER is released, at
 *     once, unconditionally. See the note above: on touch this is the only
 *     answer that is not a race, and giving the gesture up before anything is
 *     prevented is what makes the pan native and 1:1.
 *   · A press on a HANDLE still has to clear the threshold. The desktop handle
 *     is the "⋮" button, which opens the row menu when clicked, and a drag that
 *     armed on contact would mean that button could never be clicked again.
 *   · Everything else — mouse, pen — is the threshold and nothing else. The old
 *     code also lifted the row after 170ms of a STATIONARY mouse press, so
 *     resting the cursor on a cell before clicking it started a drag; a
 *     threshold cannot do that, and it is what the column header has always
 *     used.
 */
export function rowDragDecision(input: {
  pointerType: string;
  /** Total distance travelled since the press, in pixels. */
  distance: number;
  /** True when the press began on `[data-board-row-handle]`. */
  fromHandle: boolean;
  /** `PointerEvent.buttons`; a mouse that lost its button has ended the press. */
  buttons: number;
}): RowDragDecision {
  if (!input.fromHandle && input.pointerType === "touch") return "release";
  if (input.distance < ROW_DRAG_MOUSE_THRESHOLD) return "wait";
  if (input.pointerType === "touch") return "drag";
  return input.buttons === 1 ? "drag" : "release";
}

/**
 * What the pointer is over, as the gesture measured it — one hit test's worth.
 *
 * Expressed as plain numbers so the half of the drop decision that is a
 * judgement ("above the midpoint means before it") can be tested without a
 * browser, and so the half that costs a forced layout happens exactly once per
 * animation frame rather than once per pointer event.
 */
export type RowHit = {
  /** The row under the pointer, if any. */
  rowId: string | null;
  /** That row's group. */
  rowGroupId: string | null;
  /** That row's top edge and height, in client coordinates. */
  rowTop: number;
  rowHeight: number;
  /**
   * That row's LEFT edge, in client coordinates.
   *
   * Only the settle animation reads it: a preview that fades out where it
   * happened to be released has not landed anywhere, and the one thing it can
   * land ON is the gap it was dropped into. A row can be 4,000px wide and
   * scrolled halfway out of the scroller, so this is measured with the rest of
   * the hit rather than assumed to be the scroller's left edge.
   */
  rowLeft: number;
  /** The row after it in the same group, which is what "below" drops before. */
  nextRowId: string | null;
  /** The group under the pointer, when the pointer is not over a row at all. */
  groupId: string | null;
};

/**
 * Where a drop at `clientY` would land.
 *
 * Over the top half of a row the item goes BEFORE it; over the bottom half it
 * goes before whatever follows, and before `null` — the end of the group — when
 * nothing does. Over a group but not over a row, it goes to the end. Over
 * nothing at all the answer is null and the board shows no target, which is how
 * a drag released over the page chrome cancels rather than guessing.
 */
export function rowDropTargetFrom(
  hit: RowHit,
  clientY: number,
  fallbackGroupId: string | null = null,
): BoardDropTarget | null {
  const groupId = hit.rowGroupId ?? hit.groupId ?? fallbackGroupId;
  if (!groupId) return null;
  if (!hit.rowId) return { groupId, beforeRequestId: null };
  const beforeRequestId =
    clientY <= hit.rowTop + hit.rowHeight / 2 ? hit.rowId : hit.nextRowId;
  return { groupId, beforeRequestId };
}

/** Whether two drop targets name the same gap. */
export function sameDropTarget(
  left: BoardDropTarget | null,
  right: BoardDropTarget | null,
) {
  return (
    left?.groupId === right?.groupId &&
    left?.beforeRequestId === right?.beforeRequestId
  );
}

/**
 * The gap `beforeRequestId` names, as an index into `order`.
 *
 * `null` means "after everything", so it answers the length. An id that is not
 * in the order answers the length too: it has already been moved out of this
 * group, and the end is the only gap that is certainly still there.
 */
export function rowDropIndex(order: string[], beforeRequestId: string | null) {
  if (beforeRequestId === null) return order.length;
  const index = order.indexOf(beforeRequestId);
  return index < 0 ? order.length : index;
}

/**
 * The order after moving `requestId` into the gap before `beforeRequestId`.
 *
 * The gap is named by the row it sits above rather than by a number, which is
 * what makes this immune to the off-by-one that plagues index-based reordering:
 * lifting the item out shifts every index past it, but it does not move the row
 * the gap was named after. Dropping an item into either gap touching where it
 * already sits returns the original array, so a caller can use identity to
 * decide whether there is anything to save.
 */
export function rowOrderAfterMove(
  order: string[],
  requestId: string,
  beforeRequestId: string | null,
): string[] {
  if (beforeRequestId === requestId) return order;
  const from = order.indexOf(requestId);
  const without = from < 0 ? [...order] : order.filter((id) => id !== requestId);
  const at = rowDropIndex(without, beforeRequestId);
  without.splice(at, 0, requestId);
  return without.every((id, index) => id === order[index]) &&
    without.length === order.length
    ? order
    : without;
}

/**
 * Would this drop change anything?
 *
 * A cross-group drop always does, even to the same position, because the item
 * changes group. Within a group it only does when the resulting order differs,
 * which is what stops a press-and-release on a row from writing a `move_item`
 * that reorders nothing and still costs a request, a toast and a re-render.
 */
export function rowDropChangesOrder(input: {
  order: string[];
  requestId: string;
  beforeRequestId: string | null;
  sourceGroupId: string | null;
  targetGroupId: string;
}) {
  if (input.sourceGroupId !== input.targetGroupId) return true;
  if (input.beforeRequestId === input.requestId) return false;
  return (
    rowOrderAfterMove(input.order, input.requestId, input.beforeRequestId) !==
    input.order
  );
}

/**
 * How fast to creep, given how far PAST the edge threshold the pointer is.
 *
 * The old code moved the board by a flat 24px for every pointer event it saw,
 * which is not a speed at all: it is a staircase whose rate depends on how
 * often the browser happens to sample the pointer, and on a stationary finger
 * it is zero. This is a speed per FRAME, ramped quadratically so that easing
 * towards the edge creeps and pressing right into it moves properly — the same
 * shape the column drag uses, with a floor so that crossing the threshold at
 * all is always visible.
 */
export function edgeScrollSpeed(
  overshoot: number,
  edge = ROW_DRAG_EDGE,
  max = ROW_DRAG_MAX_SPEED,
) {
  if (overshoot <= 0) return 0;
  const ramp = Math.min(1, overshoot / edge);
  return (
    max * (ROW_DRAG_MIN_SPEED_RATIO + (1 - ROW_DRAG_MIN_SPEED_RATIO) * ramp * ramp)
  );
}

/** A scroller's edges, as the gesture measures them once per frame. */
export type EdgeBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * How far to move the board this frame, in both axes.
 *
 * Both axes at once and both signed, so a drag into a corner moves diagonally
 * rather than picking one. Zero everywhere in the middle, which is the common
 * case and costs one comparison per side.
 */
export function edgeScrollVector(
  pointerX: number,
  pointerY: number,
  box: EdgeBox,
  edge = ROW_DRAG_EDGE,
  max = ROW_DRAG_MAX_SPEED,
) {
  const left = edgeScrollSpeed(box.left + edge - pointerX, edge, max);
  const right = edgeScrollSpeed(pointerX - (box.right - edge), edge, max);
  const top = edgeScrollSpeed(box.top + edge - pointerY, edge, max);
  const bottom = edgeScrollSpeed(pointerY - (box.bottom - edge), edge, max);
  return { x: right - left, y: bottom - top };
}

/**
 * HOW WIDE THE LIFTED ROW IS, AND WHY IT USED TO BE WRONG ON A PHONE.
 *
 * The first version of this was one line at the call site:
 *
 *     const width = Math.min(Math.max(rect.width, 180), 320);
 *
 * `rect.width` is the whole row, which on this board is about 4,200px, so the
 * expression could only ever produce its own upper bound. Every preview, on
 * every device, was exactly 320px. On a 1440px desktop that is 22% of the
 * screen and looks deliberate. On a 390px phone it is 82% — a near edge-to-edge
 * slab with one word on it, which is precisely the "long flat duplicate strip"
 * the complaint described. A constant cannot be responsive, and nothing about
 * the row it was measuring ever reached the answer.
 *
 * So the width is now three things at once:
 *
 *   · WHAT IS BEING CARRIED. The reference product lifts something about as
 *     wide as the Name column, because that is the part of a row that says
 *     which row it is. `nameWidth` is the distance from the row's left edge to
 *     the right edge of its Name cell, measured live, so a person who has
 *     widened that column gets a wider preview.
 *   · A SHARE OF THE SCREEN. Clamped between 55% and 70% of the viewport, so a
 *     phone gets something that is obviously floating over the board rather
 *     than replacing it, and a desktop does not get a postage stamp.
 *   · AN ABSOLUTE CEILING. 300px, because past that it stops reading as an
 *     object and starts reading as a row again — which is the whole bug.
 *
 * Measured: 300px at 1440 (20.8% of the viewport) and 215–245px at 390
 * (55–63%), against 320px (82%) before.
 */
export const GHOST_MIN_FRACTION = 0.55;
export const GHOST_MAX_FRACTION = 0.7;
export const GHOST_MAX_WIDTH = 300;
/** Breathing room kept between the preview and the edge of a small screen. */
export const GHOST_VIEWPORT_MARGIN = 24;

export function ghostWidth(input: {
  /** The full row, which is the fallback when the Name cell cannot be found. */
  rowWidth: number;
  /** Row left edge → Name cell right edge. Zero when there is no Name cell. */
  nameWidth: number;
  viewportWidth: number;
}) {
  const { rowWidth, nameWidth, viewportWidth } = input;
  const low = Math.min(viewportWidth * GHOST_MIN_FRACTION, GHOST_MAX_WIDTH - 40);
  const high = Math.min(viewportWidth * GHOST_MAX_FRACTION, GHOST_MAX_WIDTH);
  const preferred = nameWidth > 0 ? nameWidth : rowWidth;
  const clamped = Math.min(Math.max(preferred, low), Math.max(low, high));
  return Math.round(
    Math.max(1, Math.min(clamped, viewportWidth - GHOST_VIEWPORT_MARGIN)),
  );
}

/**
 * WHERE A ROW STARTS, ONCE THE BOARD IS SCROLLED SIDEWAYS.
 *
 * `rect.left` is where the row begins in the DOCUMENT's terms, and on a board
 * scrolled 1,933px right that is -1,620: a coordinate no pixel of the row
 * occupies and no finger can be near. Two things were measured from it and both
 * were wrong at any `scrollLeft` but zero:
 *
 *   · THE GRAB OFFSET. `clientX - rect.left` said the row had been grabbed
 *     1,914px from its left edge, so `ghostOffset` clamped it to the preview's
 *     own width and hung the card 288px to the LEFT of the pointer — measured:
 *     pointer at x 349, preview at x 61. The grip that was actually pressed is
 *     in a STICKY cell sitting at the scroller's left edge, which is the whole
 *     reason it is still reachable at that scroll position.
 *   · THE PREVIEW'S WIDTH. `nameCell.right - rect.left` said the Name column
 *     was 2,185px wide, and only the clamp in `ghostWidth` hid it — on a phone
 *     it did not hide it, and a scrolled board produced a 273px preview where
 *     an unscrolled one produced 215px.
 *
 * The row's visible origin is the leftmost point of it that is on screen, which
 * is the scroller's own left edge whenever the row extends past it. Both
 * measurements are taken from there, and both then read the same at every
 * scroll position.
 */
export function visibleRowLeft(rowLeft: number, scrollerLeft: number) {
  return Math.max(rowLeft, scrollerLeft);
}

/**
 * How tall it is: the row's own height, floored so an empty row is still a
 * card and capped so a tall wrapped row does not become a second slab.
 */
export function ghostHeight(rowHeight: number) {
  return Math.round(Math.min(Math.max(rowHeight, 38), 48));
}

/**
 * Where the lifted preview sits, given where the row was grabbed.
 *
 * The preview is narrower than a full board row — a row can be 4,000px wide and
 * a preview that size is a smear rather than a thing being carried — so the
 * point that was grabbed is clamped into the preview's own width. Grab a row at
 * its far right and the preview hangs off the finger's left rather than
 * floating a screen and a half away, which is what an unclamped offset does.
 */
export function ghostOffset(
  grabOffsetX: number,
  grabOffsetY: number,
  ghostWidth: number,
  ghostHeight: number,
) {
  return {
    x: Math.min(Math.max(grabOffsetX, 12), Math.max(12, ghostWidth - 12)),
    y: Math.min(Math.max(grabOffsetY, 0), ghostHeight),
  };
}

/**
 * A CLIENT POINT THAT SURVIVES THE BOARD MOVING UNDER IT.
 *
 * The preview follows the pointer, so it needs no help. The two marks the drop
 * draws — the caret in the gap, and the dashed slot where the row came from —
 * are attached to the GRID, and the grid moves: the drag auto-scrolls at the
 * edges, and a person can be dragging with one hand while the board is already
 * scrolled 900px to the right.
 *
 * Re-measuring them every frame would mean a `getBoundingClientRect` per mark
 * per frame, on the one path that must not touch the DOM more than it already
 * does. It is also unnecessary: nothing reflows during a drag, so a point
 * measured once moves by exactly minus the scroll that has happened since —
 * both the scroller's own and the window's.
 *
 * That is why the marks are correct at `scrollLeft` 0 and at `scrollLeft` 900
 * alike, and why neither of them assumes the board starts at its left edge.
 */
export type ScrollFrame = {
  scrollLeft: number;
  scrollTop: number;
  pageLeft: number;
  pageTop: number;
};

export type AnchoredPoint = { left: number; top: number; frame: ScrollFrame };

export function anchorPoint(
  left: number,
  top: number,
  frame: ScrollFrame,
): AnchoredPoint {
  return { left, top, frame };
}

/** Where an anchored point is NOW, given the board's current scroll. */
export function anchoredAt(anchor: AnchoredPoint, frame: ScrollFrame) {
  return {
    x:
      anchor.left -
      (frame.scrollLeft - anchor.frame.scrollLeft) -
      (frame.pageLeft - anchor.frame.pageLeft),
    y:
      anchor.top -
      (frame.scrollTop - anchor.frame.scrollTop) -
      (frame.pageTop - anchor.frame.pageTop),
  };
}
