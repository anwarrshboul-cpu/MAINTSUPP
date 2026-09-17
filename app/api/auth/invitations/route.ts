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
import { findCompany } from "../../../lib/client-companies";
import { can, canAssignRole, resolvePermissions } from "../../../lib/permissions";
import { withArticle } from "../../../lib/roles";
import { publicUrl } from "../../../lib/public-origin";
import { roleInOrganisation } from "../../../lib/tenant-access";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import {
  createInvitation,
  findOutstandingInvitation,
  invitationWorkspaceIds,
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

type OrganisationRow = { id: string; name: string; clientCompanyId: string | null };

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 100))
    .slice(0, 50);
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
      { error: "Choose a role: owner, admin, manager or client." },
      { status: 400 },
    );
  }
  /* Platform authority is never handed out by link — for anybody, so it is
     refused before anything else is looked at. */
  if (role === "super_admin") {
    return Response.json(
      { error: "Platform Super Admins are not appointed by invitation.", denied: true },
      { status: 403 },
    );
  }

  /*
   * WHO IS ASKING, answered by the tenancy resolver for the session — the same
   * answer every other route gets. Its `organisationIds` is the complete list
   * of workspaces this person can reach, and nothing outside it is ever a
   * valid target: an id that is not in it is refused with the same sentence as
   * one that does not exist, so this route cannot be used to discover another
   * customer's workspaces.
   */
  let scope: Awaited<ReturnType<typeof scopedDb>>;
  try {
    scope = await scopedDb(request);
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  const db = scope.db;
  const d1 = await getD1();
  const reachable = new Map<string, OrganisationRow>(
    scope.activeOrganisations
      .filter((item) => scope.organisationIds.includes(item.id))
      .map((item) => [
        item.id,
        { id: item.id, name: item.name, clientCompanyId: item.clientCompanyId ?? null },
      ]),
  );

  const requestedCompany =
    typeof payload.clientCompanyId === "string" ? payload.clientCompanyId.trim().slice(0, 100) : "";
  const requestedWorkspaces = [
    ...idList(payload.organisationIds),
    ...(typeof payload.organisationId === "string" && payload.organisationId
      ? [payload.organisationId]
      : []),
  ];

  let clientCompanyId: string;
  let landing: OrganisationRow;
  /** The workspaces a workspace-role invitation grants; empty for an Owner. */
  let targets: OrganisationRow[] = [];

  if (role === "owner") {
    /*
     * AN OWNER is appointed to a COMPANY, by a Platform Super Admin only, and
     * is given no workspace membership at all: ownership reaches every
     * workspace of the company, including ones created later.
     */
    if (!scope.platformAdmin) {
      return Response.json(
        { error: "Only a Super Admin can appoint a company Owner.", denied: true },
        { status: 403 },
      );
    }
    const companyId =
      requestedCompany ||
      (requestedWorkspaces[0] ? reachable.get(requestedWorkspaces[0])?.clientCompanyId : null) ||
      scope.clientCompanyId ||
      "";
    const company = companyId ? await findCompany(db, companyId) : null;
    if (!company) return Response.json({ error: REFUSED }, { status: 403 });
    const companyWorkspaces = [...reachable.values()].filter(
      (item) => item.clientCompanyId === company.id,
    );
    const landingWorkspace =
      companyWorkspaces.find((item) => item.id === company.defaultOrganisationId) ??
      companyWorkspaces[0];
    if (!landingWorkspace) {
      return Response.json(
        { error: "Create a workspace for this company before inviting its Owner." },
        { status: 409 },
      );
    }
    clientCompanyId = company.id;
    landing = landingWorkspace;

    const alreadyOwner = await d1
      .prepare(
        `SELECT 1 AS found
           FROM client_company_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.client_company_id = ? AND lower(u.email) = ?
            AND m.relationship = 'owner' AND m.status = 'active'
          LIMIT 1`,
      )
      .bind(company.id, email)
      .all();
    if (((alreadyOwner.results ?? []) as CountRow[]).length) {
      return Response.json(
        { error: "That person is already an Owner of this company." },
        { status: 409 },
      );
    }
  } else {
    /*
     * A WORKSPACE ROLE is granted to named workspaces — one or several, all of
     * ONE client company. The caller must be allowed to give this role in
     * EVERY one of them: `users.invite` there, and the role inside their
     * assignment table (`canAssignRole`) for the role they hold THERE. An
     * Owner qualifies across their company; an Admin only in the workspaces
     * they administer.
     */
    const ids = [...new Set(requestedWorkspaces.length ? requestedWorkspaces : [scope.orgId])];
    const rows = ids.map((id) => reachable.get(id));
    if (rows.some((row) => !row)) {
      return Response.json({ error: REFUSED }, { status: 403 });
    }
    targets = rows as OrganisationRow[];
    const companies = new Set(targets.map((row) => row.clientCompanyId ?? ""));
    if (companies.size !== 1 || companies.has("")) {
      return Response.json(
        { error: "The workspaces in one invitation must all belong to the same client company." },
        { status: 400 },
      );
    }
    clientCompanyId = targets[0].clientCompanyId as string;
    if (requestedCompany && requestedCompany !== clientCompanyId) {
      return Response.json({ error: REFUSED }, { status: 403 });
    }

    for (const target of targets) {
      const actingRole = roleInOrganisation(scope, target.id);
      if (!actingRole) return Response.json({ error: REFUSED }, { status: 403 });
      const subject = await resolvePermissions(db, target.id, actingRole);
      if (!can(subject, "users.invite")) {
        return Response.json({ error: REFUSED }, { status: 403 });
      }
      if (!canAssignRole(actingRole, role)) {
        return Response.json(
          {
            error: `As ${withArticle(actingRole)} in ${target.name} you cannot invite somebody as ${withArticle(role)}.`,
            denied: true,
          },
          { status: 403 },
        );
      }
    }
    landing = targets[0];

    // Already in? Then an invitation is not the right tool for that workspace.
    const memberResult = await d1
      .prepare(
        `SELECT m.organisation_id AS organisation_id
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE lower(u.email) = ? AND m.status = 'active'
            AND m.role IN ('admin', 'manager', 'client')
            AND m.organisation_id IN (${targets.map(() => "?").join(", ")})`,
      )
      .bind(email, ...targets.map((row) => row.id))
      .all();
    const alreadyIn = ((memberResult.results ?? []) as Array<{ organisation_id?: string }>)
      .map((row) => reachable.get(row.organisation_id ?? "")?.name)
      .filter(Boolean);
    if (alreadyIn.length) {
      return Response.json(
        {
          error: `That person is already a member of ${alreadyIn.join(", ")}. Change their workspace access instead.`,
        },
        { status: 409 },
      );
    }
    const ownerResult = await d1
      .prepare(
        `SELECT 1 AS found
           FROM client_company_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.client_company_id = ? AND lower(u.email) = ?
            AND m.relationship = 'owner' AND m.status = 'active'
          LIMIT 1`,
      )
      .bind(clientCompanyId, email)
      .all();
    if (((ownerResult.results ?? []) as CountRow[]).length) {
      return Response.json(
        { error: "That person is an Owner of this company and already sees every workspace." },
        { status: 409 },
      );
    }
  }

  /*
   * ONE LIVE INVITATION PER PERSON PER COMPANY, AND RESENDING IS ASKED FOR BY
   * NAME.
   *
   * A second ordinary invite for somebody who already has a live one is almost
   * always a double click or a second tab. It is refused. `resend: true` is the
   * explicit way to retire the outstanding link and send a new one, and it
   * repeats the invitation as it was: a different role or a different set of
   * workspaces is a different invitation, so withdraw the first.
   */
  const workspaceIds = role === "owner" ? null : targets.map((row) => row.id);
  const resend = payload.resend === true;
  const outstanding = await findOutstandingInvitation(d1, {
    email,
    clientCompanyId,
    organisationIds: workspaceIds ?? [landing.id],
  });
  if (outstanding && !resend) {
    return Response.json(
      {
        error: `${email} already has a pending invitation to this company. Use Resend to send it again.`,
        pendingInvitation: true,
      },
      { status: 409 },
    );
  }
  if (outstanding && resend) {
    const sameWorkspaces =
      role === "owner" ||
      JSON.stringify(
        invitationWorkspaceIds({
          workspace_ids: outstanding.workspace_ids,
          organisation_id: outstanding.organisation_id,
        }).sort(),
      ) === JSON.stringify([...(workspaceIds ?? [])].sort());
    if (outstanding.role !== role || !sameWorkspaces) {
      return Response.json(
        {
          error:
            "A resend repeats the invitation as it was. To offer a different role or different workspaces, withdraw this invitation and invite them again.",
        },
        { status: 409 },
      );
    }
  }

  const message = typeof payload.message === "string" ? payload.message : null;
  const invitation = await createInvitation(d1, {
    organisationId: landing.id,
    clientCompanyId,
    workspaceIds,
    email,
    role,
    invitedBy: current.user.id,
    message,
    expiryDays:
      typeof payload.expiryDays === "number" ? payload.expiryDays : undefined,
  });
  const { token, id, expiresAt } = invitation;
  const company = await findCompany(db, clientCompanyId);

  /*
   * Deliberately records who was invited, to what, and until when — and NOT the
   * token or the link. An audit log that anyone with read access could mine for
   * live invitation links would hand out workspace access, which is the exact
   * opposite of what it is for.
   */
  await recordAudit({
    organisationId: landing.id,
    actor: { userId: current.user.id, email: current.user.email },
    action: resend ? "user.invitation_resent" : "user.invited",
    entityType: "invitation",
    entityId: id,
    summary: `${resend ? "Resent the invitation to" : "Invited"} ${email} as ${role}.`,
    detail: { email, role, expiresAt, clientCompanyId, workspaceIds },
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
    organisationId: landing.id,
    invitationId: id,
    email,
    workspaceName:
      role === "owner"
        ? (company?.name ?? landing.name)
        : targets.length > 1
          ? `${company?.name ?? landing.name} (${targets.length} workspaces)`
          : landing.name,
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
        organisationId: landing.id,
        organisationName: landing.name,
        clientCompanyId,
        companyName: company?.name ?? null,
        workspaces: (role === "owner" ? [] : targets).map(({ id: workspaceId, name }) => ({
          id: workspaceId,
          name,
        })),
        expiresAt,
      },
      inviteUrl,
      delivery,
      resent: resend,
    },
    { status: 201 },
  );
}
