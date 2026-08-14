/**
 * Board structure seed — Stage 4, items N11 and O13.
 *
 * This file used to carry its own column and group definitions, which competed
 * with `systemBoardColumns` in `app/api/board/route.ts`. Both wrote into
 * `maintenance_board_columns` under different keys, so a seeded board came up
 * with 38 columns instead of 25 and a visibly duplicated header row.
 *
 * The definitions now live in `monday-board-spec.ts` and both seeders read from
 * there. This module is kept as the stable import surface — `db/init.ts` and
 * the tests import `seedColumns` / `seedGroups` from here — and re-exports the
 * spec under those names.
 *
 * Reversing an earlier decision: the 28 per-store and per-month archive groups
 * ARE now seeded. The board is replacing monday rather than summarising it, so
 * dropping 28 groups would have stranded the work filed in them. They seed
 * collapsed, which keeps the operational top of the board readable.
 */

export type { SeedColumn, SeedGroup } from "./monday-board-spec";

export {
  /** The 25 columns, in monday board order. */
  maintenanceColumns as seedColumns,
  /** All 38 groups, in monday board order. */
  maintenanceGroups as seedGroups,
  /** The "move to group" control. Not a monday column. */
  maintenanceUiColumns as seedUiColumns,
  /** Option values per option-set key. */
  maintenanceOptions as seedOptions,
} from "./monday-board-spec";
