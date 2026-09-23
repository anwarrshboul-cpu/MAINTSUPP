/**
 * Contractors → Resolve names commits or rolls back AS ONE — dashboard §9 item 20.
 *
 * §3.6: "Linking writes to a `contractor_aliases` table … and backfills
 * `contractor_id` on matching jobs in one transaction." It did not: a link was
 * up to five separate statements, so a failure part-way left an alias with half
 * its jobs attributed, or attributed jobs with no activity row — and the
 * activity row is the reversal record `unlink` reads. The writes now live in
 * `app/lib/contractor-alias-writes.ts`, which commits every action in one
 * `batch()`.
 *
 * ── HOW THIS IS PROVED, RATHER THAN PINNED ────────────────────────────────
 *
 * The real module runs against REAL SQLite — a fresh file, migrated by the real
 * `ensureDatabase()` — through `tests/fixtures/cloudflare-workers-stub.mjs`,
 * whose `batch()` is a BEGIN/COMMIT/ROLLBACK transaction exactly as Miniflare's
 * D1 is. (Deployed, `db/node-pg-d1.ts` runs `batch()` as BEGIN … COMMIT on one
 * reserved connection; `tests/node-pg-d1.test.mjs` holds that.) A failure is
 * injected with a SQLite trigger that aborts ONE chosen statement, so the test
 * breaks the operation at a precise point — the last statement, and the middle
 * of a chunked backfill — and then reads what the database is left holding.
 *
 * Self-contained: a temporary file, removed afterwards. It never opens the
 * development database in `.wrangler`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function installHooks(sqlitePath) {
  process.env["D1_SQLITE_PATH"] = sqlitePath;
  const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
      if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
        const base = new URL(specifier, context.parentURL);
        for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
          if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
}

let dir = null;
let d1 = null;
let scope = null;
let writes = null;
let ORG = null;

const JOBS = Array.from({ length: 170 }, (_, i) => `zz-job-${String(i).padStart(3, "0")}`);
const ALREADY = ["zz-owned-1", "zz-owned-2"];
const CONTRACTOR = "zz-contractor-1";
const OTHER_CONTRACTOR = "zz-contractor-2";

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maintsupp-alias-tx-"));
  installHooks(path.join(dir, "alias.sqlite"));
  const { ensureDatabase } = await import("../db/init.ts");
  const { getD1, getDb } = await import("../db/index.ts");
  writes = await import("../app/lib/contractor-alias-writes.ts");
  await ensureDatabase();
  d1 = await getD1();
  ORG = (await d1.prepare("SELECT id FROM organisations WHERE status = 'active' ORDER BY id LIMIT 1").first())?.id;
  assert.ok(ORG, "a fresh database seeds an active organisation");
  scope = { db: await getDb(), orgId: ORG };

  const now = "2026-09-23T12:00:00.000Z";
  for (const [id, name] of [[CONTRACTOR, "ZZ Linked Ltd"], [OTHER_CONTRACTOR, "ZZ Other Ltd"]]) {
    await d1
      .prepare("INSERT INTO contractors (id, organisation_id, name, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
      .bind(id, ORG, name, now, now)
      .run();
  }
  for (const id of [...JOBS, ...ALREADY]) {
    await d1
      .prepare(
        `INSERT INTO maintenance_requests
           (id, organisation_id, title, description, location, requester, contact, category, engineer, contractor, contractor_id)
         VALUES (?, ?, 'zz job', 'zz job for the alias transaction test', 'zz site', 'zz', 'zz', 'Other', 'Other', 'zz linked', ?)`,
      )
      .bind(id, ORG, ALREADY.includes(id) ? OTHER_CONTRACTOR : null)
      .run();
  }
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

const activity = (action, key) => ({
  entityType: "contractor_name",
  entityId: `name:${key}`,
  action,
  actor: "qa@example.invalid",
  at: "2026-09-23T12:30:00.000Z",
});

const plan = (key, overrides = {}) => ({
  key,
  name: key,
  contractorId: CONTRACTOR,
  contractorName: "ZZ Linked Ltd",
  createContractor: null,
  existingAliasId: null,
  targetIds: [...JOBS, ...ALREADY],
  activity: activity("contractor_name.linked", key),
  ...overrides,
});

async function attributed(ids, contractorId) {
  let n = 0;
  for (const id of ids) {
    const row = await d1.prepare("SELECT contractor_id FROM maintenance_requests WHERE id = ?").bind(id).first();
    if ((row?.contractor_id ?? null) === contractorId) n += 1;
  }
  return n;
}

const aliasCount = async (key) =>
  Number((await d1.prepare("SELECT count(*) AS n FROM contractor_name_aliases WHERE normalised = ?").bind(key).first()).n);
const activityCount = async (key) =>
  Number((await d1.prepare("SELECT count(*) AS n FROM activity_log WHERE entity_id = ?").bind(`name:${key}`).first()).n);

async function withTrigger(sql, run) {
  await d1.exec(sql);
  try {
    return await run();
  } finally {
    await d1.exec("DROP TRIGGER IF EXISTS zz_fail");
  }
}

/* ── the success path, and its exact reversal ─────────────────────────────── */

test("a link attributes every unattributed job, never an owned one, and logs the count it wrote", async () => {
  const key = "zz linked";
  const { written } = await writes.applyAliasLink(scope, plan(key));
  assert.equal(written, JOBS.length, "170 jobs had no contractor — all 170 are written, across three chunks");
  assert.equal(await attributed(JOBS, CONTRACTOR), JOBS.length);
  assert.equal(await attributed(ALREADY, OTHER_CONTRACTOR), ALREADY.length, "a job already naming a record is never overwritten");
  assert.equal(await aliasCount(key), 1);
  const row = await d1.prepare("SELECT detail FROM activity_log WHERE entity_id = ? AND action = 'contractor_name.linked'").bind(`name:${key}`).first();
  assert.equal(JSON.parse(row.detail).jobsChanged, JOBS.length, "the activity row states what the transaction wrote");

  const alias = await d1.prepare("SELECT id FROM contractor_name_aliases WHERE normalised = ?").bind(key).first();
  const { cleared } = await writes.applyAliasUnlink(scope, {
    name: key,
    alias: { id: alias.id, contractorId: CONTRACTOR },
    targetIds: JOBS,
    exactReversal: true,
    activity: activity("contractor_name.unlinked", key),
  });
  assert.equal(cleared, JOBS.length);
  assert.equal(await attributed(JOBS, null), JOBS.length, "unlink puts every job back to empty");
  assert.equal(await aliasCount(key), 0);
  assert.equal(await activityCount(key), 2, "one row for the link, one for its reversal");
});

/* ── a failure at the LAST statement undoes everything before it ─────────── */

test("if the activity row fails, the contractor, the alias and every backfilled job roll back", async () => {
  const key = "zz fail at the end";
  const created = "zz-created-by-failed-link";
  await withTrigger(
    `CREATE TRIGGER zz_fail BEFORE INSERT ON activity_log
       WHEN NEW.entity_id = 'name:${key}'
       BEGIN SELECT RAISE(ABORT, 'injected: the activity row fails'); END`,
    async () => {
      await assert.rejects(
        writes.applyAliasLink(scope, plan(key, { contractorId: created, createContractor: { name: "ZZ Created Ltd" } })),
        /injected: the activity row fails/,
      );
    },
  );
  assert.equal(await attributed(JOBS, created), 0, "not one job kept the half-applied attribution");
  assert.equal(await attributed(JOBS, null), JOBS.length);
  assert.equal(await aliasCount(key), 0, "the alias written before the failure is gone");
  const contractor = await d1.prepare("SELECT count(*) AS n FROM contractors WHERE id = ?").bind(created).first();
  assert.equal(Number(contractor.n), 0, "the contractor `create` inserted first is gone too");
  assert.equal(await activityCount(key), 0);
});

/* ── a failure in the MIDDLE of the chunked backfill ─────────────────────── */

test("if the third backfill chunk fails, the first two chunks and the alias roll back", async () => {
  const key = "zz fail mid backfill";
  await withTrigger(
    `CREATE TRIGGER zz_fail BEFORE UPDATE OF contractor_id ON maintenance_requests
       WHEN NEW.id = 'zz-job-165'
       BEGIN SELECT RAISE(ABORT, 'injected: chunk three fails'); END`,
    async () => {
      await assert.rejects(writes.applyAliasLink(scope, plan(key)), /injected: chunk three fails/);
    },
  );
  /* 80 + 80 + 10: jobs 000–159 were in chunks one and two, already UPDATEd
     inside the transaction when job 165 aborted it. */
  assert.equal(await attributed(JOBS.slice(0, 160), CONTRACTOR), 0, "chunks one and two were rolled back");
  assert.equal(await attributed(JOBS, null), JOBS.length);
  assert.equal(await aliasCount(key), 0);
  assert.equal(await activityCount(key), 0);
});

/* ── and unlink is atomic the same way ──────────────────────────────────── */

test("if an unlink's activity row fails, the alias and the attribution stay exactly as they were", async () => {
  const key = "zz unlink fails";
  await writes.applyAliasLink(scope, plan(key));
  assert.equal(await attributed(JOBS, CONTRACTOR), JOBS.length);
  const alias = await d1.prepare("SELECT id FROM contractor_name_aliases WHERE normalised = ?").bind(key).first();

  await withTrigger(
    `CREATE TRIGGER zz_fail BEFORE INSERT ON activity_log
       WHEN NEW.entity_id = 'name:${key}' AND NEW.action = 'contractor_name.unlinked'
       BEGIN SELECT RAISE(ABORT, 'injected: the unlink row fails'); END`,
    async () => {
      await assert.rejects(
        writes.applyAliasUnlink(scope, {
          name: key,
          alias: { id: alias.id, contractorId: CONTRACTOR },
          targetIds: JOBS,
          exactReversal: true,
          activity: activity("contractor_name.unlinked", key),
        }),
        /injected: the unlink row fails/,
      );
    },
  );
  assert.equal(await attributed(JOBS, CONTRACTOR), JOBS.length, "no job lost its attribution");
  assert.equal(await aliasCount(key), 1, "the alias is still there");

  /* Tidy for any test after this one: a real, successful unlink. */
  await writes.applyAliasUnlink(scope, {
    name: key,
    alias: { id: alias.id, contractorId: CONTRACTOR },
    targetIds: JOBS,
    exactReversal: true,
    activity: activity("contractor_name.unlinked", key),
  });
  assert.equal(await attributed(JOBS, null), JOBS.length);
});

/* ── the route uses it, and keeps its own audit after the commit ──────────── */

test("the route applies link and unlink through the transactional module", async () => {
  const route = fs.readFileSync(path.join(root, "app/api/overview/contractor-aliases/route.ts"), "utf8");
  assert.match(route, /await applyAliasLink\(scope, \{/);
  assert.match(route, /await applyAliasUnlink\(scope, \{/);
  assert.doesNotMatch(route, /async function writeContractorId/, "no second, non-transactional writer is left behind");
  assert.doesNotMatch(route, /\.insert\(contractorNameAliases\)/, "the alias is written only inside the batch");
  const lib = fs.readFileSync(path.join(root, "app/lib/contractor-alias-writes.ts"), "utf8");
  assert.match(lib, /await scope\.db\.batch\(/);
});
