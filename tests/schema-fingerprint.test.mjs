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
 * If it fails: the migrations changed and the constant did not. Paste the value
 * printed in the failure into `SCHEMA_FINGERPRINT`.
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
    `The migration sources changed and SCHEMA_FINGERPRINT did not.\n` +
      `  Set it to: "${computed}"\n` +
      `  in ${MODULE}.\n` +
      `  Until you do, a database that already stored the old fingerprint will SKIP the\n` +
      `  migration replay and never apply your change.`,
  );
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

test("the fingerprint is written only after every stage has finished", async () => {
  /*
   * A partial run must never be recorded as a whole one: a stage that throws
   * rejects `initialize()`, `ensureDatabase()` clears its memo, and the next
   * request replays everything. This pins that the write is the LAST thing in
   * the applied branch, after the awaits it vouches for.
   */
  const init = await read("db/init.ts");
  const at = init.indexOf("async function initialize()");
  assert.ok(at > 0);
  const body = init.slice(at, init.indexOf("\n}\n", at));
  const apply = body.indexOf("applyMigrations(d1)");
  const write = body.indexOf("writeSchemaState(");
  assert.ok(apply > 0, "the migration stages are applied through one named function");
  assert.ok(write > apply, "and the fingerprint is recorded after them, never before");
  assert.doesNotMatch(
    body,
    /writeSchemaState\([^)]*\)[\s\S]*await applyMigrations/,
    "the fingerprint must not be recorded ahead of the work it describes",
  );
});

test("the repairs run on every boot, fingerprint or not", async () => {
  /*
   * A repair's effect is a function of the DATA, not of the code, so "the code
   * has not changed" says nothing about whether it has work to do.
   * `repairOrphanedSectionBoards` fixes boards orphaned when a section is
   * deleted — something ordinary use can cause again tomorrow.
   */
  const init = await read("db/init.ts");
  const at = init.indexOf("async function initialize()");
  const body = init.slice(at, init.indexOf("\n}\n", at));
  const guard = body.indexOf("if (stored !== expected)");
  const repairs = body.indexOf("repairInvariants(d1)");
  assert.ok(guard > 0, "the applied branch is guarded by the stored fingerprint");
  assert.ok(repairs > guard, "and the repairs sit outside that branch");
  const applied = body.slice(guard, body.indexOf("}", body.indexOf("writeSchemaState(")));
  assert.doesNotMatch(
    applied,
    /repairInvariants/,
    "a repair inside the guarded branch would stop running once the fingerprint settled",
  );
  const repairBody = init.slice(init.indexOf("async function repairInvariants"));
  assert.match(
    repairBody.slice(0, repairBody.indexOf("\n}\n")),
    /repairOrphanedSectionBoards\(d1\)/,
    "the orphaned-board repair is one of them",
  );
});
