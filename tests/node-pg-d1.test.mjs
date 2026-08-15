import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPgD1Database } from "../db/node-pg-d1.ts";

/**
 * The Postgres D1 adapter, exercised against the REAL Supabase `portal` schema.
 *
 * Not against a fixture, and not against a local Postgres, because almost
 * everything this adapter has to get right is a property of that specific
 * database: which columns the migration typed `boolean`, which it typed `date`
 * rather than `timestamptz`, and whether `search_path` reaches the live
 * Phase 2 tables in `public`. A local schema would agree with the adapter by
 * construction and prove nothing.
 *
 * Reads are the bulk of it. The one write is a session row of this test's own
 * making, inserted, updated and deleted inside a single test, with the delete
 * asserted — the same row the acceptance run mints by hand, for the same
 * reason: `sessions` is the only table the portal writes that has no side
 * effect on anything a user can see.
 *
 * Skipped, loudly, when there is no connection string — a test that silently
 * passes because it did not run is worse than one that is not there.
 */

function databaseUrl() {
  if (process.env.PG_D1_URL) return process.env.PG_D1_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    return /^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(vars)?.[1] ?? null;
  } catch {
    return null;
  }
}

const url = databaseUrl();
const options = url
  ? {}
  : { skip: "no DATABASE_URL / PG_D1_URL, and no .dev.vars to read one from" };

/** One binding per test file; `close()` in the last test, not per test. */
let database = null;
const db = () => (database ??= createPgD1Database(url));

/* ----------------------------------------------------------- the data is there */

test("the legacy row counts are the migrated ones", options, async () => {
  const counts = await db()
    .prepare(
      `SELECT (SELECT count(*) FROM maintenance_requests)     AS requests,
              (SELECT count(*) FROM maintenance_board_cells)  AS cells,
              (SELECT count(*) FROM users)                    AS users,
              (SELECT count(*) FROM units)                    AS units,
              (SELECT count(*) FROM attachments)              AS attachments`,
    )
    .first();

  assert.deepEqual(counts, {
    requests: 776,
    cells: 8720,
    users: 152,
    units: 20,
    attachments: 2968,
  });
});

test("count(*) comes back as a number, not postgres.js's string", options, async () => {
  // int8 is returned as a string by postgres.js. Left alone, every `total + 1`
  // in the app would concatenate and every `total.toFixed()` would throw.
  const row = await db().prepare("SELECT count(*) AS n FROM sites").first();
  assert.equal(typeof row.n, "number");
});

/* ------------------------------------------------------------ value shapes */

test("a boolean column reads back as 1/0, which is what the app compares", options, async () => {
  // db/schema.ts declares all 27 of these `integer({ mode: "boolean" })`, and
  // drizzle's mapper is `Number(value) === 1`.
  const rows = await db()
    .prepare("SELECT id, active FROM users ORDER BY id LIMIT 5")
    .all();
  assert.equal(rows.success, true);
  for (const row of rows.results) {
    assert.ok(row.active === 1 || row.active === 0, `active was ${row.active}`);
  }
});

test("a timestamptz column reads back as an ISO-8601 instant", options, async () => {
  const row = await db()
    .prepare(
      "SELECT created_at FROM maintenance_requests WHERE created_at IS NOT NULL LIMIT 1",
    )
    .first();
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("a date column reads back as YYYY-MM-DD, with no zone to shift it", options, async () => {
  // The 12 `date` columns are <input type="date"> fields. The migration typed
  // them `date` specifically so a timezone could not turn the 7th into the 6th
  // (README decision 2); returning a full instant here would undo that.
  const row = await db()
    .prepare(
      "SELECT due_at FROM maintenance_requests WHERE due_at IS NOT NULL ORDER BY due_at LIMIT 1",
    )
    .first();
  assert.match(row.due_at, /^\d{4}-\d{2}-\d{2}$/);
});

test("a NULL stays null rather than becoming a string or an epoch", options, async () => {
  const row = await db()
    .prepare("SELECT completed_at FROM maintenance_requests WHERE completed_at IS NULL LIMIT 1")
    .first();
  assert.equal(row.completed_at, null);
});

/* ------------------------------------------------------- the D1 interface */

test("bind() returns a NEW statement and leaves the original unbound", options, async () => {
  // Drizzle prepares once and binds per execution; a mutating bind would leak
  // one request's parameters into the next — and unlike the SQLite shim, two
  // requests really can be in flight here at the same time.
  const statement = db().prepare("SELECT id FROM users WHERE email = ?");
  const bound = statement.bind("no-such-user@example.invalid");
  assert.notEqual(statement, bound);
  const rows = await bound.all();
  assert.equal(rows.results.length, 0);
});

test("first(column) returns the value, first() the row, and null for no rows", options, async () => {
  const value = await db()
    .prepare("SELECT count(*) AS n FROM organisations")
    .first("n");
  assert.equal(typeof value, "number");
  const missing = await db()
    .prepare("SELECT id FROM users WHERE id = ?")
    .bind("nobody")
    .first();
  assert.equal(missing, null);
});

test("raw() returns row arrays, and columnNames prepends the header", options, async () => {
  // This is the shape drizzle reads for every SELECT it maps onto a schema.
  const rows = await db()
    .prepare("SELECT id, active FROM users ORDER BY id LIMIT 2")
    .raw();
  assert.equal(rows.length, 2);
  assert.ok(Array.isArray(rows[0]));
  assert.ok(rows[0][1] === 1 || rows[0][1] === 0);

  const withNames = await db()
    .prepare("SELECT id, active FROM users ORDER BY id LIMIT 1")
    .raw({ columnNames: true });
  assert.deepEqual(withNames[0], ["id", "active"]);
});

test("a failing query throws a D1_ERROR naming the statement", options, async () => {
  await assert.rejects(
    () => db().prepare("SELECT no_such_column FROM users").all(),
    (error) => {
      assert.match(error.message, /^D1_ERROR: /);
      assert.match(error.message, /no_such_column/);
      return true;
    },
  );
});

/* --------------------------------------------------------- the translator */

test("PRAGMA table_info answers with the columns db/init.ts reads", options, async () => {
  // The bootstrap guards every ALTER TABLE ADD COLUMN with this. Without it the
  // portal cannot boot; with it wrong, the boot ALTERs columns that exist.
  const info = await db().prepare("PRAGMA table_info(maintenance_requests)").all();
  const names = info.results.map((row) => row.name);
  assert.ok(names.includes("id"));
  assert.ok(names.includes("parent_id"), "the sub-item guard reads this one");
  assert.ok(names.includes("deleted_at"), "the recycle-bin guard reads this one");
  assert.deepEqual(Object.keys(info.results[0]).sort(), [
    "cid",
    "dflt_value",
    "name",
    "notnull",
    "pk",
    "type",
  ]);
});

test("PRAGMA table_info on a missing table is zero rows, not an error", options, async () => {
  // `addColumn` reads "no columns" as "a later stage creates this table".
  const info = await db().prepare("PRAGMA table_info(table_that_does_not_exist)").all();
  assert.equal(info.results.length, 0);
});

test("a boolean literal in a WHERE clause is translated on the way out", options, async () => {
  // Untranslated this is `operator does not exist: boolean = integer`.
  const row = await db()
    .prepare("SELECT count(*) AS n FROM users WHERE active = 1")
    .first();
  assert.ok(row.n > 0);
});

test("a bound 1 means true and a bound 0 means false", options, async () => {
  /*
   * The bug this locks: postgres.js Binds a parameter with the serialiser for
   * the type POSTGRES inferred, and its built-in boolean serialiser is
   * `x === true ? 't' : 'f'`. Without the override in `PG_TYPES`, both of these
   * bind `f` — no error, just every flag in the portal written false. `active`
   * is 151 true and 1 false in the live schema, so the two numbers below cannot
   * be produced by a serialiser that ignores its input.
   */
  const yes = await db()
    .prepare("SELECT count(*) AS n FROM users WHERE active = ?")
    .bind(1)
    .first();
  const no = await db()
    .prepare("SELECT count(*) AS n FROM users WHERE active = ?")
    .bind(0)
    .first();
  const literal = await db()
    .prepare("SELECT count(*) AS n FROM users WHERE active = 1")
    .first();

  assert.equal(yes.n, literal.n);
  assert.notEqual(yes.n, no.n);
  assert.equal(yes.n + no.n, 152);
});

test("a value that is neither true nor false is refused, not defaulted", options, async () => {
  await assert.rejects(
    () =>
      db()
        .prepare("SELECT count(*) AS n FROM users WHERE active = ?")
        .bind("perhaps")
        .all(),
    /neither true nor false/,
  );
});

test("datetime() in an ORDER BY sorts by instant", options, async () => {
  const rows = await db()
    .prepare(
      "SELECT created_at FROM item_updates ORDER BY datetime(created_at) DESC LIMIT 3",
    )
    .all();
  const instants = rows.results.map((row) => Date.parse(row.created_at));
  assert.deepEqual(instants, [...instants].sort((a, b) => b - a));
});

/* ------------------------------------------------------------ safety rails */

test("search_path is portal only — public is not reachable unqualified", options, async () => {
  const path = await db().prepare("SHOW search_path").first("search_path");
  assert.equal(path, "portal, pg_catalog");

  // `jobs` is a Phase 2 table in `public` with 791 live rows and no counterpart
  // in `portal`. If this query succeeds, the adapter can see somebody else's
  // data and the whole safety argument is gone.
  await assert.rejects(
    () => db().prepare("SELECT count(*) FROM jobs").all(),
    /relation "jobs" does not exist/,
  );
});

test("the live public schema still holds its 23 tables", options, async () => {
  const row = await db()
    .prepare(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .first();
  assert.equal(row.n, 23);
});

test("no non-boolean column shares a name with a boolean one", options, async () => {
  /*
   * The `WHERE active = 1` rule matches on the column NAME, because a
   * comparison rarely names its table. That is only sound while this query
   * returns nothing — add an integer column called `active` and the rule starts
   * rewriting the wrong statements.
   */
  const { BOOLEAN_COLUMN_NAMES } = await import("../db/sqlite-to-postgres.ts");
  const names = [...BOOLEAN_COLUMN_NAMES].map((name) => `'${name}'`).join(", ");
  const clashes = await db()
    .prepare(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'portal'
          AND column_name IN (${names})
          AND data_type <> 'boolean'`,
    )
    .all();
  assert.deepEqual(clashes.results, []);
});

test("the per-table boolean map matches the live schema exactly", options, async () => {
  const { BOOLEAN_COLUMNS } = await import("../db/sqlite-to-postgres.ts");
  const live = await db()
    .prepare(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'portal' AND data_type = 'boolean'
        ORDER BY table_name, column_name`,
    )
    .all();

  const fromDatabase = {};
  for (const row of live.results) {
    (fromDatabase[row.table_name] ??= []).push(row.column_name);
  }
  assert.deepEqual(fromDatabase, BOOLEAN_COLUMNS);
});

/* ------------------------------------------------------------- the writes */

test("insert, update and delete a scratch session row", options, async () => {
  const id = `pgd1_test_${Date.now()}`;
  const user = await db().prepare("SELECT id FROM users ORDER BY id LIMIT 1").first();
  const issued = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();

  try {
    const inserted = await db()
      .prepare(
        `INSERT INTO sessions
           (id, user_id, token_hash, organisation_id, issued_at, expires_at, last_seen_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, user.id, `hash-${id}`, null, issued, expires, issued, "127.0.0.1", "node:test")
      .run();

    // `meta.changes` has to be a real count: `consumeReset()` and the invitation
    // claim decide whether a single-use token was won by reading it.
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.changed_db, true);

    const readBack = await db()
      .prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?")
      .bind(id)
      .first();
    assert.equal(readBack.id, id);
    assert.equal(readBack.expires_at, expires);

    const updated = await db()
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    assert.equal(updated.meta.changes, 1);

    // A SELECT reports no changes, however many rows it read.
    const read = await db().prepare("SELECT id FROM sessions WHERE id = ?").bind(id).run();
    assert.equal(read.meta.changes, 0);
  } finally {
    const deleted = await db().prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    assert.equal(deleted.meta.changes, 1, "the scratch row must not survive the test");
  }

  const gone = await db().prepare("SELECT id FROM sessions WHERE id = ?").bind(id).first();
  assert.equal(gone, null);
});

test("INSERT OR IGNORE against a row that exists is a no-op, not an error", options, async () => {
  const before = await db().prepare("SELECT count(*) AS n FROM organisations").first();
  const result = await db()
    .prepare(
      "INSERT OR IGNORE INTO organisations (id, name, slug) VALUES (?, ?, ?)",
    )
    .bind("org_000000000000000000000001", "Sunnamusk UK", "sunnamusk-uk")
    .run();
  assert.equal(result.meta.changes, 0);
  const after = await db().prepare("SELECT count(*) AS n FROM organisations").first();
  assert.equal(after.n, before.n);
});

test("batch() is one transaction: a failure rolls the whole thing back", options, async () => {
  const id = `pgd1_batch_${Date.now()}`;
  const user = await db().prepare("SELECT id FROM users ORDER BY id LIMIT 1").first();
  const now = new Date().toISOString();

  await assert.rejects(() =>
    db().batch([
      db()
        .prepare(
          `INSERT INTO sessions (id, user_id, token_hash, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, user.id, `hash-${id}`, now, now),
      db().prepare("INSERT INTO sessions (id, no_such_column) VALUES (?, 1)").bind(id),
    ]),
  );

  const survivor = await db().prepare("SELECT id FROM sessions WHERE id = ?").bind(id).first();
  assert.equal(survivor, null, "the first statement must have been rolled back");
});

test("batch() returns one result per statement, in order", options, async () => {
  const results = await db().batch([
    db().prepare("SELECT count(*) AS n FROM sites"),
    db().prepare("SELECT count(*) AS n FROM units"),
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[1].results[0].n, 20);
});

test("close the connection", options, async () => {
  if (database) await database.close();
});
