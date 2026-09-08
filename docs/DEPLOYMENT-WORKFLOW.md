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

## What runs by itself, and what does not

`develop` → Preview is **automatic and verified**. Pushing `01f8945` to
`origin/develop` produced deployment `2zxzukf2p` seventeen seconds later, built
by Vercel's GitHub integration: `source: git`, `githubCommitRef: develop`,
`githubCommitSha: 01f8945`, `target: preview`, READY in 46 seconds. It also
carries a permanent per-branch alias,
`maintsupp-portal-git-develop-maintsupp.vercel.app`, alongside the stable client
link.

`main` → Production is gated by this repository, in the root `vercel.json`:

```json
"git": { "deploymentEnabled": { "main": true } }
```

While that read `false`, pushes to `main` built nothing and every Production
release was a manual prebuilt upload. It is `true` now, which is what makes the
release half of this document real.

> **A correction worth keeping, because the next reader will be tempted the same
> way.** This file first claimed the project had no Git integration at all. Two
> checks appeared to say so: `vercel project inspect` prints no Git section for
> this project, and `repos/anwarrshboul-cpu/MAINTSUPP/hooks` is empty. Both are
> worthless as evidence. Vercel's GitHub App does not install a repository
> webhook — it receives App-level events — so an empty hook list is expected on a
> perfectly connected repo, and the CLI's inspect output simply omits the link.
> The only check that answers the question is the one that costs a push: send a
> commit and see what Vercel does. It built a Preview immediately.

The two environments stay apart by target, configured in Vercel rather than
here: Preview reads **Supabase Staging** (`ajslebfjwgkvhlntrdmw`), Production
reads **Supabase Production** (`wghfhtdzxttfhofuljyy`). They share no data.

---

## Verified, 2026-09-07

Both directions were proved by pushing, not by reading settings.

| Push | Deployment | Target | Built from | Result |
| --- | --- | --- | --- | --- |
| `develop` @ `01f8945` | `2zxzukf2p` | preview | `githubCommitRef: develop` | READY, 46s |
| `develop` @ `d0b3840` | `dguv9lf23` | preview | `githubCommitRef: develop` | READY, 44s |
| `main` @ `6844e50` | `28thsavgt` | **production** | `githubCommitRef: main` | READY, 46s |

The Production deployment took the live aliases with it — `maintsupp.com`,
`www.maintsupp.com` and `maintsupp-portal-git-main-maintsupp.vercel.app` — with
`aliasError: null`. It was the first time Vercel has built this portal from
source rather than accepting a prebuilt upload, and it worked: the apex answers
200, `/login` answers 200, five `/api/*` routes answer 401, and there were no
5xx in the runtime logs.

Neither develop push moved Production, and the branch cleanup that followed
moved nothing at all.

## Development

```bash
git checkout develop
git pull origin develop

# work, commit
git push origin develop
```

That push builds a Preview. Point the stable client link at it with the existing
script, which refuses anything that is not a READY Preview belonging to this
project:

```bash
bash scripts/update-preview-alias.sh <deployment-url>
```

## Release

```
Preview approved  →  PR: develop → main  →  merge  →  Production
```

```bash
gh pr create --base main --head develop --title "Release: <what>"
# then merge it, from the PR page or:
gh pr merge --merge
```

**Do not deploy Production by hand any more.** The prebuilt-upload procedure in
`docs/DEPLOYMENT-PORTAL.md` still works and is still the emergency path, but a
normal release is a merge and nothing else. Deploying manually on top of an
auto-deployed branch is how `maintsupp.com` ends up serving something that is
not what `main` says it is.

`develop` is **not** deleted after a release; it is the permanent development
branch. Immediately after a release, `main` is an ancestor of `develop` again

## `main` is protected

Every commit that lands on `main` deploys to the public site, so `main` no
longer accepts a direct push — from anyone, including the owner.

| Rule | Setting | Why that value |
| --- | --- | --- |
| Pull request required | yes | a release is a deliberate act with a diff to read |
| Approving reviews required | **0** | one maintainer; requiring a second person would make releasing impossible |
| Required status checks | **none** | the repository carries measured baseline debt (22 `tsc` errors, a standing set of failing tests). Gating on them would block every release for faults the release did not cause. The gate below is a checklist a person applies. |
| Force pushes | blocked | |
| Branch deletion | blocked | |
| Applies to admins | **yes** | otherwise the only person who can push is exempt from the rule, and the rule protects nothing |
| Signed commits | not required | not in use here |

`develop` is deliberately **unprotected**. Push to it freely; that is what it
is for.

### The emergency path

Because admins are included, there is no quiet override. A genuine emergency
that cannot wait for a PR needs the rule lifted and put back, deliberately:

```bash
gh api -X DELETE repos/anwarrshboul-cpu/MAINTSUPP/branches/main/protection
# ... push the fix ...
gh api -X PUT repos/anwarrshboul-cpu/MAINTSUPP/branches/main/protection --input <saved-json>
```

Prefer a PR even then — it takes about a minute and leaves a record. And
whichever route a hotfix takes, **merge `main` back into `develop` immediately
afterwards** or the next release silently reverts it:

```bash
git checkout develop && git merge origin/main && git push origin develop
```

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
