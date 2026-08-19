# Deploying the MAINTSUPP portal — Vercel + Supabase

This documents the **portal** — the vinext app in the repository root
(`app/`, `worker/`, `db/`): the board, form builder, public form and ticket
links, and everything the recent work shipped. It is NOT the `apps/web`
Next.js app; see "The three deploy targets" below before touching any Vercel
project.

Written 2026-08-19, from a full audit of the tree at that date. No secrets in
this file — names and shapes only.

## The three deploy targets in this repository

| Target | What it is | How it deploys |
| --- | --- | --- |
| **The portal** (root `app/` + `worker/` + `db/`) | The real product: board, forms, tickets | **Manual prebuilt upload** via the Vercel Build Output API — see below. NOT wired to GitHub pushes. |
| `apps/web` (+ `apps/api`, `packages/db`) | A parallel "Phase 2" rewrite (Next 16 + Hono/Railway), not the current product | The two existing Vercel GitHub integrations ("maintsupp", "website") build THIS — root `vercel.json` and `apps/web/vercel.json`. Green PR checks prove `apps/web` builds, nothing about the portal. Its own doc is `DEPLOY.md`. |
| Railway | The portal on a persistent Node box (SQLite + volume) | `railway.json` + `scripts/railway-start.sh`. |

**The green "Vercel" checks on PRs are not portal deployments.** Deploying the
portal is a deliberate, separate act.

## Architecture on Vercel + Supabase

- **Runtime**: one Node function (`nodejs24.x`, `maxDuration 60`, region
  `lhr1`) built by `vercel/build-output.mjs`, which wraps the same worker
  bundle Cloudflare would run (`vercel/function/index.mjs` re-implements
  vinext's server loop and calls the bundle's `fetch`). All security headers
  (`X-Frame-Options: DENY` etc.) live in `worker/index.ts` and therefore apply
  on Vercel too. Static assets go to the CDN with immutable caching + nosniff.
- **Database**: Supabase **Postgres through the SESSION pooler (port 5432)**.
  The app keeps speaking SQLite-shaped SQL; `db/node-pg-d1.ts` +
  `db/sqlite-to-postgres.ts` translate on the wire into the **`portal`
  schema** (search_path is pinned, so the Phase 2 `public` schema is
  untouchable). Never use the transaction pooler (6543): a measured deadlock,
  documented in the adapter. The pool is 2 connections per instance on Vercel
  against Supabase's 15-client session ceiling.
- **Migrations**: automatic and additive at boot. `ensureDatabase()` replays
  `CREATE TABLE IF NOT EXISTS` + guarded `addColumn` + `INSERT OR IGNORE`
  seeds on first request per instance; there is no DROP TABLE, no column
  rename, no destructive ALTER anywhere. The one backfill worth eyeballing
  after first boot adopts `organisation_id IS NULL` rows into the primary
  organisation. **Take a Supabase snapshot (or use a branch database) before
  the first boot against production**, then it is a no-op replay.
- **Storage**: Supabase Storage through its **S3-compatible API**
  (`db/r2-over-s3.ts`). Selected by setting all four `S3_*` variables; with
  any missing the app silently falls back to per-instance `/tmp` — uploads
  appear to work and then vanish. **The bucket must be PRIVATE**: the app
  brokers all access through `/api/files` with its own authorization; a public
  bucket turns object keys into bearer credentials.
- **Auth**: fully custom (PBKDF2 210k + hashed session tokens in the DB — no
  Supabase Auth, no GoTrue, no redirect URLs to configure). Sign-in
  throttling is DB-backed, so it works across serverless instances. Cookies
  are `Secure` behind Vercel's proxy automatically.
- **Tenancy/RLS**: the browser never talks to Postgres — every query is
  server-side through `scopedDb()` org filters. RLS is therefore optional
  defence-in-depth, not the enforcement layer. Optional hardening: a dedicated
  Postgres role limited to the `portal` schema.

## Environment variables

Set in the **portal's** Vercel project (not the apps/web projects). Preview
should point at a **staging/branch** database and bucket, never production.

| Variable | Side | Required | Vercel env | Purpose / source |
| --- | --- | --- | --- | --- |
| `PG_D1=1` | server | REQUIRED | Prod + Preview | Selects Postgres over the SQLite shim |
| `DATABASE_URL` | server | REQUIRED | Prod + Preview (staging DB) | Supabase **session pooler :5432**, `postgres.<ref>@aws-0-<region>.pooler.supabase.com` |
| `S3_ENDPOINT` | server | REQUIRED | Prod + Preview | `https://<ref>.supabase.co/storage/v1/s3` |
| `S3_BUCKET` | server | REQUIRED | Prod + Preview | Private bucket name |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | server | REQUIRED | Prod + Preview | Supabase Storage → S3 access keys |
| `S3_REGION` | server | optional | Prod | Defaults `eu-west-2` |
| `MAINTSUPP_OWNER_PASSWORD` | server | REQUIRED in Prod | Prod | Owner seed (≥12 chars). Missing ⇒ owner sign-in fails closed (by design) |
| `PG_D1_POOL` etc. | server | optional | — | Pool/diagnostics knobs, see `db/node-pg-d1.ts` |

Never configure: any `NEXT_PUBLIC_*` secret, a Supabase `service_role` key
(the portal does not use one anywhere), or real secrets in Preview that
Preview does not need. Local placeholders live in `.dev.vars.example`.

## Build and deploy sequence (when deployment is approved)

Build environment: bash + Node 24 (`.nvmrc`), Linux/WSL/git-bash.

1. **Supabase**: create/select the project; confirm the `portal` schema is the
   migrated one; snapshot or branch the database; create a **private** Storage
   bucket; generate S3 access keys (Storage → S3); note the session-pooler
   URL (:5432).
2. **Vercel**: create/confirm the dedicated portal project (do NOT reuse the
   two apps/web projects); enter the variables above.
3. **Build the artifact** (the flag is load-bearing — without it the bundle is
   workerd-only and dead on Vercel; the packager refuses it):
   ```bash
   D1_NODE_SHIM=1 npx vinext build
   node vercel/build-output.mjs
   ```
4. **Preview deploy**: `cd vercel/.deploy && vercel deploy --prebuilt`
   (run from inside `.deploy` so the repo-root project link cannot be picked
   up). Smoke-test the preview URL.
5. **Migrate storage** if moving existing local/R2 files:
   `scripts/migrate-r2-to-s3.mjs`.
6. **Production deploy**: `vercel deploy --prebuilt --prod` from the same
   directory, after the preview passes.

## Post-deploy smoke test

1. Anonymous `GET /api/board` → **401/refusal** (proves `NODE_ENV=production`
   took and the demo identity is off).
2. Owner sign-in works; the cookie is `Secure`; a wrong password is throttled.
3. Board loads; photo cells draw thumbnails; hover cards fetch.
4. Upload a photo → appears without reload → **survives a redeploy** (proves
   S3 storage, not `/tmp`).
5. Share form link opens logged-out on a phone; a submission creates a job.
6. Fix Tracker Copy Link → the `/j/<token>` page opens logged-out, read-only.
7. `X-Frame-Options: DENY` present on an HTML response.
8. Check Supabase: connection count stays low (2/instance); no errors in the
   Postgres logs; the boot backfills only touched NULL rows.

## Rollback

Vercel: promote the previous deployment (instant; the artifact is immutable).
Database: boot migrations are additive, so old code runs against the new
schema; for the first-ever boot, restore the pre-boot snapshot if something
looks wrong. Storage: objects are immutable by id; nothing to roll back.

## Known deferrals (safe, documented)

- Option-label cache is per-instance with a 30s TTL — an admin's rename can
  take up to 30s to appear on another warm instance.
- Cold starts replay the boot bootstrap (~5s from lhr1 against eu-west-2).
- HSTS: supplied by Vercel on `*.vercel.app`; add a header when a custom
  domain arrives.
- Vercel's edge caps request bodies at 4.5 MB — attachments above that cannot
  upload through the function until a presigned-upload route exists
  (`app/lib/client-upload.ts` documents the arithmetic).
- `.postgres-migration/` is an abandoned earlier approach — see its README.
