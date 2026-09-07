# The permanent release workflow

Two branches, and each one has exactly one job.

| Branch | Job | Deploys to |
| --- | --- | --- |
| `develop` | every day's work | Preview — `maintsupp-preview.vercel.app` |
| `main` | releases only | Production — `maintsupp.com` |

Companion to `docs/DEPLOYMENT-PORTAL.md`, which remains the authority on how the
portal is *built*. This file answers a narrower question: which branch a change
belongs on, and what has to be true before it reaches the public site.

Written 2026-09-07, against `main` = `35250b1` — the SHA that is live on
Production.

---

## Read this first: the automatic half is not wired yet

The table above describes the **target**. Half of it does not happen on its own
today, and the reason is not the repository's configuration.

**The Vercel project `maintsupp-portal` is not connected to the GitHub
repository.** `vercel project inspect` prints no Git section, and
`repos/anwarrshboul-cpu/MAINTSUPP/hooks` is empty. The GitHub-linked projects
that used to exist were deleted on 2026-09-04 (see `CLAUDE.md`), and the portal
has shipped by manual prebuilt upload ever since.

Two consequences follow, and both are easy to trip over:

1. **Pushing to `develop` creates no Preview deployment.** Pushing to `main`
   creates no Production deployment. Nothing is listening.
2. **`git.deploymentEnabled` in the root `vercel.json` does nothing.** That key
   only takes effect when a Git integration exists. Setting `"main": true`
   today would change no behaviour while advertising that it had — which is
   worse than leaving it alone, so it is deliberately still `false`.

Connecting the repository is a dashboard action that needs the account owner:
Vercel → `maintsupp-portal` → Settings → Git → **Connect Git Repository** →
`anwarrshboul-cpu/MAINTSUPP`, with the Production Branch set to `main`. It
requires the GitHub OAuth/App authorisation, which is why it cannot be done from
a CLI session.

Until that is done, releases stay manual — the procedure in
`docs/DEPLOYMENT-PORTAL.md`, which is known to work and produced the deployment
currently serving `maintsupp.com`.

---

## Development

```bash
git checkout develop
git pull origin develop

# work, commit
git push origin develop
```

Once the repository is connected, that push builds a Preview. Point the stable
client link at it with the existing script, which refuses anything that is not a
READY Preview belonging to this project:

```bash
bash scripts/update-preview-alias.sh <deployment-url>
```

The Preview reads **Supabase Staging** (`ajslebfjwgkvhlntrdmw`). Production reads
**Supabase Production** (`wghfhtdzxttfhofuljyy`). They share no data and the
environments are mapped per target in Vercel, not in this repository.

## Release

```
Preview approved  →  PR: develop → main  →  merge  →  Production
```

No automatic merging, and no routine commits straight to `main`. A release is an
explicit act by a person.

`develop` is **not** deleted after a release; it is the permanent development
branch.

If a hotfix ever has to be made on `main` directly, merge `main` back into
`develop` immediately afterwards, or the next release silently reverts it.

## After a release

Verify, in this order:

- the deployment is READY and carries the SHA you merged
- `https://maintsupp.com` answers 200, and `www.` still redirects to the apex
- `/login` answers 200 — that route `await`s `ensureDatabase()`, so a 200 is
  positive proof the boot path completed against Production Postgres
- a few `/api/*` routes answer 401 rather than 500 — auth is running and the
  database is answering
- no 5xx in the runtime logs

---

## The minimum gate before `develop` → `main`

Deliberately small. This is a checklist, not a CI redesign.

- [ ] Preview deployment READY, and the change looked at on it
- [ ] the tests covering what changed pass
- [ ] `npm run build` succeeds
- [ ] no NEW type or lint errors attributable to the change
- [ ] no schema migration blocker — see below
- [ ] no test, demo or seeded data introduced into a client workspace
- [ ] no secrets committed (`.env*`, `.mcp.json` values, `db/monday-export/`)
- [ ] explicit approval from the owner

**On existing debt.** The repository carries a known, measured baseline: 22
`tsc` errors in named categories, a standing set of failing tests (documented in
`docs/PRE-W14-REGRESSION.md`), and lint debt in generated output. That baseline
does **not** block a release. What blocks a release is a change that makes it
worse. Compare like with like — by test *name*, never by count, because the
count moves with local `.wrangler` state.

**On schema.** Migrations are automatic and additive: `ensureDatabase()` in
`db/init.ts` replays `CREATE TABLE IF NOT EXISTS`, guarded `addColumn` and
`INSERT OR IGNORE` on the first request of every instance. A release needs a
human look only when it adds a column to a table that already exists in
Production, and especially when that column is a flag — an `INTEGER` flag must
also be registered in `BOOLEAN_COLUMNS` (`db/sqlite-to-postgres.ts`) or the DDL
creates an `integer`, the rewriter compares it with `= true`, and Postgres
answers 42883 on a path whose error is swallowed.
