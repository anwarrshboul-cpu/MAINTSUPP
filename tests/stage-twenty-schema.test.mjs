import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * Stage 20's schema contract.
 *
 * Five workstreams build on these seven tables at once, so the shape is fixed
 * here rather than negotiated. These tests are the contract: they fail if a
 * table, a column another workstream reads, or one of the security properties
 * below is changed without the change being deliberate.
 */

const TABLES = [
  "sessions",
  "invitations",
  "teams",
  "team_members",
  "role_capabilities",
  "audit_events",
  "navigation_layouts",
];

test("every Stage 20 table is declared and created at runtime", async () => {
  const schema = await read("db/schema.ts");
  const init = await read("db/init.ts");

  for (const table of TABLES) {
    assert.match(
      schema,
      new RegExp(`sqliteTable\\(\\s*\\n?\\s*"${table}"`),
      `${table} must be in the Drizzle schema`,
    );
    // Migrations do not run on the bootstrap path — a table that exists only in
    // schema.ts is a table the running database does not have.
    assert.match(
      init,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),
      `${table} must also be created by the runtime DDL`,
    );
  }

  assert.match(init, /ensureStageTwentyAccounts/);
  assert.match(
    init,
    /await ensureStageTwentyAccounts\(d1\);/,
    "the stage must actually be called from initialize()",
  );
});

test("the account columns are added through the guarded helper", async () => {
  const init = await read("db/init.ts");
  const block = init.slice(
    init.indexOf("async function ensureStageTwentyAccounts"),
    init.indexOf("async function ensureImportIdentity"),
  );

  // This file runs on the boot path of every request. An unguarded ALTER throws
  // "duplicate column name" on the second boot and takes the whole app down.
  assert.doesNotMatch(
    block,
    /ALTER TABLE/,
    "columns must go through addColumn, which guards on PRAGMA table_info",
  );
  assert.match(block, /await addColumn\(d1, "users", column, definition\)/);

  for (const column of [
    "password_hash",
    "last_login_at",
    "status",
    "theme_preference",
    "working_status",
    "timezone",
  ]) {
    assert.ok(block.includes(`"${column}"`), `users.${column} must be added`);
  }
});

test("a session stores only the hash of its token", async () => {
  const schema = await read("db/schema.ts");
  const sessions = schema.slice(schema.indexOf('sqliteTable(\n  "sessions"'));
  const block = sessions.slice(0, sessions.indexOf("export const invitations"));

  // A leaked database must not be usable to impersonate anyone.
  assert.match(block, /tokenHash: text\("token_hash"\)/);
  assert.ok(
    !/token: text\("token"\)/.test(block),
    "the raw token must never be stored",
  );
  // Revoked rather than deleted, so "signed out everywhere" stays auditable.
  assert.match(block, /revokedAt: text\("revoked_at"\)/);
});

test("an invitation carries the role, so accepting cannot escalate", async () => {
  const schema = await read("db/schema.ts");
  const block = schema.slice(
    schema.indexOf('sqliteTable(\n  "invitations"'),
    schema.indexOf('sqliteTable(\n  "teams"'),
  );
  assert.match(block, /role: text\("role"\)/);
  assert.match(block, /tokenHash: text\("token_hash"\)/);
  assert.match(block, /expiresAt: text\("expires_at"\)\.notNull\(\)/);
  assert.match(block, /revokedAt: text\("revoked_at"\)/);
});

test("a capability absent from the table falls back rather than locking out", async () => {
  const schema = await read("db/schema.ts");
  const block = schema.slice(schema.indexOf('sqliteTable(\n  "role_capabilities"'));

  // The unique index is what makes an override a single row per
  // (workspace, role, capability) — without it two rows could disagree and the
  // winner would be whichever the query happened to return first.
  assert.match(
    block.slice(0, block.indexOf("export const auditEvents")),
    /uniqueIndex\("role_capabilities_idx"\)\.on\(\s*\n?\s*table\.organisationId,\s*\n?\s*table\.role,\s*\n?\s*table\.capability,?\s*\n?\s*\)/,
    "one override per workspace, role and capability",
  );
});

test("the audit log is append-only and keeps events that have no workspace", async () => {
  const schema = await read("db/schema.ts");
  const block = schema.slice(
    schema.indexOf('sqliteTable(\n  "audit_events"'),
    schema.indexOf('sqliteTable(\n  "navigation_layouts"'),
  );

  // A failed sign-in has no workspace yet, and those are exactly the events
  // worth keeping — so organisation_id must be nullable.
  assert.ok(
    !/organisationId: text\("organisation_id"\)\.notNull\(\)/.test(block),
    "organisation_id must be nullable or a failed sign-in cannot be recorded",
  );
  // No updatedAt: a row that can be amended is not an audit record.
  assert.ok(
    !block.includes('updatedAt'),
    "an audit event must not carry an updated timestamp — it is append-only",
  );
  assert.match(block, /action: text\("action"\)\.notNull\(\)/);
  assert.match(block, /summary: text\("summary"\)\.notNull\(\)/);
});

test("a sidebar layout distinguishes the workspace default from a person's own", async () => {
  const schema = await read("db/schema.ts");
  const block = schema.slice(schema.indexOf('sqliteTable(\n  "navigation_layouts"'));

  // user_id NULL is the workspace default an admin sets; a row with a user id
  // is that person's arrangement and wins over it.
  assert.ok(
    !/userId: text\("user_id"\)\.notNull\(\)/.test(block),
    "user_id must be nullable — NULL is the workspace default",
  );
  assert.match(block, /locked: text\("locked"\)/, "admin-locked items must be storable");
  assert.match(block, /items: text\("items"\)/);
});

test("Stage 20 destroys nothing", async () => {
  const init = await read("db/init.ts");
  const block = init.slice(
    init.indexOf("async function ensureStageTwentyAccounts"),
    init.indexOf("async function ensureImportIdentity"),
  );
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "DROP INDEX"]) {
    assert.ok(
      !block.toUpperCase().includes(destructive),
      `Stage 20 must be purely additive; found ${destructive}`,
    );
  }
});
