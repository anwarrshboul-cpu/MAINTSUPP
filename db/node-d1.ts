/**
 * A D1 database that is really a SQLite file on a plain Node process.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Every database call in this app goes through `getD1()`, which reaches for the
 * `DB` binding on `cloudflare:workers`. That module is a Workers-runtime
 * virtual module: it exists inside workerd and nowhere else. Run the same build
 * on Node — which is what a Railway deployment is — and the import throws, the
 * route catches it, and the board answers 503 "temporarily unavailable" while
 * the data sits untouched in a 20MB SQLite file on disk.
 *
 * The data was never the problem. D1 *is* SQLite, and the local database the
 * app has been developed against is an ordinary SQLite file written by
 * Miniflare. So the port is not a rewrite of 48 tables' worth of queries onto
 * another engine; it is one object that answers the handful of methods D1
 * exposes, backed by `node:sqlite`. Drizzle's d1 driver, `db/init.ts`'s
 * bootstrap batches and the raw `.prepare().bind().run()` calls in the auth
 * paths all keep working unchanged, because they cannot tell the difference.
 *
 * `node:sqlite` and not `better-sqlite3` deliberately: it ships inside Node,
 * so there is no native module to compile in a Railway build image and no new
 * dependency to keep in step with a Node upgrade. It needs Node 22.5+ (behind
 * `--experimental-sqlite`) or Node 23.4+ / 24 unflagged — see the error thrown
 * by `sqliteModule()` below, which is what an under-specified runtime will hit.
 *
 * ---------------------------------------------------------------------------
 * What "D1-compatible" means here
 * ---------------------------------------------------------------------------
 * The surface is what real callers in this repo actually use, verified against
 * `node_modules/drizzle-orm/d1/session.js` rather than guessed:
 *
 *   db.prepare(sql) → stmt          stmt.bind(...) → a NEW stmt
 *   stmt.all() → { results, success, meta }        stmt.raw() → row arrays
 *   stmt.run() → { results, success, meta }        stmt.first() → row | value
 *   db.batch([stmt, …]) → one result per statement, in one transaction
 *   db.exec(sql) → { count, duration }
 *
 * Two of those shapes are load-bearing and were the reason for reading the
 * driver first. `bind()` must return a new statement and leave the original
 * alone, because drizzle prepares once and binds per execution — a mutating
 * bind would leak one request's parameters into the next. And `run()`'s
 * `meta.changes` must be a real row count: `consumeReset()` and the invitation
 * claim in `app/api/auth/` decide whether a single-use token was won or lost by
 * reading it, so a hardcoded 0 or 1 there would either break password resets or
 * hand the same token to two requests.
 *
 * Known, deliberate deviations from D1, none of which any caller reads:
 *   - `meta.size_after` is 0, and `rows_read`/`rows_written` are approximations.
 *     They exist for Cloudflare's billing telemetry, not for application logic.
 *   - `all()` reports `changes: 0`; `node:sqlite` only returns a change count
 *     from `run()`, which is where the app reads it.
 *   - BLOB columns come back as `Uint8Array` rather than `ArrayBuffer`. The
 *     schema in `db/schema.ts` has no blob columns, so this costs nothing and
 *     avoids walking every value of every row on every query to fix a type
 *     nothing produces.
 */

/* ----------------------------------------------------------------- node -- */

/**
 * `node:sqlite` without an import statement, on purpose.
 *
 * This module is pulled into the server bundle through a `resolve.alias` on
 * `cloudflare:workers`, and that bundle is still produced by a build whose
 * resolver is configured for workerd — a platform where `node:sqlite` does not
 * exist and where an `import` of it is a build-time failure, not a runtime one.
 * `process.getBuiltinModule` sidesteps the bundler entirely: it is a plain
 * property read that no static analysis can follow, and it is synchronous, so
 * `prepare()` can stay synchronous the way D1's is.
 */
function sqliteModule(): SqliteModule {
  const runtime = (globalThis as { process?: NodeProcessLike }).process;
  const getBuiltinModule = runtime?.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    throw new Error(
      "The Node SQLite database shim needs a Node runtime with " +
        "process.getBuiltinModule (Node 22.3+). This build is running " +
        "somewhere else.",
    );
  }
  const sqlite = getBuiltinModule.call(runtime, "node:sqlite") as
    | SqliteModule
    | undefined;
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      "node:sqlite is unavailable. It needs Node 23.4+ (or Node 22.5+ started " +
        "with --experimental-sqlite). Check the Node version on the host.",
    );
  }
  return sqlite;
}

function nodeFs(): NodeFsLike {
  const runtime = (globalThis as { process?: NodeProcessLike }).process;
  return runtime!.getBuiltinModule!.call(runtime, "node:fs") as NodeFsLike;
}

interface NodeProcessLike {
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (name: string) => unknown;
}

interface NodeFsLike {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
}

type SqliteValue = null | number | bigint | string | Uint8Array;

interface StatementSyncLike {
  all(...params: SqliteValue[]): unknown[];
  run(...params: SqliteValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  columns(): Array<{ name: string }>;
  setReturnArrays(returnArrays: boolean): void;
}

interface DatabaseSyncLike {
  prepare(sql: string): StatementSyncLike;
  exec(sql: string): void;
  close(): void;
  readonly isTransaction: boolean;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
}

/* -------------------------------------------------------------- the path -- */

/**
 * Where Miniflare keeps the local D1 database.
 *
 * The filename is the hash of the `database_id` in `vite.config.ts`, so it is
 * stable for this project but meaningless to read. The directory is scanned
 * rather than the name hardcoded, so that changing the database id — or
 * restoring a backup under a different id — does not leave a Railway container
 * silently pointed at a file that no longer exists.
 */
const MINIFLARE_D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

/**
 * Miniflare's own bookkeeping database, which lives in the same directory and
 * is not the application's data.
 */
const MINIFLARE_METADATA_FILE = "metadata.sqlite";

/**
 * Resolves the SQLite file this process should open.
 *
 * `D1_SQLITE_PATH` wins and is how Railway points the app at a mounted volume,
 * which is nowhere near a `.wrangler` directory. It may name the file or the
 * directory holding it, because "the volume is mounted at /data" is the thing
 * an operator actually knows.
 *
 * With nothing set, the local Miniflare directory is scanned. Exactly one
 * candidate is a database; zero or several is an error rather than a guess,
 * because the failure mode of guessing here is an app that boots happily
 * against an empty file and reports that the client has no jobs.
 */
function resolveSqlitePath(): string {
  const fs = nodeFs();
  const configured = (globalThis as { process?: NodeProcessLike }).process?.env
    ?.["D1_SQLITE_PATH"];

  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(
        `D1_SQLITE_PATH points at ${configured}, which does not exist.`,
      );
    }
    if (!fs.statSync(configured).isDirectory()) return configured;
    return soleDatabaseIn(fs, configured, "D1_SQLITE_PATH");
  }

  if (!fs.existsSync(MINIFLARE_D1_DIR)) {
    throw new Error(
      `No local D1 database directory at ${MINIFLARE_D1_DIR} (looked from ` +
        `${(globalThis as { process?: NodeProcessLike }).process?.cwd?.() ?? "?"}). ` +
        "Set D1_SQLITE_PATH to the SQLite file this deployment should use.",
    );
  }
  return soleDatabaseIn(fs, MINIFLARE_D1_DIR, "the local Miniflare state");
}

function soleDatabaseIn(fs: NodeFsLike, dir: string, label: string): string {
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== MINIFLARE_METADATA_FILE)
    .sort();

  if (candidates.length === 1) return `${dir}/${candidates[0]}`;
  if (candidates.length === 0) {
    throw new Error(`No .sqlite file in ${dir} (${label}).`);
  }
  throw new Error(
    `${candidates.length} .sqlite files in ${dir} (${label}): ` +
      `${candidates.join(", ")}. Set D1_SQLITE_PATH to the one to open.`,
  );
}

/* --------------------------------------------------------------- values -- */

/**
 * Converts a bound parameter into something SQLite will accept.
 *
 * Booleans and `undefined` are converted because D1 accepts them and
 * `node:sqlite` throws on both — drizzle emits `undefined` for an omitted
 * optional column often enough that letting it through would turn a routine
 * insert into a 500.
 *
 * A plain object is rejected loudly, and that is the important case: passing an
 * object as the first parameter to `node:sqlite` does not fail, it is
 * interpreted as a map of NAMED parameters. A drizzle query that accidentally
 * bound an object would silently bind nothing at all and return the wrong rows
 * rather than an error, which is the worst outcome available here.
 */
function toBoundValue(value: unknown, index: number): SqliteValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(
    `D1_ERROR: parameter ${index + 1} is a ${typeof value} that SQLite cannot ` +
      "bind. Serialise it before binding.",
  );
}

/**
 * `node:sqlite` hands back null-prototype objects. D1 hands back ordinary ones,
 * and application code spreads these rows, passes them through `JSON.stringify`
 * and hands them to React, so the difference is worth one shallow copy.
 */
function toPlainRow(row: unknown): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

/* ------------------------------------------------------------- the shim -- */

interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
  served_by: string;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: D1Meta;
}

function meta(overrides: Partial<D1Meta>): D1Meta {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    served_by: "node-sqlite",
    ...overrides,
  };
}

/**
 * One SQLite connection, plus the compiled statements it has been asked for.
 *
 * Compilation is deferred until execution, which is not an optimisation — it is
 * required for correctness. `db/init.ts` builds batches like
 * `[CREATE TABLE units …, CREATE INDEX … ON units …]` and hands the whole array
 * to `batch()`. D1 compiles nothing at `prepare()` time, so the index statement
 * is only parsed after the table exists. `node:sqlite`'s `prepare()` parses
 * immediately, so preparing eagerly would throw "no such table: units" while
 * building the array, on every fresh database.
 *
 * The cache exists because the bootstrap prepares hundreds of statements per
 * boot and the hot board queries repeat the same SQL thousands of times. It is
 * bounded so that a long-lived container cannot accumulate a compiled statement
 * for every one-off DDL string the bootstrap has ever run.
 */
const STATEMENT_CACHE_LIMIT = 256;

class NodeD1Connection {
  readonly database: DatabaseSyncLike;
  readonly path: string;
  private readonly compiled = new Map<string, StatementSyncLike>();

  constructor(path: string) {
    const { DatabaseSync } = sqliteModule();
    this.path = path;
    this.database = new DatabaseSync(path);
  }

  statementFor(sql: string): StatementSyncLike {
    const cached = this.compiled.get(sql);
    if (cached) {
      // Re-insert so the Map's insertion order is a least-recently-used order.
      this.compiled.delete(sql);
      this.compiled.set(sql, cached);
      return cached;
    }
    const statement = this.database.prepare(sql);
    this.compiled.set(sql, statement);
    if (this.compiled.size > STATEMENT_CACHE_LIMIT) {
      const oldest = this.compiled.keys().next();
      if (!oldest.done) this.compiled.delete(oldest.value);
    }
    return statement;
  }
}

class NodeD1PreparedStatement {
  constructor(
    private readonly connection: NodeD1Connection,
    private readonly sql: string,
    private readonly params: SqliteValue[],
  ) {}

  /**
   * Returns a NEW statement. Drizzle keeps one prepared statement per query and
   * calls `.bind(...)` on it for every execution, so mutating `this` here would
   * make two concurrent requests share one set of parameters.
   */
  bind(...values: unknown[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(
      this.connection,
      this.sql,
      values.map(toBoundValue),
    );
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const started = performance.now();
    const rows = this.rows();
    return {
      results: rows as T[],
      success: true,
      meta: meta({
        duration: performance.now() - started,
        rows_read: rows.length,
      }),
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const rows = this.rows();
    const row = rows[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    return (row[column] ?? null) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const started = performance.now();
    const statement = this.connection.statementFor(this.sql);
    const outcome = this.execute(() => statement.run(...this.params));
    const changes = Number(outcome.changes);
    return {
      results: [],
      success: true,
      meta: meta({
        duration: performance.now() - started,
        changes,
        changed_db: changes > 0,
        rows_written: changes,
        last_row_id: Number(outcome.lastInsertRowid),
      }),
    };
  }

  /**
   * Rows as arrays rather than objects, which is how drizzle reads every
   * `SELECT` it maps onto a schema (`values()` in its d1 session calls this).
   *
   * `setReturnArrays` is a mode on the compiled statement, and compiled
   * statements are cached and shared, so it is turned off again in a `finally`.
   * Nothing can interleave in between: `node:sqlite` is synchronous, so no
   * other task runs between the two calls.
   */
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const statement = this.connection.statementFor(this.sql);
    let rows: unknown[];
    statement.setReturnArrays(true);
    try {
      rows = this.execute(() => statement.all(...this.params));
    } finally {
      statement.setReturnArrays(false);
    }
    if (options?.columnNames) {
      const names = statement.columns().map((column) => column.name);
      return [names as unknown as T, ...(rows as T[])];
    }
    return rows as T[];
  }

  /** @internal — the shared read path behind `all()` and `first()`. */
  private rows(): Array<Record<string, unknown>> {
    const statement = this.connection.statementFor(this.sql);
    const rows = this.execute(() => statement.all(...this.params));
    return rows.map(toPlainRow);
  }

  /**
   * Runs one SQLite call, restating any failure the way D1 does.
   *
   * The `D1_ERROR:` prefix is not decoration: it is what the Workers runtime
   * puts in front of a query failure, and keeping it means an error surfacing
   * in a log or a test on Node reads identically to the same error on
   * Cloudflare. The SQL is attached because a bare "no such column" from inside
   * a bundled server tells nobody which query produced it.
   */
  private execute<T>(work: () => T): T {
    try {
      return work();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `D1_ERROR: ${message.replace(/^D1_ERROR:\s*/, "")}: ${this.sql}`,
        { cause },
      );
    }
  }
}

class NodeD1Database {
  private readonly connection: NodeD1Connection;

  constructor(path: string) {
    this.connection = new NodeD1Connection(path);
  }

  /** The file this binding is reading, for start-up logging. */
  get sqlitePath(): string {
    return this.connection.path;
  }

  prepare(sql: string): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.connection, sql, []);
  }

  /**
   * Runs every statement in one transaction, which is D1's contract for
   * `batch()` and the reason `db/init.ts` uses it for the schema bootstrap: a
   * half-applied batch would leave a database that no later boot can repair.
   *
   * `SAVEPOINT` rather than `BEGIN` when a transaction is already open, because
   * drizzle's `db.transaction()` issues its own `BEGIN` and SQLite has no
   * nested `BEGIN`. The alternative — skipping the wrapper — would silently
   * make the batch non-atomic inside a transaction that has its own rollback.
   */
  async batch<T = Record<string, unknown>>(
    statements: NodeD1PreparedStatement[],
  ): Promise<Array<D1Result<T>>> {
    const database = this.connection.database;
    const nested = database.isTransaction;
    const savepoint = `d1_batch_${(batchDepth += 1)}`;

    database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    try {
      const results: Array<D1Result<T>> = [];
      for (const statement of statements) {
        results.push(await statement.all<T>());
      }
      database.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return results;
    } catch (error) {
      database.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      throw error;
    }
  }

  /**
   * D1's multi-statement escape hatch. Reports the number of statements it ran,
   * which is the one field of its result anybody uses.
   */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.connection.database.exec(sql);
    const count = sql
      .split(";")
      .filter((statement) => statement.trim().length > 0).length;
    return { count, duration: performance.now() - started };
  }

  /**
   * Not implemented, and left absent rather than faked. `dump()` returns a
   * serialised copy of a D1 database; nothing in this app calls it, and a stub
   * that returned an empty buffer would be a backup that silently contained
   * nothing.
   */
  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not supported by the Node SQLite D1 shim.");
  }
}

let batchDepth = 0;

/**
 * The process-wide database.
 *
 * One connection, created on first use and kept: `node:sqlite` is synchronous
 * and single-connection is how a D1 binding behaves, so there is nothing to
 * pool. Opening lazily also means a deployment whose volume is not mounted
 * fails on the first query with the message from `resolveSqlitePath()` rather
 * than crashing at import time with a stack trace from inside a bundle.
 */
let database: NodeD1Database | null = null;

export function nodeD1Database(): NodeD1Database {
  if (database) return database;
  try {
    database = new NodeD1Database(resolveSqlitePath());
  } catch (error) {
    /*
     * Logged here because nobody downstream will. Every route wraps its work in
     * a `catch` that answers "The live board is temporarily unavailable." and
     * throws the cause away — reasonable for a query failure, useless for a
     * container whose volume is not mounted, which is by far the most likely
     * way this fails on Railway. Without this line the operator sees a mute 503
     * and no reason for it anywhere.
     */
    console.error("[node-d1] cannot open the SQLite database:", error);
    throw error;
  }
  // One line, once per process: which file this deployment is actually serving
  // is the first thing to check when the data looks wrong.
  console.log(`[node-d1] serving ${database.sqlitePath}`);
  return database;
}

export type { D1Result };
