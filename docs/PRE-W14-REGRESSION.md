# Pre-W14 — the remaining test failures, classified

Measured 2026-09-05 at the head of `feat/owner-polish-pass`, against a quiet
tree with one dev server and nothing else running.

```
full suite at HEAD          2720 tests   2444 pass   63 fail   213 skipped
the same 38 files at 67e02f3  576 tests    466 pass   64 fail    46 skipped
```

**HEAD fails one fewer than the baseline it is compared against.** The point of
the comparison is not the count, though — it is which names move.

| | count |
| --- | --- |
| fail at BOTH head and baseline | 45 |
| fail only at HEAD | 18 |
| fail only at BASELINE (i.e. head is better) | 19 |

The head-only and baseline-only sets are nearly the same size and neither is
stable between runs. That is the signature of shared-state live tests, not of a
regression, and it is confirmed below rather than asserted.

---

## Class A — real application defect

**None remaining.** Eight were found and fixed during this work:

| Defect | How it was found |
| --- | --- |
| `PATCH /api/maintenance` accepted `scheduledDate`, answered 200 and stored nothing | Browser verification of drag-to-schedule |
| Three copies of the navigation order, one updated | The two drift tests written for it |
| `insertRows` chunked by a hand-typed width; drizzle binds every column the TABLE has | The first real seed run |
| The cron read `process.env`, which Miniflare does not populate | Trying to run it locally |
| `waiverNotesForReport` written and called by nothing | Module 4 §10 re-audit |
| A colour literal in `reports.css` | `w2-reports-tabs` |
| `is_current` translator pin too literal | `workstream-seven-official-documents` |
| `narrative.ts`'s "Tier 1" read as an orphan figure | Running the validator against real data |

## Class B — test/harness defect

Fixed where safe, each with the reason written into the test:

- `stage-twenty-navigation`, `column-drag-and-recovery` — pins re-pointed for a
  deliberately added section.
- `workstream-four-calendar-model` — the source list re-pointed for the
  scheduled-visit layer, its third such re-point.
- `pre-w14-seed-loader` — drizzle stub extended for `getTableColumns`.
- `pre-w14-seed-reconcile` — status-map mirror relaxed from identity to
  subset-with-matching-semantics, after the estate's real labels were seeded.

## Class C — environment-specific

**This is where nearly every remaining failure lives.** Three mechanisms, each
reproducible:

### C1. `core.autocrlf=true` breaks newline-bearing regexes

Proven, not inferred. `completion-audit-gaps`' widget pattern against
`portal-app.tsx`:

```
matches with a bare \n : 0
matches with \r?\n     : 13
```

Git checks the file out CRLF on this machine. Essentially every test file
contains such a pattern; the ones that fail are those whose target file is CRLF.

### C2. Live tests starve under a full-suite run

`node --test tests/*.test.mjs` runs many files against one dev server. Verified
by re-running alone:

- `live: W07-04 a document is not downloadable without a session` — fails in the
  suite, **passes alone in 4.3s**.
- `w2-template-parity` — two failures in the suite, **16/16 alone**.
- `W05-07`, `W07-02`, `workstream-five-six-relationships` — all fail in the
  suite and pass alone; and when re-run alone a *different* pair fails instead,
  which is the rotation this class is named for.

### C3. The shared development database

One Miniflare D1 serves every live test, and it holds no comment attachments
and 14 fixture site rows left deliberately by `w2-scope-model`. So
`stage-twentyfour-comment-assets` (4), `stage-twentythree-viewer` (2),
`stage-twentytwo-fix-tracker` (3) and `workstream-five-sites`' alias assertion
fail on data volume rather than on behaviour. All of them fail **identically at
the baseline commit** when the baseline worktree is given the same database.

> **A trap worth recording.** A `git worktree` has no `.wrangler` of its own, so
> every database-reading test SKIPS there and appears to pass. Comparing against
> it without linking the real database in makes environment failures look like
> new regressions — it did, for nine of them, until the junction was added.

## Class D — verified pre-existing technical debt

### Lint — BASELINE DEBT, 13 errors

`npx eslint app db worker` → **42 problems (13 errors, 29 warnings)**. Was 19
errors; six were removed because they were not findings (a malformed
`eslint-disable` comment parsed as three rule names, and React hook rules
applied to `db/**`, which contains no React).

The 13 that remain are React-compiler findings, and they are debt rather than
passes:

```
app/(app)/portal/evidence-manager.tsx            870:17, 902:5    set-state-in-effect
app/(app)/portal/form-options-editor.tsx         135:12           set-state-in-effect
app/(app)/portal/form-preview.tsx                62:5             set-state-in-effect
app/(app)/portal/live-board.tsx                  1256:5           set-state-in-effect
app/(app)/portal/portal-app.tsx                  1610:10, 9299:5, 9390:28  set-state-in-effect
app/(app)/portal/portal-app.tsx                  4975:31          impure call during render
app/(app)/portal/portal-app.tsx                  5262:6           memoization not preserved
app/(app)/portal/views/document-thumbnail.tsx    88:19            set-state-in-effect
```

Identical at `67e02f3`. Fixing them is a behavioural refactor, which the owner
asked not be chased before W14.

> `npm run lint` reports ~9,983 problems because its ignore list does not cover
> `vercel/.deploy/`, so it lints the built bundle. The figure above is the
> source tree: `npx eslint app db worker`.

### TypeScript — BASELINE DEBT, 22 errors

`npx tsc --noEmit` → **22**, unchanged throughout. All in two known categories:
`Cannot find module 'cloudflare:workers'` and the ambient Workers types
(`R2Bucket`, `D1Database`, `Fetcher`), plus two `Untyped function calls` in
`db/init.ts` and two in the `examples/d1` sample. None is in code this work
touched.

### The depleted attachment estate

Documented before this pass and unchanged: the local D1 holds no comment
attachments, so five data-volume tests fail deterministically. No seeder can fix
it; the original data came from a one-time import whose payload is gitignored
and absent.
