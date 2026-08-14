-- Stage 2 — Unified Sites and Units.
-- Every statement is additive. No column is dropped, no row is deleted and no
-- existing value is rewritten, so the migration is safe to apply to the live
-- database and safe to roll back by ignoring the new columns.

-- ─────────────────────────────────────────────────────────────────────────────
-- X1 — site identity, placement and ordering
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `sites` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `code` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `site_type_value` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `address_line1` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `address_line2` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `city` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `postcode` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `country` text DEFAULT 'United Kingdom' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `latitude` real;--> statement-breakpoint
ALTER TABLE `sites` ADD `longitude` real;--> statement-breakpoint
ALTER TABLE `sites` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `active` integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- X2 — site contacts
ALTER TABLE `sites` ADD `manager_name` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `manager_phone` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `manager_email` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `landlord` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `managing_agent` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `out_of_hours_contact` text;--> statement-breakpoint

-- X3 — access split into four fields
ALTER TABLE `sites` ADD `access_method` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `access_contact` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `access_url` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `access_notes` text;--> statement-breakpoint

-- X4 — operating detail
ALTER TABLE `sites` ADD `opening_hours` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `delivery_restrictions` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `parking_notes` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `key_alarm_notes` text;--> statement-breakpoint

-- X5 — lease. Service charge is integer pence.
ALTER TABLE `sites` ADD `lease_start` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `lease_end` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `break_clause` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `rent_review` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `service_charge_pence` integer;--> statement-breakpoint

-- X11 — monday name reconciliation
ALTER TABLE `sites` ADD `monday_maintenance_name` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `monday_compliance_name` text;--> statement-breakpoint

ALTER TABLE `sites` ADD `notes` text;--> statement-breakpoint

-- Carry the Stage 0 values across so no site loses its type or lifecycle.
-- `lifecycle` held only 'Current' or 'Closed'; 'international' and 'other' are
-- resolved from `region` where it is already recorded.
UPDATE `sites` SET `site_type_value` = `type` WHERE `site_type_value` IS NULL;--> statement-breakpoint
UPDATE `sites` SET `status` = 'closed' WHERE `lifecycle` = 'Closed';--> statement-breakpoint
UPDATE `sites` SET `status` = 'international' WHERE `lifecycle` <> 'Closed' AND `region` = 'Europe';--> statement-breakpoint
UPDATE `sites` SET `status` = 'other' WHERE `lifecycle` <> 'Closed' AND `region` = 'Other';--> statement-breakpoint
UPDATE `sites` SET `address_line1` = `address` WHERE `address_line1` IS NULL;--> statement-breakpoint
UPDATE `sites` SET `manager_name` = `manager` WHERE `manager_name` IS NULL;--> statement-breakpoint
UPDATE `sites` SET `slug` = lower(replace(replace(replace(`name`, ' ', '-'), '/', '-'), '.', '')) WHERE `slug` IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `sites_organisation_status_idx` ON `sites` (`organisation_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sites_organisation_position_idx` ON `sites` (`organisation_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sites_organisation_slug_idx` ON `sites` (`organisation_id`,`slug`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- W5 — units and service history
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `units` ADD `asset_tag` text;--> statement-breakpoint
ALTER TABLE `units` ADD `location_in_site` text;--> statement-breakpoint
ALTER TABLE `units` ADD `installed_at` text;--> statement-breakpoint
ALTER TABLE `units` ADD `warranty_expiry` text;--> statement-breakpoint
ALTER TABLE `units` ADD `purchase_price_pence` integer;--> statement-breakpoint
ALTER TABLE `units` ADD `supplier` text;--> statement-breakpoint
ALTER TABLE `units` ADD `last_serviced_at` text;--> statement-breakpoint
ALTER TABLE `units` ADD `next_service_due_at` text;--> statement-breakpoint
ALTER TABLE `units` ADD `service_interval_months` integer;--> statement-breakpoint
ALTER TABLE `units` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `units_next_service_idx` ON `units` (`organisation_id`,`next_service_due_at`);--> statement-breakpoint

ALTER TABLE `attachments` ADD `unit_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attachments_unit_idx` ON `attachments` (`unit_id`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `unit_service_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
	`unit_id` text NOT NULL REFERENCES `units`(`id`),
	`site_id` text NOT NULL REFERENCES `sites`(`id`),
	`performed_at` text NOT NULL,
	`service_type` text DEFAULT 'Service' NOT NULL,
	`contractor_id` text,
	`contractor_name` text,
	`request_id` text,
	`outcome` text,
	`cost_pence` integer,
	`notes` text,
	`recorded_by_email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unit_service_unit_idx` ON `unit_service_records` (`unit_id`,`performed_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `unit_service_organisation_idx` ON `unit_service_records` (`organisation_id`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- X11 — aliases
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `site_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
	`site_id` text NOT NULL REFERENCES `sites`(`id`),
	`alias` text NOT NULL,
	`normalised` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_aliases_site_idx` ON `site_aliases` (`site_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_aliases_organisation_normalised_idx` ON `site_aliases` (`organisation_id`,`normalised`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- X14 — reporting groups and regions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `site_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'region' NOT NULL,
	`colour_hex` text DEFAULT '#12B4A8' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_groups_organisation_slug_idx` ON `site_groups` (`organisation_id`,`slug`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_groups_organisation_position_idx` ON `site_groups` (`organisation_id`,`position`);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `site_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
	`site_group_id` text NOT NULL REFERENCES `site_groups`(`id`),
	`site_id` text NOT NULL REFERENCES `sites`(`id`),
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_group_members_pair_idx` ON `site_group_members` (`site_group_id`,`site_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_group_members_site_idx` ON `site_group_members` (`site_id`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- X12/X13 — import anomaly log. Nothing is corrected silently.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `import_anomalies` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
	`batch_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`source_name` text,
	`kind` text NOT NULL,
	`field` text,
	`original_value` text,
	`applied_value` text,
	`detail` text,
	`resolved` integer DEFAULT 0 NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_anomalies_organisation_idx` ON `import_anomalies` (`organisation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_anomalies_batch_idx` ON `import_anomalies` (`batch_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_anomalies_resolved_idx` ON `import_anomalies` (`organisation_id`,`resolved`);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- M8 — site_status is a seeded option set, not an enum, so an admin can add a
-- sixth status without a deploy. Seeded per organisation by the runtime helper.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO `option_sets` (`id`, `organisation_id`, `key`, `name`, `description`)
SELECT 'set-site-status', `id`, 'site_status', 'Site status', 'Lifecycle state of a site'
FROM `organisations` WHERE `id` = 'org_000000000000000000000001';--> statement-breakpoint
INSERT OR IGNORE INTO `option_sets` (`id`, `organisation_id`, `key`, `name`, `description`)
SELECT 'set-site-group-kind', `id`, 'site_group_kind', 'Site group kind', 'Category of site grouping used for reporting'
FROM `organisations` WHERE `id` = 'org_000000000000000000000001';
