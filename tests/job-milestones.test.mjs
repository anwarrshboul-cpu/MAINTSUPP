/**
 * A JOB'S ACKNOWLEDGED, ASSIGNED AND ATTENDED TIMES — the owner's decision N.
 *
 *   - ACKNOWLEDGED: the first explicit human acknowledgement, or the first
 *     meaningful human handling event. An automation never acknowledges, and
 *     raising a job is not answering it.
 *   - ASSIGNED: the first actual assignment of a responsible person or an
 *     engineer — the write in which the job goes from none to one.
 *   - ATTENDED: only ever explicit ("Record attendance"); never inferred from a
 *     stage or a status.
 *   - All three write-once, in the existing §23 history, audited; nothing
 *     historical invented, nothing backfilled.
 *
 * The rules are CALLED; the writer runs against a REAL SQLite (node:sqlite behind
 * drizzle's sqlite-proxy) with the migration's own history DDL; every door is
 * pinned in its source; the live half walks a real job through the doors on the
 * dev server and skips when none answers.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const milestones = await import("../app/lib/job-milestones.ts");
const { impliedMilestones, hasAssignment, instantOf, withinRecording } = milestones;

/* ================================================================== */
/* The rules                                                            */
/* ================================================================== */

const person = { human: true, handled: true };
const creation = { human: false, handled: false };
const rule = { human: false, handled: false };

test("a person handling a job acknowledges it; a rule and a creation never do", () => {
  assert.deepEqual(impliedMilestones({ requestId: "a", before: {}, after: {} }, person), ["acknowledged"]);
  assert.deepEqual(impliedMilestones({ requestId: "a", before: {}, after: {} }, rule), []);
  assert.deepEqual(impliedMilestones({ requestId: "a", before: null, after: { assignee: "" } }, creation), []);
  /* A person creating a job (board create, a duplicate) has not handled it. */
  assert.deepEqual(impliedMilestones({ requestId: "a", before: null, after: {} }, { human: true, handled: false }), []);
});

test("the write that gives a job a person or an engineer assigns it — whoever made it", () => {
  assert.deepEqual(impliedMilestones({ requestId: "a", before: { assignee: "" }, after: { assignee: "Sam" } }, person), ["acknowledged", "assigned"]);
  assert.deepEqual(impliedMilestones({ requestId: "a", before: { contractorId: null }, after: { contractorId: "c1" } }, rule), ["assigned"], "a rule that assigns really assigns");
  assert.deepEqual(impliedMilestones({ requestId: "a", before: null, after: { contractor: "Acme Ltd" } }, creation), ["assigned"], "a planned visit raised with its contractor");
  /* Already assigned: a later edit or reassignment is not the first assignment. */
  assert.deepEqual(impliedMilestones({ requestId: "a", before: { assignee: "Sam" }, after: { assignee: "Jo" } }, person), ["acknowledged"]);
  /* Clearing the assignee assigns nobody. */
  assert.deepEqual(impliedMilestones({ requestId: "a", before: { assignee: "Sam" }, after: { assignee: "" } }, person), ["acknowledged"]);
  /* `engineer` is the trade the job needs, not a person. */
  assert.equal(hasAssignment({ engineer: "Plumber" }), false);
  assert.equal(hasAssignment({ assigneeUserId: "u1" }), true);
  assert.equal(hasAssignment({ assignee: "   " }), false);
});

test("attendance is only ever explicit, and recording it acknowledges the job", () => {
  assert.deepEqual(impliedMilestones({ requestId: "a", before: null, after: null, explicit: ["attended"] }, person), ["acknowledged", "attended"]);
  assert.deepEqual(impliedMilestones({ requestId: "a", before: null, after: null, explicit: ["acknowledged"] }, person), ["acknowledged"]);
  /* No stage or status name implies it — there is no input that could. */
  assert.deepEqual(impliedMilestones({ requestId: "a", before: { stage: "Booked" }, after: { stage: "Attended", status: "On site" } }, person), ["acknowledged"]);
  const source = code(readFileSync(path.join(root, "app/lib/job-milestones.ts"), "utf8"));
  assert.doesNotMatch(source, /\.stage\b|\.status\b|On site/, "no stage or status is read at all");
});

test("a time from either dialect is read, and only rows CREATED inside the recording qualify", () => {
  const expected = Date.parse("2026-09-22T10:00:00Z");
  assert.equal(instantOf("2026-09-22T10:00:00.000Z"), expected);
  assert.equal(instantOf("2026-09-22 10:00:00"), expected, "SQLite CURRENT_TIMESTAMP is UTC");
  assert.equal(instantOf("2026-09-22 10:00:00+00"), expected, "Postgres timestamptz as text");
  assert.equal(instantOf("2026-09-22 11:00:00+01:00"), expected);
  assert.ok(Number.isNaN(instantOf("")));
  assert.equal(withinRecording("2026-09-22 10:00:01", "2026-09-22T10:00:00.000Z"), true);
  assert.equal(withinRecording("2026-07-01T09:00:00Z", "2026-09-22T10:00:00.000Z"), false, "a row that existed before: nothing invented");
  assert.equal(withinRecording("2026-09-23T09:00:00Z", null), false, "no epoch, nothing recorded");
});

/*
 * THE GATE IS THE ROW'S BIRTH, NOT THE REQUEST DATE, and the three ways that
 * matters are all reachable from the product: a job raised today FOR last week
 * (the drawer's own Date requested field), a duplicate of an old job, which
 * copies `requested_at` verbatim, and a historical job whose request date is
 * corrected forward. Under a `requested_at` gate the first two could never
 * record anything and the third would silently start recording invented times.
 */
test("the eligibility gate reads created_at, which nothing in the product can edit", async () => {
  const lib = code(readFileSync(path.join(root, "app/lib/job-milestones.ts"), "utf8"));
  assert.match(lib, /cast\(\$\{maintenanceRequests\.createdAt\} as text\) as created_at/);
  assert.doesNotMatch(lib, /requestedAt|requested_at/, "the request date is not consulted at all");
  assert.match(lib, /withinRecording\(row\.createdAt, epoch\)/);
  const route = code(await read("app/api/maintenance/milestones/route.ts"));
  assert.match(route, /withinRecording\(row\?\.createdAt \?\? null, epoch\)/);
  /* And `requested_at` is a live, editable cell — which is why it cannot be the gate. */
  assert.match(code(await read("app/lib/request-fields.ts")), /requested/);
});

/* ================================================================== */
/* The writer — a real SQLite                                           */
/* ================================================================== */

const EPOCH = "2026-09-22T10:00:00.000Z";

async function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE organisations (id TEXT PRIMARY KEY);
    INSERT INTO organisations VALUES ('org_a'), ('org_b');
    CREATE TABLE maintenance_requests (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, requested_at TEXT, created_at TEXT, deleted_at TEXT, parent_id TEXT,
      acknowledged_at TEXT, assigned_at TEXT, attended_at TEXT);
    CREATE TABLE maintenance_group_items (request_id TEXT PRIMARY KEY, organisation_id TEXT, board_id TEXT NOT NULL DEFAULT 'maintenance');
    CREATE TABLE audit_events (id TEXT PRIMARY KEY, organisation_id TEXT, actor_user_id TEXT, actor_email TEXT, actor_role TEXT, action TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, summary TEXT NOT NULL, detail TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  const init = await read("db/init.ts");
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS job_status_history \([\s\S]*?\))`/)[1]);
  sqlite.exec(init.match(/`(CREATE TABLE IF NOT EXISTS feature_epochs \([\s\S]*?\))`/)[1]);
  sqlite.prepare("INSERT OR IGNORE INTO feature_epochs (feature, started_at) VALUES (?, ?)").run("job_milestones", EPOCH);
  const insert = sqlite.prepare("INSERT INTO maintenance_requests (id, organisation_id, requested_at, created_at, parent_id) VALUES (?, ?, ?, ?, ?)");
  /* Created after recording began — including one raised FOR a date long before
     it, which is an ordinary thing to do and must still record. */
  insert.run("MN-1", "org_a", "2026-09-22 11:00:00", "2026-09-22 11:00:00", null);
  insert.run("MN-2", "org_a", "2026-09-22T12:00:00.000Z", "2026-09-22T12:00:00.000Z", null);
  insert.run("MN-BACKDATED", "org_a", "2026-03-04T08:00:00.000Z", "2026-09-22T12:00:00.000Z", null);
  /* The row itself predates the recording. */
  insert.run("MN-OLD", "org_a", "2026-07-01T09:00:00.000Z", "2026-07-01T09:00:00.000Z", null);
  /* A duplicate of that old job: its request date is the original's, its row is new. */
  insert.run("MN-COPY", "org_a", "2026-07-01T09:00:00.000Z", "2026-09-22T13:00:00.000Z", null);
  insert.run("MN-SUB", "org_a", "2026-09-22T12:00:00.000Z", "2026-09-22T12:00:00.000Z", "MN-1");
  insert.run("SD-1", "org_a", "2026-09-22T12:00:00.000Z", "2026-09-22T12:00:00.000Z", null);
  insert.run("MN-B", "org_b", "2026-09-22T12:00:00.000Z", "2026-09-22T12:00:00.000Z", null);
  sqlite.prepare("INSERT INTO maintenance_group_items (request_id, organisation_id, board_id) VALUES (?, ?, ?)").run("SD-1", "org_a", "store-documentation");
  sqlite.prepare("INSERT INTO maintenance_group_items (request_id, organisation_id, board_id) VALUES (?, ?, ?)").run("MN-1", "org_a", "maintenance");
  /*
   * The writer's only reads are raw `db.all(sql…)` statements, which the D1 and
   * Postgres drivers answer with NAMED rows — so "all" answers with objects here
   * too. Its writes are `insert`s and raw `update … returning`, both of which
   * work the same way.
   */
  const db = drizzle(async (statement, params, method) => {
    const prepared = sqlite.prepare(statement);
    const values = params.map((value) => (value === undefined ? null : value));
    if (method === "run") {
      prepared.run(...values);
      return { rows: [] };
    }
    const rows = prepared.all(...values).map((row) => ({ ...row }));
    return { rows: method === "get" ? rows[0] : rows };
  });
  milestones.forgetMilestoneEpoch();
  return { sqlite, db };
}

const stamps = (sqlite, id) => ({ ...sqlite.prepare("SELECT acknowledged_at, assigned_at, attended_at FROM maintenance_requests WHERE id = ?").get(id) });

test("each milestone is stamped once, in the history and the audit log, and a second write never moves it", async () => {
  const { sqlite, db } = await database();
  const first = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "coordinator@example.com", source: "job.edit", human: true, handled: true,
    changes: [{ requestId: "MN-1", before: { assignee: "" }, after: { assignee: "Sam" } }],
  });
  assert.deepEqual(first.map((entry) => entry.milestone).sort(), ["acknowledged", "assigned"]);
  const once = stamps(sqlite, "MN-1");
  assert.ok(once.acknowledged_at && once.assigned_at && !once.attended_at);

  const again = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "someone@example.com", source: "board.bulk", human: true, handled: true,
    changes: [{ requestId: "MN-1", before: { assignee: "" }, after: { assignee: "Jo" } }],
  });
  assert.deepEqual(again, [], "write-once: nothing new");
  assert.deepEqual(stamps(sqlite, "MN-1"), once);

  const history = sqlite.prepare("SELECT field, from_value, to_value, actor_email, source FROM job_status_history ORDER BY to_value").all().map((row) => ({ ...row }));
  assert.deepEqual(history, [
    { field: "milestone", from_value: null, to_value: "acknowledged", actor_email: "coordinator@example.com", source: "job.edit" },
    { field: "milestone", from_value: null, to_value: "assigned", actor_email: "coordinator@example.com", source: "job.edit" },
  ]);
  const audit = sqlite.prepare("SELECT action, entity_id, organisation_id FROM audit_events ORDER BY action").all().map((row) => ({ ...row }));
  assert.deepEqual(audit, [
    { action: "job.acknowledged", entity_id: "MN-1", organisation_id: "org_a" },
    { action: "job.assigned", entity_id: "MN-1", organisation_id: "org_a" },
  ]);
});

test("two writers at once record one time, not two", async () => {
  const { sqlite, db } = await database();
  const write = () => milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "a@example.com", source: "job.milestone", human: true, handled: true,
    changes: [{ requestId: "MN-2", before: null, after: null, explicit: ["attended"] }],
  });
  const [left, right] = await Promise.all([write(), write()]);
  assert.equal(left.filter((e) => e.milestone === "attended").length + right.filter((e) => e.milestone === "attended").length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM job_status_history WHERE to_value = 'attended'").get().n, 1);
});

test("a job raised for an earlier date, and a duplicate of an old one, both record", async () => {
  const { sqlite, db } = await database();
  const recorded = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "a@example.com", source: "job.edit", human: true, handled: true,
    changes: ["MN-BACKDATED", "MN-COPY"].map((requestId) => ({ requestId, before: null, after: null })),
  });
  assert.deepEqual(recorded.map((entry) => entry.requestId).sort(), ["MN-BACKDATED", "MN-COPY"]);
  for (const id of ["MN-BACKDATED", "MN-COPY"]) {
    assert.ok(stamps(sqlite, id).acknowledged_at, `${id} records: its ROW was created inside the recording`);
  }
});

test("nothing is invented: an old row, a register row, a subitem and another workspace's job get nothing", async () => {
  const { sqlite, db } = await database();
  const recorded = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "a@example.com", source: "job.edit", human: true, handled: true,
    changes: ["MN-OLD", "SD-1", "MN-SUB", "MN-B"].map((requestId) => ({ requestId, before: null, after: { assignee: "Sam" } })),
  });
  assert.deepEqual(recorded, []);
  for (const id of ["MN-OLD", "SD-1", "MN-SUB", "MN-B"]) {
    assert.deepEqual(stamps(sqlite, id), { acknowledged_at: null, assigned_at: null, attended_at: null }, id);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM job_status_history").get().n, 0);
});

test("an automation assigns but never acknowledges, and a broken store never fails the change", async () => {
  const { sqlite, db } = await database();
  const recorded = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: null, source: "automation", human: false, handled: false,
    changes: [{ requestId: "MN-2", before: { assignee: null }, after: { assignee: "Sam" } }],
  });
  assert.deepEqual(recorded.map((e) => e.milestone), ["assigned"]);
  assert.equal(stamps(sqlite, "MN-2").acknowledged_at, null);
  sqlite.exec("DROP TABLE job_status_history");
  const broken = await milestones.recordJobMilestones(db, {
    organisationId: "org_a", actorEmail: "a@example.com", source: "job.edit", human: true, handled: true,
    changes: [{ requestId: "MN-2", before: null, after: null }],
  });
  assert.ok(Array.isArray(broken), "it answered rather than throwing");
  /* WRITE-ONCE MAKES THIS LOAD-BEARING: the column was stamped before the
     history insert failed, and the caller can never retry, so what was stamped
     must come back rather than an empty list. */
  assert.deepEqual(broken.map((entry) => entry.milestone), ["acknowledged"]);
  assert.ok(stamps(sqlite, "MN-2").acknowledged_at);
});

test("the audit row names the account and the role, as every other audited action does", async () => {
  const { sqlite, db } = await database();
  await milestones.recordJobMilestones(db, {
    organisationId: "org_a",
    actorEmail: "coordinator@example.com",
    actor: { userId: "usr_1", email: "coordinator@example.com", role: "admin" },
    source: "job.milestone", human: true, handled: true,
    changes: [{ requestId: "MN-1", before: null, after: null, explicit: ["acknowledged"] }],
  });
  const row = { ...sqlite.prepare("SELECT actor_user_id, actor_email, actor_role FROM audit_events").get() };
  assert.deepEqual(row, { actor_user_id: "usr_1", actor_email: "coordinator@example.com", actor_role: "admin" });
});

test("the epoch is re-read after a miss, so recording cannot stay off for the life of an instance", async () => {
  const lib = code(readFileSync(path.join(root, "app/lib/job-milestones.ts"), "utf8"));
  assert.match(lib, /if \(value === null\) epochMemo = null;/);
});

/* ================================================================== */
/* The doors, pinned                                                    */
/* ================================================================== */

test("every door that handles or assigns a job records its milestones, and says whether a person did it", async () => {
  const doors = [
    ["app/api/maintenance/route.ts", /recordJobMilestones\(db, \{[\s\S]{0,200}?source: "job\.edit",\s*human: true,\s*handled: true,\s*changes: \[\{ requestId: id, before: before \?\? null, after: updated \}\]/],
    ["app/lib/board-mutations.ts", /if \(source === "board\.move" && movedFrom\.length\) \{\s*await recordJobMilestones\(db, \{[\s\S]*?human: true,\s*handled: true,/],
    ["app/api/board/route.ts", /if \(existingItem\.groupId !== groupId\) \{\s*await recordJobMilestones\(db, \{[\s\S]*?source: "board\.move",\s*human: true,/],
    ["app/api/board/route.ts", /setBoardCell\(db, orgId, boardId, requestId, columnId, value\);\s*await recordJobMilestones\(db, \{[\s\S]*?source: "board\.cell",/],
    ["app/api/board/items/route.ts", /source: "board\.bulk",\s*human: true,\s*handled: true,\s*changes: afterRows\.map\(\(row\) => \(\{ requestId: row\.id, before: beforeRows\.get\(row\.id\) \?\? null, after: row \}\)\)/],
    ["app/api/board/items/route.ts", /source: "board\.cell",\s*human: true,/],
    ["app/lib/automations/actions.ts", /source: "automation",\s*human: false,\s*handled: false,\s*changes: \[\{ requestId: item\.id, before: item, after: updated \}\]/],
    ["app/lib/submission-service.ts", /source: `created:\$\{input\.source\}`,\s*human: false,\s*handled: false,/],
    ["app/api/updates/route.ts", /source: "update\.posted",\s*human: true,\s*handled: true,/],
  ];
  for (const [file, pattern] of doors) {
    assert.match(code(await read(file)), pattern, file);
  }
  /* The history still comes first where both are written. */
  const patch = code(await read("app/api/maintenance/route.ts"));
  assert.ok(patch.indexOf('source: "job.edit",\n      changes: statusChangesBetween(id, before, updated)') < patch.indexOf("recordJobMilestones(db, {"));
  /* The doors that hold a scope name the account and the role in the audit. */
  for (const [file, pattern] of [
    ["app/api/maintenance/route.ts", /actor: auditActor\(guard\.scope\),\s*source: "job\.edit",/],
    ["app/api/board/items/route.ts", /actor: auditActor\(guard\.scope\),\s*source: "board\.bulk",/],
    ["app/api/board/route.ts", /actor: auditActor\(guard\.scope\),\s*source: "board\.move",/],
    ["app/api/updates/route.ts", /actor: auditActor\(guard\.scope\),\s*source: "update\.posted",/],
  ]) {
    assert.match(code(await read(file)), pattern, file);
  }
  /* A contractor answering through their own link is a person handling the job:
     without this, a job completed by a contractor with no coordinator involved
     would keep an empty acknowledgement for ever and read as an SLA gap. */
  const link = code(await read("app/api/job-link/[token]/route.ts"));
  assert.match(link, /source: `job-link\.\$\{intent\}`,\s*human: true,\s*handled: true,/);
  assert.match(link, /actorEmail: `contractor-link:\$\{scope\.id\}`/, "the token, not an invented address");
  assert.equal((link.match(/recordContractorHandling\(db, scope, by, "/g) ?? []).length, 3, "blocked, completion and a note");
  /* The bulk site-assign tool is a human write that deliberately records nothing. */
  const siteAssign = await read("app/api/overview/site-assign/route.ts");
  assert.doesNotMatch(code(siteAssign), /recordJobMilestones/);
  assert.match(siteAssign, /WHY THIS DOOR RECORDS NO MILESTONE/);
  /* An archive, a group deletion, an option retirement and an import are not handling. */
  for (const file of ["app/api/options/route.ts", "app/api/import/route.ts"]) {
    assert.doesNotMatch(await read(file), /recordJobMilestones/, `${file} records no milestone`);
  }
  assert.doesNotMatch(code(await read("app/lib/board-mutations.ts")).slice(0, (await read("app/lib/board-mutations.ts")).indexOf("export async function duplicateBoardItems")).replace(/if \(source === "board\.move"[\s\S]*?\n  \}\n/, ""), /recordJobMilestones\(/, "only a person's move, not an archive");
});

test("the explicit actions: acknowledge and attend, board.edit, inside the member's sites; assigned is never posted", async () => {
  const route = code(await read("app/api/maintenance/milestones/route.ts"));
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /scopedDbWithCapability\(request, "board\.edit"\)/);
  assert.ok(post.indexOf("jobWithinMemberScope(") < post.indexOf("recordJobMilestones("), "outside the sites is a 404 first");
  assert.match(route, /const EXPLICIT = new Set<Milestone>\(\["acknowledged", "attended"\]\);/);
  assert.match(post, /status: 409/, "a second time is refused, not re-stamped");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(get, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(route, /memberSiteCondition\(maintenanceRequests\.siteId, scope\.siteScope\)/);
  assert.match(route, /resolvePermissions\(scope\.db, scope\.orgId, scope\.actor\.role, scope\.siteScope\)/);
});

test("the recording's start is written once by the migration and nothing is backfilled", async () => {
  const init = code(await read("db/init.ts"));
  const from = init.indexOf("async function ensureFeatureEpochs");
  const stage = init.slice(from, init.indexOf("\n}\n", from) + 3);
  assert.match(stage, /CREATE TABLE IF NOT EXISTS feature_epochs/);
  assert.match(stage, /INSERT OR IGNORE INTO feature_epochs \(feature, started_at\) VALUES \(\?, \?\)/);
  assert.match(stage, /\.bind\("job_milestones", new Date\(\)\.toISOString\(\)\)/);
  const migrations = init.slice(init.indexOf("async function applyMigrations"), init.indexOf("async function applyMigrations") + 30000);
  assert.match(migrations, /await ensureFeatureEpochs\(d1\);/);
  const repairs = init.slice(init.indexOf("async function repairInvariants"), init.indexOf("async function applyMigrations"));
  assert.doesNotMatch(repairs, /ensureFeatureEpochs/, "a one-time write is a migration, not a repair");
  assert.doesNotMatch(init, /set\s+(acknowledged_at|assigned_at|attended_at)\s*=/i, "no backfill of the three columns");
  const lib = code(await read("app/lib/job-milestones.ts"));
  assert.match(lib, /and \$\{sql\.raw\(COLUMN\[milestone\]\)\} is null\s*returning id/, "write-once by a conditional update");
});

test("a stamp that exists is always shown; the verdict only decides what may be recorded", async () => {
  const panel = await read("app/(app)/portal/job-milestones-panel.tsx");
  const list = panel.indexOf("job-milestones__list");
  const reason = panel.indexOf("{answer.reason ?");
  assert.ok(list > 0 && reason > list, "the rows are drawn before the reason, and not instead of it");
  assert.doesNotMatch(panel, /answer\.eligible \? \(\s*<>\s*<ul/, "the list is not behind the verdict");
  assert.match(panel, /answer\.canRecord &&/, "only the buttons are");
  assert.match(panel, /Recorded for jobs raised in this portal from \{sinceLabel\(answer\.since\)\}/, "the boundary names its date");
  const route = code(await read("app/api/maintenance/milestones/route.ts"));
  assert.ok(route.indexOf("milestones,") < route.indexOf("reason:"), "the route answers with the stamps whatever the reason says");
});

test("the drawer shows them on both widths and the history names them", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /<JobMilestonesPanel\s+requestId=\{request\.id\}\s+hidden=\{activeTab !== "columns"\}/);
  const panel = await read("app/(app)/portal/job-milestones-panel.tsx");
  assert.doesNotMatch(panel, /desktop-request-columns/, "not hidden on a phone");
  assert.match(panel, /record\("attended"\)/);
  assert.match(panel, /record\("acknowledged"\)/);
  assert.doesNotMatch(panel, /record\("assigned"\)/);
  const history = await read("app/(app)/portal/status-history.tsx");
  assert.match(history, /entry\.field === "milestone"/);
  const css = await read("app/(app)/portal/job-milestones-panel.css");
  assert.doesNotMatch(css, /@media|#[0-9a-f]{3,6}\b/i, "tokens only, no breakpoint");
});

/*
 * F10 — THE RAW STATEMENTS, THROUGH THE POSTGRES TRANSLATOR.
 *
 * Three of this module's statements are written by hand rather than by the
 * query builder (the epoch read, the row read and the write-once UPDATE), so
 * they are the ones that can be valid SQLite and invalid Postgres. The shim
 * translates them here exactly as it would at runtime, and the translation is
 * checked for the rewrites that matter: the schema qualification and the
 * placeholders.
 */
test("the module's hand-written SQL survives the Postgres translation", async () => {
  const { translateSql } = await import("../db/sqlite-to-postgres.ts");
  const statements = [
    "select cast(started_at as text) as started_at from feature_epochs where feature = ?",
    'select "maintenance_requests"."id" as id, cast("maintenance_requests"."created_at" as text) as created_at, ' +
      'cast("maintenance_requests"."acknowledged_at" as text) as acknowledged_at from "maintenance_requests" ' +
      'where "maintenance_requests"."organisation_id" = ? and "maintenance_requests"."id" in (?) ' +
      'and "maintenance_requests"."deleted_at" is null and "maintenance_requests"."parent_id" is null',
    "update maintenance_requests set acknowledged_at = ? where organisation_id = ? and id in (?) and acknowledged_at is null returning id",
  ];
  for (const statement of statements) {
    const translated = translateSql(statement);
    const text = typeof translated === "string" ? translated : translated.text ?? translated.sql ?? String(translated);
    assert.ok(text.length > 0, statement.slice(0, 40));
    assert.doesNotMatch(text, /\?/, "every placeholder is numbered for Postgres");
    assert.match(text, /feature_epochs|maintenance_requests/);
  }
});

/* ================================================================== */
/* The live half                                                        */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

async function call(cookie, pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: a new job is acknowledged by the first person to handle it, assigned by the assignment, attended only when recorded", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((v) => v.split(";")[0]).join("; ");
  const created = await call(cookie, "/api/board/items", { method: "POST", body: JSON.stringify({ board: "maintenance", title: `N-QA milestones ${Date.now()}` }) });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const id = created.body.request?.id ?? created.body.item?.requestId ?? created.body.id;
  try {
    const read = async () => (await call(cookie, `/api/maintenance/milestones?id=${encodeURIComponent(id)}`)).body;
    const fresh = await read();
    assert.equal(fresh.eligible, true, JSON.stringify(fresh));
    assert.deepEqual(fresh.milestones, { acknowledged: null, assigned: null, attended: null }, "creating it recorded nothing");

    /* A client may read them but not record them. */
    const client = await call(null, "/api/maintenance/milestones", { method: "POST", headers: { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com" }, body: JSON.stringify({ id, milestone: "acknowledged" }) });
    assert.ok([401, 403, 404].includes(client.status), `client answered ${client.status}`);
    assert.equal((await call(cookie, "/api/maintenance/milestones", { method: "POST", body: JSON.stringify({ id, milestone: "assigned" }) })).status, 400, "assigned is never posted");

    /* The first person to handle it: a note. */
    const note = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, note: "N-QA first reply" }) });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    const handled = await read();
    assert.ok(handled.milestones.acknowledged?.at, "acknowledged by the first handling");
    assert.equal(handled.milestones.acknowledged.actorEmail, OWNER.email);
    assert.equal(handled.milestones.acknowledged.source, "job.edit");
    assert.equal(handled.milestones.assigned, null);

    /* Assigning it. */
    const assign = await call(cookie, "/api/maintenance", { method: "PATCH", body: JSON.stringify({ id, fields: { assignee: "N-QA Engineer" } }) });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const assigned = await read();
    assert.ok(assigned.milestones.assigned?.at);
    assert.equal(assigned.milestones.acknowledged.at, handled.milestones.acknowledged.at, "acknowledged is not moved by a later edit");

    /* Attendance, once. */
    const attended = await call(cookie, "/api/maintenance/milestones", { method: "POST", body: JSON.stringify({ id, milestone: "attended" }) });
    assert.equal(attended.status, 201, JSON.stringify(attended.body));
    assert.ok(attended.body.milestones.attended?.at);
    const twice = await call(cookie, "/api/maintenance/milestones", { method: "POST", body: JSON.stringify({ id, milestone: "attended" }) });
    assert.equal(twice.status, 409, "recorded once");
    assert.equal(twice.body.milestones.attended.at, attended.body.milestones.attended.at);

    const detail = (await call(cookie, `/api/maintenance?id=${encodeURIComponent(id)}`)).body;
    const lines = detail.statusHistory.filter((entry) => entry.field === "milestone").map((entry) => entry.to).sort();
    assert.deepEqual(lines, ["acknowledged", "assigned", "attended"], "the §23 history carries all three, once each");
  } finally {
    await call(cookie, `/api/board/items?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }
});
