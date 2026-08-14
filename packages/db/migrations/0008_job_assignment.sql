-- 0008 — assignment: who the job was offered to, and what they said back.
--
-- `jobs` already carried `contractor_id`, `contractor_name`, `assigned_to` and
-- `assigned_to_name` since 0003, and `scopeFor()` already scopes a contractor to
-- `contractor_id`. So the *access* half of assignment has always worked: setting
-- that column is the moment a contractor can see the job at all.
--
-- What was missing is the CONVERSATION. A coordinator who has assigned a job
-- knows only that they sent it; they do not know whether anybody picked it up,
-- whether it was refused, or when somebody is turning up. That gap is where
-- work is silently lost — a job sits "assigned" for four days because the
-- contractor never opened the message, and nothing on the board says so.

/*
 * offered → accepted, or offered → declined. Nothing else.
 *
 * NULL is the fourth state and means "never offered to anyone", which is why
 * the column is nullable rather than carrying an 'unassigned' member: an enum
 * value would have to be written onto all 300-odd existing rows and would then
 * be indistinguishable, in a query, from a job whose offer was withdrawn.
 */
do $$ begin
  create type job_assignment_status as enum ('offered', 'accepted', 'declined');
exception when duplicate_object then null; end $$;

alter table jobs add column if not exists assignment_status job_assignment_status;
alter table jobs add column if not exists assigned_at timestamptz;
alter table jobs add column if not exists accepted_at timestamptz;
alter table jobs add column if not exists declined_at timestamptz;
alter table jobs add column if not exists decline_reason text;

/*
 * The ETA is `timestamptz`, not a date.
 *
 * "Thursday" is not an answer a store manager can plan a delivery around, and
 * the whole reason this column exists is so the client stops ringing to ask
 * what time. A date column would force the API to invent an hour.
 */
alter table jobs add column if not exists eta_at timestamptz;

/*
 * DECLINING DOES NOT UNASSIGN. This is the decision the brief asks for, and
 * these are the three reasons.
 *
 * 1. Access is granted BY `contractor_id`. Nulling it inside the decline would
 *    revoke the contractor's own read access in the same statement that
 *    records their answer — so the screen they just pressed Decline on would
 *    404 on its next render. They could not see the outcome of their own
 *    action, re-read the reason they gave, or notice they had tapped the wrong
 *    row. A refusal is a message to somebody, and the sender has to be able to
 *    see that it was sent.
 *
 * 2. It keeps WHO declined on the same row as WHY. The alternative needs a
 *    second `declined_by_contractor_id` column that duplicates the first and
 *    can disagree with it; every "which contractor refused this job" query
 *    would then have to know which of the two columns to believe.
 *
 * 3. A declined job must not silently vanish, and unassigning is precisely how
 *    it would. `contractor_id is null` is the same shape as a job nobody has
 *    ever looked at, so a refusal would decay into an absence and the job would
 *    sit unnoticed in the pile of never-assigned work. Held as
 *    `assignment_status = 'declined'` it is a state that demands an action:
 *    staff see "declined — needs reassignment" with the reason attached.
 *
 * The cost, stated plainly: the declining contractor keeps read access to that
 * one job until somebody else is assigned. That leaks nothing they were not
 * already shown when it was offered, and re-assigning (which overwrites
 * `contractor_id` and sets the status back to 'offered') ends it.
 */

do $$ begin
  alter table jobs add constraint jobs_assignment_needs_contractor
    check (assignment_status is null or contractor_id is not null);
exception when duplicate_object then null; end $$;

/*
 * A refusal without a reason is not a refusal, it is a job that stopped moving.
 * The coordinator's next decision — re-offer to the same firm, or find another
 * — depends entirely on whether the answer was "no van until Tuesday" or "that
 * is not a trade we cover".
 */
do $$ begin
  alter table jobs add constraint jobs_decline_is_explained
    check (
      assignment_status is distinct from 'declined'
      or (declined_at is not null and nullif(trim(decline_reason), '') is not null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table jobs add constraint jobs_acceptance_is_timed
    check (assignment_status is distinct from 'accepted' or accepted_at is not null);
exception when duplicate_object then null; end $$;

/*
 * The contractor's own screen is "my jobs, newest offer first", and the board
 * needs "which offers are still unanswered". Both read contractor + status
 * together; `jobs_contractor_idx` from 0003 only covers the first column.
 */
create index if not exists jobs_assignment_idx
  on jobs (contractor_id, assignment_status)
  where contractor_id is not null;

/*
 * Two demo contractors.
 *
 * Data in a migration, which normally belongs in `seed-demo.ts` — but the
 * assign control has nothing to offer without at least one `contractors` row,
 * and 0005 seeds none. Without these, every local database (and every
 * walkthrough) reaches the assignment step with an empty dropdown, which is
 * indistinguishable from the feature being broken.
 *
 * `is_demo = true`, like everything else 0005 plants, so
 * `delete from contractors where is_demo` removes them when a real supply
 * chain arrives. No `organisation_id`: these are independent firms working
 * across clients, not somebody's in-house team.
 *
 * Guarded by NOT EXISTS rather than ON CONFLICT because `contractors` has no
 * unique key on name — re-running must not plant a third Acme.
 */
insert into contractors (name, email, phone, service_categories, coverage_areas, is_demo)
select 'Acme Repairs Ltd', 'dispatch@acme-repairs.test', '020 7946 0100',
       array['Doors, locks & shutters', 'Glazing', 'Signage'],
       array['London', 'South East'], true
where not exists (select 1 from contractors where lower(name) = 'acme repairs ltd');

insert into contractors (name, email, phone, service_categories, coverage_areas, is_demo)
select 'Northside Electrical', 'jobs@northside-electrical.test', '0161 496 0200',
       array['Electrical & lighting', 'HVAC & air conditioning'],
       array['North West', 'Midlands'], true
where not exists (select 1 from contractors where lower(name) = 'northside electrical');

comment on column jobs.assignment_status is
  'NULL = never offered. Declining keeps contractor_id so the refusal stays attributable and the job does not decay into an unassigned one — see 0008.';
