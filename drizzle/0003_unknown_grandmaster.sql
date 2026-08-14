CREATE TABLE `maintenance_board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`board_id` text DEFAULT 'maintenance' NOT NULL,
	`column_key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`width` integer DEFAULT 160 NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`system` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_board_columns_position_idx` ON `maintenance_board_columns` (`client_id`,`board_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_columns_key_idx` ON `maintenance_board_columns` (`client_id`,`board_id`,`column_key`);--> statement-breakpoint
CREATE TABLE `maintenance_board_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`board_id` text DEFAULT 'maintenance' NOT NULL,
	`request_id` text NOT NULL,
	`column_id` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`column_id`) REFERENCES `maintenance_board_columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `maintenance_board_cells_request_idx` ON `maintenance_board_cells` (`board_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_board_cells_value_idx` ON `maintenance_board_cells` (`board_id`,`request_id`,`column_id`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `board_column_id` text;--> statement-breakpoint
CREATE INDEX `attachments_board_column_idx` ON `attachments` (`board_column_id`,`request_id`);
