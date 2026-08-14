-- 0002 — identity: users, sessions, organisations, sites, profiles, invitations.
--
-- The API owns authentication. There is no dependency on Supabase's `auth`
-- schema, which is what lets this exact SQL run against local PGlite as well as
-- hosted Supabase, and what would let the database move again later.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Nullable: an invited user exists before they have chosen a password. A row
  -- with a null hash can never authenticate — the verifier fails closed rather
  -- than treating "no password" as "any password".
  password_hash text,
  email_verified_at timestamptz,
  -- Set while a reset is outstanding. Stored hashed, never in the clear, so a
  -- database leak does not hand over live reset links.
  reset_token_hash text,
  reset_expires_at timestamptz,
  verify_token_hash text,
  verify_expires_at timestamptz,
  -- Brute-force throttling lives on the row so it survives a restart and is
  -- shared across every API instance Railway runs.
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness. Without `lower()`, Anwar@… and anwar@… are two
-- accounts, and whichever signs up second silently shadows the first.
create unique index if not exists users_email_unique on users (lower(email));

/*
 * Sessions are rows, not self-contained JWTs.
 *
 * A stateless token cannot be revoked before it expires, so "sign out
 * everywhere" and "deactivate this account now" would both be lies. The cost is
 * one indexed lookup per request, which is cheaper than the alternative being
 * untrue.
 *
 * Only the hash is stored: the cookie holds the secret, the database holds
 * sha-256 of it, so a leaked table does not let anyone log in as anybody.
 */
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  -- Whether "Keep me signed in" was ticked. Drives the cookie's lifetime and
  -- the absolute expiry below.
  persistent boolean not null default true,
  user_agent text,
  ip_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expiry_idx on sessions (expires_at) where revoked_at is null;

create table if not exists organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  contact_email text,
  contact_phone text,
  is_demo boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  address text,
  postcode text,
  access_notes text,
  store_type text,
  is_demo boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sites_org_idx on sites (organisation_id);
-- One store name per organisation. The legacy data has "Brent Cross" and
-- "Brentcross" as separate sites feeding separate totals; this stops the same
-- mistake being made again through the UI.
create unique index if not exists sites_org_name_unique on sites (organisation_id, lower(name));

create table if not exists contractors (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete set null,
  name text not null,
  email text,
  phone text,
  service_categories text[] not null default '{}',
  coverage_areas text[] not null default '{}',
  certifications text[] not null default '{}',
  insurance_expiry date,
  rating numeric(3,2),
  availability text not null default 'unknown',
  is_demo boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
 * A profile is the application's view of a user: who they are to the business.
 *
 * Split from `users` on purpose. `users` holds the credential and nothing else,
 * so the table that authentication touches is small and rarely changes shape,
 * while roles, scoping and status churn with the product.
 */
create table if not exists profiles (
  id uuid primary key references users(id) on delete cascade,
  email text not null,
  full_name text,
  phone text,
  role user_role not null default 'client_user',
  status profile_status not null default 'pending_approval',
  organisation_id uuid references organisations(id) on delete set null,
  contractor_id uuid references contractors(id) on delete set null,
  is_demo boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  /*
   * A client role without an organisation can see nothing and is almost
   * certainly a half-finished approval. Refusing it here means the API cannot
   * create that state by forgetting a field.
   *
   * Only enforced once active: a pending_approval row legitimately has neither,
   * because assigning them is what approving *is*.
   */
  constraint profiles_client_scope check (
    status <> 'active'
    or role not in ('client_admin', 'client_user')
    or organisation_id is not null
  ),
  constraint profiles_contractor_scope check (
    status <> 'active' or role <> 'contractor' or contractor_id is not null
  )
);

create index if not exists profiles_org_idx on profiles (organisation_id);
create index if not exists profiles_role_idx on profiles (role);

/* client_user is scoped to sites, which is many-to-many. */
create table if not exists profile_sites (
  profile_id uuid not null references profiles(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, site_id)
);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role user_role not null,
  organisation_id uuid references organisations(id) on delete cascade,
  contractor_id uuid references contractors(id) on delete cascade,
  -- 256 bits. Long enough that guessing is not a strategy.
  token_hash text not null unique,
  status invitation_status not null default 'pending',
  invited_by uuid references profiles(id) on delete set null,
  accepted_by uuid references profiles(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one live invitation per address. A second one would make "which link
-- is valid" depend on which email the recipient happens to open.
create unique index if not exists invitations_pending_email_unique
  on invitations (lower(email)) where status = 'pending';

/*
 * Pre-declared roles, applied on first sign-up.
 *
 * This is how the owner account is founded without inserting a half-built user
 * row: the address is declared here, and whoever signs up with it is provisioned
 * at that role instead of the pending_approval default. It also means the
 * founding account is created by the ordinary sign-up path, with a real
 * password the owner chose, rather than a seeded credential someone has to
 * remember to change.
 */
create table if not exists role_bootstrap (
  email text primary key,
  role user_role not null,
  organisation_id uuid references organisations(id) on delete set null,
  contractor_id uuid references contractors(id) on delete set null,
  note text,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

drop trigger if exists users_touch on users;
create trigger users_touch before update on users
  for each row execute function touch_updated_at();

drop trigger if exists organisations_touch on organisations;
create trigger organisations_touch before update on organisations
  for each row execute function touch_updated_at();

drop trigger if exists sites_touch on sites;
create trigger sites_touch before update on sites
  for each row execute function touch_updated_at();

drop trigger if exists contractors_touch on contractors;
create trigger contractors_touch before update on contractors
  for each row execute function touch_updated_at();

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();

drop trigger if exists invitations_touch on invitations;
create trigger invitations_touch before update on invitations
  for each row execute function touch_updated_at();
