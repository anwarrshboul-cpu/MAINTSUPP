# W14-18 guarded delete — pre-delete audit manifest

Taken 2026-09-07, immediately before the approved guarded delete.

- **Database:** Supabase Staging, project `ajslebfjwgkvhlntrdmw`
  (Production is `wghfhtdzxttfhofuljyy` and was not connected to)
- **Organisation:** `org_000000000000000000000001` — Sunnamusk UK, the client
  organisation on Staging
- **Authorised by:** owner, for Staging / Preview only
- **Method:** one transaction, scoped to the exact verified ids. No pattern,
  no wildcard, no organisation-wide purge, no delete-by-name.

## The six approved records, with every dependency counted

| # | id | name | active | is_seed | jobs | attach | certs | coverage | quotes | invoices | units | site certs | aliases | groups | planned | service |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `contractor-test-223bd7fa` | test | false | false | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| 2 | `contractor-test-a-a3db51df` | Test a | false | false | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| 3 | `contractor-test-new-section-80bead63` | test new section | false | false | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| 4 | `contractor-tester-87253bdd` | tester | false | false | 0 | 0 | 0 | 0 | 0 | 0 | — | — | — | — | — | — |
| 5 | `site-sunnamusk-oxford-street-tm9aq6` | Sunnamusk Oxford Street [cairo] | false | false | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 |
| 6 | `contractor-test-c6cfce01` | test | false | false | 0 | **1** | 0 | 0 | 0 | 0 | — | — | — | — | — | — |

Every record is in the client organisation, archived, non-seeded, and carries
zero linked jobs, zero quotations, zero invoices, zero certifications, zero
coverage rows, zero units, zero compliance documents, zero aliases, zero group
memberships, zero planned maintenance and zero service records.

## Why each is test data

1–4, 6 — contractors literally named `test`, `Test a`, `test new section`,
`tester`, `test`. Four of the five were created on 2026-09-04 between 04:48 and
04:52, in the session that also produced the jobs "New job", "New store" and
"Test test test".

5 — the row re-homed in Decision 1. Its address is **"13 , food street", cairo**
with no postcode, it holds no jobs, and it was created at 04:58 on 2026-09-04 in
that same session. The genuine "Sunnamusk Oxford Street" is a different row
(`…-36yf5e`, 128 Oxford Street, London W1D 1LT, two jobs) and is not touched.

## Record 6 — STOPPED, not deleted

`contractor-test-c6cfce01` carries a dependency that was not identified when the
delete was approved:

| field | value |
| --- | --- |
| attachment id | `136ef2ca-7491-4ba3-a30a-a4f27369eec4` |
| original name | **`test.jpg`** |
| kind | `general` — not a certificate, insurance or compliance document |
| title / document type / expiry | all null |
| size | 700,587 bytes, `image/jpeg` |
| anchors | contractor only — `request_id`, `site_id`, `unit_id`, `update_id` all null |
| storage object | `org_…001/maintenance/contractor-test-c6cfce01/general/136ef2ca-…-test.jpg` |
| uploaded | `owner@maintsupp.com`, 2026-09-02 |

The approval says to stop a record whose child dependency was not previously
identified, and this one qualifies. It is also the only record where deleting
the row would strand a real 700 KB object in Storage.

**Deleted: records 1–5. Held: record 6, pending a specific instruction.**
