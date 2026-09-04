/**
 * The two derivations that turn a board's stored columns into what the grid
 * draws — split out of `board-model.ts` when it reached its 600-line ceiling.
 *
 * Both are pure and both are about COLUMNS rather than about the board's shape,
 * which is what `board-model.ts` is for: one takes the two stored lists and
 * returns the single ordered list every engine walks, the other turns a
 * column's saved chips into the choices it offers. Capped in
 * `tests/stage-eight-board-split.test.mjs` from the start, for the reason the
 * notes there give — a file created to relieve a ceiling is the easiest place
 * for the next thing to be dropped without anyone noticing.
 */

import type { BoardOptionColumn, MaintenanceBoardColumn } from "../../lib/types";
import {
  type BoardDisplayColumn,
  type ColumnKey,
  type Option,
  editableFallbackOptions,
} from "./board-model";

/**
 * EVERY COLUMN THE GRID DRAWS, in the order it draws them.
 *
 * The board keeps its columns in two lists that mean different things — the
 * request-backed `system` ones and the cell-backed `custom` ones — and every
 * engine that walks columns (sort, filter, the column menu, the pickers) needs
 * them as ONE ordered list tagged with which kind each is. Extracted from
 * `live-board.tsx` unchanged; it is pure, and it belongs beside the
 * `BoardDisplayColumn` type it produces.
 *
 * Sorted by stored `position`, which is the only order the board honours —
 * interleaving the two lists by anything else would put a custom column
 * somewhere the operator never dragged it.
 */
export function boardDisplayColumns(
  systemColumns: MaintenanceBoardColumn[],
  customColumns: MaintenanceBoardColumn[],
): BoardDisplayColumn[] {
  return [
    ...systemColumns.map(
      (column): BoardDisplayColumn => ({
        kind: "system",
        key: column.key as ColumnKey,
        column,
      }),
    ),
    ...customColumns.map((column): BoardDisplayColumn => ({ kind: "custom", column })),
  ].sort((left, right) => left.column.position - right.column.position);
}


/**
 * The choices one option-backed column offers, saved ones first.
 *
 * Extracted from `live-board.tsx`; pure, and it belongs beside
 * `editableFallbackOptions`, which is the list it falls back to. A board whose
 * chips have never been edited has no rows of its own, and the fallback is what
 * stops the column rendering an empty menu on its first load.
 */
export function boardColumnOptions(
  boardOptions: Array<{
    id: string;
    columnKey: string;
    value: string;
    label: string;
    color: string;
    textColor: string;
    active: boolean;
    system: boolean;
    position: number;
  }>,
  columnKey: BoardOptionColumn,
): Option[] {
  const saved = boardOptions
    .filter((option) => option.columnKey === columnKey)
    .sort((a, b) => a.position - b.position)
    .map((option) => ({
      id: option.id,
      value: option.value,
      label: option.label,
      color: option.color,
      text: option.textColor,
      active: option.active,
      system: option.system,
    }));
  return saved.length ? saved : editableFallbackOptions[columnKey];
}
