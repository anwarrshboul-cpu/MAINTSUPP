/**
 * Which columns are frozen against the left edge, and where each one sits.
 *
 * `maintenance_board_columns.pinned` has existed since Stage 1. The PATCH route
 * accepted it, the board payload never returned it and no control ever set it,
 * so the board could hold a pin it had no way to draw. This is the drawing half.
 *
 * WHY THE OFFSETS ARE COMPUTED IN JS RATHER THAN WRITTEN IN CSS
 *
 * A sticky column's `left` is the sum of the widths of everything sticky to its
 * left, and those widths are DATA — a column's width is stored per workspace
 * and dragged at runtime. `.sheet-column--name { left: 72px }` could be a
 * literal because exactly one column was ever sticky and the checkbox gutter
 * ahead of it is fixed. With an arbitrary set of pins that literal becomes a
 * running total, and a resize has to move every pin to its right.
 *
 * THE ITEMS COLUMN IS PART OF THE SET, NOT AN EXCEPTION TO IT. Name has been
 * sticky since the grid was written and stays sticky whether or not it is
 * pinned, so it is laid out here alongside the pins rather than left to the
 * stylesheet — otherwise a pinned column would have to guess Name's width, and
 * the two would drift apart the first time somebody dragged it.
 *
 * ORDER IS DISPLAY ORDER. A pinned column that has been reordered to sit before
 * Name is frozen before Name, which is the only reading of "pinned" that stays
 * true after a reorder.
 *
 * ON A PHONE NONE OF THIS APPLIES: the stylesheet unsticks the grid below
 * 760px, because two frozen columns on a 390px screen leave nothing to scroll.
 * `stickyColumnOffsets` is simply not consulted there.
 */

import type { BoardDisplayColumn } from "./board-model";
import { displayedBoardColumnWidth } from "./board-format";

/**
 * Where the sticky run starts, in pixels.
 *
 * MUST MATCH THE STYLESHEET: `.sheet-check` is sticky at `left: 34px` and 38px
 * wide, so the first column after it starts at 72 — which is the literal
 * `.sheet-column--name { left: 72px }` carried until now. Changing one without
 * the other puts a one-column gap or overlap at the left edge of every group.
 */
export const STICKY_RUN_START = 72;

export type StickyColumn = {
  /** Pixels from the scroll container's left edge. */
  left: number;
  /** 0 for the leftmost sticky column, 1 for the next, and so on. */
  order: number;
};

/**
 * The sticky columns, in display order, with each one's left offset.
 *
 * `columns` must already be filtered to what is drawn and collapsed widths must
 * already be applied — this reads `displayedBoardColumnWidth`, which is the
 * same function the header, the cells and the summary row measure with, so a
 * collapsed or mobile-narrowed column contributes the width it actually
 * occupies rather than the width it was stored at.
 */
export function stickyColumnOffsets(
  columns: BoardDisplayColumn[],
  mobile: boolean,
): Map<string, StickyColumn> {
  const offsets = new Map<string, StickyColumn>();
  if (mobile) return offsets;

  let left = STICKY_RUN_START;
  let order = 0;
  for (const entry of columns) {
    const sticky =
      (entry.kind === "system" && entry.key === "name") ||
      entry.column.pinned === true;
    if (!sticky) continue;
    offsets.set(entry.column.id, { left, order });
    left += displayedBoardColumnWidth(entry.column, mobile);
    order += 1;
  }
  return offsets;
}

/**
 * Stacking order for a sticky cell.
 *
 * Later sticky columns pass UNDER earlier ones as the grid scrolls, so z-index
 * descends with `order`. Header cells sit above body cells because the header
 * is also sticky vertically and has to cover the rows sliding beneath it. The
 * two bases are chosen to sit under the Items column's own `!important` values
 * (12 for a cell, 17 for a header), which keeps Name on top of everything
 * pinned after it without restating those numbers here.
 */
export function stickyZIndex(order: number, header: boolean) {
  return (header ? 15 : 10) - order;
}

/** How many columns are frozen, Items included. Used for the toolbar's label. */
export function pinnedColumnCount(columns: BoardDisplayColumn[]) {
  return columns.filter((entry) => entry.column.pinned === true).length;
}
