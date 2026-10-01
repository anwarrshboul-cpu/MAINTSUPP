/**
 * Seeded board ids carry the workspace id: `seed-<orgId>-<board>-<key>`.
 *
 * The four original workspaces have short ids, but a workspace created in the
 * app gets `org_<32 hex>` (36 characters), so its seeded ids run long: measured
 * on 2026-10-01 in a fresh workspace, groups 60-79, columns 58-85 and views
 * 58-65 characters. `text(value, 64)` TRUNCATES rather than refusing, so every
 * route that read one of those ids at 64 looked up a shortened id and answered
 * 404 — jobs could not be moved between groups, and columns and views could not
 * be renamed, reordered or deleted, in any newly created workspace.
 *
 * Every route that reads a group, column or view id reads it at 100, the width
 * `update_cell` and the upload routes already used.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("group, column and view ids are read at 100, not 64", async () => {
  const items = await read("app/api/board/items/route.ts");
  assert.doesNotMatch(items, /text\(body\.groupId, 64\)/);
  assert.equal(items.match(/text\(body\.groupId, 100\)/g)?.length, 2);

  for (const path of [
    "app/api/board/groups/route.ts",
    "app/api/board/columns/route.ts",
    "app/api/board/views/route.ts",
  ]) {
    const source = await read(path);
    assert.doesNotMatch(source, /text\((?:body\.id|entry\?\.id|url\.searchParams\.get\("(?:id|moveTo)"\)), 64\)/, path);
  }
});

test("the widest seeded id still fits", () => {
  const orgId = `org_${"0".repeat(32)}`;
  const longest = `seed-${orgId}-store-documentation-certificate-expiry-reminder`;
  assert.ok(longest.length <= 100, `${longest.length}`);
});
