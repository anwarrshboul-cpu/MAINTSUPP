/**
 * §33 — WHICH EMAILS A PERSON HAS SAID THEY DO NOT WANT, AND THE GUARD THAT
 * STOPS ONE MESSAGE GOING OUT TEN TIMES.
 *
 * Both are consulted by `sendNotification` and by nothing else, so neither can
 * be routed around: every email this product sends passes through that one
 * door (`tests/pre-w14-email-mode.test.mjs` holds it to that).
 *
 * PREFERENCES ARE A PERSON'S, NOT A WORKSPACE'S. A row says "this account does
 * not want report emails", wherever they come from. They apply only to the
 * emails that are addressed to a PERSON because of something a colleague or a
 * rule set up — a scheduled report, an automation's email, a reminder they are
 * named on. The alerts that go to MAINTSUPP's own inboxes (a new job, a lead, a
 * contractor's update, the compliance digest) have no account behind the
 * address and are not a person's to switch off; an invitation and a test the
 * person asked for are never suppressed either. No row means "on": nobody stops
 * receiving anything because this table exists.
 *
 * THE STORM GUARD. The same email — same event, about the same record, to the
 * same address, with the same subject — is sent once per ten minutes. A rule
 * that fires on every edit of an item, a contractor uploading six photographs
 * in a row, a "Send now" pressed twice: each used to be a separate email. The
 * second and later ones are now written to the notification log as
 * `suppressed`, with the reason, so the log still shows what was asked for.
 *
 * The window is claimed with ONE conditional upsert (`claimSendSlot`) rather
 * than a read and a write, so two requests racing for the same email cannot
 * both see "nothing sent yet". Time is stored as epoch milliseconds in a
 * BIGINT, because `notification_log.created_at` is TEXT here and `timestamptz`
 * in Production and comparing the two against a parameter is exactly where the
 * two databases disagree.
 *
 * BOTH FAIL OPEN. A lookup that throws (a table not yet created on a database
 * mid-migration, a dropped connection) lets the email through. The alternative
 * is a lost urgent-job alert because a convenience table was unreachable, and
 * `sendNotification` is documented never to fail the thing that called it.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { notificationCooldowns, notificationPreferences, users } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export const NOTIFICATION_TOPICS = [
  {
    key: "reports",
    label: "Scheduled reports",
    description: "Report emails a colleague has scheduled with you as a recipient.",
    events: ["report.scheduled"],
  },
  {
    key: "automations",
    label: "Automation emails",
    description: "Emails a board automation sends to your address.",
    events: ["automation"],
  },
  {
    key: "reminders",
    label: "Reminders",
    description: "Certificate and job reminders that name you as a recipient.",
    events: ["reminder"],
  },
] as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]["key"];

export const TOPIC_KEYS: ReadonlySet<string> = new Set(NOTIFICATION_TOPICS.map((topic) => topic.key));

/** The topic an event belongs to, or null when no person may switch it off. */
export function topicForEvent(event: string): NotificationTopic | null {
  for (const topic of NOTIFICATION_TOPICS) {
    if ((topic.events as readonly string[]).includes(event)) return topic.key;
  }
  return null;
}

/** Ten minutes: long enough to absorb a loop or a double click, short enough
    that the next real event about the same thing still gets through. */
export const STORM_WINDOW_MS = 10 * 60 * 1000;

/**
 * Never held back by the storm guard. An invitation's Resend mints a new link
 * that the administrator is waiting to hand over, and a test send is the person
 * asking to see the message now.
 */
export const STORM_EXEMPT_EVENTS: ReadonlySet<string> = new Set(["user.invited", "reminder-test"]);

/**
 * Keyed by the address alone, not by the record. A lead's confirmation goes to
 * whatever address a stranger typed into a public form, and each submission is
 * a new lead — so keyed by record, the guard would let one person be mailed
 * once per submission. Keyed by address, one confirmation per ten minutes.
 */
const KEYED_BY_ADDRESS: ReadonlySet<string> = new Set(["lead.confirmation"]);

export type StormRequest = {
  organisationId: string;
  channel: string;
  event: string;
  subjectType: string;
  subjectId?: string | null;
  to: string;
  subject: string;
};

/**
 * What makes two emails "the same", hashed so the table holds no address. The
 * body is left out on purpose: a reminder or a report carries a date or a
 * figure that moves between two sends a minute apart, and they are still the
 * same message to the person receiving them.
 */
export async function stormKey(request: StormRequest) {
  const parts = [
    request.organisationId,
    request.channel,
    request.event,
    request.subjectType,
    KEYED_BY_ADDRESS.has(request.event) ? "" : (request.subjectId ?? ""),
    request.to.trim().toLowerCase(),
    request.subject,
  ];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Claims the right to send this email now. True when nothing identical went in
 * the last `STORM_WINDOW_MS`; the claim itself is the record that one did.
 *
 * One statement: insert the key, or move its time forward ONLY if the stored
 * time is older than the window. `RETURNING` answers whether either happened,
 * so there is no gap between the check and the write for a second request to
 * fall into.
 */
export async function claimSendSlot(db: Database, organisationId: string, key: string, now = Date.now()) {
  try {
    const rows = await db
      .insert(notificationCooldowns)
      .values({ key, organisationId, lastAt: now })
      .onConflictDoUpdate({
        target: notificationCooldowns.key,
        set: { lastAt: now },
        setWhere: sql`${notificationCooldowns.lastAt} <= ${now - STORM_WINDOW_MS}`,
      })
      .returning({ key: notificationCooldowns.key });
    if (Math.random() < 0.02) {
      await db
        .delete(notificationCooldowns)
        .where(sql`${notificationCooldowns.lastAt} < ${now - 24 * 60 * 60 * 1000}`)
        .catch(() => {});
    }
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * Gives the window back after a send that FAILED, so a retry is not refused as
 * a duplicate of an email that never left.
 */
export async function releaseSendSlot(db: Database, key: string) {
  try {
    await db.update(notificationCooldowns).set({ lastAt: 0 }).where(eq(notificationCooldowns.key, key));
  } catch {
    /* Worst case the retry waits out the window; the failure is already logged. */
  }
}

/** True when the account at this address has switched this topic off. */
export async function recipientDeclined(db: Database, address: string, topic: NotificationTopic) {
  try {
    const rows = await db
      .select({ state: notificationPreferences.state })
      .from(notificationPreferences)
      .innerJoin(users, eq(users.id, notificationPreferences.userId))
      .where(
        and(
          sql`lower(${users.email}) = ${address.trim().toLowerCase()}`,
          eq(notificationPreferences.topic, topic),
        ),
      )
      .limit(1);
    return rows[0]?.state === "off";
  } catch {
    return false;
  }
}

/** One person's switches, every topic present, "on" where no row says otherwise. */
export async function readPreferences(db: Database, userId: string) {
  const rows = await db
    .select({ topic: notificationPreferences.topic, state: notificationPreferences.state })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const off = new Set(rows.filter((row) => row.state === "off").map((row) => row.topic));
  return NOTIFICATION_TOPICS.map((topic) => ({
    key: topic.key,
    label: topic.label,
    description: topic.description,
    enabled: !off.has(topic.key),
  }));
}

/** Sets one switch. `state` is TEXT on purpose — see `notificationPreferences`. */
export async function savePreference(db: Database, userId: string, topic: NotificationTopic, enabled: boolean) {
  const state = enabled ? "on" : "off";
  await db
    .insert(notificationPreferences)
    .values({
      id: `npref_${crypto.randomUUID().replace(/-/g, "")}`,
      userId,
      topic,
      state,
    })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.topic],
      set: { state, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
}
