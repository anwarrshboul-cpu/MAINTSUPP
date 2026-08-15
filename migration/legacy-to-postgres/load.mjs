#!/usr/bin/env node
/**
 * Copy every row from the legacy SQLite database into `portal`.
 *
 *   node migration/legacy-to-postgres/load.mjs /path/to/legacy-src.sqlite
 *
 * Properties this script is built to have, and why each one matters:
 *
 * STREAMING. Rows are pulled through `StatementSync.iterate()` and pushed in
 * fixed-size batches. Nothing ever holds a whole table in memory, so the peak
 * footprint is one batch (a few hundred rows) regardless of how large the
 * source file grows. The current file is 19MB, but attachment metadata and
 * audit trails only ever accumulate, and a loader that works by
 * `SELECT *`-ing 3.5GB into an array is a loader that works right up until it
 * doesn't.
 *
 * IDEMPOTENT. Every insert carries `on conflict do nothing`, which is the
 * Postgres spelling of the legacy application's `INSERT OR IGNORE` (29 of
 * those exist in db/init.ts and the seed scripts). Re-running this after a
 * partial failure resumes rather than duplicating, and re-running it after a
 * complete success is a no-op. Note the deliberate consequence: rows that
 * already exist are NOT updated. This is a one-way port, not a sync — if the
 * legacy database has moved on and you need those changes, truncate `portal`
 * and load again.
 *
 * FOREIGN-KEY SAFE. Tables are visited in an order derived from SQLite's own
 * foreign-key graph (see lib/plan.mjs), so a child is never inserted before
 * its parent. No constraints are dropped or deferred to make the load work.
 *
 * LOUD. Conversion failures throw with the table, column and offending value
 * rather than substituting NULL. A migration that silently drops what it does
 * not understand still produces matching row counts, which is the worst
 * possible outcome.
 *
 * NOT IN SCOPE: file bytes. `attachments` rows are metadata only — the objects
 * themselves live in R2, keyed by `object_key`. Nothing binary moves here.
 */

import {
  connect,
  loadOrder,
  openSqlite,
  portalColumnTypes,
  sqliteColumns,
  sqlitePath,
  sqliteTables,
  TARGET_SCHEMA,
} from "./lib/plan.mjs";
import { convert } from "./lib/convert.mjs";

/**
 * Postgres caps a single statement at 65,535 bind parameters. Batch size is
 * therefore computed per table from its column count rather than fixed, so a
 * wide table like maintenance_requests (53 columns) does not blow the limit
 * that a narrow one would never approach. The 1,000-row ceiling keeps memory
 * and statement size sane for very narrow tables.
 */
function batchSizeFor(columnCount) {
  return Math.max(1, Math.min(1000, Math.floor(60000 / columnCount)));
}

const quote = (ident) => `"${ident.replace(/"/g, '""')}"`;

async function insertBatch(sql, table, columns, rows) {
  if (rows.length === 0) return 0;
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders.join(",")})`;
  });
  const text =
    `insert into ${TARGET_SCHEMA}.${quote(table)} ` +
    `(${columns.map(quote).join(",")}) values ${tuples.join(",")} ` +
    `on conflict do nothing`;
  const result = await sql.unsafe(text, params);
  // postgres.js reports rows actually written; with `do nothing` this is lower
  // than rows offered whenever the row was already present.
  return result.count ?? 0;
}

async function main() {
  const path = sqlitePath(process.argv.slice(2));
  console.log(`Source : ${path}`);

  const db = openSqlite(path);
  const tables = sqliteTables(db);
  const order = loadOrder(db, tables);
  console.log(`Tables : ${tables.length} (load order derived from FK graph)\n`);

  const sql = connect();
  const truncations = [];
  let grandTotalOffered = 0;
  let grandTotalWritten = 0;

  try {
    const pgTypes = await portalColumnTypes(sql);

    // Fail before writing anything if the schema is not fully in place —
    // a half-applied DDL would otherwise show up as a confusing error on
    // whichever table happened to be missing.
    const missing = order.filter((t) => !pgTypes.has(t));
    if (missing.length)
      throw new Error(
        `${TARGET_SCHEMA} is missing ${missing.length} table(s): ` +
          `${missing.join(", ")}. Run migrate.mjs first.`,
      );

    for (const table of order) {
      const cols = sqliteColumns(db, table);
      const names = cols.map((c) => c.name);
      const types = pgTypes.get(table);

      // A column present in SQLite but absent from portal would silently drop
      // data, so check rather than trusting the DDL to be complete.
      const unknown = names.filter((n) => !types.has(n));
      if (unknown.length)
        throw new Error(
          `${table}: columns missing from ${TARGET_SCHEMA}: ${unknown.join(", ")}`,
        );

      const batchSize = batchSizeFor(names.length);
      const statement = db.prepare(`select * from "${table}"`);

      let offered = 0;
      let written = 0;
      let batch = [];

      const flush = async () => {
        written += await insertBatch(sql, table, names, batch);
        batch = [];
      };

      for (const row of statement.iterate()) {
        batch.push(
          names.map((n) =>
            convert(row[n], types.get(n), `${table}.${n}`, (where, value) =>
              truncations.push(`${where}: ${value}`),
            ),
          ),
        );
        offered++;
        if (batch.length >= batchSize) await flush();
      }
      await flush();

      grandTotalOffered += offered;
      grandTotalWritten += written;
      const skipped = offered - written;
      console.log(
        `${table.padEnd(28)} read ${String(offered).padStart(6)}  ` +
          `inserted ${String(written).padStart(6)}` +
          (skipped > 0 ? `  (${skipped} already present)` : ""),
      );
    }

    console.log(
      `\nRead ${grandTotalOffered} rows, inserted ${grandTotalWritten}.`,
    );
    if (truncations.length)
      console.log(
        `\nWARNING: ${truncations.length} value(s) truncated to a date:\n  ` +
          truncations.slice(0, 20).join("\n  "),
      );
  } finally {
    await sql.end();
    db.close();
  }
}

main().catch((err) => {
  console.error(`\nLOAD FAILED: ${err.message}`);
  process.exit(1);
});
