/**
 * Client companies — the level between the MAINTSUPP platform and a workspace.
 *
 *   GET  — the companies the caller administers: every one for a Platform
 *          Super Admin, their own for an Owner, 403 for anybody else.
 *   POST — `{ action, ... }`:
 *
 *          create_company         Super Admin. A company and its first
 *                                 workspace, together — a company with no
 *                                 workspace has nowhere for its Owner to land.
 *          create_workspace       Super Admin, or an Owner of that company.
 *          set_default_workspace  Super Admin, or an Owner of that company.
 *          remove_owner           Super Admin.
 *          archive_company        Super Admin. The company, its workspaces and
 *                                 its outstanding invitations, reversibly (a
 *                                 status, never a DELETE).
 *
 * OWNERS ARE APPOINTED BY INVITATION (`POST /api/auth/invitations`, role
 * "owner"), never from here, so an Owner has always proved the address is
 * theirs. Nothing here writes a workspace membership: a new workspace is seen
 * by the Platform Super Admins and its company's Owners, and by anybody else
 * only once they are given access to it.
 *
 * A company id the caller does not administer is refused with the same
 * sentence as one that does not exist, so this cannot be used to discover
 * another customer.
 */

import { and, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { DEMO_WORKSPACE_ID } from "../../../../db/demo-workspace";
import {
  clientCompanies,
  clientCompanyMembers,
  invitations,
  organisations,
  users,
} from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  cleanName,
  createClientCompany,
  createWorkspace,
  findCompany,
  listCompanies,
} from "../../../lib/client-companies";
import { administersCompany, PRIMARY_ORGANISATION_ID } from "../../../lib/tenant-access";
import { anonymousRefusal, scopedDb, type ScopedDatabase } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

const NOT_YOURS = "That client company is not one you administer.";

function refused(error: string) {
  return Response.json({ error, denied: true }, { status: 403 });
}

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function resolve(request: Request): Promise<ScopedDatabase | Response> {
  try {
    return await scopedDb(request);
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}

function failure(error: unknown, message: string) {
  console.error("[/api/admin/companies]", error);
  return Response.json({ error: message }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await resolve(request);
    if (context instanceof Response) return context;
    if (!context.platformAdmin && !context.ownedCompanyIds.length) {
      return refused("Only a Super Admin or a company Owner can see client companies.");
    }

    const companies = await listCompanies(
      context.db,
      context.platformAdmin ? null : context.ownedCompanyIds,
    );
    return Response.json({
      companies: companies.map((company) => ({
        ...company,
        owned: context.ownedCompanyIds.includes(company.id),
        /* Owner appointments are the platform's business. */
        pendingOwnerInvitations: context.platformAdmin ? company.pendingOwnerInvitations : [],
        canManageOwners: context.platformAdmin,
      })),
      actor: {
        email: context.identityEmail,
        platformAdmin: context.platformAdmin,
        canCreateCompany: context.platformAdmin,
        currentOrganisationId: context.orgId,
      },
    });
  } catch (error) {
    return failure(error, "Client companies are temporarily unavailable.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const context = await resolve(request);
    if (context instanceof Response) return context;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Send a JSON body with an action." }, { status: 400 });
    }
    const action = text(body.action, 40);
    const actor = auditActor(context);

    if (action === "create_company") {
      if (!context.platformAdmin) return refused("Only a Super Admin can create a client company.");
      const name = cleanName(body.name);
      if (!name) return Response.json({ error: "A company name is required." }, { status: 400 });
      const workspaceName = cleanName(body.workspaceName) || name;

      const company = await createClientCompany(context.db, {
        name,
        createdBy: context.session?.user.id ?? null,
      });
      const workspace = await createWorkspace(context.db, {
        name: workspaceName,
        clientCompanyId: company.id,
        templateOrganisationId: context.orgId,
      });
      await recordAudit({
        db: context.db,
        organisationId: workspace.id,
        actor,
        action: "company.created",
        entityType: "client_company",
        entityId: company.id,
        summary: `Created the client company ${company.name} with the workspace ${workspace.name}.`,
        detail: { clientCompanyId: company.id, workspaceId: workspace.id },
        request,
      });
      return Response.json(
        {
          company: { id: company.id, name: company.name, defaultOrganisationId: workspace.id },
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        },
        { status: 201 },
      );
    }

    const clientCompanyId = text(body.clientCompanyId, 100);
    const company = clientCompanyId ? await findCompany(context.db, clientCompanyId) : null;
    if (!company || !administersCompany(context, company.id)) return refused(NOT_YOURS);

    if (action === "create_workspace") {
      const name = cleanName(body.name);
      if (!name) return Response.json({ error: "A workspace name is required." }, { status: 400 });
      /* The template is the company's own default workspace, so a new branch
         copies its own company's vocabulary — never another customer's when
         the caller is an Owner. */
      const template =
        company.defaultOrganisationId &&
        context.organisationIds.includes(company.defaultOrganisationId)
          ? company.defaultOrganisationId
          : context.platformAdmin
            ? context.orgId
            : null;
      const workspace = await createWorkspace(context.db, {
        name,
        clientCompanyId: company.id,
        templateOrganisationId: template,
      });
      await recordAudit({
        db: context.db,
        organisationId: workspace.id,
        actor,
        action: "workspace.created",
        entityType: "organisation",
        entityId: workspace.id,
        summary: `Created the workspace ${workspace.name} in ${company.name}.`,
        detail: { clientCompanyId: company.id },
        request,
      });
      return Response.json(
        { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, clientCompanyId: company.id } },
        { status: 201 },
      );
    }

    if (action === "set_default_workspace") {
      const organisationId = text(body.organisationId, 100);
      const [workspace] = await context.db
        .select({ id: organisations.id, name: organisations.name })
        .from(organisations)
        .where(
          and(
            eq(organisations.id, organisationId),
            eq(organisations.clientCompanyId, company.id),
            eq(organisations.status, "active"),
          ),
        )
        .limit(1);
      if (!workspace) {
        return Response.json({ error: "That workspace is not one of this company's." }, { status: 404 });
      }
      await context.db
        .update(clientCompanies)
        .set({ defaultOrganisationId: workspace.id, updatedAt: new Date().toISOString() })
        .where(eq(clientCompanies.id, company.id));
      await recordAudit({
        db: context.db,
        organisationId: workspace.id,
        actor,
        action: "company.default_workspace_changed",
        entityType: "client_company",
        entityId: company.id,
        summary: `Made ${workspace.name} the default workspace of ${company.name}.`,
        request,
      });
      return Response.json({ ok: true, defaultOrganisationId: workspace.id });
    }

    if (action === "remove_owner") {
      if (!context.platformAdmin) return refused("Only a Super Admin can remove a company Owner.");
      const userId = text(body.userId, 120);
      const [owner] = await context.db
        .select({ email: users.email })
        .from(clientCompanyMembers)
        .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
        .where(
          and(
            eq(clientCompanyMembers.clientCompanyId, company.id),
            eq(clientCompanyMembers.userId, userId),
            eq(clientCompanyMembers.relationship, "owner"),
            eq(clientCompanyMembers.status, "active"),
          ),
        )
        .limit(1);
      if (!owner) {
        return Response.json({ error: "That person is not an Owner of this company." }, { status: 404 });
      }
      /* A status, not a DELETE: who owned the company, and when, survives. */
      await context.db
        .update(clientCompanyMembers)
        .set({ status: "removed", updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(clientCompanyMembers.clientCompanyId, company.id),
            eq(clientCompanyMembers.userId, userId),
          ),
        );
      await recordAudit({
        db: context.db,
        organisationId: company.defaultOrganisationId,
        actor,
        action: "company.owner_removed",
        entityType: "client_company",
        entityId: company.id,
        summary: `Removed ${owner.email} as an Owner of ${company.name}.`,
        detail: { userId },
        request,
      });
      return Response.json({ ok: true });
    }

    if (action === "archive_company") {
      if (!context.platformAdmin) return refused("Only a Super Admin can archive a client company.");
      if (text(body.confirm, 120) !== company.name) {
        return Response.json(
          { error: "Type the company's name exactly to confirm archiving it." },
          { status: 400 },
        );
      }
      const workspaces = await context.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.clientCompanyId, company.id));
      /* The platform's own workspaces are never archived from here. */
      if (
        workspaces.some(
          (row) => row.id === PRIMARY_ORGANISATION_ID || row.id === DEMO_WORKSPACE_ID,
        )
      ) {
        return refused("This company holds a platform workspace and cannot be archived here.");
      }
      const now = new Date().toISOString();
      await context.db
        .update(organisations)
        .set({ status: "archived", updatedAt: now })
        .where(eq(organisations.clientCompanyId, company.id));
      await context.db
        .update(clientCompanies)
        .set({ status: "archived", updatedAt: now })
        .where(eq(clientCompanies.id, company.id));
      await context.db
        .update(invitations)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invitations.clientCompanyId, company.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      await recordAudit({
        db: context.db,
        organisationId: null,
        actor,
        action: "company.archived",
        entityType: "client_company",
        entityId: company.id,
        summary: `Archived the client company ${company.name} and its ${workspaces.length} workspace(s).`,
        detail: { workspaceIds: workspaces.map((row) => row.id) },
        request,
      });
      return Response.json({ ok: true, archivedWorkspaces: workspaces.length });
    }

    return Response.json({ error: "Unsupported company action." }, { status: 400 });
  } catch (error) {
    return failure(error, "That change to the client company could not be saved.");
  }
}
