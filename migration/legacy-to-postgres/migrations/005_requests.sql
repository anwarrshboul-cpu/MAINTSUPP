-- 005_requests.sql — jobs and everything attached to them.
--
-- ============================================================================
-- THE `date` vs `timestamptz` SPLIT, AND WHY IT IS NOT UNIFORM
-- ============================================================================
--
-- The instruction "SQLite TEXT timestamps -> timestamptz" is right for most
-- columns and wrong for four of them, and the data says which is which.
--
--   maintenance_requests.due_at            67 values, 100% 'YYYY-MM-DD'
--   maintenance_requests.completed_at     485 values, 100% 'YYYY-MM-DD'
--   maintenance_requests.next_update_at    94 values, 100% 'YYYY-MM-DD'
--   compliance_documents.expiry_date       34 values, 100% 'YYYY-MM-DD'
--
-- These are calendar dates, not instants. They are written by
-- `<input type="date">` (portal-app.tsx:4809 edits dueAt with a "date" editor)
-- and read straight back as strings. Forcing them into timestamptz would
-- attach a fabricated 00:00:00 and a timezone, and then a viewer east or west
-- of UTC would see the *previous or next day* — the classic off-by-one-day
-- bug, introduced by the migration rather than present in the source.
-- Postgres `date` round-trips 'YYYY-MM-DD' exactly and cannot drift.
--
-- By contrast `requested_at` IS an instant and IS timestamptz, even though
-- 634 of its 776 values are bare dates and only 142 carry a time. That column
-- is NOT NULL DEFAULT CURRENT_TIMESTAMP, is genuinely a moment the job
-- arrived, and its date-only values are backfill from the Monday.com import,
-- which never had a time to give. Those 634 rows land at 00:00:00Z. That is a
-- precision limit inherited from the source, not lost by this migration —
-- there is no time-of-day in SQLite to discard. It is listed in the README
-- under "lossy" anyway, because a reader comparing the two databases will see
-- midnight where the source showed a bare date and deserves the explanation.
--
-- ============================================================================
-- FOREIGN KEYS DELIBERATELY NOT CREATED
-- ============================================================================
--
-- `PRAGMA foreign_key_check` passes on the source, so every *declared* FK is
-- created. Three implied relationships are left unconstrained because the live
-- data would reject them, and dropping or rewriting those rows to satisfy a
-- constraint nobody asked for would be a silent data change:
--
--   maintenance_requests.site_id -> sites(id)    31 rows fail.
--       All 31 store the empty string '' rather than a site id. NOT NULL is
--       satisfied, referential integrity is not. Real sites are 'store-aldgate'
--       and friends. Preserved as-is; the rows are otherwise intact jobs.
--   attachments.site_id -> sites(id)             95 rows fail, same cause ('').
--   item_activity.request_id -> maintenance_requests(id)   6 rows fail.
--       Three req_* ids and three 'MN-1049' entries whose jobs no longer
--       exist — audit trail outliving its subject.
--
-- Adding any of these constraints is a data-cleaning decision for the owners,
-- not a migration decision. They are reported by ../verify.mjs so they cannot
-- quietly rot.

-- ---------------------------------------------------------------------------
-- maintenance_requests — the central table. 776 rows.
--
-- `tier` holds 0 and 2 with a default of 2. It is a severity level, not a
-- flag, and stays `integer` — one of the cases where the 0/1-looking data
-- would have misled a purely mechanical boolean conversion.
--
-- `cost` is `double precision`; see the money note in 003.
-- `archived` is the boolean conversion; `notify_attempts` and the four
-- `*_attachment_count` columns are counters and stay integer.
-- ---------------------------------------------------------------------------
create table if not exists portal.maintenance_requests (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  site_id text not null,             -- no FK: 31 rows hold '' (see header)
  source text not null default 'Portal form',
  title text not null,
  description text not null,
  location text not null,
  requester text not null,
  contact text not null,
  category text not null,
  engineer text not null,
  tier integer not null default 2,   -- severity level, NOT a boolean
  priority text not null default 'Medium',
  stage text not null default 'Incoming',
  status text not null default 'Pending Approval',
  contractor text,
  assignee text,
  requested_at timestamptz not null default now(),  -- instant; see header
  due_at date,                                      -- calendar date
  completed_at date,                                -- calendar date
  next_update_at date,                              -- calendar date
  cost double precision,
  approved_by text,
  invoice text,
  attachment_count integer not null default 0,
  issue_attachment_count integer not null default 0,
  completed_attachment_count integer not null default 0,
  general_attachment_count integer not null default 0,
  form_url text,
  public_upload_token_hash text,
  public_upload_token_expires_at timestamptz,
  comment_count integer not null default 0,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reference text,
  archived boolean not null default false,
  archived_at timestamptz,
  organisation_id text,
  parent_id text,                    -- self-reference for subitems; every
                                     -- value resolves, but the legacy schema
                                     -- declares no FK, so neither do we
  notified_at timestamptz,
  notify_attempts integer not null default 0,
  completion_requested_at timestamptz,
  completion_requested_by text,
  completion_note text,
  blocked_reason text,
  external_id text,                  -- Monday.com pulse id for imported jobs
  deleted_at timestamptz,
  deleted_by text,
  completion_signature text,
  completion_signed_at timestamptz,
  completion_signed_by text,
  constraint maintenance_requests_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Which group a job sits in, and where within it. The primary key is
-- `request_id`, so a job belongs to exactly one group — enforced by the PK
-- rather than by a unique index.
create table if not exists portal.maintenance_group_items (
  request_id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  board_id text not null default 'maintenance',
  group_id text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  constraint maintenance_group_items_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint maintenance_group_items_group_id_fkey
    foreign key (group_id) references portal.maintenance_groups(id),
  constraint maintenance_group_items_request_id_fkey
    foreign key (request_id) references portal.maintenance_requests(id)
);

-- ---------------------------------------------------------------------------
-- maintenance_board_cells — 8,720 rows, the largest table, and the reason
-- `value` must stay `text`.
--
-- `value` is a single untyped column holding whatever the column type calls
-- for. Sampling it finds bare dates (2015-09-02), people's names, comma-joined
-- Monday.com attachment URLs, phone numbers stored with a leading zero
-- (01179529394 — which any numeric type would mangle to 1179529394), plain
-- integers, date *ranges* ('2023-03-13 - 2023-03-31'), and 61 rows literally
-- reading '[object Object]' from a prior stringify bug.
--
-- 1,262 of those values match YYYY-MM-DD. A naive date-detector run per value
-- rather than per column would have converted exactly those and broken the
-- other 7,458. `text` is the only correct type here.
-- ---------------------------------------------------------------------------
create table if not exists portal.maintenance_board_cells (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  board_id text not null default 'maintenance',
  request_id text not null,
  column_id text not null,
  value text not null default '',    -- untyped bag; see header. Stays text.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  constraint maintenance_board_cells_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint maintenance_board_cells_column_id_fkey
    foreign key (column_id) references portal.maintenance_board_columns(id),
  constraint maintenance_board_cells_request_id_fkey
    foreign key (request_id) references portal.maintenance_requests(id)
);

-- Threaded comments on a job. Mixed timestamp formats within `created_at`
-- (269 ISO-8601 from the importer, 84 from CURRENT_TIMESTAMP) — both parse,
-- so the column converts cleanly.
create table if not exists portal.item_updates (
  id text primary key,
  organisation_id text not null,
  board_id text not null default 'maintenance',
  request_id text not null,
  parent_id text,
  author_name text not null,
  author_email text,
  body text not null,
  edited_at timestamptz,
  created_at timestamptz not null default now()
);

-- Composite primary key, carried across unchanged. One like per person per
-- update, which the PK enforces without needing a separate unique index.
create table if not exists portal.item_update_likes (
  update_id text not null,
  organisation_id text not null,
  actor_email text not null,
  actor_name text not null,
  created_at timestamptz not null default now(),
  primary key (update_id, actor_email),
  constraint item_update_likes_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Per-job audit trail. `request_id` has 6 orphans, so no FK (see header).
create table if not exists portal.item_activity (
  id text primary key,
  organisation_id text not null,
  board_id text not null default 'maintenance',
  request_id text not null,
  actor_name text not null,
  column_key text,
  action text not null,
  value_before text,
  value_after text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- attachments — 2,968 rows of FILE METADATA ONLY.
--
-- The bytes live in R2/object storage keyed by `object_key`; nothing binary is
-- stored in this database and none is moved by this migration. `byte_size` is
-- widened to bigint because Postgres `integer` caps at 2.1GB and a single
-- large upload would overflow it.
--
-- `site_id` has 95 empty-string rows and so gets no FK (see header).
-- `unit_id`, `update_id` and `board_column_id` all resolve cleanly today but
-- carry no FK in the legacy schema; preserved as-is.
-- ---------------------------------------------------------------------------
create table if not exists portal.attachments (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  request_id text,
  site_id text,                      -- no FK: 95 rows hold ''
  kind text not null default 'issue',
  board_column_id text,
  object_key text not null,          -- R2 key; the bytes are NOT in Postgres
  original_name text not null,
  content_type text not null,
  byte_size bigint not null,         -- widened: integer caps at 2.1GB
  uploaded_by_email text,
  created_at timestamptz not null default now(),
  organisation_id text,
  unit_id text,
  pending boolean not null default false,
  submitted_via text,
  reviewed_at timestamptz,
  reviewed_by text,
  update_id text,
  constraint attachments_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint attachments_request_id_fkey
    foreign key (request_id) references portal.maintenance_requests(id)
);

-- Compliance certificates per site. `expiry_date` is a calendar date (see
-- header). `attachment_id` FK is declared in the legacy schema and is
-- satisfied, so it is created — which is why this table must be created after
-- attachments, and why the loader orders it that way too.
create table if not exists portal.compliance_documents (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  site_id text not null,             -- no FK in legacy schema; all resolve
  kind text not null,
  status text not null default 'Missing',
  expiry_date date,                  -- calendar date, not an instant
  attachment_id text,
  not_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  last_alert_at timestamptz,
  last_alert_stage text,             -- a stage NAME ('30d'), not a timestamp
  constraint compliance_documents_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint compliance_documents_attachment_id_fkey
    foreign key (attachment_id) references portal.attachments(id)
);

-- Quotes and invoices are both empty in the current dataset. Their types come
-- from the legacy DDL and from the sibling columns above: money as
-- `double precision` for consistency with maintenance_requests.cost, and
-- `invoices.due_at` as `date` to match maintenance_requests.due_at, since both
-- are the same "day it is owed" concept.
create table if not exists portal.quotations (
  id text primary key not null,
  request_id text not null,
  contractor_id text,
  amount double precision not null,
  status text not null default 'Awaiting approval',
  attachment_id text,
  submitted_at timestamptz not null default now(),
  approved_at timestamptz,
  organisation_id text,
  constraint quotations_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint quotations_contractor_id_fkey
    foreign key (contractor_id) references portal.contractors(id),
  constraint quotations_request_id_fkey
    foreign key (request_id) references portal.maintenance_requests(id)
);

create table if not exists portal.invoices (
  id text primary key not null,
  request_id text not null,
  contractor_id text,
  invoice_number text,
  amount double precision not null,
  status text not null default 'Awaiting payment',
  due_at date,                       -- calendar date, matching requests.due_at
  paid_at timestamptz,               -- an instant: when payment landed
  attachment_id text,
  created_at timestamptz not null default now(),
  organisation_id text,
  constraint invoices_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint invoices_contractor_id_fkey
    foreign key (contractor_id) references portal.contractors(id),
  constraint invoices_request_id_fkey
    foreign key (request_id) references portal.maintenance_requests(id)
);

-- Scheduled/recurring work. `next_due_at` holds full ISO-8601 instants with
-- real times ('2026-07-29T16:00:00.000Z' — a 16:00 appointment), so unlike the
-- request due dates above it is genuinely timestamptz.
create table if not exists portal.planned_maintenance (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  site_id text not null,
  unit_id text,
  contractor_id text,
  title text not null,
  category text not null,
  frequency text not null,
  next_due_at timestamptz not null,  -- carries a time of day; a real instant
  last_completed_at timestamptz,
  status text not null default 'Scheduled',
  reminder_days integer not null default 30,   -- a count of days, not a flag
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  constraint planned_maintenance_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint planned_maintenance_contractor_id_fkey
    foreign key (contractor_id) references portal.contractors(id),
  constraint planned_maintenance_unit_id_fkey
    foreign key (unit_id) references portal.units(id),
  constraint planned_maintenance_site_id_fkey
    foreign key (site_id) references portal.sites(id)
);

-- Share links handed to contractors. `allowed_kinds` is a JSON array kept as
-- text (same reasoning as elsewhere). `can_comment` and
-- `can_request_completion` are boolean conversions; `use_count` is a counter
-- and stays integer despite holding small values like 0 and 1.
create table if not exists portal.job_access_tokens (
  id text primary key,
  organisation_id text not null,
  request_id text not null,
  token_hash text not null,
  audience text not null default 'contractor',
  label text,
  allowed_kinds text not null default '["completion","nameplate"]',
  can_comment boolean not null default true,
  can_request_completion boolean not null default true,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text,
  first_opened_at timestamptz,
  last_used_at timestamptz,
  use_count integer not null default 0,
  created_at timestamptz not null default now()
);
