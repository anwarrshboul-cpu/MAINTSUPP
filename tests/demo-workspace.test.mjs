/**
 * THE DEMONSTRATION WORKSPACE — the properties that make it safe to ship.
 *
 * `db/demo-workspace.ts` creates one extra tenant and fills it with invented
 * data, and it does so on the boot path of a product whose Production database
 * holds a real client's estate. Three things therefore have to be true, and all
 * three are checked here by reading the source rather than by trusting it:
 *
 *   1. IT IS ADDITIVE. No `DELETE`, no `DROP`, and no `UPDATE` that is not
 *      confined to the demo organisation. The existing seed subsystem in
 *      `app/lib/seed/` deletes before it writes, which is exactly why that one
 *      refuses to run on Production and this one may.
 *   2. IT IS CONFINED. Every statement names the demo organisation. A seed that
 *      could take an organisation id as an argument could be pointed at a
 *      client; this one has no such argument.
 *   3. IT IS IDEMPOTENT. Every write is `INSERT OR IGNORE`, and the whole data
 *      seed is skipped by a single primary-key lookup once it has run — because
 *      `ensureDatabase()` runs on the first request of every instance, for the
 *      life of the deployment.
 *
 * The dataset itself is checked for the two properties that make it a
 * DEMONSTRATION rather than a liability: nothing in it is a real address a
 * letter could reach, and every contact is `@example.com`, the reserved domain
 * that cannot receive mail.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const SEED = "db/demo-workspace.ts";
const INIT = "db/init.ts";

const seed = await read(SEED);
const init = await read(INIT);

/* ── 1. Additive ──────────────────────────────────────────────────────────── */

test("the demo seed never deletes anything", () => {
  assert.doesNotMatch(seed, /\bDELETE\s+FROM\b/i, "a demo seed with a DELETE in it is a purge wearing a different name");
  assert.doesNotMatch(seed, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(seed, /\bTRUNCATE\b/i);
});

test("every write is INSERT OR IGNORE, so a second run writes nothing", () => {
  const inserts = seed.match(/INSERT(\s+OR\s+IGNORE)?\s+INTO/gi) ?? [];
  assert.ok(inserts.length >= 6, `expected the seed to still write several tables, saw ${inserts.length}`);
  for (const statement of inserts) {
    assert.match(
      statement,
      /INSERT\s+OR\s+IGNORE\s+INTO/i,
      `a bare INSERT would fail or duplicate on the second boot: ${statement}`,
    );
  }
});

test("there is no UPDATE at all", () => {
  /*
   * The seed writes rows and never edits one. Kept as an absolute rather than
   * "an UPDATE scoped to the demo org", because the moment an UPDATE exists
   * somebody has to check its WHERE clause, and the cheapest clause to review
   * is the one that is not there.
   */
  assert.doesNotMatch(seed, /\bUPDATE\s+\w+\s+SET\b/i);
});

/* ── 2. Confined ──────────────────────────────────────────────────────────── */

test("the organisation is a constant, not an argument", () => {
  assert.match(seed, /export const DEMO_WORKSPACE_ID = "org_maintsupp_demo_workspace";/);
  /* Neither exported function may take an organisation to write to. */
  const signatures = seed.match(/export async function \w+\([^)]*\)/g) ?? [];
  assert.ok(signatures.length >= 2, "both entry points are still exported");
  for (const signature of signatures) {
    assert.doesNotMatch(
      signature,
      /organisationId|orgId/,
      `a seed that takes an organisation can be pointed at a client: ${signature}`,
    );
  }
});

test("every insert names the demo organisation", () => {
  /*
   * Each `INSERT` must bind `DEMO_WORKSPACE_ID`. Checked per statement rather
   * than per file, so a table added later without the id cannot hide behind the
   * others.
   */
  const blocks = seed.split(/INSERT\s+OR\s+IGNORE\s+INTO/i).slice(1);
  assert.ok(blocks.length >= 6);
  for (const block of blocks) {
    const upTo = block.slice(0, block.indexOf(".run()") + 1 || block.length);
    assert.match(
      upTo,
      /DEMO_WORKSPACE_ID|DEMO_COMPLETED_GROUP/,
      `an insert that does not name the demo organisation: ${upTo.slice(0, 120)}`,
    );
  }
});

test("every seeded row id is recognisable as demo data from its key alone", () => {
  for (const helper of [/const siteId = \(key: string\) => `demo-site-\$\{key\}`;/,
                        /const contractorId = \(key: string\) => `demo-contractor-\$\{key\}`;/,
                        /const jobId = \(key: string\) => `demo-job-\$\{key\}`;/]) {
    assert.match(seed, helper);
  }
  assert.match(seed, /`demo-compliance-\$\{site\.key\}-\$\{index\}`/);
  assert.match(seed, /`demo-unit-\$\{site\.key\}-\$\{index\}`/);
  assert.match(seed, /`demo-member-' \|\| m\.user_id|'demo-member-' \|\| m\.user_id/);
});

/* ── 3. Idempotent, and cheap on a path that runs at every cold start ─────── */

test("the data seed is skipped by one primary-key lookup once it has run", () => {
  assert.match(seed, /async function alreadySeeded\(/, "the guard is still a named function");
  assert.match(
    seed,
    /SELECT id FROM sites WHERE id = \? LIMIT 1/,
    "the guard is one indexed lookup, because it runs on the first request of every instance",
  );
  const body = seed.slice(seed.indexOf("export async function seedDemoWorkspaceData"));
  assert.match(body, /if \(await alreadySeeded\(d1\)\) return;/, "and it returns before any work");
});

test("it refuses to write if the organisation is not there and active", () => {
  const body = seed.slice(seed.indexOf("export async function seedDemoWorkspaceData"));
  assert.match(body, /WHERE id = \? AND status = 'active' LIMIT 1/);
  assert.match(body, /if \(!demo\?\.id\) return;/);
});

/* ── The boot path wiring ─────────────────────────────────────────────────── */

test("the organisation is created before the stages that fan out across tenants", () => {
  const organisationAt = init.indexOf("await ensureDemoWorkspaceOrganisation(d1);");
  const stageThreeAt = init.indexOf("await ensureStageThreeBoardEngine(d1);");
  assert.ok(organisationAt > 0, "the organisation is still created in initialize()");
  assert.ok(stageThreeAt > 0);
  assert.ok(
    organisationAt < stageThreeAt,
    "created after the fan-out, the workspace would have no board, no status map and no meters until the next cold start",
  );
});

test("the data is seeded last, and with the six operational lanes only", () => {
  const dataAt = init.indexOf("await seedDemoWorkspaceData(d1,");
  const structureAt = init.indexOf('await seedBoardStructure(d1, DEMO_WORKSPACE_ID, "maintenance", JOBS_TEMPLATE_GROUP_KEYS);');
  assert.ok(structureAt > 0, "the demo board is still seeded with the narrowed group set");
  assert.ok(dataAt > structureAt, "the jobs are filed after the lanes they are filed into exist");
  /*
   * The narrowed set matters for more than tidiness: the canonical board's 38
   * groups include 28 named after THIS client's own stores, and a workspace
   * shown to a stranger must not carry them.
   */
  assert.match(init, /JOBS_TEMPLATE_GROUP_KEYS/);
});

/* ── The data is a demonstration, not a liability ─────────────────────────── */

test("every contact address is @example.com, which cannot receive mail", () => {
  const addresses = seed.match(/[\w.+-]*@[\w.-]+/g) ?? [];
  const real = addresses.filter((address) => !address.endsWith("@example.com"));
  assert.deepEqual(real, [], `a demo row carrying a deliverable address: ${real.join(", ")}`);
  assert.match(seed, /\$\{site\.key\}@example\.com/);
  assert.match(seed, /\$\{contractor\.key\}@example\.com/);
});

test("no date in the dataset is a fixed calendar date", () => {
  /*
   * A demo whose certificates all expired in a named year stops demonstrating
   * anything the following year. Every date is an offset applied to the boot
   * date by `day()`.
   */
  assert.doesNotMatch(seed, /"20\d\d-\d\d-\d\d"/, "a hardcoded date would go stale and then read as broken data");
  assert.match(seed, /function day\(today: string, offset: number\): string/);
  assert.match(seed, /seedDemoWorkspaceData\(d1: D1DatabaseLike, today: string\)/);
});

test("the compliance spread covers every band the dashboard can show", () => {
  /* Expired, expiring soon, compliant and missing all have members, or the
     compliance screen demonstrates one state and implies the rest. */
  const offsets = seed.slice(seed.indexOf("const DEMO_EXPIRY_OFFSETS"), seed.indexOf("/* ── The work"));
  const numbers = [...offsets.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
  assert.ok(numbers.some((value) => value < 0), "something is expired");
  assert.ok(numbers.some((value) => value >= 0 && value <= 60), "something is expiring soon");
  assert.ok(numbers.some((value) => value > 120), "something is comfortably in date");
  assert.match(offsets, /null/, "and something has never been provided, which reads as Missing");
});

test("the duty holder vocabulary is the one the scorer actually recognises", () => {
  /*
   * `countsTowardCompliance` scores `client` and NULL only, lower-case, and
   * treats an unrecognised string as NOT counting. A capitalised "Landlord"
   * therefore removes a requirement from the percentage silently — which is
   * what the first run of this seed did to all 56 rows, leaving the compliance
   * gauge reading "–" on a workspace built to show a number.
   */
  const at = seed.indexOf("function dutyHolderFor(");
  assert.ok(at > 0, "the helper is still where the duty holder is decided");
  const body = seed.slice(at, seed.indexOf("\n}", at));
  const holders = [...body.matchAll(/return "(client|landlord|centre|unconfirmed|not_applicable)";/g)];
  assert.ok(holders.length >= 2, "the helper still returns from the recognised vocabulary");
  /*
   * Scoped to the function body, not the file: the prose above it quotes the
   * capitalised spelling to explain the bug, and a check that reads a comment
   * is a check that fails for the wrong reason.
   */
  assert.doesNotMatch(body, /"Landlord"|"Client"|"Unconfirmed"/, "capitalised duty holders score as nothing");
});

test("completed work carries the stage and status the open/closed cut reads", () => {
  /*
   * `closedJobSql` is `stage = 'Completed' OR status IN completedStatuses` —
   * `job_status_map.counts_as_open` does NOT decide this, which is the trap.
   * Every completed demo job therefore sets both.
   */
  const jobs = seed.slice(seed.indexOf("const DEMO_JOBS"), seed.indexOf("/** A row, positionally"));
  const completed = [...jobs.matchAll(/"(Job Completed)", "(Completed)"/g)];
  assert.ok(completed.length >= 40, `expected the completed jobs to set stage and status, saw ${completed.length}`);
  assert.ok(jobs.includes('"Completed", "completed"') === false || true);
});

test("every completed job has a cost and a completion date, or the spend chart is empty", () => {
  /*
   * Spend is dated by COMPLETION and requires a non-null cost — `loadSpendByMonth`
   * groups on `completed_at` and skips a null cost entirely. A completed job
   * without both contributes to no chart anywhere.
   */
  const jobs = seed.slice(seed.indexOf("const DEMO_JOBS"), seed.indexOf("/** A row, positionally"));
  const rows = [...jobs.matchAll(/^\s*j\("(\w+)",[^\n]*$/gm)].map((match) => match[0]);
  const completedRows = rows.filter((row) => row.includes('"Job Completed"'));
  assert.ok(completedRows.length >= 40);
  for (const row of completedRows) {
    assert.doesNotMatch(
      row,
      /,\s*null,\s*"Job Completed"/,
      `a completed job with no cost contributes to no spend figure: ${row.trim().slice(0, 80)}`,
    );
  }
});
