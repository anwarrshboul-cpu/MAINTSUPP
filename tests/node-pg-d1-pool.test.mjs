import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { createPgD1Database } from "../db/node-pg-d1.ts";

/**
 * The adapter's behaviour when Supabase's session pooler has no room.
 *
 * Three applications share one pooler on this project — the portal on Railway,
 * the same portal on Vercel, and the Phase 2 API in `apps/` — and the pooler's
 * client limit is 15. Going past it is not a queue. Reproduced against the real
 * project by opening single-connection clients until one was turned away, which
 * happened on the sixteenth:
 *
 *   connection 15: ok
 *   connection 16: REFUSED
 *     name    : PostgresError
 *     code    : XX000
 *     message : (EMAXCONNSESSION) max clients reached in session mode -
 *               max clients are limited to pool_size: 15
 *
 * Before this change that refusal reached the route as a `D1_ERROR` and the
 * route answered 500. These tests hold the refusal still — see
 * `pooler-refusal-driver.cjs` — so the retry can be asserted rather than timed
 * against a live pooler, and so the tests cannot themselves consume the
 * project's connection budget while other work is running against it.
 */

const driver = createRequire(import.meta.url)("./pooler-refusal-driver.cjs");

/** The adapter resolves `PG_D1_DRIVER` from cwd, so this is a path, not a name. */
const FAKE_DRIVER = "./tests/pooler-refusal-driver.cjs";
const URL_ = "postgresql://user:pw@db.example.invalid:5432/postgres";

function withDriver(env, run) {
  const saved = {
    PG_D1_DRIVER: process.env.PG_D1_DRIVER,
    PG_D1_FAKE_REFUSALS: process.env.PG_D1_FAKE_REFUSALS,
    PG_D1_FAKE_ERROR: process.env.PG_D1_FAKE_ERROR,
    PG_D1_POOL_RETRIES: process.env.PG_D1_POOL_RETRIES,
  };
  Object.assign(process.env, { PG_D1_DRIVER: FAKE_DRIVER }, env);
  driver.__reset();
  return (async () => {
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
}

test("a refused connection is retried, and the query succeeds", async () => {
  await withDriver({ PG_D1_FAKE_REFUSALS: "2" }, async () => {
    const started = Date.now();
    const row = await createPgD1Database(URL_).prepare("SELECT 1 AS ok").first();
    // Two refusals, then the third attempt is served: the caller sees a result,
    // not a 500. This is the whole of the change.
    assert.deepEqual(row, { ok: 1 });
    assert.equal(driver.__attempts(), 3);
    // And it waited rather than spinning — the first two backoffs are ~50ms and
    // ~150ms, jittered down to no less than 75% of each.
    assert.ok(Date.now() - started >= 140, "the retry must back off, not spin");
  });
});

test("the pooler refusing for good is reported, not retried for ever", async () => {
  await withDriver({ PG_D1_FAKE_REFUSALS: "99" }, async () => {
    await assert.rejects(
      () => createPgD1Database(URL_).prepare("SELECT 1 AS ok").first(),
      /EMAXCONNSESSION/,
      "a pooler that is permanently full must surface as an error",
    );
    // Four attempts: the first, plus the three backoffs. A pooler that has been
    // full for half a second is oversubscribed, and hiding that is worse than
    // reporting it.
    assert.equal(driver.__attempts(), 4);
  });
});

test("a non-transient error is not retried", async () => {
  await withDriver({ PG_D1_FAKE_ERROR: "1" }, async () => {
    await assert.rejects(
      () => createPgD1Database(URL_).prepare("SELCT 1").first(),
      /syntax error/,
    );
    // Exactly one. A retried constraint violation is just a slower one, and a
    // retried write on a dropped socket is a duplicate row.
    assert.equal(driver.__attempts(), 1);
  });
});

test("PG_D1_POOL_RETRIES=0 turns the wait off", async () => {
  await withDriver(
    { PG_D1_FAKE_REFUSALS: "99", PG_D1_POOL_RETRIES: "0" },
    async () => {
      await assert.rejects(
        () => createPgD1Database(URL_).prepare("SELECT 1 AS ok").first(),
        /EMAXCONNSESSION/,
      );
      assert.equal(driver.__attempts(), 1);
    },
  );
});

test("a batch waits for its reserved connection too", async () => {
  await withDriver({ PG_D1_FAKE_REFUSALS: "1" }, async () => {
    // `db/init.ts` boots the entire schema through `batch()`, so a portal
    // starting while the pooler is briefly full must wait rather than fail.
    const db = createPgD1Database(URL_);
    const results = await db.batch([db.prepare("SELECT 1 AS ok")]);
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
  });
});

/* ------------------------------------------------------------- pool size -- */

test("the default pool is 4 on a long-lived host and 2 on Vercel", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../db/node-pg-d1.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /const DEFAULT_POOL_SIZE = 4;/);
  assert.match(source, /const VERCEL_POOL_SIZE = 2;/);
  // The choice must be made from the environment, not frozen at one number:
  // Vercel decides how many instances exist and each one carries its own pool.
  assert.match(
    source,
    /return env\["VERCEL"\] \? VERCEL_POOL_SIZE : DEFAULT_POOL_SIZE;/,
  );
  assert.match(
    source,
    /max: positiveInteger\(env\["PG_D1_POOL"\], defaultPoolSize\(env\)\)/,
  );
});
