-- 003_estate.sql — the physical estate: sites, their groupings, the equipment
-- in them, and the contractors who service it.
--
-- MONEY AND MEASUREMENT DECISIONS MADE HERE
--
-- `*_pence` columns are widened from SQLite INTEGER to Postgres `bigint`.
-- SQLite's INTEGER is 64-bit; Postgres `integer` is 32-bit and caps at
-- 2,147,483,647 — about £21.5m expressed in pence. `annual_budget_pence`
-- already holds 1,800,000 for a single site in this dataset, so a
-- portfolio-level figure is well within reach of that ceiling. Widening costs
-- four bytes and removes a class of overflow bug that would otherwise appear
-- only once the customer grew.
--
-- REAL -> `double precision`, deliberately, and not `numeric`.
-- `latitude`, `longitude` and `contractors.rating` are genuine floats.
-- `maintenance_requests.cost`, `quotations.amount` and `invoices.amount` (in
-- 005) are money stored in a float column, which is a pre-existing flaw —
-- 74.76 and 199.2 are already inexact in the source. `double precision`
-- reproduces the stored bits exactly; `numeric` would silently round and make
-- the migration lossy in a way that is hard to detect afterwards. Fixing the
-- money representation is a schema change for the application to make, not
-- something a port should do behind its back. Flagged in the README.

-- ---------------------------------------------------------------------------
-- sites
--
-- Two traps in this table, both about columns that look like dates:
--
--   * `lease_start` / `lease_end` ARE dates. Both are edited through
--     `<input type="date">` (app/(app)/portal/sites/site-form.tsx:243-244) and
--     so are given Postgres `date`. Both are empty in the current dataset, so
--     this is a judgement from the UI rather than from the data.
--   * `break_clause` / `rent_review` are NOT dates despite sitting beside
--     them. They are free-text lease terms rendered verbatim
--     (site-detail.tsx:190-191) and edited with a plain text field
--     (site-form.tsx:245). They stay `text`. Typing them as `date` would
--     reject the "5 yearly"-style values the fields exist to hold.
--
-- `site_id` on other tables: note that `maintenance_requests.site_id` and
-- `attachments.site_id` carry no FK, here or in the legacy schema, and must
-- not be given one. See 005.
-- ---------------------------------------------------------------------------
create table if not exists portal.sites (
  id text primary key not null,
  client_id text not null default 'sunnamusk-uk',
  name text not null,
  type text not null,
  region text not null default 'UK',
  lifecycle text not null default 'Current',
  address text not null,
  manager text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  slug text,
  code text,
  site_type_value text,
  status text not null default 'active',
  address_line1 text,
  address_line2 text,
  city text,
  postcode text,
  country text not null default 'United Kingdom',
  latitude double precision,
  longitude double precision,
  position integer not null default 0,
  active boolean not null default true,
  manager_name text,
  manager_phone text,
  manager_email text,
  landlord text,
  managing_agent text,
  out_of_hours_contact text,
  access_method text,
  access_contact text,
  access_url text,
  access_notes text,
  opening_hours text,
  delivery_restrictions text,
  parking_notes text,
  key_alarm_notes text,
  lease_start date,          -- date picker in the UI; see note above
  lease_end date,            -- date picker in the UI; see note above
  break_clause text,         -- free-text lease term, NOT a date
  rent_review text,          -- free-text lease term, NOT a date
  service_charge_pence bigint,
  monday_maintenance_name text,
  monday_compliance_name text,
  notes text,
  annual_budget_pence bigint,
  constraint sites_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- Alternate names a site is known by in imported spreadsheets, used to resolve
-- free-text site names during Monday.com imports.
create table if not exists portal.site_aliases (
  id text primary key not null,
  organisation_id text not null,
  site_id text not null,
  alias text not null,
  normalised text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint site_aliases_site_id_fkey
    foreign key (site_id) references portal.sites(id),
  constraint site_aliases_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.site_groups (
  id text primary key not null,
  organisation_id text not null,
  name text not null,
  slug text not null,
  kind text not null default 'region',
  colour_hex text not null default '#12B4A8',
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_groups_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

create table if not exists portal.site_group_members (
  id text primary key not null,
  organisation_id text not null,
  site_group_id text not null,
  site_id text not null,
  created_at timestamptz not null default now(),
  constraint site_group_members_site_id_fkey
    foreign key (site_id) references portal.sites(id),
  constraint site_group_members_site_group_id_fkey
    foreign key (site_group_id) references portal.site_groups(id),
  constraint site_group_members_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- units — serviceable equipment inside a site.
--
-- Four date columns, all currently NULL across the 20 live rows, so the type
-- comes from how the UI writes them rather than from stored values:
-- `installed_at` and `warranty_expiry` are `<input type="date">` fields
-- (app/(app)/portal/units/units-manager.tsx:255-256), and `last_serviced_at`
-- and `next_service_due_at` are rendered by the same `formatDate` helper.
-- They are therefore `date`, matching the YYYY-MM-DD the form submits.
-- ---------------------------------------------------------------------------
create table if not exists portal.units (
  id text primary key not null,
  site_id text not null,
  name text not null,
  category text not null,
  manufacturer text,
  model text,
  serial_number text,
  status text not null default 'Active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organisation_id text,
  asset_tag text,
  location_in_site text,
  installed_at date,
  warranty_expiry date,
  purchase_price_pence bigint,
  supplier text,
  last_serviced_at date,
  next_service_due_at date,
  service_interval_months integer,
  position integer not null default 0,
  constraint units_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id),
  constraint units_site_id_fkey
    foreign key (site_id) references portal.sites(id)
);

-- `performed_at` is NOT NULL with no default and is a true instant, so it is
-- timestamptz. `request_id` and `contractor_id` are unconstrained in the
-- legacy schema (a service record may cite a job that has since been purged).
create table if not exists portal.unit_service_records (
  id text primary key not null,
  organisation_id text not null,
  unit_id text not null,
  site_id text not null,
  performed_at timestamptz not null,
  service_type text not null default 'Service',
  contractor_id text,
  contractor_name text,
  request_id text,
  outcome text,
  cost_pence bigint,
  notes text,
  recorded_by_email text,
  created_at timestamptz not null default now(),
  constraint unit_service_records_site_id_fkey
    foreign key (site_id) references portal.sites(id),
  constraint unit_service_records_unit_id_fkey
    foreign key (unit_id) references portal.units(id),
  constraint unit_service_records_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);

-- ---------------------------------------------------------------------------
-- contractors
--
-- `service_categories`, `coverage_areas` and `certifications` hold JSON arrays
-- as TEXT with a `'[]'` default. They stay `text` rather than becoming
-- `jsonb`: the application reads them with JSON.parse and writes them with
-- JSON.stringify, and a `jsonb` column would hand back a parsed object,
-- breaking that code. Converting to jsonb is a worthwhile follow-up once the
-- callers are updated — noted in the README as deferred, not done.
--
-- `insurance_expiry` is a `<input type="date">` field
-- (app/(app)/portal/workspace-data-manager.tsx:117) and so is `date`.
-- ---------------------------------------------------------------------------
create table if not exists portal.contractors (
  id text primary key not null,
  organisation_id text,
  name text not null,
  email text,
  phone text,
  service_categories text not null default '[]',
  coverage_areas text not null default '[]',
  certifications text not null default '[]',
  insurance_expiry date,
  availability text not null default 'Available',
  rating double precision,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contractors_organisation_id_fkey
    foreign key (organisation_id) references portal.organisations(id)
);
