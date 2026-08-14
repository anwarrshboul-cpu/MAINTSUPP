/**
 * DATABASE SEED ONLY.
 *
 * These rows are inserted into `maintenance_board_options` the first time a
 * workspace is provisioned. Nothing in the application may import this file to
 * render, validate or filter — those paths read the database through
 * app/lib/options-repository.ts, so an admin's edits take effect immediately.
 *
 * Adding a value here does NOT add it to an existing workspace. Use the options
 * admin screen, or a migration.
 *
 * The values are derived from `monday-board-spec.ts` rather than written out
 * again here. Hand-maintaining a second copy is what let the two lists drift:
 * this file used to seed "Blocked - Awaiting information" where monday says
 * "Blocked - Awaiting Response", "Quote received" for "Quote Received (waiting
 * for Approval)", a "High" priority monday does not have, and six invented
 * statuses (Triage in progress, Contractor assigned, Visit booked, In progress,
 * Waiting for decision, Completed). Imported rows carrying monday's labels
 * would have landed on chips that did not exist.
 */
import type {
  BoardColumnOption,
  BoardOptionColumn,
} from "../app/lib/types";
import { maintenanceOptions } from "./monday-board-spec";

type SeedOption = Omit<BoardColumnOption, "id">;

/**
 * Maps a spec option-set key onto the board column that renders it. Both names
 * are kept because the spec is written in monday's vocabulary and the board is
 * written in the application's.
 */
const OPTION_SET_TO_COLUMN: Record<string, BoardOptionColumn> = {
  tier_level: "tier",
  engineer_required: "engineer",
  priority: "priority",
  maintenance_label: "label",
  maintenance_status: "status",
  store_location: "storeLocation",
};

export const defaultBoardOptions: SeedOption[] = Object.entries(
  OPTION_SET_TO_COLUMN,
).flatMap(([setKey, columnKey]) =>
  (maintenanceOptions[setKey] ?? []).map((entry, position) => ({
    columnKey,
    value: entry.value,
    label: entry.label,
    color: entry.colour,
    textColor: entry.textColour ?? "#ffffff",
    active: true,
    system: true,
    position,
  })),
);
