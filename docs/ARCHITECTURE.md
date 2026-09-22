# MAINTSUPP portal — architecture map

A map of the systems the portal is built from, and where each one's rules live.
For *how it is deployed* read `DEPLOYMENT-PORTAL.md`; for *which branch a change
belongs on* read `DEPLOYMENT-WORKFLOW.md`. Each section here names the file that is
the single source of truth — change the rule there, not a copy of it.

## Runtime and data

- **One codebase, two databases.** Code is written against the Cloudflare D1
  interface. Locally that is Miniflare D1; deployed it is Supabase Postgres (`portal`
  schema) through `db/node-pg-d1.ts` (connection, parameters, value coercion) and
  `db/sqlite-to-postgres.ts` (statement rewriting, `BOOLEAN_COLUMNS`). A query can
  pass locally and fail deployed — check raw SQL, booleans and `RETURNING` on both.
- **Migrations** are additive stages in `db/init.ts` (`CREATE TABLE IF NOT EXISTS`,
  guarded columns, `INSERT OR IGNORE`), skipped while the stored fingerprint matches
  `db/schema-fingerprint.ts`. Adding a stage changes the fingerprint;
  `tests/schema-fingerprint.test.mjs` prints the new value. Repairs that must run on
  every boot belong in `repairInvariants`, not in a migration stage.
- **Storage** is R2 locally and a PRIVATE Supabase Storage bucket over its S3 API
  deployed (`db/r2-over-s3.ts`), selected by all four `S3_*` variables.
- **Money** is integer minor units; the conversion boundary is
  `app/lib/reporting/money.ts`.

## Identity, tenancy and permissions

- Sessions and sign-in are custom (PBKDF2, hashed session tokens). Every request
  resolves who and which workspace in `app/lib/tenant-access.ts`; every query goes
  through `scopedDb()` in `app/lib/tenant-db.ts`, which applies the organisation.
- Capabilities (strings such as `board.edit`, `settings.edit`, `data.delete`,
  `integrations.manage`) and the role ceilings are in `app/lib/permissions.ts`.
  Platform Super Admin (`platform_admins`) is a separate, cross-workspace grant used
  by `/admin` and the website CMS.

## Configuration without code

| System | Rules | API | Notes |
| --- | --- | --- | --- |
| Theme tokens (brand colours, fonts, chart colours) | `app/lib/theme-tokens.ts` | `/api/theme` | Per workspace. |
| Portal modules (switch sections on/off) | `app/lib/portal-modules.ts` | `/api/portal-modules` | |
| Sidebar layout (order, icons, locks) | — | `/api/navigation` | Workspace default + personal layers. |
| Dashboard layouts | — | `/api/dashboard-layout` | Workspace default (removable) + personal. |
| Version history for all of the above | `app/lib/config-versions*.ts` | `/api/versions` | Append-only; a restore is a new version. |
| Unsaved-change warnings | `app/lib/use-unsaved-changes.ts` | — | Every editor above uses it. |

## Website CMS (`/p/<slug>` pages)

`app/lib/cms-blocks.ts` defines the block catalogue and its validation;
`app/lib/cms-repository.ts` reads and writes pages; `/api/site-pages` is the only
write door (platform staff only). A slug edit MOVES a page; creating over an
existing slug is refused; every save, move, delete and restore is a version in
`config_versions` (installation-wide rows). The six built-in marketing pages are code.
`CMS_OMISSIONS` in `cms-blocks.ts` lists what the editor does not do, and the editor
prints it.

## Uploads and documents

- `app/lib/client-upload.ts` owns every upload from the browser: files up to 900 KB
  go in one request to `/api/files`; larger files go browser → private bucket, part
  by part, on short-lived upload-only URLs signed per part
  (`presignPart` in `db/r2-over-s3.ts`), bound to an `upload_sessions` row
  (`app/lib/upload-sessions.ts`). `complete` checks the parts the bucket holds, the
  MD5 of each against what the browser sent, the assembled size and the file's first
  bytes (`app/lib/file-signature.ts`) before a document row exists.
- Every READ goes through `GET /api/files/[id]` and its authorisation; no storage URL
  that can read reaches a browser.
- Documents are lineages (`root_document_id`, `version_no`, `is_current`);
  `documentName()` decides what a document is called.

## Work, schedules and reporting

- Job status history is written by `recordJobStatusChanges`
  (`app/lib/job-status-history.ts`), which also emits outbound webhook events.
- Planned maintenance generates jobs in `app/lib/planned-generation.ts`; scheduled
  reports are delivered by `app/lib/report-delivery.ts`. Both run from the one daily
  cron, `app/api/cron/daily/route.ts`, which also retries webhooks and expires
  abandoned upload sessions.
- Global search is `/api/search`, scoped to the current workspace.

## Notifications and integrations

- `app/lib/notifications.ts` is the single send path. `EMAIL_MODE` decides
  `live` / `sink` / `log` (default `sink`); per-person preferences and the storm
  limit are in `app/lib/notification-preferences.ts`. A send that did not reach its
  recipient is never recorded as sent.
- Automations (`app/lib/automations/`) can notify Slack and signed webhooks.
- Integrations (`app/lib/integrations/`): signed outbound webhooks, scoped API
  tokens (`/api/v1`, `api-tokens.ts`), and secrets sealed with AES-256-GCM
  (`app/lib/secret-box.ts`) under `MAINTSUPP_SECRETS_KEY` — absent key means
  "not configured", never a plaintext fallback.

## Public intake

The website's forms (`/api/report-job`, `/api/leads`, `/api/contractor-applications`,
`/f/<token>`) are throttled per address (`app/lib/form-throttle.ts`). Leads and
contractor applications are filed under the platform's own intake workspace
(`db/website-leads-workspace.ts`), never under a client's.

## The platform console (`/admin`)

`app/lib/platform-sections.ts` lists its screens; each exists only because it has an
API behind it, and each is guarded twice (`requirePageSession`, then
`requirePlatformAdmin`). The Backups screen is visibility only: it states what the
portal can see and that backup status belongs to the database host.

## Tests

Every `tests/*.test.mjs` runs on `node:test`. Many pin source text; when a refactor
moves a contract, the pin is re-pointed with the reason written in, never weakened.
See `CLAUDE.md` for the size ceilings, the live-test conventions and the zero-error
tsc/lint gates.
