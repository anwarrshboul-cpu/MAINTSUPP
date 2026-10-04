import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import { contractorScope, endContractorSession, expiredContractorCookie } from "../../../lib/contractor-auth";

export const dynamic = "force-dynamic";

/** POST /api/contractor/logout — sign this phone out of the contractor app. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const db = await getDb();
    const scope = await contractorScope(db, request);
    if (scope) await endContractorSession(db, scope.sessionId);
  } catch {
    /* Signing out still clears the cookie below. */
  }
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", expiredContractorCookie(request));
  return response;
}
