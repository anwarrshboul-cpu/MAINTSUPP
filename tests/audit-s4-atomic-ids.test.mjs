/**
 * Audit S4R — the two id allocators that lost races.
 *
 * Both were proven broken against the running server before their fixes:
 *
 *  - `nextReference` incremented the counter in one UPDATE and read it back
 *    in a SECOND statement, so a burst of ten simultaneous creates was handed
 *    three distinct references, one shared by five jobs. The fix reads the
 *    counter in the same statement — `UPDATE … RETURNING`.
 *  - `createBoardItem` computed `MAX(id)+1` and inserted, so simultaneous
 *    creates computed the same number and every insert after the first lost
 *    the primary key as a 503. The fix walks consecutive slots with
 *    `onConflictDoNothing().returning()`.
 *
 * After the fixes, ten concurrent creates against each path produced ten
 * distinct references / ten distinct MN- ids — including while a second audit
 * agent was minting MN- ids in parallel. These tests pin the shape of both
 * allocators so neither quietly returns to read-after-write.
 *
 * Reads normalise CRLF first — this suite must pass on a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

test("nextReference increments and reads the counter in one statement", async () => {
  const source = await read("app/lib/board-registry.ts");
  const fn = source.slice(source.indexOf("export async function nextReference"));
  assert.match(
    fn,
    /\.update\(boards\)[\s\S]*?referenceCounter: sql`\$\{boards\.referenceCounter\} \+ 1`[\s\S]*?\.returning\(\{\s*\n\s*prefix: boards\.referencePrefix,\s*\n\s*counter: boards\.referenceCounter,/,
    "the counter must come back from the UPDATE itself — a separate SELECT re-opens the duplicate-reference race",
  );
  assert.ok(
    !/await db\s*\n?\s*\.select\([\s\S]{0,200}referenceCounter/.test(fn),
    "no follow-up SELECT of the counter may exist in nextReference",
  );
});

test("createBoardItem walks past a taken id instead of failing", async () => {
  const source = await read("app/lib/board-mutations.ts");
  assert.match(
    source,
    /const MAX_ITEM_ID_ATTEMPTS = 8;/,
    "the walk-up budget is part of the contract",
  );
  const fn = source.slice(source.indexOf("export async function createBoardItem"));
  assert.match(
    fn,
    /for \(let attempt = 0; attempt < MAX_ITEM_ID_ATTEMPTS; attempt\+\+\) \{\s*\n\s*id = `MN-\$\{base \+ attempt\}`;/,
    "each retry must target base+attempt — re-reading MAX can hand back the same number",
  );
  assert.match(
    fn,
    /\.onConflictDoNothing\(\)\s*\n?\s*\.returning\(\)/,
    "a lost insert race must surface as an empty result, not an exception",
  );
  assert.match(
    fn,
    /Could not allocate a job id; too many simultaneous creates\./,
    "exhausting the walk must fail loudly rather than corrupt",
  );
});

test("the MN- numbering still counts binned rows", async () => {
  const source = await read("app/lib/board-mutations.ts");
  const fn = source.slice(
    source.indexOf("async function nextItemNumber"),
    source.indexOf("const MAX_ITEM_ID_ATTEMPTS"),
  );
  assert.ok(
    !fn.includes("deletedAt"),
    "nextItemNumber must NOT filter out binned rows — a job in the bin still owns its id, and excluding it re-issues the id a restore then collides with",
  );
});
