-- 001_schema.sql — create the target namespace.
--
-- WHY a separate schema rather than `public`:
-- This Supabase project already carries the live Phase 2 application in
-- `public` (23 tables, ~791 rows in `jobs`). The legacy portal has 48 tables
-- and several names that collide outright — `sites`, `users`, `contractors`,
-- `organisations`, `attachments`, `invoices`, `leads`, `sessions`,
-- `activity_log`, `compliance_documents`, `invitations` all exist in both
-- worlds with *different* column sets. Loading the legacy portal into `public`
-- would therefore either fail on the first `create table` or, far worse,
-- succeed against a same-named table with compatible-looking columns and
-- corrupt live data.
--
-- `portal` keeps the two estates side by side in one database, so a future
-- cut-over can join across them, and so nothing here can damage Phase 2.
--
-- Every object in this migration set is schema-qualified `portal.*`. There is
-- deliberately no `search_path` manipulation: an unqualified `create table`
-- that silently lands in `public` is exactly the accident this guards against.

create schema if not exists portal;

comment on schema portal is
  'Legacy MAINTSUPP portal (Cloudflare D1/SQLite) ported to Postgres. '
  'Separate from public, which holds the Phase 2 application.';
