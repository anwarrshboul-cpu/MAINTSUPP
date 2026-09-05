# Production bootstrap — state, blockers, and the exact remaining steps

> **UPDATE 2026-09-05, later the same day.** The Production Supabase project has
> been **restored** — `wghfhtdzxttfhofuljyy.supabase.co` now resolves and its
> REST endpoint answers `401 No API key found`, the same healthy signature as
> Staging. §1 below is kept as the record of why the first attempt halted; it is
> **no longer the current blocker**.
>
> Seven of the ten Production environment variables are now set on
> `maintsupp-portal`, target Production only: `PG_D1`, `PUBLIC_APP_ORIGIN`,
> `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `CRON_SECRET` (generated) and
> `MAINTSUPP_OWNER_PASSWORD` (generated; written to
> `C:\Users\omary\maintsupp-PRODUCTION-OWNER-LOGIN.txt`, outside the repo).
>
> **Three remain, and every one of them exists only inside the Supabase
> dashboard.** They cannot be derived, and Vercel does not return existing
> encrypted values over its API, so Preview's cannot be copied either — nor
> should they be:
>
> | Variable | Where to get it |
> | --- | --- |
> | `DATABASE_URL` | Settings → Database → Connection string → **Session pooler**. Copy it verbatim: **port 5432, not 6543** — the transaction pooler deadlocks this app. |
> | `S3_ACCESS_KEY_ID` | Storage → S3 Access Keys → *New access key* |
> | `S3_SECRET_ACCESS_KEY` | Shown once, at creation, beside the key id |
>
> Until all three are set, **do not deploy to Production**: `PG_D1=1` with no
> `DATABASE_URL` throws on the first query, and a partial `S3_*` set falls back
> to per-instance `/tmp` in silence (§4). No Production deployment exists yet —
> `targets.production` is still `NONE` — and that is deliberate.

Written 2026-09-05 against `main` = `6418d29`. Companion to
`docs/DEPLOYMENT-PORTAL.md`, which remains the authority on how the Portal is
built and shipped. This file answers one narrower question: **what stands
between today and a working Production environment**, and which of it a machine
can do versus which of it only the account owner can.

Read the blocker first. Everything below it was verified rather than assumed,
and where something could not be verified it says so instead of guessing.

---

## 1. The original blocker (RESOLVED — kept as the record)

**The Production Supabase project `wghfhtdzxttfhofuljyy` was paused and could
not be reached or resumed from a developer session.** It has since been restored
by the owner; see the update at the top.

Evidence, not inference:

| Check | Production `wghfhtdzxttfhofuljyy` | Staging `ajslebfjwgkvhlntrdmw` |
| --- | --- | --- |
| DNS `A` for `<ref>.supabase.co` | **no record at all** | `104.18.38.10` |
| `GET /rest/v1/` | connection fails (curl exit 6) | `401 No API key found` |

Supabase withdraws the DNS record for a paused project, so "does not resolve" is
the paused signature rather than a network fault. The staging row is the control:
the same probe, one host away, answers.

Resuming it needs the Supabase dashboard, or the Management API with a personal
access token. Neither is available here — there is no `~/.supabase/access-token`,
no `SUPABASE_ACCESS_TOKEN` in the environment, and both configured MCP servers
are bound to the **staging** ref (confirmed by calling `get_project_url` on each).
The production ref appears nowhere in this repository.

**Consequence.** Production `DATABASE_URL` and the four `S3_*` values cannot be
obtained, so the Production environment cannot be configured, so a Production
deployment cannot be made to work. Deploying anyway would publish an app with no
database — which is exactly what the stray `maintsupp` project already is, and
is worse than having no Production deployment at all, because it looks finished.

---

## 1b. CORRECTION: Production was PAUSED, not new

Two earlier sections of this file were written on the assumption that Production
was an empty database being stood up for the first time. **It is not.** Measured
2026-09-05:

| | Production `wghfhtdzxttfhofuljyy` | Staging `ajslebfjwgkvhlntrdmw` |
| --- | --- | --- |
| jobs | **776** | 20 |
| sites | **10** | 32 (31 live) |
| contractors | 6 | 6 |
| attachments | **2,968** | 25 |

Its owner account was created 2026-08-07, had its password set 2026-08-15, and
**signed in successfully on 2026-08-20**. This is a live estate that was paused,
and everything below has to be read that way.

**What that corrects:**

1. **§4's "if Production is effectively empty, leave it clean" does not apply.**
   There is real client data. Nothing may be seeded, reset or cloned into it.
2. **`batch_1b_canonical_site_estate` moves from "owner decision" to DO NOT
   APPLY.** §3's table rates it as a judgement call about seeding the canonical
   estate into a blank register. Production already holds 10 real sites, and
   that migration is 7.7 KB of `UPDATE`/`INSERT` against `portal.sites` — on a
   populated register it is a collision, not a seed. Same for
   `batch_1b_canonical_site_aliases`, which depends on it.
3. **The boolean repair was still right, and safer than it looked.**
   `USING (col <> 0)` converted in place, so all 776 jobs kept their flags. A
   drop-and-recreate — which an "it's empty anyway" reading would have made
   tempting — would have destroyed the estate.

**The owner credential is the owner's own, from August.** `ensureOwnerAccount`
seeds `MAINTSUPP_OWNER_PASSWORD` into a NULL hash only, so it never applied here
and never will while a hash exists. That variable is set on the Production
environment and is harmless, but do NOT "make it take effect" by clearing
`password_hash`: that discards a working credential on a live estate. The
supported recovery for a genuinely lost owner password is a reset link issued by
another account holding `users.edit` through
`POST /api/admin/users/password-reset`, which returns the link in its own
response because there is no mail server. If clearing the hash is ever
unavoidable, copy it to a row-keyed backup table first so the step is
reversible.

---

## 2. What the owner has to do (the whole list, in order)

Each step is a dashboard action. Nothing here can be delegated to a session that
holds no management credential.

1. **Restore the project.** Supabase dashboard → project `MAINTSUPP`
   (`wghfhtdzxttfhofuljyy`) → *Restore*. Wait for the API host to resolve again;
   `nslookup wghfhtdzxttfhofuljyy.supabase.co` returning an address is the
   done-signal.
2. **Take the database password.** Settings → Database. If it is unknown, reset
   it *now* rather than later — this is a fresh environment, so a reset costs
   nothing, whereas resetting after go-live drops live connections.
3. **Build the connection string on the SESSION pooler, port 5432.** Not 6543.
   The transaction pooler deadlocks this app — a documented failure, see
   `docs/DEPLOYMENT-PORTAL.md`. Supabase permits 15 clients and the app opens 2
   per instance.
4. **Create the storage bucket** `job-media`, **private**. It must not be public:
   every read is brokered through `/api/files`, so a public bucket would turn
   object keys into bearer credentials.
5. **Create S3 access keys** for that project (Storage → S3 access keys). These
   are *per project* — Staging's keys must never appear in Production.
6. **Set the Production environment variables** in the `maintsupp-portal` Vercel
   project, target **Production only** (§4 below).
7. **Deploy `main` to Production** and smoke-test (§7).

---

## 3. Schema: `ensureDatabase()` is ALMOST sufficient — one correction

> **CORRECTION, 2026-09-05.** An earlier revision of this section said
> `ensureDatabase()` was sufficient on a fresh Production Postgres. **That was
> wrong**, and the first Production deployment proved it. The section below is
> still right about tables, columns and indexes; it was wrong about COLUMN
> TYPES, and the gap is described here because it is the one thing that stops a
> fresh Postgres working at all.
>
> `db/init.ts` is dialect-shared, so it declares every flag the only way SQLite
> understands — `INTEGER NOT NULL DEFAULT 0`. `BOOLEAN_COLUMNS` in
> `db/sqlite-to-postgres.ts` then rewrites every comparison against those 37
> columns to `= true` / `= false`. The two halves agree only when the column
> really is boolean.
>
> Staging never exposed this: its `portal` schema came from
> `migration/legacy-to-postgres/migrations/001_schema.sql`, which declares real
> `boolean` columns, so every `CREATE TABLE IF NOT EXISTS` on the boot path
> skipped and these declarations never ran. Production was the first Postgres
> `init.ts` had ever built alone, and it produced all 35 of the flags it
> declares as `integer`. Postgres then answered every rewritten predicate with
> `operator does not exist: integer = boolean` (42883).
>
> **How it presents, which is nothing like a type error.**
> `ensureOwnerAccount` is called as `ensureOwnerAccount(d1).catch(() => {})` so
> that a seeding fault cannot take sign-in down. With `users.active` an integer
> the INSERT threw, was swallowed, and the owner account was never created — so
> a correct password returned *"That email and password do not match an
> account"*. The document-version index also failed to build, logged as
> "the one-current-head invariant is NOT enforced on this database".
>
> **Fixed in two places, both needed.**
> 1. `sqlite-to-postgres.ts` now translates the DDL type as well as the
>    comparison, so a database created from here on is correct at birth.
>    Covered by five tests in `tests/sqlite-to-postgres.test.mjs`.
> 2. `scripts/repair-postgres-boolean-columns.sql` retypes the columns of a
>    database that already has the integer shape. It converts in place with
>    `USING (col <> 0)` — **no data is lost**, it is idempotent, and it skips
>    anything already boolean. Run it once in the Supabase SQL editor, then
>    redeploy.

The rest of this section is unchanged and still holds:


`ensureDatabase()` in `db/init.ts` runs on the boot path of every request and
replays `CREATE TABLE IF NOT EXISTS`, guarded `addColumn` and `INSERT OR IGNORE`
seeds. On a **fresh** Postgres it produces the complete schema the current
product reads, because:

- **`maintenance_requests.site_id` is declared `TEXT`** — nullable — in the
  `CREATE TABLE`. The `BATCH_1B_APPLY=1` gate exists only to *relax an existing
  NOT NULL column* on a database that predates Batch 1B. A fresh database is
  born nullable, so **do not set `BATCH_1B_APPLY` in Production.**
- **Every W7 attachment column** (`title`, `document_type`, `description`,
  `expiry_date`, `metadata_updated_at/by`, `contractor_id`, `archived_at/by`,
  `root_document_id`, `version_no`, `is_current`) is in the `additions` list and
  is applied dialect-shared through `addColumn`.
- **Both unique version indexes** (`attachments_current_version_idx`,
  `attachments_root_version_idx`) are created by
  `ensureDocumentVersionInvariant()`, called at the end of the same pass.
- **`contractor_id` on `maintenance_requests`** is added unconditionally — it is
  deliberately *not* behind the Batch 1B flag, because `db/schema.ts` declares it
  and drizzle selects it on every job query.

**The one thing `ensureDatabase()` does not reproduce** is the `CHECK` on
`attachments.expiry_date` that rejects a shaped-but-impossible date such as
`2027-13-45`. It is second-line defence: the API already refuses those in
`expiryRefusal`, and correctness does not depend on the constraint. Add it after
bootstrap if you want the storage layer to agree — it is migration
`20260831234625` and it is safe to apply to an empty table.

### The seven Staging migrations, classified

These are recorded in Staging's `supabase_migrations.schema_migrations`. They are
**not** in this repository — they were applied ad hoc. Do not replay the list
blindly; three of them must not go anywhere near Production.

| Migration | What it is | Production |
| --- | --- | --- |
| `20260827060942 batch_1b_rollback_capture` | CTAS snapshots of **Staging rows** into `batch1b_rollback` | **Skip.** Rollback net for a Staging data change. |
| `20260827061150 batch_1b_site_id_nullable` | `ALTER … site_id DROP NOT NULL` | **Not needed.** A fresh DB is born nullable (§3). |
| `20260827064531 batch_1b_canonical_site_estate` | ~7.7 KB of `UPDATE`/`INSERT` on `portal.sites` — the client's canonical store estate | **DO NOT APPLY** — see §1b. Production already holds 10 real sites; on a populated register this collides rather than seeds. |
| `20260827064549 batch_1b_canonical_site_aliases` | Four aliases for the rows above | **DO NOT APPLY** — depends on the row above, which is now do-not-apply. |
| `20260831225955 w7_rollback_snapshot_attachments` | Snapshot of **Staging** attachments | **Skip.** |
| `20260831231456 w7_official_documents_metadata_versioning` | `ADD COLUMN` / `CREATE INDEX` for document lineage | **Not needed.** `ensureDatabase()` produces all of it (§3). |
| `20260831234625 w7_expiry_date_must_be_a_real_calendar_date` | Replaces the shape-only `CHECK` with one that casts to `date` | **Optional, recommended.** The only genuine gap; API enforces it regardless. |

So the honest summary: **one optional constraint, and one owner decision about
client reference data.** Nothing else transfers.

---

## 4. Production environment variables

Names taken from the source, not from memory. Set every one with target
**Production** only; Preview keeps its own and must not be touched.

| Name | Required? | Note |
| --- | --- | --- |
| `PG_D1` | **yes** — `1` | The explicit opt-in that swaps the SQLite file for the Supabase `portal` schema. Without it the app runs on a local file. |
| `DATABASE_URL` | **yes** | Session pooler, **port 5432**. `PG_D1_URL` overrides it if both are set; use one. |
| `PUBLIC_APP_ORIGIN` | **yes** | See §5. |
| `S3_ENDPOINT` | **yes** | Production project's storage endpoint. |
| `S3_BUCKET` | **yes** | `job-media`. |
| `S3_ACCESS_KEY_ID` | **yes** | Production key. |
| `S3_SECRET_ACCESS_KEY` | **yes** | Production key. |
| `S3_REGION` | optional | Defaults to `eu-west-2`. |
| `CRON_SECRET` | **yes, for the purge** | §6. |
| `MAINTSUPP_OWNER_PASSWORD` | conditional | §8 — seed-only semantics. |

**The `S3_*` set is all-or-nothing and fails silently.** `createS3BucketFromEnv()`
returns `null` unless `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` are *all* set, and the app then falls back to per-instance
`/tmp`. Uploads appear to succeed and vanish on the next cold start. If exactly
one of the four is missing there is no error anywhere — check all four.

Not required, and deliberately absent: `MONDAY_API_TOKEN` (import tooling only),
`BATCH_1B_APPLY` (see §3), and any Phase 2 `pg:*`/`api:*`/`web:*` variable.

---

## 5. `PUBLIC_APP_ORIGIN` while the domain stays parked

`maintsupp.com` and `www.maintsupp.com` are attached and verified on the
`maintsupp-portal` project, but **DNS still points at GoDaddy** — verified today:
both resolve to `3.33.130.190` and serve the parking page that redirects to
`/lander`, with no `x-vercel-*` headers. So a Production deployment will *not*
appear on the branded domain, which is the intended state.

Until DNS cutover, set `PUBLIC_APP_ORIGIN` to the project's own Production
hostname — `https://maintsupp-portal.vercel.app`, which is already attached to
this project and becomes live on the first Production deployment. It must not be
a Preview hostname, and it must not be `https://maintsupp.com` while the parking
page is what that name serves: generated links would point at GoDaddy.

**At cutover**, change it to `https://maintsupp.com` in the same place. That is
the only application-side change the domain move needs.

---

## 6. The 30-day recycle purge

Configured and verified; it needs a Production deployment to run, and nothing
else in the code has to change.

- Declared in `vercel/build-output.mjs` as `/api/cron/retention`, daily `20 3 * * *`.
- **Vercel runs crons on Production deployments only**, so it has never fired —
  the Portal has only ever shipped to Preview. The opportunistic sweep inside
  `/api/trash` is what has been doing the work.
- It **fails closed**: with `CRON_SECRET` unset the route answers 503 rather than
  exposing an unauthenticated endpoint that would empty every workspace's bin.
  So a Production deployment that forgets the variable gets a purge that does
  nothing, not a hole.

Verified deterministically rather than by deleting anything —
`tests/owner-fixes-retention-scheduler.test.mjs`, 10/10, covering: the 30-day
boundary at the exact comparison the sweep makes (29 survives, 30 is due), ISO
UTC timestamps throughout, a restored entry being unpurgeable because its bin row
is gone, organisation scope, bounded batches, constant-time secret comparison,
and the missing-secret refusal.

**To activate:** set `CRON_SECRET` (Production target) to a long random value and
deploy. Confirm afterwards in Vercel → project → Cron Jobs that the job is listed.

---

## 6b. Reading a pooler auth failure (this one message is a trap)

The first Production deployment (`e0c644d`, 2026-09-05) came up with every static
route at 200 and **`/login` and `/api/context` at 500**. The runtime log said:

```
[node-pg-d1] serving aws-0-eu-west-2.pooler.supabase.com:5432/postgres (search_path=portal, pg_catalog)
PostgresError: password authentication failed for user "postgres"   code: 28P01
```

**`user "postgres"` does not mean the username is wrong.** Supavisor strips the
`.<project-ref>` suffix when it reports 28P01, so a perfectly correct
`postgres.<ref>` login prints as `postgres`. Chasing the username here wastes an
hour. Probe the pooler directly instead — three wrong-password attempts tell the
three cases apart unambiguously:

| Username used | Error returned | Means |
| --- | --- | --- |
| `postgres` (bare) | `XX000 (ENOIDENTIFIER) no tenant identifier provided` | username really is missing the `.<ref>` suffix |
| `postgres.<wrong-ref>` | `XX000 (ENOTFOUND) tenant/user … not found` | the project ref is wrong |
| `postgres.<right-ref>` | **`28P01 password authentication failed for user "postgres"`** | ref and username are right — **the password is wrong** |

So 28P01 is the *good* failure: it proves host, port, database, ref and username
are all correct and isolates the fault to the password alone.

**The usual cause is URL encoding, not a typo.** The connection string is a URI,
so a password containing `@ : / ? # % &` must be percent-encoded or the parser
splits the string in the wrong place. The reliable fix is to reset the database
password to a long alphanumeric value (Settings → Database → Reset password) and
paste the dashboard's own **Session pooler** string, which then needs no
escaping. Changing the variable is not enough on its own — Vercel bakes
environment values in at build time, so **redeploy** afterwards.

---

## 7. Production smoke test, when you get there

```
/                      200
/login                 200
/dashboard/jobs        200
/dashboard/sites       200
/dashboard/contractors 200
/dashboard/reports     200
/dashboard/compliance  200
/dashboard/planned     200
/api/context           401 with {"error":"Your session has ended.…","signIn":true}
```

`/api/context` answering **401, not 404 and not 5xx**, is the check that matters:
it proves the deployment is the Portal and that its auth layer is alive. The
stray `maintsupp` project answers **404** there, which is how we know it is not a
Portal build.

Then confirm the deployment's `githubCommitSha` equals `origin/main`, and that
`/api/files` is reachable — an upload that survives a cold start is the only real
proof the `S3_*` set took (see the silent-fallback warning in §4).

---

## 8. Owner login on a fresh Production database

The Portal uses its own auth (PBKDF2 + hashed session tokens in the database),
not Supabase Auth, so restoring the project does not create a user.

`MAINTSUPP_OWNER_PASSWORD` has **seed-only** semantics: it seeds a NULL password
hash and does nothing to an account that already has one. It is not a way to
reset a forgotten password, and setting it will not recover access. On a fresh
Production database there is no owner row yet, so `ensureOwnerAccount()` — which
`POST /api/auth/login` calls on every attempt — will provision the owner from it
on the first sign-in attempt.

Two traps, both silent:

- **A value shorter than 12 characters is ignored**, not rejected — the seed
  falls through to "nothing" and you get the password-less row below.
- **In production with no secret set, the owner row is created with a NULL
  `password_hash`** and `checkPassword` refuses those outright. That is the
  correct failure — the alternative seeds a password anybody can read in the
  repository — but it presents as "the right password does not work".

So: set `MAINTSUPP_OWNER_PASSWORD` (12+ characters) **before** the first
Production login, sign in once, then change the password through the
application. Do not reuse the Staging preview credential, which is documented as
non-production and has been shared. Note also that once the hash exists this
variable stops doing anything — it seeds a NULL hash and never overwrites a
password the owner has set, so it is not a route back in after a lockout.

---

## 9. Backup and recovery

**Not verifiable from this session** — it needs the dashboard. Do not record a
capability here that nobody has looked at. What is known:

- A **paused** project is not taking backups. Whatever retention exists begins
  again after the restore in §2.1.
- Point-in-time recovery is a paid Supabase add-on. If the project is on a plan
  without it, the recovery position is daily snapshots at best.
- The application's own migration model is additive by construction — no
  `DROP TABLE`, no column rename, no destructive `ALTER` anywhere in
  `db/init.ts` — so the realistic recovery need is data loss, not schema damage.

**Recommended immediately after restore:** check Database → Backups, note the
retention actually offered, and if PITR is unavailable decide whether the client
data warrants the plan that provides it. Take one manual backup once the estate
is loaded and before the first real user writes.

---

## 10. Vercel project hygiene

The account currently holds **two** projects linked to `anwarrshboul-cpu/MAINTSUPP`:

- **`maintsupp-portal`** (`prj_rkWDVs9…`) — canonical. Production branch `main`,
  repo root, builds the Portal, owns `maintsupp.com`, `www.maintsupp.com` and
  `maintsupp-portal.vercel.app`. No Production deployment yet.
- **`maintsupp`** (`prj_qtkbtM1y…`) — **stray, and should not exist.** Created
  accidentally on 2026-09-04. It has **zero environment variables**, a stale
  Production deployment from `f32adc8`, and every build since has errored. It
  serves `maintsupp.vercel.app` publicly today, and `/api/context` there returns
  **404** — it is not even a Portal build.

**Recommended owner action: delete the `maintsupp` project**, or pause it if you
would rather keep the `maintsupp.vercel.app` name reserved. Deleting releases
that hostname, and a released `*.vercel.app` name can be claimed by anyone — the
same reasoning already written into `scripts/update-preview-alias.sh`. Pausing
avoids that and is reversible.

**The deployment guard is already correct and should stay.** `vercel.json` sets
`git.deploymentEnabled.main = false`, so pushing to `main` deploys nothing
anywhere. Production promotion is therefore always an explicit act, which is the
workflow asked for: feature → Preview/Staging → merge to `main` → deliberate
Production promotion.

---

## 11. What is deliberately still open

None of these blocks the bootstrap, and none should be worked on before it:

- W14 final sign-off; the performance pass.
- Dashboard meter drill-through; the Cancelled-status decision; cosmetic polish.
- SMTP / notifications. No credentials exist and none were invented; lead
  submissions honestly report `notified:false` / `confirmationSent:false`.
  **Post-bootstrap configuration, not a core blocker** — a lead is still stored
  and still visible in the Portal without it.
- The `maintsupp.com` DNS cutover, which stays parked on purpose so Production
  can be tested without publishing unfinished work on the branded domain.
