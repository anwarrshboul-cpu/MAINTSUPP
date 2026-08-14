-- Per-user dashboard arrangement.
--
-- Mirrors navigation_layouts: NULL user_id is the workspace default, a row with
-- a user id is that person's own arrangement and wins over it, and the built-in
-- order is the floor beneath both.
--
-- `items` records ORDER and HIDDEN only. Whether a panel exists comes from the
-- widget registry in the code, so a panel added in a later release appears for
-- someone who saved a layout last year instead of vanishing.
CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  user_id TEXT,
  surface TEXT NOT NULL DEFAULT 'overview',
  items TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_layouts_scope_idx
  ON dashboard_layouts(organisation_id, user_id, surface);
