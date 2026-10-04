import { and, eq, gt } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import { contractorLoginCodes } from "../../../../../db/schema";
import {
  contractorsForIdentity,
  identityKind,
  identityValue,
  issueLoginCode,
  normaliseIdentity,
} from "../../../../lib/contractor-auth";
import { sendLoginCodeEmail } from "../../../../lib/contractor-messaging";
import { emailDeliveryStatus } from "../../../../lib/notifications";
import { startVerification, verifyConfigured } from "../../../../lib/twilio";
import { anonymousRefusal } from "../../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * POST /api/contractor/code/start — "send me a code".
 *
 * The answer is the same whether or not the email or mobile belongs to a
 * contractor, so this cannot be used to find out who works for whom. What it
 * does say is whether codes can be sent AT ALL on this deployment for that kind
 * of address — a fact about the server, not the person.
 */
/**
 * GET /api/contractor/code/start — which kinds of code this deployment can
 * send right now, so the sign-in screen offers only what works. A fact about
 * the server, never about a person.
 */
export function GET() {
  return Response.json(
    { email: emailDeliveryStatus().deliverable, text: verifyConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as { identity?: unknown; channel?: unknown };
    const identity = normaliseIdentity(typeof body.identity === "string" ? body.identity : "");
    if (!identity) {
      return Response.json({ error: "Enter the email or mobile number your coordinator has for you." }, { status: 400 });
    }
    const kind = identityKind(identity);
    const deliverable = kind === "email" ? emailDeliveryStatus().deliverable : verifyConfigured();
    if (!deliverable) {
      return Response.json({
        ok: false,
        unavailable: true,
        message:
          kind === "email"
            ? "Codes by email aren't switched on yet. Use the app link your coordinator sent you."
            : "Codes by text aren't switched on yet. Try your email, or use the app link your coordinator sent you.",
      });
    }

    const db = await getDb();
    const matches = await contractorsForIdentity(db, identity);
    if (matches.length) {
      if (kind === "email") {
        /* One code a minute per address, so the button cannot be used to spam. */
        const [recent] = await db
          .select({ id: contractorLoginCodes.id })
          .from(contractorLoginCodes)
          .where(
            and(
              eq(contractorLoginCodes.identity, identity),
              gt(contractorLoginCodes.expiresAt, Date.now() + 9 * 60 * 1000),
            ),
          )
          .limit(1);
        if (!recent) {
          const code = await issueLoginCode(db, identity);
          await sendLoginCodeEmail(db, matches[0], identityValue(identity), code);
        }
      } else {
        await startVerification(identityValue(identity), body.channel === "whatsapp" ? "whatsapp" : "sms");
      }
    }
    return Response.json({
      ok: true,
      message:
        kind === "email"
          ? "If that email is on our contractor list, a 6-digit code is on its way."
          : "If that mobile is on our contractor list, a code is on its way by text.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Codes can't be sent right now. Try again in a minute." }, { status: 503 });
  }
}
