/**
 * Removes `maintenance_group_items` rows whose job no longer exists.
 *
 * WHAT BREAKS WITHOUT THIS, and why it is worth a script.
 *
 * `maintenance_group_items.request_id` is the PRIMARY KEY, and the next job
 * reference is chosen as `max(MN-…) + 1` over `maintenance_requests` ALONE. So
 * a placement that outlives its job silently poisons the sequence: the
 * generator re-issues an id the placements table already holds, the insert
 * fails on the primary key, and `POST /api/board {action:"create_item"}`
 * answers a bare 503 — "The board change could not be saved." — with the real
 * cause swallowed by the route's catch. On the affected board NOBODY CAN CREATE
 * A JOB until the sequence has climbed past the highest orphan.
 *
 * Observed on the local dev database on 2026-09-05: `maintenance_requests`
 * topped out at MN-1157 while `maintenance_group_items` held MN-1158, MN-1160,
 * MN-1161 and MN-1162 — four placements left behind by QA runs that deleted the
 * request rows directly instead of going through the app's own purge (which
 * does remove both). Every `create_item` on the maintenance board 503'd.
 *
 * WHAT THIS DOES NOT DO.
 *
 * It does not touch a placement whose request exists — not a soft-deleted one
 * either. A job in the recycle bin still owns its placement; `recycle_bin`
 * snapshots it precisely so a restore can put the row back where it was, and
 * deleting it here would make that restore silently lose the job's group. The
 * only rows removed are those with NO `maintenance_requests` row at all, which
 * cannot be rendered, restored or reached by anything.
 *
 * Each candidate is re-checked against `maintenance_requests` immediately
 * before its own DELETE, by exact id, so a job created between the scan and the
 * write cannot be caught by it.
 *
 * Dry run by default — it prints what it would remove and changes nothing:
 *
 *   node scripts/repair-orphaned-placements.mjs
 *   node scripts/repair-orphaned-placements.mjs --yes
 *
 * Stop the dev server first: Miniflare holds the SQLite file open, and a second
 * writer will either block on the busy timeout or fail outright.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--yes");

/* The Miniflare D1 file is named by a content hash, so it is found rather than
   hardcoded — the hash changes when the local database is rebuilt. */
const d1Dir = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
if (!existsSync(d1Dir)) {
  console.error(`No local D1 directory at ${d1Dir}. Nothing to repair.`);
  process.exit(69);
}
const candidates = readdirSync(d1Dir).filter(
  (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
);
if (candidates.length !== 1) {
  console.error(
    `Expected exactly one D1 database in ${d1Dir}, found ${candidates.length}: ${candidates.join(", ")}`,
  );
  process.exit(69);
}
const dbPath = path.join(d1Dir, candidates[0]);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 8000");

const orphans = db
  .prepare(
    `SELECT gi.request_id, gi.board_id, gi.group_id, gi.created_at
       FROM maintenance_group_items gi
       LEFT JOIN maintenance_requests r ON r.id = gi.request_id
      WHERE r.id IS NULL
      ORDER BY gi.request_id`,
  )
  .all();

console.log(`Database: ${dbPath}`);
console.log(`Orphaned placements: ${orphans.length}`);
for (const row of orphans) {
  console.log(
    `  ${row.request_id}  board=${row.board_id}  group=${row.group_id}  created=${row.created_at}`,
  );
}

/* The sequence, before and after — the number this repair exists to unblock. */
const maxOf = (sql) => db.prepare(sql).get()?.mx ?? null;
const maxRequest = maxOf(
  "SELECT max(cast(substr(id, 4) as integer)) AS mx FROM maintenance_requests WHERE id LIKE 'MN-%'",
);
const maxPlacement = maxOf(
  "SELECT max(cast(substr(request_id, 4) as integer)) AS mx FROM maintenance_group_items WHERE request_id LIKE 'MN-%'",
);
console.log(`\nmax MN in maintenance_requests:     ${maxRequest}`);
console.log(`max MN in maintenance_group_items: ${maxPlacement}`);
if (maxPlacement !== null && maxRequest !== null && maxPlacement > maxRequest) {
  console.log(
    `  -> the next reference (MN-${maxRequest + 1}) collides; create_item will 503 until this is cleared.`,
  );
}

/*
 * THE SAME FAULT IN A SECOND TABLE.
 *
 * `recycle_bin` is UNIQUE on (organisation_id, entity_type, entity_id). An
 * entry left behind by a purge therefore blocks the DELETE of whatever that
 * reference is next issued to: the bin insert collides and `delete_items`
 * answers the same bare 503. Observed here as entries for MN-1161 and MN-1162
 * written at 09:36 by a QA run whose jobs are long gone, against jobs created
 * at 21:46 that are very much alive.
 *
 * The test is deliberately NOT "the job is missing". It is "the bin claims a
 * job is deleted while that job is LIVE" — `deleted_at IS NULL`. A bin row
 * whose job really is soft-deleted is a genuine entry and is left alone.
 */
const staleBin = db
  .prepare(
    `SELECT b.id, b.entity_type, b.entity_id, b.title, b.deleted_at
       FROM recycle_bin b
       JOIN maintenance_requests r ON r.id = b.entity_id
      WHERE b.entity_type = 'job' AND r.deleted_at IS NULL
      ORDER BY b.entity_id`,
  )
  .all();

console.log(`
Stale bin entries (bin says deleted, job is live): ${staleBin.length}`);
for (const row of staleBin) {
  console.log(`  ${row.entity_id}  binned=${row.deleted_at}  ${String(row.title).slice(0, 56)}`);
}

if (!orphans.length && !staleBin.length) {
  console.log("\nNothing to do.");
  process.exit(0);
}

if (!apply) {
  console.log("\nDry run. Re-run with --yes to remove the rows listed above.");
  process.exit(0);
}

const stillGone = db.prepare("SELECT 1 AS live FROM maintenance_requests WHERE id = ?");
const remove = db.prepare("DELETE FROM maintenance_group_items WHERE request_id = ?");
let removed = 0;
for (const row of orphans) {
  // Re-checked by exact id immediately before its own delete: a job created
  // since the scan above must not be caught by a stale candidate list.
  if (stillGone.get(row.request_id)) {
    console.log(`SKIP ${row.request_id} — a job with that id now exists.`);
    continue;
  }
  removed += remove.run(row.request_id).changes;
  console.log(`removed ${row.request_id}`);
}
console.log(`\nRemoved ${removed} orphaned placement(s).`);

const stillLive = db.prepare(
  "SELECT 1 AS live FROM maintenance_requests WHERE id = ? AND deleted_at IS NULL",
);
const dropBin = db.prepare("DELETE FROM recycle_bin WHERE id = ?");
let binRemoved = 0;
for (const row of staleBin) {
  // Re-checked by exact id: if the job has been soft-deleted since the scan,
  // the entry is genuine now and must stay.
  if (!stillLive.get(row.entity_id)) {
    console.log(`SKIP ${row.entity_id} — its job is soft-deleted, so the entry is real.`);
    continue;
  }
  binRemoved += dropBin.run(row.id).changes;
  console.log(`removed stale bin entry for ${row.entity_id}`);
}
console.log(`Removed ${binRemoved} stale bin entr${binRemoved === 1 ? "y" : "ies"}.`);

