/**
 * THE REGISTER'S SOURCE OF TRUTH — one column, one order, one lane.
 *
 * Three defects the owner found by hand on the Contractors register, and the
 * one thing all three have in common: a piece of state was being DERIVED in two
 * places, and the two answers were allowed to disagree.
 *
 *   1. Unticking "Contractor" changed `hidden_at` and left the composite lane
 *      on the table, because the lane was re-derived from a `columns.find(...)`
 *      with no `hidden` check.
 *   2. Move earlier / Move later stepped ±1 through the FULL column list. On a
 *      register with 22 hidden columns and visible positions 0, 15, 20, 21,
 *      26…30, almost every press swapped a column on the table with a HIDDEN
 *      neighbour: the metadata changed, the checklist showed it, and the table
 *      could not move because nothing on it had.
 *   3. The composite lane and the standalone Contact / Email / Phone / WhatsApp
 *      columns had to stay independent of one another.
 *
 * ── WHY THIS FILE ASSERTS DERIVED ORDER AND NOT ONLY SOURCE TEXT ─────────
 *
 * Every one of those three passed the source pins that were already in the
 * suite. The pins were right about what the code SAID; what nobody had was a
 * test that took a register shaped like the owner's, pressed the button, and
 * looked at what came out. So the assertions below call the real module with
 * real column arrays and compare the KEYS THE TABLE WOULD DRAW. Source pins are
 * kept for the wiring a pure function cannot see — which grid calls which
 * helper — and are marked as such.
 *
 * The fixture is the owner's live Staging register, read from
 * `portal.register_columns` on 2026-09-02: 31 rows, 22 hidden, `name` at
 * position 0 carrying `{"pinned": true}`, `contactName` and `email` hidden
 * carrying `{"pinned": false}`, and the eight other visible columns at the
 * sparse positions above. The sparseness is not incidental — it IS defect 2 —
 * so it is reproduced exactly rather than smoothed into 0..8.
 *
 * NOTHING HERE WRITES TO THE DATABASE. The pure assertions need no fixture at
 * all, and the one live test reads `/api/registers` and asserts. There is
 * therefore no `ZZQA-` residue to sweep, which on a suite whose live tests share
 * one Miniflare D1 is the safest form this file could take.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const CLIENT = "app/(app)/portal/register/register-client.ts";
const PANEL = "app/(app)/portal/register/register-columns-panel.tsx";
const CATALOGUE = "app/lib/register-catalogue.ts";
const ENGINE = "app/lib/register-columns.ts";
const GRID = "app/(app)/portal/contractor-register.tsx";
const SITES_GRID = "app/(app)/portal/register/register-grid.tsx";

/*
 * `register-client.ts` imports nothing at runtime — deliberately, so that the
 * rules a register depends on can be exercised without a bundler, a DOM or a
 * React renderer. Transpiled and imported as a data: URL, which is the idiom
 * `tests/column-drag-and-recovery.test.mjs` established for exactly this.
 */
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const client = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(await read(CLIENT))).toString("base64")}`
);

const {
  CONTRACTOR_COLUMN_KEY,
  CONTRACTOR_COLUMN_TITLE,
  canMoveRegisterColumn,
  frozenRegisterColumn,
  identityRegisterColumn,
  orderAfterMove,
  orderAfterStep,
  registerTableColumns,
} = client;

/** Comments are prose and may say anything; the assertions read code only. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── The owner's register, as a column list ─────────────────────────────── */

/**
 * `[key, position, hidden, settings]` for all 31 rows, in position order.
 *
 * Positions are the owner's own. Read them as the defect report they are: nine
 * columns are on the table and eight of the nine have a run of hidden columns
 * immediately before them, so a press that steps one place through this list
 * lands on something nobody can see.
 */
const OWNER_REGISTER = [
  ["name", 0, false, { pinned: true }],
  ["contactName", 1, true, { pinned: false }],
  ["email", 2, true, { pinned: false }],
  ["phone", 3, true, {}],
  ["whatsappNumber", 4, true, {}],
  ["address", 5, true, {}],
  ["postcode", 6, true, {}],
  ["serviceCategories", 7, true, {}],
  ["coverageAreas", 8, true, {}],
  ["certifications", 9, true, {}],
  ["availability", 10, true, {}],
  ["rating", 11, true, {}],
  ["dayRatePence", 12, true, {}],
  ["hourlyRatePence", 13, true, {}],
  ["callOutCostPence", 14, true, {}],
  ["otherCostPence", 15, false, {}],
  ["otherCostLabel", 16, true, {}],
  ["paymentTerms", 17, true, {}],
  ["financeReference", 18, true, {}],
  ["insurerName", 19, true, {}],
  ["policyNumber", 20, false, {}],
  ["insuranceExpiry", 21, false, {}],
  ["insuranceNotes", 22, true, {}],
  ["notes", 23, true, {}],
  ["active", 24, true, {}],
  ["assigned", 25, true, {}],
  ["completed", 26, false, {}],
  ["completion", 27, false, {}],
  ["urgent", 28, false, {}],
  ["documents", 29, false, {}],
  ["spend", 30, false, {}],
];

/** One wire-shaped column. `native` and `nativeField` as `/api/registers` sends them. */
function column([key, position, hidden, settings]) {
  return {
    id: `rcol_${key}`,
    register: "contractors",
    key,
    title: key === "name" ? "Contractor" : key,
    type: "text",
    position,
    width: 180,
    native: true,
    nativeField: key,
    hidden,
    pinned: settings.pinned === true,
    settings,
  };
}

const ownerColumns = () => OWNER_REGISTER.map(column);

/** The same register with one column's `hidden` / `settings` overridden. */
function ownerColumnsWith(key, patch) {
  return OWNER_REGISTER.map((row) =>
    row[0] === key
      ? column([row[0], row[1], patch.hidden ?? row[2], patch.settings ?? row[3]])
      : column(row),
  );
}

/** The keys the table draws, in order — the frozen lane first when there is one. */
const tableKeys = (columns) => registerTableColumns(columns).map((entry) => entry.key);

/**
 * What a reorder actually persists, applied.
 *
 * `reorderRegisterColumns` rewrites positions 0..n-1 densely from the list it
 * is sent and answers with the columns in that order — so a RELOAD sees the
 * array below. Modelled here rather than trusted, because "the press moved it
 * and the reload moved it back" is a real failure mode and only a re-derivation
 * from the persisted order can catch it.
 */
function afterReorder(columns, order) {
  const byKey = new Map(columns.map((entry) => [entry.key, entry]));
  return order.map((key, index) => ({ ...byKey.get(key), position: index }));
}

/* ── A — the checkbox takes the whole lane off the table ────────────────── */

test("SOT-A unticking Contractor takes the composite lane off the table", () => {
  const before = ownerColumns();
  assert.equal(frozenRegisterColumn(before)?.key, "name", "the lane is the Contractor column");
  assert.equal(tableKeys(before)[0], "name", "and it is drawn first");

  /*
   * WHAT THE SERVER WRITES WHEN THE BOX IS UNTICKED, both halves of it.
   * `PATCH /api/registers { id, hidden: true }` stamps `hidden_at` AND releases
   * the pin — "a pinned column that is not on the register is a frozen lane
   * with nothing in it" — so the snapshot that comes back carries
   * `{"pinned": false}`. Reproduced exactly; asserting against a shape the API
   * cannot produce would prove nothing about the press.
   */
  const after = ownerColumnsWith("name", { hidden: true, settings: { pinned: false } });

  assert.equal(frozenRegisterColumn(after), null, "no frozen lane survives the untick");
  assert.ok(
    !tableKeys(after).includes("name"),
    "and the composite column is not on the table in any form",
  );
  assert.equal(
    tableKeys(after)[0],
    "otherCostPence",
    "the first thing drawn is the first column that is still ticked",
  );
  assert.equal(tableKeys(after).length, tableKeys(before).length - 1, "exactly one lane fewer");
});

/* ── F — a hidden column that still carries a pin leaves no spacer ──────── */

test("SOT-F a hidden Contractor leaves no frozen lane even while it carries the pin", () => {
  /*
   * VISIBILITY WINS. `PATCH /api/registers` will not produce this pair, but a
   * stale snapshot, a hand-written row or a future write path can, and the old
   * `pinnedColumn(columns)` branch had no `hidden` check at all — so the lane
   * would have been drawn from a column the reader had taken off the register:
   * a frozen strip with nothing in it, at a width every scrolling cell is
   * indented past.
   */
  const stale = ownerColumnsWith("name", { hidden: true, settings: { pinned: true } });

  assert.equal(frozenRegisterColumn(stale), null, "a hidden pinned column freezes nothing");
  assert.ok(!tableKeys(stale).includes("name"), "and is not in the scrolling run either");

  /*
   * NO SPACER. `registerTableColumns` returns the scrolling run alone when
   * nothing is frozen, so there is no empty lane to leave behind and no
   * reserved offset to reset — the stale frozen strip is unrepresentable rather
   * than cleaned up afterwards.
   */
  assert.deepEqual(
    tableKeys(stale),
    tableKeys(ownerColumnsWith("name", { hidden: true, settings: { pinned: false } })),
    "the drawn order does not depend on a pin nobody can see",
  );

  // And showing it again returns it to the lane, which is why the pin is left
  // alone rather than repaired on read.
  const shownAgain = ownerColumnsWith("name", { hidden: false, settings: { pinned: true } });
  assert.equal(frozenRegisterColumn(shownAgain)?.key, "name");
});

/* ── B and C — one press moves the TABLE ────────────────────────────────── */

test("SOT-B one press of Move earlier moves Spend left in the table", () => {
  const columns = ownerColumns();
  const frozenKey = frozenRegisterColumn(columns)?.key ?? null;
  const before = tableKeys(columns);
  assert.deepEqual(
    before,
    [
      "name",
      "otherCostPence",
      "policyNumber",
      "insuranceExpiry",
      "completed",
      "completion",
      "urgent",
      "documents",
      "spend",
    ],
    "the owner's nine lanes, in the owner's order",
  );

  /*
   * THE OWNER'S OWN SCENARIO. `spend` is at position 30 and `documents` at 29,
   * so this one happened to be adjacent — but the press below is the general
   * one, and the assertion is on the TABLE rather than on the stored list.
   */
  const order = orderAfterStep(columns, "spend", -1, frozenKey);
  const after = tableKeys(afterReorder(columns, order));
  assert.deepEqual(after.slice(-2), ["spend", "documents"], "Spend is now left of Documents");
  assert.equal(after.length, before.length, "and nothing else joined or left the table");

  /*
   * THE PRESS THAT USED TO DO NOTHING. `policyNumber` is at 20 and the previous
   * column ON THE TABLE is `otherCostPence` at 15, with four hidden columns
   * between them. Stepping ±1 through the full list swapped it with
   * `insurerName`, which nobody can see — the metadata moved and the table did
   * not, which is the defect exactly.
   */
  const stepped = afterReorder(columns, orderAfterStep(columns, "policyNumber", -1, frozenKey));
  assert.deepEqual(
    tableKeys(stepped).slice(0, 3),
    ["name", "policyNumber", "otherCostPence"],
    "one press crosses four hidden columns and lands past the visible sibling",
  );

  /* A HIDDEN COLUMN KEEPS ITS PLACE. Only the two named columns exchange
     indices, so the checklist stays legible and nothing else is renumbered. */
  const movedKeys = orderAfterStep(columns, "policyNumber", -1, frozenKey);
  const untouched = movedKeys.filter(
    (key) => key !== "policyNumber" && key !== "otherCostPence",
  );
  assert.deepEqual(
    untouched,
    OWNER_REGISTER.map(([key]) => key).filter(
      (key) => key !== "policyNumber" && key !== "otherCostPence",
    ),
    "every column the press did not name keeps its position in the full order",
  );
});

test("SOT-C Move later is the same rule in reverse, and the pair is reversible", () => {
  const columns = ownerColumns();
  const frozenKey = frozenRegisterColumn(columns)?.key ?? null;
  const original = tableKeys(columns);

  const later = afterReorder(columns, orderAfterStep(columns, "completed", 1, frozenKey));
  assert.deepEqual(
    tableKeys(later).slice(4, 6),
    ["completion", "completed"],
    "Completed moves right past Completion in one press",
  );

  /*
   * AND BACK. Every move is a SWAP of two entries in the full order, so Move
   * later followed by Move earlier restores the exact list — positions of the
   * hidden columns included. A splice would not: it drags the run of hidden
   * columns between the two along with it, and the pair of presses would leave
   * the checklist rearranged for no reason the reader asked for.
   */
  const back = afterReorder(later, orderAfterStep(later, "completed", -1, frozenKey));
  assert.deepEqual(tableKeys(back), original, "the table is where it started");
  assert.deepEqual(
    back.map((entry) => entry.key),
    columns.map((entry) => entry.key),
    "and so is every hidden column",
  );
});

test("SOT-B/C a press that cannot move the table is refused rather than written", () => {
  const columns = ownerColumns();
  const frozenKey = frozenRegisterColumn(columns)?.key ?? null;
  const find = (key) => columns.find((entry) => entry.key === key);

  /*
   * `otherCostPence` is at position 15 and is the FIRST column in the scrolling
   * run: everything before it is hidden except `name`, which is the frozen lane
   * and is drawn outside the run. There is nowhere earlier for it to go, so the
   * button is disabled and the order comes back untouched — a press that writes
   * an order the reader cannot see is the same defect as one that writes
   * nothing.
   */
  assert.equal(canMoveRegisterColumn(columns, find("otherCostPence"), -1, frozenKey), false);
  assert.deepEqual(
    orderAfterStep(columns, "otherCostPence", -1, frozenKey),
    columns.map((entry) => entry.key),
    "and no order is produced for it",
  );
  assert.equal(canMoveRegisterColumn(columns, find("spend"), 1, frozenKey), false, "last on the table");
  assert.equal(canMoveRegisterColumn(columns, find("name"), -1, frozenKey), false, "the frozen lane");
  assert.equal(canMoveRegisterColumn(columns, find("name"), 1, frozenKey), false, "either way");

  // The presses that DO move the table are offered.
  assert.equal(canMoveRegisterColumn(columns, find("spend"), -1, frozenKey), true);
  assert.equal(canMoveRegisterColumn(columns, find("otherCostPence"), 1, frozenKey), true);

  /*
   * A HIDDEN COLUMN STILL MOVES, one place through the full order. It is not on
   * the table, so there is nothing for the table to do and the checklist — which
   * lists every column — is the whole of what changes. Swapping a hidden column
   * with anything can never disturb the visible order, because it contributes
   * nothing to it.
   */
  assert.equal(canMoveRegisterColumn(columns, find("insurerName"), -1, frozenKey), true);
  const shuffled = afterReorder(
    columns,
    orderAfterStep(columns, "insurerName", -1, frozenKey),
  );
  assert.deepEqual(tableKeys(shuffled), tableKeys(columns), "the table does not move for it");
  assert.deepEqual(
    shuffled.map((entry) => entry.key).slice(18, 20),
    ["insurerName", "financeReference"],
    "but the checklist does",
  );
});

test("SOT-B the ±1 call both grids already make goes through the same rule", () => {
  /*
   * WIRING, NOT ARITHMETIC. `contractor-register.tsx` and `register-grid.tsx`
   * both compute `index + delta` off the column's own place in the FULL list
   * and hand it to `orderAfterMove` — which is how ±1 came to mean "swap with
   * whatever is next, hidden or not". `orderAfterMove` now routes a one-place
   * target to `orderAfterStep` rather than splicing, so the two call sites are
   * correct as they stand and there is still exactly one definition of what
   * "earlier" means.
   */
  const columns = ownerColumns();
  const at = columns.findIndex((entry) => entry.key === "policyNumber");
  assert.deepEqual(
    orderAfterMove(columns, "policyNumber", at - 1),
    orderAfterStep(columns, "policyNumber", -1),
    "a one-place target is a press",
  );
  assert.deepEqual(
    orderAfterMove(columns, "policyNumber", at + 1),
    orderAfterStep(columns, "policyNumber", 1),
  );

  // A real drop to a distant index is still a splice, which is what a drag
  // would want and what nothing currently sends.
  assert.equal(orderAfterMove(columns, "spend", 0)[0], "spend", "a distant target still lands there");
});

/* ── D — one ordered definition behind both loops ───────────────────────── */

test("SOT-D the headers and the row cells come from one ordered definition", async () => {
  /*
   * A header loop over one list beside a cell loop over another is a table
   * whose labels stop matching its values the first time anything is reordered,
   * and nothing about it fails — the figures simply appear under the wrong
   * headings, which is the one rendering fault a reader will believe.
   */
  const grid = codeOnly(await read(GRID));
  assert.equal(
    (grid.match(/lanes\.map\(\(lane\)/g) ?? []).length,
    2,
    "the contractors <thead> and <tbody> map the same array",
  );
  const sites = codeOnly(await read(SITES_GRID));
  assert.equal(
    (sites.match(/shown\.map\(\(column/g) ?? []).length,
    2,
    "and so do the sites ones",
  );

  /*
   * DERIVED, not only pinned. The order is decided once — the frozen lane, then
   * the scrolling run with that column lifted out of it — and the same answer
   * has to hold whether the lane is a stored pin, the identity fallback, or
   * nothing at all.
   */
  const columns = ownerColumns();
  const drawn = registerTableColumns(columns);
  assert.equal(new Set(drawn.map((entry) => entry.id)).size, drawn.length, "no column twice");
  assert.ok(
    drawn.every((entry) => !entry.hidden),
    "and nothing hidden is drawn",
  );
  assert.equal(drawn[0].key, frozenRegisterColumn(columns).key, "the frozen lane leads");

  /* THE FALLBACK LANE IS THE SAME ONE LIST. A register nobody has pinned — the
     state of every live one — freezes its identity, and that column must be
     lifted out of the run exactly as a pinned one is, or the name is printed
     twice on every row. */
  const unpinned = ownerColumnsWith("name", { hidden: false, settings: {} }).map((entry) =>
    entry.key === "contactName" || entry.key === "email"
      ? { ...entry, settings: {}, pinned: false }
      : entry,
  );
  assert.equal(frozenRegisterColumn(unpinned)?.key, "name", "the identity falls back into the lane");
  assert.equal(
    tableKeys(unpinned).filter((key) => key === "name").length,
    1,
    "and is drawn exactly once",
  );
});

/* ── H — Sites still follows the shared metadata order ──────────────────── */

test("SOT-H Sites ordering still follows the shared metadata, hidden columns included", async () => {
  /*
   * SITES SHARES THIS CONFIGURATION and must not regress. Its catalogue seeds
   * seven columns hidden among forty, so it has the same interleaving that
   * broke Contractors — the fixture is built from the real catalogue rather
   * than invented, so a seed added later is exercised without editing this.
   *
   * Its PIN SEMANTICS are deliberately untouched: `register-grid.tsx` hoists a
   * pinned column to the front of its own run and draws no sticky lane, and no
   * sites column seeds pinned, so the default answer here is "nothing is
   * frozen" and every column is an ordinary member of the order.
   */
  const catalogue = await read(CATALOGUE);
  const block = catalogue.slice(
    catalogue.indexOf("export const SITE_NATIVE_COLUMNS"),
    catalogue.indexOf("export const CONTRACTOR_NATIVE_COLUMNS"),
  );
  const seeds = [...block.matchAll(/\{ field: "([A-Za-z0-9_]+)"[^}]*\}/g)].map((match, index) =>
    column([match[1], index, /hidden: true/.test(match[0]), {}]),
  );
  assert.ok(seeds.length > 30, `the sites catalogue is read, saw ${seeds.length}`);
  assert.ok(
    seeds.some((entry) => entry.hidden),
    "and it does seed some columns hidden — the case this test is about",
  );

  const before = tableKeys(seeds);
  const last = before[before.length - 1];
  const secondLast = before[before.length - 2];

  /* One press, one visible change — on a register whose last visible column has
     six hidden ones after it. */
  const moved = afterReorder(seeds, orderAfterStep(seeds, last, -1));
  assert.deepEqual(
    tableKeys(moved).slice(-2),
    [last, secondLast],
    "Move earlier crosses the run of hidden columns and lands past the visible sibling",
  );

  /*
   * AND A RELOAD SHOWS THE SAME THING. `reorderRegisterColumns` rewrites
   * positions densely over ALL columns, so the persisted order stays a total
   * order and the hidden ones keep a stable place in it.
   */
  assert.equal(moved.length, seeds.length, "every column is still in the persisted order");
  assert.deepEqual(
    moved.map((entry) => entry.position),
    seeds.map((entry, index) => index),
    "positions come back dense, 0..n-1",
  );
  assert.deepEqual(
    moved.filter((entry) => entry.hidden).map((entry) => entry.key),
    seeds.filter((entry) => entry.hidden).map((entry) => entry.key),
    "and the hidden columns keep their relative order",
  );

  /* Sites draws no frozen lane, so its first visible column is an ordinary one
     and only its position stops it moving earlier. */
  assert.equal(frozenRegisterColumn(seeds.filter((entry) => entry.key !== "name")), null);
  assert.equal(canMoveRegisterColumn(seeds, seeds[0], -1), false, "nothing before the first");
});

/* ── One canonical column, and the standalone ones beside it ────────────── */

test("SOT-3 there can never be both a `name` and a `contractor` column on one register", async () => {
  const catalogue = await read(CATALOGUE);
  const block = catalogue.slice(
    catalogue.indexOf("export const CONTRACTOR_NATIVE_COLUMNS"),
    catalogue.indexOf("/** The native columns a register starts with"),
  );
  const fields = [...block.matchAll(/\{ field: "([A-Za-z0-9_]+)"/g)].map((match) => match[1]);

  /*
   * THE DECISION, PINNED. The composite lane's canonical KEY is `name` and its
   * canonical LABEL is `Contractor`. A key of `contractor` was the other
   * option and is refused, because for a native column the key IS the entity's
   * field — `seedNativeColumns` writes `columnKey: seed.field` — and
   * `addMissingNativeColumns` inserts every catalogue field a register does not
   * already hold. So a catalogue entry named `contractor` would not RENAME the
   * owner's `name` row; it would silently insert a SECOND identity column
   * beside it, leaving two checkboxes on the panel with the pin, the title and
   * the position stranded on the one nobody draws.
   */
  assert.equal(CONTRACTOR_COLUMN_KEY, "name", "the composite column's key is the entity's field");
  assert.equal(CONTRACTOR_COLUMN_TITLE, "Contractor", "and its default label is the concept");
  assert.ok(
    !fields.includes("contractor"),
    "no catalogue entry may claim the key `contractor` beside `name`",
  );
  assert.equal(
    fields.filter((field) => field === CONTRACTOR_COLUMN_KEY).length,
    1,
    "exactly one identity entry in the catalogue",
  );
  assert.match(
    block,
    new RegExp(`\\{ field: "${CONTRACTOR_COLUMN_KEY}", title: "${CONTRACTOR_COLUMN_TITLE}"`),
    "and it is labelled with the concept, not with the field name",
  );

  /*
   * AND THE CATALOGUE IS THE ONLY THING THAT EVER NAMES A NATIVE KEY. Both
   * insert paths write `columnKey: seed.field`, so a second identity column
   * cannot be introduced from anywhere else, and the unique index on
   * `(organisation, register, column_key)` refuses a duplicate of the first.
   */
  const engine = codeOnly(await read(ENGINE));
  assert.equal(
    (engine.match(/columnKey: seed\.field/g) ?? []).length,
    2,
    "seeding and reconciling both take the key from the catalogue field",
  );

  // One register, one identity column, whatever else is on it.
  const columns = ownerColumns();
  assert.equal(identityRegisterColumn(columns)?.key, CONTRACTOR_COLUMN_KEY);
  assert.equal(
    columns.filter((entry) => entry.nativeField === CONTRACTOR_COLUMN_KEY).length,
    1,
  );
});

test("SOT-3 Contact, Email, Phone and WhatsApp are standalone columns, independent of the lane", async () => {
  const catalogue = await read(CATALOGUE);
  const block = catalogue.slice(
    catalogue.indexOf("export const CONTRACTOR_NATIVE_COLUMNS"),
    catalogue.indexOf("/** The native columns a register starts with"),
  );

  /*
   * FOUR COLUMNS OF THEIR OWN, seeded hidden. A reader who wants the email as
   * sortable text ticks Email; the ACTIONABLE phone / WhatsApp / email block
   * inside the composite lane is a different rendering of the same facts and is
   * drawn from the page's `contact` prop, not from these rows. Duplication is
   * allowed exactly when somebody asked for it.
   */
  for (const [field, title] of [
    ["contactName", "Contact"],
    ["email", "Email"],
    ["phone", "Phone"],
    ["whatsappNumber", "WhatsApp"],
  ]) {
    assert.match(
      block,
      new RegExp(`\\{ field: "${field}", title: "${title}"[^}]*hidden: true`),
      `${title} is a standalone column of its own, off by default`,
    );
  }

  /*
   * SHOWING THE COMPOSITE LANE DOES NOT DRAG THEM ONTO THE TABLE, and hiding
   * one does not take anything out of the lane. Derived rather than argued: the
   * owner's register has all four hidden, and the answer for each is the same
   * whether the identity is pinned, unpinned or unticked.
   */
  const standalone = ["contactName", "email", "phone", "whatsappNumber"];
  for (const columns of [
    ownerColumns(),
    ownerColumnsWith("name", { hidden: false, settings: {} }),
    ownerColumnsWith("name", { hidden: true, settings: { pinned: false } }),
  ]) {
    const drawn = tableKeys(columns);
    for (const key of standalone) {
      assert.ok(!drawn.includes(key), `${key} stays off the table on its own answer`);
    }
  }

  // Ticking Email puts Email on the table and changes nothing else about the lane.
  const withEmail = ownerColumnsWith("email", { hidden: false, settings: { pinned: false } });
  assert.ok(tableKeys(withEmail).includes("email"), "the standalone column can be turned on");
  assert.equal(frozenRegisterColumn(withEmail)?.key, "name", "and the lane is untouched by it");

  /*
   * AND HIDING EMAIL CANNOT STRIP EMAIL FROM THE LANE, because the lane's
   * contact block is a prop the page passes and not a register column at all.
   * A source pin, because this is wiring a pure function cannot see.
   */
  const grid = codeOnly(await read(GRID));
  assert.match(grid, /\{contact\?\.\(row\)\}/, "the lane renders the page's contact block");
  assert.doesNotMatch(
    grid,
    /contact\?\.\(row\)[\s\S]{0,200}column\.hidden/,
    "and never gates it on another column's visibility",
  );
});

/* ── The rule has one home, and the callers use it ──────────────────────── */

test("SOT-10 every menu verb is offered from the same answer the write uses", async () => {
  const panel = codeOnly(await read(PANEL));

  /*
   * THE DISABLED STATE AND THE WRITE COME FROM ONE RULE. `index === 0` was a
   * test on the FULL list, so it left both buttons live on a column that was
   * already first or last ON THE TABLE and on the frozen column, which has no
   * place in the run to change. Every one of those presses wrote a new order
   * the reader could not see.
   */
  assert.match(
    panel,
    /disabled=\{busy \|\| !canMoveRegisterColumn\(columns, column, -1, frozenKey\)\}/,
    "Move earlier is offered only when it would move the table",
  );
  assert.match(
    panel,
    /disabled=\{busy \|\| !canMoveRegisterColumn\(columns, column, 1, frozenKey\)\}/,
    "and so is Move later",
  );
  assert.doesNotMatch(panel, /index === 0/, "the full-list test is gone, not layered over");
  assert.doesNotMatch(panel, /index === columns\.length - 1/);

  /*
   * AND THE CHECKLIST IS UNCHANGED OTHERWISE. One compact grid, one checkbox
   * per column meaning visible/hidden, no Shown/Hidden split and no permanent
   * hidden chips — the design the owner approved, and not something this work
   * is entitled to redraw.
   */
  assert.match(panel, /repeat\(auto-fill, minmax\(min\(100%, \d+px\), 1fr\)\)/, "one compact grid");
  assert.match(panel, /checked=\{!column\.hidden\}/, "the checkbox is visible/hidden");
  assert.doesNotMatch(panel, /Shown</, "no Shown/Hidden split");

  /* Every other verb is still reachable per column and still the grid's call. */
  for (const label of ["Move earlier", "Move later", "Rename", "Wider", "Narrower", "Remove"]) {
    assert.match(panel, new RegExp(`^\\s*${label}\\s*$`, "m"), `the menu still offers ${label}`);
  }
});

test("SOT the frozen rule and the move rule have exactly one definition", async () => {
  const client = codeOnly(await read(CLIENT));

  // The rule lives here, where the grid, the panel and the ordering helpers can
  // all reach the same answer.
  for (const verb of [
    "identityRegisterColumn",
    "frozenRegisterColumn",
    "registerTableColumns",
    "canMoveRegisterColumn",
    "orderAfterStep",
    "orderAfterMove",
  ]) {
    assert.match(client, new RegExp(`export function ${verb}\\(`), `${verb} is exported`);
  }

  /*
   * AND THE CONTRACTORS GRID NO LONGER CARRIES ITS OWN COPY. The version that
   * did ended `columns.find((column) => column.nativeField === "name") ?? null`
   * with no `hidden` check, which is defect 1 in one line.
   */
  const grid = codeOnly(await read(GRID));
  assert.doesNotMatch(
    grid,
    /export function frozenRegisterColumn\(\s*columns: readonly RegisterColumn\[\],\s*\): RegisterColumn \| null \{/,
    "the grid must import the rule rather than define a second one",
  );
  assert.match(grid, /frozenRegisterColumn/, "and it does still ask for it");
});

/* ── The live register answers with the shape all of this is derived from ─ */

const BASE_URL = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/registers?register=contractors`, {
      signal: AbortSignal.timeout(8000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test("SOT the live contractors register carries one identity column and no `contractor` key", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const response = await fetch(`${BASE_URL}/api/registers?register=contractors`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.columns), "the snapshot carries its columns");

  const identity = body.columns.filter((entry) => entry.nativeField === CONTRACTOR_COLUMN_KEY);
  assert.equal(identity.length, 1, "exactly one identity column on the real register");
  assert.equal(identity[0].native, true, "and it is a view onto the contractor's own field");
  assert.ok(
    !body.columns.some((entry) => entry.key === "contractor"),
    "and nothing has introduced a second logical column beside it",
  );

  /*
   * DERIVED FROM THE REAL ANSWER. Whatever this register's pins and hidden
   * flags are, the frozen lane is never a hidden column and is never drawn
   * twice — the two properties defect 1 turned on.
   */
  const frozen = frozenRegisterColumn(body.columns);
  if (frozen) assert.equal(frozen.hidden, false, "a frozen lane is never a hidden column");
  const drawn = registerTableColumns(body.columns).map((entry) => entry.key);
  assert.equal(new Set(drawn).size, drawn.length, "no column is drawn twice");
  assert.ok(
    drawn.every((key) => !body.columns.find((entry) => entry.key === key)?.hidden),
    "and nothing hidden reaches the table",
  );
});
