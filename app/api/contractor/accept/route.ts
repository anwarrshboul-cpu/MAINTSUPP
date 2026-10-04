import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import {
  contractorCookie,
  contractorForInvite,
  createContractorSession,
  identityForContractor,
} from "../../../lib/contractor-auth";
import { anonymousRefusal } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/** POST /api/contractor/accept — open a personal invite link: sign the contractor in. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; remember?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const db = await getDb();
    const contractor = await contractorForInvite(db, token);
    if (!contractor) {
      return Response.json(
        { error: "This link has expired. Ask your coordinator to send a new one." },
        { status: 410 },
      );
    }
    const session = await createContractorSession(db, {
      contractor,
      identity: identityForContractor(contractor),
      request,
    });
    const response = Response.json({ ok: true, name: contractor.contactName || contractor.name });
    response.headers.append("Set-Cookie", contractorCookie(session, request, body.remember !== false));
    return response;
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Sign-in is unavailable right now. Try again in a minute." }, { status: 503 });
  }
}
