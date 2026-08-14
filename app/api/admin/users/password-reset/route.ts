/**
 * POST /api/admin/users/password-reset — issue somebody a way back in.
 *
 * Until now, forgetting a password was permanent. There is no "forgot
 * password" link because there is no mail server; `POST /api/auth/password`
 * deliberately refuses to take a `userId`, because an administrator overriding
 * somebody's password there would be the easiest privilege-escalation bug in
 * the codebase; and no other route touched `password_hash`. So a workspace of
 * 71 people had 71 permanent lockouts waiting to happen.
 *
 * The shape follows invitations exactly, because the problem is the same one:
 * this route decides *whether the caller may*, and hands the credential work to
 * `reset-tokens.ts`, which is the only place a reset token is minted or hashed.
 * Two places that mint credentials drift, and one of them eventually forgets to
 * hash or to expire.
 *
 * `users.edit` gates it — the capability that already covers changing somebody
 * else's role and deactivating them. Anyone who can do those can take an
 * account over regardless; a reset link grants nothing further.
 *
 * Two limits that are not about capabilities at all:
 *
 *   - Never for a role above your own. An admin issuing a reset for a super
 *     admin would hand themselves that account, and every limit on `admin`
 *     would be decorative. Same reasoning as `canAssignRole`, applied to the
 *     other way of taking an account.
 *   - Never for yourself. You are signed in; `POST /api/auth/password` is the
 *     route for that, and it asks for your current password first. Minting
 *     yourself a link that skips that check would turn a borrowed session into
 *     permanent ownership of the account, which is precisely what requiring the
 *     old password prevents.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getD1 } from "../../../../../db";
import { memberships, users } from "../../../../../db/schema";
import {
  ROLE_LABELS,
  ROLE_RANK,
  isWorkspaceRole,
  requireCapability,
} from "../../../../lib/permissions";
import type { WorkspaceRole } from "../../../../lib/workspace-actor";
import {
  adminContext,
  adminError,
  isRefusal,
  readJson,
  recordAudit,
  trimmed,
} from "../../admin-context";
import { createReset, RESET_EXPIRY_HOURS } from "../../../auth/password-resets/reset-tokens";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = await readJson<{ userId?: string; organisationId?: string }>(request);

    const context = await adminContext(request, body.organisationId ?? null);
    if (isRefusal(context)) return context;

    const denied = requireCapability(context.subject, "users.edit");
    if (denied) return denied;

    const userId = trimmed(body.userId, 80);
    if (!userId) {
      return Response.json({ error: "Which account? None was named." }, { status: 400 });
    }

    /*
     * Resolved through the workspace, not by bare id. The membership join is
     * what stops an id belonging to another client's workspace from being
     * reset from here — it is not found rather than refused, because a 403
     * would confirm the account exists.
     */
    const [target] = await context.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        active: users.active,
        role: memberships.role,
      })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(
        and(
          eq(users.id, userId),
          eq(memberships.organisationId, context.targetOrganisationId),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1);

    if (!target) {
      return Response.json(
        { error: "That account is not in this workspace." },
        { status: 404 },
      );
    }

    if (target.email.toLowerCase() === context.identityEmail?.toLowerCase()) {
      return Response.json(
        {
          error:
            "Change your own password from your account settings — it asks for your current one first, which is what stops a borrowed session becoming a permanent one.",
        },
        { status: 400 },
      );
    }

    const targetRole: WorkspaceRole = isWorkspaceRole(target.role)
      ? target.role
      : "client";
    if (ROLE_RANK[targetRole] > ROLE_RANK[context.actor.role]) {
      return Response.json(
        {
          // No article in front of either label: "A Admin" is what the obvious
          // phrasing produces, and the roles read as proper nouns here anyway.
          error: `${ROLE_LABELS[context.actor.role]} cannot reset the password of ${ROLE_LABELS[targetRole]} — that would hand over the account.`,
          denied: true,
        },
        { status: 403 },
      );
    }

    if (!target.active) {
      return Response.json(
        {
          error:
            "That account is deactivated. Reactivate it first — a reset link for a deactivated account opens nothing.",
        },
        { status: 409 },
      );
    }

    const d1 = await getD1();
    const { token, id, expiresAt } = await createReset(d1, {
      userId: target.id,
      organisationId: context.targetOrganisationId,
      issuedBy: context.session?.user.id ?? null,
    });

    /*
     * Who, for whom, and until when — and NOT the token or the link. An audit
     * log anybody with read access could mine for live reset links would hand
     * out accounts, which is the exact opposite of what it is for.
     */
    await recordAudit(context, {
      action: "user.password_reset_issued",
      summary: `Issued a password reset link for ${target.email}`,
      entityType: "user",
      entityId: target.id,
      detail: { email: target.email, resetId: id, expiresAt },
    });

    return Response.json(
      {
        ok: true,
        account: { id: target.id, email: target.email, fullName: target.fullName },
        expiresAt,
        expiryHours: RESET_EXPIRY_HOURS,
        // Returned once, to the administrator who just proved they may issue
        // it. Only the hash is stored, so nothing can hand it back afterwards.
        resetUrl: new URL(`/reset/${token}`, request.url).toString(),
      },
      { status: 201 },
    );
  } catch (error) {
    return adminError(error, "The reset link could not be issued.");
  }
}
