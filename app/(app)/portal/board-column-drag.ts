/**
 * Dragging a column header to a new place — the arithmetic, without React.
 *
 * WHY THIS IS NOT HTML5 DRAG-AND-DROP, WHICH IS WHAT IT WAS.
 *
 * The first attempt put `draggable` on the header's title and listened for
 * `dragstart` / `dragover` / `drop`. It never fired once in a real browser, and
 * the reason is three lines of CSS that predate it:
 *
 *     .custom-column-header > strong {
 *       position: absolute;   …   pointer-events: none;
 *     }
 *
 * The title is a CENTRING OVERLAY. It is absolutely positioned across the whole
 * cell so the label sits in the middle regardless of which controls flank it,
 * and it is pointer-transparent so it does not swallow the clicks meant for the
 * sort arrow and the `…` button underneath it. An element that never receives a
 * `mousedown` can never begin a drag, so `dragstart` was never dispatched —
 * measured in Chromium: `pointerdown`, `mousedown`, `selectstart`, `mouseup`,
 * `click`, and no drag event of any kind.
 *
 * Removing `pointer-events: none` would have started the drag and broken the
 * two controls the rule exists to protect. So the drag moved to POINTER EVENTS
 * on the header cell itself, which is also what the row drag beside it already
 * does. That buys four things the DOM API was not going to give:
 *
 *   · a movement THRESHOLD, so a click stays a click and a drag is a drag —
 *     which is what keeps a drop from also firing the quick sort;
 *   · no `dragover` storm. The board draws 1,102 header cells across 38 groups;
 *     setting React state on every `dragover` re-rendered all of them sixty
 *     times a second. The drop index is recomputed on every move but the state
 *     is written only when it CHANGES;
 *   · `setPointerCapture`, so the drag survives the pointer leaving the header;
 *   · one place to say "not from the resize handle, the sort arrow or the menu".
 *
 * Everything here is pure: same input, same output, no DOM and no state, so the
 * index arithmetic can be tested against numbers rather than against a browser.
 */

import type { BoardDisplayColumn } from "./board-model";

/** Where a header sits, measured once at the start of a drag. */
export type ColumnBox = { id: string; left: number; right: number };

/**
 * How far a mouse must move before a press becomes a drag.
 *
 * Four pixels, matching the row drag next door. Below it the gesture is still a
 * click and the header's own controls behave exactly as they always have.
 */
export const COLUMN_DRAG_THRESHOLD = 4;

/**
 * Which gap the pointer is currently over, as an index into the CURRENT order.
 *
 * "Insert before column N", so a value equal to the array length means "after
 * everything". The comparison is against each header's midpoint, which is what
 * makes the indicator flip exactly when the pointer crosses the middle of a
 * column rather than when it leaves the previous one.
 */
export function columnDropIndex(pointerX: number, boxes: ColumnBox[]): number {
  for (const [index, box] of boxes.entries()) {
    if (pointerX < (box.left + box.right) / 2) return index;
  }
  return boxes.length;
}

/**
 * The order after dropping `columnId` into the gap at `insertBefore`.
 *
 * The index is expressed against the order INCLUDING the dragged column, which
 * is what the pointer is actually over, so it has to be adjusted once the
 * column is lifted out: every gap to the right of where it was shifts left by
 * one. Getting that wrong is the classic off-by-one that makes a column
 * "refuse" to move one place right.
 *
 * A move that changes nothing returns the original array, so a caller can use
 * identity to decide whether there is anything to save.
 */
export function moveColumnTo<T extends { column: { id: string } }>(
  order: T[],
  columnId: string,
  insertBefore: number,
): T[] {
  const from = order.findIndex((entry) => entry.column.id === columnId);
  if (from < 0) return order;
  const to = insertBefore > from ? insertBefore - 1 : insertBefore;
  if (to === from || to < 0 || to > order.length - 1) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Whether a column belongs to the board's frozen leading region.
 *
 * The Items column is sticky by construction and a pinned column is sticky by
 * request; both are laid out as one contiguous run from the left edge — see
 * `stickyColumnOffsets`.
 */
export function isFrozenColumn(entry: BoardDisplayColumn) {
  return (
    (entry.kind === "system" && entry.key === "name") || entry.column.pinned === true
  );
}

/**
 * THE RULE: FROZEN COLUMNS KEEP THE LEADING REGION.
 *
 * A frozen column is drawn against the left edge of the viewport while the rest
 * of the board scrolls under it. If the order allowed a frozen column to sit
 * between two scrolling ones, the run of `left` offsets would no longer be
 * contiguous: a column pinned at position 12 would be painted at the left edge
 * on top of whatever had scrolled beneath it, and the columns between would
 * disappear behind it. There is no arrangement of offsets that makes a
 * non-contiguous frozen set read correctly, so the ORDER is what gives.
 *
 * Every reorder therefore ends here: frozen columns first in their own relative
 * order, then the rest in theirs. Both halves keep the order the drag produced,
 * so a drag WITHIN either half does exactly what it looks like, and a drag that
 * would interleave them is pulled to the nearest arrangement that can actually
 * be drawn. The caller compares the result with what it asked for and tells the
 * operator when the rule moved something, rather than letting the board quietly
 * disagree with the gesture.
 *
 * With nothing pinned this is the identity function, which is the common case.
 */
export function withFrozenColumnsLeading<T extends BoardDisplayColumn>(order: T[]): T[] {
  const frozen = order.filter(isFrozenColumn);
  if (!frozen.length || frozen.length === order.length) return order;
  const scrolling = order.filter((entry) => !isFrozenColumn(entry));
  const next = [...frozen, ...scrolling];
  return next.every((entry, index) => entry === order[index]) ? order : next;
}

/** Which header the drop indicator is drawn on, and which side of it. */
export type ColumnDropMarker = { columnId: string; side: "before" | "after" } | null;

/**
 * The indicator for a drop at `insertBefore`, or null when the drop would not
 * move anything.
 *
 * Past the last column the marker moves to that column's trailing edge rather
 * than vanishing, because "drop at the end" needs to look like somewhere.
 */
export function columnDropMarker<T extends { column: { id: string } }>(
  order: T[],
  columnId: string,
  insertBefore: number,
): ColumnDropMarker {
  const from = order.findIndex((entry) => entry.column.id === columnId);
  if (from < 0) return null;
  // Dropping into either gap beside where it already sits changes nothing.
  if (insertBefore === from || insertBefore === from + 1) return null;
  if (insertBefore >= order.length) {
    const last = order.at(-1);
    return last ? { columnId: last.column.id, side: "after" } : null;
  }
  return { columnId: order[insertBefore].column.id, side: "before" };
}
