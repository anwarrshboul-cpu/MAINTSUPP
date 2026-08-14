import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.ts";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/**
 * Applies every `.sql` file in ../migrations, in filename order, once.
 *
 * Each file runs inside a transaction together with the row that records it,
 * so a migration that fails half way leaves nothing behind — no partially
 * applied schema, and no ledger entry claiming it succeeded.
 *
 * The checksum is not decoration. Editing an already-applied migration is the
 * single most common way a developer's database and production drift apart:
 * the file looks right in the repository and the deployed schema never had the
 * change. This refuses to start instead.
 */
export async function migrate(
  db: Db,
  options: { silent?: boolean } = {},
): Promise<{ applied: string[]; skipped: number }> {
  const log = options.silent ? () => {} : console.log;

  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);

  const existing = new Map(
    (
      await db.query<{ name: string; checksum: string }>(
        "select name, checksum from schema_migrations",
      )
    ).map((row) => [row.name, row.checksum]),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  let skipped = 0;

  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    const previous = existing.get(name);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${name} has changed since it was applied ` +
            `(recorded ${previous}, file ${checksum}). Migrations are ` +
            `immutable — add a new one instead of editing this.`,
        );
      }
      skipped += 1;
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        "insert into schema_migrations (name, checksum) values ($1, $2)",
        [name, checksum],
      );
    });

    applied.push(name);
    log(`  applied  ${name}`);
  }

  return { applied, skipped };
}

/* Run directly: `node packages/db/src/migrate.ts` */
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { getDb } = await import("./client.ts");
  const db = await getDb();
  console.log(`migrating (${db.backend})…`);
  const { applied, skipped } = await migrate(db);
  console.log(
    applied.length
      ? `${applied.length} applied, ${skipped} already current.`
      : `nothing to do — ${skipped} migrations already current.`,
  );
  await db.close();
}
