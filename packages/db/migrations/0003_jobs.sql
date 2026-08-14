-- 0003 — the ticket system: intake, jobs, comments, quotes, attachments.

/*
 * Public intake from the landing page's Report a Job form.
 *
 * Deliberately separate from `jobs`. A request is something a stranger typed
 * into a form on the internet; a job is something a coordinator has accepted.
 * Merging them would put unverified rows on the board, and would mean the
 * anonymous insert path could write to the table the whole product reads.
 */
create table if not exists job_requests (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete set null,
  site_name text not null,
  contact_name text not null,
  phone text not null,
  email text not null,
  address text not null,
  postcode text not null,
  fault_category text not null,
  urgency text not null,
  description text not null,
  access_window text,
  -- Object keys in private storage, never URLs. Photographs are mandatory on
  -- the form ("requests without clear pictures will be declined"), but the
  -- constraint is not enforced here: a request that arrives without them is
  -- evidence of a bug or an abusive client, and losing it would hide that.
  photos text[] not null default '{}',
  status job_request_status not null default 'new',
  rejected_reason text,
  converted_job_id uuid,
  triaged_by uuid references profiles(id) on delete set null,
  triaged_at timestamptz,
  -- Hashed, not stored raw: enough to rate-limit and spot a flood, not enough
  -- to be a log of who reported what from where.
  source_ip_hash text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_requests_status_idx on job_requests (status, created_at desc);

/* Human-readable job numbers. MS-00001 upward — quotable over the phone. */
create sequence if not exists job_reference_seq start 1;

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('MS-' || lpad(nextval('job_reference_seq')::text, 5, '0')),
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id uuid references sites(id) on delete set null,
  source_request_id uuid references job_requests(id) on delete set null,

  -- The monday columns, one per field.
  title text not null,
  description text not null,
  location text,
  engineer_required engineer_required,
  priority job_priority,
  fault_label job_fault_label,
  tier_level smallint check (tier_level between 1 and 4),
  contractor_id uuid references contractors(id) on delete set null,
  contractor_name text,
  assigned_to uuid references profiles(id) on delete set null,
  assigned_to_name text,
  date_requested timestamptz not null default now(),
  date_completed timestamptz,
  next_update date,
  job_requested_by text,
  contact_number text,
  cost_of_works_pence bigint,
  approved_by text,
  approved_by_profile_id uuid references profiles(id) on delete set null,
  invoice_ref text,

  status job_status not null default 'Pending Approval',
  /*
   * Generated, never written. The API writes `status`; the stage follows.
   * A stored generated column rather than a trigger so it is correct even for
   * rows written by a migration or a direct SQL fix.
   */
  stage job_stage generated always as (job_stage_for(status)) stored,
  status_changed_at timestamptz not null default now(),

  -- First-entry timestamps per stage, maintained by the trigger below.
  stage_new_at timestamptz,
  stage_scheduling_at timestamptz,
  stage_in_progress_at timestamptz,
  stage_quotes_at timestamptz,
  stage_on_hold_at timestamptz,
  stage_payment_at timestamptz,
  stage_done_at timestamptz,

  /*
   * The share link.
   *
   * 256 bits of CSPRNG output as 64 hex characters. It is a bearer credential —
   * whoever holds it sees the job — so it must be long enough that guessing is
   * hopeless, and it must never appear in a URL that gets logged server-side
   * beyond the redemption endpoint.
   *
   * `share_enabled` allows revocation without destroying the record of which
   * token was issued; `share_expires_at` allows a link to age out.
   */
  share_token text not null unique default encode(gen_random_bytes(32), 'hex'),
  share_enabled boolean not null default true,
  share_expires_at timestamptz,

  created_by uuid references profiles(id) on delete set null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_org_idx on jobs (organisation_id);
create index if not exists jobs_site_idx on jobs (site_id);
create index if not exists jobs_stage_idx on jobs (stage);
create index if not exists jobs_contractor_idx on jobs (contractor_id);
create index if not exists jobs_requested_idx on jobs (date_requested desc);

-- Close the loop between a request and the job it became.
do $$ begin
  alter table job_requests
    add constraint job_requests_converted_fk
    foreign key (converted_job_id) references jobs(id) on delete set null;
exception when duplicate_object then null; end $$;

/*
 * Stamps the stage timestamps on entry, and only on FIRST entry.
 *
 * "When did this reach In Progress" has one answer, and a job that bounces
 * back from On Hold must not rewrite it — otherwise every ageing and SLA figure
 * silently resets each time somebody flips a status back and forth.
 */
create or replace function stamp_job_stage()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  new.status_changed_at = now();

  case job_stage_for(new.status)
    when 'New' then new.stage_new_at = coalesce(new.stage_new_at, now());
    when 'Scheduling' then new.stage_scheduling_at = coalesce(new.stage_scheduling_at, now());
    when 'In Progress' then new.stage_in_progress_at = coalesce(new.stage_in_progress_at, now());
    when 'Quotes' then new.stage_quotes_at = coalesce(new.stage_quotes_at, now());
    when 'On Hold' then new.stage_on_hold_at = coalesce(new.stage_on_hold_at, now());
    when 'Payment' then new.stage_payment_at = coalesce(new.stage_payment_at, now());
    when 'Done' then new.stage_done_at = coalesce(new.stage_done_at, now());
  end case;

  return new;
end;
$$;

drop trigger if exists jobs_stamp_stage on jobs;
create trigger jobs_stamp_stage before insert or update of status on jobs
  for each row execute function stamp_job_stage();

drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();

create table if not exists job_comments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  body text not null,
  -- Null for a contractor commenting through a share link, who has no account.
  author_profile_id uuid references profiles(id) on delete set null,
  author_name text,
  visibility comment_visibility not null default 'public',
  via_share_link boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz,

  -- Every comment must be attributable to somebody. An unsigned note on a job
  -- record is worthless in a dispute about who agreed to what.
  constraint job_comments_authorship check (
    author_profile_id is not null or nullif(trim(author_name), '') is not null
  )
);

create index if not exists job_comments_job_idx on job_comments (job_id, created_at);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  amount_pence bigint not null check (amount_pence >= 0),
  description text,
  status quote_status not null default 'pending',
  valid_until date,
  created_by uuid references profiles(id) on delete set null,
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A decided quote records who decided and when. Without this an approval can
  -- exist with nobody's name against it.
  constraint quotes_decision check (
    status = 'pending' or (decided_by is not null and decided_at is not null)
  )
);

create index if not exists quotes_job_idx on quotes (job_id);

drop trigger if exists quotes_touch on quotes;
create trigger quotes_touch before update on quotes
  for each row execute function touch_updated_at();

/*
 * Uploaded files.
 *
 * `object_key` only — never a public URL. Buckets are private and the API hands
 * out short-lived signed URLs, so a leaked row is not a leaked photograph.
 */
create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  kind attachment_kind not null default 'file',
  bucket_id text not null default 'job-media',
  object_key text not null unique,
  original_name text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),

  job_id uuid references jobs(id) on delete cascade,
  job_request_id uuid references job_requests(id) on delete cascade,
  site_id uuid references sites(id) on delete cascade,
  comment_id uuid references job_comments(id) on delete cascade,
  organisation_id uuid references organisations(id) on delete cascade,

  uploaded_by uuid references profiles(id) on delete set null,
  uploaded_by_name text,
  via_share_link boolean not null default false,
  -- An upload from a share link is held until staff release it: the endpoint is
  -- open to anyone holding the token, so this is the gate that stops it being
  -- used to publish anything into a client's record.
  pending boolean not null default false,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,

  is_demo boolean not null default false,
  created_at timestamptz not null default now(),

  -- Exactly one owner. An attachment belonging to both a job and a site has no
  -- defined access rule, so the shape that has no answer is made impossible.
  constraint attachments_single_owner check (
    (job_id is not null)::int + (job_request_id is not null)::int
      + (site_id is not null)::int + (comment_id is not null)::int = 1
  )
);

create index if not exists attachments_job_idx on attachments (job_id) where job_id is not null;
create index if not exists attachments_pending_idx on attachments (pending) where pending;
