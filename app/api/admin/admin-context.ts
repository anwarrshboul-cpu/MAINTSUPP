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

import { auditEvents, memberships, organisations } from "../../../db/schema";
import {
  resolvePermissions,
  type PermissionSubject,
} from "../../lib/permissions";
import { scopedDb, type ScopedDatabase } from "../../lib/tenant-db";
import type { WorkspaceRole } from "../../lib/workspace-actor";
// The same three-role normaliser the invitation path uses; it is the only
// exported one, and using a second would be a second definition of "admin".
import { normaliseRole } from "../auth/invitations/invitation-tokens";

export type AdminContext = ScopedDatabase & {
  /** The workspace this request acts on — validated, never merely requested. */
  targetOrganisationId: string;
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
   * `access.actor.role` is the strongest role held ANYWHERE — that is what
   * `resolveTenantAccess` computes, deliberately, so a super admin of one
   * organisation is a super admin everywhere. Applying it to a *named* target
   * organisation was the bug: someone who is an admin of one client and merely
   * a viewer of another arrived here as an admin of both.
   *
   * Proven before this change. An account that was admin of Sunnamusk UK and
   * client of Demo Client Ltd could, against Demo Client Ltd: list all 71
   * members and their emails, read and REWRITE the permission matrix, read the
   * audit trail, promote someone to admin, and deactivate someone — killing
   * their sessions. For a product that runs a workspace per retail client that
   * is one client administering another.
   *
   * `roleInOrganisation` mirrors `invitingRole`, which is the one route that
   * already did this correctly and was the only one that refused the attack: a
   * super admin anywhere stays a super admin, and everyone else is whatever
   * their membership in THIS organisation says. Read from `memberships`,
   * because `users.role` is a display label and has never been the authority.
   */
  const effectiveRole = await roleInOrganisation(
    access.db,
    access.session?.user.id ?? null,
    targetOrganisationId,
    access.actor.role,
  );

  const subject = await resolvePermissions(
    access.db,
    targetOrganisationId,
    effectiveRole,
  );

  return {
    ...access,
    // Downstream guard-rails compare against the acting role — "no editing
    // upwards", "you cannot remove your own ability" — so they must see the
    // role that actually applies here, not the one held elsewhere.
    actor: { ...access.actor, role: effectiveRole },
    targetOrganisationId,
    subject,
    request,
  };
}

/**
 * The role a user holds in one specific organisation.
 *
 * A super admin of any active workspace is a super admin everywhere — that is
 * the product's rule and `resolveTenantAccess` states it. Below that, a role is
 * local: being an admin of one client says nothing about another.
 *
 * Falls back to the caller's ambient role only when there is no session to
 * resolve a membership for, which in production means an anonymous request —
 * and those cannot reach an admin route at all.
 */
async function roleInOrganisation(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  userId: string | null,
  organisationId: string,
  fallback: WorkspaceRole,
): Promise<WorkspaceRole> {
  if (!userId) return fallback;

  const superAnywhere = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(organisations, eq(organisations.id, memberships.organisationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        eq(memberships.role, "super_admin"),
        eq(organisations.status, "active"),
      ),
    )
    .limit(1);
  if (superAnywhere.length) return "super_admin";

  const here = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organisationId, organisationId),
        eq(memberships.status, "active"),
      ),
    )
    .limit(1);

  // No membership in the target workspace is the weakest role, never the
  // ambient one — that fallback is exactly what let a viewer act as an admin.
  return normaliseRole(here[0]?.role) ?? "client";
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
 */
export function adminError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development" ? `${fallback} (${message})` : fallback,
    },
    { status: 503 },
  );
}
