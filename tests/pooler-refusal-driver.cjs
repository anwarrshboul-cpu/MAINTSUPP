/*
 * A stand-in for postgres.js that refuses the way Supabase's session pooler
 * refuses, on demand.
 *
 * `db/node-pg-d1.ts` loads its driver through `PG_D1_DRIVER`, which exists so
 * the specifier is opaque to the bundler; pointing it here is the only way to
 * make the pooler run out of room deterministically, in-process, without
 * holding fifteen real client connections against a live project for the
 * duration of a test suite.
 *
 * The refusal is reproduced from the real one, captured by opening clients
 * against the project until the sixteenth was turned away:
 *
 *   PostgresError { name: "PostgresError", code: "XX000",
 *     message: "(EMAXCONNSESSION) max clients reached in session mode -
 *               max clients are limited to pool_size: 15" }
 *
 * `PG_D1_FAKE_REFUSALS` is how many attempts are refused before one is allowed
 * through — set it above the retry budget to assert that the adapter gives up
 * and reports rather than retrying for ever. `PG_D1_FAKE_ERROR` refuses with a
 * DIFFERENT, non-transient error instead, which is how the "does not retry a
 * syntax error" case is written.
 */

let attempts = 0;

function reset() {
  attempts = 0;
}

function attemptCount() {
  return attempts;
}

function poolerRefusal() {
  const error = new Error(
    "(EMAXCONNSESSION) max clients reached in session mode - " +
      "max clients are limited to pool_size: 15",
  );
  error.name = "PostgresError";
  error.code = "XX000";
  return error;
}

function permanentFailure() {
  const error = new Error('syntax error at or near "SELCT"');
  error.name = "PostgresError";
  error.code = "42601";
  return error;
}

/** One row, shaped the way postgres.js's `.values()` shapes a result. */
function successResult() {
  const rows = [[1]];
  rows.columns = [{ name: "ok", type: 23 }];
  rows.command = "SELECT";
  rows.count = 1;
  return rows;
}

function nextResult() {
  attempts += 1;
  const budget = Number(process.env.PG_D1_FAKE_REFUSALS ?? 0);
  if (process.env.PG_D1_FAKE_ERROR === "1") throw permanentFailure();
  if (attempts <= budget) throw poolerRefusal();
  return successResult();
}

function query() {
  const run = async () => nextResult();
  const promise = run();
  promise.values = () => promise;
  promise.simple = () => promise;
  return promise;
}

function makeSql() {
  const sql = {
    unsafe: () => query(),
    begin: (run) => run(sql),
    reserve: async () => {
      // Reserving is where a `batch()` meets the pooler, so it refuses here too.
      nextResult();
      return { ...sql, release: () => {} };
    },
    end: async () => {},
  };
  return sql;
}

function postgres() {
  return makeSql();
}

postgres.__reset = reset;
postgres.__attempts = attemptCount;

module.exports = postgres;
