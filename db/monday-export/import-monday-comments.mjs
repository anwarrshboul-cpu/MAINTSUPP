/**
 * Lands monday's comments in `item_updates`, with their replies.
 *
 * 221 comments and 54 replies across both boards. The table held 0 rows and
 * `maintenance_requests.comment_count` read 0 on all 775 requests, so the
 * running conversation about every job — who was called, what they said, when
 * they were coming — existed only on monday.
 *
 * WHY THIS WRITES THE DATABASE DIRECTLY, when the file import went through the
 * app's own API: there is no comment-import endpoint, and inventing one for a
 * one-off historical load would be a second write path for something the app
 * already writes one way. The file import needed the API because an attachment
 * is TWO writes — an R2 object and a row — that must not disagree. A comment is
 * one row, so the same argument does not apply.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every row's primary key is derived from monday's
 * own update id (`monday-update-<id>`, `monday-reply-<id>`), so a re-run
 * replaces rather than duplicates. That matters because this is exactly the
 * kind of import somebody runs twice after fixing one thing.
 *
 * REPLIES BECOME CHILD ROWS. `item_updates.parent_id` already exists, so
 * monday's nested shape maps without flattening. Flattening into the parent's
 * body would have lost who said what and when.
 *
 * Usage:
 *   node db/monday-export/import-monday-comments.mjs            # dry run
 *   node db/monday-export/import-monday-comments.mjs --commit
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SOURCE = path.join(HERE, "api-pull", "comments.json");

const DB_PATH = path.join(
  ROOT,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

const COMMIT = process.argv.includes("--commit");

if (!existsSync(SOURCE)) {
  console.error(`No pull at ${SOURCE}. Run pull-monday-comments.mjs first.`);
  process.exit(1);
}

const pulled = JSON.parse(readFileSync(SOURCE, "utf8"));
const db = new DatabaseSync(DB_PATH);

/*
 * Matching, exactly as the file import does it.
 *
 * Maintenance rows carry monday's item id in `external_id`, which is the only
 * stable identity they have — this board names 732 of its 744 items "Incoming
 * form answer", so a title match would fold hundreds of conversations onto one
 * job. Store rows carry no external_id and are matched on their name, which is
 * safe only because store names are unique ON THAT BOARD, so the index is
 * scoped to it.
 */
const byExternal = new Map();
const externalRows = db
  .prepare("SELECT id, external_id, organisation_id FROM maintenance_requests WHERE external_id IS NOT NULL")
  .all();
for (const row of externalRows) byExternal.set(String(row.external_id), row);

const storeRows = db
  .prepare(
    `SELECT r.id, r.title, r.organisation_id
       FROM maintenance_requests r
       JOIN maintenance_group_items gi ON gi.request_id = r.id
      WHERE gi.board_id = 'store-documentation'`,
  )
  .all();
const byStoreName = new Map(
  storeRows.map((row) => [row.title.toLowerCase().replace(/\s+/g, " ").trim(), row]),
);

/** Flattens monday's HTML-ish body to something a text column can hold. */
function cleanBody(value) {
  return (value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);
}

const planned = [];
const skipped = [];

for (const [label, items] of Object.entries(pulled)) {
  const boardId = label === "maintenance" ? "maintenance" : "store-documentation";
  for (const item of items) {
    const request =
      boardId === "maintenance"
        ? byExternal.get(String(item.id))
        : byStoreName.get(item.name.toLowerCase().replace(/\s+/g, " ").trim());

    if (!request) {
      skipped.push({ item: item.name, reason: `no ${boardId} row matches` });
      continue;
    }

    for (const update of item.updates ?? []) {
      const body = cleanBody(update.text_body);
      const assetCount = (update.assets ?? []).length;
      const replyList = update.replies ?? [];
      const parentId = `monday-update-${update.id}`;

      /*
       * AN UPDATE WITH NO WORDS IS NOT NECESSARILY AN EMPTY UPDATE.
       *
       * This used to `continue` on an empty `text_body`, on the reasoning that
       * "an empty comment on screen reads as a bug". True of an update that
       * carries nothing — but three of the ten it dropped are PICTURES with no
       * caption, which monday renders perfectly well as a card that is the
       * photograph: 599116482 (2 assets), 616199584 (2 assets) and 601041893
       * (1 asset). Those five are exactly the gap between the 58 assets in the
       * capture and the 53 that reached `attachments`.
       *
       * A parent with replies is kept for a different reason: `parent_id`
       * points at a row, and a reply whose parent was never written is
       * unreachable — `/api/updates` builds the thread from top-level rows and
       * hangs children off them, so an orphan is imported and then invisible.
       * Keeping the anchor is what makes the child readable.
       */
      const keep = Boolean(body) || assetCount > 0 || replyList.length > 0;
      if (keep) {
        planned.push({
          id: parentId,
          organisationId: request.organisation_id,
          boardId,
          requestId: request.id,
          parentId: null,
          authorName: update.creator?.name ?? "monday.com",
          authorEmail: update.creator?.email ?? null,
          body,
          createdAt: update.created_at,
          editedAt: update.updated_at !== update.created_at ? update.updated_at : null,
          assetCount,
        });
      } else {
        skipped.push({ item: item.name, reason: "empty comment: no body, no assets, no replies" });
      }

      /*
       * The replies are walked whatever happened to the parent.
       *
       * They used to sit under the `continue` above, so skipping one parent
       * skipped its entire conversation — which is how reply 616201331 ("We
       * sent an electrician on the 29th, but he could not fix the…", 255
       * characters of real text) was lost: not because anything was wrong with
       * it, but because the update it hung under had no caption. A reply is
       * only dropped now for its own emptiness, and only when its parent
       * survives to hold it.
       */
      if (!keep) continue;
      for (const reply of replyList) {
        const replyBody = cleanBody(reply.text_body);
        // A reply carries no assets in the capture — the pull does not ask for
        // them — so an empty body really is nothing to show.
        if (!replyBody) {
          skipped.push({ item: item.name, reason: "empty reply body" });
          continue;
        }
        planned.push({
          id: `monday-reply-${reply.id}`,
          organisationId: request.organisation_id,
          boardId,
          requestId: request.id,
          parentId,
          authorName: reply.creator?.name ?? "monday.com",
          authorEmail: reply.creator?.email ?? null,
          body: replyBody,
          createdAt: reply.created_at,
          editedAt: null,
          assetCount: 0,
        });
      }
    }
  }
}

const parents = planned.filter((row) => !row.parentId).length;
const replies = planned.length - parents;
const withAssets = planned.filter((row) => row.assetCount > 0).length;
// Named separately because these are the rows the old skip lost: a picture
// with no caption. `import-comment-assets.mjs` can only reach an asset whose
// comment exists, so this number is the ceiling on what it can attach.
const pictureOnly = planned.filter((row) => !row.body && row.assetCount > 0).length;
const requests = new Set(planned.map((row) => row.requestId)).size;

console.log(`planned : ${planned.length} rows — ${parents} comments, ${replies} replies`);
console.log(`          across ${requests} jobs; ${withAssets} comments carry an image on monday`);
console.log(`          ${pictureOnly} of those have no caption — the card IS the picture`);
console.log(`skipped : ${skipped.length}`);
const reasons = {};
for (const entry of skipped) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
for (const [reason, count] of Object.entries(reasons)) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}

if (!COMMIT) {
  console.log("\nDry run. Nothing written. Pass --commit.");
  db.close();
  process.exit(0);
}

const insert = db.prepare(
  `INSERT INTO item_updates
     (id, organisation_id, board_id, request_id, parent_id,
      author_name, author_email, body, edited_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     body = excluded.body,
     author_name = excluded.author_name,
     author_email = excluded.author_email,
     edited_at = excluded.edited_at`,
);

let written = 0;
for (const row of planned) {
  insert.run(
    row.id,
    row.organisationId,
    row.boardId,
    row.requestId,
    row.parentId,
    row.authorName,
    row.authorEmail,
    row.body,
    row.editedAt,
    row.createdAt,
  );
  written += 1;
}

/*
 * The counter, recomputed from the rows rather than incremented.
 *
 * `comment_count` is denormalised, and this codebase has already been bitten
 * once by exactly that: `issue_attachment_count` read 2,281 with no matching
 * row behind it because something wrote the counter and nothing reconciled it.
 * Setting it from a COUNT means a re-run cannot drift, and a comment deleted
 * outside this script is corrected the next time it runs.
 */
const counted = db
  .prepare(
    `UPDATE maintenance_requests
        SET comment_count = (
          SELECT COUNT(*) FROM item_updates u
           WHERE u.request_id = maintenance_requests.id
        )`,
  )
  .run();

console.log(`\nwritten ${written} rows`);
console.log(`comment_count recomputed on ${counted.changes} requests`);
console.log(
  `jobs now carrying a comment: ${db.prepare("SELECT COUNT(*) c FROM maintenance_requests WHERE comment_count > 0").get().c}`,
);

db.close();
