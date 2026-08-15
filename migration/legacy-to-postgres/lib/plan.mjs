/**
 * Shared plumbing for the three scripts: how to reach each database, which
 * tables exist, and what order they have to be touched in.
 *
 * The guiding rule here is that nothing re-states a decision that is already
 * written down somewhere authoritative. The load order is derived from
 * SQLite's own foreign-key graph rather than hand-listed, and the column types
 * are read back out of Postgres rather than duplicated from the migration
 * files. Both of those are things that would otherwise drift the moment
 * someone edited the DDL and forgot to edit a matching array in here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");
export const TARGET_SCHEMA = "portal";

/**
 * `_cf_METADATA` is Cloudflare D1's own bookkeeping table — a single row of
 * BLOB holding the internal schema version. It is not application data, it is
 * the only table in the file containing a BLOB, and it has no meaning outside
 * D1. It is excluded everywhere, which is why this migration deals with 48
 * tables while `sqlite_master` reports 49.
 */
export const EXCLUDED_TABLES = new Set(["_cf_METADATA"]);

/* ------------------------------------------------------------------ SQLite */

export function openSqlite(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export function sqliteTables(db) {
  return db
    .prepare(
      `select name from sqlite_master
        where type = 'table' and name not like 'sqlite_%'
        order by name`,
    )
    .all()
    .map((r) => r.name)
    .filter((n) => !EXCLUDED_TABLES.has(n));
}

export function sqliteColumns(db, table) {
  return db.prepare(`pragma table_info('${table}')`).all();
}

/**
 * Load order, derived rather than declared.
 *
 * A table may only be loaded once every table it references already holds its
 * rows, or the foreign keys created in the migrations will reject the insert.
 * Rather than maintain a hand-written list of 48 names in dependency order —
 * which is wrong the first time anyone adds a table — this walks SQLite's own
 * `foreign_key_list` and topologically sorts it.
 *
 * Self-references (maintenance_requests.parent_id would be one, if it carried
 * a constraint) are ignored as edges: a table cannot wait for itself, and
 * within a single table the loader inserts parents and children in one batch
 * sequence anyway.
 *
 * If a genuine cycle between two tables ever appeared, this throws rather than
 * emitting an arbitrary order, because the honest fix is deferrable
 * constraints and someone needs to make that decision consciously.
 */
export function loadOrder(db, tables) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const t of tables) {
    for (const fk of db.prepare(`pragma foreign_key_list('${t}')`).all()) {
      if (fk.table === t) continue; // self-reference: not an ordering edge
      if (!deps.has(fk.table)) continue; // points at an excluded table
      deps.get(t).add(fk.table);
    }
  }

  const ordered = [];
  const done = new Set();
  // Deterministic output: walk the alphabetical list repeatedly, emitting any
  // table whose dependencies are already satisfied.
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every((d) => done.has(d))) {
        ordered.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  if (ordered.length !== tables.length) {
    const stuck = tables.filter((t) => !done.has(t));
    throw new Error(
      `Foreign-key cycle involving: ${stuck.join(", ")}. ` +
        `Resolve with deferrable constraints before loading.`,
    );
  }
  return ordered;
}

/* -------------------------------------------------------------- PostgreSQL */

/**
 * DATABASE_URL comes from .dev.vars, which is the same file the application
 * reads. It points at the Supabase SESSION pooler on port 5432 — deliberately
 * not the transaction pooler on 6543, which per the comment in
 * packages/db/src/client.ts deadlocks this workload. Nothing here rewrites the
 * port.
 */
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const devVars = join(ROOT, "..", "..", ".dev.vars");
  const text = readFileSync(devVars, "utf8");
  const line = text.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error(`No DATABASE_URL in ${devVars}`);
  return line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

export function connect() {
  return postgres(databaseUrl(), {
    ssl: "require",
    // One connection, and no prepared-statement caching. The session pooler
    // multiplexes, and a large `max` here buys nothing for a single-threaded
    // sequential loader while making a stuck migration harder to reason about.
    max: 1,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 30,
    // Timestamps are handed over as ISO-8601 strings that already carry an
    // explicit UTC offset, so no client-side date parsing is wanted.
    types: {},
    onnotice: () => {},
  });
}

/**
 * The Postgres column types, read back from the live database.
 *
 * The loader converts each SQLite value according to the type the column
 * *actually* has in `portal`, not according to a second copy of the mapping
 * table. If the DDL says `date` and this said `timestamptz`, the load would
 * fail confusingly; reading the truth from information_schema makes that
 * disagreement impossible.
 */
export async function portalColumnTypes(sql) {
  const rows = await sql`
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = ${TARGET_SCHEMA}
     order by table_name, ordinal_position`;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Map());
    map.get(r.table_name).set(r.column_name, r.data_type);
  }
  return map;
}

/** The numbered .sql files, in order. */
export function migrationFiles() {
  const dir = join(ROOT, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f) }));
}

/** Locate the SQLite copy: explicit argument, env var, or the documented path. */
export function sqlitePath(argv) {
  const fromArg = argv.find((a) => a.endsWith(".sqlite"));
  return fromArg || process.env.LEGACY_SQLITE || join(ROOT, "legacy-src.sqlite");
}
