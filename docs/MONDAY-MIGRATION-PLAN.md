# monday.com → MAINTSUPP migration plan

Version 1, 2026-09-09. Written after the Phase 1 export and before any write.

Source of truth for the data: the local Phase 1 export at
`D:\MAINTSUPP-Monday-Export\full-2026-09-09\` — 774 Maintenance items, 31 Store
Documentation rows, 3,107 files, every one checksummed. **The importer never
calls monday.** Re-reading a board that has moved on mid-import is how two runs
of the same migration produce two different databases.

Source of truth for the destination: the live Staging schema, read on
2026-09-09, not `db/schema.ts` and not the original migration brief.

---

## 1. The decision that shapes everything else

**MAINTSUPP already has a monday-shaped board.** `maintenance_board_columns` on
the Maintenance board carries all 25 of monday's columns under matching keys —
`label`, `timeline`, `number`, `storeLocation`, `formView` and the rest — and
`maintenance_board_cells` stores a value per (item, column). `sites` carries
`monday_maintenance_name` and `monday_compliance_name`. `site_aliases` and
`contractor_name_aliases` exist. `item_updates.parent_id` threads replies.
`import_anomalies` records what an import changed and why.

So the brief's field names (`location_raw`, `contractor_name_raw`,
`source_item_name`, `label`, `tier`) are **not new concepts to build**. Almost
all of them already have a destination, and `app/api/import/route.ts` already
writes to it. This plan reuses that path rather than adding a parallel one.

Nine additive columns are genuinely new; §3 lists them.

### Two representations, both written

Every job is written twice, deliberately, because two parts of the product read
different things:

- **`maintenance_requests` scalar columns** — what the dashboards, meters,
  filters and exports aggregate over.
- **`maintenance_board_cells`** — what the board grid renders.

The existing import route already does this, and a row written to only one of
them is invisible in the other. Cells whose value is a copy of a scalar are
written with `INSERT … SELECT` from the row itself rather than carried
separately, so the two cannot disagree.

---

## 2. Identity and idempotency

Re-running the importer must reconcile, never duplicate. Every entity therefore
has a stable key derived from the source:

| entity | key | uniqueness |
| --- | --- | --- |
| job | `maintenance_requests.external_id` = monday item id | existing index `(organisation_id, external_id)` |
| board cell | `(organisation_id, board_id, request_id, column_id)` | natural key |
| group placement | `maintenance_group_items.request_id` | primary key |
| site | `sites.code` = `mnd-<canonical slug>` | existing unique index on `(organisation_id, code)` |
| site alias | `site_aliases.normalised` | existing unique `(organisation_id, normalised)` |
| update / reply | `item_updates.id` = `mu-<monday update id>` / `mr-<monday reply id>` | primary key |
| attachment | `attachments.id` = `ma-<monday asset id>` | primary key |
| contractor | `contractors.id` = `mc-<slug>` | primary key |
| compliance record | `compliance_documents.id` = `mcd-<site code>-<slot key>` | primary key |
| anomaly | `import_anomalies.id` = `<batch>-<kind>-<entity>` | primary key |

Deriving ids from the source rather than generating them is what makes the
importer idempotent without a bookkeeping table: the second run computes the
same id, finds the row, and updates it.

**Everything is scoped to one organisation** — the rehearsal tenant — and every
statement carries `organisation_id`. Nothing reads or writes another tenant.

---

## 3. Additive schema

Declared in the `CREATE TABLE IF NOT EXISTS` text in `ensureBaseSchema`, which
is how this codebase adds a column: `reconcileDeclaredColumns` reads each
table's catalogue once per boot and `ALTER TABLE ADD COLUMN`s anything absent.
Additive, idempotent, no rename, no drop, no destructive `ALTER`.

**`maintenance_requests`** — five columns:

| column | why |
| --- | --- |
| `source_item_name TEXT` | monday's Name, verbatim. `title` now holds a *generated* title (§5), so the original needs its own home |
| `source_group TEXT` | monday's group title. The brief makes Status authoritative over the group; keeping the group is what makes the disagreement auditable |
| `source_number TEXT` | monday's `Number` column. It also lands in `contact`, which is where the existing route puts it, but `contact` is a phone field and 583 of 774 rows have no number |
| `source_url TEXT` | the monday item URL, for provenance |
| `title_rule INTEGER` | which of the six title rules produced the title. Reporting a count per rule requires storing it |

**`attachments`** — three columns:

| column | why |
| --- | --- |
| `source_asset_id TEXT` | monday's asset id — the file idempotency key |
| `checksum_sha256 TEXT` | proves the byte that left the export is the byte that arrived |
| `source_column_id TEXT` | monday's file column id. `board_column_id` holds the MAINTSUPP key; this holds monday's, so provenance survives a board rename |

**`item_updates`** — one column:

| column | why |
| --- | --- |
| `source_update_id TEXT` | monday's update/reply id. The row id is derived from it, but a queryable column is what a reconciliation joins on |

Nothing else. No new table, no new subsystem.

---

## 4. Site register

Built and **frozen before any job is written**, because a job's `site_id` cannot
be resolved against a register that is still moving.

### Resolution order (deterministic; fuzzy never writes)

1. `Store Location Name` label → canonical site (21 labels, exact)
2. Maintenance group title → canonical site (28 `<Store> completed` groups, exact after whitespace/suffix normalisation)
3. `location_raw` exact canonical name or approved alias
4. approved normalised alias
5. **fuzzy → REVIEW ONLY.** Never writes `site_id`

A job whose signals disagree — label says one site, group says another — is
**held for review**: `site_id` stays null, an `import_anomalies` row records both
signals, and the job still imports. No job is dropped for failing to resolve.

### The four Phase 1 fuzzy candidates

Individually reviewed and promoted to **approved aliases**, because each is a
single word that names exactly one site and no other:

| source | canonical | why approved |
| --- | --- | --- |
| `Silverburn` | Glasgow – Silverburn | only site carrying the token |
| `Stratford` / `stratford` | Westfield – Stratford | only site carrying the token |
| `Trafford` | Manchester – Trafford Centre | only site carrying the token |

`Bristol` and `Westfiled` stay unresolved on purpose — Cabot Circus and Cribbs
Causeway both carry "bristol"; Stratford and White City both carry "westfield".
Guessing either attaches one shop's history to another.

### Cardiff — one site, not two

Phase 1 proved by checksum that `Cardiff St Davids` and `Grand Arcade - Cardiff`
are the same shop: two PAT files byte-identical across both rows, both from job
1057752, and Grand Arcade's own address reads "(FORMERLY KNOWN AS UNIT LG24)" —
which is what the other row is named after.

One site: **Cardiff – Grand Arcade**, `lifecycle = Current`, `status = active`.
Aliases stored: `Cardiff St Davids`, `Grand Arcade - Cardiff`, `Cardiff – Grand
Arcade`, `Cardiff completed`, `UNIT LG24`, `10 Grand Arcade`. Both monday item
ids preserved — `monday_compliance_name` holds the primary source name and an
`import_anomalies` row of kind `site-merge` records the second item id, its
`Closed` group and the checksum evidence, so the historical closed
representation is not lost.

Every Cardiff job under either naming resolves to this one site.

### The four international sites

`Mall of Scandinavia`, `Nacka`, `Solna`, `Täby` are created as distinct sites,
never merged into a UK one:

- `region = 'International'`, `lifecycle = 'Current'`, `status = 'active'`
- `country` from source evidence where the source states it (`Nacka / Sweden`
  and `Taby/ Sweden` say Sweden; `Mall of Scandinavia` and `Solna` do not, and
  **no address is invented** — `address` is left as the source string)
- source alias preserved verbatim, including `Nacka / Sweden` and `Taby/ Sweden`

### Expected count

Computed from the mapping, not hardcoded: 33 register entries minus the Cardiff
merge (−1), minus `Item 5` which is not a site (−1), plus four international
(+4) = **35**, subject to what the frozen mapping actually produces.

---

## 5. Job titles

First rule that yields content. `title` is `NOT NULL` in the schema and must
never be blank in fact either.

| rule | template | stored in `title_rule` |
| --- | --- | ---: |
| 1 | `{Site} — {Label}` | 1 |
| 2 | `{Site} — {first 60 useful chars of Description}` | 2 |
| 3 | `{Location raw} — {first 60 useful chars of Description}` | 3 |
| 4 | `{first 60 useful chars of Description}` | 4 |
| 5 | `Job {source_number}` — only when non-blank | 5 |
| 6 | `Monday Job {source_item_id}` — absolute fallback | 6 |

Rules 4 and 6 are Phase 2 additions. Phase 1 proved both items reaching the old
rule 4 had no `Number`, so the brief's last resort produced `Job ` — a blank
title on a `NOT NULL` column. Rule 6 cannot fail: every item has an id.

"Useful chars" means trimmed, with runs of whitespace collapsed; a description
of `"   "` is not content.

monday's Name is kept in `source_item_name` regardless, and the board's `name`
cell carries the generated title so the grid and the dashboards agree.

---

## 6. Maintenance column mapping — all 25

| # | monday column | id | MAINTSUPP scalar | board cell | notes |
| ---: | --- | --- | --- | --- | --- |
| 1 | Name | `name` | `source_item_name` | `name` (generated title) | §5 |
| 2 | Location | `short_text6` | `location` | `location` | also feeds site resolution |
| 3 | Description of Works | `short_text` | `description` | `description` | verbatim, never truncated in storage |
| 4 | Tier Level | `dropdown_mm51wmh0` | `tier` (int) | `tier` | "Tier 3" → 3; blank → 2 (column default) |
| 5 | Engineer Required | `single_select` | `engineer` | `engineer` | "Plummer" → **"Plumber"**, anomaly row keeps the raw |
| 6 | Priority | `status` | `priority` | `priority` | blank → null, never `""` |
| 7 | Label | `color_mm0ahrtb` | `category` | `label` | blank → null |
| 8 | Status | `status1` | `status` | `status` | all 23 labels verbatim |
| 9 | Contractor | `text_mm51zcqg` | `contractor` (raw) + `contractor_id` | `contractor` | raw never discarded |
| 10 | Assigned To | `person` | `assignee` + `assignee_user_id` | `assignee` | §9 |
| 11 | Date Requested | `date` | `requested_at` | `requested` | insert-only; a re-run never restamps |
| 12 | Date Completed | `date2` | `completed_at` | `completed` | |
| 13 | Timeline | `timeline` | `due_at` (end) | `timeline` | full range kept in the cell |
| 14 | Job Requested by | `short_text64` | `requester` | `requester` | |
| 15 | Next Update | `date_mkmts6wz` | `next_update_at` | `nextUpdate` | |
| 16 | Pictures of Issue | `upload_file` | — | `issuePictures` | attachments `kind='issue'` |
| 17 | Picture of completed | `dup__of_…` | — | `completedPictures` | attachments `kind='completion'` |
| 18 | Cost of Works | `numbers` | `cost` (real) | `cost` | **zero ≠ null**, both preserved |
| 19 | Approved by | `text` | `approved_by` | `approvedBy` | |
| 20 | Subitems | `subitems` | — | — | §11 — nothing to migrate |
| 21 | Invoice | `text6` | `invoice` | `invoice` | |
| 22 | Files | `file_mm44swj6` | — | `files` | attachments `kind='general'` |
| 23 | Number | `numbertb4g1z46` | `contact` + `source_number` | `number` | |
| 24 | Store Location Name | `single_selecty9rcyhe` | `site_id` | `storeLocation` | primary resolution signal |
| 25 | Form View | `form_view_19b7dd3b` | `form_url` | `formView` | |

**Per item as well:** monday item id → `external_id`; group title →
`source_group` and `maintenance_group_items`; item url → `source_url`;
created/updated → `created_at`/`updated_at`; `state` → `archived` where not
active.

`stage` is MAINTSUPP's own lifecycle, which monday has no column for. Taken from
the group's `stage_key`, falling back to Completed when the status is a
done-flagged one. **The Status column wins over the group for every meter**; the
group is preserved so the 40 disagreements stay auditable.

---

## 7. Store Documentation → Store Documentation board **and** Compliance

The 24 data columns map onto the seeded `store-documentation` board's 25 columns
one for one (verified live: every column id in the brief exists). Each row also
updates its canonical `sites` row — `address`, `type`, `access_url`/
`access_contact` from Access Request, `monday_compliance_name` from the row name.

Compliance uses the app's existing twelve-slot vocabulary from
`db/monday-board-spec.ts` (`storeDocumentationCertificates`), not a new one:
RAMS, Fire Risk Assessment, PLI, PAT Test, Electrical Wiring, Fire Extinguisher,
Fire Alarm, Emergency Lighting, Sprinkler, Water Hygiene, Fire Door, Drawing —
with the responsibility each slot already declares.

| source shape | `compliance_documents` | notes |
| --- | --- | --- |
| certificate **and** expiry | `status` from the app's own expiry rules, `attachment_id` set, `expiry_date` set | real evidence |
| expiry, no certificate | `expiry_date` set, `attachment_id` null, anomaly `certificate-missing` | due date preserved |
| certificate, no expiry | `attachment_id` set, `expiry_date` null, anomaly `expiry-missing` | RAMS, Fire Risk Assessment, Drawing are undated by design |
| neither | row created `not_required = false`, `status` unconfirmed, anomaly `responsibility-unconfirmed` | enters the confirm queue |
| **sprinkler with no evidence** | left unconfirmed; **never auto-assigned to the client** | landlord-controlled in a mall |
| **PLI** | one organisation-level record, not one per site | §8 |
| **the two suspicious files** | imported, but `attachment_id` **not** set; anomaly `document-site-mismatch` | §8 |

---

## 8. The specific data rules

**PLI is organisation-level.** Phase 1 proved by checksum that `Public Liability
Certificate 2027.pdf` is byte-identical on Aldgate and Westfield Stratford. One
compliance record is created against the organisation's primary site with an
`organisation-level` anomaly naming both source sites; **no per-site PLI gap is
created for the other 33 sites.** Aldgate's `Employers Liability Certificate.pdf`
is a *different* insurance in the same column and is imported as its own
document with a `mixed-document-type` anomaly rather than being treated as PLI.

**The two suspicious documents.** Both import with their bytes, checksum,
original filename, source item, source column and source site association
intact. Neither becomes verified compliance evidence: the compliance record is
created without `attachment_id`, and an `import_anomalies` row of kind
`document-site-mismatch` carries the filename, the site it is filed against and
the site its name suggests.

- *Bluewater* `RAMS Watfrod Atria .docx` — preserved, review-flagged. Watford
  already holds its own RAMS, so Bluewater may have none at all.
- *Cabot Circus* `Water_Hygiene_..._Meadowhall.docx` — preserved, review-flagged.
  The source expiry `2029-06-21` is **retained as source metadata on the
  compliance record** but the file is not its evidence.

**"Plummer" → "Plumber"**, with the option set seeded corrected and one
`import_anomalies` row per affected job holding the raw value.

**Blank labels are null.** Priority and Label both carry a blank monday label
that is the "no value" chip, not a category. Never stored as `""`.

**"Nottingham complited"** resolves to Nottingham – Victoria Centre by the
group-suffix rule, which strips `completed|complited`.

**Item 5** — from live evidence, not the README: monday id `1398027779`, group
Europe, created 2024-02-15, **one** non-empty column, `date4` (PLI Expiry)
`2024-02-13`. No address, no type, no documents, no updates. Not imported as a
site; recorded as skipped with its live contents.

**Subitems** — board 1164003119 serves one row whose `parent_item` is null, all
columns blank, created with the board in 2023. Not migrated as a job or a
subitem; recorded as source surplus evidence in `import_anomalies`.

---

## 9. People

No account is invented and no email is sent. Authentication configuration is not
touched.

- **Assigned To** and update authors are matched to an existing user in the
  rehearsal tenant **by email only**, and only when the email matches exactly.
- Unmatched: the source name and email are preserved as text —
  `maintenance_requests.assignee`, `item_updates.author_name` /
  `author_email`. Both columns already exist and `author_name` is `NOT NULL`,
  so an imported author always displays.
- `assignee_user_id` is set only on a real match.

---

## 10. Updates and replies

`item_updates` threads natively: a reply is a row whose `parent_id` is its
parent's row id. Both carry `source_update_id`.

Body: monday's `text_body` into `body`. The HTML is kept in the export and not
imported — `body` is rendered as text by the updates panel, and injecting
monday's HTML into it would be both a display and a safety change that this
migration has no mandate to make. Recorded as a known, deliberate omission.

Timestamps are monday's, not the migration's. `comment_count` on the job is
recomputed from the rows actually written.

---

## 11. Files

3,107 files, 3.73 GB, every one already checksummed locally.

- One `attachments` row per (item, asset), id `ma-<asset id>`, carrying
  `source_asset_id`, `checksum_sha256`, `original_name`, `content_type`,
  `byte_size`, `created_at` from monday's upload time, `uploaded_by_email`,
  `board_column_id` (MAINTSUPP key) and `source_column_id` (monday's).
- `kind` from the source column: `issue`, `completion`, `general`.
- Update and reply assets carry `update_id`.
- Store Documentation files carry `site_id` and `document_type`.
- **Content dedupe only where identity is proven** — equal SHA-256. A physical
  object is stored once; a second logical attachment row references the same
  `object_key`. Cross-site duplicates are recorded explicitly as anomalies
  rather than silently collapsed, because a PLI certificate on two sites and a
  PAT certificate on two sites mean different things.
- The bucket stays **private**. Access is brokered through `/api/files`; a
  monday URL is never stored as an application link.
- Uploads are gated on §14's storage capacity check.

---

## 12. Concurrency and connection safety

The known `EMAXCONNSESSION` pooler saturation is not solved here, but the
importer must not provoke it.

- Session pooler, port 5432. The transaction pooler (6543) is a documented
  deadlock for this adapter.
- **One pool, `max` configurable, default 2** — matching what the app itself
  runs per instance.
- Batches of 100 rows, configurable. No `Promise.all` over an unbounded array.
- Metadata writes in transactions per batch; files resumable independently.
- Transient connection errors retried with exponential backoff.
- A checkpoint file records the last completed batch per entity, so an
  interrupted run resumes rather than restarts.

---

## 13. Rollback

Every row this importer writes carries `organisation_id = <rehearsal org>`.
Rollback is therefore a scoped delete of that one organisation's rows in reverse
dependency order, and it cannot touch Sunnamusk or Demo:

```
delete from portal.item_update_likes    where organisation_id = :org;
delete from portal.item_updates          where organisation_id = :org;
delete from portal.attachments           where organisation_id = :org;
delete from portal.compliance_documents  where organisation_id = :org;
delete from portal.maintenance_board_cells where organisation_id = :org;
delete from portal.maintenance_group_items where organisation_id = :org;
delete from portal.maintenance_requests   where organisation_id = :org;
delete from portal.site_aliases           where organisation_id = :org;
delete from portal.compliance_documents   where organisation_id = :org;
delete from portal.sites                  where organisation_id = :org;
delete from portal.contractor_name_aliases where organisation_id = :org;
delete from portal.contractors            where organisation_id = :org;
delete from portal.import_anomalies       where organisation_id = :org;
```

Storage objects are keyed under the organisation id and removed by prefix.

A pre-import snapshot of the affected tables plus per-tenant row counts is taken
first (§7 of the brief) so "unchanged" can be proved rather than asserted.

---

## 14. Reconciliation

Nothing is called done on a claim. Source figures come from the Phase 1 export
and are recomputed, not copied from the report.

| line | source | how checked |
| --- | ---: | --- |
| jobs | 774 | count in the rehearsal tenant |
| groups | 39 | distinct `source_group`, plus placements |
| statuses | 23 defined / 10 in use | every source status present |
| labels | 16 | every source label present |
| jobs with a cost | 92 | including the 2 that are zero |
| total cost | £52,408.06 | exact sum, to the penny |
| updates | 200 | `parent_id is null` |
| replies | 45 | `parent_id is not null` |
| sites | computed | every source alias accounted for |
| unresolved jobs | listed individually | `site_id is null` |
| group/status disagreements | 40 | recomputed, not assumed |
| files | 3,107 | logical rows vs physical objects vs checksums |

Any difference is investigated and explained, never rounded away.
