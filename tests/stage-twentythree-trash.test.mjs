import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Stage 23 — the 30-day recycle bin.
 *
 * This stage REVERSED a decision the codebase had made on purpose and defended
 * with a test: that nothing was recoverable, because no table carried a
 * `deleted_at`. The reversal was the owner's call. What these tests exist for is
 * the part that is not a matter of instruction — that the bin is honest, that
 * the board did not silently lose its 744 rows to it, and that the promises on
 * the screen are ones the code keeps.
 *
 * Four things are guarded here, in order of how badly they would fail:
 *
 *   1. THE BOARD STILL SHOWS EVERYTHING. A soft delete is one predicate away
 *      from hiding live rows and one predicate away from showing dead ones.
 *      The reads were enumerated and changed; these assert they stayed changed.
 *
 *   2. RESTORE IS EXACT. Not "the row is back" — back in its group, at its
 *      position. That is the difference between a restore and a re-creation,
 *      and it is why the bin snapshots a placement instead of setting a flag.
 *
 *   3. EXPIRY CANNOT EAT THE BOOT PATH. `db/init.ts` already runs several
 *      hundred statements per cold start. The sweep must not be in it, and must
 *      be bounded when it does run.
 *
 *   4. THE DESTRUCTIVE VERB IS STILL GUARDED. `data.delete` is withheld from
 *      `admin` by default; permanent deletion has to keep asking for it.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const SCHEMA = "db/schema.ts";
const INIT = "db/init.ts";
const LIB = "app/lib/recycle-bin.ts";
const BIN_API = "app/api/trash/route.ts";
const HISTORY_API = "app/api/account/trash/route.ts";
const BOARD_API = "app/api/board/route.ts";
const GROUPS_API = "app/api/board/groups/route.ts";
const VIEW = "app/(app)/portal/views/account-workspace.tsx";
const MIGRATION = "drizzle/0018_stage_twentythree_recycle_bin.sql";

/* ── 1. The schema, and the migration that carries it ───────────────────── */

test("the soft-delete columns and the bin table exist in schema and migration", async () => {
  const schema = await read(SCHEMA);
  const migration = await read(MIGRATION);

  for (const column of ["deleted_at", "deleted_by"]) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE maintenance_requests ADD COLUMN ${column}`),
      `maintenance_requests must gain ${column}`,
    );
    assert.match(
      migration,
      new RegExp(`ALTER TABLE maintenance_groups ADD COLUMN ${column}`),
      `maintenance_groups must gain ${column}`,
    );
  }

  assert.match(schema, /export const recycleBin = sqliteTable\(/);
  // `placement` is the column that makes a restore exact rather than
  // approximate. Without it the bin can only un-delete, not put back.
  assert.match(schema, /placement: text\("placement"\)/);
  assert.match(schema, /expiresAt: text\("expires_at"\)\.notNull\(\)/);

  // One live bin row per thing, or a restore is ambiguous.
  assert.match(schema, /uniqueIndex\("recycle_bin_entity_idx"\)/);
});

test("db/init.ts adds the columns through the PRAGMA guard, never a bare ALTER", async () => {
  const init = await read(INIT);
  const stage = init.slice(init.indexOf("async function ensureStageTwentyThreeRecycleBin"));
  assert.ok(stage.length > 0, "the stage function must exist");

  for (const column of ["deleted_at", "deleted_by"]) {
    assert.match(
      stage,
      new RegExp(`addColumn\\(d1, "maintenance_requests", "${column}"`),
      `${column} must be added through addColumn`,
    );
  }

  /*
   * This file runs on the boot path of every isolate. SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, so an ALTER issued directly here throws
   * "duplicate column name" on the SECOND boot and takes the whole bootstrap —
   * and therefore every API route — down with it.
   */
  assert.doesNotMatch(
    stage,
    /prepare\(\s*[`"']\s*ALTER TABLE/i,
    "Stage 23 must not issue an unguarded ALTER on the boot path",
  );

  assert.match(stage, /CREATE TABLE IF NOT EXISTS recycle_bin/);
  assert.match(
    stage,
    /CREATE INDEX IF NOT EXISTS recycle_bin_expiry_idx/,
    "the sweep needs an index or it scans the table to find its work",
  );
});

/* ── 2. Every read path that had to change ──────────────────────────────── */

/**
 * The board is 744 jobs and 31 stores of real operational data. A read that
 * forgets `deleted_at` either keeps deleted rows on the board or, far worse,
 * takes live ones off it.
 *
 * The placement is what actually removes a binned job from the board — every
 * board read joins through `maintenance_group_items` and a soft delete drops
 * that row — so these are the reads that go STRAIGHT at `maintenance_requests`
 * and would otherwise still count or list a binned job.
 */
test("every direct read of maintenance_requests excludes binned rows", async () => {
  const files = [
    ["app/api/maintenance/route.ts", 2],
    ["app/api/account/route.ts", 1],
    ["app/api/context/route.ts", 1],
    ["app/api/admin/clients/route.ts", 2],
    ["app/api/workspace/route.ts", 1],
    ["app/api/sites/route.ts", 2],
    ["app/api/account/platform/route.ts", 1],
    ["app/api/account/archive/route.ts", 1],
    ["app/api/updates/route.ts", 1],
    ["app/api/board/links/route.ts", 1],
    ["app/api/board/items/route.ts", 1],
    ["app/api/options/route.ts", 1],
  ];

  for (const [file, atLeast] of files) {
    const source = await read(file);
    const hits = [...source.matchAll(/isNull\(maintenanceRequests\.deletedAt\)/g)].length;
    assert.ok(
      hits >= atLeast,
      `${file} must exclude soft-deleted jobs in at least ${atLeast} read(s); found ${hits}`,
    );
  }
});

/**
 * The read that would have undone every delete on the next page load.
 *
 * `ensureBoardState` re-places any request with no `maintenance_group_items`
 * row — that is how an orphaned or freshly imported job finds a group. A binned
 * job has had its placement deleted deliberately, so without this filter the
 * board would silently restore everything, for ever.
 */
test("ensureBoardState will not re-place a job that is in the bin", async () => {
  const source = await read(BOARD_API);
  const fn = source.slice(
    source.indexOf("async function ensureBoardState"),
    source.indexOf("async function boardPayload"),
  );
  assert.ok(fn.length > 0, "ensureBoardState must exist");
  assert.match(
    fn,
    /isNull\(maintenanceRequests\.deletedAt\)/,
    "without this the next board load resurrects every deleted job",
  );
  assert.match(
    fn,
    /isNull\(maintenanceGroups\.deletedAt\)/,
    "and a binned group must not come back as a placement target",
  );
});

/**
 * Two reads that MUST NOT be filtered, recorded so a later tidy-up does not
 * "fix" them into bugs.
 */
test("the id generator and the import identity map still see binned rows", async () => {
  const board = await read(BOARD_API);
  const generators = [...board.matchAll(/coalesce\(max\(cast\(substr\(/g)];
  assert.equal(generators.length, 2, "both MN-… generators must still be here");
  assert.match(
    board,
    /DELIBERATELY UNFILTERED/,
    "the reason must be written down where the query is",
  );

  const importer = await read("app/api/import/route.ts");
  const map = importer.slice(
    importer.indexOf("DELIBERATELY UNFILTERED"),
    importer.indexOf("const itemByTitle"),
  );
  assert.ok(map.length > 0, "the identity map must carry the explanation");
  assert.doesNotMatch(
    map,
    /isNull\(maintenanceRequests\.deletedAt\)/,
    "filtering here makes a re-import duplicate every job sitting in the bin",
  );
});

/* ── 3. Deleting, restoring, and what restore means ─────────────────────── */

test("deleting board items bins them instead of destroying them", async () => {
  const source = await read(BOARD_API);
  const action = source.slice(
    source.indexOf('if (action === "delete_items")'),
    source.indexOf('return Response.json({ error: "Unknown board action." }'),
  );
  assert.ok(action.length > 0, "delete_items must still exist");

  assert.match(action, /sendJobsToBin\(/, "delete_items must send jobs to the bin");
  assert.doesNotMatch(
    action,
    /\.delete\(maintenanceRequests\)/,
    "the board must no longer hard-delete a job",
  );
  assert.doesNotMatch(
    action,
    /BUCKET\.delete/,
    "a binned job keeps its files, or restoring it returns a row with no evidence",
  );
  // The audit trail must not develop a hole at the moment deletion became
  // recoverable — the deletion history reads from it.
  assert.match(action, /action: "board\.items_deleted"/);
});

test("deleting a board group bins it, and only ever when it is empty", async () => {
  const source = await read(GROUPS_API);
  assert.match(source, /sendGroupToBin\(/);
  assert.doesNotMatch(
    source,
    /\.delete\(maintenanceGroups\)/,
    "the group route must no longer hard-delete",
  );
  // The pre-existing refusal that keeps a bin entry from swallowing jobs.
  assert.match(source, /error: "has-items"/);
});

/**
 * The property that separates a restore from a re-creation.
 *
 * A job that comes back at the bottom of the wrong group has not been restored.
 * The bin snapshots the group and the position before deleting the placement,
 * and puts both back.
 */
test("restoring a job returns it to its group AND its position", async () => {
  const lib = await read(LIB);

  const send = lib.slice(lib.indexOf("export async function sendJobsToBin"), lib.indexOf("export async function sendGroupToBin"));
  assert.match(send, /position: placement\.position/, "the position must be snapshotted");
  assert.match(send, /groupId: placement\.groupId/, "and the group with it");
  assert.match(
    send,
    /\.delete\(maintenanceGroupItems\)/,
    "the placement must be removed, or the job stays on the board",
  );

  const restore = lib.slice(lib.indexOf("async function restoreJob"), lib.indexOf("async function restoreGroup"));
  assert.match(restore, /\.insert\(maintenanceGroupItems\)/);
  assert.match(
    restore,
    /position: placement\?\.position \?\? 0/,
    "restore must put the row back at the position it held",
  );
  assert.match(
    restore,
    /deletedAt: null/,
    "and clear the flag, or it is placed but still invisible",
  );

  /*
   * The group may have been deleted while the job sat in the bin. Restoring
   * into it would put the row somewhere invisible, so there has to be a
   * fallback — and the response has to say it was used.
   */
  assert.match(restore, /fellBack/, "a missing group must fall back, visibly");
});

test("a bin entry is never dropped unless the purge really happened", async () => {
  const lib = await read(LIB);
  const sweep = lib.slice(lib.indexOf("export async function sweepRecycleBin"));
  assert.match(
    sweep,
    /if \(!purged\) continue;/,
    "dropping the entry after a failed purge strands the row: invisible and unreachable",
  );
});

/* ── 4. Expiry — what actually sweeps the 30 days ───────────────────────── */

test("retention is 30 days, written once", async () => {
  const lib = await read(LIB);
  assert.match(lib, /export const RETENTION_DAYS = 30;/);
  assert.match(lib, /RETENTION_DAYS \* DAY_MS/, "expiry must be derived from it");
});

/**
 * There is no cron in this project. The sweep is opportunistic, and the three
 * bounds below are what stop that being a performance bug.
 */
test("the expiry sweep is off the boot path, sampled, capped and indexed", async () => {
  /*
   * A CALL, not a mention. `db/init.ts` names `sweepRecycleBin` in a comment
   * explaining why the sweep is deliberately not there, and a test that
   * forbade the word would forbid the explanation along with the mistake.
   */
  const init = await read(INIT);
  assert.doesNotMatch(
    init,
    /(await\s+)?(maybe)?[sS]weepRecycleBin\s*\(/,
    "db/init.ts runs on every cold start and must not invoke the sweep",
  );

  const lib = await read(LIB);
  assert.match(lib, /const SWEEP_CHANCE = /, "sampled, like the sign-in failure prune");
  assert.match(lib, /const SWEEP_LIMIT = /, "capped, so one request cannot drain a huge bin");
  assert.match(
    lib,
    /if \(Math\.random\(\) > SWEEP_CHANCE\) return 0;/,
    "the sampling must actually gate the work",
  );

  const sweep = lib.slice(lib.indexOf("export async function sweepRecycleBin"));
  assert.match(
    sweep,
    /lte\(recycleBin\.expiresAt, nowIso\(\)\)/,
    "the candidate query must be a range scan on the indexed expiry column",
  );
  assert.match(sweep, /\.limit\(SWEEP_LIMIT\)/);
  assert.doesNotMatch(
    sweep,
    /from\(maintenanceRequests\)/,
    "the sweep must never scan the 744-row jobs table to find its work",
  );

  // And it must be triggered from somewhere a person is already looking.
  const bin = await read(BIN_API);
  assert.match(bin, /maybeSweepRecycleBin\(db, purgeFor\(db\)\)/);
});

/* ── 5. Capabilities ────────────────────────────────────────────────────── */

test("the bin guards reading, restoring and purging differently", async () => {
  const bin = await read(BIN_API);

  const get = bin.slice(bin.indexOf("export async function GET"), bin.indexOf("export async function POST"));
  const post = bin.slice(bin.indexOf("export async function POST"), bin.indexOf("export async function DELETE"));
  const del = bin.slice(bin.indexOf("export async function DELETE"), bin.indexOf("function purgeFor"));

  assert.match(get, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(post, /scopedDbWithCapability\(request, "board\.edit"\)/, "restoring is a write");
  assert.match(
    del,
    /scopedDbWithCapability\(request, "data\.delete"\)/,
    "permanent deletion must require data.delete",
  );

  // `data.delete` is withheld from admin by default; that is the whole reason
  // the capability exists, and this route is what it was waiting for.
  const permissions = await read("app/lib/permissions.ts");
  const adminBlock = permissions.slice(
    permissions.indexOf("  admin: ["),
    permissions.indexOf("  client: ["),
  );
  assert.doesNotMatch(
    adminBlock,
    /"data\.delete"/,
    "if admin gains data.delete by default, the second gate on purging is gone",
  );
});

/* ── 6. The screen, and the honesty of the reversal ─────────────────────── */

test("the Trash screen restores, filters, and keeps the deletion history", async () => {
  const view = await read(VIEW);
  const panel = view.slice(
    view.indexOf("export function AccountTrashPanel"),
    view.indexOf("export function AccountArchivePanel"),
  );

  assert.match(panel, /"Restore"/, "there must be a Restore button");
  assert.match(panel, /Delete for good/, "and a permanent delete beside it");
  assert.match(panel, /window\.confirm\(/, "which must confirm, because it is the one that cannot be undone");

  // Filterable: what, by whom, when, and when it expires.
  for (const field of ["Search", "Type", "Board", "Deleted by"]) {
    assert.ok(panel.includes(`<span>${field}</span>`), `the bin must filter on ${field}`);
  }
  assert.match(panel, /days left/, "the screen must say when each thing expires");

  // The half of the old screen that had to survive.
  assert.match(panel, /Deletion history/);
  assert.match(panel, /This is a history, not a bin/);
});

/**
 * The reversal must be recorded as a reversal.
 *
 * The point is not decoration. Someone reading `recycle-bin.ts` in a year will
 * find a codebase that once argued, in several files and a test, that soft
 * delete was wrong here. If the reason it changed is not written down beside
 * the change, that argument reads as an oversight and is liable to be
 * "restored" by someone tidying up.
 */
test("the reversal is documented where the old decision used to be", async () => {
  for (const file of [SCHEMA, LIB, HISTORY_API, VIEW, MIGRATION]) {
    const source = await read(file);
    assert.match(
      source,
      /revers/i,
      `${file} must say the previous decision was reversed, not pretend it never existed`,
    );
    assert.match(
      source,
      /owner/i,
      `${file} must say on whose instruction`,
    );
  }
});
