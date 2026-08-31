/**
 * Stage 24 — the compliance register says what the Store Documentation board
 * says, and every compliance surface says the same thing.
 *
 * WHAT WAS WRONG
 *
 * The whole compliance area was reading a different estate from the one the
 * client gave us. `compliance_documents` had exactly three writers — the sample
 * seeder in `/api/workspace` and that route's own POST and PATCH — and the
 * monday importer never touched it. So the product's view of compliance was 120
 * rows seeded from `app/lib/mock-data.ts` across ten fictional sites (their
 * managers are called "Sample Manager F"), while the board imported from the
 * client's monday account — 31 stores, 42 expiry dates — reached no screen at
 * all.
 *
 * Six separate defects fell out of that, and each has its own test below:
 *
 *   1. The register was seed data, not board data. 27 of its 34 expiry dates
 *      appeared nowhere on the board.
 *   2. It reported lapsed certificates as valid. The board says HQ - The Loom's
 *      PAT certificate expired 2025-04-29 with four files attached; both
 *      compliance screens showed "PAT Test · 05/06/2027 · Compliant". Eleven
 *      board certificates were expired; the screens showed one, and it was
 *      invented.
 *   3. The Compliance Tracker drew 10 stores on a board whose adjacent tab said
 *      31, because the shell rendered `<StoreComplianceTracker />` with no
 *      `stores` prop and the tracker fell back to `/api/workspace`.
 *   4. The Calendar — the one surface deliberately built from board expiry
 *      dates — rendered empty, because the shell handed it `payload.items`,
 *      which are PLACEMENTS (`{requestId, groupId, position}`) and carry no
 *      `cells`. The values live in a sibling `cells` array.
 *   5. Expired / due soon / valid were read from a stored status STRING that
 *      nothing ever recomputed, so a row stored "Compliant" stayed Compliant
 *      for ever, and the two screens printed 31 and 32 for the same ten stores.
 *   6. The tracker's "Due within 30 days" tile actually counted 60, because it
 *      declared its own `DUE_SOON_DAYS = 30` for the label and then filled the
 *      tile from `expiryStatus`, whose window is 60.
 *
 * And the email digest scanned the same seeded table, so it alerted on fiction
 * and was silent on all eleven genuinely lapsed board certificates.
 *
 * WHY THE FIX IS RIGHT
 *
 * One derivation, in `app/lib/store-documentation-register.ts`, turns board
 * rows into register records; `app/lib/compliance-register.ts` reads it out of
 * the database for the screens and the digest alike. `compliance_documents` is
 * not dropped and no row was deleted — it became the override layer it should
 * always have been, holding "Not required", which the board has no column for.
 *
 * These tests transpile and CALL the shipped modules rather than grepping them,
 * so they assert behaviour. The numbers are pinned to the real capture in
 * db/monday-export/api-pull/store-documentation.json.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/**
 * Source with its block comments removed.
 *
 * Every fix in this area is documented by quoting the broken line it replaced,
 * so `setItems(payload.items ?? [])` and `<StoreComplianceTracker />` both still
 * appear in the files — inside the comments explaining why they are gone. A
 * "this must not appear" assertion run over the raw text therefore fails on the
 * explanation rather than on the defect. These assertions are about what the
 * code DOES, so they read the code.
 */
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");

/*
 * A data: URL cannot resolve a relative specifier, so each dependency is
 * substituted for its own data: URL before its importer is loaded. Only the
 * VALUE imports need it — the type-only ones are erased by the transpile.
 */
const specUrl = asModule(transpile(await read("db/monday-board-spec.ts")));
const spec = await import(specUrl);

/*
 * expiry-status.ts writes its dates through app/lib/format-date.ts, the one
 * en-GB formatter the platform shares, rather than keeping two `Intl`
 * instances of its own. That is one more relative specifier a data: URL cannot
 * resolve, so it is substituted like every other dependency here.
 */
const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));
const expiryUrl = asModule(
  transpile(await read("app/lib/expiry-status.ts")).replace(
    /from ["']\.\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);
const expiry = await import(expiryUrl);

const register = await import(
  asModule(
    transpile(await read("app/lib/store-documentation-register.ts"))
      .replace(/from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${specUrl}"`)
      .replace(/from ["']\.\/expiry-status["']/g, `from "${expiryUrl}"`),
  )
);

const model = await import(
  asModule(
    transpile(
      await read("app/(app)/portal/views/store-documentation-model.ts"),
    )
      .replace(
        /from ["']\.\.\/\.\.\/\.\.\/\.\.\/db\/monday-board-spec["']/g,
        `from "${specUrl}"`,
      )
      /*
       * The model now normalises the expiry cell through `dateOnlyValue`, the
       * same helper the server-side register uses, so monday's two date shapes
       * — a bare "2026-08-05" and a {"date":…} object — reach the tracker and
       * the renewal calendar as one shape. That is one more relative specifier
       * a data: URL cannot resolve, substituted here exactly as the register's
       * own import of the same module is above.
       */
      .replace(
        /from ["']\.\.\/\.\.\/\.\.\/lib\/expiry-status["']/g,
        `from "${expiryUrl}"`,
      ),
  )
);

/* ── A board payload shaped exactly like /api/board's ────────────────────── */

/**
 * Column ids are per-organisation seeds, and that asymmetry is the trap this
 * area kept falling into: `cells` is keyed by column ID, the spec names columns
 * by KEY. A fixture that used the key as the id would let a broken key→id
 * resolution pass.
 */
const columnId = (key) => `seed-org_1-store-documentation-${key}`;

const COLUMNS = [
  "storeType",
  "storeAddress",
  "accessRequest",
  "rams",
  "fireRiskAssessment",
  "pliDocument",
  "pliExpiry",
  "patCertificate",
  "patExpiry",
  "electricalCertificate",
  "electricalExpiry",
  "fireExtinguisher",
  "fireExtinguisherExpiry",
  "fireAlarmReport",
  "fireAlarmExpiry",
  "emergencyLighting",
  "emergencyLightingExpiry",
  "sprinklerReport",
  "sprinklerExpiry",
  "waterHygiene",
  "waterHygieneExpiry",
  "fireDoorTest",
  "fireDoorExpiry",
  "drawing",
].map((key) => ({ id: columnId(key), key }));

const cell = (requestId, key, value) => ({
  requestId,
  columnId: columnId(key),
  value,
});
const files = (requestId, key, count) => ({
  requestId,
  columnId: columnId(key),
  count,
});

/**
 * Three real rows from the capture, with their real values.
 *
 *  - sd-loom is HQ - The Loom: PAT expiry 2025-04-29 with four files. The
 *    screens called this "Compliant, 05/06/2027".
 *  - sd-bristol is Cabot Circus - Bristol: electrical wiring to 2029-03-26 with
 *    ten files, which the screens called "Missing", and fire alarm 2027-06-01,
 *    which they reported as 18/08/2026 "due soon".
 *  - sd-stratford is Westfield Stratford, the store whose fire alarm and water
 *    hygiene are marked Not required in the register.
 */
const PAYLOAD = {
  columns: COLUMNS,
  groups: [
    { id: "g-current", name: "Current stores", position: 0 },
    { id: "g-closed", name: "Closed", position: 1 },
  ],
  requests: [
    { id: "sd-loom", title: "HQ - The Loom" },
    { id: "sd-bristol", title: "Cabot Circus - Bristol" },
    { id: "sd-stratford", title: "Westfield Stratford" },
  ],
  items: [
    { requestId: "sd-bristol", groupId: "g-current", position: 1 },
    { requestId: "sd-loom", groupId: "g-current", position: 0 },
    { requestId: "sd-stratford", groupId: "g-closed", position: 0 },
  ],
  cells: [
    cell("sd-loom", "patExpiry", "2025-04-29"),
    cell("sd-loom", "storeType", "Office"),
    cell("sd-bristol", "electricalExpiry", "2029-03-26"),
    cell("sd-bristol", "fireAlarmExpiry", "2027-06-01"),
    cell("sd-bristol", "patExpiry", "2026-11-06"),
    cell("sd-stratford", "storeType", "Inline"),
  ],
  fileCounts: [
    files("sd-loom", "patCertificate", 4),
    files("sd-bristol", "electricalCertificate", 10),
    files("sd-bristol", "rams", 2),
  ],
  notRequired: [
    { itemId: "sd-stratford", slotKey: "fire-alarm" },
    { itemId: "sd-stratford", slotKey: "water-hygiene" },
  ],
};

/** The day the findings were measured against. Pinned so nothing drifts. */
const TODAY = new Date("2026-08-10T09:00:00Z");

const rows = () =>
  register.boardRowsFrom({
    requests: PAYLOAD.requests,
    columns: PAYLOAD.columns,
    cells: PAYLOAD.cells,
    fileCounts: PAYLOAD.fileCounts,
  });

const documentFor = (store, kind) =>
  store.documents.find((document) => document.kind === kind);

/* ── 1 + 2. The register is the board, and a lapsed certificate is lapsed ── */

test("the register is derived from board cells, not from a seeded table", async () => {
  const derived = register.storeDocumentationRegister(rows(), { today: TODAY });

  assert.equal(derived.length, 3, "one register store per board row");
  assert.deepEqual(
    derived.map((store) => store.name).sort(),
    ["Cabot Circus - Bristol", "HQ - The Loom", "Westfield Stratford"],
    "the register's stores are the board's stores, under the board's names",
  );

  // Every store gets every slot the board tracks — twelve, not the register's
  // old five ad-hoc kinds, which had no room for PLI, sprinklers or fire doors.
  for (const store of derived) {
    assert.equal(store.documents.length, 12);
  }

  // The value came out of the cell, which means it came out of the board.
  const loom = derived.find((store) => store.name === "HQ - The Loom");
  assert.equal(documentFor(loom, "PAT Test").expiry, "2025-04-29");
  assert.equal(loom.type, "Office", "store type is read from the board too");
});

test("a certificate the board says lapsed is never reported as valid", () => {
  const derived = register.storeDocumentationRegister(rows(), { today: TODAY });
  const loom = derived.find((store) => store.name === "HQ - The Loom");
  const pat = documentFor(loom, "PAT Test");

  /*
   * The exact contradiction from the finding. The board reads 2025-04-29 with
   * four files attached — 468 days lapsed on 2026-08-10 — and both compliance
   * surfaces printed "05/06/2027 · Compliant / In date". A date that appears
   * nowhere on the board.
   */
  assert.equal(pat.state, "Expired");
  assert.equal(pat.expiry, "2025-04-29");
  assert.equal(pat.fileCount, 4, "the files are on the slot, and it still lapsed");
  assert.notEqual(pat.state, "Compliant");

  const status = expiry.expiryStatus(pat.expiry, TODAY);
  assert.equal(status.state, "expired");
  assert.equal(status.daysRemaining, -468);
});

test("a held certificate with a future date is not Missing", () => {
  const derived = register.storeDocumentationRegister(rows(), { today: TODAY });
  const bristol = derived.find(
    (store) => store.name === "Cabot Circus - Bristol",
  );

  /*
   * The mirror failure: the board holds Electrical Wiring to 2029-03-26 with
   * ten files attached and downloadable, and the screens said "Missing"
   * because the seeded register had no such row.
   */
  const wiring = documentFor(bristol, "Electrical Wiring");
  assert.equal(wiring.expiry, "2029-03-26");
  assert.equal(wiring.fileCount, 10);
  assert.equal(wiring.state, "Compliant");

  // And the fire alarm is the board's 2027-06-01, not the register's invented
  // 18/08/2026 "due soon, in 9 days".
  const alarm = documentFor(bristol, "Fire Alarm");
  assert.equal(alarm.expiry, "2027-06-01");
  assert.equal(alarm.state, "Compliant");
});

test("no compliance screen can reach the sample seed", async () => {
  const workspace = withoutComments(await read("app/api/workspace/route.ts"));

  // The register now comes from the board reader. If this import goes, the
  // seeded table is back in front of the customer.
  assert.match(
    workspace,
    /readComplianceRegister/,
    "the workspace route must build compliance from the board register",
  );

  /*
   * The specific line that made the register a status STRING: the state was
   * read off `item.status` with no date arithmetic anywhere near it.
   */
  assert.doesNotMatch(
    workspace,
    /state:\s*\(item\.notRequired \? "Not required" : item\.status\)/,
    "state must be computed from the expiry date, never read from the column",
  );
});

/* ── 5. State is computed from the date, not from a stored word ─────────── */

test("state is recomputed from the date on every read", () => {
  const dated = (iso, fileCount = 1) =>
    register.complianceStateFor({
      tracksExpiry: true,
      expiry: iso,
      fileCount,
      today: TODAY,
    });

  assert.equal(dated("2026-08-09"), "Expired", "yesterday is expired");
  assert.equal(dated("2026-08-10"), "Expiring soon", "today is the last valid day");
  assert.equal(dated("2026-10-09"), "Expiring soon", "60 days out is amber");
  assert.equal(dated("2026-10-10"), "Compliant", "61 days out is green");

  /*
   * The live contradiction from the finding: store-brentcross PAT was STORED
   * "Expiring soon" with an expiry 86 days away, so /dashboard/compliance
   * counted it as expiring while the tracker, which reads the date, called it
   * in date. Same document, two screens, 31 against 32. The stored word cannot
   * reach this function at all.
   */
  assert.equal(dated("2026-11-03"), "Compliant", "86 days away is not expiring");

  // The three slots the board tracks no date for are answered by holding alone,
  // and are never amber — there is nothing to count down to.
  const held = (fileCount) =>
    register.complianceStateFor({
      tracksExpiry: false,
      expiry: null,
      fileCount,
      today: TODAY,
    });
  assert.equal(held(1), "Compliant");
  assert.equal(held(0), "Missing");
});

test("the five-word vocabulary is unchanged", () => {
  /*
   * `ComplianceState` is the vocabulary of the register CRUD panel, the CSV
   * export and `complianceTone`. Deriving the values had to keep the words, or
   * every chip class breaks silently.
   */
  const produced = new Set();
  for (const tracksExpiry of [true, false]) {
    for (const expiryDate of [null, "2020-01-01", "2026-08-10", "2030-01-01"]) {
      for (const fileCount of [0, 3]) {
        for (const notRequired of [false, true]) {
          produced.add(
            register.complianceStateFor({
              tracksExpiry,
              expiry: expiryDate,
              fileCount,
              notRequired,
              today: TODAY,
            }),
          );
        }
      }
    }
  }
  for (const word of produced) {
    assert.ok(
      ["Compliant", "Expiring soon", "Expired", "Missing", "Not required"].includes(
        word,
      ),
      `${word} is not one of the five states the UI knows`,
    );
  }
  assert.ok(produced.has("Not required"), "the override must still be reachable");
});

/* ── 6. One threshold, one name ──────────────────────────────────────────── */

test("the due-soon window is one constant, and the label prints it", async () => {
  assert.equal(expiry.EXPIRY_DUE_SOON_DAYS, 60);

  const tracker = withoutComments(
    await read("app/(app)/portal/views/store-compliance-tracker.tsx"),
  );

  /*
   * The tile said "Due within 30 days" from a local `DUE_SOON_DAYS = 30` and
   * then filled itself from `expiryStatus`, which is 60. `verdictFromDays` —
   * the only code that used the 30 — was unreachable. A document 45 days out
   * was counted in a tile that said 30.
   */
  assert.doesNotMatch(
    tracker,
    /const DUE_SOON_DAYS\s*=/,
    "a second due-soon window is how the label and the count drifted apart",
  );
  assert.match(
    tracker,
    /Due within \$\{EXPIRY_DUE_SOON_DAYS\} days/,
    "the label must be printed from the constant that decides the count",
  );

  // The case that used to be miscounted, asserted through the classifier.
  const fortyFive = expiry.expiryStatus("2026-09-24", TODAY);
  assert.equal(fortyFive.daysRemaining, 45);
  assert.equal(fortyFive.state, "due-soon");
});

/* ── 4. Placements are not rows ──────────────────────────────────────────── */

test("board items are joined to their cells, not served as placements", () => {
  const items = model.buildStoreBoardItems(PAYLOAD);

  assert.equal(items.length, 3);

  /*
   * The defect exactly: `payload.items` are `{requestId, groupId, position}`.
   * The Calendar reads `item.cells?.[columnId]`, which was `undefined` on every
   * row, so a board holding 42 expiry dates drew "No renewal dates recorded
   * yet". Any row that reaches the Calendar must carry an id, a title and cells.
   */
  for (const item of items) {
    assert.ok(item.id, "a row must carry its own id; a placement has none");
    assert.ok(item.title, "a row must carry its title; a placement has none");
    assert.equal(typeof item.cells, "object");
  }

  const loom = items.find((item) => item.id === "sd-loom");
  assert.equal(
    loom.cells[columnId("patExpiry")],
    "2025-04-29",
    "the Calendar reads cells by column ID — this is the join that was missing",
  );

  // Keyed by id, NOT by key. Reading by key finds nothing and looks like no data.
  assert.equal(loom.cells.patExpiry, undefined);

  // Group then position, so the Calendar and the grid agree about ordering.
  assert.deepEqual(
    items.map((item) => item.id),
    ["sd-loom", "sd-bristol", "sd-stratford"],
  );
});

test("an empty cell is not a renewal date", () => {
  const items = model.buildStoreBoardItems({
    ...PAYLOAD,
    cells: [...PAYLOAD.cells, cell("sd-stratford", "patExpiry", "")],
  });
  const stratford = items.find((item) => item.id === "sd-stratford");
  assert.equal(
    stratford.cells[columnId("patExpiry")],
    undefined,
    "a cleared date must not become a calendar entry for nothing",
  );
});

/* ── 3. The tracker is fed the board's stores ────────────────────────────── */

test("the shell hands the board's rows to the Compliance Tracker", async () => {
  const shell = withoutComments(
    await read("app/(app)/portal/views/store-documentation-board.tsx"),
  );

  /*
   * `<StoreComplianceTracker />` with no `stores` prop is what sent the tracker
   * to its own `/api/workspace` fetch and drew 10 stores beside a tab reading
   * 31 — hiding 21 board stores including 6 of the 7 with an expired
   * certificate.
   */
  assert.doesNotMatch(
    shell,
    /<StoreComplianceTracker\s*\/>/,
    "an unfed tracker falls back to /api/workspace and shows the wrong estate",
  );
  assert.match(shell, /<StoreComplianceTracker stores=\{/);

  // And the Calendar must be fed the joined rows, not the raw payload.
  assert.doesNotMatch(
    shell,
    /setItems\(payload\.items/,
    "handing placements to the Calendar is what emptied it",
  );
  assert.match(shell, /buildStoreBoardItems/);
});

test("every board store reaches the tracker, with its files and dates", () => {
  const stores = model.buildComplianceStores(PAYLOAD);

  assert.equal(stores.length, 3, "one tracker row per board row");
  assert.deepEqual(
    stores.map((store) => store.id).sort(),
    ["sd-bristol", "sd-loom", "sd-stratford"],
    "ids are the board's, because that is what holds the certificate",
  );

  for (const store of stores) {
    assert.equal(store.compliance.length, 12);
    assert.equal(typeof store.manager, "string");
    assert.equal(typeof store.lifecycle, "string");
  }

  // The board's group is the only lifecycle this board records.
  assert.equal(
    stores.find((store) => store.id === "sd-stratford").lifecycle,
    "Closed",
  );

  /*
   * `fileCount` was zero on all 120 seeded rows, so certificates that are
   * attached and downloadable were reported as Missing. It has to survive.
   */
  const bristol = stores.find((store) => store.id === "sd-bristol");
  const wiring = bristol.compliance.find(
    (item) => item.kind === "Electrical Wiring",
  );
  assert.equal(wiring.fileCount, 10);
  assert.equal(wiring.expiry, "2029-03-26");
});

/* ── The override that has no board column ───────────────────────────────── */

test("Not required survives a board read, on both compliance surfaces", () => {
  /*
   * The board cannot say "this store does not need a sprinkler report", so the
   * flag lives in `compliance_documents` and has to travel with the board
   * payload. Without it the tracker offered a "Not required" filter that could
   * never match, and Westfield Stratford's fire alarm read "Missing" on the tab
   * while /dashboard/compliance called it "Not required" — the same flag, two
   * answers, one tab apart.
   */
  const stores = model.buildComplianceStores(PAYLOAD);
  const stratford = stores.find((store) => store.id === "sd-stratford");
  const named = (kind) =>
    stratford.compliance.find((item) => item.kind === kind).state;

  assert.equal(named("Fire Alarm"), "Not required");
  assert.equal(named("Water Hygiene"), "Not required");
  assert.equal(named("PLI"), "Missing", "only the flagged slots are overridden");

  // The same answer from the server-side derivation.
  const derived = register.storeDocumentationRegister(rows(), {
    today: TODAY,
    notRequired: new Set([
      register.notRequiredKey("sd-stratford", "fire-alarm"),
      register.notRequiredKey("sd-stratford", "water-hygiene"),
    ]),
  });
  const store = derived.find((entry) => entry.id === "sd-stratford");
  assert.equal(documentFor(store, "Fire Alarm").state, "Not required");
  assert.equal(documentFor(store, "Water Hygiene").state, "Not required");
});

test("the board payload carries the override for this board only", async () => {
  const route = await read("app/api/board/route.ts");

  assert.match(
    route,
    /boardId === STORE_DOCUMENTATION_BOARD_ID\s*\n?\s*\?\s*await readNotRequiredSlots/,
    "the override is a compliance concept; the 744-row board must not pay for it",
  );
  assert.match(route, /notRequired,/, "and it has to reach the payload");
});

/* ── 7. The digest scans the estate, not the seed ────────────────────────── */

test("the compliance digest reads the board register", async () => {
  const digest = withoutComments(
    await read("app/api/notifications/compliance/route.ts"),
  );

  /*
   * It selected from `complianceDocuments` joined to `sites`, so its scan
   * covered the 34 seeded dates and none of the board's 42. Eleven lapsed board
   * certificates could never produce an alert because their stores have no row
   * in `sites` at all.
   */
  assert.match(digest, /readComplianceRegister/);
  assert.doesNotMatch(
    digest,
    /\.leftJoin\(sites,/,
    "joining the seeded sites table is what made the digest blind to the estate",
  );

  // "Not required" must still never alert — the Stage 7 guarantee.
  assert.match(digest, /if \(row\.notRequired\) continue;/);

  // The bookkeeping has to be keyed on board identity, or the first run repeats
  // for ever because there is no register row to write the stage onto.
  assert.match(digest, /board-\$\{itemId\}-\$\{slotKey\}/);
});

test("the digest never publishes the register entry it uses for bookkeeping", async () => {
  const digest = await read("app/api/notifications/compliance/route.ts");
  const shape = digest.slice(digest.indexOf("function forDigest"));

  /*
   * `entry` carries the board item id, the slot key and the backing
   * `compliance_documents` id. Spreading and deleting one field would publish
   * the next field somebody adds to `RegisterEntry`; the projection is explicit
   * so that cannot happen quietly.
   */
  assert.doesNotMatch(shape.slice(0, 400), /\.\.\.rest/);
  assert.doesNotMatch(shape.slice(0, 400), /entry/);
});

/* ── A date-only value is not a moment in time ───────────────────────────── */

test("an expiry date cannot shift a day on its way to the screen", () => {
  /*
   * `new Date("2026-11-24")` is midnight UTC by specification, so formatting it
   * in local time moved a certificate a day earlier for anyone west of
   * Greenwich — the difference between "expires today" and "expired yesterday"
   * on a screen whose only job is to say when things run out.
   */
  assert.equal(expiry.formatExpiryDate("2026-11-24"), "24 November 2026");
  assert.equal(expiry.formatExpiryDate("2026-01-01"), "1 January 2026");

  // The three shapes a board date column stores all normalise to the same day.
  assert.equal(expiry.dateOnlyValue("2026-11-24"), "2026-11-24");
  assert.equal(expiry.dateOnlyValue("2026-11-24T00:00:00.000Z"), "2026-11-24");
  assert.equal(expiry.dateOnlyValue('{"date":"2026-11-24"}'), "2026-11-24");

  // Anything unparseable is "no date recorded", which surfaces as an open
  // finding rather than as a pass. The safe direction.
  for (const bad of ["", null, undefined, "not a date", "{", '{"date":"soon"}']) {
    assert.equal(expiry.dateOnlyValue(bad), "");
    assert.equal(expiry.expiryStatus(bad, TODAY).state, "not-recorded");
  }
});

test("the classifier takes its today from the caller", () => {
  /*
   * Injectable so a whole board is classified against one instant instead of
   * drifting across the loop, and so this file can pin the date. A classifier
   * that reads its own clock cannot be tested and cannot be consistent.
   */
  const iso = "2026-08-10";
  assert.equal(expiry.expiryStatus(iso, new Date("2026-08-10T00:00:00Z")).state, "due-soon");
  assert.equal(expiry.expiryStatus(iso, new Date("2026-08-11T00:00:00Z")).state, "expired");
  assert.equal(
    expiry.expiryStatus(iso, new Date("2026-08-10T23:59:59Z")).daysRemaining,
    0,
    "the final valid day is zero days remaining, not minus one",
  );
});

/* ── The whole board, against the real capture ───────────────────────────── */

test("the capture's expired certificates are exactly the ones reported", async (t) => {
  /*
   * The end-to-end number, walked out of the verbatim capture rather than out
   * of the database, so it fails if the classifier stops agreeing with the
   * source of truth — whatever the importer happens to have written.
   *
   * `store-documentation-expiry.csv` is the export's own expiry sheet: four
   * group sections, each with a header row naming the nine expiry columns by
   * their monday titles. Eleven certificates across seven stores were lapsed on
   * 2026-08-10, and the compliance screens showed one, a fictional one.
   */
  /*
   * Gitignored for the reason given in the "Not published"
   * block: this repository is public and the expiry sheet is the client's live
   * register. The sheet is an operator-machine artefact, so on a clone this
   * assertion has no bytes to walk and stands down rather than failing for
   * ever. Every BEHAVIOURAL assertion in this file - that a lapsed certificate
   * is never reported valid, that state is recomputed from the date on every
   * read, that a date cannot shift a day on its way to the screen - is
   * independent of this file and still runs.
   */
  const csv = await read("db/monday-export/store-documentation-expiry.csv").catch(
    () => null,
  );
  if (csv === null) {
    t.skip("no monday expiry sheet on this machine (gitignored: client data)");
    return;
  }

  const titleByKey = new Map(
    spec.storeDocumentationColumns.map((column) => [column.key, column.title]),
  );
  /** monday's expiry column title → the requirement name the register speaks. */
  const kindByTitle = new Map(
    spec.storeDocumentationCertificates
      .filter((slot) => slot.expiryColumn)
      .map((slot) => [titleByKey.get(slot.expiryColumn), slot.label]),
  );
  assert.equal(kindByTitle.size, 9, "nine of the twelve slots carry an expiry");

  const lapsed = [];
  const stores = new Set();
  let headers = null;
  for (const line of csv.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const fields = row.split(",");
    if (fields[0] === "Name") {
      headers = fields;
      // Every group's header must name columns the spec knows, or the sheet has
      // been re-exported with different titles and this test is reading noise.
      for (const title of fields.slice(1)) {
        assert.ok(kindByTitle.has(title), `unmapped expiry column: ${title}`);
      }
      continue;
    }
    if (!headers || fields.length !== headers.length) continue;
    stores.add(fields[0]);
    for (let i = 1; i < fields.length; i += 1) {
      const iso = expiry.dateOnlyValue(fields[i]);
      if (!iso) continue;
      if (expiry.expiryStatus(iso, TODAY).state === "expired") {
        lapsed.push(`${fields[0]} · ${kindByTitle.get(headers[i])} · ${iso}`);
      }
    }
  }

  assert.equal(stores.size, 31, "the capture must hold the whole board");
  assert.equal(
    lapsed.length,
    11,
    `the board holds 11 lapsed certificates on 2026-08-10, found ${lapsed.length}:\n${lapsed.join("\n")}`,
  );
  assert.equal(
    new Set(lapsed.map((line) => line.split(" · ")[0])).size,
    7,
    "across seven stores",
  );
  assert.ok(
    lapsed.includes("HQ - The Loom · PAT Test · 2025-04-29"),
    "HQ - The Loom's PAT certificate is the headline case and must be lapsed",
  );
  assert.equal(
    lapsed.filter((line) => line.startsWith("Churchill Square")).length,
    5,
    "Churchill Square - Brighton has five lapsed certificates",
  );

  /*
   * And the one the screens DID report — store-solihull PAT 2026-07-20 — is
   * fiction. The board's Touchwood - Solihull PAT expiry is 2026-11-06, which
   * is not expired, so it must not be in this list under any name.
   */
  assert.ok(!lapsed.some((line) => /Solihull/.test(line)));
  assert.ok(!csv.includes("2026-07-20"), "that date is nowhere in the capture");
});
