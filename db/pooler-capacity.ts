/**
 * IS THIS FAILURE THE CONNECTION POOLER SAYING "NOT RIGHT NOW"?
 *
 * ONE AUTHOR FOR A RULE TWO LAYERS HAVE TO AGREE ABOUT.
 *
 * `db/node-pg-d1.ts` asks this to decide whether to wait and try the statement
 * again. `app/lib/tenant-db.ts` asks it to decide what to TELL SOMEBODY once
 * the waiting is over and the answer is still no. Those are different
 * decisions, and a second copy of the regular expression is exactly how they
 * would come to disagree about what they are looking at.
 *
 * It lives in a file of its own, importing nothing, because the two callers
 * cannot share either of theirs: `node-pg-d1.ts` reaches for `postgres`
 * through `createRequire` and is Node-only, while the route layer is bundled
 * for Workers as well. A pure string predicate is safe in both.
 *
 * WHAT IT MATCHES, AND WHY NOT THE SQLSTATE. Recorded against the real project
 * by opening clients until it refused — the sixteenth — the error is:
 *
 *   PostgresError { name: "PostgresError", code: "XX000",
 *     message: "(EMAXCONNSESSION) max clients reached in session mode -
 *               max clients are limited to pool_size: 15" }
 *
 * `XX000` is `internal_error`, the code Postgres and everything wearing its
 * wire protocol reach for when nothing more specific fits, so matching on the
 * code would sweep up genuine server faults with it. `EMAXCONNSESSION` is
 * supavisor's own marker and means one specific thing.
 *
 * MATCHED AS A SUBSTRING, THROUGH A WRAPPER. By the time this reaches a route
 * the adapter has re-thrown it as `Error: D1_ERROR: (EMAXCONNSESSION) …`, and
 * drizzle may have wrapped that again, so an equality test would miss every
 * caller that is not the driver itself.
 *
 * DELIBERATELY NARROW. `node-pg-d1.ts` retries on this predicate, and a retry
 * is only safe because the refusal is issued during the client STARTUP
 * exchange, before postgres.js has sent a Parse or a Bind: there is no
 * connection, so there is no backend, so that statement provably did not run.
 * Widening this to cover, say, `CONNECTION_CLOSED` would break that guarantee —
 * a socket dropped mid-statement gives no such promise, and an INSERT retried
 * through one is a duplicate row. See `withPoolerRetry` for the full account.
 */
export function isPoolerAtCapacity(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    typeof message === "string" &&
    /EMAXCONNSESSION|max clients reached in session mode/i.test(message)
  );
}
