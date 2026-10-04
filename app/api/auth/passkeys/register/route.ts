import { anonymousRefusal } from "../../../../lib/tenant-db";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import { passkeys } from "../../../../../db/schema";
import { recordAudit } from "../../../../lib/audit";
import { getSession } from "../../../../lib/auth-session";
import { allowedOrigins, consumeChallenge, findPasskey } from "../../../../lib/passkey-store";
import { fromBase64Url, parseClientData, verifyRegistration } from "../../../../lib/webauthn";

export const dynamic = "force-dynamic";

/** POST /api/auth/passkeys/register — finish adding Face ID to the signed-in account. */
async function handlePOST(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: "Sign in first, then set up Face ID." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    clientDataJSON?: unknown;
    authenticatorData?: unknown;
    publicKey?: unknown;
    publicKeyAlgorithm?: unknown;
    transports?: unknown;
    name?: unknown;
  };
  if (
    typeof body.id !== "string" ||
    typeof body.clientDataJSON !== "string" ||
    typeof body.authenticatorData !== "string" ||
    typeof body.publicKey !== "string" ||
    typeof body.publicKeyAlgorithm !== "number" ||
    body.id.length > 1400
  ) {
    return Response.json(
      { error: "This browser did not return a usable passkey. Update the phone's software and try again." },
      { status: 400 },
    );
  }

  try {
    const db = await getDb();
    const clientDataJSON = fromBase64Url(body.clientDataJSON);
    const clientData = parseClientData(clientDataJSON);
    const challenge = await consumeChallenge(db, clientData.challenge, "register", session.user.id);
    if (!challenge) {
      return Response.json({ error: "That took too long. Try again." }, { status: 400 });
    }
    const result = await verifyRegistration({
      clientData,
      authenticatorData: fromBase64Url(body.authenticatorData),
      credentialId: fromBase64Url(body.id),
      publicKey: fromBase64Url(body.publicKey),
      algorithm: body.publicKeyAlgorithm,
      allowedOrigins: allowedOrigins(request),
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    if (await findPasskey(db, body.id)) {
      return Response.json({ error: "This device is already set up." }, { status: 409 });
    }

    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Passkey";
    const transports = Array.isArray(body.transports)
      ? body.transports.filter((value): value is string => typeof value === "string").slice(0, 6)
      : [];
    await db.insert(passkeys).values({
      id: body.id,
      userId: session.user.id,
      publicKey: body.publicKey,
      algorithm: body.publicKeyAlgorithm,
      signCount: result.signCount,
      name,
      transports: JSON.stringify(transports),
    });
    await recordAudit({
      organisationId: session.organisationId,
      actor: { userId: session.user.id, email: session.user.email },
      action: "passkey.added",
      entityType: "user",
      entityId: session.user.id,
      summary: `${session.user.email} set up Face ID / passkey sign-in on ${name}.`,
      request,
    }).catch(() => {});
    return Response.json({ ok: true, name });
  } catch (failure) {
    void failure;
    return Response.json({ error: "Face ID could not be set up right now. Try again." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  /* The boot call sits inside the try, so a database outage answers with a
     JSON message rather than an empty body (tests/api-error-body.test.mjs). */
  try {
    await ensureDatabase();
    return await handlePOST(request);
  } catch (error) {
    /* An ended session is a sign-in prompt, not an outage. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "Sign-in with Face ID is unavailable right now. Use your password." },
      { status: 503 },
    );
  }
}
