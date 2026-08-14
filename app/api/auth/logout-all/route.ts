import { recordAudit } from "../../../lib/audit";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  expiredSessionCookie,
  requireSession,
  revokeAllSessions,
  unauthenticatedResponse,
  UnauthenticatedError,
} from "../../../lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout-all — end every session this user has, everywhere.
 *
 * Unlike plain sign-out this one *does* require a valid session: it acts on all
 * of a user's devices, so it has to know whose devices they are, and the only
 * trustworthy answer to that is a session cookie we issued.
 *
 * The current device is included rather than spared. The reason someone reaches
 * for this button is "I think my password is out there", and under that
 * assumption the device in front of them has no special claim to be trusted.
 */
export async function POST(request: Request) {
  await ensureDatabase();

  try {
    const current = await requireSession(request);
    const d1 = await getD1();
    await revokeAllSessions(d1, current.user.id);
    // Worth its own action rather than a plain sign-out: ending every session
    // is what someone does when they think a device or password is compromised,
    // and that intent is the useful thing to have recorded.
    await recordAudit({
      organisationId: current.organisationId,
      actor: { userId: current.user.id, email: current.user.email },
      action: "session.revoked",
      entityType: "session",
      summary: `${current.user.email} signed out of all devices.`,
      request,
    });

    const response = Response.json({ ok: true });
    response.headers.append("Set-Cookie", expiredSessionCookie(request));
    return response;
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthenticatedResponse();
    return Response.json(
      { error: "Those sessions could not be ended." },
      { status: 500 },
    );
  }
}
