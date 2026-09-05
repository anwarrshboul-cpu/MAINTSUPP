/**
 * `POST /api/reminders/action` — spend an Acknowledge / Snooze / Mark-renewed
 * token.
 *
 * ── WHY THIS IS A POST AND THE EMAIL LINK IS NOT ───────────────────────────
 *
 * The specification asks for links that work without logging in, and the
 * obvious implementation is a GET that performs the action when the link is
 * opened. That implementation loses tokens to machines.
 *
 * Outlook SafeLinks, Gmail's scanners, corporate mail gateways and link
 * previewers all FETCH a URL before any human sees it. A single-use token
 * spent by a scanner is spent: the recipient clicks a dead link, the record
 * shows the reminder was acknowledged at 03:14 by nobody, and the repeat loop
 * they were relying on has stopped. That is worse than an extra click, because
 * it is silent and it looks like the person did it.
 *
 * So the emailed link is a GET that renders a confirmation, and the action
 * happens here, on a POST a scanner will not issue. The cost is one button.
 *
 * ── NO SESSION, AND THAT IS THE POINT ──────────────────────────────────────
 *
 * The whole value of these links is that a renewal owner who does not have a
 * portal account can still stop a cascade. Authority comes from the token — a
 * 64-character random string, stored only as a SHA-256 digest, single-use,
 * 30-day expiry — and `redeemActionToken` spends it with the used-at test
 * inside the UPDATE so two simultaneous clicks cannot both succeed.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { complianceDocuments } from "../../../../db/schema";
import {
  acknowledgeReminder,
  cancelPendingForSubject,
  redeemActionToken,
  snoozeReminder,
} from "../../../lib/reminders/repository";

export const dynamic = "force-dynamic";

/** Snooze is seven days, per the specification's own wording on the button. */
const SNOOZE_DAYS = 7;

export type ReminderActionResult = {
  ok: boolean;
  action?: string;
  message: string;
};

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const db = await getDb();

    const body = (await request.json().catch(() => null)) as {
      token?: unknown;
      email?: unknown;
    } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) {
      return Response.json({ ok: false, message: "No token was supplied." }, { status: 400 });
    }
    /*
     * The address is whatever the recipient typed, and it is recorded rather
     * than trusted. It answers "who says they did this" on the activity log; it
     * grants nothing, because the token already did.
     */
    const declaredEmail =
      typeof body?.email === "string" && body.email.includes("@") ? body.email.trim() : null;

    const nowIso = new Date().toISOString();
    const redeemed = await redeemActionToken(db, token, nowIso, declaredEmail);
    if (!redeemed) {
      /*
       * One message for expired, already-used and never-existed.
       *
       * Distinguishing them would tell someone holding a guessed token whether
       * they had guessed a real one, and there is nothing the honest recipient
       * can do differently in any of the three cases anyway.
       */
      return Response.json(
        {
          ok: false,
          message:
            "This link is no longer valid. It may already have been used, or it may have expired. Ask for a new reminder or sign in to the portal.",
        },
        { status: 410 },
      );
    }

    const { organisationId, reminderId, subjectType, subjectId, action } = redeemed;

    if (action === "ack") {
      await acknowledgeReminder(db, organisationId, reminderId, declaredEmail, nowIso);
      return Response.json({
        ok: true,
        action,
        message:
          "Thank you — this reminder is acknowledged and will stop repeating. Later steps in the cascade will still be sent.",
      } satisfies ReminderActionResult);
    }

    if (action === "snooze") {
      const next = new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString();
      await snoozeReminder(db, organisationId, reminderId, next, nowIso);
      return Response.json({
        ok: true,
        action,
        message: `Snoozed. This reminder will return in ${SNOOZE_DAYS} days.`,
      } satisfies ReminderActionResult);
    }

    if (action === "renew") {
      /*
       * Mark renewed cancels EVERY pending reminder on the record, not just
       * this step — the thing the cascade was chasing has been dealt with, so
       * the remaining steps are chasing nothing. Sent reminders are untouched:
       * they are the record of what was sent and when.
       */
      await cancelPendingForSubject(db, organisationId, subjectType, subjectId, nowIso);
      if (subjectType === "certificate") {
        await db
          .update(complianceDocuments)
          .set({ renewalStatus: "Certificate received", updatedAt: nowIso })
          .where(
            and(
              eq(complianceDocuments.id, subjectId),
              eq(complianceDocuments.organisationId, organisationId),
            ),
          );
      }
      return Response.json({
        ok: true,
        action,
        message:
          "Marked as renewed. Every outstanding reminder on this record has been cancelled. Please upload the new certificate when you have it.",
      } satisfies ReminderActionResult);
    }

    return Response.json(
      { ok: false, message: "That action is not recognised." },
      { status: 400 },
    );
  } catch (error) {
    console.error("[/api/reminders/action]", error);
    return Response.json(
      { ok: false, message: "The action could not be completed. Please try again." },
      { status: 503 },
    );
  }
}

/**
 * Deliberately not implemented.
 *
 * A GET here would be exactly the scanner-consumable endpoint the header
 * explains this route exists to avoid. The emailed link points at the
 * confirmation PAGE, which issues the POST.
 */
export async function GET() {
  return Response.json(
    {
      ok: false,
      message: "Open the link from your email to confirm this action.",
    },
    { status: 405 },
  );
}
