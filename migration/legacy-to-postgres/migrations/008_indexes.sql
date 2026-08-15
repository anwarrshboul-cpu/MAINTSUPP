-- 008_indexes.sql — all 107 secondary indexes, transcribed from the legacy
-- schema and re-pointed at `portal`.
--
-- Indexes are created after the data load would normally be faster, but they
-- are created here, before it, on purpose: several are UNIQUE and act as
-- correctness checks on the migration itself. If the loader were to duplicate
-- a row, `sessions_token_idx` or `maintenance_board_cells_org_value_idx` would
-- reject it immediately rather than leaving a silent duplicate to be found
-- weeks later. The dataset is ~32k rows, so the load-time cost is irrelevant.
--
-- DIALECT NOTES
--
-- * `if not exists` on every statement makes this migration re-runnable, which
--   the runner in ../migrate.mjs relies on.
--
-- * Index names are schema-scoped in Postgres, so `portal.activity_created_idx`
--   cannot collide with anything in `public`. In SQLite they were
--   database-global. No renaming was needed.
--
-- * SQLite auto-created hidden `sqlite_autoindex_*` entries for every PRIMARY
--   KEY and inline UNIQUE. Postgres does the same for primary keys, so those
--   are not repeated here. The three inline `UNIQUE` constraints in the legacy
--   DDL — organisations.slug, users.email, attachments.object_key — were each
--   ALSO declared as a named unique index in the legacy schema, so the named
--   index below is the single source of that guarantee here and the redundant
--   inline constraint was dropped. Same enforcement, one index instead of two.
--
-- * `maintenance_requests_live_idx` is a PARTIAL index
--   (`WHERE deleted_at IS NULL`). Postgres supports these with identical
--   syntax and semantics to SQLite, so it is carried across verbatim rather
--   than being widened into a full index.
--
-- * Several unique indexes span a NULLable column — for example
--   `navigation_layouts_scope_idx (organisation_id, user_id)`, where a NULL
--   `user_id` means "organisation default". Both SQLite and Postgres treat
--   NULLs as distinct in a unique index by default, so multiple NULL-user rows
--   would be permitted in either engine. Postgres 15+ offers `NULLS NOT
--   DISTINCT` to change that; it is deliberately NOT used, because doing so
--   would impose a constraint the legacy application never had.

create index if not exists activity_created_idx on portal.activity_log (created_at);
create index if not exists activity_entity_idx on portal.activity_log (entity_type, entity_id);
create index if not exists activity_organisation_idx on portal.activity_log (organisation_id);
create index if not exists attachments_board_column_idx on portal.attachments (board_column_id, request_id);
create unique index if not exists attachments_object_key_unique on portal.attachments (object_key);
create index if not exists attachments_org_column_request_idx on portal.attachments (organisation_id, board_column_id, request_id);
create index if not exists attachments_organisation_idx on portal.attachments (organisation_id);
create index if not exists attachments_request_idx on portal.attachments (request_id);
create index if not exists attachments_site_idx on portal.attachments (site_id);
create index if not exists attachments_unit_idx on portal.attachments (unit_id);
create index if not exists attachments_update_idx on portal.attachments (update_id);
create index if not exists audit_events_action_idx on portal.audit_events (action);
create index if not exists audit_events_actor_idx on portal.audit_events (actor_email);
create index if not exists audit_events_organisation_idx on portal.audit_events (organisation_id, created_at);
create unique index if not exists board_views_org_key_idx on portal.board_views (organisation_id, board_id, key);
create index if not exists board_views_org_position_idx on portal.board_views (organisation_id, board_id, position);
create index if not exists boards_org_idx on portal.boards (organisation_id);
create unique index if not exists boards_org_key_idx on portal.boards (organisation_id, key);
create index if not exists compliance_expiry_idx on portal.compliance_documents (expiry_date);
create index if not exists compliance_organisation_idx on portal.compliance_documents (organisation_id);
create index if not exists compliance_site_kind_idx on portal.compliance_documents (site_id, kind);
create index if not exists contractors_organisation_idx on portal.contractors (organisation_id);
create unique index if not exists dashboard_layouts_scope_idx on portal.dashboard_layouts (organisation_id, user_id, surface);
create index if not exists import_anomalies_batch_idx on portal.import_anomalies (batch_id);
create index if not exists import_anomalies_organisation_idx on portal.import_anomalies (organisation_id);
create index if not exists import_anomalies_resolved_idx on portal.import_anomalies (organisation_id, resolved);
create index if not exists invitations_organisation_idx on portal.invitations (organisation_id, email);
create unique index if not exists invitations_token_idx on portal.invitations (token_hash);
create index if not exists invoices_organisation_idx on portal.invoices (organisation_id);
create index if not exists invoices_request_idx on portal.invoices (request_id);
create index if not exists item_activity_request_idx on portal.item_activity (organisation_id, request_id);
create index if not exists item_update_likes_update_idx on portal.item_update_likes (organisation_id, update_id);
create index if not exists item_updates_request_idx on portal.item_updates (organisation_id, request_id);
create unique index if not exists job_access_tokens_hash_idx on portal.job_access_tokens (token_hash);
create index if not exists leads_created_idx on portal.leads (created_at);
create index if not exists leads_organisation_idx on portal.leads (organisation_id);
create unique index if not exists maintenance_board_cells_org_value_idx on portal.maintenance_board_cells (organisation_id, board_id, request_id, column_id);
create index if not exists maintenance_board_cells_request_idx on portal.maintenance_board_cells (board_id, request_id);
create unique index if not exists maintenance_board_columns_org_key_idx on portal.maintenance_board_columns (organisation_id, board_id, column_key);
create index if not exists maintenance_board_columns_org_position_idx on portal.maintenance_board_columns (organisation_id, board_id, position);
create index if not exists maintenance_board_options_column_idx on portal.maintenance_board_options (client_id, board_id, column_key, position);
create unique index if not exists maintenance_board_options_org_value_idx on portal.maintenance_board_options (organisation_id, board_id, column_key, value);
create index if not exists maintenance_group_items_group_idx on portal.maintenance_group_items (board_id, group_id, position);
create index if not exists maintenance_group_items_org_idx on portal.maintenance_group_items (organisation_id, board_id, group_id, position);
create index if not exists maintenance_groups_org_board_idx on portal.maintenance_groups (organisation_id, board_id);
create unique index if not exists maintenance_groups_org_position_idx on portal.maintenance_groups (organisation_id, board_id, position);
create index if not exists maintenance_client_stage_idx on portal.maintenance_requests (client_id, stage);
create index if not exists maintenance_org_archived_created_idx on portal.maintenance_requests (organisation_id, archived, created_at);
create index if not exists maintenance_org_requested_idx on portal.maintenance_requests (organisation_id, requested_at);
create index if not exists maintenance_organisation_stage_idx on portal.maintenance_requests (organisation_id, stage);
create index if not exists maintenance_priority_idx on portal.maintenance_requests (priority);
create index if not exists maintenance_requests_external_idx on portal.maintenance_requests (organisation_id, external_id);
create index if not exists maintenance_requests_live_idx on portal.maintenance_requests (organisation_id, archived) WHERE deleted_at IS NULL;
create index if not exists maintenance_requests_parent_idx on portal.maintenance_requests (organisation_id, parent_id);
create index if not exists maintenance_requests_reference_idx on portal.maintenance_requests (organisation_id, reference);
create index if not exists maintenance_site_idx on portal.maintenance_requests (site_id);
create index if not exists memberships_organisation_idx on portal.memberships (organisation_id);
create unique index if not exists memberships_user_organisation_idx on portal.memberships (user_id, organisation_id);
create unique index if not exists navigation_layouts_scope_idx on portal.navigation_layouts (organisation_id, user_id);
create index if not exists notification_log_org_idx on portal.notification_log (organisation_id, created_at);
create unique index if not exists option_sets_organisation_key_idx on portal.option_sets (organisation_id, key);
create index if not exists option_values_set_position_idx on portal.option_values (organisation_id, option_set_id, position);
create unique index if not exists option_values_set_value_idx on portal.option_values (organisation_id, option_set_id, value);
create unique index if not exists organisations_slug_unique on portal.organisations (slug);
create unique index if not exists password_resets_token_idx on portal.password_resets (token_hash);
create index if not exists password_resets_user_idx on portal.password_resets (user_id, created_at);
create index if not exists planned_maintenance_due_idx on portal.planned_maintenance (next_due_at);
create index if not exists planned_maintenance_organisation_idx on portal.planned_maintenance (organisation_id);
create index if not exists planned_maintenance_site_idx on portal.planned_maintenance (site_id);
create index if not exists quotations_organisation_idx on portal.quotations (organisation_id);
create index if not exists quotations_request_idx on portal.quotations (request_id);
create unique index if not exists recycle_bin_entity_idx on portal.recycle_bin (organisation_id, entity_type, entity_id);
create index if not exists recycle_bin_expiry_idx on portal.recycle_bin (expires_at);
create index if not exists recycle_bin_org_deleted_idx on portal.recycle_bin (organisation_id, deleted_at);
create unique index if not exists role_capabilities_idx on portal.role_capabilities (organisation_id, role, capability);
create unique index if not exists section_view_preferences_scope_idx on portal.section_view_preferences (organisation_id, section_key, user_id);
create unique index if not exists sessions_token_idx on portal.sessions (token_hash);
create index if not exists sessions_user_idx on portal.sessions (user_id, expires_at);
create index if not exists sign_in_failures_expiry_idx on portal.sign_in_failures (blocked_until, first_at);
create unique index if not exists site_aliases_organisation_normalised_idx on portal.site_aliases (organisation_id, normalised);
create index if not exists site_aliases_site_idx on portal.site_aliases (site_id);
create unique index if not exists site_group_members_pair_idx on portal.site_group_members (site_group_id, site_id);
create index if not exists site_group_members_site_idx on portal.site_group_members (site_id);
create index if not exists site_groups_organisation_position_idx on portal.site_groups (organisation_id, position);
create unique index if not exists site_groups_organisation_slug_idx on portal.site_groups (organisation_id, slug);
create index if not exists sites_client_idx on portal.sites (client_id);
create index if not exists sites_lifecycle_idx on portal.sites (lifecycle);
create index if not exists sites_organisation_idx on portal.sites (organisation_id);
create index if not exists sites_organisation_position_idx on portal.sites (organisation_id, position);
create unique index if not exists sites_organisation_slug_idx on portal.sites (organisation_id, slug);
create index if not exists sites_organisation_status_idx on portal.sites (organisation_id, status);
create index if not exists system_notifications_entity_idx on portal.system_notifications (entity_type, entity_id);
create index if not exists system_notifications_organisation_idx on portal.system_notifications (organisation_id);
create index if not exists system_notifications_user_idx on portal.system_notifications (user_email, read_at);
create unique index if not exists team_members_pair_idx on portal.team_members (team_id, user_id);
create index if not exists team_members_user_idx on portal.team_members (user_id);
create unique index if not exists teams_organisation_slug_idx on portal.teams (organisation_id, slug);
create index if not exists unit_service_organisation_idx on portal.unit_service_records (organisation_id);
create index if not exists unit_service_unit_idx on portal.unit_service_records (unit_id, performed_at);
create index if not exists units_next_service_idx on portal.units (organisation_id, next_service_due_at);
create index if not exists units_organisation_idx on portal.units (organisation_id);
create index if not exists units_site_idx on portal.units (site_id);
create unique index if not exists users_email_unique on portal.users (email);
create index if not exists users_organisation_idx on portal.users (organisation_id);
create unique index if not exists workspace_sections_key_idx on portal.workspace_sections (organisation_id, key);
create index if not exists workspace_sections_position_idx on portal.workspace_sections (organisation_id, position);
create unique index if not exists workspace_settings_organisation_idx on portal.workspace_settings (organisation_id);
