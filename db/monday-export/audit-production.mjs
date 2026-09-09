/**
 * A read-only census of the live Production estate, for cutover planning.
 *
 *   node db/monday-export/audit-production.mjs
 *
 * Reads PRODUCTION_DATABASE_URL and writes NOTHING. Three independent guards,
 * because "I meant to only read" is not a safety property:
 *
 *  1. The project ref must be the Production one and must not be Staging's.
 *     Checked against literals, so a swapped environment variable is caught
 *     before a socket is opened rather than after a query has run.
 *  2. Port 5432 — the session pooler. 6543 is the transaction pooler and is a
 *     documented deadlock for this application.
 *  3. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, issued after
 *     connecting and then VERIFIED. This is the one that actually matters: it
 *     is enforced by Postgres, not by this file, so every statement below is
 *     refused by the server if it tries to write. A bug in the SQL here cannot
 *     damage Production because the connection is incapable of it.
 *
 *     NOT passed as a startup parameter, which is what the first version of
 *     this file did. `default_transaction_read_only` in the `connection` block
 *     was silently DROPPED — Supavisor does not forward startup parameters it
 *     does not recognise, so the session came up read-write and the self-test
 *     below correctly failed. A guard that can be silently ignored is not a
 *     guard, which is the entire reason this script verifies rather than
 *     assumes.
 *
 * Guard 3 is self-testing twice over: the setting is read back before any
 * audit query runs (and the script exits if it is not "on"), and a deliberate
 * write is attempted at the end, which Postgres must refuse.
 */

import process from "node:process";

const PRODUCTION_REF = "wghfhtdzxttfhofuljyy";
const STAGING_REF = "ajslebfjwgkvhlntrdmw";

const url = process.env.PRODUCTION_DATABASE_URL;
if (!url) throw new Error("PRODUCTION_DATABASE_URL is not set");

const ref = (/postgres\.([a-z]{20})/.exec(url) ?? [])[1] ?? null;
const port = (/:(\d{4})\//.exec(url) ?? [])[1] ?? null;

if (ref === STAGING_REF) {
  throw new Error(`REFUSED: PRODUCTION_DATABASE_URL points at Staging (${STAGING_REF})`);
}
if (ref !== PRODUCTION_REF) {
  throw new Error(`REFUSED: expected project ${PRODUCTION_REF}, got ${ref ?? "unparseable"}`);
}
if (port !== "5432") {
  throw new Error(`REFUSED: expected the session pooler on 5432, got ${port ?? "unparseable"}`);
}
console.log(`target project : ${ref}`);
console.log(`port           : ${port} (session pooler)`);
console.log(`transaction mode: read-only, enforced by Postgres\n`);

const { default: postgres } = await import("postgres");
const sql = postgres(url, {
  max: 1,
  connect_timeout: 30,
  onnotice: () => {},
  connection: {
    search_path: "portal, pg_catalog",
    application_name: "maintsupp-phase4-readonly-audit",
  },
});

/*
 * The guarantee, applied and then proved before a single audit query runs.
 * `sql.unsafe` because SET takes no parameters.
 */
await sql.unsafe("set session characteristics as transaction read only");
const [mode] = await sql`select current_setting('transaction_read_only') ro`;
if (mode.ro !== "on") {
  await sql.end({ timeout: 5 }).catch(() => {});
  throw new Error(
    `REFUSED: could not put the session into read-only mode (transaction_read_only=${mode.ro}). ` +
      "Refusing to audit Production over a connection that is able to write.",
  );
}
console.log("read-only mode : VERIFIED before any query ran\n");

const table = (rows) => {
  if (!rows.length) return console.log("  (none)");
  console.table(rows);
};

try {
  /* ── Fingerprint ──────────────────────────────────────────────────────── */
  const [who] = await sql`
    select current_database() db, current_user usr,
           inet_server_port()::text port,
           current_setting('transaction_read_only') read_only`;
  console.log("FINGERPRINT");
  console.table([who]);

  /* ── Estate ───────────────────────────────────────────────────────────── */
  const counts = [];
  const add = async (label, query) => {
    try {
      const [row] = await query;
      counts.push({ table: label, rows: Number(row.n) });
    } catch (error) {
      counts.push({ table: label, rows: `ERROR: ${String(error.message).slice(0, 60)}` });
    }
  };

  await add("organisations", sql`select count(*)::int n from portal.organisations`);
  await add("users", sql`select count(*)::int n from portal.users`);
  await add("memberships", sql`select count(*)::int n from portal.memberships`);
  await add("sites", sql`select count(*)::int n from portal.sites`);
  await add("site_aliases", sql`select count(*)::int n from portal.site_aliases`);
  await add("contractors", sql`select count(*)::int n from portal.contractors`);
  await add("contractor_name_aliases", sql`select count(*)::int n from portal.contractor_name_aliases`);
  await add("maintenance_requests", sql`select count(*)::int n from portal.maintenance_requests`);
  await add("maintenance_groups", sql`select count(*)::int n from portal.maintenance_groups`);
  await add("maintenance_group_items", sql`select count(*)::int n from portal.maintenance_group_items`);
  await add("maintenance_board_columns", sql`select count(*)::int n from portal.maintenance_board_columns`);
  await add("maintenance_board_cells", sql`select count(*)::int n from portal.maintenance_board_cells`);
  await add("item_updates", sql`select count(*)::int n from portal.item_updates`);
  await add("attachments", sql`select count(*)::int n from portal.attachments`);
  await add("compliance_documents", sql`select count(*)::int n from portal.compliance_documents`);
  await add("import_anomalies", sql`select count(*)::int n from portal.import_anomalies`);
  await add("units", sql`select count(*)::int n from portal.units`);
  console.log("\nESTATE");
  table(counts);

  /* ── Per organisation ─────────────────────────────────────────────────── */
  console.log("\nPER ORGANISATION");
  table(await sql`
    select o.id, o.name,
           (select count(*)::int from portal.maintenance_requests r where r.organisation_id = o.id) jobs,
           (select count(*)::int from portal.sites s where s.organisation_id = o.id) sites,
           (select count(*)::int from portal.attachments a where a.organisation_id = o.id) attachments,
           (select count(*)::int from portal.item_updates u where u.organisation_id = o.id) updates,
           (select count(*)::int from portal.contractors c where c.organisation_id = o.id) contractors
      from portal.organisations o order by jobs desc`);

  /* ── Money, both ways, so the pence column's state is visible ─────────── */
  console.log("\nMONEY (existing estate)");
  const costPence = await sql`
    select count(*)::int n from information_schema.columns
     where table_schema='portal' and table_name='maintenance_requests' and column_name='cost_pence'`;
  const hasPence = Number(costPence[0].n) > 0;
  console.log(`  cost_pence column present: ${hasPence ? "YES" : "NO — added on first boot of the new build"}`);
  table(await sql`
    select count(*) filter (where cost is not null)::int costed_rows,
           coalesce(sum(cost), 0)::text sum_cost_real,
           coalesce(sum(cost::numeric), 0)::text sum_cost_numeric
      from portal.maintenance_requests`);

  /* ── Board/config rows the migration touches ──────────────────────────── */
  console.log("\nBOARD CONFIGURATION");
  table(await sql`
    select organisation_id, count(*)::int columns
      from portal.maintenance_board_columns group by 1 order by 2 desc`);

  /* ── Does the destination already carry the migration's columns? ──────── */
  console.log("\nMIGRATION COLUMNS ON PRODUCTION (added additively at boot)");
  table(await sql`
    select table_name, column_name
      from information_schema.columns
     where table_schema='portal'
       and (
         (table_name='maintenance_requests' and column_name in
           ('cost_pence','source_item_name','source_group','source_number','source_url','title_rule'))
         or (table_name='attachments' and column_name in
           ('source_asset_id','source_column_id','checksum_sha256'))
         or (table_name='item_updates' and column_name='source_update_id')
       )
     order by table_name, column_name`);

  /* ── Storage-side facts that ARE readable from SQL ────────────────────── */
  console.log("\nDATABASE SIZE");
  table(await sql`
    select pg_size_pretty(pg_database_size(current_database())) database_size,
           (select setting from pg_settings where name='max_connections') max_connections,
           (select setting from pg_settings where name='superuser_reserved_connections') reserved`);

  console.log("\nCONNECTION STATE RIGHT NOW");
  table(await sql`
    select coalesce(nullif(application_name,''),'(none)') app, state, count(*)::int n
      from pg_stat_activity where datname = current_database()
     group by 1,2 order by n desc limit 10`);

  /* ── Prove the read-only guarantee rather than asserting it ───────────── */
  console.log("\nWRITE-PROTECTION SELF-TEST");
  let refused = false;
  try {
    await sql`create temporary table phase4_write_probe (x int)`;
  } catch (error) {
    refused = /read-only|cannot execute/i.test(String(error.message));
    console.log(`  attempted write refused by Postgres: ${String(error.message).slice(0, 90)}`);
  }
  if (!refused) {
    console.log("  *** THE CONNECTION IS NOT READ-ONLY. Treat this audit as unsafe. ***");
    process.exitCode = 1;
  } else {
    console.log("  PASS — this connection provably cannot write.");
  }
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
