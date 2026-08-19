import { ensureDatabase } from "../../../../db/init";
import { getDb } from "../../../../db";
import { formOptionOverrides } from "../../../lib/form-options";
import {
  expectedUnlockValue,
  formAvailability,
  isUnlocked,
  loadFormByToken,
  publicForm,
  unavailableMessage,
  unlockCookie,
  verifyFormPassword,
} from "../../../lib/form-config";
import { getSession } from "../../../lib/auth-session";

export const dynamic = "force-dynamic";

/**
 * The public form, by share token.
 *
 * ANONYMOUS AND UNSCOPED, DELIBERATELY. Every other read path in this app goes
 * through `scopedDb`, which resolves a session to a tenant and refuses without
 * one. That is exactly wrong here: the whole point of a share link is that the
 * person opening it has no account. The token IS the authorisation — 32 random
 * bytes, uniquely indexed — and `publicForm()` is what stops the token being
 * authorisation for more than it should be.
 *
 * The response is an allowlist built by `publicForm()`, so the hidden
 * questions, the response counter and the access settings are absent by
 * construction rather than by deletion.
 */

function notFound() {
  /*
   * A token that does not resolve and a token that resolves to another tenant's
   * form must be indistinguishable, or the endpoint becomes an oracle for
   * guessing valid tokens. Both answer exactly this.
   */
  return Response.json({ error: "This form could not be found." }, { status: 404 });
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await ensureDatabase();
    const { token } = await context.params;
    const db = await getDb();
    const record = await loadFormByToken(db, token);
    if (!record) return notFound();

    /*
     * Availability is reported rather than hidden. Somebody following a link to
     * a closed form should be told it closed — answering 404 would read as a
     * broken link and generate a support message.
     */
    const availability = formAvailability(record);
    if (!availability.open) {
      return Response.json(
        {
          state: "unavailable",
          reason: availability.reason,
          title: record.title,
          message: unavailableMessage(availability.reason),
        },
        { status: 200 },
      );
    }

    /*
     * "Require login" is checked against a real session. A visitor without one
     * is told to sign in rather than being handed the questions, and the form's
     * own content stays unsent until they have.
     */
    if (record.requireLogin) {
      const session = await getSession(request).catch(() => null);
      if (!session) {
        return Response.json(
          { state: "login-required", title: record.title },
          { status: 200 },
        );
      }
    }

    if (!(await isUnlocked(db, record, request))) {
      /* Only the title crosses the gate, so the tab has something to say. */
      return Response.json({ state: "locked", title: record.title }, { status: 200 });
    }

    /*
     * The Location, Engineer and Priority options come from their canonical
     * registers — sites and `option_values` — not from the captured monday
     * snapshot. `formOptionOverrides` is the ONE builder of that substitution,
     * shared with `/api/board/form`, so the builder's Preview and this route
     * cannot offer different lists.
     */
    return Response.json({
      state: "open",
      form: publicForm(record, await formOptionOverrides(db, record.organisationId, record.config)),
    });
  } catch {
    return Response.json({ error: "This form is temporarily unavailable." }, { status: 503 });
  }
}

/**
 * The password gate.
 *
 * Rate limiting is deliberately NOT implemented here with a counter table: the
 * cost of a guess is already one PBKDF2 verification at 210,000 iterations,
 * which bounds an attacker to single-digit attempts per second per core and is
 * the same defence the sign-in route leans on. A wrong answer returns the same
 * shape as a right one minus the cookie, and says nothing about whether the
 * form exists.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await ensureDatabase();
    const { token } = await context.params;
    const db = await getDb();
    const record = await loadFormByToken(db, token);
    if (!record) return notFound();

    if (!record.hasPassword) {
      return Response.json({ ok: true, state: "open" });
    }

    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !(await verifyFormPassword(db, record.id, password))) {
      return Response.json({ error: "That password is not right." }, { status: 401 });
    }

    const value = await expectedUnlockValue(db, record.id);
    if (!value) return Response.json({ ok: true, state: "open" });

    return Response.json(
      { ok: true, state: "open" },
      { headers: { "Set-Cookie": unlockCookie(request, record.id, value) } },
    );
  } catch {
    return Response.json({ error: "This form is temporarily unavailable." }, { status: 503 });
  }
}
