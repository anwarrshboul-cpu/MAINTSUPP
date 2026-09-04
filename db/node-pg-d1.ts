/**
 * A D1 database that is really the `portal` schema on Supabase Postgres.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `db/node-d1.ts` already moved this application off Cloudflare and onto Node,
 * by answering the D1 interface out of a SQLite file. That shim needed no SQL
 * translation and no type conversion, because D1 *is* SQLite: the same bytes,
 * the same dialect, the same loose typing.
 *
 * This file makes the same trade against a different engine. The legacy data is
 * already in Supabase — 48 tables, 30,265 rows in schema `portal`, loaded and
 * verified by `migration/legacy-to-postgres/` — and the goal is to serve the
 * unchanged legacy portal from it. Not one line of `app/**` may move, so
 * everything that differs between SQLite and Postgres has to be absorbed by two
 * files: `db/sqlite-to-postgres.ts` for the statements, and this one for the
 * connection, the parameters and the values that come back.
 *
 * ---------------------------------------------------------------------------
 * Sync vs async: what actually changed, and what did not
 * ---------------------------------------------------------------------------
 * `node:sqlite` is synchronous; Postgres is a socket. That sounds like the
 * central problem of this port and it is very nearly a non-problem, because
 * D1's own contract is already asynchronous: `all()`, `first()`, `run()`,
 * `raw()`, `batch()` and `exec()` all return promises, and drizzle's d1 driver
 * awaits every one of them. `db/node-d1.ts` returned already-resolved promises
 * around synchronous work; this file returns promises that are actually
 * pending. No caller can tell.
 *
 * Three real consequences, all of them handled below:
 *
 *  1. `prepare()` must stay SYNCHRONOUS — drizzle calls it inline in
 *     `prepareQuery()` and never awaits it. So translation cannot happen there
 *     if it ever needs to await anything, and it is done at execution time
 *     instead. That also preserves the laziness `db/init.ts` depends on: D1
 *     compiles nothing at prepare time, so a batch may legally contain
 *     `CREATE TABLE units` followed by `CREATE INDEX … ON units`.
 *
 *  2. `raw()` no longer needs the "set a mode on the shared compiled statement,
 *     unset it in a finally" dance that `node-d1.ts` documents. Row-array shape
 *     is a property of the postgres.js call, not of a cached statement, so
 *     concurrency cannot interleave two callers into each other's mode.
 *
 *  3. `batch()` must run on ONE connection or it is not a transaction at all.
 *     A pool would happily send a bare `BEGIN` down one socket and the batch's
 *     inserts down another — a bug that does not fail, it just silently stops
 *     being atomic. This ran on a single connection for that reason, and now
 *     runs on a pool with the batch's connection RESERVED out of it: see
 *     `connection()` for why one connection was costing every parameterised
 *     statement a second round trip, and `batch()` for the two independent
 *     mechanisms that keep the transaction on one socket.
 *
 * ---------------------------------------------------------------------------
 * The `public` schema is not ours
 * ---------------------------------------------------------------------------
 * The same Supabase project holds the LIVE Phase 2 application in `public` — 23
 * tables, 791 rows in `jobs` — which has nothing to do with the legacy portal
 * and must never be touched by it. The connection therefore pins
 * `search_path = portal, pg_catalog` as a STARTUP parameter, so every
 * unqualified name in all 238 raw statements and everything drizzle emits
 * resolves inside `portal`, and an unqualified `CREATE TABLE` from
 * `db/init.ts`'s bootstrap cannot land in `public`.
 *
 * A startup parameter rather than a `SET` after connecting, deliberately: the
 * pooler can drop an idle session at any time, postgres.js reconnects silently,
 * and a `SET` issued once would be gone. The startup packet is re-sent on every
 * reconnect, so the guarantee survives the thing most likely to break it.
 */

/*
 * The `.ts` on this specifier is not a typo and not a style choice. Node
 * resolves ESM specifiers literally, so `tests/node-pg-d1.test.mjs` — which
 * imports this module directly, the way `tests/node-r2.test.mjs` imports
 * `node-r2.ts` — cannot load a translator imported without its extension. The
 * cost is one `tsc --noEmit` complaint (TS5097, "enable
 * allowImportingTsExtensions"), which this repo's tsconfig does not enable and
 * which is not part of any build, lint or test script; the same tsconfig
 * already records that the other half of this repository runs on Node's native
 * TypeScript with explicit `.ts` specifiers. Vite resolves it either way.
 */
import {
  BOOLEAN_COLUMNS,
  translateSql,
  type TranslateOptions,
} from "./sqlite-to-postgres.ts";

/* ----------------------------------------------------------------- node -- */

interface NodeProcessLike {
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (name: string) => unknown;
}

function nodeProcess(): NodeProcessLike {
  const runtime = (globalThis as { process?: NodeProcessLike }).process;
  if (typeof runtime?.getBuiltinModule !== "function") {
    throw new Error(
      "The Postgres D1 adapter needs a Node runtime with " +
        "process.getBuiltinModule (Node 22.3+). This build is running " +
        "somewhere else.",
    );
  }
  return runtime;
}

/**
 * `postgres` (postgres.js) loaded without an import statement, for the same
 * reason `db/node-d1.ts` reaches for `node:sqlite` through
 * `process.getBuiltinModule` — and with one extra precaution that was NOT
 * optional.
 *
 * This module is pulled into the server bundle by a `resolve.alias` on
 * `cloudflare:workers`, and that bundle is produced by a build configured for
 * workerd. That matters more than it sounds: postgres.js publishes four builds
 * in its `exports` map, and the `workerd` condition selects `cf/src/index.js`,
 * whose socket layer is `await import('cloudflare:sockets')`.
 *
 * The first version of this function called `require("postgres")` with a
 * literal specifier, and the bundler followed it — a literal `require` is a
 * static dependency to a bundler regardless of where the `require` function
 * came from. The workerd build landed in `dist/server/index.js`, and every
 * query in the portal failed at runtime with
 *
 *   ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'cloudflare:'
 *
 * which names neither postgres.js nor the condition that chose it. The
 * specifier is therefore assembled from `PG_D1_DRIVER` or a constant, so the
 * call is opaque to static analysis and Node resolves it at first query, from
 * the ordinary `node_modules`, under the ordinary `node`/`require` conditions —
 * which is the CommonJS build that actually speaks TCP.
 */
type PostgresFactory = (url: string, options: Record<string, unknown>) => Sql;

const POSTGRES_DRIVER = "postgres";

function postgresModule(): PostgresFactory {
  const runtime = nodeProcess();
  const moduleApi = runtime.getBuiltinModule!.call(runtime, "node:module") as {
    createRequire: (path: string) => (id: string) => unknown;
  };
  const path = runtime.getBuiltinModule!.call(runtime, "node:path") as {
    join: (...parts: string[]) => string;
  };
  const load = moduleApi.createRequire(
    path.join(runtime.cwd?.() ?? ".", "node-pg-d1.cjs"),
  );
  const specifier = runtime.env?.["PG_D1_DRIVER"] || POSTGRES_DRIVER;
  const loaded = load(specifier) as PostgresFactory | { default: PostgresFactory };
  return typeof loaded === "function" ? loaded : loaded.default;
}

/* ------------------------------------------------------ postgres.js types -- */

interface PostgresColumn {
  name: string;
  type: number;
}

interface PostgresResult extends Array<unknown> {
  columns?: PostgresColumn[];
  count?: number;
  command?: string;
}

interface Sql {
  unsafe(
    sql: string,
    params?: unknown[],
    options?: { prepare?: boolean },
  ): PostgresQuery;
  begin<T>(run: (tx: Sql) => Promise<T>): Promise<T>;
  reserve?(): Promise<ReservedSql>;
  end(options?: { timeout?: number }): Promise<void>;
}

interface ReservedSql extends Sql {
  release(): void;
}

interface PostgresQuery extends Promise<PostgresResult> {
  values(): Promise<PostgresResult>;
  simple(): PostgresQuery;
}

/* -------------------------------------------------------- the connection -- */

/**
 * Where the legacy portal's Postgres lives.
 *
 * `PG_D1_URL` wins over `DATABASE_URL` so that a deployment running both halves
 * of this repo — the Phase 2 API also reads `DATABASE_URL` — can point the
 * legacy portal somewhere else without disturbing it.
 */
function resolveDatabaseUrl(): string {
  const env = nodeProcess().env ?? {};
  const url = env["PG_D1_URL"] || env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "PG_D1=1 selects the Postgres D1 adapter, but neither PG_D1_URL nor " +
        "DATABASE_URL is set. Point one at the Supabase session pooler " +
        "(port 5432) holding the `portal` schema.",
    );
  }
  if (/:6543\//.test(url)) {
    /*
     * Not fatal, because a URL is the operator's decision, but loud: port 6543
     * is Supabase's TRANSACTION pooler, which hands out a different backend per
     * statement. `batch()` below opens a real transaction and the bootstrap in
     * `db/init.ts` runs hundreds of statements through it — see the note in
     * `packages/db/src/client.ts` about this workload deadlocking there.
     */
    console.warn(
      "[node-pg-d1] the connection string uses port 6543 (transaction " +
        "pooler). This adapter expects the session pooler on 5432.",
    );
  }
  return url;
}

/**
 * The schema this adapter is allowed to see.
 *
 * `public` is absent on purpose and that absence is the safety property: the
 * live Phase 2 application's 23 tables are there, and an unqualified name that
 * fails to resolve in `portal` must be an error rather than a quiet hit on
 * somebody else's `jobs` table.
 */
const SEARCH_PATH = "portal, pg_catalog";

/**
 * Whether postgres.js may give its prepared statements names.
 *
 * Off for the transaction pooler, where a name can outlive the backend that
 * parsed it, and off on request — `PG_D1_PREPARE=0` is the escape hatch for an
 * operator who puts something else in front of Postgres. On otherwise, for the
 * round-trip reason set out on `connection()`.
 */
function usePreparedStatements(url: string): boolean {
  const env = nodeProcess().env ?? {};
  if (env["PG_D1_PREPARE"] === "0") return false;
  return !/:6543\//.test(url);
}

/* --------------------------------------------------------------- values -- */

/**
 * Converts a bound parameter into the one shape that survives the round trip:
 * text, with the type left for Postgres to decide.
 *
 * The reason this works — and the reason `PG_TYPES` below has to exist — is a
 * detail of how postgres.js sends a parameterised query, and it is worth
 * stating because it is not what the documentation suggests and it cost an
 * afternoon to find:
 *
 *   1. Values are collected and each is given a type OID by `inferType()`. A
 *      string or a number gets OID 0, "unspecified"; a JS `Date` gets
 *      `timestamptz`; `true` gets `boolean`.
 *   2. Because the query has parameters, postgres.js sets `describeFirst` and
 *      sends only Parse + Describe. Postgres replies with a ParameterDescription
 *      naming the type it INFERRED for every unspecified parameter — `boolean`
 *      for `WHERE active = $1`, `date` for `WHERE due_at = $1`.
 *   3. Only then does postgres.js Bind — and it serialises each value with the
 *      serialiser registered for the type Postgres just named.
 *
 * So the parameter is typed by the column, exactly as a SQLite-shaped caller
 * needs. But it is serialised by a function that expects a JS-native value of
 * that type, and postgres.js's built-in `boolean` serialiser is literally
 * `x === true ? 't' : 'f'`. Hand it the string `"1"` that
 * `INSERT … (active) VALUES (?)` binds and it sends `f`, and every flag the
 * portal writes is silently false. Not an error — the wrong answer, which is
 * why `PG_TYPES` replaces that serialiser rather than this function trying to
 * guess which parameters are boolean.
 *
 * Everything here therefore becomes a string, which is what SQLite's own type
 * affinity does to a bound value anyway, and `PG_TYPES` makes sure the three
 * types where "a string" and "what postgres.js expects" disagree are handled.
 * The object case throws for the same reason it throws in `node-d1.ts`: an
 * accidental object parameter must be an error and not a silently wrong query.
 */
function toBoundValue(value: unknown, index: number): string | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(
    `D1_ERROR: parameter ${index + 1} is a ${typeof value} that Postgres ` +
      "cannot bind. Serialise it before binding.",
  );
}

/** SQLite's spellings of true, plus Postgres' own, all of which mean 1. */
const TRUTHY = new Set(["1", "t", "true", "y", "yes", "on"]);
const FALSY = new Set(["0", "f", "false", "n", "no", "off"]);

/**
 * The three serialisers where postgres.js's JS-native assumption and this
 * application's SQLite-shaped values disagree.
 *
 * These are merged over postgres.js's defaults, keyed by type OID, and are
 * chosen at Bind time using the type Postgres inferred for the parameter — see
 * `toBoundValue()` for why that is the interesting moment.
 *
 *  - `bool` is the one that matters. The default sends `f` for anything that is
 *    not the JS literal `true`, so every `VALUES (?, …, 1)` in the app would
 *    write false. This accepts what SQLite accepts, and REFUSES anything else
 *    rather than defaulting to false — a flag written from an unparseable value
 *    is a data corruption that no test would notice.
 *
 *  - `date` (which covers `date`, `timestamp` and `timestamptz`) defaults to
 *    `new Date(x).toISOString()`, and that reparse is a bug waiting to happen:
 *    JavaScript reads `2026-08-07 09:33:46` — the format 35,847 legacy rows
 *    were written in — as LOCAL time, so a server outside UTC would shift every
 *    timestamp it round-tripped. Passing the string through hands the parsing
 *    to Postgres, which reads it as UTC because the session is pinned to UTC,
 *    which is what SQLite's `CURRENT_TIMESTAMP` always meant.
 *
 *  - `json` defaults to `JSON.stringify`, which would double-encode the JSON
 *    this application stores as text. `portal` has no json columns today; this
 *    is here so that adding one does not corrupt it.
 */
const PG_TYPES = {
  bool: {
    to: 16,
    from: [16],
    serialize: (value: unknown) => {
      if (value === true) return "t";
      if (value === false) return "f";
      const text = String(value).toLowerCase();
      if (TRUTHY.has(text)) return "t";
      if (FALSY.has(text)) return "f";
      throw new TypeError(
        `D1_ERROR: ${JSON.stringify(value)} was bound to a boolean column and ` +
          "is neither true nor false.",
      );
    },
    parse: (value: string) => value === "t",
  },
  date: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: (value: unknown) =>
      value instanceof Date ? value.toISOString() : String(value),
    parse: (value: string) => new Date(value),
  },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (value: unknown) =>
      typeof value === "string" ? value : JSON.stringify(value),
    parse: (value: string) => value,
  },
} as const;

/**
 * Postgres type OIDs, from `pg_type`. Only the ones `portal` can produce.
 *
 * The schema is 430 `text`, 111 `timestamptz`, 27 `boolean`, 27 `integer`, 12
 * `date`, 8 `bigint` and 6 `double precision` columns; `int8` and `numeric` are
 * here because `count(*)` and `sum()` produce them regardless of what the
 * columns hold.
 */
const OID = {
  BOOL: 16,
  BYTEA: 17,
  INT8: 20,
  JSON: 114,
  DATE: 1082,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  JSONB: 3802,
} as const;

/**
 * Converts one Postgres value back into the shape the legacy application has
 * always been handed.
 *
 * This is the half of the port that `migration/legacy-to-postgres/README.md`
 * flagged as "the largest single piece of work and the most likely source of
 * subtle UI bugs" — every consumer of a timestamp or a flag would need
 * checking. It needs checking in exactly one place instead, because the
 * migration typed the columns properly and the application did not change:
 *
 *  - `boolean` → 1/0. `db/schema.ts` declares all 27 of these as
 *    `integer({ mode: "boolean" })`, and drizzle's mapper is literally
 *    `Number(value) === 1`; hand it `true` and every flag in the portal reads
 *    false. Raw callers compare against 1 directly.
 *
 *  - `timestamptz` → ISO-8601 with `Z`. The legacy column held three formats at
 *    once (see the migration's decision 1); ISO is one of them, it is
 *    unambiguous, `new Date()` parses it, and — unlike the space-separated form
 *    — sorting it as text agrees with sorting it as an instant.
 *
 *  - `date` → `YYYY-MM-DD`, with no time and no zone. These 12 columns are
 *    `<input type="date">` fields (`due_at`, `completed_at`, `expiry_date`, …)
 *    and the whole reason the migration typed them `date` rather than
 *    `timestamptz` was to stop a timezone turning "the 7th" into "the 6th".
 *    Formatting through UTC parts keeps that promise: postgres.js parses a bare
 *    date into UTC midnight, so the UTC parts are the original characters.
 *
 *  - `int8`/`numeric` → number. postgres.js returns both as strings, so
 *    `count(*)` would otherwise come back as `"776"` and every
 *    `total > 0 ? … : …` in the app would still be true but every
 *    `total + 1` would be `"7761"`. Values beyond `Number.MAX_SAFE_INTEGER`
 *    keep the string, because a wrong number is worse than an unexpected type.
 *
 *  - `json`/`jsonb` → text. The legacy app stores JSON in `text` columns and
 *    calls `JSON.parse` itself; `portal` has no json columns today, so this is
 *    only here so that adding one does not hand a route an object it will try
 *    to parse.
 */
function fromPostgresValue(value: unknown, oid: number): unknown {
  if (value === null || value === undefined) return null;

  switch (oid) {
    case OID.BOOL:
      return value === true || value === "t" || value === 1 ? 1 : 0;
    case OID.DATE: {
      const date = value instanceof Date ? value : new Date(String(value));
      const year = String(date.getUTCFullYear()).padStart(4, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    case OID.TIMESTAMP:
    case OID.TIMESTAMPTZ: {
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
    }
    case OID.INT8:
    case OID.NUMERIC: {
      const asNumber = Number(value);
      if (!Number.isFinite(asNumber)) return value;
      if (oid === OID.INT8 && !Number.isSafeInteger(asNumber)) return value;
      return asNumber;
    }
    case OID.JSON:
    case OID.JSONB:
      return typeof value === "string" ? value : JSON.stringify(value);
    case OID.BYTEA:
      return value;
    default:
      return value;
  }
}

/* --------------------------------------------------------------- trace -- */

/**
 * Per-statement timing, off unless `PG_D1_TRACE=1`.
 *
 * This exists because the first question anyone asks about this adapter — "why
 * is /api/board three seconds against Supabase and 0.29s against SQLite?" — is
 * unanswerable from outside it. Postgres' own `pg_stat_statements` reports
 * execution time on the server, which for this workload is the small half; the
 * interesting number is how many statements a request issues and what each one
 * cost end to end, round trip included. Nothing above this file can count that.
 *
 * The output is one line per statement plus a per-request-ish summary flushed
 * on demand, and it is deliberately written to stderr rather than accumulated:
 * a trace that grows an array is a memory leak waiting for somebody to leave
 * the flag on in production.
 */
interface TraceTotals {
  statements: number;
  totalMs: number;
  byStatement: Map<string, { count: number; ms: number }>;
}

let traceTotals: TraceTotals | null = null;

function traceEnabled(): boolean {
  return nodeProcess().env?.["PG_D1_TRACE"] === "1";
}

/** The statement, flattened and clipped, as a grouping key a human can read. */
function traceKey(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").slice(0, 110);
}

function recordTrace(sql: string, ms: number): void {
  if (!traceTotals) {
    traceTotals = { statements: 0, totalMs: 0, byStatement: new Map() };
  }
  traceTotals.statements += 1;
  traceTotals.totalMs += ms;
  const key = traceKey(sql);
  const entry = traceTotals.byStatement.get(key);
  if (entry) {
    entry.count += 1;
    entry.ms += ms;
  } else {
    traceTotals.byStatement.set(key, { count: 1, ms });
  }
  console.error(`[pg-d1-trace] ${ms.toFixed(1)}ms  ${key}`);
}

/**
 * @internal — the totals since the last reset, for a measurement harness.
 *
 * Exported rather than printed on a timer because the only useful boundary is
 * "one HTTP request", which this file cannot see. A caller that can — a test,
 * or a debug route — resets before and reads after.
 */
export function pgD1TraceSnapshot(): {
  statements: number;
  totalMs: number;
  top: Array<{ sql: string; count: number; ms: number }>;
} {
  const totals = traceTotals ?? {
    statements: 0,
    totalMs: 0,
    byStatement: new Map(),
  };
  const top = [...totals.byStatement.entries()]
    .map(([sql, value]) => ({ sql, count: value.count, ms: value.ms }))
    .sort((a, b) => b.ms - a.ms);
  return { statements: totals.statements, totalMs: totals.totalMs, top };
}

/** @internal — starts a fresh measurement window. */
export function pgD1TraceReset(): void {
  traceTotals = null;
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

/**
 * The same deliberate deviations `db/node-d1.ts` lists, plus one of this
 * engine's own: `last_row_id` is always 0. Postgres has no rowid and no
 * `last_insert_rowid()`, every legacy primary key is an application-generated
 * text id (migration decision 10), and no caller in this repo reads the field —
 * checked. `meta.changes` is real, because `consumeReset()` and the invitation
 * claim in `app/api/auth/` decide whether a single-use token was won or lost by
 * reading it.
 */
function meta(overrides: Partial<D1Meta>): D1Meta {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
    served_by: "node-postgres",
    ...overrides,
  };
}

/** Statements whose `count` from Postgres means "rows affected", not "rows". */
const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * A translated statement plus the rows it produced, in both shapes.
 *
 * One execution path for `all()`, `first()`, `run()` and `raw()`, built on
 * postgres.js's `.values()` — which returns row ARRAYS and the column
 * descriptors together. Object rows are assembled here rather than by
 * postgres.js, because the type conversion above is per column OID and the
 * descriptors are the only place the OIDs exist.
 */
interface Executed {
  columns: PostgresColumn[];
  rows: unknown[][];
  command: string;
  count: number;
}

/**
 * Translation is expensive relative to a query and every statement in this
 * application repeats: `db/init.ts` issues several hundred per boot and the
 * board reads the same dozen statements thousands of times. Bounded for the
 * same reason `node-d1.ts` bounds its compiled-statement cache — a long-lived
 * container must not accumulate an entry for every one-off DDL string.
 */
const TRANSLATION_CACHE_LIMIT = 512;

/**
 * How many sockets the adapter may open.
 *
 * Four, and the number is bounded from above by the pooler rather than chosen
 * for throughput. Supabase's session-mode pooler enforces a per-project client
 * limit — this project's is 15, and exceeding it is not a queue, it is a
 * connection REFUSED at startup:
 *
 *   PostgresError: (EMAXCONNSESSION) max clients reached in session mode -
 *   max clients are limited to pool_size: 15
 *
 * which was hit during this adapter's own testing, with two app processes at
 * eight each. Four leaves room for a rolling deploy where two instances overlap
 * (8), a `psql`, and the Phase 2 stack in `apps/` — which shares this database
 * and this pooler. `PG_D1_POOL` raises it for a deployment that knows its own
 * budget; raising it past the project's `pool_size` trades a slow portal for a
 * portal that cannot connect at all.
 */
const DEFAULT_POOL_SIZE = 4;

/**
 * The same number on a host that runs many copies of this process at once.
 *
 * `DEFAULT_POOL_SIZE` is a per-PROCESS figure that was budgeted against a fixed
 * number of processes, and on Railway that arithmetic holds: `railway.json` sets
 * `numReplicas: 1`, so the portal is one process and costs 4. The portal is also
 * deployed on Vercel, where the unit is a function instance, each instance gets
 * its own module scope and therefore its own pool, and the platform decides how
 * many instances exist. Four per instance is not a budget of four, it is four
 * times a number nobody in this repository controls: three warm instances is 12
 * on its own, and the Phase 2 API in `apps/` — same database, same pooler — is
 * already holding up to 10 of the project's 15.
 *
 * Two, there, for a reason rather than as a round-down. A function instance is
 * serving a small number of concurrent requests by construction, so the pool is
 * not what limits its throughput; and when the pool IS the limit, postgres.js
 * QUEUES the extra query on an existing socket instead of opening another. That
 * is backpressure inside the process, which is the well-behaved failure — the
 * request waits. Exceeding the pooler's client limit is the badly-behaved one:
 * the pooler refuses the connection outright and the route answers 500.
 *
 * Not one. `db/init.ts` runs its whole schema bootstrap through `batch()`, which
 * RESERVES a connection out of the pool for the duration; with `max: 1` every
 * other query on a cold start would queue behind the entire bootstrap, and
 * `primaryKeyMap()` — which a `batch()` containing `INSERT OR REPLACE` would
 * reach for on the pool handle while that batch holds the reservation — would
 * have nothing left to run on. Two keeps a socket free of both.
 *
 * `VERCEL` is set to "1" on every Vercel runtime, build and deployment; it is
 * their own marker and not a value this repo has to set. `PG_D1_POOL` overrides
 * either default for a deployment that knows its own instance count.
 */
const VERCEL_POOL_SIZE = 2;

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * The pool ceiling for the host this process is running on.
 *
 * Stated as a function rather than a constant so the reasoning above stays
 * attached to the choice, and so a test can exercise both branches.
 */
function defaultPoolSize(env: Record<string, string | undefined>): number {
  return env["VERCEL"] ? VERCEL_POOL_SIZE : DEFAULT_POOL_SIZE;
}

/**
 * How many times a statement may wait for the pooler to have room, and for how
 * long.
 *
 * Four attempts and roughly 50/150/350 ms of sleeping between them, so the
 * worst case a caller can experience is its own latency plus about 0.55 s, and
 * a request that would have been a 500 becomes a request that was slow. Beyond
 * that the honest answer is the error: a pooler that has been full for half a
 * second is not momentarily busy, it is oversubscribed, and hiding that behind
 * a thirty-second retry would turn a visible outage into an invisible one.
 *
 * Jittered, because the whole point is that several processes are colliding on
 * one 15-client budget. Un-jittered backoff makes them collide again, in step,
 * at the same three moments.
 */
const POOLER_RETRY_DELAYS_MS = [50, 150, 350];

function retryDelays(
  env: Record<string, string | undefined>,
): readonly number[] {
  // `PG_D1_POOL_RETRIES=0` turns it off for an operator who would rather see
  // the refusal than wait for it.
  const raw = env["PG_D1_POOL_RETRIES"];
  if (raw === undefined) return POOLER_RETRY_DELAYS_MS;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) return POOLER_RETRY_DELAYS_MS;
  return POOLER_RETRY_DELAYS_MS.slice(0, count);
}

/**
 * Whether this failure is the pooler saying "not right now".
 *
 * Deliberately narrow, and matched on the marker in the MESSAGE rather than on
 * the SQLSTATE. Reproduced against the real project by opening clients until it
 * refused — the sixteenth — and the error is:
 *
 *   PostgresError { name: "PostgresError", code: "XX000",
 *     message: "(EMAXCONNSESSION) max clients reached in session mode -
 *               max clients are limited to pool_size: 15" }
 *
 * `XX000` is `internal_error`, the code Postgres and everything wearing its
 * wire protocol reach for when nothing more specific fits, so retrying on the
 * code would retry genuine server faults as well. `EMAXCONNSESSION` is
 * supavisor's own marker and means one specific thing.
 *
 * WHY RETRYING THIS IS SAFE EVEN FOR A WRITE, which is the question any retry
 * has to answer. The refusal is issued during the client STARTUP exchange,
 * before postgres.js has sent a Parse or a Bind: there is no connection, so
 * there is no backend, so the statement provably did not run. Nothing can be
 * executed twice by retrying it. That is why this predicate must not be widened
 * to cover, say, `CONNECTION_CLOSED` — a socket that dropped mid-statement has
 * no such guarantee, and an INSERT retried through one is a duplicate row.
 */
function isPoolerAtCapacity(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    typeof message === "string" &&
    /EMAXCONNSESSION|max clients reached in session mode/i.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attempt`, giving the pooler a moment and trying again if it refused the
 * connection for want of room.
 *
 * Only `isPoolerAtCapacity` is retried. Every other failure — a syntax error, a
 * constraint violation, a dropped socket — is rethrown on the first attempt,
 * unchanged and undelayed, because none of them get better by being repeated
 * and a retried constraint violation is just a slower one.
 */
async function withPoolerRetry<T>(attempt: () => Promise<T>): Promise<T> {
  const delays = retryDelays(nodeProcess().env ?? {});
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= delays.length || !isPoolerAtCapacity(error)) throw error;
      const base = delays[index];
      // ±25%, so two processes backing off together stop being in step.
      await sleep(Math.round(base * (0.75 + Math.random() * 0.5)));
    }
  }
}

class NodePgConnection {
  readonly url: string;
  private sql: Sql | null = null;
  private readonly translations = new Map<string, string>();
  private primaryKeys: ReadonlyMap<string, readonly string[]> | null = null;

  /**
   * Passed to every `unsafe()` call, so the prepared-statement decision is made
   * once here rather than being re-derived at each of the four call sites.
   */
  readonly queryOptions: { prepare: boolean };

  constructor(url: string) {
    this.url = url;
    this.queryOptions = { prepare: usePreparedStatements(url) };
  }

  /**
   * A small pool, and named prepared statements. Both were `1` and `false`, and
   * both were changed on the strength of a measurement rather than a preference
   * — the numbers are in the block comment below because the reasoning is not
   * recoverable from the code.
   *
   * WHY THE POOL IS SAFE, which is the question `max: 1` was answering.
   *
   * The original note said a pool "would happily send `BEGIN` down one socket
   * and the batch's inserts down another". That is true of a bare `BEGIN`
   * string sent through the pool handle — which is how drizzle's d1 driver
   * implements `transaction()` — and it is NOT true of `sql.begin()`, which is
   * what `batch()` uses. postgres.js's `begin()` captures the connection its
   * `begin` executed on (`onexecute`) and binds the callback's handle to that
   * one connection, so every statement in the batch provably shares a socket
   * with its `BEGIN` and `COMMIT` no matter how large the pool is. Nothing in
   * `app/**` or `db/**` calls `db.transaction()` — checked — so the unsafe
   * shape has no caller; `batchConnection()` below reserves a connection anyway
   * so that the guarantee does not rest on that remaining true.
   *
   * WHY PREPARED STATEMENTS ARE SAFE HERE, which is what `prepare: false` was
   * answering. The concern is real but belongs to Supabase's TRANSACTION pooler
   * on 6543, which hands out a different backend per statement and where a
   * named statement can therefore outlive the backend that parsed it. This
   * adapter requires the SESSION pooler on 5432 — `resolveDatabaseUrl()` warns
   * about 6543 already — and a session-mode pooler pins one backend for the
   * life of the client connection. postgres.js also clears its statement cache
   * in `connected()`, so a silent reconnect re-parses rather than referring to
   * a name the new backend never saw. `PG_D1_PREPARE=0` turns it off, and 6543
   * turns it off automatically.
   *
   * WHAT IT BUYS. With `prepare: false` and any bound parameter, postgres.js
   * sets `describeFirst`: it sends Parse+Describe, WAITS for Postgres to name
   * the parameter types, and only then sends Bind+Execute. That is two round
   * trips for every parameterised statement. Measured against this Supabase
   * pooler from a developer machine: 6.7 ms for an unparameterised statement,
   * 19.0 ms for a parameterised one — 2.8x, and this application's statements
   * are almost all parameterised. Naming the statement makes `describeFirst`
   * false from the second execution onwards, which is where the repetition in
   * `db/init.ts` and the board's seeding loops actually live.
   */
  connection(): Sql {
    if (this.sql) return this.sql;
    const postgres = postgresModule();
    const env = nodeProcess().env ?? {};
    this.sql = postgres(this.url, {
      max: positiveInteger(env["PG_D1_POOL"], defaultPoolSize(env)),
      prepare: this.queryOptions.prepare,
      types: PG_TYPES,
      connection: {
        search_path: SEARCH_PATH,
        /*
         * SQLite's `CURRENT_TIMESTAMP` is UTC and the 111 migrated timestamp
         * columns were loaded on that basis, so the session must not inherit a
         * host's local zone: `2026-08-07 09:33:46` written by the app has to
         * mean the same instant it has always meant.
         */
        TimeZone: "UTC",
        /*
         * Pinned for the same class of reason as `TimeZone`, and for one
         * concrete caller: `sqlite-to-postgres.ts` translates SQLite's
         * `replace(X, …)` — which /api/audit uses on `created_at` — into a
         * `::text` cast, and the text form of a timestamp is whatever DateStyle
         * says it is. `ISO` gives "2026-08-07 14:35:37.123+00", which sorts as
         * text in the same order it sorts as an instant; `SQL` or `German`
         * would give "07/08/2026 …" and "07.08.2026 …", which do not. It is the
         * Postgres default, so this changes nothing today — it stops a role or
         * database `SET` somebody adds later from silently reordering an audit
         * log.
         */
        DateStyle: "ISO, MDY",
        /*
         * A HISTORICAL NAME, KEPT ON PURPOSE.
         *
         * `maintsupp-legacy-portal` was the Vercel project this connected
         * from, and that project was deleted on 2026-09-04 — the portal now
         * deploys as `maintsupp-portal`. The string is not renamed to match,
         * because `application_name` is what identifies these connections in
         * `pg_stat_activity` and in Supabase's logs, and changing it splits
         * the log record either side of the rename for no gain. Whoever is
         * reading a slow-query log should know this label means the portal.
         */
        application_name: "maintsupp-legacy-portal",
      },
      /*
       * IDLE SOCKETS MUST BE GIVEN BACK, which is the other half of the pool
       * sizing above and the half that was missing.
       *
       * `max: 2` bounds what ONE instance holds. It says nothing about how many
       * instances hold two each, and postgres.js keeps a socket open for the
       * life of the process by default — so a function instance that served one
       * request an hour ago still owns its connections, and Vercel keeps
       * instances warm long after a deployment is superseded. Instances from
       * several deployments therefore accumulate against one pooler until:
       *
       *   PostgresError: (EMAXCONNSESSION) max clients reached in session mode
       *   — max clients are limited to pool_size: 30
       *
       * which is what the preview started answering to /api/context after a run
       * of deployments — a 500 on the first request the client's browser makes,
       * with nothing wrong in the code path it names.
       *
       * Twenty seconds is comfortably longer than any single request here (the
       * schema bootstrap runs inside one `batch()`, which reserves its
       * connection and so is never idle) and far shorter than the minutes an
       * instance stays warm. The reconnect is transparent — postgres.js dials
       * again on the next query — so the cost is one connect on a cold path and
       * the gain is that idle instances stop hoarding a shared, capped resource.
       *
       * `max_lifetime` recycles even a busy connection every half hour, so a
       * socket the pooler has quietly dropped cannot be held indefinitely.
       */
      idle_timeout: positiveInteger(env["PG_D1_IDLE_TIMEOUT"], 20),
      max_lifetime: positiveInteger(env["PG_D1_MAX_LIFETIME"], 60 * 30),
      // The bootstrap's DDL raises "already exists, skipping" notices by the
      // hundred on every boot. They are the expected outcome, not news.
      onnotice: () => {},
    });
    return this.sql;
  }

  translate(sql: string, options: TranslateOptions): string {
    const cached = this.translations.get(sql);
    if (cached !== undefined) {
      // Re-insert so Map insertion order is a least-recently-used order.
      this.translations.delete(sql);
      this.translations.set(sql, cached);
      return cached;
    }
    const translated = translateSql(sql, options);
    this.translations.set(sql, translated);
    if (this.translations.size > TRANSLATION_CACHE_LIMIT) {
      const oldest = this.translations.keys().next();
      if (!oldest.done) this.translations.delete(oldest.value);
    }
    return translated;
  }

  /**
   * Primary keys per table, read once, and only when something needs them.
   *
   * Only `INSERT OR REPLACE` does — it becomes `ON CONFLICT (…) DO UPDATE` and
   * Postgres insists on a conflict target. This codebase contains none, so this
   * query is never run in practice; it exists so that the first one written
   * works instead of failing with a translator error.
   */
  async primaryKeyMap(): Promise<ReadonlyMap<string, readonly string[]>> {
    if (this.primaryKeys) return this.primaryKeys;
    const rows = (await this.connection().unsafe(
      `SELECT c.relname::text AS table_name,
              a.attname::text AS column_name,
              array_position(i.indkey::int2[], a.attnum) AS ordinal
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
        WHERE i.indisprimary AND n.nspname = 'portal'
        ORDER BY 1, 3`,
    )) as Array<{ table_name: string; column_name: string }>;

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const existing = map.get(row.table_name);
      if (existing) existing.push(row.column_name);
      else map.set(row.table_name, [row.column_name]);
    }
    this.primaryKeys = map;
    return map;
  }

  /** Translation options, resolved lazily so the common path stays cheap. */
  async optionsFor(sql: string): Promise<TranslateOptions> {
    if (!/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) return {};
    return { primaryKeys: await this.primaryKeyMap() };
  }

  /**
   * A connection nothing else can be scheduled onto, for the duration of a
   * `batch()`.
   *
   * With the connection reserved out of the pool there is no arrangement of
   * pool state under which another request's statement can be dispatched onto
   * the socket carrying an open transaction. `batch()` explains why that is
   * worth taking a connection out of circulation for.
   *
   * A capability check rather than a version test, and `null` rather than a
   * silent fallback to the pool handle: on a postgres.js without `reserve()`
   * the caller must take the `sql.begin()` path instead, which is correct for a
   * different reason. Handing back the pool handle here would look like it had
   * worked and would open the transaction on whichever connection happened to
   * be free — the one shape this method exists to prevent.
   */
  async batchConnection(): Promise<{ sql: Sql; release: () => void } | null> {
    const pool = this.connection();
    if (typeof pool.reserve !== "function") return null;
    /*
     * The one place a `batch()` can be refused by the pooler, and therefore the
     * only place it is worth retrying one: `reserve()` may have to open a socket
     * to hand back, and no statement of the batch has been sent yet, so waiting
     * and asking again cannot repeat any work. Every statement after this runs
     * on the connection this call returns. `db/init.ts` boots the whole schema
     * through here, so a portal starting up while the pooler is briefly full
     * used to fail its bootstrap rather than wait 50 ms for room.
     */
    const reserved = await withPoolerRetry(() => pool.reserve!());
    return { sql: reserved, release: () => reserved.release() };
  }

  async close(): Promise<void> {
    if (!this.sql) return;
    const sql = this.sql;
    this.sql = null;
    await sql.end({ timeout: 5 });
  }
}

/*
 * Fields are declared and assigned rather than written as TypeScript parameter
 * properties, so that `node --test tests/node-pg-d1.test.mjs` can import this
 * file directly: Node's built-in type stripping rewrites nothing, and a
 * parameter property is a construct with runtime behaviour rather than a type
 * annotation. The tests import the real module for the same reason
 * `tests/node-r2.test.mjs` does — a re-implementation would be testing itself.
 */
class NodePgPreparedStatement {
  private readonly connection: NodePgConnection;
  private readonly sql: string;
  private readonly params: Array<string | null | Uint8Array>;

  constructor(
    connection: NodePgConnection,
    sql: string,
    params: Array<string | null | Uint8Array>,
  ) {
    this.connection = connection;
    this.sql = sql;
    this.params = params;
  }

  /**
   * Returns a NEW statement, for the reason `db/node-d1.ts` spells out: drizzle
   * prepares once and binds per execution, so mutating `this` would leak one
   * request's parameters into the next. It matters more here than it did there,
   * because here two requests really can be in flight at the same time.
   */
  bind(...values: unknown[]): NodePgPreparedStatement {
    return new NodePgPreparedStatement(
      this.connection,
      this.sql,
      values.map(toBoundValue),
    );
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const started = performance.now();
    const executed = await this.execute();
    const rows = objectRows(executed);
    return {
      results: rows as T[],
      success: true,
      meta: meta({
        duration: performance.now() - started,
        rows_read: rows.length,
        ...writeMeta(executed),
      }),
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const executed = await this.execute();
    const rows = objectRows(executed);
    const row = rows[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    return (row[column] ?? null) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const started = performance.now();
    const executed = await this.execute();
    const written = writeMeta(executed);
    return {
      results: [],
      success: true,
      meta: meta({ duration: performance.now() - started, ...written }),
    };
  }

  /**
   * Rows as arrays, which is how drizzle reads every SELECT it maps onto a
   * schema (`values()` in its d1 session calls this).
   */
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const executed = await this.execute();
    const rows = executed.rows.map((row) =>
      row.map((value, index) =>
        fromPostgresValue(value, executed.columns[index]?.type ?? 0),
      ),
    ) as T[];
    if (options?.columnNames) {
      const names = executed.columns.map((column) => column.name);
      return [names as unknown as T, ...rows];
    }
    return rows;
  }

  /** @internal — used by `batch()` to run this statement inside its transaction. */
  async executeOn(sql: Sql): Promise<Executed> {
    return this.execute(sql);
  }

  /**
   * Translate, send, and restate any failure the way D1 does.
   *
   * The `D1_ERROR:` prefix is what the Workers runtime puts in front of a query
   * failure, so an error surfacing in a log on Node reads the same as it would
   * on Cloudflare. The TRANSLATED statement is attached rather than the
   * original, because that is the text Postgres objected to — with the original
   * in hand and no translation, "column active is of type boolean" names a
   * query that does not exist.
   */
  private async execute(on?: Sql): Promise<Executed> {
    const options = await this.connection.optionsFor(this.sql);
    /*
     * Translation is inside the try, not before it. A statement this translator
     * refuses — a `PRAGMA` it does not know, a `strftime` — throws here, and
     * that is exactly the failure a porter needs to see; leaving it outside
     * would route the most informative error in the file around the logging.
     */
    let translated = this.sql;
    const sql = on ?? this.connection.connection();
    const tracing = traceEnabled();
    const startedAt = tracing ? performance.now() : 0;
    try {
      translated = this.connection.translate(this.sql, options);
      /*
       * The retry wraps the pool handle only. `on` is the connection `batch()`
       * RESERVED, and it is already open — the pooler cannot refuse it for want
       * of room, because the room was taken at `reserve()` and is still held.
       * More importantly a retry there would be wrong even if it could fire:
       * inside a transaction, re-running one statement of a batch would append
       * it to a transaction whose earlier statements have already been applied.
       * The reservation itself is retried instead, in `batchConnection()`,
       * where nothing has been executed yet.
       */
      const send = () =>
        sql
          .unsafe(translated, this.params, this.connection.queryOptions)
          .values();
      const result = on ? await send() : await withPoolerRetry(send);
      if (tracing) recordTrace(translated, performance.now() - startedAt);
      return {
        columns: result.columns ?? [],
        rows: result as unknown as unknown[][],
        command: result.command ?? "",
        count: result.count ?? 0,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      /*
       * Every route in this application wraps its work in a `catch` that
       * answers "temporarily unavailable" and throws the cause away — sensible
       * for one failed query, useless while porting, when the first question is
       * always WHICH statement Postgres refused and what it looked like after
       * translation. `PG_D1_DEBUG=1` puts that on stderr; off, this stays as
       * quiet as the SQLite shim.
       */
      if (nodeProcess().env?.["PG_D1_DEBUG"] === "1") {
        console.error(
          `[node-pg-d1] ${message}\n  original:   ${this.sql.trim()}\n` +
            `  translated: ${translated.trim()}\n  params:     ${JSON.stringify(this.params)}`,
        );
      }
      throw new Error(
        `D1_ERROR: ${message.replace(/^D1_ERROR:\s*/, "")}: ${translated.trim()}`,
        { cause },
      );
    }
  }
}

/** Row arrays plus column descriptors, as the plain objects D1 returns. */
function objectRows(executed: Executed): Array<Record<string, unknown>> {
  return executed.rows.map((row) => {
    const object: Record<string, unknown> = {};
    for (let i = 0; i < executed.columns.length; i += 1) {
      const column = executed.columns[i];
      object[column.name] = fromPostgresValue(row[i], column.type);
    }
    return object;
  });
}

/**
 * `changes` only for statements that changed something.
 *
 * postgres.js reports `count` for a SELECT too — it is the row count — and D1
 * reports 0 changes for a read. The two callers that read `meta.changes`
 * (`reset-tokens.ts`, the invitation claim) both run UPDATEs whose whole
 * purpose is to find out whether a single-use token was won, so reporting a
 * SELECT's row count here would hand the same token to two requests.
 */
function writeMeta(executed: Executed): Partial<D1Meta> {
  if (!WRITE_COMMANDS.has(executed.command)) return {};
  const changes = executed.count;
  return { changes, changed_db: changes > 0, rows_written: changes };
}

class NodePgDatabase {
  private readonly connection: NodePgConnection;

  constructor(url: string) {
    this.connection = new NodePgConnection(url);
  }

  /** Host and database only — the password must never reach a log line. */
  get describe(): string {
    try {
      const parsed = new URL(this.connection.url);
      return `${parsed.host}${parsed.pathname} (search_path=${SEARCH_PATH})`;
    } catch {
      return `(unparseable connection string) (search_path=${SEARCH_PATH})`;
    }
  }

  prepare(sql: string): NodePgPreparedStatement {
    return new NodePgPreparedStatement(this.connection, sql, []);
  }

  /**
   * Every statement in one transaction, which is D1's contract for `batch()`
   * and the reason `db/init.ts` uses it for the schema bootstrap.
   *
   * The connection is RESERVED out of the pool and the transaction is opened on
   * it by hand, rather than through postgres.js's `sql.begin()`.
   *
   * `sql.begin()` would also be correct — it captures the connection its
   * `begin` executed on and binds the callback's handle to that one connection,
   * so it is atomic at any pool size, and this adapter used it while it ran on
   * a single connection. It is not used now for a blunt reason: `reserve()`
   * returns a handle carrying `unsafe` and nothing else — no `begin` — so the
   * two cannot be combined, and reservation is the stronger of the two. A
   * reserved connection is OUT of the pool for the duration: there is no state
   * postgres.js could reach in which another request's statement is dispatched
   * onto a socket with an open transaction on it. `sql.begin()` on the pool
   * handle gives that guarantee through an internal detail; this gives it
   * structurally.
   *
   * That matters more than it looks, because the failure mode is not an error.
   * A batch that loses atomicity still returns success — `db/init.ts` runs the
   * entire schema bootstrap through here — so the guarantee has to be one that
   * cannot quietly stop holding.
   *
   * ROLLBACK is not optional and not best-effort: a reserved connection returns
   * to the pool when released, and returning one with an open transaction on it
   * would hand the next request a session that silently discards its writes.
   * Hence the `catch` that rolls back before rethrowing, and the `finally` that
   * releases whatever happened.
   *
   * There is no SAVEPOINT branch, unlike `db/node-d1.ts`. It would be dead
   * code: nothing in this repo calls `db.transaction()` — checked — and a
   * nested `batch()` is impossible by construction, because each one reserves
   * its own connection and therefore cannot be inside another's transaction.
   */
  async batch<T = Record<string, unknown>>(
    statements: NodePgPreparedStatement[],
  ): Promise<Array<D1Result<T>>> {
    const started = performance.now();

    const run = async (tx: Sql): Promise<Array<D1Result<T>>> => {
      const results: Array<D1Result<T>> = [];
      for (const statement of statements) {
        const executed = await statement.executeOn(tx);
        const rows = objectRows(executed);
        results.push({
          results: rows as T[],
          success: true,
          meta: meta({
            duration: performance.now() - started,
            rows_read: rows.length,
            ...writeMeta(executed),
          }),
        });
      }
      return results;
    };

    const reserved = await this.connection.batchConnection();
    if (!reserved) return this.connection.connection().begin(run);

    const { sql, release } = reserved;
    try {
      await sql.unsafe("BEGIN");
      try {
        const results = await run(sql);
        await sql.unsafe("COMMIT");
        return results;
      } catch (cause) {
        /*
         * Swallowed deliberately, and only here. If the ROLLBACK itself fails
         * the connection is already unusable — postgres.js will reconnect it —
         * and reporting that instead of the statement that actually failed
         * would replace the useful error with a symptom of it.
         */
        await sql.unsafe("ROLLBACK").catch(() => {});
        throw cause;
      }
    } finally {
      release();
    }
  }

  /**
   * D1's multi-statement escape hatch, on Postgres' simple query protocol —
   * which is the only one that accepts several statements in one message.
   * Nothing in this application calls it; drizzle and `db/init.ts` both use
   * `batch()`.
   */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const translated = translateSql(sql);
    await this.connection.connection().unsafe(translated).simple();
    const count = sql
      .split(";")
      .filter((statement) => statement.trim().length > 0).length;
    return { count, duration: performance.now() - started };
  }

  /**
   * Not implemented, and left absent rather than faked, exactly as in
   * `db/node-d1.ts`: `dump()` returns a serialised copy of a D1 database, and a
   * stub returning an empty buffer would be a backup that silently held nothing.
   */
  async dump(): Promise<ArrayBuffer> {
    throw new Error("dump() is not supported by the Postgres D1 adapter.");
  }

  /** For tests and for a clean shutdown; the app never closes its binding. */
  async close(): Promise<void> {
    await this.connection.close();
  }
}

/**
 * The process-wide database.
 *
 * Lazy for the same reason `node-d1.ts` is lazy: a deployment with no
 * `DATABASE_URL` should fail on its first query with the message from
 * `resolveDatabaseUrl()`, not crash at import time with a stack trace from
 * inside a bundle.
 */
let database: NodePgDatabase | null = null;

export function nodePgD1Database(): NodePgDatabase {
  if (database) return database;
  try {
    database = new NodePgDatabase(resolveDatabaseUrl());
  } catch (error) {
    // Logged here because nobody downstream will: every route catches and
    // answers "temporarily unavailable", throwing the cause away.
    console.error("[node-pg-d1] cannot configure the Postgres binding:", error);
    throw error;
  }
  console.log(`[node-pg-d1] serving ${database.describe}`);
  return database;
}

/** @internal — a standalone binding for tests, with no process-wide state. */
export function createPgD1Database(url?: string): NodePgDatabase {
  return new NodePgDatabase(url ?? resolveDatabaseUrl());
}

export { BOOLEAN_COLUMNS };
export type { D1Result, NodePgDatabase };
