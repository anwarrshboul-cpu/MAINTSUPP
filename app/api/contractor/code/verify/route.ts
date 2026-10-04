import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import {
  checkLoginCode,
  contractorCookie,
  contractorsForIdentity,
  createContractorSession,
  identityKind,
  identityValue,
  normaliseIdentity,
} from "../../../../lib/contractor-auth";
import { checkVerification } from "../../../../lib/twilio";
import { anonymousRefusal } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

const REJECTED = "That code didn't work. Check it, or ask for a new one.";

/** POST /api/contractor/code/verify — the code is right: sign the contractor in. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as {
      identity?: unknown;
      code?: unknown;
      remember?: unknown;
    };
    const identity = normaliseIdentity(typeof body.identity === "string" ? body.identity : "");
    const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
    if (!identity || code.length < 4 || code.length > 10) {
      return Response.json({ error: REJECTED }, { status: 400 });
    }
    const db = await getDb();
    const valid =
      identityKind(identity) === "email"
        ? await checkLoginCode(db, identity, code)
        : await checkVerification(identityValue(identity), code);
    if (!valid) return Response.json({ error: REJECTED }, { status: 401 });

    const [contractor] = await contractorsForIdentity(db, identity);
    if (!contractor) return Response.json({ error: REJECTED }, { status: 401 });
    const session = await createContractorSession(db, { contractor, identity, request });
    const response = Response.json({ ok: true, name: contractor.contactName || contractor.name });
    response.headers.append("Set-Cookie", contractorCookie(session, request, body.remember !== false));
    return response;
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Sign-in is unavailable right now. Try again in a minute." }, { status: 503 });
  }
}
