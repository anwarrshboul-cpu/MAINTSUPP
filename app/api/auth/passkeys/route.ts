import { anonymousRefusal } from "../../../lib/tenant-db";
import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import { recordAudit } from "../../../lib/audit";
import { getSession } from "../../../lib/auth-session";
import { passkeysFor, removePasskey } from "../../../lib/passkey-store";

export const dynamic = "force-dynamic";

/**
 * /api/auth/passkeys — the signed-in person's own Face ID / fingerprint keys.
 *
 *   GET     list them (names and dates only; a public key is not news)
 *   DELETE  ?id=… remove one of THEIR OWN — the user filter is in the query
 */

async function handleGET(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const db = await getDb();
  const rows = await passkeysFor(db, session.user.id);
  return Response.json({
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name ?? "Passkey",
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    })),
  });
}

async function handleDELETE(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "Which passkey?" }, { status: 400 });
  const db = await getDb();
  await removePasskey(db, session.user.id, id);
  await recordAudit({
    organisationId: session.organisationId,
    actor: { userId: session.user.id, email: session.user.email },
    action: "passkey.removed",
    entityType: "user",
    entityId: session.user.id,
    summary: `${session.user.email} removed a Face ID / passkey sign-in.`,
    request,
  }).catch(() => {});
  return Response.json({ ok: true });
}

export async function GET(request: Request) {
  /* The boot call sits inside the try, so a database outage answers with a
     JSON message rather than an empty body (tests/api-error-body.test.mjs). */
  try {
    await ensureDatabase();
    return await handleGET(request);
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

export async function DELETE(request: Request) {
  /* The boot call sits inside the try, so a database outage answers with a
     JSON message rather than an empty body (tests/api-error-body.test.mjs). */
  try {
    await ensureDatabase();
    return await handleDELETE(request);
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
