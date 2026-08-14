/**
 * People in a workspace: who is here, what they may do, and how to stop them.
 *
 * Four operations, and one rule they all share — every one of them is gated by
 * `can()` on the server before a row is touched. The UI hides controls the
 * caller cannot use, but hiding is a courtesy: a client calling this route with
 * curl gets a 403 with a `denied` flag, not a quietly ignored request.
 *
 *   GET    — the roster for one workspace, plus each person's memberships in
 *            the *other* workspaces the caller can already see.
 *   POST   — invite. Delegated to `/api/auth/invitations`; nothing here writes
 *            an invitation row itself.
 *   PATCH  — edit a profile, change a role, deactivate or reactivate.
 *   DELETE — revoke an invitation that has not been accepted yet.
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
import { invitations, memberships, users } from "../../../../db/schema";
import {
  CAPABILITY_CATALOGUE,
  ROLE_LABELS,
  ROLES,
  canAssignRole,
  effectiveCapabilities,
  isWorkspaceRole,
  requireCapability,
  ROLE_RANK,
} from "../../../lib/permissions";
import type { WorkspaceRole } from "../../../lib/workspace-actor";
import {
  adminContext,
  adminError,
  isRefusal,
  optional,
  readJson,
  recordAudit,
  trimmed,
  type AdminContext,
} from "../admin-context";

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

async function roster(context: AdminContext) {
  const { db, targetOrganisationId, organisationIds, activeOrganisations } = context;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      active: users.active,
      createdAt: users.createdAt,
      membershipRole: memberships.role,
      membershipStatus: memberships.status,
      siteScope: memberships.siteScope,
      approvalLimitPence: memberships.approvalLimitPence,
      acceptedAt: memberships.acceptedAt,
      ...profileColumns,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organisationId, targetOrganisationId))
    .orderBy(asc(users.fullName), asc(users.email));

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
            ),
          ),
      )
    : [];

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
  return rows.map((row) => ({
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
  }));
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
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.organisationId, context.targetOrganisationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(desc(invitations.createdAt))
    .limit(50);

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    expired: row.expiresAt ? Date.parse(row.expiresAt) <= now : false,
  }));
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const context = await adminContext(request, url.searchParams.get("organisationId"));
    if (isRefusal(context)) return context;

    // Gate one. A client's built-in defaults do not include `users.view`, so
    // this is where a client's GET stops — with a 403, before any row is read.
    const denied = requireCapability(context.subject, "users.view");
    if (denied) return denied;

    const organisation =
      context.activeOrganisations.find(
        (item) => item.id === context.targetOrganisationId,
      ) ?? context.organisation;

    return Response.json({
      organisation: {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        planTier: organisation.planTier,
      },
      organisations: context.activeOrganisations
        .filter((item) => context.organisationIds.includes(item.id))
        .map((item) => ({ id: item.id, name: item.name, slug: item.slug })),
      actor: {
        email: context.identityEmail,
        role: context.actor.role,
        roleLabel: ROLE_LABELS[context.actor.role],
        capabilities: effectiveCapabilities(
          context.actor.role,
          context.subject.capabilities,
        ),
      },
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
      message?: string;
    }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;

    const denied = requireCapability(context.subject, "users.invite");
    if (denied) return denied;

    const email = trimmed(body.email, 180).toLowerCase();
    if (!email.includes("@")) {
      return Response.json(
        { error: "A valid email address is required." },
        { status: 400 },
      );
    }

    const role = trimmed(body.role, 40) || "client";
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
     * the role decorative.
     */
    if (!canAssignRole(context.actor.role, role)) {
      return Response.json(
        {
          error: `A ${ROLE_LABELS[context.actor.role]} cannot invite somebody as ${ROLE_LABELS[role]}.`,
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
        organisationId: context.targetOrganisationId,
        message: optional(body.message, 500),
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
      action: "user.invited",
      summary: `Invited ${email} as ${ROLE_LABELS[role]}`,
      entityType: "invitation",
      entityId: email,
      detail: { email, role },
    });

    return Response.json(payload, { status: response.status });
  } catch (error) {
    return adminError(error, "The invitation could not be sent.");
  }
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
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.organisationId, context.targetOrganisationId),
        ),
      )
      .limit(1);

    if (!target) {
      return Response.json(
        { error: "That invitation is not in this workspace." },
        { status: 404 },
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

/** The target, resolved through the workspace rather than by bare id. */
async function loadTarget(
  context: AdminContext,
  userId: string,
): Promise<TargetMember | null> {
  const [row] = await context.db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      active: users.active,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, context.targetOrganisationId),
        eq(memberships.userId, userId),
      ),
    )
    .limit(1);
  return row ? { ...row, active: Boolean(row.active) } : null;
}

/**
 * The organisations that would be left with no active super admin.
 *
 * GUARD-RAIL — the last super admin. Demoting or deactivating the only person
 * who can administer a workspace leaves it with no way back: nobody can edit
 * roles, nobody can reactivate the account that was just switched off, and the
 * only repair is a hand-written database row. So the question is asked as
 * "after this change, how many active super admins would this workspace still
 * have?" and the change is refused when the answer is zero.
 *
 * Counted from `memberships` joined to `users`, with both the membership and the
 * user required to be active — the same two conditions `tenant-access.ts` uses
 * when it decides whether a grant is real, so the count cannot disagree with who
 * can actually sign in.
 */
async function workspacesLosingTheirLastSuperAdmin(
  context: AdminContext,
  targetUserId: string,
  scope: "all" | { organisationId: string },
) {
  const held = await context.db
    .select({ organisationId: memberships.organisationId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.userId, targetUserId),
        eq(memberships.role, "super_admin"),
        eq(memberships.status, "active"),
        eq(users.active, true),
      ),
    );

  const affected = held
    .map((row) => row.organisationId)
    .filter((id) => scope === "all" || id === scope.organisationId);
  if (!affected.length) return [];

  const survivors = await context.db
    .select({
      organisationId: memberships.organisationId,
      remaining: sql<number>`count(*)`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        inArray(memberships.organisationId, affected),
        eq(memberships.role, "super_admin"),
        eq(memberships.status, "active"),
        eq(users.active, true),
        sql`${memberships.userId} <> ${targetUserId}`,
      ),
    )
    .groupBy(memberships.organisationId);

  const remaining = new Map(
    survivors.map((row) => [row.organisationId, Number(row.remaining)]),
  );
  const names = new Map(
    context.activeOrganisations.map((item) => [item.id, item.name]),
  );
  return affected
    .filter((id) => (remaining.get(id) ?? 0) === 0)
    .map((id) => names.get(id) ?? id);
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const body = await readJson<{
      userId?: string;
      action?: string;
      organisationId?: string;
      role?: string;
      fullName?: string;
      jobTitle?: string;
      phone?: string;
      timezone?: string;
      avatarColour?: string;
    }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;

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
     * GUARD-RAIL — no editing upwards. An admin acting on a super admin could
     * deactivate the account that outranks them and then do as they liked. Rank
     * is compared through the membership row, which is the same thing
     * `tenant-access.ts` grants a role from.
     */
    if (
      isWorkspaceRole(target.role) &&
      ROLE_RANK[target.role] > ROLE_RANK[context.actor.role]
    ) {
      return Response.json(
        {
          error: `A ${ROLE_LABELS[context.actor.role]} cannot change a ${ROLE_LABELS[target.role]}'s account.`,
          denied: true,
        },
        { status: 403 },
      );
    }

    if (action === "profile") {
      const denied = requireCapability(context.subject, "users.edit");
      if (denied) return denied;

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
      if (!isWorkspaceRole(role)) {
        return Response.json(
          { error: `"${role}" is not a role this workspace has.` },
          { status: 400 },
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
            error: `A ${ROLE_LABELS[context.actor.role]} cannot grant the ${ROLE_LABELS[role]} role.`,
            denied: true,
          },
          { status: 403 },
        );
      }

      if (role !== "super_admin") {
        const stranded = await workspacesLosingTheirLastSuperAdmin(context, target.id, {
          organisationId: context.targetOrganisationId,
        });
        if (stranded.length) {
          return Response.json(
            {
              error: `${target.email} is the last active Super Admin in ${stranded.join(", ")}. Appoint another Super Admin first.`,
              denied: true,
              guardRail: "last_super_admin",
            },
            { status: 409 },
          );
        }
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

    if (action === "deactivate" || action === "reactivate") {
      const denied = requireCapability(context.subject, "users.deactivate");
      if (denied) return denied;

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

        // Deactivation reaches every workspace this person belongs to, so the
        // last-super-admin question is asked of all of them, not just this one.
        const stranded = await workspacesLosingTheirLastSuperAdmin(
          context,
          target.id,
          "all",
        );
        if (stranded.length) {
          return Response.json(
            {
              error: `${target.email} is the last active Super Admin in ${stranded.join(", ")}. Appoint another Super Admin first.`,
              denied: true,
              guardRail: "last_super_admin",
            },
            { status: 409 },
          );
        }

        // No DELETE. The row, its memberships and its audit history all stay;
        // only the flag `tenant-access.ts` reads is cleared.
        await context.db.run(sql`
          update users
             set active = 0,
                 status = 'deactivated',
                 deactivated_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
           where id = ${target.id}
        `);
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
