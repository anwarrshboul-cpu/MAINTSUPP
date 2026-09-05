/**
 * `POST /api/reminders/test-send` — send the template to yourself, and to
 * nobody else.
 *
 * ── THE RECIPIENT IS NOT A PARAMETER ───────────────────────────────────────
 *
 * The address is taken from the SESSION and there is no field in the body that
 * can change it. That is the entire security design of this endpoint: a
 * "send a test to this address" parameter is an open mail relay wearing a
 * different name, and it would let any authenticated user post arbitrary
 * MAINTSUPP-branded mail to anyone. The specification's own wording — "sends
 * the current template to the logged-in user only" — is a constraint, not a
 * default.
 *
 * ── AND IT IS NOT A REAL SEND ──────────────────────────────────────────────
 *
 * Subject prefixed `[TEST]`, and NOT recorded against the reminder's dispatch
 * ledger. A test that wrote a `reminder_dispatch` row would consume the
 * (rule, occurrence) pair the real send needs, and the reminder would then
 * never go out — the idempotency guarantee turned into a way to silently
 * cancel a reminder by previewing it.
 *
 * It still passes through `sendNotification`, so `EMAIL_MODE` applies and the
 * attempt is visible in `notification_log`. A test send in Preview is
 * suppressed exactly like every other message.
 */

import { ensureDatabase } from "../../../../db/init";
import { scopedDbWithCapability } from "../../../lib/tenant-db";
import { databaseSafeFailure } from "../../../lib/database-failure";
import { sendNotification } from "../../../lib/notifications";
import { reminderEmail } from "../../../lib/reminders/template";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    const to = (actor.email ?? "").trim();
    if (!to || !to.includes("@")) {
      return Response.json(
        { error: "Your account has no email address, so a test cannot be sent to you." },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const subjectType =
      typeof body?.subjectType === "string" ? body.subjectType.slice(0, 40) : "certificate";
    const title = typeof body?.title === "string" ? body.title.slice(0, 200) : null;
    const siteName = typeof body?.siteName === "string" ? body.siteName.slice(0, 200) : null;
    const expiryDate = typeof body?.expiryDate === "string" ? body.expiryDate.slice(0, 10) : null;
    const daysRemaining = Number.isFinite(Number(body?.daysRemaining))
      ? Number(body?.daysRemaining)
      : null;
    const customMessage =
      typeof body?.customMessage === "string" ? body.customMessage.slice(0, 2000) : null;

    const message = reminderEmail({
      subjectType,
      subjectId: "preview",
      title,
      siteName,
      expiryDate,
      daysRemaining,
      customMessage,
      occurrenceKey: "preview",
      /*
       * Placeholder tokens, and deliberately not real ones. Issuing three
       * single-use tokens for a preview would mean a test send handed out
       * working Acknowledge and Mark-renewed links for a live cascade.
       */
      tokens: { ack: "test-token", snooze: "test-token", renew: "test-token" },
    });

    const result = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: "reminder-test",
      subjectType: subjectType === "certificate" ? "compliance" : "job",
      subjectId: null,
      to,
      subject: `[TEST] ${message.subject}`,
      body: message.html,
      text: message.text,
    });

    return Response.json({
      ok: result.ok || result.status === "suppressed" || result.status === "skipped",
      to,
      status: result.status,
      /*
       * The mode is reported back so the operator is told what actually
       * happened. "Sent" when nothing left the building would be the single
       * most misleading thing this endpoint could say.
       */
      message:
        result.status === "sent"
          ? `A test reminder has been sent to ${to}.`
          : result.status === "suppressed"
            ? `Email is suppressed on this deployment, so nothing was delivered. The message was written to the notification log instead.`
            : result.status === "skipped"
              ? `Email is not configured on this deployment, so nothing was delivered.`
              : `The test could not be sent: ${result.error ?? "unknown error"}`,
    });
  } catch (error) {
    const { status, message } = databaseSafeFailure(error, "The test send could not be made.");
    return Response.json({ error: message }, { status });
  }
}
