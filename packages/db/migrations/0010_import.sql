-- 0010 — provenance keys for the legacy Cloudflare D1 import.
--
-- Adds nothing to the product's vocabulary and inserts no rows. It exists for
-- one reason: the importer must be safe to re-run.
--
-- The legacy `maintenance_requests` rows have a stable primary key
-- (`req_…` / `sd-…`) but no reference number — `reference` is NULL for all 775
-- of them — and the new `jobs.reference` is generated from a sequence, so it is
-- a different value on every run. Without somewhere to record where a row came
-- from, a second import cannot tell "this job already exists" from "this is a
-- new job", and 776 rows quietly becomes 1552.
--
-- `legacy_id` is that record. It is the importer's ON CONFLICT target, and it
-- stays afterwards as provenance: it is the only thing that can answer "which
-- monday row did this job come from" once the D1 database is gone.
--
-- Only the three tables the importer creates in bulk need it. `organisations`
-- already has a unique `slug` and does not.

alter table organisations add column if not exists legacy_id text;
alter table sites add column if not exists legacy_id text;
alter table contractors add column if not exists legacy_id text;
alter table jobs add column if not exists legacy_id text;

/*
 * Plain unique indexes, not partial ones.
 *
 * Postgres treats NULLs as distinct in a unique index, so every row created
 * through the UI — which has no legacy id and never will — coexists happily.
 * A partial `where legacy_id is not null` index would behave identically here
 * but has to be spelled out again in every ON CONFLICT clause that infers it,
 * which is a footgun for the next person to write an upsert.
 */
create unique index if not exists organisations_legacy_id_key on organisations (legacy_id);
create unique index if not exists sites_legacy_id_key on sites (legacy_id);
create unique index if not exists contractors_legacy_id_key on contractors (legacy_id);
create unique index if not exists jobs_legacy_id_key on jobs (legacy_id);
