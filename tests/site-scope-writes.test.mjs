/**
 * THE SITE RESTRICTION ON THE WRITE DOORS.
 *
 * #83 confined every job-level READ and both upload doors to
 * `memberships.site_scope`. The write doors did not ask: a member confined to
 * one store who held `board.edit` could not SEE another store's jobs, and could
 * still edit their cells, move, archive, bin or duplicate them, comment on
 * them, issue a contractor link for them, set their reminders, move a job to
 * another store, raise a job there, rename the store, or restore another
 * store's job from the bin — by id, through the API.
 *
 * `app/lib/job-site-scope.ts` is the rule on the way in, built on #83's
 * `memberSiteSet` / `withinMemberScope` — one rule, not a second copy.
 *
 * Four layers, as #83's test has them:
 *   1. the helpers, on a real in-memory SQLite, including "an unrestricted
 *      member costs no query";
 *   2. every job- and site-anchored write door pinned to the rule by source,
 *      and the check placed BEFORE the write;
 *   3. an inventory: any route that writes a job-level table either asks the
 *      rule or is named here with the reason it does not — so a NEW write door
 *      cannot quietly skip it;
 *   4. against the running estate, a member confined to one store tries each
 *      write on another store's job (refused, and the row read back unchanged)
 *      and on their own (allowed); the unrestricted admin is unaffected. The
 *      member and everything written are removed. Skips without a dev server.
 *
 * THE UNRESTRICTED MEMBER — `site_scope` NULL, every member on Staging and
 * Production today — must not move, and each layer says so separately.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const {
  anyJobOutsideMemberScope,
  beyondMemberScope,
  jobWithinMemberScope,
  jobsWithinMemberScope,
  siteOutsideMemberScope,
  siteRequired,
  SITE_REQUIRED,
} = await import("../app/lib/job-site-scope.ts");
const { parseSiteScope } = await import("../app/lib/tenant-grants.ts");

/* ── 1. The helpers, on a real SQLite ───────────────────────────────────── */

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
 * org   j-a     site-a
 * org   j-b     site-b
 * org   j-none  (none)
 * other j-x     site-a     — another organisation's job at a same-named site
 */
function estate() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE maintenance_requests (id TEXT PRIMARY KEY, organisation_id TEXT NOT NULL, site_id TEXT);
    INSERT INTO maintenance_requests VALUES
      ('j-a', 'org', 'site-a'), ('j-b', 'org', 'site-b'), ('j-none', 'org', NULL), ('j-x', 'other', 'site-a');
  `);
  return proxy(sqlite);
}

/* A database that throws if it is touched: the unrestricted member's path. */
const exploding = new Proxy({}, { get: () => { throw new Error("an unrestricted member must not query"); } });

test("an unrestricted member is never refused, costs no query, and gets the SAME array back", async () => {
  const ids = ["j-a", "j-b", "j-none", "j-missing"];
  assert.equal(await jobsWithinMemberScope(exploding, "org", null, ids), ids, "the array itself, not a copy");
  assert.equal(await jobsWithinMemberScope(exploding, "org", undefined, ids), ids);
  assert.equal(await jobWithinMemberScope(exploding, "org", null, "j-b"), true);
  assert.equal(await anyJobOutsideMemberScope(exploding, "org", null, ids), false);
  assert.equal(siteOutsideMemberScope(null, "site-b"), false);
  assert.equal(siteOutsideMemberScope(null, null), false, "no site is fine for an unrestricted member");
});

test("jobsWithinMemberScope keeps the member's jobs, in the order named", async () => {
  const db = estate();
  const scope = ["site-a"];
  assert.deepEqual(await jobsWithinMemberScope(db, "org", scope, ["j-b", "j-a", "j-none", "j-missing", "j-x"]), ["j-a"]);
  assert.deepEqual(
    await jobsWithinMemberScope(db, "org", ["site-a", "site-b"], ["j-b", "j-a"]),
    ["j-b", "j-a"],
    "order preserved",
  );
  assert.deepEqual(await jobsWithinMemberScope(db, "org", scope, []), []);
  assert.deepEqual(
    await jobsWithinMemberScope(db, "org", parseSiteScope("{oops"), ["j-a", "j-b"]),
    [],
    "a malformed restriction reaches nothing",
  );
});

test("jobWithinMemberScope: a job at another store, with no store, missing or foreign is outside", async () => {
  const db = estate();
  const scope = ["site-a"];
  assert.equal(await jobWithinMemberScope(db, "org", scope, "j-a"), true);
  for (const [id, why] of [
    ["j-b", "another store"],
    ["j-none", "no store — nothing proves it is theirs"],
    ["j-missing", "does not resolve"],
    ["j-x", "another organisation's job at a same-named store"],
  ]) {
    assert.equal(await jobWithinMemberScope(db, "org", scope, id), false, why);
  }
});

test("anyJobOutsideMemberScope: one job at another store is enough; an empty set is not", async () => {
  const db = estate();
  assert.equal(await anyJobOutsideMemberScope(db, "org", ["site-a"], ["j-a", "j-a"]), false);
  assert.equal(await anyJobOutsideMemberScope(db, "org", ["site-a"], ["j-a", "j-b"]), true);
  assert.equal(await anyJobOutsideMemberScope(db, "org", ["site-a"], ["j-a", ""]), true, "a file with no job counts as outside");
  assert.equal(await anyJobOutsideMemberScope(db, "org", ["site-a"], []), false);
});

test("siteOutsideMemberScope and the two refusals", async () => {
  assert.equal(siteOutsideMemberScope(["site-a"], "site-a"), false);
  assert.equal(siteOutsideMemberScope(["site-a"], "site-b"), true);
  assert.equal(siteOutsideMemberScope(["site-a"], null), true, "no store is outside a restriction");
  assert.equal(siteOutsideMemberScope(["site-a"], ""), true);

  const required = siteRequired();
  assert.equal(required.status, 403);
  assert.deepEqual(await required.json(), { error: SITE_REQUIRED, outsideSiteScope: true });

  const beyond = beyondMemberScope("this group still holds jobs at other sites");
  assert.equal(beyond.status, 403);
  assert.equal(
    (await beyond.json()).error,
    "Your access is limited to some sites, and this group still holds jobs at other sites.",
  );
});

/* ── 2. Every write door is pinned to the rule, before its write ────────── */

const handler = (source, name) => {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} has moved; fix this test`);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end > 0 ? end : undefined);
};
const action = (source, name, next) => {
  const start = source.indexOf(`action === "${name}"`);
  assert.ok(start >= 0, `action ${name} has moved; fix this test`);
  const end = next ? source.indexOf(next, start + 1) : -1;
  return source.slice(start, end > 0 ? end : undefined);
};
const before = (source, check, write, why) => {
  const at = source.search(check);
  const writeAt = source.search(write);
  assert.ok(at >= 0, `${why}: the check is missing`);
  assert.ok(writeAt >= 0, `${why}: the write has moved; fix this test`);
  assert.ok(at < writeAt, `${why}: the check must come before the write`);
};

test("POST /api/board: create_item needs a store; duplicate, move, archive and delete drop other stores' jobs", async () => {
  const post = code(handler(await read("app/api/board/route.ts"), "POST"));
  assert.match(post, /const \{ actor, db, orgId, identityEmail, session, siteScope \} = guard\.scope;/);
  const create = action(post, "create_item", 'action === "create_column"');
  before(create, /if \(siteScope\) return siteRequired\(\);/, /createBoardItem\(/, "create_item");
  for (const [name, next, write] of [
    ["duplicate_items", 'action === "move_items"', /duplicateBoardItems\(/],
    ["move_items", 'action === "delete_items"', /moveItemsToGroup\(/],
    ["delete_items", "Unknown board action", /sendJobsToBin\(/],
  ]) {
    const block = action(post, name, next);
    before(block, /const requestIds = await jobsWithinMemberScope\(db, orgId, siteScope, named\);/, write, name);
    assert.match(block, /if \(!named\.length\)/, `${name}: an empty selection is still the 400 it was`);
  }
});

test("PATCH /api/board: cells, moves, sorts, group deletes, column clears and store renames ask the rule", async () => {
  const patch = code(handler(await read("app/api/board/route.ts"), "PATCH"));
  assert.match(patch, /const \{ actor, db, orgId, identityEmail, session, siteScope \} = guard\.scope;/);

  const cell = action(patch, "update_cell", 'action === "update_column"');
  before(
    cell,
    /if \(!column \|\| !workOrder \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, requestId\)\)\)/,
    /setBoardCell\(/,
    "update_cell",
  );

  const move = action(patch, "move_item", 'action === "update_option"');
  before(move, /if \(!existingItem \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, requestId\)\)\)/, /\.update\(maintenanceGroupItems\)/, "move_item");
  assert.match(move, /if \(beforeRequestId && !\(await jobWithinMemberScope\(db, orgId, siteScope, beforeRequestId\)\)\)/);

  const sort = action(patch, "sort_group", 'action === "delete_group"');
  before(sort, /if \(siteScope\) \{/, /\.update\(maintenanceGroupItems\)/, "sort_group");
  assert.match(sort, /const slots = own\.map\(\(item\) => item\.position\)\.sort\(\(a, b\) => a - b\);/, "their rows, in their own slots");

  const group = action(patch, "delete_group", 'action === "update_cell"');
  before(
    group,
    /if \(await anyJobOutsideMemberScope\(db, orgId, siteScope, sourceItems\.map\(\(item\) => item\.requestId\)\)\)/,
    /\.update\(maintenanceGroupItems\)/,
    "delete_group",
  );

  const clear = action(patch, "clear_column", 'action === "move_item"');
  before(clear, /if \(action === "clear_column" && siteScope\)/, /deleteFilesForColumn\(/, "clear_column");
  assert.match(clear, /return beyondMemberScope\("this column holds values at other sites"\);/);

  const rename = action(patch, "update_option", 'action === "delete_option"');
  before(rename, /if \(!existingSite \|\| siteOutsideMemberScope\(siteScope, siteOptionId\)\)/, /\.update\(sites\)/, "a store rename");
});

test("/api/board/items: every intent asks the rule, and the list read is confined", async () => {
  const source = await read("app/api/board/items/route.ts");
  const get = code(handler(source, "GET"));
  assert.match(get, /const confined = memberSiteCondition\(maintenanceRequests\.siteId, siteScope\);\s*if \(confined\) conditions\.push\(confined\);/);

  const post = code(handler(source, "POST"));
  before(post, /if \(!source \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, sourceId\)\)\)/, /db\.insert\(maintenanceRequests\)/, "duplicate");
  before(post, /if \(!site \|\| siteOutsideMemberScope\(siteScope, siteId\)\) return bad\("Site not found\.", 404\);/, /createSubmission\(/, "a store outside the scope");
  before(post, /\} else if \(siteScope\) \{\s*return siteRequired\(\);/, /createSubmission\(/, "a new job with no store");
  before(post, /if \(!parent \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, parentId\)\)\)/, /createSubmission\(/, "a subitem's parent");

  const patch = code(handler(source, "PATCH"));
  before(patch, /if \(!workOrder \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, requestId\)\)\)/, /\.update\(maintenanceBoardCells\)/, "a cell");
  assert.equal(
    (patch.match(/const itemIds = await jobsWithinMemberScope\(db, orgId, siteScope, namedIds\);/g) ?? []).length,
    2,
    "the move intent and the batch update",
  );

  const del = code(handler(source, "DELETE"));
  assert.match(del, /isNull\(maintenanceRequests\.deletedAt\),\s*memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/);
});

test("/api/maintenance: a job at another store is 'Request not found.' before the completion gate; stores and parents ask the rule", async () => {
  const source = await read("app/api/maintenance/route.ts");
  const post = code(handler(source, "POST"));
  before(
    post,
    /if \(!matchedSite \|\| siteOutsideMemberScope\(siteScope, matchedSite\.id\)\)/,
    /createSubmission\(/,
    "a new job at another store",
  );

  const patch = code(handler(source, "PATCH"));
  const scoped = patch.search(/if \(!\(await jobWithinMemberScope\(db, orgId, siteScope, id\)\)\) \{\s*return Response\.json\(\{ error: "Request not found\." \}, \{ status: 404 \}\);/);
  assert.ok(scoped > 0, "the job itself");
  assert.ok(scoped < patch.indexOf('if (stage === "Completed")'), "before the completion gate can confirm the job exists");
  assert.ok(scoped < patch.indexOf(".update(maintenanceRequests)"), "before the write");
  assert.match(patch, /if \(!parent \|\| !\(await jobWithinMemberScope\(db, orgId, siteScope, parentId\)\)\)/);
  assert.match(patch, /if \(!site \|\| siteOutsideMemberScope\(siteScope, nextSiteId\)\)/);
  assert.match(patch, /\} else if \(siteScope\) \{\s*return siteRequired\(\);/, "clearing the store");
});

test("/api/maintenance/calendar: the item's store and the store it moves to", async () => {
  const source = await read("app/api/maintenance/calendar/route.ts");
  const post = code(handler(source, "POST"));
  before(post, /const refusedSite = siteChoiceRefusal\(siteScope, text\(data\.siteId, 120\) \|\| null\);/, /\.insert\(calendarEvents\)/, "a new item");
  const patch = code(handler(source, "PATCH"));
  before(patch, /if \(!existing \|\| siteOutsideMemberScope\(siteScope, existing\.siteId\)\)/, /\.update\(calendarEvents\)/, "an item");
  before(patch, /if \(data\.siteId !== undefined\) \{\s*const refusedSite = siteChoiceRefusal/, /\.update\(calendarEvents\)/, "a move");
  const del = code(handler(source, "DELETE"));
  before(del, /if \(!existing \|\| siteOutsideMemberScope\(siteScope, existing\.siteId\)\)/, /\.update\(calendarEvents\)/, "a removal");
});

test("/api/updates: a comment and a like on another store's job are the 404s a missing job gets", async () => {
  const source = await read("app/api/updates/route.ts");
  const post = code(handler(source, "POST"));
  before(post, /isNull\(maintenanceRequests\.deletedAt\),\s*memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/, /\.insert\(itemUpdates\)/, "a comment");
  const put = code(handler(source, "PUT"));
  before(put, /isNull\(maintenanceRequests\.deletedAt\),\s*memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/, /\.insert\(itemUpdateLikes\)/, "a like");
});

test("/api/reminders: POST, PATCH and DELETE ask GET's `subjectWithinScope`", async () => {
  const source = await read("app/api/reminders/route.ts");
  before(
    code(handler(source, "POST")),
    /if \(siteScope && !\(await subjectWithinScope\(db, orgId, subjectType, subjectId, siteScope\)\)\)/,
    /createReminder\(/,
    "a new reminder",
  );
  for (const [verb, write] of [["PATCH", /updateReminder\(/], ["DELETE", /deleteReminder\(/]]) {
    before(
      code(handler(source, verb)),
      /\(siteScope && !\(await subjectWithinScope\(db, orgId, existing\.subjectType, existing\.subjectId, siteScope\)\)\)/,
      write,
      verb,
    );
  }
});

test("/api/board/links: a credential, evidence review and revocation all ask the rule", async () => {
  const source = await read("app/api/board/links/route.ts");
  assert.match(code(handler(source, "GET")), /if \(!\(await jobWithinMemberScope\(db, orgId, siteScope, requestId\)\)\)/);
  before(code(handler(source, "POST")), /memberSiteCondition\(maintenanceRequests\.siteId, siteScope\),/, /createJobToken\(/, "issuing a link");
  before(code(handler(source, "PATCH")), /await outsideSiteScope\(db, orgId, siteScope, file\)/, /\.delete\(attachments\)|\.update\(attachments\)/, "reviewing evidence");
  before(code(handler(source, "DELETE")), /jobWithinMemberScope\(db, orgId, siteScope, link\.requestId\)/, /revokeJobToken\(/, "revoking");
});

test("the store-level writes: /api/sites, the register values, site-assign, backfill", async () => {
  const sites = await read("app/api/sites/route.ts");
  for (const verb of ["PATCH", "DELETE"]) {
    const body = code(handler(sites, verb));
    before(body, /if \(!existing \|\| !withinMemberScope\(memberSiteSet\(siteScope\), id\)\)/, /\.update\(sites\)/, `sites ${verb}`);
  }
  const values = code(await read("app/api/registers/values/route.ts"));
  before(values, /if \(register === "sites" && siteOutsideMemberScope\(scope\.siteScope, entityId\)\)/, /\.insert\(registerValues\)|\.delete\(registerValues\)/, "a register cell");

  const assign = code(await read("app/api/overview/site-assign/route.ts"));
  before(assign, /if \(!site \|\| siteOutsideMemberScope\(scope\.siteScope, site\.id\)\)/, /\.update\(maintenanceRequests\)/, "the target store");
  before(assign, /withinMemberScope\(allowed, row\.siteId\)/, /\.update\(maintenanceRequests\)/, "the jobs");

  const backfill = code(await read("app/api/compliance/backfill/route.ts"));
  assert.match(backfill, /withinMemberScope\(allowed, row\.id\),/, "a batch covers the member's stores");
  assert.match(backfill, /return revert\(db, orgId, actor\.email, payload, siteScope\);/);
  const revert = backfill.slice(backfill.indexOf("async function revert("));
  before(revert, /if \(siteScope\) \{/, /\.delete\(complianceDocuments\)/, "undoing a batch");
});

test("workspace-wide writes refuse a restricted member outright, in the webhook route's words", async () => {
  for (const [file, reach] of [
    ["app/api/import/route.ts", "an import reaches every site in the workspace"],
    ["app/api/sites/csv/route.ts", "an import reaches every site in the register"],
    ["app/api/notifications/compliance/route.ts", "a compliance alert run covers every site in the workspace"],
    ["app/api/trash/route.ts", "emptying the bin destroys every site's deleted items"],
    ["app/api/board/groups/route.ts", "this group still holds jobs at other sites"],
  ]) {
    assert.match(code(await read(file)), new RegExp(`beyondMemberScope\\("${reach.replace(/'/g, "'")}"\\)`), file);
  }
  const webhooks = code(await read("app/api/integrations/webhooks/route.ts"));
  assert.match(webhooks, /Your access is limited to some sites, and a webhook sends events from the whole workspace\./, "the precedent");
});

test("the recycle bin and the archive: another store's job is not in this member's bin or archive", async () => {
  const trash = await read("app/api/trash/route.ts");
  const confine = trash.slice(trash.indexOf("async function confineBinEntries"), trash.indexOf("function unavailable("));
  assert.match(confine, /if \(!allowed\) return entries;/, "unrestricted: the entries themselves");
  assert.match(confine, /if \(entry\.entityType === SECTION_ENTITY_TYPE\) return false;/, "a section holds every store's jobs");
  assert.match(code(handler(trash, "GET")), /const all = await confineBinEntries\(db, orgId, guard\.scope\.siteScope, await listBin\(db, orgId\)\);/);
  before(code(handler(trash, "POST")), /confineBinEntries\(db, orgId, siteScope, \[entry\]\)/, /restoreFromBin\(/, "a restore");
  before(code(handler(trash, "DELETE")), /const all = await confineBinEntries\(db, orgId, siteScope, unconfined\);/, /await purge\(/, "a purge");

  const archive = code(await read("app/api/account/archive/route.ts"));
  assert.equal((archive.match(/memberSiteCondition\(maintenanceRequests\.siteId, context\.siteScope\)/g) ?? []).length, 2, "the list and the restore");

  const csv = code(await read("app/api/board/csv/route.ts"));
  assert.match(csv, /ids = await jobsWithinMemberScope\(/, "an export of a chosen list");
  assert.match(csv, /isNull\(maintenanceRequests\.deletedAt\),\s*confined,/, "an export of the whole board");
});

/* ── 3. The inventory ───────────────────────────────────────────────────── */

/*
 * Every API route that writes a job-level table. A route listed by the scan
 * must either ask the rule or be named here with the reason it need not; a new
 * write door that does neither fails this test rather than shipping.
 */
const JOB_WRITES =
  /update\(maintenanceRequests\)|insert\(maintenanceRequests\)|update\(maintenanceBoardCells\)|insert\(maintenanceBoardCells\)|delete\(maintenanceBoardCells\)|update\(maintenanceGroupItems\)|insert\(maintenanceGroupItems\)|insert\(itemUpdates\)|update\(calendarEvents\)|insert\(calendarEvents\)|createSubmission\(|createBoardItem\(|moveItemsToGroup\(|duplicateBoardItems\(|sendJobsToBin\(|setBoardCell\(|createJobToken\(|createReminder\(|updateReminder\(|deleteReminder\(|restoreFromBin\(|revokeJobToken\(|applyAliasLink\(|applyAliasUnlink\(/;
/*
 * `applyAliasLink(` / `applyAliasUnlink(` added 2026-09-23 (dashboard §9 item
 * 20): the contractor-alias route's job writes moved into
 * `app/lib/contractor-alias-writes.ts` so they commit in one batch, and a scan
 * of route files would otherwise stop seeing that route as a job writer at all.
 * Naming the calls keeps the door in the inventory — the same way this list
 * already names `createSubmission(` and `sendJobsToBin(`.
 */
const ASKS_THE_RULE = /job-site-scope|member-site-scope|outsideSiteScope/;
const NOT_A_MEMBERS_WRITE = new Map([
  ["app/api/forms/[token]/submit/route.ts", "a public form: the grant is the form's token, not a member"],
  ["app/api/report-job/route.ts", "public intake: nobody is signed in"],
  ["app/api/job-link/[token]/route.ts", "the grant is the job link, and a restricted member can now issue one only for their own stores' jobs"],
  ["app/api/board/discussion/route.ts", "the board's own conversation: no job, so no store"],
  ["app/api/options/route.ts", "workspace vocabulary: a label renamed is renamed on every job alike — board structure, left for an owner decision"],
  ["app/api/overview/contractor-aliases/route.ts", "`settings.edit` vocabulary: links contractor names to register rows across the workspace"],
]);

async function routeFiles(directory) {
  const found = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await routeFiles(relative)));
    else if (entry.name === "route.ts") found.push(relative);
  }
  return found;
}

test("INVENTORY: every route that writes a job asks the member's sites, or says why it need not", async () => {
  const writers = [];
  for (const file of await routeFiles("app/api")) {
    const source = await read(file);
    if (JOB_WRITES.test(code(source))) writers.push([file, source]);
  }
  assert.ok(writers.length >= 18, `the scan found ${writers.length} writers; it should find every job-level door`);
  const unexplained = writers
    .filter(([file, source]) => !ASKS_THE_RULE.test(source) && !NOT_A_MEMBERS_WRITE.has(file))
    .map(([file]) => file);
  assert.deepEqual(unexplained, [], "a job-level write door that neither asks the rule nor says why");
  for (const file of NOT_A_MEMBERS_WRITE.keys()) {
    assert.ok(writers.some(([writer]) => writer === file), `${file} no longer writes a job; take it off the list`);
  }
});

/* ── 4. Against the running estate ────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const RUN = `scope-writes-${Date.now().toString(36)}`;
/* Two purpose-built admins of the development workspace — one confined to a
   store, one unrestricted — so the test changes nobody who already exists. The
   identity header resolves to this workspace in development (#83's test uses
   it the same way). */
const ORG = "org_000000000000000000000001";
const CONFINED = `${RUN}-confined@example.com`;
const OPEN = `${RUN}-open@example.com`;

const as = (email) => ({ "x-maintsupp-identity": email, Accept: "application/json" });
async function call(method, url, email, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...as(email), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a bare-text answer */
  }
  return { status: response.status, body: json };
}

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/maintenance?limit=1`, { signal: AbortSignal.timeout(30000) });
    return response.status < 500;
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
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

const cleanup = { calendar: [], updates: [], jobs: new Map(), sites: [], positions: [] };
const JOB_COLUMNS = "title, stage, status, priority, site_id, parent_id, archived, deleted_at, comment_count, updated_at";

after(async () => {
  const db = await openDevDatabase().catch(() => null);
  if (!db) return;
  try {
    for (const id of cleanup.calendar) db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    for (const id of cleanup.updates) db.prepare("DELETE FROM item_updates WHERE id = ?").run(id);
    for (const [id, row] of cleanup.jobs) {
      db.prepare("UPDATE maintenance_requests SET title = ?, comment_count = ?, updated_at = ? WHERE id = ?").run(
        row.title,
        row.comment_count,
        row.updated_at,
        id,
      );
    }
    for (const id of cleanup.sites) db.prepare("DELETE FROM sites WHERE id = ? AND name LIKE ?").run(id, `${RUN}%`);
    for (const [requestId, position] of cleanup.positions) {
      db.prepare("UPDATE maintenance_group_items SET position = ? WHERE request_id = ?").run(position, requestId);
    }
    for (const email of [CONFINED, OPEN]) {
      db.prepare("DELETE FROM activity_log WHERE lower(actor_email) = lower(?)").run(email);
    }
    db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)").run(`${RUN}%`);
    db.prepare("DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)").run(`${RUN}%`);
    db.prepare("DELETE FROM users WHERE email LIKE ?").run(`${RUN}%`);
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    db.close();
  }
});

function addMember(db, org, email, label, siteScope) {
  const userId = `user-${RUN}-${label}`;
  db.prepare("INSERT INTO users (id, organisation_id, email, full_name, role, active) VALUES (?, ?, ?, ?, 'admin', 1)").run(
    userId,
    org,
    email,
    `Scope writes probe (${label})`,
  );
  db.prepare(
    `INSERT INTO memberships (id, user_id, organisation_id, role, status, accepted_at, site_scope)
     VALUES (?, ?, ?, 'admin', 'active', CURRENT_TIMESTAMP, ?)`,
  ).run(`membership-${userId}-${org}`, userId, org, siteScope);
  return userId;
}

test("LIVE a member confined to one store cannot write to another store's jobs, and still can to their own", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const db = await openDevDatabase();
  if (!db) {
    t.skip("no development database to add a restricted member to");
    return;
  }
  /* Confined to nothing until a store is chosen — a malformed scope denies. */
  const confinedId = addMember(db, ORG, CONFINED, "confined", "[]");
  addMember(db, ORG, OPEN, "open", null);
  db.close();

  /* Two stores, each with a live job placed on the default board. */
  const board = await call("GET", "/api/board", OPEN);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  const placed = new Set(board.body.items.map((item) => item.requestId));
  const bySite = new Map();
  for (const row of board.body.requests) {
    if (!row.siteId || !placed.has(row.id) || row.archived) continue;
    bySite.set(row.siteId, [...(bySite.get(row.siteId) ?? []), row]);
  }
  const ranked = [...bySite.entries()].sort((a, b) => b[1].length - a[1].length);
  if (ranked.length < 2) {
    t.skip("the default board needs placed jobs at two stores");
    return;
  }
  const [site, [own]] = ranked[0];
  const [otherSite, [other]] = ranked[1];
  const group = board.body.groups[0]?.id;

  const snapshot = (handle, id) => handle.prepare(`SELECT ${JOB_COLUMNS} FROM maintenance_requests WHERE id = ?`).get(id);
  const placement = (handle, id) => handle.prepare("SELECT group_id, position FROM maintenance_group_items WHERE request_id = ?").get(id);
  const setup = await openDevDatabase();
  let otherBefore;
  let placementBefore;
  let siteBefore;
  try {
    setup.prepare("UPDATE memberships SET site_scope = ? WHERE user_id = ?").run(JSON.stringify([site]), confinedId);
    /* A job's store need not be a row in the register; the store-level doors
       need one to answer about, so a probe row is filed and removed after. */
    for (const id of [site, otherSite]) {
      if (setup.prepare("SELECT 1 FROM sites WHERE id = ?").get(id)) continue;
      setup
        .prepare("INSERT INTO sites (id, organisation_id, name, type, address) VALUES (?, ?, ?, 'Retail', 'Scope probe')")
        .run(id, ORG, `${RUN} ${id}`);
      cleanup.sites.push(id);
    }
    otherBefore = snapshot(setup, other.id);
    placementBefore = placement(setup, other.id);
    siteBefore = setup.prepare("SELECT name, updated_at FROM sites WHERE id = ?").get(otherSite);
    for (const job of [own, other]) {
      cleanup.jobs.set(job.id, setup.prepare("SELECT title, comment_count, updated_at FROM maintenance_requests WHERE id = ?").get(job.id));
    }
  } finally {
    setup.close();
  }

  /* ── Another store's job, or a store outside the scope: refused, as missing. ── */
  const refusals = [
    ["PATCH", "/api/maintenance", { id: other.id, fields: { title: `${RUN} hijack` } }, 404],
    ["PATCH", "/api/maintenance", { id: other.id, stage: "Completed" }, 404],
    ["PATCH", "/api/maintenance", { id: own.id, fields: { siteId: otherSite } }, 404],
    ["PATCH", "/api/maintenance", { id: own.id, fields: { siteId: null } }, 403],
    ["POST", "/api/updates", { requestId: other.id, body: `${RUN} comment` }, 404],
    ["POST", "/api/board/links", { requestId: other.id }, 404],
    ["POST", "/api/board", { action: "duplicate_items", requestIds: [other.id] }, 404],
    ["POST", "/api/board", { action: "move_items", groupId: group, requestIds: [other.id] }, 404],
    ["POST", "/api/board", { action: "delete_items", requestIds: [other.id] }, 404],
    ["POST", "/api/board", { action: "create_item", groupId: group }, 403],
    ["PATCH", "/api/board", { action: "move_item", requestId: other.id, groupId: group }, 404],
    ["PATCH", "/api/board", { action: "update_option", optionId: `site-option-${otherSite}`, label: `${RUN} store` }, 404],
    ["POST", "/api/board/items", { intent: "duplicate", id: other.id }, 404],
    ["POST", "/api/board/items", { title: `${RUN} at another store`, siteId: otherSite }, 404],
    ["POST", "/api/board/items", { title: `${RUN} at no store` }, 403],
    ["DELETE", `/api/board/items?id=${encodeURIComponent(other.id)}`, undefined, 404],
    ["POST", "/api/reminders", { subjectType: "job", subjectId: other.id, recipients: [] }, 404],
    ["POST", "/api/maintenance/calendar", { data: { title: `${RUN} event`, siteId: otherSite, startsOn: "2031-01-01" } }, 404],
    ["POST", "/api/maintenance/calendar", { data: { title: `${RUN} event`, startsOn: "2031-01-01" } }, 403],
    ["POST", "/api/overview/site-assign", { requestIds: [own.id], siteId: otherSite, mode: "apply" }, 400],
    ["POST", "/api/account/archive", { kind: "job", id: other.id }, 404],
    ["PATCH", "/api/sites", { id: otherSite, rename: `${RUN} store` }, 404],
  ];
  for (const [method, url, body, status] of refusals) {
    const answer = await call(method, url, CONFINED, body);
    assert.equal(answer.status, status, `${method} ${url} ${JSON.stringify(body ?? {})} → ${JSON.stringify(answer.body)}`);
  }
  /* The bulk doors drop another store's jobs and report what they wrote. */
  const moved = await call("PATCH", "/api/board/items", CONFINED, { intent: "move", groupId: group, itemIds: [other.id] });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.moved, 0, "nothing moved");
  const batch = await call("PATCH", "/api/board/items", CONFINED, { itemIds: [other.id], title: `${RUN} batch` });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.updated, 0, "no row written");

  /* And nothing happened to it: read back from the database. */
  const check = await openDevDatabase();
  try {
    assert.deepEqual(snapshot(check, other.id), otherBefore, "the other store's job is exactly as it was");
    assert.deepEqual(placement(check, other.id), placementBefore, "and exactly where it was on the board");
    assert.deepEqual(check.prepare("SELECT name, updated_at FROM sites WHERE id = ?").get(otherSite), siteBefore, "the other store is not renamed");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM item_updates WHERE body LIKE ?").get(`${RUN}%`).n, 0, "no comment");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE title LIKE ?").get(`${RUN}%`).n, 0, "no event");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM maintenance_requests WHERE title LIKE ?").get(`${RUN}%`).n, 0, "no job");
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sites WHERE name LIKE ? AND id NOT IN (?, ?)").get(`${RUN} store%`, site, otherSite).n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM job_access_tokens WHERE request_id = ?").get(other.id).n,
      check.prepare("SELECT COUNT(*) AS n FROM job_access_tokens WHERE request_id = ? AND created_at < datetime('now', '-1 hour')").get(other.id).n,
      "no contractor link issued");
  } finally {
    check.close();
  }

  /* ── Changes that reach every job in a group: refused while it holds another store's. ── */
  const otherGroup = placementBefore.group_id;
  const elsewhere = board.body.groups.find((entry) => entry.id !== otherGroup)?.id;
  const groupDelete = await call("PATCH", "/api/board", CONFINED, { action: "delete_group", groupId: otherGroup, targetGroupId: elsewhere });
  assert.equal(groupDelete.status, 403, JSON.stringify(groupDelete.body));
  assert.equal(groupDelete.body.outsideSiteScope, true);
  const groupsDelete = await call("DELETE", `/api/board/groups?id=${encodeURIComponent(otherGroup)}&moveTo=${encodeURIComponent(elsewhere)}`, CONFINED);
  assert.equal(groupsDelete.status, 403, JSON.stringify(groupsDelete.body));
  const groupAfter = await openDevDatabase();
  try {
    assert.equal(groupAfter.prepare("SELECT deleted_at FROM maintenance_groups WHERE id = ?").get(otherGroup).deleted_at, null, "the group is not binned");
    assert.deepEqual(placement(groupAfter, other.id), placementBefore, "its jobs did not move");
  } finally {
    groupAfter.close();
  }

  /* ── Sorting a group: their rows, in their own slots; other stores' rows stay put. ── */
  const ownGroup = board.body.items.find((item) => item.requestId === own.id).groupId;
  const inGroup = board.body.items.filter((item) => item.groupId === ownGroup).sort((a, b) => a.position - b.position);
  const siteOf = new Map(board.body.requests.map((row) => [row.id, row.siteId]));
  const mine = inGroup.filter((item) => siteOf.get(item.requestId) === site);
  const theirs = inGroup.filter((item) => siteOf.get(item.requestId) !== site);
  for (const item of mine) cleanup.positions.push([item.requestId, item.position]);
  const sorted = await call("PATCH", "/api/board", CONFINED, {
    action: "sort_group",
    groupId: ownGroup,
    requestIds: mine.map((item) => item.requestId).reverse(),
  });
  assert.equal(sorted.status, 200, JSON.stringify(sorted.body));
  const slots = mine.map((item) => item.position).sort((a, b) => a - b);
  assert.deepEqual(sorted.body.items.map((item) => item.position), slots, "into the slots their rows already held");
  const afterSort = await openDevDatabase();
  try {
    for (const item of theirs) {
      assert.equal(placement(afterSort, item.requestId).position, item.position, `another store's row ${item.requestId} kept its place`);
    }
  } finally {
    afterSort.close();
  }

  /* ── Their own store: the same doors let them in. ── */
  const comment = await call("POST", "/api/updates", CONFINED, { requestId: own.id, body: `${RUN} own comment` });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  cleanup.updates.push(comment.body.id);
  const event = await call("POST", "/api/maintenance/calendar", CONFINED, {
    data: { title: `${RUN} own event`, siteId: site, startsOn: "2031-01-01" },
  });
  assert.equal(event.status, 200, JSON.stringify(event.body));
  cleanup.calendar.push(event.body.event.id);
  const retitle = await call("PATCH", "/api/maintenance", CONFINED, { id: own.id, fields: { title: `${RUN} own title` } });
  assert.equal(retitle.status, 200, JSON.stringify(retitle.body));

  /* ── The unrestricted admin of the same workspace is not asked. ── */
  const openComment = await call("POST", "/api/updates", OPEN, { requestId: other.id, body: `${RUN} open comment` });
  assert.equal(openComment.status, 200, JSON.stringify(openComment.body));
  cleanup.updates.push(openComment.body.id);
  const openEvent = await call("POST", "/api/maintenance/calendar", OPEN, { data: { title: `${RUN} open event`, startsOn: "2031-01-01" } });
  assert.equal(openEvent.status, 200, "an unrestricted member may still file an item at no store");
  cleanup.calendar.push(openEvent.body.event.id);
});
