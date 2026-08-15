/**
 * Value conversion, SQLite -> PostgreSQL.
 *
 * Every dialect difference that survives into the *data* (rather than the
 * schema) is handled in this one file, so there is a single place to audit
 * when a row lands looking wrong.
 *
 * The design rule throughout: convert what is understood, and throw loudly on
 * anything that is not. A converter that quietly returns null for input it
 * cannot parse turns a schema surprise into permanent, silent data loss, and
 * the row counts would still come out equal — which is exactly the failure a
 * migration is least likely to notice.
 */

/**
 * The three timestamp formats that actually occur in the legacy database.
 * These were established by inspecting all 84 time-bearing columns rather than
 * assumed, because the assumption "it's all ISO-8601" is wrong here in two
 * different ways.
 */

/** JavaScript `toISOString()` — 19,625 values. Already explicit UTC. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * SQLite `CURRENT_TIMESTAMP` — 35,847 values, the most common form.
 * Space-separated with no zone marker. SQLite defines CURRENT_TIMESTAMP as
 * UTC, so these are read as UTC. Reading them as local time instead would
 * shift every audit trail and every job's created_at by the server's offset —
 * an hour, in the case of the Europe/London default this application uses.
 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Bare calendar date — 2,576 values, mostly Monday.com import backfill. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise any of the three into an unambiguous UTC ISO-8601 string, which is
 * then handed to Postgres as text for a `timestamptz` column.
 *
 * A bare date becomes midnight UTC. That is a genuine widening — the source
 * has no time of day to give — and it is why `requested_at` reads 00:00:00Z
 * for the 634 imported jobs. It is recorded in the README rather than being
 * hidden here.
 */
export function toTimestamptz(value, where) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  // '' is not a timestamp. Postgres rejects it outright where SQLite stored it
  // happily, so it becomes NULL — the only honest reading of "no value".
  if (v === "") return null;

  if (ISO_UTC.test(v)) return v;
  if (SQLITE_DATETIME.test(v)) return v.replace(" ", "T") + "Z";
  if (DATE_ONLY.test(v)) return v + "T00:00:00Z";

  throw new Error(
    `Unrecognised timestamp format at ${where}: ${JSON.stringify(v)}. ` +
      `Add a rule to lib/convert.mjs rather than letting this row through.`,
  );
}

/**
 * Calendar dates (`due_at`, `completed_at`, `expiry_date`, lease and warranty
 * dates). These stay day-precision on purpose — see the header of
 * migrations/005_requests.sql for why turning them into instants would
 * introduce an off-by-one-day bug that the source does not have.
 *
 * A full timestamp appearing in one of these columns would be a real surprise,
 * so it is reported rather than silently truncated.
 */
export function toDate(value, where, onTruncate) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (v === "") return null;

  if (DATE_ONLY.test(v)) return v;
  if (ISO_UTC.test(v) || SQLITE_DATETIME.test(v)) {
    // Keep the row, keep the day, but make sure somebody hears about it.
    onTruncate?.(where, v);
    return v.slice(0, 10);
  }
  throw new Error(
    `Unrecognised date format at ${where}: ${JSON.stringify(v)}`,
  );
}

/**
 * SQLite has no boolean type; the legacy schema stores flags as INTEGER 0/1.
 * Anything other than 0/1/null in a column the DDL declared `boolean` means
 * the column was misclassified, so it throws rather than guessing truthiness —
 * `Boolean(2)` being `true` is precisely the kind of quiet reinterpretation
 * that makes a migration untrustworthy.
 */
export function toBoolean(value, where) {
  if (value === null || value === undefined) return null;
  if (value === 0 || value === 0n || value === "0") return false;
  if (value === 1 || value === 1n || value === "1") return true;
  if (typeof value === "boolean") return value;
  throw new Error(
    `Non-boolean value at ${where}: ${JSON.stringify(String(value))}. ` +
      `This column is declared boolean in portal but holds something else.`,
  );
}

/**
 * Numbers. node:sqlite hands back BigInt for large INTEGER values, which
 * postgres.js will not bind directly, so they are passed as strings and let
 * Postgres parse them. This is what carries `sign_in_failures.first_at`
 * (epoch milliseconds, ~1.78e12) across intact.
 */
export function toNumber(value, where) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`Non-finite number at ${where}: ${value}`);
    return value;
  }
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    return value;
  }
  throw new Error(`Unexpected numeric value at ${where}: ${typeof value}`);
}

/**
 * Text passes through untouched, with one guard: Postgres cannot store U+0000
 * in a `text` column, and a lone UTF-16 surrogate cannot be encoded on the
 * wire. Neither occurs in the current source (both were scanned for and came
 * back clean), but a later export could introduce one, and the failure it
 * causes mid-COPY is opaque enough to be worth naming here.
 */
export function toText(value, where) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array)
    throw new Error(
      `BLOB value at ${where}; portal has no bytea columns by design.`,
    );
  const v = typeof value === "string" ? value : String(value);
  if (v.includes("\u0000"))
    throw new Error(`NUL byte at ${where}; Postgres text cannot store U+0000.`);
  return v;
}

/**
 * Dispatch on the Postgres type the column actually has, as read from
 * information_schema. Driving conversion off the live schema rather than a
 * second copy of the mapping means the loader and the DDL cannot disagree.
 */
export function convert(value, pgType, where, onTruncate) {
  switch (pgType) {
    case "timestamp with time zone":
      return toTimestamptz(value, where);
    case "date":
      return toDate(value, where, onTruncate);
    case "boolean":
      return toBoolean(value, where);
    case "bigint":
    case "integer":
    case "smallint":
    case "numeric":
    case "double precision":
    case "real":
      return toNumber(value, where);
    case "text":
    case "character varying":
      return toText(value, where);
    default:
      throw new Error(
        `No conversion rule for Postgres type "${pgType}" at ${where}.`,
      );
  }
}
