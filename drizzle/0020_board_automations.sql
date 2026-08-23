-- Board automations — "When this happens, then do this".
--
-- Additive only. Two tables: the rules, and every time one fired or was
-- considered and skipped. Nothing existing is touched.
--
-- Shape notes, because they are deliberate rather than careless:
--   · `enabled` is TEXT 'on'/'off', not an integer boolean, and every
--     timestamp is an ISO string written by the application with no column
--     default. `db/sqlite-to-postgres.ts` rewrites booleans and timestamps per
--     column against the converted production schema it knows; a table it has
--     never heard of has to be plain text on both databases to behave the same
--     on both.
--   · Both tables are indexed by (organisation_id, board_id) because that is
--     the only way they are ever read — one board at a time, inside one
--     workspace.
--
-- `db/init.ts` creates the same tables on the boot path; this file exists so a
-- deployment that runs migrations gets the same shape.

CREATE TABLE IF NOT EXISTS board_automations (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  board_id TEXT NOT NULL DEFAULT 'maintenance',
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_config TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL,
  action_config TEXT NOT NULL DEFAULT '{}',
  enabled TEXT NOT NULL DEFAULT 'on',
  importance TEXT NOT NULL DEFAULT 'minor',
  description TEXT,
  created_by TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_sweep_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS board_automations_board_idx
  ON board_automations(organisation_id, board_id);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  automation_id TEXT NOT NULL,
  board_id TEXT NOT NULL DEFAULT 'maintenance',
  request_id TEXT,
  status TEXT NOT NULL,
  trigger_summary TEXT,
  action_summary TEXT,
  error TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  chain_id TEXT,
  dedupe_key TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS automation_runs_board_idx
  ON automation_runs(organisation_id, board_id, created_at);

CREATE INDEX IF NOT EXISTS automation_runs_rule_idx
  ON automation_runs(organisation_id, automation_id, dedupe_key);
