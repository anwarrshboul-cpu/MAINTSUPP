/**
 * Removes the accounts that automated test runs left behind.
 *
 * Fifty-four of the fifty-seven users in the exported database were created by
 * test suites probing sign-in, invitations and permissions. They are harmless,
 * but they make the Users screen unreadable.
 *
 * Deliberately NOT touched: `audit_events`. That log is append-only by contract
 * — a test asserts no code anywhere updates or deletes it — and the record that
 * an account existed and did something is exactly what an audit log is for.
 * Rows there keep the email as text, so they stay readable with the user gone.
 *
 * Dry run by default. Pass --yes to actually delete.
 *
 *   node scripts/clean-test-accounts.mjs
 *   node scripts/clean-test-accounts.mjs --yes
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = path.join(
  root,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "faaf2b0445ab934c3aac48ddf0cdfade8f9bac050be98993748742cdd2cb05fb.sqlite",
);

if (!existsSync(DB)) {
  console.error("No local database found at:\n  " + DB);
  console.error("Start the app once (npm run dev) and it will create one.");
  process.exit(1);
}

/**
 * What counts as a test account.
 *
 * Matched on the address rather than on creation date, because a date window
 * would also catch anyone the owner invited on the same day. Everything that
 * must survive is named explicitly, so no widening of the patterns below can
 * sweep it up.
 *
 * The `*-@test.maintsupp.com` trio is NOT disposable despite the domain: those
 * are the identities the sidebar's demo role switcher resolves to
 * (`roleIdentityEmail` in `app/lib/tenant-access.ts`), and deleting them breaks
 * the switcher for anyone browsing without signing in — which is still how the
 * dashboard is demonstrated. The same goes for the per-workspace variants that
 * `organisationIdentityEmail` builds from an organisation slug.
 */
const KEEP = new Set([
  "owner@maintsupp.com",
  "sample-admin@maintsupp.local",
  "sample-client@maintsupp.local",
  // Demo role switcher, global.
  "super-admin@test.maintsupp.com",
  "admin@test.maintsupp.com",
  "client@test.maintsupp.com",
]);

/** Per-workspace demo identities: `<role>@<org-slug>.test.maintsupp.com`. */
const KEEP_PATTERN =
  /^(super-admin|admin|client)@[a-z0-9-]+\.test\.maintsupp\.com$/;

const TEST_PATTERNS = ["%stage20%", "%probe%", "%@test.maintsupp.com", "%@example.com"];

const db = new DatabaseSync(DB);
const where =
  TEST_PATTERNS.map(() => "lower(email) LIKE ?").join(" OR ");
const candidates = db
  .prepare(`SELECT id, email FROM users WHERE ${where}`)
  .all(...TEST_PATTERNS)
  .filter((row) => {
    const email = String(row.email).toLowerCase();
    return !KEEP.has(email) && !KEEP_PATTERN.test(email);
  });

if (!candidates.length) {
  console.log("Nothing to clean — no test accounts found.");
  process.exit(0);
}

const ids = candidates.map((row) => row.id);
const holes = ids.map(() => "?").join(",");
const count = (table, column = "user_id") =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${holes})`).get(...ids).n;

console.log(`${candidates.length} test account(s):`);
for (const row of candidates.slice(0, 8)) console.log("  " + row.email);
if (candidates.length > 8) console.log(`  … and ${candidates.length - 8} more`);
console.log("\nWould also remove:");
console.log(`  ${count("memberships")} membership(s)`);
console.log(`  ${count("sessions")} session(s)`);
console.log(`  ${count("team_members")} team membership(s)`);
console.log("\nKeeping: the 3 real accounts, and every audit_events row.");

if (!process.argv.includes("--yes")) {
  console.log("\nDry run. Re-run with --yes to delete.");
  process.exit(0);
}

db.exec("BEGIN");
try {
  for (const table of ["team_members", "sessions", "memberships"]) {
    db.prepare(`DELETE FROM ${table} WHERE user_id IN (${holes})`).run(...ids);
  }
  // Invitations reference the accepting user, and are keyed by email too.
  db.prepare(`DELETE FROM invitations WHERE accepted_user_id IN (${holes})`).run(...ids);
  db.prepare(`DELETE FROM users WHERE id IN (${holes})`).run(...ids);
  db.exec("COMMIT");
  console.log(`\nRemoved ${candidates.length} test account(s). Audit log untouched.`);
} catch (error) {
  db.exec("ROLLBACK");
  console.error("\nNothing was changed — the delete failed and was rolled back:");
  console.error(error);
  process.exit(1);
}
