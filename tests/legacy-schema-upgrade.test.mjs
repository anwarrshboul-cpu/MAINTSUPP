/**
 * THE UPGRADE PATH, NOT THE FRESH ONE.
 *
 * Every other test in this suite meets a database that `db/init.ts` created.
 * Production did not: it is an estate that predates most of this schema, and the
 * only thing standing between it and a missing column is a guard somebody
 * remembered to write. `CREATE TABLE IF NOT EXISTS` upgrades nothing — it sees a
 * table with that name and returns — so a column added to a declaration years
 * after the table was first created reaches a fresh database and never reaches
 * an old one.
 *
 * That is not hypothetical. On 2026-09-08 the four rebuilt operations pages
 * shipped, and on Production — and only on Production — `Performance over time`
 * and `Cost` answered "The dashboard is temporarily unavailable" while the four
 * cards beside them loaded, workspace switching sometimes reported a failed
 * `organisations` query, and the Jobs form sometimes refused to load.
 *
 * The cause was not in any of those features. `ensureBaseSchema` ran every
 * CREATE TABLE and every CREATE INDEX in ONE batch and called
 * `ensureLegacyColumns` after it. `CREATE INDEX IF NOT EXISTS` guards the INDEX,
 * not the COLUMN, so on an estate whose `sites` predates `lifecycle` the index
 * threw, the batch rolled back, and `initialize()` died at its FIRST stage —
 * taking with it every later stage, including the guards that add
 * `target_completion_date` and `annual_budget_pence`, the two columns those two
 * cards are the only readers of.
 *
 * THE FIXTURE IS A COPY OF A REAL DATABASE, with the rebuild-era columns and
 * their indexes dropped. Modelling "old" by writing a small table by hand tests
 * a database nobody has; modelling it by ageing a real one tests the estate the
 * outage happened on.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const D1_DIR = path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

/**
 * What an estate created before the rebuild is missing, and what breaks without
 * each one. `sites.lifecycle` is in the list because it is the one that made the
 * boot path itself fail — every other entry is a consequence of that.
 */
const LEGACY_GAPS = [
  ["sites", "lifecycle", "the boot path — sites_lifecycle_idx indexes it"],
  ["maintenance_requests", "target_completion_date", "Overview → Performance over time"],
  ["sites", "annual_budget_pence", "Overview → Cost"],
];

const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

function localDatabaseFile() {
  if (!fs.existsSync(D1_DIR)) return null;
  const files = fs
    .readdirSync(D1_DIR)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => path.join(D1_DIR, f));
  return files.length === 1 ? files[0] : null;
}

/** Age a copy of the real database back to before the rebuild. */
function ageDatabase(file) {
  const db = new DatabaseSync(file);
  const dropped = [];
  try {
    for (const [table, column] of LEGACY_GAPS) {
      if (!columnsOf(db, table).includes(column)) continue;
      /* An index over the column has to go first — SQLite will not drop a
         column an index depends on, which is the same coupling that broke the
         boot from the other direction. */
      for (const row of db.prepare(`PRAGMA index_list(${table})`).all()) {
        const cols = db.prepare(`PRAGMA index_info(${row.name})`).all().map((c) => c.name);
        if (cols.includes(column)) db.exec(`DROP INDEX IF EXISTS ${row.name}`);
      }
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      dropped.push(`${table}.${column}`);
    }
  } finally {
    db.close();
  }
  return dropped;
}

let hooksInstalled = false;
function installHooks(sqlitePath) {
  process.env["D1_SQLITE_PATH"] = sqlitePath;
  if (hooksInstalled) return;
  hooksInstalled = true;
  const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
      /* `db/init.ts` imports `from "."` and `db/index.ts` imports `./schema`.
         TypeScript resolves both; Node does not. Appending the extension here
         keeps the source honest rather than editing imports to suit a test. */
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

test("ensureDatabase upgrades a pre-rebuild database instead of assuming a fresh one", async (t) => {
  const source = localDatabaseFile();
  if (!source) {
    t.skip("no single local D1 database to age; run the dev server once first");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-legacy-"));
  const file = path.join(dir, "legacy.sqlite");
  fs.copyFileSync(source, file);

  const dropped = ageDatabase(file);
  assert.ok(
    dropped.length > 0,
    "the fixture must actually be missing something, or this proves nothing",
  );
  t.diagnostic(`aged the copy by dropping: ${dropped.join(", ")}`);

  /* Counted before the boot so the survival check below has a number to hold
     it to, rather than asserting "some rows exist". */
  const before = new DatabaseSync(file, { readOnly: true });
  const jobsBefore = before.prepare("SELECT count(*) AS n FROM maintenance_requests").get().n;
  const sitesBefore = before.prepare("SELECT count(*) AS n FROM sites").get().n;
  before.close();

  installHooks(file);
  const init = await import("../db/init.ts");

  /*
   * THE ASSERTION THAT MATTERS MOST. Before the fix this rejected at the first
   * stage with `no such column: lifecycle`, and every guard after it was
   * skipped — which is the whole outage in one line.
   */
  await assert.doesNotReject(
    () => init.ensureDatabase(),
    "the boot path must survive meeting a database older than itself",
  );

  const after = new DatabaseSync(file, { readOnly: true });
  try {
    for (const [table, column, breaks] of LEGACY_GAPS) {
      assert.ok(
        columnsOf(after, table).includes(column),
        `${table}.${column} is still missing after the boot ran — ${breaks}`,
      );
    }

    /* An upgrade that repaired the schema by rebuilding the tables would pass
       every assertion above and lose the estate. */
    assert.equal(
      after.prepare("SELECT count(*) AS n FROM maintenance_requests").get().n,
      jobsBefore,
      "no job may be lost by a schema repair",
    );
    assert.equal(
      after.prepare("SELECT count(*) AS n FROM sites").get().n,
      sitesBefore,
      "no site may be lost by a schema repair",
    );

    /* The three queries the outage was reported against, run against the
       upgraded estate. What is proved is that they execute at all. */
    assert.doesNotThrow(
      () =>
        after
          .prepare(
            `SELECT id, name, slug, logo_url, primary_colour, plan_tier, status, created_at, updated_at
               FROM organisations WHERE status = 'active' ORDER BY created_at ASC`,
          )
          .all(),
      "the workspace switcher's organisations query",
    );
    assert.doesNotThrow(
      () =>
        after
          .prepare(
            "SELECT count(*) AS n FROM maintenance_requests WHERE target_completion_date IS NOT NULL",
          )
          .all(),
      "Performance over time reads target_completion_date",
    );
    assert.doesNotThrow(
      () => after.prepare("SELECT coalesce(sum(annual_budget_pence), 0) AS n FROM sites").all(),
      "Cost reads annual_budget_pence",
    );
    assert.doesNotThrow(
      () => after.prepare("SELECT count(*) AS n FROM sites WHERE lifecycle IS NOT NULL").all(),
      "and the column whose index broke the boot is back",
    );
  } finally {
    after.close();
    /* Release the boot path's own handle first: Windows will not unlink a file
       SQLite still has open, and a failed cleanup would read as a failed test. */
    const stub = await import("./fixtures/cloudflare-workers-stub.mjs");
    stub.closeForTests?.();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* A leftover temp directory is the OS's to reclaim; it is not a result. */
    }
  }
});
