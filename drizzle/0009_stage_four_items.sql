-- Stage 4 — Items, seeding, and tenant-safe board indexes
--
-- No table or column is dropped and no row is deleted. Indexes ARE dropped and
-- recreated: an index holds no data, and three of them are actively unsafe.
--
-- THE BUG BEING FIXED
--
-- maintenance_groups_board_position_idx was UNIQUE (board_id, position).
-- Every organisation uses board_id = 'maintenance', so two organisations could
-- not both hold a group at position 0. The second tenant's seed failed.
--
-- maintenance_board_columns_key_idx and maintenance_board_options_value_idx
-- were scoped by client_id, which now defaults to the same literal for every
-- tenant, so all organisations shared one namespace.
--
-- All three are re-created scoped by organisation_id.

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_groups_board_position_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_groups_org_position_idx
  ON maintenance_groups(organisation_id, board_id, position);

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_groups_board_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_groups_org_board_idx
  ON maintenance_groups(organisation_id, board_id);

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_board_columns_key_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_columns_org_key_idx
  ON maintenance_board_columns(organisation_id, board_id, column_key);

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_board_columns_position_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_board_columns_org_position_idx
  ON maintenance_board_columns(organisation_id, board_id, position);

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_board_options_value_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_options_org_value_idx
  ON maintenance_board_options(organisation_id, board_id, column_key, value);

--> statement-breakpoint
DROP INDEX IF EXISTS maintenance_board_cells_value_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_board_cells_org_value_idx
  ON maintenance_board_cells(organisation_id, board_id, request_id, column_id);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_group_items_org_idx
  ON maintenance_group_items(organisation_id, board_id, group_id, position);

-- Sub-items — O11. A sub-item is a request whose parent_id points at another
-- request on the same board, so it inherits scoping and evidence handling.
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN parent_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maintenance_requests_parent_idx
  ON maintenance_requests(organisation_id, parent_id);
