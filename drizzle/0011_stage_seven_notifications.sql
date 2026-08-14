-- Stage 7 — Notifications
--
-- Additive. No table or column dropped, no row deleted.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  channel TEXT NOT NULL,
  event TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  provider_id TEXT,
  -- Set once the message is accepted by the provider. A row with a null value
  -- and attempts > 0 is a delivery that needs chasing.
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_log_org_idx
  ON notification_log(organisation_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_log_subject_idx
  ON notification_log(organisation_id, subject_type, subject_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_log_pending_idx
  ON notification_log(organisation_id, status);

-- J6 — visible delivery state on the records people actually look at.
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN notified_at TEXT;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN notified_at TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;

-- Compliance expiry alerting needs somewhere to record that a warning has
-- already gone out, or every scan re-sends the same alert.
--> statement-breakpoint
ALTER TABLE compliance_documents ADD COLUMN last_alert_at TEXT;
--> statement-breakpoint
ALTER TABLE compliance_documents ADD COLUMN last_alert_stage TEXT;
