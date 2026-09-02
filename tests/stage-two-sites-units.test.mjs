import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

async function collect(dir, extensions, found = []) {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) await collect(`${path}/`, extensions, found);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }
  return found;
}

const STAGE_TWO_ROUTES = [
  "app/api/sites/route.ts",
  "app/api/sites/csv/route.ts",
  "app/api/sites/groups/route.ts",
  "app/api/units/route.ts",
  "app/api/options/route.ts",
];

test("every Stage 2 route resolves an organisation-scoped database", async () => {
  for (const path of STAGE_TWO_ROUTES) {
    const source = await read(path);
    /*
     * `scopedDb(request)` OR `scopedDbWithCapability(request, …)`.
     *
     * The property under test is tenancy: this route must never choose its own
     * organisation. Both helpers satisfy it — the second calls the first and
     * then asks a capability question on top — so a route that gained a
     * capability guard has become stricter, not less scoped, and pinning the
     * literal call was pinning the wrong thing.
     */
    assert.match(
      source,
      /scopedDb\(request\)|scopedDbWithCapability\(request, "/,
      `${path} must resolve an organisation-scoped database`,
    );
    assert.doesNotMatch(source, /\bCLIENT_ID\b/, `${path} must not use a fixed client ID`);
    assert.doesNotMatch(source, /sunnamusk/i, `${path} must not name a specific tenant`);
  }
});

test("every Stage 2 route filters its reads and writes by organisation", async () => {
  for (const path of STAGE_TWO_ROUTES) {
    const source = await read(path);
    assert.match(
      source,
      /organisationId,\s*orgId\)|organisationId:\s*orgId/,
      `${path} must constrain queries to the resolved organisation`,
    );
  }
});

/**
 * M12 — the configurability guard.
 *
 * This is the test that stops the platform sliding back into the restriction it
 * exists to remove. A status, priority, site type or document type reintroduced
 * as a TypeScript constant means an admin needs a developer again.
 */
test("no configurable list has reappeared as a code constant", async () => {
  const files = await collect("app/", [".ts", ".tsx"]);
  const forbidden = [
    { pattern: /type\s+Priority\s*=\s*["']/, why: "Priority must be a string validated against the database" },
    { pattern: /type\s+\w*Status\w*\s*=\s*["'][^"']+["']\s*\|/, why: "Statuses are option_values rows, not a union" },
    { pattern: /enum\s+DocumentType\b/, why: "Document types are rows in document_types" },
    { pattern: /const\s+\w*STATUSES\w*\s*=\s*\[/, why: "Status lists live in the database" },
    { pattern: /export\s+const\s+locations\s*=/, why: "The site list comes from the sites table" },
    { pattern: /fireAlarm(File|Expiry)/i, why: "Per-document columns are the monday anti-pattern" },
  ];

  for (const path of files) {
    const source = await read(path);
    for (const rule of forbidden) {
      assert.doesNotMatch(source, rule.pattern, `${path}: ${rule.why}`);
    }
  }
});

/**
 * M12, SECOND HALF — the form the first half could not see.
 *
 * The guard above looks for a configurable list reintroduced as a NAMED
 * constant. It has never caught the shape this codebase actually reaches for,
 * which is the list written inline at the point of use:
 *
 *     { key: "type", label: "Type", type: "select",
 *       options: ["Kiosk", "Inline", "Office", "Warehouse"].map(...) }
 *
 * That is the same defect with no identifier to match on. It was live on the
 * Manage-data drawer's Sites tab for site TYPE and site LIFECYCLE while
 * `POST /api/sites` validated the very same columns against
 * `option_values` — so two screens editing one column disagreed about
 * what its legal values are, and a type an admin added in Settings could be
 * used on one of them and not the other.
 *
 * WHY AN ALLOWLIST RATHER THAN A BARE REFUSAL. Six of these remain and they
 * belong to registers this pass does not own — the compliance state ladder, the
 * unit and planned status lists, contractor availability, the role list. Making
 * them fail today would leave the suite red for work nobody has started, and a
 * red suite teaches people to ignore it. Naming them instead does three useful
 * things at once: a NEW inline list fails immediately, a fixed one fails until
 * it is struck off this list, and the debt is written down where somebody will
 * read it rather than in a ticket. The site entries are absent because they are
 * gone; they can never come back without failing here.
 */
const INLINE_OPTION_LIST = /options:\s*\[\s*["'][^\]]*\]\s*\.map\(/g;

/**
 * Every inline option list the codebase still has, by file and by first value.
 * Anything not on this list is new and must come from the options registry.
 */
const KNOWN_INLINE_OPTION_LISTS = [
  // The five compliance states. A closed vocabulary the whole product speaks —
  // COMPLIANCE_STATES in app/lib/types.ts — but restated here rather than
  // imported from it.
  ["app/(app)/portal/workspace-data-manager.tsx", '"Compliant"'],
  // Unit status. `unit_status` IS a seeded option_values key.
  ["app/(app)/portal/workspace-data-manager.tsx", '"Active"'],
  // Contractor availability, owned by the contractor register.
  ["app/(app)/portal/workspace-data-manager.tsx", '"Available"'],
  // Planned maintenance frequency and status.
  ["app/(app)/portal/workspace-data-manager.tsx", '"One-off"'],
  ["app/(app)/portal/workspace-data-manager.tsx", '"Scheduled"'],
  // The three workspace roles, which are a permissions concept rather than an
  // admin-editable list.
  ["app/(app)/portal/workspace-data-manager.tsx", '"Super Admin"'],
];

test("no configurable list has reappeared as an inline literal option list", async () => {
  const files = await collect("app/", [".ts", ".tsx"]);
  const seen = [];
  for (const path of files) {
    const source = await read(path);
    for (const match of source.matchAll(INLINE_OPTION_LIST)) {
      const first = match[0].slice(match[0].indexOf("["));
      seen.push([path, first.slice(first.indexOf('"') >= 0 ? first.indexOf('"') : 0).match(/["'][^"']*["']/)?.[0] ?? first]);
    }
  }

  for (const [path, first] of seen) {
    assert.ok(
      KNOWN_INLINE_OPTION_LISTS.some(([file, value]) => file === path && value === first),
      `${path}: options starting ${first} are written inline instead of read from option_values. Add the list to the options registry, or name it in KNOWN_INLINE_OPTION_LISTS with the reason.`,
    );
  }

  /*
   * And the other direction: a list that has been fixed must be struck off,
   * so this cannot quietly become a permanent exemption.
   */
  for (const [file, value] of KNOWN_INLINE_OPTION_LISTS) {
    assert.ok(
      seen.some(([path, first]) => path === file && first === value),
      `${file}: the inline list starting ${value} is gone — remove it from KNOWN_INLINE_OPTION_LISTS.`,
    );
  }

  /*
   * THE SITE FIELDS, NAMED. These three are the reason this test exists and
   * they are the ones a regression would most plausibly restore, because the
   * drawer's other tabs still have theirs.
   */
  const drawer = await read("app/(app)/portal/workspace-data-manager.tsx");
  for (const gone of [
    ['"Kiosk", "Inline", "Office", "Warehouse"', "site types are option_values rows"],
    ['"UK", "Europe", "Other"', "region is free text; there is no site_region list to hardcode"],
    ['"Current", "Closed"', "the lifecycle words have one home, app/lib/site-state.ts"],
  ]) {
    assert.ok(
      !drawer.includes(`[${gone[0]}]`),
      `the Sites tab must not restate [${gone[0]}] — ${gone[1]}`,
    );
  }
});

test("site attributes are runtime strings, not literal unions", async () => {
  const types = await read("app/lib/types.ts");
  const store = types.slice(types.indexOf("export interface StoreRecord"));
  const body = store.slice(0, store.indexOf("}"));
  for (const field of ["type", "region", "lifecycle", "status"]) {
    assert.match(
      body,
      new RegExp(`${field}:\\s*string;`),
      `StoreRecord.${field} must be string so admins can add values`,
    );
  }
});

test("the seed array is reachable only from provisioning code", async () => {
  const files = await collect("app/", [".ts", ".tsx"]);
  for (const path of files) {
    const source = await read(path);
    if (!/seed-options/.test(source)) continue;

    // A component must never see seed data — it renders what the admin
    // configured, which only the database knows.
    assert.ok(
      !path.endsWith(".tsx"),
      `${path} is a component and must read options from the API, not the seed`,
    );
    // Anywhere else, the seed may only be written, never read back to
    // validate, filter or label a value.
    assert.match(
      source,
      /\.insert\(/,
      `${path} imports the seed but never inserts it — seeds are for provisioning only`,
    );
    assert.doesNotMatch(
      source,
      /defaultBoardOptions\s*\.\s*(find|filter|some|map)\(/,
      `${path} must not read the seed at runtime`,
    );
  }
  // And the file this replaced must stay gone.
  await assert.rejects(read("app/lib/board-options.ts"));
});

test("the Stage 2 migration is additive and covers every new structure", async () => {
  const migration = await read("drizzle/0007_stage_two_sites_units.sql");

  // Nothing destructive may reach a live database holding compliance records.
  assert.doesNotMatch(migration, /DROP\s+TABLE/i, "migrations must not drop tables");
  assert.doesNotMatch(migration, /DROP\s+COLUMN/i, "migrations must not drop columns");
  assert.doesNotMatch(migration, /DELETE\s+FROM/i, "migrations must not delete rows");

  for (const table of [
    "site_aliases",
    "site_groups",
    "site_group_members",
    "unit_service_records",
    "import_anomalies",
  ]) {
    assert.match(
      migration,
      new RegExp("CREATE TABLE IF NOT EXISTS `" + table + "`"),
      `${table} must be created`,
    );
  }

  for (const column of [
    "access_method",
    "access_contact",
    "access_url",
    "access_notes",
    "monday_maintenance_name",
    "monday_compliance_name",
    "service_charge_pence",
    "lease_end",
  ]) {
    assert.match(
      migration,
      new RegExp("ALTER TABLE `sites` ADD `" + column + "`"),
      `sites.${column} must be added`,
    );
  }

  assert.match(migration, /ALTER TABLE `units` ADD `warranty_expiry`/);
  assert.match(migration, /ALTER TABLE `units` ADD `next_service_due_at`/);
});

test("the runtime compatibility path mirrors the Stage 2 migration", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /ensureStageTwoFoundation/);
  for (const table of ["site_aliases", "site_groups", "unit_service_records", "import_anomalies"]) {
    assert.match(init, new RegExp("CREATE TABLE IF NOT EXISTS " + table));
  }
});

test("money is stored in pence and never as a float", async () => {
  for (const path of ["app/api/sites/route.ts", "app/api/units/route.ts"]) {
    const source = await read(path);
    assert.match(source, /Math\.round\(parsed \* 100\)/, `${path} must convert pounds to pence`);
  }
  const schema = await read("db/schema.ts");
  assert.match(schema, /serviceChargePence: integer\("service_charge_pence"\)/);
  assert.match(schema, /purchasePricePence: integer\("purchase_price_pence"\)/);
});

test("import corrections are recorded rather than applied silently", async () => {
  const csv = await read("app/api/sites/csv/route.ts");
  assert.match(csv, /recordAnomaly/, "address cleanups must be logged");
  assert.match(csv, /junkReason/, "placeholder rows must be rejected and reported");
  assert.match(csv, /dryRun/, "an import must be previewable before it commits");
});

test("site names reconcile across both monday boards", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  assert.match(repository, /normaliseSiteName/);
  assert.match(repository, /mondayMaintenanceName/);
  assert.match(repository, /mondayComplianceName/);
  assert.match(repository, /siteAliases/);
});

test("the compliance register tracks every Store Documentation requirement", async () => {
  // The register carried five ad-hoc requirement names against a board that
  // tracks twelve. PLI, fire extinguishers, sprinklers, fire doors, RAMS, the
  // fire risk assessment and the store drawing had nowhere to be recorded.
  const spec = await read("db/monday-board-spec.ts");
  const block = spec.slice(
    spec.indexOf("export const storeDocumentationCertificates"),
    spec.indexOf("/** Requirement names, in board order"),
  );
  const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
  assert.equal(labels.length, 12, "the board carries twelve document slots");
  for (const required of ["RAMS", "Fire Risk Assessment", "PLI", "Sprinkler", "Drawing"]) {
    assert.ok(labels.includes(required), `${required} must be tracked`);
  }

  // Three slots have no expiry date on monday. Marking them keeps the tracker
  // from demanding a date the board never asks for.
  const undated = [...block.matchAll(/expiryColumn: null/g)].length;
  assert.equal(undated, 3, "RAMS, the fire risk assessment and the drawing carry no expiry");
});

test("every site is seeded with the full requirement set", async () => {
  const seed = await read("app/lib/mock-data.ts");
  assert.match(
    seed,
    /for \(const store of stores\)[\s\S]{0,400}storeDocumentationKinds/,
    "each store must be filled out to the full requirement set",
  );
  // A requirement that is not held must be visibly Missing, not simply absent.
  assert.match(seed, /store\.compliance\.push\(missing\(kind\)\)/);
});

test("requirement names are normalised onto one vocabulary", async () => {
  const init = await read("db/init.ts");
  const fn = init.slice(init.indexOf("async function renameComplianceKinds"));
  for (const legacy of ["PAT", "Fire alarm", "Emergency lighting", "Water hygiene"]) {
    assert.ok(fn.includes(`"${legacy}"`), `${legacy} must be renamed, not left as a duplicate`);
  }
  // Renaming must not collide with a row the site already holds.
  assert.match(fn, /NOT EXISTS/, "a rename must skip where the target already exists");

  const seed = await read("app/lib/mock-data.ts");
  for (const legacy of ['"PAT"', '"Fire alarm"', '"Emergency lighting"', '"Water hygiene"']) {
    assert.ok(!seed.includes(legacy), `the seed must not reintroduce ${legacy}`);
  }
});

test("seeded sites carry their Stage 2 fields", async () => {
  // `ensureDatabase()` backfills manager_name from manager, but it finishes
  // before this lazy seed inserts anything — so seeded sites were left with a
  // null manager_name and the Sites screen showed a dash for every store.
  const source = await read("app/api/workspace/route.ts");
  const insert = source.slice(source.indexOf("await db.insert(sites).values("));
  for (const field of ["slug:", "siteTypeValue:", "addressLine1:", "managerName:", "status:"]) {
    assert.ok(insert.slice(0, 900).includes(field), `${field} must be written at insert`);
  }
});

test("the Store Documentation groups are derived, not hand-maintained", async () => {
  const init = await read("db/init.ts");
  const fn = init.slice(init.indexOf("export async function seedStoreDocumentationGroups"));
  for (const name of ["Current stores", "Europe", "Closed", "Other"]) {
    assert.ok(fn.includes(`"${name}"`), `${name} must be one of the board's four groups`);
  }
  // Membership is rebuilt so a closed or relocated store changes group.
  assert.match(fn, /DELETE FROM site_group_members WHERE site_group_id = \?/);
});
