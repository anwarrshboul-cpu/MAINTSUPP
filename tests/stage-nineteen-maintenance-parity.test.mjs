import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Structural parity with monday board 1139774521 — Maintenance.
 *
 * The authority is `db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md`, a live
 * pull taken on 7 August 2026. Every expected value below is transcribed from
 * that capture by hand and written out in full, exactly as
 * `tests/store-documentation-board.test.mjs` does for board 1398027719.
 *
 * Deriving the expectations from `db/monday-board-spec.ts` — importing it,
 * mapping it, counting it — would only prove the file agrees with itself. It
 * would have passed on every fault this suite was written to catch: the first
 * column titled "Item" where monday says "Name", and the subitem statuses in
 * id order where monday renders index order.
 *
 * Three things here look like mistakes and are not. Do not "fix" them in the
 * spec; the importer maps monday's export headings and group names onto these
 * exact strings, so tidying one silently strands the rows filed under it:
 *
 *   "Nottingham complited"             monday's typo for "completed"
 *   "August  2026 Recently completed"  two spaces after August
 *   "Westfield Stratford  completed"   two spaces before completed
 *   "Plummer"                          monday's spelling of Plumber
 *
 * Store Location Name separates town from centre with an EN DASH (U+2013), not
 * a hyphen. The two are indistinguishable at a glance and not at all to a
 * string comparison.
 */

const SPEC = "db/monday-board-spec.ts";

/** The text between `from` and `to`, so one export can be read in isolation. */
function section(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start !== -1, `${from} is missing from ${SPEC}`);
  assert.ok(end > start, `${to} must follow ${from} in ${SPEC}`);
  return source.slice(start, end);
}

/** Reads an `opt(label, colour[, isDone])` list out of one option-set block. */
function options(source, setKey) {
  const start = source.indexOf(`${setKey}: [`);
  assert.ok(start !== -1, `option set ${setKey} is missing from ${SPEC}`);
  const open = source.indexOf("[", start);
  let depth = 1;
  let cursor = open + 1;
  while (depth > 0) {
    if (source[cursor] === "[") depth += 1;
    else if (source[cursor] === "]") depth -= 1;
    cursor += 1;
  }
  const block = source.slice(open + 1, cursor - 1);
  return [...block.matchAll(/opt\("([^"]*)",\s*"(#[0-9a-f]{6})"(,\s*true)?\)/g)].map(
    (match) => [match[1], match[2], Boolean(match[3])],
  );
}

/* ── Columns ──────────────────────────────────────────────────────────────── */

/**
 * The 25 columns, in monday's order: app key, monday's title, app type.
 *
 * Titles carry monday's own capitalisation — "Job Requested by" and "Approved
 * by" with a lowercase b, "Picture of completed works" lowercase throughout,
 * "Pictures of Maintenance Issue" capitalised. They are inconsistent on monday
 * and must stay inconsistent here.
 *
 * Types are the app's vocabulary, and four of them deliberately depart from the
 * monday column they mirror. Each is annotated; each is reversible in the UI.
 */
const MONDAY_COLUMNS = [
  // monday id `name`, type name. Titled "Name" on this board — "Item" is the
  // generic monday item noun, not what board 1139774521 shows.
  ["name", "Name", "text"],
  ["location", "Location", "text"],
  // monday `short_text` (single-line). Rendered as a textarea here: the request
  // form asks for several sentences and monday truncates them in the cell.
  ["description", "Description of Works to be done", "long_text"],
  ["tier", "Tier Level", "dropdown"],
  ["engineer", "Engineer Required", "status"],
  ["priority", "Priority", "status"],
  ["label", "Label", "status"],
  ["status", "Status", "status"],
  ["contractor", "Contractor", "text"],
  ["assignee", "Assigned To", "people"],
  ["requested", "Date Requested", "date"],
  ["completed", "Date Completed", "date"],
  ["timeline", "Timeline", "timeline"],
  ["requester", "Job Requested by", "text"],
  ["nextUpdate", "Next Update", "date"],
  ["issuePictures", "Pictures of Maintenance Issue", "files"],
  ["completedPictures", "Picture of completed works", "files"],
  // monday `numbers`. Held in pence here, matching the existing cell encoding.
  ["cost", "Cost of Works", "number"],
  ["approvedBy", "Approved by", "text"],
  // monday `subtasks`, pointing at child board 1164003119.
  ["subitems", "Subitems", "subitems"],
  ["invoice", "Invoice", "text"],
  ["files", "Files", "files"],
  // monday `numbers`, which eats the leading zero on 07863234937.
  ["number", "Number", "phone"],
  ["storeLocation", "Store Location Name", "status"],
  ["formView", "Form View", "link"],
];

test("the 25 columns keep monday's keys, titles, types and order", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceColumns",
    "export const maintenanceUiColumns",
  );

  const keys = [...block.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  const titles = [...block.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]);
  const types = [...block.matchAll(/type: "([a-z_]+)"/g)].map((match) => match[1]);

  assert.equal(keys.length, 25, "monday's Maintenance board carries exactly 25 columns");
  assert.deepEqual(
    keys,
    MONDAY_COLUMNS.map(([key]) => key),
    "column order is monday's, position for position — do not reorder or drop",
  );
  assert.deepEqual(
    titles,
    MONDAY_COLUMNS.map(([, title]) => title),
    "column titles are monday's, capitalisation included — the importer maps on them",
  );
  assert.deepEqual(
    types,
    MONDAY_COLUMNS.map(([, , type]) => type),
    "column types must not drift from the captured board",
  );
});

test("MAINTSUPP's own columns stay outside the 25", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceUiColumns",
    "/* ── Maintenance — groups",
  );

  /*
   * The property being pinned is that monday's 25 stay 25 — not that this array
   * never grows. Two entries live here, and both are MAINTSUPP's own:
   *
   *   move     monday exposes "move to group" from the row menu, not a column.
   *   dueDate  monday's board has no deadline column; this product's
   *            `maintenance_requests.due_at` has driven the overdue meter and
   *            the Planned calendar since long before the board showed it.
   *
   * Folding either into `maintenanceColumns` would make a parity count read 26
   * or 27, which is what the assertion above exists to catch. Anything else
   * appearing here should be argued for in the same terms.
   */
  const keys = [...block.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    keys,
    ["move", "dueDate"],
    "only MAINTSUPP's own non-monday columns may live here",
  );
});

/* ── Groups ───────────────────────────────────────────────────────────────── */

/**
 * All 38 groups, in monday's order, with monday's colours.
 *
 * The ten operational groups come first, then 28 per-store and per-month
 * archives. Two of the archive names carry a double space and one a spelling
 * mistake; all three are monday's and all three are load-bearing.
 */
const MONDAY_GROUPS = [
  ["topics", "Incoming requests", "#579bfc"],
  ["recently", "recently", "#007eb5"],
  ["jobs-booked", "Jobs Booked", "#9cd326"],
  ["needs-attention", "Needs attention", "#ff642e"],
  ["completed-2026-08", "August  2026 Recently completed", "#9cd326"],
  ["completed-2026-07", "July 2026 Recently completed", "#df2f4a"],
  ["completed-2026-06", "June 2026 Recently completed", "#66ccff"],
  ["on-hold", "On Hold", "#bb3354"],
  ["access-requests", "Access Requests", "#c4c4c4"],
  ["international", "International", "#00c875"],
  ["done-wood-green", "Wood Green completed", "#757575"],
  ["done-aldgate", "Aldgate completed", "#9cd326"],
  ["done-arndale", "Arndale completed", "#ff5ac4"],
  ["done-bluewater", "Bluewater completed", "#fdab3d"],
  ["done-brent-cross", "Brent Cross completed", "#9cd326"],
  ["done-brighton", "Brighton completed", "#ffcb00"],
  ["done-bespoke-whitecity", "Bespoke whitecity completed", "#784bd1"],
  ["done-bristol-cabot-circus", "Bristol Cabot Circus completed", "#757575"],
  ["done-bullring", "Bullring completed", "#ff007f"],
  ["done-cambridge", "Cambridge completed", "#fdab3d"],
  ["done-cardiff", "Cardiff completed", "#bb3354"],
  ["done-cribbs", "Cribbs completed", "#ff5ac4"],
  ["done-derby", "Derby completed", "#cab641"],
  ["done-glasgow-silverburn", "Glasgow Silverburn completed", "#579bfc"],
  ["done-highcross-leicester", "Highcross Leicester completed", "#00c875"],
  ["done-meadowhall-sheffield", "Meadowhall Sheffield completed", "#00c875"],
  ["done-merry-hill", "Merry Hill completed", "#037f4c"],
  ["done-metro-centre", "Metro Centre completed", "#9cd326"],
  ["done-milton-keynes", "Milton Keynes completed", "#9cd326"],
  ["done-nottingham", "Nottingham complited", "#579bfc"],
  ["done-reading", "Reading completed", "#ff5ac4"],
  ["done-white-city", "White City completed", "#cab641"],
  ["done-sjq-edinburgh", "SJQ Edinburgh completed", "#7f5347"],
  ["done-solihull", "Solihull completed", "#ff5ac4"],
  ["done-southall", "Southall completed", "#9d50dd"],
  ["done-westfield-stratford", "Westfield Stratford  completed", "#7f5347"],
  ["done-trafford-centre", "Trafford centre completed", "#ff5ac4"],
  ["done-watford", "Watford completed", "#cab641"],
];

test("all 38 groups keep monday's order, names and colours", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceGroups",
    "/* ── Maintenance — option sets",
  );

  const keys = [...block.matchAll(/key: "([a-z0-9-]+)"/g)].map((match) => match[1]);
  const names = [...block.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
  const colours = [...block.matchAll(/colour: "(#[0-9a-f]{6})"/g)].map((match) => match[1]);

  assert.equal(keys.length, 38, "monday's Maintenance board carries exactly 38 groups");
  assert.deepEqual(keys, MONDAY_GROUPS.map(([key]) => key));
  assert.deepEqual(
    names,
    MONDAY_GROUPS.map(([, name]) => name),
    "group names are the importer's join key — they must match monday byte for byte",
  );
  assert.deepEqual(
    colours,
    MONDAY_GROUPS.map(([, , colour]) => colour),
    "group colours are monday's, recorded as captured",
  );
});

test("monday's typo and double spaces survive in the group names", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceGroups",
    "/* ── Maintenance — option sets",
  );

  // Spelled out separately from the table above so the failure message names
  // the fault. Someone will read "complited" as a slip and correct it.
  assert.ok(
    block.includes('name: "Nottingham complited"'),
    'monday spells it "complited" — correcting it orphans that archive on import',
  );
  assert.ok(
    !block.includes("Nottingham completed"),
    "the corrected spelling must not appear — it is not a group monday has",
  );
  assert.ok(
    block.includes('name: "August  2026 Recently completed"'),
    "two spaces after August, as monday has it",
  );
  assert.ok(
    block.includes('name: "Westfield Stratford  completed"'),
    "two spaces before completed, as monday has it",
  );

  // The 28 archives seed collapsed so the board opens on the ten operational
  // groups rather than 700 rows of history.
  assert.equal((block.match(/collapsed: true/g) ?? []).length, 28);
});

/* ── Option sets ──────────────────────────────────────────────────────────── */

/**
 * Every option set, in monday's DISPLAY order.
 *
 * Monday orders a status dropdown by its `index`, which is not its `id` order
 * and not alphabetical. Engineer Required starts at Plummer, not Electrician;
 * Status starts at Pending Approval; the subitem board starts at Working on it.
 *
 * Colours are monday's own hex values. They are row data in
 * `maintenance_board_options`, not the MAINTSUPP interface palette, so carrying
 * them across restyles nothing.
 *
 * Tier Level is the exception: monday's is a plain dropdown, which has no
 * palette, so its four colours are MAINTSUPP's own and the capture records
 * none. That is a choice, not drift.
 */
const MONDAY_OPTIONS = {
  tier_level: [
    ["Tier 1", "#e2445c", false],
    ["Tier 2", "#fdab3d", false],
    ["Tier 3", "#579bfc", false],
    ["Tier 4", "#00c875", false],
  ],
  engineer_required: [
    ["Plummer", "#df2f4a", false],
    ["Electrician", "#00c875", false],
    ["Handyman", "#fdab3d", false],
    ["Other", "#007eb5", false],
  ],
  priority: [
    ["Medium", "#fdab3d", false],
    ["Low", "#00c875", false],
    ["Urgent", "#df2f4a", false],
  ],
  maintenance_label: [
    ["Locks", "#9aadbd", false],
    ["Hinges", "#007eb5", false],
    ["Glass", "#9d99b9", false],
    ["Signboard", "#00c875", true],
    ["Diffuser", "#9d50dd", false],
    ["Vinyls", "#037f4c", false],
    ["Acrylic", "#579bfc", false],
    ["Paint", "#cab641", false],
    ["Replacement parts", "#ffcb00", false],
    ["Other", "#333333", false],
    ["Lights", "#bb3354", false],
    ["TV/Display", "#ff007f", false],
    ["Shelves", "#ff5ac4", false],
    ["AC", "#784bd1", false],
    ["Drawers", "#9cd326", false],
    ["CCTV", "#66ccff", false],
  ],
  maintenance_status: [
    ["Pending Approval", "#ff7575", false],
    ["Pending Scheduling", "#fdab3d", false],
    ["Job Scheduled", "#cab641", false],
    ["Job In Progress", "#bda8f9", false],
    ["Job Completed", "#00c875", true],
    ["Blocked - Awaiting Response", "#df2f4a", false],
    ["Awaiting Landlord Approval", "#c4c4c4", false],
    ["Waiting for parts", "#ff007f", false],
    ["Health And Safety Hold", "#ffcb00", false],
    ["Waiting for payment", "#333333", false],
    ["Waiting for decisions", "#bb3354", false],
    ["Awaiting Access", "#ff5ac4", false],
    ["Escalated", "#784bd1", false],
    ["Major works", "#9d50dd", false],
    ["Third Party Delay", "#9cd326", false],
    ["Quote requested", "#66ccff", false],
    ["Quote Received (waiting for Approval)", "#ffadad", false],
    ["Quote approved", "#757575", false],
    ["Quote rejected", "#7f5347", false],
    ["Deposit Invoice Received", "#ff6d3b", false],
    ["Deposit Invoice Paid", "#faa1f1", false],
    ["Completion Invoice Received", "#007eb5", false],
    ["Completion Invoice Paid", "#7e3b8a", false],
  ],
  store_location: [
    ["Birmingham – Bullring", "#fdab3d", false],
    ["Solihull – Touchwood", "#00c875", false],
    ["Westfield – White City", "#df2f4a", false],
    ["Aldgate – Whitechapel Road", "#007eb5", false],
    ["Brent Cross – Shopping Centre", "#9d50dd", false],
    ["Brighton – Churchill Square", "#037f4c", false],
    ["Bristol – Cabot Circus", "#579bfc", false],
    ["Cardiff – Grand Arcade", "#cab641", false],
    ["Dudley – Merry Hill", "#ffcb00", false],
    ["Glasgow – Silverburn", "#333333", false],
    ["Greenhithe – Bluewater", "#bb3354", false],
    ["Manchester – Arndale", "#ff007f", false],
    ["Manchester – Trafford Centre", "#ff5ac4", false],
    ["Milton Keynes – The Centre", "#784bd1", false],
    ["Nottingham – Victoria Centre", "#9cd326", false],
    ["Reading – The Oracle", "#66ccff", false],
    ["Sheffield – Meadow Hall", "#757575", false],
    ["Southall – The Broadway", "#7f5347", false],
    ["Watford – Atria", "#ff6d3b", false],
    ["Westfield – Stratford", "#ff7575", false],
    ["Wood Green – High Road", "#faa1f1", false],
  ],
};

/** How many options monday's board carries per set, for a legible failure. */
const OPTION_COUNTS = {
  tier_level: 4,
  engineer_required: 4,
  priority: 3,
  maintenance_label: 16,
  maintenance_status: 23,
  store_location: 21,
};

for (const [setKey, expected] of Object.entries(MONDAY_OPTIONS)) {
  test(`${setKey} keeps monday's labels, order and colours`, async () => {
    const spec = await read(SPEC);
    const block = section(
      spec,
      "export const maintenanceOptions",
      "/** Subitem columns — monday board 1164003119. */",
    );
    const found = options(block, setKey);

    assert.equal(
      found.length,
      OPTION_COUNTS[setKey],
      `${setKey} carries ${OPTION_COUNTS[setKey]} options on monday`,
    );
    assert.deepEqual(
      found.map(([label]) => label),
      expected.map(([label]) => label),
      `${setKey} must be in monday's index order — not id order, not alphabetical`,
    );
    assert.deepEqual(
      found.map(([, colour]) => colour),
      expected.map(([, colour]) => colour),
      `${setKey} chip colours are monday's, recorded as captured`,
    );
    assert.deepEqual(
      found.map(([, , done]) => done),
      expected.map(([, , done]) => done),
      `${setKey} must mark the same option done as monday does`,
    );
  });
}

test("monday's blank labels are captured as absent, not seeded as empty chips", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceOptions",
    "/** Subitem columns — monday board 1164003119. */",
  );

  // Priority has a blank label at id 4 and Label one at id 5. Monday treats
  // them as "no value" and hides them from the dropdown; seeding them would put
  // an unlabelled, unpickable chip in the options admin.
  assert.ok(
    !/opt\(""/.test(block),
    "no option may have an empty label — monday's blanks are its no-value chips",
  );
  assert.equal(options(block, "priority").length, 3, "three real priorities, not four");
  assert.equal(options(block, "maintenance_label").length, 16, "sixteen real labels, not seventeen");
});

test("Store Location Name separates on an en dash, never a hyphen", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceOptions",
    "/** Subitem columns — monday board 1164003119. */",
  );
  const labels = options(block, "store_location").map(([label]) => label);

  for (const label of labels) {
    assert.ok(
      label.includes("–"),
      `${label} must use U+2013 EN DASH, as monday's board does`,
    );
    assert.ok(
      !label.includes("-"),
      `${label} contains a hyphen-minus — it reads identically and compares differently`,
    );
  }
});

test("monday's spelling of Plummer is preserved", async () => {
  const spec = await read(SPEC);
  // Renaming it to Plumber would leave every imported row carrying "Plummer"
  // with no chip to land on.
  assert.ok(spec.includes('opt("Plummer"'), "monday spells it Plummer");
  assert.ok(!spec.includes('opt("Plumber"'), "the corrected spelling is not a monday option");
});

/* ── Subitem board 1164003119 ─────────────────────────────────────────────── */

const MONDAY_SUBITEM_COLUMNS = [
  ["name", "Name", "text"],
  ["owner", "Owner", "people"],
  ["status", "Status", "status"],
  ["date", "Date", "date"],
];

/** Monday's stock status column, in its index order. */
const MONDAY_SUBITEM_STATUSES = [
  ["Working on it", "#fdab3d", false],
  ["Done", "#00c875", true],
  ["Stuck", "#df2f4a", false],
];

test("the subitem board carries monday's four columns", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceSubitemColumns",
    "export const maintenanceSubitemOptions",
  );

  const keys = [...block.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  const titles = [...block.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]);
  const types = [...block.matchAll(/type: "([a-z_]+)"/g)].map((match) => match[1]);

  assert.deepEqual(keys, MONDAY_SUBITEM_COLUMNS.map(([key]) => key));
  assert.deepEqual(titles, MONDAY_SUBITEM_COLUMNS.map(([, title]) => title));
  assert.deepEqual(types, MONDAY_SUBITEM_COLUMNS.map(([, , type]) => type));
});

test("the subitem statuses are monday's three, in monday's order", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceSubitemOptions",
    "/* ── Store Documentation UK",
  );
  const found = options(block, "subitem_status");

  // The child board has three labels, not the parent's twenty-three, and the
  // picker draws them in this order.
  assert.deepEqual(found, MONDAY_SUBITEM_STATUSES);
});

/* ── The seeders ──────────────────────────────────────────────────────────── */

test("the seeders read the capture rather than restating it", async () => {
  const structure = await read("db/seed-board-structure.ts");
  const optionsSeed = await read("db/seed-options.ts");

  // A second hand-maintained copy is what let the lists drift last time: the
  // options seed carried "Blocked - Awaiting information" against monday's
  // "Blocked - Awaiting Response", plus a "High" priority monday has no chip
  // for. Both files must re-export or derive, never re-declare.
  assert.match(structure, /from "\.\/monday-board-spec"/);
  assert.doesNotMatch(structure, /title: "/, "the structure seed must not declare columns");
  assert.doesNotMatch(structure, /colour: "/, "the structure seed must not declare groups");

  assert.match(optionsSeed, /from "\.\/monday-board-spec"/);
  for (const label of ["Pending Approval", "Plummer", "Urgent", "Tier 1", "Bullring"]) {
    assert.ok(
      !optionsSeed.includes(label),
      `${label} is written out in the capture — the options seed must derive, not restate`,
    );
  }
  // `#ffffff` is the text-colour fallback and is allowed. A chip colour is not:
  // every one of them belongs to the capture.
  const hexes = (optionsSeed.match(/#[0-9a-f]{6}/g) ?? []).filter((hex) => hex !== "#ffffff");
  assert.deepEqual(hexes, [], "chip colours belong to the capture, not to a second copy");
});

test("every option-set in the capture reaches a board column", async () => {
  const optionsSeed = await read("db/seed-options.ts");
  const map = section(optionsSeed, "const OPTION_SET_TO_COLUMN", "export const defaultBoardOptions");
  const pairs = [...map.matchAll(/(\w+): "(\w+)"/g)].map((match) => [match[1], match[2]]);

  // Six option-bearing columns on monday. A set with no column would be seeded
  // nowhere; a column with no set would render an empty picker.
  assert.deepEqual(pairs, [
    ["tier_level", "tier"],
    ["engineer_required", "engineer"],
    ["priority", "priority"],
    ["maintenance_label", "label"],
    ["maintenance_status", "status"],
    ["store_location", "storeLocation"],
  ]);

  // Position comes from the array index, so the seeded order is the captured
  // order. A sort here would undo everything above.
  assert.match(optionsSeed, /\.map\(\(entry, position\) =>/);
  assert.doesNotMatch(optionsSeed, /\.sort\(/, "the seeder must not re-sort monday's options");
});

test("the spec's option-set keys are exactly the ones the seeder maps", async () => {
  const spec = await read(SPEC);
  const block = section(
    spec,
    "export const maintenanceOptions",
    "/** Subitem columns — monday board 1164003119. */",
  );
  const keys = [...block.matchAll(/^ {2}(\w+): \[/gm)].map((match) => match[1]);
  assert.deepEqual(keys, Object.keys(OPTION_COUNTS));
});
