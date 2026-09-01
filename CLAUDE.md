# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                     # Node 22.13+
npm run dev                # Vite + vinext on :5173 (Miniflare D1 + R2 bindings)
npm run build              # scripts/build-verified.sh -> dist/ (bounded vinext build)
npm run lint               # eslint via scripts/sites-env.sh
npm test                   # NOTE: runs `npm run build` first, then all 137 test files
```

Running tests without the build (much faster, and what you usually want):

```bash
node --test tests/stage-eight-board-split.test.mjs          # one file
node --test tests/workstream-seven-*.test.mjs               # one family
node --test --test-name-pattern="the register counts" tests/*.test.mjs
```

Deploying the portal is a manual, deliberate act — see `docs/DEPLOYMENT-PORTAL.md`:

```bash
npm run build
node vercel/build-output.mjs                     # writes vercel/.deploy/.vercel/output
cd vercel/.deploy && npx vercel deploy --prebuilt # Preview only
bash scripts/update-preview-alias.sh <url>       # moves maintsupp-preview.vercel.app
```

Run `vercel deploy` from `vercel/.deploy`, never from the repo root — the root
`.vercel/project.json` is linked to the `apps/web` project and a root deploy 404s
every portal route.

## Three deploy targets — do not confuse them

| Target | Code | Deploys by |
| --- | --- | --- |
| **The portal** (the real product) | root `app/`, `worker/`, `db/` | Manual prebuilt upload only. **Not** wired to GitHub pushes. |
| Phase 2 rewrite (not the current product) | `apps/web`, `apps/api`, `packages/db` | The Vercel GitHub integrations. |
| Railway | the portal on a persistent Node box | `railway.json` + `scripts/railway-start.sh` |

**Green "Vercel" checks on a PR are building `apps/web`, not the portal.** They
prove nothing about the product. The `pg:*`, `api:*` and `web:*` npm scripts all
belong to Phase 2 and have no effect on the portal.

## Architecture

`docs/DEPLOYMENT-PORTAL.md` is the authoritative document; read it before any
infrastructure work. The essentials:

**One codebase, two databases, no branching in `app/**`.** The portal is written
against the Cloudflare D1 interface throughout. Locally that is Miniflare D1
(real SQLite in `.wrangler/`); deployed it is **Supabase Postgres, `portal`
schema**, reached through two shims that absorb every difference:

- `db/node-pg-d1.ts` — connection, parameters, and value coercion
- `db/sqlite-to-postgres.ts` — rewrites SQLite statements to Postgres, including
  `BOOLEAN_COLUMNS` (SQLite `0/1` -> Postgres booleans)

Because of that split, a query can pass locally and fail deployed. Anything
touching raw SQL, booleans, or `RETURNING` deserves a check against both.

Use the **session pooler (5432)**, never the transaction pooler (6543) — a
documented deadlock. Supabase allows 15 clients; the app runs 2 per instance.

**Migrations are automatic and additive.** `ensureDatabase()` in `db/init.ts`
replays `CREATE TABLE IF NOT EXISTS`, guarded `addColumn` and `INSERT OR IGNORE`
seeds on the first request of every instance. There is no `DROP TABLE`, no
column rename, no destructive `ALTER`. `db/init.ts` therefore runs on the boot
path of every request — invariant repairs belong there, and anything expensive
does not.

**Storage** is R2 locally and Supabase Storage over its S3 API deployed
(`db/r2-over-s3.ts`), selected by all four `S3_*` vars. With any one missing the
app **silently** falls back to per-instance `/tmp`: uploads appear to work and
then vanish. The bucket must stay private — all access is brokered through
`/api/files`, so a public bucket would turn object keys into bearer credentials.

**Auth and tenancy** are custom (PBKDF2 + hashed session tokens in the DB). The
browser never talks to Postgres; every query goes through `scopedDb()` /
`scopedDbWithCapability()` in `app/lib/tenant-db.ts`, which apply the org filter.
RLS is defence in depth, not the enforcement layer. Capabilities are strings like
`board.edit` (edit/archive) and `data.delete` (permanent purge — deliberately
withheld from `admin`).

**Uploads have a hard ~1 MiB ceiling on the direct path.** The Workers form
parser refuses above it with a bare-text 413 carrying no JSON `error`. Anything
over `DIRECT_UPLOAD_LIMIT` (900 KB) must go through the multipart route. Always
upload via `uploadEvidenceFile()` in `app/lib/client-upload.ts` — it owns the
ceiling, the multipart fallback and thumbnail generation. Hand-rolling a
`fetch("/api/files")` silently loses all three.

**Documents are lineages, not files**: `root_document_id` / `version_no` /
`is_current`, with a unique partial index on `coalesce(root_document_id, id)
WHERE is_current`. A new version is the *same document* and inherits its
predecessor's anchors, title, type, expiry and kind. `documentName()` in
`app/(app)/portal/views/document-register.ts` is the only function allowed to
decide what a document is called (`title` when set, filename otherwise); the
server's `Content-Disposition` follows the same rule.

## Test suite conventions

137 files, `node:test`, no framework. Three things make it unlike a typical suite:

**Tests pin source text.** There are ~3,100 `assert.match` calls against file
contents, so a rename or a move *breaks tests that were protecting a real
contract*. When a refactor invalidates a pin, **re-point it at the contract's new
home with the reason written in — never delete or weaken it.**

**Enforced size ceilings** (`tests/stage-eight-board-split.test.mjs`): `live-board.tsx`
< 6000, `board-model.ts` 600, `board-cells.tsx` 1300, `board-chrome.tsx` 500,
`board-format.ts` 400, `board-compact.ts` 300, `board-subitems.tsx` 300,
`board-primitives.tsx` 200, `board-ordering.ts` 200. When one is hit, split the
file as the failure message says; do not trim comments to squeeze under.

**CSS media queries are restricted to 640 / 767 / 768 / 1024 / 1280.** Several
stage tests fail on any other width.

~32 files make live HTTP calls and **skip** (not fail) when no dev server
answers, defaulting to `localhost:5173` or `localhost:3000`. Consequences worth
internalising:

- Run the suite against a **quiet** tree. Concurrent work starves the dev server;
  it will 500 SSR routes under load (`"Network connection lost"` from
  `@vitejs/plugin-rsc`) while `/api/*` still answers 200, and it can die outright.
  A failure that took 18-70 seconds is almost always starvation, not an assertion.
- Compare runs **by test name, never by count** — the count moves with `.wrangler`
  state and with which live tests skipped.
- Before believing a regression, re-run the file alone.

Live tests share one Miniflare D1. Mark fixtures in a document's `title` as well
as its filename, and sweep by listing over `archived=all` rather than by remembered
ids — a filename-substring sweep has repeatedly eaten other fixtures.

## Known local-environment issue

The local D1 attachment estate is depleted (**5 rows**; everything else intact).
Five data-volume tests fail deterministically as a result — two in
`tests/stage-twentythree-viewer.test.mjs`, three in
`tests/stage-twentytwo-fix-tracker.test.mjs`. Four of the five already failed at
the last verified reference.

**No seeder can fix this.** `db/init.ts` seeds board structure and inserts zero
attachments; `pg:seed`/`pg:reset` target Phase 2's Postgres. The real estate came
from a one-time Monday import whose 3.4 GB payload is gitignored and absent.
Restore only from an exact backup of the sqlite file or a separately authorised
Monday import. Treat these five as a known environment limitation, not a
regression, and do not weaken them to get green.

## Editing notes

Line endings are **per file** and there is no `.gitattributes` — `app/api/files/route.ts`
is CRLF while `portal-app.tsx` and `globals.css` are LF. Normalise before matching
and restore the file's own ending when writing, or diffs become unreadable.

Never commit `.mcp.json` (it carries a project ref), `.env*`, `.wrangler/`, or
anything under `db/monday-export/` — that directory holds the client's live data
and this repository is public.
