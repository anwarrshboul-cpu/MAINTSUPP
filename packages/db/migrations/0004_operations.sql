-- 0004 — leads, invoices, compliance and the audit trail.

/* The landing page's "Book a Portfolio Review" form. */
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text not null,
  email text not null,
  phone text,
  site_range text not null,
  services text[] not null default '{}',
  regions text[] not null default '{}',
  challenge text not null,
  status lead_status not null default 'new',
  -- Notification bookkeeping. `notify_attempts` exists so a mail outage shows
  -- up as a number rather than as leads nobody ever hears about again.
  notified_at timestamptz,
  notify_attempts integer not null default 0,
  source_ip_hash text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_status_idx on leads (status, created_at desc);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  contractor_id uuid references contractors(id) on delete set null,
  attachment_id uuid references attachments(id) on delete set null,
  invoice_number text,
  -- Money is integer pence throughout. A float would make £0.10 + £0.20 fail to
  -- equal £0.30, and this column ends up in client-facing totals.
  amount_pence bigint not null check (amount_pence >= 0),
  status invoice_status not null default 'awaiting_payment',
  issued_at date,
  due_at date,
  paid_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoices_org_idx on invoices (organisation_id);
create index if not exists invoices_job_idx on invoices (job_id);

create table if not exists compliance_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  kind text not null,
  attachment_id uuid references attachments(id) on delete set null,
  expiry_date date,
  /*
   * Three of the twelve certificates monday tracks carry no expiry — RAMS, the
   * fire risk assessment and the store drawing. `not_required` distinguishes
   * "nobody asks for a date" from "the date is missing", which the compliance
   * score has to tell apart or it counts a non-requirement as a failure.
   */
  not_required boolean not null default false,
  status compliance_status not null default 'Missing',
  last_alert_at timestamptz,
  last_alert_stage text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (site_id, kind)
);

create index if not exists compliance_site_idx on compliance_documents (site_id);
create index if not exists compliance_expiry_idx on compliance_documents (expiry_date)
  where not not_required;

/*
 * The audit trail.
 *
 * `actor_email` is denormalised on purpose: the point of an audit row is to
 * still say who did it after the profile has been deleted, and a foreign key
 * that nulls on delete would erase exactly the records most worth keeping.
 */
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete set null,
  actor_profile_id uuid references profiles(id) on delete set null,
  actor_email text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_entity_idx on activity_log (entity_type, entity_id, created_at desc);
create index if not exists activity_org_idx on activity_log (organisation_id, created_at desc);

drop trigger if exists leads_touch on leads;
create trigger leads_touch before update on leads
  for each row execute function touch_updated_at();

drop trigger if exists invoices_touch on invoices;
create trigger invoices_touch before update on invoices
  for each row execute function touch_updated_at();

drop trigger if exists compliance_touch on compliance_documents;
create trigger compliance_touch before update on compliance_documents
  for each row execute function touch_updated_at();
