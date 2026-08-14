/**
 * Turns the Store Documentation API pull into the CSV the existing importer
 * takes, carrying the eleven expiry dates that have never been in the app.
 *
 * Why a CSV rather than writing cells directly: `app/lib/monday-import.ts` and
 * `/api/import` are the verified path. They preview before they commit, they
 * update rather than duplicate on a re-run, and they skip an empty value
 * instead of wiping the cell that holds one. Re-implementing that here would
 * mean two write paths that can disagree about the same board — which is the
 * mistake that put 38 columns on a 25-column board.
 *
 * DELIBERATELY WITHOUT AN "Item ID" COLUMN.
 *
 * The maintenance CSV carries one because that board names 732 of its 744 rows
 * "Incoming form answer" and a title match folds them together. This board is
 * the opposite case: store names are unique, and the 31 rows already in the
 * database carry no `external_id` at all. The importer matches on the id ALONE
 * when a file supplies one — deliberately, so a new job cannot be merged into
 * an unrelated row — so supplying ids here would match nothing and create 31
 * duplicate stores beside the real ones. Falling back to the title is correct
 * for this board and only for this board.
 *
 * Only the name and the date columns are emitted. The file columns import as
 * empty by nature and are handled by `import-monday-assets.mjs`; the text and
 * dropdown columns are already in the app and reproducing them here would put
 * a second writer on cells that nothing has asked to change.
 *
 * Usage: node db/monday-export/build-store-documentation-csv.mjs
 * Writes db/monday-export/store-documentation-expiry.csv
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULL = path.join(HERE, "api-pull");

/**
 * monday column id → the column title the importer matches on.
 *
 * Titles, not keys, because that is what the importer joins on and what
 * `db/monday-board-spec.ts` captures verbatim from the live board. Read from
 * columns.json rather than retyped, so a rename on monday surfaces as an
 * unmatched column in the preview instead of silently writing nowhere.
 */
const STORE_DOC_BOARD = "1398027719";

const boards = JSON.parse(readFileSync(path.join(PULL, "columns.json"), "utf8"));
const board = boards.find((entry) => entry.id === STORE_DOC_BOARD);
if (!board) {
  console.error(`Board ${STORE_DOC_BOARD} is not in columns.json. Re-run the pull.`);
  process.exit(1);
}

const dateColumns = board.columns.filter((column) => column.type === "date");
const items = JSON.parse(
  readFileSync(path.join(PULL, "store-documentation.json"), "utf8"),
);

/**
 * One CSV field. Quoted whenever it holds a comma, quote or newline.
 *
 * Two of these addresses genuinely begin with a double quote on monday — this
 * was previously assumed to be a CSV export artefact, and the API pull shows it
 * is not: the stored value itself starts with `"`. Quoting is what keeps that
 * verbatim rather than silently correcting the source of truth.
 */
function field(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const row = (cells) => cells.map(field).join(",");

const byGroup = new Map();
for (const item of items) {
  const title = item.group?.title ?? "Current stores";
  if (!byGroup.has(title)) byGroup.set(title, []);
  byGroup.get(title).push(item);
}

const header = ["Name", ...dateColumns.map((column) => column.title)];
const lines = ["Store Documentation UK", ""];

let populated = 0;
for (const [title, groupItems] of byGroup) {
  lines.push(row([title]));
  lines.push(row(header));
  for (const item of groupItems) {
    const values = new Map(
      item.column_values.map((cell) => [cell.id, (cell.text ?? "").trim()]),
    );
    for (const column of dateColumns) if (values.get(column.id)) populated += 1;
    lines.push(
      row([item.name, ...dateColumns.map((column) => values.get(column.id) ?? "")]),
    );
  }
  lines.push("");
}

const out = path.join(HERE, "store-documentation-expiry.csv");
writeFileSync(out, lines.join("\n"), "utf8");

console.log(`${items.length} stores across ${byGroup.size} groups → ${out}`);
console.log(`${dateColumns.length} expiry columns, ${populated} populated dates`);
for (const [title, groupItems] of byGroup) {
  console.log(`  ${String(groupItems.length).padStart(3)}  ${title}`);
}
