# ABANDONED — do not use

This directory is an **abandoned early approach** to running the portal on
Postgres, kept only as history. It predates the adapter that actually shipped
and contradicts it:

- It rewrites `getDb` to drizzle/postgres-js against the **transaction pooler
  (port 6543)** — the live adapter (`db/node-pg-d1.ts`) requires the **session
  pooler (5432)** and documents a measured deadlock on 6543.
- Its `init.ts` is a stale fork (~800 lines vs the live ~2,600): it is missing
  stages 5, 7, 9, 20 (auth), 23 (recycle bin), the demo organisation and the
  form builder. Running its drizzle config against a live database would
  create a second, incomplete schema.

The architecture that shipped is the opposite of this one: `app/**` stays
untouched and SQL is translated on the wire — see `db/node-pg-d1.ts` and
`db/sqlite-to-postgres.ts`, selected at runtime by `PG_D1=1`. Deployment is
documented in `docs/DEPLOYMENT-PORTAL.md`.
