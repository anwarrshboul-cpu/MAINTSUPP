import { seedColumns, seedGroups, seedUiColumns } from "./seed-board-structure";
import { seedStoreDocumentationBoard } from "./seed-store-documentation";
import { getD1 } from ".";
import { defaultBoardOptions } from "./seed-options";
import { maintenanceFormConfiguration, maintenanceOptions } from "./monday-board-spec";
import type { BoardOptionColumn } from "../app/lib/types";

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";

/*
 * The second tenant — Stage 19.
 *
 * Multi-tenancy that has only ever been exercised with one organisation is
 * multi-tenancy on paper. "Demo Client Ltd" exists so the isolation rules in
 * `app/lib/tenant-access.ts` have a second side to be tested against, and so a
 * super admin switching client in the sidebar sees the view actually change.
 *
 * Structure only: board, columns, groups and option values, copied from the
 * primary organisation, and not one row of operational data. Every sample-data
 * seeder in the API routes is already guarded on `PRIMARY_ORGANISATION_ID`, so
 * this organisation stays empty by construction rather than by convention.
 */
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";
const DEMO_ORGANISATION_SLUG = "demo-client-ltd";


let initialization: Promise<void> | null = null;

export function ensureDatabase() {
  if (!initialization) {
    initialization = initialize().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

async function initialize() {
  const d1 = await getD1();
  await ensureBaseSchema(d1);
  await ensureBoardEngineColumns(d1);
  await ensureStageOneFoundation(d1);

  /*
   * The second tenant, and the identities that map a sidebar role onto a real
   * membership row. Placed immediately after Stage 1 — which creates the
   * primary organisation, the option sets and `memberships` — and before
   * Stage 3, whose `INSERT … SELECT FROM organisations` materialises a
   * maintenance board for every organisation that exists by then.
   */
  await ensureDemoClientOrganisation(d1);
  await ensureTenantIdentities(d1);

  await ensureStageTwoFoundation(d1);
  await ensureStageThreeBoardEngine(d1);
  await ensureStageFourItems(d1);
  await ensureImportIdentity(d1);
  await ensureStageTwentyAccounts(d1);

  /*
   * The Store Documentation board.
   *
   * Deliberately here and not beside the Stage 1 board seed: `boards` is
   * created by Stage 3, so seeding it any earlier fails on a fresh database
   * with "no such table: boards". Structure only — no stores are invented; real
   * rows arrive through the monday export importer.
   */
  const seedOrganisations = await d1
    .prepare("SELECT id FROM organisations WHERE status = 'active'")
    .all();
  for (const row of (seedOrganisations.results ?? []) as Array<{ id?: string }>) {
    if (row.id) await seedStoreDocumentationBoard(d1, row.id);
  }
  await ensureStageFiveBoardViews(d1);
  await ensureFormBuilder(d1);
  await ensureStageSevenNotifications(d1);
  await renameComplianceKinds(d1);
  await ensureStageNineContractorLinks(d1);
  await ensureStageTwentyThreeRecycleBin(d1);
  await ensureBoardAutomations(d1);
  await ensureCanonicalSiteLink(d1);
}

/**
 * Batch 1B — `site_id` stops lying, and `contractor_id` starts existing.
 *
 * Two things, in an order that is not negotiable.
 *
 * First `site_id` becomes nullable, THEN the placeholders are nulled. The other
 * way round raises "NOT NULL constraint failed", and on this file's boot path
 * that takes every API route down with it. Measured, not assumed.
 *
 * Then `contractor_id` is added beside the legacy `contractor` text, which is
 * never touched. The text is the historical record of who did the work; the id
 * is a live reference. Removing a contractor must not remove the job, so the
 * reference is dropped and the name kept.
 *
 * The dialect split lives in the first half alone, and it is a real one rather
 * than a tidy one. Postgres relaxes the column in place. SQLite has no
 * `ALTER COLUMN ... DROP NOT NULL`; `PRAGMA writable_schema` is refused by both
 * the translator and the driver; and the only remaining move — dropping and
 * recreating a 52-column table on a boot path — would be doing that to
 * Railway's volume of real client data on every deploy. So an existing SQLite
 * database keeps `NOT NULL`, keeps its sentinels, and skips the data step
 * entirely. Fresh databases of either dialect are born nullable from the
 * CREATE TABLE above. Read paths must tolerate both shapes for as long as both
 * exist, which is why `siteIdIsNullable` is published rather than inferred.
 */
async function ensureCanonicalSiteLink(d1: D1DatabaseLike) {
  /*
   * The Postgres half does not run because the code shipped. It runs because
   * somebody set a flag.
   *
   * This file executes on the boot path of every isolate, and a preview deploy
   * points at the shared staging database — so merely deploying would relax a
   * column and null nineteen rows there, on a database other people are writing
   * to, with no migration ledger and no restore point a concurrent writer
   * cannot invalidate. The change is safe and reversible with the backup below;
   * applying it unannounced to a database that is not ours to schedule is not
   * the same question, and it is not this file's to answer.
   *
   * Unset, everything here is a no-op on Postgres and the column stays as it
   * is. The SQLite half is unaffected either way: it has nothing to apply.
   */
  const applyApproved =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.["BATCH_1B_APPLY"] === "1";

  const before = await columnInfo(d1, "maintenance_requests", "site_id");
  if (before && Number(before.notnull) === 1 && usePostgres() && applyApproved) {
    /*
     * Idempotent in Postgres — dropping a NOT NULL that is already gone is a
     * no-op, so two isolates racing this bootstrap cannot make it fail. It is a
     * catalogue change rather than a rewrite, so the lock it takes is held for
     * microseconds however large the table is.
     */
    await d1
      .prepare("ALTER TABLE maintenance_requests ALTER COLUMN site_id DROP NOT NULL")
      .run();
  }

  const after = await columnInfo(d1, "maintenance_requests", "site_id");
  siteIdNullable = after ? Number(after.notnull) === 0 : null;

  if (siteIdNullable === true && (applyApproved || !usePostgres())) {
    /*
     * Three placeholders, one meaning. "site-unassigned" is what the board's
     * inline add writes and matches no row in `sites`. "site-website-intake-…"
     * is the standing bucket the public form used to invent when a typed store
     * name matched nothing. An empty string was never meant to be a value at
     * all. None of them is a site.
     *
     * Deliberately NOT "every id with no matching site": an orphan this does
     * not name is a real id whose site row went missing, which is a fault to
     * report rather than data to erase.
     */
    await d1
      .prepare(
        `UPDATE maintenance_requests
            SET site_id = NULL
          WHERE site_id IS NOT NULL
            AND (TRIM(site_id) = ''
                 OR site_id = 'site-unassigned'
                 OR site_id LIKE 'site-website-intake-%')`,
      )
      .run();
  }

  /*
   * Not behind the flag, deliberately. This is additive — one nullable column
   * and one index, nothing narrowed, nothing rewritten — and `db/schema.ts`
   * declares it, so drizzle asks for `contractor_id` in every select against
   * this table. A database without it would answer "no such column" to every
   * job query on the board. The flag guards the destructive half above, which
   * relaxes a constraint and rewrites rows; this half is what makes the code
   * and the database agree at all.
   */
  await addColumn(
    d1,
    "maintenance_requests",
    "contractor_id",
    "TEXT REFERENCES contractors(id) ON DELETE SET NULL",
  );
  await d1
    .prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_contractor_idx ON maintenance_requests (organisation_id, contractor_id)",
    )
    .run();

  /*
   * The links the register can make on its own, and not one more.
   *
   * A job is attached to a contractor only where the name it carries matches
   * exactly one row in that job's OWN organisation, comparing on trimmed,
   * case-folded text and nothing else. No initials, no first names, no
   * substrings, no similarity: "Saed" is probably "Saed Electrical" and
   * probably is not good enough to put a company's name against an invoice.
   *
   * The `count(*) = 1` is what makes an ambiguous register safe rather than
   * lucky — two contractors sharing a name link neither job. The organisation
   * predicate is inside that count as well as the select, so a same-named
   * contractor in another tenant can neither steal the link nor spoil it.
   *
   * Nothing is created, nothing is overwritten, and the `contractor` text is
   * untouched — it stays the record of who was named on the job. Re-running is
   * a no-op, because only rows still holding no reference are considered.
   */
  await d1
    .prepare(
      `UPDATE maintenance_requests
          SET contractor_id = (
            SELECT c.id FROM contractors c
             WHERE c.organisation_id = maintenance_requests.organisation_id
               AND lower(trim(c.name)) = lower(trim(maintenance_requests.contractor))
          )
        WHERE contractor_id IS NULL
          AND contractor IS NOT NULL
          AND trim(contractor) <> ''
          AND (SELECT count(*) FROM contractors c
                WHERE c.organisation_id = maintenance_requests.organisation_id
                  AND lower(trim(c.name)) = lower(trim(maintenance_requests.contractor))) = 1`,
    )
    .run();
}

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

/**
 * Adds one column, and only where it is missing.
 *
 * SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and this whole file
 * runs on the boot path of every request, so an unguarded ALTER throws
 * "duplicate column name" on the second boot and takes the entire bootstrap —
 * and therefore every API route — down with it. `PRAGMA table_info` is the
 * guard, which is why every stage below goes through this helper rather than
 * issuing ALTERs of its own.
 *
 * A table that does not exist yet reports no columns at all. That is treated as
 * "nothing to extend" rather than an error, so a stage may safely name a table
 * a later stage creates.
 */
async function addColumn(
  d1: D1DatabaseLike,
  table: string,
  column: string,
  definition: string,
) {
  const info = await d1.prepare(`PRAGMA table_info(${table})`).all();
  const columns = (info.results ?? []) as Array<{ name?: string }>;
  if (columns.length === 0) return;
  if (columns.some((row) => row.name === column)) return;
  await d1
    .prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    .run();
}

/**
 * Which dialect `env.DB` is.
 *
 * This file is dialect-shared: with `PG_D1=1` every statement here goes through
 * `db/sqlite-to-postgres.ts` to Supabase, otherwise to a SQLite file. Almost
 * everything is written in the subset both accept, and where it cannot be, this
 * is the flag that decides — the same read `db/node-workers-env.ts` uses to
 * choose the adapter in the first place.
 */
function usePostgres(): boolean {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.["PG_D1"] === "1"
  );
}

/**
 * One column's `PRAGMA table_info` row, or null.
 *
 * Portable on purpose. `db/sqlite-to-postgres.ts` rewrites `PRAGMA table_info`
 * into a catalogue query carrying PRAGMA's own result shape, `notnull`
 * included, so this reads real nullability on BOTH dialects. That is what lets
 * the work below be guarded by what the column actually is rather than by which
 * database we are on — the distinction that keeps it from throwing on a boot
 * path that every API route awaits.
 */
async function columnInfo(
  d1: D1DatabaseLike,
  table: string,
  column: string,
): Promise<{ name?: string; notnull?: number | boolean } | null> {
  const info = await d1.prepare(`PRAGMA table_info(${table})`).all();
  const rows = (info.results ?? []) as Array<{
    name?: string;
    notnull?: number | boolean;
  }>;
  return rows.find((row) => row.name === column) ?? null;
}

/**
 * Whether a job may say it has no site yet.
 *
 * Postgres can relax the column in place and does. An existing SQLite database
 * cannot, so it keeps `NOT NULL` and keeps writing the sentinel — and Railway
 * runs SQLite over a volume of real client data, so this is not a development
 * detail. Writers ask this rather than assume, which is what stops a NULL write
 * raising `NOT NULL constraint failed` on that deployment.
 */
let siteIdNullable: boolean | null = null;

export function siteIdIsNullable(): boolean {
  return siteIdNullable === true;
}

/**
 * The base schema — drizzle/0000 … 0005 applied at runtime.
 *
 * Migrations do not run on the bootstrap path: `npm run dev` starts against an
 * empty Miniflare database and the first request has to find a working schema
 * or the dashboard 500s before it renders. Every statement is
 * `CREATE TABLE IF NOT EXISTS`, so this is a no-op against a database that has
 * already been migrated, and the stage shims that follow bring an older one up
 * to date column by column.
 *
 * Tables are declared in their post-0003 shape rather than their original one.
 * A fresh database would have received 0001–0003 immediately after 0000 in any
 * case, and `ensureLegacyColumns` below covers the only databases that would
 * not: those provisioned between 0000 and 0003.
 */
async function ensureBaseSchema(d1: D1DatabaseLike) {
  await d1.batch([
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS organisations (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         slug TEXT NOT NULL,
         logo_url TEXT,
         primary_colour TEXT NOT NULL DEFAULT '#12B4A8',
         plan_tier TEXT NOT NULL DEFAULT 'development',
         status TEXT NOT NULL DEFAULT 'active',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS organisations_slug_unique ON organisations (slug)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT REFERENCES organisations(id),
         email TEXT NOT NULL,
         full_name TEXT,
         role TEXT NOT NULL DEFAULT 'client_user',
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS memberships (
         id TEXT PRIMARY KEY NOT NULL,
         user_id TEXT NOT NULL REFERENCES users(id),
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         role TEXT NOT NULL,
         site_scope TEXT,
         approval_limit_pence INTEGER,
         status TEXT NOT NULL DEFAULT 'active',
         invited_by TEXT,
         accepted_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS memberships_user_organisation_idx ON memberships (user_id, organisation_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS option_sets (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         key TEXT NOT NULL,
         name TEXT NOT NULL,
         description TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS option_sets_organisation_key_idx ON option_sets (organisation_id, key)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS option_values (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         option_set_id TEXT NOT NULL REFERENCES option_sets(id),
         value TEXT NOT NULL,
         label TEXT NOT NULL,
         colour_hex TEXT NOT NULL,
         text_colour TEXT NOT NULL DEFAULT '#ffffff',
         position INTEGER NOT NULL DEFAULT 0,
         is_done INTEGER NOT NULL DEFAULT 0,
         is_default INTEGER NOT NULL DEFAULT 0,
         active INTEGER NOT NULL DEFAULT 1,
         system INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS option_values_set_value_idx ON option_values (organisation_id, option_set_id, value)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS option_values_set_position_idx ON option_values (organisation_id, option_set_id, position)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS sites (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         name TEXT NOT NULL,
         type TEXT NOT NULL,
         region TEXT NOT NULL DEFAULT 'UK',
         lifecycle TEXT NOT NULL DEFAULT 'Current',
         address TEXT NOT NULL,
         manager TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sites_lifecycle_idx ON sites (lifecycle)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS units (
         id TEXT PRIMARY KEY NOT NULL,
         site_id TEXT NOT NULL REFERENCES sites(id),
         name TEXT NOT NULL,
         category TEXT NOT NULL,
         manufacturer TEXT,
         model TEXT,
         serial_number TEXT,
         status TEXT NOT NULL DEFAULT 'Active',
         notes TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare("CREATE INDEX IF NOT EXISTS units_site_idx ON units (site_id)"),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS contractors (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT REFERENCES organisations(id),
         name TEXT NOT NULL,
         email TEXT,
         phone TEXT,
         service_categories TEXT NOT NULL DEFAULT '[]',
         coverage_areas TEXT NOT NULL DEFAULT '[]',
         certifications TEXT NOT NULL DEFAULT '[]',
         insurance_expiry TEXT,
         availability TEXT NOT NULL DEFAULT 'Available',
         rating REAL,
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    // Kept in step with db/schema.ts, which declares this index but does not
    // provision anything: drizzle-kit is configured for sqlite and writes to
    // `drizzle/`, which nothing on the boot path reads, so an index declared
    // only there exists on no database. Every contractor read is scoped
    // `WHERE organisation_id = ?`, and without this they were sequential scans.
    // `CREATE INDEX IF NOT EXISTS` matches on NAME, so the name here must stay
    // byte-identical to the declaration or this creates a duplicate instead.
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS contractors_organisation_idx ON contractors (organisation_id)",
    ),
    // Held in the post-0003 shape: the seven columns 0001–0003 added are
    // declared here and back-filled onto older databases by
    // `ensureLegacyColumns`.
    /*
     * `site_id` is nullable here: a job whose site is unknown has no site, and
     * the sentinel that stood in for one referenced a row in no table. Only
     * FRESH databases start that way — `ensureCanonicalSiteLink` explains why
     * an existing SQLite one cannot be relaxed in place.
     *
     * The note lives out here rather than in the statement because D1 rejects
     * a `--` comment inside a prepared one, and a failure in this batch takes
     * the whole bootstrap down with it.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_requests (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         site_id TEXT,
         source TEXT NOT NULL DEFAULT 'Portal form',
         title TEXT NOT NULL,
         description TEXT NOT NULL,
         location TEXT NOT NULL,
         requester TEXT NOT NULL,
         contact TEXT NOT NULL,
         category TEXT NOT NULL,
         engineer TEXT NOT NULL,
         tier INTEGER NOT NULL DEFAULT 2,
         priority TEXT NOT NULL DEFAULT 'Medium',
         stage TEXT NOT NULL DEFAULT 'Incoming',
         -- 0000's default was a status the board has since retired and holds
         -- no option row for. This follows schema.ts instead, so a row
         -- inserted without one still renders as a chip.
         status TEXT NOT NULL DEFAULT 'Pending Approval',
         contractor TEXT,
         assignee TEXT,
         approved_by TEXT,
         invoice TEXT,
         form_url TEXT,
         requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         due_at TEXT,
         completed_at TEXT,
         next_update_at TEXT,
         cost REAL,
         attachment_count INTEGER NOT NULL DEFAULT 0,
         issue_attachment_count INTEGER NOT NULL DEFAULT 0,
         completed_attachment_count INTEGER NOT NULL DEFAULT 0,
         general_attachment_count INTEGER NOT NULL DEFAULT 0,
         comment_count INTEGER NOT NULL DEFAULT 0,
         public_upload_token_hash TEXT,
         public_upload_token_expires_at TEXT,
         created_by_email TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_site_idx ON maintenance_requests (site_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_priority_idx ON maintenance_requests (priority)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_groups (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         name TEXT NOT NULL,
         color TEXT NOT NULL DEFAULT '#579bfc',
         stage_key TEXT,
         position INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_group_items (
         request_id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         group_id TEXT NOT NULL,
         position INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_board_columns (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         column_key TEXT NOT NULL,
         title TEXT NOT NULL,
         type TEXT NOT NULL,
         position INTEGER NOT NULL DEFAULT 0,
         width INTEGER NOT NULL DEFAULT 160,
         settings TEXT NOT NULL DEFAULT '{}',
         system INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_board_options (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         column_key TEXT NOT NULL,
         value TEXT NOT NULL,
         label TEXT NOT NULL,
         color TEXT NOT NULL DEFAULT '#579bfc',
         text_color TEXT NOT NULL DEFAULT '#ffffff',
         active INTEGER NOT NULL DEFAULT 1,
         system INTEGER NOT NULL DEFAULT 0,
         position INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS maintenance_board_cells (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         request_id TEXT NOT NULL,
         column_id TEXT NOT NULL,
         value TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_board_cells_request_idx ON maintenance_board_cells (board_id, request_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS attachments (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         request_id TEXT,
         site_id TEXT,
         board_column_id TEXT,
         object_key TEXT NOT NULL,
         original_name TEXT NOT NULL,
         content_type TEXT NOT NULL,
         byte_size INTEGER NOT NULL,
         kind TEXT NOT NULL DEFAULT 'issue',
         uploaded_by_email TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS attachments_object_key_unique ON attachments (object_key)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_request_idx ON attachments (request_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_site_idx ON attachments (site_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_board_column_idx ON attachments (board_column_id, request_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS compliance_documents (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         site_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'Missing',
         expiry_date TEXT,
         attachment_id TEXT,
         not_required INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS compliance_site_kind_idx ON compliance_documents (site_id, kind)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS compliance_expiry_idx ON compliance_documents (expiry_date)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS planned_maintenance (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         site_id TEXT NOT NULL REFERENCES sites(id),
         unit_id TEXT,
         contractor_id TEXT,
         title TEXT NOT NULL,
         category TEXT NOT NULL,
         frequency TEXT NOT NULL,
         next_due_at TEXT NOT NULL,
         last_completed_at TEXT,
         status TEXT NOT NULL DEFAULT 'Scheduled',
         reminder_days INTEGER NOT NULL DEFAULT 30,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS planned_maintenance_due_idx ON planned_maintenance (next_due_at)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS quotations (
         id TEXT PRIMARY KEY NOT NULL,
         request_id TEXT NOT NULL,
         contractor_id TEXT,
         amount REAL NOT NULL,
         status TEXT NOT NULL DEFAULT 'Awaiting approval',
         attachment_id TEXT,
         submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         approved_at TEXT
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS quotations_request_idx ON quotations (request_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS invoices (
         id TEXT PRIMARY KEY NOT NULL,
         request_id TEXT NOT NULL,
         contractor_id TEXT,
         invoice_number TEXT,
         amount REAL NOT NULL,
         status TEXT NOT NULL DEFAULT 'Awaiting payment',
         due_at TEXT,
         paid_at TEXT,
         attachment_id TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS invoices_request_idx ON invoices (request_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS system_notifications (
         id TEXT PRIMARY KEY NOT NULL,
         user_email TEXT NOT NULL,
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         event TEXT NOT NULL,
         title TEXT NOT NULL,
         body TEXT,
         read_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS system_notifications_user_idx ON system_notifications (user_email, read_at)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS leads (
         id TEXT PRIMARY KEY NOT NULL,
         name TEXT NOT NULL,
         company TEXT NOT NULL,
         email TEXT NOT NULL,
         phone TEXT,
         site_range TEXT NOT NULL,
         services TEXT NOT NULL,
         regions TEXT NOT NULL,
         challenge TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'New',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at)",
    ),
    /*
     * Contractor applications from the public /contractors page.
     *
     * A separate table from `leads` rather than a flag on it. A lead is a
     * prospective client and an application is a prospective supplier: they are
     * read by different people, answered differently, and carry different
     * fields — insurance, years trading, certifications and a recorded consent,
     * none of which a lead has. Folding them together would have meant packing
     * four structured answers into the `challenge` free-text column and then
     * teaching every reader of that column to unpack them.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS contractor_applications (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL,
         company TEXT NOT NULL,
         contact_name TEXT NOT NULL,
         email TEXT NOT NULL,
         phone TEXT NOT NULL,
         trades TEXT NOT NULL,
         regions TEXT NOT NULL,
         insured TEXT NOT NULL,
         years_trading TEXT,
         certifications TEXT,
         notes TEXT,
         consent INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'New',
         notified_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS contractor_applications_created_idx ON contractor_applications (organisation_id, created_at)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS activity_log (
         id TEXT PRIMARY KEY NOT NULL,
         client_id TEXT NOT NULL DEFAULT 'sunnamusk-uk',
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         action TEXT NOT NULL,
         actor_email TEXT,
         detail TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS activity_entity_idx ON activity_log (entity_type, entity_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS workspace_settings (
         client_id TEXT PRIMARY KEY NOT NULL DEFAULT 'sunnamusk-uk',
         settings TEXT NOT NULL DEFAULT '{}',
         updated_by_email TEXT,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
  ]);

  await ensureLegacyColumns(d1);
}

/**
 * The columns 0001–0003 added to tables 0000 had already created.
 *
 * Only a database provisioned between those migrations is missing them —
 * `ensureBaseSchema` declares them inline for anything newer — but that is
 * exactly the deployed database this code has to survive meeting.
 */
async function ensureLegacyColumns(d1: D1DatabaseLike) {
  const additions: Array<[string, string, string]> = [
    ["maintenance_requests", "approved_by", "TEXT"],
    ["maintenance_requests", "invoice", "TEXT"],
    ["maintenance_requests", "form_url", "TEXT"],
    ["maintenance_requests", "completed_attachment_count", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_requests", "issue_attachment_count", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_requests", "general_attachment_count", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_requests", "public_upload_token_hash", "TEXT"],
    ["maintenance_requests", "public_upload_token_expires_at", "TEXT"],
    ["attachments", "kind", "TEXT NOT NULL DEFAULT 'issue'"],
    ["attachments", "board_column_id", "TEXT"],
    ["organisations", "logo_url", "TEXT"],
    ["organisations", "primary_colour", "TEXT NOT NULL DEFAULT '#12B4A8'"],
    ["organisations", "plan_tier", "TEXT NOT NULL DEFAULT 'development'"],
    ["organisations", "status", "TEXT NOT NULL DEFAULT 'active'"],
  ];

  for (const [table, column, definition] of additions) {
    await addColumn(d1, table, column, definition);
  }

  /*
   * THE 0002 BACKFILL IS GONE, AND ITS GUARD WAS THE BUG.
   *
   * There used to be an `UPDATE maintenance_requests SET issue_attachment_count
   * = attachment_count WHERE attachment_count > 0 AND issue_attachment_count =
   * 0` here, written for migration 0002 when attachments carried no `kind` and
   * every file on a job really was a fault photograph. Its comment claimed the
   * `= 0` guard meant "a later correction is never overwritten". It means the
   * opposite: zero is the correct, settled answer for a job that has evidence
   * but no fault photographs, so the guard does not PROTECT a corrected row, it
   * SELECTS for it.
   *
   * And `ensureBaseSchema` calls this unconditionally from `initialize()`, so
   * it ran on every cold start of every isolate, in both dialects. Upload a
   * completion photograph to a job with no issue photographs and the next boot
   * declared that completion photograph to be a fault photograph — for ever,
   * re-applying itself after any repair. Measured on staging: all 16 rows fit
   * this and nothing else. MN-1055 held one completion row and one general row
   * and reported two issue photographs; the same statement explains MN-1058 and
   * MN-1050 exactly, and the two jobs that had a genuine issue photo before
   * their first boot were never touched because the guard never held.
   *
   * Nothing replaces it. The counters are recomputed from `attachments` on
   * every write and overruled on every read by `app/lib/attachment-counts.ts`,
   * so there is no longer anything for a boot-time guess to contribute — only
   * something for it to break.
   */
}

/**
 * Board-engine column reconciliation.
 *
 * These six board-column fields, three group fields and three request fields
 * arrived with Stage 3, but `seedBoardStructure` — which runs at the end of
 * Stage 1 — writes to `visible`, `pinned`, `required`, `summary`,
 * `option_set_key`, `description`, `collapsed` and `archived`. While this loop
 * lived inside `ensureStageThreeBoardEngine` it ran *after* that seed, so a
 * freshly provisioned database (the base DDL creates these tables without the
 * newer fields) failed the very first request with
 * `table maintenance_board_columns has no column named visible`, taking every
 * API route and the whole dashboard down with it.
 *
 * It therefore runs immediately after the base DDL batch and before Stage 1.
 * Every entry is an additive `ALTER TABLE … ADD COLUMN` guarded by
 * `PRAGMA table_info`, so it is idempotent and safe on existing databases; all
 * three tables are created in the base batch, so nothing here can run early.
 */
async function ensureBoardEngineColumns(d1: D1DatabaseLike) {
  const additions: Array<[string, string, string]> = [
    ["maintenance_board_columns", "visible", "INTEGER NOT NULL DEFAULT 1"],
    ["maintenance_board_columns", "pinned", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_board_columns", "required", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_board_columns", "summary", "TEXT"],
    ["maintenance_board_columns", "option_set_key", "TEXT"],
    ["maintenance_board_columns", "description", "TEXT"],
    /*
     * Recoverable columns. Nullable and additive: an existing row reads NULL,
     * which is "live", so every board behaves exactly as it did before this
     * ran. Reversible in the only sense that matters — dropping the feature
     * means ignoring these two fields, not migrating anything back.
     */
    ["maintenance_board_columns", "deleted_at", "TEXT"],
    ["maintenance_board_columns", "deleted_by", "TEXT"],
    ["maintenance_groups", "collapsed", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_groups", "archived", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_groups", "description", "TEXT"],
    ["maintenance_requests", "reference", "TEXT"],
    ["maintenance_requests", "archived", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_requests", "archived_at", "TEXT"],
    /*
     * The four things a coordinator needs about a contractor that the register
     * could not hold. The row had a company name, an email and a phone number,
     * so "who do I actually ask for", "where are they", "what did we agree" and
     * "what do they charge" all lived in somebody's head. `day_rate` is stored
     * in pence, like every other money column here, so nothing has to round.
     */
    ["contractors", "contact_name", "TEXT"],
    ["contractors", "address", "TEXT"],
    ["contractors", "notes", "TEXT"],
    ["contractors", "day_rate_pence", "INTEGER"],
    /*
     * WhatsApp, as a number of its own rather than an assumption about the
     * one already there. A contractor's landline and the mobile they answer
     * messages on are routinely different numbers, and treating `phone` as
     * both would put a wa.me link on an office line that will never receive
     * it. Nullable, so every existing contractor reads NULL and the register
     * simply draws no WhatsApp row for them.
     *
     * It belongs HERE rather than in a drizzle migration for the same reason
     * the four columns above do: drizzle/meta stops at 0005, and this list is
     * what actually reconciles a live database on boot — in both dialects,
     * via `sqlite-to-postgres.ts`. A column declared only in the schema and a
     * numbered file is a column that does not exist anywhere it is read.
     */
    ["contractors", "whatsapp_number", "TEXT"],
    /*
     * WORKSTREAM 6 — the commercial, compliance and finance columns the
     * official checklist names and the register could not hold.
     *
     * Every one is nullable, so an existing contractor reads NULL and every
     * screen behaves exactly as it did before. Money is INTEGER pence, like
     * `day_rate_pence` and every other money column here, so nothing rounds.
     *
     * `payment_terms` and `finance_reference` are the approved shape of
     * "payment details": terms the coordinator agreed, and a reference to the
     * supplier record in whichever accounting system already holds the bank
     * details. There is deliberately NO account number, sort code or IBAN
     * column — this repository is public, and an accounting reference is
     * useless to anyone who steals it, which a bank detail is not.
     *
     * `insurer_name`/`policy_number`/`insurance_notes` give the existing bare
     * `insurance_expiry` an identity: a date on its own cannot answer "expiring
     * with whom, under which policy".
     */
    ["contractors", "postcode", "TEXT"],
    ["contractors", "call_out_cost_pence", "INTEGER"],
    ["contractors", "hourly_rate_pence", "INTEGER"],
    ["contractors", "other_cost_pence", "INTEGER"],
    ["contractors", "other_cost_label", "TEXT"],
    ["contractors", "payment_terms", "TEXT"],
    ["contractors", "finance_reference", "TEXT"],
    ["contractors", "insurer_name", "TEXT"],
    ["contractors", "policy_number", "TEXT"],
    ["contractors", "insurance_notes", "TEXT"],
    /*
     * WORKSTREAM 7 — a document's own identity. See the block comment on
     * `attachments` in db/schema.ts for what each column is for.
     *
     * They belong in THIS list for the reason the WhatsApp note above gives:
     * drizzle/meta stops at 0005, and this list is what actually reconciles a
     * live database on boot, in both dialects via `sqlite-to-postgres.ts`. The
     * Postgres side already has these columns from the Workstream 7 migration —
     * `addColumn` guards on `PRAGMA table_info`, so on that deployment every one
     * of these is a no-op, and on a fresh SQLite file they are what makes the
     * feature exist at all. A column declared only in the schema file is a
     * column that does not exist anywhere it is read.
     *
     * Every one is nullable or carries a default that reproduces the
     * pre-migration meaning: an existing attachment reads NULL title, NULL
     * expiry, NULL lineage, `version_no = 1` and `is_current = 1`, which is
     * exactly "the only version of itself, live". Nothing has to be back-filled.
     *
     * The two UNIQUE version indexes and the CHECK on `expiry_date` are NOT
     * created here. They exist on Postgres, where the data they protect lives,
     * and SQLite cannot add either to an existing table without rebuilding it —
     * which this boot path must never do to a table holding evidence. The code
     * validates both regardless (`expiryRefusal`, and the read-modify-write in
     * `addDocumentVersion`), so correctness does not depend on which dialect is
     * underneath; on Postgres the constraints are the second line of defence.
     */
    ["attachments", "title", "TEXT"],
    ["attachments", "document_type", "TEXT"],
    ["attachments", "description", "TEXT"],
    ["attachments", "expiry_date", "TEXT"],
    ["attachments", "metadata_updated_at", "TEXT"],
    ["attachments", "metadata_updated_by", "TEXT"],
    ["attachments", "contractor_id", "TEXT"],
    ["attachments", "archived_at", "TEXT"],
    ["attachments", "archived_by", "TEXT"],
    ["attachments", "root_document_id", "TEXT"],
    ["attachments", "version_no", "INTEGER NOT NULL DEFAULT 1"],
    ["attachments", "is_current", "INTEGER NOT NULL DEFAULT 1"],
  ];

  for (const [table, column, definition] of additions) {
    await addColumn(d1, table, column, definition);
  }

  await ensureDocumentVersionInvariant(d1);
}

/**
 * ONE CURRENT VERSION PER LINEAGE, ENFORCED BY THE DATABASE.
 *
 * Workstream 7 gave documents version lineage and left the invariant to the
 * code: `standDownPredecessor` clears the old head, then the successor is
 * inserted as the new one. Those are two statements with no transaction around
 * them, so they are not atomic — and on D1 nothing else was stopping a race.
 * Three concurrent `POST /api/files` carrying the same `replaces` all answered
 * 201 and left the lineage with THREE rows at `is_current = 1`; the board and
 * the file list then showed one certificate three times.
 *
 * Postgres never had that problem, because the Workstream 7 migration created
 * these two indexes there: the second head is rejected by the database, the
 * insert throws, and the route's catch deletes the orphaned object and restores
 * the predecessor. `db/init.ts` is the authority for the D1/SQLite schema and it
 * created neither — it added the three columns and stopped. So the invariant
 * existed on one backend of two, and the one it was missing from is what local
 * development and every Cloudflare deployment run on.
 *
 * SQLite has supported partial indexes since 3.8.0 and indexes on expressions
 * since 3.9.0, so both are expressible verbatim. The names are the ones already
 * on Staging, so on the Postgres path each statement is an IF NOT EXISTS no-op
 * rather than a second, differently-named copy of an index that exists.
 *
 * `is_current = 1` rather than a bare `WHERE is_current`: the column is INTEGER
 * on D1 and a real `boolean` on Postgres, and `db/sqlite-to-postgres.ts` rewrites
 * `= 1` to `= true` for the columns it knows are boolean — which is exactly why
 * `is_current` had to be added to `BOOLEAN_COLUMNS`. A bare predicate would be
 * valid SQLite and invalid Postgres, and the rewriter has nothing to grip on.
 */
async function ensureDocumentVersionInvariant(d1: D1DatabaseLike) {
  /*
   * A UNIQUE INDEX CANNOT BE CREATED OVER DATA THAT ALREADY VIOLATES IT, and
   * this file runs on the boot path of EVERY request. A database that raced
   * before this shipped holds duplicate heads, so creating the index first would
   * throw on every request and take the whole application down — the same
   * failure mode `addColumn` exists to prevent for ALTER.
   *
   * So the duplicates are repaired first, and the repair is the rule the write
   * path already uses: the HIGHEST `version_no` in a lineage is the head, and
   * every other row in it is stood down. Highest rather than newest by
   * `created_at`, because `version_no` is what orders a lineage everywhere else
   * and it is the value the second index protects.
   *
   * Ties break on `id` so the choice is deterministic: two rows that raced to
   * the same `version_no` are indistinguishable by date at this resolution, and
   * an arbitrary-but-stable winner beats a repair that picks a different row on
   * every boot.
   */
  try {
    await d1
      .prepare(
        `UPDATE attachments SET is_current = 0
          WHERE is_current = 1
            AND id NOT IN (
              SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                         PARTITION BY organisation_id, COALESCE(root_document_id, id)
                         ORDER BY version_no DESC, id DESC
                       ) AS position
                  FROM attachments
                 WHERE is_current = 1
              ) ranked
              WHERE ranked.position = 1
            )`,
      )
      .run();
  } catch (error) {
    /*
     * Swallowed, loudly. A repair that cannot run must not stop the application
     * from starting — and if it did not run, the index below simply fails to be
     * created and the invariant stays exactly where it was rather than becoming
     * an outage.
     */
    console.error("[init] could not repair duplicate document heads", error);
  }

  /*
   * Each index in its own statement and its own catch, NOT in a `batch()`.
   *
   * A batch fails as a unit, so one index that could not be created would
   * discard the other, and the two are independent guarantees. Catching means a
   * database whose duplicates the repair could not resolve still boots, and an
   * unenforced invariant is reported rather than turned into a 500 on every
   * request.
   */
  const indexes = [
    // ONE head per lineage. This is the one that stops the concurrent replace.
    `CREATE UNIQUE INDEX IF NOT EXISTS attachments_current_version_idx
       ON attachments (organisation_id, COALESCE(root_document_id, id))
       WHERE is_current = 1`,
    // And no two rows claiming to be the same version of the same document.
    `CREATE UNIQUE INDEX IF NOT EXISTS attachments_root_version_idx
       ON attachments (organisation_id, COALESCE(root_document_id, id), version_no)`,
  ];
  for (const statement of indexes) {
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      console.error(
        "[init] could not create a document version index; the one-current-head invariant is NOT enforced on this database",
        { statement, error },
      );
    }
  }
}

async function ensureStageOneFoundation(d1: D1DatabaseLike) {

  const tenantTables = [
    "sites",
    "units",
    "maintenance_requests",
    "planned_maintenance",
    "quotations",
    "invoices",
    "system_notifications",
    "leads",
    "activity_log",
    "attachments",
    "compliance_documents",
    "workspace_settings",
    "maintenance_groups",
    "maintenance_group_items",
    "maintenance_board_options",
    "maintenance_board_columns",
    "maintenance_board_cells",
  ];
  for (const table of tenantTables) {
    await addColumn(
      d1,
      table,
      "organisation_id",
      "TEXT REFERENCES organisations(id)",
    );
  }

  // The tenant indexes 0006 creates. Held here rather than in the base batch
  // because the column they key off has only just been added above.
  await d1.batch([
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sites_organisation_idx ON sites (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS units_organisation_idx ON units (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_organisation_stage_idx ON maintenance_requests (organisation_id, stage)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS planned_maintenance_organisation_idx ON planned_maintenance (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS quotations_organisation_idx ON quotations (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS invoices_organisation_idx ON invoices (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS system_notifications_organisation_idx ON system_notifications (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS leads_organisation_idx ON leads (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS activity_organisation_idx ON activity_log (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_organisation_idx ON attachments (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS compliance_organisation_idx ON compliance_documents (organisation_id)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_settings_organisation_idx ON workspace_settings (organisation_id)",
    ),
    /*
     * The two list queries every board and dashboard load runs.
     *
     * Neither had an index whose second column is a date, so SQLite fell back
     * to the bare organisation prefix of maintenance_requests_external_idx and
     * finished with USE TEMP B-TREE FOR ORDER BY -- a full sort of every job in
     * the workspace, on every request. Confirmed against the real 775-row board:
     * both plans lose the temp B-tree once these exist.
     */
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_org_archived_created_idx ON maintenance_requests (organisation_id, archived, created_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_org_requested_idx ON maintenance_requests (organisation_id, requested_at)",
    ),
    // The attachment counts joined onto every board payload, which were a
    // GROUP BY over an organisation-wide scan.
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_org_column_request_idx ON attachments (organisation_id, board_column_id, request_id)",
    ),
  ]);


  await d1
    .prepare(
      `INSERT OR IGNORE INTO organisations
        (id, name, slug, primary_colour, plan_tier, status)
       VALUES (?, 'Sunnamusk UK', 'sunnamusk-uk', '#12B4A8', 'development', 'active')`,
    )
    .bind(PRIMARY_ORGANISATION_ID)
    .run();

  const organisationResult = await d1
    .prepare(
      "SELECT id FROM organisations WHERE status = 'active' ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
    )
    .bind(PRIMARY_ORGANISATION_ID)
    .first<{ id: string }>();
  const organisationId = organisationResult?.id ?? PRIMARY_ORGANISATION_ID;

  for (const table of ["users", "contractors", ...tenantTables]) {
    await d1
      .prepare(
        `UPDATE ${table} SET organisation_id = ? WHERE organisation_id IS NULL`,
      )
      .bind(organisationId)
      .run();
  }


  await d1
    .prepare(
      `INSERT OR IGNORE INTO memberships
        (id, user_id, organisation_id, role, status, accepted_at)
       SELECT 'membership-' || id, id, organisation_id,
         CASE lower(role)
           WHEN 'super admin' THEN 'super_admin'
           WHEN 'admin' THEN 'admin'
           ELSE 'client'
         END,
         'active', CURRENT_TIMESTAMP
       FROM users WHERE organisation_id IS NOT NULL`,
    )
    .run();

  const setDefinitions = [
    ["maintenance_status", "Maintenance status", "Workflow states for maintenance tickets"],
    ["maintenance_label", "Maintenance label", "Maintenance issue labels"],
    ["engineer_required", "Engineer required", "Trade or engineer requirement"],
    ["priority", "Priority", "Maintenance request priority"],
    ["tier_level", "Tier level", "Service tier"],
    ["store_location", "Store location name", "The 21 UK store locations"],
    ["site_type", "Site type", "Property or operating-unit type"],
    ["site_status", "Site status", "Lifecycle state of a site"],
    ["site_group_kind", "Site group kind", "Category of site grouping used for reporting"],
    ["unit_category", "Unit category", "Asset category for the unit register"],
    ["unit_status", "Unit status", "Operating state of an asset"],
    ["access_method", "Access method", "How access to a site is arranged"],
    /*
     * WORKSTREAM 6 — the two contractor vocabularies that were free text.
     *
     * `contractor_trade` exists because `contractors.service_categories` is a
     * comma-split JSON array of whatever was typed, so "Electrical",
     * "electrical" and "Electrics" were three different trades and the register
     * could not be filtered or reported on by trade at all. The values below are
     * EXACTLY the eleven the public application form already offers
     * (`TRADES` in app/api/contractor-applications/route.ts), in its order —
     * two vocabularies for one concept is the thing being fixed, so this must
     * not become a third.
     *
     * `contractor_payment_terms` is half of the approved shape of "payment
     * details". The other half is `contractors.finance_reference`, a pointer to
     * the supplier record in the accounting system that already holds the bank
     * details under its own controls. There is deliberately no account number,
     * sort code or IBAN anywhere: this repository is public, and a stolen
     * accounting reference buys an attacker nothing.
     */
    ["contractor_trade", "Contractor trade", "Trades a contractor covers"],
    ["contractor_payment_terms", "Payment terms", "Agreed payment terms for a contractor"],
  ] as const;
  const setIds = new Map<string, string>();
  for (const [key, name, description] of setDefinitions) {
    const existing = await d1
      .prepare(
        "SELECT id FROM option_sets WHERE organisation_id = ? AND key = ? LIMIT 1",
      )
      .bind(organisationId, key)
      .first<{ id: string }>();
    const id =
      existing?.id ??
      (organisationId === PRIMARY_ORGANISATION_ID
        ? `set-${key.replaceAll("_", "-")}`
        : `set-${organisationId}-${key}`);
    if (!existing) {
      await d1
        .prepare(
          "INSERT OR IGNORE INTO option_sets (id, organisation_id, key, name, description) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id, organisationId, key, name, description)
        .run();
    }
    setIds.set(key, id);
  }

  const columnSetKey: Record<BoardOptionColumn, string> = {
    status: "maintenance_status",
    label: "maintenance_label",
    engineer: "engineer_required",
    priority: "priority",
    tier: "tier_level",
    storeLocation: "store_location",
  };
  for (const option of defaultBoardOptions) {
    const key = columnSetKey[option.columnKey];
    const setId = setIds.get(key);
    if (!setId) continue;
    const id = `runtime-${organisationId}-${option.columnKey}-${option.position}`;
    await d1
      .prepare(
        `INSERT OR IGNORE INTO option_values
          (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      )
      .bind(
        id,
        organisationId,
        setId,
        option.value,
        option.label,
        option.color,
        option.textColor,
        option.position,
        option.columnKey === "status" &&
          ["Job Completed", "Completed"].includes(option.value)
          ? 1
          : 0,
        option.value === "Medium" || option.value === "2" ? 1 : 0,
      )
      .run();
  }

  // Stage 2 seeds. These are starting rows, not a fixed list — an admin adds a
  // fifth site type or a sixth status in the options screen with no deploy.
  const stageTwoSeeds: Record<string, ReadonlyArray<readonly [string, string, string, string]>> = {
    site_status: [
      ["active", "Active", "#12B4A8", "#101820"],
      ["closed", "Closed", "#e2445c", "#ffffff"],
      ["international", "International", "#579bfc", "#ffffff"],
      ["other", "Other", "#5c82af", "#ffffff"],
    ],
    site_group_kind: [
      ["region", "Region", "#12B4A8", "#101820"],
      ["portfolio", "Portfolio", "#a25ddc", "#ffffff"],
      ["cluster", "Cluster", "#fdab3d", "#101820"],
    ],
    unit_category: [
      ["Air conditioning", "Air conditioning", "#579bfc", "#ffffff"],
      ["Refrigeration", "Refrigeration", "#12B4A8", "#101820"],
      ["Electrical", "Electrical", "#fdab3d", "#101820"],
      ["Lighting", "Lighting", "#f0a91f", "#101820"],
      ["Security", "Security", "#a25ddc", "#ffffff"],
      ["Shopfront", "Shopfront", "#5c82af", "#ffffff"],
      ["Other", "Other", "#808799", "#ffffff"],
    ],
    access_method: [
      ["Email the centre", "Email the centre", "#579bfc", "#ffffff"],
      ["Contractor portal", "Contractor portal", "#a25ddc", "#ffffff"],
      ["Phone ahead", "Phone ahead", "#fdab3d", "#101820"],
      ["Key holder on site", "Key holder on site", "#12B4A8", "#101820"],
      ["No restriction", "No restriction", "#808799", "#ffffff"],
    ],
    unit_status: [
      ["Active", "Active", "#12B4A8", "#101820"],
      ["Inactive", "Inactive", "#5c82af", "#ffffff"],
      ["Out of service", "Out of service", "#e2445c", "#ffffff"],
      ["Retired", "Retired", "#808799", "#ffffff"],
    ],
    /*
     * The eleven trades the public form offers, verbatim and in its order. If
     * that list ever changes, change it there and here together — the whole
     * point of this set is that an applicant and the register mean the same
     * thing by "Glazing".
     */
    contractor_trade: [
      ["Electrical & lighting", "Electrical & lighting", "#fdab3d", "#101820"],
      ["Plumbing & leaks", "Plumbing & leaks", "#579bfc", "#ffffff"],
      ["Doors, locks & shutters", "Doors, locks & shutters", "#5c82af", "#ffffff"],
      ["HVAC & air conditioning", "HVAC & air conditioning", "#12B4A8", "#101820"],
      ["Glazing", "Glazing", "#9cd326", "#101820"],
      ["Signage", "Signage", "#a25ddc", "#ffffff"],
      ["Drainage", "Drainage", "#037f4c", "#ffffff"],
      ["General maintenance & handyman", "General maintenance & handyman", "#808799", "#ffffff"],
      ["Fire & compliance", "Fire & compliance", "#e2445c", "#ffffff"],
      ["CCTV & security", "CCTV & security", "#401694", "#ffffff"],
      ["Other", "Other", "#808799", "#ffffff"],
    ],
    /*
     * Terms, not credentials. "Other" is last so the list stays usable without
     * becoming a free-text field by the back door.
     */
    contractor_payment_terms: [
      ["On completion", "On completion", "#12B4A8", "#101820"],
      ["7 days", "7 days", "#9cd326", "#101820"],
      ["14 days", "14 days", "#fdab3d", "#101820"],
      ["30 days", "30 days", "#579bfc", "#ffffff"],
      ["60 days", "60 days", "#5c82af", "#ffffff"],
      ["Other", "Other", "#808799", "#ffffff"],
    ],
  };
  for (const [key, values] of Object.entries(stageTwoSeeds)) {
    const setId = setIds.get(key);
    if (!setId) continue;
    for (const [position, [value, label, colour, textColour]] of values.entries()) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO option_values
            (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 1)`,
        )
        .bind(
          `runtime-${organisationId}-${key}-${position}`,
          organisationId,
          setId,
          value,
          label,
          colour,
          textColour,
          position,
          position === 0 ? 1 : 0,
        )
        .run();
    }
  }

  const siteTypeSetId = setIds.get("site_type");
  if (siteTypeSetId) {
    const siteTypes = [
      ["Inline", "Inline", "#12B4A8", "#101820"],
      ["Kiosk", "Kiosk", "#579bfc", "#ffffff"],
      ["Office", "Office", "#a25ddc", "#ffffff"],
      ["Warehouse", "Warehouse", "#fdab3d", "#101820"],
    ] as const;
    for (const [position, [value, label, colour, textColour]] of siteTypes.entries()) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO option_values
            (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 1)`,
        )
        .bind(
          `runtime-${organisationId}-site-${position}`,
          organisationId,
          siteTypeSetId,
          value,
          label,
          colour,
          textColour,
          position,
          position === 0 ? 1 : 0,
        )
        .run();
    }
  }

  // N11 / O13 — seed the board's columns and groups for this organisation.
  // Idempotent, and never restores something an admin has deleted.
  await seedBoardStructure(d1, organisationId);
}

/**
 * Creates the empty second tenant and copies the primary organisation's
 * *structure* into it — Stage 19.
 *
 * Copied rather than restated so the two organisations cannot drift: whatever
 * option sets and values the primary organisation ends up with, this one gets
 * the same shape. Ids are derived from the source row's id, which makes every
 * statement here idempotent under `INSERT OR IGNORE` and means a re-run never
 * duplicates an option or resurrects one an admin has deleted.
 *
 * What is deliberately NOT copied: sites, units, maintenance requests,
 * compliance documents, board cells — every table that holds operational data.
 * The requirement is a second client with a genuinely different (empty) view,
 * not a second copy of Sunnamusk's estate under another name.
 */
async function ensureDemoClientOrganisation(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO organisations
        (id, name, slug, primary_colour, plan_tier, status)
       VALUES (?, 'Demo Client Ltd', ?, '#5c82af', 'development', 'active')`,
    )
    .bind(DEMO_ORGANISATION_ID, DEMO_ORGANISATION_SLUG)
    .run();

  // An organisation an admin has since suspended must not be re-seeded.
  const demo = (await d1
    .prepare(
      "SELECT id FROM organisations WHERE id = ? AND status = 'active' LIMIT 1",
    )
    .bind(DEMO_ORGANISATION_ID)
    .first()) as { id?: string } | null;
  if (!demo?.id) return;

  await d1
    .prepare(
      `INSERT OR IGNORE INTO option_sets (id, organisation_id, key, name, description)
       SELECT 'set-' || ? || '-' || source.key, ?, source.key, source.name, source.description
         FROM option_sets source
        WHERE source.organisation_id = ?`,
    )
    .bind(DEMO_ORGANISATION_ID, DEMO_ORGANISATION_ID, PRIMARY_ORGANISATION_ID)
    .run();

  // Joined through the set *key* rather than the set id, because the two
  // organisations' sets are different rows describing the same vocabulary.
  await d1
    .prepare(
      `INSERT OR IGNORE INTO option_values
         (id, organisation_id, option_set_id, value, label, colour_hex, text_colour,
          position, is_done, is_default, active, system)
       SELECT 'value-' || ? || '-' || source_value.id, ?, target_set.id,
              source_value.value, source_value.label, source_value.colour_hex,
              source_value.text_colour, source_value.position, source_value.is_done,
              source_value.is_default, source_value.active, source_value.system
         FROM option_values source_value
         JOIN option_sets source_set ON source_set.id = source_value.option_set_id
         JOIN option_sets target_set
           ON target_set.key = source_set.key AND target_set.organisation_id = ?
        WHERE source_value.organisation_id = ?`,
    )
    .bind(
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      PRIMARY_ORGANISATION_ID,
    )
    .run();

  // The maintenance board's columns and groups. The Store Documentation board
  // is seeded by the per-organisation loop in `initialize()`, and the board's
  // status/label/priority chips by `ensureBoardState` on first view.
  await seedBoardStructure(d1, DEMO_ORGANISATION_ID);
}

/**
 * The demo identities behind the sidebar's role selector — Stage 19.
 *
 * `app/lib/tenant-access.ts` answers "which organisations may this request
 * read?" from `memberships`, so the role selector only means anything if each
 * role resolves to a user that actually holds a membership. These are those
 * users. Two families:
 *
 *   • the three unqualified identities (`super-admin@`, `admin@`, `client@`
 *     test.maintsupp.com) that a browser with no identity cookie falls back to.
 *     The two non-super-admin ones belong to Sunnamusk UK, which is what makes
 *     the default view the real estate rather than an empty one;
 *   • a per-organisation pair (`admin@<slug>.` / `client@<slug>.`) so a super
 *     admin can drop into any tenant as that tenant's own admin or client.
 *
 * The super admin is a member of every organisation, which is what "only the
 * super admins have the view on everything" reduces to once the rule is read
 * from the database instead of from a cookie.
 *
 * Idempotent throughout, and it never touches the three pre-existing users or
 * their memberships.
 */
async function ensureTenantIdentities(d1: D1DatabaseLike) {
  const organisationRows = await d1
    .prepare(
      `SELECT id, slug FROM organisations
        WHERE status = 'active'
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC`,
    )
    .bind(PRIMARY_ORGANISATION_ID)
    .all();
  const organisationList = (organisationRows.results ?? []) as Array<{
    id?: string;
    slug?: string;
  }>;
  if (!organisationList.length) return;
  const primary =
    organisationList.find((row) => row.id === PRIMARY_ORGANISATION_ID) ??
    organisationList[0];
  if (!primary?.id) return;

  const userId = (email: string) =>
    `user-${email.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  async function upsertIdentity(
    email: string,
    fullName: string,
    userRole: string,
    homeOrganisationId: string,
    grants: Array<{ organisationId: string; role: string }>,
  ) {
    const id = userId(email);
    await d1
      .prepare(
        `INSERT OR IGNORE INTO users (id, organisation_id, email, full_name, role, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .bind(id, homeOrganisationId, email, fullName, userRole)
      .run();

    // The email is unique, so a database that already carries this identity
    // under a different id must be honoured rather than shadowed.
    const stored = (await d1
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1")
      .bind(email)
      .first()) as { id?: string } | null;
    const resolvedId = stored?.id ?? id;

    for (const grant of grants) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO memberships
             (id, user_id, organisation_id, role, status, accepted_at)
           VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`,
        )
        .bind(
          `membership-${resolvedId}-${grant.organisationId}`,
          resolvedId,
          grant.organisationId,
          grant.role,
        )
        .run();
    }
  }

  const everyOrganisation = organisationList
    .filter((row): row is { id: string; slug?: string } => Boolean(row.id))
    .map((row) => ({ organisationId: row.id, role: "super_admin" }));

  await upsertIdentity(
    "super-admin@test.maintsupp.com",
    "Super Admin (testing)",
    "Super Admin",
    primary.id,
    everyOrganisation,
  );
  await upsertIdentity(
    "admin@test.maintsupp.com",
    "Admin (testing)",
    "Admin",
    primary.id,
    [{ organisationId: primary.id, role: "admin" }],
  );
  await upsertIdentity(
    "client@test.maintsupp.com",
    "Client (testing)",
    "Client",
    primary.id,
    [{ organisationId: primary.id, role: "client" }],
  );

  // The existing superadmin@ account predates the role selector and is a member
  // of the primary organisation only. Widen it to every organisation so the one
  // real super admin on the database also sees everything.
  const legacySuperAdmins = await d1
    .prepare(
      "SELECT user_id FROM memberships WHERE role = 'super_admin' AND status = 'active'",
    )
    .all();
  for (const row of (legacySuperAdmins.results ?? []) as Array<{
    user_id?: string;
  }>) {
    if (!row.user_id) continue;
    for (const grant of everyOrganisation) {
      await d1
        .prepare(
          `INSERT OR IGNORE INTO memberships
             (id, user_id, organisation_id, role, status, accepted_at)
           VALUES (?, ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP)`,
        )
        .bind(
          `membership-${row.user_id}-${grant.organisationId}`,
          row.user_id,
          grant.organisationId,
        )
        .run();
    }
  }

  for (const organisation of organisationList) {
    if (!organisation.id || !organisation.slug) continue;
    for (const role of ["admin", "client"] as const) {
      await upsertIdentity(
        `${role}@${organisation.slug}.test.maintsupp.com`,
        `${organisation.slug} ${role} (testing)`,
        role === "admin" ? "Admin" : "Client",
        organisation.id,
        [{ organisationId: organisation.id, role }],
      );
    }
  }
}

/**
 * Stage 2 compatibility.
 *
 * Mirrors drizzle/0007_stage_two_sites_units.sql for databases that were
 * provisioned before that migration existed. Every operation is additive and
 * idempotent. Groups G1/G2 remove this whole runtime path in Stage 8 once
 * migrations run at deploy time; until then an existing database that never
 * saw the migration must not fail on first request.
 */
async function ensureStageTwoFoundation(d1: D1DatabaseLike) {
  const siteColumns: Array<[string, string]> = [
    ["slug", "text"],
    ["code", "text"],
    ["site_type_value", "text"],
    ["status", "text DEFAULT 'active' NOT NULL"],
    ["address_line1", "text"],
    ["address_line2", "text"],
    ["city", "text"],
    ["postcode", "text"],
    ["country", "text DEFAULT 'United Kingdom' NOT NULL"],
    ["latitude", "real"],
    ["longitude", "real"],
    ["position", "integer DEFAULT 0 NOT NULL"],
    ["active", "integer DEFAULT 1 NOT NULL"],
    ["manager_name", "text"],
    ["manager_phone", "text"],
    ["manager_email", "text"],
    ["landlord", "text"],
    ["managing_agent", "text"],
    ["out_of_hours_contact", "text"],
    ["access_method", "text"],
    ["access_contact", "text"],
    ["access_url", "text"],
    ["access_notes", "text"],
    ["opening_hours", "text"],
    ["delivery_restrictions", "text"],
    ["parking_notes", "text"],
    ["key_alarm_notes", "text"],
    ["lease_start", "text"],
    ["lease_end", "text"],
    ["break_clause", "text"],
    ["rent_review", "text"],
    ["service_charge_pence", "integer"],
    ["annual_budget_pence", "integer"],
    ["monday_maintenance_name", "text"],
    ["monday_compliance_name", "text"],
    ["notes", "text"],
  ];
  for (const [column, definition] of siteColumns) {
    await addColumn(d1, "sites", column, definition);
  }

  const unitColumns: Array<[string, string]> = [
    ["asset_tag", "text"],
    ["location_in_site", "text"],
    ["installed_at", "text"],
    ["warranty_expiry", "text"],
    ["purchase_price_pence", "integer"],
    ["supplier", "text"],
    ["last_serviced_at", "text"],
    ["next_service_due_at", "text"],
    ["service_interval_months", "integer"],
    ["position", "integer DEFAULT 0 NOT NULL"],
  ];
  for (const [column, definition] of unitColumns) {
    await addColumn(d1, "units", column, definition);
  }

  await addColumn(d1, "attachments", "unit_id", "text");
  // The comment a file belongs to, when it belongs to one rather than to
  // the job itself. monday updates carry their own assets.
  await addColumn(d1, "attachments", "update_id", "text");
  await d1
    .prepare(
      "CREATE INDEX IF NOT EXISTS attachments_update_idx ON attachments(update_id)",
    )
    .run();

  await d1.batch([
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS unit_service_records (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         unit_id TEXT NOT NULL REFERENCES units(id),
         site_id TEXT NOT NULL REFERENCES sites(id),
         performed_at TEXT NOT NULL,
         service_type TEXT NOT NULL DEFAULT 'Service',
         contractor_id TEXT,
         contractor_name TEXT,
         request_id TEXT,
         outcome TEXT,
         cost_pence INTEGER,
         notes TEXT,
         recorded_by_email TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS unit_service_unit_idx ON unit_service_records (unit_id, performed_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS unit_service_organisation_idx ON unit_service_records (organisation_id)",
    ),

    // X11 — the alias table that reconciles a store's monday maintenance name
    // against its Store Documentation name.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS site_aliases (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         site_id TEXT NOT NULL REFERENCES sites(id),
         alias TEXT NOT NULL,
         normalised TEXT NOT NULL,
         source TEXT NOT NULL DEFAULT 'manual',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS site_aliases_site_idx ON site_aliases (site_id)",
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS site_aliases_organisation_normalised_idx ON site_aliases (organisation_id, normalised)",
    ),

    /*
     * A site code is an IDENTITY, so the database has to be the thing that says so.
     *
     * `codeConflict()` in the sites repository refuses a duplicate with a helpful
     * 409, and it is worth keeping for that message — but a SELECT followed by an
     * INSERT cannot enforce uniqueness on its own. QA reproduced both ways through
     * on the first attempt: eight concurrent POSTs claiming one code all answered
     * 200 and left eight sites sharing it, and the CSV importer, which never called
     * the check at all, produced a duplicate from a single two-row sheet with no
     * concurrency whatsoever.
     *
     * It matters because `resolveSiteByName` treats a code as an identity and
     * returns the FIRST row that matches one, so two sites wearing the same code
     * make job intake non-deterministic — work attaches to whichever shop the
     * query happened to return.
     *
     * NULL is distinct from NULL under UNIQUE in both SQLite and Postgres, so the
     * 26 of 31 canonical rows with no code are unaffected. Verified before adding:
     * zero duplicate code groups, zero empty strings and zero untrimmed values in
     * both the canonical register and the development database, so this applies
     * with no cleanup step.
     */
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sites_organisation_code_idx ON sites (organisation_id, code)",
    ),

    // X14 — reporting groups. `seedStoreDocumentationGroups` fills these.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS site_groups (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         name TEXT NOT NULL,
         slug TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'region',
         colour_hex TEXT NOT NULL DEFAULT '#12B4A8',
         position INTEGER NOT NULL DEFAULT 0,
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS site_groups_organisation_slug_idx ON site_groups (organisation_id, slug)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS site_group_members (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         site_group_id TEXT NOT NULL REFERENCES site_groups(id),
         site_id TEXT NOT NULL REFERENCES sites(id),
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS site_group_members_pair_idx ON site_group_members (site_group_id, site_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS site_group_members_site_idx ON site_group_members (site_id)",
    ),

    /*
     * WORKSTREAM 5/6 — the configurable register, as ONE architecture for both
     * Sites and Contractors rather than two implementations.
     *
     * `register_key` is the discriminator ('sites' | 'contractors'), which is
     * what lets a third register join later without a migration.
     *
     * These deliberately do NOT reuse `maintenance_board_cells`. That table's
     * `request_id` is a work order, so a site's value has nowhere to sit in it;
     * widening it would put three unrelated entity kinds behind one FK.
     *
     * `native_field` carries the whole native/custom distinction. NON-NULL means
     * this column is a view onto a real typed column on `sites`/`contractors`:
     * its values are read and written THERE and are never duplicated here, so
     * the canonical row stays the single source of truth. NULL means a user
     * created the column, and its values live in `register_values`. One
     * nullable column says both things, which is why there is no `native`
     * boolean — and a boolean of that name would also have had to be declared
     * in BOOLEAN_COLUMNS in db/sqlite-to-postgres.ts to survive the rewriter.
     *
     * `hidden_at` rather than a `visible` flag, for a sharper version of the
     * same reason: `visible` is ALREADY a BOOLEAN_COLUMN name (from
     * maintenance_board_columns), and the rewriter's bare-name rule turns
     * `WHERE visible = 1` into `WHERE visible = true` on the strength of the
     * name alone. An INTEGER column called `visible` on a new table would make
     * that rule silently wrong — the exact failure its own comment warns about.
     * A nullable timestamp also records WHEN a column was hidden, which a flag
     * does not. Same argument for `deleted_at`.
     *
     * A native column is never physically deleted: hiding is the only removal,
     * because the underlying canonical field is real data. Only custom columns
     * accept `deleted_at`.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS register_columns (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         register_key TEXT NOT NULL,
         column_key TEXT NOT NULL,
         title TEXT NOT NULL,
         type TEXT NOT NULL DEFAULT 'text',
         position INTEGER NOT NULL DEFAULT 0,
         width INTEGER NOT NULL DEFAULT 160,
         native_field TEXT,
         settings TEXT NOT NULL DEFAULT '{}',
         hidden_at TEXT,
         deleted_at TEXT,
         deleted_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS register_columns_key_idx ON register_columns (organisation_id, register_key, column_key)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS register_columns_order_idx ON register_columns (organisation_id, register_key, position)",
    ),
    /*
     * One row per custom cell. Native cells are absent by construction — they
     * live on the canonical row — so this table stays proportional to what
     * users actually added rather than to the size of the register.
     *
     * The unique index is the write contract: a custom value is upserted by
     * (organisation, register, entity, column), so a double submit updates one
     * row instead of growing a second. `organisation_id` leads every index
     * because every read is org-scoped and a cross-tenant row must never be
     * reachable even by an id guess.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS register_values (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         register_key TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         column_key TEXT NOT NULL,
         value TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS register_values_cell_idx ON register_values (organisation_id, register_key, entity_id, column_key)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS register_values_entity_idx ON register_values (organisation_id, register_key, entity_id)",
    ),

    /*
     * WORKSTREAM 5/6 — the Contractor <-> Site relation, canonical and explicit.
     *
     * Until now the only site-bearing path from a contractor was transitive
     * through a job, and `coverage_areas` was free text every contractor filled
     * with "UK" — which discriminates nothing. This is a real many-to-many with
     * a real uniqueness rule, so "which sites does this contractor cover" has
     * an answer that does not depend on fuzzy matching a string.
     *
     * `organisation_id` is part of the unique key rather than merely present,
     * so the same contractor and site cannot be paired twice, and a pair can
     * never span tenants. Both FKs are declared; the API additionally checks
     * that contractor and site belong to the acting organisation BEFORE the
     * insert, because an FK proves the row exists, not that the caller may see it.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS contractor_sites (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         contractor_id TEXT NOT NULL REFERENCES contractors(id),
         site_id TEXT NOT NULL REFERENCES sites(id),
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         created_by TEXT
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS contractor_sites_pair_idx ON contractor_sites (organisation_id, contractor_id, site_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS contractor_sites_site_idx ON contractor_sites (site_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS contractor_sites_contractor_idx ON contractor_sites (contractor_id)",
    ),

    /*
     * WORKSTREAM 6 — certifications as entries rather than as one comma string.
     *
     * The old `contractors.certifications` JSON array holds names and nothing
     * else, so "is this contractor's gas certificate still valid" had no answer:
     * there was one `insurance_expiry` for the whole contractor and none per
     * certificate. Each row here carries its own expiry, which is what lets the
     * register derive a status the same way the site compliance register does.
     *
     * The legacy column is left in place and still read. This table is additive:
     * a contractor with no rows here behaves exactly as before.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS contractor_certifications (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         contractor_id TEXT NOT NULL REFERENCES contractors(id),
         name TEXT NOT NULL,
         reference TEXT,
         issued_on TEXT,
         expires_on TEXT,
         notes TEXT,
         position INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS contractor_certifications_owner_idx ON contractor_certifications (organisation_id, contractor_id, position)",
    ),

    // X12/X13 — nothing an import corrects is corrected silently.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS import_anomalies (
         id TEXT PRIMARY KEY NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         batch_id TEXT NOT NULL,
         entity_type TEXT NOT NULL,
         entity_id TEXT,
         source_name TEXT,
         kind TEXT NOT NULL,
         field TEXT,
         original_value TEXT,
         applied_value TEXT,
         detail TEXT,
         resolved INTEGER NOT NULL DEFAULT 0,
         resolved_by TEXT,
         resolved_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS import_anomalies_organisation_idx ON import_anomalies (organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS import_anomalies_resolved_idx ON import_anomalies (organisation_id, resolved)",
    ),

    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sites_organisation_status_idx ON sites (organisation_id, status)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sites_organisation_position_idx ON sites (organisation_id, position)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS units_next_service_idx ON units (organisation_id, next_service_due_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS attachments_unit_idx ON attachments (unit_id)",
    ),
  ]);

  // Carry Stage 0 values forward exactly once, only where the new column is
  // still empty, so a later admin edit is never overwritten on the next boot.
  await d1.batch([
    d1.prepare(
      "UPDATE sites SET site_type_value = type WHERE site_type_value IS NULL",
    ),
    d1.prepare(
      "UPDATE sites SET address_line1 = address WHERE address_line1 IS NULL",
    ),
    d1.prepare(
      "UPDATE sites SET manager_name = manager WHERE manager_name IS NULL",
    ),
    d1.prepare(
      `UPDATE sites SET slug = lower(replace(replace(replace(name, ' ', '-'), '/', '-'), '.', ''))
        WHERE slug IS NULL`,
    ),
  ]);

  // Only after every site holds a slug, or the unique index cannot be built:
  // NULL is distinct from NULL in SQLite, but a half-populated column is not
  // worth the risk of a partial failure part-way through the boot.
  await d1
    .prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sites_organisation_slug_idx ON sites (organisation_id, slug)",
    )
    .run();
}


/**
 * Stage 3 compatibility — mirrors drizzle/0008 for databases that were created
 * before it existed. Additive and idempotent, following the Stage 2 pattern.
 *
 * The column reconciliation this used to carry now lives in
 * `ensureBoardEngineColumns`, which runs before Stage 1 — see the note there.
 */
async function ensureStageThreeBoardEngine(d1: D1DatabaseLike) {
  await d1.batch([
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS boards (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         key TEXT NOT NULL,
         name TEXT NOT NULL,
         description TEXT,
         kind TEXT NOT NULL DEFAULT 'maintenance',
         item_noun TEXT NOT NULL DEFAULT 'Job',
         reference_prefix TEXT NOT NULL DEFAULT 'MS',
         reference_counter INTEGER NOT NULL DEFAULT 0,
         position INTEGER NOT NULL DEFAULT 0,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS boards_org_key_idx ON boards(organisation_id, key)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS boards_org_idx ON boards(organisation_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS maintenance_requests_reference_idx ON maintenance_requests(organisation_id, reference)",
    ),
  ]);

  // The board's comment bubble (AA16) reads both of these. Their shapes differ
  // only in the middle, so the two are created from one loop rather than two
  // near-identical blocks.
  for (const table of ["item_updates", "item_activity"] as const) {
    const columns =
      table === "item_updates"
        ? `parent_id TEXT, author_name TEXT NOT NULL, author_email TEXT,
           body TEXT NOT NULL, edited_at TEXT`
        : `actor_name TEXT NOT NULL, column_key TEXT, action TEXT NOT NULL,
           value_before TEXT, value_after TEXT`;

    await d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           organisation_id TEXT NOT NULL REFERENCES organisations(id),
           board_id TEXT NOT NULL DEFAULT 'maintenance',
           request_id TEXT NOT NULL,
           ${columns},
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`,
      )
      .run();
    await d1
      .prepare(
        `CREATE INDEX IF NOT EXISTS ${table}_request_idx
           ON ${table}(organisation_id, request_id)`,
      )
      .run();
  }

  /*
   * `👍 Like`, one row per person per update.
   *
   * Created here rather than left to `drizzle/`, because nothing in the request
   * boot path runs those migrations — a table that exists only as a migration
   * is a table the Updates panel would 500 on. The pair is the primary key, so
   * a double-tap is idempotent in storage and not merely in the client.
   *
   * No foreign key to `item_updates`: that table is written by the importer in
   * bulk and a constraint here would make a re-import order-dependent for no
   * gain — the read path already joins on `update_id` and a like whose update
   * has gone simply never appears.
   */
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS item_update_likes (
         update_id TEXT NOT NULL,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         actor_email TEXT NOT NULL,
         actor_name TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (update_id, actor_email)
       )`,
    )
    .run();
  await d1
    .prepare(
      `CREATE INDEX IF NOT EXISTS item_update_likes_update_idx
         ON item_update_likes(organisation_id, update_id)`,
    )
    .run();

  // Column reconciliation moved to `ensureBoardEngineColumns`, which now runs
  // before Stage 1 — see the note on that function.

  // Materialise the implicit board so existing board_id values resolve.
  await d1
    .prepare(
      `INSERT OR IGNORE INTO boards
         (id, organisation_id, key, name, kind, item_noun, reference_prefix, position)
       SELECT 'board_' || o.id || '_maintenance', o.id, 'maintenance', 'Maintenance',
              'maintenance', 'Job', 'MS', 0
       FROM organisations o`,
    )
    .run();
}


/**
 * Stage 4 compatibility — mirrors drizzle/0009. Additive and idempotent.
 *
 * Also repairs three indexes that were not organisation-scoped. An index holds
 * no data, so recreating it is safe; leaving them was not, because a second
 * organisation could not seed a board at all.
 */
async function ensureStageFourItems(d1: D1DatabaseLike) {
  // Old index → the organisation-scoped index that replaces it. Dropping is
  // safe in a way dropping a table never is: an index holds no data, and these
  // three were actively wrong. `maintenance_groups_board_position_idx` was
  // UNIQUE (board_id, position) with every tenant on board_id = 'maintenance',
  // so a second organisation could not hold a group at position 0 and its seed
  // failed outright.
  const indexRepairs: Array<[string, string]> = [
    [
      "maintenance_groups_board_position_idx",
      `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_groups_org_position_idx
         ON maintenance_groups(organisation_id, board_id, position)`,
    ],
    [
      "maintenance_groups_board_idx",
      `CREATE INDEX IF NOT EXISTS maintenance_groups_org_board_idx
         ON maintenance_groups(organisation_id, board_id)`,
    ],
    [
      "maintenance_board_columns_key_idx",
      `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_columns_org_key_idx
         ON maintenance_board_columns(organisation_id, board_id, column_key)`,
    ],
    [
      "maintenance_board_columns_position_idx",
      `CREATE INDEX IF NOT EXISTS maintenance_board_columns_org_position_idx
         ON maintenance_board_columns(organisation_id, board_id, position)`,
    ],
    [
      "maintenance_board_options_value_idx",
      `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_options_org_value_idx
         ON maintenance_board_options(organisation_id, board_id, column_key, value)`,
    ],
    [
      "maintenance_board_cells_value_idx",
      `CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_cells_org_value_idx
         ON maintenance_board_cells(organisation_id, board_id, request_id, column_id)`,
    ],
  ];

  for (const [drop, create] of indexRepairs) {
    await d1.prepare(`DROP INDEX IF EXISTS ${drop}`).run();
    await d1.prepare(create).run();
  }

  await d1
    .prepare(
      `CREATE INDEX IF NOT EXISTS maintenance_group_items_org_idx
         ON maintenance_group_items(organisation_id, board_id, group_id, position)`,
    )
    .run();

  // Sub-items — O11. A sub-item is a request whose parent points at another
  // request on the same board, so it inherits scoping and evidence handling.
  // Guarded by hand rather than through `addColumn` because the test that locks
  // this path reads the PRAGMA back out of this file.
  const requestColumns = await d1
    .prepare("PRAGMA table_info(maintenance_requests)")
    .all();
  const hasParent = ((requestColumns.results ?? []) as Array<{ name?: string }>).some(
    (row) => row.name === "parent_id",
  );
  if (!hasParent) {
    await d1
      .prepare("ALTER TABLE maintenance_requests ADD COLUMN parent_id TEXT")
      .run();
  }
  await d1
    .prepare(
      `CREATE INDEX IF NOT EXISTS maintenance_requests_parent_idx
         ON maintenance_requests(organisation_id, parent_id)`,
    )
    .run();
}

/**
 * Groups that correspond to a request stage, so a job filed by the workflow
 * lands in the right place. The 28 archive groups are filed into by hand,
 * exactly as on monday, and carry no stage.
 */
const STAGE_BY_GROUP_KEY: Record<string, string> = {
  topics: "Incoming",
  "jobs-booked": "Booked",
  "needs-attention": "Attention",
  "completed-2026-08": "Completed",
};

/**
 * Removes seeded columns that the board no longer defines — S1.
 *
 * Board structure was declared twice for several stages: `systemBoardColumns`
 * in the board route and a rival `seedColumns` here, both writing into
 * `maintenance_board_columns` under different keys for the same fields. A board
 * came up carrying 38 columns rather than 25, showing "Date requested" beside
 * "Date Requested" and "Pictures of maintenance issue" beside "Pictures of
 * Maintenance Issue". Both seeders now read `monday-board-spec.ts`; this clears
 * the strays out of databases provisioned before that.
 *
 * Deliberately conservative — a row is dropped only when all three hold:
 *
 *   1. its key is absent from the current spec,
 *   2. it is `system`, so it was seeded rather than created by an admin,
 *   3. no cell carries a value for it, so no data is lost.
 *
 * Anything holding data stays put and shows up as an extra column, which is
 * visible and fixable, rather than being deleted silently.
 */
async function reconcileDuplicateColumns(
  d1: D1DatabaseLike,
  organisationId: string,
  boardKey: string,
) {
  const expected = new Set([
    ...seedColumns.map((column) => column.key),
    ...seedUiColumns.map((column) => column.key),
  ]);

  const existing = await d1
    .prepare(
      `SELECT id, column_key FROM maintenance_board_columns
        WHERE organisation_id = ? AND board_id = ? AND system = 1`,
    )
    .bind(organisationId, boardKey)
    .all();

  const rows = (existing.results ?? []) as Array<{ id?: string; column_key?: string }>;
  for (const row of rows) {
    if (!row.id || !row.column_key || expected.has(row.column_key)) continue;

    const used = await d1
      .prepare(
        `SELECT COUNT(*) AS total FROM maintenance_board_cells
          WHERE column_id = ? AND TRIM(COALESCE(value, '')) <> ''`,
      )
      .bind(row.id)
      .all();
    const total = Number(((used.results ?? [])[0] as { total?: number })?.total ?? 0);
    if (total > 0) continue;

    await d1.prepare("DELETE FROM maintenance_board_cells WHERE column_id = ?").bind(row.id).run();
    await d1.prepare("DELETE FROM maintenance_board_columns WHERE id = ?").bind(row.id).run();
  }
}

/**
 * A maintenance column's stored `settings` blob.
 *
 * There are two places a status or dropdown column's choices are read from,
 * and they are not the same place:
 *
 *   `maintenance_board_options` rows  ->  the grid's own cells, via `optionsFor`
 *   `settings.choices` on the column  ->  the column menu's choice editor, the
 *                                         column summary, and the mobile editor
 *
 * Only the first was ever seeded here. `settings` was the literal `'{}'`, and
 * `parseSettings` in the board route falls back to `defaultSettings(type)` on
 * an empty blob — so every maintenance status column served the generic
 * placeholder set "Not started / Working on it / Done / Stuck", and Tier Level
 * served "Option 1 / Option 2". Those labels appear nowhere on monday and
 * nowhere in the spec; they are the API's own scaffolding, shown to the
 * operator as though they were the board's vocabulary.
 *
 * The cells looked right, which is what kept this hidden: the grid reads the
 * option rows, and those were correct all along.
 *
 * This is the same fix `seed-store-documentation.ts` already applies to Store
 * Type, written the same way and from the same spec arrays, so the two boards
 * cannot drift apart again.
 *
 * Choice ids are the lower-cased value, matching how the board API slugifies an
 * id it is handed; an imported cell holds the label instead and the grid
 * resolves that case-insensitively.
 */
function maintenanceColumnSettings(type: string, optionSetKey?: string | null) {
  if (type !== "dropdown" && type !== "status") return "{}";
  const options = optionSetKey ? maintenanceOptions[optionSetKey] : undefined;
  if (!options?.length) return "{}";
  return JSON.stringify({
    choices: options.map((option) => ({
      id: option.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      label: option.label,
      color: option.colour,
      textColor: option.textColour ?? "#ffffff",
    })),
  });
}

/**
 * Seeds the board structure for one organisation — N11 and O13.
 *
 * Idempotent: INSERT OR IGNORE throughout, so an admin who deletes a seeded
 * column does not have it silently restored on the next boot.
 */
export async function seedBoardStructure(
  d1: D1DatabaseLike,
  organisationId: string,
  boardKey = "maintenance",
) {
  const columnsToSeed = [...seedColumns, ...seedUiColumns];

  for (const [position, column] of columnsToSeed.entries()) {
    const settings = maintenanceColumnSettings(column.type, column.optionSetKey);

    /*
     * EVERY COLUMN ON THIS BOARD IS `system`, AND `column.system` IS NOT THAT
     * FLAG.
     *
     * `system` on the stored row answers one question: is this column backed by
     * a field on `maintenance_requests`, or by a row in
     * `maintenance_board_cells`? The board reads it that way in three places —
     * `live-board.tsx` splits the payload into `systemColumns` (rendered by
     * `systemCell`, from the request record) and `customColumns` (rendered from
     * `customCells`); `board-model.ts` builds `fallbackSystemColumns` with all
     * 26 marked `system: true`; and the board route refuses to delete a system
     * column, because there are no cell rows to delete and the field would
     * survive with nothing to show it.
     *
     * Every one of the 26 maintenance columns is request-backed — `systemCell`
     * has a case for all 26 keys — so all 26 must be seeded `system = 1`. This
     * bound `column.system` instead, which is the SPEC's flag and means
     * something else entirely: monday's own system columns, which on this board
     * are just Name, Status and Subitems. Four columns were seeded system, so
     * `live-board` filed the other 22 as custom and looked them up in
     * `maintenance_board_cells` — a table that holds two rows for this whole
     * workspace. Location, Description, Tier Level, Engineer Required, Priority,
     * Contractor, Assigned To and every date and money column rendered "Add
     * value" on every row of a board whose request rows were fully populated,
     * and their group summaries read "0 filled".
     *
     * It also cost a write. `ensureBoardState` in the board route re-inserts all
     * 26 as `system: true` whenever it counts fewer system columns than the spec
     * has, which was every load; each one conflicted on
     * `maintenance_board_columns_org_key_idx` and was discarded.
     *
     * Store Documentation is seeded by `seed-store-documentation.ts`, which
     * keeps `column.system` because that board genuinely is cell-backed: only
     * Name comes off the request. This function only ever runs for maintenance.
     */
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_board_columns
           (id, organisation_id, board_id, column_key, title, type, position, width,
            settings, system, visible, pinned, required, summary, option_set_key, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
      )
      .bind(
        `seed-${organisationId}-${boardKey}-${column.key}`,
        organisationId,
        boardKey,
        column.key,
        column.title,
        column.type,
        position,
        column.width,
        settings,
        1,
        column.required ? 1 : 0,
        column.summary ?? null,
        column.optionSetKey ?? null,
        column.description ?? null,
      )
      .run();

    /*
     * Every board seeded before this carries the empty blob, and the
     * `INSERT OR IGNORE` above will not correct it. Guarded on the stored value
     * still being exactly `{}` — an unconfigured column — so an admin who has
     * renamed or recoloured a label keeps that edit rather than having it
     * overwritten on the next boot.
     */
    if (settings !== "{}") {
      await d1
        .prepare(
          `UPDATE maintenance_board_columns
              SET settings = ?
            WHERE organisation_id = ? AND board_id = ? AND column_key = ?
              AND TRIM(COALESCE(settings, '')) IN ('', '{}')`,
        )
        .bind(settings, organisationId, boardKey, column.key)
        .run();
    }

    /*
     * Same shape as the settings backfill above, and for the same reason: an
     * INSERT OR IGNORE cannot correct a row that already exists, so a board
     * seeded before the fix above keeps `system = 0` on 22 columns and keeps
     * rendering them empty for ever.
     *
     * Keyed on `column_key` against the spec's own list, so only the columns
     * this function seeds are touched. A column an admin added through the board
     * UI is not in `columnsToSeed`, never matches, and stays `system = 0` —
     * which is correct: those genuinely are cell-backed, and flipping one would
     * both blank it and make it undeletable.
     */
    await d1
      .prepare(
        `UPDATE maintenance_board_columns
            SET system = 1
          WHERE organisation_id = ? AND board_id = ? AND column_key = ?
            AND system = 0`,
      )
      .bind(organisationId, boardKey, column.key)
      .run();
  }

  for (const [position, group] of seedGroups.entries()) {
    await d1
      .prepare(
        `INSERT OR IGNORE INTO maintenance_groups
           (id, organisation_id, board_id, name, color, position, collapsed, archived,
            description, stage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        `seed-${organisationId}-${boardKey}-${group.key}`,
        organisationId,
        boardKey,
        group.name,
        group.colour,
        position,
        group.collapsed ? 1 : 0,
        group.description ?? null,
        STAGE_BY_GROUP_KEY[group.key] ?? null,
      )
      .run();
  }

  await reconcileDuplicateColumns(d1, organisationId, boardKey);
}


/**
 * Seeds the Store Documentation board's four groups over the site register.
 *
 * Monday files every store into "Current stores", "Europe", "Closed" or
 * "Other". The site register already carries the two fields that decide which —
 * `lifecycle` and `region` — but no group rows existed, so the Sites screen's
 * "All groups" filter was empty and the register could not be read the way the
 * board is.
 *
 * Membership is derived rather than stored by hand, and re-derived on each
 * boot, so a site closed or moved to Europe lands in the right group without
 * anyone maintaining a second list. Groups an admin has created themselves are
 * untouched — only the four seeded slugs are rebuilt.
 */
export async function seedStoreDocumentationGroups(d1: D1DatabaseLike, organisationId: string) {
  /*
   * The predicates read `status` and the site type, NOT `lifecycle`/`region`.
   *
   * They used to read the latter, and all four groups were wrong because those
   * two columns are the LOSSY Stage-0 projections of `status`. Measured against
   * the canonical 31-row register, the old predicates produced 24/0/7/0:
   *
   *  - "Current stores" collected 24 — every `lifecycle = 'Current'` UK row —
   *    which swept in the office and both warehouses. It is supposed to be the
   *    21 shops, the same 21 `listRetailSites()` offers a picker, and the same
   *    21 the monday board's own Current stores group holds.
   *  - "Closed" collected 7, because the three legacy rows carry `status='other'`
   *    with `lifecycle='Closed'`; they are not closed shops.
   *  - "Other" could never match anything. Its predicate asked for a region
   *    outside ('UK','Europe'), `region` defaults to 'UK' and every row holds
   *    it, so the group the office and warehouses belong in was permanently empty.
   *
   * Keyed on `status` and type the four become a true PARTITION — 21 + 0 + 4 + 6
   * = 31, every site in exactly one group — and "Current stores" agrees with
   * `listRetailSites()` by construction rather than by coincidence.
   *
   * `europe` keys on `status='international'` rather than `region='Europe'` for
   * the same reason: status is canonical and the CSV importer sets the two
   * together. It is 0 today, correctly — the board's two Europe rows are
   * deliberately outside the register (one is non-UK scope, one is a placeholder).
   */
  const groups: Array<[string, string, string, string]> = [
    // slug, name, colour, SQL predicate over `sites s`
    ["current-stores", "Current stores", "#579bfc", "s.status = 'active' AND COALESCE(s.site_type_value, s.type) IN ('Inline', 'Kiosk')"],
    ["europe", "Europe", "#a25ddc", "s.status = 'international'"],
    ["closed", "Closed", "#ff5ac4", "s.status = 'closed'"],
    ["other", "Other", "#757575", "s.status = 'other' OR (s.status = 'active' AND COALESCE(s.site_type_value, s.type) NOT IN ('Inline', 'Kiosk'))"],
  ];

  for (const [position, [slug, name, colour, predicate]] of groups.entries()) {
    const id = `site-group-${organisationId}-${slug}`;
    await d1
      .prepare(
        `INSERT OR IGNORE INTO site_groups
           (id, organisation_id, name, slug, kind, colour_hex, position)
         VALUES (?, ?, ?, ?, 'portfolio', ?, ?)`,
      )
      .bind(id, organisationId, name, slug, colour, position)
      .run();

    // Rebuild membership so a lifecycle or region change is reflected.
    await d1
      .prepare("DELETE FROM site_group_members WHERE site_group_id = ?")
      .bind(id)
      .run();
    await d1
      .prepare(
        /*
         * The predicate is PARENTHESISED, and that is load-bearing.
         *
         * `AND` binds tighter than `OR`, so interpolating a predicate that
         * contains a top-level `OR` bare would parse as
         *   (organisation_id = ? AND <left>) OR <right>
         * and the right-hand branch would match rows belonging to EVERY
         * organisation — a cross-tenant leak straight into a reporting group.
         * The 'other' predicate below is exactly that shape.
         */
        `INSERT OR IGNORE INTO site_group_members
           (id, organisation_id, site_group_id, site_id)
         SELECT 'sgm-' || ? || '-' || s.id, ?, ?, s.id
           FROM sites s
          WHERE s.organisation_id = ? AND (${predicate})`,
      )
      .bind(slug, organisationId, id, organisationId)
      .run();
  }
}

/**
 * Renames compliance requirements onto the Store Documentation vocabulary.
 *
 * The register grew five ad-hoc requirement names — "PAT", "Fire alarm",
 * "Emergency lighting", "Water hygiene" and "Electrical wiring" — that differ
 * from the board's column titles only by case or abbreviation. Seeding the
 * board's twelve alongside them produced fifteen requirements, five of which
 * were the same certificate counted twice, and the compliance score was
 * computed against that inflated denominator.
 *
 * Renaming rather than deleting keeps every expiry date, status and attachment
 * attached to the row that already holds it. The unique index is on
 * (site_id, kind), so a site that somehow holds both spellings would collide;
 * the update is therefore guarded to skip a rename where the target already
 * exists, leaving that one pair visible for an admin to merge by hand.
 */
async function renameComplianceKinds(d1: D1DatabaseLike) {
  const renames: Array<[string, string]> = [
    ["PAT", "PAT Test"],
    ["PAT certificate", "PAT Test"],
    ["Fire alarm", "Fire Alarm"],
    ["Fire alarm report", "Fire Alarm"],
    ["Emergency lighting", "Emergency Lighting"],
    ["Water hygiene", "Water Hygiene"],
    ["Electrical wiring", "Electrical Wiring"],
    ["Electrical certificate", "Electrical Wiring"],
    ["Store drawing", "Drawing"],
  ];

  for (const [from, to] of renames) {
    await d1
      .prepare(
        `UPDATE compliance_documents
            SET kind = ?, updated_at = CURRENT_TIMESTAMP
          WHERE kind = ?
            AND NOT EXISTS (
              SELECT 1 FROM compliance_documents AS existing
               WHERE existing.site_id = compliance_documents.site_id
                 AND existing.organisation_id = compliance_documents.organisation_id
                 AND existing.kind = ?
            )`,
      )
      .bind(to, from, to)
      .run();
  }
}

/**
 * Stage 5 compatibility — mirrors drizzle/0010_stage_five_board_views.sql.
 *
 * `board_views` existed only as a migration, and migrations do not run on the
 * runtime bootstrap path that every request goes through. The table was
 * therefore absent from every database this code actually provisions, so
 * `/api/board/views` caught the missing-table error and answered 503 — which is
 * the whole tab strip, on every board. Additive and idempotent, like the other
 * stage shims.
 */
async function ensureStageFiveBoardViews(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS board_views (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL,
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         key TEXT NOT NULL,
         name TEXT NOT NULL,
         type TEXT NOT NULL DEFAULT 'table',
         icon TEXT,
         filters TEXT NOT NULL DEFAULT '[]',
         sort TEXT NOT NULL DEFAULT '[]',
         settings TEXT NOT NULL DEFAULT '{}',
         position INTEGER NOT NULL DEFAULT 0,
         is_default INTEGER NOT NULL DEFAULT 0,
         system INTEGER NOT NULL DEFAULT 0,
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )
    .run();
}

/**
 * The form builder's store — `form_configurations`, plus one seeded row per
 * organisation.
 *
 * Additive and idempotent like every other shim here, and seeded rather than
 * left empty for a specific reason: an empty table would mean the Form tab
 * opens on a form with no questions until somebody presses a button. The seed
 * is `maintenanceFormConfiguration`, read from monday's API, so a fresh
 * database starts with the real form — nineteen questions, the ten hidden ones
 * included, and the feature and appearance settings as the live form has them.
 *
 * THE SEED RUNS ONCE PER ORGANISATION AND NEVER AGAIN. `INSERT OR IGNORE` is
 * doing real work here, and it is the same idiom the board-structure seed uses
 * for the same reason: this function is on the boot path of every request, so
 * an unguarded insert would either throw on the unique index or, worse,
 * silently reset an edited form back to monday's values on the next cold start.
 * The uniqueness of (organisation_id, board_id, view_key) is what makes the
 * IGNORE mean "this organisation already has its form" — once a row exists it
 * is the operator's, and this code stops touching it.
 *
 * The share token is generated per organisation rather than copied from
 * monday's. Reusing monday's would point our public route at an identifier
 * that belongs to somebody else's system, and two organisations would collide
 * on the unique index.
 */
async function ensureFormBuilder(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS form_configurations (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL,
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         view_key TEXT NOT NULL DEFAULT 'form',
         title TEXT NOT NULL,
         description TEXT,
         share_token TEXT NOT NULL,
         short_token TEXT,
         active INTEGER NOT NULL DEFAULT 1,
         require_login INTEGER NOT NULL DEFAULT 0,
         password_hash TEXT,
         response_limit INTEGER,
         close_at TEXT,
         response_count INTEGER NOT NULL DEFAULT 0,
         config TEXT NOT NULL DEFAULT '{}',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )
    .run();

  /*
   * The indexes are separate statements because the table may already exist
   * from an earlier boot that predates them — `CREATE TABLE IF NOT EXISTS`
   * would skip inline constraints in that case and the uniqueness that the
   * public lookup depends on would quietly not be there.
   */
  await d1
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS form_configurations_token_idx
         ON form_configurations (share_token)`,
    )
    .run();
  /*
   * A table created before `short_token` existed needs the column adding, and
   * `addColumn` is the guarded way to do it — see its own note on why an
   * unguarded ALTER takes the whole bootstrap down on the second boot.
   */
  await addColumn(d1, "form_configurations", "short_token", "TEXT");
  await d1
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS form_configurations_short_token_idx
         ON form_configurations (short_token)`,
    )
    .run();
  await d1
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS form_configurations_view_idx
         ON form_configurations (organisation_id, board_id, view_key)`,
    )
    .run();

  const organisations = await d1
    .prepare("SELECT id FROM organisations WHERE status = 'active'")
    .all();

  /*
   * `config` carries everything the builder edits that nothing needs to query.
   * The access-control fields are deliberately NOT duplicated in here — they
   * live in their own columns, and a second copy would be a second answer to
   * "is this form password protected".
   */
  const config = JSON.stringify({
    order: maintenanceFormConfiguration.order,
    questions: maintenanceFormConfiguration.questions,
    features: maintenanceFormConfiguration.features,
    appearance: maintenanceFormConfiguration.appearance,
    accessibility: maintenanceFormConfiguration.accessibility,
    tags: maintenanceFormConfiguration.tags,
  });

  for (const row of (organisations.results ?? []) as Array<{ id?: string }>) {
    if (!row.id) continue;
    const id = `form_${row.id.slice(-12)}_maintenance`;
    const token = crypto.randomUUID().replace(/-/g, "");
    /* The short alias: the first twelve hex characters of a second UUID. */
    const shortToken = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await d1
      .prepare(
        `INSERT OR IGNORE INTO form_configurations
           (id, organisation_id, board_id, view_key, title, description,
            share_token, short_token, config)
         VALUES (?, ?, 'maintenance', 'form', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        row.id,
        maintenanceFormConfiguration.title,
        maintenanceFormConfiguration.description,
        token,
        shortToken,
        config,
      )
      .run();
  }
}

/**
 * Stage 7 compatibility — mirrors drizzle/0011. Additive and idempotent.
 */
async function ensureStageSevenNotifications(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS notification_log (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL,
         channel TEXT NOT NULL,
         event TEXT NOT NULL,
         subject_type TEXT NOT NULL,
         subject_id TEXT,
         recipient TEXT NOT NULL,
         subject TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         error TEXT,
         provider_id TEXT,
         delivered_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )
    .run();

  const additions: Array<[string, string, string]> = [
    ["leads", "notified_at", "TEXT"],
    ["leads", "notify_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["maintenance_requests", "notified_at", "TEXT"],
    ["maintenance_requests", "notify_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["compliance_documents", "last_alert_at", "TEXT"],
    ["compliance_documents", "last_alert_stage", "TEXT"],
  ];

  for (const [table, column, definition] of additions) {
    await addColumn(d1, table, column, definition);
  }
}


/** Stage 9 compatibility — mirrors drizzle/0012. Additive and idempotent. */
async function ensureStageNineContractorLinks(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `CREATE TABLE IF NOT EXISTS job_access_tokens (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL,
         request_id TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         audience TEXT NOT NULL DEFAULT 'contractor',
         label TEXT,
         allowed_kinds TEXT NOT NULL DEFAULT '["completion","nameplate"]',
         can_comment INTEGER NOT NULL DEFAULT 1,
         can_request_completion INTEGER NOT NULL DEFAULT 1,
         expires_at TEXT NOT NULL,
         revoked_at TEXT,
         created_by TEXT,
         first_opened_at TEXT,
         last_used_at TEXT,
         use_count INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    )
    .run();

  const additions: Array<[string, string, string]> = [
    ["attachments", "pending", "INTEGER NOT NULL DEFAULT 0"],
    ["attachments", "submitted_via", "TEXT"],
    ["attachments", "reviewed_at", "TEXT"],
    ["attachments", "reviewed_by", "TEXT"],
    ["maintenance_requests", "completion_requested_at", "TEXT"],
    ["maintenance_requests", "completion_requested_by", "TEXT"],
    ["maintenance_requests", "completion_note", "TEXT"],
    ["maintenance_requests", "blocked_reason", "TEXT"],
    /*
     * K — the contractor's signature at completion.
     *
     * Stored on the row as a PNG data URL rather than as an attachment. A
     * signature is a few kilobytes and it is not evidence of the work: putting
     * it in `attachments` would put it in the photo columns, the media viewer
     * and the client's evidence pack, none of which is where a signature
     * belongs. Bounded server-side so a row cannot be filled with an image.
     */
    ["maintenance_requests", "completion_signature", "TEXT"],
    ["maintenance_requests", "completion_signed_at", "TEXT"],
    ["maintenance_requests", "completion_signed_by", "TEXT"],
  ];

  for (const [table, column, definition] of additions) {
    await addColumn(d1, table, column, definition);
  }
}

/**
 * The identity an imported row keeps.
 *
 * `external_id` holds the row's id on the system it came from — monday's item
 * id. Without it the importer had nothing stable to match a re-import on and
 * fell back to the display title, which is not unique on a real board: the
 * Maintenance board names every form submission "Incoming form answer", so a
 * 744-row import folded 713 distinct jobs onto the rows already present and
 * reported it as "updated". Store Documentation never exposed the fault because
 * store names happen to be unique.
 *
 * Nullable, because anything created in the app rather than imported has no
 * external identity, and the index is deliberately NOT unique: two different
 * boards could legitimately carry the same source id, and a unique index would
 * make the second import fail rather than simply match within its own board.
 */
/**
 * Stage 20 — accounts, teams, permissions, audit and sidebar layout.
 *
 * Additive and idempotent like every stage above it: `CREATE TABLE IF NOT
 * EXISTS` throughout and every column added through the `PRAGMA`-guarded
 * helper, because this runs on the boot path of every request.
 *
 * These tables exist because the workspace had no real notion of a person.
 * Identity came from a cookie the browser set for itself, so "each client sees
 * only their own data" was a convention rather than a rule, and there was
 * nowhere to record who changed what.
 */
async function ensureStageTwentyAccounts(d1: D1DatabaseLike) {
  // A person's own details, and the credential that proves they are them.
  // On `users` rather than a side table so a sign-in is a single read.
  const userColumns: Array<[string, string]> = [
    ["password_hash", "TEXT"],
    ["password_updated_at", "TEXT"],
    ["last_login_at", "TEXT"],
    ["job_title", "TEXT"],
    ["phone", "TEXT"],
    ["timezone", "TEXT NOT NULL DEFAULT 'Europe/London'"],
    ["avatar_colour", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'active'"],
    ["deactivated_at", "TEXT"],
    ["theme_preference", "TEXT NOT NULL DEFAULT 'dark'"],
    ["working_status", "TEXT"],
  ];
  for (const [column, definition] of userColumns) {
    await addColumn(d1, "users", column, definition);
  }

  await d1.batch([
    // Only the token's hash is stored, so a leaked database cannot be used to
    // impersonate anyone. Revoked rather than deleted, so "signed out of all
    // devices" stays visible in the audit trail.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id),
         token_hash TEXT NOT NULL,
         organisation_id TEXT,
         issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         expires_at TEXT NOT NULL,
         last_seen_at TEXT,
         revoked_at TEXT,
         ip_address TEXT,
         user_agent TEXT
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at)",
    ),

    // The role lives on the invitation, so accepting cannot escalate: the
    // membership is written from this row, never from what the invitee sends.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS invitations (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         email TEXT NOT NULL,
         role TEXT NOT NULL DEFAULT 'client',
         token_hash TEXT NOT NULL,
         invited_by TEXT,
         message TEXT,
         expires_at TEXT NOT NULL,
         accepted_at TEXT,
         accepted_user_id TEXT,
         revoked_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_idx ON invitations(token_hash)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS invitations_organisation_idx ON invitations(organisation_id, email)",
    ),

    /*
     * Password resets. Deliberately shaped like `invitations`, because they are
     * the same object: a single-use, expiring, revocable credential handed to
     * one person out of band. Only the hash is stored, for the same reason.
     *
     * Separate from `invitations` rather than a `kind` column on it, because
     * the two answer different questions — an invitation creates an account,
     * a reset re-opens one — and a shared table would need every query on both
     * sides to remember to filter, which one of them eventually would not.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS password_resets (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id),
         organisation_id TEXT REFERENCES organisations(id),
         token_hash TEXT NOT NULL,
         issued_by TEXT,
         expires_at TEXT NOT NULL,
         used_at TEXT,
         revoked_at TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_idx ON password_resets(token_hash)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id, created_at)",
    ),

    d1.prepare(
      `CREATE TABLE IF NOT EXISTS teams (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         name TEXT NOT NULL,
         slug TEXT NOT NULL,
         description TEXT,
         colour_hex TEXT NOT NULL DEFAULT '#12B4A8',
         position INTEGER NOT NULL DEFAULT 0,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS teams_organisation_slug_idx ON teams(organisation_id, slug)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS team_members (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         team_id TEXT NOT NULL REFERENCES teams(id),
         user_id TEXT NOT NULL REFERENCES users(id),
         team_role TEXT NOT NULL DEFAULT 'member',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS team_members_pair_idx ON team_members(team_id, user_id)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members(user_id)",
    ),

    // A capability absent from this table falls back to the built-in default
    // for that role, so an empty table is a working system rather than one
    // nobody can get into.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS role_capabilities (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         role TEXT NOT NULL,
         capability TEXT NOT NULL,
         allowed INTEGER NOT NULL DEFAULT 1,
         updated_by TEXT,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS role_capabilities_idx ON role_capabilities(organisation_id, role, capability)",
    ),

    // Append-only by contract: nothing in the app updates or deletes a row
    // here. `organisation_id` is nullable because a failed sign-in has no
    // workspace yet, and those are exactly the ones worth keeping.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS audit_events (
         id TEXT PRIMARY KEY,
         organisation_id TEXT,
         actor_user_id TEXT,
         actor_email TEXT,
         actor_role TEXT,
         action TEXT NOT NULL,
         entity_type TEXT,
         entity_id TEXT,
         summary TEXT NOT NULL,
         detail TEXT,
         ip_address TEXT,
         user_agent TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS audit_events_organisation_idx ON audit_events(organisation_id, created_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events(actor_email)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events(action)",
    ),

    // `user_id` NULL is the workspace default an admin sets; a row with a user
    // id is that person's own arrangement and wins over it.
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS navigation_layouts (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         user_id TEXT,
         items TEXT NOT NULL DEFAULT '[]',
         locked TEXT NOT NULL DEFAULT '[]',
         updated_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    // NULL is distinct from NULL in SQLite, so the workspace-default row cannot
    // be constrained here; the API enforces one default per organisation.
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS navigation_layouts_scope_idx ON navigation_layouts(organisation_id, user_id)",
    ),

    /*
     * Failed sign-in counters, shared across isolates.
     *
     * This replaces a `Map` in module scope, which meant five attempts *per
     * Worker isolate* — and Cloudflare runs many and recycles them, so the
     * limit was a multiple of five that nobody could name, reset by every
     * deploy. Here it is one row per (email|IP), seen by every isolate.
     *
     * Deliberately outside the tenant tables: a failed sign-in has no
     * workspace, exactly as `audit_events.organisation_id` is nullable for the
     * same reason. Keying on email and IP together is what stops the limiter
     * being usable to lock a colleague out of their own account.
     *
     * Times are epoch milliseconds, not the TEXT timestamps the rest of the
     * schema uses, because the increment arithmetic happens inside a single
     * SQL statement and integer comparison there is exact.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS sign_in_failures (
         key TEXT PRIMARY KEY,
         count INTEGER NOT NULL DEFAULT 0,
         first_at INTEGER NOT NULL DEFAULT 0,
         blocked_until INTEGER NOT NULL DEFAULT 0
       )`,
    ),
    // Swept by expiry, so the sweep must not scan the table to find its work.
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS sign_in_failures_expiry_idx ON sign_in_failures(blocked_until, first_at)",
    ),

    /*
     * Per-user dashboard arrangement. Same shape and same rules as
     * `navigation_layouts`: NULL user_id is the workspace default, a row with a
     * user id wins over it, and the stored list is an arrangement rather than an
     * inventory — existence comes from the widget registry in the code, so a
     * panel added later appears rather than vanishing.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS dashboard_layouts (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         user_id TEXT,
         surface TEXT NOT NULL DEFAULT 'overview',
         items TEXT NOT NULL DEFAULT '[]',
         updated_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layouts_scope_idx ON dashboard_layouts(organisation_id, user_id, surface)",
    ),

    /*
     * Sections the owner added — the workspace's own inventory.
     *
     * The stored sidebar arrangement is deliberately NOT an inventory, so
     * "which sections exist" had nowhere to live for anything the code did not
     * ship. This is that place, and it is read as a *catalogue*: the rows here
     * are appended to the built-in catalogue and the existing three-layer merge
     * runs over the result unchanged. A section added here therefore appears in
     * the sidebar of somebody who arranged theirs a year ago.
     *
     * `surface` names a screen the product already renders. That is what stops
     * a new section being a label with no destination.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS workspace_sections (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         key TEXT NOT NULL,
         label TEXT NOT NULL,
         /* W02-07 asks a new section's page for a description as well as a
            title. Nullable: every section that existed before this reads NULL,
            and a NULL description renders the screen's own blurb exactly as it
            did. */
         description TEXT,
         icon TEXT NOT NULL DEFAULT 'grid',
         surface TEXT NOT NULL DEFAULT 'board',
         surface_ref TEXT,
         group_key TEXT NOT NULL DEFAULT 'group:operations',
         position INTEGER NOT NULL DEFAULT 0,
         archived_at TEXT,
         created_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS workspace_sections_key_idx ON workspace_sections(organisation_id, key)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS workspace_sections_position_idx ON workspace_sections(organisation_id, position)",
    ),

    /*
     * Which view a section opens on. NULL user_id is the workspace default the
     * owner sets and everyone lands on; a row with a user id is that person's
     * own last view, which wins for them alone. Same two-layer shape as the
     * layout tables above, for the same reason: one mental model.
     *
     * `view_key` references `board_views.key` rather than defining anything. A
     * remembered view that has since been deleted resolves to nothing and falls
     * through to the default, so deleting a view cannot strand anybody.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS section_view_preferences (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         section_key TEXT NOT NULL,
         user_id TEXT,
         view_key TEXT NOT NULL,
         updated_by TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    ),
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS section_view_preferences_scope_idx ON section_view_preferences(organisation_id, section_key, user_id)",
    ),
  ]);

  /*
   * The same column for a database provisioned before it existed.
   *
   * The CREATE above carries it for a fresh database; this carries it for every
   * other one. `addColumn` reads `PRAGMA table_info` first and returns early
   * when the table is absent or the column already there, so this is idempotent
   * and costs one guarded read per boot — SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, and an unguarded ALTER would throw "duplicate
   * column name" on the second boot and take every API route down with it.
   *
   * After the batch, never inside it: the table has to exist before it can be
   * altered, and a batch gives no ordering guarantee this could rely on.
   */
  await addColumn(d1, "workspace_sections", "description", "TEXT");
}

async function ensureImportIdentity(d1: D1DatabaseLike) {
  await addColumn(d1, "maintenance_requests", "external_id", "TEXT");
  await d1
    .prepare(
      `CREATE INDEX IF NOT EXISTS maintenance_requests_external_idx
         ON maintenance_requests(organisation_id, external_id)`,
    )
    .run();
}

/**
 * Stage 23 — the recycle bin.
 *
 * Nine statements per boot: four `PRAGMA table_info` guards and a five-statement
 * batch of `IF NOT EXISTS` DDL. That is deliberate restraint — this file runs on
 * the boot path of every isolate and already issues several hundred statements,
 * so a stage that wants a table and four columns should cost a fixed handful and
 * never a scan.
 *
 * Every ALTER goes through `addColumn`, which checks `PRAGMA table_info` first.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`; an unguarded ALTER here throws
 * "duplicate column name" on the SECOND boot and takes the whole bootstrap — and
 * therefore every API route — down with it.
 *
 * Note what is NOT here: the expiry sweep. Purging thirty-day-old rows is not
 * bootstrap work and must not run inside a memoised initialiser, so it lives in
 * `app/lib/recycle-bin.ts` and is triggered from the bin's own read path,
 * bounded and sampled. See `sweepRecycleBin` for why.
 */
async function ensureStageTwentyThreeRecycleBin(d1: D1DatabaseLike) {
  await addColumn(d1, "maintenance_requests", "deleted_at", "TEXT");
  await addColumn(d1, "maintenance_requests", "deleted_by", "TEXT");
  await addColumn(d1, "maintenance_groups", "deleted_at", "TEXT");
  await addColumn(d1, "maintenance_groups", "deleted_by", "TEXT");

  await d1.batch([
    /*
     * One row per thing CURRENTLY in the bin — a live index, not a history. The
     * row is removed on restore and on purge; the permanent record that a
     * deletion happened stays in `audit_events` and `activity_log`, which are
     * append-only and which the Trash screen still shows beneath the bin.
     *
     * `placement` is why this is a table and not just the flags above. Restoring
     * a job to where it came from means its group AND its position, and those
     * live in `maintenance_group_items` — a row that has to be deleted on soft
     * delete, or every board read that joins through it would keep showing the
     * deleted job. The placement is snapshotted here as JSON instead.
     */
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS recycle_bin (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         board_id TEXT,
         title TEXT NOT NULL,
         summary TEXT,
         placement TEXT,
         deleted_by_email TEXT,
         deleted_by_name TEXT,
         deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         expires_at TEXT NOT NULL
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS recycle_bin_org_deleted_idx ON recycle_bin(organisation_id, deleted_at)",
    ),
    // Swept by expiry, so the sweep must not scan the table to find its work.
    // Same reason `sign_in_failures_expiry_idx` exists a few stages above.
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS recycle_bin_expiry_idx ON recycle_bin(expires_at)",
    ),
    // One live bin row per thing: a second soft delete of the same id would
    // otherwise leave two entries and an ambiguous restore.
    d1.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS recycle_bin_entity_idx ON recycle_bin(organisation_id, entity_type, entity_id)",
    ),
    /*
     * Partial indexes over the live rows only.
     *
     * Every board read now carries `deleted_at IS NULL`, and a partial index
     * both stays small and matches that predicate, so the 744-row board does not
     * pay for the bin.
     */
    d1.prepare(
      `CREATE INDEX IF NOT EXISTS maintenance_requests_live_idx
         ON maintenance_requests(organisation_id, archived) WHERE deleted_at IS NULL`,
    ),
  ]);
}

/**
 * Board automations — mirrors drizzle/0020 for databases created before it.
 *
 * Two tables, both additive, both `IF NOT EXISTS`. No integer booleans and no
 * `DEFAULT CURRENT_TIMESTAMP`: `enabled` is 'on'/'off' text and every stamp is
 * an ISO string the application writes, so the Postgres adapter — which
 * translates booleans and timestamps per column against the converted
 * production schema — has nothing to translate here and the two databases
 * behave the same. See the note on `boardAutomations` in db/schema.ts.
 */
async function ensureBoardAutomations(d1: D1DatabaseLike) {
  await d1.batch([
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS board_automations (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         name TEXT NOT NULL,
         trigger_type TEXT NOT NULL,
         trigger_config TEXT NOT NULL DEFAULT '{}',
         action_type TEXT NOT NULL,
         action_config TEXT NOT NULL DEFAULT '{}',
         enabled TEXT NOT NULL DEFAULT 'on',
         importance TEXT NOT NULL DEFAULT 'minor',
         description TEXT,
         created_by TEXT,
         run_count INTEGER NOT NULL DEFAULT 0,
         last_run_at TEXT,
         last_sweep_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS board_automations_board_idx ON board_automations(organisation_id, board_id)",
    ),
    d1.prepare(
      `CREATE TABLE IF NOT EXISTS automation_runs (
         id TEXT PRIMARY KEY,
         organisation_id TEXT NOT NULL REFERENCES organisations(id),
         automation_id TEXT NOT NULL,
         board_id TEXT NOT NULL DEFAULT 'maintenance',
         request_id TEXT,
         status TEXT NOT NULL,
         trigger_summary TEXT,
         action_summary TEXT,
         error TEXT,
         depth INTEGER NOT NULL DEFAULT 0,
         chain_id TEXT,
         dedupe_key TEXT,
         actor_email TEXT,
         created_at TEXT NOT NULL
       )`,
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS automation_runs_board_idx ON automation_runs(organisation_id, board_id, created_at)",
    ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS automation_runs_rule_idx ON automation_runs(organisation_id, automation_id, dedupe_key)",
    ),
  ]);
}
