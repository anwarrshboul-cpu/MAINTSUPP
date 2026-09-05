-- Retype the portal's flag columns from integer to boolean, in place.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `db/init.ts` is dialect-shared, so it declares every flag the only way SQLite
-- understands: `INTEGER NOT NULL DEFAULT 0`. `BOOLEAN_COLUMNS` in
-- `db/sqlite-to-postgres.ts` then rewrites every comparison against those
-- columns to `= true` / `= false`. The halves agree only if the column really
-- is boolean.
--
-- On Staging it always was. That schema came from
-- `migration/legacy-to-postgres/migrations/001_schema.sql`, which declares real
-- `boolean` columns, so every `CREATE TABLE IF NOT EXISTS` on the boot path
-- skipped and the SQLite declarations never ran. MAINTSUPP Production, created
-- fresh on 2026-09-05, was the first Postgres that `init.ts` had ever built on
-- its own -- and it produced all 35 flags as `integer`. Postgres then answered
-- every rewritten predicate with:
--
--   operator does not exist: integer = boolean          (42883)
--
-- which is quiet in the worst way: `ensureOwnerAccount` is called as
-- `ensureOwnerAccount(d1).catch(() => {})`, so the failed INSERT into `users`
-- was swallowed and sign-in reported "That email and password do not match an
-- account" -- a credential message for a schema fault.
--
-- `sqlite-to-postgres.ts` now declares these columns BOOLEAN, so a database
-- created from here on is correct at birth. THIS script is for one that already
-- exists with the integer shape.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES, AND WHAT IT REFUSES TO DO
-- ---------------------------------------------------------------------------
-- `USING (col <> 0)` converts in place: 0 becomes false, anything else true. No
-- row is deleted, no column is dropped, nothing is renamed, and the data that
-- was in the column is the data that comes out of it. It is NOT a reset -- it
-- is safe on a database that already holds real work.
--
-- Idempotent: a column already `boolean` is skipped, so re-running changes
-- nothing. It only ever touches columns whose current type is `integer` AND
-- whose (table, column) pair appears in the list below, which is
-- `BOOLEAN_COLUMNS` transcribed. A flag this list does not name is left alone.
--
-- The default is dropped before the type change and restored after, because
-- Postgres will not cast an existing `DEFAULT 0` to boolean on the way through.
-- NOT NULL is preserved by the ALTER itself and is deliberately not touched.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
-- Supabase dashboard -> SQL Editor -> paste -> Run. Then REDEPLOY: the fix in
-- the translator only affects statements issued after it ships, and Vercel
-- bakes the build at deploy time.
--
-- It prints one NOTICE per column changed and one summary line, so the output
-- is the record of what it did.

DO $$
DECLARE
  target   record;
  changed  int := 0;
  skipped  int := 0;
  absent   int := 0;
  current_type text;
  had_default  boolean;
  default_true boolean;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('attachments','pending'), ('attachments','is_current'),
      ('billing_settings','vat_enabled'), ('billing_settings','pro_rata_enabled'),
      ('board_views','is_default'), ('board_views','system'),
      ('boards','archived'),
      ('calendar_events','all_day'), ('calendar_events','archived'),
      ('compliance_documents','not_required'),
      ('contractors','active'),
      ('import_anomalies','resolved'),
      ('job_access_tokens','can_comment'), ('job_access_tokens','can_request_completion'),
      ('job_holds','approved'),
      ('maintenance_board_columns','pinned'), ('maintenance_board_columns','required'),
      ('maintenance_board_columns','system'), ('maintenance_board_columns','visible'),
      ('maintenance_board_options','active'), ('maintenance_board_options','system'),
      ('maintenance_groups','archived'), ('maintenance_groups','collapsed'),
      ('maintenance_requests','archived'),
      ('option_values','active'), ('option_values','is_default'),
      ('option_values','is_done'), ('option_values','system'),
      ('role_capabilities','allowed'),
      ('service_invoice_lines','included'),
      ('service_invoices','vat_enabled'),
      ('site_groups','active'),
      ('sites','active'), ('sites','billable'),
      ('sla_rules','active'),
      ('teams','archived'),
      ('users','active')
    ) AS t(table_name, column_name)
  LOOP
    SELECT c.data_type,
           c.column_default IS NOT NULL,
           coalesce(c.column_default LIKE '1%' OR lower(c.column_default) LIKE 'true%', false)
      INTO current_type, had_default, default_true
      FROM information_schema.columns c
     WHERE c.table_schema = 'portal'
       AND c.table_name   = target.table_name
       AND c.column_name  = target.column_name;

    IF current_type IS NULL THEN
      -- The product does not create every table on every deployment; a column
      -- that is not there yet is not a fault, and init.ts will create it with
      -- the corrected type.
      absent := absent + 1;
      CONTINUE;
    END IF;

    IF current_type <> 'integer' THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE portal.%I ALTER COLUMN %I DROP DEFAULT',
                   target.table_name, target.column_name);
    EXECUTE format('ALTER TABLE portal.%I ALTER COLUMN %I TYPE boolean USING (%I <> 0)',
                   target.table_name, target.column_name, target.column_name);
    IF had_default THEN
      EXECUTE format('ALTER TABLE portal.%I ALTER COLUMN %I SET DEFAULT %L',
                     target.table_name, target.column_name, default_true);
    END IF;

    changed := changed + 1;
    RAISE NOTICE 'retyped portal.%.% integer -> boolean (default %)',
      target.table_name, target.column_name,
      CASE WHEN had_default THEN default_true::text ELSE 'none' END;
  END LOOP;

  RAISE NOTICE 'boolean repair complete: % changed, % already boolean, % not present',
    changed, skipped, absent;
END $$;

-- Proof, for the record. Every row this returns should read `boolean`; anything
-- still `integer` was not in the list above and wants looking at by hand.
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'portal'
   AND (table_name, column_name) IN (
     ('attachments','is_current'), ('attachments','pending'),
     ('users','active'), ('contractors','active'),
     ('option_values','active'), ('role_capabilities','allowed'),
     ('boards','archived'), ('maintenance_requests','archived')
   )
 ORDER BY table_name, column_name;
