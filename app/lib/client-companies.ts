/**
 * Client companies and their workspaces: creating them, and listing them for
 * the people allowed to see them.
 *
 * WHO MAY DO WHAT is decided by the routes, from `tenant-access.ts`:
 *
 *   · create a client company        → Platform Super Admin only
 *   · create a workspace in company X → Platform Super Admin, or an Owner of X
 *   · appoint or remove an Owner      → Platform Super Admin only
 *
 * This module only does the work, and never widens anything: a new workspace
 * gets NO memberships (apart from the development-only testing identities), so
 * on creation it is visible to the Platform Super Admins and to X's Owners and
 * to nobody else. Anyone below Owner is added to it explicitly, later.
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import { getD1 } from "../../db";
import { seedBoardStructure, seedJobTypes } from "../../db/init";
import { seedStoreDocumentationBoard } from "../../db/seed-store-documentation";
import {
  clientCompanies,
  clientCompanyMembers,
  invitations,
  memberships,
  optionSets,
  optionValues,
  organisations,
  users,
} from "../../db/schema";
import { demoIdentityAllowed, organisationIdentityEmail } from "./tenant-access";

type Database = Awaited<ReturnType<typeof getDb>>;

export type ClientCompanyRow = typeof clientCompanies.$inferSelect;
export type WorkspaceRow = typeof organisations.$inferSelect;

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** A workspace slug nobody holds yet: `base`, then `base-2`, `base-3`… */
async function uniqueWorkspaceSlug(db: Database, base: string) {
  const root = base || "workspace";
  for (let attempt = 1; attempt < 50; attempt += 1) {
    const candidate = attempt === 1 ? root : `${root}-${attempt}`.slice(0, 64);
    const [taken] = await db
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

export function cleanName(value: unknown, max = 120) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Creates a client company. It has no workspaces and no Owners yet. */
export async function createClientCompany(
  db: Database,
  input: { name: string; createdBy: string | null },
): Promise<ClientCompanyRow> {
  const [created] = await db
    .insert(clientCompanies)
    .values({
      id: `company_${crypto.randomUUID().replaceAll("-", "")}`,
      name: input.name,
      slug: slugify(input.name) || "company",
      status: "active",
      defaultOrganisationId: null,
      createdBy: input.createdBy,
    })
    .returning();
  return created;
}

/**
 * Option sets whose VALUES belong to one customer and must never be copied into
 * another's workspace. `store_location` is literally a client's list of stores.
 * The set itself is still created, empty, so the pickers that expect it work.
 */
const CUSTOMER_SPECIFIC_OPTION_SETS = new Set(["store_location"]);

/**
 * Creates a workspace inside `clientCompanyId`, structurally complete.
 *
 * Moved here from `POST /api/context` (`create_organisation`), which is what it
 * did before companies existed: copy the option sets from a template
 * workspace, seed the board, the Store Documentation register and the three
 * default job types. Two changes, both narrowing:
 *
 *   · the template's CUSTOMER-SPECIFIC option values are not copied, because
 *     the template is usually another customer's workspace;
 *   · the `admin@<slug>.test.maintsupp.com` / `client@…` testing identities are
 *     created only where testing identities are allowed at all — they were
 *     being written into Production for every new workspace, and a new
 *     workspace must start with no members.
 *
 * If the company has no default workspace yet, this one becomes it.
 */
export async function createWorkspace(
  db: Database,
  input: {
    name: string;
    clientCompanyId: string;
    templateOrganisationId: string | null;
  },
): Promise<WorkspaceRow> {
  const slug = await uniqueWorkspaceSlug(db, slugify(input.name));
  const [created] = await db
    .insert(organisations)
    .values({
      id: `org_${crypto.randomUUID().replaceAll("-", "")}`,
      name: input.name,
      slug,
      logoUrl: null,
      primaryColour: "#12B4A8",
      planTier: "development",
      status: "active",
      clientCompanyId: input.clientCompanyId,
    })
    .returning();

  if (input.templateOrganisationId) {
    const sourceSets = await db
      .select()
      .from(optionSets)
      .where(eq(optionSets.organisationId, input.templateOrganisationId));
    for (const sourceSet of sourceSets) {
      const newSetId = `set_${crypto.randomUUID().replaceAll("-", "")}`;
      await db.insert(optionSets).values({
        id: newSetId,
        organisationId: created.id,
        key: sourceSet.key,
        name: sourceSet.name,
        description: sourceSet.description,
      });
      if (CUSTOMER_SPECIFIC_OPTION_SETS.has(sourceSet.key)) continue;
      const sourceValues = await db
        .select()
        .from(optionValues)
        .where(eq(optionValues.optionSetId, sourceSet.id));
      for (const sourceValue of sourceValues) {
        await db.insert(optionValues).values({
          id: `value_${crypto.randomUUID().replaceAll("-", "")}`,
          organisationId: created.id,
          optionSetId: newSetId,
          value: sourceValue.value,
          label: sourceValue.label,
          colourHex: sourceValue.colourHex,
          textColour: sourceValue.textColour,
          position: sourceValue.position,
          isDone: sourceValue.isDone,
          isDefault: sourceValue.isDefault,
          active: sourceValue.active,
          system: sourceValue.system,
        });
      }
    }
  }

  /*
   * A new workspace has to arrive with a board, or it renders as an error.
   * All three seeders are idempotent and organisation-scoped, and none writes
   * a row of operational data.
   */
  const d1 = await getD1();
  await seedBoardStructure(d1, created.id);
  await seedStoreDocumentationBoard(d1, created.id);
  await seedJobTypes(d1, created.id);

  if (demoIdentityAllowed()) {
    for (const role of ["admin", "client"] as const) {
      const email = organisationIdentityEmail(created.slug, role);
      const userId = `user-${email.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      await db
        .insert(users)
        .values({
          id: userId,
          organisationId: created.id,
          email,
          fullName: `${created.name} ${role}`,
          role: role === "admin" ? "Admin" : "Client",
          active: true,
        })
        .onConflictDoNothing();
      await db
        .insert(memberships)
        .values({
          id: `membership-${userId}-${created.id}`,
          userId,
          organisationId: created.id,
          role,
          status: "active",
          acceptedAt: new Date().toISOString(),
        })
        .onConflictDoNothing();
    }
  }

  await db
    .update(clientCompanies)
    .set({ defaultOrganisationId: created.id, updatedAt: new Date().toISOString() })
    .where(
      and(eq(clientCompanies.id, input.clientCompanyId), isNull(clientCompanies.defaultOrganisationId)),
    );

  return created;
}

export type CompanySummary = {
  id: string;
  name: string;
  status: string;
  /** `customer`, or `internal` for MAINTSUPP's own demonstration company. */
  kind: string;
  defaultOrganisationId: string | null;
  workspaces: Array<{ id: string; name: string; status: string }>;
  owners: Array<{ userId: string; email: string; fullName: string | null; active: boolean }>;
  pendingOwnerInvitations: Array<{ id: string; email: string; expiresAt: string }>;
};

/**
 * The companies `companyIds` names (every company when null), with their
 * active workspaces, their active Owners and their outstanding Owner
 * invitations. The caller decides the list; this never widens it.
 */
export async function listCompanies(
  db: Database,
  companyIds: string[] | null,
): Promise<CompanySummary[]> {
  if (companyIds && !companyIds.length) return [];
  const companyRows = await db
    .select()
    .from(clientCompanies)
    .where(
      companyIds
        ? and(inArray(clientCompanies.id, companyIds), eq(clientCompanies.status, "active"))
        : eq(clientCompanies.status, "active"),
    )
    // Customers first, then MAINTSUPP's internal companies; by name within each.
    .orderBy(asc(clientCompanies.kind), asc(clientCompanies.name));
  const ids = companyRows.map((row) => row.id);
  if (!ids.length) return [];

  const [workspaceRows, ownerRows, inviteRows] = await Promise.all([
    db
      .select({
        id: organisations.id,
        name: organisations.name,
        status: organisations.status,
        clientCompanyId: organisations.clientCompanyId,
      })
      .from(organisations)
      .where(and(inArray(organisations.clientCompanyId, ids), eq(organisations.status, "active")))
      .orderBy(asc(organisations.name)),
    db
      .select({
        clientCompanyId: clientCompanyMembers.clientCompanyId,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        active: users.active,
      })
      .from(clientCompanyMembers)
      .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
      .where(
        and(
          inArray(clientCompanyMembers.clientCompanyId, ids),
          eq(clientCompanyMembers.relationship, "owner"),
          eq(clientCompanyMembers.status, "active"),
        ),
      )
      .orderBy(asc(users.email)),
    db
      .select({
        id: invitations.id,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        clientCompanyId: invitations.clientCompanyId,
      })
      .from(invitations)
      .where(
        and(
          inArray(invitations.clientCompanyId, ids),
          eq(invitations.role, "owner"),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      ),
  ]);

  const now = Date.now();
  return companyRows.map((company) => ({
    id: company.id,
    name: company.name,
    status: company.status,
    kind: company.kind,
    defaultOrganisationId: company.defaultOrganisationId,
    workspaces: workspaceRows
      .filter((row) => row.clientCompanyId === company.id)
      .map(({ id, name, status }) => ({ id, name, status })),
    owners: ownerRows
      .filter((row) => row.clientCompanyId === company.id)
      .map(({ userId, email, fullName, active }) => ({
        userId,
        email,
        fullName,
        active: Boolean(active),
      })),
    pendingOwnerInvitations: inviteRows
      .filter((row) => row.clientCompanyId === company.id && Date.parse(row.expiresAt) > now)
      .map(({ id, email, expiresAt }) => ({ id, email, expiresAt })),
  }));
}

/**
 * A company's display name, changed. The slug is left as it was: nothing
 * routes on it, and a stable slug keeps any link that mentions it working.
 */
export async function renameCompany(db: Database, clientCompanyId: string, name: string) {
  await db
    .update(clientCompanies)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(clientCompanies.id, clientCompanyId));
}

/** One active company, or null. */
export async function findCompany(db: Database, clientCompanyId: string) {
  const [row] = await db
    .select()
    .from(clientCompanies)
    .where(and(eq(clientCompanies.id, clientCompanyId), eq(clientCompanies.status, "active")))
    .limit(1);
  return row ?? null;
}
