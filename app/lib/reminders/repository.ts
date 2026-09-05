/**
 * READING AND WRITING REMINDERS. The scheduling arithmetic is next door.
 *
 * `schedule.ts` decides WHEN a reminder fires and `recipients.ts` decides WHO
 * it reaches; neither of them touches a database, which is what lets both be
 * tested against dates and lists rather than against a fixture. This file is
 * the other half: it owns the rows, and it owns the two operations that are
 * only correct if the DATABASE enforces them rather than the application.
 *
 * ── THE TWO OPERATIONS THAT MUST NOT BE DONE IN JAVASCRIPT ─────────────────
 *
 * 1. CLAIMING A DISPATCH. `claimDispatch` inserts into `reminder_dispatch` and
 *    treats a unique-constraint violation as "somebody else already has this
 *    one", which is the whole idempotency guarantee. The obvious alternative —
 *    SELECT to see whether it exists, then INSERT — is a race with itself: two
 *    cron invocations both find nothing and both send. The check has to BE the
 *    insert.
 *
 * 2. REDEEMING A TOKEN. `redeemActionToken` marks the row used with the
 *    used-at test in the WHERE clause, so a double-click on an Acknowledge
 *    link updates one row and zero rows, not two. Single-use is a property of
 *    the update, not of a flag the code reads first.
 *
 * ── OMITTED IS NOT CLEARED ─────────────────────────────────────────────────
 *
 * `updateReminder` takes a patch where `undefined` means "leave it alone" and
 * `null` means "clear it". Sites has been bitten four times by the opposite
 * convention and the calendar route's PATCH says so at length; this file keeps
 * the same rule so a caller that omits `customMessage` does not silently erase
 * one somebody typed.
 */

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  reminderDefaults,
  reminderDispatch,
  reminderRecipients,
  reminderRules,
  reminderTokens,
} from "../../../db/schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle db type is
   assembled per-driver and importing it here drags the D1 binding into a module
   the tests load on its own. Every call below is shaped by the schema imports,
   which is where the real type safety for these queries lives. */
type Db = any;

export type ReminderSubjectType = "certificate" | "visit" | "job" | "note";

export type ReminderRow = {
  id: string;
  subjectType: string;
  subjectId: string;
  stepKey: string | null;
  isEnabled: boolean;
  offsetValue: number;
  offsetUnit: string;
  offsetDirection: string;
  sendTime: string;
  timezone: string;
  repeatEnabled: boolean;
  repeatIntervalDays: number;
  repeatCap: number;
  sendsCount: number;
  customMessage: string | null;
  channel: string;
  nextSendAt: string | null;
  status: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  recipients: ReminderRecipientRow[];
};

export type ReminderRecipientRow = {
  id: string;
  userId: string | null;
  email: string | null;
  groupKey: string | null;
};

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/* ------------------------------------------------------------------ reads -- */

/** Every live reminder on one subject, with its recipients, in step order. */
export async function listReminders(
  db: Db,
  organisationId: string,
  subjectType: string,
  subjectId: string,
): Promise<ReminderRow[]> {
  const rules = await db
    .select()
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.organisationId, organisationId),
        eq(reminderRules.subjectType, subjectType),
        eq(reminderRules.subjectId, subjectId),
        isNull(reminderRules.deletedAt),
      ),
    )
    .orderBy(asc(reminderRules.createdAt));

  if (rules.length === 0) return [];
  const ids = rules.map((rule: { id: string }) => rule.id);
  const recipients = await db
    .select()
    .from(reminderRecipients)
    .where(inArray(reminderRecipients.reminderId, ids));

  const byRule = new Map<string, ReminderRecipientRow[]>();
  for (const row of recipients as Array<ReminderRecipientRow & { reminderId: string }>) {
    const list = byRule.get(row.reminderId) ?? [];
    list.push({ id: row.id, userId: row.userId, email: row.email, groupKey: row.groupKey });
    byRule.set(row.reminderId, list);
  }

  return rules.map((rule: Record<string, unknown>) => ({
    ...(rule as unknown as Omit<ReminderRow, "recipients">),
    recipients: byRule.get(rule.id as string) ?? [],
  }));
}

/** The editable global cascade for one scope, in step order. */
export async function listDefaults(db: Db, organisationId: string, scope: string) {
  return db
    .select()
    .from(reminderDefaults)
    .where(
      and(
        eq(reminderDefaults.organisationId, organisationId),
        eq(reminderDefaults.scope, scope),
        eq(reminderDefaults.active, true),
      ),
    )
    .orderBy(asc(reminderDefaults.stepOrder));
}

/**
 * Reminders the cron should consider, across every organisation.
 *
 * Deliberately NOT organisation-scoped: the caller is a scheduler with no
 * session, and scoping it to one tenant would mean the cron either runs once
 * per tenant or silently serves only the first. The organisation travels on
 * each row instead, and everything written back is keyed by it.
 *
 * `isEnabled` and `status = 'pending'` are both tested. A row switched off
 * keeps its `nextSendAt` — the specification wants rows switched off rather
 * than deleted — so the date alone would select a reminder somebody disabled.
 */
export async function listDueReminders(db: Db, nowIso: string, limit = 200) {
  return db
    .select()
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.isEnabled, true),
        eq(reminderRules.status, "pending"),
        isNull(reminderRules.deletedAt),
        lte(reminderRules.nextSendAt, nowIso),
      ),
    )
    .orderBy(asc(reminderRules.nextSendAt))
    .limit(limit);
}

/* ----------------------------------------------------------------- writes -- */

export type ReminderInput = {
  subjectType: string;
  subjectId: string;
  stepKey?: string | null;
  isEnabled?: boolean;
  offsetValue: number;
  offsetUnit: string;
  offsetDirection: string;
  sendTime: string;
  timezone?: string;
  repeatEnabled?: boolean;
  repeatIntervalDays?: number;
  repeatCap?: number;
  customMessage?: string | null;
  channel?: string;
  nextSendAt: string | null;
  recipients: Array<{ userId?: string | null; email?: string | null; groupKey?: string | null }>;
};

export async function createReminder(
  db: Db,
  organisationId: string,
  input: ReminderInput,
  actorEmail: string | null,
): Promise<string> {
  const id = newId("rem");
  const now = new Date().toISOString();
  await db.insert(reminderRules).values({
    id,
    organisationId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    stepKey: input.stepKey ?? null,
    isEnabled: input.isEnabled ?? true,
    offsetValue: input.offsetValue,
    offsetUnit: input.offsetUnit,
    offsetDirection: input.offsetDirection,
    sendTime: input.sendTime,
    timezone: input.timezone ?? "Europe/London",
    repeatEnabled: input.repeatEnabled ?? false,
    repeatIntervalDays: input.repeatIntervalDays ?? 3,
    repeatCap: input.repeatCap ?? 10,
    sendsCount: 0,
    customMessage: input.customMessage ?? null,
    channel: input.channel ?? "email",
    nextSendAt: input.nextSendAt,
    status: "pending",
    createdByEmail: actorEmail,
    createdAt: now,
    updatedAt: now,
  });
  await replaceRecipients(db, organisationId, id, input.recipients);
  return id;
}

/** `undefined` leaves a field alone; `null` clears it. See the header. */
export type ReminderPatch = Partial<
  Pick<
    ReminderInput,
    | "isEnabled"
    | "offsetValue"
    | "offsetUnit"
    | "offsetDirection"
    | "sendTime"
    | "timezone"
    | "repeatEnabled"
    | "repeatIntervalDays"
    | "repeatCap"
    | "customMessage"
    | "channel"
    | "nextSendAt"
  >
> & { status?: string };

export async function updateReminder(
  db: Db,
  organisationId: string,
  reminderId: string,
  patch: ReminderPatch,
): Promise<void> {
  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  await db
    .update(reminderRules)
    .set(values)
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

/**
 * Soft delete, because a reminder that has already sent is part of the record
 * of what the client was told and when. Hard-deleting it would leave
 * `reminder_dispatch` rows pointing at nothing, which is how an audit trail
 * turns into a list of orphans.
 */
export async function deleteReminder(
  db: Db,
  organisationId: string,
  reminderId: string,
): Promise<void> {
  await db
    .update(reminderRules)
    .set({ deletedAt: new Date().toISOString(), status: "cancelled" })
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

export async function replaceRecipients(
  db: Db,
  organisationId: string,
  reminderId: string,
  recipients: Array<{ userId?: string | null; email?: string | null; groupKey?: string | null }>,
): Promise<void> {
  await db.delete(reminderRecipients).where(eq(reminderRecipients.reminderId, reminderId));
  if (recipients.length === 0) return;
  for (const recipient of recipients) {
    await db.insert(reminderRecipients).values({
      id: newId("rcp"),
      organisationId,
      reminderId,
      userId: recipient.userId ?? null,
      email: recipient.email ?? null,
      groupKey: recipient.groupKey ?? null,
      createdAt: new Date().toISOString(),
    });
  }
}

/* ------------------------------------------------------------- dispatching -- */

/**
 * Take ownership of one (reminder, occurrence), or discover somebody already
 * has it.
 *
 * Returns the dispatch id on success and NULL when the row already existed.
 * Null is not an error: it is the normal answer when the cron overlaps itself,
 * and the caller's correct response is to skip quietly rather than to log a
 * failure. The unique index on (reminder_id, occurrence_date) is what makes
 * this true, so this function must never be "optimised" into a SELECT.
 */
export async function claimDispatch(
  db: Db,
  organisationId: string,
  reminderId: string,
  occurrenceDate: string,
): Promise<string | null> {
  const id = newId("dsp");
  try {
    await db.insert(reminderDispatch).values({
      id,
      organisationId,
      reminderId,
      occurrenceDate,
      status: "claimed",
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  } catch {
    /*
     * The only expected failure here is the unique violation, and both drivers
     * report it differently — SQLite as "UNIQUE constraint failed", Postgres as
     * 23505 wrapped by the shim. Matching on the message would be a third
     * dialect difference to maintain, and any OTHER insert failure at this
     * point also means "do not send", which is the safe answer either way.
     */
    return null;
  }
}

export async function recordDispatchResult(
  db: Db,
  dispatchId: string,
  result: {
    status: "sent" | "failed" | "suppressed";
    providerMessageId?: string | null;
    recipients?: string[];
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(reminderDispatch)
    .set({
      status: result.status,
      sentAt: new Date().toISOString(),
      providerMessageId: result.providerMessageId ?? null,
      recipientsJson: result.recipients ? JSON.stringify(result.recipients) : null,
      error: result.error ?? null,
      attempts: sql`${reminderDispatch.attempts} + 1`,
    })
    .where(eq(reminderDispatch.id, dispatchId));
}

/** Count the sends so `repeat_cap` can be enforced against reality, not a guess. */
export async function noteSendOnRule(
  db: Db,
  organisationId: string,
  reminderId: string,
  nextSendAt: string | null,
): Promise<void> {
  await db
    .update(reminderRules)
    .set({
      sendsCount: sql`${reminderRules.sendsCount} + 1`,
      nextSendAt,
      /*
       * A rule with no next occurrence is DONE, not still pending. Leaving it
       * pending with a null date would make it invisible to `listDueReminders`
       * and permanently "about to send" on screen — the two disagreeing.
       */
      status: nextSendAt ? "pending" : "sent",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

/* ----------------------------------------------------------------- tokens -- */

/**
 * Hash a token the same way the session store does — SHA-256, hex.
 *
 * The token itself is generated by the caller, put in exactly one email, and
 * never stored. What is stored is this digest, so a reader of the database
 * holds something that cannot be replayed as a link.
 */
export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueActionToken(
  db: Db,
  organisationId: string,
  input: {
    reminderId: string;
    subjectType: string;
    subjectId: string;
    action: "ack" | "snooze" | "renew";
    expiresAt: string;
  },
): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await db.insert(reminderTokens).values({
    id: newId("tok"),
    organisationId,
    reminderId: input.reminderId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    tokenHash: await hashToken(token),
    action: input.action,
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString(),
  });
  return token;
}

export type RedeemedToken = {
  reminderId: string;
  organisationId: string;
  subjectType: string;
  subjectId: string;
  action: string;
};

/**
 * Spend a token, once.
 *
 * The `used_at IS NULL` test is IN THE UPDATE and the answer is the number of
 * rows it changed. Reading the row, checking the flag and then writing would
 * let two simultaneous clicks both pass the check — which on a "Mark renewed"
 * link means cancelling a cascade twice and, worse, reporting success to
 * somebody whose second click actually did nothing.
 *
 * Expiry is tested here too rather than by a sweep, so a token is dead on its
 * expiry date whether or not any cleanup has run.
 */
export async function redeemActionToken(
  db: Db,
  token: string,
  nowIso: string,
  usedByEmail: string | null,
): Promise<RedeemedToken | null> {
  const digest = await hashToken(token);
  const [row] = await db
    .select()
    .from(reminderTokens)
    .where(eq(reminderTokens.tokenHash, digest))
    .limit(1);
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt <= nowIso) return null;

  const updated = await db
    .update(reminderTokens)
    .set({ usedAt: nowIso, usedByEmail })
    .where(and(eq(reminderTokens.id, row.id), isNull(reminderTokens.usedAt)))
    .returning({ id: reminderTokens.id });
  if (updated.length === 0) return null;

  return {
    reminderId: row.reminderId,
    organisationId: row.organisationId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    action: row.action,
  };
}

/**
 * Acknowledgement stops the repeat loop ON THAT STEP ONLY.
 *
 * Later steps keep their dates. The specification is explicit and the reason is
 * operational: acknowledging the 90-day warning means "I have seen it", not "I
 * have renewed the certificate", and cancelling the 30-day and 14-day warnings
 * on the strength of it would remove exactly the reminders that matter.
 */
export async function acknowledgeReminder(
  db: Db,
  organisationId: string,
  reminderId: string,
  who: string | null,
  nowIso: string,
): Promise<void> {
  await db
    .update(reminderRules)
    .set({
      acknowledgedAt: nowIso,
      acknowledgedBy: who,
      status: "acknowledged",
      nextSendAt: null,
      updatedAt: nowIso,
    })
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

/** Push one step out, keeping it pending. Snooze delays; it does not cancel. */
export async function snoozeReminder(
  db: Db,
  organisationId: string,
  reminderId: string,
  nextSendAt: string,
  nowIso: string,
): Promise<void> {
  await db
    .update(reminderRules)
    .set({ nextSendAt, status: "pending", updatedAt: nowIso })
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

/**
 * "Mark renewed" — cancel EVERY pending reminder on the record, not just this
 * one, because the certificate this cascade was chasing has been replaced.
 *
 * Sent reminders are untouched: they are the record of what was sent, and
 * retracting them would rewrite history to make the present look tidier.
 */
export async function cancelPendingForSubject(
  db: Db,
  organisationId: string,
  subjectType: string,
  subjectId: string,
  nowIso: string,
): Promise<void> {
  await db
    .update(reminderRules)
    .set({ status: "cancelled", nextSendAt: null, updatedAt: nowIso })
    .where(
      and(
        eq(reminderRules.organisationId, organisationId),
        eq(reminderRules.subjectType, subjectType),
        eq(reminderRules.subjectId, subjectId),
        isNull(reminderRules.deletedAt),
        or(eq(reminderRules.status, "pending"), eq(reminderRules.status, "failed")),
      ),
    );
}
