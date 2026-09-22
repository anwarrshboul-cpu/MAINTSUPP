/**
 * Workspace memberships, read for the tenancy resolver.
 *
 * Its own module, importing nothing that needs a request, so the migration
 * tests can load it against a real SQLite copy and prove what a row does and
 * does not grant. `tenant-access.ts` is the only production caller.
 *
 * ONLY THE THREE WORKSPACE ROLES ARE GRANTS. A legacy `super_admin` membership
 * row — the seeds used to copy one into every workspace — is skipped:
 * platform authority is read from `platform_admins` (`loadCompanyAuthority`),
 * and those rows are kept, inert, only so a rollback of the code restores
 * their old meaning. Nothing else is read from a membership: in particular,
 * never the free-text `users.role` label.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { memberships, users } from "../../db/schema";
import { normaliseMembershipRole, type MembershipRole } from "./roles";
import { SITE_OUTSIDE_SCOPE } from "./member-site-scope";

type Database = Awaited<ReturnType<typeof getDb>>;

export type MembershipGrant = {
  organisationId: string;
  role: MembershipRole;
  siteScope: string[] | null;
};

/**
 * `memberships.site_scope` → the member's permitted sites, FAILING CLOSED.
 *
 *   SQL NULL          → `null`: unrestricted. The column's only state today —
 *                       nothing in the product writes it.
 *   a JSON array of site ids → exactly those sites.
 *   anything else     → restricted to NO sites: malformed JSON, a non-array,
 *                       `[]`, an array of no usable ids, and even `""`.
 *
 * It used to answer `null` — every site — for all of "anything else", so a
 * corrupted or half-written restriction silently lifted itself. A restriction
 * that somebody wrote but that names no site is read as what it literally says:
 * none. Returned as `[SITE_OUTSIDE_SCOPE]`, never `[]` — see that constant for
 * why an empty restriction must not exist.
 */
export function parseSiteScope(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [SITE_OUTSIDE_SCOPE];
    const ids = parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return ids.length ? ids : [SITE_OUTSIDE_SCOPE];
  } catch {
    return [SITE_OUTSIDE_SCOPE];
  }
}

/** Active workspace memberships held by any of `emails`, keyed back to the email. */
export async function loadGrants(db: Database, emails: string[]) {
  if (!emails.length) return new Map<string, MembershipGrant[]>();
  const rows = await db
    .select({
      email: sql<string>`lower(${users.email})`,
      organisationId: memberships.organisationId,
      role: memberships.role,
      siteScope: memberships.siteScope,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.status, "active"),
        eq(users.active, true),
        sql`lower(${users.email}) in (${sql.join(
          emails.map((email) => sql`${email}`),
          sql`, `,
        )})`,
      ),
    );

  const grants = new Map<string, MembershipGrant[]>();
  for (const row of rows) {
    const role = normaliseMembershipRole(row.role);
    if (!role) continue;
    const list = grants.get(row.email) ?? [];
    list.push({
      organisationId: row.organisationId,
      role,
      siteScope: parseSiteScope(row.siteScope),
    });
    grants.set(row.email, list);
  }
  return grants;
}
