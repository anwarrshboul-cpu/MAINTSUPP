#!/usr/bin/env node
/**
 * Compare the legacy SQLite database against `portal` and report per-table
 * PASS/FAIL.
 *
 *   node migration/legacy-to-postgres/verify.mjs /path/to/legacy-src.sqlite
 *
 * Row counts are the headline, but counts alone are a weak check: a loader
 * that wrote NULL into every timestamp it could not parse would still produce
 * a perfect count table. So this also verifies, in order of how badly a
 * failure would be missed:
 *
 *   1. Row count, source vs destination, per table.
 *   2. Schema parity — every SQLite column exists in portal. A dropped column
 *      is invisible to a count check.
 *   3. Timestamp fidelity — the earliest and latest instant in the largest
 *      time-bearing columns must agree, which is what catches a timezone
 *      misreading. Reading SQLite's CURRENT_TIMESTAMP as local rather than UTC
 *      shifts every value by the server offset and changes nothing else.
 *   4. Boolean fidelity — the count of true values must equal the count of 1s.
 *   5. Known data-quality facts, restated so they cannot silently change:
 *      the empty-string site ids and the orphaned activity rows.
 *
 * Exit status is non-zero if any check fails, so this is usable in CI.
 */

import {
  connect,
  openSqlite,
  sqliteColumns,
  sqlitePath,
  sqliteTables,
  TARGET_SCHEMA,
} from "./lib/plan.mjs";

/**
 * Columns worth checking for timestamp drift: the busiest instant column in
 * each of the largest tables, plus the two that mix both source formats.
 */
const TIME_CHECKS = [
  ["maintenance_board_cells", "created_at"],
  ["audit_events", "created_at"], // mixes ISO-8601 and CURRENT_TIMESTAMP
  ["item_updates", "created_at"], // mixes both, too
  ["activity_log", "created_at"],
  ["sessions", "issued_at"],
  ["maintenance_requests", "requested_at"],
  ["attachments", "created_at"],
];

/** Boolean columns whose true-count must match the source's count of 1s. */
const BOOL_CHECKS = [
  ["users", "active"],
  ["maintenance_requests", "archived"],
  ["option_values", "is_done"],
  ["maintenance_board_columns", "visible"],
  ["job_access_tokens", "can_comment"],
  ["compliance_documents", "not_required"],
];

function row(cells, widths) {
  return cells
    .map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])))
    .join("  ");
}

async function main() {
  const path = sqlitePath(process.argv.slice(2));
  const db = openSqlite(path);
  const tables = sqliteTables(db);
  const sql = connect();
  let failures = 0;

  try {
    /* ---------------------------------------------------- 1. row counts -- */
    const widths = [30, 10, 12, 6];
    console.log("ROW COUNTS: SQLite (source) vs portal (destination)\n");
    console.log(row(["TABLE", "SOURCE", "DESTINATION", "RESULT"], widths));
    console.log("-".repeat(widths.reduce((a, b) => a + b + 2, 0)));

    let srcTotal = 0;
    let dstTotal = 0;
    const mismatches = [];

    for (const t of tables) {
      const src = db.prepare(`select count(*) as c from "${t}"`).get().c;
      const [{ c: dst }] = await sql.unsafe(
        `select count(*)::int as c from ${TARGET_SCHEMA}."${t}"`,
      );
      srcTotal += Number(src);
      dstTotal += Number(dst);
      const ok = Number(src) === Number(dst);
      if (!ok) {
        failures++;
        mismatches.push({ table: t, src, dst });
      }
      console.log(row([t, src, dst, ok ? "PASS" : "FAIL"], widths));
    }

    console.log("-".repeat(widths.reduce((a, b) => a + b + 2, 0)));
    console.log(
      row(
        ["TOTAL", srcTotal, dstTotal, srcTotal === dstTotal ? "PASS" : "FAIL"],
        widths,
      ),
    );
    if (srcTotal !== dstTotal) failures++;

    if (mismatches.length) {
      console.log("\nMISMATCHED TABLES (explain every one of these):");
      for (const m of mismatches)
        console.log(`  ${m.table}: source ${m.src}, destination ${m.dst}`);
    }

    /* -------------------------------------------------- 2. schema parity -- */
    console.log("\n\nSCHEMA PARITY: every SQLite column present in portal\n");
    const pgCols = await sql`
      select table_name, column_name, data_type
        from information_schema.columns
       where table_schema = ${TARGET_SCHEMA}`;
    const pgMap = new Map();
    for (const c of pgCols) {
      if (!pgMap.has(c.table_name)) pgMap.set(c.table_name, new Map());
      pgMap.get(c.table_name).set(c.column_name, c.data_type);
    }

    let missingCols = 0;
    let colTotal = 0;
    for (const t of tables) {
      const have = pgMap.get(t);
      if (!have) {
        console.log(`  MISSING TABLE: ${t}`);
        missingCols++;
        continue;
      }
      for (const c of sqliteColumns(db, t)) {
        colTotal++;
        if (!have.has(c.name)) {
          console.log(`  MISSING COLUMN: ${t}.${c.name}`);
          missingCols++;
        }
      }
    }
    console.log(
      missingCols === 0
        ? `  PASS — all ${colTotal} legacy columns exist in ${TARGET_SCHEMA}.`
        : `  FAIL — ${missingCols} missing.`,
    );
    if (missingCols) failures++;

    /* ---------------------------------------------- 3. timestamp fidelity -- */
    console.log("\n\nTIMESTAMP FIDELITY: min/max instant must agree\n");
    for (const [t, c] of TIME_CHECKS) {
      const src = db
        .prepare(
          `select min("${c}") as lo, max("${c}") as hi from "${t}" where "${c}" is not null`,
        )
        .get();
      if (!src.lo) {
        console.log(`  ${t}.${c}: no data, skipped`);
        continue;
      }
      const [dst] = await sql.unsafe(
        `select to_char(min("${c}") at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as lo,
                to_char(max("${c}") at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as hi
           from ${TARGET_SCHEMA}."${t}"`,
      );
      // Normalise the source to the same shape: ISO 'T'/'Z' and any fractional
      // seconds removed, bare dates padded to midnight.
      const norm = (v) => {
        let s = String(v).replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");
        return s.length === 10 ? `${s} 00:00:00` : s;
      };
      // min()/max() over mixed text formats in SQLite sort lexically, which is
      // why the source values are normalised before comparison rather than
      // after — 'T' sorts after ' ', so the raw extremes can disagree even when
      // every individual value converted correctly. Compare the converted set
      // instead for the mixed-format columns.
      const rows = db.prepare(`select "${c}" as v from "${t}" where "${c}" is not null`).all();
      const normalised = rows.map((r) => norm(r.v)).sort();
      const lo = normalised[0];
      const hi = normalised[normalised.length - 1];
      const ok = lo === dst.lo && hi === dst.hi;
      if (!ok) failures++;
      console.log(
        `  ${(t + "." + c).padEnd(38)} ${ok ? "PASS" : "FAIL"}  ` +
          `src [${lo} .. ${hi}]  dst [${dst.lo} .. ${dst.hi}]`,
      );
    }

    /* ------------------------------------------------ 4. boolean fidelity -- */
    console.log("\n\nBOOLEAN FIDELITY: count of 1s must equal count of true\n");
    for (const [t, c] of BOOL_CHECKS) {
      const src = db
        .prepare(`select count(*) as n from "${t}" where "${c}" = 1`)
        .get().n;
      const [{ n: dst }] = await sql.unsafe(
        `select count(*)::int as n from ${TARGET_SCHEMA}."${t}" where "${c}" is true`,
      );
      const ok = Number(src) === Number(dst);
      if (!ok) failures++;
      console.log(
        `  ${(t + "." + c).padEnd(38)} ${ok ? "PASS" : "FAIL"}  ` +
          `src ${src} true, dst ${dst} true`,
      );
    }

    /* --------------------------------------- 5. known data-quality facts -- */
    console.log("\n\nKNOWN DATA-QUALITY FACTS (carried across, not repaired)\n");
    const facts = [
      [
        "maintenance_requests with site_id = '' (no FK possible)",
        `select count(*) as n from maintenance_requests where site_id = ''`,
        `select count(*)::int as n from ${TARGET_SCHEMA}.maintenance_requests where site_id = ''`,
      ],
      [
        "attachments with site_id = '' (no FK possible)",
        `select count(*) as n from attachments where site_id = ''`,
        `select count(*)::int as n from ${TARGET_SCHEMA}.attachments where site_id = ''`,
      ],
      [
        "item_activity rows citing a missing job",
        `select count(*) as n from item_activity i where not exists (select 1 from maintenance_requests r where r.id = i.request_id)`,
        `select count(*)::int as n from ${TARGET_SCHEMA}.item_activity i where not exists (select 1 from ${TARGET_SCHEMA}.maintenance_requests r where r.id = i.request_id)`,
      ],
      [
        "maintenance_requests.requested_at at exactly midnight UTC (date-only source)",
        `select count(*) as n from maintenance_requests where length(requested_at) = 10`,
        `select count(*)::int as n from ${TARGET_SCHEMA}.maintenance_requests where requested_at = date_trunc('day', requested_at)`,
      ],
    ];
    for (const [label, srcSql, dstSql] of facts) {
      const src = db.prepare(srcSql).get().n;
      const [{ n: dst }] = await sql.unsafe(dstSql);
      const ok = Number(src) === Number(dst);
      if (!ok) failures++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: src ${src}, dst ${dst}`);
    }

    /* ------------------------------------------------------- public safe -- */
    const [{ count: pub }] = await sql`
      select count(*)::int as count from information_schema.tables
       where table_schema = 'public'`;
    console.log(`\n\npublic schema still has ${pub} tables (must be 23).`);
    if (Number(pub) !== 23) failures++;

    console.log(
      failures === 0
        ? "\nVERIFICATION PASSED — every check green.\n"
        : `\nVERIFICATION FAILED — ${failures} check(s) failed.\n`,
    );
  } finally {
    await sql.end();
    db.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nVERIFY FAILED: ${err.message}`);
  process.exit(1);
});
