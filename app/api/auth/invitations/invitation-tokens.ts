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

type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

export type InvitableRole = "super_admin" | "admin" | "client";

/** Ranked so an inviter can never grant more than they hold. */
export const ROLE_RANK: Record<InvitableRole, number> = {
  client: 0,
  admin: 1,
  super_admin: 2,
};

/** The label written to `users.role`, which is display text, not authority. */
export const ROLE_LABEL: Record<InvitableRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  client: "Client",
};

/** Long enough to survive a weekend and a forwarded email, short enough to rot. */
export const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;

export function normaliseRole(value: unknown): InvitableRole | null {
  return value === "super_admin" || value === "admin" || value === "client"
    ? value
    : null;
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
  organisation_name?: string | null;
  organisation_slug?: string | null;
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
              o.name AS organisation_name, o.slug AS organisation_slug
         FROM invitations i
         JOIN organisations o ON o.id = i.organisation_id
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
 * Creates an invitation and returns its token exactly once.
 *
 * The plaintext token is in the return value and nowhere else — it is not
 * stored, and the caller must not log it. Returning it at all is unavoidable:
 * it is the entire deliverable, the same way `createJobToken` has to hand back
 * a contractor link. What matters is that this is the *only* moment it exists,
 * and that it goes to the admin who just proved they may issue it.
 *
 * Any outstanding invitation for the same person and workspace is revoked
 * first. Two live links to one seat means a withdrawn invitation is not
 * actually withdrawn, which is the sort of thing nobody notices until it is
 * the reason somebody still has access.
 */
export async function createInvitation(
  d1: D1DatabaseLike,
  input: {
    organisationId: string;
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

  await d1
    .prepare(
      `UPDATE invitations
          SET revoked_at = ?
        WHERE organisation_id = ?
          AND lower(email) = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL`,
    )
    .bind(new Date().toISOString(), input.organisationId, input.email)
    .run();

  await d1
    .prepare(
      `INSERT INTO invitations
         (id, organisation_id, email, role, token_hash, invited_by, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();

  return { token, id, expiresAt };
}

/**
 * The strongest role a user actually holds, for the purpose of inviting.
 *
 * Mirrors `resolveTenantAccess`: a super admin of any organisation is a super
 * admin everywhere, and everyone else is whatever their membership in *this*
 * organisation says. Read from `memberships` rather than from `users.role`,
 * because `users.role` is a display label and has never been the authority.
 */
export async function invitingRole(
  d1: D1DatabaseLike,
  userId: string,
  organisationId: string,
): Promise<InvitableRole | null> {
  const anywhere = await d1
    .prepare(
      `SELECT 1 AS found
         FROM memberships m
         JOIN organisations o ON o.id = m.organisation_id
        WHERE m.user_id = ? AND m.status = 'active'
          AND m.role = 'super_admin' AND o.status = 'active'
        LIMIT 1`,
    )
    .bind(userId)
    .all();
  if ((anywhere.results ?? []).length) return "super_admin";

  const here = await d1
    .prepare(
      `SELECT role FROM memberships
        WHERE user_id = ? AND organisation_id = ? AND status = 'active'
        LIMIT 1`,
    )
    .bind(userId, organisationId)
    .all();
  const [row] = (here.results ?? []) as Array<{ role?: string }>;
  return normaliseRole(row?.role);
}
