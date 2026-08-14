-- Password resets: a single-use, expiring link that reopens one account.
--
-- Shaped like `invitations` on purpose. Both are credentials handed to one
-- person out of band, both store only a hash, both can expire and be revoked.
-- Kept in their own table rather than as a `kind` column on invitations,
-- because the two answer different questions — an invitation creates an
-- account, a reset re-opens one — and a shared table would need every query on
-- both sides to remember to filter.
--
-- `db/init.ts` creates this on the boot path as well; this file exists so a
-- deployment that runs migrations gets the same shape.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  organisation_id TEXT REFERENCES organisations(id),
  token_hash TEXT NOT NULL,
  issued_by TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_idx
  ON password_resets(token_hash);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON password_resets(user_id, created_at);
