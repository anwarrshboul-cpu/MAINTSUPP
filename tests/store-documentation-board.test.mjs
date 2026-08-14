import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Guards for the second board — Store Documentation UK.
 *
 * The schema has carried `board_id` on every board table since Stage 3, but the
 * board route pinned it to the literal "maintenance", so a second board could
 * be seeded and never read. These tests hold that open.
 */

test("the board route is not pinned to a single board", async () => {
  const route = await read("app/api/board/route.ts");

  assert.doesNotMatch(
    route,
    /const BOARD_ID = "maintenance"/,
    "the hardcoded board id is what stopped a second board being served",
  );
  assert.match(route, /function boardIdFrom\(request: Request\)/);

  // `board_id` reaches a WHERE clause, so the query string must not be trusted
  // straight through. This is the check that stops a caller addressing rows the
  // route was never meant to serve.
  assert.match(
    route,
    /BOARD_IDS\.includes\(raw as BoardId\)/,
    "the board id must be validated against an allow-list, not passed through",
  );
  assert.match(
    route,
    /const DEFAULT_BOARD_ID: BoardId = "maintenance"/,
    "existing callers send no board param and must keep getting maintenance",
  );
});

test("every board query still filters by organisation", async () => {
  const route = await read("app/api/board/route.ts");
  // Parameterising the board must not have loosened tenant scoping: each board
  // table is filtered on organisationId as well as boardId.
  const boardIdFilters = route.match(/eq\((\w+)\.boardId, boardId\)/g) ?? [];
  assert.ok(
    boardIdFilters.length > 8,
    `expected the board filter throughout, found ${boardIdFilters.length}`,
  );
  const orgFilters = route.match(/eq\((\w+)\.organisationId, orgId\)/g) ?? [];
  assert.ok(
    orgFilters.length >= boardIdFilters.length,
    `every board filter needs an organisation filter beside it — ${boardIdFilters.length} board vs ${orgFilters.length} org`,
  );
});

test("the board seeds structure only, never invented stores", async () => {
  const seed = await read("db/seed-store-documentation.ts");

  // The owner's real stores, addresses and access links live in monday and
  // arrive through the importer. Inventing any of them would put fabricated
  // compliance data in front of someone who has to act on it.
  for (const invented of ["Aldgate", "Westfield", "Bluewater", "Meadowhall", "Brentcross"]) {
    assert.ok(
      !seed.includes(invented),
      `${invented} is a real store name — the seeder must not fabricate rows`,
    );
  }
  assert.doesNotMatch(seed, /maintenance_board_cells/, "no cell values may be seeded");
});

test("the seeder is idempotent and organisation-scoped", async () => {
  const seed = await read("db/seed-store-documentation.ts");
  assert.match(
    seed,
    /INSERT OR IGNORE/,
    "re-running initialisation must not duplicate columns or groups",
  );
  assert.match(seed, /organisationId/, "every seeded row belongs to an organisation");
});

test("group colours use the MAINTSUPP palette, not monday's", async () => {
  const seed = await read("db/seed-store-documentation.ts");
  const spec = await read("db/monday-board-spec.ts");

  // monday's own hex values stay in the spec, which is a capture of the live
  // board. The seeder re-maps them on the way in.
  assert.match(spec, /#579bfc/, "the spec records monday's colours as captured");
  for (const mondayHex of ["#579bfc", "#a25ddc", "#ff5ac4", "#757575"]) {
    assert.ok(
      !seed.includes(mondayHex),
      `${mondayHex} is monday's palette and must not reach the seeded board`,
    );
  }
  for (const ours of ["#12b5aa", "#1b4662", "#8d9aa7", "#667889"]) {
    assert.ok(seed.includes(ours), `${ours} is missing from the group colour map`);
  }
});

test("the board structure matches the captured monday board", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const block = spec.slice(
    spec.indexOf("export const storeDocumentationColumns"),
    spec.indexOf("export const storeDocumentationGroups"),
  );

  // 12 documents, 9 of which carry an expiry date. Three deliberately do not:
  // RAMS, the Fire Risk Assessment and the store Drawing.
  const files = (block.match(/type: "files"/g) ?? []).length;
  const dates = (block.match(/type: "date"/g) ?? []).length;
  assert.equal(files, 12, "twelve document slots");
  assert.equal(dates, 9, "nine expiry dates — RAMS, Fire Risk and Drawing have none");

  // Column titles carry monday's own capitalisation, including "FireDoor Test".
  // Tidying them here would break the one-to-one mapping the importer relies on.
  assert.match(block, /title: "FireDoor Test"/);
});

test("the section is reachable from the dashboard", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /\| "store-documentation"/, "the section must exist on the Section union");
  assert.match(portal, /"store-documentation": \{\s*label: "Store Documentation"/);
  // A section that is routable but absent from the sidebar is a section nobody
  // finds.
  const nav = portal.slice(portal.indexOf("const navPrimary"), portal.indexOf("const navSecondary"));
  assert.match(nav, /"store-documentation"/, "it must appear in the sidebar");

  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(page, /"store-documentation": "store-documentation"/);
});

test("every board request carries the board it is for", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");

  // 26 call sites hit /api/board. One missed URL would read or write the wrong
  // board's rows without erroring, so none may address the API directly.
  assert.doesNotMatch(
    board,
    /fetch\("\/api\/board/,
    "board requests must go through boardUrl(), not a hardcoded path",
  );
  assert.match(board, /function boardUrl\(path: string, boardId: string\)/);

  // Maintenance must keep sending the exact URL it always sent — a new query
  // param on the default path is a behaviour change nobody asked for.
  assert.match(
    board,
    /if \(boardId === "maintenance"\) return path;/,
    "the default board's URLs must stay untouched",
  );
  assert.match(board, /boardId = "maintenance"/, "the prop must default to maintenance");
});

/**
 * The 25 columns, in monday's order, keyed and titled exactly as the source
 * board has them.
 *
 * Written out in full rather than derived from `monday-board-spec.ts`, because
 * a test that reads the same file the code reads proves only that one file
 * agrees with itself. This list is the capture of monday board 1398027719, and
 * a reorder has to fail here.
 *
 * The order is not cosmetic: each of the nine expiry columns sits immediately
 * after the document it dates, which is how the Compliance Tracker pairs them
 * and how anyone reading the sheet across knows which certificate a date
 * belongs to. Monday's own capitalisation is preserved — "FireDoor Test" and
 * "PLI Document" included — because the importer maps export headings onto
 * these titles.
 */
const MONDAY_COLUMN_ORDER = [
  /*
   * "Name", not "Store".
   *
   * This list is the capture, so it carried the same transcription error the
   * spec did: the app renamed monday's first column to "Store" because the
   * board's item noun is Store. The header on monday reads "Name" — confirmed
   * against the API, where the first column of all three boards is titled
   * "Name" — and the maintenance board's equivalent was already correct here.
   * The item noun is unchanged and still reads "New store" on the button.
   */
  ["name", "Name"],
  ["storeType", "Store Type"],
  ["storeAddress", "Store Address"],
  ["accessRequest", "Access Request"],
  ["rams", "RAMS"],
  ["fireRiskAssessment", "Fire Risk Assessment"],
  ["pliDocument", "PLI Document"],
  ["pliExpiry", "PLI Expiry Date"],
  ["patCertificate", "PAT Test Certificate"],
  ["patExpiry", "PAT Test Expiry Date"],
  ["electricalCertificate", "Electrical Wiring Certificate"],
  ["electricalExpiry", "Electrical Wiring Certificate Expiry"],
  ["fireExtinguisher", "Fire Extinguisher"],
  ["fireExtinguisherExpiry", "Fire Extinguisher Expiry"],
  ["fireAlarmReport", "Fire Alarm Report"],
  ["fireAlarmExpiry", "Fire Alarm Expiry"],
  ["emergencyLighting", "Emergency Lighting Report"],
  ["emergencyLightingExpiry", "Emergency Lighting Expiry"],
  ["sprinklerReport", "Sprinkler Report"],
  ["sprinklerExpiry", "Sprinkler Expiry"],
  ["waterHygiene", "Water Hygiene Test Report"],
  ["waterHygieneExpiry", "Water Hygiene Test Expiry"],
  ["fireDoorTest", "FireDoor Test"],
  ["fireDoorExpiry", "Fire Door Expiry"],
  ["drawing", "Drawing"],
];

test("the 25 columns stay in monday's order", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const block = spec.slice(
    spec.indexOf("export const storeDocumentationColumns"),
    spec.indexOf("export const storeDocumentationGroups"),
  );

  const keys = [...block.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  const titles = [...block.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]);

  assert.equal(keys.length, 25, "the board carries exactly 25 columns");
  assert.deepEqual(
    keys,
    MONDAY_COLUMN_ORDER.map(([key]) => key),
    "column order must match monday position for position — do not reorder",
  );
  assert.deepEqual(
    titles,
    MONDAY_COLUMN_ORDER.map(([, title]) => title),
    "column titles are monday's, capitalisation included",
  );
});

test("the seeder writes positions from the captured order", async () => {
  const seed = await read("db/seed-store-documentation.ts");

  // `entries()` gives the array index, so the stored position is the spec's
  // order. Anything else — a sort, a lookup table — would let the two drift.
  assert.match(
    seed,
    /for \(const \[position, column\] of storeDocumentationColumns\.entries\(\)\)/,
    "positions must come from the spec's array order, not a second list",
  );
  assert.doesNotMatch(
    seed,
    /storeDocumentationColumns[\s\S]{0,80}\.sort\(/,
    "the seeder must not re-sort the captured columns",
  );
});

test("every expiry column follows the document it dates", async () => {
  // The pairing is what makes the sheet readable across, and what the
  // Compliance Tracker walks. An expiry that drifts away from its document
  // dates the wrong certificate.
  for (const [index, [key]] of MONDAY_COLUMN_ORDER.entries()) {
    if (!/Expiry$/.test(key)) continue;
    const previous = MONDAY_COLUMN_ORDER[index - 1][0];
    assert.ok(
      !/Expiry$/.test(previous),
      `${key} follows ${previous}, which is itself an expiry column`,
    );
  }
});

test("the Store Type filter and choices come off the column, not a hardcoded list", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");

  // The maintenance priority filter offers four values this board has no
  // column for, so using it hid every row. The replacement reads the column's
  // own choices, which means an admin adding a fifth store type sees it here
  // without a deploy.
  assert.match(board, /const storeTypeColumn = useMemo/);
  assert.match(board, /storeTypeChoices\.map\(\(choice\) => \(/);
  assert.doesNotMatch(
    board,
    /aria-label="Filter by Store Type"[\s\S]{0,200}<option>Inline<\/option>/,
    "the store types must not be restated in the toolbar",
  );

  // Person and Group by stay off this board: there is no people column, and the
  // four groups are fixed.
  assert.match(board, /\{!isStoreDocumentation && \(\s*<label className="live-board-tool">/);
});

test("an imported cell resolves to its choice even though it holds the label", async () => {
  const format = await read("app/(app)/portal/board-format.ts");

  // Picking in the grid writes the choice id ("kiosk"); monday exports the
  // label ("Kiosk"). Matching on id alone left all 31 Store Type cells blank.
  assert.match(format, /export function findChoice/);
  assert.match(format, /choice\.label\.trim\(\)\.toLowerCase\(\) === needle/);

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /const selected = findChoice\(choices, value\)/);
  assert.doesNotMatch(
    board,
    /choices\.find\(\(choice\) => choice\.id === value\)/,
    "the id-only lookup is what blanked the imported cells",
  );
});

test("the board serves the rows it places", async () => {
  const route = await read("app/api/board/route.ts");

  // `items` is placement only. Without the rows themselves the grid drew 31
  // stores' worth of positions against nothing and came up empty.
  assert.match(route, /requests: requestRows\.map\(exposeRequest\)/);
  assert.match(
    route,
    /inArray\(maintenanceRequests\.id, chunk\)/,
    "a board must serve only the rows it places, and in chunks",
  );

  // The redaction list lives in one place, so a board payload cannot leak what
  // the maintenance payload strips.
  const shared = await read("app/lib/request-payload.ts");
  assert.match(shared, /delete payload\.publicUploadTokenHash/);
  const maintenance = await read("app/api/maintenance/route.ts");
  assert.match(maintenance, /import \{ exposeRequest \} from "\.\.\/\.\.\/lib\/request-payload"/);

  const shell = await read("app/(app)/portal/views/store-documentation-board.tsx");
  assert.match(shell, /requests=\{stores\}/, "the grid must be handed the stores");
});

test("a new row is named for the board that made it", async () => {
  const route = await read("app/api/board/route.ts");
  assert.match(route, /function newItemTitle\(boardId: BoardId\)/);
  assert.match(route, /"store-documentation" \? "New store"/);
  // Maintenance keeps its exact wording.
  assert.match(route, /"New maintenance item"/);
});
