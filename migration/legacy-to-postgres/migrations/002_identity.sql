-- 002_identity.sql — organisations, people, and everything that authenticates.
--
-- ============================================================================
-- DIALECT DECISIONS APPLIED THROUGHOUT THIS MIGRATION SET
-- ============================================================================
--
-- 1. TEXT PRIMARY KEYS STAY TEXT.
--    Legacy ids are application-generated strings — `org_00000…0001`,
--    `req_4ff2c25d…`, `store-aldgate`, and imported Monday.com references like
--    `MN-1049`. They are quoted in URLs, in `object_key` paths in R2, and in
--    external systems. Re-keying to uuid would invalidate every one of those,
--    so the ids are carried across verbatim. No `uuid` columns are invented
--    anywhere in this schema.
--
-- 2. NO AUTOINCREMENT / SERIAL ANYWHERE.
--    Not one legacy table uses INTEGER PRIMARY KEY AUTOINCREMENT; SQLite's
--    implicit `rowid` is never selected by the application (verified against
--    db/schema.ts, which declares every primary key as `text(...)`, and
--    against the live DDL). There is therefore no sequence to create and no
--    `setval` to run after loading — a step that is mandatory when porting a
--    SQLite schema that *does* use AUTOINCREMENT, and whose omission normally
--    shows up as a duplicate-key error on the first insert after migration.
--    The one exception in spirit is `boards.reference_counter`, which the
--    application increments by hand to mint job references; it is a plain
--    integer column and is carried across with its current value.
--
-- 3. SQLite TEXT TIMESTAMPS -> timestamptz, BUT NOT UNIFORMLY.
--    The stored values were inspected rather than assumed, and three distinct
--    formats are present across the 84 time-bearing columns:
--      a) '2026-08-07 09:33:46'     — SQLite CURRENT_TIMESTAMP. 35,847 values.
--                                     Space-separated, no zone. SQLite defines
--                                     CURRENT_TIMESTAMP as UTC, so these are
--                                     read as UTC.
--      b) '2026-08-07T14:41:02.645Z' — JavaScript toISOString(). 19,625 values.
--                                     Already unambiguous UTC.
--      c) '2015-09-02'              — bare calendar date. 2,576 values.
--    A column is only given `timestamptz` when 100% of its non-null values
--    parse; the loader converts (a) by reading it as UTC and (b) directly.
--    See migration 005 for the columns where (c) dominates and the column is
--    given `date` instead.
--
-- 4. `DEFAULT CURRENT_TIMESTAMP` -> `DEFAULT now()`.
--    SQLite's CURRENT_TIMESTAMP yields a *string* in UTC with second
--    granularity. Postgres `now()` yields a timestamptz with microsecond
--    granularity at the session's timezone, stored as UTC. This is a
--    deliberate upgrade, not a transcription: the two agree on the instant,
--    and the extra precision only affects rows written *after* migration.
--
-- 5. SQLite INTEGER BOOLEANS -> boolean.
--    SQLite has no boolean type, so flags are stored as 0/1 integers. 27
--    columns were confirmed to hold only 0/1 and to be named/used as flags,
--    and become real `boolean`; `DEFAULT 0`/`DEFAULT 1` become
--    `DEFAULT false`/`DEFAULT true`. Integer columns that merely happen to
--    contain 0 and 1 in this dataset — `position`, `tier`, `use_count`,
--    `reference_counter`, `sign_in_failures.count` — stay `integer`.
--
-- 6. FOREIGN KEYS ARE REPLICATED EXACTLY, AND ONLY, AS THE LEGACY SCHEMA
--    DECLARES THEM.
--    D1/miniflare runs with `PRAGMA foreign_keys = 0`, so SQLite never
--    enforced these. `PRAGMA foreign_key_check` on the source returns zero
--    violations, so all 63 declared constraints can be created here and will
--    hold. Several *implied* relationships are deliberately NOT given
--    constraints because the data would reject them — see 005 for the detail.
--
-- 7. `INSERT OR IGNORE` -> `ON CONFLICT DO NOTHING`.
--    29 occurrences of `INSERT OR IGNORE` exist in the legacy application and
--    seed code (db/init.ts, db/seed-*.ts). None of them are DDL, so none are
--    translated here; this note exists because that rewrite is required before
--    the application itself can run against Postgres, and because the data
--    loader in ../load.mjs already uses `on conflict do nothing` to get the
--    same idempotency for the migration itself.

-- ---------------------------------------------------------------------------
-- organisations — the tenant root. Everything else hangs off this.
-- ---------------------------------------------------------------------------
create table if not exists portal.organisations (
  id text primary key not null,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  logo_url text,
  primary_colour text not null default '#12B4A8',
  plan_tier text not null default 'development',
  status text not null default 'active'
);

-- ---------------------------------------------------------------------------
-- users — `active` is the first of the 27 integer-boolean conversions.
-- `organisation_id` is nullable in the legacy schema (platform staff exist
-- outside any tenant), so the FK stays nullable here too.
-- ---------------------------------------------------------------------------
create table if not exists portal.users (
  id text primary key not null,
  organisation_id text,
  email text not null,
  full_name text,
  role text not null default 'client_user',
  active boolean not null default true,        -- was: integer default 1
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  password_hash text,
  password_updated_at timestamptz,
  last_login_at timestamptz,
  job_title text,
  phone text,
  timezone text not null default 'Europe/London',
  avatar_colour text,
  status text not null default 'active',
  deactivated_at timestamptz,
  theme_preference text not null default 'dark',
  working_status text,
  constraint users_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- memberships — user↔organisation with a role.
-- `approval_limit_pence` is money-as-integer-pence and is widened to bigint;
-- see the note on bigint widening in 003.
-- ---------------------------------------------------------------------------
create table if not exists portal.memberships (
  id text primary key not null,
  user_id text not null,
  organisation_id text not null,
  role text not null,
  site_scope text,
  approval_limit_pence bigint,
  status text not null default 'active',
  invited_by text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint memberships_user_id_fkey
    foreign key (user_id) references portal.users(id)
);

-- ---------------------------------------------------------------------------
-- sessions — 3,028 live rows, all four time columns in toISOString() form.
-- `organisation_id` carries no FK in the legacy schema even though every
-- stored value resolves; that omission is preserved rather than "fixed", so
-- this schema stays a faithful port. Adding it later is a one-line migration.
-- ---------------------------------------------------------------------------
create table if not exists portal.sessions (
  id text primary key,
  user_id text not null,
  token_hash text not null,
  organisation_id text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  ip_address text,
  user_agent text,
  constraint sessions_user_id_fkey
    foreign key (user_id) references portal.users(id)
);

create table if not exists portal.invitations (
  id text primary key,
  organisation_id text not null,
  email text not null,
  role text not null default 'client',
  token_hash text not null,
  invited_by text,
  message text,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id text,   -- resolves to users(id) in all 142 accepted rows,
                           -- but the legacy schema declares no FK; preserved.
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitations_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.password_resets (
  id text primary key,
  user_id text not null,
  organisation_id text,
  token_hash text not null,
  issued_by text,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint password_resets_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint password_resets_user_id_fkey
    foreign key (user_id) references portal.users(id)
);

create table if not exists portal.teams (
  id text primary key,
  organisation_id text not null,
  name text not null,
  slug text not null,
  description text,
  colour_hex text not null default '#12B4A8',
  position integer not null default 0,   -- ordering, not a flag: stays integer
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teams_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.team_members (
  id text primary key,
  organisation_id text not null,
  team_id text not null,
  user_id text not null,
  team_role text not null default 'member',
  created_at timestamptz not null default now(),
  constraint team_members_user_id_fkey
    foreign key (user_id) references portal.users(id),
  constraint team_members_team_id_fkey
    foreign key (team_id) references portal.teams(id),
  constraint team_members_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.role_capabilities (
  id text primary key,
  organisation_id text not null,
  role text not null,
  capability text not null,
  allowed boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint role_capabilities_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- sign_in_failures — the one table whose "timestamps" must NOT become
-- timestamptz.
--
-- `first_at` and `blocked_until` are INTEGER epoch **milliseconds**
-- (e.g. 1786613349820), written and compared arithmetically by the rate
-- limiter. Two consequences:
--   * They stay numeric. Converting to timestamptz would break the
--     `blocked_until > Date.now()` comparison the lockout depends on, and the
--     sentinel value 0 ("never blocked") has no sensible instant.
--   * They are `bigint`, not `integer`. 1.78e12 overflows Postgres `integer`
--     (max 2.147e9) — SQLite's INTEGER is 64-bit and hid this. This is the
--     single most likely silent failure in the whole port.
-- `count` is a genuine small counter and stays `integer`.
-- ---------------------------------------------------------------------------
create table if not exists portal.sign_in_failures (
  key text primary key,
  count integer not null default 0,
  first_at bigint not null default 0,
  blocked_until bigint not null default 0
);
