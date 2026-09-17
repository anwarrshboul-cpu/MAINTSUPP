import { getD1 } from "../../../../../db";
import { ensureDatabase } from "../../../../../db/init";
import {
  createSession,
  getSession,
  recordLogin,
  sessionCookie,
  setPassword,
} from "../../../../lib/auth-session";
import { passwordProblem } from "../../../../lib/password";
import { ORGANISATION_COOKIE } from "../../../../lib/tenant-access";
import {
  invitationGrant,
  invitationProblem,
  resolveInvitation,
  ROLE_LABEL,
  normaliseRole,
  type InvitationGrant,
  type InvitationRow,
} from "../invitation-tokens";

export const dynamic = "force-dynamic";

/**
 * GET  /api/auth/invitations/[token] — what is this link for?
 * POST /api/auth/invitations/[token] — accept it.
 *
 * The token in the URL is the credential; there is no other authentication on
 * GET, exactly as with the contractor job links. That is safe only because the
 * response is narrow: the workspace name, the invited email, the role and the
 * expiry — the things already implied by having been sent the link. It carries
 * no member list, no data and no other invitation.
 *
 * Both verbs fail closed. An unknown, expired, used or withdrawn token is
 * refused before anything else happens, and no path below can create a
 * membership without a `valid` invitation row to copy it from.
 */

type UserRow = {
  id?: string;
  email?: string;
  password_hash?: string | null;
  active?: number;
  status?: string | null;
  full_name?: string | null;
};

function gone(state: string) {
  // 404 for a token that was never real, 410 for one that was and is not any
  // more. The distinction is meaningful to the person holding the link and
  // discloses nothing: they already have the token either way.
  const status = state === "unknown" ? 404 : 410;
  return Response.json(
    { error: invitationProblem(state as never), state },
    { status },
  );
}

async function findUser(
  d1: Awaited<ReturnType<typeof getD1>>,
  email: string,
): Promise<UserRow | null> {
  const result = await d1
    .prepare(
      `SELECT id, email, password_hash, active, status, full_name
         FROM users WHERE lower(email) = ? LIMIT 1`,
    )
    .bind(email)
    .all();
  const [row] = (result.results ?? []) as UserRow[];
  return row ?? null;
}

function noLongerGrantable() {
  return Response.json(
    {
      error: "This invitation can no longer be used. Ask your administrator for a new one.",
      state: "revoked",
    },
    { status: 410 },
  );
}

/**
 * The public shape of an invitation: who it is for, as what, into which
 * company and workspaces, and until when. Nothing else — no member list, no
 * data, no other invitation.
 */
function describe(
  invitation: InvitationRow,
  grant: InvitationGrant,
) {
  return {
    email: invitation.email ?? "",
    role: grant.role,
    roleLabel: ROLE_LABEL[grant.role],
    organisationName: grant.landing.name,
    companyName: grant.companyName,
    workspaceNames: grant.workspaces.map((row) => row.name),
    /* An Owner's access is the company, including workspaces added later. */
    wholeCompany: grant.role === "owner",
    expiresAt: invitation.expires_at ?? "",
    message: invitation.message ?? null,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  await ensureDatabase();
  const { token } = await context.params;
  const d1 = await getD1();

  const { state, invitation } = await resolveInvitation(d1, token);
  if (state !== "valid" || !invitation) return gone(state);
  const grant = await invitationGrant(d1, invitation);
  if (!grant) return noLongerGrantable();

  const existing = await findUser(d1, (invitation.email ?? "").toLowerCase());

  return Response.json({
    invitation: describe(invitation, grant),
    /*
     * Tells the page which form to render. An address that already has a
     * password cannot have a new one set through this link — see POST — so the
     * page asks the person to sign in instead of offering a password field it
     * would then have to refuse.
     */
    existingAccount: !!existing?.password_hash,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  await ensureDatabase();
  const { token } = await context.params;
  const d1 = await getD1();

  const { state, invitation } = await resolveInvitation(d1, token);
  if (state !== "valid" || !invitation) return gone(state);

  const email = (invitation.email ?? "").toLowerCase();
  if (!email || !normaliseRole(invitation.role) || !invitation.organisation_id) {
    return Response.json(
      { error: "This invitation is incomplete. Ask your administrator for a new one." },
      { status: 410 },
    );
  }
  /*
   * What it grants is settled BEFORE the token is consumed, so a link whose
   * company or workspaces have gone stays refusable rather than being burnt
   * for nothing — and a legacy Super Admin invitation is refused outright.
   */
  const grant = await invitationGrant(d1, invitation);
  if (!grant) return noLongerGrantable();
  const role = grant.role;
  const landingId = grant.landing.id;

  let payload: Record<string, unknown> = {};
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    // A body is optional for the already-signed-in path below.
  }

  const existing = await findUser(d1, email);
  const signedIn = await getSession(request);

  /*
   * An account that is deactivated stays deactivated.
   *
   * Otherwise an invitation would be a way to switch a suspended person back
   * on — a route around the one control an administrator has for removing
   * somebody in a hurry.
   */
  if (existing && (existing.active === 0 || (existing.status && existing.status !== "active"))) {
    return Response.json(
      { error: "That account is not active. Ask your administrator." },
      { status: 403 },
    );
  }

  /*
   * THE ACCOUNT-TAKEOVER CASE, and why this branch exists.
   *
   * If the invited address already has a password, letting the link-holder set
   * a new one would be a complete takeover of somebody else's account: any
   * admin of any workspace could invite `someone@big-client.com`, open their
   * own invitation, and choose that person's password. The invitation proves
   * only that an admin wants to *add* this address to a workspace — it is not
   * proof of who is holding the link.
   *
   * So an existing account must prove itself the ordinary way: sign in, then
   * open the link again. The membership is still written from the invitation;
   * only the credential is off limits.
   */
  const holdsPassword = !!existing?.password_hash;
  const provenOwner =
    holdsPassword && signedIn?.user.email?.toLowerCase() === email;

  if (holdsPassword && !provenOwner) {
    return Response.json(
      {
        error:
          "That email already has a MAINTSUPP account. Sign in first, then open this invitation link again.",
        signInRequired: true,
        email,
      },
      { status: 409 },
    );
  }

  const password = typeof payload.password === "string" ? payload.password : "";
  if (!holdsPassword) {
    const problem = passwordProblem(password);
    if (problem) return Response.json({ error: problem }, { status: 400 });
  }

  /*
   * Consume the invitation before anything is written.
   *
   * `WHERE accepted_at IS NULL` makes this a compare-and-set: two clicks on the
   * same link race here, and exactly one of them changes a row. Doing it first
   * means a failure further down burns the invitation rather than leaving a
   * token that can be replayed — the safe direction when the alternative is a
   * link that quietly works twice.
   */
  const now = new Date().toISOString();
  const userId =
    existing?.id ??
    `user-${email.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  const claim = await d1
    .prepare(
      `UPDATE invitations
          SET accepted_at = ?, accepted_user_id = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(now, userId, invitation.id)
    .run();
  if (!claim?.meta?.changes) return gone("accepted");

  const fullName =
    typeof payload.fullName === "string" && payload.fullName.trim()
      ? payload.fullName.trim().slice(0, 120)
      : (existing?.full_name ?? null);

  if (existing) {
    await d1
      .prepare("UPDATE users SET full_name = COALESCE(?, full_name), updated_at = ? WHERE id = ?")
      .bind(fullName, now, userId)
      .run();
  } else {
    await d1
      .prepare(
        `INSERT INTO users (id, organisation_id, email, full_name, role, active, status)
         VALUES (?, ?, ?, ?, ?, 1, 'active')`,
      )
      .bind(userId, landingId, email, fullName, ROLE_LABEL[role])
      .run();
  }

  // Only ever for an account that had no password. `provenOwner` keeps theirs.
  if (!holdsPassword) await setPassword(d1, userId, password);

  /*
   * The access, written FROM the invitation row.
   *
   * `role`, the company and the workspaces were read out of the database, put
   * there by somebody whose authority to grant them was checked at creation
   * time. Nothing in this request contributed to them.
   *
   *   · OWNER — one `client_company_members` row. No workspace membership:
   *     ownership is what reaches the company's workspaces, today's and
   *     tomorrow's.
   *   · WORKSPACE ROLE — one membership per granted workspace, each at the
   *     invited role. Nothing is inherited downwards: the person reaches
   *     exactly these workspaces and no others of the company.
   */
  if (role === "owner") {
    await d1
      .prepare(
        `INSERT INTO client_company_members
           (id, user_id, client_company_id, relationship, status, invited_by, accepted_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?)
         ON CONFLICT(user_id, client_company_id) DO UPDATE SET
           relationship = 'owner',
           status = 'active',
           accepted_at = excluded.accepted_at,
           updated_at = excluded.accepted_at`,
      )
      .bind(
        `company-member-${userId}-${grant.clientCompanyId}`,
        userId,
        grant.clientCompanyId,
        invitation.invited_by ?? null,
        now,
      )
      .run();
  } else {
    for (const workspace of grant.workspaces) {
      await d1
        .prepare(
          `INSERT INTO memberships
             (id, user_id, organisation_id, role, status, invited_by, accepted_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(user_id, organisation_id) DO UPDATE SET
             role = excluded.role,
             status = 'active',
             accepted_at = excluded.accepted_at,
             updated_at = excluded.accepted_at`,
        )
        .bind(
          `membership-${userId}-${workspace.id}`,
          userId,
          workspace.id,
          role,
          invitation.invited_by ?? null,
          now,
        )
        .run();
    }
  }

  const body = {
    ok: true,
    organisationId: landingId,
    organisationName: grant.landing.name,
    clientCompanyId: grant.clientCompanyId,
    companyName: grant.companyName,
    workspaceCount: grant.workspaces.length,
    role,
    redirectTo: "/dashboard",
  };

  /*
   * Stand the person in the workspace they were just invited to.
   *
   * Without this, somebody who already belongs to another workspace and
   * accepts while signed in lands on /dashboard in whichever workspace their
   * browser last selected, and the invitation looks as though it did nothing.
   * The cookie is only a REQUEST — `resolveTenantAccess` honours it only for a
   * workspace the person can reach — so it cannot widen anything; the access
   * written above is what makes it valid.
   */
  const workspaceCookie =
    `${ORGANISATION_COOKIE}=${encodeURIComponent(landingId)}; ` +
    "Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly";

  // An already-signed-in owner keeps the session they proved themselves with.
  if (provenOwner) {
    const response = Response.json(body);
    response.headers.append("Set-Cookie", workspaceCookie);
    return response;
  }

  const { token: sessionToken } = await createSession(d1, {
    userId,
    organisationId: landingId,
    request,
  });
  await recordLogin(d1, userId).catch(() => {});

  const response = Response.json(body, { status: 201 });
  response.headers.append("Set-Cookie", sessionCookie(sessionToken, request));
  response.headers.append("Set-Cookie", workspaceCookie);
  return response;
}
