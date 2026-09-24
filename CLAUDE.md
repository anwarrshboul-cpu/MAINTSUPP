# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                     # Node 22.13+
npm run dev                # Vite + vinext on :5173 (Miniflare D1 + R2 bindings)
npm run build              # scripts/build-verified.sh -> dist/ (bounded vinext build)
npm run lint               # eslint via scripts/sites-env.sh
npm test                   # NOTE: runs `npm run build` first, then every tests/*.test.mjs
```

Running tests without the build (much faster, and what you usually want):

```bash
node --test tests/stage-eight-board-split.test.mjs          # one file
node --test tests/workstream-seven-*.test.mjs               # one family
node --test --test-name-pattern="the register counts" tests/*.test.mjs
```

Deploying is now a branch push, not a command — see `docs/DEPLOYMENT-WORKFLOW.md`.
The manual prebuilt upload below is the **emergency path**, and the way to put a
specific build behind the client link without waiting for a release:

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
| **The portal** (the real product) | root `app/`, `worker/`, `db/` | Vercel's GitHub integration. `develop` → Preview, `main` → **Production**, both automatic. Prebuilt upload is the emergency path. |
| Phase 2 rewrite (not the current product) | `apps/web`, `apps/api`, `packages/db` | **Nothing.** Its two Vercel GitHub integrations were deleted 2026-09-04. |
| Railway | the portal on a persistent Node box | `railway.json` + `scripts/railway-start.sh` |

**A push now deploys.** This section used to say the opposite — that the portal
was not wired to GitHub pushes and that a PR check proved nothing about the
product. That was true of the two *Phase 2* integrations deleted on 2026-09-04,
and it stopped being true of the portal on 2026-09-06, when `6844e50` set
`git.deploymentEnabled.main = true` in the root `vercel.json`. Measured again on
2026-09-08: three pushes to `develop` produced source-built Preview deployments
3, 4 and 13 seconds later.

So, concretely:

- **pushing `develop` builds a Preview automatically.** It does NOT move
  `maintsupp-preview.vercel.app` — only `scripts/update-preview-alias.sh` does
  that — so a git-built Preview sits on its own hash URL until the script runs;
- **merging to `main` deploys the public site**, with no confirmation step. Treat
  any merge or push to `main` as a production release and get explicit approval
  first. `main` refuses a direct push, so the release is a PR.

`docs/DEPLOYMENT-WORKFLOW.md` is the authority on which branch a change belongs
on; `docs/DEPLOYMENT-PORTAL.md` remains the authority on how the portal is
*built*. The `pg:*`, `api:*` and `web:*` npm scripts still belong to Phase 2 and
have no effect on the portal.

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

**Production uses Supavisor TRANSACTION mode, port 6543** — the shared pooler,
`aws-0-<region>.pooler.supabase.com:6543` — and has since 2026-09-09. That is the
mode Supabase documents for serverless functions, and it is right for this
deployment: every Vercel instance opens its own pool (2 connections), and the
transaction pooler multiplexes up to 200 such clients onto the server-side pool,
where SESSION mode (5432) pins one backend per client and refused this app at 15
(`EMAXCONNSESSION … pool_size: 15`, 181 times in 20 days before the switch). The
adapter turns prepared statements off automatically on 6543, and `batch()` keeps
each transaction on one reserved connection, which is what transaction pooling
requires.

This file used to say "never 6543 — a documented deadlock". That deadlock was
measured on 2026-08-14 against the **Phase 2 API** (`packages/db`, a different
client and workload) and was only ever cited, never reproduced, for the portal;
the portal has run on 6543 in Production since, full migration replays included,
with no Postgres deadlock logged. **Do not switch Production back to 5432 because
of the old warning.** Any future change of connection mode needs fresh evidence
and the owner's approval. The investigation is in the master handoff (2026-09-23).

**Migrations are automatic and additive.** `ensureDatabase()` in `db/init.ts`
applies `CREATE TABLE IF NOT EXISTS`, guarded `addColumn` and `INSERT OR IGNORE`
seeds. There is no `DROP TABLE`, no column rename, no destructive `ALTER`.

**They no longer replay on every cold start.** They used to, and it cost **47
seconds** on the first request of every instance against 0.98s for every request
after it — 349 prepared statements, spread across 30 stages with no single one
dominating. `db/schema-fingerprint.ts` now stores a fingerprint of the migration
sources once a full run finishes, and the replay is skipped while it matches.
Measured after: **3.0s** cold, and a fresh database still migrates from nothing
and answers 200.

Three things follow, and the first is the one that bites:

- **Adding a migration means the fingerprint changes.** You do not maintain it —
  `tests/schema-fingerprint.test.mjs` recomputes it and fails with the value to
  **append** as a new last entry of `SCHEMA_GENERATIONS` in
  `db/schema-fingerprint.ts`. A red run there is not a flaky test; it is that
  test doing the only job it has. Never relax it: it is what stands between a
  changed migration and a database that believes it is already up to date.
- **Never edit or remove an entry of `SCHEMA_GENERATIONS`.** A build's position
  in that list is its schema generation, and the boot path uses the order: a
  build that finds a HIGHER generation recorded is older than the database and
  touches nothing — no replay, no repairs, no write (`bootSchema` in
  `db/init.ts`). Every superseded Production deployment shares the Production
  database, and before this guard (2026-09-23) one woken at its own URL replayed
  its older migrations over the newer schema. Builds from before generations
  existed only ever write the legacy `migrations` row, which nothing reads now.
- **A repair is not a migration.** Anything that reads live rows and fixes drift
  ordinary use can reintroduce belongs in `repairInvariants`, which runs on every
  boot regardless of the fingerprint. Anything that only ever has work to do once
  belongs in `applyMigrations`. Putting a repair in the wrong half makes it stop
  running the day the fingerprint settles.
- **Do not rely on the boot path to finish a row a write path left incomplete.**
  One already did: the workspace drawer created sites without their Stage-2
  columns and four boot-path `UPDATE … WHERE … IS NULL` statements tidied up
  afterwards. That is no longer a backstop.

`db/init.ts` still runs on the boot path of every request, so anything expensive
added to `repairInvariants` is paid on every cold start for ever.

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

**Both static gates are zero-error on `main`** (since #77 and #80, 2026-09-22):
`npx tsc --noEmit` reports 0 errors and `npm run lint` exits 0 (59 warnings). A new
error in either is a regression, not baseline noise; do not let the warning count grow.

Every `tests/*.test.mjs`, `node:test`, no framework — a couple of hundred files,
and the count moves with almost every batch, so measure it (`ls tests/*.test.mjs |
wc -l`) rather than trusting a number written here. Three things make the suite
unlike a typical one:

**Tests pin source text.** There are ~3,100 `assert.match` calls against file
contents, so a rename or a move *breaks tests that were protecting a real
contract*. When a refactor invalidates a pin, **re-point it at the contract's new
home with the reason written in — never delete or weaken it.**

**Enforced size ceilings** (`tests/stage-eight-board-split.test.mjs`): `live-board.tsx`
< 6000, `board-model.ts` 600, `board-cells.tsx` 1300, `board-chrome.tsx` 500,
`board-format.ts` 400, `board-compact.ts` 300, `board-subitems.tsx` 300,
`board-primitives.tsx` 200, `board-ordering.ts` 200. When one is hit, split the
file as the failure message says; do not trim comments to squeeze under.

`live-board.tsx` has a SECOND, tighter ceiling in a different file —
`tests/workstream-seven-official-document-ui.test.mjs` asserts `< 5600`, "the
extraction must leave real room" — and that is the one a change actually hits
first. Measure both before planning anything that adds to it.

**CSS media queries are restricted to 640 / 767 / 768 / 1024 / 1280.** Several
stage tests fail on any other width.

~32 files make live HTTP calls and **skip** (not fail) when no dev server
answers, defaulting to `localhost:5173` or `localhost:3000` — and some probe
`3000` and `5173`–`5177` in turn, so they will find ANY dev server on those ports,
including one running another branch in a parallel worktree. For a run with no
live tests while other servers are up, point `MAINTSUPP_BASE_URL` at a dead port
(e.g. `http://localhost:5999`); for a live run, point it at your own server. Consequences worth
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

**The local D1 is a development database, not the client estate.** It is full of
test-fixture tenants (RBAC and browser-QA organisations, demo workspace) and holds
only a small, deliberate slice of Monday data. Measured on 2026-09-24 against
`6898920`, after the recovery below:

| | local D1 | what the estate tests expect |
| --- | --- | --- |
| attachments | **293** | more than 2,000 (the old pin: 2,968) |
| jobs (`maintenance_requests`) | **339** | exactly 776 |
| Monday comments (`item_updates` `monday-%`) | **45** | at least 269 |
| sites | **232** | exactly 10 |

**The lightweight recovery (2026-09-24, LOCAL ONLY).** With the owner's approval
the active local D1 was rebuilt on a disposable copy, then promoted with its
local R2 storage (the database and the objects move together, or attachment rows
point at nothing):
- the stale "W2 Scope Shared Name …" live-test fixtures that broke the register
  invariants were removed: 9 aliases that were another site's name, and one
  duplicate-name site with its group membership;
- 16 Monday Maintenance jobs were recovered, exactly the parents of every comment
  that carries a file, with their 35 comments and 10 replies;
- the 58 comment files and their 54 image thumbnails were recovered into local R2.

It went through the app's own import and upload paths on a local dev server.
Production, Staging, Supabase and Vercel were not involved, and Monday was only
read. Byte backups of the previous local state are kept outside the repository.
Before this, the section described 10 failures in 4 files against the unrecovered
database (235 attachments, 323 jobs, 0 Monday comments, 233 sites).

**4 tests in 3 files fail deterministically** when the suite runs with no dev
server (measured one file at a time, `MAINTSUPP_BASE_URL` at a dead port); with
the database absent they skip or pass instead:

| file | pass | fail | skip |
| --- | --- | --- | --- |
| `stage-twentytwo-fix-tracker` | 14 | 2 | 0 |
| `stage-twentythree-viewer` | 16 | 1 | 0 |
| `stage-twentyfour-comment-assets` | 7 | 1 | 2 |
| `workstream-five-sites` | 18 | 0 | 2 |

`workstream-five-sites` is green. The four failures, and why each one stays:
- **stage-22 "the tabs carry counts":** a stale expectation against current
  application and seed behaviour. The boot path re-seeds the demo jobs
  `demo-job-ac1`/`ac2` as `Booked` outside the "Jobs Booked" group
  (`db/demo-workspace.ts`), and so is the local job `MN-1110`. The product itself
  also gives a job moved to Booked the status "Job Scheduled"
  (`app/lib/stage-status.ts`), which the test's status check rejects.
- **stage-22 "[object Object]":** depends on junk rows the historical importer
  produced, which no longer exist anywhere.
- **stage-23 "files that are not pictures":** depends on the full historical
  attachment estate (~3,116 files, ~3.75 GB on Monday), which was deliberately not
  downloaded.
- **stage-24 "nothing was removed":** pins historical exact counts (776 jobs,
  2,968 attachments, 10 sites, 84 groups) that can no longer be reconstructed;
  Monday itself has moved on (781 items).

These are known historical and local-estate limitations, not failures of the
original dashboard master prompt. Treat the four as the baseline, so anything else
failing in these files is a regression, and do not weaken them to get green.

Three more tests also need estate data but need a live dev server as well:
`stage-twentyfour-update-thread` ×1 and `stage-twentytwo-share-link` ×2 (not
re-measured after the recovery).

**No seeder can restore the full estate.** `db/init.ts` seeds board structure and
inserts zero attachments; `pg:seed`/`pg:reset` target Phase 2's Postgres. The
real estate came from a one-time Monday import whose payload is gitignored and
absent. A full rebuild needs a separately authorised Monday import.
`db/monday-export/build-maintenance-csv.mjs` could not write its output on Windows
until 2026-09-24: it took its directory from a URL's path, which kept a separator
before the drive (`C:\C:\…`) and the `%20` of a space. It now uses
`fileURLToPath`, pinned by `tests/monday-export-output-path.test.mjs`.

**These tests can pass without checking anything.** The stage-22 and stage-23 data
tests `return` early, and so report "ok", when the database cannot be opened. That
happens in a fresh worktree, or on Windows when the path passes 260 characters,
which a copy under a deep temp directory does. Confirm the file actually opens
before trusting a pass.

## Editing notes

Line endings, **measured 2026-09-22**: `core.autocrlf` is **false** and there is no
`.gitattributes`, so git writes files exactly as committed. TypeScript, TSX, MJS and
Markdown files are **LF** in the blob and on disk (measured: `app/api/files/route.ts`,
`app/(app)/portal/portal-app.tsx`, this file). Earlier versions of this paragraph said
`autocrlf=true` and CRLF-on-disk; both were wrong and misdirected people, so trust a fresh
measurement over any remembered list — including this one.

`app/globals.css` is the one exception: **pure CRLF**, in the blob and on disk alike
(17,140 CRLF, 0 bare LF). Write CRLF when editing it and splice at byte level; never
normalise it. (It used to be mixed — 20 LF lines among 16,621 CRLF — and normalising a
mixed file is how an 18-line addition becomes 38 insertions and 20 deletions.)

**Bash cannot measure any of this here.** Inside `$( )`, `$'\r'` expands to an
empty string, so a `grep -c` for it becomes `grep -c ''` and matches every line —
every file reads as entirely CRLF, including pure-LF ones. `file` mis-reports too,
and `git show HEAD:path` may apply the smudge filter. Count bytes in Python
instead: the CRLF count is `data.count(b"\r\n")`, and the bare-LF count is
`data.count(b"\n")` minus that.

Never commit `.mcp.json` (it carries a project ref), `.env*`, `.wrangler/`, or
anything under `db/monday-export/` — that directory holds the client's live data
and this repository is public.
