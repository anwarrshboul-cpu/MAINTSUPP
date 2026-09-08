/**
 * THE COLUMN TYPES PRODUCTION ACTUALLY HAS, NOT THE ONES init.ts DECLARES.
 *
 * `Overview -> Performance over time` answered "The dashboard is temporarily
 * unavailable" on Production for a day, and on no other estate. The reason,
 * once `dashboardFailure` was made to log its `cause`:
 *
 *     function pg_catalog.btrim(date) does not exist
 *     select count(*) from "maintenance_requests" where (... trim("due_at") ...)
 *
 * `btrim` is what Postgres compiles `trim()` to. The SQL applied a STRING
 * function to a DATE column, and two comments in `dashboard-aggregates.ts`
 * asserted that was safe because "due_at is TEXT in both dialects, so no cast
 * is involved". That is true of a database `db/init.ts` created — it declares
 * these columns TEXT, which is Staging and every local Miniflare file — and
 * false of Production, which predates that declaration and holds a real
 * Postgres `date`. Neither Staging nor a local run could ever have shown it.
 *
 * The repair is one canonical helper, `dateText()`, that every text operation
 * on a date column goes through. These tests hold both halves of what that has
 * to be worth: the SQL Postgres receives must never apply a bare string
 * function to one of these columns, and the meaning on SQLite must not move.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(path.join(root, "app/lib/dashboard-aggregates.ts"), "utf8");

/* `app/lib/**` imports its neighbours without file extensions and reaches
   `cloudflare:workers` for a binding. TypeScript resolves the first and the
   deployed build aliases the second; Node needs both spelled out. */
const stub = pathToFileURL(path.join(root, "tests/fixtures/cloudflare-workers-stub.mjs")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && ctx.parentURL?.endsWith(".ts")) {
      const base = new URL(spec, ctx.parentURL);
      for (const c of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(c))) return { url: c, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const aggregates = await import("../app/lib/dashboard-aggregates.ts");
const { PgDialect } = await import("drizzle-orm/pg-core");
const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
const { maintenanceRequests } = await import("../db/schema.ts");

/** The date columns Production can hold as a real `date` rather than as text. */
const DATE_COLUMNS = ["due_at", "target_completion_date", "completed_at"];

const NOW = new Date("2026-09-08T12:00:00.000Z");

test("the SQL Postgres receives never applies a bare string function to a date column", () => {
  const { sql: rendered } = new PgDialect().sqlToQuery(aggregates.overdueOpenSql(NOW));

  for (const column of DATE_COLUMNS) {
    const quoted = `"maintenance_requests"."${column}"`;
    if (!rendered.includes(quoted)) continue;
    for (const fn of ["trim", "substr", "length", "lower", "btrim"]) {
      assert.ok(
        !rendered.includes(`${fn}(${quoted})`),
        `${fn}(${column}) reaches Postgres unwrapped — this is the exact shape that answered "function pg_catalog.btrim(date) does not exist" on Production`,
      );
    }
    assert.ok(
      rendered.includes(`cast(${quoted} as text)`),
      `${column} must be cast to text before any string function touches it`,
    );
  }
});

test("dateText renders one expression both dialects spell the same way", () => {
  const expr = aggregates.dateText(maintenanceRequests.dueAt);
  const pg = new PgDialect().sqlToQuery(expr).sql;
  const lite = new SQLiteSyncDialect().sqlToQuery(expr).sql;
  assert.equal(
    pg.replace(/\$\d+/g, "?"),
    lite,
    "the two dialects must receive the same expression, or the estates stop agreeing",
  );
  assert.match(pg, /cast\(.* as text\)/);
  assert.match(pg, /trim\(/);
  assert.match(pg, /replace\(/);
});

/*
 * MEANING, NOT JUST SYNTAX. A cast that quietly changed which jobs count as
 * overdue would pass every assertion above and misreport the card, so the rest
 * of this file runs the real predicate over the date shapes a legacy estate
 * actually holds.
 */
const ROWS = [
  ["bare-past", "2026-09-01", true, "a bare date whose day has passed"],
  ["bare-today", "2026-09-08", false, "a bare date is not late until its day is over"],
  ["bare-future", "2026-09-20", false, "a bare date still ahead"],
  ["iso-past", "2026-09-08T09:00:00.000Z", true, "an ISO instant already passed"],
  ["iso-future", "2026-09-08T18:00:00.000Z", false, "an ISO instant later today"],
  ["padded", "  2026-09-01  ", true, "the importer's padded value still reads as a day"],
  ["spaced", "2026-09-08 09:00:00", true, "a space-separated timestamp, which is what a cast Postgres timestamp looks like"],
  ["empty", "", false, "an empty string is not a due date"],
  ["null", null, false, "and neither is null"],
];

test("the overdue predicate means the same thing over every legacy date shape", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE maintenance_requests (
      id TEXT PRIMARY KEY NOT NULL,
      organisation_id TEXT,
      stage TEXT,
      status TEXT,
      due_at TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO maintenance_requests (id, organisation_id, stage, status, due_at) VALUES (?, 'org', 'In progress', 'New', ?)",
  );
  for (const [id, due] of ROWS) insert.run(id, due);

  const { sql: where, params } = new SQLiteSyncDialect().sqlToQuery(aggregates.overdueOpenSql(NOW));
  const found = new Set(
    db
      .prepare(`SELECT id FROM maintenance_requests WHERE ${where}`)
      .all(...params.map((p) => (p === undefined ? null : p)))
      .map((r) => r.id),
  );

  for (const [id, , overdue, why] of ROWS) {
    assert.equal(found.has(id), overdue, `${id}: ${why}`);
  }
  db.close();
});

/*
 * The other two call sites are not exported, so they are pinned in the source
 * — the convention this suite already uses ~3,100 times. Both were the same
 * defect and both would fail Production the same way if they regressed.
 */
test("the coverage and SLA comparisons go through dateText too", () => {
  assert.match(
    source,
    /const has = \(column: TextColumn\) =>[\s\S]{0,80}dateText\(column\)/,
    "coverage's has() tests three date columns for emptiness and must cast first",
  );
  assert.match(
    source,
    /const met = sql`substr\(\$\{dateText\(completed\)\}[\s\S]{0,80}dateText\(targetColumn\)/,
    "the SLA comparison substr()s two date columns and must cast first",
  );
  assert.ok(
    !/\btrim\(\$\{due\}\)/.test(source) && !/substr\(\$\{completed\}/.test(source),
    "no bare string function may be applied to a date column again",
  );
});
