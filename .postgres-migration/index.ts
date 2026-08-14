import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Postgres connection — Supabase.
 *
 * Converted from Cloudflare D1. Three things here are load-bearing:
 *
 * `prepare: false` is REQUIRED. Supabase's transaction pooler (Supavisor, port
 * 6543) hands each statement to whichever backend connection is free, so a
 * prepared statement created on one connection is not there when the next
 * statement runs. Leaving prepared statements on produces "prepared statement
 * already exists" under concurrency — intermittently, and only under load,
 * which is the worst way to find out.
 *
 * `max: 1` because the pooler is already the pool. A client-side pool behind a
 * server-side pool multiplies connections rather than reusing them, and
 * Supabase's connection ceiling is the first limit you meet.
 *
 * USE THE POOLER URL, NOT THE DIRECT ONE. Supabase gives you both:
 *   pooler  postgresql://…@aws-0-<region>.pooler.supabase.com:6543/postgres
 *   direct  postgresql://…@db.<ref>.supabase.co:5432/postgres
 * The direct connection is for running migrations from your own machine. The
 * app must use the pooler — serverless request patterns exhaust direct
 * connections quickly.
 */

let client: ReturnType<typeof postgres> | null = null;

function connectionString() {
  const fromGlobal = (globalThis as { DATABASE_URL?: string }).DATABASE_URL;
  const fromProcess =
    typeof process !== "undefined" ? process.env?.DATABASE_URL : undefined;
  const url = fromGlobal ?? fromProcess;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Supabase transaction pooler " +
        "(port 6543), not the direct connection — see the comment in db/index.ts.",
    );
  }
  return url;
}

/**
 * The raw postgres.js client, for the places that still speak SQL directly.
 *
 * Named `getSql` rather than the old `getD1` on purpose: it is not a D1 handle,
 * and any code still calling `.prepare().bind().all()` will fail to compile
 * against it instead of failing at runtime in production.
 */
export async function getSql() {
  if (!client) {
    client = postgres(connectionString(), {
      prepare: false,
      max: 1,
      // A hung connection should fail the request, not pin a worker open.
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return client;
}

export async function getDb() {
  return drizzle(await getSql(), { schema });
}
