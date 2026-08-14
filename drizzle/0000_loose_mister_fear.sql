CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_email` text,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_entity_idx` ON `activity_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `activity_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`request_id` text,
	`site_id` text,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`uploaded_by_email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `maintenance_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_object_key_unique` ON `attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `attachments_request_idx` ON `attachments` (`request_id`);--> statement-breakpoint
CREATE INDEX `attachments_site_idx` ON `attachments` (`site_id`);--> statement-breakpoint
CREATE TABLE `compliance_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`site_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'Missing' NOT NULL,
	`expiry_date` text,
	`attachment_id` text,
	`not_required` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `compliance_site_kind_idx` ON `compliance_documents` (`site_id`,`kind`);--> statement-breakpoint
CREATE INDEX `compliance_expiry_idx` ON `compliance_documents` (`expiry_date`);--> statement-breakpoint
CREATE TABLE `maintenance_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`site_id` text NOT NULL,
	`source` text DEFAULT 'Portal form' NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`location` text NOT NULL,
	`requester` text NOT NULL,
	`contact` text NOT NULL,
	`category` text NOT NULL,
	`engineer` text NOT NULL,
	`tier` integer DEFAULT 2 NOT NULL,
	`priority` text DEFAULT 'Medium' NOT NULL,
	`stage` text DEFAULT 'Incoming' NOT NULL,
	`status` text DEFAULT 'Triage in progress' NOT NULL,
	`contractor` text,
	`assignee` text,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`due_at` text,
	`completed_at` text,
	`next_update_at` text,
	`cost` real,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`created_by_email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_client_stage_idx` ON `maintenance_requests` (`client_id`,`stage`);--> statement-breakpoint
CREATE INDEX `maintenance_site_idx` ON `maintenance_requests` (`site_id`);--> statement-breakpoint
CREATE INDEX `maintenance_priority_idx` ON `maintenance_requests` (`priority`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT 'sunnamusk-uk' NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`region` text DEFAULT 'UK' NOT NULL,
	`lifecycle` text DEFAULT 'Current' NOT NULL,
	`address` text NOT NULL,
	`manager` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sites_client_idx` ON `sites` (`client_id`);--> statement-breakpoint
CREATE INDEX `sites_lifecycle_idx` ON `sites` (`lifecycle`);