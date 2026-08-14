/**
 * /api/auth/password-resets/[token] — inspect a reset link, and spend it.
 *
 * Public by necessity: the person holding this link cannot sign in, which is
 * the entire reason they have it. The token is the whole credential, so it is
 * treated like one — 32 bytes of CSPRNG, only its hash stored, single use, and
 * an expiry measured in hours rather than days.
 *
 * GET names the state of the link. That is safe here even though `/login`
 * refuses to say why it failed, and the difference is what an attacker learns:
 * on /login, a specific message reveals whether an email has an account here;
 * here, the reader already holds the token, so telling them it has expired
 * discloses nothing they could not establish by trying it.
 *
 * POST sets the password and revokes every session on the account. It does NOT
 * sign anybody in. A reset that issued a session would be a second way into an
 * account, and then the password would no longer be the only thing that grants
 * access to it — which is the property the whole sign-in path is built around.
 */

import { getD1 } from "../../../../../db";
import { ensureDatabase } from "../../../../../db/init";
import { recordAudit } from "../../../../lib/audit";
import { revokeAllSessions, setPassword } from "../../../../lib/auth-session";
import { passwordProblem } from "../../../../lib/password";
import { consumeReset, resetProblem, resolveReset } from "../reset-tokens";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  await ensureDatabase();
  const { token } = await params;
  const d1 = await getD1();
  const { state, reset } = await resolveReset(d1, token);

  const problem = resetProblem(state);
  if (problem || !reset) {
    return Response.json({ error: problem, state }, { status: 410 });
  }

  return Response.json({
    account: {
      email: reset.email ?? null,
      fullName: reset.full_name ?? null,
      expiresAt: reset.expires_at ?? null,
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  await ensureDatabase();
  const { token } = await params;
  const d1 = await getD1();

  const payload = (await request.json().catch(() => ({}))) as {
    password?: unknown;
  };

  const { state, reset } = await resolveReset(d1, token);
  const problem = resetProblem(state);
  if (problem || !reset?.user_id) {
    return Response.json({ error: problem, state }, { status: 410 });
  }

  /*
   * The password is checked BEFORE the link is spent. A rejected password must
   * not burn the link — the person would then be locked out by their own typo,
   * with no way to ask for another one except through the administrator who
   * issued the first.
   */
  const weak = passwordProblem(payload.password);
  if (weak) return Response.json({ error: weak }, { status: 400 });

  const claimed = await consumeReset(d1, String(reset.id));
  if (!claimed) {
    // Somebody else spent it between resolving and claiming. The database
    // decided, not this code, which is why two simultaneous requests cannot
    // both set a password.
    return Response.json(
      { error: resetProblem("used"), state: "used" },
      { status: 410 },
    );
  }

  await setPassword(d1, String(reset.user_id), String(payload.password));

  /*
   * Every session, including any the attacker was holding. A password reset
   * that left old sessions alive would be theatre: the point of resetting is
   * usually that somebody else has been in the account.
   */
  await revokeAllSessions(d1, String(reset.user_id));

  await recordAudit({
    organisationId: reset.organisation_id ?? null,
    actor: { userId: String(reset.user_id), email: reset.email ?? null },
    action: "user.password_reset",
    entityType: "user",
    entityId: String(reset.user_id),
    summary: `${reset.email ?? "An account"} set a new password from a reset link.`,
    // Neither the token nor its hash. An audit log anybody with read access
    // could mine for live reset links would hand out accounts.
    detail: { resetId: reset.id, sessionsRevoked: true },
    request,
  });

  return Response.json({ ok: true, email: reset.email ?? null });
}
