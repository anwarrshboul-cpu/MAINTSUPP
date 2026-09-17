import { recordAudit } from "../../../lib/audit";
import { getD1, getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  requireSession,
  unauthenticatedResponse,
  UnauthenticatedError,
} from "../../../lib/auth-session";
import {
  INVITATION_REPLY_TO,
  INVITATION_SENDER,
  invitationEmailEnabled,
  invitationEmailTemplate,
  outboundEmailMode,
  sendNotification,
  type SendResult,
} from "../../../lib/notifications";
import { can, canAssignRole, resolvePermissions } from "../../../lib/permissions";
import { withArticle } from "../../../lib/roles";
import { publicUrl } from "../../../lib/public-origin";
import { scopedDb } from "../../../lib/tenant-db";
import {
  createInvitation,
  findOutstandingInvitation,
  invitingRole,
  normaliseEmail,
  normaliseRole,
  ROLE_LABEL,
} from "./invitation-tokens";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/invitations — invite someone into a workspace.
 *
 * The whole security question for this route is "may the caller grant what they
 * are asking to grant", and it is answered in two parts:
 *
 *   - MAY THEY INVITE INTO THIS ORGANISATION? Only if their role IN THAT
 *     ORGANISATION holds `users.invite`. The organisation is taken from the
 *     request body, which is fine precisely *because* it is then checked
 *     against the caller's own memberships — an unrecognised organisation is
 *     refused with the same message as one they simply have no rights over, so
 *     this cannot be used to enumerate other tenants.
 *
 *     This used to be a rank comparison ("admin or above"), which ignored the
 *     permission matrix: an admin whose `users.invite` a Super Admin had
 *     withdrawn could still invite by calling this route directly, because only
 *     `/api/admin/users` asked the capability question. Asking it here closes
 *     that, and it is also what keeps Manager and Client out by default.
 *
 *   - MAY THEY GRANT THIS ROLE? Only one `canAssignRole` allows: a Super Admin
 *     any role, an Admin only Manager or Client, nobody else anything. Without
 *     that rule an admin could invite a super admin, accept it themselves at a
 *     throwaway address, and hold the keys to every organisation in the
 *     workspace. Privilege escalation rarely looks like an exploit; it usually
 *     looks like a missing comparison.
 *
 * DELIVERY IS OFF BY DEFAULT. Real invitation email is a deferred follow-up,
 * so no email is attempted unless `INVITATION_EMAIL_MODE=live` (see
 * `invitationEmailEnabled`) — and even then the global `EMAIL_MODE` and
 * `RESEND_API_KEY` still apply. Switched off, `delivery` says so and the
 * administrator shares the link, which is the product as it was before email.
 *
 * When it is on, the invitation is created FIRST and the email sent SECOND,
 * and the order is deliberate. A mail-provider outage must not lose an invitation the
 * administrator has been told about, and must not leave a half-state: the row
 * is complete and valid the moment it is written, the link is returned to the
 * administrator either way, and `delivery` says plainly whether an email
 * actually left. "Created but not emailed" is therefore a usable state — the
 * administrator shares the link or presses Resend — never a silent one.
 */

type OrganisationRow = { id?: string; name?: string; status?: string };
type CountRow = { found?: number };

const REFUSED = "You cannot invite people into that workspace.";

export type InvitationDelivery = {
  status: SendResult["status"] | "sink" | "disabled";
  /** Where the email was meant to go. The address the admin typed, no more. */
  to: string;
  from: string;
  message: string;
};

/**
 * Send the invitation email and describe what happened, in words an
 * administrator can act on. Never throws: `sendNotification` records every
 * attempt in `notification_log`, and anything it could not record is reported
 * as a failure rather than taking the (already created) invitation with it.
 *
 * The provider's own error text is NOT returned — it can carry request detail
 * that belongs in the log, not on a screen.
 */
async function deliverInvitation(input: {
  organisationId: string;
  invitationId: string;
  email: string;
  workspaceName: string;
  roleLabel: string;
  inviterName: string | null;
  inviteUrl: string;
  expiresAt: string;
  message: string | null;
}): Promise<InvitationDelivery> {
  const template = invitationEmailTemplate({
    workspaceName: input.workspaceName,
    roleLabel: input.roleLabel,
    inviterName: input.inviterName,
    inviteUrl: input.inviteUrl,
    expiresAt: input.expiresAt,
    message: input.message,
  });
  const base = { to: input.email, from: INVITATION_REPLY_TO };

  // Switched off: nothing is attempted and nothing is logged as a send.
  if (!invitationEmailEnabled()) {
    return {
      ...base,
      status: "disabled",
      message:
        "Invitation emails are not switched on yet, so no email was sent. Share the link below with them directly.",
    };
  }

  let result: SendResult;
  try {
    result = await sendNotification(await getDb(), {
      organisationId: input.organisationId,
      channel: "email",
      event: "user.invited",
      subjectType: "invitation",
      subjectId: input.invitationId,
      to: input.email,
      from: INVITATION_SENDER,
      replyTo: INVITATION_REPLY_TO,
      subject: template.subject,
      body: template.body,
      text: template.text,
    });
  } catch {
    return {
      ...base,
      status: "failed",
      message:
        "The invitation was created, but the email could not be sent. Share the link below, or use Resend once email is working.",
    };
  }

  switch (result.status) {
    case "sent":
      return outboundEmailMode() === "sink"
        ? {
            ...base,
            status: "sink",
            message: `Test environment: the email was redirected to the internal test inbox rather than to ${input.email}. Share the link below if they need it.`,
          }
        : {
            ...base,
            status: "sent",
            message: `An invitation email was sent to ${input.email} from ${INVITATION_REPLY_TO}.`,
          };
    case "suppressed":
      return {
        ...base,
        status: "suppressed",
        message:
          "Email sending is switched off on this deployment, so no email was sent. Share the link below with them directly.",
      };
    case "skipped":
      return {
        ...base,
        status: "skipped",
        message:
          "Email is not configured on this deployment, so no email was sent. Share the link below with them directly.",
      };
    default:
      return {
        ...base,
        status: "failed",
        message:
          "The invitation was created, but the email could not be sent. Share the link below, or use Resend once email is working.",
      };
  }
}

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
      { error: "Choose a role: client, manager, admin or super_admin." },
      { status: 400 },
    );
  }

  const d1 = await getD1();

  /*
   * Falls back to the workspace the caller is LOOKING AT, so the common case
   * ("invite this person to the workspace I am in") does not have to pass an
   * id it might get wrong.
   *
   * This used to fall back to the session's own organisation, which is where
   * the account signed in — not necessarily where it is standing. A Super Admin
   * who had switched to another client and invited from the board's dialog
   * (which sent no id) put the invitation in the wrong workspace. `scopedDb`
   * resolves the selected workspace from the same session, filtered through
   * the memberships, so the fallback can only ever be a workspace the caller
   * belongs to.
   */
  const organisationId =
    typeof payload.organisationId === "string" && payload.organisationId
      ? payload.organisationId
      : (await scopedDb(request).then((scope) => scope.orgId).catch(() => null)) ??
        current.organisationId ??
        current.user.organisationId;

  if (!organisationId) {
    return Response.json({ error: "Choose a workspace to invite into." }, { status: 400 });
  }

  const granting = await invitingRole(d1, current.user.id, organisationId);
  if (!granting) {
    // Identical whether the organisation does not exist, is archived, or simply
    // is not theirs — otherwise this route answers "which tenants exist".
    return Response.json({ error: REFUSED }, { status: 403 });
  }
  const subject = await resolvePermissions(await getDb(), organisationId, granting);
  if (!can(subject, "users.invite")) {
    return Response.json({ error: REFUSED }, { status: 403 });
  }
  if (!canAssignRole(granting, role)) {
    return Response.json(
      { error: `As ${withArticle(granting)} you cannot invite somebody as ${withArticle(role)}.` },
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

  /*
   * ONE LIVE INVITATION, AND RESENDING IS ASKED FOR BY NAME.
   *
   * A second ordinary invite for somebody who already has a live one is almost
   * always a double click or a second tab, and it used to mint a second link
   * and — now that invitations are emailed — would send a second email. It is
   * refused. `resend: true` is the explicit way to retire the outstanding link
   * and send a new one, and it repeats the invitation as it was: a different
   * role is a different invitation, so withdraw the first.
   */
  const resend = payload.resend === true;
  const outstanding = await findOutstandingInvitation(d1, organisationId, email);
  if (outstanding && !resend) {
    return Response.json(
      {
        error: `${email} already has a pending invitation to this workspace. Use Resend to send it again.`,
        pendingInvitation: true,
      },
      { status: 409 },
    );
  }
  if (outstanding && resend && outstanding.role !== role) {
    return Response.json(
      {
        error:
          "A resend repeats the invitation as it was. To offer a different role, withdraw this invitation and invite them again.",
      },
      { status: 409 },
    );
  }

  const message = typeof payload.message === "string" ? payload.message : null;
  const invitation = await createInvitation(d1, {
    organisationId,
    email,
    role,
    invitedBy: current.user.id,
    message,
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
    action: resend ? "user.invitation_resent" : "user.invited",
    entityType: "invitation",
    entityId: id,
    summary: `${resend ? "Resent the invitation to" : "Invited"} ${email} as ${role}.`,
    detail: { email, role, expiresAt },
    request,
  });

  /*
   * The link is built on the workspace's canonical public origin
   * (`PUBLIC_APP_ORIGIN`), falling back to this request's origin — the same
   * rule every other link this app hands to somebody outside it follows. An
   * invitation is read in an inbox days later, so it must not be pinned to
   * whichever deployment hostname the administrator happened to be using.
   */
  const inviteUrl = publicUrl(request, `/invite/${token}`);

  const delivery = await deliverInvitation({
    organisationId,
    invitationId: id,
    email,
    workspaceName: organisation.name ?? "your MAINTSUPP workspace",
    roleLabel: ROLE_LABEL[role],
    inviterName: current.user.displayName ?? null,
    inviteUrl,
    expiresAt,
    message,
  });

  /*
   * The link is ALSO returned once, here, to the admin who just proved they may
   * issue it — it is the fallback when the email did not leave, and there is
   * no way to retrieve it again afterwards, because only its hash was stored.
   * It is not logged.
   */
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
      delivery,
      resent: resend,
    },
    { status: 201 },
  );
}
