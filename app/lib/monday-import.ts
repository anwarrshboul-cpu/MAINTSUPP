/**
 * Reads a monday.com board export into rows the board can store.
 *
 * MONDAY'S EXPORT SHAPE
 *
 * "Export board to Excel" writes one sheet laid out by group, not one flat
 * table:
 *
 *     Maintenance                          <- board name
 *                                          <- blank
 *     Incoming requests                    <- group name, alone on its row
 *     Name  Location  Description  …       <- header, repeated per group
 *     MN-1  Aldgate   Back shutter …
 *     MN-2  Watford   Display
 *                                          <- blank
 *     Jobs Booked
 *     Name  Location  Description  …
 *     …
 *
 * The header repeats inside every group, so a parser that assumes one header at
 * the top silently reads twenty-odd header rows in as items. Groups are
 * identified by position — a row with exactly one non-empty cell, immediately
 * before a header row.
 *
 * COLUMN MATCHING
 *
 * Headers are matched against the board spec's titles, case- and
 * punctuation-insensitively, because an export carries the title as displayed
 * and titles pick up stray spaces ("Westfield Stratford  completed" has two).
 * Anything unmatched is reported rather than dropped, so a column that has been
 * renamed on monday since the capture is visible instead of vanishing.
 */
import {
  maintenanceColumns,
  storeDocumentationColumns,
} from "../../db/monday-board-spec";
import { excelSerialToISO } from "./xlsx-reader";

export type ImportBoardKey = "maintenance" | "store-documentation";

export type ImportedItem = {
  /** 1-based row number in the source file, for error reporting. */
  sourceRow: number;
  group: string;
  /** Column key from the board spec → cell value. */
  values: Record<string, string>;
};

export type ImportPlan = {
  board: ImportBoardKey;
  groups: string[];
  items: ImportedItem[];
  /** Header labels that matched no column on the board. */
  unmatchedColumns: string[];
  /** Column keys the board has that the file never supplied. */
  missingColumns: string[];
  /** Rows skipped, with the reason. Never silently dropped. */
  skipped: Array<{ sourceRow: number; reason: string }>;
};

function columnsFor(board: ImportBoardKey) {
  return board === "maintenance" ? maintenanceColumns : storeDocumentationColumns;
}

/** Lowercases, strips punctuation and collapses runs of whitespace. */
function normalise(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Where monday's own item id is carried, when the export includes it.
 *
 * Deliberately not a board column: it is the source row's identity, not
 * something anyone should see in a cell. It exists because matching on the
 * display name does not work on a real board. The Maintenance board names 700+
 * of its 744 items "Incoming form answer" — every form submission gets the same
 * name — so a title-keyed import folded 713 distinct jobs onto the rows that
 * happened to be there first, and reported it as "updated". Store Documentation
 * never showed the fault because store names are unique.
 *
 * The prefix keeps it out of the board's key space, so it can never be mistaken
 * for a column key by anything downstream.
 */
export const EXTERNAL_ID_KEY = "__externalId";

/**
 * Header aliases. Monday's export writes the Name column's header as the board's
 * item noun ("Item", "Store", "Name") depending on how the board is configured,
 * and a few titles were shortened on the board after the capture.
 */
const ALIASES: Record<string, string> = {
  name: "name",
  item: "name",
  store: "name",
  subject: "name",
  "store name": "name",
  // monday's own row identity. Not a board column — see EXTERNAL_ID_KEY.
  "item id": EXTERNAL_ID_KEY,
  "item id ": EXTERNAL_ID_KEY,
  "monday item id": EXTERNAL_ID_KEY,
  "pulse id": EXTERNAL_ID_KEY,
  "job requested by": "requester",
  "date requested": "requested",
  "date completed": "completed",
  "next update": "nextUpdate",
  "cost of works": "cost",
  "approved by": "approvedBy",
  "assigned to": "assignee",
  "engineer required": "engineer",
  "tier level": "tier",
  "store location name": "storeLocation",
  "contact number": "number",
  "form view": "formView",
  "pictures of maintenance issue": "issuePictures",
  "picture of completed works": "completedPictures",
  "description of works to be done": "description",
};

function isBlank(row: string[]) {
  return row.every((cell) => !cell || !cell.trim());
}

function nonEmpty(row: string[]) {
  return row.filter((cell) => cell && cell.trim());
}

/**
 * Builds the header → column-key map for one header row.
 * Returns null when the row is not a header.
 */
function matchHeader(row: string[], board: ImportBoardKey) {
  const columns = columnsFor(board);
  const byTitle = new Map<string, string>();
  for (const column of columns) {
    byTitle.set(normalise(column.title), column.key);
  }

  const mapping: Array<{ index: number; key: string | null; label: string }> = [];
  let matched = 0;

  row.forEach((cell, index) => {
    const label = (cell ?? "").trim();
    if (!label) {
      mapping.push({ index, key: null, label });
      return;
    }
    const slug = normalise(label);
    const key = byTitle.get(slug) ?? ALIASES[slug] ?? null;
    if (key) matched += 1;
    mapping.push({ index, key, label });
  });

  // A header row has to match several columns. One or two matches is an item
  // that happens to contain the word "Status".
  return matched >= 3 ? mapping : null;
}

/**
 * Converts a raw cell to the value the board stores.
 *
 * Dates arrive either as an Excel serial (from .xlsx) or already formatted
 * (from .csv). Both are normalised to `YYYY-MM-DD`; anything unrecognised is
 * kept verbatim rather than blanked, so a human can see what came across.
 */
function cellValue(raw: string, type: string): string {
  const value = (raw ?? "").trim();
  if (!value) return "";

  if (type === "date" || type === "timeline") {
    if (/^\d+(\.\d+)?$/.test(value)) {
      return excelSerialToISO(Number(value)) ?? value;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return value;
  }

  if (type === "number") {
    const numeric = Number(value.replace(/[£$€,\s]/g, ""));
    return Number.isFinite(numeric) ? String(numeric) : value;
  }

  return value;
}

/**
 * Parses an export into a plan. Pure — it reads rows and returns what it found,
 * so the same function backs both the preview and the commit and the two cannot
 * disagree.
 */
export function planImport(rows: string[][], board: ImportBoardKey): ImportPlan {
  const columns = columnsFor(board);
  const typeByKey = new Map(columns.map((column) => [column.key, column.type]));

  const plan: ImportPlan = {
    board,
    groups: [],
    items: [],
    unmatchedColumns: [],
    missingColumns: [],
    skipped: [],
  };

  let mapping: ReturnType<typeof matchHeader> = null;
  let group = "";
  let pendingGroup = "";
  const seenGroups = new Set<string>();
  const seenKeys = new Set<string>();
  const unmatched = new Set<string>();

  rows.forEach((row, index) => {
    const sourceRow = index + 1;
    if (isBlank(row)) {
      // A blank line ends a group; the next single-cell row names the new one.
      pendingGroup = "";
      return;
    }

    const header = matchHeader(row, board);
    if (header) {
      mapping = header;
      for (const entry of header) {
        if (entry.label && !entry.key) unmatched.add(entry.label);
        if (entry.key) seenKeys.add(entry.key);
      }
      // The row before a header, if it held a single value, was the group name.
      if (pendingGroup) {
        group = pendingGroup;
        pendingGroup = "";
        if (!seenGroups.has(group)) {
          seenGroups.add(group);
          plan.groups.push(group);
        }
      }
      return;
    }

    const filled = nonEmpty(row);

    /*
     * A lone value is either the board title (before any header) or a group
     * name (before the next header).
     *
     * "Lone" has to mean the row HOLDS one cell, not that one cell happens to
     * be filled. `nonEmpty` discards the empties, so an item whose only
     * populated column is its Name — `Warehouse 1,,,,,,,,,` — reduced to a
     * single value and was read as a group heading. The item then vanished:
     * not imported, not skipped, not counted, and a phantom group appeared in
     * its place. Three real stores went that way on the Store Documentation
     * expiry import (Cribbs Causeway - Bristol, Warehouse 1, Warehouse 2), and
     * the preview said 28 items for a 31-row file.
     *
     * The maintenance board never exposed it because its export carries an
     * Item ID beside every Name, so two cells are always filled.
     *
     * A genuine group heading occupies one cell on its row; an item row is as
     * wide as its header even when almost all of it is blank. `row.length` is
     * what separates them, and it is checked FIRST so a wide, nearly-empty row
     * can never be mistaken for a heading.
     */
    if (row.length <= 1 && filled.length === 1) {
      pendingGroup = filled[0].trim();
      return;
    }

    /*
     * A row with a name and nothing else is still an item.
     *
     * Reached only when the row is wide, so it cannot be a heading. Without
     * this the row falls through to the mapping below, which is the correct
     * outcome — this branch exists to make the "no values at all" case
     * explicit rather than to change it.
     */
    if (filled.length === 0) return;

    if (!mapping) {
      plan.skipped.push({
        sourceRow,
        reason: "Appears before any column header — no way to tell what the values are.",
      });
      return;
    }

    const values: Record<string, string> = {};
    for (const entry of mapping) {
      if (!entry.key) continue;
      const raw = row[entry.index] ?? "";
      const value = cellValue(raw, typeByKey.get(entry.key) ?? "text");
      if (value) values[entry.key] = value;
    }

    if (!values.name) {
      plan.skipped.push({ sourceRow, reason: "No name — an item must have one." });
      return;
    }

    if (group && !seenGroups.has(group)) {
      seenGroups.add(group);
      plan.groups.push(group);
    }

    plan.items.push({ sourceRow, group, values });
  });

  plan.unmatchedColumns = [...unmatched].sort();
  plan.missingColumns = columns
    .filter((column) => !seenKeys.has(column.key) && column.type !== "subitems")
    .map((column) => column.title)
    .sort();

  return plan;
}
