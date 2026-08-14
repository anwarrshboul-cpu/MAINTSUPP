ALTER TABLE `organisations` ADD `logo_url` text;
--> statement-breakpoint
ALTER TABLE `organisations` ADD `primary_colour` text DEFAULT '#12B4A8' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organisations` ADD `plan_tier` text DEFAULT 'development' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organisations` ADD `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
INSERT INTO `organisations` (`id`, `name`, `slug`, `primary_colour`, `plan_tier`, `status`)
SELECT 'org_000000000000000000000001', 'Sunnamusk UK', 'sunnamusk-uk', '#12B4A8', 'development', 'active'
WHERE NOT EXISTS (SELECT 1 FROM `organisations`);
--> statement-breakpoint

ALTER TABLE `sites` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `units` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `planned_maintenance` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `quotations` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `system_notifications` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `leads` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `activity_log` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `attachments` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `compliance_documents` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_groups` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_group_items` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_board_options` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_board_columns` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint
ALTER TABLE `maintenance_board_cells` ADD `organisation_id` text REFERENCES `organisations`(`id`);
--> statement-breakpoint

UPDATE `users` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `contractors` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `sites` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `units` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_requests` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `planned_maintenance` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `quotations` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `invoices` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `system_notifications` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `leads` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `activity_log` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `attachments` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `compliance_documents` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `workspace_settings` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_groups` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_group_items` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_board_options` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_board_columns` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint
UPDATE `maintenance_board_cells` SET `organisation_id` = 'org_000000000000000000000001' WHERE `organisation_id` IS NULL;
--> statement-breakpoint

UPDATE `maintenance_requests` SET `requester` = 'Sample Manager A' WHERE `requester` = 'Valentina Colangelo';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `requester` = 'Sample Manager B' WHERE `requester` = 'Maria Ramos';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `requester` = 'Sample Manager C' WHERE `requester` = 'Qasim Malik';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `requester` = 'Sample Manager D' WHERE `requester` = 'Joseph Cole';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `requester` = 'Sample Manager E' WHERE `requester` = 'Laura Fox';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `requester` = 'Sample Manager F' WHERE `requester` = 'Amrik Sahota';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `assignee` = 'Sample Coordinator A' WHERE `assignee` = 'Alex Morgan';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `assignee` = 'Sample Coordinator B' WHERE `assignee` = 'Amelia Shah';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900000' WHERE `contact` = '+44 7700 900148';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900001' WHERE `contact` = '+44 7700 900147';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900002' WHERE `contact` = '+44 7700 900146';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900003' WHERE `contact` = '+44 7700 900145';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900004' WHERE `contact` = '+44 7700 900142';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900005' WHERE `contact` = '+44 7700 900141';
--> statement-breakpoint
UPDATE `maintenance_requests` SET `contact` = '+44 7700 900006' WHERE `contact` = '+44 7700 900140';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager A' WHERE `manager` = 'Valentina Colangelo';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager B' WHERE `manager` = 'Maria Ramos';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager C' WHERE `manager` = 'Qasim Malik';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager D' WHERE `manager` = 'Joseph Cole';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager E' WHERE `manager` = 'Laura Fox';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager F' WHERE `manager` = 'Amrik Sahota';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager G' WHERE `manager` = 'Nadia Ahmed';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager H' WHERE `manager` = 'Emily Stone';
--> statement-breakpoint
UPDATE `sites` SET `manager` = 'Sample Manager I' WHERE `manager` = 'Mali Patel';
--> statement-breakpoint
UPDATE `users` SET `full_name` = 'Sample Admin', `email` = 'sample-admin@maintsupp.local' WHERE `email` = 'alex@maintsupp.com';
--> statement-breakpoint
UPDATE `users` SET `full_name` = 'Sample Client User', `email` = 'sample-client@maintsupp.local' WHERE `email` = 'maria@sunnamusk.com';
--> statement-breakpoint

CREATE INDEX `sites_organisation_idx` ON `sites` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `units_organisation_idx` ON `units` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `maintenance_organisation_stage_idx` ON `maintenance_requests` (`organisation_id`, `stage`);
--> statement-breakpoint
CREATE INDEX `planned_maintenance_organisation_idx` ON `planned_maintenance` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `quotations_organisation_idx` ON `quotations` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `invoices_organisation_idx` ON `invoices` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `system_notifications_organisation_idx` ON `system_notifications` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `leads_organisation_idx` ON `leads` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `activity_organisation_idx` ON `activity_log` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `attachments_organisation_idx` ON `attachments` (`organisation_id`);
--> statement-breakpoint
CREATE INDEX `compliance_organisation_idx` ON `compliance_documents` (`organisation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_settings_organisation_idx` ON `workspace_settings` (`organisation_id`);
--> statement-breakpoint

DROP INDEX `maintenance_groups_board_position_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_groups_board_position_idx` ON `maintenance_groups` (`organisation_id`, `board_id`, `position`);
--> statement-breakpoint
DROP INDEX `maintenance_board_options_value_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_options_value_idx` ON `maintenance_board_options` (`organisation_id`, `board_id`, `column_key`, `value`);
--> statement-breakpoint
DROP INDEX `maintenance_board_columns_key_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_columns_key_idx` ON `maintenance_board_columns` (`organisation_id`, `board_id`, `column_key`);
--> statement-breakpoint
DROP INDEX `maintenance_board_cells_value_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_cells_value_idx` ON `maintenance_board_cells` (`organisation_id`, `board_id`, `request_id`, `column_id`);
--> statement-breakpoint

CREATE TABLE `memberships` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
  `role` text NOT NULL,
  `site_scope` text,
  `approval_limit_pence` integer,
  `status` text DEFAULT 'active' NOT NULL,
  `invited_by` text,
  `accepted_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_organisation_idx` ON `memberships` (`user_id`, `organisation_id`);
--> statement-breakpoint
CREATE INDEX `memberships_organisation_idx` ON `memberships` (`organisation_id`);
--> statement-breakpoint
INSERT INTO `memberships` (`id`, `user_id`, `organisation_id`, `role`, `site_scope`, `approval_limit_pence`, `status`, `accepted_at`)
SELECT 'membership-' || `id`, `id`, `organisation_id`,
  CASE lower(`role`)
    WHEN 'super admin' THEN 'super_admin'
    WHEN 'admin' THEN 'admin'
    ELSE 'client'
  END,
  NULL, NULL, 'active', CURRENT_TIMESTAMP
FROM `users`
WHERE `organisation_id` IS NOT NULL
ON CONFLICT (`user_id`, `organisation_id`) DO NOTHING;
--> statement-breakpoint

CREATE TABLE `option_sets` (
  `id` text PRIMARY KEY NOT NULL,
  `organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `option_sets_organisation_key_idx` ON `option_sets` (`organisation_id`, `key`);
--> statement-breakpoint
CREATE TABLE `option_values` (
  `id` text PRIMARY KEY NOT NULL,
  `organisation_id` text NOT NULL REFERENCES `organisations`(`id`),
  `option_set_id` text NOT NULL REFERENCES `option_sets`(`id`),
  `value` text NOT NULL,
  `label` text NOT NULL,
  `colour_hex` text NOT NULL,
  `text_colour` text DEFAULT '#ffffff' NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `is_done` integer DEFAULT 0 NOT NULL,
  `is_default` integer DEFAULT 0 NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `system` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `option_values_set_position_idx` ON `option_values` (`organisation_id`, `option_set_id`, `position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `option_values_set_value_idx` ON `option_values` (`organisation_id`, `option_set_id`, `value`);
--> statement-breakpoint

INSERT INTO `option_sets` (`id`, `organisation_id`, `key`, `name`, `description`) VALUES
('set-maintenance-status', 'org_000000000000000000000001', 'maintenance_status', 'Maintenance status', 'Workflow states for maintenance tickets'),
('set-maintenance-label', 'org_000000000000000000000001', 'maintenance_label', 'Maintenance label', 'Maintenance issue labels'),
('set-engineer-required', 'org_000000000000000000000001', 'engineer_required', 'Engineer required', 'Trade or engineer requirement'),
('set-priority', 'org_000000000000000000000001', 'priority', 'Priority', 'Maintenance request priority'),
('set-tier-level', 'org_000000000000000000000001', 'tier_level', 'Tier level', 'Service tier'),
('set-site-type', 'org_000000000000000000000001', 'site_type', 'Site type', 'Property or operating-unit type');
--> statement-breakpoint

INSERT INTO `option_values` (`id`, `organisation_id`, `option_set_id`, `value`, `label`, `colour_hex`, `text_colour`, `position`, `is_done`, `is_default`, `active`, `system`) VALUES
('status-pending-approval','org_000000000000000000000001','set-maintenance-status','Pending Approval','Pending Approval','#ff7575','#ffffff',0,0,0,1,1),
('status-pending-scheduling','org_000000000000000000000001','set-maintenance-status','Pending Scheduling','Pending Scheduling','#fdab3d','#ffffff',1,0,0,1,1),
('status-job-scheduled','org_000000000000000000000001','set-maintenance-status','Job Scheduled','Job Scheduled','#d0bb39','#ffffff',2,0,0,1,1),
('status-job-in-progress','org_000000000000000000000001','set-maintenance-status','Job In Progress','Job In Progress','#b18cfa','#ffffff',3,0,0,1,1),
('status-job-completed','org_000000000000000000000001','set-maintenance-status','Job Completed','Job Completed','#00c875','#ffffff',4,1,0,1,1),
('status-blocked-response','org_000000000000000000000001','set-maintenance-status','Blocked – Awaiting Response','Blocked – Awaiting Response','#e2445c','#ffffff',5,0,0,1,1),
('status-landlord','org_000000000000000000000001','set-maintenance-status','Awaiting Landlord Approval','Awaiting Landlord Approval','#b6b6b6','#101820',6,0,0,1,1),
('status-parts','org_000000000000000000000001','set-maintenance-status','Waiting for parts','Waiting for parts','#ff008c','#ffffff',7,0,0,1,1),
('status-hs-hold','org_000000000000000000000001','set-maintenance-status','Health And Safety Hold','Health And Safety Hold','#ffcb00','#101820',8,0,0,1,1),
('status-payment','org_000000000000000000000001','set-maintenance-status','Waiting for payment','Waiting for payment','#333333','#ffffff',9,0,0,1,1),
('status-decisions','org_000000000000000000000001','set-maintenance-status','Waiting for decisions','Waiting for decisions','#c32f56','#ffffff',10,0,0,1,1),
('status-access','org_000000000000000000000001','set-maintenance-status','Awaiting Access','Awaiting Access','#ff52bd','#ffffff',11,0,0,1,1),
('status-escalated','org_000000000000000000000001','set-maintenance-status','Escalated','Escalated','#7e4ecf','#ffffff',12,0,0,1,1),
('status-major','org_000000000000000000000001','set-maintenance-status','Major works','Major works','#a25ddc','#ffffff',13,0,0,1,1),
('status-third-party','org_000000000000000000000001','set-maintenance-status','Third Party Delay','Third Party Delay','#9cd326','#101820',14,0,0,1,1),
('status-quote-requested','org_000000000000000000000001','set-maintenance-status','Quote requested','Quote requested','#61caf0','#101820',15,0,0,1,1),
('status-quote-received','org_000000000000000000000001','set-maintenance-status','Quote Received (waiting for Approval)','Quote Received (waiting for Approval)','#ff8f9a','#101820',16,0,0,1,1),
('status-quote-approved','org_000000000000000000000001','set-maintenance-status','Quote approved','Quote approved','#808080','#ffffff',17,0,0,1,1),
('status-quote-rejected','org_000000000000000000000001','set-maintenance-status','Quote rejected','Quote rejected','#8a5044','#ffffff',18,0,0,1,1),
('status-deposit-received','org_000000000000000000000001','set-maintenance-status','Deposit Invoice Received','Deposit Invoice Received','#ff642e','#ffffff',19,0,0,1,1),
('status-deposit-paid','org_000000000000000000000001','set-maintenance-status','Deposit Invoice Paid','Deposit Invoice Paid','#e881e8','#101820',20,0,0,1,1),
('status-completion-received','org_000000000000000000000001','set-maintenance-status','Completion Invoice Received','Completion Invoice Received','#0086c0','#ffffff',21,0,0,1,1),
('status-completion-paid','org_000000000000000000000001','set-maintenance-status','Completion Invoice Paid','Completion Invoice Paid','#7e3f98','#ffffff',22,0,0,1,1),
('label-locks','org_000000000000000000000001','set-maintenance-label','Locks','Locks','#9aafbf','#101820',0,0,0,1,1),
('label-signboard','org_000000000000000000000001','set-maintenance-label','Signboard','Signboard','#00c875','#ffffff',1,0,0,1,1),
('label-glass','org_000000000000000000000001','set-maintenance-label','Glass','Glass','#a9a4c7','#101820',2,0,0,1,1),
('label-hinges','org_000000000000000000000001','set-maintenance-label','Hinges','Hinges','#0086c0','#ffffff',3,0,0,1,1),
('label-diffuser','org_000000000000000000000001','set-maintenance-label','Diffuser','Diffuser','#a25ddc','#ffffff',4,0,0,1,1),
('label-vinyls','org_000000000000000000000001','set-maintenance-label','Vinyls','Vinyls','#037f4c','#ffffff',5,0,0,1,1),
('label-acrylic','org_000000000000000000000001','set-maintenance-label','Acrylic','Acrylic','#579bfc','#ffffff',6,0,0,1,1),
('label-paint','org_000000000000000000000001','set-maintenance-label','Paint','Paint','#d0bb39','#101820',7,0,0,1,1),
('label-replacement','org_000000000000000000000001','set-maintenance-label','Replacement parts','Replacement parts','#ffcb00','#101820',8,0,0,1,1),
('label-lights','org_000000000000000000000001','set-maintenance-label','Lights','Lights','#c32f56','#ffffff',9,0,0,1,1),
('label-display','org_000000000000000000000001','set-maintenance-label','TV/Display','TV/Display','#ff008c','#ffffff',10,0,0,1,1),
('label-shelves','org_000000000000000000000001','set-maintenance-label','Shelves','Shelves','#ff52bd','#ffffff',11,0,0,1,1),
('label-ac','org_000000000000000000000001','set-maintenance-label','AC','AC','#7e4ecf','#ffffff',12,0,0,1,1),
('label-drawers','org_000000000000000000000001','set-maintenance-label','Drawers','Drawers','#9cd326','#101820',13,0,0,1,1),
('label-cctv','org_000000000000000000000001','set-maintenance-label','CCTV','CCTV','#61caf0','#101820',14,0,0,1,1),
('label-other','org_000000000000000000000001','set-maintenance-label','Other','Other','#333333','#ffffff',15,0,0,1,1),
('label-blank','org_000000000000000000000001','set-maintenance-label','','(blank)','#6b7a86','#ffffff',16,0,0,1,1),
('engineer-handyman','org_000000000000000000000001','set-engineer-required','Handyman','Handyman','#fdab3d','#101820',0,0,0,1,1),
('engineer-electrician','org_000000000000000000000001','set-engineer-required','Electrician','Electrician','#00c875','#ffffff',1,0,0,1,1),
('engineer-plummer','org_000000000000000000000001','set-engineer-required','Plummer','Plummer','#e2445c','#ffffff',2,0,0,1,1),
('engineer-other','org_000000000000000000000001','set-engineer-required','Other','Other','#0086c0','#ffffff',3,0,0,1,1),
('priority-urgent','org_000000000000000000000001','set-priority','Urgent','Urgent','#e2445c','#ffffff',0,0,0,1,1),
('priority-medium','org_000000000000000000000001','set-priority','Medium','Medium','#fdab3d','#101820',1,0,1,1,1),
('priority-low','org_000000000000000000000001','set-priority','Low','Low','#00c875','#ffffff',2,0,0,1,1),
('tier-1','org_000000000000000000000001','set-tier-level','1','Tier 1','#d9ecfb','#456579',0,0,0,1,1),
('tier-2','org_000000000000000000000001','set-tier-level','2','Tier 2','#d9ecfb','#456579',1,0,1,1,1),
('tier-3','org_000000000000000000000001','set-tier-level','3','Tier 3','#d9ecfb','#456579',2,0,0,1,1),
('tier-4','org_000000000000000000000001','set-tier-level','4','Tier 4','#d9ecfb','#456579',3,0,0,1,1),
('site-inline','org_000000000000000000000001','set-site-type','Inline','Inline','#12B4A8','#101820',0,0,1,1,1),
('site-kiosk','org_000000000000000000000001','set-site-type','Kiosk','Kiosk','#579bfc','#ffffff',1,0,0,1,1),
('site-office','org_000000000000000000000001','set-site-type','Office','Office','#a25ddc','#ffffff',2,0,0,1,1),
('site-warehouse','org_000000000000000000000001','set-site-type','Warehouse','Warehouse','#fdab3d','#101820',3,0,0,1,1);
--> statement-breakpoint

INSERT INTO `option_values` (`id`, `organisation_id`, `option_set_id`, `value`, `label`, `colour_hex`, `text_colour`, `position`, `is_done`, `is_default`, `active`, `system`)
SELECT 'legacy-' || `id`, `organisation_id`,
  CASE `column_key`
    WHEN 'status' THEN 'set-maintenance-status'
    WHEN 'label' THEN 'set-maintenance-label'
    WHEN 'engineer' THEN 'set-engineer-required'
    WHEN 'priority' THEN 'set-priority'
    WHEN 'tier' THEN 'set-tier-level'
  END,
  `value`, `label`, `color`, `text_color`, `position`, 0, 0, `active`, `system`
FROM `maintenance_board_options`
WHERE `column_key` IN ('status','label','engineer','priority','tier')
ON CONFLICT (`organisation_id`, `option_set_id`, `value`) DO NOTHING;
