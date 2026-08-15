-- 004_boards.sql — the Monday.com-style board definitions: boards, their
-- columns, the option sets those columns draw from, the groups rows sit in,
-- and the saved views over them.
--
-- THE `board_id` TRAP — READ BEFORE ADDING ANY FOREIGN KEY HERE
--
-- `boards.id` looks like this:
--     board_org_000000000000000000000001_maintenance
-- but `board_id` on maintenance_board_cells, maintenance_groups,
-- maintenance_group_items, maintenance_board_columns, maintenance_board_options,
-- board_views, item_updates, item_activity and recycle_bin looks like this:
--     maintenance
--
-- That is, `board_id` stores the board's *key*, not its id, and is scoped by
-- `organisation_id` alongside it. Only two distinct values exist in the data
-- ('maintenance' and 'store-documentation') against four board rows, because
-- the same two keys are reused by both organisations.
--
-- Consequences, all deliberate:
--   * No `board_id -> boards(id)` foreign key can exist. It would reject
--     every row. The legacy schema declares none, and neither does this one.
--   * The natural key is (organisation_id, board_id), which is exactly what
--     the unique indexes in 008 use.
--   * Any future normalisation must rewrite the column contents first. This
--     is called out in the README as outstanding work, not silently repaired
--     here, because rewriting ids is a data change and this is a port.

-- ---------------------------------------------------------------------------
-- boards
--
-- `reference_counter` is the hand-rolled sequence used to mint job references
-- like MS-0042. It is an ordinary integer the application reads, increments
-- and writes back — not a SQLite AUTOINCREMENT — so it needs no Postgres
-- sequence and no post-load `setval`. It is carried across at its current
-- value so the next reference minted continues the series rather than
-- colliding with an existing one.
--
-- `organisation_id` is NOT NULL but carries no declared FK in the legacy
-- schema. All four rows resolve; the omission is preserved for fidelity.
-- ---------------------------------------------------------------------------
create table if not exists portal.boards (
  id text primary key,
  organisation_id text not null,
  key text not null,
  name text not null,
  description text,
  kind text not null default 'maintenance',
  item_noun text not null default 'Job',
  reference_prefix text not null default 'MS',
  reference_counter integer not null default 0,
  position integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- option_sets / option_values — the reusable dropdown vocabularies.
-- Four boolean conversions in option_values: is_done, is_default, active,
-- system. `position` beside them is ordering and stays integer.
-- ---------------------------------------------------------------------------
create table if not exists portal.option_sets (
  id text primary key not null,
  organisation_id text not null,
  key text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint option_sets_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.option_values (
  id text primary key not null,
  organisation_id text not null,
  option_set_id text not null,
  value text not null,
  label text not null,
  colour_hex text not null,
  text_colour text not null default '#ffffff',
  position integer not null default 0,
  is_done boolean not null default false,
  is_default boolean not null default false,
  active boolean not null default true,
  system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint option_values_option_set_id_fkey
    foreign key (option_set_id) references portal.option_sets(id),
  constraint option_values_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- maintenance_board_columns — column definitions for a board.
--
-- Note `system`, `visible`, `pinned` and `required` all become boolean, while
-- `position` and `width` (values like 105, 160, 180 — pixels) stay integer.
-- `settings` is a JSON blob kept as text for the same reason as contractors'
-- JSON array columns: the application parses it itself.
-- ---------------------------------------------------------------------------
create table if not exists portal.maintenance_board_columns (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  board_id text not null default 'maintenance',   -- board KEY, see header
  column_key text not null,
  title text not null,
  type text not null,
  position integer not null default 0,
  width integer not null default 160,             -- pixels, not a flag
  settings text not null default '{}',
  system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  visible boolean not null default true,
  pinned boolean not null default false,
  required boolean not null default false,
  summary text,
  option_set_key text,
  description text,
  organisation_id text,
  constraint maintenance_board_columns_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- The older, per-board copy of the dropdown options, predating option_sets.
-- Both survive in the legacy schema and both are migrated; deduplicating them
-- is an application concern.
create table if not exists portal.maintenance_board_options (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  board_id text not null default 'maintenance',
  column_key text not null,
  value text not null,
  label text not null,
  color text not null default '#579bfc',
  text_color text not null default '#ffffff',
  active boolean not null default true,
  system boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  constraint maintenance_board_options_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Groups are the coloured bands a board's rows are bucketed into.
-- `deleted_at` is a soft-delete marker; it is a real instant, so timestamptz.
create table if not exists portal.maintenance_groups (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  board_id text not null default 'maintenance',
  name text not null,
  color text not null default '#579bfc',
  stage_key text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  collapsed boolean not null default false,
  archived boolean not null default false,
  description text,
  organisation_id text,
  deleted_at timestamptz,
  deleted_by text,
  constraint maintenance_groups_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Saved views. `filters` and `sort` are JSON arrays held as text, again
-- because the application does its own parsing.
create table if not exists portal.board_views (
  id text primary key,
  organisation_id text not null,
  board_id text not null default 'maintenance',
  key text not null,
  name text not null,
  type text not null default 'table',
  icon text,
  filters text not null default '[]',
  sort text not null default '[]',
  settings text not null default '{}',
  position integer not null default 0,
  is_default boolean not null default false,
  system boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
