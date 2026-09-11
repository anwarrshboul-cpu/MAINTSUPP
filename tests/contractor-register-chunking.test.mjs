/**
 * THE CONTRACTOR REGISTER READS PAST D1'S VARIABLE CEILING.
 *
 * `GET /api/contractors?registers=all` bound every contractor id into one `IN`
 * list for each of its per-contractor tallies, and D1 refuses a statement past
 * ~100 bound variables: past about a hundred contractors the register answered
 * 503 "The contractor register is temporarily unavailable." The four reads now
 * go through `selectInChunks`.
 *
 *   1. `selectInChunks` itself, over an empty list, a small one, one either side
 *      of the chunk size, and one well past the old ceiling — every id reaches
 *      exactly one statement and no statement binds more than the chunk.
 *   2. The route and the alias helper are pinned to it by source.
 *   3. The live register answers 200 however many contractors the estate holds.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { selectInChunks, SQL_VARIABLE_CHUNK } = await import("../app/lib/sql-batching.ts");

/** A stand-in statement: records the chunk it bound and answers one row per id. */
function recorder() {
  const statements = [];
  return {
    statements,
    query: async (chunk) => {
      statements.push([...chunk]);
      return chunk.map((id) => ({ contractorId: id, total: 1 }));
    },
  };
}

for (const [label, size] of [
  ["no contractors", 0],
  ["a small register", 7],
  ["one under the chunk", SQL_VARIABLE_CHUNK - 1],
  ["exactly the chunk", SQL_VARIABLE_CHUNK],
  ["one over the chunk", SQL_VARIABLE_CHUNK + 1],
  ["around the old ceiling", 101],
  ["well past the old ceiling", 460],
]) {
  test(`selectInChunks over ${label} (${size}) reads every id once, never more than ${SQL_VARIABLE_CHUNK} a statement`, async () => {
    const ids = Array.from({ length: size }, (_, index) => `contractor-${index}`);
    const { statements, query } = recorder();
    const rows = await selectInChunks(ids, query);
    assert.equal(rows.length, size, "one row back per id");
    assert.deepEqual(rows.map((row) => row.contractorId), ids, "order and membership preserved");
    assert.equal(statements.length, Math.ceil(size / SQL_VARIABLE_CHUNK), "statement count");
    for (const chunk of statements) assert.ok(chunk.length <= SQL_VARIABLE_CHUNK && chunk.length > 0);
    assert.equal(new Set(statements.flat()).size, size, "no id bound twice");
  });
}

test("per-contractor totals are identical whether read in one statement or in chunks", async () => {
  /* The route groups by contractor id; a contractor's rows sit in one chunk,
     so concatenating chunked GROUP BY results must equal the unchunked one. */
  const jobs = Array.from({ length: 900 }, (_, index) => ({ contractorId: `c-${index % 230}`, cost: (index % 7) + 0.25 }));
  const ids = [...new Set(jobs.map((job) => job.contractorId))];
  const groupBy = (subset) =>
    subset.map((id) => ({
      contractorId: id,
      assigned: jobs.filter((job) => job.contractorId === id).length,
      spend: jobs.filter((job) => job.contractorId === id).reduce((sum, job) => sum + job.cost, 0),
    }));
  const whole = groupBy(ids);
  const chunked = await selectInChunks(ids, async (chunk) => groupBy(chunk));
  assert.deepEqual(chunked, whole);
});

test("the route's three tallies and the alias read are chunked", async () => {
  const route = await read("app/api/contractors/route.ts");
  assert.match(route, /import \{ selectInChunks \} from "\.\.\/\.\.\/lib\/sql-batching";/);
  assert.equal((route.match(/selectInChunks\(ids, \(chunk\) =>/g) ?? []).length, 3, "jobs, documents and certifications");
  assert.match(route, /inArray\(maintenanceRequests\.contractorId, chunk\)/);
  assert.match(route, /inArray\(attachments\.contractorId, chunk\)/);
  assert.match(route, /inArray\(contractorCertifications\.contractorId, chunk\)/);
  assert.doesNotMatch(route, /inArray\([^)]*, ids\)/, "no IN list binds the whole id set any more");
  const linking = await read("app/lib/contractor-linking.ts");
  const aliases = linking.slice(linking.indexOf("export async function aliasesByContractor"));
  assert.match(aliases.slice(0, 1200), /selectInChunks\(contractorIds, \(chunk\) =>/);
  assert.match(aliases.slice(0, 1200), /inArray\(contractorNameAliases\.contractorId, chunk\)/);
});

const BASE = "http://localhost:5173";
const headers = { "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com", Accept: "application/json" };

test("LIVE registers=all answers whatever the register's size", async (t) => {
  let response;
  try {
    response = await fetch(`${BASE}/api/contractors?registers=all&archived=all`, { headers, signal: AbortSignal.timeout(20000) });
  } catch {
    t.skip("no development server");
    return;
  }
  if (response.status === 404) {
    t.skip("no development server");
    return;
  }
  assert.equal(response.status, 200, "no 503 from the variable ceiling");
  const body = await response.json();
  assert.ok(Array.isArray(body.contractors));
  for (const contractor of body.contractors) {
    assert.equal(typeof contractor.assignedJobs, "number");
    assert.equal(typeof contractor.documentCount, "number");
  }
  if (body.contractors.length <= SQL_VARIABLE_CHUNK) {
    t.diagnostic(`only ${body.contractors.length} contractors here, so this run did not cross a chunk boundary`);
  }
});
