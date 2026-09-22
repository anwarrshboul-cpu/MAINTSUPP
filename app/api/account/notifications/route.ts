/**
 * `/api/account/notifications` — the signed-in person's own email switches
 * (§33), and whether this deployment delivers email at all.
 *
 * GET answers every topic, "on" unless the person has switched it off, and the
 * deployment's delivery status in the words `emailDeliveryStatus()` uses — so
 * the screen never offers a switch for email that is not being sent without
 * saying so (owner decision Q1).
 *
 * PUT `{ topic, enabled }` sets one switch. It is the caller's OWN row and
 * nobody else's: the account is resolved from the session's identity, never
 * from the body, so there is no id to tamper with. A caller who has not proved
 * who they are (the development role switcher) is refused a write — a
 * preference belongs to an account, and a demo identity is not one.
 */

import { eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { users } from "../../../../db/schema";
import { emailDeliveryStatus } from "../../../lib/notifications";
import { TOPIC_KEYS, readPreferences, savePreference, type NotificationTopic } from "../../../lib/notification-preferences";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

type Database = Awaited<ReturnType<typeof scopedDb>>["db"];

async function accountId(db: Database, email: string) {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  return rows[0]?.id ?? null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const userId = context.authenticated ? await accountId(context.db, context.identityEmail) : null;
    return Response.json({
      /* Null when there is no account to hold a preference — said, not faked. */
      topics: userId ? await readPreferences(context.db, userId) : null,
      delivery: emailDeliveryStatus(),
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Your notification settings are temporarily unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    if (!context.authenticated) {
      return Response.json({ error: "Sign in to change your notification settings." }, { status: 401 });
    }
    const userId = await accountId(context.db, context.identityEmail);
    if (!userId) {
      return Response.json({ error: "This identity has no account record, so there is nothing to save." }, { status: 404 });
    }
    const payload = (await request.json().catch(() => null)) as { topic?: unknown; enabled?: unknown } | null;
    const topic = typeof payload?.topic === "string" ? payload.topic : "";
    if (!TOPIC_KEYS.has(topic)) {
      return Response.json({ error: "Choose one of the listed email types." }, { status: 400 });
    }
    if (typeof payload?.enabled !== "boolean") {
      return Response.json({ error: "Say whether this email should be on or off." }, { status: 400 });
    }
    await savePreference(context.db, userId, topic as NotificationTopic, payload.enabled);
    return Response.json({ topics: await readPreferences(context.db, userId) });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Your notification settings could not be saved." }, { status: 503 });
  }
}
