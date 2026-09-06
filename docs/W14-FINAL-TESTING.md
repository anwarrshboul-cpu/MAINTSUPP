# W14 — Final Testing and Sign-Off

The twenty checks of workstream 14 in `MAINTSUPP-Development-Checklist.docx`,
run against the deployed Preview at `https://maintsupp-preview.vercel.app` and,
where a figure had to be checked independently, against the Supabase Staging
database behind it.

**Two organisations live on that deployment and the difference matters to nearly
every check below.** `Sunnamusk UK` is the client's real estate — 19 jobs, 32
sites, no seeded rows. `Demo Client Ltd` is the reconciliation harness's demo
estate — 180 jobs, 12 sites, every row carrying `is_seed` and a `zzdemo-` id.
Unless a check says otherwise, it was run against the REAL organisation, because
that is the one the question is about.

Started 2026-09-06.

---

## W14-05 / W14-06 — dashboard KPIs, recalculated and compared to source

Read off the rendered Overview at 1440px on the deployed Preview, then computed
again straight from Postgres — not from the API the page used, which would only
prove the page agrees with itself.

| Figure | Dashboard | Computed from the database | |
| --- | ---: | ---: | --- |
| Jobs, all statuses | 19 | 19 | ✅ |
| Open jobs | 17 | 17 | ✅ |
| Completed | 2 | 2 | ✅ |
| Compliance | 0% | 0 documents | ✅ |
| Active sites | **24** | **25** | ⚠️ see below |

Every breakdown sums to the headline, which is the other half of §4.3's
cross-section rule and is what catches a chart drawn from a different query
than the tile above it:

```
status     Pending Approval 16 + Job Completed 2 + Job Scheduled 1   = 19
priority   Medium 9 + Low 5 + Urgent 5                              = 19
tier       Tier 3 8 + Tier 2 6 + Tier 1 5                           = 19
trade      Plummer 12 + Handyman 3 + Electrician 2 + Other 2        = 19
category   twelve values                                            = 19
open 17 + completed 2                                               = 19
```

No console errors and no response at or above 400 while the page loaded.

### The one figure that did not agree, and why it is not the dashboard's fault

`/api/sites` returns 31 rows where the table holds 32, so the dashboard's 24 is
a faithful count of what it was given. The 32nd row is
`site-sunnamusk-oxford-street-tm9aq6`, and it is **orphaned**: its `board_id`
names workspace section `sec-731cdb10a3ba`, which no longer exists. It is
therefore invisible to every register — the canonical read filters on the
canonical key, and `registers=all` finds no section resolving to that one — and
both reads were run to confirm it, returning 31 either way.

**This is a known incident with the fix already shipped, and this row is the
residue of it.** `app/lib/register-scope.ts` describes it in as many words:

> The failure was observed, not theorised: a Sites instance created during
> testing was purged with a site in it, and the row survived carrying the key of
> a board that no longer existed. It was then invisible to every register […]
> while still holding its name against a unique id, so the next attempt to
> create a site of the same name answered 409 for a row nobody could see.

`rehomeRegisterRows` and `scopedRegisterRows` were written to stop it happening
again, and the section purge now refuses a register that still holds rows. What
neither does is repair a row orphaned BEFORE they existed, and nothing sweeps
one: the orphan clean-up in `db/init.ts` is about legacy boards, not about a
site carrying a dead `board_id`.

The row was created 2026-09-04 by the test that motivated the fix. It is one
row, in Staging, in the client's organisation, and it has a live consequence —
a second "Sunnamusk Oxford Street" cannot be created, because the name is held
by a row nobody can see.

**Recorded rather than deleted.** A site is real operational data whichever
register it sits in, the owner ruled out cascading deletes of canonical entities
when a section goes, and re-homing it is a data write this pass was not
authorised to make. The repair is one `UPDATE` setting `board_id` to the
canonical register — exactly what `rehomeRegisterRows` does — and it wants to be
made deliberately, by someone who has decided that is the right home for it.

---

## W14-07 — every calendar event against its original Job or Compliance record

The Operations calendar draws from three places, and each was compared against
Postgres by **per-day fingerprint** rather than by row count, because a count
survives a timezone shift and a per-day hash does not.

| Source | Rows | Days | API (deployed) | Postgres | |
| --- | ---: | ---: | --- | --- | --- |
| `calendar_events` | 55 | 47 | `8ed9d42b…` | `8ed9d42b…` | ✅ |
| Jobs with a `scheduled_date` | 172 | 106 | `01dc0d2e…` | `01dc0d2e…` | ✅ |
| Certificate expiries | 50 | 19 | `ce02c7b1…` | `ce02c7b1…` | ✅ |

Identical on every one. No date lands on a different day in the deployed API
than it occupies in the database — which is the failure this check exists to
catch, and the one a row count would have missed.

**The hybrid planned-visit invariant holds, though trivially.** All 57 calendar
events across both organisations are standalone (`request_id` null), so no row
carries both a job link and its own schedule. `plannedVisitIntegrityIssue` has
nothing to flag because nothing yet exercises the linked case.

Rendered at 1440 / 768 / 380 px with no horizontal overflow, no console error
and no response at or above 400. The calendar independently reproduces two
figures from `expected-values.json`: the Unscheduled tray shows **8**, and the
banner names **3** unmapped statuses.

## W14-13 — the landing-page pricing section

Compared line by line against the supplied `maintsupp-form-pricing-v2.html`.
Every figure in the approved source is present and correct on the deployed page:

| | Approved | Deployed |
| --- | --- | --- |
| Maintenance Coordination | £65 /store/month + VAT · ≈ £520 at 8 stores | same |
| Compliance Administration | £55 /store/month + VAT · ≈ £440 at 8 stores | same |
| Total Care | £100 /store/month + VAT · ≈ £800 at 8 stores | same |
| Most popular / bundle saving | save £20 per store | same |
| One-off setup | from £25 /store + VAT | same |
| Portfolio minimum | £295 /month + VAT | same |
| Additional jobs · P1 escalation | from £65 each · £125 per incident | same |

The deployed section also carries a store-count selector (1–10 / 11–25 / 26+), a
live total for the chosen count, and a three-plan comparison table — the
"updated" part of the requirement.

> A false alarm worth recording so nobody repeats it. A first pass reported the
> three headline prices missing, because the markup renders the symbol and the
> number as separate nodes (`£` then `65`) and a `£[0-9]+` search cannot see
> them. The page was right and the search was wrong.

`content.ts` still exports a four-tier `packages` array (£45/£85/£115/£165). It
is rendered nowhere, and `app/(marketing)/page.tsx` already says why: "packages
— four tiers with no prices, replaced by Pricing". Dead by decision, not drift.

## W14-14 — the opening form, submitted end to end

Section 10's form is Report-a-Job — the one with the file inputs and the
reference number. Nine fields carry a required marker in their label: site,
contact name, phone, email, address, postcode, fault category, urgency,
description; access window is explicitly optional.

| Criterion | Result |
| --- | --- |
| Required fields and labels | ✅ nine marked, one optional, all labelled |
| Validation and helpful errors | ✅ an empty submit is refused with "Check the highlighted fields and submit again." plus per-field messages |
| Connected to the right system | ✅ `201 /api/report-job` |
| Files stored against the submission | ✅ `201 /api/files`, and the row has exactly 1 attachment |
| Confirmation and reference | ✅ "Request MN-1076 received. The operations team can now begin triage." |

**Two things that look like defects and are not**, both chased to the bottom:

1. With every field filled the browser reported the form completely valid, yet
   nothing submitted. The cause is deliberate and documented in
   `report-job.tsx`: at least one photo or video is required, and the files live
   in component state rather than in a form field, so `checkValidity()` cannot
   see them. With a file attached it submits first time. The upload error is
   rendered and visible when it is the only thing missing.
2. The row's `reference` column is NULL. So is every other row's — all 21 in
   that organisation. The reference is the primary key: the row's `id` *is*
   `MN-1076`. Nothing is lost.

**One test record was created and is deliberately still there:** `MN-1076` in
the client's own organisation, description prefixed `W14TEST-`. It is the
evidence for this check. It should be binned once the checklist is signed off.

---

## W14-15 — every landing-page image against the approved file

| What | Result |
| --- | --- |
| Image URLs referenced on the landing page | 114 |
| Returning 200 | **114** — none missing, none empty |
| Broken (`naturalWidth === 0`) at 1440 / 768 / 390 px | **0** |
| Distorted (rendered ratio ≠ intrinsic, excluding `object-fit`) | **0** |
| Originals vs modern variants | 20 originals 11.7 MB · 94 WebP/AVIF 3.7 MB |

Five approved originals were compared **byte for byte** against the supplied
`MAINTSUPP-image-assets-v3` pack by SHA-256 — `who-we-help-retail-chains`,
`-clinics-wellness`, `-gyms-studios`, `-commercial-offices`,
`-shopping-centre-kiosks`. Every one is IDENTICAL to the file supplied, at the
site path the pack's own README gives. "Use the original-quality image files"
and "do not compress" are satisfied literally: the original is the `src`, and
the AVIF/WebP variants are offered above it, so a browser takes ~110 KB instead
of 2.2 MB without the original ever being replaced.

The pack supplies six audience photographs and the page uses five.
`who-we-help-franchise-groups.png` still ships and still serves 200, and
`who-we-help.tsx` says why in its header: **"WHY FIVE AND NOT SIX: 'Franchise
groups' was withdrawn."** A decision, not a missing image.

## W14-16 — desktop, tablet and mobile

Nine portal surfaces (Overview, Jobs, Planned, Sites, Contractors, Compliance,
Documents, Reports, Settings) plus the public landing page, at 1440 / 768 /
390 px — **thirty renders**.

**No horizontal overflow anywhere, and no surface rendered empty.** The portal
screenshots at each width are in this pass's evidence set.

## W14-18 — random, placeholder and demonstration data

**The demo estate is properly isolated.** Not one seeded row and not one
`zzdemo-` id appears in the client's organisation, across all eight tables that
carry them — jobs, sites, contractors, users, attachments, compliance documents,
calendar events and reminder rules. That is the boundary the whole seed
architecture exists to hold, and it holds.

**What is in the client's organisation is another matter.** Of 21 jobs, eight
are not operational records:

| Record | Title | Created |
| --- | --- | --- |
| MN-1075 | "Test test test" | 2026-09-04 |
| MN-1074 | "New store" | 2026-09-04 |
| MN-1073 | "New job" | 2026-09-04 |
| MN-1067 | "New store" | 2026-08-20 |
| MN-1066 | "New store" | 2026-08-20 |
| MN-1071 | "R1 QA job D for contractor-link parity spec" | 2026-08-29 |
| MN-1070 | "R1 QA job C for contractor-link parity spec" | 2026-08-29 |
| MN-1076 | this pass's own W14-14 evidence, `W14TEST-` prefixed | 2026-09-06 |

And **five of the six contractors are test records**: "test", "Test a", "test",
"test new section", "tester". One is real.

Five `*.test.maintsupp.com` user accounts also sit in that organisation. Those
are platform test identities and are a different question from operational
clutter.

**Two things must be said plainly about this result.** First, this is the
STAGING database, and a staging estate is expected to carry test rows — the
check's real subject is Production, which this pass is forbidden to touch and
which holds 776 jobs. Second, it still matters: `maintsupp-preview` is the link
the client is shown, and this is what they see on it.

**OWNER DECISION REQUIRED.** Removing them is a data write in the client's
organisation. The safe route is the product's own recycle bin rather than SQL,
which keeps the deletion auditable and reversible for thirty days.

## W14-05 addendum — a capacity failure found while testing, not a code defect

Partway through the responsive sweep the deployed Preview began answering
**500 on `/api/files/…` and 503 on `/api/navigation`, `/api/notifications`,
`/api/context` and `/api/sites`**, reproducibly, and did not recover. The
runtime log gives one cause for all of them:

```
D1_ERROR: (EMAXCONNSESSION) max clients reached in session mode
          — max clients are limited to pool_size: 30
```

`pg_stat_activity` shows Supavisor holding 30 connections. This is the
documented tension of the architecture, not a new bug: the session pooler is
mandatory (the transaction pooler has a documented deadlock), each warm
serverless instance holds up to two clients, and enough instances saturate a
pool capped at 30.

**The mitigation is already in the deployed build.** `db/node-pg-d1.ts` names
this exact error in its header and answers it with `idle_timeout: 20` and
`max_lifetime: 1800`, and the deployment carries them — verified at the deployed
commit, with neither `PG_D1_IDLE_TIMEOUT` nor `PG_D1_POOL` overridden on
Preview. What this pass demonstrates is that the mitigation is not sufficient
under sustained concurrent load: thirty renders across three widths, plus seeds,
plus three concurrent cron dispatches, exhausted it.

**It recovers, and that matters to the classification.** After roughly three
minutes with no traffic at all, `/api/context` and `/api/sites` both answered
200 again. Earlier probes had reported it stuck only because each retry woke
another instance — the retries were feeding the thing they were measuring. So
this is saturation under sustained concurrent load, which drains on its own,
and **not** a connection leak: `idle_timeout` does give the sockets back once
the load stops.

The practical consequence for the rest of this pass is that deployed testing has
to be paced — sequential, with pauses — rather than fanned out.

Raising `pool_size`, lowering `max` per instance, or moving off session mode are
all capacity decisions — and one of them is explicitly forbidden. **Recorded as
a capacity finding for the Performance phase, which this pass is instructed not
to begin.**

---

## W14-01 — date fields and date-range controls

Clicking a `Date Requested` cell on the Jobs board opens a real picker: focus
lands on an `input[type=date]` and a calendar popover renders. A change was made
and **persisted** — `PATCH 200 /api/maintenance`, and `zzdemo-job-001` moved to
`2026-06-11` in Postgres.

That edit changed seeded data the reconciliation harness depends on, so the
estate was re-seeded immediately afterwards and re-verified at **97 passing, 0
failing, 100%** — which incidentally demonstrates that the seed repairs drift
rather than merely detecting it.

## W14-02 — column editing, sorting and filtering

Column management, through the register API:

| Operation | Result |
| --- | --- |
| add | 201 |
| rename | 200, new title confirmed in the response |
| hide | 200 |
| reorder | 200 |
| remove | 200 — 32 columns became 31 and the key was gone |
| delete a NATIVE column | **409 "Native columns cannot be deleted. Hide it instead."** |
| add a nameless column | **400 "Give the column a name."** |

**Sorting** is offered per column, not by clicking the header text: the board
exposes `Sort Name ascending`, `Sort Location ascending`, `Sort Tier Level
ascending` and `Sort Priority ascending`, alongside `Filter`, `Hide` and
`Resize <column> column`. Clicking one flips the control to offer
`Sort Name descending`, so both directions are reachable. Multi-column
subsorting is an ordered rule list in `board-sort.ts` (`addSortRule`,
`flipSortRule`, `moveSortRule`).

> Stated honestly: the board's rows are virtualised and not plain `tbody tr`, so
> the harness could not read them back to watch the order change. What is
> evidenced is the control state flipping, not a reordering observed directly.

**Filtering** was watched end to end on the Sites register: searching
"Birmingham" took it from 8 rows to 1, the right one. **Editing a value directly
from the table** is the same write proved in W14-01.

## W14-03 — adding, renaming, reordering, archiving and removing sections

Add 201 · rename 200 (label confirmed) · reorder 200 · archive 200 · restore 200.

Removal is deliberately two-step, and that IS the confirmation the checklist
asks for: `DELETE` archives and answers `{"archived": true}`; a second `DELETE`
answers `{"alreadyArchived": true}` and changes nothing; only
`DELETE ...?purge=1` destroys, answering:

```json
{"ok":true,"deleted":true,"discarded":{"arrangements":0,"views":0},
 "rehomed":{"sites":0,"contractors":0,"groups":0,"total":0},"board":null}
```

That `rehomed` block is the safeguard written after the orphaned-site incident
in W14-06, reporting that it had nothing to rescue. The mechanism that would
have prevented that orphan is live and answering.

## W14-04 — the default page a new section gets

A section created with `template: "sites"` comes back `ownsBoard: true` with its
own board key, and its page carries every element the checklist lists: the title
in sidebar and header, a description, configurable columns (a Summary / All
columns toggle), a search field, Status and Group filters, Export CSV / Import
CSV / Add site, and an empty state that tells the reader what to do —
**"No sites yet. Add your first one, or import a CSV."**

A section created WITHOUT a template is handled just as carefully rather than
left broken: it renders the canonical register and says **"This section has no
register of its own. Remove it and add it again to give it one."**

## W14-08 / W14-09 — Sites and Contractors

Both full cycles pass. Contractor edits were read back from Postgres to confirm
they landed: phone `07111 111111` and the note both persisted.

| | Sites | Contractors |
| --- | --- | --- |
| add | 200 | 200 |
| edit | 200 | 200, verified in the database |
| archive | 200 | 200 |
| remove | 200 | 200 |

**"Remove" means archive, for both, and there is no permanent removal.** After
two DELETEs a site is still present with `active = false`; it is not in the
recycle bin either. That is consistent with the owner's instruction never to
cascade-delete canonical entities — a site is real operational data whatever
register it sits in — but it is worth knowing plainly: nothing in the product
permanently removes a site or a contractor.

## W14-10 — documents

| Step | Result |
| --- | --- |
| upload with no anchor | **400 "A document must be filed against a work order, a site, a unit or a contractor."** |
| upload against a site | 201 |
| download | 200, **192 bytes — byte-identical to the original** |
| download with no session | **401** |
| replace | 201, `versionNo: 2`, `isCurrent: true`, `rootDocumentId` = the original |
| download the new version | 200, 619 bytes |
| remove | 200, **`versionsDeleted: 2`** |

The lineage model behaves exactly as `CLAUDE.md` describes: a replacement is the
same document at a new version, and deleting the current version takes the
lineage with it.

## W14-11 / W14-12 — every report and customised date range

Four ranges through the real engine on the deployed Preview, each checked
against Postgres independently:

| Range | Report | Database | |
| --- | ---: | ---: | --- |
| August 2026 | 65 | 65 | ✅ |
| September 2026 | 31 | 31 | ✅ |
| Q3 (Jul-Sep) | 135 | 135 | ✅ |
| 15 September only | 0 | 0 | ✅ |

They are additive — 39 + 65 + 31 = 135 — and the labels are right: a whole
calendar month is named "September 2026", a span is "Custom range". A reversed
range is refused rather than silently swapped: **400 "The start date is after
the end date."**

## W14-17 — permissions for every user role

Three roles, defined in `app/lib/permissions.ts` and enforced server-side:

| Role | Capabilities |
| --- | --- |
| `super_admin` | all |
| `admin` | 14 — and **`data.delete` is withheld**, along with `clients.view_all` and `billing.manage` |
| `client` | two only: `board.view`, `data.export` |

Ninety-one capability-guarded call sites across eight capabilities; only three
routes demand `data.delete`. Every `/api/admin/*` route gates itself with
`requireCapability`. Twelve protected endpoints were called with no session and
**every one answered 401** — not 403, not 500, and nothing leaked.

> The limit of this check, stated rather than glossed: role SEPARATION is
> evidenced from the code and from unauthenticated refusals, not by signing in as
> a client and being refused. The other accounts' passwords are not in this
> checkout, and inventing one would have meant changing a credential.

## W14-19 — evidence

Thirty-five screenshots and fifty-nine captured data files, covering the landing
page at three widths, nine portal surfaces at three widths, the calendar, the
reconciliation page, the report-a-job form in four states, the board, the sort
panel and a newly created section's default page.

## W14-20 — the completed checklist

This document and the consolidated W14 final report are the deliverable for
review and approval. **Approval remains the owner's**, and nothing here is a
sign-off: the items in the final report marked OWNER DECISION REQUIRED need an
answer before this checklist can be called complete.

---

# W14 sign-off pass — the three owner decisions

Executed 2026-09-06/07 against Supabase Staging (`ajslebfjwgkvhlntrdmw`) and the
deployed Preview only. Production (`wghfhtdzxttfhofuljyy`) was not touched.

## Decision 1 — the orphaned site, REPAIRED

**And it was not the record everybody thought it was.** Before writing anything,
the row was read in full, and the two "Sunnamusk Oxford Street" rows are not a
real site and its duplicate:

| | `…-36yf5e` | `…-tm9aq6` (the orphan) |
| --- | --- | --- |
| `board_id` | `null` — canonical | `sec-731cdb10a3ba` — **section gone** |
| address | 128 Oxford Street, London, W1D 1LT | **"13 , food street", cairo**, no postcode |
| jobs / units / certs | 2 / 0 / 0 | **0 / 0 / 0** |
| created | 2026-08-20, with the estate import | **2026-09-04 04:58** |
| active | false, Closed | true |

The orphan is a **test record** from the 2026-09-04 session that also produced
"New job", "New store" and "Test test test" — not an operational site that lost
its register.

Two more orphans were found that nobody had listed: contractors `test` and
`test new section`, both pointing at a second dead section `sec-75ae0103d9eb`,
both created 04:48–04:49 the same morning. Three orphans, one origin.

**Both dead sections were confirmed absent** from `workspace_sections` and from
`boards` before any write, and every row was confirmed to be in the client
organisation.

The repair is exactly `rehomeRegisterRows`: `board_id → NULL`, which is the
value of `CANONICAL_REGISTER`. Each statement was additionally guarded with
`not exists (select 1 from workspace_sections where id = board_id)`, so it could
only ever touch a row whose section is genuinely gone.

```
BEFORE  sites        site-sunnamusk-oxford-street-tm9aq6   board_id sec-731cdb10a3ba
BEFORE  contractors  contractor-test-223bd7fa              board_id sec-75ae0103d9eb
BEFORE  contractors  contractor-test-new-section-80bead63  board_id sec-75ae0103d9eb
AFTER   all three                                          board_id NULL
```

**Re-homing was the prerequisite for cleaning them up, not an alternative to
it.** An orphan is reachable by no register and therefore by no API, so nothing
in the product could archive or remove it. Decision 1 is what made Decision 2
possible.

Verified immediately after: `/api/sites` went from 31 rows to **32**, matching
the table exactly, and `registers=all` agreed. Orphan count across every
organisation is now **0 sites, 0 contractors, 0 groups**.

## Decision 2 — QA records in the client organisation, CLEANED

Re-identified from live data first. Fourteen records, every one with zero linked
jobs.

**Eight jobs, moved to the recycle bin through the board's own `delete_items`
action** — no SQL:

```
MN-1066  MN-1067  MN-1070  MN-1071  MN-1073  MN-1074  MN-1075  MN-1076
7 items moved to the recycle bin. They can be restored for 30 days.
```

Seven moved; MN-1074 was already in the bin, which is why the API omitted it —
correctly, as a no-op rather than an error.

> **A correction to the original W14-18 finding.** It reported "8 of 21 jobs"
> without excluding rows already in the bin. The true figure was 7 test records
> among 20 live jobs. The client organisation now holds **13 live jobs, and not
> one of them is test-shaped.**

**Five contractors and one site, archived through the product API** — `DELETE`
on `/api/workspace` and `/api/sites`, all 200. They are left in the recycle-bin
lifecycle rather than destroyed, because Decision 2 forbids SQL deletes in the
client organisation and the product has no permanent-removal path for either.

## Decision 3 — the ZZ-W14 demo fixture, CLEANED

The product archives a site rather than deleting it, so the fixture would have
remained. Decision 3 covers QA data in the demo organisation and says to use the
normal path *where possible*; where it is not, the two rows were removed
directly, each guarded on organisation, `is_seed = false`, `active = false` and
the absence of any dependent row:

```
deleted  sites        site-zz-w14-site-1788732036-4zr2lz
deleted  contractors  contractor-zz-w14-contractor-1788733129-72095870
```

The demo organisation is back to exactly its seeded shape: **12 sites, 0
non-seeded, 6 contractors, 180 jobs.**

## W14-06 retest — PASS, fully reconciled

Every figure read off the rendered dashboard, then computed again from Postgres:

| Figure | Dashboard | Database | |
| --- | ---: | ---: | --- |
| **Active sites** | **24** | **24** | ✅ *was 24 vs 25* |
| Sites, all | 32 | 32 | ✅ *API saw 31 before* |
| Open jobs | 11 | 11 | ✅ |
| Completed | 2 | 2 | ✅ |
| Jobs total | 13 | 13 | ✅ |
| Tier 1 / 2 / 3 | 3 / 6 / 4 | 3 / 6 / 4 | ✅ |
| Urgent / Medium / Low | 3 / 6 / 4 | 3 / 6 / 4 | ✅ |

The discrepancy that failed the original W14-06 is gone, and it is gone for the
right reason: the platform can now see every row the table holds.

## W14-18 retest — PARTIAL, and the reason is a product limit

| Estate | Result |
| --- | --- |
| Demo isolation | ✅ **0 seeded rows and 0 `zzdemo-` ids** in the client organisation, across all eight tables |
| Demo organisation | ✅ back to its seeded shape, 0 non-seeded rows |
| Client jobs | ✅ 13 live, **0 test-shaped** |
| Client sites | ⚠️ the test site is archived, and still listed as "Closed" |
| Client contractors | ⚠️ five test contractors archived, and still listed with an "Archived" badge |

**Nothing test-shaped remains in any live or operational set.** What remains is
visible in the registers, correctly badged as archived — because the registers
show archived rows by design, and because **nothing in the product permanently
removes a site or a contractor**. Two `DELETE`s leave the row present with
`active = false`; it does not enter the recycle bin either.

Decision 2 forbids SQL deletes in the client organisation, and that instruction
is respected. So this cannot reach a clean pass by any approved means, and the
remaining step is the owner's:

**OWNER DECISION** — either accept archived-and-badged as "removed", or
authorise a guarded delete of the five contractors and one site (all have zero
linked jobs), which would take the client's Contractors register to one real
contractor and its Sites register to 31.

## A finding that only a live scheduler could have produced

`seed:verify` was run again at the end and came back **83 passing, 14 failing**.
Every one of the fourteen was a reminder metric, with one signature: *Due today*
15 → **0** at every step, *Already sent* 125 → **134**.

That is not drift or damage. It is **the hourly scheduler working**: two runs
fired on schedule at 20:00 and 22:41, both succeeded, and both consumed the
reminders that were due. Re-seeding restored **97 passing, 0 failing, 100%**.

Worth writing down, because the next person to run `seed:verify` some hours
after seeding will see fourteen red rows and reasonably conclude something
broke: **the reminder metrics are a snapshot taken at seed time, and a working
cron necessarily moves them.**

---

# W14-18 guarded delete — executed 2026-09-07

Staging only (`ajslebfjwgkvhlntrdmw`); Production (`wghfhtdzxttfhofuljyy`) was
never connected to. The pre-delete manifest is at
`docs/w14-audit/2026-09-07-w14-18-delete-manifest.md`.

## What was deleted, and how

Five of the six approved records, in **one transaction**, scoped to exact ids —
no pattern, no wildcard, no organisation-wide purge — with every statement
additionally guarded by `not exists` clauses over every foreign-key child, so a
row could not be removed if any dependency had appeared between validation and
execution:

```
contractor-test-223bd7fa              test
contractor-test-a-a3db51df            Test a
contractor-test-new-section-80bead63  test new section
contractor-tester-87253bdd            tester
site-sunnamusk-oxford-street-tm9aq6   Sunnamusk Oxford Street [cairo]
```

## What was HELD, and why

`contractor-test-c6cfce01` was not deleted. It carries a dependency that was not
identified when the delete was approved: one attachment,
`136ef2ca-7491-4ba3-a30a-a4f27369eec4`, `test.jpg`, 700,587 bytes, `image/jpeg`,
kind `general`, no title, no document type, no expiry, anchored to nothing but
the contractor.

The approval says to stop a record whose child dependency was not previously
identified. Every marker says the file is test data — but it is a real 700 KB
object, and deleting the row would also strand it in Storage. **One instruction
would close it: delete the attachment row and the contractor together.**

## A seventh test record the first pass missed

`MN-1072` was classified "looks real" in the original W14-18 because its title is
`[P3] Routine` — the urgency label the public form generates, the same shape as
this pass's own `MN-1076`. Its description is `teststeetstsdtsd` and its site
address `13 , food street, E14 5AA`, the same cairo address as the deleted test
site.

It was moved to the recycle bin through the board's own flow, restorable for 30
days. The previous approval said its list was non-exhaustive and instructed that
every record be re-identified from live data, which is what surfaced it.

**The genuine live job count is therefore 12, not the 13 the target assumed** —
the difference is this record.

> The same sweep cleared two false alarms. `MN-1051`, "Two ceiling spotlights out
> above the **tester** counter", is a genuine job — a perfume tester counter, in a
> fragrance retailer's store. A `\btester\b` search flagged it and it is real.

## Final state

| | Client organisation | Demo organisation |
| --- | ---: | ---: |
| Sites | **31** | 12, all seeded |
| Contractors | **2** — 1 genuine, 1 held | 6, all seeded |
| Live jobs | **12**, none test-shaped | 180 |
| Test sites | **0** | 0 non-seeded |
| Seeded rows leaked in | **0** | — |
| Orphans (dead `board_id`) | **0** | 0 |

Verified through the product as well as the database: `/api/sites` returns 31
with 24 active, `/api/maintenance` returns 12 with nothing test-shaped, the Sites
register shows no test data, and no 4xx or 5xx appeared. No ghost-name conflict
is possible any more, because no row is invisible to its register.

## W14-18 verdict

**PARTIAL, by one record.** Jobs, sites, orphans and tenant isolation are all
clean. One contractor named `test` remains visible in the client's Contractors
register, held deliberately for the reason above rather than deleted without a
specific instruction.

---

# W14-18 closed — the last record, 2026-09-07

Staging only (`ajslebfjwgkvhlntrdmw`). Production was never connected to.

## Re-read before deletion

`contractor-test-c6cfce01`, re-read at the moment of deletion: organisation
`org_…001` (the Staging client organisation), name `test`, `active = false`,
`is_seed = false`, `board_id` null, and **zero** linked jobs, quotations,
invoices, certifications and site links.

Its one attachment, re-read in full:

| field | value |
| --- | --- |
| id | `136ef2ca-7491-4ba3-a30a-a4f27369eec4` |
| original name | `test.jpg`, 700,587 bytes, `image/jpeg` |
| kind | `general`; title, document type and expiry all null |
| anchors | `request_id`, `site_id`, `unit_id`, `update_id`, `board_column_id` — **all null** |
| lineage | `root_document_id` null, **0 other versions** |
| compliance references | **0** |
| rows sharing its object key | **1** — itself, so nothing else needs the object |
| object key | `org_…001/maintenance/contractor-test-c6cfce01/general/136ef2ca-…-test.jpg` |

No new dependency appeared, so the record was not stopped a second time.

## Deletion

The attachment went through the **application's own path**, not SQL:
`DELETE /api/files/136ef2ca-…` → `{"deleted": true, "versionsDeleted": 1}`.
The file answered 200 with 700,587 bytes immediately before, and **404**
immediately after.

**The Storage claim is proved rather than assumed.** In
`app/api/files/[id]/route.ts` the object delete runs BEFORE the metadata delete
and is not wrapped in a catch:

```ts
for (const keys of chunkIds(objectKeys, 1000)) {
  await storage.delete(keys);          // objectKey and objectKey.thumb
}
for (const chunk of chunkIds(doomedIds)) {
  await db.delete(attachments)...      // only reached if the above resolved
}
```

So a failed Storage delete would have thrown, the route would have answered 500,
and the metadata row would still exist. It answered 200 and the row is gone —
which means the object and its thumbnail were removed.

The contractor then went in **one transaction scoped to its exact id**, guarded
by `not exists` over every foreign-key child including the attachment that had
just been removed.

## Final Staging client estate

| | Target | Actual | |
| --- | ---: | ---: | --- |
| Sites | 31 | **31** | ✅ |
| Contractors | 1 | **1** | ✅ |
| Live jobs | 12 | **12** | ✅ |
| Test contractors | 0 | **0** | ✅ |
| Test sites | 0 | **0** | ✅ |
| Test jobs | 0 | **0** | ✅ |
| Orphan attachment metadata | 0 | **0** | ✅ |
| Rows referencing the deleted object | 0 | **0** | ✅ |
| Attachments pointing at a missing contractor | 0 | **0** | ✅ |
| Seeded rows leaked into the client org | 0 | **0** | ✅ |

Through the product: `/api/sites` 31 with 24 active, `/api/maintenance` 12 with
nothing test-shaped, `/api/workspace` one contractor — `PV Contractor l7jp5` —
and 31 stores, `/api/context` 200. The Contractors register renders a single
row and the Sites register none of the test data. No 4xx or 5xx anywhere.

**Demo Client Ltd is untouched and isolated**: 12 sites all seeded, 6
contractors all seeded, 180 jobs, zero non-seeded rows. `seed:verify` returns
**97 passing, 0 failing, 100%**.

> One string still matches a naive search of the Jobs board, and it is not a
> defect: **MN-1051, "Two ceiling spotlights out above the tester counter"** — a
> perfume tester counter, in a fragrance retailer's store. A `\btester\b` search
> flags a genuine job. Recorded so the next reader does not delete it.

## W14-18 — PASS

No random, placeholder or demonstration data remains in the client
organisation, in any state: not live, not archived, not orphaned, and not in
Storage.

**W14 is 20 / 20.**
