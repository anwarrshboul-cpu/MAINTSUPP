# Legacy portal → Supabase Postgres (`portal` schema)

Ports the legacy MAINTSUPP portal — 48 tables in Cloudflare D1/SQLite — into
PostgreSQL so the legacy portal UI can eventually be served from Supabase
instead of D1.

**Status: done and verified against the real Supabase project.** All 48 tables
created, all 30,265 rows loaded, every verification check green.

---

## Safety: this did not touch Phase 2

The Supabase project (`wghfhtdzxttfhofuljyy`) holds the **live Phase 2
application** in `public` — 23 tables, 791 rows in `jobs`. Everything here
targets a **new schema, `portal`**, and nothing else.

Enforced three ways rather than by care alone:

- Every object is written `portal.*`. No `search_path` is ever set, so an
  unqualified `create table` cannot silently land in `public`.
- `migrate.mjs` refuses to execute any migration file whose SQL (comments
  stripped) matches `drop schema`, `drop database`, `public.`, or
  `create schema public`. It checks all files before opening a connection.
- `migrate.mjs` and `verify.mjs` both re-count `public` and print the result.
  `verify.mjs` fails if it is not exactly 23 tables.

Confirmed after the load: `public` = 23 tables, `public.jobs` = 791 rows.

---

## Running it

```bash
# 1. Take a consistent copy of the live SQLite file (never read the live one directly)
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite \
  "VACUUM INTO '/tmp/legacy-src.sqlite';"

# 2. Create the portal schema (idempotent)
node migration/legacy-to-postgres/migrate.mjs

# 3. Load the data (idempotent, streaming)
node migration/legacy-to-postgres/load.mjs /tmp/legacy-src.sqlite

# 4. Verify
node migration/legacy-to-postgres/verify.mjs /tmp/legacy-src.sqlite
```

`DATABASE_URL` is read from `.dev.vars` — the Supabase **session** pooler on
port 5432. Not the transaction pooler on 6543, which per
`packages/db/src/client.ts` deadlocks this workload. Nothing here rewrites the
port. Override with the `DATABASE_URL` env var if needed.

All three scripts are re-runnable. Re-running the load reads all 30,265 rows
and inserts 0 (verified).

```
migration/legacy-to-postgres/
├── migrations/
│   ├── 001_schema.sql      create schema portal
│   ├── 002_identity.sql    organisations, users, sessions, auth  (10 tables)
│   ├── 003_estate.sql      sites, units, contractors             (7 tables)
│   ├── 004_boards.sql      boards, columns, options, views       (7 tables)
│   ├── 005_requests.sql    jobs, cells, attachments, invoices    (12 tables)
│   ├── 006_workspace.sql   layouts, preferences, recycle bin     (6 tables)
│   ├── 007_logs.sql        activity, audit, notifications        (6 tables)
│   └── 008_indexes.sql     all 107 secondary indexes
├── lib/
│   ├── plan.mjs            connections, table list, FK-derived load order
│   └── convert.mjs         all SQLite→Postgres value conversion
├── migrate.mjs             applies the DDL
├── load.mjs                streams the data
└── verify.mjs              row counts + fidelity checks
```

---

## What landed

| | |
|---|---|
| Tables | 48 |
| Columns | 621 |
| Indexes | 155 (107 explicit + 48 primary-key) |
| Foreign keys | 63 |
| **Rows migrated** | **30,265** |

Column types after conversion: 430 `text`, 111 `timestamptz`, 27 `boolean`,
27 `integer`, 12 `date`, 8 `bigint`, 6 `double precision`.

---

## Dialect decisions

Everything below was decided by inspecting the actual stored data and the
application code, not by assuming. The non-mechanical ones are marked ★.

### ★ 1. Timestamps: three source formats, not one

The brief warned not to assume ISO-8601, and that warning was correct. The 84
time-bearing columns hold **three** different formats:

| Format | Example | Count | Source |
|---|---|---|---|
| SQLite `CURRENT_TIMESTAMP` | `2026-08-07 09:33:46` | 35,847 | database default |
| JS `toISOString()` | `2026-08-07T14:41:02.645Z` | 19,625 | application writes |
| Bare calendar date | `2015-09-02` | 2,576 | Monday.com import |

Some columns mix them. `audit_events.created_at` is 4,433 ISO-8601 and 2,037
`CURRENT_TIMESTAMP` in the same column; `item_updates.created_at` is 269 and 84.
A converter handling only one format would have failed on a third or two thirds
of those tables respectively.

The space-separated form is read as **UTC**, which is how SQLite defines
`CURRENT_TIMESTAMP`. Reading it as local time would have shifted every audit
trail by the server's offset — an hour for this application's `Europe/London`
default — and nothing would have looked obviously wrong.

`lib/convert.mjs` accepts exactly these three and **throws** on anything else.
It never substitutes NULL for input it cannot parse, because that produces
matching row counts while silently destroying data.

### ★ 2. Four columns became `date`, not `timestamptz`

Blanket "TEXT timestamp → timestamptz" is wrong for four columns whose values
are 100% bare `YYYY-MM-DD`:

- `maintenance_requests.due_at` (67 values)
- `maintenance_requests.completed_at` (485)
- `maintenance_requests.next_update_at` (94)
- `compliance_documents.expiry_date` (34)

These are calendar dates, written by `<input type="date">`
(`portal-app.tsx:4809` edits `dueAt` with a `"date"` editor) and read straight
back. Forcing them into `timestamptz` attaches a fabricated `00:00:00` plus a
timezone, and then a viewer east or west of UTC sees the **previous or next
day** — an off-by-one-day bug *introduced by the migration*. Postgres `date`
round-trips the string exactly and cannot drift.

Eight further columns are `date` on the same reasoning, typed from the UI
because they hold no data yet: `sites.lease_start`/`lease_end`,
`units.installed_at`/`warranty_expiry`/`last_serviced_at`/`next_service_due_at`,
`contractors.insurance_expiry`, `invoices.due_at`. All are `<input type="date">`
fields in the app.

### ★ 3. …but `requested_at` stayed `timestamptz`

`maintenance_requests.requested_at` is 634 bare dates and 142 full datetimes.
Despite the majority being date-only it is `timestamptz`, because it is
`NOT NULL DEFAULT CURRENT_TIMESTAMP` and genuinely records *when a job
arrived*. Its date-only values are Monday.com backfill that never had a time.

Those 634 rows now read `00:00:00Z`. **Listed under "lossy" below** — although
strictly nothing was lost, since the source had no time-of-day to discard.

### ★ 4. Columns that look like dates but are not

Three traps, all left as `text`:

- **`sites.break_clause`, `sites.rent_review`** sit right beside `lease_start`
  and `lease_end` but hold free-form lease terms (`"5 yearly"`), edited with a
  plain text field. Typing them as `date` would reject the values they exist
  to hold.
- **`compliance_documents.last_alert_stage`** ends in a date-ish word but holds
  a stage name like `"30d"`.
- **`maintenance_board_cells.value`** — see below.

### ★ 5. `maintenance_board_cells.value` must stay `text`

The largest table (8,720 rows) has one untyped `value` column holding whatever
its board column calls for. Sampling finds bare dates, people's names,
comma-joined Monday.com URLs, **phone numbers with a leading zero**
(`01179529394` — any numeric type mangles this to `1179529394`), plain
integers, date *ranges* (`2023-03-13 - 2023-03-31`), and 61 rows literally
reading `[object Object]` from a prior stringify bug.

1,262 of those values match `YYYY-MM-DD`. A per-*value* date detector would
have converted exactly those and broken the other 7,458. Type decisions are
made per column, on the whole column, all-or-nothing.

### ★ 6. `sign_in_failures` is the one table that must NOT get timestamps

`first_at` and `blocked_until` are INTEGER **epoch milliseconds**
(`1786613349820`), compared arithmetically by the rate limiter. Two decisions:

- They stay numeric. `timestamptz` would break `blocked_until > Date.now()`,
  and the sentinel `0` ("never blocked") has no sensible instant.
- They are **`bigint`, not `integer`**. `1.78e12` overflows Postgres `integer`
  (max 2.147e9); SQLite's 64-bit INTEGER hid this. **This is the single most
  likely silent failure in the whole port** and the reason the type map was
  checked against real values rather than declared types.

`count` beside them is a genuine small counter and stays `integer`.

### 7. Integer booleans → `boolean`

27 columns confirmed to hold only 0/1 *and* to be used as flags became real
`boolean`, with `DEFAULT 0`/`1` → `DEFAULT false`/`true`.

★ The judgement was **not** mechanical. Columns holding only 0 and 1 in this
dataset that are **not** booleans and stayed `integer`:

- `maintenance_requests.tier` — a severity level (holds 0 and 2, default 2)
- `boards.position`, `sites.position`, `teams.position` — ordering
- `job_access_tokens.use_count`, `boards.reference_counter` — counters

`convert.mjs` throws on any value other than 0/1/null in a `boolean` column
rather than using JS truthiness, since `Boolean(2) === true` is exactly the
kind of quiet reinterpretation that makes a migration untrustworthy.

### ★ 8. Money stayed `double precision` — deliberately not `numeric`

`maintenance_requests.cost`, `quotations.amount`, `invoices.amount` are money
in SQLite `REAL` columns. That is a pre-existing flaw — `74.76` and `199.2` are
already inexact in the source.

`double precision` reproduces the stored bits **exactly**. `numeric` would
silently round and make the migration lossy in a way that is very hard to
detect afterwards. Fixing money representation is a schema change for the
application to make deliberately, not something a port should do behind its
back. **Recommended follow-up, not done here.**

`*_pence` columns (integer pence) were widened `integer` → `bigint`: Postgres
`integer` caps at ~£21.5m expressed in pence, and `annual_budget_pence` already
holds 1,800,000 for a single site. `attachments.byte_size` likewise, since
`integer` caps at 2.1GB per file.

### 9. Text primary keys stayed text

Legacy ids are application-generated strings — `org_00000…0001`,
`req_4ff2c25d…`, `store-aldgate`, imported `MN-1049`. They appear in URLs, in
R2 `object_key` paths, and in external systems. **No uuids were invented
anywhere.**

### 10. AUTOINCREMENT / rowid

Not one legacy table uses `INTEGER PRIMARY KEY AUTOINCREMENT`; every primary
key is `text`, and the implicit `rowid` is never selected by the application.
So there is **no sequence to create and no `setval` to run after loading** —
a step that is mandatory when porting a SQLite schema that *does* use
AUTOINCREMENT, and whose omission normally surfaces as a duplicate-key error on
the first insert after migration.

The one thing that behaves like a sequence is `boards.reference_counter`, which
the app increments by hand to mint job references. It is a plain integer,
migrated at its current value, so the next reference continues the series.

### 11. `CHECK` constraints

**There are none in the legacy schema.** All 48 `CREATE TABLE` statements were
checked — validation lives entirely in application code and in the
`option_values` lookup tables. Nothing to port, and none were invented.

### 12. Defaults, indexes, partial indexes

- `DEFAULT CURRENT_TIMESTAMP` → `DEFAULT now()`. Agrees on the instant; `now()`
  adds microsecond precision, which only affects rows written after migration.
- All 107 secondary indexes ported, names unchanged (Postgres index names are
  schema-scoped, so no collision with `public`).
- `maintenance_requests_live_idx` is a **partial** index
  (`WHERE deleted_at IS NULL`) — Postgres supports this with identical syntax
  and it was carried across verbatim rather than widened.
- Unique indexes spanning a nullable column (e.g.
  `navigation_layouts (organisation_id, user_id)` where NULL user means "org
  default") keep default NULL-distinct behaviour. Postgres 15+ offers
  `NULLS NOT DISTINCT`; deliberately **not** used, as it would impose a
  constraint the legacy app never had.
- SQLite's inline `UNIQUE` on `organisations.slug`, `users.email` and
  `attachments.object_key` was each *also* declared as a named unique index in
  the legacy schema. Only the named index is created here — same guarantee,
  one index instead of two.

### 13. `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`

**29 occurrences confirmed** in application/seed code — `db/init.ts` (20),
`db/seed-store-documentation.ts` (7), `app/lib/auth-session.ts` (2). None are
DDL, so **none were rewritten here**; this is DDL plus a data load. The rewrite
is required before the *application* can run against Postgres and is listed
under "What remains".

`load.mjs` itself uses `on conflict do nothing`, which is what makes it
re-runnable.

---

## Foreign keys: 63 created, 3 deliberately not

D1/miniflare runs with `PRAGMA foreign_keys = 0`, so SQLite **never enforced**
these. `PRAGMA foreign_key_check` on the source returns **zero violations**, so
all 63 declared constraints were created and all hold.

★ Three *implied* relationships were left unconstrained because the live data
would reject them. Deleting or rewriting rows to satisfy a constraint nobody
asked for would be a silent data change:

| Relationship | Failing rows | Why |
|---|---|---|
| `maintenance_requests.site_id → sites.id` | **31** | store `''` (empty string), not a site id. `NOT NULL` is satisfied; referential integrity is not. |
| `attachments.site_id → sites.id` | **95** | same — `''`. |
| `item_activity.request_id → maintenance_requests.id` | **6** | 3 `req_*` ids and 3 `MN-1049` whose jobs no longer exist — audit trail outliving its subject. |

These are **reported by `verify.mjs`** on every run so they cannot quietly rot.
Cleaning them is a decision for the data owners.

A further set of relationships resolve cleanly today but carry no FK in the
legacy schema and were **not** tightened, to keep this a faithful port:
`sessions.organisation_id`, `boards.organisation_id`,
`maintenance_requests.parent_id`, `item_updates.request_id`,
`job_access_tokens.request_id`, `attachments.unit_id`/`update_id`,
`invitations.accepted_user_id`, `compliance_documents.site_id`. Each is a
one-line follow-up migration if wanted.

### ★ The `board_id` trap

`boards.id` is `board_org_000000000000000000000001_maintenance`, but `board_id`
on nine other tables is just `maintenance`. **`board_id` stores the board's
*key*, not its id**, scoped by `organisation_id` alongside it — two distinct
values across four board rows, because both organisations reuse the same keys.

So **no `board_id → boards(id)` foreign key can exist**; it would reject every
row. The legacy schema declares none and neither does this one. Normalising it
requires rewriting column contents, which is a data change, not a port.

---

## What is lossy

Honestly, very little — but all of it, stated:

1. **634 `requested_at` values now read `00:00:00Z`.** The source held bare
   dates with no time-of-day, so nothing was discarded; but a reader diffing
   the two databases will see midnight where SQLite showed `2015-09-02` and
   deserves the explanation. Verified: exactly 634 rows sit at midnight in
   both. The same applies to the 2,576 bare dates across all `timestamptz`
   columns.

2. **Sub-second precision was never present** in the `CURRENT_TIMESTAMP` values
   (second granularity) and is preserved where it was present (the
   `toISOString()` values keep their milliseconds).

3. **Money remains floating-point.** Not made worse, not fixed — see decision 8.

Nothing else. Specifically **not** lost: no rows dropped, no columns dropped,
no values silently nulled (the converter throws instead), no ids rewritten, no
text truncated. `verify.mjs` reported **zero** date truncations.

### Not in scope: file bytes

`attachments` rows are **metadata only** — 2,968 rows describing objects that
live in R2, keyed by `object_key`. No binary data is in this database and none
was moved. This is by design and was confirmed: the only BLOB in the source
file is in `_cf_METADATA`.

### Excluded table

`_cf_METADATA` is Cloudflare D1's internal bookkeeping (one row, a BLOB holding
D1's schema version). Not application data, meaningless outside D1, excluded.
This is why `sqlite_master` reports 49 tables and this migration handles 48.

---

## Verification output

Run against the real Supabase project. Full per-table table is in the task
report; summary:

```
ROW COUNTS       48/48 tables PASS      TOTAL  30,265 → 30,265  PASS
SCHEMA PARITY    PASS — all 621 legacy columns exist in portal
TIMESTAMP        7/7 PASS  (min/max instant agrees, incl. both mixed-format columns)
BOOLEAN          6/6 PASS  (count of 1s == count of true)
DATA-QUALITY     4/4 PASS  (31 / 95 / 6 known-bad rows carried across intact)
public schema    23 tables (unchanged)

VERIFICATION PASSED — every check green.
```

Row counts alone are a weak check — a loader nulling every timestamp it could
not parse would still produce a perfect count table. Hence checks 2–5.

---

## What remains

This makes Postgres **able to hold** everything the legacy portal holds. It does
not yet make the legacy portal **run** on it. Outstanding, roughly in order:

1. **Rewrite the data access layer.** `db/schema.ts` is
   `drizzle-orm/sqlite-core` and must become `drizzle-orm/pg-core`. The 29
   `INSERT OR IGNORE` statements become `ON CONFLICT DO NOTHING`.
2. **Placeholder syntax.** D1 uses `?`; Postgres uses `$1`. Every raw query
   needs converting.
3. **Read the new types.** The app currently receives timestamps as strings.
   `timestamptz` columns now come back as `Date` objects and `boolean` columns
   as `true`/`false` rather than `1`/`0`. Every consumer of those fields needs
   checking — this is the largest single piece of work and the most likely
   source of subtle UI bugs.
4. **Decide on the empty-string `site_id` rows** (31 jobs, 95 attachments) and
   the 6 orphaned `item_activity` rows. Then the three withheld FKs can be
   added.
5. **Normalise `board_id`** to reference `boards.id`, if that is wanted.
6. **Consider `jsonb`.** 11 columns hold JSON as `text` (`settings`, `items`,
   `filters`, `sort`, `service_categories`, `allowed_kinds`, …). Left as `text`
   because the app does its own `JSON.parse`/`stringify` and a `jsonb` column
   hands back an already-parsed object, which would make `JSON.parse` throw.
   Worth doing **paired with** the code change, not before it.
7. **Fix money to `numeric`** — see decision 8.
8. **Row-level security.** `portal` has none. Multi-tenancy is currently
   enforced entirely in application code via `organisation_id`. If this schema
   is ever reached by a Supabase anon/authenticated key rather than only by a
   server-side connection, RLS is mandatory. It is not enabled here because
   doing so would break the current server-side access pattern without the
   corresponding policy design.
9. **A cut-over plan.** This load is a point-in-time copy. Anything written to
   D1 after the `VACUUM INTO` is not here. Re-running `load.mjs` inserts new
   rows but does **not** update changed ones (`on conflict do nothing`), so a
   real cut-over needs either a freeze window or an upsert variant.
