import { defineConfig } from "drizzle-kit";

/*
 * Postgres (Supabase).
 *
 * `out` moved to ./drizzle/pg so the old SQLite migrations stay on disk as a
 * record of how the D1 database was built. They are not replayable against
 * Postgres and must never be run there.
 *
 * Generate with `npm run db:generate`, apply with `npm run db:migrate`.
 * Migrations run from a developer machine against the DIRECT connection
 * (port 5432), never from a Worker and never through the pooler.
 */
export default defineConfig({
  out: "./drizzle/pg",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL ?? "",
  },
});
