import { and, eq } from "drizzle-orm";
/**
 * The two questions every `/api/admin/*` route has to answer before it does
 * anything, resolved in one place.
 *
 *   1. Which workspace is this request about?  (tenancy — `scopedDb`)
 *   2. Is the caller allowed to do this to it? (capability — `permissions.ts`)
 *
 * They are separate gates and both are required. Answering only (1) is how an
 * admin screen ends up readable by a client whose cookie happens to name the
 * right organisation; answering only (2) is how a super admin of workspace A
 * edits workspace B. The helpers below make it awkward to do either by halves:
 * `adminContext` will not return until the organisation has been checked against
 * the actor's own membership list, and it always returns the subject that
 * `can()` needs.
 *
 * Not a route file. Next only treats `route.ts` as an endpoint, so this sits
 * beside them as a plain module.
 */

import {
  auditEvents,
  clientCompanyMembers,
  memberships,
  organisations,
  platformAdmins,
} from "../../../db/schema";
import {
  can,
  canManageRole,
  loadRoleOverridesForOrganisations,
  resolvePermissions,
  type Capability,
  type PermissionSubject,
} from "../../lib/permissions";
import { anonymousRefusal, scopedDb, type ScopedDatabase } from "../../lib/tenant-db";
import {
  companyOfOrganisation,
  roleInOrganisation as grantedRoleIn,
  siteScopeInOrganisation,
} from "../../lib/tenant-access";
import type { WorkspaceRole } from "../../lib/workspace-actor";
// The role vocabulary, from the module that defines it.
import { isMembershipRole, normaliseMembershipRole } from "../../lib/roles";

export type AdminContext = ScopedDatabase & {
  /** The workspace this request acts on — validated, never merely requested. */
  targetOrganisationId: string;
  /** The client company that workspace belongs to. */
  targetClientCompanyId: string | null;
  /** The actor's role plus that workspace's capability overrides. */
  subject: PermissionSubject;
  /** Kept so an audit line can record where the change came from. */
  request: Request;
};

/** A 403 with the same shape as `capabilityDenied`, for tenancy refusals. */
export function organisationDenied(organisationId: string) {
  return Response.json(
    {
      error: "You are not a member of that workspace.",
      organisationId,
      denied: true,
    },
    { status: 403 },
  );
}

/**
 * Resolves tenancy and capability for an admin request.
 *
 * `requestedOrganisationId` is honoured only when it names an organisation the
 * actor's *memberships* already reach — `access.organisationIds`, which
 * `tenant-access.ts` built from the database and not from the request. So the
 * owner console can legitimately act on another workspace (a super admin's
 * membership list is every workspace) while a client naming someone else's
 * organisation is refused outright rather than quietly redirected. Refused, not
 * ignored, because a silent fallback to your own workspace makes a
 * cross-tenant write look like it succeeded.
 *
 * Returns a `Response` when it must be refused, so callers can `if ("status" in
 * result) return result` and cannot forget to stop.
 */
export async function adminContext(
  request: Request,
  requestedOrganisationId?: string | null,
): Promise<AdminContext | Response> {
  const access = await scopedDb(request);

  const requested = requestedOrganisationId?.trim() || null;
  if (requested && !access.organisationIds.includes(requested)) {
    return organisationDenied(requested);
  }
  const targetOrganisationId = requested ?? access.orgId;

  /*
   * The role is resolved IN THE WORKSPACE BEING ACTED ON.
   *
   * Applying the role held somewhere else to a *named* target workspace was a
   * real bug: someone who was an admin of one client and merely a viewer of
   * another arrived here as an admin of both, and could list, re-role and
   * deactivate the other client's people. `roleInOrganisation` answers for the
   * target alone — Platform Super Admin everywhere, Owner in their own
   * company's workspaces, otherwise the membership there — from the access the
   * tenancy resolver already loaded for this request. The target is in
   * `organisationIds` (checked above), so there is always an answer; the
   * weakest role is only a type-level fallback.
   */
  const effectiveRole = grantedRoleIn(access, targetOrganisationId) ?? "client";

  const subject = await resolvePermissions(
    access.db,
    targetOrganisationId,
    effectiveRole,
    siteScopeInOrganisation(access, targetOrganisationId),
  );

  return {
    ...access,
    // Downstream guard-rails compare against the acting role — "no editing
    // upwards", "you cannot remove your own ability" — so they must see the
    // role that actually applies here, not the one held elsewhere.
    actor: { ...access.actor, role: effectiveRole },
    targetOrganisationId,
    targetClientCompanyId: companyOfOrganisation(access, targetOrganisationId),
    subject,
    request,
  };
}

/**
 * Where the person being acted on stands, across the whole platform.
 *
 * `loadTarget` answers "is this person in the workspace I administer". It does
 * not answer "who else is this person", and three changes the admin screen
 * makes are not about one workspace at all: a password reset and a
 * deactivation act on the ACCOUNT (`users`), and a profile edit rewrites the
 * name every other workspace shows. So they need this second question
 * answered: which workspaces, which companies, and whether they are MAINTSUPP
 * staff.
 *
 * Legacy `super_admin` membership rows are ignored here as they are in the
 * tenancy resolver; platform authority is `platform_admins`.
 */
async function targetStanding(context: AdminContext, targetUserId: string) {
  const [membershipRows, ownerRows, platformRows] = await Promise.all([
    context.db
      .select({
        organisationId: memberships.organisationId,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(organisations, eq(organisations.id, memberships.organisationId))
      .where(and(eq(memberships.userId, targetUserId), eq(organisations.status, "active"))),
    context.db
      .select({ clientCompanyId: clientCompanyMembers.clientCompanyId })
      .from(clientCompanyMembers)
      .where(
        and(
          eq(clientCompanyMembers.userId, targetUserId),
          eq(clientCompanyMembers.relationship, "owner"),
          eq(clientCompanyMembers.status, "active"),
        ),
      ),
    context.db
      .select({ userId: platformAdmins.userId })
      .from(platformAdmins)
      .where(and(eq(platformAdmins.userId, targetUserId), eq(platformAdmins.status, "active"))),
  ]);
  return {
    platformAdmin: platformRows.length > 0,
    ownedCompanyIds: ownerRows.map((row) => row.clientCompanyId),
    memberships: membershipRows.filter((row) => isMembershipRole(row.role)),
  };
}

/**
 * The role that decides "no acting upwards" for a target.
 *
 * A Platform Super Admin is one everywhere; an Owner of this workspace's
 * company is its Owner; otherwise the membership in THIS workspace. Comparing
 * against the local membership alone would let a workspace admin act on
 * somebody whose authority comes from a higher level.
 */
export async function effectiveTargetRole(
  context: AdminContext,
  targetUserId: string,
  localRole: string,
): Promise<WorkspaceRole> {
  const standing = await targetStanding(context, targetUserId);
  if (standing.platformAdmin) return "super_admin";
  if (
    context.targetClientCompanyId &&
    standing.ownedCompanyIds.includes(context.targetClientCompanyId)
  ) {
    return "owner";
  }
  return normaliseMembershipRole(localRole) ?? "client";
}

/**
 * Refuses an ACCOUNT-WIDE change the caller is not entitled to make, or null.
 *
 * Proven before this existed: an Admin of workspace A could reset the password
 * of — and so take over — an account that was also an Admin of workspace B, or
 * deactivate that account and lock it out of B. Each check passed because each
 * looked only at A. The rule now: below Super Admin, you may change an account
 * only if
 *
 *   · it is not a Platform Super Admin and owns no client company (only a
 *     Super Admin acts on those), and
 *   · you hold `capability` in EVERY workspace it belongs to, and may act on
 *     its role there (`canManageRole`) — which an Owner does across their own
 *     company's workspaces and nobody does outside the ones they can reach.
 *
 * The refusal never names the other workspace or company. The caller may not
 * be able to see it, and its name is exactly what isolation keeps from them.
 */
export async function accountWideRefusal(
  context: AdminContext,
  targetUserId: string,
  capability: Capability,
): Promise<Response | null> {
  if (context.actor.role === "super_admin") return null;

  const standing = await targetStanding(context, targetUserId);
  if (standing.platformAdmin) {
    return Response.json(
      {
        error: "Only a Super Admin can change a Super Admin's account.",
        denied: true,
      },
      { status: 403 },
    );
  }
  if (standing.ownedCompanyIds.length) {
    return Response.json(
      {
        error: "Only a Super Admin can change an Owner's account.",
        denied: true,
      },
      { status: 403 },
    );
  }

  const elsewhere = standing.memberships.filter(
    (row) => row.organisationId !== context.targetOrganisationId,
  );
  if (!elsewhere.length) return null;

  const overrides = await loadRoleOverridesForOrganisations(
    context.db,
    [...new Set(elsewhere.map((row) => row.organisationId))],
  );
  for (const row of elsewhere) {
    const actorRole = grantedRoleIn(context, row.organisationId);
    const targetRole = normaliseMembershipRole(row.role) ?? "client";
    const allowed =
      actorRole !== null &&
      can(
        {
          role: actorRole,
          capabilities: overrides.get(row.organisationId)?.[actorRole] ?? {},
          /* The site ceiling in THAT workspace too (review): restricted there,
             no account-wide change — a password reset included. */
          siteRestricted: siteScopeInOrganisation(context, row.organisationId) !== null,
        },
        capability,
      ) &&
      canManageRole(actorRole, targetRole);
    if (!allowed) {
      return Response.json(
        {
          error:
            "This person also belongs to a workspace you do not administer, so a change to their account has to be made by a Super Admin.",
          denied: true,
          guardRail: "other_workspace",
        },
        { status: 403 },
      );
    }
  }
  return null;
}

/** True when `adminContext` refused. */
export function isRefusal(value: AdminContext | Response): value is Response {
  return value instanceof Response;
}

/**
 * Appends one line to the system audit trail.
 *
 * Every state change an admin route makes goes through here. `audit_events` is
 * append-only by contract, so this only ever inserts — nothing in these routes
 * updates or deletes a row, which is what makes "who removed that person's
 * access" answerable after the fact.
 *
 * Failures are swallowed. An audit write that throws must not roll back a
 * change the caller has already been told about, and the alternative — refusing
 * the deactivation because the log was unavailable — is worse than a gap in the
 * log.
 */
export async function recordAudit(
  context: AdminContext,
  entry: {
    action: string;
    summary: string;
    entityType?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
    organisationId?: string;
  },
) {
  try {
    await context.db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      organisationId: entry.organisationId ?? context.targetOrganisationId,
      actorUserId: null,
      actorEmail: context.identityEmail,
      actorRole: context.actor.role,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      summary: entry.summary,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      ipAddress:
        context.request.headers.get("cf-connecting-ip") ??
        context.request.headers.get("x-forwarded-for"),
      userAgent: context.request.headers.get("user-agent"),
    });
  } catch {
    // See above: the change stands even if the log line does not.
  }
}

/** Reads a JSON body, tolerating an empty or malformed one. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function trimmed(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function optional(value: unknown, max = 200) {
  const result = trimmed(value, max);
  return result || null;
}

/**
 * The error body a route returns when the database is unreachable.
 *
 * Detail only in development: a stack trace on a production admin screen tells
 * an attacker the schema.
 *
 * The ended-session check comes first, and belongs HERE rather than in each
 * route, because `adminContext` resolves tenancy through `scopedDb` — so an
 * expired cookie arrives at every admin catch as a thrown
 * `AnonymousAccessError` and was being dressed up as an outage: "The permission
 * change could not be saved", 503, to someone who only had to sign in again.
 * Every admin route already funnels into this one function, so one check makes
 * all of them agree with the rest of the API. See `anonymousRefusal`.
 */
export function adminError(error: unknown, fallback: string) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development" ? `${fallback} (${message})` : fallback,
    },
    { status: 503 },
  );
}
