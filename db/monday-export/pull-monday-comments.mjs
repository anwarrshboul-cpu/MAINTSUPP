/**
 * Pulls every comment (monday calls them "updates") from both boards.
 *
 * These have never been in the app: `item_updates` holds 0 rows and
 * `comment_count` reads 0 on all 775 requests, while monday carries the running
 * conversation about each job — who was called, what they said, when they are
 * coming. On a maintenance board that thread is often the only record of why a
 * job took three weeks.
 *
 * An Excel export does not carry updates at all, which is why this needs the
 * API like the file columns did.
 *
 * Separate from `pull-monday-api.mjs` because the query shape is different and
 * much heavier — updates carry replies, and both carry their own assets — so it
 * pages smaller and is worth re-running on its own when the conversation moves
 * on without the board changing.
 *
 * Read-only. Writes JSON beside itself; `import-monday-comments.mjs` decides
 * what lands in the database.
 *
 * Usage:
 *   set -a; . ./.env.monday; set +a
 *   node db/monday-export/pull-monday-comments.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "api-pull");

const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) {
  console.error("MONDAY_API_TOKEN is not set. `set -a; . ./.env.monday; set +a`");
  process.exit(1);
}

const BOARDS = [
  { id: "1139774521", label: "maintenance" },
  { id: "1398027719", label: "store-documentation" },
];

/*
 * 25, against 50 for the plain item pull.
 *
 * An update carries a body, a creator, its replies and its assets, and monday
 * bills a query by complexity — so the same page size that worked for columns
 * is refused here. A refusal costs the whole page, so smaller is faster.
 */
const PAGE_SIZE = 25;

async function query(gql, attempt = 1) {
  const response = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query: gql }),
  });

  if (response.status === 429) {
    const wait = Number(response.headers.get("Retry-After") ?? 30);
    if (attempt > 5) throw new Error("Rate limited five times; giving up.");
    console.log(`  rate limited, waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return query(gql, attempt + 1);
  }

  const body = await response.json();
  if (body.errors) {
    const message = JSON.stringify(body.errors);
    const seconds = /reset in (\d+) seconds/.exec(message);
    if (seconds && attempt <= 5) {
      const wait = Number(seconds[1]) + 2;
      console.log(`  complexity budget spent, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return query(gql, attempt + 1);
    }
    throw new Error(`monday API: ${message}`);
  }
  return body.data;
}

const ITEM_FIELDS = `
  id
  name
  updates {
    id
    text_body
    created_at
    updated_at
    creator { id name email }
    assets { id name public_url file_extension file_size }
    replies {
      id
      text_body
      created_at
      creator { id name email }
    }
  }
`;

async function pullBoard(board) {
  const items = [];
  let cursor = null;
  let page = 0;
  do {
    page += 1;
    const gql = cursor
      ? `{ next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") { cursor items { ${ITEM_FIELDS} } } }`
      : `{ boards(ids: [${board.id}]) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${ITEM_FIELDS} } } } }`;
    const data = await query(gql);
    const pageData = data.next_items_page ?? data.boards[0].items_page;
    // Only items that actually said something are worth keeping.
    items.push(...pageData.items.filter((item) => (item.updates ?? []).length));
    cursor = pageData.cursor;
    const totals = items.reduce((sum, item) => sum + item.updates.length, 0);
    console.log(`  ${board.label} page ${page}: ${items.length} items with comments, ${totals} comments`);
  } while (cursor);
  return items;
}

mkdirSync(OUT_DIR, { recursive: true });

const output = {};
let comments = 0;
let replies = 0;
let assets = 0;

for (const board of BOARDS) {
  console.log(`${board.label} (${board.id})`);
  const items = await pullBoard(board);
  output[board.label] = items;
  for (const item of items) {
    for (const update of item.updates) {
      comments += 1;
      replies += (update.replies ?? []).length;
      assets += (update.assets ?? []).length;
    }
  }
}

writeFileSync(
  path.join(OUT_DIR, "comments.json"),
  `${JSON.stringify(output, null, 1)}\n`,
);

console.log("\n--- pulled ---");
console.log(`comments        : ${comments}`);
console.log(`replies         : ${replies}`);
console.log(`comment assets  : ${assets}`);
console.log(`\nwritten to ${path.relative(process.cwd(), path.join(OUT_DIR, "comments.json"))}`);
