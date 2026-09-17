/**
 * Invitations — Stage 20.
 *
 * The only way a new person gets into a workspace. Two properties matter more
 * than anything else here, and both are structural rather than a matter of
 * remembering to check something:
 *
 * 1. THE ROLE LIVES ON THE INVITATION. `invitations.role` is written when the
 *    invitation is *created*, by somebody who has already been shown to hold
 *    that authority, and the `memberships` row is copied from it at acceptance.
 *    The accept endpoint reads no role from its request body at all — there is
 *    nothing for an invitee to tamper with, so "accepting an invite as an
 *    admin instead of a client" is not a request that can be expressed.
 *
 * 2. THE LINK IS A CREDENTIAL, SO ONLY ITS HASH IS STORED. Same reasoning as
 *    sessions and contractor job links: the plaintext exists once, in the
 *    response to the admin who created it, and a leak of the `invitations`
 *    table yields nothing usable.
 *
 * Everything that can be wrong with a token — unknown, expired, already used,
 * revoked — fails closed and says so plainly. This is one of the few places
 * where a *specific* error is the right call: the person reading it has been
 * sent a link by a colleague and needs to know whether to ask for a new one,
 * and the token itself is the secret, so naming its state discloses nothing
 * that the holder does not already have.
 */

import type { getD1 } from "../../../../db";
import { hashToken } from "../../../lib/auth-session";
import { invitationWorkspaceIds } from "./invitation-scope";
import {
  ROLE_LABELS,
  ROLE_RANK,
  normaliseRole as normaliseWorkspaceRole,
  type WorkspaceRole,
} from "../../../lib/roles";

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

/*
 * The role vocabulary is `roles.ts`'s. These names are kept because the
 * invitation routes, the invite page and the admin context import them from
 * here; they used to be a private three-role copy, which is exactly the kind
 * of list a fourth role gets left out of.
 */
export type InvitableRole = WorkspaceRole;

/** Ranked so an inviter can never grant more than they hold. */
export { ROLE_RANK };

/** The label written to `users.role`, which is display text, not authority. */
export const ROLE_LABEL: Record<InvitableRole, string> = ROLE_LABELS;

/** Long enough to survive a weekend and a forwarded email, short enough to rot. */
export const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;

export function normaliseRole(value: unknown): InvitableRole | null {
  return normaliseWorkspaceRole(value);
}

export function normaliseEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  // Deliberately permissive. Over-strict email validation rejects addresses
  // that genuinely work; the real check is that a person receives the link.
  if (!email || email.length > 200) return "";
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

/**
 * 32 bytes from the CSPRNG.
 *
 * Reuses the session token generator: an invitation link is guessable-or-not on
 * exactly the same terms as a session cookie, so it gets exactly the same
 * entropy. Nothing here is derived from the email or the organisation, because
 * a token an attacker can construct from things they know is not a token.
 */
function generateInviteToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type InvitationRow = {
  id?: string;
  organisation_id?: string;
  email?: string;
  role?: string;
  invited_by?: string | null;
  message?: string | null;
  expires_at?: string;
  accepted_at?: string | null;
  accepted_user_id?: string | null;
  revoked_at?: string | null;
  created_at?: string;
  client_company_id?: string | null;
  workspace_ids?: string | null;
  organisation_name?: string | null;
  organisation_slug?: string | null;
  company_name?: string | null;
};

export type InvitationState =
  | "valid"
  | "unknown"
  | "expired"
  | "accepted"
  | "revoked";

/** See `parseTimestamp` in auth-session.ts — same UTC-without-a-zone hazard. */
function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolves a raw invitation token to its row and its state.
 *
 * The state is computed in a fixed order — revoked, then accepted, then expired
 * — so a token that is several kinds of dead reports the most deliberate reason
 * first. `unknown` covers both "no such token" and "an unparseable expiry",
 * because an expiry we cannot read must never be treated as "not yet".
 */
export async function resolveInvitation(
  d1: D1DatabaseLike,
  rawToken: string,
): Promise<{ state: InvitationState; invitation: InvitationRow | null }> {
  if (!rawToken || rawToken.length < 32) {
    return { state: "unknown", invitation: null };
  }

  const tokenHash = await hashToken(rawToken);
  const result = await d1
    .prepare(
      `SELECT i.id, i.organisation_id, i.email, i.role, i.invited_by, i.message,
              i.expires_at, i.accepted_at, i.accepted_user_id, i.revoked_at, i.created_at,
              i.client_company_id, i.workspace_ids,
              o.name AS organisation_name, o.slug AS organisation_slug,
              c.name AS company_name
         FROM invitations i
         JOIN organisations o ON o.id = i.organisation_id
         LEFT JOIN client_companies c ON c.id = i.client_company_id
        WHERE i.token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .all();

  const [row] = (result.results ?? []) as InvitationRow[];
  if (!row || !row.id) return { state: "unknown", invitation: null };
  if (row.revoked_at) return { state: "revoked", invitation: row };
  if (row.accepted_at) return { state: "accepted", invitation: row };

  const expiresAt = timestampMs(row.expires_at);
  if (expiresAt === null) return { state: "unknown", invitation: row };
  if (expiresAt <= Date.now()) return { state: "expired", invitation: row };

  return { state: "valid", invitation: row };
}

/** What to tell someone holding a token that is not usable. */
export function invitationProblem(state: InvitationState): string | null {
  switch (state) {
    case "valid":
      return null;
    case "expired":
      return "This invitation has expired. Ask your administrator to send a new one.";
    case "accepted":
      return "This invitation has already been used. Sign in instead.";
    case "revoked":
      return "This invitation was withdrawn. Ask your administrator for a new one.";
    default:
      return "This invitation link is not valid. Ask your administrator for a new one.";
  }
}

/**
 * The outstanding, unexpired invitation for this person, if any.
 *
 * What stops a second click from sending a second email: an ordinary invite is
 * refused while one of these exists, and "send it again" has to be asked for
 * explicitly. An EXPIRED invitation does not count — the link in that inbox
 * opens nothing, so a fresh invite is the right answer, and `createInvitation`
 * retires the dead row as it always has.
 *
 * Scoped to the CLIENT COMPANY: one person has at most one live invitation per
 * company, whichever of its workspaces it grants. Invitations written before
 * companies existed carry no company, and still match by their workspace.
 */
export async function findOutstandingInvitation(
  d1: D1DatabaseLike,
  scope: { email: string; clientCompanyId: string | null; organisationIds: string[] },
): Promise<{
  id: string;
  role: string;
  expires_at: string;
  workspace_ids: string | null;
  organisation_id: string;
} | null> {
  const workspaceIds = scope.organisationIds.length ? scope.organisationIds : [""];
  const result = await d1
    .prepare(
      `SELECT id, role, expires_at, workspace_ids, organisation_id
         FROM invitations
        WHERE lower(email) = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND (client_company_id = ? OR organisation_id IN (${workspaceIds.map(() => "?").join(", ")}))
        ORDER BY created_at DESC
        LIMIT 5`,
    )
    .bind(scope.email, scope.clientCompanyId ?? "", ...workspaceIds)
    .all();
  const rows = (result.results ?? []) as Array<{
    id: string;
    role: string;
    expires_at: string;
    workspace_ids: string | null;
    organisation_id: string;
  }>;
  const now = Date.now();
  return (
    rows.find((row) => {
      const expires = timestampMs(row.expires_at);
      return expires !== null && expires > now;
    }) ?? null
  );
}

/**
 * Creates an invitation and returns its token exactly once.
 *
 * The plaintext token is in the return value and nowhere else — it is not
 * stored, and the caller must not log it. Returning it at all is unavoidable:
 * it is the entire deliverable, the same way `createJobToken` has to hand back
 * a contractor link. What matters is that this is the *only* moment it exists,
 * and that it goes to the admin who just proved they may issue it.
 *
 * Any outstanding invitation for the same person and company (or landing
 * workspace) is revoked first. Two live links to one seat means a withdrawn invitation is not
 * actually withdrawn, which is the sort of thing nobody notices until it is
 * the reason somebody still has access.
 */
export async function createInvitation(
  d1: D1DatabaseLike,
  input: {
    /** Where the invitee lands, and the first workspace a workspace role grants. */
    organisationId: string;
    /** The client company the invitation is for. */
    clientCompanyId: string | null;
    /** Every workspace a workspace-role invitation grants; null for an Owner. */
    workspaceIds: string[] | null;
    email: string;
    role: InvitableRole;
    invitedBy: string | null;
    message?: string | null;
    expiryDays?: number;
  },
): Promise<{ token: string; id: string; expiresAt: string }> {
  const token = generateInviteToken();
  const tokenHash = await hashToken(token);
  const id = `inv_${crypto.randomUUID().replaceAll("-", "")}`;
  const days = Math.min(
    Math.max(Number(input.expiryDays) || DEFAULT_EXPIRY_DAYS, 1),
    MAX_EXPIRY_DAYS,
  );
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  /* Retire every outstanding invitation for this person in the same company
     (or, for pre-company rows, the same landing workspace). */
  await d1
    .prepare(
      `UPDATE invitations
          SET revoked_at = ?
        WHERE (organisation_id = ? OR client_company_id = ?)
          AND lower(email) = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL`,
    )
    .bind(
      new Date().toISOString(),
      input.organisationId,
      input.clientCompanyId ?? "",
      input.email,
    )
    .run();

  await d1
    .prepare(
      `INSERT INTO invitations
         (id, organisation_id, email, role, token_hash, invited_by, message, expires_at,
          client_company_id, workspace_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.organisationId,
      input.email,
      input.role,
      tokenHash,
      input.invitedBy,
      input.message?.trim().slice(0, 500) || null,
      expiresAt,
      input.clientCompanyId,
      input.workspaceIds ? JSON.stringify(input.workspaceIds) : null,
    )
    .run();

  return { token, id, expiresAt };
}

/**
 * `invitingRole` used to live here: a second reader of "which role does this
 * person hold in this workspace", with its own super-admin query. It is gone.
 * The invitation route and the board's member list now ask the tenancy
 * resolver (`roleInOrganisation`), which also knows about Owners — one reader,
 * one answer.
 */

/* The workspace ids a stored invitation grants: see `invitation-scope.ts`. */
export { invitationWorkspaceIds };

type GrantedWorkspace = { id: string; name: string };

/**
 * WHAT THIS INVITATION GRANTS, re-read from the database at the moment it is
 * used — never from the request.
 *
 *   · an OWNER invitation grants the client company. The workspaces listed are
 *     the company's active ones today (ownership reaches later ones too), and
 *     the landing workspace is the invitation's, else the company default,
 *     else the first.
 *   · a WORKSPACE invitation grants the workspaces stored on it, narrowed to
 *     those still active and still in the invitation's company. A workspace
 *     archived or moved since the invite was sent is simply not granted.
 *
 * Null when nothing grantable is left, or the role is one no invitation may
 * carry any more (`super_admin` — Platform Super Admins are not appointed by
 * link). The caller refuses in that case, before the token is consumed.
 */
export type InvitationGrant = {
  role: "owner" | "admin" | "manager" | "client";
  clientCompanyId: string | null;
  companyName: string | null;
  landing: GrantedWorkspace;
  workspaces: GrantedWorkspace[];
};

export async function invitationGrant(
  d1: D1DatabaseLike,
  invitation: InvitationRow,
): Promise<InvitationGrant | null> {
  const role = normaliseRole(invitation.role);
  if (!role || role === "super_admin" || !invitation.organisation_id) return null;
  const companyId = invitation.client_company_id ?? null;

  if (role === "owner") {
    if (!companyId) return null;
    const company = await d1
      .prepare(
        "SELECT id, name, default_organisation_id FROM client_companies WHERE id = ? AND status = 'active' LIMIT 1",
      )
      .bind(companyId)
      .all();
    const [companyRow] = (company.results ?? []) as Array<{
      id: string;
      name: string;
      default_organisation_id: string | null;
    }>;
    if (!companyRow) return null;
    const rows = await d1
      .prepare(
        `SELECT id, name FROM organisations
          WHERE client_company_id = ? AND status = 'active'
          ORDER BY created_at, id`,
      )
      .bind(companyId)
      .all();
    const workspaces = (rows.results ?? []) as GrantedWorkspace[];
    const landing =
      workspaces.find((row) => row.id === invitation.organisation_id) ??
      workspaces.find((row) => row.id === companyRow.default_organisation_id) ??
      workspaces[0];
    if (!landing) return null;
    return { role, clientCompanyId: companyId, companyName: companyRow.name, landing, workspaces };
  }

  const wanted = invitationWorkspaceIds(invitation);
  if (!wanted.length) return null;
  const rows = await d1
    .prepare(
      `SELECT id, name, client_company_id FROM organisations
        WHERE status = 'active' AND id IN (${wanted.map(() => "?").join(", ")})`,
    )
    .bind(...wanted)
    .all();
  const found = (rows.results ?? []) as Array<GrantedWorkspace & { client_company_id: string | null }>;
  const workspaces = wanted
    .map((id) => found.find((row) => row.id === id))
    .filter((row): row is GrantedWorkspace & { client_company_id: string | null } => Boolean(row))
    .filter((row) => !companyId || row.client_company_id === companyId)
    .map(({ id, name }) => ({ id, name }));
  if (!workspaces.length) return null;
  const landing = workspaces.find((row) => row.id === invitation.organisation_id) ?? workspaces[0];
  return {
    role,
    clientCompanyId: companyId,
    companyName: invitation.company_name ?? null,
    landing,
    workspaces,
  };
}
