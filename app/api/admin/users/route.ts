/**
 * People in a workspace: who is here, what they may do, and how to stop them.
 *
 * Four operations, and one rule they all share — every one of them is gated by
 * `can()` on the server before a row is touched. The UI hides controls the
 * caller cannot use, but hiding is a courtesy: a client calling this route with
 * curl gets a 403 with a `denied` flag, not a quietly ignored request.
 *
 *   GET    — the roster for one workspace — its members and its client
 *            company's Owners — plus each person's memberships in the *other*
 *            workspaces the caller can already see.
 *   POST   — invite. Delegated to `/api/auth/invitations`; nothing here writes
 *            an invitation row itself.
 *   PATCH  — edit a profile, change a role, give or take away access to one
 *            of the company's workspaces, deactivate or reactivate.
 *   DELETE — revoke an invitation that has not been accepted yet.
 *
 * SCOPE, NOT RANK. What a caller may do depends on the level their authority
 * comes from: a Platform Super Admin anywhere, an Owner across their own
 * client company's workspaces, an Admin only in the workspaces they
 * administer. Every per-workspace question below is asked of the role the
 * caller holds IN THAT WORKSPACE (`roleInOrganisation`).
 *
 * DEACTIVATION IS NOT DELETION. `users.active` goes to 0 and `status` to
 * "deactivated"; the `users` row, the `memberships` rows and every audit line
 * naming that person stay exactly where they were. `tenant-access.ts` already
 * requires `users.active = 1` when it loads grants, so flipping that one column
 * removes access everywhere on the next request — while leaving "who did this
 * in March" answerable, and leaving reactivation as a single flip back rather
 * than a re-invitation that would silently rebuild the wrong permissions.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { selectInChunks } from "../../../lib/sql-batching";
import { ensureDatabase } from "../../../../db/init";
import {
  clientCompanies,
  clientCompanyMembers,
  invitations,
  memberships,
  platformAdmins,
  users,
} from "../../../../db/schema";
import { getD1 } from "../../../../db";
import { platformAdminIds } from "../../../lib/company-authority";
import { deactivateAccountGuarded } from "../../../lib/company-owners";
import {
  CAPABILITY_CATALOGUE,
  ROLE_LABELS,
  ROLES,
  can,
  canAssignRole,
  canManageRole,
  effectiveCapabilities,
  isWorkspaceRole,
  loadRoleOverridesForOrganisations,
  requireCapability,
  type Capability,
} from "../../../lib/permissions";
import { roleInOrganisation, siteScopeInOrganisation } from "../../../lib/tenant-access";
import type { WorkspaceRole } from "../../../lib/workspace-actor";
import {
  isMembershipRole,
  MEMBERSHIP_ROLES,
  normaliseMembershipRole,
  withArticle,
} from "../../../lib/roles";
import { invitationWorkspaceIds } from "../../auth/invitations/invitation-tokens";
import {
  accountWideRefusal,
  adminContext,
  adminError,
  effectiveTargetRole,
  isRefusal,
  optional,
  readJson,
  recordAudit,
  trimmed,
  type AdminContext,
} from "../admin-context";
import { moduleRefusal } from "../../../lib/module-guard";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * The profile columns `db/schema.ts` does not declare.
 *
 * Stage 20 added them to the table through `db/init.ts`, but the Drizzle model
 * has not caught up and that file is not mine to change. Naming them as SQL
 * fragments reads the real columns without pretending the model knows about
 * them — and it fails loudly at query time rather than silently returning
 * undefined if a column is ever dropped.
 */
const profileColumns = {
  jobTitle: sql<string | null>`users.job_title`,
  phone: sql<string | null>`users.phone`,
  timezone: sql<string | null>`users.timezone`,
  avatarColour: sql<string | null>`users.avatar_colour`,
  status: sql<string>`users.status`,
  deactivatedAt: sql<string | null>`users.deactivated_at`,
  lastLoginAt: sql<string | null>`users.last_login_at`,
  workingStatus: sql<string | null>`users.working_status`,
};

/**
 * May the caller hand out `role` in EVERY one of `organisationIds`?
 *
 * Asked workspace by workspace, with the role the caller holds THERE: the
 * capability (`users.invite` by default) under that workspace's matrix, and
 * the role inside that role's assignment table. An Owner qualifies across
 * their company; an Admin only where they administer; a workspace the caller
 * cannot reach at all fails the whole question. Owner itself is a
 * company-level appointment only a Platform Super Admin makes.
 */
async function mayGrantIn(
  context: AdminContext,
  organisationIds: string[],
  role: WorkspaceRole,
  capability: Capability = "users.invite",
) {
  if (role === "super_admin") return false;
  if (role === "owner") return context.platformAdmin;
  if (!organisationIds.length) return false;
  if (organisationIds.some((id) => !context.organisationIds.includes(id))) return false;
  const overrides = await loadRoleOverridesForOrganisations(context.db, organisationIds);
  return organisationIds.every((id) => {
    const actorRole = roleInOrganisation(context, id);
    return (
      actorRole !== null &&
      /* The ceiling too: a member restricted to some sites THERE grants nothing
         there — or they could hand a new account unrestricted access (review). */
      can(
        {
          role: actorRole,
          capabilities: overrides.get(id)?.[actorRole] ?? {},
          siteRestricted: siteScopeInOrganisation(context, id) !== null,
        },
        capability,
      ) &&
      canAssignRole(actorRole, role)
    );
  });
}

/** The active workspaces of the target's client company that the caller can reach. */
function companyWorkspaces(context: AdminContext) {
  if (!context.targetClientCompanyId) return [];
  return context.activeOrganisations
    .filter(
      (item) =>
        item.clientCompanyId === context.targetClientCompanyId &&
        context.organisationIds.includes(item.id),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function roster(context: AdminContext) {
  const { db, targetOrganisationId, organisationIds, activeOrganisations } = context;

  const person = {
    id: users.id,
    email: users.email,
    fullName: users.fullName,
    active: users.active,
    createdAt: users.createdAt,
    ...profileColumns,
  };

  /*
   * The members of this workspace, at the three membership roles. A legacy
   * `super_admin` membership row is not a member: platform authority lives in
   * `platform_admins`, and MAINTSUPP staff are not on a customer's roster
   * because of an old row. A removed membership is gone from the roster too.
   */
  const memberRows = await db
    .select({
      ...person,
      membershipRole: memberships.role,
      membershipStatus: memberships.status,
      siteScope: memberships.siteScope,
      approvalLimitPence: memberships.approvalLimitPence,
      acceptedAt: memberships.acceptedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, targetOrganisationId),
        inArray(memberships.role, [...MEMBERSHIP_ROLES]),
        sql`${memberships.status} <> 'removed'`,
      ),
    )
    .orderBy(asc(users.fullName), asc(users.email));

  /*
   * The client company's Owners. They reach this workspace without a
   * membership, so they are listed from the company relationship — and an
   * Owner who also has an old membership here is listed once, as Owner.
   */
  const ownerRows = context.targetClientCompanyId
    ? await db
        .select({ ...person, acceptedAt: clientCompanyMembers.acceptedAt })
        .from(clientCompanyMembers)
        .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
        .where(
          and(
            eq(clientCompanyMembers.clientCompanyId, context.targetClientCompanyId),
            eq(clientCompanyMembers.relationship, "owner"),
            eq(clientCompanyMembers.status, "active"),
          ),
        )
        .orderBy(asc(users.fullName), asc(users.email))
    : [];
  const ownerIds = new Set(ownerRows.map((row) => row.id));
  /* The last active Owner cannot be removed or switched off; say so up front. */
  const activeOwnerCount = ownerRows.filter((row) => Boolean(row.active)).length;
  const rows = [
    ...ownerRows.map((row) => ({
      ...row,
      membershipRole: "owner",
      membershipStatus: "active",
      siteScope: null as string | null,
      approvalLimitPence: null as number | null,
    })),
    ...memberRows.filter((row) => !ownerIds.has(row.id)),
  ];

  const userIds = rows.map((row) => row.id);

  /*
   * "A user may belong to several workspaces" — but only the ones the *caller*
   * may already read. An admin of Sunnamusk who can see that a colleague also
   * belongs to Demo Client Ltd has learned that Demo Client Ltd exists and who
   * is in it, which is exactly the cross-tenant leak Stage 19 closed. The filter
   * is `organisationIds`, the list the database granted this actor.
   */
  /*
   * Chunked, because a workspace can have more members than SQLite has bind
   * variables.
   *
   * One `IN (...)` with a placeholder per user, and D1 refused the statement
   * the moment a workspace passed ~100 people — the whole People screen
   * answered 503 "temporarily unavailable", which is the least useful thing it
   * could have said. Found on a demo workspace that had accumulated 99 test
   * accounts, and it would have happened to any real client of that size.
   *
   * `selectInChunks` is the helper the board reads already use for exactly
   * this. Sequential rather than concurrent: D1 serialises statements on one
   * connection anyway.
   */
  const otherMemberships = userIds.length
    ? await selectInChunks(userIds, (chunk) =>
        db
          .select({
            userId: memberships.userId,
            organisationId: memberships.organisationId,
            role: memberships.role,
            status: memberships.status,
          })
          .from(memberships)
          .where(
            and(
              inArray(memberships.userId, chunk),
              inArray(memberships.organisationId, organisationIds),
              inArray(memberships.role, [...MEMBERSHIP_ROLES]),
              sql`${memberships.status} <> 'removed'`,
            ),
          ),
      )
    : [];

  /*
   * Who on this roster is a Platform Super Admin.
   *
   * A workspace admin must learn that a person outranks them even though that
   * authority sits outside any workspace they can see. Only the boolean leaves
   * the server.
   */
  const superAdminIds = await platformAdminIds(db, userIds);

  const organisationNames = new Map(
    activeOrganisations.map((organisation) => [organisation.id, organisation.name]),
  );
  const byUser = new Map<string, Array<Record<string, unknown>>>();
  for (const row of otherMemberships) {
    const list = byUser.get(row.userId) ?? [];
    list.push({
      organisationId: row.organisationId,
      organisationName: organisationNames.get(row.organisationId) ?? "Unknown workspace",
      role: row.role,
      roleLabel: isWorkspaceRole(row.role) ? ROLE_LABELS[row.role] : row.role,
      status: row.status,
      isCurrent: row.organisationId === targetOrganisationId,
    });
    byUser.set(row.userId, list);
  }

  const self = context.identityEmail.toLowerCase();
  return rows.map((row) => {
    const effectiveRole: WorkspaceRole = superAdminIds.has(row.id)
      ? "super_admin"
      : ownerIds.has(row.id)
        ? "owner"
        : (normaliseMembershipRole(row.membershipRole) ?? "client");
    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      jobTitle: row.jobTitle,
      phone: row.phone,
      timezone: row.timezone,
      avatarColour: row.avatarColour,
      status: row.status,
      active: Boolean(row.active),
      deactivatedAt: row.deactivatedAt,
      lastLoginAt: row.lastLoginAt,
      workingStatus: row.workingStatus,
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt,
      role: row.membershipRole,
      roleLabel: isWorkspaceRole(row.membershipRole)
        ? ROLE_LABELS[row.membershipRole]
        : row.membershipRole,
      membershipStatus: row.membershipStatus,
      siteScope: row.siteScope,
      approvalLimitPence: row.approvalLimitPence,
      memberships: byUser.get(row.id) ?? [],
      isSelf: row.email.toLowerCase() === self,
      /* An Owner's access is the whole company, not memberships. */
      companyOwner: ownerIds.has(row.id),
      soleOwner: ownerIds.has(row.id) && Boolean(row.active) && activeOwnerCount === 1,
      platformAdmin: superAdminIds.has(row.id),
      /*
       * Whether the caller may act on this person at all — `canManageRole`,
       * the same rule PATCH and the password-reset route apply, computed from
       * the same effective role. An Admin manages Managers and Clients; an
       * Owner also Admins; only a Super Admin manages Owners. The screen draws
       * controls only where a change could be accepted. A control is a
       * courtesy; PATCH still decides.
       */
      manageable: canManageRole(context.actor.role, effectiveRole),
    };
  });
}

/**
 * Invitations that have neither been accepted nor revoked. Real rows only.
 *
 * An expired invitation is still returned, carrying `expired: true`, because
 * the screen's job is to answer "why has this person not arrived yet" and
 * hiding the row answers it with silence. `/invite/[token]` refuses an expired
 * token, so a row marked expired here is genuinely dead — the flag and the
 * behaviour come from the same timestamp.
 */
async function pendingInvitations(context: AdminContext) {
  const rows = await context.db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      invitedBy: invitations.invitedBy,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      organisationId: invitations.organisationId,
      clientCompanyId: invitations.clientCompanyId,
      workspaceIds: invitations.workspaceIds,
    })
    .from(invitations)
    .where(
      and(
        /*
         * This workspace's invitations: the ones that land here, and the
         * company's invitations that grant it — an Owner invitation grants
         * every workspace of the company, a workspace invitation the ones
         * listed on it (filtered below).
         */
        context.targetClientCompanyId
          ? sql`(${invitations.organisationId} = ${context.targetOrganisationId}
                 OR ${invitations.clientCompanyId} = ${context.targetClientCompanyId})`
          : eq(invitations.organisationId, context.targetOrganisationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(desc(invitations.createdAt))
    .limit(100);

  /*
   * `invited_by` is a user id. The screen used to print it raw — an internal
   * identifier in the "Invited by" column. Resolved to the inviter's name or
   * email here; the id itself no longer leaves the server.
   */
  const inviterIds = [...new Set(rows.map((row) => row.invitedBy).filter(Boolean))] as string[];
  /* Up to a hundred invitations, so up to a hundred inviters: chunked like the roster. */
  const inviters = new Map(
    (
      await selectInChunks(inviterIds, (chunk) =>
        context.db
          .select({ id: users.id, email: users.email, fullName: users.fullName })
          .from(users)
          .where(inArray(users.id, chunk)),
      )
    ).map((row) => [row.id, row.fullName?.trim() || row.email]),
  );

  const now = Date.now();
  const names = new Map(context.activeOrganisations.map((item) => [item.id, item.name]));
  const listed = rows
    .map((row) => ({
      row,
      companyWide: row.role === "owner",
      grants: invitationWorkspaceIds({
        workspace_ids: row.workspaceIds,
        organisation_id: row.organisationId,
      }),
    }))
    .filter(
      ({ row, companyWide, grants }) =>
        row.role !== "super_admin" &&
        (companyWide || grants.includes(context.targetOrganisationId)) &&
        /* Owner invitations are company business: Super Admins and Owners. */
        (!companyWide || context.actor.role === "super_admin" || context.actor.role === "owner"),
    );
  const result = [];
  for (const { row, companyWide, grants } of listed) {
    const role = isWorkspaceRole(row.role) ? row.role : null;
    result.push({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      clientCompanyId: row.clientCompanyId,
      roleLabel: role ? ROLE_LABELS[role] : row.role,
      invitedBy: row.invitedBy ? (inviters.get(row.invitedBy) ?? null) : null,
      expired: row.expiresAt ? Date.parse(row.expiresAt) <= now : false,
      companyWide,
      /* Only the workspaces the caller can already see are named. */
      workspaces: companyWide
        ? []
        : grants
            .filter((id) => context.organisationIds.includes(id))
            .map((id) => ({ id, name: names.get(id) ?? "Workspace" })),
      /* Withdraw and resend are the power to issue, so the same test. */
      manageable: role ? await mayGrantIn(context, companyWide ? [] : grants, role) : false,
    });
  }
  return result;
}

/**
 * The workspaces this caller may open the People screen for.
 *
 * `organisationIds` is every workspace the caller can READ, which for a person
 * who is an Admin of one client and a Client of another includes a workspace
 * where this screen answers 403. Offering it in the picker is a dead end, so
 * the list is narrowed to the workspaces where `users.view` actually holds.
 */
async function administrableOrganisations(context: AdminContext) {
  const visible = context.activeOrganisations.filter((item) =>
    context.organisationIds.includes(item.id),
  );
  if (context.platformAdmin) return visible;
  const overrides = await loadRoleOverridesForOrganisations(
    context.db,
    visible.map((item) => item.id),
  );
  return visible.filter((item) => {
    const role = roleInOrganisation(context, item.id);
    return (
      role !== null &&
      can({ role, capabilities: overrides.get(item.id)?.[role] ?? {} }, "users.view")
    );
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const context = await adminContext(request, url.searchParams.get("organisationId"));
    if (isRefusal(context)) return context;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal({ ...context, orgId: context.targetOrganisationId }, "admin-users");
    if (switchedOff) return switchedOff;

    // Gate one. A client's built-in defaults do not include `users.view`, so
    // this is where a client's GET stops — with a 403, before any row is read.
    const denied = requireCapability(context.subject, "users.view");
    if (denied) return denied;

    const organisation =
      context.activeOrganisations.find(
        (item) => item.id === context.targetOrganisationId,
      ) ?? context.organisation;

    const company = context.targetClientCompanyId
      ? (
          await context.db
            .select({
              id: clientCompanies.id,
              name: clientCompanies.name,
              defaultOrganisationId: clientCompanies.defaultOrganisationId,
            })
            .from(clientCompanies)
            .where(eq(clientCompanies.id, context.targetClientCompanyId))
            .limit(1)
        )[0] ?? null
      : null;
    const companyNames = new Map<string, string>();
    const administrable = await administrableOrganisations(context);
    const namedCompanies = [
      ...new Set(administrable.map((item) => item.clientCompanyId).filter(Boolean)),
    ] as string[];
    if (namedCompanies.length) {
      for (const row of await context.db
        .select({ id: clientCompanies.id, name: clientCompanies.name })
        .from(clientCompanies)
        .where(inArray(clientCompanies.id, namedCompanies))) {
        companyNames.set(row.id, row.name);
      }
    }

    /*
     * The company's workspaces the caller can reach, each with the workspace
     * roles the caller may give THERE — which is what the invite and access
     * dialogs offer. An Admin of A1 sees A2 listed only if they can reach it,
     * and can give nothing in a workspace they do not administer.
     */
    const siblings = companyWorkspaces(context);
    const siblingOverrides = await loadRoleOverridesForOrganisations(
      context.db,
      siblings.map((item) => item.id),
    );
    const workspaceGrants = siblings.map((item) => {
      const actorRole = roleInOrganisation(context, item.id);
      const subject = {
        role: actorRole ?? ("client" as const),
        capabilities: actorRole ? (siblingOverrides.get(item.id)?.[actorRole] ?? {}) : {},
      };
      const grantable = (capability: Capability) =>
        actorRole && can(subject, capability)
          ? MEMBERSHIP_ROLES.filter((role) => canAssignRole(actorRole, role))
          : [];
      return {
        id: item.id,
        name: item.name,
        isCurrent: item.id === context.targetOrganisationId,
        isDefault: item.id === company?.defaultOrganisationId,
        inviteRoles: grantable("users.invite"),
        accessRoles: grantable("users.edit"),
      };
    });

    return Response.json({
      organisation: {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        planTier: organisation.planTier,
        clientCompanyId: context.targetClientCompanyId,
      },
      company: company
        ? {
            id: company.id,
            name: company.name,
            owned: context.ownedCompanyIds.includes(company.id),
            /* MAINTSUPP's own demonstration company: nobody is invited into it. */
            internal: context.internalCompanyIds.includes(company.id),
            defaultOrganisationId: company.defaultOrganisationId,
          }
        : null,
      companyWorkspaces: workspaceGrants,
      organisations: administrable.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        clientCompanyId: item.clientCompanyId ?? null,
        companyName: item.clientCompanyId ? (companyNames.get(item.clientCompanyId) ?? null) : null,
      })),
      actor: {
        email: context.identityEmail,
        role: context.actor.role,
        roleLabel: ROLE_LABELS[context.actor.role],
        platformAdmin: context.platformAdmin,
        ownsCompany: Boolean(
          context.targetClientCompanyId &&
            context.ownedCompanyIds.includes(context.targetClientCompanyId),
        ),
        capabilities: effectiveCapabilities(
          context.actor.role,
          context.subject.capabilities,
          context.subject.siteRestricted,
        ),
      },
      /*
       * Super Admin is listed and never assignable here: platform authority is
       * not granted from a customer's People screen. Owner is assignable only
       * by a Platform Super Admin, and only by invitation.
       */
      roles: ROLES.map((role) => ({
        key: role,
        label: ROLE_LABELS[role],
        assignable: canAssignRole(context.actor.role, role),
      })),
      capabilityCatalogue: CAPABILITY_CATALOGUE,
      users: await roster(context),
      invitations: await pendingInvitations(context),
    });
  } catch (error) {
    return adminError(error, "The people directory is temporarily unavailable.");
  }
}

/* ------------------------------------------------------------------ */
/* Inviting                                                            */
/* ------------------------------------------------------------------ */

/**
 * Invite somebody, by asking the invitation service to do it.
 *
 * The token, its hash, the expiry and the email all belong to
 * `/api/auth/invitations`. Writing an `invitations` row here as well would give
 * the product two places that mint credentials, and they would drift — one of
 * them would eventually forget to hash, or to expire. So this route does the
 * part that is genuinely its own (is the caller allowed to invite, and at what
 * role) and forwards the rest.
 *
 * The caller's identity is forwarded with the request, so the invitation
 * service applies its own checks against the same actor rather than trusting a
 * claim made by this route.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = await readJson<{
      email?: string;
      role?: string;
      organisationId?: string;
      organisationIds?: unknown;
      clientCompanyId?: string;
      message?: string;
      invitationId?: string;
    }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal({ ...context, orgId: context.targetOrganisationId }, "admin-users");
    if (switchedOff) return switchedOff;

    const denied = requireCapability(context.subject, "users.invite");
    if (denied) return denied;

    /*
     * RESEND IS ITS OWN REQUEST, AND IT CARRIES NO ADDRESS OR ROLE.
     *
     * Only a hash of an invitation link is stored, so "send it again" has to
     * mint a new link — which retires the old one. That used to be a second
     * ordinary invite with the same address, and the invitation service now
     * refuses an ordinary invite while one is outstanding, so a double click
     * cannot send two emails. Resending names the pending invitation instead,
     * and the address, role and message are read back from that row: a resend
     * can repeat an invitation, never change what it grants or who it is for.
     */
    const invitationId = trimmed(body.invitationId, 60);
    let email: string;
    let role: string;
    let message: string | null;
    let workspaceIds: string[];
    let clientCompanyId: string | null = context.targetClientCompanyId;
    if (invitationId) {
      const [pending] = await context.db
        .select({
          email: invitations.email,
          role: invitations.role,
          message: invitations.message,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          organisationId: invitations.organisationId,
          clientCompanyId: invitations.clientCompanyId,
          workspaceIds: invitations.workspaceIds,
        })
        .from(invitations)
        .where(invitationInScope(context, invitationId))
        .limit(1);
      if (!pending) {
        return Response.json(
          { error: "That invitation is not in this workspace." },
          { status: 404 },
        );
      }
      if (pending.acceptedAt || pending.revokedAt) {
        return Response.json(
          {
            error: pending.acceptedAt
              ? "That invitation has already been accepted, so there is nothing to resend."
              : "That invitation was withdrawn. Invite the person again instead.",
          },
          { status: 409 },
        );
      }
      email = pending.email.toLowerCase();
      role = pending.role;
      message = pending.message;
      clientCompanyId = pending.clientCompanyId ?? clientCompanyId;
      workspaceIds =
        role === "owner"
          ? []
          : invitationWorkspaceIds({
              workspace_ids: pending.workspaceIds,
              organisation_id: pending.organisationId,
            });
    } else {
      email = trimmed(body.email, 180).toLowerCase();
      role = trimmed(body.role, 40) || "client";
      message = optional(body.message, 500);
      const named = Array.isArray(body.organisationIds)
        ? body.organisationIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : [];
      workspaceIds = role === "owner" ? [] : named.length ? named : [context.targetOrganisationId];
    }

    if (!email.includes("@")) {
      return Response.json(
        { error: "A valid email address is required." },
        { status: 400 },
      );
    }

    if (!isWorkspaceRole(role)) {
      return Response.json(
        { error: `"${role}" is not a role this workspace has.` },
        { status: 400 },
      );
    }

    /*
     * GUARD-RAIL — no escalation by invitation. An admin who could invite a
     * super admin could hand themselves that account's credentials and hold
     * powers `admin` was never granted, which would make every other limit on
     * the role decorative. Asked of EVERY workspace the invitation would
     * grant, with the role the caller holds in each (`mayGrantIn`); the
     * invitation service asks again.
     */
    if (!(await mayGrantIn(context, workspaceIds, role))) {
      return Response.json(
        {
          error:
            role === "owner"
              ? "Only a Super Admin can appoint a company Owner."
              : role === "super_admin"
                ? "Platform Super Admins are not appointed from this screen."
                : workspaceIds.length > 1
                  ? `You cannot invite somebody as ${withArticle(role)} to every one of those workspaces.`
                  : `As ${withArticle(context.actor.role)} you cannot invite somebody as ${withArticle(role)}.`,
          denied: true,
        },
        { status: 403 },
      );
    }

    const target = new URL("/api/auth/invitations", request.url);
    const forwarded = new Headers({ "content-type": "application/json" });
    for (const header of ["cookie", "x-maintsupp-identity", "authorization"]) {
      const value = request.headers.get(header);
      if (value) forwarded.set(header, value);
    }

    const response = await fetch(target, {
      method: "POST",
      headers: forwarded,
      body: JSON.stringify({
        email,
        role,
        organisationIds: role === "owner" ? [] : workspaceIds,
        clientCompanyId,
        message,
        resend: Boolean(invitationId),
      }),
    });

    const payload = await response
      .json()
      .catch(() => ({ error: "The invitation service returned an unreadable reply." }));

    if (!response.ok) {
      // Passed through rather than rewritten: the invitation service's own
      // refusal is more accurate than anything this route could guess.
      return Response.json(payload, { status: response.status });
    }

    await recordAudit(context, {
      action: invitationId ? "user.invitation_resent" : "user.invited",
      summary: `${invitationId ? "Resent the invitation to" : "Invited"} ${email} as ${ROLE_LABELS[role]}`,
      entityType: "invitation",
      entityId: email,
      detail: {
        email,
        role,
        workspaceIds,
        clientCompanyId,
        delivery: payload?.delivery?.status ?? null,
      },
    });

    return Response.json(payload, { status: response.status });
  } catch (error) {
    return adminError(error, "The invitation could not be sent.");
  }
}

/**
 * An invitation id, found only if it belongs to the workspace being
 * administered — landing here, or issued for its client company. A bare id
 * from another tenant matches nothing.
 */
function invitationInScope(context: AdminContext, invitationId: string) {
  return and(
    eq(invitations.id, invitationId),
    context.targetClientCompanyId
      ? sql`(${invitations.organisationId} = ${context.targetOrganisationId}
             OR ${invitations.clientCompanyId} = ${context.targetClientCompanyId})`
      : eq(invitations.organisationId, context.targetOrganisationId),
  );
}

/**
 * Withdraw an invitation that has not been accepted.
 *
 * Sending an invitation to the wrong address was, until now, irreversible from
 * the product: the row sat in "Pending invitations" until it expired, and the
 * link in that person's inbox kept working the whole time. That is a live
 * credential for a workspace, and there was no button to take it back.
 *
 * Revoked, not deleted. `revoked_at` is stamped and the row stays, so "who was
 * invited, by whom, and who called it back" survives — the same reasoning that
 * makes deactivation keep the user row. `/invite/[token]` already refuses a
 * revoked token, so the link dies on the next click without a second mechanism
 * needing to agree.
 *
 * Gated on `users.invite`: the power to withdraw is the power to issue. An
 * invitation belonging to another workspace is not found rather than refused,
 * because the organisation filter is part of the lookup — a bare id from
 * another tenant matches nothing.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const invitationId = trimmed(url.searchParams.get("invitationId"), 60);

    const context = await adminContext(
      request,
      url.searchParams.get("organisationId"),
    );
    if (isRefusal(context)) return context;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal({ ...context, orgId: context.targetOrganisationId }, "admin-users");
    if (switchedOff) return switchedOff;

    const denied = requireCapability(context.subject, "users.invite");
    if (denied) return denied;

    if (!invitationId) {
      return Response.json(
        { error: "Which invitation? None was named." },
        { status: 400 },
      );
    }

    const [target] = await context.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        organisationId: invitations.organisationId,
        workspaceIds: invitations.workspaceIds,
      })
      .from(invitations)
      .where(invitationInScope(context, invitationId))
      .limit(1);

    if (!target) {
      return Response.json(
        { error: "That invitation is not in this workspace." },
        { status: 404 },
      );
    }
    /*
     * The power to withdraw is the power to issue — including its ceiling, and
     * in every workspace the invitation grants. An admin cannot issue an Owner
     * invitation, so they cannot withdraw one a Super Admin issued either.
     */
    const withdrawable =
      isWorkspaceRole(target.role) &&
      (await mayGrantIn(
        context,
        target.role === "owner"
          ? []
          : invitationWorkspaceIds({
              workspace_ids: target.workspaceIds,
              organisation_id: target.organisationId,
            }),
        target.role,
      ));
    if (isWorkspaceRole(target.role) && !withdrawable && !context.platformAdmin) {
      return Response.json(
        {
          error: `As ${withArticle(context.actor.role)} you cannot withdraw an invitation for ${withArticle(target.role)}.`,
          denied: true,
        },
        { status: 403 },
      );
    }
    if (target.acceptedAt) {
      return Response.json(
        {
          error:
            "That invitation has already been accepted. Deactivate the person instead — revoking the invitation now would take nothing away.",
        },
        { status: 409 },
      );
    }
    if (target.revokedAt) {
      // Already gone. Answered as success so a double click is not an error.
      return Response.json({ ok: true, alreadyRevoked: true });
    }

    await context.db
      .update(invitations)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(invitations.id, invitationId));

    await recordAudit(context, {
      action: "user.invitation_revoked",
      summary: `Revoked the invitation to ${target.email}`,
      entityType: "invitation",
      entityId: invitationId,
      detail: { email: target.email, role: target.role },
    });

    return Response.json({ ok: true });
  } catch (error) {
    return adminError(error, "The invitation could not be withdrawn.");
  }
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

type TargetMember = {
  id: string;
  email: string;
  fullName: string | null;
  active: boolean;
  role: string;
};

/**
 * The target, resolved through the workspace rather than by bare id: a member
 * of this workspace, or an Owner of its client company (whose `role` is then
 * "owner" whatever else they hold here).
 */
async function loadTarget(
  context: AdminContext,
  userId: string,
): Promise<TargetMember | null> {
  const person = {
    id: users.id,
    email: users.email,
    fullName: users.fullName,
    active: users.active,
  };
  if (context.targetClientCompanyId) {
    const [owner] = await context.db
      .select(person)
      .from(clientCompanyMembers)
      .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
      .where(
        and(
          eq(clientCompanyMembers.clientCompanyId, context.targetClientCompanyId),
          eq(clientCompanyMembers.userId, userId),
          eq(clientCompanyMembers.relationship, "owner"),
          eq(clientCompanyMembers.status, "active"),
        ),
      )
      .limit(1);
    if (owner) return { ...owner, active: Boolean(owner.active), role: "owner" };
  }
  const [row] = await context.db
    .select({ ...person, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, context.targetOrganisationId),
        eq(memberships.userId, userId),
        inArray(memberships.role, [...MEMBERSHIP_ROLES]),
        sql`${memberships.status} <> 'removed'`,
      ),
    )
    .limit(1);
  return row ? { ...row, active: Boolean(row.active) } : null;
}

/**
 * Whether deactivating `targetUserId` would leave the platform with no active
 * Super Admin.
 *
 * GUARD-RAIL — the last Super Admin. Switching off the only person who can
 * administer the platform leaves no way back: nobody can reactivate the
 * account, appoint an Owner or create a company, and the only repair is a
 * hand-written database row. Platform authority is `platform_admins` now, so
 * that is what is counted — active rows whose account is active, the same
 * two conditions the tenancy resolver requires.
 */
async function isLastPlatformAdmin(context: AdminContext, targetUserId: string) {
  const admins = await platformAdminIds(context.db, [targetUserId]);
  if (!admins.has(targetUserId)) return false;
  const [survivors] = await context.db
    .select({ remaining: sql<number>`count(*)` })
    .from(platformAdmins)
    .innerJoin(users, eq(users.id, platformAdmins.userId))
    .where(
      and(
        eq(platformAdmins.status, "active"),
        eq(users.active, true),
        sql`${platformAdmins.userId} <> ${targetUserId}`,
      ),
    );
  return Number(survivors?.remaining ?? 0) === 0;
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const body = await readJson<{
      userId?: string;
      action?: string;
      organisationId?: string;
      role?: string;
      workspaceId?: string;
      access?: string;
      fullName?: string;
      jobTitle?: string;
      phone?: string;
      timezone?: string;
      avatarColour?: string;
    }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;
    /* The switch holds at the API too, not only in the navigation — see
       `module-guard.ts`. */
    const switchedOff = await moduleRefusal({ ...context, orgId: context.targetOrganisationId }, "admin-users");
    if (switchedOff) return switchedOff;

    const userId = trimmed(body.userId, 120);
    const action = trimmed(body.action, 40);
    if (!userId || !action) {
      return Response.json(
        { error: "A user and an action are required." },
        { status: 400 },
      );
    }

    const target = await loadTarget(context, userId);
    if (!target) {
      // 404, not 403: the caller has already proved they may administer this
      // workspace, and the honest answer is that this person is not in it.
      return Response.json(
        { error: "That person is not a member of this workspace." },
        { status: 404 },
      );
    }

    const isSelf = target.email.toLowerCase() === context.identityEmail.toLowerCase();

    /*
     * GUARD-RAIL — no acting upwards or sideways. An admin acting on a super
     * admin could deactivate the account that outranks them and then do as they
     * liked; since the owner's role decision, an admin may not act on another
     * ADMIN either (`canManageRole`: an Admin manages Managers and Clients).
     * The role compared is the EFFECTIVE one: the membership here, unless the
     * person is a Super Admin anywhere — see `effectiveTargetRole`.
     *
     * Editing your own profile is the one exception: it changes nothing about
     * anybody's access, and every other self-change is refused further down.
     */
    const targetRole = await effectiveTargetRole(context, target.id, target.role);
    if (
      !canManageRole(context.actor.role, targetRole) &&
      !(isSelf && action === "profile")
    ) {
      return Response.json(
        {
          error: `As ${withArticle(context.actor.role)} you cannot change the account of ${withArticle(targetRole)}.`,
          denied: true,
        },
        { status: 403 },
      );
    }

    if (action === "profile") {
      const denied = requireCapability(context.subject, "users.edit");
      if (denied) return denied;

      // The profile belongs to the account, which other workspaces show too.
      const elsewhere = await accountWideRefusal(context, target.id, "users.edit");
      if (elsewhere) return elsewhere;

      const fullName = optional(body.fullName, 120);
      const jobTitle = optional(body.jobTitle, 120);
      const phone = optional(body.phone, 40);
      const timezone = trimmed(body.timezone, 60) || "Europe/London";
      const avatarColour = /^#[0-9a-fA-F]{6}$/.test(trimmed(body.avatarColour, 7))
        ? trimmed(body.avatarColour, 7)
        : null;

      // Raw SQL because the Drizzle model does not carry the Stage 20 profile
      // columns; see `profileColumns` above. `email` is deliberately not
      // settable — it is the identity every membership lookup joins on.
      await context.db.run(sql`
        update users
           set full_name = ${fullName},
               job_title = ${jobTitle},
               phone = ${phone},
               timezone = ${timezone},
               avatar_colour = ${avatarColour},
               updated_at = CURRENT_TIMESTAMP
         where id = ${target.id}
      `);

      await recordAudit(context, {
        action: "user.profile_updated",
        summary: `Updated ${target.email}'s profile`,
        entityType: "user",
        entityId: target.id,
        detail: { fullName, jobTitle, phone, timezone },
      });
      return Response.json({ ok: true, userId: target.id });
    }

    if (action === "role") {
      const denied = requireCapability(context.subject, "users.edit");
      if (denied) return denied;

      const role = trimmed(body.role, 40);
      /*
       * A workspace role is one of the three membership roles. Owner is a
       * company appointment (by invitation, from a Super Admin) and Super
       * Admin a platform one; neither is set by editing a membership.
       */
      if (!isMembershipRole(role)) {
        /* Asking for a role above your reach is an escalation attempt, and is
           answered as one; a role you could give, but not as a membership, is
           a malformed request. */
        if (isWorkspaceRole(role) && !canAssignRole(context.actor.role, role)) {
          return Response.json(
            {
              error: `As ${withArticle(context.actor.role)} you cannot grant the ${ROLE_LABELS[role]} role.`,
              denied: true,
            },
            { status: 403 },
          );
        }
        return Response.json(
          {
            error: isWorkspaceRole(role)
              ? `${ROLE_LABELS[role]} is not a workspace role. Choose Admin, Manager or Client.`
              : `"${role}" is not a role this workspace has.`,
          },
          { status: 400 },
        );
      }
      if (target.role === "owner") {
        return Response.json(
          {
            error:
              "An Owner's access comes from the company, not from a workspace role. Remove them as Owner first.",
          },
          { status: 409 },
        );
      }

      /*
       * GUARD-RAIL — no self-promotion or self-demotion. Promoting yourself
       * makes the escalation check below pointless (you would simply do it in
       * two steps), and demoting yourself is the same lockout the last-super-
       * admin rule guards against, arrived at from a different direction.
       */
      if (isSelf) {
        return Response.json(
          {
            error: "You cannot change your own role. Ask another administrator.",
            denied: true,
          },
          { status: 403 },
        );
      }

      if (!canAssignRole(context.actor.role, role)) {
        return Response.json(
          {
            error: `As ${withArticle(context.actor.role)} you cannot grant the ${ROLE_LABELS[role]} role.`,
            denied: true,
          },
          { status: 403 },
        );
      }

      await context.db
        .update(memberships)
        .set({ role, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(memberships.userId, target.id),
            eq(memberships.organisationId, context.targetOrganisationId),
          ),
        );

      await recordAudit(context, {
        action: "user.role_changed",
        summary: `Changed ${target.email} from ${ROLE_LABELS[target.role as WorkspaceRole] ?? target.role} to ${ROLE_LABELS[role]}`,
        entityType: "user",
        entityId: target.id,
        detail: { from: target.role, to: role },
      });
      return Response.json({ ok: true, userId: target.id, role });
    }

    /*
     * WORKSPACE ACCESS — give this person a role in another workspace of the
     * same client company, or take one away.
     *
     * Nothing is inherited downwards: an Admin of A1 reaches A2 only once
     * somebody who may grant it there does. The caller needs `users.edit` in
     * the workspace being changed, and the role inside their assignment table
     * THERE (granting) or the existing role inside what they manage there
     * (removing). The person must already be on this workspace's roster, and
     * the other workspace must belong to the same company — access never
     * crosses a company boundary from this screen.
     */
    if (action === "workspace_access") {
      /* Access management here first — a site-restricted member never holds it
         (SITE_RESTRICTED_CEILING) — then each workspace's own rule below. */
      const deniedHere = requireCapability(context.subject, "users.edit");
      if (deniedHere) return deniedHere;
      const workspaceId = trimmed(body.workspaceId, 100);
      const access = trimmed(body.access, 20);
      const workspace = context.activeOrganisations.find((item) => item.id === workspaceId);
      if (workspace?.clientCompanyId && context.internalCompanyIds.includes(workspace.clientCompanyId)) {
        return Response.json(
          {
            error:
              "That is a MAINTSUPP internal workspace. Only Platform Super Admins work in it, so nobody is given access to it here.",
            denied: true,
          },
          { status: 409 },
        );
      }
      if (
        !workspace ||
        !context.organisationIds.includes(workspace.id) ||
        !context.targetClientCompanyId ||
        workspace.clientCompanyId !== context.targetClientCompanyId
      ) {
        return Response.json(
          { error: "That workspace is not one of this company's workspaces you can manage.", denied: true },
          { status: 403 },
        );
      }
      if (access !== "grant" && access !== "remove") {
        return Response.json({ error: "Choose to grant or remove access." }, { status: 400 });
      }
      if (isSelf) {
        return Response.json(
          { error: "You cannot change your own workspace access. Ask another administrator.", denied: true },
          { status: 403 },
        );
      }
      if (target.role === "owner" || targetRole === "super_admin") {
        return Response.json(
          {
            error:
              target.role === "owner"
                ? "An Owner already reaches every workspace of the company."
                : "A Super Admin already reaches every workspace.",
          },
          { status: 409 },
        );
      }

      const [existing] = await context.db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, target.id), eq(memberships.organisationId, workspace.id)))
        .limit(1);
      const existingRole =
        existing && existing.status !== "removed" ? normaliseMembershipRole(existing.role) : null;
      const now = new Date().toISOString();

      if (access === "grant") {
        const role = trimmed(body.role, 40);
        if (!isMembershipRole(role)) {
          return Response.json(
            { error: "Choose Admin, Manager or Client for that workspace." },
            { status: 400 },
          );
        }
        if (existingRole) {
          return Response.json(
            { error: `${target.email} already has access to ${workspace.name}. Change their role there instead.` },
            { status: 409 },
          );
        }
        if (!(await mayGrantIn(context, [workspace.id], role, "users.edit"))) {
          return Response.json(
            { error: `You cannot give somebody ${withArticle(role)} role in ${workspace.name}.`, denied: true },
            { status: 403 },
          );
        }
        await context.db
          .insert(memberships)
          .values({
            id: `membership-${target.id}-${workspace.id}`,
            userId: target.id,
            organisationId: workspace.id,
            role,
            status: "active",
            invitedBy: context.session?.user.id ?? null,
            acceptedAt: now,
          })
          .onConflictDoUpdate({
            target: [memberships.userId, memberships.organisationId],
            set: { role, status: "active", acceptedAt: now, updatedAt: now },
          });
        await recordAudit(context, {
          action: "user.workspace_granted",
          summary: `Gave ${target.email} ${withArticle(role)} role in ${workspace.name}`,
          entityType: "user",
          entityId: target.id,
          detail: { workspaceId: workspace.id, role },
        });
        return Response.json({ ok: true, userId: target.id, workspaceId: workspace.id, role });
      }

      if (!existingRole) {
        return Response.json({ ok: true, alreadyRemoved: true });
      }
      const removerRole = roleInOrganisation(context, workspace.id);
      const overrides = await loadRoleOverridesForOrganisations(context.db, [workspace.id]);
      const mayRemove =
        removerRole !== null &&
        can(
          {
            role: removerRole,
            capabilities: overrides.get(workspace.id)?.[removerRole] ?? {},
            siteRestricted: siteScopeInOrganisation(context, workspace.id) !== null,
          },
          "users.edit",
        ) &&
        canManageRole(removerRole, existingRole);
      if (!mayRemove) {
        return Response.json(
          { error: `You cannot remove ${withArticle(existingRole)} from ${workspace.name}.`, denied: true },
          { status: 403 },
        );
      }
      const [remaining] = await context.db
        .select({ count: sql<number>`count(*)` })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, target.id),
            eq(memberships.status, "active"),
            inArray(memberships.role, [...MEMBERSHIP_ROLES]),
            sql`${memberships.organisationId} <> ${workspace.id}`,
          ),
        );
      if (Number(remaining?.count ?? 0) === 0) {
        return Response.json(
          {
            error: `${workspace.name} is the only workspace ${target.email} can open. Deactivate the person instead.`,
            guardRail: "last_workspace",
          },
          { status: 409 },
        );
      }
      await context.db
        .update(memberships)
        .set({ status: "removed", updatedAt: now })
        .where(and(eq(memberships.userId, target.id), eq(memberships.organisationId, workspace.id)));
      await recordAudit(context, {
        action: "user.workspace_removed",
        summary: `Removed ${target.email}'s access to ${workspace.name}`,
        entityType: "user",
        entityId: target.id,
        detail: { workspaceId: workspace.id, role: existingRole },
      });
      return Response.json({ ok: true, userId: target.id, workspaceId: workspace.id, removed: true });
    }

    if (action === "deactivate" || action === "reactivate") {
      const denied = requireCapability(context.subject, "users.deactivate");
      if (denied) return denied;

      /*
       * `users.active` is the ACCOUNT's switch, so flipping it removes (or
       * restores) access to every workspace the person belongs to — not just
       * this one. Below Super Admin, that is only allowed when the caller could
       * make the same change in each of those workspaces.
       */
      const elsewhere = await accountWideRefusal(context, target.id, "users.deactivate");
      if (elsewhere) return elsewhere;

      if (action === "deactivate") {
        /*
         * GUARD-RAIL — you cannot switch yourself off. There is no undo
         * available to the person who just did it: the next request they make
         * resolves no active membership, so the button that would turn it back
         * on is behind a screen they can no longer load.
         */
        if (isSelf) {
          return Response.json(
            {
              error: "You cannot deactivate your own account.",
              denied: true,
            },
            { status: 403 },
          );
        }

        // Deactivation reaches the whole account, including platform
        // authority, so the last-Super-Admin question is the platform's.
        if (await isLastPlatformAdmin(context, target.id)) {
          return Response.json(
            {
              error: `${target.email} is the last active Super Admin. Appoint another Super Admin first.`,
              denied: true,
              guardRail: "last_super_admin",
            },
            { status: 409 },
          );
        }

        /*
         * No DELETE. The row, its memberships and its audit history all stay;
         * only the flag `tenant-access.ts` reads is cleared — and never on the
         * last active Owner of a client company. That rule is inside the
         * write (`deactivateAccountGuarded`), so two deactivations at the same
         * moment cannot leave a company with no Owner.
         */
        const blocking = await deactivateAccountGuarded(await getD1(), target.id);
        if (blocking.length) {
          return Response.json(
            {
              error: `${target.email} is the only Owner of ${blocking.map((company) => company.name).join(", ")}. Appoint another Owner first, then deactivate this account.`,
              denied: true,
              guardRail: "last_owner",
            },
            { status: 409 },
          );
        }
      } else {
        await context.db.run(sql`
          update users
             set active = 1,
                 status = 'active',
                 deactivated_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
           where id = ${target.id}
        `);
      }

      await recordAudit(context, {
        action: action === "deactivate" ? "user.deactivated" : "user.reactivated",
        summary: `${action === "deactivate" ? "Deactivated" : "Reactivated"} ${target.email}`,
        entityType: "user",
        entityId: target.id,
        detail: { email: target.email },
      });
      return Response.json({ ok: true, userId: target.id, active: action === "reactivate" });
    }

    return Response.json({ error: `Unsupported action "${action}".` }, { status: 400 });
  } catch (error) {
    return adminError(error, "That change could not be saved.");
  }
}
