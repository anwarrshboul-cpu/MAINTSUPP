/**
 * Derives each attachment's `kind` from the board column it was filed in.
 *
 * Every one of the 2,915 imported attachments carries `kind = 'general'`,
 * because `POST /api/files` forces that whenever a `columnId` is supplied — a
 * rule written for custom file columns, applied to the three monday system
 * columns that DO mean something.
 *
 * Two consumers filter on `kind` and therefore see nothing:
 *
 *   app/api/job-link/[token]/route.ts   kind = 'issue'      the contractor's
 *                                                            view of the fault
 *   app/(app)/portal/views/fix-tracker  kind === 'issue'     the engineer's
 *
 * So 1,149 fault photographs are invisible to exactly the two people who need
 * them, and the share link's "upload a photo before completing" gate counts
 * `kind = 'completion'`, of which there are zero — it has been measuring the
 * wrong thing on every imported job.
 *
 * The column is the authority: `issuePictures` and `completedPictures` are
 * monday's own names for these, captured verbatim in `db/monday-board-spec.ts`.
 * `board_column_id` was set correctly by the import; only the derived label was
 * wrong.
 *
 * NOTHING IS DELETED and no file moves. This rewrites one text column, and only
 * where the board column says something different from what is stored.
 *
 * Dry run by default:
 *   node scripts/repair-attachment-kinds.mjs
 *   node scripts/repair-attachment-kinds.mjs --yes
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(
  root,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

if (!existsSync(DB)) {
  console.error(`No local database at:\n  ${DB}`);
  process.exit(1);
}

const commit = process.argv.includes("--yes");
const db = new DatabaseSync(DB);

/**
 * Column key → the evidence kind it holds.
 *
 * Only the three maintenance system columns appear. A Store Documentation
 * certificate and a genuine custom file column are both `general`, which is
 * what they already are, so they are left alone rather than relabelled to
 * something the app has no meaning for.
 */
const KIND_BY_COLUMN = {
  issuePictures: "issue",
  completedPictures: "completion",
  files: "general",
};

const rows = db
  .prepare(
    `SELECT a.id, a.kind, c.column_key, c.board_id
       FROM attachments a
       JOIN maintenance_board_columns c ON c.id = a.board_column_id
      WHERE c.board_id = 'maintenance'`,
  )
  .all();

const planned = [];
for (const row of rows) {
  const wanted = KIND_BY_COLUMN[row.column_key];
  if (!wanted || wanted === row.kind) continue;
  planned.push({ id: row.id, from: row.kind, to: wanted, column: row.column_key });
}

const summary = {};
for (const row of planned) {
  const key = `${row.column} : ${row.from} -> ${row.to}`;
  summary[key] = (summary[key] ?? 0) + 1;
}

console.log(`${rows.length} maintenance attachments carry a board column.`);
console.log(`${planned.length} have a kind that disagrees with it.\n`);
for (const [key, count] of Object.entries(summary)) {
  console.log(`  ${String(count).padStart(5)}  ${key}`);
}

if (!planned.length) {
  console.log("\nNothing to repair.");
  db.close();
  process.exit(0);
}

if (!commit) {
  console.log("\nDry run. Nothing written. Pass --yes.");
  db.close();
  process.exit(0);
}

const update = db.prepare("UPDATE attachments SET kind = ? WHERE id = ?");
for (const row of planned) update.run(row.to, row.id);

/*
 * The per-request counters, recomputed rather than adjusted.
 *
 * `issue_attachment_count` read 2,281 with no issue-kind row behind it and
 * `completed_attachment_count` read 0 against 1,616 real photographs — the
 * counters had drifted from the rows entirely. Setting all four from a COUNT
 * makes them true, and makes a re-run idempotent.
 */
const counters = db
  .prepare(
    `UPDATE maintenance_requests SET
       attachment_count = (SELECT COUNT(*) FROM attachments a WHERE a.request_id = maintenance_requests.id),
       issue_attachment_count = (SELECT COUNT(*) FROM attachments a WHERE a.request_id = maintenance_requests.id AND a.kind = 'issue'),
       completed_attachment_count = (SELECT COUNT(*) FROM attachments a WHERE a.request_id = maintenance_requests.id AND a.kind = 'completion'),
       general_attachment_count = (SELECT COUNT(*) FROM attachments a WHERE a.request_id = maintenance_requests.id AND a.kind = 'general')`,
  )
  .run();

console.log(`\nrepaired ${planned.length} attachments`);
console.log(`counters recomputed on ${counters.changes} requests`);

for (const row of db
  .prepare("SELECT kind, COUNT(*) c FROM attachments GROUP BY kind ORDER BY c DESC")
  .all()) {
  console.log(`  ${String(row.c).padStart(5)}  ${row.kind}`);
}

db.close();
