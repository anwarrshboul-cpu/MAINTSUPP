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

| Project | URL | Production deployment |
| --- | --- | --- |
| `maintsupp` | https://maintsupp.vercel.app | 2026-08-19, `dpl_A63M6tzAKAYc1KvBXffPEL7hTEsA` |
| `website` | https://website-rho-seven-8mdd7vw83c.vercel.app | 2026-08-19, `dpl_C47iGxpsNGuWQoZcDbuGm1Wcbnds` |

Two projects, two distinct deployments, byte-identical pages apart from chunk
hashes — one push to `main` on 2026-08-19 built both.

**`maintsupp-legacy-portal.vercel.app` is NOT this directory**, whatever an
earlier draft of this file said. `vercel inspect` shows one `__portal`
function in `lhr1` — the shape `vercel/build-output.mjs` produces — and it
answers with `X-Frame-Options: DENY` from `worker/index.ts`, which nothing
here sets, and with `__vinext` markup rather than `/_next/` chunks. It is a
**stale portal deployment** from 2026-08-17. Editing this directory cannot
change it; only a portal redeploy can.

The root `vercel.json` points at this directory explicitly — `"buildCommand":
"cd apps/web && next build"` — and it has its own scripts (`npm run
web:build`, `web:test`, `web:start`), its own test suite under
`apps/web/tests/`, and at least one cross-check that reads it
(`apps/api/tests/stage-parity.test.ts` compares its `lib/job-stages.ts`
against the API's).

So do not delete it, and do not assume nobody sees it.

## What rebuilds those URLs, and what does not

`git.deploymentEnabled.main: false` — in both the root `vercel.json` and this
directory's — holds, and the dashboard is the evidence: the flag landed
2026-08-20, `main` has carried commits since, and neither project has produced
a production deployment after 2026-08-19. Pushing a feature branch **does**
build both projects (19 Preview deployments in three days), but a Preview gets
its own URL; it does not touch the two production aliases above.

So editing this directory does not, by itself, change what those URLs serve.
What would:

- promoting a Preview deployment to Production from the dashboard;
- `vercel deploy --prod` from the repository root;
- flipping `deploymentEnabled.main` back to `true`, or changing either
  project's Production Branch away from `main`;
- a redeploy of the current production deployment — same commit, so same
  content.

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
  submission — and on `website-rho-seven-…` that form is live: the `website`
  project has `NEXT_PUBLIC_API_URL` set and `/api/health` answers 200. (The
  `maintsupp` project has no environment variables at all, so its `/api/*`
  rewrite targets `localhost:8787` and 404s — that form is already inert.)
- The approved v3 How-it-works photography, the founder section, the mobile
  pricing comparison table and the compact services register are portal work
  this copy has never carried.

Bringing the rest into line means editing live production sites, which is a
decision about what those URLs are for — not a tidy-up. Whoever takes it on
should decide first whether these projects should still be serving a landing
page at all.


## Where the real deployment story is written

`docs/DEPLOYMENT-PORTAL.md` — "The three deploy targets in this repository".
Read it before touching any Vercel project. In particular: the green "Vercel"
checks on pull requests build **this** directory, and prove nothing about the
portal.
