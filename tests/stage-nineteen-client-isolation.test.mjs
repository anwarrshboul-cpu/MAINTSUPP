/**
 * Stage 19 — one client cannot read another client's rows.
 *
 * Two halves. The first reads the source and pins the *shape* of the rule: that
 * tenancy is decided in exactly one place, that no data route resolves an
 * organisation any other way, and that the second tenant is seeded with
 * structure and no operational rows. The second half talks to a running dev
 * server and checks the rule actually holds end to end — a scoping bug is a
 * data leak, and source that reads correctly is not by itself evidence.
 *
 * The live half skips when nothing is listening on the dev port, so the suite
 * still passes in an environment without a server.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";
const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";

const SUNNAMUSK_CLIENT = "client@sunnamusk-uk.test.maintsupp.com";
const DEMO_CLIENT = "client@demo-client-ltd.test.maintsupp.com";
const SUPER_ADMIN = "super-admin@test.maintsupp.com";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/*
 * Every route that reads or writes tenant data. Kept in step with the list in
 * tenant-scope.test.mjs, and extended with the routes that grew after it was
 * written — a route missing from both lists is a route nobody is checking.
 */
const dataRoutes = [
  "app/api/board/route.ts",
  "app/api/board/columns/route.ts",
  "app/api/board/groups/route.ts",
  "app/api/board/items/route.ts",
  "app/api/board/links/route.ts",
  "app/api/board/views/route.ts",
  "app/api/context/route.ts",
  "app/api/files/route.ts",
  "app/api/files/[id]/route.ts",
  "app/api/files/multipart/route.ts",
  "app/api/import/route.ts",
  "app/api/leads/route.ts",
  "app/api/maintenance/route.ts",
  "app/api/notifications/route.ts",
  "app/api/notifications/compliance/route.ts",
  "app/api/notifications/replay/route.ts",
  "app/api/options/route.ts",
  "app/api/sites/route.ts",
  "app/api/sites/csv/route.ts",
  "app/api/sites/groups/route.ts",
  "app/api/units/route.ts",
  "app/api/workspace/route.ts",
];

test("every data route takes its organisation from scopedDb and nowhere else", async () => {
  for (const path of dataRoutes) {
    const text = await source(path);
    /*
     * `scopedDbWithCapability` counts, because it IS `scopedDb`.
     *
     * The helper resolves the same scope and then additionally refuses a caller
     * whose role lacks the capability, so a route using it satisfies this test's
     * subject — the organisation comes from memberships, never from the request
     * — strictly more than the bare call does. Matching only the literal
     * `scopedDb(request)` would push a route back to the weaker of the two to
     * keep a test green.
     */
    assert.match(
      text,
      /scopedDb(WithCapability)?\(\s*request/,
      `${path} must resolve its scope through scopedDb`,
    );
    assert.doesNotMatch(
      text,
      /maintsupp_demo_organisation/,
      `${path} must not read the organisation cookie itself`,
    );
    assert.doesNotMatch(
      text,
      /workspaceRoleFromRequest/,
      `${path} must use the role the database granted, not the role cookie`,
    );
  }
});

test("tenancy is decided in one place, from memberships rather than cookies", async () => {
  const access = await source("app/lib/tenant-access.ts");

  // The organisation is only ever taken from a membership row.
  assert.match(access, /from\(memberships\)/);
  assert.match(access, /innerJoin\(users/);
  assert.match(access, /eq\(memberships\.status, "active"\)/);

  // The cookie is a request, not a grant: it is filtered through the allowed
  // set before it can select anything.
  assert.match(access, /allowed\.has\(requestedId\)/);

  // Only a super admin is ever given more than one organisation.
  assert.match(access, /role === "super_admin"/);
  assert.match(access, /crossOrganisation: role === "super_admin"/);

  const db = await source("app/lib/tenant-db.ts");
  assert.match(db, /resolveTenantAccess\(db, request\)/);
  assert.doesNotMatch(
    db,
    /workspaceCookieValue/,
    "scopedDb must not read cookies directly any more",
  );
});

test("the empty second tenant is seeded with structure and no operational rows", async () => {
  const init = await source("db/init.ts");

  assert.match(init, new RegExp(`DEMO_ORGANISATION_ID = "${DEMO_ORGANISATION_ID}"`));
  assert.match(init, /'Demo Client Ltd'/);
  assert.match(init, /ensureDemoClientOrganisation\(d1\)/);
  assert.match(init, /seedBoardStructure\(d1, DEMO_ORGANISATION_ID\)/);

  // Structure copied: option sets and their values.
  assert.match(init, /INSERT OR IGNORE INTO option_sets[\s\S]*?SELECT/);
  assert.match(init, /INSERT OR IGNORE INTO option_values[\s\S]*?FROM option_values/);

  // No operational table may be copied into the demo organisation.
  const demoSeeder = init.slice(
    init.indexOf("async function ensureDemoClientOrganisation"),
    init.indexOf("async function ensureTenantIdentities"),
  );
  assert.ok(demoSeeder.length > 0, "the demo seeder must exist");
  for (const table of [
    "sites",
    "units",
    "maintenance_requests",
    "compliance_documents",
    "maintenance_board_cells",
    "attachments",
  ]) {
    assert.doesNotMatch(
      demoSeeder,
      new RegExp(`INSERT[^;]*INTO ${table}\\b`),
      `the demo organisation must not be seeded with ${table} rows`,
    );
  }
});

test("the demo seeders stay additive and idempotent", async () => {
  const init = await source("db/init.ts");
  const block = init.slice(
    init.indexOf("async function ensureDemoClientOrganisation"),
    init.indexOf("async function ensureStageTwoFoundation"),
  );
  assert.ok(block.length > 0);

  // db/init.ts runs on the boot path of every request. An unguarded write that
  // is not INSERT OR IGNORE takes the whole app down on the second boot.
  const inserts = block.match(/INSERT(?! OR IGNORE)\s+INTO/g) ?? [];
  assert.deepEqual(inserts, [], "every insert in the Stage 19 seeders must be INSERT OR IGNORE");
  assert.doesNotMatch(block, /\bDELETE FROM\b/, "the Stage 19 seeders must not delete rows");
  assert.doesNotMatch(block, /\bALTER TABLE\b/, "column additions must go through addColumn");
});

test("sample data is still confined to the primary organisation", async () => {
  for (const path of [
    "app/api/board/route.ts",
    "app/api/maintenance/route.ts",
    "app/api/workspace/route.ts",
  ]) {
    const text = await source(path);
    assert.match(
      text,
      new RegExp(`orgId !== PRIMARY_ORGANISATION_ID\\)\\s*return`),
      `${path} must not seed sample rows into a second tenant`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Live isolation, against the running dev server.                     */
/* ------------------------------------------------------------------ */

async function live(path, identity, extraHeaders = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-maintsupp-identity": identity, ...extraHeaders },
  });
  return { status: response.status, body: await response.json() };
}

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test("a client sees only their own organisation's rows", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const sunnamusk = await live("/api/context", SUNNAMUSK_CLIENT);
  assert.equal(sunnamusk.body.context.actor.role, "client");
  assert.equal(
    sunnamusk.body.context.currentOrganisation.id,
    PRIMARY_ORGANISATION_ID,
  );
  assert.deepEqual(sunnamusk.body.context.identity.organisationIds, [
    PRIMARY_ORGANISATION_ID,
  ]);
  assert.equal(sunnamusk.body.context.tenantSummary, null);

  const demo = await live("/api/context", DEMO_CLIENT);
  assert.equal(demo.body.context.actor.role, "client");
  assert.equal(demo.body.context.currentOrganisation.id, DEMO_ORGANISATION_ID);
  assert.deepEqual(demo.body.context.identity.organisationIds, [
    DEMO_ORGANISATION_ID,
  ]);

  // The operational data belongs to Sunnamusk, and only Sunnamusk sees it.
  const sunnamuskBoard = await live("/api/board?board=maintenance", SUNNAMUSK_CLIENT);
  const demoBoard = await live("/api/board?board=maintenance", DEMO_CLIENT);
  assert.ok(
    sunnamuskBoard.body.items.length > 0,
    "Sunnamusk UK must still hold its imported jobs",
  );
  assert.equal(demoBoard.body.items.length, 0);
  assert.equal(demoBoard.body.cells.length, 0);

  // …but the second tenant is a working, structured board, not an error page.
  assert.ok(demoBoard.body.columns.length > 0, "the demo board must have columns");
  assert.ok(demoBoard.body.groups.length > 0, "the demo board must have groups");

  const sunnamuskSites = await live("/api/sites", SUNNAMUSK_CLIENT);
  const demoSites = await live("/api/sites", DEMO_CLIENT);
  assert.ok(sunnamuskSites.body.sites.length > 0);
  assert.equal(demoSites.body.sites.length, 0);
});

test("forging the organisation cookie does not cross the tenant boundary", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // The exact attack the old `scopedDb` was open to: name another tenant in the
  // cookie, and claim to be a super admin while doing it.
  const forged = {
    Cookie: `maintsupp_demo_organisation=${PRIMARY_ORGANISATION_ID}; maintsupp_demo_role=super_admin`,
  };

  const context = await live("/api/context", DEMO_CLIENT, forged);
  assert.equal(context.body.context.actor.role, "client");
  assert.equal(
    context.body.context.currentOrganisation.id,
    DEMO_ORGANISATION_ID,
    "the organisation cookie must be ignored when it names a tenant the actor is not a member of",
  );

  const board = await live("/api/board?board=maintenance", DEMO_CLIENT, forged);
  assert.equal(board.body.items.length, 0);

  const sites = await live("/api/sites", DEMO_CLIENT, forged);
  assert.equal(sites.body.sites.length, 0);

  // Selecting another tenant explicitly is refused rather than silently ignored.
  const refused = await fetch(`${BASE_URL}/api/context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-maintsupp-identity": DEMO_CLIENT,
      ...forged,
    },
    body: JSON.stringify({
      action: "select_organisation",
      organisationId: PRIMARY_ORGANISATION_ID,
    }),
  });
  assert.equal(refused.status, 403);
});

test("a client cannot read another tenant's record by id", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const board = await live("/api/board?board=maintenance", SUNNAMUSK_CLIENT);
  const target = board.body.items[0];
  assert.ok(target?.requestId, "expected at least one Sunnamusk job to probe with");
  const id = encodeURIComponent(target.requestId);

  const owner = await live(`/api/maintenance?id=${id}`, SUNNAMUSK_CLIENT);
  assert.equal(owner.body.request.id, target.requestId);

  const intruder = await live(`/api/maintenance?id=${id}`, DEMO_CLIENT);
  assert.equal(intruder.status, 404);
  assert.equal(intruder.body.request, undefined);
});

test("a super admin sees every organisation and can switch between them", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const context = await live("/api/context", SUPER_ADMIN);
  assert.equal(context.body.context.actor.role, "super_admin");
  assert.equal(context.body.context.identity.crossOrganisation, true);
  const ids = context.body.context.identity.organisationIds;
  assert.ok(ids.includes(PRIMARY_ORGANISATION_ID));
  assert.ok(ids.includes(DEMO_ORGANISATION_ID));

  // The cross-tenant summary is the "view on everything", and is withheld from
  // everyone else — asserted null for a client above.
  const summary = context.body.context.tenantSummary;
  assert.ok(Array.isArray(summary));
  const primary = summary.find((row) => row.id === PRIMARY_ORGANISATION_ID);
  const demo = summary.find((row) => row.id === DEMO_ORGANISATION_ID);
  assert.ok(primary.maintenanceRequests > 0);
  assert.ok(primary.sites > 0);
  assert.equal(demo.maintenanceRequests, 0);
  assert.equal(demo.sites, 0);

  // A super admin's organisation cookie IS honoured, because every tenant is
  // one they may read.
  const asDemo = await live("/api/board?board=maintenance", SUPER_ADMIN, {
    Cookie: `maintsupp_demo_organisation=${DEMO_ORGANISATION_ID}`,
  });
  assert.equal(asDemo.body.items.length, 0);

  const asPrimary = await live("/api/board?board=maintenance", SUPER_ADMIN, {
    Cookie: `maintsupp_demo_organisation=${PRIMARY_ORGANISATION_ID}`,
  });
  assert.ok(asPrimary.body.items.length > 0);
});

test("the sidebar role selector switches identity, not just a label", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  // Super admin standing in Demo Client Ltd picks the Client role.
  const response = await fetch(`${BASE_URL}/api/context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-maintsupp-identity": SUPER_ADMIN,
      Cookie: `maintsupp_demo_organisation=${DEMO_ORGANISATION_ID}`,
    },
    body: JSON.stringify({ action: "set_role", role: "client" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.identity, DEMO_CLIENT);

  const cookies = response.headers.getSetCookie?.() ?? [];
  assert.ok(
    cookies.some((value) => value.startsWith("maintsupp_demo_identity=")),
    "set_role must write the identity cookie, or the role change means nothing",
  );
});
