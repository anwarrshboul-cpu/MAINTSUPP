# Pre-W14 — decisions taken, and the questions still open

Companion to `PRE-W14-HANDOVER.md`. That file records what was and was not
built; this one records the judgement calls made along the way, so that a later
reader can disagree with a decision rather than rediscover the problem.

Written 2026-09-05.

---

## 1. Planned visits: the hybrid model

**Decided by the owner. Implemented in `app/(app)/portal/planned-visit.ts`.**

Module 1 §4 describes a planned visit as a rich calendar record with assignees,
contractor, priority, status and an SLA deadline. Module 2 §2 forbids copying a
job into a calendar row, in terms: two copies drift within a week and every
later bug traces back to it. Read together they ask for a record that carries a
job's fields without being a copy of a job.

The resolution:

| Case | Where the truth lives |
| --- | --- |
| Visit **linked** to a maintenance job | The JOB. The calendar renders it through the existing feed. |
| Visit with **no** job (survey, inspection, attendance) | The calendar row. No job is invented. |
| Standalone visit that **becomes** maintenance work | "Create job from this visit" makes ONE job and links the visit to it. |

The invariant, enforced by `visitScheduleTarget` and asserted by
`plannedVisitIntegrityIssue`: **a linked visit never stores its own schedule.**
A row carrying both a `request_id` and a `starts_on` has two answers to "when is
this visit" and no rule for which wins.

Why not simply make every visit a job: a job carries an SLA, a requester, a cost
and a place in the client's on-time percentage. A survey booked for Tuesday has
none of those, and filing it as a job would put it in the denominator of a
number that appears on an invoice.

## 2. Bank holidays are data, and the header that said they should not exist

`app/lib/reporting/period.ts` stated that there was no holiday calendar in the
product and that inventing one would put a number on a client's SLA report that
no agreement supports. That was correct while nobody had agreed one.

Module 4 §4.2 requires the calendar and the owner has agreed it, so
`bank_holidays` exists, seeded with England & Wales 2024–2028 including
substitute days, and the header now records the change rather than contradicting
it. Holidays are transcribed, never computed: the English calendar has
substitute days, one-off royal holidays and a spring bank holiday twice moved by
statute, so an algorithm is wrong in exactly the years people remember.

The set travels from `engine.ts` as DATA on the compute input rather than as an
import, because `tests/w9-report-engine.test.mjs` stages a fixed list of modules
into a temp directory; a value import inside `maintenance-compute.ts` would
resolve to a file that suite does not stage.

## 3. One reminder engine, and what that did and did not mean

`/api/notifications/compliance` already walked a 90/60/30/14/7/0 ladder. It is
not replaced, because it answers a different question — "has this document
crossed a threshold since the last run" — and because two suites pin it.

What is NOT duplicated is the part that matters: both paths send through
`sendNotification`, so there is one place that owns `EMAIL_MODE`, one
`notification_log`, and one answer to whether mail leaves the building.
`reminder_dispatch` is the row engine's idempotency ledger and is deliberately
separate from the log: one rule can produce several log lines (one per
recipient) and must produce exactly one dispatch.

**Open:** the two ladders should eventually become one. Nothing is broken by
having both; it is a consolidation, not a defect.

## 4. Numbering: the counter was already right

`billing_settings.invoice_sequence` was already gapless, compare-and-swap and
backed by a partial UNIQUE index. Only the RENDERING was wrong (`MS-00042` where
Module 4 asks for `MS-YYYY-NNN`). A `document_number_sequence` table was drafted
and removed: two counters for one number is how a client ends up holding two
documents numbered the same.

The year comes from the invoice's own date, not from today's, so a December
period finalised in January is not numbered as the new year's first invoice. The
sequence refuses to restart when the year moves backwards.

## 5. Waivers: why a block that can be bypassed is the right block

Module 4 §6 rejects blocking on everything (somebody eventually raises the
invoice outside the system) and warning on everything (wrong numbers reach a
client). So `blocking`-severity findings stop Finalise, and an approver can
waive one at a time with a typed reason that is printed in the report.

The waiver key is `${code}:${entityId}`, not the code alone — waiving one job's
missing completion date must not silently waive every other job's.

Waiving requires `document.approve`, not `document.edit`: whoever prepares a
document must not be able to dismiss the checks on their own work.

## 6. The emailed action links do not act on a GET

Outlook SafeLinks, Gmail's scanners and corporate gateways fetch a URL before a
human sees it. A single-use Acknowledge token spent by a scanner leaves the
recipient with a dead link and the record claiming they acknowledged something
at 03:14. So `/r/{action}/{token}` renders a confirmation and the action happens
on a POST.

This is a deliberate deviation from the specification's "links that work without
logging in", which it still does — it just costs one button.

## 7. Test isolation without a second database

Module 3 §1.1 asks for a second D1 database and R2 bucket. The owner instructed
otherwise: the current architecture is Vercel + Supabase Postgres, with no second
binding to split. Isolation is therefore the layers §1 calls "belt and braces",
promoted to primary: `is_seed` + `seed_batch_id`, `ZZ-DEMO —` store names,
`@example.com` addresses, `zzdemo-` id prefixes, and two independent production
guards on purge.

Verified independently of the seeding code: all nineteen §3.3 boundary offsets
exact, byte-identical across two runs, no address outside `@example.com`, every
store prefixed. Both guards fail closed and neither can satisfy the other.

---

## Open questions for the owner

### A. Working days — DECIDED 2026-09-05, and implemented

The owner confirmed Module 4 §4.2 exactly: working days run **from the day
AFTER the request** to the completion date inclusive, excluding Saturdays,
Sundays and England & Wales bank holidays from `bank_holidays`.

`workingDaysAfterRequest` in `app/lib/reporting/period.ts` is the rule.
`computeSlaOutcome` and `openJobDaysPastTarget` both use it, so the open list
and the closed table cannot disagree about the same days.

**A hold's own span was NOT changed** and the asymmetry is deliberate: a hold
running Monday to Wednesday still removes three days, inclusive of both ends,
because every day it covers is a day the clock was stopped. Only the ELAPSED
measurement drops its first day. A test asserts both halves so that unifying
them would fail loudly.

Two consequences worth stating plainly:

- **Same-day work is now zero working days, not one.** Raised and closed on
  Monday, against a two-day target, is zero — which is the honest number.
- **Every new SLA figure is one working day lower** than the same job would have
  produced yesterday.

**No historical figure moved, and that is structural rather than a promise.**
`documentPayload` in `documents.ts` branches on `Finalised`/`Voided` BEFORE it
recomputes anything, serves the stored `report_snapshots` payload, and has no
path from a snapshot failure back to a recomputation. Two tests pin that
ordering, and a third was added to `pre-w14-working-days.test.mjs` for this
change specifically.

Four existing expectations in `w9-report-engine` and `pre-w14-reports-module4`
were re-pointed by exactly one day each, with the reason written in.

### B. Sub-daily job reminders

`occurrence_date` is the LOCAL CALENDAR DAY, which is what makes a double-firing
cron harmless. The consequence: one rule sends at most once per local day.

Module 2 §8 asks for an "SLA deadline approaching — hourly check" and an "SLA
breached — immediate, repeats daily". The daily cap is arguably the right
behaviour for both (nobody wants hourly breach mail), but if genuinely sub-daily
sends are wanted, `occurrence_date` needs an hour component and a migration.

### C. "Overdue — weekly, Mondays 08:00"

Expressible as "weekly from expiry" via `direction: after` +
`repeat_interval_days: 7`. Pinning it to Mondays specifically has no column.
Accepted as weekly-from-expiry; a weekday column would be needed otherwise.

### D. EMAIL_MODE: intent versus letter

Module 3 §2.1 requires a build that reads `EMAIL_MODE` as unset to FAIL TO
START. `app/lib/notifications.ts` instead defaults to `sink`.

That satisfies the intent — an unset variable can never mean `live` — and
contradicts the letter. It was left alone: `sendNotification` sits on the path
that saves a lead and is documented never to throw, so an unset variable would
turn "nobody was emailed" into "the lead was lost". The strict reading lives in
`assertEmailModeSafe`, called by the seed and purge entry points, which have no
lead to lose and every reason to stop.
