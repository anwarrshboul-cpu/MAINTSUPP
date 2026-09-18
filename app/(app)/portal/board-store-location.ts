"use client";

/**
 * What the Store Location Name column may be set to on THIS board.
 *
 * TWO SOURCES, BECAUSE THE COLUMN HAS TWO MEANINGS IN THE FIELD.
 *
 * `/api/board` builds options for this column from the site register, so on an
 * estate that files jobs against shops the picker offers the shops — carrying
 * the site's own id (`site-option-<id>`) and its colour, which is what lets a
 * rename reach every row filed under it.
 *
 * But the column is free text underneath, and a workspace that files jobs by
 * AREA uses it that way: the demonstration workspace holds "Whole site",
 * "Loading bay" and "Back of house", not one of which is a site. Offering only
 * the register there would leave the picker unable to express a single value
 * the board actually holds.
 *
 * So: the register first, then every value already in use that the register did
 * not already name. Never empty while one cell is filled, and never missing the
 * value of the cell being edited.
 *
 * THE EXTRAS CARRY NO `id`, AND THAT IS THE POINT. `OptionCell`'s label editor
 * disables every control for an option without one, so a shop can be renamed
 * from the board — it is a row in a register, and the rename lands there — while
 * a free-text area cannot, because there is nothing to rename it IN. Changing
 * one of those is editing the cell.
 *
 * WHY THIS IS NOT NEW. The list was already being built, in
 * `board-column-summary.tsx`, to colour the column's footer — which is exactly
 * why the distribution bar under Store Location drew a palette while every chip
 * above it drew in `groupColors[0]`: the summary knew the values and the cell
 * did not. One function now, read by both.
 */

import type { Option } from "./board-model";

/**
 * A free-text value's colour, derived from the value itself.
 *
 * NOT `palette[index]`. The extras are read off the rows the board is showing,
 * so an index-picked colour changes the moment a filter hides a row or a sort
 * reorders one — "Loading bay" would be amber on one screen and purple on the
 * next. Hashing the value pins it: the same area is the same colour on every
 * board, in every session and on every device, which is the rule
 * `memberColour` in assignee-directory.ts already follows for the same reason.
 */
function colourFor(value: string, palette: readonly string[]): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

export function storeLocationChoices(
  siteOptions: Option[],
  rows: Array<{ location?: string | null }>,
  palette: readonly string[],
): Option[] {
  const seen = new Set(siteOptions.map((option) => option.value));
  const extras: Option[] = [];
  for (const row of rows) {
    const value = row.location?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    extras.push({ value, color: colourFor(value, palette) });
  }
  /* Alphabetical, so the list does not reorder itself as rows are filtered or
     sorted — the register's own order is kept for the half that has one. */
  extras.sort((left, right) => left.value.localeCompare(right.value));
  return [...siteOptions, ...extras];
}
