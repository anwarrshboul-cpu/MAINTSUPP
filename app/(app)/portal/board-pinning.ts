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
 * ON A PHONE NONE OF THIS APPLIES, and the reason has changed even though the
 * behaviour of this module has not. Below 760px the stylesheet freezes exactly
 * ONE cell — the Items column, at `left: 0` — and unfreezes everything else,
 * the selection gutter and any column the reader pinned from the toolbar
 * included. Measured on a 320px screen, the gutter and Items together held
 * 192px of the display and left 125px to scroll twenty columns through;
 * freezing one of them leaves 167px. A running total is therefore not needed
 * and would be wrong: there is one frozen column, it is first, and its offset
 * is the literal 0 written in `globals.css` under "ONE FROZEN COLUMN ON A
 * PHONE". `stickyColumnOffsets` returns an empty map here and is not consulted.
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
 * is also sticky vertically and has to cover the rows sliding beneath it.
 *
 * THE HEADER BASE WAS 15 AND THAT WAS WRONG BY 26.
 *
 * The comment this replaces said the bases sat "under the Items column's own
 * `!important` values (12 for a cell, 17 for a header)". Those numbers are not
 * what the stylesheet holds and have not been for some time. What it holds is
 * `--z-sticky: 40`, and every rule that matters is expressed against it:
 *
 *     .live-sheet th                     → calc(var(--z-sticky) + 1)  = 41
 *     .sheet-column--name                → calc(var(--z-sticky) + 2)  = 42  !important
 *     .sheet-check                       → calc(var(--z-sticky) + 3)  = 43  !important
 *     .live-sheet thead .sheet-column--name → calc(var(--z-sticky) + 6) = 46 !important
 *     .live-sheet thead .sheet-check     → calc(var(--z-sticky) + 7)  = 47  !important
 *
 * Name and the checkbox gutter carry `!important`, so a stylesheet rule beats
 * the inline number and they were never affected. A PINNED column carries no
 * such rule, so it took the inline 15 — and ORDINARY headers sit at 41. Every
 * unpinned header therefore painted OVER the pinned header it was supposed to
 * slide beneath, which is the "the left edge goes wrong halfway through a
 * scroll" report: the frozen header vanished under the traffic while its own
 * body cells (which only compete with unpositioned `td`s, and so won at 10)
 * stayed put. Header and body disagreed by exactly the width of the bug.
 *
 * The band is therefore 42–45: above every ordinary header, below the two
 * `!important` thead rules so Items and the gutter stay on top of everything
 * frozen after them. Four slots is more than the pin count the toolbar can
 * produce in practice; past that the floor makes later pins TIE rather than
 * fall through the ordinary headers, and a tie between two frozen columns is
 * invisible because they occupy disjoint left offsets and never overlap.
 *
 * The body base keeps its long-standing 10 — an unpositioned `td` paints below
 * every positioned box regardless — with a floor of its own, because at eleven
 * pins the old expression went negative and a negative z-index would have
 * dropped a frozen cell BEHIND the rows scrolling under it.
 */
export function stickyZIndex(order: number, header: boolean) {
  return header ? Math.max(42, 45 - order) : Math.max(1, 10 - order);
}

/** How many columns are frozen, Items included. Used for the toolbar's label. */
export function pinnedColumnCount(columns: BoardDisplayColumn[]) {
  return columns.filter((entry) => entry.column.pinned === true).length;
}
