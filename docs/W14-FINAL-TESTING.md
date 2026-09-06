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
