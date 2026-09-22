import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { CANONICAL_REGISTER, registerScopeFilter } from "../../lib/register-scope";
import {
  clientCompanies,
  maintenanceRequests,
  memberships,
  organisations,
  platformAdmins,
  sites,
  users,
} from "../../../db/schema";
import { auditActor, recordAudit } from "../../lib/audit";
import {
  cleanName,
  createClientCompany,
  createWorkspace,
  findCompany,
} from "../../lib/client-companies";
import { anonymousRefusal, scopedDb, type ScopedDatabase } from "../../lib/tenant-db";
import {
  demoIdentityAllowed,
  IDENTITY_COOKIE,
  ORGANISATION_COOKIE,
  organisationIdentityEmail,
  roleIdentityEmail,
} from "../../lib/tenant-access";
import { listOptionValues } from "../../lib/options-repository";
import { effectiveCapabilities, resolvePermissions } from "../../lib/permissions";
import { availableModules } from "../../lib/portal-modules.ts";
import { readModuleOverrides } from "../../lib/portal-module-repository.ts";
import { type WorkspaceRole } from "../../lib/workspace-actor";
import { isWorkspaceRole } from "../../lib/roles";
import { memberSiteCondition } from "../../lib/member-site-scope";
import { organisationLogoUrl } from "../../lib/organisation-logo";

function clean(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cookie(name: string, value: string) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

/**
 * Per-organisation row counts, for a super admin only.
 *
 * "Only the super admins have the view on everything" is otherwise only
 * demonstrable by switching client and looking, one at a time. This answers it
 * in one payload — and it is the one place in the API that reads across
 * organisation boundaries at all, which is why the guard is on the caller's
 * resolved `crossOrganisation` flag rather than on anything in the request.
 */
async function tenantSummary(context: ScopedDatabase, knownCompanyNames: Map<string, string>) {
  if (!context.crossOrganisation) return null;
  const ids = context.organisationIds;
  if (!ids.length) return null;

  const [jobRows, siteRows] = await Promise.all([
    context.db
      .select({
        organisationId: maintenanceRequests.organisationId,
        value: count(),
      })
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.organisationId, ids),
          // Stage 23 — binned jobs are not part of a tenant's job count.
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .groupBy(maintenanceRequests.organisationId),
    context.db
      .select({ organisationId: sites.organisationId, value: count() })
      .from(sites)
      /* The workspace's own register, for the same reason the job count
         excludes binned jobs: this tile says how big a TENANT is, and a site
         filed inside one section is not part of the workspace's own estate. */
      .where(
        and(
          inArray(sites.organisationId, ids),
          registerScopeFilter(sites.boardId, CANONICAL_REGISTER),
        ),
      )
      .groupBy(sites.organisationId),
  ]);

  const jobs = new Map(jobRows.map((row) => [row.organisationId, row.value]));
  const siteCounts = new Map(
    siteRows.map((row) => [row.organisationId, row.value]),
  );
  return context.activeOrganisations
    .filter((organisation) => ids.includes(organisation.id))
    .map((organisation) => ({
      id: organisation.id,
      name: organisation.name,
      slug: organisation.slug,
      clientCompanyId: organisation.clientCompanyId ?? null,
      companyName: organisation.clientCompanyId
        ? (knownCompanyNames.get(organisation.clientCompanyId) ?? null)
        : null,
      /* MAINTSUPP's own demonstration company, not a customer. */
      internal: Boolean(
        organisation.clientCompanyId &&
          context.internalCompanyIds.includes(organisation.clientCompanyId),
      ),
      maintenanceRequests: jobs.get(organisation.id) ?? 0,
      sites: siteCounts.get(organisation.id) ?? 0,
    }));
}

async function contextPayload(request: Request) {
  const context = await scopedDb(request);

  // The organisations this actor may read — their memberships, or every active
  // organisation for a super admin. A client is handed exactly one entry, so
  // the sidebar's client switcher has nothing to switch to.
  const visibleOrganisationRows = context.activeOrganisations
    .filter((organisation) => context.organisationIds.includes(organisation.id))
    .sort((left, right) => left.name.localeCompare(right.name));

  /*
   * The client companies those workspaces belong to — ONLY those. A person
   * learns the name of a company exactly when they can already open one of its
   * workspaces, so this cannot be used to discover another customer.
   */
  const companyIds = [
    ...new Set(
      visibleOrganisationRows
        .map((organisation) => organisation.clientCompanyId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const companyRows = companyIds.length
    ? await context.db
        .select({ id: clientCompanies.id, name: clientCompanies.name })
        .from(clientCompanies)
        .where(inArray(clientCompanies.id, companyIds))
    : [];
  const companyNames = new Map(companyRows.map((row) => [row.id, row.name]));
  /*
   * THE WORKSPACE LOGO — the brokered address, or null for the default mark.
   *
   * `organisations.logo_url` is an old column nothing writes; the row is spread
   * below, so it is overwritten here rather than trusted. Only the CURRENT
   * workspace's logo is given: `/api/branding/logo/image` serves the caller's
   * current workspace and no other, so an address for any other entry would
   * draw the wrong mark.
   */
  const logoUrl = await organisationLogoUrl(context.db, context.orgId);
  const visibleOrganisations = visibleOrganisationRows.map((organisation) => ({
    ...organisation,
    logoUrl: organisation.id === context.orgId ? logoUrl : null,
    companyName: organisation.clientCompanyId
      ? (companyNames.get(organisation.clientCompanyId) ?? null)
      : null,
  }));
  const companies = companyRows
    .map((row) => ({
      id: row.id,
      name: row.name,
      internal: context.internalCompanyIds.includes(row.id),
      owned: context.ownedCompanyIds.includes(row.id),
      workspaceCount: visibleOrganisationRows.filter(
        (organisation) => organisation.clientCompanyId === row.id,
      ).length,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const currentCompany = context.clientCompanyId
    ? {
        id: context.clientCompanyId,
        name: companyNames.get(context.clientCompanyId) ?? null,
        owned: context.ownedCompanyIds.includes(context.clientCompanyId),
      }
    : null;

  const [siteRows, priorities, engineers, labels, permissions] = await Promise.all([
    context.db
      .select({ id: sites.id, name: sites.name })
      .from(sites)
      /*
       * THE CANONICAL REGISTER ONLY. This list is the location select on
       * Raise a ticket, the board's job form and the public /request page —
       * an ASSIGNMENT surface, and `workspace-data-manager.tsx` states the
       * rule for exactly this case: "a picker is an assignment surface rather
       * than an inventory - offering another register's site there would
       * attach a job to a site the canonical board does not hold."
       * `registerScopeFilter` rather than a hand-rolled `isNull`, because
       * `x = NULL` is never true and this module owns that.
       */
      .where(
        and(
          eq(sites.organisationId, context.orgId),
          registerScopeFilter(sites.boardId, CANONICAL_REGISTER),
          // The request form offers only the member's own sites.
          memberSiteCondition(sites.id, context.siteScope),
        ),
      )
      .orderBy(asc(sites.name)),
    listOptionValues(context.db, context.orgId, "priority"),
    listOptionValues(context.db, context.orgId, "engineer_required"),
    listOptionValues(context.db, context.orgId, "maintenance_label"),
    resolvePermissions(context.db, context.orgId, context.actor.role),
  ]);

  return {
    actor: context.actor,
    currentOrganisation: {
      ...context.organisation,
      logoUrl,
      companyName: currentCompany?.name ?? null,
    },
    organisations: visibleOrganisations,
    /* The client-company level: which companies the workspaces above belong
       to, whether this person owns each, and which one they are standing in. */
    companies,
    currentCompany,
    /*
     * WHAT THIS ACTOR MAY DO, decided by the server.
     *
     * The defaults merged with this workspace's overrides — the same answer
     * `can()` gives every route that enforces one, so a control the browser
     * hides and a request the API refuses can never disagree. It is a read of
     * the caller's OWN permissions and nobody else's, so it discloses nothing
     * a person could not learn by clicking.
     *
     * Two callers were already waiting for this and guessing without it:
     * `raise-ticket.tsx` reads `context.capabilities["board.edit"]` and falls
     * back to inferring from the role string, and the board's CSV export had
     * no answer at all — `data.export` gated the Sites register and nothing on
     * the board. Guessing from a role is wrong the moment an admin narrows one.
     */
    capabilities: effectiveCapabilities(context.actor.role, permissions.capabilities),
    /*
     * WHICH PORTAL MODULES THIS ACTOR MAY REACH, decided by the server.
     *
     * Existence AND authority, resolved once: a module this workspace has
     * switched off, or whose capability this actor does not hold, is simply not
     * in the list. Both the sidebar and the page guard read THIS answer, which
     * is the same reason `capabilities` above exists — "a control the browser
     * hides and a request the API refuses can never disagree."
     *
     * The browser needs it because it builds its own catalogue: `navCatalogue`
     * in `portal-app.tsx` is assembled from a static client-side list, so
     * dropping a module on the server would otherwise change nothing in the
     * sidebar. This field is how the client learns.
     */
    modules: availableModules(
      await readModuleOverrides(context.db, context.orgId),
      effectiveCapabilities(context.actor.role, permissions.capabilities),
      context.actor.role,
    ),
    // Stage 19 — what the actor is allowed to see, and how it was decided.
    identity: {
      email: context.identityEmail,
      organisationIds: context.organisationIds,
      crossOrganisation: context.crossOrganisation,
      /* The platform level, stated plainly rather than inferred from a role. */
      platformAdmin: context.platformAdmin,
      ownsCurrentCompany: currentCompany?.owned ?? false,
      // No membership matched; the actor is confined to the primary
      // organisation on the cookie role alone.
      unaffiliated: context.unaffiliated,
    },
    tenantSummary: await tenantSummary(context, companyNames),
    /*
     * Whether this caller proved who they are.
     *
     * `testingMode` is now the inverse of being signed in rather than a
     * constant: with a real session the sidebar role switcher is not merely
     * unnecessary, it is misleading, because `resolveTenantAccess` refuses to
     * let it widen a session's reach — a user clicking "Super Admin" would see
     * nothing change and reasonably conclude the app was broken.
     */
    testingMode: !context.authenticated,
    authenticationEnabled: context.authenticated,
    requestConfiguration: {
      sites: siteRows,
      priorities: priorities.filter((item) => item.active),
      engineers: engineers.filter((item) => item.active),
      categories: labels.filter((item) => item.active && item.value),
    },
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    return Response.json({ context: await contextPayload(request) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace context could not be loaded.",
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = clean(payload.action, 40);

    const context = await scopedDb(request);

    if (action === "set_role") {
      /*
       * The testing role switcher is a preview affordance, not a product one.
       *
       * It writes `maintsupp_demo_role` and `maintsupp_demo_identity` with no
       * session and no capability check, so in production it hands any
       * anonymous caller a super-admin cookie for the asking. It stays for the
       * public preview and is refused once NODE_ENV says production, where the
       * role must come from a membership.
       */
      if (!demoIdentityAllowed()) {
        return Response.json(
          { error: "The testing role switcher is not available." },
          { status: 403 },
        );
      }
      const role = clean(payload.role, 40) as WorkspaceRole;
      if (!isWorkspaceRole(role)) {
        return Response.json({ error: "Choose a valid testing role." }, { status: 400 });
      }

      /*
       * Stage 19 — the role selector now switches *identity*, not just a label.
       *
       * Role and organisation are read from `memberships`, so setting the role
       * cookie alone would change nothing. Picking "Client" while Demo Client
       * Ltd is selected therefore signs the browser in as that organisation's
       * own client account, and the tenant rules take it from there: the
       * organisation cookie stops having any effect, and the client sees the
       * one organisation their membership names.
       *
       * The per-organisation identity is preferred, falling back to the
       * unqualified demo account (which belongs to Sunnamusk UK) when the
       * selected organisation has none seeded.
       */
      const wanted =
        role === "super_admin"
          ? [roleIdentityEmail(role)]
          : [
              organisationIdentityEmail(context.organisation.slug, role),
              roleIdentityEmail(role),
            ];
      /* The testing Super Admin is a `platform_admins` row, not a membership. */
      const identityRows =
        role === "super_admin"
          ? await context.db
              .select({ email: users.email })
              .from(users)
              .innerJoin(platformAdmins, eq(platformAdmins.userId, users.id))
              .where(and(inArray(users.email, wanted), eq(platformAdmins.status, "active")))
          : await context.db
              .select({ email: users.email })
              .from(users)
              .innerJoin(memberships, eq(memberships.userId, users.id))
              .where(
                and(
                  inArray(users.email, wanted),
                  eq(memberships.status, "active"),
                  eq(memberships.role, role),
                ),
              );
      const available = new Set(identityRows.map((row) => row.email));
      const identity = wanted.find((email) => available.has(email)) ?? null;

      const response = Response.json({ ok: true, role, identity });
      response.headers.append("Set-Cookie", cookie("maintsupp_demo_role", role));
      response.headers.append(
        "Set-Cookie",
        identity
          ? cookie(IDENTITY_COOKIE, identity)
          : // No seeded identity for this role. Clear the cookie rather than
            // leave the previous one in place, which would silently keep the
            // browser signed in as the organisation it just left.
            `${IDENTITY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
      );
      return response;
    }

    /*
     * Switching workspace is open to anybody with more than one membership —
     * but only between THOSE memberships.
     *
     * It used to be Super Admin only, which left `Account → Workspaces` offering
     * a "Switch" button to people with two memberships that the server then
     * refused. The rule that matters was never the role: it is the check
     * below, that the workspace is one `organisationIds` names — every active
     * workspace for a Super Admin, and exactly the caller's memberships for
     * anyone else. A workspace the caller does not belong to answers the same
     * 404 as one that does not exist, so this cannot be used to discover
     * another client.
     */
    if (action === "select_organisation") {
      const organisationId = clean(payload.organisationId, 100);
      const [organisation] = await context.db
        .select()
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);
      // `scopedDb` would ignore an organisation the actor may not read anyway;
      // refusing here turns a silent no-op into a legible error — the same
      // error, whether the workspace is someone else's or does not exist.
      if (
        !organisation ||
        organisation.status !== "active" ||
        !context.organisationIds.includes(organisation.id)
      ) {
        return Response.json({ error: "That workspace is unavailable." }, { status: 404 });
      }
      const response = Response.json({ ok: true, organisation });
      response.headers.append(
        "Set-Cookie",
        cookie(ORGANISATION_COOKIE, organisation.id),
      );
      return response;
    }

    /*
     * CREATING A WORKSPACE — a Platform Super Admin anywhere, an Owner inside
     * their own client company, nobody else.
     *
     * This used to be Super Admin only, and it created a workspace with no
     * parent. A workspace now always belongs to a client company:
     *
     *   · a Platform Super Admin may name any active company, or name none, in
     *     which case a company of the same name is created for it — the
     *     one-customer-one-workspace shape every existing workspace was given;
     *   · an Owner may only create inside a company they own (the current
     *     workspace's company when none is named). A company id they do not
     *     own is refused with the same sentence as one that does not exist.
     *
     * The new workspace starts with NO members: its company's Owners and the
     * Platform Super Admins see it at once, and everybody else only once they
     * are given a membership. `createWorkspace` holds the rest.
     */
    if (action === "create_organisation") {
      const name = cleanName(payload.name);
      if (!name) {
        return Response.json({ error: "A workspace name is required." }, { status: 400 });
      }
      let companyId = clean(payload.clientCompanyId, 100) || null;
      if (context.platformAdmin) {
        if (companyId) {
          if (!(await findCompany(context.db, companyId))) {
            return Response.json({ error: "That client company is unavailable." }, { status: 404 });
          }
        } else {
          companyId = (
            await createClientCompany(context.db, {
              name,
              createdBy: context.session?.user.id ?? null,
            })
          ).id;
        }
      } else {
        companyId ||= context.clientCompanyId;
        if (!companyId || !context.ownedCompanyIds.includes(companyId)) {
          return Response.json(
            {
              error: "Only a Super Admin or the company's Owner can create workspaces.",
              denied: true,
            },
            { status: 403 },
          );
        }
      }

      /* The template is the company's own default workspace when the caller
         can reach it, so a new branch copies its own company's vocabulary. */
      const company = await findCompany(context.db, companyId);
      const template =
        company?.defaultOrganisationId &&
        context.organisationIds.includes(company.defaultOrganisationId)
          ? company.defaultOrganisationId
          : context.orgId;
      const created = await createWorkspace(context.db, {
        name,
        clientCompanyId: companyId,
        templateOrganisationId: template,
      });

      await recordAudit({
        db: context.db,
        organisationId: created.id,
        actor: auditActor(context),
        action: "workspace.created",
        entityType: "organisation",
        entityId: created.id,
        summary: `Created the workspace ${created.name}.`,
        detail: { clientCompanyId: companyId },
        request,
      });

      const response = Response.json({ organisation: created }, { status: 201 });
      response.headers.append(
        "Set-Cookie",
        cookie(ORGANISATION_COOKIE, created.id),
      );
      return response;
    }

    return Response.json({ error: "Unsupported workspace action." }, { status: 400 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The workspace context could not be updated.",
      },
      { status: 400 },
    );
  }
}
