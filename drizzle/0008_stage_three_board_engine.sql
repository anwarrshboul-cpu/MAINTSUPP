-- Stage 3 — Canonical Jobs and Maintenance Board
--
-- Additive only. No DROP TABLE, no DROP COLUMN, no DELETE FROM.
-- Existing board rows keep working: every new column is nullable or defaulted,
-- and the implicit "maintenance" board is materialised as a real row so the
-- current boardId text values resolve without a rewrite.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'maintenance',
  item_noun TEXT NOT NULL DEFAULT 'Job',
  reference_prefix TEXT NOT NULL DEFAULT 'MS',
  reference_counter INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS boards_org_key_idx ON boards(organisation_id, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS boards_org_idx ON boards(organisation_id);

--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN summary TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN option_set_key TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_board_columns ADD COLUMN description TEXT;

--> statement-breakpoint
ALTER TABLE maintenance_groups ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_groups ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_groups ADD COLUMN description TEXT;

--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN reference TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN archived_at TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_requests_reference_idx
  ON maintenance_requests(organisation_id, reference);

-- Item updates and per-item activity are needed by the board's comment bubble
-- (AA16). Kept minimal here; Group V extends them.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_updates (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  board_id TEXT NOT NULL DEFAULT 'maintenance',
  request_id TEXT NOT NULL,
  parent_id TEXT,
  author_name TEXT NOT NULL,
  author_email TEXT,
  body TEXT NOT NULL,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_updates_request_idx
  ON item_updates(organisation_id, request_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_activity (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  board_id TEXT NOT NULL DEFAULT 'maintenance',
  request_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  column_key TEXT,
  action TEXT NOT NULL,
  value_before TEXT,
  value_after TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_activity_request_idx
  ON item_activity(organisation_id, request_id);

-- Materialise the implicit board so existing rows resolve. One per
-- organisation, matching the boardId text already in use.
--> statement-breakpoint
INSERT OR IGNORE INTO boards (id, organisation_id, key, name, kind, item_noun, reference_prefix, position)
SELECT
  'board_' || o.id || '_maintenance',
  o.id,
  'maintenance',
  'Maintenance',
  'maintenance',
  'Job',
  'MS',
  0
FROM organisations o;
