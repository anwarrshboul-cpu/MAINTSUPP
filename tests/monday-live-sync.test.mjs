/**
 * The live monday.com → Sunnamusk workspace sync (owner, 2026-10-04).
 * One way only; new items and every change to existing ones follow.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the sync writes through the file import's own commit, matched on monday's item id", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /import \{ commit, jobTypeMatcher \} from "\.\.\/api\/import\/route";/);
  assert.match(lib, /const outcome = await commit\(db, orgId, board\.key, plan, batchId, board\.key === "maintenance" \? matchJobType : null\);/);
  assert.match(lib, /const titles = \["Name", "Item ID"\];/, "Item ID carries monday's id, so jobs are never duplicated");
  assert.match(lib, /return planImport\(rows, board\);/);
  const route = await read("app/api/import/route.ts");
  assert.match(route, /export async function commit\(/);
  assert.match(route, /export function jobTypeMatcher\(/);
});

test("only Maintenance and Store Documentation, and nothing is ever written back to monday", async () => {
  /* Re-pointed 2026-10-04 (owner): Store Documentation joined Maintenance, so
     the one-board check became "one of our two boards". */
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /const board = syncedBoardFor\(item\.board\?\.id\);/);
  assert.match(lib, /if \(board && \(live \|\| known\.has\(String\(item\.id\)\)\)\) items\.push\(\{ item, board \}\);/);
  assert.match(lib, /const DEFAULT_BOARD_ID = "1139774521";/);
  assert.match(lib, /const DEFAULT_STORE_DOC_BOARD_ID = "1398027719";/);
  /* The only mutation sent to monday is registering our own webhooks. */
  const mutations = lib.match(/mutation \(/g) ?? [];
  assert.equal(mutations.length, 1);
  assert.match(lib, /create_webhook\(board_id: \$board, url: \$url, event: \$event\)/);
});

test("comments keep the historical import's ids, so they replace rather than repeat", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /const parentId = `monday-update-\$\{update\.id\}`;/);
  assert.match(lib, /id: `monday-reply-\$\{reply\.id\}`,/);
  assert.match(lib, /\.onConflictDoUpdate\(\{\s*target: itemUpdates\.id,/);
});

test("the webhook needs its key, answers monday's handshake and re-reads the item itself", async () => {
  const hook = await read("app/api/integrations/monday/webhook/route.ts");
  assert.match(hook, /if \(!config\.configured \|\| !sameKey\(key, await mondayWebhookKey\(\)\)\) \{\s*return Response\.json\(\{ error: "Not accepted\." \}, \{ status: 403 \}\);/);
  assert.match(hook, /return Response\.json\(\{ challenge: payload\.challenge \}\);/);
  assert.match(hook, /await syncMondayItems\(db, \[itemId\], \{ budgetMs: 25_000 \}\)/);
});

test("one variable is enough: the webhook key is derived from the token when not set", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /if \(secret\) return secret;/);
  assert.match(lib, /crypto\.subtle\.sign\("HMAC", key, new TextEncoder\(\)\.encode\("maintsupp-monday-webhook"\)\)/);
});

test("the control endpoint is MAINTSUPP staff with a real session only", async () => {
  const route = await read("app/api/integrations/monday/route.ts");
  assert.match(route, /if \(!scope\.platformAdmin \|\| !scope\.authenticated\) \{/);
});

test("the daily run catches up anything a webhook missed", async () => {
  const daily = await read("app/api/cron/daily/route.ts");
  assert.match(daily, /const monday = await catchUpMondaySync\(db, 2\)\.catch\(/);
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /if \(!config\.token\) return \{ skipped: "MONDAY_API_TOKEN is not set" \} as const;/);
});

test("store rows are linked to monday by exact name on their own board, never a guess", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  const link = lib.slice(lib.indexOf("async function linkStoreDocumentationRows"));
  assert.match(link, /eq\(maintenanceGroupItems\.boardId, "store-documentation"\)/);
  assert.match(link, /isNull\(maintenanceRequests\.externalId\)/);
  assert.match(link, /if \(matches\.length !== 1\) continue;/);
});

test("files are copied once: the historical import's ledger key, on the column they sit in", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  const files = lib.slice(lib.indexOf("async function copyMondayFiles"));
  /* Re-pointed 2026-10-04 (owner): comment files joined column files, so the
     ledger's middle term is the slot — the column, or the comment. */
  assert.match(files, /`\$\{row\.requestId\}\|\$\{slotOf\(row\)\}\|\$\{row\.name\}\|\$\{row\.size\}`/);
  assert.match(files, /row\.updateId \? `update:\$\{row\.updateId\}` : `column:\$\{row\.columnId\}`/);
  assert.match(files, /const kind = entry\.columnKey \? kindForColumnKey\(entry\.columnKey\) : "general";/);
  assert.match(files, /for \(const requestId of touched\) await reconcileAttachmentCounts\(db, orgId, requestId\);/);
  assert.match(files, /if \(Date\.now\(\) > deadline\) \{\s*result\.filesPending \+= 1;/, "a long run stops in time and resumes later");
});

test("comment pictures are copied onto the comment that carried them", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /assets \{ id name file_size public_url \}\n    replies \{/);
  assert.match(lib, /\[`monday-update-\$\{update\.id\}`, update\.assets \?\? \[\]\]/);
  assert.match(lib, /if \(!body && !replies\.length && !\(update\.assets \?\? \[\]\)\.length\) continue;/);
});

test("each certificate file carries its row's expiry date; a blank date clears nothing", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  const fn = lib.slice(lib.indexOf("async function applyCertificateExpiry"));
  assert.match(fn, /const date = dateOnlyValue\(cellValue\.get\(`\$\{requestId\}\|\$\{expiryColumnId\}`\)\);/);
  assert.match(fn, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(date\)\) continue;/);
  assert.match(fn, /eq\(attachments\.boardColumnId, fileColumnId\),\s*isNull\(attachments\.archivedAt\),/);
});

test("missing files are put back at the key the row already names — no row is written", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  const fn = lib.slice(lib.indexOf("export async function repairMissingFiles"), lib.indexOf("/** The daily catch-up"));
  assert.match(fn, /if \(await bucket\.head\(row\.objectKey\)\) \{\s*result\.present \+= 1;/);
  assert.match(fn, /await bucket\.put\(row\.objectKey, bytes,/);
  assert.doesNotMatch(fn, /db\s*\.\s*(insert|update|delete)\(/, "the repair never touches a row");
});
