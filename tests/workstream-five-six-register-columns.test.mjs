import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * WORKSTREAM 5/6 — the shared configurable register.
 *
 * W05-01 and W06-11 ask for the same thing on two screens: the Sites register
 * and the Contractors register must let somebody reorder their columns, rename
 * them, show and hide them and resize them. W05-08 asks that they be able to
 * ADD a column of their own and fill it in per site. This file holds one
 * implementation to account for all three, because there is one implementation
 * — `app/lib/register-columns.ts`, `/api/registers` — discriminated by
 * `register_key` rather than duplicated per register.
 *
 * THE INVARIANT THESE TESTS EXIST FOR. A register column is either NATIVE (a
 * view onto a real typed field on `sites` / `contractors`) or CUSTOM (somebody
 * added it). A native column's value lives on the entity row and is NEVER
 * copied into `register_values`. Two stores for one fact is two answers to one
 * question, and they would diverge the first time anybody edited a site through
 * the ordinary form with nothing marking either copy as the wrong one. Three
 * tests below hold that line from three directions: the route refuses a native
 * key, the source says why, and the database is read afterwards to confirm no
 * such row exists.
 *
 * Source assertions run everywhere. The behavioural tests need a dev server and
 * skip without one, which is the bargain the rest of this suite already makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 5176, 5177, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `ZZQA-W56-REGISTER-${Date.now().toString(36)}`;

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/registers?register=sites`, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        BASE_URL = candidate;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  return false;
}

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function call(method, path, body, headers = {}) {
  await signIn();
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: cookie ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/**
 * The same call made by somebody else, through the testing identity switcher.
 *
 * No session cookie: a live session outranks the header, so sending both would
 * test the owner twice. `client@…` holds `board.view` and `data.export` and
 * nothing else; `admin@demo-client-ltd…` holds `board.edit` in the OTHER
 * organisation, which is what makes it the right caller for the cross-tenant
 * test — it is refused by the organisation filter rather than by the capability
 * check, which is the thing being proved.
 */
async function callAs(identity, method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-maintsupp-identity": identity,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

const CLIENT_IDENTITY = "client@demo-client-ltd.test.maintsupp.com";
const OTHER_ADMIN_IDENTITY = "admin@demo-client-ltd.test.maintsupp.com";

/**
 * The development database, opened once.
 *
 * Read directly rather than through the API for the two things the API cannot
 * say: that `register_values` holds no row for a native column, and what a
 * column looked like before this file changed it.
 */
async function openDevDatabase(readOnly) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly });
    // The dev server holds this file open, so an unqualified write loses the
    // race and throws "database is locked". Wait for the writer.
    if (!readOnly) db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

/**
 * Every column this file is about to change, as it was before.
 *
 * Restored by exact primary key in `after()`. This suite runs against a shared
 * development database that other work is using; a register left renamed and
 * reordered would be residue, and residue in a register is somebody else's
 * confusing afternoon.
 */
const restorePoints = new Map();
/** Ids of columns this file CREATED. The only rows it may delete. */
const createdColumnIds = [];
/** Cells this file wrote, by their exact composite key. */
const writtenCells = [];

async function snapshotRegister(register) {
  const db = await openDevDatabase(true);
  if (!db) return;
  try {
    const rows = db
      .prepare(
        `SELECT id, title, width, position, hidden_at, deleted_at
           FROM register_columns
          WHERE organisation_id = ? AND register_key = ?`,
      )
      .all(PRIMARY_ORGANISATION_ID, register);
    for (const row of rows) {
      if (!restorePoints.has(row.id)) restorePoints.set(row.id, row);
    }
  } finally {
    db.close();
  }
}

after(async () => {
  if (restorePoints.size === 0 && createdColumnIds.length === 0) return;
  const db = await openDevDatabase(false);
  if (!db) {
    console.warn("fixture cleanup could not open the development database");
    return;
  }
  try {
    // Fixtures first, by EXACT primary key. Never a substring sweep — this
    // repository's notes record those repeatedly eating other agents' rows.
    for (const cell of writtenCells) {
      db.prepare(
        `DELETE FROM register_values
          WHERE organisation_id = ? AND register_key = ? AND entity_id = ? AND column_key = ?`,
      ).run(cell.orgId, cell.register, cell.entityId, cell.columnKey);
    }
    for (const id of createdColumnIds) {
      db.prepare("DELETE FROM register_columns WHERE id = ?").run(id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }
    // Then put every column this file touched back exactly as it was.
    for (const [id, row] of restorePoints) {
      if (createdColumnIds.includes(id)) continue;
      db.prepare(
        `UPDATE register_columns
            SET title = ?, width = ?, position = ?, hidden_at = ?, deleted_at = ?
          WHERE id = ?`,
      ).run(row.title, row.width, row.position, row.hidden_at, row.deleted_at, id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});

// ---------------------------------------------------------------------------
// Source assertions — the shape of the thing, checked without a server
// ---------------------------------------------------------------------------

test("W05-01/W06-11 one engine serves both registers rather than two implementations", async () => {
  const engine = await read("app/lib/register-columns.ts");
  const catalogue = await read("app/lib/register-catalogue.ts");
  const route = await read("app/api/registers/route.ts");

  // The discriminator, not a table per register.
  assert.match(catalogue, /export const REGISTER_KEYS = \["sites", "contractors"\] as const;/);
  assert.match(engine, /register: RegisterKey/, "every engine function takes the register");
  assert.match(route, /function readRegister\(value: unknown\)/, "one place decides which register");

  // Both catalogues come from the same shape and the same loader.
  assert.match(catalogue, /export const SITE_NATIVE_COLUMNS: readonly NativeColumnSeed\[\]/);
  assert.match(catalogue, /export const CONTRACTOR_NATIVE_COLUMNS: readonly NativeColumnSeed\[\]/);
  assert.match(catalogue, /export function nativeCatalogue\(register: RegisterKey\)/);

  // And there is no second route. A sites-only or contractors-only column API
  // would be the first step back to two implementations.
  const files = await readdir(new URL("../app/api/registers/", import.meta.url));
  assert.deepEqual(files.sort(), ["route.ts", "values"], "one route plus its values endpoint");
});

test("W05-01/W06-11 the native catalogue never exposes a row's machinery", async () => {
  const catalogue = await read("app/lib/register-catalogue.ts");

  /*
   * `id`, `organisation_id`, `client_id`, `slug`, `created_at` and `updated_at`
   * are what make a row addressable, not facts about a site or a contractor.
   * `position` is the register's own row ordering, and a column that reorders
   * the thing displaying it is a loop. A register that offered any of them
   * would be offering to break itself.
   */
  assert.match(catalogue, /export const EXCLUDED_NATIVE_FIELDS = \[/);
  const excluded = catalogue
    .slice(catalogue.indexOf("EXCLUDED_NATIVE_FIELDS = ["), catalogue.indexOf("] as const;\n\n/**\n * SITES"))
    .match(/"([a-zA-Z]+)"/g)
    .map((entry) => entry.replaceAll('"', ""));
  for (const field of ["id", "organisationId", "legacyClientId", "slug", "position", "createdAt", "updatedAt"]) {
    assert.ok(excluded.includes(field), `${field} must be excluded`);
  }

  const seeded = [...catalogue.matchAll(/\{ field: "([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
  assert.ok(seeded.length >= 60, `both catalogues are seeded, saw ${seeded.length} fields`);
  for (const field of excluded) {
    assert.ok(!seeded.includes(field), `${field} must not be a register column`);
  }
});

test("W05-01/W06-11 the register's flags are timestamps the Postgres shim cannot mis-rewrite", async () => {
  const engine = await read("app/lib/register-columns.ts");
  const schema = await read("db/schema.ts");
  const shim = await read("db/sqlite-to-postgres.ts");

  /*
   * `db/sqlite-to-postgres.ts` rewrites `WHERE visible = 1` to
   * `WHERE visible = true` on the strength of the column NAME alone. `visible`
   * is already in that set from `maintenance_board_columns`, so an INTEGER
   * column of that name on this new table would be silently wrong on deployed
   * Postgres while passing locally on SQLite. Hence nullable timestamps.
   */
  assert.match(shim, /BOOLEAN_COLUMN_NAMES/, "the bare-name rewrite rule still exists");
  const registerBlock = schema.slice(
    schema.indexOf("export const registerColumns"),
    schema.indexOf("export const registerValues"),
  );
  assert.match(registerBlock, /hiddenAt: text\("hidden_at"\)/);
  assert.match(registerBlock, /deletedAt: text\("deleted_at"\)/);
  assert.ok(
    !/visible|hidden: integer|deleted: integer/.test(registerBlock),
    "no boolean-named flag on register_columns",
  );
  assert.match(
    engine,
    /hidden: row\.hiddenAt !== null/,
    "the wire boolean is derived from the timestamp, not stored",
  );
  assert.match(
    engine,
    /native: row\.nativeField !== null/,
    "native is derived from the field, not a second flag to keep in step",
  );
});

test("W05-01/W05-08 structural writes ask for board.edit and value writes ask for sites.edit", async () => {
  const route = await read("app/api/registers/route.ts");
  const values = await read("app/api/registers/values/route.ts");
  const permissions = await read("app/lib/permissions.ts");

  /*
   * EXISTING capabilities, deliberately. A new key would be a key nobody has
   * seeded into a role, which is a key nobody holds — the owner would have been
   * locked out of their own register until Roles was edited.
   */
  assert.match(permissions, /key: "board\.edit"/, "board.edit is a real capability");
  assert.match(permissions, /key: "sites\.edit"/, "sites.edit is a real capability");

  for (const verb of ["POST", "PATCH", "DELETE"]) {
    const body = route.slice(route.indexOf(`export async function ${verb}(`));
    assert.match(
      body.slice(0, 400),
      /scopedDbWithCapability\(request, "board\.edit"\)/,
      `${verb} /api/registers is gated on board.edit`,
    );
  }
  assert.match(values, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.ok(
    !/scopedDbWithCapability\(request, "board\.edit"\)/.test(values),
    "editing a cell must not require the capability that rearranges the register",
  );
});

test("W05-08 a native value is never written into register_values", async () => {
  const engine = await read("app/lib/register-columns.ts");
  const values = await read("app/api/registers/values/route.ts");

  // The refusal itself, before any write.
  assert.match(values, /if \(column\.nativeField !== null\) \{/);
  assert.match(values, /is a built-in field\. Change it on the/);
  const refusalAt = values.indexOf("column.nativeField !== null");
  const insertAt = values.indexOf(".insert(registerValues)");
  assert.ok(refusalAt > 0 && insertAt > refusalAt, "the refusal precedes the insert");

  /*
   * And nothing else writes that table. `/api/registers/values` is the only
   * writer in the codebase, which is what makes the refusal above sufficient
   * rather than merely one of several places to remember.
   */
  assert.match(engine, /export async function loadRegisterValues\(/, "the engine only reads");
  assert.ok(
    !/\.insert\(registerValues\)|\.update\(registerValues\)/.test(engine),
    "the engine must not write register_values",
  );
});

test("W05-01/W05-08/W06-11 the browser reads a native cell from the entity, not from register_values", async () => {
  const client = await read("app/(app)/portal/register/register-client.ts");

  /*
   * Native and custom columns are drawn side by side and look identical, so a
   * grid that reaches into `values` for all of them renders every native column
   * blank — which looks like missing data rather than like a bug. One reader
   * decides which source a cell comes from, and every screen mounts it.
   */
  assert.match(client, /export function registerCellValue\(/, "one reader");
  const reader = client.slice(client.indexOf("export function registerCellValue("));
  assert.match(reader.slice(0, 600), /if \(column\.native\) \{[\s\S]*entity\?\.\[column\.nativeField/);
  assert.match(reader.slice(0, 900), /return values\[entityId\]\?\.\[column\.key\] \?\? null;/);

  // And the writer refuses a native column in the browser, so the mistake is
  // caught where somebody can see it rather than as a 400 in a network tab.
  assert.match(client, /export async function writeRegisterCell\(/);
  const writer = client.slice(client.indexOf("export async function writeRegisterCell("));
  const refusalAt = writer.indexOf("if (column.native)");
  const sendAt = writer.indexOf('"/api/registers/values"');
  assert.ok(refusalAt > 0 && sendAt > refusalAt, "the browser refuses before it posts");

  // The verbs Wave 2 mounts. Named here so a rename has to come through this
  // test rather than quietly breaking whichever screen imported them.
  for (const verb of [
    "fetchRegister",
    "addRegisterColumn",
    "renameRegisterColumn",
    "resizeRegisterColumn",
    "setRegisterColumnHidden",
    "reorderRegisterColumns",
    "removeRegisterColumn",
    "restoreRegisterColumn",
    "visibleColumns",
    "orderAfterMove",
  ]) {
    assert.match(client, new RegExp(`export (async )?function ${verb}\\(`), `${verb} is exported`);
  }
});

test("W05-01/W06-11 a cross-tenant id is answered 404 before anything is written", async () => {
  const engine = await read("app/lib/register-columns.ts");
  const route = await read("app/api/registers/route.ts");
  const values = await read("app/api/registers/values/route.ts");

  /*
   * The organisation filter is part of the WHERE rather than a check on the row
   * afterwards, so another tenant's id and an id that never existed are the
   * same answer. Telling them apart would tell a caller which ids exist inside
   * a workspace they may not read — the reasoning `contractorTarget` in
   * `app/api/workspace/route.ts` sets out at length.
   */
  const finder = engine.slice(engine.indexOf("export async function findRegisterColumn("));
  assert.match(finder.slice(0, 800), /eq\(registerColumns\.organisationId, orgId\)/);
  assert.match(route, /"That column does not exist\."/);
  assert.match(route, /\{ status: 404 \}/);

  // And a value cannot be written against an entity of another tenant's.
  assert.match(engine, /export async function registerEntityExists\(/);
  const guardAt = values.indexOf("registerEntityExists(");
  assert.ok(guardAt > 0 && values.indexOf(".insert(registerValues)") > guardAt);
});

// ---------------------------------------------------------------------------
// Behaviour — against the running development server
// ---------------------------------------------------------------------------

test("W05-01/W06-11 the native catalogue seeds once, for both registers", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");
  await snapshotRegister("contractors");

  const first = await call("GET", "/api/registers?register=sites");
  assert.equal(first.status, 200);
  assert.ok(first.body.columns.length >= 40, `sites seeds its catalogue, saw ${first.body.columns.length}`);
  assert.ok(
    first.body.columns.filter((column) => column.native).length >= 40,
    "every seeded column is a view onto a real field",
  );

  /*
   * IDEMPOTENT, because this runs on a READ path that every page load hits. A
   * check-then-insert would produce a second catalogue under concurrency; the
   * seed is `onConflictDoNothing` against the unique key instead.
   */
  const second = await call("GET", "/api/registers?register=sites");
  assert.equal(
    second.body.columns.length,
    first.body.columns.length,
    "a second read must not duplicate the catalogue",
  );
  assert.deepEqual(
    second.body.columns.map((column) => column.key),
    first.body.columns.map((column) => column.key),
  );

  const contractors = await call("GET", "/api/registers?register=contractors");
  assert.equal(contractors.status, 200);
  assert.ok(contractors.body.columns.length >= 25, "contractors seeds its own catalogue");
  assert.ok(
    contractors.body.columns.every((column) => column.register === "contractors"),
    "the two registers do not bleed into each other",
  );

  // A register nobody defined is refused rather than defaulted to sites.
  const unknown = await call("GET", "/api/registers?register=widgets");
  assert.equal(unknown.status, 400);
});

test("W05-01/W06-11 a native column can be renamed, hidden, shown and resized", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");
  const listed = await call("GET", "/api/registers?register=sites");
  const native = listed.body.columns.find((column) => column.key === "postcode");
  assert.ok(native?.native, "postcode is a native site column");

  /*
   * A RENAME CHANGES THE LABEL AND NOTHING ELSE. That is the whole point of the
   * split: "Store" can become "Branch" on the register while `sites.name` and
   * every join, import and screen that reads it carry on unchanged.
   */
  const renamed = await call("PATCH", "/api/registers", { id: native.id, title: `${RUN} Post code` });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.column.title, `${RUN} Post code`);
  assert.equal(renamed.body.column.key, "postcode", "the key is untouched by a rename");
  assert.equal(renamed.body.column.nativeField, "postcode", "the field is untouched by a rename");

  const hidden = await call("PATCH", "/api/registers", { id: native.id, hidden: true });
  assert.equal(hidden.body.column.hidden, true);

  /*
   * A HIDDEN COLUMN IS STILL RETURNED, carrying the flag. A "show hidden"
   * control cannot offer to restore a column it was never told about.
   */
  const withHidden = await call("GET", "/api/registers?register=sites");
  const stillListed = withHidden.body.columns.find((column) => column.id === native.id);
  assert.equal(stillListed?.hidden, true, "hidden columns stay in the list, flagged");

  const shown = await call("PATCH", "/api/registers", { id: native.id, hidden: false });
  assert.equal(shown.body.column.hidden, false);

  // Clamped rather than refused: a drag that overshoots should stop, not fail.
  const wide = await call("PATCH", "/api/registers", { id: native.id, width: 99999 });
  assert.equal(wide.body.column.width, 640);
  const narrow = await call("PATCH", "/api/registers", { id: native.id, width: -10 });
  assert.equal(narrow.body.column.width, 60);
});

test("W05-01/W06-11 a native column cannot be deleted and is told to hide instead", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");
  await snapshotRegister("contractors");

  for (const [register, key] of [
    ["sites", "postcode"],
    ["contractors", "dayRatePence"],
  ]) {
    const listed = await call("GET", `/api/registers?register=${register}`);
    const native = listed.body.columns.find((column) => column.key === key);
    assert.ok(native?.native, `${key} is native on ${register}`);

    const refused = await call("DELETE", `/api/registers?id=${native.id}`);
    /*
     * "Remove this column" and "stop showing me this column" are the same
     * sentence in a person's head, so the refusal carries the instruction. A
     * bare 409 would leave somebody hunting for a Hide they had already found.
     */
    assert.equal(refused.status, 409, `${register}.${key} must refuse deletion`);
    assert.equal(refused.body.error, "Native columns cannot be deleted. Hide it instead.");

    // And it is still there, unchanged.
    const after = await call("GET", `/api/registers?register=${register}`);
    assert.ok(after.body.columns.some((column) => column.id === native.id));
  }
});

test("W05-08 a custom column can be added, renamed, reordered, hidden and removed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");

  const created = await call("POST", "/api/registers", {
    register: "sites",
    title: `${RUN} Fire door count`,
    type: "number",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const column = created.body.column;
  createdColumnIds.push(column.id);
  assert.equal(column.native, false, "a column somebody added has no field behind it");
  assert.equal(column.nativeField, null);
  assert.match(column.key, /^[a-z0-9_]+$/, "the server generates the key, not the client");

  // The key is a namespace, and the unique index is what holds it. A second
  // column of the same name is refused rather than silently shadowing.
  const duplicate = await call("POST", "/api/registers", {
    register: "sites",
    title: `${RUN} Fire door count`,
  });
  assert.equal(duplicate.status, 409);

  // A type this register cannot honour is refused rather than substituted:
  // handing somebody who asked for a rating a text box is worse than saying no.
  const unsupported = await call("POST", "/api/registers", {
    register: "sites",
    title: `${RUN} Formula`,
    type: "formula",
  });
  assert.equal(unsupported.status, 400);

  const renamed = await call("PATCH", "/api/registers", {
    id: column.id,
    title: `${RUN} Fire doors`,
  });
  assert.equal(renamed.body.column.title, `${RUN} Fire doors`);
  assert.equal(renamed.body.column.key, column.key, "a rename never moves the key");

  const hidden = await call("PATCH", "/api/registers", { id: column.id, hidden: true });
  assert.equal(hidden.body.column.hidden, true);
  await call("PATCH", "/api/registers", { id: column.id, hidden: false });

  /*
   * SOFT, AND THE VALUES STAY. Deleting the cells here would make the column
   * recoverable and its contents not, which is the worst of the three available
   * answers — the same reasoning the board applies to a deleted column's
   * attachments.
   */
  const removed = await call("DELETE", `/api/registers?id=${column.id}`);
  assert.equal(removed.status, 200);
  const afterDelete = await call("GET", "/api/registers?register=sites");
  assert.ok(
    !afterDelete.body.columns.some((entry) => entry.id === column.id),
    "a removed column is gone from the register",
  );
  assert.ok(
    afterDelete.body.columns.length >= 40,
    "removing a custom column must not reseed the native catalogue",
  );

  const restored = await call("PATCH", "/api/registers", { id: column.id, restore: true });
  assert.equal(restored.status, 200, "a removed column can be brought back");
  assert.equal(restored.body.column.id, column.id);
});

test("W05-08 a custom value round-trips per entity and a native key is refused", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");

  const created = await call("POST", "/api/registers", {
    register: "sites",
    title: `${RUN} Alarm code note`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const column = created.body.column;
  createdColumnIds.push(column.id);

  const sites = await call("GET", "/api/sites");
  const rows = Array.isArray(sites.body.sites) ? sites.body.sites : sites.body;
  assert.ok(Array.isArray(rows) && rows.length >= 2, "two sites to tell apart");
  const [first, second] = rows;

  const wrote = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: first.id,
    columnKey: column.key,
    value: `${RUN}-first`,
  });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  writtenCells.push({
    orgId: PRIMARY_ORGANISATION_ID,
    register: "sites",
    entityId: first.id,
    columnKey: column.key,
  });

  const readBack = await call("GET", "/api/registers?register=sites");
  assert.equal(readBack.body.values?.[first.id]?.[column.key], `${RUN}-first`);
  assert.equal(
    readBack.body.values?.[second.id]?.[column.key],
    undefined,
    "a value belongs to one entity, not to the register",
  );

  // Written twice is updated, not duplicated — the unique cell index and an
  // upsert, rather than select-then-insert losing a race.
  const again = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: first.id,
    columnKey: column.key,
    value: `${RUN}-second`,
  });
  assert.equal(again.status, 200);
  const updated = await call("GET", "/api/registers?register=sites");
  assert.equal(updated.body.values[first.id][column.key], `${RUN}-second`);

  /*
   * THE REFUSAL THIS ROUTE EXISTS FOR. A native key would put a second copy of
   * the site's postcode in `register_values`, and the two would diverge the
   * first time anybody edited the site through the ordinary form.
   */
  const nativeWrite = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: first.id,
    columnKey: "postcode",
    value: "ZZ1 1ZZ",
  });
  assert.equal(nativeWrite.status, 400);
  assert.match(nativeWrite.body.error, /built-in field/);

  // An entity that does not exist — or belongs to another tenant — is refused
  // BEFORE anything is written, and answered 404 rather than 403.
  const unknownEntity = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: "site-that-does-not-exist",
    columnKey: column.key,
    value: "x",
  });
  assert.equal(unknownEntity.status, 404);

  // An ABSENT value is not a cleared one: a body with no `value` is a client
  // bug, and clearing the cell on the strength of it would delete data.
  const missing = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: first.id,
    columnKey: column.key,
  });
  assert.equal(missing.status, 400);

  const cleared = await call("PATCH", "/api/registers/values", {
    register: "sites",
    entityId: first.id,
    columnKey: column.key,
    value: null,
  });
  assert.equal(cleared.status, 200);
  const empty = await call("GET", "/api/registers?register=sites");
  assert.equal(empty.body.values?.[first.id]?.[column.key], undefined, "a cleared cell is absent");
});

test("W05-08 the invariant: no native column's value is ever stored in register_values", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");

  const sites = await call("GET", "/api/sites");
  const rows = Array.isArray(sites.body.sites) ? sites.body.sites : sites.body;
  const site = rows[0];

  /*
   * Native keys from BOTH registers pushed at the cell writer. A sample rather
   * than all sixty-five, because the definitive check is the database query
   * below — the API attempts are here to prove the refusal is a property of the
   * route rather than of one hand-guarded field.
   */
  for (const register of ["sites", "contractors"]) {
    const listed = await call("GET", `/api/registers?register=${register}`);
    for (const column of listed.body.columns.filter((entry) => entry.native).slice(0, 5)) {
      const attempt = await call("PATCH", "/api/registers/values", {
        register,
        entityId: site.id,
        columnKey: column.key,
        value: `${RUN}-should-never-land`,
      });
      assert.notEqual(attempt.status, 200, `${register}.${column.key} must not accept a value here`);
    }
  }

  const db = await openDevDatabase(true);
  if (!db) {
    t.diagnostic("no development database to read; the API refusals above still hold");
    return;
  }
  try {
    const offending = db
      .prepare(
        `SELECT v.register_key, v.column_key, v.entity_id
           FROM register_values v
           JOIN register_columns c
             ON c.organisation_id = v.organisation_id
            AND c.register_key = v.register_key
            AND c.column_key = v.column_key
          WHERE c.native_field IS NOT NULL`,
      )
      .all();
    assert.deepEqual(
      offending,
      [],
      "register_values must hold no row for a column that has a field behind it",
    );
  } finally {
    db.close();
  }
});

test("W05-01/W06-11 reorder is dense and deterministic, and two columns never share a position", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");

  const listed = await call("GET", "/api/registers?register=sites");
  const keys = listed.body.columns.map((column) => column.key);
  assert.ok(
    listed.body.columns.every((column, index) => column.position === index),
    "the seeded catalogue is already dense",
  );

  // Reversed wholesale: the strongest shuffle available without inventing keys.
  const reversed = await call("PATCH", "/api/registers", {
    register: "sites",
    order: [...keys].reverse(),
  });
  assert.equal(reversed.status, 200);
  assert.deepEqual(
    reversed.body.columns.map((column) => column.key),
    [...keys].reverse(),
  );
  assert.ok(
    reversed.body.columns.every((column, index) => column.position === index),
    "positions come back 0..n-1 with no gaps",
  );
  assert.equal(
    new Set(reversed.body.columns.map((column) => column.position)).size,
    reversed.body.columns.length,
    "no two columns share a position",
  );

  /*
   * A PARTIAL LIST IS NOT A DELETION, AND A GHOST IS NOT A FAILURE. A browser's
   * list can be a moment stale — a colleague added a column while this one was
   * being dragged, or removed the one being dropped next to — so anything the
   * request did not mention keeps its relative order at the tail rather than
   * collapsing to the front, and a key that no longer exists is ignored rather
   * than failing the whole reorder. Both in one call because each of these
   * costs a renumber of the whole register against a shared dev server.
   */
  const partial = await call("PATCH", "/api/registers", {
    register: "sites",
    order: ["notes", "no-such-column", "name"],
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.body).slice(0, 200));
  assert.deepEqual(partial.body.columns.slice(0, 2).map((column) => column.key), ["notes", "name"]);
  assert.equal(partial.body.columns.length, reversed.body.columns.length, "nothing was dropped");
  assert.ok(partial.body.columns.every((column, index) => column.position === index));

  // Ids work as well as keys: the grid holds keys, the settings panel holds
  // rows. Accepting either keeps a lookup table out of the client.
  const byId = listed.body.columns.find((column) => column.key === "city");
  const withIds = await call("PATCH", "/api/registers", { register: "sites", order: [byId.id] });
  assert.equal(withIds.body.columns[0].key, "city");

  // Put it back the way it was found; `after()` restores the rest.
  const restored = await call("PATCH", "/api/registers", { register: "sites", order: keys });
  assert.deepEqual(restored.body.columns.map((column) => column.key), keys);
});

test("W05-01/W05-08 structural writes are capability-gated and cross-org ids are refused", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  await snapshotRegister("sites");

  const created = await call("POST", "/api/registers", {
    register: "sites",
    title: `${RUN} Guarded column`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const column = created.body.column;
  createdColumnIds.push(column.id);

  /*
   * A CLIENT MAY READ AND MAY NOT CONFIGURE. `client` holds `board.view` and
   * `data.export` and nothing else, so every structural verb must refuse — and
   * the read must still say so in `canConfigure`, because a role whose
   * `board.edit` was revoked in Roles is still called "Admin".
   */
  const clientRead = await callAs(CLIENT_IDENTITY, "GET", "/api/registers?register=sites");
  assert.equal(clientRead.status, 200, "a client can still draw the register");
  assert.equal(clientRead.body.canConfigure, false);

  const clientAdd = await callAs(CLIENT_IDENTITY, "POST", "/api/registers", {
    register: "sites",
    title: `${RUN} client should not`,
  });
  assert.equal(clientAdd.status, 403);
  const clientRename = await callAs(CLIENT_IDENTITY, "PATCH", "/api/registers", {
    id: column.id,
    title: `${RUN} client renamed`,
  });
  assert.equal(clientRename.status, 403);
  const clientDelete = await callAs(CLIENT_IDENTITY, "DELETE", `/api/registers?id=${column.id}`);
  assert.equal(clientDelete.status, 403);

  /*
   * AND A CAPABLE STRANGER IS STILL A STRANGER. `admin@demo-client-ltd…` holds
   * `board.edit` in the OTHER organisation, so the capability check waves them
   * through and the organisation filter is what refuses them. 404, not 403:
   * telling a caller that an id exists in a tenant they may not read is itself
   * a leak. Measured on `/api/workspace` before `contractorTarget` existed: a
   * cross-tenant PATCH answered 200, changed nothing, and filed the caller's
   * payload into the wrong workspace's activity feed.
   */
  const crossPatch = await callAs(OTHER_ADMIN_IDENTITY, "PATCH", "/api/registers", {
    id: column.id,
    title: "HACKED",
  });
  assert.equal(crossPatch.status, 404);
  const crossDelete = await callAs(OTHER_ADMIN_IDENTITY, "DELETE", `/api/registers?id=${column.id}`);
  assert.equal(crossDelete.status, 404);

  const after = await call("GET", "/api/registers?register=sites");
  const untouched = after.body.columns.find((entry) => entry.id === column.id);
  assert.equal(
    untouched?.title,
    `${RUN} Guarded column`,
    "nothing was mutated before the refusal",
  );
});
