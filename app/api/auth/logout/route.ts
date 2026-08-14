import { recordAudit } from "../../../lib/audit";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  expiredSessionCookie,
  getSession,
  revokeSession,
} from "../../../lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — end this one session.
 *
 * Always answers 200, even with no session or an already-dead one. Sign-out is
 * not an operation anybody should have to retry or interpret, and a 401 here
 * would leave a browser holding a cookie it had just been told to discard.
 *
 * The cookie is cleared *and* the row is revoked. Clearing the cookie alone
 * would leave a token that still worked for anyone who had copied it; revoking
 * alone would leave a browser presenting a dead cookie on every request.
 */
export async function POST(request: Request) {
  await ensureDatabase();

  const current = await getSession(request);
  if (current) {
    const d1 = await getD1();
    await revokeSession(d1, current.session.id).catch(() => {
      // Best effort. The cookie is cleared regardless, below.
    });
    await recordAudit({
      organisationId: current.organisationId,
      actor: { userId: current.user.id, email: current.user.email },
      action: "session.signed_out",
      entityType: "session",
      entityId: current.session.id,
      summary: `${current.user.email} signed out.`,
      request,
    });
  }

  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", expiredSessionCookie(request));
  return response;
}
