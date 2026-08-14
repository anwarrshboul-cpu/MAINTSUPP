-- Stage 9 — Contractor job links (Group Z)
--
-- Additive. No table or column dropped, no row deleted.
--
-- The existing publicUploadTokenHash on maintenance_requests stays exactly as
-- it is: it serves the reporter attaching fault photos immediately after
-- submitting the public form. This table serves a different audience with a
-- different scope, and keeping them separate means the reporter flow cannot be
-- broken by a change to the contractor flow.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS job_access_tokens (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  request_id TEXT NOT NULL,
  -- SHA-256 of the token. The plaintext is returned once at creation and is
  -- never stored or logged.
  token_hash TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'contractor',
  label TEXT,
  -- JSON array of the evidence kinds this link may upload.
  allowed_kinds TEXT NOT NULL DEFAULT '["completion","nameplate"]',
  can_comment INTEGER NOT NULL DEFAULT 1,
  can_request_completion INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT,
  first_opened_at TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS job_access_tokens_hash_idx
  ON job_access_tokens(token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS job_access_tokens_request_idx
  ON job_access_tokens(organisation_id, request_id);

-- Z12 — uploads through a public link land here first. A coordinator accepts
-- or rejects before they join the job's evidence record.
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN submitted_via TEXT;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN reviewed_at TEXT;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN reviewed_by TEXT;

-- Z10 — the contractor requests completion; a coordinator accepts.
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN completion_requested_at TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN completion_requested_by TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN completion_note TEXT;
--> statement-breakpoint
ALTER TABLE maintenance_requests ADD COLUMN blocked_reason TEXT;
