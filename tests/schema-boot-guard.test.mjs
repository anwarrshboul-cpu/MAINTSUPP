/**
 * THE SCHEMA BOOT GUARD, PROVED BY RUNNING THE BOOT — against a real database.
 *
 * Two defects, both reproduced on 2026-09-23 against the real boot path on a
 * copy of the local database before this code existed, and both measured on
 * Production the same day:
 *
 *   1. AN OLDER BUILD OVER A NEWER SCHEMA. A superseded Production deployment,
 *      woken at its own URL, found a fingerprint that was not its own, replayed
 *      its OLDER migration set (341 statements) and overwrote the stored state
 *      with its own fingerprint — so the current build's next cold instance
 *      replayed everything again. Two replays in one minute; two requests lost
 *      to the 60-second limit.
 *   2. A TRANSIENT READ AS A REBUILD. The state and tenant reads swallowed
 *      their errors into "never migrated", so one failed read on a database
 *      that was already current replayed all 341 statements.
 *
 * `bootSchema(d1, build, stages)` is the boot `ensureDatabase()` runs, with the
 * build and the stages as parameters. The stages here are counters, so each
 * case says exactly what the boot DID; two cases use the real stages, to prove
 * the same thing in statements issued. The copy lives in a temp directory and
 * is deleted afterwards; the local database the dev server uses is only read.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const D1_DIR = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function localDatabaseFile() {
  if (!fs.existsSync(D1_DIR)) return null;
  const files = fs
    .readdirSync(D1_DIR)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => path.join(D1_DIR, f));
  return files.length === 1 ? files[0] : null;
}

function installHooks(sqlitePath) {
  process.env["D1_SQLITE_PATH"] = sqlitePath;
  const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
      if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
          if (fs.existsSync(fileURLToPath(candidate))) {
            return { url: candidate, shortCircuit: true };
          }
        }
      }
      return next(specifier, context);
    },
  });
}

const source = localDatabaseFile();
const skip = source ? false : "no local D1 database to copy (run the dev server once)";
let dir = null;
let init = null;
let fp = null;
let d1 = null;

before(async () => {
  if (!source) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-boot-guard-"));
  const file = path.join(dir, "boot.sqlite");
  fs.copyFileSync(source, file);
  installHooks(file);
  init = await import("../db/init.ts");
  fp = await import("../db/schema-fingerprint.ts");
  const { getD1 } = await import("../db/index.ts");
  d1 = await getD1();
});

after(async () => {
  if (!dir) return;
  const stub = await import("./fixtures/cloudflare-workers-stub.mjs");
  stub.closeForTests?.();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A leftover temp directory is the OS's to reclaim; it is not a result. */
  }
});

/* ── helpers ──────────────────────────────────────────────────────────────── */

const OLD_STAMP = "2000-01-01T00:00:00.000Z";

async function tenantStamp() {
  const row = await d1
    .prepare("SELECT count(*) AS total, coalesce(max(id), '') AS newest FROM organisations WHERE status = 'active'")
    .first();
  return `${Number(row.total)}/${row.newest}`;
}

/** Plant the generation row exactly as a build at `generation` would have left it. */
async function recordGeneration(generation, fingerprint = fp.SCHEMA_FINGERPRINT, organisations = null) {
  await d1.prepare("DELETE FROM schema_state WHERE key = ?").bind(fp.SCHEMA_GENERATION_KEY).run();
  const value = fp.schemaGenerationValue(generation, fingerprint, organisations ?? (await tenantStamp()));
  await d1
    .prepare("INSERT INTO schema_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(fp.SCHEMA_GENERATION_KEY, value, OLD_STAMP)
    .run();
  return value;
}

async function storedRow(key) {
  return d1.prepare("SELECT value, updated_at FROM schema_state WHERE key = ?").bind(key).first();
}

/** Counting stages: what the boot DID, not what it might have done. */
function spies(extra = {}) {
  const calls = { apply: 0, repair: 0 };
  return {
    calls,
    stages: {
      applyMigrations: async () => {
        calls.apply += 1;
        await extra.duringApply?.();
      },
      repairInvariants: async () => {
        calls.repair += 1;
      },
    },
  };
}

/** The same binding, with one kind of statement made to fail — a transient read. */
function failing(pattern) {
  let failures = 0;
  const wrapped = {
    prepare(sql) {
      const statement = d1.prepare(sql);
      if (!pattern.test(sql)) return statement;
      const fail = async () => {
        failures += 1;
        throw new Error("D1_ERROR: simulated transient failure (connection reset by peer)");
      };
      const broken = { first: fail, all: fail, run: fail, raw: fail };
      return { ...broken, bind: () => broken };
    },
    batch: (statements) => d1.batch(statements),
  };
  return { d1: wrapped, failures: () => failures };
}

/** The same binding, counting the CREATE statements that reach the database. */
function counting() {
  let creates = 0;
  return {
    d1: {
      prepare(sql) {
        if (/^\s*CREATE\s/i.test(sql)) creates += 1;
        return d1.prepare(sql);
      },
      batch: (statements) => d1.batch(statements),
    },
    creates: () => creates,
  };
}

const quietly = async (run) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

/* ── the decisions, one build against one database ────────────────────────── */

test("an OLD build meeting a NEWER schema replays nothing, repairs nothing, and overwrites nothing", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  const newer = await recordGeneration(current.generation + 1, "ffffffff");
  const { calls, stages } = spies();
  const decision = await quietly(() => init.bootSchema(d1, current, stages));
  assert.equal(decision.action, "newer-schema");
  assert.deepEqual(calls, { apply: 0, repair: 0 }, "an older build must not run its migration set or its repairs");
  const row = await storedRow(fp.SCHEMA_GENERATION_KEY);
  assert.equal(row.value, newer, "the newer build's record is left exactly as it was");
  assert.equal(row.updated_at, OLD_STAMP, "not even rewritten with the same value");
});

test("the CURRENT build meeting its own schema skips the replay and still runs the repairs", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  const recorded = await recordGeneration(current.generation);
  const { calls, stages } = spies();
  const decision = await quietly(() => init.bootSchema(d1, current, stages));
  assert.equal(decision.action, "current");
  assert.deepEqual(calls, { apply: 0, repair: 1 }, "no replay; the data repairs still run");
  const row = await storedRow(fp.SCHEMA_GENERATION_KEY);
  assert.equal(row.value, recorded);
  assert.equal(row.updated_at, OLD_STAMP, "nothing to record, so nothing is written");
});

test("a NEWER build meeting an older schema migrates once and records its generation", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await recordGeneration(current.generation - 1, "0000abcd");
  const { calls, stages } = spies();
  const decision = await quietly(() => init.bootSchema(d1, current, stages));
  assert.equal(decision.action, "migrate");
  assert.deepEqual(calls, { apply: 1, repair: 1 });
  const parsed = fp.parseSchemaGenerationValue((await storedRow(fp.SCHEMA_GENERATION_KEY)).value);
  assert.deepEqual(parsed, {
    generation: current.generation,
    fingerprint: current.fingerprint,
    organisations: await tenantStamp(),
  });
});

test("the same generation with a changed tenant set re-runs the fan-out, once", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await recordGeneration(current.generation, current.fingerprint, "0/org_none");
  const { calls, stages } = spies();
  const decision = await quietly(() => init.bootSchema(d1, current, stages));
  assert.equal(decision.action, "migrate", "a tenant added at runtime still gets its board and status map");
  assert.equal(calls.apply, 1);
  const again = spies();
  assert.equal((await quietly(() => init.bootSchema(d1, current, again.stages))).action, "current");
  assert.equal(again.calls.apply, 0, "and the next boot is current again");
});

test("a database with only the LEGACY row (every database today) migrates once, and leaves the legacy row alone", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await d1.prepare("DELETE FROM schema_state").run();
  await d1
    .prepare("INSERT INTO schema_state (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(fp.SCHEMA_STATE_KEY, "a7bcc17c:orgs=4/org_legacy", OLD_STAMP)
    .run();
  const { calls, stages } = spies();
  const decision = await quietly(() => init.bootSchema(d1, current, stages));
  assert.equal(decision.action, "migrate");
  assert.equal(calls.apply, 1);
  const legacy = await storedRow(fp.SCHEMA_STATE_KEY);
  assert.equal(legacy.value, "a7bcc17c:orgs=4/org_legacy", "a pre-generation build's row is not ours to rewrite");
  assert.equal(legacy.updated_at, OLD_STAMP);
  assert.ok(await storedRow(fp.SCHEMA_GENERATION_KEY), "and the generation row now exists");
});

/* ── transient failures: fail the boot, never rebuild ──────────────────────── */

test("a FAILED read of the schema state rejects the boot instead of rebuilding", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  const recorded = await recordGeneration(current.generation);
  const broken = failing(/SELECT value FROM schema_state/i);
  const { calls, stages } = spies();
  await assert.rejects(
    quietly(() => init.bootSchema(broken.d1, current, stages)),
    /simulated transient failure/,
    "the error surfaces; ensureDatabase() clears its memo and the next request retries",
  );
  assert.equal(broken.failures(), 1);
  assert.deepEqual(calls, { apply: 0, repair: 0 }, "no replay on an unreadable state");
  assert.equal((await storedRow(fp.SCHEMA_GENERATION_KEY)).value, recorded, "and nothing is rewritten");
});

test("a FAILED tenant-stamp read rejects the boot instead of rebuilding", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  const recorded = await recordGeneration(current.generation);
  const broken = failing(/FROM organisations WHERE status = 'active'/i);
  const { calls, stages } = spies();
  await assert.rejects(quietly(() => init.bootSchema(broken.d1, current, stages)), /simulated transient failure/);
  assert.deepEqual(calls, { apply: 0, repair: 0 }, "an unreadable stamp is not evidence the schema needs rebuilding");
  assert.equal((await storedRow(fp.SCHEMA_GENERATION_KEY)).value, recorded);
  /* And once the read works again, the same database is simply current. */
  const healthy = spies();
  assert.equal((await quietly(() => init.bootSchema(d1, current, healthy.stages))).action, "current");
  assert.equal(healthy.calls.apply, 0, "no rebuild after the transient failure clears");
});

/* ── the write can never lower the generation ──────────────────────────────── */

test("a NEWER record written while an older build is mid-run is never overwritten (no downgrade)", { skip }, async () => {
  /*
   * The deploy race: both builds find generation N-1 and replay; the newer one
   * finishes first and records N+1. The older one's write must be refused by
   * the database itself — `CAST(substr(value, 1, 6) AS INTEGER) <= ?`.
   */
  const older = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await recordGeneration(older.generation - 1, "0000abcd");
  const newerValue = fp.schemaGenerationValue(older.generation + 1, "ffffffff", await tenantStamp());
  const { calls, stages } = spies({
    duringApply: async () => {
      await d1
        .prepare("UPDATE schema_state SET value = ?, updated_at = ? WHERE key = ?")
        .bind(newerValue, "2099-01-01T00:00:00.000Z", fp.SCHEMA_GENERATION_KEY)
        .run();
    },
  });
  await quietly(() => init.bootSchema(d1, older, stages));
  assert.equal(calls.apply, 1, "the older build had already started its replay");
  const row = await storedRow(fp.SCHEMA_GENERATION_KEY);
  assert.equal(row.value, newerValue, "the newer generation stays on record");
  assert.equal(row.updated_at, "2099-01-01T00:00:00.000Z");
});

/* ── the same, in statements that reach the database ───────────────────────── */

test("with the REAL stages, an old build over a newer schema issues one CREATE (the state table) and no replay", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await recordGeneration(current.generation + 1, "ffffffff");
  const counter = counting();
  const decision = await quietly(() => init.bootSchema(counter.d1, current));
  assert.equal(decision.action, "newer-schema");
  assert.equal(counter.creates(), 1, "reproduced before the fix: 341 CREATE statements here");
});

test("with the REAL stages, the current build on a current schema issues only the boot's few CREATEs", { skip }, async () => {
  const current = { generation: fp.SCHEMA_GENERATION, fingerprint: fp.SCHEMA_FINGERPRINT };
  await recordGeneration(current.generation);
  const counter = counting();
  const decision = await quietly(() => init.bootSchema(counter.d1, current));
  assert.equal(decision.action, "current");
  assert.ok(counter.creates() < 10, `a current boot is the state table and the repairs' indexes, not a replay (${counter.creates()})`);
});

test("ensureDatabase() — the entry every route calls — uses the guard", { skip }, async () => {
  /*
   * Last in the file on purpose: `ensureDatabase()` memoises for the life of the
   * module. A newer generation is on record, so the production entry point must
   * return without replaying — counted on the binding it actually uses.
   */
  await recordGeneration(fp.SCHEMA_GENERATION + 1, "ffffffff");
  const prepare = d1.prepare.bind(d1);
  let creates = 0;
  d1.prepare = (sql) => {
    if (/^\s*CREATE\s/i.test(sql)) creates += 1;
    return prepare(sql);
  };
  try {
    await quietly(() => init.ensureDatabase());
  } finally {
    d1.prepare = prepare;
  }
  assert.equal(creates, 1, "only the state table's IF NOT EXISTS; no migration replay");
});
