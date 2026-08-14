-- Stage 5 — Board views and chrome
--
-- Additive. No table or column dropped, no row deleted.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS board_views (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  board_id TEXT NOT NULL DEFAULT 'maintenance',
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'table',
  icon TEXT,
  filters TEXT NOT NULL DEFAULT '[]',
  sort TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS board_views_org_key_idx
  ON board_views(organisation_id, board_id, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS board_views_org_position_idx
  ON board_views(organisation_id, board_id, position);
