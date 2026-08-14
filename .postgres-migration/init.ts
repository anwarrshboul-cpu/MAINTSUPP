import { seedColumns, seedGroups, seedUiColumns } from "./seed-board-structure";
import { seedStoreDocumentationBoard } from "./seed-store-documentation";
import { getSql } from ".";
import { pgCompat, type CompatDatabase } from "./pg-compat";
import { defaultBoardOptions } from "./seed-options";
import type { BoardOptionColumn } from "../app/lib/types";

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";


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
  const d1 = pgCompat(await getSql());
  await ensureStageOneFoundation(d1);
  await ensureStageTwoFoundation(d1);
  await ensureStageThreeBoardEngine(d1);
  await ensureStageFourItems(d1);

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
  await ensureStageSevenNotifications(d1);
  await renameComplianceKinds(d1);
  await ensureStageNineContractorLinks(d1);
}

type D1DatabaseLike = CompatDatabase;



async function ensureStageOneFoundation(d1: CompatDatabase) {

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
  }


  await d1
    .prepare(
      `INSERT INTO organisations
        (id, name, slug, primary_colour, plan_tier, status)
       VALUES (?, 'Sunnamusk UK', 'sunnamusk-uk', '#12B4A8', 'development', 'active')
         ON CONFLICT DO NOTHING`,
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
      `INSERT INTO memberships
        (id, user_id, organisation_id, role, status, accepted_at)
       SELECT 'membership-' || id, id, organisation_id,
         CASE lower(role)
           WHEN 'super admin' THEN 'super_admin'
           WHEN 'admin' THEN 'admin'
           ELSE 'client'
         END,
         'active', CURRENT_TIMESTAMP
       FROM users WHERE organisation_id IS NOT NULL
         ON CONFLICT DO NOTHING`,
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
          "INSERT INTO option_sets (id, organisation_id, key, name, description) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
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
        `INSERT INTO option_values
          (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true, true)
         ON CONFLICT DO NOTHING`,
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
  };
  for (const [key, values] of Object.entries(stageTwoSeeds)) {
    const setId = setIds.get(key);
    if (!setId) continue;
    for (const [position, [value, label, colour, textColour]] of values.entries()) {
      await d1
        .prepare(
          `INSERT INTO option_values
            (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, true, true)
         ON CONFLICT DO NOTHING`,
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
          `INSERT INTO option_values
            (id, organisation_id, option_set_id, value, label, colour_hex, text_colour, position, is_done, is_default, active, system)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, true, true)
         ON CONFLICT DO NOTHING`,
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
 * Stage 2 compatibility.
 *
 * Mirrors drizzle/0007_stage_two_sites_units.sql for databases that were
 * provisioned before that migration existed. Every operation is additive and
 * idempotent. Groups G1/G2 remove this whole runtime path in Stage 8 once
 * migrations run at deploy time; until then an existing database that never
 * saw the migration must not fail on first request.
 */
async function ensureStageTwoFoundation(d1: CompatDatabase) {
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
    ["monday_maintenance_name", "text"],
    ["monday_compliance_name", "text"],
    ["notes", "text"],
  ];
  for (const [column, definition] of siteColumns) {
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
  }

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
  ]);

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
 * It is hoisted to run immediately after the base DDL batch and before Stage 1.
 * Every entry is an additive `ALTER TABLE … ADD COLUMN` guarded by
 * `PRAGMA table_info`, so it is idempotent and safe on existing databases; all
 * three tables are created in the base batch, so nothing here can run early.
 */

/**
 * Stage 3 compatibility — mirrors drizzle/0008 for databases that were created
 * before it existed. Additive and idempotent, following the Stage 2 pattern.
 */
async function ensureStageThreeBoardEngine(d1: CompatDatabase) {

  for (const table of ["item_updates", "item_activity"] as const) {
    const columns =
      table === "item_updates"
        ? `parent_id TEXT, author_name TEXT NOT NULL, author_email TEXT,
           body TEXT NOT NULL, edited_at TEXT`
        : `actor_name TEXT NOT NULL, column_key TEXT, action TEXT NOT NULL,
           value_before TEXT, value_after TEXT`;
  }

  // Column reconciliation moved to `ensureBoardEngineColumns`, which now runs
  // before Stage 1 — see the note on that function.

  // Materialise the implicit board so existing board_id values resolve.
  await d1
    .prepare(
      `INSERT INTO boards
         (id, organisation_id, key, name, kind, item_noun, reference_prefix, position)
       SELECT 'board_' || o.id || '_maintenance', o.id, 'maintenance', 'Maintenance',
              'maintenance', 'Job', 'MS', 0
       FROM organisations o
         ON CONFLICT DO NOTHING`,
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
async function ensureStageFourItems(_d1: CompatDatabase) {
  // Nothing left to do. This applied Stage 4's schema at runtime; the Postgres
  // migration defines those tables, columns and organisation-scoped indexes up
  // front. Kept as a no-op so `initialize()` reads as the same sequence of
  // stages, and deleted once nothing references it.
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
  d1: CompatDatabase,
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
        WHERE organisation_id = ? AND board_id = ? AND system = true`,
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
 * Seeds the board structure for one organisation — N11 and O13.
 *
 * Idempotent: INSERT OR IGNORE throughout, so an admin who deletes a seeded
 * column does not have it silently restored on the next boot.
 */
export async function seedBoardStructure(
  d1: CompatDatabase,
  organisationId: string,
  boardKey = "maintenance",
) {
  const columnsToSeed = [...seedColumns, ...seedUiColumns];

  for (const [position, column] of columnsToSeed.entries()) {
    await d1
      .prepare(
        `INSERT INTO maintenance_board_columns
           (id, organisation_id, board_id, column_key, title, type, position, width,
            settings, system, visible, pinned, required, summary, option_set_key, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, true, false, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
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
        column.system ? 1 : 0,
        column.required ? 1 : 0,
        column.summary ?? null,
        column.optionSetKey ?? null,
        column.description ?? null,
      )
      .run();
  }

  for (const [position, group] of seedGroups.entries()) {
    await d1
      .prepare(
        `INSERT INTO maintenance_groups
           (id, organisation_id, board_id, name, color, position, collapsed, archived,
            description, stage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, false, ?, ?)
         ON CONFLICT DO NOTHING`,
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
export async function seedStoreDocumentationGroups(d1: CompatDatabase, organisationId: string) {
  const groups: Array<[string, string, string, string]> = [
    // slug, name, colour, SQL predicate over `sites`
    ["current-stores", "Current stores", "#579bfc", "lifecycle = 'Current' AND region = 'UK'"],
    ["europe", "Europe", "#a25ddc", "region = 'Europe'"],
    ["closed", "Closed", "#ff5ac4", "lifecycle <> 'Current'"],
    ["other", "Other", "#757575", "lifecycle = 'Current' AND region NOT IN ('UK', 'Europe')"],
  ];

  for (const [position, [slug, name, colour, predicate]] of groups.entries()) {
    const id = `site-group-${organisationId}-${slug}`;
    await d1
      .prepare(
        `INSERT INTO site_groups
           (id, organisation_id, name, slug, kind, colour_hex, position)
         VALUES (?, ?, ?, ?, 'portfolio', ?, ?)
         ON CONFLICT DO NOTHING`,
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
        `INSERT INTO site_group_members
           (id, organisation_id, site_group_id, site_id)
         SELECT 'sgm-' || ? || '-' || s.id, ?, ?, s.id
           FROM sites s
          WHERE s.organisation_id = ? AND ${predicate}
         ON CONFLICT DO NOTHING`,
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
async function renameComplianceKinds(d1: CompatDatabase) {
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
async function ensureStageFiveBoardViews(d1: CompatDatabase) {
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
 * Stage 7 compatibility — mirrors drizzle/0011. Additive and idempotent.
 */
async function ensureStageSevenNotifications(d1: CompatDatabase) {
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
    const existing = await d1.prepare(`PRAGMA table_info(${table})`).all();
    const present = ((existing.results ?? []) as Array<{ name?: string }>).some(
      (row) => row.name === column,
    );
  }
}


/** Stage 9 compatibility — mirrors drizzle/0012. Additive and idempotent. */
async function ensureStageNineContractorLinks(d1: CompatDatabase) {
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
  ];

  for (const [table, column, definition] of additions) {
    const existing = await d1.prepare(`PRAGMA table_info(${table})`).all();
    const present = ((existing.results ?? []) as Array<{ name?: string }>).some(
      (row) => row.name === column,
    );
  }
}
