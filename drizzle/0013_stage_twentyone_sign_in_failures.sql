-- Failed sign-in throttling, moved out of isolate memory.
--
-- The limiter was a `Map` in module scope: five attempts per Worker isolate,
-- across as many isolates as Cloudflare chose to run, zeroed on every deploy.
-- This table is the shared counter that makes the limit mean what it says.
--
-- Times are epoch milliseconds rather than the TEXT timestamps used elsewhere,
-- because the window restart and lockout are computed inside a single
-- ON CONFLICT DO UPDATE statement and integer comparison there is exact.
CREATE TABLE IF NOT EXISTS sign_in_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sign_in_failures_expiry_idx
  ON sign_in_failures(blocked_until, first_at);
