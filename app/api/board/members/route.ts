/**
 * `GET /api/board/members` — who can open this board, for the Invite dialog.
 *
 * A board has no membership of its own: everyone with an active membership
 * of the workspace can open it, and "Anyone at <org> can access this board"
 * is the literal truth. So the list is the workspace roster — name, email,
 * role, title — which any member may read (the same reasoning `/api/teams`
 * gives: a rota is meant to be legible). Pending invitations are only
 * included for a caller who holds `users.view`, because an invitation names
 * somebody who is not yet in the workspace.
 *
 * Inviting is not done here. `POST /api/auth/invitations` is the one writer
 * of invitations and the dialog calls it directly; this route only tells the
 * dialog whether the caller may, and at what role, so it can draw the right
 * controls and an honest note when it cannot.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { invitations, memberships, users } from "../../../../db/schema";
import { can, resolvePermissions } from "../../../lib/permissions";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { invitingRole } from "../../auth/invitations/invitation-tokens";
import { getD1 } from "../../../../db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const { db, orgId } = scope;

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        role: memberships.role,
        jobTitle: sql<string | null>`users.job_title`,
        avatarColour: sql<string | null>`users.avatar_colour`,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organisationId, orgId),
          eq(memberships.status, "active"),
          eq(users.active, true),
        ),
      )
      .orderBy(asc(users.fullName), asc(users.email));

    const subject = await resolvePermissions(db, orgId, scope.actor.role);
    const canViewPeople = can(subject, "users.view");

    /*
     * The role the caller may grant. `invitingRole` is the rule the invitation
     * route itself applies — a real membership in THIS organisation, super
     * admins everywhere — so the dialog's role list cannot disagree with the
     * refusal it would meet.
     */
    let inviteAs: string | null = null;
    if (scope.session?.user.id) {
      inviteAs = await invitingRole(await getD1(), scope.session.user.id, orgId);
    }
    const canInvite = Boolean(inviteAs && (inviteAs === "admin" || inviteAs === "super_admin")) && can(subject, "users.invite");

    const pending = canViewPeople
      ? await db
          .select({
            id: invitations.id,
            email: invitations.email,
            role: invitations.role,
            expiresAt: invitations.expiresAt,
            createdAt: invitations.createdAt,
          })
          .from(invitations)
          .where(
            and(
              eq(invitations.organisationId, orgId),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .orderBy(asc(invitations.createdAt))
      : [];

    const me = scope.identityEmail.toLowerCase();
    return Response.json({
      organisation: { id: scope.organisation.id, name: scope.organisation.name },
      members: rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.fullName?.trim() || row.email,
        role: row.role,
        title: row.jobTitle,
        avatarColour: row.avatarColour,
        isMe: row.email.toLowerCase() === me,
      })),
      pending,
      canInvite,
      inviteAs,
      // Why the caller cannot invite, in words the dialog can show.
      inviteNote: canInvite
        ? null
        : !scope.session
          ? "Sign in to invite people. The preview identity cannot issue invitations."
          : "Only admins can invite people to this workspace.",
      delivery: "No email is sent. Share the link with the person you are inviting.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/board/members]", error);
    return Response.json({ error: "The member list is temporarily unavailable." }, { status: 503 });
  }
}
