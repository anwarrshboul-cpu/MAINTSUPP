/**
 * THE STALL DIAGNOSTICS — a wait that never ends says what it was waiting for.
 *
 * On 2026-09-23 one Production request hit the 60-second limit with its boot
 * statements answered in 126 ms and then 59 silent seconds: nothing in the
 * function could say which await it was stuck in. `db/pending-watch.ts` logs a
 * STAGE after ten seconds, and these tests hold it to three promises:
 *
 *   - silence on the healthy path (no line for anything that finishes in time);
 *   - a line naming the stage, and a second when it settles, on a slow one;
 *   - no data in either: a statement is described by its verb and first table,
 *     with quoted literals blanked before anything is matched.
 *
 * And the connection line reports whether TLS is in use — read from
 * postgres.js's resolved options, never from the URL.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeStatement, watchPending } from "../db/pending-watch.ts";
import { createPgD1Database } from "../db/node-pg-d1.ts";

function capture() {
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => (console.warn = warn) };
}

async function withWatchMs(ms, run) {
  const saved = process.env.DB_WATCH_MS;
  process.env.DB_WATCH_MS = String(ms);
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.DB_WATCH_MS;
    else process.env.DB_WATCH_MS = saved;
  }
}

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("a statement is described by its verb and first table, and nothing else", () => {
  assert.equal(describeStatement("SELECT value FROM schema_state WHERE key = ?"), "SELECT schema_state");
  assert.equal(describeStatement("  update maintenance_requests SET title = ? WHERE id = ?"), "UPDATE maintenance_requests");
  assert.equal(describeStatement("INSERT OR IGNORE INTO schema_state (key) VALUES (?)"), "INSERT schema_state");
  assert.equal(describeStatement("DELETE FROM attachments WHERE id = ?"), "DELETE attachments");
  assert.equal(describeStatement("CREATE TABLE IF NOT EXISTS invoice_flags (id TEXT)"), "CREATE invoice_flags");
  assert.equal(
    describeStatement("CREATE UNIQUE INDEX IF NOT EXISTS attachments_root_version_idx ON attachments (id)"),
    "CREATE attachments",
  );
  assert.equal(describeStatement("BEGIN"), "BEGIN");
});

test("a word inside a quoted literal can never be reported as a table", () => {
  /* The only content a statement's text could carry is in its literals. */
  assert.equal(describeStatement("SELECT 'from alice@example.com' AS x FROM users"), "SELECT users");
  assert.equal(describeStatement("SELECT id FROM jobs WHERE status = 'on hold'"), "SELECT jobs");
  assert.equal(describeStatement("SELECT 'it''s from secret_table' AS note"), "SELECT");
});

test("the healthy path logs nothing", async () => {
  await withWatchMs(50, async () => {
    const out = capture();
    try {
      assert.equal(await watchPending("query: SELECT organisations", () => sleep(5, "ok")), "ok");
    } finally {
      out.restore();
    }
    assert.deepEqual(out.lines, [], "one timer set and cleared, and silence");
  });
});

test("a slow stage is named while it waits, and again when it finishes", async () => {
  await withWatchMs(30, async () => {
    const out = capture();
    try {
      assert.equal(await watchPending("boot: read schema generation", () => sleep(90, "late")), "late");
    } finally {
      out.restore();
    }
    assert.equal(out.lines.length, 2);
    assert.match(out.lines[0], /^\[db-watch\] still waiting after 0\.0s: boot: read schema generation$/);
    assert.match(out.lines[1], /^\[db-watch\] finished after \d+\.\ds: boot: read schema generation$/);
  });
});

test("a failure still propagates, and a slow one is reported as failed", async () => {
  await withWatchMs(20, async () => {
    const out = capture();
    try {
      await assert.rejects(
        watchPending("query: UPDATE schema_state", async () => {
          await sleep(60);
          throw new Error("boom");
        }),
        /boom/,
      );
      await assert.rejects(watchPending("query: SELECT users", () => Promise.reject(new Error("fast"))), /fast/);
    } finally {
      out.restore();
    }
    assert.equal(out.lines.length, 2, "the fast failure logs nothing; the slow one logs twice");
    assert.match(out.lines[1], /^\[db-watch\] failed after /);
  });
});

test("DB_WATCH_MS=0 turns the watch off", async () => {
  await withWatchMs(0, async () => {
    const out = capture();
    try {
      await watchPending("query: SELECT organisations", () => sleep(20));
    } finally {
      out.restore();
    }
    assert.deepEqual(out.lines, []);
  });
});

test("the adapter watches every statement, the reservation and the batch boundaries", async () => {
  const adapter = await readFile(new URL("../db/node-pg-d1.ts", import.meta.url), "utf8");
  assert.match(adapter, /watchPending\(\s*`query: \$\{describeStatement\(this\.sql\)\}/, "every statement, by shape only");
  assert.match(adapter, /watchPending\("pool: reserve a connection for a batch"/);
  assert.match(adapter, /watchPending\("batch: BEGIN"/);
  assert.match(adapter, /watchPending\("batch: COMMIT"/);
  const init = await readFile(new URL("../db/init.ts", import.meta.url), "utf8");
  for (const stage of ["create schema_state", "read schema generation", "apply migrations", "record schema generation", "repair invariants"]) {
    assert.match(init, new RegExp(`watchPending\\("boot: ${stage}"`), `the boot stage "${stage}" is watched`);
  }
});

test("the connection line says whether TLS is in use, and never the password", () => {
  /*
   * postgres.js negotiates TLS only when its resolved `ssl` option is truthy,
   * and constructing the pool opens no socket — so this runs offline.
   */
  const secret = "s3cret-not-for-logs";
  const plain = createPgD1Database(`postgresql://user.ref:${secret}@pooler.example.invalid:6543/postgres`).describe;
  assert.match(plain, /pooler\.example\.invalid:6543\/postgres \(search_path=portal, pg_catalog, tls=off\)$/);
  const tls = createPgD1Database(
    `postgresql://user.ref:${secret}@pooler.example.invalid:6543/postgres?sslmode=require`,
  ).describe;
  assert.match(tls, /tls=require\)$/);
  for (const line of [plain, tls]) {
    assert.doesNotMatch(line, new RegExp(secret), "the password never reaches the line");
    assert.doesNotMatch(line, /user\.ref|sslmode/, "nor the user, nor any query parameter");
  }
});
