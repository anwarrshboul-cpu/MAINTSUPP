/**
 * W11 — MANUAL CALENDAR ITEMS.
 *
 * "We must also be able to add and adjust additional calendar items manually."
 * This is the whole write path for those items, and the one thing it exists to
 * make impossible is a manual note becoming indistinguishable from a job.
 *
 * ── WHY A TABLE OF ITS OWN, AND NOT A FLAGGED `maintenance_requests` ROW ──
 *
 * A job that is not a job leaks. `maintenance_requests` is counted by the
 * Overview meters, the SLA report, the Fix Tracker, the contractor performance
 * figures, every board view and the CSV export — and every one of those would
 * have to learn about the flag, on the same day, for the counts to stay true.
 * One that did not would report a site visit reminder as an open work order.
 * `db/schema.ts` says the same thing beside `calendarEvents`; this is the route
 * that keeps the promise.
 *
 * The consequence is that this table is invisible to all of that by
 * construction, which is exactly right: a manual item is a note on a calendar,
 * not work anybody is being measured on.
 *
 * ── WHY THE PATH IS UNDER /api/maintenance ───────────────────────────────
 *
 * A manual item is a planning entry on the operations calendar, which is the
 * maintenance surface — `/dashboard/planned` — and this workstream owns
 * `app/api/maintenance/**`. It is deliberately a SUBPATH rather than a verb on
 * `/api/maintenance` itself: that route reads and writes jobs, and adding a
 * `kind` discriminator to it would put the two records back in one endpoint
 * after the schema went to the trouble of separating them.
 *
 * ── ARCHIVE AND REMOVE ARE DIFFERENT VERBS ──────────────────────────────
 *
 * The same pair W07-05 established for documents, for the same reason: an
 * operator who wants a past item off the calendar and an operator who made a
 * mistake want different things, and offering only one makes the other one
 * destructive. `archived` hides it and is one press to undo; `deleted_at` is
 * the soft delete, and it is soft because nothing in this product hard-deletes
 * a row somebody typed.
 *
 * NOT YET IN THE RECYCLE BIN, and that is recorded rather than hidden.
 * `app/lib/recycle-bin.ts` registers an entity per type with its own
 * `sendXToBin` and a branch in `restoreFromBin`, and both are outside this
 * workstream's files. The columns this table carries — `deleted_at`,
 * `deleted_by` — are the ones the bin reads, so the registration is additive
 * when somebody makes it. Until then `PATCH {restore:true}` is the way back and
 * a deleted item is listed by `?deleted=include`, so nothing is unrecoverable.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { calendarEvents } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { databaseSafeFailure } from "../../../lib/database-failure";

/**
 * The capability a manual calendar item is written under.
 *
 * `board.edit`, which is this product's "may change planning data" — the same
 * one the calendar already requires to drag a job's Due Date or a certificate's
 * expiry (`calendarEditCapability`). Deliberately NOT `sites.edit`: an item
 * need not be about a site at all, so gating it on the site register would
 * refuse a perfectly ordinary note to somebody entitled to make one. And
 * deliberately not `data.delete` for the removal either — that capability is
 * the PERMANENT purge, withheld from `admin` on purpose, and this delete is
 * reversible.
 */
const WRITE_CAPABILITY = "board.edit" as const;

/** ISO date, `YYYY-MM-DD`, or "" for anything this route will not accept. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function day(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 10);
  if (!DAY_PATTERN.test(trimmed)) return "";
  /*
   * A SHAPE IS NOT A DATE. "2026-02-31" matches the pattern and is not a day,
   * and a calendar handed one would draw an item on 3 March while the register
   * said February — so the round trip through `Date.UTC` is the check. Parsed
   * in UTC, never in local time: this codebase stores days as days, and
   * `new Date("2026-02-31")` west of Greenwich is a different date again. Same
   * rule as `calendarDay` in `calendar-model.ts`.
   */
  const [year, month, date] = trimmed.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
    ? trimmed
    : "";
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** `#RRGGBB` or null. Anything else is dropped rather than stored and rendered. */
function colour(value: unknown): string | null {
  const raw = text(value, 7);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null;
}

export type ManualCalendarEventPayload = {
  id: string;
  title: string;
  notes: string | null;
  siteId: string | null;
  startsOn: string;
  endsOn: string | null;
  allDay: boolean;
  category: string;
  colour: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
};

function expose(row: typeof calendarEvents.$inferSelect): ManualCalendarEventPayload {
  /*
   * FIELDS NAMED, NEVER SPREAD. `organisationId` and `deletedBy` are on the row
   * and neither belongs in a browser payload — the first is a tenant identifier
   * and the second is somebody's email address attached to an action they took.
   * A spread-and-delete would publish the next column somebody adds.
   */
  return {
    id: row.id,
    title: row.title,
    notes: row.notes ?? null,
    siteId: row.siteId ?? null,
    startsOn: row.startsOn,
    endsOn: row.endsOn ?? null,
    allDay: row.allDay !== false,
    category: row.category,
    colour: row.colour ?? null,
    createdByEmail: row.createdByEmail ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archived: row.archived === true,
    archivedAt: row.archivedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

/**
 * The two dates, validated together.
 *
 * A RANGE THAT ENDS BEFORE IT STARTS IS REFUSED rather than quietly swapped.
 * Swapping is the friendlier-looking answer and it is the wrong one: an
 * operator who typed the dates the wrong way round wants to be told, and a
 * client that sent them the wrong way round has a bug that silently correcting
 * would hide.
 *
 * `endsOn === startsOn` is normalised to NULL, because the column's meaning is
 * "NULL is a single day". Two ways of spelling one-day would be two rows that
 * look different in the database and identical on the screen, and every reader
 * would have to handle both.
 */
function range(startRaw: unknown, endRaw: unknown, fallbackStart?: string) {
  const startsOn = day(startRaw) || fallbackStart || "";
  if (!startsOn) throw new Error("A start date is required, as YYYY-MM-DD.");
  if (endRaw === null || endRaw === undefined || endRaw === "") {
    return { startsOn, endsOn: null };
  }
  const endsOn = day(endRaw);
  if (!endsOn) throw new Error("The end date must be a date, as YYYY-MM-DD.");
  if (endsOn < startsOn) {
    throw new Error("The end date cannot be before the start date.");
  }
  return { startsOn, endsOn: endsOn === startsOn ? null : endsOn };
}


/** Days between two `YYYY-MM-DD` values, in UTC. Negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/** `day` moved by `days`, in UTC, as `YYYY-MM-DD`. */
function shiftDay(dayValue: string, days: number): string {
  return new Date(Date.parse(`${dayValue}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The two dates after an edit, given what the caller actually sent.
 *
 * ── A DRAG IS A MOVE, NOT A NEW START ───────────────────────────────────
 *
 * This is the rule the first version of this route got wrong, and it was found
 * by dragging a real three-day item rather than by reading the code. A drag
 * sends `{ startsOn }` and nothing else — that is all the gesture knows — and
 * validating it against the STORED `endsOn` refused every forward drag of a
 * multi-day item with "The end date cannot be before the start date." Measured:
 * a 15–17 September item dragged to the 22nd came back 400, which reads to an
 * operator as "the calendar is broken" rather than as a rule.
 *
 * A range dragged across a calendar keeps its LENGTH. That is what the gesture
 * means everywhere it exists, so moving the start by n days moves the end by n
 * days too, and a three-day item stays three days long.
 *
 * ── AND RESIZING IS STILL POSSIBLE, BECAUSE IT SENDS BOTH ───────────────
 *
 * Sending both dates says "these are the dates", and they are validated as
 * given. Sending `endsOn` alone keeps the start and changes the end, which is
 * the other half of a resize. So:
 *
 *   { startsOn }            → move, duration preserved
 *   { startsOn, endsOn }    → set both, refused if backwards
 *   { endsOn }              → change the end only
 *   { endsOn: null }        → becomes a single-day item
 *
 * Four spellings, four different intentions, none of them a guess.
 */
function nextRange(
  existing: { startsOn: string; endsOn: string | null },
  data: Record<string, unknown>,
): { startsOn: string; endsOn: string | null } {
  const movingStart = data.startsOn !== undefined;
  const settingEnd = data.endsOn !== undefined;

  if (movingStart && !settingEnd) {
    const startsOn = day(data.startsOn);
    if (!startsOn) throw new Error("A start date is required, as YYYY-MM-DD.");
    if (!existing.endsOn) return { startsOn, endsOn: null };
    return {
      startsOn,
      endsOn: shiftDay(existing.endsOn, daysBetween(existing.startsOn, startsOn)),
    };
  }

  return range(
    movingStart ? data.startsOn : existing.startsOn,
    settingEnd ? data.endsOn : existing.endsOn,
    existing.startsOn,
  );
}

/**
 * An input refusal is a 400 and a sick database is a 503.
 *
 * Told apart by the SHARED classifier rather than by guessing from the words —
 * `databaseSafeFailure` is what `app/lib/database-failure.ts` exists to be, and
 * a second private opinion here is how one route comes to answer 400 for an
 * outage and invite somebody to edit a form that was never wrong.
 */
const failure = (error: unknown, fallback: string) =>
  databaseSafeFailure(error, fallback);

/**
 * The live items of this organisation.
 *
 * `?archived=include` adds archived ones and `?deleted=include` adds
 * soft-deleted ones, both off by default — so the calendar's own read is the
 * plain one and a "show what I removed" view has to ask. Ordered by start day
 * so the calendar's grouping meets them in the order it draws them.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const withArchived = url.searchParams.get("archived") === "include";
    const withDeleted = url.searchParams.get("deleted") === "include";

    const conditions = [eq(calendarEvents.organisationId, orgId)];
    if (!withDeleted) conditions.push(isNull(calendarEvents.deletedAt));
    if (!withArchived) conditions.push(eq(calendarEvents.archived, false));

    const rows = await db
      .select()
      .from(calendarEvents)
      .where(and(...conditions))
      .orderBy(asc(calendarEvents.startsOn), asc(calendarEvents.id));

    return Response.json({ events: rows.map(expose) });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "Calendar items could not be loaded." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    const body = (await request.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const title = text(data.title, 160);
    if (!title) throw new Error("A title is required.");
    const { startsOn, endsOn } = range(data.startsOn, data.endsOn);

    const now = new Date().toISOString();
    const id = `cal-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.insert(calendarEvents).values({
      id,
      organisationId: orgId,
      title,
      notes: text(data.notes, 2000) || null,
      /*
       * The site is stored as sent and is NOT resolved against `sites` here.
       * The column carries no foreign key by this schema's deferred-FK
       * convention, and the calendar renders the name from the site list it
       * already holds — an id that names nothing renders as no site rather than
       * as a wrong one. Validating it would be better; doing it HERE, on a
       * table with no FK, would be one route's opinion rather than a rule.
       */
      siteId: text(data.siteId, 120) || null,
      startsOn,
      endsOn,
      allDay: data.allDay === false ? false : true,
      category: text(data.category, 60) || "Manual",
      colour: colour(data.colour),
      createdByEmail: actor.email || null,
      createdAt: now,
      updatedAt: now,
    });

    const [created] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)))
      .limit(1);
    return Response.json({ ok: true, event: created ? expose(created) : null });
  } catch (error) {
    const { status, message } = failure(error, "The calendar item could not be created.");
    return Response.json({ error: message }, { status });
  }
}

/**
 * Edit, move, archive, unarchive or restore — one row, one write.
 *
 * A MOVE IS AN EDIT OF THE SAME TWO COLUMNS the form writes, which is what
 * makes the drag and the dialog one operation rather than two that can drift:
 * a drag sends `{ startsOn, endsOn }` and the form sends those plus the rest.
 * `calendar-event-drag.ts` and the editor therefore end in the same place.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS UNCHANGED. Sites has been bitten
 * four times by the opposite convention — see the omitted-vs-cleared defect
 * recorded against the site write paths — so `notes: null` CLEARS the note and
 * omitting `notes` leaves it alone, and the two are distinguishable because
 * `undefined` and `null` are different values in the parsed body.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const body = (await request.json()) as {
      id?: string;
      data?: Record<string, unknown>;
      restore?: boolean;
    };
    const id = text(body.id, 120);
    if (!id) throw new Error("A calendar item ID is required.");
    const data = body.data ?? {};

    const [existing] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)))
      .limit(1);
    /*
     * Look first, so a refusal reads as one. Every write below is
     * organisation-scoped, so another tenant's row was never reachable — what
     * would have been wrong is answering `{ ok: true }` to an id that does not
     * exist here, which tells a caller a change happened.
     */
    if (!existing) {
      return Response.json({ error: "Calendar item not found." }, { status: 404 });
    }
    if (existing.deletedAt && body.restore !== true) {
      return Response.json(
        { error: "This calendar item was removed. Restore it before editing." },
        { status: 409 },
      );
    }

    const changes: Partial<typeof calendarEvents.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };

    if (body.restore === true) {
      changes.deletedAt = null;
      changes.deletedBy = null;
    }

    if (data.title !== undefined) {
      const title = text(data.title, 160);
      if (!title) throw new Error("A title is required.");
      changes.title = title;
    }
    if (data.notes !== undefined) changes.notes = text(data.notes, 2000) || null;
    if (data.siteId !== undefined) changes.siteId = text(data.siteId, 120) || null;
    if (data.category !== undefined) {
      changes.category = text(data.category, 60) || "Manual";
    }
    if (data.colour !== undefined) changes.colour = colour(data.colour);
    if (data.allDay !== undefined) changes.allDay = data.allDay !== false;

    /*
     * THE TWO DATES ARE DECIDED TOGETHER, by `nextRange`, which is where the
     * difference between a DRAG and a RESIZE is written down.
     */
    if (data.startsOn !== undefined || data.endsOn !== undefined) {
      const next = nextRange(
        { startsOn: existing.startsOn, endsOn: existing.endsOn ?? null },
        data,
      );
      changes.startsOn = next.startsOn;
      changes.endsOn = next.endsOn;
    }

    if (data.archived !== undefined) {
      const archived = data.archived === true;
      changes.archived = archived;
      /*
       * The stamp travels with the flag, both ways. An `archived_at` left
       * behind by an un-archive is a row that says it was archived and is not,
       * which is the kind of half-state a later report reads as truth.
       */
      changes.archivedAt = archived ? new Date().toISOString() : null;
    }

    await db
      .update(calendarEvents)
      .set(changes)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)));

    const [updated] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)))
      .limit(1);
    return Response.json({ ok: true, event: updated ? expose(updated) : null });
  } catch (error) {
    const { status, message } = failure(error, "The calendar item could not be updated.");
    return Response.json({ error: message }, { status });
  }
}

/**
 * Remove — SOFT, and reversible.
 *
 * Nothing in this product hard-deletes a row somebody typed, and a calendar
 * item is the easiest thing on the screen to delete by accident: it is a small
 * chip, the control is next to the one that opens it, and there is no other
 * copy of what it said. So the row stays, `deleted_at` and `deleted_by` are
 * stamped, every ordinary read drops it, and `PATCH {restore:true}` brings it
 * back with its dates and its note intact.
 *
 * `data.delete` is NOT the capability, deliberately. That one is the permanent
 * purge and is withheld from `admin` on purpose (see `app/lib/permissions.ts`);
 * requiring it here would mean an admin could create a calendar item and never
 * be able to take it off the calendar.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, WRITE_CAPABILITY);
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;

    const url = new URL(request.url);
    let id = text(url.searchParams.get("id"), 120);
    if (!id) {
      /* A body is accepted as well as a query string, because the two other
         soft-delete routes in this codebase take one and a caller should not
         have to remember which. */
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      id = text(body.id, 120);
    }
    if (!id) throw new Error("A calendar item ID is required.");

    const [existing] = await db
      .select({ id: calendarEvents.id, deletedAt: calendarEvents.deletedAt })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "Calendar item not found." }, { status: 404 });
    }
    // Already gone. Idempotent rather than an error: a retried request and a
    // double-click are the same thing to a caller and neither is a mistake.
    if (existing.deletedAt) return Response.json({ ok: true, id });

    await db
      .update(calendarEvents)
      .set({
        deletedAt: new Date().toISOString(),
        deletedBy: actor.email || null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.organisationId, orgId)));

    return Response.json({ ok: true, id });
  } catch (error) {
    const { status, message } = failure(error, "The calendar item could not be removed.");
    return Response.json({ error: message }, { status });
  }
}

/**
 * The capability, exported so a test can assert it rather than restate it.
 *
 * A test that hard-codes "board.edit" passes whatever this route actually
 * requires; one that reads the constant fails when somebody changes it, which
 * is the whole point of pinning a permission.
 */
export const CALENDAR_EVENT_WRITE_CAPABILITY = WRITE_CAPABILITY;
