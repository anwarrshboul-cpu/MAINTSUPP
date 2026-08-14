-- Stage 23 — sections the workspace owner adds, the way monday gets a board.
--
-- The sidebar already had three layers (built-in order, workspace default, the
-- person's own arrangement) and a hard rule underneath them: a saved layout is
-- an ARRANGEMENT, never an inventory. Existence comes from the catalogue, which
-- is why a section shipped after somebody saved their sidebar appears for them
-- instead of vanishing.
--
-- That left nowhere for a section the code did not ship. This table is the
-- workspace's own half of the catalogue: rows here are APPENDED to the built-in
-- catalogue and the same merge runs over the result untouched. Nothing about
-- the arrangement layers changes, and the property they exist to hold survives.
--
-- `surface` names a screen the product already renders, so adding a section
-- cannot invent a destination — that is the other rule this has to keep.
CREATE TABLE IF NOT EXISTS workspace_sections (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  -- Namespaced `section:<slug>` so a workspace key can never collide with a
  -- built-in one, nor with a `group:` heading key.
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'grid',
  surface TEXT NOT NULL DEFAULT 'board',
  -- The surface's parameter: a board key for board surfaces, else NULL.
  surface_ref TEXT,
  group_key TEXT NOT NULL DEFAULT 'group:operations',
  position INTEGER NOT NULL DEFAULT 0,
  -- Set instead of deleting when the section still holds content. Removing a
  -- nav item must not be a way to lose rows.
  archived_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_sections_key_idx
  ON workspace_sections(organisation_id, key);

CREATE INDEX IF NOT EXISTS workspace_sections_position_idx
  ON workspace_sections(organisation_id, position);

-- Which view a section opens on — monday's default view, and its memory.
--
-- Two layers in one table, told apart by `user_id` exactly as
-- navigation_layouts and dashboard_layouts do it: NULL is the workspace default
-- the owner sets and everyone lands on, a row with a user id is that person's
-- own last view and wins for them alone.
--
-- `view_key` REFERENCES a view rather than defining one; the views live in
-- board_views. A remembered key whose view has been deleted resolves to nothing
-- and falls through to the default, so deleting a view cannot strand anybody on
-- a tab that is no longer there.
CREATE TABLE IF NOT EXISTS section_view_preferences (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  section_key TEXT NOT NULL,
  user_id TEXT,
  view_key TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NULL is distinct from NULL in SQLite, so the workspace-default row is not
-- actually constrained by this; the API enforces one default per section.
CREATE UNIQUE INDEX IF NOT EXISTS section_view_preferences_scope_idx
  ON section_view_preferences(organisation_id, section_key, user_id);
