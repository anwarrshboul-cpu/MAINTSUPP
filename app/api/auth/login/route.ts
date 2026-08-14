import { recordAudit } from "../../../lib/audit";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  checkPassword,
  clearSignInFailures,
  createSession,
  ensureOwnerAccount,
  recordLogin,
  recordSignInFailure,
  requestIp,
  safeRedirectPath,
  sessionCookie,
  signInRetryAfter,
} from "../../../lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login — exchange an email and password for a session cookie.
 *
 * Two rules shape every response below.
 *
 * The first is that failure is *uniform*. "No such account", "wrong password",
 * "account deactivated" and "no password set" all return the same 401 with the
 * same wording, and `checkPassword` makes them take the same amount of time.
 * Anything else turns this endpoint into a way to test whether an email has an
 * account here, which is a disclosure in its own right — it tells you who a
 * company's clients are — and it hands a credential-stuffing run a free
 * filtering step before it spends any effort guessing.
 *
 * The second is that nothing about the credential leaves this function. No
 * branch logs the email with the outcome, no response echoes the password, and
 * the session token appears only inside a `Set-Cookie` header.
 */

/** The one failure message. Every rejected sign-in gets exactly this. */
const REJECTED = "That email and password do not match an account.";

function readField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  await ensureDatabase();
  const d1 = await getD1();

  // Provisions the owner account if it is missing. Here as well as on the
  // sign-in page so a fresh database can be signed into through the API alone.
  await ensureOwnerAccount(d1).catch(() => {
    // A seeding failure must not take down sign-in for accounts that already
    // exist — those are the ones that matter once the workspace is in use.
  });

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send an email and password." }, { status: 400 });
  }

  const email = readField(payload, "email").trim().toLowerCase();
  const password = readField(payload, "password");
  const ip = requestIp(request);

  if (!email || !password) {
    // Not a credential check, so this one may be specific: the form simply was
    // not filled in, and nothing about any account is revealed by saying so.
    return Response.json(
      { error: "Enter your email address and password." },
      { status: 400 },
    );
  }

  // Checked before the password is verified, so a locked-out attacker cannot
  // keep spending server CPU on 210,000-iteration derivations.
  const retryAfter = await signInRetryAfter(d1, email, ip);
  if (retryAfter > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    const response = Response.json(
      {
        error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        retryAfter,
      },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(retryAfter));
    return response;
  }

  const outcome = await checkPassword(d1, email, password);
  if (!outcome.ok) {
    await recordSignInFailure(d1, email, ip);
    /*
     * A failed sign-in has no workspace, which is exactly why it is worth
     * keeping: a run of these against one address is the first visible sign
     * of someone trying passwords. Recorded with the address as typed and
     * nothing else — never the password, and never whether the account
     * exists, which is the same thing the response refuses to reveal.
     */
    await recordAudit({
      organisationId: null,
      actor: { email },
      action: "session.sign_in_failed",
      entityType: "session",
      summary: `Failed sign-in for ${email}.`,
      request,
    });
    return Response.json({ error: REJECTED }, { status: 401 });
  }

  await clearSignInFailures(d1, email, ip);

  const { token } = await createSession(d1, {
    userId: outcome.userId,
    organisationId: outcome.organisationId,
    request,
  });
  await recordAudit({
    organisationId: outcome.organisationId,
    actor: { userId: outcome.userId, email },
    action: "session.signed_in",
    entityType: "session",
    summary: `${email} signed in.`,
    request,
  });
  await recordLogin(d1, outcome.userId).catch(() => {
    // Cosmetic. A missing "last signed in" stamp is not worth failing a
    // successful authentication over.
  });

  const response = Response.json({
    ok: true,
    // Where the browser should go next: the page the user was heading for
    // before they were asked to sign in, once it has been proved to be one of
    // ours. Never reflected back unsanitised — see `safeRedirectPath`.
    redirectTo: safeRedirectPath(payload.next),
  });
  response.headers.append("Set-Cookie", sessionCookie(token, request));
  return response;
}
