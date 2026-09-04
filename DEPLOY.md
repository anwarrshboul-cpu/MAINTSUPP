# MAINTSUPP — deploying the three tiers

```
Vercel  apps/web    Next.js. Holds no database credentials.
Railway apps/api    Node + Hono. Holds DATABASE_URL. Enforces all access.
Supabase            Postgres only — no GoTrue, no RLS-as-enforcement.
```

Local development needs none of them: `npm run api:dev` runs the API against
**PGlite**, real PostgreSQL 18 in-process. No Docker, no daemon, and the same
SQL that runs in production.

---

## 1. Supabase — the database

Only Postgres is used. Auth, Storage and PostgREST are not.

Take **two** connection strings from Project Settings → Database:

| | Port | Used for |
|---|---|---|
| Pooler, **session mode** | 5432 | the API — `DATABASE_URL` — **and** migrations |
| Pooler, transaction mode | 6543 | **do not use** — see below |
| Direct `db.<ref>.supabase.co` | 5432 | IPv6-only; unusable from an IPv4-only network |

**Transaction mode (6543) deadlocks this application.** Measured against the real
project with 791 jobs: five concurrent analytics requests left two of them
hanging indefinitely, and `pg_stat_activity` showed every connection `idle` on
`ClientRead` — Postgres waiting for the client while the client waited for
Postgres. Nothing was slow; it stopped. The identical code on the session pooler
answers all five in under 0.7s and `/analytics/overview` in 0.16s. Use 5432.

**The direct host is IPv6-only.** `db.<ref>.supabase.co` publishes an AAAA
record and no A record, so it is unreachable from an IPv4-only network and fails
as `ENOTFOUND` — which reads like a typo in the hostname. The pooler publishes
A records; use it for migrations too.

**TLS is required and is not the default.** `postgres.js` ships with SSL off, and
Supabase refuses an unencrypted connection by reporting
`28P01 password authentication failed` — sending you hunting for a wrong
password that is in fact correct. `packages/db/src/client.ts` now sets
`ssl: "require"` for every non-local URL.

The distinction is not cosmetic. The direct connection has a low connection
ceiling that a request-per-connection app exhausts quickly; the pooler hands
each statement to whichever backend is free, which is why
`packages/db/src/client.ts` sets `prepare: false` and `max: 1` when it sees
`:6543`. Getting that wrong produces `prepared statement already exists`
intermittently, under load, and never in testing.

Run the migrations against the **direct** URL:

```bash
DATABASE_URL="postgresql://…@…:5432/postgres" node packages/db/src/migrate.ts
```

Migrations are checksum-locked: editing one that has already been applied is
refused rather than silently diverging from production. Add a new file instead.

> The project currently holds an **earlier, incompatible schema** built for the
> Supabase-native design (16 tables, 63 RLS policies, FKs into `auth.users`).
> It is not what this code expects. Decide deliberately whether to drop it or
> point at a fresh project — do not run these migrations on top of it and hope.

## 2. Railway — the API

Root directory `/`, so the build sees `packages/db`.

```
Start   node --experimental-strip-types apps/api/src/server.ts
Health  /health
```

Environment (see `apps/api/.env.example`):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | the **session** pooler URL, port **5432** — 6543 deadlocks it, see §1 |
| `WEB_URL` | the Vercel origin — every emailed link is built from it |
| `CORS_ORIGINS` | comma-separated exact origins. Never `*` |
| `RESEND_API_KEY` | **without it, no email is sent** — see below |
| `MAIL_FROM`, `ADMIN_EMAIL` | sender and where intake notifications land |
| `HIDE_MONEY_ON_SHARE` | `false` by default: shared links show the full ticket |
| `API_URL` | this service's own origin — signed file links are built from it |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | all five or none — see below |
| `UPLOAD_SIGNING_SECRET` | 32+ random bytes. Signs the API's own file URLs |
| `NODE_ENV=production` | switches session cookies to `Secure` |

`MIGRATE_ON_BOOT` defaults to on, so a deploy applies pending migrations. Set it
to `false` if you would rather run them yourself.

**File storage is a go-live blocker too.** With the `S3_*` variables unset the
API writes uploads to a directory inside the container — which works, and which
Railway deletes on every deploy. Point them at Supabase Storage's S3-compatible
endpoint (`https://<ref>.supabase.co/storage/v1/s3`) and **make the bucket
private**. The product hands out five-minute signed URLs precisely so that a
leaked database row is not a leaked photograph; a public bucket throws that
away, because `object_key` is then all anybody needs.

`UPLOAD_SIGNING_SECRET` must be set and must be the same on every instance.
Unset, it is regenerated per process: file links break on restart and two
Railway replicas cannot verify each other's.

**Email is a go-live blocker.** With no `RESEND_API_KEY` the API prints messages
to the log instead of sending them — deliberate, so local development works, and
deliberately loud. In production it means verification links, invitations and
password resets never arrive. Add the key and the SPF/DKIM records before
inviting anyone.

## 3. Vercel — the web app

Root directory `apps/web`. Framework preset Next.js.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | the Railway origin. Public by definition |

Then set `CORS_ORIGINS` on Railway to the Vercel origin. The session cookie is
issued by the API on a different origin, so both halves must agree or every
authenticated request 401s — which looks exactly like a broken login.

### Cookies across two origins

Cookies are `HttpOnly; SameSite=Lax; Secure`. `SameSite=Lax` works because the
browser treats a `*.vercel.app` page calling `maintsupp-api.up.railway.app` as
cross-**site**, so **`SameSite=Lax` will not send the cookie on those calls**
unless both are served from one registrable domain.

**Put both behind one domain before launch**: `maintsupp.com` for the web app
and `api.maintsupp.com` for the API. Then set `COOKIE_DOMAIN=.maintsupp.com`.
Until that is done, the portal works on `localhost` (same site) and the public
share page works anywhere (no cookie involved), but signing in from the Vercel
origin to the Railway origin will not hold a session. The alternative —
`SameSite=None` — sends the cookie on every cross-site request including ones
started by other websites, and is not worth it when a subdomain is free.

---

## Verifying a deployment

```bash
curl https://<api>/health     # {"ok":true}                  no database touched
curl https://<api>/ready      # {"ok":true,"backend":"postgres"}
```

`/ready` failing while `/health` passes means the API is up but cannot reach
Postgres — almost always a wrong `DATABASE_URL` or an IP restriction.

Locally, the whole suite:

```bash
npm run pg:migrate    # apply migrations to .pglite
npm run pg:verify     # 12 schema behaviours, against a real database
npm run api:test      # 75 tests: tenancy isolation, auth, full lifecycle
```
