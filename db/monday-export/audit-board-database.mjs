/**
 * Diffs the seeded database against the board spec.
 *
 * `audit-labels.mjs` checks the spec against monday. This checks the database
 * against the spec — the other half, and the half that has broken before. The
 * seeder once wrote `maintenance_board_options` rows correctly while leaving
 * `settings.choices` on the column empty, and `settings.choices` is what the
 * grid actually reads, so every chip on the board rendered as a dash while
 * every option row in the database was perfect.
 *
 * So both stores are compared, separately and against the same spec:
 *   maintenance_board_columns.title     column headers
 *   maintenance_board_columns.settings  the choices the GRID reads
 *   maintenance_board_options           the choices the option editor reads
 *
 * Read-only. Prints a diff and exits.
 *
 * Usage: node db/monday-export/audit-board-database.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const DB_PATH = path.join(
  ROOT,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

if (!existsSync(DB_PATH)) {
  console.error(`No local database at:\n  ${DB_PATH}\nStart the app once.`);
  process.exit(1);
}

const {
  maintenanceColumns,
  maintenanceUiColumns,
  maintenanceOptions,
  storeDocumentationColumns,
  storeDocumentationOptions,
} = await import("../monday-board-spec.ts");

/** Which option set backs which column key, per board. */
const COLUMN_OPTION_SET = {
  maintenance: {
    tier: "tier_level",
    engineer: "engineer_required",
    priority: "priority",
    label: "maintenance_label",
    status: "maintenance_status",
    storeLocation: "store_location",
  },
  "store-documentation": {
    storeType: "store_type",
  },
};

const OPTION_SETS = { ...maintenanceOptions, ...storeDocumentationOptions };

const BOARDS = [
  {
    id: "maintenance",
    spec: [...maintenanceColumns, ...maintenanceUiColumns],
  },
  {
    id: "store-documentation",
    spec: storeDocumentationColumns,
  },
];

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const organisations = db
  .prepare("SELECT DISTINCT organisation_id AS id FROM maintenance_board_columns ORDER BY id")
  .all();

let problems = 0;
const note = (message) => {
  problems += 1;
  console.log(message);
};

for (const org of organisations) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`ORGANISATION ${org.id}`);
  console.log("=".repeat(72));

  for (const board of BOARDS) {
    const rows = db
      .prepare(
        `SELECT column_key, title, type, position, settings
           FROM maintenance_board_columns
          WHERE organisation_id = ? AND board_id = ?
          ORDER BY position`,
      )
      .all(org.id, board.id);

    console.log(`\n${board.id} — spec ${board.spec.length} columns, database ${rows.length}`);

    const byKey = new Map(rows.map((row) => [row.column_key, row]));

    /* ---- titles ------------------------------------------------- */
    for (const spec of board.spec) {
      const row = byKey.get(spec.key);
      if (!row) {
        note(`  MISSING COLUMN   ${spec.key}  ("${spec.title}")`);
        continue;
      }
      if (row.title !== spec.title) {
        note(`  TITLE   ${spec.key}: database ${JSON.stringify(row.title)} != spec ${JSON.stringify(spec.title)}`);
      }
      if (row.type !== spec.type) {
        note(`  TYPE    ${spec.key}: database ${row.type} != spec ${spec.type}`);
      }
    }

    const specKeys = new Set(board.spec.map((column) => column.key));
    for (const row of rows) {
      if (!specKeys.has(row.column_key)) {
        note(`  EXTRA COLUMN     ${row.column_key}  ("${row.title}")`);
      }
    }

    /* ---- the choices the grid reads ----------------------------- */
    for (const [columnKey, setKey] of Object.entries(COLUMN_OPTION_SET[board.id] ?? {})) {
      const row = byKey.get(columnKey);
      const expected = OPTION_SETS[setKey] ?? [];
      if (!row) continue;

      let settings = {};
      try {
        settings = JSON.parse(row.settings || "{}");
      } catch {
        note(`  SETTINGS  ${columnKey}: not valid JSON`);
        continue;
      }
      const choices = settings.choices ?? [];

      if (choices.length !== expected.length) {
        note(
          `  CHOICES   ${columnKey}: grid has ${choices.length}, spec has ${expected.length}` +
            (choices.length === 0 ? "  <-- the grid renders a dash for every cell" : ""),
        );
      }

      const rowCount = Math.max(choices.length, expected.length);
      for (let i = 0; i < rowCount; i += 1) {
        const got = choices[i];
        const want = expected[i];
        if (want && !got) {
          note(`  CHOICES   ${columnKey}[${i}] missing ${JSON.stringify(want.label)}`);
          continue;
        }
        if (got && !want) {
          note(`  CHOICES   ${columnKey}[${i}] unexpected ${JSON.stringify(got.label)}`);
          continue;
        }
        if (got.label !== want.label) {
          note(
            `  CHOICES   ${columnKey}[${i}] label ${JSON.stringify(got.label)} != ${JSON.stringify(want.label)}`,
          );
        }
        const gotColour = (got.color ?? got.colour ?? "").toLowerCase();
        if (gotColour !== want.colour.toLowerCase()) {
          note(
            `  CHOICES   ${columnKey}[${i}] colour ${gotColour} != ${want.colour}  (${want.label})`,
          );
        }
      }
    }

    /* ---- the option rows the editor reads ----------------------- */
    for (const [columnKey, setKey] of Object.entries(COLUMN_OPTION_SET[board.id] ?? {})) {
      const expected = OPTION_SETS[setKey] ?? [];
      const optionRows = db
        .prepare(
          `SELECT label, color, position FROM maintenance_board_options
            WHERE organisation_id = ? AND column_key = ?
            ORDER BY position`,
        )
        .all(org.id, columnKey);

      if (!optionRows.length && expected.length) {
        note(`  OPTIONS   ${columnKey}: no option rows, spec has ${expected.length}`);
        continue;
      }
      if (optionRows.length !== expected.length) {
        note(
          `  OPTIONS   ${columnKey}: ${optionRows.length} rows, spec has ${expected.length}`,
        );
      }
      for (let i = 0; i < Math.min(optionRows.length, expected.length); i += 1) {
        if (optionRows[i].label !== expected[i].label) {
          note(
            `  OPTIONS   ${columnKey}[${i}] ${JSON.stringify(optionRows[i].label)} != ${JSON.stringify(expected[i].label)}`,
          );
        }
        if ((optionRows[i].color ?? "").toLowerCase() !== expected[i].colour.toLowerCase()) {
          note(
            `  OPTIONS   ${columnKey}[${i}] colour ${optionRows[i].color} != ${expected[i].colour}  (${expected[i].label})`,
          );
        }
      }
    }
  }
}

db.close();

console.log(`\n${"=".repeat(72)}`);
console.log(problems === 0 ? "Database matches the spec." : `${problems} difference(s).`);
console.log("=".repeat(72));
process.exitCode = problems === 0 ? 0 : 1;
