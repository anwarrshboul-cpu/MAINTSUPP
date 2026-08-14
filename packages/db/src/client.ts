/**
 * One database interface, two backends.
 *
 * Local development runs PGlite — real PostgreSQL 18 compiled to WASM, in
 * process, no Docker and no daemon to keep alive. Staging and production run
 * hosted Postgres (Supabase) over the wire. The SQL is identical either way,
 * which is the whole point: a query that works locally works deployed, and the
 * migrations in ../migrations are the single definition of the schema.
 *
 * Chosen by `DATABASE_URL`: set it and you get Postgres, leave it unset and you
 * get PGlite. There is no third mode and no "mock" — a fake database that
 * accepts everything is how schema bugs reach production.
 */

export type Row = Record<string, unknown>;

export interface Db {
  /** Parameterised query. `$1`, `$2` … — never string-concatenate user input. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement DDL. No parameters; used by the migration runner. */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly backend: "pglite" | "postgres";
}

/* ---------------------------------------------------------------- PGlite -- */

async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // `gen_random_bytes` for share tokens lives in pgcrypto, which PGlite ships
  // as a separate contrib module rather than in the base bundle.
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");

  /*
   * Two call shapes, and the difference is load-bearing.
   *
   * `new PGlite(undefined, { extensions })` silently discards the extensions —
   * the first parameter is overloaded (data directory *or* options), and a
   * literal `undefined` still selects the two-argument form, whose options are
   * then ignored. The failure surfaces much later as
   * `extension "pgcrypto" is not available` while running a migration, which
   * reads like a build problem rather than a call-signature one.
   */
  const pg = dataDir
    ? new PGlite(dataDir, { extensions: { pgcrypto } })
    : new PGlite({ extensions: { pgcrypto } });
  await pg.waitReady;

  const wrap = (runner: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    exec: (sql: string) => Promise<unknown>;
  }): Db => ({
    backend: "pglite",
    async query<T = Row>(sql: string, params: unknown[] = []) {
      const result = await runner.query(sql, params);
      return result.rows as T[];
    },
    async exec(sql: string) {
      await runner.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction(async (tx) => fn(wrap(tx as never))) as Promise<T>;
    },
    async close() {
      await pg.close();
    },
  });

  return wrap(pg as never);
}

/* -------------------------------------------------------------- Postgres -- */

async function postgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");

  const sql = postgres(url, {
    /*
     * Both of these are required against Supabase's transaction pooler
     * (Supavisor, port 6543) and both fail intermittently rather than loudly
     * if got wrong.
     *
     * `prepare: false` — the pooler hands each statement to whichever backend
     * connection is free, so a prepared statement created on one is not there
     * for the next. Leaving it on yields "prepared statement already exists"
     * under concurrency and never in testing.
     *
     * USE THE SESSION POOLER (port 5432), NOT TRANSACTION MODE (6543).
     * Measured against this project with 791 jobs: on 6543, five concurrent
     * analytics requests left `/analytics/jobs` and `/contractors` hanging
     * indefinitely, and `pg_stat_activity` showed every connection `idle` on
     * `ClientRead` — Postgres waiting for the client while the client waited
     * for Postgres. Nothing was slow; it deadlocked. The same code on 5432
     * answers all five in under 0.7s and `/analytics/overview` in 0.16s.
     */
    prepare: false,

    /*
     * A small pool, even behind the pooler.
     *
     * This was `max: 1` on the reasoning that "the pooler is already the pool".
     * That is right for a DIRECT connection, where every client connection is a
     * real Postgres backend and a client-side pool multiplies them. It is wrong
     * for the transaction pooler, whose entire job is to multiplex many client
     * connections onto few server ones.
     *
     * With one connection, a single slow query holds it and every other request
     * queues behind it: measured here as `/health` answering in 1ms while
     * `/ready` timed out at 20s, because one analytics query over 791 jobs had
     * the connection. On Railway that is the whole API stalling on one report.
     *
     * `statement_timeout` is the other half. Without it a query that never
     * finishes never releases its connection, and the pool degrades one slot at
     * a time until the service is down with no error anywhere.
     */
    max: 10,
    idle_timeout: 20,
    connect_timeout: 15,
    connection: { statement_timeout: 30_000 },

    /*
     * TLS, for anything that is not a local socket.
     *
     * Supabase refuses an unencrypted connection, and postgres.js defaults SSL
     * OFF — so without this the pooler rejects the handshake and reports
     * `28P01 password authentication failed`, which sends you hunting for a
     * wrong password that is in fact correct. It cost an hour here; it would
     * have cost the same on the first Railway deploy.
     *
     * `require` encrypts but does not verify the server certificate. Supabase
     * terminates TLS at the pooler with a certificate chain Node does not
     * carry by default, so `verify-full` needs their CA bundle pinned — worth
     * doing, and a different change from making the connection work at all.
     */
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
  });

  const wrap = (runner: typeof sql): Db => ({
    backend: "postgres",
    async query<T = Row>(text: string, params: unknown[] = []) {
      return runner.unsafe(text, params as never[]) as unknown as Promise<T[]>;
    },
    async exec(text: string) {
      await runner.unsafe(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return sql.begin(async (tx) => fn(wrap(tx as never))) as Promise<T>;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  });

  return wrap(sql);
}

/* ----------------------------------------------------------------- entry -- */

let singleton: Promise<Db> | undefined;

/**
 * The process-wide database handle.
 *
 * Memoised because both backends hold real resources — a WASM instance or a
 * connection pool — and building a second one per request is the standard way
 * to exhaust a database's connection limit under load.
 */
export function getDb(): Promise<Db> {
  if (!singleton) singleton = createDb();
  return singleton;
}

export function createDb(
  url = process.env.DATABASE_URL,
  pgliteDir = process.env.PGLITE_DIR,
): Promise<Db> {
  if (url?.trim()) return postgresDb(url.trim());
  // `undefined` means in-memory, which is what the tests want; a path gives a
  // local database that survives a restart, which is what `npm run dev` wants.
  return pgliteDb(pgliteDir?.trim() || undefined);
}

/** For tests: a fresh in-memory database, migrated and ready. */
export async function createTestDb(): Promise<Db> {
  const db = await pgliteDb(undefined);
  const { migrate } = await import("./migrate.ts");
  await migrate(db, { silent: true });
  return db;
}
