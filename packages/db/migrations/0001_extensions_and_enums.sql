-- 0001 — extensions and the enumerated vocabularies.
--
-- Runs identically against local PGlite and hosted Supabase Postgres. Nothing
-- here may depend on Supabase-only schemas (`auth`, `storage`) or on the
-- `supabase_admin` role: the API owns authentication now, so the database is
-- plain Postgres and stays portable.
--
-- The labels below are monday's, captured 14 Aug 2026, including its two
-- misspellings. `Plummer` is deliberate — it is what the live board says, and
-- renaming it here would break the import mapping for 744 existing rows.

create extension if not exists pgcrypto;

-- Roles. Order matters: `rank()` in the API reads the ordinal to decide who
-- may act on whom, so new roles go at the end unless a rank change is intended.
do $$ begin
  create type user_role as enum (
    'owner', 'super_admin', 'admin', 'client_admin', 'client_user', 'contractor'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type profile_status as enum ('active', 'pending_approval', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
exception when duplicate_object then null; end $$;

-- The board's 23 status labels, verbatim.
do $$ begin
  create type job_status as enum (
    'Pending Approval',
    'Pending Scheduling',
    'Job Scheduled',
    'Awaiting Access',
    'Job In Progress',
    'Major works',
    'Waiting for parts',
    'Quote requested',
    'Quote Received (waiting for Approval)',
    'Quote approved',
    'Quote rejected',
    'Blocked - Awaiting Response',
    'Awaiting Landlord Approval',
    'Health And Safety Hold',
    'Waiting for decisions',
    'Third Party Delay',
    'Escalated',
    'Waiting for payment',
    'Deposit Invoice Received',
    'Deposit Invoice Paid',
    'Completion Invoice Received',
    'Completion Invoice Paid',
    'Job Completed'
  );
exception when duplicate_object then null; end $$;

-- The seven stages those 23 group into, for dashboards.
do $$ begin
  create type job_stage as enum (
    'New', 'Scheduling', 'In Progress', 'Quotes', 'On Hold', 'Payment', 'Done'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_priority as enum ('Urgent', 'Medium', 'Low');
exception when duplicate_object then null; end $$;

-- monday's spelling of Plumber. Kept for import parity — see the file header.
do $$ begin
  create type engineer_required as enum ('Plummer', 'Electrician', 'Handyman', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_fault_label as enum (
    'Locks', 'Hinges', 'Glass', 'Signboard', 'Lights', 'Diffuser', 'Vinyls',
    'Acrylic', 'Paint', 'Shelves', 'Drawers', 'TV/Display', 'AC', 'CCTV',
    'Replacement parts', 'Other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_request_status as enum ('new', 'converted', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quote_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type attachment_kind as enum ('issue_picture', 'completed_picture', 'file');
exception when duplicate_object then null; end $$;

do $$ begin
  create type comment_visibility as enum ('internal', 'client', 'public');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lead_status as enum ('new', 'contacted', 'qualified', 'won', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type invoice_status as enum ('awaiting_payment', 'paid', 'overdue', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_status as enum ('Missing', 'Valid', 'Expiring', 'Expired', 'Not required');
exception when duplicate_object then null; end $$;

/*
 * status -> stage, as one function.
 *
 * `jobs.stage` is a stored generated column computed from this, so a status can
 * never be filed under the wrong stage and no caller has to remember the
 * mapping. IMMUTABLE is required for a generated column and is honest here:
 * the mapping is a constant.
 *
 * Changing a label means changing this function AND the job_status enum, and
 * regenerating the column — which is the point. A silent drift between the two
 * is what splits a board in half.
 */
create or replace function job_stage_for(p_status job_status)
returns job_stage
language sql
immutable
as $$
  select case p_status
    when 'Pending Approval' then 'New'::job_stage
    when 'Pending Scheduling' then 'Scheduling'::job_stage
    when 'Job Scheduled' then 'Scheduling'::job_stage
    when 'Awaiting Access' then 'Scheduling'::job_stage
    when 'Job In Progress' then 'In Progress'::job_stage
    when 'Major works' then 'In Progress'::job_stage
    when 'Waiting for parts' then 'In Progress'::job_stage
    when 'Quote requested' then 'Quotes'::job_stage
    when 'Quote Received (waiting for Approval)' then 'Quotes'::job_stage
    when 'Quote approved' then 'Quotes'::job_stage
    when 'Quote rejected' then 'Quotes'::job_stage
    when 'Blocked - Awaiting Response' then 'On Hold'::job_stage
    when 'Awaiting Landlord Approval' then 'On Hold'::job_stage
    when 'Health And Safety Hold' then 'On Hold'::job_stage
    when 'Waiting for decisions' then 'On Hold'::job_stage
    when 'Third Party Delay' then 'On Hold'::job_stage
    when 'Escalated' then 'On Hold'::job_stage
    when 'Waiting for payment' then 'Payment'::job_stage
    when 'Deposit Invoice Received' then 'Payment'::job_stage
    when 'Deposit Invoice Paid' then 'Payment'::job_stage
    when 'Completion Invoice Received' then 'Payment'::job_stage
    when 'Completion Invoice Paid' then 'Payment'::job_stage
    when 'Job Completed' then 'Done'::job_stage
  end;
$$;

/* Keeps `updated_at` honest without every caller remembering to set it. */
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
