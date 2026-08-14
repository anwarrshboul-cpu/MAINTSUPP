CREATE TABLE `contractors` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`service_categories` text DEFAULT '[]' NOT NULL,
	`coverage_areas` text DEFAULT '[]' NOT NULL,
	`certifications` text DEFAULT '[]' NOT NULL,
	`insurance_expiry` text,
	`availability` text DEFAULT 'Available' NOT NULL,
	`rating` real,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contractors_organisation_idx` ON `contractors` (`organisation_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`contractor_id` text,
	`invoice_number` text,
	`amount` real NOT NULL,
	`status` text DEFAULT 'Awaiting payment' NOT NULL,
	`due_at` text,
	`paid_at` text,
	`attachment_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoices_request_idx` ON `invoices` (`request_id`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`company` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`site_range` text NOT NULL,
	`services` text NOT NULL,
	`regions` text NOT NULL,
	`challenge` text NOT NULL,
	`status` text DEFAULT 'New' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `leads_created_idx` ON `leads` (`created_at`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organisations_slug_unique` ON `organisations` (`slug`);--> statement-breakpoint
CREATE TABLE `planned_maintenance` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`site_id` text NOT NULL,
	`unit_id` text,
	`contractor_id` text,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`frequency` text NOT NULL,
	`next_due_at` text NOT NULL,
	`last_completed_at` text,
	`status` text DEFAULT 'Scheduled' NOT NULL,
	`reminder_days` integer DEFAULT 30 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `planned_maintenance_site_idx` ON `planned_maintenance` (`site_id`);--> statement-breakpoint
CREATE INDEX `planned_maintenance_due_idx` ON `planned_maintenance` (`next_due_at`);--> statement-breakpoint
CREATE TABLE `quotations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`contractor_id` text,
	`amount` real NOT NULL,
	`status` text DEFAULT 'Awaiting approval' NOT NULL,
	`attachment_id` text,
	`submitted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contractor_id`) REFERENCES `contractors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `quotations_request_idx` ON `quotations` (`request_id`);--> statement-breakpoint
CREATE TABLE `system_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`event` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_notifications_user_idx` ON `system_notifications` (`user_email`,`read_at`);--> statement-breakpoint
CREATE INDEX `system_notifications_entity_idx` ON `system_notifications` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`manufacturer` text,
	`model` text,
	`serial_number` text,
	`status` text DEFAULT 'Active' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `units_site_idx` ON `units` (`site_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text,
	`email` text NOT NULL,
	`full_name` text,
	`role` text DEFAULT 'client_user' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_organisation_idx` ON `users` (`organisation_id`);