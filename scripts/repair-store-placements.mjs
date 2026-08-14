/**
 * Puts Store Documentation rows back on the Store Documentation board.
 *
 * `maintenance_group_items` carries both a `board_id` and a `group_id`, and
 * they can disagree. One row does: sd-020, the Merry Hill store, is filed with
 * `board_id = "store-documentation"` while its `group_id` points at the
 * *maintenance* group "Merry Hill completed". An earlier title-keyed import put
 * it there — the same class of bug that folded 713 maintenance jobs onto 20
 * rows, surviving on the one board where names are otherwise unique.
 *
 * What it cost: the Store Documentation board draws 30 of its 31 stores, and
 * Merry Hill's PAT certificate and RAMS document had nowhere to be filed —
 * `boardKeyForRequest` reads the placement to decide which columns a row may
 * use, and answered "maintenance" for a store.
 *
 * NOTHING IS DELETED. This repoints a placement's `group_id` at the group the
 * monday capture says the store belongs to. The request row, its cells, its
 * attachments and the audit log are untouched, and the previous group id is
 * printed so the change can be reversed by hand.
 *
 * Dry run by default:
 *   node scripts/repair-store-placements.mjs
 *   node scripts/repair-store-placements.mjs --yes
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(
  root,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);
const CAPTURE = path.join(root, "db/monday-export/api-pull/store-documentation.json");

if (!existsSync(DB)) {
  console.error(`No local database at:\n  ${DB}`);
  process.exit(1);
}
if (!existsSync(CAPTURE)) {
  console.error(
    `No monday capture at:\n  ${CAPTURE}\nRun db/monday-export/pull-monday-api.mjs first.`,
  );
  process.exit(1);
}

const commit = process.argv.includes("--yes");
const db = new DatabaseSync(DB);

/** The group monday says each store sits in, keyed by normalised name. */
const mondayGroup = new Map(
  JSON.parse(readFileSync(CAPTURE, "utf8")).map((item) => [
    item.name.toLowerCase().replace(/\s+/g, " ").trim(),
    item.group?.title ?? "Current stores",
  ]),
);

/*
 * A placement is wrong when its group belongs to a different board than the
 * placement claims. Checked as a join rather than by listing known-bad ids, so
 * this finds any other row that has drifted the same way rather than only the
 * one that was noticed.
 */
const broken = db
  .prepare(
    `SELECT gi.request_id, gi.board_id AS claimed_board, gi.group_id AS current_group,
            gi.organisation_id, gi.position, g.board_id AS group_board, g.name AS group_name,
            r.title
       FROM maintenance_group_items gi
       JOIN maintenance_groups g ON g.id = gi.group_id
       JOIN maintenance_requests r ON r.id = gi.request_id
      WHERE gi.board_id <> g.board_id`,
  )
  .all();

if (!broken.length) {
  console.log("Every placement's group belongs to the board it claims. Nothing to do.");
  db.close();
  process.exit(0);
}

console.log(`${broken.length} placement(s) point at a group on another board:\n`);

let repaired = 0;
let unresolved = 0;

for (const row of broken) {
  const wantedGroupName = mondayGroup.get(
    row.title.toLowerCase().replace(/\s+/g, " ").trim(),
  );
  console.log(`  ${row.request_id}  "${row.title}"`);
  console.log(`    claims board : ${row.claimed_board}`);
  console.log(`    sits in group: "${row.group_name}" (board ${row.group_board})`);

  if (!wantedGroupName) {
    console.log(`    -> monday has no row of this name; left alone\n`);
    unresolved += 1;
    continue;
  }

  const target = db
    .prepare(
      `SELECT id, name FROM maintenance_groups
        WHERE board_id = ? AND organisation_id = ?
          AND lower(trim(name)) = lower(trim(?))`,
    )
    .get(row.claimed_board, row.organisation_id, wantedGroupName);

  if (!target) {
    console.log(
      `    -> no "${wantedGroupName}" group on ${row.claimed_board}; left alone\n`,
    );
    unresolved += 1;
    continue;
  }

  console.log(`    monday says  : "${wantedGroupName}"`);
  console.log(`    -> move to   : ${target.id}`);
  console.log(`       (was      : ${row.current_group})\n`);

  if (commit) {
    db.prepare(
      `UPDATE maintenance_group_items
          SET group_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND organisation_id = ?`,
    ).run(target.id, row.request_id, row.organisation_id);
  }
  repaired += 1;
}

console.log(
  commit
    ? `Repaired ${repaired}, left alone ${unresolved}.`
    : `Dry run. ${repaired} would be repaired, ${unresolved} left alone. Pass --yes to write.`,
);

db.close();
