/**
 * No money aggregate may sum the `real` column.
 *
 *   node --test tests/cost-aggregates-pence.test.mjs
 *
 * `maintenance_requests.cost` is IEEE-754 binary32. Every individual value
 * round-trips perfectly, so nothing looks wrong until several are added
 * together: the migration's 92 costed jobs are £52,408.06, and `sum(cost)`
 * returns £52,408.10.
 *
 * Twelve SQL aggregates across six files summed that column. They are the
 * numbers the client actually reads — the Cost card, the contractor spend
 * table, the per-site utilisation meter — so converting the TypeScript helpers
 * alone fixed nothing a user could see. This pins the SQL, because the SQL is
 * where the arithmetic happens and a new aggregate is exactly the kind of
 * addition that would quietly reintroduce it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const FILES = [
  "app/lib/dashboard-aggregates.ts",
  "app/lib/contractor-linking.ts",
  "app/lib/site-metrics.ts",
  "app/api/contractors/route.ts",
  "app/api/workspace/route.ts",
];

const sources = new Map();
for (const file of FILES) sources.set(file, await readFile(file, "utf8"));

test("no aggregate sums the real cost column", () => {
  for (const [file, source] of sources) {
    const offenders = [...source.matchAll(/sum\(\$\{maintenanceRequests\.cost\}\)/g)];
    assert.equal(
      offenders.length, 0,
      `${file} sums the binary32 column; use sumCostPenceSql from app/lib/cost-sql.ts`,
    );
  }
});

test("every file that reports money reads the shared pence expression", () => {
  for (const [file, source] of sources) {
    assert.match(
      source, /from "\.{1,2}\/(?:\.\.\/)?lib\/cost-sql"|from "\.\/cost-sql"/,
      `${file} reports money but does not import the shared pence SQL`,
    );
  }
});

test("the shared expression prefers the integer column and falls back exactly", async () => {
  const source = await readFile("app/lib/cost-sql.ts", "utf8");
  // The fallback has to round BEFORE truncating: cast(48.87 * 100 as integer)
  // is 4886, because 4887 is not representable and the product lands under it.
  assert.match(source, /coalesce\(\$\{maintenanceRequests\.costPence\}/);
  assert.match(source, /cast\(round\(\$\{maintenanceRequests\.cost\} \* 100\) as integer\)/);
});

test("the expression stays legal on SQLite as well as Postgres", async () => {
  const source = await readFile("app/lib/cost-sql.ts", "utf8");
  /*
   * Comments stripped first. The file's own prose explains why a Postgres-only
   * cast is wrong here, and an earlier version of this test failed on that
   * explanation — the contract is about the SQL, not about what is written
   * beside it.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/::(?:bigint|numeric|int)/.test(code),
    "Postgres-only cast syntax would pass deployed and fail every Miniflare test",
  );
});

test("a total is converted to pounds once, at the edge", async () => {
  const source = await readFile("app/lib/cost-sql.ts", "utf8");
  assert.match(source, /export function poundsFromSum\(pence: number\): number/);
  // Division by 100 of an exact integer — not an accumulator.
  assert.match(source, /return pence \/ 100;/);
});
