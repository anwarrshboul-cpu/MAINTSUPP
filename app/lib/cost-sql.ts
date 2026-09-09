/**
 * One SQL expression for "how much money is this, in pence".
 *
 * `maintenance_requests.cost` is a `real` — IEEE-754 binary32 — and summing it
 * is wrong in a way that only appears once several rows are added together.
 * The migration's 92 costed jobs are the proof: every individual value
 * round-trips perfectly, and `sum(cost)` returns 52408.1 against a true total
 * of 52408.06. Four pence, growing with the row count, invisible per row.
 *
 * `cost_pence` is the canonical column and this codebase already keeps money in
 * `*_pence INTEGER` in twenty-one other places. `cost` is kept beside it
 * because it is the source value, so every aggregate has to be able to read a
 * workspace part-way through the backfill: prefer the integer, fall back to the
 * decimal, and never mix an integer sum with a float one.
 *
 * WRITTEN TO RUN ON BOTH ENGINES. `cast(... as integer)` and `round()` are the
 * spelling SQLite and Postgres agree on; a `::bigint` would pass deployed and
 * fail every local Miniflare test. Nothing here needs `db/sqlite-to-postgres.ts`
 * to translate it.
 *
 * Callers get PENCE and divide by 100 themselves, through `penceToPounds`. The
 * division is the last step and happens once, on an exact integer, so the
 * float that reaches the screen is a rendering rather than an accumulator.
 */

import { sql, type SQL } from "drizzle-orm";
import { maintenanceRequests } from "../../db/schema";

/**
 * The pence value of one row, whichever column carries it.
 *
 * `round()` before the cast, not after: `cast(48.87 * 100 as integer)` is 4886
 * on a binary float, because 4887 is not representable and the product lands
 * just below it. Rounding first is the difference between a penny and a bug.
 */
export const rowCostPence = sql<number>`coalesce(${maintenanceRequests.costPence}, cast(round(${maintenanceRequests.cost} * 100) as integer))`;

/** Total pence over the grouped rows, zero rather than null when there are none. */
export const sumCostPenceSql = sql<number>`coalesce(sum(${rowCostPence}), 0)`;

/**
 * Total pence over the rows matching `condition`, zero elsewhere.
 *
 * For the attribution meters, which need "of this total, how much names a
 * contractor" as a second sum over the same scan.
 */
export function sumCostPenceWhere(condition: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${condition} then ${rowCostPence} else 0 end), 0)`;
}

/**
 * Whether a row carries a cost at all.
 *
 * Reads both columns for the same reason the sum does. `> 0` rather than
 * `is not null` preserves the existing behaviour of every caller: a job
 * recorded as £0.00 has never counted as a costed job here.
 */
export const isCostedJob = sql`(${rowCostPence} is not null and ${rowCostPence} > 0)`;

/**
 * The pounds value of one of the sums above.
 *
 * Separate from `penceToPounds`, which is nullable because a single row's cost
 * may genuinely be "not recorded". An aggregate is never that: these sums
 * `coalesce` to zero, so the result is a number by construction and callers
 * should not have to write `?? 0` to say so.
 */
export function poundsFromSum(pence: number): number {
  return pence / 100;
}
