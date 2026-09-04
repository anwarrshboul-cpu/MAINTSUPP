# `apps/web` is not the landing page you are looking for

If you are here to change the public MAINTSUPP landing page — the hero, How it
works, pricing, Who we help, the footer — **you are in the wrong directory**.
Edit the portal's copy instead:

```
app/(marketing)/            <- canonical landing page
app/(marketing)/_sections/  <- hero, workflow, pricing, services, chrome, final CTA
app/(marketing)/marketing.css
```

That is what `maintsupp-preview.vercel.app` serves, and it is the one the
client reviews.

## This directory is no longer deployed anywhere

`apps/web` is a parallel "Phase 2" rewrite (Next.js + `apps/api` on Railway +
`packages/db`). Until **2026-09-04** it was built and served by two Vercel
projects of its own, so its landing page was publicly reachable. It is not any
more: that day's infrastructure consolidation reduced the account to a single
Vercel project, `maintsupp-portal`, and **nothing builds this directory now.**

> **Historical, for anyone reading an older branch or following an old link.**
> The two projects were `maintsupp` (https://maintsupp.vercel.app) and
> `website` (https://website-rho-seven-8mdd7vw83c.vercel.app), each carrying a
> production deployment from 2026-08-19 — two distinct deployments of
> byte-identical pages apart from chunk hashes, because one push to `main`
> built both. A third project, `maintsupp-legacy-portal`, held a **stale
> portal** deployment from 2026-08-17 (one `__portal` function,
> `X-Frame-Options: DENY` from `worker/index.ts`, `__vinext` markup rather than
> `/_next/` chunks) — it was never this directory, whatever an earlier draft of
> this file said. All three projects were deleted on 2026-09-04, and those
> hostnames now 404.

**So there is no live URL to be careful about, and nothing here can break a
public page.** That is a change in the stakes, not a licence to delete the
directory: the root `vercel.json` still points at it — `"buildCommand": "cd
apps/web && next build"` — and it still has its own scripts (`npm run
web:build`, `web:test`, `web:start`), its own test suite under
`apps/web/tests/`, and at least one cross-check that reads it
(`apps/api/tests/stage-parity.test.ts` compares its `lib/job-stages.ts`
against the API's).

## What would put this directory back on the internet

Nothing automatic. No Vercel project is linked to this repository any more, so
no push to any branch builds anything here, and the
`git.deploymentEnabled.main: false` flag in both the root `vercel.json` and
this directory's is now a belt to a brace that no longer exists. Leave the flag
alone anyway — it costs nothing and it is the guard that would matter first if
a project were ever linked again.

Reaching a public URL again would take a deliberate act: creating a new Vercel
project linked to this repository, or adding this build to `maintsupp-portal`,
which deploys by manual prebuilt upload and builds the portal rather than this.

## The two landings have diverged, deliberately and not

As of 2026-08-29 three of the four owner-facing facts have been brought into
line with the canonical copy in `app/(marketing)/`: the store count is `+20`,
the withdrawn "Franchise groups" card is gone, and `Contact Us` is in the
navigation (pointing at `#contact`, an id on the CTA panel's inner `div` —
deliberately not on the `<section>`, so the "eleven sections" assertion in
`tests/ui.test.mjs` still counts eleven).

What has **not** been aligned, because it needs a decision rather than an edit:

- **The three removed form fields** — Regions, Approx. maintenance issues per
  month, Biggest problem right now — are still here. They cannot just be
  deleted. This form posts to the Railway API, whose `/public/portfolio-review`
  handler rejects any body with `challenge.length < 20`, and `challenge` is
  composed from two of those three dropdowns. The portal's copy posts to its
  own `/api/leads` route, which dropped that requirement. Removing the fields
  here without relaxing `apps/api/src/routes/public.ts` would 400 every
  submission. That was once a live-site concern: until 2026-09-04 the `website`
  project had `NEXT_PUBLIC_API_URL` set and its `/api/health` answered 200, so
  the form really did submit, while the `maintsupp` project had no environment
  variables at all and its `/api/*` rewrite targeted `localhost:8787`. With
  both projects deleted, no deployment of this form exists to break — the 400
  would now surface only in local development, or in whatever is stood up next.
- The approved v3 How-it-works photography, the founder section, the mobile
  pricing comparison table and the compact services register are portal work
  this copy has never carried.

Bringing the rest into line was once a decision about live production sites.
It is not any more: the projects that served them are gone, so the open
question has moved from "what are those URLs for" to whether this copy of the
landing page should exist at all now that nothing publishes it.


## Where the real deployment story is written

`docs/DEPLOYMENT-PORTAL.md` — "The three deploy targets in this repository".
Read it before touching any Vercel project. Note that pull requests no longer
carry a "Vercel" check at all: the GitHub-linked projects that produced it
built **this** directory, and they were deleted on 2026-09-04. While one
existed it proved nothing about the portal, which has never deployed from a
push.
