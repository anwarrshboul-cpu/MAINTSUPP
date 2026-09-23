/**
 * THE TEST THAT MAKES THE MIGRATION SHORT-CIRCUIT SAFE.
 *
 * `ensureDatabase()` skips the whole migration replay when a fingerprint stored
 * in the database matches `SCHEMA_FINGERPRINT`. That is a 47-second saving on
 * every cold start and a catastrophe if the constant and the migrations ever
 * disagree: the database would report itself up to date while a new column or
 * a new seed never ran, and nothing would raise an error — the next query to
 * want that column would simply fail, in production, at some unrelated moment.
 *
 * So the constant is NOT trusted. This suite recomputes it from the actual
 * source of every module that issues migration SQL and fails when the two
 * disagree, which turns "somebody forgot to bump it" from a silent production
 * fault into a red suite on their own machine. **This file is the mechanism;
 * the constant is only its cache.** Weakening this test re-arms the fault it
 * exists to prevent.
 *
 * If it fails: the migrations changed and the list did not. APPEND the value
 * printed in the failure to `SCHEMA_GENERATIONS` — a new last entry, which is a
 * new generation. Never edit an existing entry (see the generation tests below).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const ts = (await import("typescript")).default;

const MODULE = "db/schema-fingerprint.ts";
const source = await read(MODULE);

/* The module has no runtime imports, so it loads on its own. */
const fingerprint = await import(
  `data:text/javascript,${encodeURIComponent(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )}`
);

/**
 * The fingerprint of the migration sources, computed the same way the module
 * documents: each file's path and content, in the declared order, with a NUL
 * between them so that moving text from the end of one file to the start of
 * the next cannot leave the hash unchanged.
 */
async function computeFingerprint() {
  let joined = "";
  for (const file of fingerprint.FINGERPRINTED_SOURCES) {
    joined += `\u0000${file}\u0000${await read(file)}`;
  }
  return fingerprint.fingerprintOf(joined);
}

/* ── The contract ─────────────────────────────────────────────────────────── */

test("SCHEMA_FINGERPRINT matches the migrations it claims to describe", async () => {
  const computed = await computeFingerprint();
  assert.equal(
    fingerprint.SCHEMA_FINGERPRINT,
    computed,
    `The migration sources changed and SCHEMA_GENERATIONS did not.\n` +
      `  Append "${computed}" as a NEW LAST entry of SCHEMA_GENERATIONS\n` +
      `  in ${MODULE} — never edit an existing entry.\n` +
      `  Until you do, a database that already stored the old fingerprint will SKIP the\n` +
      `  migration replay and never apply your change.`,
  );
});

/* ── The generation order ─────────────────────────────────────────────────── */

test("the generation is the position in an append-only list, and the fingerprint is its last entry", () => {
  /*
   * A fingerprint says "different"; only the list's ORDER says "newer", and the
   * boot path uses that order to stop an older build replaying its migrations
   * over a newer database (measured on Production, 2026-09-23). So the shape is
   * the contract: generation = length, fingerprint = last entry, and the first
   * entry is anchored to the last pre-generation build so that nobody can
   * rewrite history from the top.
   */
  const list = fingerprint.SCHEMA_GENERATIONS;
  assert.ok(Array.isArray(list) && list.length >= 2, "generation 1 is the pre-generation baseline; this code is at least 2");
  assert.equal(list[0], "a7bcc17c", "generation 1 is anchored to 71d3eda (#105), the last build before generations");
  for (const entry of list) assert.match(entry, /^[0-9a-f]{8}$/, "every generation is an eight-hex fingerprint");
  assert.equal(fingerprint.SCHEMA_GENERATION, list.length, "a build's generation is its position in the list");
  assert.equal(fingerprint.SCHEMA_FINGERPRINT, list[list.length - 1], "and its fingerprint is the last entry");
});

test("the stored generation value compares as a number in its first six characters", () => {
  /*
   * The write refuses a downgrade in SQL with `CAST(substr(value, 1, 6) AS
   * INTEGER) <= ?`, so the value must start with the zero-padded generation —
   * and parse back to exactly what was written.
   */
  const value = fingerprint.schemaGenerationValue(12, "abc12345", "4/org_z");
  assert.equal(value, "000012:abc12345:orgs=4/org_z");
  assert.equal(Number(value.slice(0, 6)), 12);
  assert.deepEqual(fingerprint.parseSchemaGenerationValue(value), {
    generation: 12,
    fingerprint: "abc12345",
    organisations: "4/org_z",
  });
  assert.equal(fingerprint.parseSchemaGenerationValue("a7bcc17c:orgs=4/org_z"), null, "a legacy value is not a generation");
  assert.equal(fingerprint.parseSchemaGenerationValue(null), null);
});

test("every module that issues migration SQL is fingerprinted", async () => {
  /*
   * The list is the contract, and the failure mode it guards is quiet: a module
   * that writes DDL but is not hashed can change without changing the
   * fingerprint, so its change never runs on a database that is already marked
   * up to date. This looks for migration SQL in `db/` and checks it is covered.
   */
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.join(root, "db"), { withFileTypes: true });
  const covered = new Set(fingerprint.FINGERPRINTED_SOURCES);
  const missing = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = `db/${entry.name}`;
    if (covered.has(file)) continue;
    /*
     * The fingerprint module itself cannot be in its own input: the constant
     * lives there, so hashing it would change the value it is being compared
     * against and no fixed point would exist. It issues no SQL — it only quotes
     * some in its reasoning — so nothing is lost by leaving it out.
     */
    if (file === MODULE) continue;
    const text = await read(file);
    /* The statements that change a database's shape or seed it. */
    if (/CREATE TABLE IF NOT EXISTS|ALTER TABLE|CREATE INDEX|INSERT OR IGNORE/i.test(text)) {
      missing.push(file);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these modules issue migration SQL but are not in FINGERPRINTED_SOURCES, so a change to them would not re-run the migrations: ${missing.join(", ")}`,
  );
});

test("the hash changes when any fingerprinted source changes", async () => {
  /* A hash that collided on ordinary edits would be worse than none. */
  const base = await computeFingerprint();
  const one = fingerprint.fingerprintOf("a");
  const two = fingerprint.fingerprintOf("b");
  assert.notEqual(one, two, "two different inputs must not share a fingerprint");
  assert.equal(fingerprint.fingerprintOf("a"), one, "and the same input must be stable");
  assert.match(base, /^[0-9a-f]{8}$/, "the fingerprint is eight hex characters");
});

test("the stored value carries the tenant count, not only the code", async () => {
  /*
   * THE SHARPEST EDGE IN THE WHOLE DESIGN. Several stages fan out with
   * `INSERT … SELECT … FROM organisations WHERE status = 'active'`. An
   * organisation created at runtime — `POST /api/context` does exactly that —
   * arrives after they have run, and today the next cold start completes it.
   * A fingerprint that knew only about code would skip that for ever and leave
   * the new tenant half-built with no error anywhere.
   */
  assert.equal(fingerprint.schemaStateValue("abc12345", "3/org_z"), "abc12345:orgs=3/org_z");
  assert.notEqual(
    fingerprint.schemaStateValue("abc12345", "3/org_z"),
    fingerprint.schemaStateValue("abc12345", "4/org_z"),
    "adding a tenant must invalidate the fingerprint, or the fan-out stages never run for it",
  );
  /*
   * And a COUNT ALONE would not have been enough: suspend one organisation and
   * create another before the next cold start and the count is unchanged. The
   * stamp carries the greatest active id beside the count for exactly that.
   */
  assert.notEqual(
    fingerprint.schemaStateValue("abc12345", "3/org_a"),
    fingerprint.schemaStateValue("abc12345", "3/org_b"),
    "swapping one tenant for another must invalidate it too",
  );
  assert.notEqual(
    fingerprint.schemaStateValue("abc12345", "3/org_z"),
    fingerprint.schemaStateValue("abc12346", "3/org_z"),
    "and so must changing the code",
  );
});

/* ── How the boot path uses it ────────────────────────────────────────────── */

/*
 * RE-POINTED 2026-09-23 from `initialize()` to `bootSchema()`: the boot moved
 * into one function a test can run with any build (the generation guard), and
 * `initialize()` now only calls it with this build. The contracts are the same
 * ones, pinned where they now live; `tests/schema-boot-guard.test.mjs` proves
 * them by running the boot, not only by reading it.
 */
function bootBody(init) {
  const at = init.indexOf("export async function bootSchema(");
  assert.ok(at > 0, "the boot is one named function");
  return init.slice(at, init.indexOf("\n}\n", at));
}

test("the fingerprint is written only after every stage has finished", async () => {
  /*
   * A partial run must never be recorded as a whole one: a stage that throws
   * rejects the boot, `ensureDatabase()` clears its memo, and the next request
   * replays everything. This pins that the write is the LAST thing in the
   * applied branch, after the awaits it vouches for.
   */
  const init = await read("db/init.ts");
  const body = bootBody(init);
  assert.match(init, /async function initialize\(\) \{\n\s*await bootSchema\(await getD1\(\), THIS_BUILD\);/);
  const apply = body.indexOf("stages.applyMigrations(d1)");
  const write = body.indexOf("writeSchemaGeneration(");
  assert.ok(apply > 0, "the migration stages are applied through one named function");
  assert.ok(write > apply, "and the generation is recorded after them, never before");
  assert.doesNotMatch(
    body,
    /writeSchemaGeneration\([^)]*\)[\s\S]*stages\.applyMigrations/,
    "the generation must not be recorded ahead of the work it describes",
  );
});

test("the repairs run on every boot of a current or newer build, fingerprint or not", async () => {
  /*
   * A repair's effect is a function of the DATA, not of the code, so "the code
   * has not changed" says nothing about whether it has work to do.
   * `repairOrphanedSectionBoards` fixes boards orphaned when a section is
   * deleted — something ordinary use can cause again tomorrow.
   */
  const init = await read("db/init.ts");
  const body = bootBody(init);
  const guard = body.indexOf('if (decision.action === "migrate")');
  const repairs = body.indexOf("stages.repairInvariants(d1)");
  assert.ok(guard > 0, "the applied branch is guarded by the boot decision");
  assert.ok(repairs > guard, "and the repairs sit outside that branch");
  const applied = body.slice(guard, body.indexOf("\n  }\n", guard));
  assert.doesNotMatch(
    applied,
    /repairInvariants/,
    "a repair inside the guarded branch would stop running once the fingerprint settled",
  );
  /*
   * The ONE exception, added 2026-09-23: a build OLDER than the database skips
   * the repairs too, because its repairs were written against rules a newer
   * build may have changed. That early return must come before everything.
   */
  const older = body.indexOf('if (decision.action === "newer-schema")');
  assert.ok(older > 0 && older < guard && older < repairs, "an older build returns before migrating or repairing");
  const repairBody = init.slice(init.indexOf("async function repairInvariants"));
  assert.match(
    repairBody.slice(0, repairBody.indexOf("\n}\n")),
    /repairOrphanedSectionBoards\(d1\)/,
    "the orphaned-board repair is one of them",
  );
});
