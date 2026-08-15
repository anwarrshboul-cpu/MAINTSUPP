import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOLEAN_COLUMNS,
  BOOLEAN_COLUMN_NAMES,
  maskNonCode,
  translateSql,
} from "../db/sqlite-to-postgres.ts";

/**
 * The SQLite → Postgres translator, tested against statements taken out of this
 * repository rather than out of a dialect reference.
 *
 * Every "real statement" case below is copied verbatim from the file named in
 * its comment. That is the point: the translator does not have to handle SQLite,
 * it has to handle the 238 `.prepare()` sites and whatever drizzle's sqlite
 * dialect emits, and those are a much smaller and much more knowable language.
 */

const squash = (sql) => sql.replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------ placeholders */

test("? becomes $1..$n, in order", () => {
  assert.equal(
    squash(
      translateSql(
        "SELECT id FROM users WHERE organisation_id = ? AND email = ? LIMIT ?",
      ),
    ),
    "SELECT id FROM users WHERE organisation_id = $1 AND email = $2 LIMIT $3",
  );
});

test("a ? inside a string literal is not a placeholder", () => {
  const sql =
    "SELECT id FROM maintenance_requests WHERE title LIKE '%what? why?%' AND site_id = ?";
  assert.equal(
    squash(translateSql(sql)),
    "SELECT id FROM maintenance_requests WHERE title LIKE '%what? why?%' AND site_id = $1",
  );
});

test("a ? inside a comment or a quoted identifier is not a placeholder", () => {
  assert.equal(
    squash(translateSql("SELECT 1 -- why? because\nWHERE x = ?")),
    "SELECT 1 -- why? because WHERE x = $1",
  );
  assert.equal(
    squash(translateSql('SELECT "odd?name" FROM t WHERE a = ? /* and ? */')),
    'SELECT "odd?name" FROM t WHERE a = $1 /* and ? */',
  );
});

test("an escaped quote does not end the literal early", () => {
  // 'it''s a ?' is ONE literal. A scanner that stopped at the second quote
  // would see the rest as code and rewrite the ? inside it.
  const sql = "UPDATE users SET full_name = 'it''s a ?' WHERE id = ?";
  assert.equal(
    squash(translateSql(sql)),
    "UPDATE users SET full_name = 'it''s a ?' WHERE id = $1",
  );
});

test("numbered and named placeholders are refused rather than renumbered", () => {
  assert.throws(() => translateSql("SELECT * FROM t WHERE a = ?1"), /\?1/);
  assert.throws(
    () => translateSql("SELECT * FROM t WHERE a = :name"),
    /named parameters/,
  );
});

test("a cast this translator emits is not mistaken for a named parameter", () => {
  // ::timestamptz starts with a colon followed by a letter, which is exactly
  // the shape of a SQLite named parameter.
  assert.match(
    translateSql("SELECT * FROM item_updates ORDER BY datetime(created_at) DESC"),
    /::timestamptz/,
  );
});

/* -------------------------------------------------------------- INSERT OR */

test("INSERT OR IGNORE ... VALUES gains ON CONFLICT DO NOTHING", () => {
  // app/lib/auth-session.ts:801 — verbatim, including the boolean literal.
  const sql = `INSERT OR IGNORE INTO users (id, organisation_id, email, full_name, role, active)
       VALUES (?, ?, ?, ?, 'Super Admin', 1)`;
  assert.equal(
    squash(translateSql(sql)),
    "INSERT INTO users (id, organisation_id, email, full_name, role, active) " +
      "VALUES ($1, $2, $3, $4, 'Super Admin', true) ON CONFLICT DO NOTHING",
  );
});

test("INSERT OR IGNORE ... SELECT gains the clause at the very end", () => {
  // db/init.ts:753 — the INSERT … SELECT form.
  const sql = `INSERT OR IGNORE INTO memberships (id, user_id, organisation_id, role, status, created_at)
       SELECT 'membership-' || id, id, organisation_id, 'admin', 'active', CURRENT_TIMESTAMP
         FROM users WHERE organisation_id = ?`;
  const out = squash(translateSql(sql));
  assert.ok(out.startsWith("INSERT INTO memberships"));
  assert.ok(out.endsWith("WHERE organisation_id = $1 ON CONFLICT DO NOTHING"));
});

test("ON CONFLICT is placed before RETURNING, where the grammar wants it", () => {
  const out = squash(
    translateSql("INSERT OR IGNORE INTO sites (id, name) VALUES (?, ?) RETURNING id"),
  );
  assert.equal(
    out,
    "INSERT INTO sites (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
  );
});

test("INSERT OR ABORT/FAIL/ROLLBACK collapse to a plain INSERT", () => {
  for (const verb of ["ABORT", "FAIL", "ROLLBACK"]) {
    const out = squash(
      translateSql(`INSERT OR ${verb} INTO sites (id, name) VALUES (?, ?)`),
    );
    assert.equal(out, "INSERT INTO sites (id, name) VALUES ($1, $2)");
  }
});

test("INSERT OR REPLACE needs a conflict target and says so when it has none", () => {
  assert.throws(
    () => translateSql("INSERT OR REPLACE INTO sites (id, name) VALUES (?, ?)"),
    /primary key/,
  );
});

test("INSERT OR REPLACE overwrites every non-key column from EXCLUDED", () => {
  const out = squash(
    translateSql("INSERT OR REPLACE INTO sites (id, name, active) VALUES (?, ?, 1)", {
      primaryKeys: new Map([["sites", ["id"]]]),
    }),
  );
  assert.equal(
    out,
    'INSERT INTO sites (id, name, active) VALUES ($1, $2, true) ' +
      'ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "active" = EXCLUDED."active"',
  );
});

/* ---------------------------------------------------------------- booleans */

test("a 0/1 literal written into a boolean column becomes false/true", () => {
  // db/seed-store-documentation.ts:116 — ten placeholders, then 1, 0.
  const sql = `INSERT OR IGNORE INTO maintenance_board_columns
       (id, organisation_id, board_id, key, title, kind, position, width, settings, options, visible, pinned, required, system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`;
  const out = squash(translateSql(sql));
  assert.ok(out.includes("$9, $10, true, false, $11"), out);
});

test("a 0/1 literal in a NON-boolean column of the same insert is left alone", () => {
  // `tier` holds 0 and 2 and is a severity level (migration decision 7); a
  // mechanical "this column only holds 0 and 1" rule would have broken it.
  const out = squash(
    translateSql(
      "INSERT INTO maintenance_requests (id, tier, archived) VALUES (?, 0, 0)",
    ),
  );
  assert.equal(
    out,
    "INSERT INTO maintenance_requests (id, tier, archived) VALUES ($1, 0, false)",
  );
});

test("boolean positions are mapped per table, not per name", () => {
  // `position` is an ordering column everywhere; `active` is boolean in
  // option_values. Same statement shape, different answer.
  const out = squash(
    translateSql(
      "INSERT INTO option_values (id, position, active, system) VALUES (?, 1, 1, 0)",
    ),
  );
  assert.equal(
    out,
    "INSERT INTO option_values (id, position, active, system) VALUES ($1, 1, true, false)",
  );
});

test("multi-row VALUES are all rewritten", () => {
  const out = squash(
    translateSql("INSERT INTO users (id, active) VALUES (?, 1), (?, 0), (?, 1)"),
  );
  assert.equal(
    out,
    "INSERT INTO users (id, active) VALUES ($1, true), ($2, false), ($3, true)",
  );
});

test("INSERT ... SELECT rewrites the select list positionally", () => {
  const out = squash(
    translateSql(
      "INSERT INTO option_values (id, organisation_id, is_done, active) " +
        "SELECT 'v-' || s.id, ?, 0, 1 FROM option_sets s WHERE s.key = ?",
    ),
  );
  assert.ok(out.includes("SELECT 'v-' || s.id, $1, false, true FROM option_sets"), out);
});

test("an insert with no column list is left alone rather than guessed at", () => {
  const out = squash(translateSql("INSERT INTO users VALUES (?, 1)"));
  assert.equal(out, "INSERT INTO users VALUES ($1, 1)");
});

test("a comparison against a boolean column becomes true/false", () => {
  // db/init.ts:1637 and app/api/admin/users/route.ts:791.
  assert.equal(
    squash(
      translateSql(
        "SELECT id FROM maintenance_board_columns WHERE organisation_id = ? AND board_id = ? AND system = 1",
      ),
    ),
    "SELECT id FROM maintenance_board_columns WHERE organisation_id = $1 AND board_id = $2 AND system = true",
  );
  assert.equal(
    squash(translateSql("UPDATE users SET active = 0, updated_at = ? WHERE id = ?")),
    "UPDATE users SET active = false, updated_at = $1 WHERE id = $2",
  );
});

test("a qualified boolean column is matched too, and a non-boolean is not", () => {
  assert.equal(
    squash(translateSql("SELECT 1 FROM sites s WHERE s.active = 1 AND s.position = 1")),
    "SELECT 1 FROM sites s WHERE s.active = true AND s.position = 1",
  );
});

test("a 0/1 inside a string literal is never a boolean", () => {
  const sql = "UPDATE users SET full_name = 'active = 1' WHERE active = 1";
  assert.equal(
    squash(translateSql(sql)),
    "UPDATE users SET full_name = 'active = 1' WHERE active = true",
  );
});

test("the boolean name set and the per-table map agree", () => {
  const flat = Object.values(BOOLEAN_COLUMNS).flat();
  assert.equal(flat.length, 27, "the migration converted 27 columns");
  for (const name of flat) assert.ok(BOOLEAN_COLUMN_NAMES.has(name));
});

/* -------------------------------------------------------------- datetime() */

test("datetime(column) becomes a timestamptz cast", () => {
  // app/api/updates/route.ts:161, via drizzle's sql`` template.
  assert.equal(
    squash(translateSql('SELECT * FROM item_updates ORDER BY datetime("created_at") DESC')),
    'SELECT * FROM item_updates ORDER BY ("created_at")::timestamptz DESC',
  );
});

test("datetime('now') becomes now()", () => {
  assert.equal(
    squash(translateSql("UPDATE t SET updated_at = datetime('now') WHERE id = ?")),
    "UPDATE t SET updated_at = now() WHERE id = $1",
  );
});

test("datetime() with a modifier is refused rather than approximated", () => {
  assert.throws(
    () => translateSql("SELECT datetime('now', '-30 days')"),
    /modifiers are not translated/,
  );
});

/* ------------------------------------------------------------- identifiers */

test("backtick and bracket identifiers become double-quoted", () => {
  assert.equal(
    squash(translateSql("SELECT `id`, [full name] FROM `users` WHERE `id` = ?")),
    'SELECT "id", "full name" FROM "users" WHERE "id" = $1',
  );
});

test("a backtick inside a string literal is left alone", () => {
  assert.equal(
    squash(translateSql("SELECT id FROM users WHERE full_name = '`odd`' AND id = ?")),
    "SELECT id FROM users WHERE full_name = '`odd`' AND id = $1",
  );
});

/* ------------------------------------------------ AUTOINCREMENT and rowid */

test("INTEGER PRIMARY KEY AUTOINCREMENT becomes BIGSERIAL PRIMARY KEY", () => {
  assert.equal(
    squash(
      translateSql("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)"),
    ),
    "CREATE TABLE IF NOT EXISTS t (id BIGSERIAL PRIMARY KEY, a TEXT)",
  );
});

test("rowid and last_insert_rowid() are refused, not silently zeroed", () => {
  assert.throws(() => translateSql("SELECT rowid FROM users"), /rowid/);
  assert.throws(() => translateSql("SELECT last_insert_rowid()"), /rowid/);
});

test("a string containing the word rowid is not a use of rowid", () => {
  assert.equal(
    squash(translateSql("SELECT id FROM users WHERE full_name = 'rowid' AND id = ?")),
    "SELECT id FROM users WHERE full_name = 'rowid' AND id = $1",
  );
});

/* ------------------------------------------------------------------ PRAGMA */

test("PRAGMA table_info becomes a catalogue query with PRAGMA's own columns", () => {
  // db/init.ts:104 — the guard in front of every ALTER TABLE ADD COLUMN.
  const out = translateSql("PRAGMA table_info(maintenance_requests)");
  assert.match(out, /to_regclass\('maintenance_requests'\)/);
  for (const column of ["cid", "name", "type", "notnull", "dflt_value", "pk"]) {
    assert.match(out, new RegExp(`AS ${column}\\b`));
  }
});

test("PRAGMA table_info accepts a quoted table name", () => {
  assert.match(
    translateSql('PRAGMA table_info("maintenance_requests")'),
    /to_regclass\('maintenance_requests'\)/,
  );
});

test("any other PRAGMA is refused by name", () => {
  assert.throws(() => translateSql("PRAGMA foreign_keys = ON"), /foreign_keys/);
});

test("a table name that is not an identifier is refused", () => {
  assert.throws(
    () => translateSql("PRAGMA table_info(users; DROP TABLE users)"),
    /plain table name/,
  );
});

/* -------------------------------------------------------------- functions */

test("ifnull, instr and group_concat are translated", () => {
  assert.equal(
    squash(translateSql("SELECT ifnull(a, '') FROM t")),
    "SELECT coalesce(a, '') FROM t",
  );
  assert.equal(
    squash(translateSql("SELECT instr(title, 'x') FROM t")),
    "SELECT strpos(title, 'x') FROM t",
  );
  assert.equal(
    squash(translateSql("SELECT group_concat(name) FROM t")),
    "SELECT string_agg((name)::text, ',') FROM t",
  );
  assert.equal(
    squash(translateSql("SELECT group_concat(name, '; ') FROM t")),
    "SELECT string_agg((name)::text, '; ') FROM t",
  );
});

test("functions with no equivalent are refused by name", () => {
  for (const [sql, needle] of [
    ["SELECT strftime('%Y', created_at) FROM t", /strftime/],
    ["SELECT julianday(created_at) FROM t", /julianday/],
    ["SELECT json_extract(settings, '$.a') FROM t", /json_extract/],
  ]) {
    assert.throws(() => translateSql(sql), needle);
  }
});

/* -------------------------------------------------------------------- DDL */

test("a TEXT column defaulting to CURRENT_TIMESTAMP keeps SQLite's format", () => {
  // db/init.ts declares every timestamp this way; Postgres refuses a
  // timestamptz default on a text column outright.
  const out = squash(
    translateSql(
      "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    ),
  );
  assert.ok(
    out.includes("to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')"),
    out,
  );
});

test("CURRENT_TIMESTAMP outside DDL is left exactly as it is", () => {
  // 207 uses across the app, and every one of them is valid Postgres already.
  assert.equal(
    squash(translateSql("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")),
    "UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1",
  );
});

/* --------------------------------------------------------------- the mask */

test("the mask preserves length, which is what makes offsets transferable", () => {
  const sql = "SELECT 'a?b' /* ? */ , `x?` FROM t -- ?\n WHERE a = ?";
  assert.equal(maskNonCode(sql).length, sql.length);
});

test("the mask blanks literals, comments and quoted identifiers only", () => {
  const mask = maskNonCode("SELECT 'x' FROM t -- c\nWHERE a = ?");
  assert.ok(!mask.includes("x"));
  assert.ok(!mask.includes("c"));
  assert.ok(mask.includes("SELECT"));
  assert.ok(mask.includes("?"));
});

/* --------------------------------------------------- drizzle's own output */

test("what drizzle's sqlite dialect emits passes through intact", () => {
  // Double-quoted identifiers, ? placeholders, and nothing else SQLite-specific
  // — which is why the 900-odd drizzle call sites needed no rules of their own.
  const sql =
    'select "id", "organisation_id", "created_at" from "maintenance_requests" ' +
    'where ("maintenance_requests"."organisation_id" = ? and "maintenance_requests"."deleted_at" is null) ' +
    'order by "maintenance_requests"."created_at" desc limit ?';
  assert.equal(
    translateSql(sql),
    sql.replace("= ?", "= $1").replace("limit ?", "limit $2"),
  );
});

test("drizzle's own on conflict clause is not touched", () => {
  const sql =
    'insert into "sessions" ("id", "token_hash") values (?, ?) on conflict do nothing';
  assert.equal(
    translateSql(sql),
    'insert into "sessions" ("id", "token_hash") values ($1, $2) on conflict do nothing',
  );
});
