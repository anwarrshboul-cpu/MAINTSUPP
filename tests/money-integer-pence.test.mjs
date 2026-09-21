/**
 * Money as integer pence — Master Specification §72, owner decision D7.
 *
 * What these assertions are for. The migration is additive and the read path falls
 * back, so almost nothing here can be proved by "does it still work" — a workspace
 * with an empty `cost_pence` reads exactly as it did before. What can be proved is
 * that the arithmetic is right, that no float accumulation survives, and that the
 * two engines agree. So this file pins:
 *
 *   1. that the column is additive, nullable and guarded, and `cost` is untouched;
 *   2. that the SQL rounds BEFORE it casts, with a witness that actually fails
 *      otherwise at the float width the engine under test has;
 *   3. that no aggregation site sums the raw float any more;
 *   4. that every pounds figure is one division of an exact integer, not a sum of
 *      divisions;
 *   5. that a part-migrated workspace reads correctly, because Staging is one.
 *
 * Comments are stripped before any ABSENCE assertion: this file's own prose quotes
 * the very expressions it forbids.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every file that aggregates job cost. The subject of assertion 3. */
const AGGREGATING = [
  "app/api/contractors/route.ts",
  "app/api/workspace/route.ts",
  "app/lib/contractor-linking.ts",
  "app/lib/dashboard-aggregates.ts",
  "app/lib/overview-aggregates.ts",
];

/* ------------------------------------------------------------------ */
/* The column                                                          */
/* ------------------------------------------------------------------ */

test("cost_pence is additive, nullable and guarded, and cost is untouched", async () => {
  const schema = await read("db/schema.ts");
  const init = await read("db/init.ts");

  /* D7 conditions 1, 2 and 3, by construction rather than by promise. */
  assert.match(schema, /costPence: integer\("cost_pence"\),/);
  assert.match(schema, /cost: real\("cost"\),/, "the source column must remain exactly as it was");
  assert.doesNotMatch(
    schema,
    /costPence: integer\("cost_pence"\)[^,\n]*notNull/,
    "a NOT NULL column would need a default and a backfill in the same breath",
  );

  /* A guarded addColumn, which is the only additive mechanism this schema has. */
  assert.match(init, /\["maintenance_requests", "cost_pence", "INTEGER"\],/);

  /* And nothing destructive anywhere near it. */
  /*
   * NARROWED TO THE MONEY COLUMNS deliberately. A blanket "no DROP near
   * maintenance_requests" caught a pre-existing, documented, approval-gated statement
   * — `ALTER COLUMN site_id DROP NOT NULL`, behind `BATCH_1B_APPLY` — which has
   * nothing to do with this phase, and forbidding it here would have been this test
   * claiming authority over a decision somebody else already made and recorded.
   *
   * What must be true is narrower and stronger: neither money column is ever dropped.
   */
  const body = decommented(init);
  assert.doesNotMatch(body, /DROP COLUMN/i, "this schema has no destructive column change at all");
  assert.doesNotMatch(body, /DROP[^\n]*\bcost(_pence)?\b/i);
  assert.doesNotMatch(body, /\bcost(_pence)?\b[^\n]*DROP/i);
});

test("the migration does not backfill on the boot path", async () => {
  /*
   * `applyMigrations` runs on the boot path of a request. A backfill there would be
   * an unbounded UPDATE over every workspace's financial history on somebody's first
   * page load, and it would run again for every workspace the moment the fingerprint
   * moved. The column arrives empty and the read path copes.
   */
  const init = decommented(await read("db/init.ts"));
  assert.doesNotMatch(
    init,
    /UPDATE maintenance_requests[\s\S]{0,200}cost_pence/i,
    "the backfill is a separate, individually reconciled operation",
  );
});

/* ------------------------------------------------------------------ */
/* The SQL                                                             */
/* ------------------------------------------------------------------ */

test("the pence expression rounds before it casts", async () => {
  const source = await read("app/lib/cost-sql.ts");

  /*
   * `cast(x * 100 as integer)` TRUNCATES. A binary float product can land just below
   * the integer it should be, and the cast then discards the difference — a penny, on
   * a value a person would check by hand.
   */
  assert.match(source, /cast\(round\(\$\{maintenanceRequests\.cost\} \* 100\) as integer\)/);
  assert.doesNotMatch(
    decommented(source),
    /cast\(\$\{maintenanceRequests\.cost\} \* 100 as integer\)/,
    "the cast must never see an unrounded product",
  );
});

test("the trap is real at the float width JavaScript actually has", () => {
  /*
   * THE WITNESS MATTERS, and this is the assertion that stops the one above being
   * decoration.
   *
   * `develop` recorded `48.87` as the example, and that is true on Postgres `real`
   * (float32, which Staging has). On float64 — SQLite locally, and Production's
   * `double precision` — 48.87 is fine, so a test written with it alone would pass
   * vacuously in two of the three environments.
   *
   * `1.115` fails at float64. Measured in this repository's own local SQLite:
   *     cast(1.115 * 100 as integer)        = 111
   *     cast(round(1.115 * 100) as integer) = 112
   *
   * JavaScript is float64 too, so the same arithmetic demonstrates it here without a
   * database.
   */
  assert.equal(Math.trunc(1.115 * 100), 111, "truncation loses the penny");
  assert.equal(Math.round(1.115 * 100), 112, "rounding first keeps it");
  assert.notEqual(Math.trunc(1.115 * 100), Math.round(1.115 * 100));

  /* And the float32 witness, for the record — exact at float64, which is why it
     cannot be the only one. */
  assert.equal(Math.trunc(48.87 * 100), 4887, "48.87 is exact at float64");
});

test("the SQL is spelled the way both engines agree on", async () => {
  const source = await read("app/lib/cost-sql.ts");
  const body = decommented(source);

  /*
   * The portal runs the same SQL on Miniflare SQLite locally and Postgres deployed.
   * `::bigint` is Postgres-only: it would pass deployed and fail every local test,
   * which is the worst direction for a difference to run in.
   */
  assert.doesNotMatch(body, /::bigint/);
  assert.doesNotMatch(body, /::numeric/);
  assert.doesNotMatch(body, /::integer/);
  assert.match(body, /as integer\)/);
});

test("the expression reads BOTH columns, because a workspace can be part-migrated", async () => {
  const source = await read("app/lib/cost-sql.ts");

  /*
   * Not belt-and-braces. Staging literally is part-migrated — 155 rows carry `cost`
   * and 92 carry `cost_pence` — so an expression reading only the new column would
   * report a fraction of that workspace's spend, and one reading only the old column
   * would never benefit from the migration.
   */
  assert.match(
    source,
    /coalesce\(\$\{maintenanceRequests\.costPence\}, cast\(round/,
    "prefer the integer, fall back to the decimal",
  );
});

/* ------------------------------------------------------------------ */
/* No float aggregation survives                                       */
/* ------------------------------------------------------------------ */

test("no aggregation site sums the raw float any more", async () => {
  const offenders = [];
  for (const file of AGGREGATING) {
    const body = decommented(await read(file));
    /* `sum(cost)` in any spelling — the drizzle column reference or the bare name. */
    for (const match of body.matchAll(/sum\(\s*\$\{maintenanceRequests\.cost\}\s*\)/g)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a float sum is exact only by headroom; it must go through cost-sql.ts",
  );
});

test("every aggregating file goes through the shared expression", async () => {
  for (const file of AGGREGATING) {
    const source = await read(file);
    assert.match(
      source,
      /from "(\.\.\/)*(\.\/)?(lib\/)?cost-sql"/,
      `${file} must import the shared money expression rather than repeat it`,
    );
  }
});

test("the shared module is the only place the expression is written", async () => {
  /*
   * `overview-aggregates.ts` had its own correct copy, and a second definition of the
   * rule is how one screen comes to count a job as costed while another does not —
   * which is the argument that file's own header makes. It now imports.
   */
  const offenders = [];
  for (const file of AGGREGATING) {
    const body = decommented(await read(file));
    if (/cast\(round\(\$\{maintenanceRequests\.cost\} \* 100\) as integer\)/.test(body)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], "the expression belongs to app/lib/cost-sql.ts alone");
});

/* ------------------------------------------------------------------ */
/* One division, at the edge                                           */
/* ------------------------------------------------------------------ */

test("pounds are one division of an exact integer, never a sum of divisions", async () => {
  /*
   * THE POINT OF THE WHOLE PHASE. Converting the SQL and then adding the pounds
   * results in JavaScript puts the float accumulation straight back. Every accumulator
   * in these files therefore adds pence and divides once.
   */
  for (const file of ["app/lib/contractor-linking.ts", "app/lib/dashboard-aggregates.ts"]) {
    const body = decommented(await read(file));
    assert.doesNotMatch(
      body,
      /\+= poundsFromPenceSum/,
      `${file} must accumulate pence, not pounds`,
    );
    assert.match(body, /Pence \+=|Pence\.set\(/, `${file} must have a pence accumulator`);
  }

  /* And the division helper exists precisely so nobody writes `/ 100` by hand. */
  const shared = await read("app/lib/cost-sql.ts");
  assert.match(shared, /export function poundsFromPenceSum\(pence: number\): number \{\s*\n\s*return pence \/ 100;/);
});

test("the two money boundaries stay separate, and each says why", async () => {
  const sqlSide = await read("app/lib/cost-sql.ts");
  const jsSide = await read("app/lib/reporting/money.ts");

  /*
   * `reporting/money.ts` imports nothing on purpose — its header says the invoice
   * arithmetic has to be callable from `node --test` without a database, a component
   * or a bundler. A SQL expression needs drizzle and the schema, so folding the two
   * together would take that property away from the file that most needs it.
   */
  assert.match(jsSide, /Nothing\s*\n? \* here imports anything|imports anything, which is\s*\n? \* deliberate/);
  assert.doesNotMatch(
    decommented(jsSide),
    /drizzle-orm|db\/schema/,
    "the JS boundary must stay importless",
  );
  assert.match(sqlSide, /drizzle-orm/);
  assert.match(sqlSide, /WHY THIS IS A SEPARATE MODULE/);
});

/* ------------------------------------------------------------------ */
/* What the phase deliberately did not do                              */
/* ------------------------------------------------------------------ */

test("the other float money columns are left alone, knowingly", async () => {
  const schema = await read("db/schema.ts");

  /*
   * `invoices.amount` and `quotations.amount` are also floats. Measured 2026-09-20,
   * BOTH HAVE ZERO ROWS IN PRODUCTION, so nothing is at risk there today and
   * converting them is a separate decision rather than something to fold in silently.
   * Asserted so that the day one of them gains rows, this test is the record of the
   * decision rather than a surprise.
   */
  assert.match(schema, /amount: real\("amount"\)/, "invoices/quotations amount is still a float");
  const shared = await read("app/lib/cost-sql.ts");
  assert.doesNotMatch(
    decommented(shared),
    /invoices|quotations/,
    "this module is about job cost; the other columns need their own decision",
  );
});
