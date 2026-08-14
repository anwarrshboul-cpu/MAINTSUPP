import { recordAudit } from "../../../lib/audit";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  checkPassword,
  createSession,
  requestIp,
  revokeAllSessions,
  sessionCookie,
  setPassword,
  requireSession,
  unauthenticatedResponse,
  UnauthenticatedError,
  recordSignInFailure,
  signInRetryAfter,
} from "../../../lib/auth-session";
import { passwordProblem } from "../../../lib/password";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/password — change your own password.
 *
 * Own, and only own. There is deliberately no `userId` parameter: an
 * administrator resetting somebody else's password is a different operation
 * with different rules (it needs an audit entry and it must not be doable by
 * anyone who merely borrowed a session), and quietly allowing it here by adding
 * a field would be the easiest possible privilege-escalation bug to introduce.
 *
 * The current password is required even though the caller already holds a valid
 * session. A session cookie proves the browser was signed in at some point; it
 * does not prove the person at the keyboard is the account holder. Requiring
 * the old password is what stops an unlocked laptop, or a stolen cookie, from
 * being converted into permanent ownership of the account.
 *
 * On success every session is revoked and a fresh one is issued to this device.
 * If the change was prompted by a suspected compromise, leaving the attacker's
 * session alive would defeat the entire exercise.
 */
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
    return Response.json(
      { error: "Send your current and new password." },
      { status: 400 },
    );
  }

  const currentPassword =
    typeof payload.currentPassword === "string" ? payload.currentPassword : "";
  const newPassword =
    typeof payload.newPassword === "string" ? payload.newPassword : "";

  if (!currentPassword || !newPassword) {
    return Response.json(
      { error: "Enter your current password and a new one." },
      { status: 400 },
    );
  }

  // The same throttle as sign-in, for the same reason: this endpoint verifies a
  // password, so without it an attacker with a stolen cookie could grind for
  // the plaintext here instead of at /login.
  const ip = requestIp(request);
  const d1 = await getD1();
  const retryAfter = await signInRetryAfter(d1, current.user.email, ip);
  if (retryAfter > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return Response.json(
      { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429 },
    );
  }

  const problem = passwordProblem(newPassword);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  if (newPassword === currentPassword) {
    return Response.json(
      { error: "Choose a password you have not used here before." },
      { status: 400 },
    );
  }

  const verified = await checkPassword(d1, current.user.email, currentPassword);
  if (!verified.ok) {
    await recordSignInFailure(d1, current.user.email, ip);
    return Response.json(
      { error: "That is not your current password." },
      { status: 403 },
    );
  }

  await setPassword(d1, current.user.id, newPassword);

  // Revoke first, then issue. The other order leaves a window in which the new
  // session could be caught by its own revocation sweep.
  await revokeAllSessions(d1, current.user.id);
  /*
   * Two events, because two things happened. The password change is the actor's
   * own act; the mass revocation is a consequence of it that a reader would
   * otherwise have to infer — and "every session ended" looks alarming until
   * you can see the change that caused it sitting next to it.
   */
  await recordAudit({
    organisationId: current.organisationId,
    actor: { userId: current.user.id, email: current.user.email },
    action: "user.password_changed",
    entityType: "user",
    entityId: current.user.id,
    summary: `${current.user.email} changed their password.`,
    request,
  });
  await recordAudit({
    organisationId: current.organisationId,
    actor: { userId: current.user.id, email: current.user.email },
    action: "session.revoked",
    entityType: "session",
    summary: "All sessions ended by a password change.",
    request,
  });
  const { token } = await createSession(d1, {
    userId: current.user.id,
    organisationId: current.organisationId,
    request,
  });

  const response = Response.json({
    ok: true,
    // Said explicitly so the UI can tell the user what just happened to their
    // other devices, rather than leaving them to discover it.
    signedOutOtherDevices: true,
  });
  response.headers.append("Set-Cookie", sessionCookie(token, request));
  return response;
}
