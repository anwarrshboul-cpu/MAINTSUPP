-- 006_workspace.sql — per-tenant and per-user UI state: what the sidebar shows,
-- which view each section opens on, dashboard tiles, and the recycle bin.
--
-- Every table here stores its payload as a JSON string in a `text` column with
-- a `'[]'` or `'{}'` default. They are left as `text` rather than promoted to
-- `jsonb` for one reason: the application does its own JSON.parse/stringify on
-- these values, and a `jsonb` column hands back an already-parsed object,
-- which would make `JSON.parse` throw on a non-string. Promoting them is a
-- worthwhile follow-up *paired with* a code change, and is recorded in the
-- README as deferred rather than done silently here.
--
-- The `user_id` columns on navigation_layouts, dashboard_layouts and
-- section_view_preferences are nullable on purpose: NULL means "the
-- organisation-wide default", and a row with a user id overrides it. That
-- interacts with the unique indexes in 008 — see the note there about NULL
-- not colliding with NULL in a unique index, which is true in both SQLite and
-- Postgres and so preserves the legacy behaviour exactly.

-- ---------------------------------------------------------------------------
-- workspace_settings — one row per client_id, which IS the primary key.
-- An unusual shape (no surrogate id) carried across verbatim.
-- ---------------------------------------------------------------------------
create table if not exists portal.workspace_settings (
  client_id text primary key not null default 'sunnamusk-uk',
  settings text not null default '{}',
  updated_by_email text,
  updated_at timestamptz not null default now(),
  organisation_id text,
  constraint workspace_settings_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- The configurable left-hand navigation: which sections exist, what they point
-- at, and in what order. `archived_at` is a soft-delete instant.
create table if not exists portal.workspace_sections (
  id text primary key,
  organisation_id text not null,
  key text not null,
  label text not null,
  icon text not null default 'grid',
  surface text not null default 'board',
  surface_ref text,
  group_key text not null default 'group:operations',
  position integer not null default 0,
  archived_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_sections_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Which saved view a given section opens on, per user (or org-wide when
-- user_id is NULL).
create table if not exists portal.section_view_preferences (
  id text primary key,
  organisation_id text not null,
  section_key text not null,
  user_id text,                      -- NULL = organisation default
  view_key text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint section_view_preferences_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.navigation_layouts (
  id text primary key,
  organisation_id text not null,
  user_id text,                      -- NULL = organisation default
  items text not null default '[]',  -- JSON array as text; see header
  locked text not null default '[]',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint navigation_layouts_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.dashboard_layouts (
  id text primary key,
  organisation_id text not null,
  user_id text,                      -- NULL = organisation default
  surface text not null default 'overview',
  items text not null default '[]',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_layouts_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- recycle_bin — soft-deleted entities awaiting expiry.
--
-- Both time columns are real instants and become timestamptz. `expires_at` is
-- NOT NULL with no default: the application always computes a retention
-- window, so there is nothing for Postgres to supply.
--
-- `entity_id` is intentionally unconstrained — the whole point of the table is
-- to describe rows that have been removed from their own table, so a foreign
-- key would be self-defeating.
-- ---------------------------------------------------------------------------
create table if not exists portal.recycle_bin (
  id text primary key,
  organisation_id text not null,
  entity_type text not null,
  entity_id text not null,           -- no FK by design: the row is gone
  board_id text,
  title text not null,
  summary text,
  placement text,
  deleted_by_email text,
  deleted_by_name text,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint recycle_bin_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);
