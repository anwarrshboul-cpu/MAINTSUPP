/**
 * Turning a database fault into a refusal that does not publish the schema.
 *
 * `db/node-pg-d1.ts` throws `D1_ERROR: <postgres message>` with the TRANSLATED
 * STATEMENT attached, and Drizzle prefixes its own faults with
 * `Failed query: <sql>`. A route that answers `error.message` verbatim
 * therefore hands the caller its own SQL. `app/api/sites/route.ts` found this
 * the hard way and fixed it there with `sitesDatabaseError`/`siteWriteFailure`;
 * this is the same protection, for routes that are not the sites route.
 *
 * It is deliberately NOT `siteWriteFailure`, even though importing that across
 * routes is an established pattern here (`sites/csv/route.ts` and
 * `sites/groups/route.ts` both do it). Two reasons:
 *
 *   - That function treats `UNIQUE constraint failed` as an outage and answers
 *     503. For the sites route that is right, because the only unique index it
 *     can trip is one it already checks for. For the register routes it is
 *     wrong: a duplicate column key is a legitimate, deliberate **409** the
 *     caller is meant to act on, and reporting it as an outage would replace a
 *     useful instruction with a lie.
 *   - It also carries `SiteInputError` and site-code handling, which mean
 *     nothing outside that file.
 *
 * The rule below is therefore narrower on purpose: it recognises a DRIVER
 * fault and nothing else, and every other error keeps the status and the
 * message the route already chose. It can only ever make a leak safe; it can
 * never change a path that was already correct.
 *
 * This is invisible in local development. Miniflare D1 is SQLite and does not
 * produce the Postgres messages the regex is written for, so the fault it
 * guards against appears for the first time on the deployed database — which
 * is exactly why it belongs in the code rather than in a test that would pass
 * either way.
 */

/**
 * The shapes a driver fault arrives in, from both dialects.
 *
 * Taken from `DATABASE_FAULT` in `app/api/sites/route.ts`, MINUS the two
 * constraint-violation clauses. A unique or duplicate-key violation is a real
 * answer to a real request here, not an outage; see the note above.
 */
const DRIVER_FAULT =
  /^D1_ERROR|^Failed query:|no such (table|column)|database is locked|SQLITE_|ECONNREFUSED|ETIMEDOUT|too many clients|authentication failed/i;

/** What the caller is told instead of the statement that failed. */
const OUTAGE =
  "The database is not answering. Nothing was changed. Try again in a moment.";

/**
 * Whether this error came from the driver rather than from the route's own
 * validation.
 *
 * `error.cause instanceof Error` is part of the test because Drizzle wraps the
 * underlying pg error rather than re-throwing it, so the outer message can be
 * innocuous while the cause carries the statement.
 */
export function isDriverFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return DRIVER_FAULT.test(error.message) || error.cause instanceof Error;
}

/**
 * The message and status a catch block should answer with.
 *
 * Pass the status the route would otherwise have used; a driver fault
 * overrides it with 503, because a database that is down is not the caller's
 * bad request and telling them it is invites them to edit a form that was
 * never wrong.
 */
export function databaseSafeFailure(
  error: unknown,
  fallback: string,
  status = 400,
): { message: string; status: number } {
  if (isDriverFault(error)) return { message: OUTAGE, status: 503 };
  return {
    message: error instanceof Error && error.message ? error.message : fallback,
    status,
  };
}
