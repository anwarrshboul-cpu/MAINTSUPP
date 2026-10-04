import { anonymousRefusal } from "../../../../lib/tenant-db";
import { ensureDatabase } from "../../../../../db/init";
import { getDb } from "../../../../../db";
import { getSession } from "../../../../lib/auth-session";
import { issueChallenge, passkeysFor, rpIdFor } from "../../../../lib/passkey-store";
import { ALGORITHM_ES256, ALGORITHM_RS256, toBase64Url } from "../../../../lib/webauthn";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/passkeys/options — start a Face ID ceremony.
 *
 * `{ purpose: "register" }` needs a session: it adds a passkey to the account
 * that is signed in, and to no other. `{ purpose: "login" }` needs nothing: the
 * phone offers whichever MAINTSUPP passkeys it holds, and the one chosen names
 * its own account. Either way the answer carries a fresh one-time challenge.
 */
async function handlePOST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { purpose?: unknown };
  const db = await getDb();
  const rpId = rpIdFor(request);

  if (body.purpose === "register") {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in first, then set up Face ID." }, { status: 401 });
    const existing = await passkeysFor(db, session.user.id);
    const challenge = await issueChallenge(db, "register", session.user.id);
    return Response.json({
      publicKey: {
        challenge,
        rp: { id: rpId, name: "MAINTSUPP" },
        user: {
          id: toBase64Url(new TextEncoder().encode(session.user.id)),
          name: session.user.email,
          displayName: session.user.displayName,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: ALGORITHM_ES256 },
          { type: "public-key", alg: ALGORITHM_RS256 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        timeout: 60000,
        excludeCredentials: existing.map((row) => ({ type: "public-key", id: row.id })),
      },
    });
  }

  if (body.purpose === "login") {
    const challenge = await issueChallenge(db, "login", null);
    return Response.json({
      publicKey: { challenge, rpId, userVerification: "required", timeout: 60000, allowCredentials: [] },
    });
  }

  return Response.json({ error: "Unknown purpose." }, { status: 400 });
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
