import { recordAudit } from "../../../lib/audit";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  requireSession,
  unauthenticatedResponse,
  UnauthenticatedError,
} from "../../../lib/auth-session";
import {
  createInvitation,
  invitingRole,
  normaliseEmail,
  normaliseRole,
  ROLE_RANK,
} from "./invitation-tokens";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/invitations — invite someone into a workspace.
 *
 * The whole security question for this route is "may the caller grant what they
 * are asking to grant", and it is answered in two parts:
 *
 *   - MAY THEY INVITE INTO THIS ORGANISATION? Only if `memberships` says they
 *     are an admin or super admin of it. The organisation is taken from the
 *     request body, which is fine precisely *because* it is then checked
 *     against the caller's own memberships — an unrecognised organisation is
 *     refused with the same message as one they simply have no rights over, so
 *     this cannot be used to enumerate other tenants.
 *
 *   - MAY THEY GRANT THIS ROLE? Only a role at or below their own. Without that
 *     rule an admin could invite a super admin, accept it themselves at a
 *     throwaway address, and hold the keys to every organisation in the
 *     workspace. Privilege escalation rarely looks like an exploit; it usually
 *     looks like a missing comparison.
 */

type OrganisationRow = { id?: string; name?: string; status?: string };
type CountRow = { found?: number };

const REFUSED = "You cannot invite people into that workspace.";

export async function POST(request: Request) {
  await ensureDatabase();

  let current;
  try {
    current = await requireSession(request);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthenticatedResponse();
    throw error;
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send an email address and a role." }, { status: 400 });
  }

  const email = normaliseEmail(payload.email);
  if (!email) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const role = normaliseRole(payload.role);
  if (!role) {
    return Response.json(
      { error: "Choose a role: client, admin or super_admin." },
      { status: 400 },
    );
  }

  const d1 = await getD1();

  // Falls back to the organisation the session is already standing in, so the
  // common case ("invite this person to the workspace I am looking at") does
  // not have to pass an id it might get wrong.
  const organisationId =
    typeof payload.organisationId === "string" && payload.organisationId
      ? payload.organisationId
      : (current.organisationId ?? current.user.organisationId);

  if (!organisationId) {
    return Response.json({ error: "Choose a workspace to invite into." }, { status: 400 });
  }

  const granting = await invitingRole(d1, current.user.id, organisationId);
  if (!granting || ROLE_RANK[granting] < ROLE_RANK.admin) {
    // Identical whether the organisation does not exist, is archived, or simply
    // is not theirs — otherwise this route answers "which tenants exist".
    return Response.json({ error: REFUSED }, { status: 403 });
  }
  if (ROLE_RANK[role] > ROLE_RANK[granting]) {
    return Response.json(
      { error: "You cannot invite someone to a role above your own." },
      { status: 403 },
    );
  }

  const organisationResult = await d1
    .prepare("SELECT id, name, status FROM organisations WHERE id = ? LIMIT 1")
    .bind(organisationId)
    .all();
  const [organisation] = (organisationResult.results ?? []) as OrganisationRow[];
  if (!organisation || organisation.status !== "active") {
    return Response.json({ error: REFUSED }, { status: 403 });
  }

  // Already in? Then an invitation is not the right tool, and sending one would
  // create a link that grants nothing while looking as though it does.
  const memberResult = await d1
    .prepare(
      `SELECT 1 AS found
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ? AND lower(u.email) = ? AND m.status = 'active'
        LIMIT 1`,
    )
    .bind(organisationId, email)
    .all();
  if (((memberResult.results ?? []) as CountRow[]).length) {
    return Response.json(
      { error: "That person is already a member of this workspace." },
      { status: 409 },
    );
  }

  const invitation = await createInvitation(d1, {
    organisationId,
    email,
    role,
    invitedBy: current.user.id,
    message: typeof payload.message === "string" ? payload.message : null,
    expiryDays:
      typeof payload.expiryDays === "number" ? payload.expiryDays : undefined,
  });
  const { token, id, expiresAt } = invitation;

  /*
   * Deliberately records who was invited, to what, and until when — and NOT the
   * token or the link. An audit log that anyone with read access could mine for
   * live invitation links would hand out workspace access, which is the exact
   * opposite of what it is for.
   */
  await recordAudit({
    organisationId,
    actor: { userId: current.user.id, email: current.user.email },
    action: "user.invited",
    entityType: "invitation",
    entityId: id,
    summary: `Invited ${email} as ${role}.`,
    detail: { email, role, expiresAt },
    request,
  });

  /*
   * The link is returned once, here, to the admin who just proved they may
   * issue it — there is no way to send an invitation without handing somebody
   * the token, and no way to retrieve it again afterwards, because only its
   * hash was stored. It is not logged. Built as an absolute URL from the
   * request's own origin so it is correct in development and in production
   * without a base-URL setting to get wrong.
   */
  const inviteUrl = new URL(`/invite/${token}`, request.url).toString();

  return Response.json(
    {
      ok: true,
      invitation: {
        id,
        email,
        role,
        organisationId,
        organisationName: organisation.name ?? null,
        expiresAt,
      },
      inviteUrl,
    },
    { status: 201 },
  );
}
