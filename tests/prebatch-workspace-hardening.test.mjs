import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * The four defects the pre-Batch-1B hardening pass closed.
 *
 * Batch 1B — the canonical Jobs↔Sites and Jobs↔Contractors migration — is
 * blocked, so these are the parts of its groundwork that need no legacy corpus
 * and no owner decision: a partial PATCH that blanked the site register, three
 * reference columns that crossed the tenant boundary unchecked, an archive verb
 * that left a site half-closed, and an index that every environment was missing
 * because it had only ever been declared.
 *
 * The source assertions run everywhere. The behavioural tests need a dev server
 * and skip without one, which is the bargain the rest of the suite already
 * makes — see tests/stage-nineteen-client-isolation.test.mjs.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

/*
 * Found rather than assumed. `vite` takes the first free port from 5173 up, so
 * pinning one number means the three tests that exercise the running app skip
 * themselves on any machine whose 5173 is busy — which is exactly the headline
 * protection quietly switching off. `MAINTSUPP_BASE_URL` still wins outright.
 */
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `HARDENING-${Date.now().toString(36)}`;

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/context`, {
        signal: AbortSignal.timeout(4000),
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

/**
 * A real session. The identity header alone scopes reads; every write here goes
 * through `authoriseWorkspaceWrite`, which refuses an unauthenticated caller
 * with "Sign in to make this change."
 */
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

/**
 * Which tenant the call acts as.
 *
 * Not the `x-maintsupp-identity` header: once a real session is presented the
 * header is ignored, so both identities resolve to the session's own actor. The
 * owner is a super admin and may select either organisation, which is how a
 * genuine cross-organisation id is obtained here — created inside the demo
 * tenant, then referenced from the primary one.
 */
async function call(method, path, orgId, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: `${cookie}; maintsupp_demo_organisation=${orgId}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

/**
 * Every fixture this file created, removed for good.
 *
 * A site is closed rather than deleted — that is the product contract, and
 * `tests/stage-nineteen-client-isolation.test.mjs` asserts the demo tenant
 * holds exactly zero of them — so archiving alone would let each run leave a
 * row behind and eventually break a neighbouring test. Only rows carrying this
 * run's marker are touched, and only in the local development database; when
 * that file is absent, or the driver is missing, there is nothing to clean.
 */
after(async () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  const directory = new URL(
    "../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/",
    import.meta.url,
  );
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return;
  }
  if (!file) return;
  let db;
  try {
    // `fileURLToPath`, not `URL.pathname`: the repo path contains a space, and a
    // percent-encoded path opens nothing. Swallowed, that failure is invisible —
    // which is how a previous run left three orphaned sites behind.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    /*
     * The dev server holds this file open, so an unqualified write loses the
     * race and throws "database is locked" — which is how two runs' fixtures
     * survived their own cleanup. Wait for the writer rather than give up.
     */
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("DELETE FROM planned_maintenance WHERE title LIKE ?").run(`${RUN}%`);
    db.prepare("DELETE FROM units WHERE name LIKE ?").run(`${RUN}%`);
    db.prepare(
      "DELETE FROM compliance_documents WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ?)",
    ).run(`${RUN}%`);
    /*
     * Aliases before sites: `site_aliases.site_id` references `sites.id`, and
     * SQLite enforces that here — the driver is built with node:sqlite's
     * defaults, which turn foreign keys on. The rename test leaves two.
     */
    db.prepare(
      "DELETE FROM site_aliases WHERE site_id IN (SELECT id FROM sites WHERE name LIKE ?) OR alias LIKE ?",
    ).run(`${RUN}%`, `${RUN}%`);
    db.prepare("DELETE FROM sites WHERE name LIKE ?").run(`${RUN}%`);
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  }
});

/**
 * A site's recorded former names, read straight from the development database.
 *
 * `GET /api/sites` does not carry aliases, and this asserts the one thing a
 * rename is now supposed to leave behind. Opened read-only and closed
 * immediately: the development server holds the same file, and a handle kept
 * across an await is how one suite's cleanup turns into another suite's 503.
 */
/** One site's row, read straight from the development database. Same reason. */
async function siteRow(id) {
  return withDatabase((db) =>
    db.prepare("SELECT name, status, lifecycle, active FROM sites WHERE id = ?").get(id),
  );
}

async function siteAliases(id) {
  return withDatabase((db) =>
    db
      .prepare("SELECT alias FROM site_aliases WHERE site_id = ? ORDER BY alias")
      .all(id)
      .map((row) => row.alias),
  );
}

/** Opens the development database read-only, runs one query, closes it. */
async function withDatabase(query) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  let db;
  try {
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
    return query(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to do — the handle is going out of scope regardless.
    }
  }
}

const workspace = (orgId) => call("GET", "/api/workspace", orgId);
const create = (orgId, entity, data) =>
  call("POST", "/api/workspace", orgId, { entity, data });
const patch = (orgId, entity, id, data) =>
  call("PATCH", "/api/workspace", orgId, { entity, id, data });
const archive = (orgId, entity, id) =>
  call("DELETE", "/api/workspace", orgId, { entity, id });

// ---------------------------------------------------------------------------
// FIX 1 — a partial PATCH no longer blanks the columns it did not mention
// ---------------------------------------------------------------------------

test("a partial workspace PATCH writes only the keys it was sent", async () => {
  const route = await read("app/api/workspace/route.ts");
  const update = route.slice(route.indexOf("export async function PATCH"));

  /*
   * `text()` returns "" for undefined and "" satisfies NOT NULL, so any bare
   * `text(data.x)` inside a `.set({` blanked that column on a partial PATCH.
   * The site branch erased `sites.name` — the one identifier resolveSiteByName,
   * the importer's index, Report-a-Job and the shared-form submit path all key
   * on.
   */
  for (const [entity, columns] of [
    ["site", ["name", "type", "region", "lifecycle", "address", "manager"]],
    ["unit", ["siteId", "name", "category", "status", "notes"]],
    ["planned", ["siteId", "title", "category", "frequency", "nextDueAt", "status"]],
  ]) {
    const start = update.indexOf(`entity === "${entity}"`);
    assert.ok(start > 0, `the PATCH ${entity} branch must exist`);
    const branch = update.slice(start, update.indexOf("} else if", start + 20));
    for (const column of columns) {
      assert.match(
        branch,
        new RegExp(`supplied\\(data, "${column}"`),
        `PATCH ${entity} must write ${column} only when it was sent`,
      );
    }
    assert.doesNotMatch(
      branch,
      /set\(\{ \w+: (text|optionalText)\(data\./,
      `PATCH ${entity} must not blank unmentioned columns`,
    );
  }
});

test("an explicitly blank required field is refused rather than written", async () => {
  const route = await read("app/api/workspace/route.ts");
  /*
   * `supplied` fixes omission, not `{ name: "" }`. POST already refuses these
   * fields, so PATCH agrees with POST about one rule rather than inventing one.
   */
  assert.match(route, /function requiredTextRefusal\(/, "one guard, used by every branch");
  assert.match(route, /requiredTextRefusal\(data, "name", 120, "A site name is required\."\)/);
  assert.match(route, /requiredTextRefusal\(data, "address", 300, "A site address is required\."\)/);
  assert.match(route, /requiredTextRefusal\(data, "nextDueAt", 40, "A next due date is required\."\)/);
  assert.match(route, /status: 400/, "a malformed request is a 400, not a 404");
});

test("the compliance PATCH refuses the partial it cannot survive", async () => {
  /*
   * Every other branch guards a key only when it was sent, because those
   * branches write only what they were sent. This one names `site_id` and
   * `kind` unconditionally, so the dangerous request is the one that OMITS
   * them — a presence-conditional guard would look like protection and stop
   * nothing.
   */
  const route = await read("app/api/workspace/route.ts");
  const start = route.indexOf('entity === "compliance"', route.indexOf("export async function PATCH"));
  const branch = route.slice(start, route.indexOf("} else if", start + 20));
  assert.match(branch, /if \(!text\(data\.siteId, 100\)\)/, "an omitted site must be refused, not written as ''");
  assert.match(branch, /if \(!text\(data\.kind, 120\)\)/, "and so must an omitted requirement");
  assert.doesNotMatch(
    branch,
    /"siteId" in data \? text\(data\.siteId, 100\) : null/,
    "the reference check must not be conditional on a key this UPDATE writes regardless",
  );
});

test("closing a site from the workspace tab can be undone there", async () => {
  /*
   * Archiving writes all three state columns. The only closed/open control this
   * form has is `lifecycle`, so writing that alone would strand a site the
   * Sites screen still calls closed and this tab could never reopen.
   */
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /lifecycleState = \{ status: "closed", active: false \}/, "closing writes the trio");
  assert.match(route, /lifecycleState = \{ status: "active", active: true \}/, "reopening clears it");
  assert.match(
    route,
    /if \(current\?\.status === "closed"\)/,
    "and only for a site that was actually closed — 'international' and 'other' are open states this form cannot express",
  );
});

test("the compliance PATCH keeps its deliberate full replace", async () => {
  /*
   * The calendar's compliance PATCH sends all four keys and depends on the
   * unconditional UPDATE — tests/acceptance-correction-one-calendar-data.test.mjs
   * pins that statement's literal text. Hardening added reference validation
   * above it and left the statement alone.
   */
  const route = await read("app/api/workspace/route.ts");
  assert.match(
    route,
    /await db\.update\(complianceDocuments\)\.set\(\{ siteId: text\(data\.siteId, 100\), kind: text\(data\.kind, 120\), status: state,/,
    "the compliance UPDATE must stay byte-for-byte as the calendar contract requires",
  );
});

// ---------------------------------------------------------------------------
// FIX 2 — reference columns are checked for existence AND ownership
// ---------------------------------------------------------------------------

test("every workspace reference is resolved against the caller's organisation", async () => {
  const route = await read("app/api/workspace/route.ts");

  assert.match(route, /async function referenceRefusal\(/, "one org-scoped lookup");
  assert.match(route, /async function referencesRefusal\(/, "checked as a set, before any write");

  // The lookup carries both predicates, so "missing" and "not yours" cannot
  // drift into distinguishable answers later.
  for (const table of ["sites", "units", "contractors"]) {
    assert.match(
      route,
      new RegExp(`eq\\(${table}\\.id, value\\), eq\\(${table}\\.organisationId, orgId\\)`),
      `${table} must be looked up by id AND organisation`,
    );
  }

  assert.match(route, /status: 404/, "a reference miss is a 404");
  assert.doesNotMatch(route, /status: 403/, "never 403 — that would confirm the row exists elsewhere");

  // An absent optional reference is skipped, not refused: "" is how the manage
  // form says "No linked unit" / "No contractor".
  assert.match(route, /if \(!reference\.value\) continue;/);
});

test("no reference is validated after the write it guards", async () => {
  const route = await read("app/api/workspace/route.ts");
  /*
   * The zero-partial-mutation invariant made checkable. Each branch performs
   * exactly one entity write and this route deliberately never opens a
   * transaction — db/node-pg-d1.ts documents that the pooled adapter cannot
   * serve a bare BEGIN — so "validate first" is the whole of the guarantee.
   */
  assert.doesNotMatch(route, /db\.transaction\(/, "the pooled adapter cannot serve a bare BEGIN");

  /*
   * Scoped to the POST handler: `seedWorkspaceIfEmpty` inserts the same tables
   * far above it from a hardcoded fixture, and those writes take no caller
   * input, so they are not what needs guarding.
   */
  const post = route.slice(route.indexOf("export async function POST"));
  for (const marker of ["insert(units)", "insert(plannedMaintenance)", "insert(complianceDocuments)"]) {
    const write = post.indexOf(marker);
    assert.ok(write > 0, `${marker} must exist in POST`);
    const guard = post.lastIndexOf("referencesRefusal(db, orgId", write);
    assert.ok(guard > 0 && guard < write, `${marker} must be guarded before it runs`);
  }
});

// ---------------------------------------------------------------------------
// FIX 3 — archiving a site writes the whole closed state
// ---------------------------------------------------------------------------

test("archiving a site closes it everywhere, not just in the lifecycle word", async () => {
  /*
   * `sites` carries three state columns and every other write path moves them
   * together. Archiving through /api/workspace set `lifecycle` alone, so the
   * site stayed `status='active'` and `active=true` — and app/lib/form-options.ts
   * filters the public Location dropdown on `sites.active`, so an archived site
   * was still offered to the public.
   */
  for (const file of ["app/api/sites/route.ts", "app/api/workspace/route.ts"]) {
    const source = await read(file);
    const archiveVerb = source.slice(source.indexOf("export async function DELETE"));
    assert.match(archiveVerb, /status: "closed"/, `${file}: status must close`);
    assert.match(archiveVerb, /lifecycle: "Closed"/, `${file}: the Stage 0 column stays in step`);
    assert.match(archiveVerb, /active: false/, `${file}: form-options.ts filters on sites.active`);
  }
});

// ---------------------------------------------------------------------------
// FIX 4 — the index reaches the database that actually runs
// ---------------------------------------------------------------------------

test("contractors_organisation_idx is created by the provisioner, not just declared", async () => {
  /*
   * db/schema.ts is read by drizzle-kit, which is configured for sqlite and
   * writes to drizzle/ — a directory nothing on the boot path reads. db/init.ts
   * is what actually provisions, and it had no index for contractors at all, so
   * every `WHERE organisation_id = ?` was a sequential scan on every runtime.
   */
  const schema = await read("db/schema.ts");
  assert.match(
    schema,
    /index\("contractors_organisation_idx"\)\.on\(table\.organisationId\)/,
    "the declaration is the name of record",
  );

  const init = await read("db/init.ts");
  assert.match(
    init,
    /CREATE INDEX IF NOT EXISTS contractors_organisation_idx ON contractors \(organisation_id\)/,
    "the provisioner that actually runs must create it",
  );

  // CREATE INDEX IF NOT EXISTS matches on name: a differently-named copy would
  // silently add a second index rather than replace anything.
  const declared = schema.match(/index\("(contractors_[a-z_]*idx)"\)/g) ?? [];
  for (const entry of declared) {
    const name = entry.match(/"([^"]+)"/)[1];
    assert.ok(
      init.includes(name),
      `${name} is declared in db/schema.ts but never created by db/init.ts`,
    );
  }
});

// ---------------------------------------------------------------------------
// Behavioural — needs a dev server
// ---------------------------------------------------------------------------

test("a partial site PATCH leaves the name byte-for-byte intact", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  const name = `${RUN} Partial Patch Store`;
  const created = await create(PRIMARY_ORGANISATION_ID, "site", {
    name,
    address: "1 Hardening Way, London",
    type: "Kiosk",
    region: "UK",
    lifecycle: "Current",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  try {
    // A PATCH that mentions only the lifecycle must not touch anything else.
    const partial = await patch(PRIMARY_ORGANISATION_ID, "site", id, { lifecycle: "Closed" });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));

    let after = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.stores.find((s) => s.id === id);
    assert.equal(after.name, name, "the name must survive a PATCH that did not mention it");
    assert.equal(after.address, "1 Hardening Way, London", "and so must the address");
    assert.equal(after.lifecycle, "Closed", "while the field that WAS sent is written");

    // An explicit rename still works.
    const renamed = `${name} Renamed`;
    const rename = await patch(PRIMARY_ORGANISATION_ID, "site", id, { name: renamed });
    assert.equal(rename.status, 200);
    after = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.stores.find((s) => s.id === id);
    assert.equal(after.name, renamed, "an explicit rename must still be written");
    assert.equal(after.address, "1 Hardening Way, London", "without disturbing its neighbours");

    // An explicit blank is refused, and the stored name is untouched.
    const blanked = await patch(PRIMARY_ORGANISATION_ID, "site", id, { name: "" });
    assert.equal(blanked.status, 400, "an empty required field is a 400");
    after = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.stores.find((s) => s.id === id);
    assert.equal(after.name, renamed, "a refused PATCH must write nothing");
  } finally {
    await archive(PRIMARY_ORGANISATION_ID, "site", id);
  }
});

test("a reference belonging to another organisation is refused, and writes nothing", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  const ours = await workspace(PRIMARY_ORGANISATION_ID);
  const ourSite = ours.body.workspace.stores.find((store) => store.lifecycle !== "Closed");
  const ourContractor = ours.body.workspace.contractors[0];
  assert.ok(ourSite?.id, "the primary tenant must hold an open site to reference");

  /*
   * Nothing is created inside the demo tenant. Acting AS the demo tenant while
   * naming the primary tenant's site is already the cross-organisation attempt,
   * and it leaves no row behind — which matters, because a site archived
   * through the API is closed rather than deleted, so a fixture created here
   * would survive its own cleanup and
   * tests/stage-nineteen-client-isolation.test.mjs asserts the demo tenant
   * holds exactly zero sites.
   */
  const crossOrg = await create(DEMO_ORGANISATION_ID, "unit", {
    name: `${RUN} Cross Org Unit`,
    siteId: ourSite.id,
    category: "Asset",
    status: "Active",
  });
  assert.equal(crossOrg.status, 404, "another tenant's site must not be referencable");

  // …and it is answered identically to an id that exists nowhere, so the status
  // cannot be used to confirm that a site id is real.
  const nowhere = await create(DEMO_ORGANISATION_ID, "unit", {
    name: `${RUN} Nonexistent Unit`,
    siteId: "site-does-not-exist-anywhere",
    category: "Asset",
    status: "Active",
  });
  assert.equal(nowhere.status, crossOrg.status, "no existence oracle via the status");
  assert.deepEqual(nowhere.body, crossOrg.body, "nor via the body");

  // Neither attempt may leave a row behind.
  const demo = await workspace(DEMO_ORGANISATION_ID);
  assert.equal(
    demo.body.workspace.units.filter((unit) => unit.name?.startsWith(RUN)).length,
    0,
    "a refused create must write nothing",
  );

  // The same refusal on PATCH, against a record the caller really does own.
  const fixture = await create(PRIMARY_ORGANISATION_ID, "unit", {
    name: `${RUN} Same Org Unit`,
    siteId: ourSite.id,
    category: "Asset",
    status: "Active",
  });
  assert.equal(fixture.status, 200, `a site this tenant owns must be accepted: ${JSON.stringify(fixture.body)}`);
  const unitId = fixture.body.id;
  assert.ok(unitId, "the fixture must exist before anything destructive runs");

  try {
    // A cross-org contractor on an otherwise valid planned visit writes nothing.
    if (ourContractor?.id) {
      const before = (await workspace(DEMO_ORGANISATION_ID)).body.workspace.planned.length;
      const refused = await create(DEMO_ORGANISATION_ID, "planned", {
        title: `${RUN} Cross Org Planned`,
        siteId: ourSite.id,
        nextDueAt: "2027-01-01",
        contractorId: ourContractor.id,
      });
      assert.equal(refused.status, 404, "another tenant's contractor must not be referencable");
      const after = (await workspace(DEMO_ORGANISATION_ID)).body.workspace.planned.length;
      assert.equal(after, before, "a refused create must leave no partial row behind");
    }

    // A PATCH naming another tenant's site is refused, and writes nothing —
    // not even the valid half of the same request.
    const patched = await patch(PRIMARY_ORGANISATION_ID, "unit", unitId, {
      name: `${RUN} Renamed By A Refused Patch`,
      siteId: "site-does-not-exist-anywhere",
    });
    assert.equal(patched.status, 404, "an unresolvable site on PATCH is refused");
    const after = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.units.find((u) => u.id === unitId);
    assert.equal(after.name, `${RUN} Same Org Unit`, "a refused PATCH must not write its valid half");

    // An empty optional reference still means "none", not "not found".
    const noContractor = await create(PRIMARY_ORGANISATION_ID, "planned", {
      title: `${RUN} No Contractor`,
      siteId: ourSite.id,
      nextDueAt: "2027-01-01",
      unitId: "",
      contractorId: "",
    });
    assert.equal(noContractor.status, 200, "'No contractor' must still save");
    if (noContractor.body.id) await archive(PRIMARY_ORGANISATION_ID, "planned", noContractor.body.id);
  } finally {
    await archive(PRIMARY_ORGANISATION_ID, "unit", unitId);
  }
});

test("renaming a site keeps every name it used to have", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  /*
   * Batch 1B, decision D6. A rename used to write the new name and nothing
   * else, so every job, compliance row and import that recorded the old
   * spelling stopped resolving the moment somebody tidied a store's name.
   *
   * It lives in this file rather than beside the rest of Batch 1B because the
   * local D1 cannot serve a third concurrent live suite: three test files
   * talking to one development server turns its own reads into 503s, which then
   * surface as failures in whichever suite happened to be mid-request.
   */
  const created = await call("POST", "/api/sites", PRIMARY_ORGANISATION_ID, {
    data: {
      name: `${RUN} Alpha`,
      addressLine1: "1 Alias Way",
      city: "London",
      postcode: "E1 1AA",
      siteTypeValue: "Kiosk",
      status: "active",
      region: "UK",
    },
  });
  assert.equal(created.status, 200, `fixture creation failed: ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  const rename = (to) => call("PATCH", "/api/sites", PRIMARY_ORGANISATION_ID, { id, rename: to });
  // Read from the database, not `GET /api/sites`: that call lists the whole
  // register, and doing it between every rename is what tips the one
  // development server over when the suites run in parallel.
  const siteName = async () => (await siteRow(id))?.name;

  // A -> B -> C: both earlier names must still resolve.
  assert.equal((await rename(`${RUN} Beta`)).status, 200);
  assert.equal((await rename(`${RUN} Gamma`)).status, 200);
  assert.equal(await siteName(), `${RUN} Gamma`);
  const afterTwo = await siteAliases(id);
  if (afterTwo === null) {
    t.skip("no development database to read aliases from");
    return;
  }
  assert.deepEqual(afterTwo, [`${RUN} Alpha`, `${RUN} Beta`], "a rename is additive, not a replace");

  // C -> A: adopting a name back retires it as an alias rather than duplicating it.
  assert.equal((await rename(`${RUN} Alpha`)).status, 200);
  assert.equal(await siteName(), `${RUN} Alpha`);
  assert.deepEqual(
    await siteAliases(id),
    [`${RUN} Beta`, `${RUN} Gamma`],
    "the adopted name stops being a former name of the same site",
  );
});

test("an archived site is closed in every column the app filters on", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return;
  }

  const created = await create(PRIMARY_ORGANISATION_ID, "site", {
    name: `${RUN} Archive Store`,
    address: "3 Hardening Way, London",
    type: "Kiosk",
    region: "UK",
    lifecycle: "Current",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.ok(id, "the fixture must exist before anything destructive runs");

  const archived = await archive(PRIMARY_ORGANISATION_ID, "site", id);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const after = (await workspace(PRIMARY_ORGANISATION_ID)).body.workspace.stores.find((s) => s.id === id);
  assert.ok(after, "an archived site is kept, never deleted");
  assert.equal(after.lifecycle, "Closed");
  assert.equal(after.status, "closed", "the Stage 2 column must agree with the Stage 0 one");

  // The invariant that would have caught the contradictory row on Staging.
  assert.equal(
    after.lifecycle === "Closed",
    after.status === "closed",
    "a site is closed in both columns or neither",
  );
});
