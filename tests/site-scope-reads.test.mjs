/**
 * THE SITE RESTRICTION ON THE JOB-LEVEL READS, AND ON THE UPLOAD DOORS.
 *
 * `memberships.site_scope` confines a member to named stores. The Sites view,
 * Compliance, the dashboard, search and the document reads honoured it; the
 * job-level reads did not. A member confined to one store who held `board.view`
 * was sent every job on the board, every job in `/api/maintenance`, every
 * calendar item, any job's comment thread and reminders, every store's register
 * values, and every store's name in `/api/context`. And a member holding
 * `board.edit` could FILE a document against a job, site or asset at any store —
 * the read doors (Phase 9) asked the restriction, the upload doors never did.
 *
 * And a restriction that failed to parse lifted itself: `parseSiteScope`
 * answered `null` — "every site" — for malformed JSON, a non-array and `[]`.
 *
 * Four layers:
 *   1. the parser and the rule, called directly;
 *   2. the rule as SQL, `confineBoardPayload` and `uploadOutsideSiteScope`, run
 *      against a real in-memory SQLite;
 *   3. every read and both upload doors pinned to the rule by source;
 *   4. against the running estate with purpose-built members — one confined to a
 *      store, one whose restriction is malformed — who are removed afterwards.
 *      Skips without a dev server, as ~32 files in this suite already do.
 *
 * THE UNRESTRICTED MEMBER (`site_scope` NULL — every member on Staging and on
 * Production today) is the case that must not move, and each layer says so
 * separately: the parser returns `null`, the condition is `undefined` (the SQL
 * is byte-identical), the board payload is the SAME object, and the upload
 * check returns before its first query.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const { SITE_OUTSIDE_SCOPE, memberSiteCondition, memberSiteSet, withinMemberScope } = await import(
  "../app/lib/member-site-scope.ts"
);
const { parseSiteScope } = await import("../app/lib/tenant-grants.ts");
const { confineBoardPayload } = await import("../app/lib/board-site-scope.ts");
const { uploadOutsideSiteScope, UPLOAD_OUTSIDE_SCOPE } = await import("../app/api/files/documents.ts");
const { maintenanceRequests } = await import("../db/schema.ts");

/* ── 1. The parser ────────────────────────────────────────────────────────── */

test("parseSiteScope: NULL is unrestricted; a JSON array of ids is exactly those sites", () => {
  assert.equal(parseSiteScope(null), null, "SQL NULL — every member today — is unrestricted");
  assert.equal(parseSiteScope(undefined), null);
  assert.deepEqual(parseSiteScope('["site-a"]'), ["site-a"]);
  assert.deepEqual(parseSiteScope('["site-a","site-b"]'), ["site-a", "site-b"]);
  assert.deepEqual(parseSiteScope('["site-a", 7, null, "", "  "]'), ["site-a"], "unusable entries are dropped");
});

test("parseSiteScope FAILS CLOSED: a restriction that names no usable site names none", () => {
  for (const [value, why] of [
    ["not json", "malformed JSON"],
    ["{\"sites\":[\"site-a\"]}", "an object, not an array"],
    ["\"site-a\"", "a bare string"],
    ["42", "a number"],
    ["null", "JSON null is a written value, not SQL NULL"],
    ["[]", "an empty array"],
    ["[1, 2, null]", "no string ids"],
    ["[\"\"]", "only an empty id"],
    ["", "an empty string"],
  ]) {
    const parsed = parseSiteScope(value);
    assert.deepEqual(parsed, [SITE_OUTSIDE_SCOPE], `${why} must deny, not lift the restriction`);
    /* Never `[]`: every reader that tests `siteScope && siteScope.length`
       would read an empty list as "no filter" — the whole estate. */
    assert.ok(parsed.length > 0, `${why}: never an empty restriction`);
    const allowed = memberSiteSet(parsed);
    assert.equal(withinMemberScope(allowed, "site-a"), false, `${why}: no real site passes`);
    assert.equal(withinMemberScope(allowed, null), false, `${why}: nor a row with no site`);
  }
});

test("the sentinel is the dashboard's own, and no row can carry it", async () => {
  const dashboard = await read("app/lib/dashboard-route.ts");
  assert.match(dashboard, new RegExp(`const FORBIDDEN_SITE = "${SITE_OUTSIDE_SCOPE}";`));
  assert.equal(SITE_OUTSIDE_SCOPE, "__site_outside_scope__");
});

/* ── 2. On a real SQLite ─────────────────────────────────────────────────── */

function proxy(sqlite) {
  return drizzle(async (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    statement.setReturnArrays?.(true);
    const rows = statement.all(...values).map((row) => (Array.isArray(row) ? row : Object.values(row)));
    return { rows: method === "get" ? rows[0] : rows };
  });
}

/*
 * org   job     site
 * org   j-a     site-a
 * org   j-b     site-b
 * org   j-none  (none)
 * other j-x     site-a     — another organisation's job at a same-named id
 */
function estate() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE maintenance_requests (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, site_id TEXT);
    INSERT INTO maintenance_requests VALUES
      ('j-a', 'org', 'site-a'), ('j-b', 'org', 'site-b'), ('j-none', 'org', NULL), ('j-x', 'other', 'site-a');
    CREATE TABLE units (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, site_id TEXT NOT NULL);
    INSERT INTO units VALUES ('u-a', 'org', 'site-a'), ('u-b', 'org', 'site-b');
    CREATE TABLE contractor_sites (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, contractor_id TEXT NOT NULL, site_id TEXT NOT NULL);
    INSERT INTO contractor_sites VALUES ('l1', 'org', 'c-a', 'site-a'), ('l2', 'org', 'c-b', 'site-b');
    CREATE TABLE attachments (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, request_id TEXT, site_id TEXT, unit_id TEXT, contractor_id TEXT);
    INSERT INTO attachments VALUES
      ('doc-a', 'org', 'j-a', 'site-a', NULL, NULL),
      ('doc-b', 'org', 'j-b', 'site-b', NULL, NULL),
      ('doc-site-b', 'org', NULL, 'site-b', NULL, NULL);
  `);
  return { sqlite, db: proxy(sqlite) };
}

async function jobsVisibleTo(db, siteScope) {
  const rows = await db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.organisationId, "org"), memberSiteCondition(maintenanceRequests.siteId, siteScope)));
  return rows.map((row) => row.id).sort();
}

test("memberSiteCondition on SQLite: unrestricted sees every job; restricted sees its sites; no site is outside", async () => {
  const { db } = estate();
  assert.deepEqual(await jobsVisibleTo(db, null), ["j-a", "j-b", "j-none"], "NULL scope: every job, the site-less one too");
  assert.deepEqual(await jobsVisibleTo(db, ["site-a"]), ["j-a"]);
  assert.deepEqual(await jobsVisibleTo(db, ["site-a", "site-b"]), ["j-a", "j-b"], "a job with no site is outside any restriction");
  assert.deepEqual(await jobsVisibleTo(db, parseSiteScope("garbage")), [], "a malformed restriction sees nothing");
  assert.deepEqual(await jobsVisibleTo(db, parseSiteScope("[]")), [], "an empty restriction sees nothing");
  /* Defence in depth: an empty list handed straight in is still no sites, never all. */
  assert.deepEqual(await jobsVisibleTo(db, []), []);
});

test("memberSiteCondition for an unrestricted member leaves the SQL exactly as it was", () => {
  const { db } = estate();
  const before = db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.organisationId, "org")))
    .toSQL();
  const after = db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(and(eq(maintenanceRequests.organisationId, "org"), memberSiteCondition(maintenanceRequests.siteId, null)))
    .toSQL();
  assert.deepEqual(after, before, "the same statement and the same parameters");
  assert.equal(memberSiteCondition(maintenanceRequests.siteId, null), undefined);
  assert.equal(memberSiteCondition(maintenanceRequests.siteId, undefined), undefined);
});

function boardPayload() {
  return {
    groups: [{ id: "g1" }],
    columns: [{ key: "storeLocation" }, { key: "status" }],
    items: [
      { id: "i-a", requestId: "j-a" },
      { id: "i-b", requestId: "j-b" },
      { id: "i-none", requestId: "j-none" },
    ],
    cells: [
      { requestId: "j-a", columnKey: "status" },
      { requestId: "j-b", columnKey: "status" },
      { requestId: "j-none", columnKey: "status" },
    ],
    fileCounts: [{ requestId: "j-a" }, { requestId: "j-b" }],
    notRequired: [
      { itemId: "j-a", slotKey: "fire" },
      { itemId: "j-b", slotKey: "fire" },
    ],
    options: [
      { id: "site-option-site-a", columnKey: "storeLocation" },
      { id: "site-option-site-b", columnKey: "storeLocation" },
      { id: "legacy-chip", columnKey: "storeLocation" },
      { id: "status-done", columnKey: "status" },
    ],
    requests: [
      { id: "j-a", siteId: "site-a" },
      { id: "j-b", siteId: "site-b" },
      { id: "j-none", siteId: null },
    ],
  };
}

test("confineBoardPayload: an unrestricted member gets the SAME object back", async () => {
  const { db } = estate();
  const payload = boardPayload();
  assert.equal(await confineBoardPayload(db, "org", payload, null), payload, "not a copy — the object itself");
  assert.deepEqual(payload, boardPayload(), "and untouched");
});

test("confineBoardPayload: a restricted member gets only their jobs, and their stores in the Location list", async () => {
  const { db } = estate();
  const confined = await confineBoardPayload(db, "org", boardPayload(), ["site-a"]);
  assert.deepEqual(confined.items.map((item) => item.requestId), ["j-a"]);
  assert.deepEqual(confined.cells.map((cell) => cell.requestId), ["j-a"]);
  assert.deepEqual(confined.fileCounts.map((entry) => entry.requestId), ["j-a"]);
  assert.deepEqual(confined.notRequired.map((slot) => slot.itemId), ["j-a"]);
  assert.deepEqual(confined.requests.map((row) => row.id), ["j-a"]);
  assert.deepEqual(
    confined.options.map((option) => option.id),
    ["site-option-site-a", "status-done"],
    "another store's option goes; so does a chip naming no store; other columns' options stay",
  );
  assert.deepEqual(confined.groups, boardPayload().groups, "the board's own structure is sent as it is");
  assert.deepEqual(confined.columns, boardPayload().columns);
});

test("confineBoardPayload with ?compact=1 — no request rows — looks each job's site up", async () => {
  const { db } = estate();
  const compact = { ...boardPayload(), requests: [] };
  const confined = await confineBoardPayload(db, "org", compact, ["site-b"]);
  assert.deepEqual(confined.items.map((item) => item.requestId), ["j-b"]);
  assert.deepEqual(confined.cells.map((cell) => cell.requestId), ["j-b"]);
  /* The lookup is organisation-scoped: another tenant's `j-x` at `site-a` is never consulted. */
  const foreign = { ...boardPayload(), requests: [], items: [{ id: "i-x", requestId: "j-x" }] };
  assert.deepEqual((await confineBoardPayload(db, "org", foreign, ["site-a"])).items, []);
});

test("confineBoardPayload: a malformed restriction is sent no jobs at all", async () => {
  const { db } = estate();
  const confined = await confineBoardPayload(db, "org", boardPayload(), parseSiteScope("{oops"));
  for (const key of ["items", "cells", "fileCounts", "notRequired", "requests"]) {
    assert.deepEqual(confined[key], [], key);
  }
  assert.deepEqual(confined.options.map((option) => option.id), ["status-done"]);
});

const anchors = (fields) => ({ requestId: "", siteId: "", unitId: "", contractorId: "", ...fields });

test("uploadOutsideSiteScope: an unrestricted member is never refused and costs no query", async () => {
  const exploding = new Proxy({}, { get: () => { throw new Error("an unrestricted member must not query"); } });
  for (const filed of [anchors({ requestId: "j-b" }), anchors({ siteId: "site-b" }), anchors({})]) {
    assert.equal(await uploadOutsideSiteScope(exploding, "org", null, filed, ""), false);
    assert.equal(await uploadOutsideSiteScope(exploding, "org", null, filed, "doc-b"), false);
  }
});

test("uploadOutsideSiteScope: every anchor the upload is filed against must be one of the member's sites", async () => {
  const { db } = estate();
  const scope = ["site-a"];
  const cases = [
    [anchors({ requestId: "j-a" }), false, "a job at their site"],
    [anchors({ siteId: "site-a" }), false, "their site"],
    [anchors({ unitId: "u-a" }), false, "an asset at their site"],
    [anchors({ contractorId: "c-a" }), false, "a contractor linked to their site"],
    [anchors({ requestId: "j-b" }), true, "a job at another site"],
    [anchors({ siteId: "site-b" }), true, "another site"],
    [anchors({ unitId: "u-b" }), true, "an asset at another site"],
    [anchors({ contractorId: "c-b" }), true, "a contractor linked only elsewhere"],
    [anchors({ requestId: "j-none" }), true, "a job with no site — Phase 9's Q5 rule"],
    [anchors({ requestId: "j-missing" }), true, "a job that does not resolve"],
    [anchors({ requestId: "j-x" }), true, "another organisation's job"],
    [anchors({ requestId: "j-a", siteId: "site-b" }), true, "one anchor in, one out: the weaker decides"],
  ];
  for (const [filed, expected, why] of cases) {
    assert.equal(await uploadOutsideSiteScope(db, "org", scope, filed, ""), expected, why);
  }
});

test("uploadOutsideSiteScope: a new version is refused when the document it replaces is outside the scope", async () => {
  const { db } = estate();
  const scope = ["site-a"];
  assert.equal(await uploadOutsideSiteScope(db, "org", scope, anchors({ requestId: "j-a" }), "doc-a"), false);
  assert.equal(
    await uploadOutsideSiteScope(db, "org", scope, anchors({ siteId: "site-a" }), "doc-site-b"),
    true,
    "re-filing at their own site does not let them supersede another store's document",
  );
  assert.equal(await uploadOutsideSiteScope(db, "org", scope, anchors({ requestId: "j-a" }), "doc-b"), true);
  assert.equal(
    await uploadOutsideSiteScope(db, "org", scope, anchors({ requestId: "j-a" }), "doc-missing"),
    false,
    "a predecessor that does not resolve is `planVersion`'s 404 to give",
  );
  assert.equal(
    await uploadOutsideSiteScope(db, "org", parseSiteScope("[]"), anchors({ requestId: "j-a" }), ""),
    true,
    "a malformed restriction uploads nowhere",
  );
});

/* ── 3. Every read and both upload doors are pinned to the rule ──────────── */

const handler = (source, name) => {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} has moved; fix this test`);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end > 0 ? end : undefined);
};

test("GET /api/board confines the finished payload to the member's sites", async () => {
  const get = code(handler(await read("app/api/board/route.ts"), "GET"));
  assert.match(get, /const payload = await confineBoardPayload\(\s*db,\s*orgId,\s*await boardPayload\(/);
  assert.match(get, /guard\.scope\.siteScope,\s*\);\s*return Response\.json\(compact \? compactBoard\(payload\) : payload\);/);
});

test("GET /api/maintenance confines the list in SQL and the single job by id", async () => {
  const get = code(handler(await read("app/api/maintenance/route.ts"), "GET"));
  assert.match(get, /const \{ db, orgId, siteScope \} = guard\.scope;/);
  const conditions = get.match(/memberSiteCondition\(maintenanceRequests\.siteId, siteScope\)/g) ?? [];
  assert.equal(conditions.length, 2, "one on the job by id, one on the paged list");
  assert.match(get, /eq\(maintenanceRequests\.id, requestId\),[\s\S]{0,200}?memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/);
  /* In SQL, before the page is cut, so `limit`/`offset`/`hasMore` stay exact. */
  assert.match(get, /memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),\s*\),\s*\)\s*\.orderBy\(desc\(maintenanceRequests\.requestedAt\)\)\s*\.limit\(limit \+ 1\)/);
});

test("GET /api/maintenance/calendar confines the events", async () => {
  const get = code(handler(await read("app/api/maintenance/calendar/route.ts"), "GET"));
  assert.match(get, /const confined = memberSiteCondition\(calendarEvents\.siteId, viewGuard\.scope\.siteScope\);\s*if \(confined\) conditions\.push\(confined\);/);
});

test("GET /api/updates answers a job outside the scope as a missing one", async () => {
  const get = code(handler(await read("app/api/updates/route.ts"), "GET"));
  assert.match(get, /\(\{ db, orgId, actor, siteScope \} = viewGuard\.scope\);/);
  assert.match(get, /isNull\(maintenanceRequests\.deletedAt\),\s*memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/);
  assert.match(get, /if \(!job\) \{\s*return Response\.json\(\{ error: "Job not found\." \}, \{ status: 404 \}\);/);
});

test("GET /api/reminders reads a record's reminders only when the record is at the member's sites", async () => {
  const source = await read("app/api/reminders/route.ts");
  const get = code(handler(source, "GET"));
  assert.match(get, /const \{ db, orgId, siteScope \} = guard\.scope;/);
  assert.match(
    get,
    /if \(siteScope && !\(await subjectWithinScope\(db, orgId, subjectType, subjectId, siteScope\)\)\) \{\s*return Response\.json\(\{ reminders: \[\] \}\);/,
  );
  const within = source.slice(source.indexOf("async function subjectWithinScope("), source.indexOf("export async function GET("));
  assert.match(within, /const allowed = memberSiteSet\(siteScope\);/, "the shared rule, not a second copy of it");
  for (const table of ["calendarEvents", "maintenanceRequests", "complianceDocuments"]) {
    assert.match(within, new RegExp(`\\.from\\(${table}\\)`), `${table} is one of the records a reminder hangs off`);
  }
  assert.equal((within.match(/withinMemberScope\(allowed, \w+\.siteId\)/g) ?? []).length, 3, "each record's site, by the one rule");
  assert.match(within, /return false;\s*\}\s*$/, "an unrecognised or missing record is outside the scope");
});

test("GET /api/registers sends a restricted member only their sites' values", async () => {
  const get = code(handler(await read("app/api/registers/route.ts"), "GET"));
  assert.match(get, /const allowed = named\.register === "sites" \? memberSiteSet\(scope\.siteScope\) : null;/);
  assert.match(get, /Object\.entries\(values\)\.filter\(\(\[siteId\]\) => withinMemberScope\(allowed, siteId\)\)/);
  assert.match(get, /values: visibleValues,/);
});

test("GET /api/context offers only the member's own sites", async () => {
  const source = code(await read("app/api/context/route.ts"));
  assert.match(
    source,
    /registerScopeFilter\(sites\.boardId, CANONICAL_REGISTER\),\s*memberSiteCondition\(sites\.id, context\.siteScope\),/,
  );
});

test("both upload doors ask the member's sites, after the grant and before the bytes", async () => {
  const direct = code(await read("app/api/files/route.ts"));
  const check = direct.indexOf("uploadOutsideSiteScope(db, orgId, scope.siteScope, filedAgainst, replacesId)");
  assert.ok(check > 0, "the direct route asks the rule of what the row will be filed against");
  assert.ok(direct.indexOf("const filedAgainst = effectiveAnchors(") < check, "after the anchors are known");
  assert.ok(check < direct.indexOf("signatureMatches(file.type"), "before the bytes are inspected");
  assert.ok(check < direct.indexOf(".put("), "before anything is stored");
  assert.match(direct, /authority\.via === "capability" &&\s*\(await uploadOutsideSiteScope\(/, "a link's grant is not the member's");
  assert.match(direct, /return Response\.json\(\{ error: UPLOAD_OUTSIDE_SCOPE \}, \{ status: 404 \}\);/);

  const multipart = code(await read("app/api/files/multipart/route.ts"));
  const authorize = multipart.slice(multipart.indexOf("async function authorizeUpload("), multipart.indexOf("export async function POST("));
  const denied = authorize.indexOf("if (authority.denied) return { response: authority.denied } as const;");
  const scoped = authorize.indexOf("uploadOutsideSiteScope(db, orgId, scope.siteScope, keyAnchors, replacesId)");
  assert.ok(denied > 0 && scoped > denied, "multipart asks on every action, after the grant");
  assert.match(authorize, /authority\.via === "capability" &&\s*\(await uploadOutsideSiteScope\(/);
  assert.equal(UPLOAD_OUTSIDE_SCOPE, "The record this file is for was not found.");
});

test("the upload doors and the document doors share ONE rule", async () => {
  const documents = await read("app/api/files/documents.ts");
  const upload = documents.slice(documents.indexOf("export async function uploadOutsideSiteScope("));
  /* Re-pointed 2026-09-22 (security review): the empty-scope fail-open was closed — see `memberSiteCondition`. An empty scope is a restriction to no site, and reaches nothing. */
  assert.match(upload, /if \(!siteScope\) return false;\s*if \(!siteScope\.length\) return true;/, "unrestricted: out before the first query; empty: nothing");
  assert.equal((upload.match(/outsideSiteScope\(db, orgId, siteScope, /g) ?? []).length, 2, "filed anchors, then the predecessor");
  assert.match(documents, /export async function outsideSiteScope\(/);
  const byId = await read("app/api/files/[id]/route.ts");
  assert.doesNotMatch(byId, /async function outsideSiteScope\(/, "no second copy left behind");
});

test("parseSiteScope is the one place site_scope is read, and it fails closed", async () => {
  const grants = code(await read("app/lib/tenant-grants.ts"));
  assert.match(grants, /if \(value === null \|\| value === undefined\) return null;/);
  assert.match(grants, /if \(!Array\.isArray\(parsed\)\) return \[SITE_OUTSIDE_SCOPE\];/);
  assert.match(grants, /return ids\.length \? ids : \[SITE_OUTSIDE_SCOPE\];/);
  assert.match(grants, /catch \{\s*return \[SITE_OUTSIDE_SCOPE\];/);
  assert.doesNotMatch(grants, /return ids\.length \? ids : null;/, "the fail-open answer is gone");
});

/* ── 4. Against the running estate ────────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const ORG = "org_000000000000000000000001";
/* The address shape `scripts/clean-test-accounts.mjs` sweeps, so an interrupted
   run's fixtures are still recognisably test accounts. */
const RUN = `scope-reads-${Date.now().toString(36)}`;
const CONFINED = `${RUN}-confined@example.com`;
const MALFORMED = `${RUN}-malformed@example.com`;

const as = (email) => ({ "x-maintsupp-identity": email, Accept: "application/json" });
const getJson = async (url, email) => {
  const response = await fetch(`${BASE}${url}`, { headers: as(email) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
};

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/maintenance?limit=1`, { headers: as(ADMIN), signal: AbortSignal.timeout(8000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function openDevDatabase() {
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
  } catch {
    return null;
  }
  if (!file) return null;
  const db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  /* The dev server holds this file open; wait for its writer rather than lose the race. */
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/** A purpose-built admin of the dev organisation with `site_scope` written as given. */
function addMember(db, email, label, siteScope) {
  const userId = `user-${RUN}-${label}`;
  db.prepare(
    "INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, ?, 'admin', 1)",
  ).run(userId, ORG, email, `Scope reads probe (${label})`);
  db.prepare(
    `INSERT INTO memberships (id, user_id, organisation_id, role, status, accepted_at, site_scope)
     VALUES (?, ?, ?, 'admin', 'active', CURRENT_TIMESTAMP, ?)`,
  ).run(`membership-${userId}-${ORG}`, userId, ORG, siteScope);
}

after(async () => {
  const db = await openDevDatabase().catch(() => null);
  if (!db) return;
  try {
    db.prepare("DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)").run(`${RUN}%`);
    db.prepare("DELETE FROM users WHERE email LIKE ?").run(`${RUN}%`);
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    db.close();
  }
});

async function upload(email, fields) {
  const form = new FormData();
  form.set("file", new Blob(["not a png"], { type: "image/png" }), "scope-probe.png");
  form.set("kind", "issue");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await fetch(`${BASE}/api/files`, { method: "POST", headers: as(email), body: form });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a bare-text refusal */
  }
  return { status: response.status, error: json?.error ?? text };
}

test("LIVE a member confined to one store reads only that store's jobs, and cannot file elsewhere", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const db = await openDevDatabase();
  if (!db) {
    t.skip("no development database to add a restricted member to");
    return;
  }

  /* The unrestricted view first: which stores hold live jobs. */
  const everything = await getJson("/api/maintenance?limit=2000", ADMIN);
  assert.equal(everything.status, 200);
  const bySite = new Map();
  for (const job of everything.body.requests) {
    if (!job.siteId) continue;
    bySite.set(job.siteId, [...(bySite.get(job.siteId) ?? []), job]);
  }
  const ranked = [...bySite.entries()].sort((a, b) => b[1].length - a[1].length);
  if (ranked.length < 2) {
    db.close();
    t.skip("the dev estate needs jobs at two stores to prove a narrowing");
    return;
  }
  const [site, ownJobs] = ranked[0];
  const otherJobs = ranked[1][1];
  const own = new Set(ownJobs.map((job) => job.id));
  const adminBoard = await getJson("/api/board", ADMIN);
  const adminContext = await getJson("/api/context", ADMIN);
  const adminCalendar = await getJson("/api/maintenance/calendar", ADMIN);

  /* A site row that exists and is not theirs — a job's `site_id` need not name one. */
  const otherSite = db.prepare("SELECT id FROM sites WHERE organisation_id = ? AND id <> ? ORDER BY id LIMIT 1").get(ORG, site)?.id;
  try {
    addMember(db, CONFINED, "confined", JSON.stringify([site]));
    addMember(db, MALFORMED, "malformed", "{not json");
  } finally {
    db.close();
  }

  /* /api/maintenance — the list is exactly the store's jobs, in SQL. */
  const list = await getJson("/api/maintenance?limit=2000", CONFINED);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.requests.map((job) => job.id).sort(), [...own].sort(), "the list is the store's jobs, by id");
  const paged = await getJson("/api/maintenance?limit=1", CONFINED);
  assert.equal(paged.body.requests.length, 1);
  assert.equal(paged.body.hasMore, own.size > 1, "paging counts the member's rows, not the organisation's");
  assert.equal((await getJson(`/api/maintenance?id=${encodeURIComponent(ownJobs[0].id)}`, CONFINED)).status, 200);
  assert.equal((await getJson(`/api/maintenance?id=${encodeURIComponent(otherJobs[0].id)}`, CONFINED)).status, 404);

  /* /api/board — placements, cells and rows only for the store's jobs. */
  const board = await getJson("/api/board", CONFINED);
  assert.equal(board.status, 200);
  for (const item of board.body.items) assert.ok(own.has(item.requestId), `board item ${item.requestId}`);
  for (const cell of board.body.cells) assert.ok(own.has(cell.requestId), `board cell ${cell.requestId}`);
  for (const row of board.body.requests) assert.equal(row.siteId, site, `board row ${row.id}`);
  for (const option of board.body.options.filter((entry) => entry.columnKey === "storeLocation")) {
    assert.equal(option.id, `site-option-${site}`, "the Location list offers only their store");
  }
  assert.ok(board.body.items.length < adminBoard.body.items.length, "the board narrowed");
  assert.deepEqual(board.body.groups.map((group) => group.id), adminBoard.body.groups.map((group) => group.id), "groups are the board's");
  /* `?compact=1` names every row once, in `rowIds`; items and cells point into it. */
  const compact = await getJson("/api/board?compact=1", CONFINED);
  assert.equal(compact.body.compact, 1);
  for (const rowId of compact.body.rowIds) assert.ok(own.has(rowId), `compact row ${rowId}`);
  assert.equal(compact.body.items.length, board.body.items.length);

  /* /api/maintenance/calendar — only events at their store. */
  const calendar = await getJson("/api/maintenance/calendar", CONFINED);
  assert.equal(calendar.status, 200);
  for (const event of calendar.body.events) assert.equal(event.siteId, site, `calendar event ${event.id}`);
  assert.ok(calendar.body.events.length <= adminCalendar.body.events.length);

  /* /api/updates and /api/reminders — a job at another store is not theirs. */
  assert.equal((await getJson(`/api/updates?requestId=${encodeURIComponent(ownJobs[0].id)}`, CONFINED)).status, 200);
  assert.equal((await getJson(`/api/updates?requestId=${encodeURIComponent(otherJobs[0].id)}`, CONFINED)).status, 404);
  const reminders = await getJson(`/api/reminders?subjectType=job&subjectId=${encodeURIComponent(otherJobs[0].id)}`, CONFINED);
  assert.equal(reminders.status, 200);
  assert.deepEqual(reminders.body.reminders, []);

  /* /api/registers — the sites register holds only their store's values. */
  const register = await getJson("/api/registers?register=sites", CONFINED);
  assert.equal(register.status, 200);
  for (const siteId of Object.keys(register.body.values)) assert.equal(siteId, site, `register values for ${siteId}`);

  /* /api/context — no store name outside the scope. */
  const context = await getJson("/api/context", CONFINED);
  assert.equal(context.status, 200);
  const offered = context.body.context.requestConfiguration.sites;
  for (const entry of offered) assert.equal(entry.id, site, `context names ${entry.name}`);
  const adminOffered = adminContext.body.context.requestConfiguration.sites;
  assert.equal(
    offered.length,
    adminOffered.some((entry) => entry.id === site) ? 1 : 0,
    "their store when the register offers it, and nothing else",
  );

  /* Uploads: anchored at another store — refused before the bytes are read. */
  const outsideJob = await upload(CONFINED, { requestId: otherJobs[0].id });
  assert.equal(outsideJob.status, 404);
  assert.equal(outsideJob.error, UPLOAD_OUTSIDE_SCOPE);
  if (otherSite) {
    const outsideSite = await upload(CONFINED, { siteId: otherSite });
    assert.equal(outsideSite.status, 404);
    assert.equal(outsideSite.error, UPLOAD_OUTSIDE_SCOPE, "a site anchor at another store");
  }
  const multipart = await fetch(`${BASE}/api/files/multipart`, {
    method: "POST",
    headers: { ...as(CONFINED), "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", requestId: otherJobs[0].id, kind: "issue", fileName: "scope-probe.mp4", contentType: "video/mp4", size: 2_000_000 }),
  });
  assert.equal(multipart.status, 404, "the multipart door refuses at start");
  assert.equal((await multipart.json()).error, UPLOAD_OUTSIDE_SCOPE);
  /* At their own store the gate passes, and the next check along — the file's
     own bytes, which are not a PNG — is what refuses. Nothing is stored. */
  const inside = await upload(CONFINED, { requestId: ownJobs[0].id });
  assert.equal(inside.status, 415, `own store passes the gate (${inside.error})`);
  /* And the unrestricted admin is never refused by it. */
  const admin = await upload(ADMIN, { requestId: otherJobs[0].id });
  assert.equal(admin.status, 415, `an unrestricted admin passes the gate (${admin.error})`);

  /* A malformed restriction: nothing, anywhere. */
  const nothing = await getJson("/api/maintenance?limit=2000", MALFORMED);
  assert.equal(nothing.status, 200);
  assert.deepEqual(nothing.body.requests, []);
  assert.deepEqual((await getJson("/api/board", MALFORMED)).body.items, []);
  assert.deepEqual((await getJson("/api/maintenance/calendar", MALFORMED)).body.events, []);
  assert.deepEqual((await getJson("/api/context", MALFORMED)).body.context.requestConfiguration.sites, []);
  assert.deepEqual(Object.keys((await getJson("/api/registers?register=sites", MALFORMED)).body.values), []);
  assert.equal((await getJson(`/api/maintenance?id=${encodeURIComponent(ownJobs[0].id)}`, MALFORMED)).status, 404);
  assert.equal((await upload(MALFORMED, { requestId: ownJobs[0].id })).error, UPLOAD_OUTSIDE_SCOPE);

  /* The unrestricted admin's view did not move while the probes existed. */
  const again = await getJson("/api/maintenance?limit=2000", ADMIN);
  assert.deepEqual(again.body.requests.map((job) => job.id), everything.body.requests.map((job) => job.id));
  assert.equal((await getJson("/api/board", ADMIN)).body.items.length, adminBoard.body.items.length);
});
