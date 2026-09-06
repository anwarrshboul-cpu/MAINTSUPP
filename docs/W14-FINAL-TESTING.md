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
