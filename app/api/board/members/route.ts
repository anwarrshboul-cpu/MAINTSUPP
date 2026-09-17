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

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { clientCompanyMembers, invitations, memberships, users } from "../../../../db/schema";
import { can, resolvePermissions } from "../../../lib/permissions";
import { invitationEmailEnabled } from "../../../lib/notifications";
import { assignableRoles, MEMBERSHIP_ROLES } from "../../../lib/roles";
import { roleInOrganisation } from "../../../lib/tenant-access";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const { db, orgId } = scope;

    const person = {
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      jobTitle: sql<string | null>`users.job_title`,
      avatarColour: sql<string | null>`users.avatar_colour`,
    };
    /*
     * Who can open this board: the workspace's members, plus the Owners of its
     * client company, who reach every workspace of it without a membership.
     * Legacy `super_admin` membership rows are not listed — MAINTSUPP staff
     * are not members of a customer's workspace.
     */
    const [memberRows, ownerRows] = await Promise.all([
      db
        .select({ ...person, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organisationId, orgId),
            eq(memberships.status, "active"),
            inArray(memberships.role, [...MEMBERSHIP_ROLES]),
            eq(users.active, true),
          ),
        )
        .orderBy(asc(users.fullName), asc(users.email)),
      scope.clientCompanyId
        ? db
            .select({ ...person, role: sql<string>`'owner'` })
            .from(clientCompanyMembers)
            .innerJoin(users, eq(users.id, clientCompanyMembers.userId))
            .where(
              and(
                eq(clientCompanyMembers.clientCompanyId, scope.clientCompanyId),
                eq(clientCompanyMembers.relationship, "owner"),
                eq(clientCompanyMembers.status, "active"),
                eq(users.active, true),
              ),
            )
            .orderBy(asc(users.fullName), asc(users.email))
        : Promise.resolve([]),
    ]);
    const ownerIds = new Set(ownerRows.map((row) => row.id));
    const rows = [...ownerRows, ...memberRows.filter((row) => !ownerIds.has(row.id))];

    const subject = await resolvePermissions(db, orgId, scope.actor.role);
    const canViewPeople = can(subject, "users.view");

    /*
     * The role the caller may grant FROM, answered by the same resolver the
     * invitation route asks (`roleInOrganisation`): Platform Super Admin
     * everywhere, an Owner in their company's workspaces, otherwise the
     * membership here. So the dialog's role list cannot disagree with the
     * refusal it would meet. Only a signed-in person can invite.
     */
    const inviteAs = scope.session?.user.id ? roleInOrganisation(scope, orgId) : null;
    // The capability decides, as it does in `/api/auth/invitations` itself —
    // a rank test here would disagree with that route the moment a Super
    // Admin narrowed or widened `users.invite` for a role.
    const canInvite =
      Boolean(inviteAs) &&
      can(subject, "users.invite") &&
      assignableRoles(inviteAs).some((role) => role !== "owner");

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
          : "Your role cannot invite people to this workspace.",
      delivery: invitationEmailEnabled()
        ? "An invitation email is sent from admin@maintsupp.com, and the link is shown here too in case it does not arrive."
        : "No email is sent yet. Share the link with the person you are inviting.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/board/members]", error);
    return Response.json({ error: "The member list is temporarily unavailable." }, { status: 503 });
  }
}
