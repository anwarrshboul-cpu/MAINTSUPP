# monday.com export — the read-only pull, and the audit that reads it back

Two Python scripts, standard library only, no `pip install`, nothing to build.
They exist beside the `.mjs` pullers in this directory rather than replacing
them: `pull-monday-api.mjs` and `pull-monday-comments.mjs` feed the app's own
importers and are wired into the tests, while these two produce a **standalone,
checksummed archive** on a disk of your choosing for a migration to read.

| script | what it does | writes |
| --- | --- | --- |
| `monday_export.py` | reads both boards plus the subitems board and downloads every attachment | the output directory only |
| `monday_audit.py` | reads that output back and reports on it | the report directory only |
| `test_monday_export.py`, `test_monday_audit.py` | 70 tests over the pure logic | nothing |

Neither script writes to monday, and neither touches a MAINTSUPP database. Every
monday query in `monday_export.py` is a read; `monday_audit.py` opens no socket
at all.

## The token

```bash
export MONDAY_API_TOKEN='...'          # bash
```
```powershell
$env:MONDAY_API_TOKEN = '...'          # PowerShell, current session only
```

monday.com → your avatar (bottom left) → **Developers** → **My Access Tokens**.
It needs read access to workspace 2341287.

The token is read from the environment and nowhere else. It is never a command
line argument (arguments are visible in the process list and in shell history),
never printed, and never written to any output file — including the failure log,
whose error text is truncated before it is stored. Do not put it in a `.env`
inside this repository: the repository is public.

## Where the output goes

**Outside the repository.** The export carries the client's live data — store
addresses, out-of-hours access notes, contact numbers, photographs of the inside
of shops — and this repository is public. `.gitignore` already refuses `*.json`
and `*.csv` in this directory, but the right answer is not to write it here at
all:

```bash
python3 db/monday-export/monday_export.py --no-files --out D:/MAINTSUPP-Monday-Export/dry-run-2026-09-09
```

## The two-phase workflow

**Phase one — metadata, and the gate.**

```bash
python3 db/monday-export/monday_export.py \
    --no-files --out D:/MAINTSUPP-Monday-Export/dry-run-2026-09-09
python3 db/monday-export/monday_audit.py \
    --export D:/MAINTSUPP-Monday-Export/dry-run-2026-09-09 \
    --matrix store-documentation-compliance-matrix.csv \
    --out    D:/MAINTSUPP-Monday-Export/dry-run-2026-09-09/reports
```

`reports/reconciliation.md` says PASS or FAIL. A FAIL means a page was missed,
and downloading several gigabytes of photographs on top of an incomplete item
list only makes the incompleteness more expensive to discover.

The exporter enforces this itself: a file run whose item counts do not reconcile
refuses to download and says so. `--force-files` overrides it, deliberately.

**Phase two — the bytes.**

```bash
python3 db/monday-export/monday_export.py --out D:/MAINTSUPP-Monday-Export/full-2026-09-09
```

Re-running is safe. A file already on disk is re-hashed locally and kept if its
size agrees with monday's; only missing or disagreeing files are fetched again.
`--no-resume` forces a full re-download.

## Reading the result

`export-summary.json` ends with `"status": "COMPLETE"` or `"INCOMPLETE"`, and
the process exit code matches. **INCOMPLETE means the export is not a migration
source**, whatever the counts look like. It is set by any of: a board whose
exported count differs from monday's, a recorded failure, or a downloaded file
whose size disagrees with the size monday reported.

- `failures.csv` — every item, page or asset that did not export, with why.
- `file-manifest.csv` — one row per file: board, item, source, source column id
  and title, asset id, original filename, extension, HTTP content type,
  monday's reported size, the downloaded size, `size_match`, SHA-256, the local
  path, the original upload time and uploader.
- `api-capabilities.json` — what this API version actually exposes, including
  whether replies can carry assets.

`size_match` has three values, not two: `True`, `False`, and `unknown` for an
asset monday reported no size for. `unknown` is not a pass.

## Page sizes

50 items per page for the metadata pass, 25 once updates are attached, 25
updates per item. The migration brief says 100; the number does not matter as
long as every item arrives, and these are the sizes the `.mjs` pullers have used
against this account for a year. monday bills a query by complexity and refuses
the *whole page* when the budget is spent, so a smaller page is not slower in
practice — it is the difference between finishing and not.

What does matter is that `Item.updates` **defaults to 25 with no error when it
truncates**. The exporter always states the limit and pages past it, and reports
how many items needed a second page.

## What this corrects in the supplied `monday_export.py`

Six of these were silent data loss — the export would finish, print a success
line and be wrong.

1. **`Item.updates` had no limit**, so every conversation longer than 25 updates
   was cut off without an error. Now paged explicitly, with the number of items
   that needed a follow-up page reported.
2. **Paging went through `items_page(cursor:)`.** The documented continuation is
   the top-level `next_items_page`. A cursor the server ignores re-serves page
   one forever; there is now a duplicate-id guard and a no-progress guard as
   well.
3. **Assets were mapped to their column by regex over the cell's display text.**
   The raw cell value carries `{"files":[{"assetId":...}]}` — an id rather than a
   rendering. On Store Documentation the column *is* the certificate type, so
   this decided whether a PAT certificate could be told from a fire door report.
4. **`size_match` compared a string to an int** and read `False` for every file
   ever downloaded, while an asset with no reported size read `True`. The check
   could neither fail usefully nor pass honestly.
5. **A file that failed every retry stayed on disk, truncated**, with no manifest
   row. Bytes now land in `.part` and are renamed only when complete.
6. **Expired asset URLs counted as failures.** They expire in about an hour and a
   full run is longer than that; the URL is now re-read and the download retried.
7. **The subitems board was not in the script at all** — it could not confirm the
   brief's claim that it is empty. All three boards are exported, and a non-empty
   subitems board is exported in full rather than skipped.
8. **Reply attachments were never requested.** Whether `Reply.assets` exists
   depends on the API version, so the exporter introspects the schema, includes
   the field when it is there, and records the answer in
   `api-capabilities.json`.
9. **The run always exited 0.** There is now a COMPLETE/INCOMPLETE verdict and a
   matching exit code.

Two smaller ones: duplicate column titles no longer collide in `items.csv`, and
filenames are capped at 120 characters so the deepest path stays under Windows'
260-character limit.

## Counts

**Do not trust a number in this file, or in any brief, as the live count.** The
audit reads `items_count` from the board itself and reconciles against what was
exported. The figures in circulation — 772 Maintenance, 31 Store Documentation,
0 subitems — are from an audit dated 6–8 August 2026 and are the thing being
verified, not the answer.

Two known discrepancies between the migration brief and
`db/monday-board-spec.ts`, which is a verbatim capture pinned by
`tests/stage-nineteen-maintenance-parity.test.mjs`:

- the brief says "items per group (all 39)". The capture has **38** groups.
- the brief says "the 26 `<Store> completed` groups". There are **28**.

The brief also writes the Westfield Stratford group as `Westfield Stratford
completed`; the live title has two spaces. The audit normalises whitespace
before matching, so it resolves — a literal comparison would not.

## What the audit produces

```
reconciliation.md              live vs exported, per board — the gate
audit-maintenance.md           groups, statuses, labels, costs, contractors
audit-store-documentation.md
site-alias-mapping.csv         every site string on either board, classified
contractor-candidates.csv      distinct free-text contractors, with variants
job-titles.csv                 the generated title per item, and which rule made it
job-titles-and-contractors.md  rule counts, and every rule-4 item
group-status-disagreements.csv items filed as completed whose status says otherwise
store-doc-classification.csv   CLEAR / NEEDS REVIEW / ORGANISATION-LEVEL / ...
store-doc-documents.csv        every certificate, and the column that types it
filename-site-mismatches.csv   a file whose name says one site, filed against another
organisation-level-documents.csv  one document filed against several sites
compliance-matrix-diff.csv     the supplied matrix against live monday
subitems.md                    the subitems board's real item count
```

Every site mapping is a **proposal with its reason attached**. A string that
matches two sites within 0.08 is reported `AMBIGUOUS` rather than resolved to
whichever sorted first, and a string below 0.80 is `UNRESOLVED` rather than
guessed. Nothing in the audit creates a site, a contractor or an alias.

`--matrix` is optional, and so is `--export`: with a matrix and no export the
audit classifies the supplied CSV alone, which is how the site register was
reviewed before a token existed.

## Tests

```bash
python3 db/monday-export/test_monday_export.py
python3 db/monday-export/test_monday_audit.py
```

Not part of `npm test`, which builds first and runs `node:test` over
`tests/*.test.mjs`. These are Python and run in under a second.

They cover the corrections above — the size check that could not fail, the asset
that could not name its column, the reply whose attachments were never counted —
and the audit's own judgement: that `Nottingham complited` resolves,
that Arndale and the Trafford Centre do not collapse into one Manchester, that
`RAMS Watfrod Atria .docx` filed against Bluewater is flagged despite the typo,
and that `Item 5` refuses to become a site.
