/**
 * One SQL expression for "how much money is this, in pence" — Master Specification §72.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `app/lib/reporting/money.ts`.
 *
 * That file is the conversion boundary for JavaScript, and its header states the
 * reason it imports nothing: the invoice arithmetic is the part a client checks with
 * a calculator, so it has to be callable from `node --test` without a database, a
 * component or a bundler. A SQL expression needs `drizzle-orm` and `db/schema`, so
 * putting it there would take that property away from the one file that most needs
 * it. Two modules, one rule, and neither is any use unless the other is right.
 *
 * WHY SQL AT ALL, RATHER THAN SUMMING IN JS.
 *
 * `app/lib/overview-aggregates.ts` already worked this out and says it best: the
 * cards, the spend-by-site table and the utilisation meters are computed by SQL, so a
 * conversion applied only in JavaScript fixes nothing anybody can see. Its own
 * comment — "two readers of two columns is how a card comes to disagree with a report
 * about one number" — is the whole argument.
 *
 * This file is that expression, extracted so the nine aggregation sites which still
 * sum the raw float can share it instead of each repeating it. The expressions below
 * are deliberately the same shape that file already proved, plus the `cost_pence`
 * preference it could not have because the column did not exist.
 *
 * ⚠️ THREE THINGS THAT ARE NOT STYLE.
 *
 * 1. **`round()` BEFORE the cast.** `cast(x * 100 as integer)` TRUNCATES, and a
 *    binary float product can land just below the integer it should be. Measured in
 *    this repository's own local SQLite:
 *
 *        cast(1.115 * 100 as integer)        = 111
 *        cast(round(1.115 * 100) as integer) = 112
 *
 *    A penny, on a value a person would check by hand. The witness matters: `48.87`
 *    fails this way on Postgres `real` (float32, which Staging has) and is fine on
 *    float64, so a test written with 48.87 alone would pass vacuously on SQLite and
 *    in Production.
 *
 * 2. **`cast(… as integer)`, never `::bigint`.** The portal runs the same SQL on
 *    Miniflare SQLite locally and on Postgres deployed. The Postgres-only spelling
 *    would pass deployed and fail every local test, which is the worst direction for
 *    a difference to run in. Nothing here needs `db/sqlite-to-postgres.ts` to
 *    translate it.
 *
 * 3. **`cost_pence` is preferred and `cost` is the fallback.** Not belt-and-braces: a
 *    workspace part-way through the backfill genuinely has both, and Staging is
 *    literally in that state — 155 rows carry `cost`, 92 carry `cost_pence`. An
 *    expression reading only the new column would report a fraction of that
 *    workspace's spend; one reading only the old column would never benefit from the
 *    migration at all.
 *
 * WHAT THE COLUMN IS FOR, STATED PLAINLY AND WITHOUT OVERSTATING IT.
 *
 * `maintenance_requests.cost` is a float, and it is the only float money column in
 * this schema holding data — money lives in `*_pence INTEGER` in 44 columns across 23
 * tables. Measured 2026-09-20: Production's `cost` is `double precision` and its 132
 * costed rows sum EXACTLY, so there is no visible error in Production today; Staging's
 * is `real` and its 155 rows are 6p out. The case for integer pence is therefore not
 * "the total is wrong in Production" — it is that the total is right only by float64
 * headroom at this row count, and being right by luck is not a property to ship
 * financial figures on.
 *
 * Callers get PENCE and divide once, at the edge, so the float that reaches a screen
 * is a rendering rather than an accumulator.
 */

import { sql, type SQL } from "drizzle-orm";

import { maintenanceRequests } from "../../db/schema";

/**
 * One row's cost in integer pence, from whichever column carries it.
 *
 * A module constant, reused freely — which is how `overview-aggregates.ts` already
 * uses its equivalent in seven places within single statements. A drizzle `sql`
 * fragment is an immutable description, not a consumable stream.
 */
export const rowCostPenceSql = sql<number>`coalesce(${maintenanceRequests.costPence}, cast(round(${maintenanceRequests.cost} * 100) as integer))`;

/**
 * A cost that is a recorded trade spend.
 *
 * `> 0` rather than `is not null`, which preserves exactly what every existing caller
 * already means: a job recorded as £0.00 has never counted as a costed job here, and
 * zero or negative is a data-quality observation rather than money. Reads both columns
 * for the same reason the sum does.
 */
export const isCostedSql = sql`(${rowCostPenceSql} is not null and ${rowCostPenceSql} > 0)`;

/** Total pence over the grouped rows — zero rather than null when there are none. */
export const sumCostPenceSql = sql<number>`coalesce(sum(case when ${isCostedSql} then ${rowCostPenceSql} else 0 end), 0)`;

/**
 * Total pence over the rows matching `condition`, and zero for the rest.
 *
 * For the attribution meters, which need "of this total, how much names a contractor"
 * as a second sum over the same scan rather than a second query.
 */
export function sumCostPenceWhereSql(condition: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${isCostedSql} and ${condition} then ${rowCostPenceSql} else 0 end), 0)`;
}

/**
 * One of the sums above, as pounds.
 *
 * Separate from `penceToPounds` in `reporting/money.ts`, which is nullable because a
 * single row's cost may genuinely be "not recorded". An aggregate is never that: the
 * sums above `coalesce` to zero, so this is a number by construction and no caller
 * should have to write `?? 0` to say what the SQL already guarantees.
 *
 * The division is the LAST step and happens exactly once, on an exact integer.
 */
export function poundsFromPenceSum(pence: number): number {
  return pence / 100;
}
