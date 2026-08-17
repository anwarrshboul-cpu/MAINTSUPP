"use client";

/**
 * The intrinsic height of a board group, so the browser can skip drawing it.
 *
 * `board-visibility.css` puts `content-visibility: auto` on every expanded
 * group; that only helps if the browser is told how tall a skipped group would
 * be, because otherwise the scrollbar is a lie and the page jumps as groups
 * render. This computes the height.
 *
 * THE NUMBERS BELOW ARE MEASURED, NOT ESTIMATED, and that distinction is the
 * whole reason this approach is safe. Every group on /dashboard/jobs was read
 * out of a real Chrome with `getBoundingClientRect`, and against the formula
 * `43 + 38 + rows * 40 + 40` the residual was exactly 0 for all 38 of them —
 * one distinct value, no spread. It is exact rather than close because the
 * board's tables are `table-layout: fixed` with an explicit `height` on every
 * `th` and `td`, so no cell can grow to its content and no row can be a
 * different height from any other.
 *
 * That is what separates this from windowing with guessed row heights, which
 * the brief rightly calls worse than no windowing: there is nothing to guess.
 *
 * The one case the formula does not cover is a row with its subitems expanded,
 * which adds a nested table below it. It does not need to: `contain-intrinsic-
 * size` is declared with the `auto` keyword, so once a group has been rendered
 * the browser remembers its real height and uses that instead of this value.
 * A group can only have subitems expanded if the reader expanded them, which
 * means it was on screen, which means it has been rendered. The computed height
 * only ever has to be right for a group that has not yet been seen.
 */

import "./board-visibility.css";

/** The group's own header row — name, count, rename, actions. */
const GROUP_HEADER_HEIGHT = 43;

/** The sticky column header row inside the group's table. */
const COLUMN_HEADER_HEIGHT = 38;

/** Every data row. Fixed by `.live-sheet th, .live-sheet td { height: 40px }`. */
const ROW_HEIGHT = 40;

/** The trailing "+ Add item" row, present in every expanded group. */
const ADD_ROW_HEIGHT = 40;

const GROUP_CHROME_HEIGHT =
  GROUP_HEADER_HEIGHT + COLUMN_HEADER_HEIGHT + ADD_ROW_HEIGHT;

/**
 * The class that opts a group into being skipped while off screen.
 *
 * Collapsed groups do not get it: they are one 43px header with no table under
 * them, so there is nothing to skip and the height formula above — which counts
 * a column header and an add row that a collapsed group does not draw — would
 * be wrong for them.
 */
export const DEFERRED_GROUP_CLASS = "is-deferred";

/** The height a group of `rowCount` rows occupies, in CSS pixels. */
export function deferredGroupHeight(rowCount: number): number {
  return GROUP_CHROME_HEIGHT + rowCount * ROW_HEIGHT;
}
