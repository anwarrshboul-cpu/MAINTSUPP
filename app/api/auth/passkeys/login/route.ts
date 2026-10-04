import { anonymousRefusal } from "../../../../lib/tenant-db";
import { eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { getD1, getDb } from "../../../../../db";
import { passkeys } from "../../../../../db/schema";
import { recordAudit } from "../../../../lib/audit";
import {
  createSession,
  recordLogin,
  safeRedirectPath,
  sessionCookie,
} from "../../../../lib/auth-session";
import { allowedOrigins, consumeChallenge, findPasskey } from "../../../../lib/passkey-store";
import { fromBase64Url, parseClientData, verifyAssertion } from "../../../../lib/webauthn";

export const dynamic = "force-dynamic";

/** The one failure message, like the password route: nothing to learn from it. */
const REJECTED = "Face ID sign-in didn't work. Try again, or use your email and password.";

/**
 * POST /api/auth/passkeys/login — exchange a Face ID signature for a session.
 *
 * Ends exactly where a password sign-in ends — the same `createSession`, the
 * same cookie, the same audit and "last signed in" stamp — so everything after
 * this (workspaces, permissions, sign out everywhere) is unchanged. An account
 * that is disabled or no longer active is refused even with a valid passkey.
 */
async function handlePOST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    clientDataJSON?: unknown;
    authenticatorData?: unknown;
    signature?: unknown;
    next?: unknown;
    remember?: unknown;
  };
  if (
    typeof body.id !== "string" ||
    typeof body.clientDataJSON !== "string" ||
    typeof body.authenticatorData !== "string" ||
    typeof body.signature !== "string" ||
    body.id.length > 1400
  ) {
    return Response.json({ error: REJECTED }, { status: 400 });
  }

  try {
    const db = await getDb();
    const clientDataJSON = fromBase64Url(body.clientDataJSON);
    const clientData = parseClientData(clientDataJSON);
    const challenge = await consumeChallenge(db, clientData.challenge, "login", null);
    const passkey = await findPasskey(db, body.id);
    if (!challenge || !passkey) return Response.json({ error: REJECTED }, { status: 401 });

    const result = await verifyAssertion({
      clientData,
      clientDataJSON,
      authenticatorData: fromBase64Url(body.authenticatorData),
      signature: fromBase64Url(body.signature),
      publicKey: fromBase64Url(passkey.publicKey),
      algorithm: passkey.algorithm,
      storedSignCount: Number(passkey.signCount) || 0,
      allowedOrigins: allowedOrigins(request),
    });
    if (!result.ok) return Response.json({ error: REJECTED }, { status: 401 });

    /* The account behind the passkey must still be allowed in. */
    const d1 = await getD1();
    const lookup = await d1
      .prepare("SELECT id, email, active, status, organisation_id FROM users WHERE id = ? LIMIT 1")
      .bind(passkey.userId)
      .all();
    const [user] = (lookup.results ?? []) as Array<{
      id: string;
      email: string;
      active: number | boolean | null;
      status: string | null;
      organisation_id: string | null;
    }>;
    const usable =
      !!user && user.active !== 0 && user.active !== false && (!user.status || user.status === "active");
    if (!usable) return Response.json({ error: REJECTED }, { status: 401 });

    await db
      .update(passkeys)
      .set({ signCount: result.signCount, lastUsedAt: new Date().toISOString() })
      .where(eq(passkeys.id, passkey.id));

    const { token } = await createSession(d1, {
      userId: String(user.id),
      organisationId: user.organisation_id ?? null,
      request,
    });
    await recordAudit({
      organisationId: user.organisation_id ?? null,
      actor: { userId: String(user.id), email: user.email },
      action: "session.signed_in",
      entityType: "session",
      summary: `${user.email} signed in with Face ID / passkey.`,
      request,
    });
    await recordLogin(d1, String(user.id)).catch(() => {});

    const response = Response.json({ ok: true, redirectTo: safeRedirectPath(body.next) });
    response.headers.append(
      "Set-Cookie",
      sessionCookie(token, request, { remember: body.remember !== false }),
    );
    return response;
  } catch (failure) {
    /* Anything unreadable is the same uniform refusal; nothing is logged. */
    void failure;
    return Response.json({ error: REJECTED }, { status: 401 });
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
