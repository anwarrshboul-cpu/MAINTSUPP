/**
 * Runs the emitted rehearsal SQL against Staging, in order, with a checkpoint.
 *
 *   STAGING_DATABASE_URL=... node db/monday-export/run-rehearsal-sql.mjs \
 *     --sql D:/MAINTSUPP-Monday-Export/full-2026-09-09/rehearsal-sql \
 *     --org org_000000000000000000000003
 *
 *   --pool N    max connections   (default 2, matching what the app runs)
 *   --from NAME resume at a file  (default: the checkpoint, else the start)
 *   --dry-run   list what would run
 *
 * Files are numbered and run in that order: jobs reference sites, cells and
 * group placements are derived from jobs, compliance references attachments.
 * Every statement is an upsert keyed on an id derived from the monday id, so a
 * re-run reconciles rather than duplicating and an interrupted run resumes.
 *
 * SAFETY. Refuses the Sunnamusk and Demo organisation ids, refuses a
 * transaction-pooler URL, and refuses an organisation whose name does not read
 * as a rehearsal tenant — the same three guards the importer applies.
 */

import postgres from "postgres";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PROTECTED_ORGS = new Set([
  "org_000000000000000000000001",
  "org_000000000000000000000002",
]);

function parseArgs(argv) {
  const args = { pool: 2, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === "--sql") args.sql = next();
    else if (flag === "--org") args.org = next();
    else if (flag === "--pool") args.pool = Number(next());
    else if (flag === "--from") args.from = next();
    else if (flag === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.sql) throw new Error("--sql is required");
  if (!args.org) throw new Error("--org is required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (PROTECTED_ORGS.has(args.org)) throw new Error(`refusing to write to ${args.org}`);

  const files = readdirSync(args.sql).filter((f) => f.endsWith(".sql")).sort();
  const checkpointFile = path.join(args.sql, ".run-checkpoint.json");
  const done = existsSync(checkpointFile)
    ? new Set(JSON.parse(readFileSync(checkpointFile, "utf8")).done ?? [])
    : new Set();

  const todo = files.filter((f) => !done.has(f) && (!args.from || f >= args.from));
  console.log(`${files.length} files, ${done.size} already applied, ${todo.length} to run`);
  if (args.dryRun) {
    for (const file of todo) console.log(`  would run ${file}`);
    return;
  }

  const url = process.env.STAGING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("STAGING_DATABASE_URL is not set");
  if (/:6543\//.test(url)) throw new Error("refusing port 6543; use the session pooler on 5432");

  const sql = postgres(url, { max: args.pool, idle_timeout: 20, connect_timeout: 30, onnotice: () => {} });
  try {
    const [org] = await sql`select id, name, slug from portal.organisations where id = ${args.org}`;
    if (!org) throw new Error(`organisation ${args.org} does not exist`);
    if (!/rehearsal/i.test(org.name) && !/rehearsal/i.test(org.slug)) {
      throw new Error(`${org.name} does not read as a rehearsal tenant; refusing`);
    }
    console.log(`target: ${org.name} (${org.id})\n`);

    for (const file of todo) {
      const statement = readFileSync(path.join(args.sql, file), "utf8");
      const started = Date.now();
      // One transaction per file: a file is one logical step, and half of an
      // attachment chunk applied is harder to reason about than none of it.
      await sql.begin(async (tx) => { await tx.unsafe(statement); });
      done.add(file);
      writeFileSync(checkpointFile, `${JSON.stringify({ done: [...done] }, null, 2)}\n`);
      console.log(`  ${file.padEnd(28)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    const [counts] = await sql`
      select (select count(*) from portal.maintenance_requests where organisation_id = ${args.org}) as jobs,
             (select count(*) from portal.sites where organisation_id = ${args.org}) as sites,
             (select count(*) from portal.item_updates where organisation_id = ${args.org}) as updates,
             (select count(*) from portal.attachments where organisation_id = ${args.org}) as attachments,
             (select count(*) from portal.compliance_documents where organisation_id = ${args.org}) as compliance,
             (select count(*) from portal.import_anomalies where organisation_id = ${args.org}) as anomalies`;
    console.log(`\napplied. ${JSON.stringify(counts)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
