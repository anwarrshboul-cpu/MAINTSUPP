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
  assert.match(lib, /await commit\(db, orgId, BOARD_KEY, plan, batchId, jobTypeMatcher\(await listJobTypes\(db, orgId\)\)\)/);
  assert.match(lib, /const titles = \["Name", "Item ID"\];/, "Item ID carries monday's id, so jobs are never duplicated");
  assert.match(lib, /return planImport\(rows, "maintenance"\);/);
  const route = await read("app/api/import/route.ts");
  assert.match(route, /export async function commit\(/);
  assert.match(route, /export function jobTypeMatcher\(/);
});

test("only the configured board, and nothing is ever written back to monday", async () => {
  const lib = await read("app/lib/monday-live-sync.ts");
  assert.match(lib, /const onBoard = String\(item\.board\?\.id \?\? ""\) === config\.boardId;/);
  assert.match(lib, /const DEFAULT_BOARD_ID = "1139774521";/);
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
  assert.match(hook, /await syncMondayItems\(db, \[itemId\]\)/);
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
