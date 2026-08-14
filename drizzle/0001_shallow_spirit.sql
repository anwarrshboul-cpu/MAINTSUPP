CREATE TABLE `maintenance_group_items` (
	`request_id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`board_id` text DEFAULT 'maintenance' NOT NULL,
	`group_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `maintenance_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `maintenance_group_items_group_idx` ON `maintenance_group_items` (`board_id`,`group_id`,`position`);--> statement-breakpoint
CREATE TABLE `maintenance_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`board_id` text DEFAULT 'maintenance' NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#579bfc' NOT NULL,
	`stage_key` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_groups_board_idx` ON `maintenance_groups` (`client_id`,`board_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_groups_board_position_idx` ON `maintenance_groups` (`board_id`,`position`);--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `approved_by` text;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `invoice` text;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `completed_attachment_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `maintenance_requests` ADD `form_url` text;