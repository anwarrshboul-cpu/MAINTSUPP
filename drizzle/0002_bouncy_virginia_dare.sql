CREATE TABLE `maintenance_board_options` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`board_id` text DEFAULT 'maintenance' NOT NULL,
	`column_key` text NOT NULL,
	`value` text NOT NULL,
	`label` text NOT NULL,
	`color` text DEFAULT '#579bfc' NOT NULL,
	`text_color` text DEFAULT '#ffffff' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`system` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_board_options_column_idx` ON `maintenance_board_options` (`client_id`,`board_id`,`column_key`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_options_value_idx` ON `maintenance_board_options` (`client_id`,`board_id`,`column_key`,`value`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `kind` text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `issue_attachment_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `maintenance_requests` SET `issue_attachment_count` = `attachment_count` WHERE `attachment_count` > 0;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `general_attachment_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `public_upload_token_hash` text;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `public_upload_token_expires_at` text;
