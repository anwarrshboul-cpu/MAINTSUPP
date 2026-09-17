/**
 * THE STAGE 19 CONVERSION, AND NOTHING SINCE.
 *
 * When the portal became multi-tenant, every existing `users` row was given a
 * membership of its home workspace, with the role read from the free-text
 * `users.role` label — because on a single-tenant database that label WAS the
 * access model. That was a one-time conversion.
 *
 * It kept running on every migration replay, and that turned a display label
 * into security authority: a person added from the Team tab (a `users` row, no
 * membership) with the label "Admin" became an Admin of the workspace at the
 * next replay, and — once the client-company migration read super_admin
 * memberships — "Super Admin" would have become platform authority.
 *
 * DISPLAY LABELS MUST NEVER GRANT SECURITY AUTHORITY, so this runs only on a
 * database that has NEVER held a membership: the pre-multi-tenant estate the
 * conversion was written for. Every live database already has memberships and
 * never reaches the INSERT. Even then, a label never yields platform or
 * company authority (`super admin`, `owner` are skipped) and never Manager,
 * which did not exist in that era.
 *
 * Access is granted only by explicit RBAC operations: an accepted invitation,
 * a role change or workspace grant in Users & access, or the platform's own
 * appointment of an Owner.
 */

type D1Like = {
  prepare(sql: string): {
    all(): Promise<{ results?: unknown[] }>;
    run(): Promise<unknown>;
  };
};

export async function backfillLegacyMemberships(d1: D1Like) {
  const existing = await d1.prepare("SELECT 1 AS found FROM memberships LIMIT 1").all();
  if ((existing.results ?? []).length) return;

  await d1
    .prepare(
      `INSERT OR IGNORE INTO memberships
        (id, user_id, organisation_id, role, status, accepted_at)
       SELECT 'membership-' || id, id, organisation_id,
         CASE lower(role) WHEN 'admin' THEN 'admin' ELSE 'client' END,
         'active', CURRENT_TIMESTAMP
       FROM users
       WHERE organisation_id IS NOT NULL
         AND lower(role) NOT IN ('owner', 'super admin')`,
    )
    .run();
}
