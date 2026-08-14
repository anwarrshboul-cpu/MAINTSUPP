/**
 * Pulls the parts of the two monday boards that an Excel export cannot carry.
 *
 * monday's "Export board to Excel" writes an attachment as a URL that monday
 * will not serve without a token, and it exports the parent board only. So the
 * file columns, the Store Documentation expiry dates that sit beside them, and
 * any subitems have to come from the API instead. That is all this script does:
 * it reads, it writes JSON beside this file, and it never touches the database.
 *
 * Nothing here decides what lands in the app — `import-monday-assets.mjs` does
 * that, against the same importer rules as the CSV path. Keeping the pull and
 * the write apart is what makes the pull safe to re-run: it is idempotent by
 * construction because it has no side effect beyond overwriting its own output.
 *
 * Usage:
 *   set -a; . ./.env.monday; set +a
 *   node db/monday-export/pull-monday-api.mjs
 *
 * Writes db/monday-export/api-pull/{maintenance,store-documentation,subitems}.json
 * plus manifest.json — the asset list the downloader walks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "api-pull");

const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN) {
  console.error(
    "MONDAY_API_TOKEN is not set. Source the gitignored env file first:\n" +
      "  set -a; . ./.env.monday; set +a",
  );
  process.exit(1);
}

const MAINTENANCE_BOARD = "1139774521";
const STORE_DOC_BOARD = "1398027719";
const SUBITEM_BOARD = "1164003119";

/*
 * 50, not monday's maximum of 500.
 *
 * The API bills a query by complexity, and asking for `assets` on top of every
 * column value multiplies the cost per item. A 500-item page with assets is
 * refused outright with COMPLEXITY_BUDGET_EXHAUSTED, and the failure arrives
 * after the whole page has been computed — so a smaller page is not slower in
 * practice, it is the difference between finishing and not.
 */
const PAGE_SIZE = 50;

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

  /*
   * 429 carries `Retry-After`; complexity exhaustion arrives as a 200 with an
   * error body naming the seconds to wait. Both are worth waiting out rather
   * than failing the run — a 744-item pull that dies on page 7 has to start
   * again, and every restart spends the budget it is waiting for.
   */
  if (response.status === 429) {
    const wait = Number(response.headers.get("Retry-After") ?? 30);
    if (attempt > 5) throw new Error("Rate limited five times; giving up.");
    console.log(`  rate limited, waiting ${wait}s (attempt ${attempt})`);
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
  group { id title }
  column_values { id type text value }
  assets { id name public_url file_size file_extension created_at uploaded_by { id name } }
`;

/** Every item on a board, following the cursor to the end. */
async function pullBoard(boardId, label) {
  const items = [];
  let cursor = null;
  let page = 0;
  do {
    page += 1;
    const gql = cursor
      ? `{ next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") { cursor items { ${ITEM_FIELDS} } } }`
      : `{ boards(ids: [${boardId}]) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${ITEM_FIELDS} } } } }`;
    const data = await query(gql);
    const pageData = data.next_items_page ?? data.boards[0].items_page;
    items.push(...pageData.items);
    cursor = pageData.cursor;
    console.log(`  ${label} page ${page}: ${pageData.items.length} items (${items.length} total)`);
  } while (cursor);
  return items;
}

/**
 * Which column an asset belongs to.
 *
 * `item.assets` is a flat list with no column on it, so the mapping has to come
 * from the file column's own value — `{"files":[{"assetId":123,...}]}`. Without
 * this every certificate would arrive as an unfiled attachment and the
 * compliance register could not tell a PAT certificate from a fire door report.
 */
function assetColumnIndex(item) {
  const index = new Map();
  for (const cv of item.column_values) {
    if (cv.type !== "file" || !cv.value || cv.value === "null") continue;
    let parsed;
    try {
      parsed = JSON.parse(cv.value);
    } catch {
      continue;
    }
    for (const file of parsed.files ?? []) {
      if (file.assetId != null) index.set(String(file.assetId), cv.id);
    }
  }
  return index;
}

/** The flat asset list the downloader walks, with its board column attached. */
function buildManifest(items, boardId, boardLabel) {
  const rows = [];
  for (const item of items) {
    const columnOf = assetColumnIndex(item);
    for (const asset of item.assets ?? []) {
      rows.push({
        boardId,
        boardLabel,
        itemId: item.id,
        itemName: item.name,
        columnId: columnOf.get(String(asset.id)) ?? null,
        assetId: String(asset.id),
        name: asset.name,
        publicUrl: asset.public_url,
        byteSize: Number(asset.file_size ?? 0),
        extension: asset.file_extension,
        createdAt: asset.created_at,
      });
    }
  }
  return rows;
}

mkdirSync(OUT_DIR, { recursive: true });

/*
 * Column titles, saved separately.
 *
 * An item's `column_values` carry the monday column *id* and no title, and the
 * app's own columns are keyed by title (that is how the CSV importer matches).
 * Without this file the import step has nothing to join on but a hardcoded id
 * table, which is exactly the kind of third declaration of board structure that
 * put 38 columns on a 25-column board.
 */
console.log("board columns");
const columnData = await query(
  `{ boards(ids: [${STORE_DOC_BOARD}, ${MAINTENANCE_BOARD}, ${SUBITEM_BOARD}]) {
      id name columns { id title type settings_str }
    } }`,
);
writeFileSync(
  path.join(OUT_DIR, "columns.json"),
  `${JSON.stringify(columnData.boards, null, 1)}\n`,
);

console.log("Store Documentation UK (1398027719)");
const storeDoc = await pullBoard(STORE_DOC_BOARD, "store-doc");
writeFileSync(
  path.join(OUT_DIR, "store-documentation.json"),
  `${JSON.stringify(storeDoc, null, 1)}\n`,
);

console.log("Maintenance (1139774521)");
const maintenance = await pullBoard(MAINTENANCE_BOARD, "maintenance");
writeFileSync(
  path.join(OUT_DIR, "maintenance.json"),
  `${JSON.stringify(maintenance, null, 1)}\n`,
);

console.log("Subitems of Maintenance (1164003119)");
const subitems = await pullBoard(SUBITEM_BOARD, "subitems");
writeFileSync(
  path.join(OUT_DIR, "subitems.json"),
  `${JSON.stringify(subitems, null, 1)}\n`,
);

const manifest = [
  ...buildManifest(storeDoc, STORE_DOC_BOARD, "store-documentation"),
  ...buildManifest(maintenance, MAINTENANCE_BOARD, "maintenance"),
  ...buildManifest(subitems, SUBITEM_BOARD, "subitems"),
];
writeFileSync(
  path.join(OUT_DIR, "manifest.json"),
  `${JSON.stringify(manifest, null, 1)}\n`,
);

/*
 * An asset with no column is reported, never dropped silently. It means a file
 * lives in an update or was removed from its cell but not from the item, and
 * the importer has nowhere to file it — which is a thing to know before the
 * counts are read as complete.
 */
const unfiled = manifest.filter((row) => !row.columnId);
const bytes = manifest.reduce((total, row) => total + row.byteSize, 0);

console.log("\n--- pulled ---");
console.log(`store documentation items : ${storeDoc.length}`);
console.log(`maintenance items         : ${maintenance.length}`);
console.log(`subitems                  : ${subitems.length}`);
console.log(`assets                    : ${manifest.length}`);
console.log(`  of which unfiled        : ${unfiled.length}`);
console.log(`total bytes               : ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`\nwritten to ${path.relative(process.cwd(), OUT_DIR)}`);
