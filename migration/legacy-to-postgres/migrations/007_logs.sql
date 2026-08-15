-- 007_logs.sql — append-only trails and inbound records: activity, audit,
-- notifications, marketing leads, and import diagnostics.
--
-- These tables are created last because they reference organisations but
-- nothing references them, so they are the safe tail of both the DDL order and
-- the load order in ../load.mjs.
--
-- A note on `audit_events.created_at`, which is the clearest single example of
-- why the timestamp formats had to be inspected rather than assumed: its 6,470
-- rows contain BOTH formats — 4,433 written by the application as
-- '2026-08-07T14:38:18.013Z' and 2,037 written by SQLite's CURRENT_TIMESTAMP
-- as '2026-08-07 14:34:55'. A loader that handled only ISO-8601 would have
-- failed on a third of this table; one that handled only the SQLite form would
-- have failed on two thirds. The converter in ../lib/convert.mjs accepts both
-- and rejects anything else loudly.

-- ---------------------------------------------------------------------------
-- activity_log — the older, coarser trail (entity/action/actor).
-- All 3,486 rows use the CURRENT_TIMESTAMP format.
-- ---------------------------------------------------------------------------
create table if not exists portal.activity_log (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  entity_type text not null,
  entity_id text not null,           -- polymorphic; no FK possible
  action text not null,
  actor_email text,
  detail text,
  created_at timestamptz not null default now(),
  organisation_id text,
  constraint activity_log_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- audit_events — the newer, richer trail. Mixed timestamp formats; see header.
--
-- `organisation_id` is nullable here (platform-level events belong to no
-- tenant) and carries no declared FK in the legacy schema even though every
-- non-null value resolves. Preserved rather than tightened.
-- ---------------------------------------------------------------------------
create table if not exists portal.audit_events (
  id text primary key,
  organisation_id text,
  actor_user_id text,
  actor_email text,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id text,
  summary text not null,
  detail text,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Outbound email/notification delivery attempts. `attempts` is a retry counter
-- and stays integer; `delivered_at` is a real instant.
create table if not exists portal.notification_log (
  id text primary key,
  organisation_id text not null,
  channel text not null,
  event text not null,
  subject_type text not null,
  subject_id text,
  recipient text not null,
  subject text,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  provider_id text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- In-app notification bell. Keyed by email rather than user id, which is why
-- there is no FK to users despite the obvious relationship.
create table if not exists portal.system_notifications (
  id text primary key not null,
  user_email text not null,
  entity_type text not null,
  entity_id text not null,
  event text not null,
  title text not null,
  body text,
  read_at timestamptz,               -- NULL = unread
  created_at timestamptz not null default now(),
  organisation_id text,
  constraint system_notifications_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Marketing enquiries from the public site. `notify_attempts` is a retry
-- counter (integer), `notified_at` the instant the alert went out.
create table if not exists portal.leads (
  id text primary key not null,
  name text not null,
  company text not null,
  email text not null,
  phone text,
  site_range text not null,
  services text not null,
  regions text not null,
  challenge text not null,
  status text not null default 'New',
  created_at timestamptz not null default now(),
  organisation_id text,
  notified_at timestamptz,
  notify_attempts integer not null default 0,
  constraint leads_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- import_anomalies — what the Monday.com importer could not map cleanly.
-- `resolved` is a boolean conversion; `resolved_at` an instant.
-- `entity_id` is polymorphic and unconstrained.
-- ---------------------------------------------------------------------------
create table if not exists portal.import_anomalies (
  id text primary key not null,
  organisation_id text not null,
  batch_id text not null,
  entity_type text not null,
  entity_id text,
  source_name text,
  kind text not null,
  field text,
  original_value text,
  applied_value text,
  detail text,
  resolved boolean not null default false,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint import_anomalies_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);
