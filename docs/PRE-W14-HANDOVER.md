# Pre-W14 — what is built, what is not, and what is blocked

Written 2026-09-05. Companion to `PRE-W14-DECISIONS.md`, which records the
judgement calls and the open questions.

Baseline for this pass: `67e02f3`. Head: see `git log`.
Preview: https://maintsupp-preview.vercel.app

**W14 has not started, and must not start yet.** Phases 2, 3 and 4 are all
PARTIAL for the reasons below; the gate the owner set is not met.

---

## Phase 2 — Operations Calendar · PARTIAL

### Built and verified

| | Evidence |
| --- | --- |
| Reminder row model, cascade, per-row send time | `app/lib/reminders/`, 28 tests |
| Europe/London + DST | 08:00 → 07:00Z in BST, 08:00Z in GMT, both sides of both 2026 transitions, checked independently of the suite that ships with it |
| Recipient picker, dynamic groups, case-insensitive de-duplication | `recipient-picker.tsx`, resolved AT SEND TIME |
| Reminder preview panel, test send | Above the rows, recomputes on expiry change |
| Acknowledge / Snooze 7 days / Mark renewed | Signed single-use tokens, hash-only storage |
| Repeat-until-acknowledged, cap, quiet hours | Quiet hours DEFER, never cancel |
| Idempotency | Proved against the real index: a second claim on one (rule, occurrence) is refused by the database; a repeat three days later is accepted |
| Job status map, chips, overdue overlay, admin notice | Overdue LAYERS on the status colour |
| Job side panel, unscheduled tray, drag-to-reschedule | Tray is a bottom sheet under 640px |
| Planned Visit hybrid model | `planned-visit.ts`; a linked visit never stores its own schedule |
| Scheduled-visit calendar layer | Was missing entirely — a booked job drew no chip on the day it was booked |

### NOT built

- **Certificate fields in the calendar dialog** — reference, issued by, renewal
  owner, escalation contact and cost were added to `compliance_documents` but
  are not exposed in the create/edit dialog. A certificate created from the
  calendar therefore cannot yet carry them.
- Bulk CSV import of certificates, ICS feed, weekly digest, client-facing
  read-only view, coverage-gap detection, duplicate detection (Module 1 §12).
- Filters/Show toggles/URL state and the date-layer toggles (Module 2 §3, §6).
- Performance work (§9) — deliberately out of scope until after W14.

### BLOCKED

**The cascade cannot fire on a schedule.** `/api/cron/reminders` is finished,
authenticated and idempotent, but it needs an HOURLY cron and Vercel refuses:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (0 * * * *) would run more than once per day.

Declaring it daily would deploy and quietly break the feature — every row's own
send time would become decorative — so it is deliberately not declared. Unblock
by either a Vercel Pro plan, or any external scheduler: the route accepts a
plain `x-cron-secret` header for exactly this.

---

## Phase 3 — Reports · PARTIAL

### Built and verified

- **England & Wales bank holidays** as a table, 2024–2028 including substitute
  days, threaded from `engine.ts` into elapsed / held / adjusted.
- **Holds UI.** The table, the arithmetic and the API all existed; nothing in
  the application called them, so the adjusted column was computed from a table
  no person could write to. Recording a hold still cannot approve it.
- **Data-quality gate.** `blocking` findings now block Finalise. Previously the
  48-issue badge gated nothing.
- **Waivers.** One issue, one approver (`document.approve`), one mandatory typed
  reason, printed in the report. Keyed `${code}:${entityId}` so waiving one job
  does not waive every job.
- **`MS-YYYY-NNN`**, on the existing gapless compare-and-swap counter, with the
  year taken from the invoice's own date and no restart when the year moves
  backwards.

### NOT built

- **AI narrative** and the orphan-number validator (Module 4 §4.3). No LLM
  integration exists in this product; the deterministic `narrative.ts` remains.
- **Template parity.** §10 asks that exports be verified against
  `MAINTSUPP_Maintenance_Report_August_2026.docx` and
  `Maintsupp_Invoice_August_2026.docx` by rendering and comparing side by side.
  **Those two files were never available in this session**, so that criterion is
  UNVERIFIED — not passed, not failed.
- Email to client — DEFERRED by an existing owner decision; two test files
  forbid email under `app/api/reports/`.

---

## Phase 4 — Test data and reconciliation · PARTIAL

### Built

Deterministic dataset (mulberry32, no `Math.random`), the §3.3 boundary matrix,
independent expected-values computation, two independent production guards, the
loader, `/api/admin/reconcile`, `/api/admin/seed`, the reconcile panel and the
five `seed:*` scripts.

Verified independently of the seeding code: all nineteen boundary offsets exact,
byte-identical across two runs, no address outside `@example.com`, every store
`ZZ-DEMO` prefixed, both guards failing closed with neither able to satisfy the
other.

### NOT executed — and this is the gap that matters

**No seed run has ever completed.** No environment variable reaches the running
worker locally (`.dev.vars` does not populate `process.env` here — the same
reason `/api/cron/reminders` reports `CRON_SECRET is unset` on the dev server),
and on the deployed Preview `/api/admin/reconcile` answers **403** because
`ENVIRONMENT` is not set in the Vercel project.

Consequences:

- `seed/expected-values.json` has never been written.
- The reconciliation harness has never compared a real number to an expected one.
- `seed:travel` and `seed:cron` are untested against data.

**To unblock:** set `ENVIRONMENT=preview` (and `EMAIL_MODE=sink`) in the Vercel
project's Preview environment, then run `npm run seed` followed by
`npm run seed:verify`. Everything else is in place.

Also outstanding: seeded jobs get board placements but no
`maintenance_board_cells`, so board columns render empty for them; seeded JPEG
fixtures are byte filler and will not decode (the PDFs are valid).

---

## Regression

Full suite at head: **2667 tests, 2402 pass, 56 fail, 209 skipped.**
The same 44 files at `67e02f3`, against the same database: **62 fail.**

Every one of the 56 is classified in the final report. Six genuine regressions
were found during this pass and fixed; none remains.

Two things about this suite are worth knowing before reading a failure count:

1. **`core.autocrlf=true` breaks newline-bearing regexes.** Proven, not
   inferred: `completion-audit-gaps`' widget pattern matches **0** times against
   `portal-app.tsx` with a bare `\n` and **13** with `\r?\n`, because git checks
   the file out CRLF. Nearly every test file contains such a pattern; the ones
   that fail are those whose target file is CRLF.

2. **A baseline worktree has no `.wrangler`.** Every database-reading test
   SKIPS there and appears to pass. Comparing against it without linking the
   real database in makes environment failures look like new regressions — it
   did here, for nine of them, until the junction was added and they failed
   identically at both ends.

---

## Not touched

Production deployment, Production Supabase, Production Storage, Production auth,
DNS, the Production Data Rebase, MN-1049 as a fixture, `.mcp.json`. No real
external email was sent; `EMAIL_MODE` defaults to `sink` and the one send path
is `sendNotification`.
