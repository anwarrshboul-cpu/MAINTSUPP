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

type Database = Awaited<ReturnType<typeof getDb>>;

export type MembershipGrant = {
  organisationId: string;
  role: MembershipRole;
  siteScope: string[] | null;
};

export function parseSiteScope(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((item): item is string => typeof item === "string");
    return ids.length ? ids : null;
  } catch {
    return null;
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
