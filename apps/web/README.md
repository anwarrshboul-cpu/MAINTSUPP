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

## But this directory is not dead either

It would be easier if it were. `apps/web` is a parallel "Phase 2" rewrite
(Next.js + `apps/api` on Railway + `packages/db`), and it is **built and
deployed by its own Vercel projects**, so its landing page is publicly
reachable:

| Project | URL |
| --- | --- |
| `maintsupp` | https://maintsupp.vercel.app |
| `website` | https://website-rho-seven-8mdd7vw83c.vercel.app |
| `maintsupp-legacy-portal` | https://maintsupp-legacy-portal.vercel.app |

The root `vercel.json` points at it explicitly — `"buildCommand": "cd apps/web
&& next build"` — and it has its own scripts (`npm run web:build`, `web:test`,
`web:start`), its own test suite under `apps/web/tests/`, and at least one
cross-check that reads it (`apps/api/tests/stage-parity.test.ts` compares its
`lib/job-stages.ts` against the API's).

So do not delete it, and do not assume nobody sees it.

## The two landings have diverged, deliberately and not

As of 2026-08-28 the portal landing carries work this copy does not: the
approved v3 How-it-works photography, the mobile pricing comparison table, the
compact services register, `Contact Us` in the navigation, and a store count of
**20**. This copy still says **21** and still shows the withdrawn "Franchise
groups" card.

That divergence was left in place on purpose. Bringing this copy into line
means editing three live production sites, which is a decision about what those
URLs are for — not a tidy-up. Whoever takes it on should decide first whether
these projects should still be serving a landing page at all.

## Where the real deployment story is written

`docs/DEPLOYMENT-PORTAL.md` — "The three deploy targets in this repository".
Read it before touching any Vercel project. In particular: the green "Vercel"
checks on pull requests build **this** directory, and prove nothing about the
portal.
