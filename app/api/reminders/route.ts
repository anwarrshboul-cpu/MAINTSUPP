/**
 * `/api/reminders` — the reminder rows on one record.
 *
 * ── THE ANCHOR ARRIVES WITH THE WRITE, AND IS NOT LOOKED UP ────────────────
 *
 * A reminder is stored as an OFFSET plus a send time, and `next_send_at` is a
 * cache of the two applied to an anchor date — a certificate's expiry, a
 * visit's start. This route takes that anchor from the caller rather than
 * reading it back out of the subject, and the reason is a sequencing one: the
 * dialog lets somebody change the expiry date and the cascade in the same
 * edit, and a route that re-read the record would compute every reminder
 * against the OLD date until the record's own save landed. The client already
 * knows the date the user is looking at; it sends it.
 *
 * The cost is that a caller could send an anchor that does not match the
 * record. That is bounded — `next_send_at` is only ever a cache, and
 * `recalculateCascade` rebuilds it from the record on the next edit — and the
 * alternative costs correctness on the one path that matters.
 *
 * ── WHY THERE IS NO "SAVE THE WHOLE LIST" VERB ─────────────────────────────
 *
 * PATCH edits one row and DELETE removes one row. A bulk replace would be
 * fewer requests and would also silently discard a row somebody else added
 * while the dialog was open — and for a compliance cascade, "silently
 * discarded" means a reminder that everyone believes is set and that never
 * fires. One row, one write.
 */

import { and, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { reminderRules } from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { databaseSafeFailure } from "../../lib/database-failure";
import {
  createReminder,
  deleteReminder,
  listReminders,
  replaceRecipients,
  updateReminder,
} from "../../lib/reminders/repository";
import { validateRecipientRows } from "../../lib/reminders/recipients";
import { reminderOccurrenceUtc } from "../../lib/reminders/schedule";

export const dynamic = "force-dynamic";

/*
 * `board.edit` — the same capability the calendar itself writes under.
 *
 * Deliberately not `settings.edit`: a reminder is a property of one record, set
 * by whoever is allowed to edit that record. `settings.edit` guards the GLOBAL
 * defaults, which is a different act with a different blast radius — editing
 * them changes what every future certificate is created with.
 */
const WRITE_CAPABILITY = "board.edit" as const;

const SUBJECT_TYPES = new Set(["certificate", "visit", "job", "note"]);
const UNITS = new Set(["day", "week", "month"]);
const DIRECTIONS = new Set(["before", "after", "on"]);

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** `HH:MM`, 00:00–23:59. Anything else falls back to the documented default. */
function clockTime(value: unknown): string {
  const raw = text(value, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : "08:00";
}

function isoDate(value: unknown): string | null {
  const raw = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

type RecipientInput = { userId?: string | null; email?: string | null; groupKey?: string | null };

function readRecipients(value: unknown): RecipientInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      userId: typeof entry.userId === "string" ? entry.userId : null,
      email: typeof entry.email === "string" ? entry.email.trim() : null,
      groupKey: typeof entry.groupKey === "string" ? entry.groupKey : null,
    }))
    .filter((entry) => entry.userId || entry.email || entry.groupKey);
}

/**
 * The next moment this row should fire, or null when it cannot fire.
 *
 * Null for a date already past — the specification is explicit that such a row
 * shows a warning and is NEVER sent — and null when there is no anchor at all,
 * which is the ordinary state of a reminder on a record whose date has not been
 * chosen yet. Null keeps it out of `listDueReminders` without deleting it.
 */
function computeNextSendAt(
  anchor: string | null,
  offsetValue: number,
  offsetUnit: string,
  offsetDirection: string,
  sendTime: string,
  timezone: string,
  now: Date,
): string | null {
  if (!anchor) return null;
  const at = reminderOccurrenceUtc(
    anchor,
    { value: offsetValue, unit: offsetUnit as "day" | "week" | "month", direction: offsetDirection as "before" | "after" | "on" },
    sendTime,
    timezone,
  );
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  if (at.getTime() <= now.getTime()) return null;
  return at.toISOString();
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const subjectType = text(url.searchParams.get("subjectType"), 40);
    const subjectId = text(url.searchParams.get("subjectId"), 120);
    if (!SUBJECT_TYPES.has(subjectType) || !subjectId) {
      return Response.json(
        { error: "Name the record these reminders belong to." },
        { status: 400 },
      );
    }
    const reminders = await listReminders(db, orgId, subjectType, subjectId);
    return Response.json({ reminders });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const { status, message } = databaseSafeFailure(error, "The reminders could not be read.");
    return Response.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return Response.json({ error: "Send a JSON body." }, { status: 400 });

    const subjectType = text(body.subjectType, 40);
    const subjectId = text(body.subjectId, 120);
    if (!SUBJECT_TYPES.has(subjectType) || !subjectId) {
      return Response.json({ error: "Name the record this reminder belongs to." }, { status: 400 });
    }

    const recipients = readRecipients(body.recipients);
    /*
     * A malformed address blocks the save, which the specification asks for
     * explicitly. An EMPTY dynamic group does not: "renewal owner" with nobody
     * in the role is a configuration to fix, not a reason to refuse the row —
     * and refusing would stop somebody setting a cascade up before the owner is
     * appointed.
     */
    const check = validateRecipientRows(recipients as never);
    if (!check.ok) {
      const first = check.invalid[0];
      return Response.json({ error: `${first.value}: ${first.reason}` }, { status: 400 });
    }

    const offsetUnit = UNITS.has(text(body.offsetUnit, 10)) ? text(body.offsetUnit, 10) : "day";
    const offsetDirection = DIRECTIONS.has(text(body.offsetDirection, 10))
      ? text(body.offsetDirection, 10)
      : "before";
    const offsetValue = Number.isFinite(Number(body.offsetValue))
      ? Math.max(0, Math.trunc(Number(body.offsetValue)))
      : 0;
    const sendTime = clockTime(body.sendTime);
    const timezone = text(body.timezone, 60) || "Europe/London";
    const anchor = isoDate(body.anchorDate);

    const id = await createReminder(
      db,
      orgId,
      {
        subjectType,
        subjectId,
        stepKey: text(body.stepKey, 40) || null,
        isEnabled: body.isEnabled !== false,
        offsetValue,
        offsetUnit,
        offsetDirection,
        sendTime,
        timezone,
        repeatEnabled: body.repeatEnabled === true,
        repeatIntervalDays: Math.max(1, Math.trunc(Number(body.repeatIntervalDays ?? 3)) || 3),
        repeatCap: Math.max(1, Math.trunc(Number(body.repeatCap ?? 10)) || 10),
        customMessage: text(body.customMessage, 2000) || null,
        channel: "email",
        nextSendAt: computeNextSendAt(
          anchor,
          offsetValue,
          offsetUnit,
          offsetDirection,
          sendTime,
          timezone,
          new Date(),
        ),
        recipients,
      },
      actor.email || null,
    );

    const reminders = await listReminders(db, orgId, subjectType, subjectId);
    return Response.json({ ok: true, id, reminders });
  } catch (error) {
    const { status, message } = databaseSafeFailure(error, "The reminder could not be saved.");
    return Response.json({ error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = text(body?.id, 120);
    if (!body || !id) return Response.json({ error: "Name the reminder." }, { status: 400 });

    const [existing] = await db
      .select()
      .from(reminderRules)
      .where(
        and(
          eq(reminderRules.id, id),
          eq(reminderRules.organisationId, orgId),
          isNull(reminderRules.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return Response.json({ error: "That reminder no longer exists." }, { status: 404 });

    /*
     * OMITTED IS NOT CLEARED. `undefined` leaves a field alone and an explicit
     * value replaces it — the convention the calendar route states at length,
     * kept here so a client sending only `isEnabled` cannot erase a custom
     * message somebody typed.
     */
    const patch: Record<string, unknown> = {};
    if ("isEnabled" in body) patch.isEnabled = body.isEnabled !== false;
    if ("offsetValue" in body) patch.offsetValue = Math.max(0, Math.trunc(Number(body.offsetValue)) || 0);
    if ("offsetUnit" in body && UNITS.has(text(body.offsetUnit, 10))) patch.offsetUnit = text(body.offsetUnit, 10);
    if ("offsetDirection" in body && DIRECTIONS.has(text(body.offsetDirection, 10))) {
      patch.offsetDirection = text(body.offsetDirection, 10);
    }
    if ("sendTime" in body) patch.sendTime = clockTime(body.sendTime);
    if ("repeatEnabled" in body) patch.repeatEnabled = body.repeatEnabled === true;
    if ("repeatIntervalDays" in body) {
      patch.repeatIntervalDays = Math.max(1, Math.trunc(Number(body.repeatIntervalDays)) || 3);
    }
    if ("customMessage" in body) patch.customMessage = text(body.customMessage, 2000) || null;

    const anchor = isoDate(body.anchorDate);
    if (anchor) {
      patch.nextSendAt = computeNextSendAt(
        anchor,
        Number(patch.offsetValue ?? existing.offsetValue),
        String(patch.offsetUnit ?? existing.offsetUnit),
        String(patch.offsetDirection ?? existing.offsetDirection),
        String(patch.sendTime ?? existing.sendTime),
        String(existing.timezone),
        new Date(),
      );
      /*
       * A row whose recalculated date is in the future is pending again, even
       * if it had finished. Moving a certificate's expiry forward has to bring
       * its cascade back with it, or the reminders quietly stay spent.
       */
      if (patch.nextSendAt && existing.status === "sent") patch.status = "pending";
    }

    await updateReminder(db, orgId, id, patch);
    if (Array.isArray(body.recipients)) {
      const recipients = readRecipients(body.recipients);
      const check = validateRecipientRows(recipients as never);
      if (!check.ok) {
        const first = check.invalid[0];
        return Response.json({ error: `${first.value}: ${first.reason}` }, { status: 400 });
      }
      await replaceRecipients(db, orgId, id, recipients);
    }

    const reminders = await listReminders(db, orgId, existing.subjectType, existing.subjectId);
    return Response.json({ ok: true, reminders });
  } catch (error) {
    const { status, message } = databaseSafeFailure(error, "The reminder could not be updated.");
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 120);
    if (!id) return Response.json({ error: "Name the reminder." }, { status: 400 });

    const [existing] = await db
      .select()
      .from(reminderRules)
      .where(and(eq(reminderRules.id, id), eq(reminderRules.organisationId, orgId)))
      .limit(1);
    if (!existing) return Response.json({ error: "That reminder no longer exists." }, { status: 404 });

    await deleteReminder(db, orgId, id);
    const reminders = await listReminders(db, orgId, existing.subjectType, existing.subjectId);
    return Response.json({ ok: true, reminders });
  } catch (error) {
    const { status, message } = databaseSafeFailure(error, "The reminder could not be removed.");
    return Response.json({ error: message }, { status });
  }
}
