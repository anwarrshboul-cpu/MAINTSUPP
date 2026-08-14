-- Stage 23 — a 30-day recycle bin.
--
-- This migration reverses a decision the schema previously made on purpose: no
-- table carried a `deleted_at`, every delete was a real DELETE, and the Trash
-- screen said so instead of offering a Restore button that could not work.
--
-- Reversed on the owner's explicit instruction — "when someone deleted
-- something we should have backup for 30 days and where he can find also the
-- deleted section — check monday.com". The old comment was an accurate
-- description of the schema; the owner asked for a different schema.
--
-- Additive only. `deleted_at IS NULL` is the live state, so every existing row
-- is live the moment this lands and no backfill is needed.

ALTER TABLE maintenance_requests ADD COLUMN deleted_at TEXT;
ALTER TABLE maintenance_requests ADD COLUMN deleted_by TEXT;

ALTER TABLE maintenance_groups ADD COLUMN deleted_at TEXT;
ALTER TABLE maintenance_groups ADD COLUMN deleted_by TEXT;

-- Partial indexes: only live rows are indexed, so these stay small and the
-- board's reads — which all filter `deleted_at IS NULL` — hit them.
CREATE INDEX IF NOT EXISTS maintenance_requests_live_idx
  ON maintenance_requests(organisation_id, archived)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS maintenance_groups_live_idx
  ON maintenance_groups(organisation_id, board_id)
  WHERE deleted_at IS NULL;

-- One row per thing CURRENTLY in the bin. Not a history: the row is removed on
-- restore and on purge, and the permanent record that a deletion happened stays
-- in `audit_events` / `activity_log`, which are append-only.
--
-- `placement` is the reason this is a table rather than a flag. Restoring a job
-- to where it came from means its group AND its position, which live in
-- `maintenance_group_items` — a row that must be deleted on soft delete, or
-- every board read that joins through it keeps showing the deleted job.
--
-- `expires_at` is stored rather than computed so it can be indexed, which is
-- what lets the expiry sweep find its work without scanning the table.
CREATE TABLE IF NOT EXISTS recycle_bin (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  board_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  placement TEXT,
  deleted_by_email TEXT,
  deleted_by_name TEXT,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recycle_bin_org_deleted_idx
  ON recycle_bin(organisation_id, deleted_at);

-- Swept by expiry, so the sweep must not scan the table to find its work — the
-- same reason `sign_in_failures_expiry_idx` exists.
CREATE INDEX IF NOT EXISTS recycle_bin_expiry_idx
  ON recycle_bin(expires_at);

-- One live bin row per thing. A second soft delete of the same id would
-- otherwise leave two entries and an ambiguous restore.
CREATE UNIQUE INDEX IF NOT EXISTS recycle_bin_entity_idx
  ON recycle_bin(organisation_id, entity_type, entity_id);
