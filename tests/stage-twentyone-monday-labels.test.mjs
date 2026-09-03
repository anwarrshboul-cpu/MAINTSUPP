import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Every option column serves monday's own labels, not the API's scaffolding.
 *
 * There are two places a status or dropdown column's choices are read from:
 *
 *   `maintenance_board_options` rows  ->  the grid's cells, via `optionsFor`
 *   `settings.choices` on the column  ->  the column menu's choice editor,
 *                                         the column summary, the mobile editor
 *
 * Only the first was seeded for the maintenance board. `settings` was the
 * literal `'{}'`, and `parseSettings` falls back to `defaultSettings(type)` on
 * an empty blob — so every maintenance status column served "Not started /
 * Working on it / Done / Stuck" and Tier Level served "Option 1 / Option 2".
 * Those strings are the board API's placeholders. They appear nowhere on
 * monday, nowhere in the capture, and nowhere in the spec, and the operator was
 * shown them as though they were the board's vocabulary.
 *
 * The cells looked correct throughout, which is what hid it: the grid reads the
 * option rows, and those were right all along.
 *
 * Verified against the running server after the fix — status 23 choices,
 * priority 3, label 16, tier 4, engineer 4, storeLocation 21, all matching
 * monday's labels, colours and display order.
 */

test("the maintenance seeder writes settings.choices, not an empty blob", async () => {
  const init = await read("db/init.ts");

  assert.match(init, /function maintenanceColumnSettings/);
  assert.match(
    init,
    /const settings = maintenanceColumnSettings\(column\.type, column\.optionSetKey\)/,
  );

  /*
   * The literal `'{}'` in the VALUES list is the bug itself. A bound parameter
   * is what allows a real blob through, so its absence is the regression.
   */
  const seeder = init.slice(init.indexOf("export async function seedBoardStructure"));
  assert.doesNotMatch(
    seeder.slice(0, 2500),
    /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, '\{\}'/,
    "the settings column must be bound, not hardcoded to an empty blob",
  );
});

test("choices come from the spec, so the two stores cannot drift", async () => {
  const init = await read("db/init.ts");

  // Same source array as `seed-options.ts` uses for the option rows. Two
  // hand-maintained copies is exactly how this list drifted before, seeding
  // "Blocked - Awaiting information" where monday says "Awaiting Response".
  assert.match(init, /maintenanceOptions\[optionSetKey\]/);
  assert.match(init, /from "\.\/monday-board-spec"/);
});

test("an existing board is backfilled, but an admin's rename is not touched", async () => {
  const init = await read("db/init.ts");
  const seeder = init.slice(init.indexOf("export async function seedBoardStructure"));

  /*
   * INSERT OR IGNORE cannot correct a row that already exists, so without a
   * backfill every board seeded before this fix keeps the placeholders forever.
   * The guard is what keeps it safe: only a column whose settings are still
   * exactly `{}` — never configured — is written, so a renamed or recoloured
   * label survives the next boot.
   */
  /*
   * RE-POINTED: the window, not the rule.
   *
   * This read `seeder.slice(0, 4000)`, a byte count chosen when the function
   * was shorter. W2 gave `seedBoardStructure` a `groupKeys` parameter — so a
   * section created from the Jobs template can be seeded by THIS function
   * rather than by a second copy of the job board's structure — and the note
   * explaining why a subset may only ever narrow pushed the backfill past 4000.
   * The assertion below was protecting a real contract and would have started
   * passing vacuously on any future comment, so it is bounded by the function
   * instead: everything up to its last statement.
   */
  const columnPass = seeder.slice(0, seeder.indexOf("await reconcileDuplicateColumns"));
  assert.ok(columnPass.length > 0, "the seeder must still end in a reconcile pass");
  assert.match(columnPass, /UPDATE maintenance_board_columns\s+SET settings = \?/);
  assert.match(
    columnPass,
    /TRIM\(COALESCE\(settings, ''\)\) IN \('', '\{\}'\)/,
    "the backfill must only touch an unconfigured column",
  );
});

/**
 * The Store Documentation board's first column is headed "Name".
 *
 * It was seeded as "Store" — a rename made because the board's item noun is
 * Store, which remains true and is still how a new row is labelled and how the
 * "New store" button reads. But the column HEADER on board 1398027719 says
 * "Name", the maintenance board's equivalent column was already correct, and
 * the standing rule is that where the app and the capture disagree the capture
 * wins. Confirmed against the API: the first column of all three boards is
 * titled "Name".
 */
test("the store board's name column is headed as monday heads it", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const storeSection = spec.slice(spec.indexOf("export const storeDocumentationColumns"));
  const firstColumn = storeSection.slice(0, 1200);

  assert.match(firstColumn, /key: "name"/);
  assert.match(firstColumn, /title: "Name"/);
  assert.doesNotMatch(
    firstColumn,
    /title: "Store"/,
    'the header must read "Name"; the item noun is separate',
  );
});

test("the old header is corrected on boards already seeded", async () => {
  const seeder = await read("db/seed-store-documentation.ts");

  // Guarded on the exact historic value AND on the column still being a system
  // column, so only this specific mistake is corrected and any other name an
  // admin has chosen is left alone.
  assert.match(seeder, /SET title = \?/);
  assert.match(seeder, /AND title = 'Store' AND system = 1/);
});

/**
 * The audit scripts exist and stay read-only.
 *
 * `audit-labels.mjs` compares the spec to the live monday API;
 * `audit-board-database.mjs` compares the seeded database to the spec. Between
 * them they cover both halves of "does the app say what monday says", and both
 * were clean when this was written. A script that could write would be a
 * migration wearing an audit's name.
 */
test("the label audits are read-only", async () => {
  for (const file of [
    "db/monday-export/audit-labels.mjs",
    "db/monday-export/audit-board-database.mjs",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE)\b/, `${file} must not write`);
    assert.match(source, /readOnly: true|readFileSync/, `${file} must open read-only`);
  }
});
