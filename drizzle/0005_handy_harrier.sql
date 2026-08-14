CREATE TABLE `workspace_settings` (
	`client_id` text PRIMARY KEY DEFAULT 'sunnamusk-uk' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_by_email` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
