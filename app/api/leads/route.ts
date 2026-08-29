import { ensureDatabase } from "../../../db/init";
import { leads } from "../../../db/schema";
import { scopedDb } from "../../lib/tenant-db";
import { eq, sql } from "drizzle-orm";
import {
  leadAlertTemplate,
  leadConfirmationTemplate,
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function GET() {
  return Response.json(
    { error: "Lead export is disabled while public testing is active." },
    { status: 501 },
  );
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const name = clean(payload.name, 120);
    const company = clean(payload.company, 160);
    const email = clean(payload.email, 180).toLowerCase();
    const phone = clean(payload.phone, 80);
    const siteRange = clean(payload.siteRange, 40);
    const services = Array.isArray(payload.services)
      ? payload.services.map((value) => clean(value, 80)).filter(Boolean)
      : [];
    const regions = Array.isArray(payload.regions)
      ? payload.regions.map((value) => clean(value, 80)).filter(Boolean)
      : [];
    const challenge = clean(payload.challenge, 900);

    /*
     * `services` is no longer required, because the form no longer asks.
     *
     * It was a "which service lines interest you" multi-select on step 1 of the
     * old three-step form — a question put to the reader before the page had
     * told them what any of the lines cost. The rebuilt CTA drops it, and a
     * required field with no control behind it is a 400 nobody can fix. It is
     * still READ and still stored: anything that does send it keeps working,
     * which matters because `leads.services` already holds rows.
     *
     * `regions` and `challenge` are no longer required either, for exactly
     * the same reason: the form stopped asking.
     *
     * The CTA dropped "Regions", "Approx. maintenance issues per month" and
     * "Biggest problem right now". `regions` was the first of those; the
     * other two were glued into `challenge` by the form, because `challenge`
     * was once a free-text box and this check went on demanding 20 characters
     * of it long after the box was gone. With no control behind either,
     * keeping them required would have made every submission from the only
     * page that posts here a 400 nobody can fix — and the alternative,
     * sending a placeholder long enough to clear the floor, would have
     * written a sentence the visitor never said into a sales inbox.
     *
     * Both are still READ, still stored and still notified: anything that
     * does send them keeps working, and `leads.regions` / `leads.challenge`
     * are NOT NULL columns with existing rows behind them. Absent, they
     * store as "[]" and "" — an unanswered question recorded as unanswered,
     * which is honest in a way an invented answer is not. `leadAlertTemplate`
     * already drops a row whose value is empty, so a lead with no challenge
     * shows no "What they said" line rather than an empty one.
     *
     * Everything else stays required. Those five are all on the form.
     */
    if (!name || !company || !/^\S+@\S+\.\S+$/.test(email) || !siteRange) {
      return Response.json({ error: "Complete the required portfolio and contact details." }, { status: 400 });
    }

    await ensureDatabase();
    // The public lead form has no account behind it by definition.
    const { db, orgId } = await scopedDb(request, { allowAnonymous: true });
    const [created] = await db.insert(leads).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      name,
      company,
      email,
      phone: phone || null,
      siteRange,
      services: JSON.stringify(services),
      regions: JSON.stringify(regions),
      challenge,
      status: "New",
    }).returning();

    // J2 / J3 — tell sales, and confirm to the prospect.
    //
    // Notification failure must never fail the request: the lead is already
    // saved, and losing it because a mail provider was down would be worse than
    // not sending the alert. Failures are recorded in notification_log and can
    // be replayed from /api/notifications/replay.
    const { salesInbox } = notificationTargets();
    const alert = leadAlertTemplate({
      name, company, email, phone, siteRange, challenge,
    });
    const [alertResult, confirmationResult] = await Promise.all([
      sendNotification(db, {
        organisationId: orgId,
        channel: "email",
        event: "lead.created",
        subjectType: "lead",
        subjectId: created.id,
        to: salesInbox,
        subject: alert.subject,
        body: alert.body,
      }),
      (async () => {
        const confirmation = leadConfirmationTemplate({ name });
        return sendNotification(db, {
          organisationId: orgId,
          channel: "email",
          event: "lead.confirmation",
          subjectType: "lead",
          subjectId: created.id,
          to: email,
          subject: confirmation.subject,
          body: confirmation.body,
        });
      })(),
    ]);

    await db
      .update(leads)
      .set({
        notifiedAt: alertResult.ok ? sql`CURRENT_TIMESTAMP` : null,
        notifyAttempts: 1,
      })
      .where(eq(leads.id, created.id));

    return Response.json(
      {
        lead: created,
        notified: alertResult.ok,
        confirmationSent: confirmationResult.ok,
      },
      { status: 201 },
    );
  } catch {
    return Response.json({ error: "The portfolio review request could not be saved." }, { status: 503 });
  }
}
