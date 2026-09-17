/**
 * The two kinds of authority that sit ABOVE a workspace membership.
 *
 *   · Platform Super Admin — `platform_admins`, a property of the person.
 *   · Client company Owner — `client_company_members` with
 *     `relationship = 'owner'`, a property of the person and one company.
 *
 * Read in one place, for the same reason `loadGrants` reads memberships in one
 * place: `resolveTenantAccess` is the single point where access is decided, and
 * a second reader would be a second definition of "Owner".
 *
 * Both reads require the person's `users` row to be active and the grant's own
 * status to be active — the same two conditions a membership must meet — and an
 * Owner's company must itself be active and a CUSTOMER company: an internal
 * (demonstration) company has no customer Owners, whatever a row says. A deactivated account therefore loses
 * platform and company authority on its next request, exactly as it loses its
 * memberships.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { clientCompanies, clientCompanyMembers, platformAdmins, users } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export type CompanyAuthority = {
  platformAdmin: boolean;
  /** Active client companies this person owns, in a stable order. */
  ownedCompanyIds: string[];
  /** The same companies with the workspace each designates as its landing page. */
  ownedCompanies: Array<{ id: string; defaultOrganisationId: string | null }>;
};

const lowerEmails = (emails: string[]) =>
  sql`lower(${users.email}) in (${sql.join(
    emails.map((email) => sql`${email}`),
    sql`, `,
  )})`;

/** Platform and company authority for each of `emails`, keyed by lower-case email. */
export async function loadCompanyAuthority(
  db: Database,
  emails: string[],
): Promise<Map<string, CompanyAuthority>> {
  const result = new Map<string, CompanyAuthority>();
  if (!emails.length) return result;

  const [platformRows, ownerRows] = await Promise.all([
    db
      .select({ email: sql<string>`lower(${users.email})` })
      .from(platformAdmins)
      .innerJoin(users, eq(users.id, platformAdmins.userId))
      .where(and(eq(platformAdmins.status, "active"), eq(users.active, true), lowerEmails(emails))),
    db
      .select({
        email: sql<string>`lower(${users.email})`,
        clientCompanyId: clientCompanyMembers.clientCompanyId,
        defaultOrganisationId: clientCompanies.defaultOrganisationId,
      })
      .from(clientCompanyMembers)
      .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
      .innerJoin(clientCompanies, eq(clientCompanies.id, clientCompanyMembers.clientCompanyId))
      .where(
        and(
          eq(clientCompanyMembers.relationship, "owner"),
          eq(clientCompanyMembers.status, "active"),
          eq(clientCompanies.status, "active"),
          eq(clientCompanies.kind, COMPANY_KIND.customer),
          eq(users.active, true),
          lowerEmails(emails),
        ),
      ),
  ]);

  const entry = (email: string) => {
    const existing = result.get(email) ?? { platformAdmin: false, ownedCompanyIds: [], ownedCompanies: [] };
    result.set(email, existing);
    return existing;
  };
  for (const row of platformRows) entry(row.email).platformAdmin = true;
  for (const row of ownerRows) {
    const bucket = entry(row.email);
    if (!bucket.ownedCompanyIds.includes(row.clientCompanyId)) {
      bucket.ownedCompanyIds.push(row.clientCompanyId);
      bucket.ownedCompanies.push({
        id: row.clientCompanyId,
        defaultOrganisationId: row.defaultOrganisationId ?? null,
      });
    }
  }
  for (const bucket of result.values()) {
    bucket.ownedCompanyIds.sort();
    bucket.ownedCompanies.sort((left, right) => left.id.localeCompare(right.id));
  }
  return result;
}

/**
 * The two kinds of client company.
 *
 * `customer` is a real client. `internal` is MAINTSUPP's own — the
 * demonstration workspace today — which only Platform Super Admins see and
 * manage: no customer Owner, Admin, Manager or Client reaches its workspaces,
 * even with a membership row. An explicit marker rather than a name, so a
 * rename cannot change who sees it.
 */
export const COMPANY_KIND = { customer: "customer", internal: "internal" } as const;
export type CompanyKind = (typeof COMPANY_KIND)[keyof typeof COMPANY_KIND];

/** Internal companies, which only the platform reaches. One small read per request. */
export async function loadInternalCompanyIds(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ id: clientCompanies.id })
    .from(clientCompanies)
    .where(eq(clientCompanies.kind, COMPANY_KIND.internal));
  return new Set(rows.map((row) => row.id));
}

/** The active Platform Super Admins among `userIds`. */
export async function platformAdminIds(db: Database, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(and(inArray(platformAdmins.userId, userIds), eq(platformAdmins.status, "active")));
  return new Set(rows.map((row) => row.userId));
}

/** Active Owners of one company: user id → owner row. */
export async function companyOwnerIds(db: Database, clientCompanyId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: clientCompanyMembers.userId })
    .from(clientCompanyMembers)
    .where(
      and(
        eq(clientCompanyMembers.clientCompanyId, clientCompanyId),
        eq(clientCompanyMembers.relationship, "owner"),
        eq(clientCompanyMembers.status, "active"),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}
