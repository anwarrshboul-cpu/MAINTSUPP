# The client-review preview link

**https://maintsupp-preview.vercel.app**

That URL does not change. Send it once; the client keeps using it.

---

## What it is

A Vercel alias on the `maintsupp-portal` project, pointed at one specific
**Preview** deployment. Every `vercel deploy` mints a new
`maintsupp-portal-<hash>-maintsupp.vercel.app`, so without an alias the client
gets a different link after every update — and the old links keep working,
which is worse, because there is then no single answer to "what is the client
looking at".

The alias is **not** a production domain and assigning it does not promote
anything. The deployment behind it still reports `target: preview`, and
`maintsupp-portal` still reports no production URL at all — checked before and
after, and re-checked by the script on every run.

`maintsupp-portal` is the only Vercel project in the account. The two older
ones, `maintsupp` and `website`, owned their own production domains
(`maintsupp.vercel.app`, `website-rho-seven-8mdd7vw83c.vercel.app`) and were
deleted on 2026-09-04; a third, `maintsupp-legacy-portal`, went with them once
`maintsupp.com` and `www.maintsupp.com` had been moved onto `maintsupp-portal`.
Nothing in this workflow ever touched any of them, and the script still refuses
their hostnames by name — see `scripts/update-preview-alias.sh`.

---

## Updating it after a change

```bash
# 1. build and deploy a Preview as usual — no --prod, ever
npm run build
node vercel/build-output.mjs
cd vercel/.deploy && npx vercel deploy --prebuilt --archive=tgz --yes

# 2. smoke-test that deployment on its own URL first
#    (tests, then the browser checks — see the verification scripts)

# 3. only once it is healthy, move the client's link onto it
cd "$(git rev-parse --show-toplevel)"
scripts/update-preview-alias.sh https://maintsupp-portal-<hash>-maintsupp.vercel.app
```

With no argument the script takes the newest READY Preview from
`maintsupp-portal`:

```bash
scripts/update-preview-alias.sh
```

**The order matters.** The alias stays on the last known-good deployment until
the new one has passed. That is the entire rollback story: the previous
deployment is still there, still served by its own URL, and moving the link
back is one command.

### What the script refuses

- a deployment whose target is `production`
- a deployment belonging to any project other than `maintsupp-portal`
- a deployment that is not READY, or that does not answer 200 on `/` and
  `/login`
- an alias that is one of the known production domains

It runs only `vercel ls`, `inspect`, `alias ls`, `alias set` and `project ls`.
`--prod` appears nowhere in it, and `tests/preview-alias-script.test.mjs` fails
the build if that stops being true. No token, project id or password is stored
in it.

---

## Rolling back

Every run prints the deployment the alias pointed at *before* it moved:

```
  To roll back:  scripts/update-preview-alias.sh maintsupp-portal-<previous>-maintsupp.vercel.app
```

Run that line. The script accepts a bare host as well as a full URL, so the hint
can be pasted straight back in.

To see what the link currently points at:

```bash
npx vercel alias ls | grep maintsupp-preview
```

---

## Signing in

The client credentials are in `maintsupp-preview-CLIENT-LOGIN.txt`, outside the
repository. The database behind this link is the Supabase **Staging** project
(`MAINTSUPP Staging`), never production.

---

## Checking it is healthy

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://maintsupp-preview.vercel.app/
curl -s -o /dev/null -w '%{http_code}\n' https://maintsupp-preview.vercel.app/login
```

Both should be `200`, with no redirect and no Vercel login wall — Deployment
Protection is off for this project, which is what lets the client open the link
without a Vercel account.
