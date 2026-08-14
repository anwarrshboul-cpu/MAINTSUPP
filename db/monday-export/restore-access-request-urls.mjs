/**
 * Restores the Access Request cells on Store Documentation UK from the monday
 * capture.
 *
 * WHAT WAS WRONG
 *
 * Three of the twenty-four populated Access Request cells hold a truncated URL.
 * A cell-by-cell comparison of all 82 populated text and dropdown cells against
 * `api-pull/store-documentation.json` found these three and nothing else — the
 * other 79 text cells and every Store Type and Store Address value match
 * exactly:
 *
 *   The Centre:MK (sd-009)             everything after the host was dropped
 *   Cribbs Causeway - Bristol (sd-025) same
 *   Manchester Arndale (sd-014)        the whole query string was dropped
 *
 * They are contractor gatekeeper links. `https://cbre.meridianuk.net/` is the
 * CBRE Meridian front door and does not reach a store's access request:
 * everything that identifies the store — `siteaccessrequestid`, `requestguid`,
 * `instance` — lives in the part that went missing. A contractor handed the
 * truncated link cannot book access, which is the only thing the column is for.
 *
 * WHERE THE TRUNCATION CAME FROM
 *
 * Not from `db/seed-store-documentation.ts`. That seeder writes columns and
 * groups and no cells at all, and `tests/store-documentation-board.test.mjs`
 * holds it to that. It came from `db/monday-export/store-documentation.json`,
 * the hand-condensed 31-row capture whose `r` field carries the shortened
 * strings. That file has no reader left in the tree, but it is a capture, so it
 * is corrected alongside this script — otherwise the next person to load cells
 * from it writes the same three truncations back.
 *
 * `api-pull/store-documentation.json` is the authority for both. It is the raw
 * monday API response and is never edited here.
 *
 * HOW IT WRITES
 *
 * Through `PATCH /api/board?board=store-documentation` with
 * `action=update_cell` — the same path the grid uses when someone edits the
 * cell by hand. It requires the `board.edit` capability, validates the column
 * against the board, scopes to the session's organisation and normalises the
 * value. Raw SQL against `maintenance_board_cells` would bypass all four.
 *
 * SAFETY
 *
 *  - Dry run by default. `--commit` is required to write anything.
 *  - Only ever an UPDATE of a cell's text. No row is created or deleted. A
 *    capture value that is empty is SKIPPED, not written, because
 *    `update_cell` deletes the cell for an empty value and this script must
 *    never be able to clear a populated one.
 *  - Idempotent: it compares first and writes only what differs, so a second
 *    run reports "nothing to do".
 *  - Every before value is printed in full before it is replaced.
 *
 * Credentials come from the environment. Nothing is defaulted:
 *
 *   MAINTSUPP_EMAIL=… MAINTSUPP_PASSWORD=… \
 *     node db/monday-export/restore-access-request-urls.mjs
 *   MAINTSUPP_EMAIL=… MAINTSUPP_PASSWORD=… \
 *     node db/monday-export/restore-access-request-urls.mjs --commit
 *
 * Optional: --base http://localhost:5173
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const COMMIT = args.includes("--commit");
const BASE = flag("--base", "http://localhost:5173").replace(/\/$/, "");
const BOARD = "store-documentation";

/** The monday board and the column, both as the capture names them. */
const MONDAY_BOARD_ID = "1398027719";
const COLUMN_TITLE = "Access Request";

const EMAIL = process.env.MAINTSUPP_EMAIL;
const PASSWORD = process.env.MAINTSUPP_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error(
    "Set MAINTSUPP_EMAIL and MAINTSUPP_PASSWORD in the environment.\n" +
      "They are deliberately not defaulted here — a credential must not live in the repository.",
  );
  process.exit(1);
}

/* ── The capture ─────────────────────────────────────────────────────────── */

const columnsCapture = JSON.parse(
  readFileSync(path.join(HERE, "api-pull", "columns.json"), "utf8"),
);
const mondayBoard = columnsCapture.find((entry) => entry.id === MONDAY_BOARD_ID);
if (!mondayBoard) {
  console.error(`Board ${MONDAY_BOARD_ID} is not in api-pull/columns.json.`);
  process.exit(1);
}
/* Resolved from the capture rather than typed, so a rename on monday shows up
   as "column not found" instead of writing into the wrong column. */
const mondayColumn = mondayBoard.columns.find(
  (column) => column.title === COLUMN_TITLE,
);
if (!mondayColumn) {
  console.error(`No "${COLUMN_TITLE}" column in the monday capture.`);
  process.exit(1);
}

const capturedRows = JSON.parse(
  readFileSync(path.join(HERE, "api-pull", "store-documentation.json"), "utf8"),
);
/** `store name → the Access Request text monday holds`. */
const wanted = new Map();
for (const key of Object.keys(capturedRows)) {
  const row = capturedRows[key];
  if (!row?.name) continue;
  const cell = (row.column_values ?? []).find(
    (value) => value.id === mondayColumn.id,
  );
  const text = (cell?.text ?? "").trim();
  if (text) wanted.set(row.name.trim(), text);
}
console.log(
  `Capture: ${wanted.size} stores carry an ${COLUMN_TITLE} value on monday.`,
);

/* ── The live board ──────────────────────────────────────────────────────── */

const signIn = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  console.error(`Sign-in failed (${signIn.status}). Is the dev server on ${BASE}?`);
  process.exit(1);
}
const cookie = (signIn.headers.getSetCookie?.() ?? [])
  .map((raw) => raw.split(";")[0])
  .join("; ");

const boardResponse = await fetch(`${BASE}/api/board?board=${BOARD}`, {
  headers: { accept: "application/json", cookie },
});
if (!boardResponse.ok) {
  console.error(`The board would not load (${boardResponse.status}).`);
  process.exit(1);
}
const board = await boardResponse.json();

const column = (board.columns ?? []).find((entry) => entry.key === "accessRequest");
if (!column) {
  console.error("The board has no accessRequest column.");
  process.exit(1);
}
const valueByRequest = new Map();
for (const cell of board.cells ?? []) {
  if (cell.columnId === column.id) valueByRequest.set(cell.requestId, cell.value);
}

/* ── Compare ─────────────────────────────────────────────────────────────── */

const changes = [];
const unmatched = [];
for (const request of board.requests ?? []) {
  const title = (request.title ?? "").trim();
  const target = wanted.get(title);
  if (target === undefined) {
    // Either monday holds nothing for this store, or the name has drifted.
    if (!wanted.has(title)) unmatched.push(title);
    continue;
  }
  const current = valueByRequest.get(request.id) ?? "";
  if (current === target) continue;
  changes.push({ id: request.id, title, from: current, to: target });
}

const missingFromBoard = [...wanted.keys()].filter(
  (name) => !(board.requests ?? []).some((r) => (r.title ?? "").trim() === name),
);

console.log(
  `Board: ${board.requests?.length ?? 0} rows, ${valueByRequest.size} with an ${COLUMN_TITLE} cell.`,
);
if (missingFromBoard.length) {
  console.log(
    `Named on monday but not on the board (left alone): ${missingFromBoard.join(", ")}`,
  );
}
if (!changes.length) {
  console.log("Nothing to do — every Access Request cell already matches monday.");
  process.exit(0);
}

console.log(`\n${changes.length} cell(s) differ from the capture:\n`);
for (const change of changes) {
  console.log(`  ${change.id}  ${change.title}`);
  console.log(`    before: ${change.from === "" ? "(empty)" : change.from}`);
  console.log(`    after:  ${change.to}`);
}

if (!COMMIT) {
  console.log("\nDry run. Re-run with --commit to write these values.");
  process.exit(0);
}

/* ── Write ───────────────────────────────────────────────────────────────── */

let written = 0;
for (const change of changes) {
  // Guarded twice: `wanted` only ever holds non-empty strings, and this refuses
  // anyway. An empty value makes `update_cell` DELETE the cell, and this script
  // must not be able to clear a populated one.
  if (!change.to) {
    console.log(`  skipped ${change.id} — the capture value is empty`);
    continue;
  }
  const response = await fetch(`${BASE}/api/board?board=${BOARD}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      action: "update_cell",
      requestId: change.id,
      columnId: column.id,
      value: change.to,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`  FAILED ${change.id} (${response.status}): ${body.slice(0, 200)}`);
    continue;
  }
  const body = await response.json();
  if (body.cell?.value !== change.to) {
    console.error(
      `  MISMATCH ${change.id}: the API stored ${JSON.stringify(body.cell?.value)}`,
    );
    continue;
  }
  written += 1;
  console.log(`  wrote ${change.id} ${change.title}`);
}

console.log(`\n${written} of ${changes.length} cell(s) written. Re-run to confirm it is idempotent.`);
console.log(`Repository root: ${ROOT}`);
