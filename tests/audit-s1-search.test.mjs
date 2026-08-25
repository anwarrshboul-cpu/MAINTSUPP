/**
 * Audit S1 — the board search haystack.
 *
 * The Name COLUMN on the maintenance board deliberately shows the arrival
 * form ("Manual" / "Incoming form answer") when no Name cell exists — monday
 * parity, pinned elsewhere (board-ordering.ts boardItemName). That makes the
 * search haystack the only place a row's own words are reachable, and two of
 * them were missing:
 *
 *  - `request.title` — a public submission's own words ("Leaking tap in
 *    kitchen") appeared NOWHERE in the haystack: name resolves to the arrival
 *    form, and description is a different form answer. Searching the exact
 *    title found nothing.
 *  - `request.reference` — the server-assigned number (e.g. MS-2026-0040) a
 *    requester quotes from their confirmation email.
 *
 * Verified in-browser 2026-08-25: searching an exact title and a generated
 * reference each matched exactly the one row after the fix, and zero rows
 * before it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("the search haystack includes title and reference alongside the parity name", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  const start = board.indexOf("const filtered = useMemo(");
  assert.ok(start > -1, "the search memo must exist");
  const haystack = board.slice(start, board.indexOf(".some((value) => value.toLowerCase().includes(needle))", start));
  assert.ok(haystack.length > 0, "the haystack list must feed a case-insensitive includes");

  for (const field of [
    "request.id",
    "boardItemName(",
    "request.description",
    "request.location",
    "request.requester",
    'request.contractor ?? ""',
    'request.reference ?? ""',
    'request.title ?? ""',
  ]) {
    assert.ok(haystack.includes(field), `search must match on ${field}`);
  }
});

test("search lowercases both sides, so case and trailing spaces cannot hide rows", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /const needle = deferredQuery\.trim\(\)\.toLowerCase\(\);/);
  assert.match(board, /\.some\(\(value\) => value\.toLowerCase\(\)\.includes\(needle\)\)/);
});
