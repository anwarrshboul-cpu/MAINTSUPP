/**
 * Turns a monday API pull of board 1139774521 into the CSV shape the existing
 * importer already understands.
 *
 * Why go through a CSV rather than writing rows directly: `app/lib/monday-import.ts`
 * is the verified path — it previews before it commits, updates rather than
 * duplicates on a re-run, and records what it could not match. Re-implementing
 * that against the API would mean two write paths that can disagree about the
 * same board. This script only reformats; every decision about what lands in the
 * database stays in the importer.
 *
 * The importer reads monday's own export layout:
 *
 *     Maintenance            <- board title, a lone cell before any header
 *     <blank>
 *     Incoming requests      <- group name, a lone cell
 *     Name,Location,...      <- header row, matched by column title
 *     <item rows>
 *     <blank>
 *     Jobs Booked            <- next group
 *     ...
 *
 * Usage: node db/monday-export/build-maintenance-csv.mjs page1.json page2.json …
 * Writes db/monday-export/maintenance-full.csv
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * monday column id → the column title the importer matches on.
 *
 * "Item ID" is first and is not a board column. It is monday's row identity,
 * and without it an import has nothing stable to match on: this board names
 * 700+ of its 744 items "Incoming form answer", so a title-keyed match folds
 * them all onto one row. monday's own "Export board to Excel" offers the same
 * column, which is why the importer takes it under that heading.
 */
const COLUMN_TITLES = [
  ["__itemId", "Item ID"],
  ["name", "Name"],
  ["short_text6", "Location"],
  ["short_text", "Description of Works to be done"],
  ["dropdown_mm51wmh0", "Tier Level"],
  ["single_select", "Engineer Required"],
  ["status", "Priority"],
  ["color_mm0ahrtb", "Label"],
  ["status1", "Status"],
  ["text_mm51zcqg", "Contractor"],
  ["person", "Assigned To"],
  ["date", "Date Requested"],
  ["date2", "Date Completed"],
  ["timeline", "Timeline"],
  ["short_text64", "Job Requested by"],
  ["date_mkmts6wz", "Next Update"],
  ["upload_file", "Pictures of Maintenance Issue"],
  ["dup__of_upload_pictures_of_work_needed", "Picture of completed works"],
  ["numbers", "Cost of Works"],
  ["text", "Approved by"],
  ["subitems", "Subitems"],
  ["text6", "Invoice"],
  ["file_mm44swj6", "Files"],
  ["numbertb4g1z46", "Number"],
  ["single_selecty9rcyhe", "Store Location Name"],
  ["form_view_19b7dd3b", "Form View"],
];

/**
 * monday's group order, captured from the board.
 *
 * Taken from the board rather than from the items, because the order groups
 * appear in an item list is the order rows happened to be created, and the
 * board's own order is what anyone reading it sees. Groups the pull did not
 * return are simply absent from the output.
 */
const GROUP_ORDER = [
  "Incoming requests",
  "recently",
  "Jobs Booked",
  "Needs attention",
  "August  2026 Recently completed",
  "July 2026 Recently completed",
  "June 2026 Recently completed",
  "On Hold",
  "Access Requests",
  "International",
  "Wood Green completed",
  "Aldgate completed",
  "Arndale completed",
  "Bluewater completed",
  "Brent Cross completed",
  "Brighton completed",
  "Bespoke whitecity completed",
  "Bristol Cabot Circus completed",
  "Bullring completed",
  "Cambridge completed",
  "Cardiff completed",
  "Cribbs completed",
  "Derby completed",
  "Glasgow Silverburn completed",
  "Highcross Leicester completed",
  "Meadowhall Sheffield completed",
  "Merry Hill completed",
  "Metro Centre completed",
  "Milton Keynes completed",
  "Nottingham complited",
  "Reading completed",
  "White City completed",
  "SJQ Edinburgh completed",
  "Solihull completed",
  "Southall completed",
  "Westfield Stratford  completed",
  "Trafford centre completed",
  "Watford completed",
];

/**
 * One CSV field.
 *
 * Quoted whenever it holds a comma, quote or newline — several descriptions run
 * to multiple lines and the file-URL columns hold comma-separated lists, so an
 * unquoted write would silently shift every later column on that row.
 */
function field(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const row = (cells) => cells.map(field).join(",");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Pass at least one monday items-page JSON file.");
  process.exit(1);
}

const items = [];
const seen = new Set();
for (const file of files) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  for (const item of payload.items ?? []) {
    // The pages are cursor-paged and must not overlap, but de-duplicate on id
    // anyway: a repeated row would import as a second job, and nothing about
    // the output would show that it had happened.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
}

const byGroup = new Map();
for (const item of items) {
  const title = item.group?.title ?? "Incoming requests";
  if (!byGroup.has(title)) byGroup.set(title, []);
  byGroup.get(title).push(item);
}

// Board order first, then any group the board did not list, so nothing is lost.
const ordered = [
  ...GROUP_ORDER.filter((title) => byGroup.has(title)),
  ...[...byGroup.keys()].filter((title) => !GROUP_ORDER.includes(title)),
];

const header = COLUMN_TITLES.map(([, title]) => title);
const lines = ["Maintenance", ""];

for (const title of ordered) {
  lines.push(row([title]));
  lines.push(row(header));
  for (const item of byGroup.get(title)) {
    lines.push(
      row(
        COLUMN_TITLES.map(([id]) => {
          if (id === "__itemId") return item.id;
          if (id === "name") return item.name;
          return item.column_values?.[id] ?? "";
        }),
      ),
    );
  }
  lines.push("");
}

const out = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "maintenance-full.csv",
);
writeFileSync(out, lines.join("\n"), "utf8");

console.log(`${items.length} items across ${ordered.length} groups → ${out}`);
for (const title of ordered) {
  console.log(`  ${String(byGroup.get(title).length).padStart(3)}  ${title}`);
}
