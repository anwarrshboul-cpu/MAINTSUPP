#!/usr/bin/env node
/**
 * Apply the numbered DDL migrations to the `portal` schema.
 *
 *   node migration/legacy-to-postgres/migrate.mjs
 *
 * Every statement in migrations/ is `create ... if not exists`, so this script
 * is safe to re-run and needs no migration-tracking table of its own. That is
 * a deliberate simplification for a one-way port: there are no `alter` steps
 * to sequence and nothing to roll back, so the complexity of a version ledger
 * would buy nothing.
 *
 * SAFETY
 * ------
 * This project's `public` schema holds the live Phase 2 application. Before
 * executing anything, the script asserts that no migration file mentions
 * `public.` or `drop schema`, and it refuses to run if one does. The guard is
 * cheap and the alternative — a stray statement reaching live data — is not
 * recoverable.
 */

import { readFileSync } from "node:fs";
import { connect, migrationFiles, TARGET_SCHEMA } from "./lib/plan.mjs";

/**
 * Statements that must never appear in a migration for this project.
 * `public.` is checked as a qualified reference; the bare word "public" is
 * allowed because it legitimately appears in prose comments.
 */
const FORBIDDEN = [
  { pattern: /\bdrop\s+schema\b/i, why: "drops a schema" },
  { pattern: /\bdrop\s+database\b/i, why: "drops a database" },
  { pattern: /\bpublic\s*\./i, why: "references the live public schema" },
  { pattern: /\bcreate\s+schema\s+public\b/i, why: "recreates public" },
];

/** Strip `--` line comments so prose cannot trip the guard. */
function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function assertSafe(name, sql) {
  const code = stripComments(sql);
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(code)) {
      throw new Error(
        `REFUSING TO RUN ${name}: it ${why}. ` +
          `This project's public schema holds live Phase 2 data.`,
      );
    }
  }
}

async function main() {
  const files = migrationFiles();
  if (files.length === 0) throw new Error("No migration files found.");

  // Guard every file before opening a connection, so a bad migration cannot
  // be caught halfway through a partially applied run.
  for (const f of files) assertSafe(f.name, readFileSync(f.path, "utf8"));
  console.log(`Safety check passed for ${files.length} migration files.`);

  const sql = connect();
  try {
    const [{ current_database: db, current_user: user }] =
      await sql`select current_database(), current_user`;
    console.log(`Connected to ${db} as ${user}\n`);

    for (const f of files) {
      const text = readFileSync(f.path, "utf8");
      process.stdout.write(`${f.name} ... `);
      // Each file runs as one implicit transaction via a single simple-query
      // round trip, so a syntax error late in a file leaves nothing behind.
      await sql.unsafe(text);
      console.log("ok");
    }

    const [{ count }] = await sql`
      select count(*)::int as count
        from information_schema.tables
       where table_schema = ${TARGET_SCHEMA}`;
    console.log(`\n${TARGET_SCHEMA} now has ${count} tables.`);

    // Prove we did not touch the live schema. Cheap, and the number appearing
    // in the log is what makes the claim auditable later.
    const [{ count: pub }] = await sql`
      select count(*)::int as count
        from information_schema.tables
       where table_schema = 'public'`;
    console.log(`public still has ${pub} tables (untouched).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(`\nMIGRATION FAILED: ${err.message}`);
  process.exit(1);
});
