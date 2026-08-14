/**
 * Password reset links: minting, resolving, and consuming them.
 *
 * A person who forgets their password had, until now, no way back into this
 * product and nobody who could help them. There is no "forgot password" link
 * because there is no mail server, and no administrator override because
 * `POST /api/auth/password` deliberately refuses to take a `userId` — quietly
 * adding one there would be the easiest privilege-escalation bug in the
 * codebase. So a workspace of 71 people had 71 permanent lockouts waiting to
 * happen.
 *
 * This is the invitation story again, and it is built out of the same parts on
 * purpose: 32 bytes of CSPRNG, only the hash stored, an expiry, a revocation
 * column, single use. An administrator with `users.edit` issues the link and
 * hands it over — the same honest delivery story as an invitation, rather than
 * a screen that claims to have sent an email nobody will receive.
 *
 * What a reset must NOT be is a second way to sign in. Consuming a link sets a
 * password and revokes every existing session for that account, including the
 * one held by whoever was already signed in as them; it does not issue a
 * session of its own. The person then signs in normally, which means the
 * account's password is the only thing that ever grants access to it.
 */

import { hashToken } from "../../../lib/auth-session";

type D1Like = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      all: <T = unknown>() => Promise<{ results?: T[] }>;
      run: () => Promise<unknown>;
      first: <T = unknown>() => Promise<T | null>;
    };
  };
};

/** Short by design. A reset link is a live credential, not a keepsake. */
export const RESET_EXPIRY_HOURS = 24;

/**
 * 32 bytes from the CSPRNG, hex encoded.
 *
 * The same entropy as a session cookie and an invitation token, for the same
 * reason: this link is a credential, and nothing about it is derived from the
 * email, the user id, or the clock — a token an attacker can construct from
 * things they already know is not a token.
 */
function generateResetToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type ResetRow = {
  id?: string;
  user_id?: string;
  organisation_id?: string | null;
  issued_by?: string | null;
  expires_at?: string;
  used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
  email?: string | null;
  full_name?: string | null;
  active?: number | null;
};

export type ResetState = "valid" | "unknown" | "expired" | "used" | "revoked";

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
 * Resolves a raw token to its row and its state.
 *
 * The order is fixed — revoked, then used, then expired — so a token that is
 * dead several times over reports the most deliberate reason first. `unknown`
 * covers both "no such token" and "an expiry we cannot parse", because an
 * expiry that will not read must never be treated as "not yet".
 *
 * A deactivated account resolves to `revoked`: the link is genuinely useless,
 * and saying "this account is disabled" to whoever holds the link tells them
 * something about somebody else's account.
 */
export async function resolveReset(
  d1: D1Like,
  rawToken: string,
): Promise<{ state: ResetState; reset: ResetRow | null }> {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) return { state: "unknown", reset: null };

  const tokenHash = await hashToken(token);
  const result = await d1
    .prepare(
      `SELECT r.id, r.user_id, r.organisation_id, r.issued_by, r.expires_at,
              r.used_at, r.revoked_at, r.created_at,
              u.email, u.full_name, u.active
         FROM password_resets r
         JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .all<ResetRow>();

  const reset = (result.results ?? [])[0] ?? null;
  if (!reset) return { state: "unknown", reset: null };

  if (reset.revoked_at) return { state: "revoked", reset };
  if (reset.used_at) return { state: "used", reset };
  if (reset.active === 0) return { state: "revoked", reset };

  const expiresAt = timestampMs(reset.expires_at);
  if (expiresAt === null) return { state: "unknown", reset };
  if (expiresAt <= Date.now()) return { state: "expired", reset };

  return { state: "valid", reset };
}

/** The reader holds the token already, so naming the state discloses nothing. */
export function resetProblem(state: ResetState): string | null {
  switch (state) {
    case "valid":
      return null;
    case "expired":
      return "This reset link has expired. Ask an administrator for a new one.";
    case "used":
      return "This reset link has already been used. If it was not you, tell an administrator now.";
    case "revoked":
      return "This reset link is no longer valid. Ask an administrator for a new one.";
    default:
      return "We do not recognise this reset link. Check it was copied in full.";
  }
}

/**
 * Mints a link, retiring any outstanding one for the same account.
 *
 * Retiring first is what makes "issue another" safe to offer: two live reset
 * links to one account would mean an old link, possibly already seen by
 * somebody else, still opening it. One account, at most one live link.
 */
export async function createReset(
  d1: D1Like,
  input: {
    userId: string;
    organisationId: string | null;
    issuedBy: string | null;
    expiryHours?: number;
  },
): Promise<{ token: string; id: string; expiresAt: string }> {
  const token = generateResetToken();
  const tokenHash = await hashToken(token);
  const id = `pwr_${crypto.randomUUID().replaceAll("-", "")}`;
  const hours = Math.min(Math.max(Number(input.expiryHours) || RESET_EXPIRY_HOURS, 1), 72);
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

  await d1
    .prepare(
      `UPDATE password_resets
          SET revoked_at = ?
        WHERE user_id = ?
          AND used_at IS NULL
          AND revoked_at IS NULL`,
    )
    .bind(new Date().toISOString(), input.userId)
    .run();

  await d1
    .prepare(
      `INSERT INTO password_resets
         (id, user_id, organisation_id, token_hash, issued_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.userId, input.organisationId, tokenHash, input.issuedBy, expiresAt)
    .run();

  return { token, id, expiresAt };
}

/**
 * Marks a link used.
 *
 * Guarded in the WHERE clause rather than by reading first and writing second:
 * two requests arriving with the same token at the same moment would both pass
 * a read-then-write check, and the second would silently set the password a
 * second time. `used_at IS NULL` in the UPDATE makes the database the arbiter,
 * and the row count says which request won.
 */
export async function consumeReset(
  d1: D1Like,
  resetId: string,
): Promise<boolean> {
  const outcome = (await d1
    .prepare(
      `UPDATE password_resets
          SET used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND revoked_at IS NULL`,
    )
    .bind(new Date().toISOString(), resetId)
    .run()) as { meta?: { changes?: number } };

  return (outcome?.meta?.changes ?? 0) > 0;
}
