CREATE TABLE "activity_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_email" text,
	"detail" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"request_id" text,
	"site_id" text,
	"unit_id" text,
	"kind" text DEFAULT 'issue' NOT NULL,
	"board_column_id" text,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"uploaded_by_email" text,
	"pending" boolean DEFAULT false NOT NULL,
	"submitted_via" text,
	"reviewed_at" text,
	"reviewed_by" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "attachments_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "board_views" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'table' NOT NULL,
	"icon" text,
	"filters" text DEFAULT '[]' NOT NULL,
	"sort" text DEFAULT '[]' NOT NULL,
	"settings" text DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'maintenance' NOT NULL,
	"item_noun" text DEFAULT 'Job' NOT NULL,
	"reference_prefix" text DEFAULT 'MS' NOT NULL,
	"reference_counter" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"site_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'Missing' NOT NULL,
	"expiry_date" text,
	"attachment_id" text,
	"not_required" boolean DEFAULT false NOT NULL,
	"last_alert_at" text,
	"last_alert_stage" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"service_categories" text DEFAULT '[]' NOT NULL,
	"coverage_areas" text DEFAULT '[]' NOT NULL,
	"certifications" text DEFAULT '[]' NOT NULL,
	"insurance_expiry" text,
	"availability" text DEFAULT 'Available' NOT NULL,
	"rating" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_anomalies" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"source_name" text,
	"kind" text NOT NULL,
	"field" text,
	"original_value" text,
	"applied_value" text,
	"detail" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_by" text,
	"resolved_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"contractor_id" text,
	"invoice_number" text,
	"amount" double precision NOT NULL,
	"status" text DEFAULT 'Awaiting payment' NOT NULL,
	"due_at" text,
	"paid_at" text,
	"attachment_id" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"request_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"column_key" text,
	"action" text NOT NULL,
	"value_before" text,
	"value_after" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"request_id" text NOT NULL,
	"parent_id" text,
	"author_name" text NOT NULL,
	"author_email" text,
	"body" text NOT NULL,
	"edited_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"audience" text DEFAULT 'contractor' NOT NULL,
	"label" text,
	"allowed_kinds" text DEFAULT '["completion","nameplate"]' NOT NULL,
	"can_comment" boolean DEFAULT true NOT NULL,
	"can_request_completion" boolean DEFAULT true NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_by" text,
	"first_opened_at" text,
	"last_used_at" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"name" text NOT NULL,
	"company" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"site_range" text NOT NULL,
	"services" text NOT NULL,
	"regions" text NOT NULL,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'New' NOT NULL,
	"notified_at" text,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_board_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"request_id" text NOT NULL,
	"column_id" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_board_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"column_key" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"width" integer DEFAULT 160 NOT NULL,
	"settings" text DEFAULT '{}' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"summary" text,
	"option_set_key" text,
	"description" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_board_options" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"column_key" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#579bfc' NOT NULL,
	"text_color" text DEFAULT '#ffffff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_group_items" (
	"request_id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"group_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"board_id" text DEFAULT 'maintenance' NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#579bfc' NOT NULL,
	"stage_key" text,
	"collapsed" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"site_id" text NOT NULL,
	"source" text DEFAULT 'Portal form' NOT NULL,
	"title" text NOT NULL,
	"reference" text,
	"completion_requested_at" text,
	"completion_requested_by" text,
	"completion_note" text,
	"blocked_reason" text,
	"notified_at" text,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"parent_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" text,
	"description" text NOT NULL,
	"location" text NOT NULL,
	"requester" text NOT NULL,
	"contact" text NOT NULL,
	"category" text NOT NULL,
	"engineer" text NOT NULL,
	"tier" integer DEFAULT 2 NOT NULL,
	"priority" text DEFAULT 'Medium' NOT NULL,
	"stage" text DEFAULT 'Incoming' NOT NULL,
	"status" text DEFAULT 'Pending Approval' NOT NULL,
	"contractor" text,
	"assignee" text,
	"requested_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"due_at" text,
	"completed_at" text,
	"next_update_at" text,
	"cost" double precision,
	"approved_by" text,
	"invoice" text,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"issue_attachment_count" integer DEFAULT 0 NOT NULL,
	"completed_attachment_count" integer DEFAULT 0 NOT NULL,
	"general_attachment_count" integer DEFAULT 0 NOT NULL,
	"form_url" text,
	"public_upload_token_hash" text,
	"public_upload_token_expires_at" text,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"created_by_email" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organisation_id" text NOT NULL,
	"role" text NOT NULL,
	"site_scope" text,
	"approval_limit_pence" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" text,
	"accepted_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"recipient" text NOT NULL,
	"subject" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_id" text,
	"delivered_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_values" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"option_set_id" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"colour_hex" text NOT NULL,
	"text_colour" text DEFAULT '#ffffff' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_url" text,
	"primary_colour" text DEFAULT '#12B4A8' NOT NULL,
	"plan_tier" text DEFAULT 'development' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "planned_maintenance" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"site_id" text NOT NULL,
	"unit_id" text,
	"contractor_id" text,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"frequency" text NOT NULL,
	"next_due_at" text NOT NULL,
	"last_completed_at" text,
	"status" text DEFAULT 'Scheduled' NOT NULL,
	"reminder_days" integer DEFAULT 30 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"contractor_id" text,
	"amount" double precision NOT NULL,
	"status" text DEFAULT 'Awaiting approval' NOT NULL,
	"attachment_id" text,
	"submitted_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"approved_at" text
);
--> statement-breakpoint
CREATE TABLE "site_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"site_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalised" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"site_group_id" text NOT NULL,
	"site_id" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'region' NOT NULL,
	"colour_hex" text DEFAULT '#12B4A8' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"client_id" text DEFAULT 'sunnamusk-uk' NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"region" text DEFAULT 'UK' NOT NULL,
	"lifecycle" text DEFAULT 'Current' NOT NULL,
	"address" text NOT NULL,
	"manager" text,
	"slug" text,
	"code" text,
	"site_type_value" text,
	"status" text DEFAULT 'active' NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postcode" text,
	"country" text DEFAULT 'United Kingdom' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"manager_name" text,
	"manager_phone" text,
	"manager_email" text,
	"landlord" text,
	"managing_agent" text,
	"out_of_hours_contact" text,
	"access_method" text,
	"access_contact" text,
	"access_url" text,
	"access_notes" text,
	"opening_hours" text,
	"delivery_restrictions" text,
	"parking_notes" text,
	"key_alarm_notes" text,
	"lease_start" text,
	"lease_end" text,
	"break_clause" text,
	"rent_review" text,
	"service_charge_pence" integer,
	"monday_maintenance_name" text,
	"monday_compliance_name" text,
	"notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"user_email" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"read_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_service_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"unit_id" text NOT NULL,
	"site_id" text NOT NULL,
	"performed_at" text NOT NULL,
	"service_type" text DEFAULT 'Service' NOT NULL,
	"contractor_id" text,
	"contractor_name" text,
	"request_id" text,
	"outcome" text,
	"cost_pence" integer,
	"notes" text,
	"recorded_by_email" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"notes" text,
	"asset_tag" text,
	"location_in_site" text,
	"installed_at" text,
	"warranty_expiry" text,
	"purchase_price_pence" integer,
	"supplier" text,
	"last_serviced_at" text,
	"next_service_due_at" text,
	"service_interval_months" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"organisation_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"role" text DEFAULT 'client_user' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"client_id" text PRIMARY KEY DEFAULT 'sunnamusk-uk' NOT NULL,
	"organisation_id" text NOT NULL,
	"settings" text DEFAULT '{}' NOT NULL,
	"updated_by_email" text,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_views" ADD CONSTRAINT "board_views_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_anomalies" ADD CONSTRAINT "import_anomalies_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_activity" ADD CONSTRAINT "item_activity_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_updates" ADD CONSTRAINT "item_updates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_access_tokens" ADD CONSTRAINT "job_access_tokens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_board_cells" ADD CONSTRAINT "maintenance_board_cells_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_board_cells" ADD CONSTRAINT "maintenance_board_cells_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_board_cells" ADD CONSTRAINT "maintenance_board_cells_column_id_maintenance_board_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."maintenance_board_columns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_board_columns" ADD CONSTRAINT "maintenance_board_columns_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_board_options" ADD CONSTRAINT "maintenance_board_options_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_group_items" ADD CONSTRAINT "maintenance_group_items_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_group_items" ADD CONSTRAINT "maintenance_group_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_group_items" ADD CONSTRAINT "maintenance_group_items_group_id_maintenance_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."maintenance_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_groups" ADD CONSTRAINT "maintenance_groups_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_sets" ADD CONSTRAINT "option_sets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_values" ADD CONSTRAINT "option_values_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_values" ADD CONSTRAINT "option_values_option_set_id_option_sets_id_fk" FOREIGN KEY ("option_set_id") REFERENCES "public"."option_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_maintenance" ADD CONSTRAINT "planned_maintenance_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_maintenance" ADD CONSTRAINT "planned_maintenance_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_maintenance" ADD CONSTRAINT "planned_maintenance_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_maintenance" ADD CONSTRAINT "planned_maintenance_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_request_id_maintenance_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."maintenance_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_aliases" ADD CONSTRAINT "site_aliases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_aliases" ADD CONSTRAINT "site_aliases_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_members" ADD CONSTRAINT "site_group_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_members" ADD CONSTRAINT "site_group_members_site_group_id_site_groups_id_fk" FOREIGN KEY ("site_group_id") REFERENCES "public"."site_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_members" ADD CONSTRAINT "site_group_members_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_groups" ADD CONSTRAINT "site_groups_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_notifications" ADD CONSTRAINT "system_notifications_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_service_records" ADD CONSTRAINT "unit_service_records_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_service_records" ADD CONSTRAINT "unit_service_records_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_service_records" ADD CONSTRAINT "unit_service_records_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_organisation_idx" ON "activity_log" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "attachments_organisation_idx" ON "attachments" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "attachments_request_idx" ON "attachments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "attachments_site_idx" ON "attachments" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "attachments_unit_idx" ON "attachments" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "attachments_board_column_idx" ON "attachments" USING btree ("board_column_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_views_org_key_idx" ON "board_views" USING btree ("organisation_id","board_id","key");--> statement-breakpoint
CREATE INDEX "board_views_org_position_idx" ON "board_views" USING btree ("organisation_id","board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "boards_org_key_idx" ON "boards" USING btree ("organisation_id","key");--> statement-breakpoint
CREATE INDEX "boards_org_idx" ON "boards" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "compliance_organisation_idx" ON "compliance_documents" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "compliance_site_kind_idx" ON "compliance_documents" USING btree ("site_id","kind");--> statement-breakpoint
CREATE INDEX "compliance_expiry_idx" ON "compliance_documents" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "contractors_organisation_idx" ON "contractors" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "import_anomalies_organisation_idx" ON "import_anomalies" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "import_anomalies_batch_idx" ON "import_anomalies" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_anomalies_resolved_idx" ON "import_anomalies" USING btree ("organisation_id","resolved");--> statement-breakpoint
CREATE INDEX "invoices_organisation_idx" ON "invoices" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "invoices_request_idx" ON "invoices" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "item_activity_request_idx" ON "item_activity" USING btree ("organisation_id","request_id");--> statement-breakpoint
CREATE INDEX "item_updates_request_idx" ON "item_updates" USING btree ("organisation_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_access_tokens_hash_idx" ON "job_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "job_access_tokens_request_idx" ON "job_access_tokens" USING btree ("organisation_id","request_id");--> statement-breakpoint
CREATE INDEX "leads_organisation_idx" ON "leads" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "maintenance_board_cells_request_idx" ON "maintenance_board_cells" USING btree ("organisation_id","board_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_board_cells_value_idx" ON "maintenance_board_cells" USING btree ("organisation_id","board_id","request_id","column_id");--> statement-breakpoint
CREATE INDEX "maintenance_board_columns_position_idx" ON "maintenance_board_columns" USING btree ("organisation_id","board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_board_columns_key_idx" ON "maintenance_board_columns" USING btree ("organisation_id","board_id","column_key");--> statement-breakpoint
CREATE INDEX "maintenance_board_options_column_idx" ON "maintenance_board_options" USING btree ("organisation_id","board_id","column_key","position");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_board_options_value_idx" ON "maintenance_board_options" USING btree ("organisation_id","board_id","column_key","value");--> statement-breakpoint
CREATE INDEX "maintenance_group_items_group_idx" ON "maintenance_group_items" USING btree ("organisation_id","board_id","group_id","position");--> statement-breakpoint
CREATE INDEX "maintenance_groups_board_idx" ON "maintenance_groups" USING btree ("organisation_id","board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_groups_board_position_idx" ON "maintenance_groups" USING btree ("organisation_id","board_id","position");--> statement-breakpoint
CREATE INDEX "maintenance_organisation_stage_idx" ON "maintenance_requests" USING btree ("organisation_id","stage");--> statement-breakpoint
CREATE INDEX "maintenance_site_idx" ON "maintenance_requests" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "maintenance_priority_idx" ON "maintenance_requests" USING btree ("priority");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_organisation_idx" ON "memberships" USING btree ("user_id","organisation_id");--> statement-breakpoint
CREATE INDEX "memberships_organisation_idx" ON "memberships" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "notification_log_org_idx" ON "notification_log" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_log_subject_idx" ON "notification_log" USING btree ("organisation_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "option_sets_organisation_key_idx" ON "option_sets" USING btree ("organisation_id","key");--> statement-breakpoint
CREATE INDEX "option_values_set_position_idx" ON "option_values" USING btree ("organisation_id","option_set_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "option_values_set_value_idx" ON "option_values" USING btree ("organisation_id","option_set_id","value");--> statement-breakpoint
CREATE INDEX "planned_maintenance_organisation_idx" ON "planned_maintenance" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "planned_maintenance_site_idx" ON "planned_maintenance" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "planned_maintenance_due_idx" ON "planned_maintenance" USING btree ("next_due_at");--> statement-breakpoint
CREATE INDEX "quotations_organisation_idx" ON "quotations" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "quotations_request_idx" ON "quotations" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "site_aliases_site_idx" ON "site_aliases" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_aliases_organisation_normalised_idx" ON "site_aliases" USING btree ("organisation_id","normalised");--> statement-breakpoint
CREATE UNIQUE INDEX "site_group_members_pair_idx" ON "site_group_members" USING btree ("site_group_id","site_id");--> statement-breakpoint
CREATE INDEX "site_group_members_site_idx" ON "site_group_members" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_groups_organisation_slug_idx" ON "site_groups" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "site_groups_organisation_position_idx" ON "site_groups" USING btree ("organisation_id","position");--> statement-breakpoint
CREATE INDEX "sites_organisation_idx" ON "sites" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "sites_lifecycle_idx" ON "sites" USING btree ("lifecycle");--> statement-breakpoint
CREATE INDEX "sites_organisation_status_idx" ON "sites" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "sites_organisation_position_idx" ON "sites" USING btree ("organisation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_organisation_slug_idx" ON "sites" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "system_notifications_organisation_idx" ON "system_notifications" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "system_notifications_user_idx" ON "system_notifications" USING btree ("user_email","read_at");--> statement-breakpoint
CREATE INDEX "system_notifications_entity_idx" ON "system_notifications" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "unit_service_unit_idx" ON "unit_service_records" USING btree ("unit_id","performed_at");--> statement-breakpoint
CREATE INDEX "unit_service_organisation_idx" ON "unit_service_records" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "units_organisation_idx" ON "units" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "units_site_idx" ON "units" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "units_next_service_idx" ON "units" USING btree ("organisation_id","next_service_due_at");--> statement-breakpoint
CREATE INDEX "users_organisation_idx" ON "users" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_settings_organisation_idx" ON "workspace_settings" USING btree ("organisation_id");