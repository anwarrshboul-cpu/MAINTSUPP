-- 0009 — the compliance requirement list, one status rule, and invoices as a
-- record rather than a document generator.
--
-- 0004 created `compliance_documents` and `invoices` and is checksum-locked, so
-- everything this stage needs that they do not already carry is added here.
--
-- Three things are being fixed, and they are all the same mistake in different
-- clothes: a number whose meaning is not written down anywhere.
--
--   1. THE DENOMINATOR. `compliance_documents` records the certificates a site
--      HAS. Nothing in 0004 records the certificates a site is SUPPOSED to
--      have, so "82% compliant" meant "82% of whatever rows happen to exist",
--      which silently became 26% when the requirement list grew from nine
--      entries to twelve. The catalogue below is the denominator, written down
--      once, in the database, where both the score and the screen read it from.
--   2. THE STATUS RULE. `compliance_documents.status` is a stored enum, and a
--      stored status ages: a row written 'Valid' in January is still 'Valid' in
--      December after the certificate expired in March. `compliance_status_for`
--      is the one definition of that rule; the API recomputes on every read and
--      the trigger keeps the stored column from being an outright lie in the
--      meantime.
--   3. THE INVOICE NUMBER. An invoice with no number, or the same invoice
--      recorded twice, quietly doubles an organisation's outstanding total.

/* =========================================================== compliance == */

/*
 * What every site is asked for — the denominator, as data.
 *
 * These are monday's twelve document slots from the Store Documentation board,
 * captured 14 Aug 2026. `expires` is false for exactly three of them (RAMS, the
 * fire risk assessment and the store drawing), which is the distinction the
 * 0004 comment on `not_required` is about: for those three there is no date to
 * be missing, so "no expiry recorded" must never be read as a failure.
 *
 * A row here, not a constant in a route handler, for two reasons. An admin
 * adding a thirteenth requirement must move every site's denominator at the
 * same instant — otherwise two screens disagree about what 100% means. And
 * `active` lets a requirement be retired without deleting the documents already
 * filed against it, which would destroy the evidence along with the rule.
 */
create table if not exists compliance_requirements (
  kind text primary key,
  label text not null,
  /* False for the three certificates that carry no expiry date at all. */
  expires boolean not null default true,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into compliance_requirements (kind, label, expires, sort_order) values
  ('rams',                 'RAMS',                          false,  10),
  ('fire_risk_assessment', 'Fire Risk Assessment',          false,  20),
  ('pli',                  'PLI Document',                  true,   30),
  ('pat',                  'PAT Test Certificate',          true,   40),
  ('electrical_wiring',    'Electrical Wiring Certificate', true,   50),
  ('fire_extinguisher',    'Fire Extinguisher',             true,   60),
  ('fire_alarm',           'Fire Alarm Report',             true,   70),
  ('emergency_lighting',   'Emergency Lighting Report',     true,   80),
  ('sprinkler',            'Sprinkler Report',              true,   90),
  ('water_hygiene',        'Water Hygiene Test Report',     true,  100),
  ('fire_door',            'Fire Door Test',                true,  110),
  ('drawing',              'Store Drawing',                 false, 120)
on conflict (kind) do nothing;

/*
 * `compliance_documents.kind` was free text. Now it must name a requirement.
 *
 * Without this a typo — 'fire_alarm ' with a trailing space, 'firealarm' — is a
 * document filed against a requirement that does not exist: invisible on every
 * screen, counted by nothing, and indistinguishable from a certificate nobody
 * ever uploaded. The migration fails loudly if any existing row names an
 * unknown kind, which is the correct outcome: that row needs a decision, not a
 * silent reclassification.
 */
do $$ begin
  alter table compliance_documents
    add constraint compliance_documents_kind_fk
    foreign key (kind) references compliance_requirements(kind) on update cascade;
exception when duplicate_object then null; end $$;

/*
 * Why a requirement does not apply, and who said so.
 *
 * `not_required` on its own is an assertion with nobody behind it, and it is
 * the one flag that REMOVES a row from the denominator — so it is exactly the
 * flag that must be justified. "No sprinkler system in this unit" is an
 * auditable answer; a bare checkbox is not.
 */
alter table compliance_documents add column if not exists not_required_reason text;
alter table compliance_documents add column if not exists reviewed_by uuid references profiles(id) on delete set null;
alter table compliance_documents add column if not exists reviewed_at timestamptz;

do $$ begin
  alter table compliance_documents
    add constraint compliance_documents_not_required_reason
    check (not not_required or nullif(trim(not_required_reason), '') is not null);
exception when duplicate_object then null; end $$;

/* How near an expiry has to be before it is "Expiring" rather than "Valid".
   One definition, so the trigger below and the API agree by construction
   instead of by two people remembering the same number. */
create or replace function compliance_soon_days()
returns integer
language sql
immutable
as $$ select 90 $$;

/*
 * The status rule, as one function.
 *
 * IMMUTABLE, which means today's date is a PARAMETER rather than something this
 * reads from the clock. That is deliberate twice over: an immutable function can
 * be used in an index or a generated column later, and a test can ask what this
 * row will look like next March without waiting until March.
 *
 * The order of the branches is the whole point:
 *
 *   not_required   → 'Not required'  — excluded from the score's denominator.
 *   does not expire→ file present decides it. There is no date to age, so a
 *                    missing date must never be reported as a failure.
 *   no date        → 'Missing'. NOT 'Not required': "nobody asks for this" and
 *                    "nobody has recorded it" are different facts about a site
 *                    and only one of them is somebody's job to fix.
 *   past           → 'Expired'.
 *   within 90 days → 'Expiring'. Still in date, and still counts as compliant.
 *   otherwise      → 'Valid'.
 */
create or replace function compliance_status_for(
  p_not_required boolean,
  p_expires boolean,
  p_has_document boolean,
  p_expiry date,
  p_today date,
  p_soon_days integer default compliance_soon_days()
)
returns compliance_status
language sql
immutable
as $$
  select case
    when coalesce(p_not_required, false) then 'Not required'::compliance_status
    when not coalesce(p_expires, true) then
      case when coalesce(p_has_document, false)
        then 'Valid'::compliance_status
        else 'Missing'::compliance_status
      end
    when p_expiry is null then 'Missing'::compliance_status
    when p_expiry < p_today then 'Expired'::compliance_status
    when p_expiry <= p_today + p_soon_days then 'Expiring'::compliance_status
    else 'Valid'::compliance_status
  end;
$$;

/*
 * Keeps the stored `status` column honest as of its last write.
 *
 * THE STORED COLUMN IS NOT THE ANSWER. It is a snapshot, and snapshots of a
 * date-relative fact rot: nothing writes to a row on the morning its
 * certificate expires. Every read path recomputes with `compliance_status_for`
 * and today's date. This trigger exists only so that a row inspected directly
 * in the database — in a backup, in a support query — is not carrying a value
 * that was wrong the moment it was written.
 */
create or replace function stamp_compliance_status()
returns trigger
language plpgsql
as $$
declare
  v_expires boolean;
begin
  select r.expires into v_expires
    from compliance_requirements r where r.kind = new.kind;

  new.status = compliance_status_for(
    new.not_required,
    coalesce(v_expires, true),
    new.attachment_id is not null,
    new.expiry_date,
    current_date
  );
  return new;
end;
$$;

drop trigger if exists compliance_stamp_status on compliance_documents;
create trigger compliance_stamp_status before insert or update on compliance_documents
  for each row execute function stamp_compliance_status();

/* The calendar's query: what expires next, ignoring the rows nobody asks for. */
create index if not exists compliance_calendar_idx
  on compliance_documents (expiry_date, site_id)
  where not not_required and expiry_date is not null;

/* ============================================================= invoices == */

/*
 * RECORDED, NOT GENERATED. The owner's explicit decision: MAINTSUPP does not
 * issue invoices, number them or produce PDFs. It writes down invoices that
 * exist elsewhere so that "what is outstanding" has an answer. Nothing in this
 * migration allocates a number — `invoice_number` is transcribed from the
 * document, which is why it is required and why it must be unique per client.
 */
alter table invoices add column if not exists notes text;
alter table invoices add column if not exists recorded_by uuid references profiles(id) on delete set null;

/*
 * An invoice without a number cannot be reconciled against anything. It is a
 * figure in a total that nobody can trace back to a document, which is worse
 * than an absent row: it moves the outstanding balance and cannot be chased.
 */
do $$ begin
  alter table invoices add constraint invoices_number_present
    check (nullif(trim(invoice_number), '') is not null);
exception when duplicate_object then null; end $$;

/*
 * A paid invoice must say when it was paid.
 *
 * Otherwise "paid" is a checkbox with no date behind it, and the first question
 * anyone asks about a paid invoice — when did the money arrive — has no answer
 * in the system that claims to track it.
 */
do $$ begin
  alter table invoices add constraint invoices_paid_dated
    check (status <> 'paid' or paid_at is not null);
exception when duplicate_object then null; end $$;

/*
 * One number, once, per client.
 *
 * Recording the same invoice twice is the single most likely data-entry error
 * here, and its symptom is an outstanding total that is quietly double what the
 * client owes. Scoped per organisation because two clients' accounting systems
 * will certainly both produce an "INV-001", and case- and space-insensitive
 * because "inv-001 " is the same document as "INV-001".
 */
create unique index if not exists invoices_org_number_unique
  on invoices (organisation_id, lower(trim(invoice_number)));

/* The chase list: unpaid, by due date. */
create index if not exists invoices_due_idx on invoices (due_at)
  where status = 'awaiting_payment';

/* ================================================= invoice attachments == */

/*
 * An invoice PDF needs an owner column of its own, and NOT `job_id`.
 *
 * This looked like it could reuse the job: most invoices are against a job, and
 * `attachments.job_id` already exists. It cannot. A contractor assigned to a job
 * can list that job's attachments — correctly, they are their own photographs —
 * and an invoice PDF filed there would be one signed URL away from a contractor
 * who must never see pricing at all (`canSeeMoney` is false for them). The
 * owner column decides the access rule, so the access rule decides the column.
 *
 * `/uploads/:id/url` therefore cannot serve these rows, by construction: its
 * predicate ORs over job / comment / site / job_request, and an invoice
 * attachment matches none of them. They are served by `/invoices/:id/pdf`,
 * which applies the money gate as well as the tenancy one.
 */
alter table attachments add column if not exists invoice_id uuid references invoices(id) on delete cascade;

/*
 * A certificate's OWNER is still the site — that is what makes the existing
 * `/uploads/:id/url` access check work for it unchanged, through `siteScopeFor`.
 * This column is a tag, not an owner: it says which requirement the file was
 * uploaded against, so that replacing a certificate can keep the superseded one
 * findable instead of orphaning bytes nothing references.
 */
alter table attachments add column if not exists compliance_document_id uuid
  references compliance_documents(id) on delete set null;

/*
 * Exactly one owner, still — now counting five. Recreated rather than relaxed:
 * an attachment with no owner has no defined access rule, and one with two has
 * two conflicting ones.
 */
alter table attachments drop constraint if exists attachments_single_owner;
alter table attachments add constraint attachments_single_owner check (
  (job_id is not null)::int + (job_request_id is not null)::int
    + (site_id is not null)::int + (comment_id is not null)::int
    + (invoice_id is not null)::int = 1
);

create index if not exists attachments_invoice_idx
  on attachments (invoice_id) where invoice_id is not null;
create index if not exists attachments_compliance_idx
  on attachments (compliance_document_id) where compliance_document_id is not null;
