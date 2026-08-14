/**
 * Diffs every column title and option set in the app against the live monday
 * boards, in monday's own display order.
 *
 * The board spec in `db/monday-board-spec.ts` was captured by hand from the
 * monday UI. This reads the same information from the API — labels, colours and
 * `labels_positions_v2`, which is the order monday actually draws them in — and
 * reports every difference. Where the two disagree the API wins: it is the
 * board, not a transcription of it.
 *
 * Deliberately read-only. It prints a diff and exits; fixing anything is a
 * separate, reviewable edit to the spec.
 *
 * Usage: node db/monday-export/audit-labels.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULL = path.join(HERE, "api-pull");

const {
  maintenanceOptions,
  maintenanceColumns,
  storeDocumentationColumns,
  storeDocumentationOptions,
} = await import("../monday-board-spec.ts");

/*
 * The two boards keep their option sets in separate exports, so a lookup in
 * `maintenanceOptions` alone reports Store Type as "missing from spec" when it
 * is simply declared elsewhere. Merged here rather than special-cased at the
 * call site, so a third board's sets can join the same way.
 */
const SPEC_OPTIONS = { ...maintenanceOptions, ...storeDocumentationOptions };

const boards = JSON.parse(readFileSync(path.join(PULL, "columns.json"), "utf8"));
const byBoardId = new Map(boards.map((board) => [board.id, board]));

const MAINTENANCE = "1139774521";
const STORE_DOC = "1398027719";

/**
 * The app's option-set key for each monday column.
 *
 * Written out rather than inferred from the title, because the two names differ
 * on purpose in places ("Engineer Required" -> `engineer_required`) and a
 * guessed mapping would silently compare the wrong pair.
 */
const OPTION_SETS = [
  { board: MAINTENANCE, columnId: "dropdown_mm51wmh0", key: "tier_level" },
  { board: MAINTENANCE, columnId: "single_select", key: "engineer_required" },
  { board: MAINTENANCE, columnId: "status", key: "priority" },
  { board: MAINTENANCE, columnId: "color_mm0ahrtb", key: "maintenance_label" },
  { board: MAINTENANCE, columnId: "status1", key: "maintenance_status" },
  { board: MAINTENANCE, columnId: "single_selecty9rcyhe", key: "store_location" },
  { board: STORE_DOC, columnId: "text9", key: "store_type" },
];

/**
 * monday's options for a column, in the order monday draws them.
 *
 * `labels` is keyed by the index stored in a cell, and those indices are NOT
 * the display order — a board that has had options added and reordered over
 * years ends up with index 102 sitting third. `labels_positions_v2` maps index
 * to position, and that is what the board shows. Sorting by index instead
 * would produce a list that matches no screen anyone has seen.
 *
 * Options whose label is empty are dropped: monday keeps the index reserved
 * when an option is deleted, and an empty entry is a tombstone rather than a
 * choice somebody can pick.
 */
function mondayOptions(column) {
  let settings = {};
  try {
    settings = JSON.parse(column.settings_str || "{}");
  } catch {
    return [];
  }
  const labels = settings.labels ?? {};
  const colours = settings.labels_colors ?? {};
  const positions = settings.labels_positions_v2 ?? {};

  return Object.keys(labels)
    .map((index) => ({
      index,
      label: typeof labels[index] === "object" ? labels[index].name : labels[index],
      colour: colours[index]?.color ?? null,
      position: positions[index] ?? Number(index),
    }))
    .filter((entry) => (entry.label ?? "").trim() !== "")
    .sort((a, b) => a.position - b.position);
}

let problems = 0;
const note = (message) => {
  problems += 1;
  console.log(message);
};

/* ---- Column titles ---------------------------------------------- */

console.log("=".repeat(72));
console.log("COLUMN TITLES");
console.log("=".repeat(72));

for (const [boardId, specColumns, label] of [
  [MAINTENANCE, maintenanceColumns, "Maintenance"],
  [STORE_DOC, storeDocumentationColumns, "Store Documentation UK"],
]) {
  const live = byBoardId.get(boardId);
  const liveTitles = live.columns.map((column) => column.title);
  const specTitles = specColumns.map((column) => column.title);

  console.log(`\n${label} — spec ${specTitles.length}, monday ${liveTitles.length}`);

  for (const title of specTitles) {
    if (!liveTitles.includes(title)) {
      note(`  SPEC ONLY   ${JSON.stringify(title)}`);
    }
  }
  for (const title of liveTitles) {
    if (title === "Name") continue;
    if (!specTitles.includes(title)) {
      note(`  MONDAY ONLY ${JSON.stringify(title)}`);
    }
  }
}

/* ---- Option sets ------------------------------------------------- */

console.log(`\n${"=".repeat(72)}`);
console.log("OPTION LABELS, COLOURS AND ORDER");
console.log("=".repeat(72));

for (const entry of OPTION_SETS) {
  const board = byBoardId.get(entry.board);
  const column = board.columns.find((candidate) => candidate.id === entry.columnId);
  if (!column) {
    note(`\n  MISSING monday column ${entry.columnId}`);
    continue;
  }

  const live = mondayOptions(column);
  const spec = SPEC_OPTIONS[entry.key] ?? [];

  console.log(`\n"${column.title}"  (${entry.columnId} -> ${entry.key})`);
  console.log(`  monday ${live.length} options, spec ${spec.length}`);

  const rows = Math.max(live.length, spec.length);
  for (let i = 0; i < rows; i += 1) {
    const l = live[i];
    const s = spec[i];

    if (l && !s) {
      note(`  [${i}] MISSING FROM SPEC   ${JSON.stringify(l.label)}  ${l.colour ?? ""}`);
      continue;
    }
    if (s && !l) {
      note(`  [${i}] NOT ON MONDAY       ${JSON.stringify(s.label)}  ${s.colour}`);
      continue;
    }

    const labelMatch = l.label === s.label;
    // A plain dropdown carries no colours on monday, so there is nothing to
    // disagree with — only a status column's colours are compared.
    const colourMatch =
      l.colour === null || l.colour.toLowerCase() === (s.colour ?? "").toLowerCase();

    if (!labelMatch) {
      note(`  [${i}] LABEL   monday ${JSON.stringify(l.label)}  !=  spec ${JSON.stringify(s.label)}`);
    }
    if (!colourMatch) {
      note(`  [${i}] COLOUR  monday ${l.colour}  !=  spec ${s.colour}   (${l.label})`);
    }
  }
}

console.log(`\n${"=".repeat(72)}`);
console.log(problems === 0 ? "No differences." : `${problems} difference(s).`);
console.log("=".repeat(72));
process.exitCode = problems === 0 ? 0 : 1;
