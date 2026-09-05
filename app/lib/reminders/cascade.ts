/**
 * The LADDER: turning one expiry date into a set of reminder rows, and keeping
 * them honest when that date moves.
 *
 * ── THE DEFAULTS ARE COPIED, NOT REFERENCED ────────────────────────────────
 *
 * §7.2 is unambiguous: "editing the global default never retro-applies to
 * existing records". So `cascadeFromDefaults` produces ROWS — a snapshot the
 * record then owns and the operator may edit, delete or switch off — rather
 * than a view onto `reminder_defaults`. The alternative reads better in the
 * schema and is indefensible in practice: an admin tidying the default ladder
 * would silently rewrite the reminder configuration of every certificate ever
 * created, including ones whose steps somebody deliberately changed.
 *
 * This is also why `recalculateCascade` exists as a separate operation. The
 * rows have a life of their own from the moment they are written, so moving
 * them is a decision with rules, not a recomputation.
 *
 * ── WHAT MOVES WHEN THE EXPIRY DATE MOVES ──────────────────────────────────
 *
 * The acceptance criterion is one sentence — "changing the expiry date
 * recalculates pending reminders and cancels superseded ones; sent reminders
 * are untouched" — and it contains three different behaviours that are easy to
 * collapse into one and wrong when collapsed:
 *
 *   PENDING       recompute from the new anchor. This is the ordinary case and
 *                 the reason the feature exists.
 *   ALREADY SENT  left exactly as they are. An email that has gone cannot be
 *                 un-sent, and a system that rewrote its own record of what it
 *                 sent would destroy the audit trail an auditor is coming for.
 *                 Never re-sent either: the row keeps its `sent` status, so the
 *                 cron does not reconsider it.
 *   SUPERSEDED    a pending row whose NEW date is already in the past is
 *                 cancelled outright. Leaving it pending is the dangerous
 *                 option: the cron selects on `next_send_at <= now`, so a
 *                 certificate whose expiry is pulled forward six months would
 *                 fire its 90-, 60- and 30-day steps within the same hour, and
 *                 the reader would receive three contradictory emails about one
 *                 certificate.
 *
 * ── AND WHAT THE PREVIEW PANEL IS FOR ──────────────────────────────────────
 *
 * §7.4 calls the reminder preview "the single best defence against silent
 * misconfiguration", and it earns that only if it is computed by the same code
 * as the send. `previewCascade` therefore reads the same instants through the
 * same `isPastAndWillNotSend`; a preview that agreed with the operator's
 * expectations rather than with the cron would be worse than no preview.
 *
 * Pure throughout. `now` is a parameter, defaulted for callers who genuinely
 * mean "at this moment" and passed explicitly by anything that needs to be
 * reproducible.
 */

import {
  DEFAULT_REPEAT_CAP,
  DEFAULT_REPEAT_INTERVAL_DAYS,
  DEFAULT_SEND_TIME,
  DEFAULT_TIMEZONE,
  flagIsTrue,
  isPastAndWillNotSend,
  isUsableInstant,
  normaliseClockTime,
  reminderOccurrenceUtc,
  wallClockInZone,
  type ClockTime,
  type IsoDate,
  type OffsetDirection,
  type OffsetUnit,
  type ReminderOffset,
} from "./schedule";
import { normaliseGroupKey, type DynamicGroupKey } from "./recipients";

/** A `reminder_defaults` row, as stored. */
export interface ReminderDefaultRow {
  step_key?: string | null;
  step_order?: number | string | null;
  offset_value?: number | string | null;
  offset_unit?: string | null;
  offset_direction?: string | null;
  send_time?: string | null;
  /** TEXT holding a JSON array; accepted pre-parsed too, because the admin
      route hands over the array it just validated rather than re-stringifying. */
  recipient_groups_json?: string | readonly unknown[] | null;
  repeat_enabled?: unknown;
  repeat_interval_days?: number | string | null;
  repeat_cap?: number | string | null;
  active?: unknown;
}

/** One row as it will be written to `reminder_rules`, with its computed instant. */
export interface CascadeRow {
  stepKey: string;
  stepOrder: number;
  isEnabled: boolean;
  offsetValue: number;
  offsetUnit: OffsetUnit;
  offsetDirection: OffsetDirection;
  sendTime: ClockTime;
  timezone: string;
  repeatEnabled: boolean;
  repeatIntervalDays: number;
  repeatCap: number;
  recipientGroups: DynamicGroupKey[];
  /** Group keys in the default that nothing recognises. Surfaced rather than
      dropped, so a typo in the admin JSON is visible instead of being a step
      that quietly reaches nobody. */
  unknownGroups: string[];
  status: "pending";
  occurrenceUtc: Date | null;
  /** `reminder_rules.next_send_at`, ISO-8601 UTC — the column the cron selects
      on. Null when the anchor or the offset could not produce a date. */
  nextSendAt: string | null;
}

const UNITS: readonly OffsetUnit[] = ["day", "week", "month"];
const DIRECTIONS: readonly OffsetDirection[] = ["before", "after", "on"];

function unitOf(value: unknown): OffsetUnit {
  const text = String(value ?? "").trim().toLowerCase().replace(/s$/, "");
  return (UNITS as readonly string[]).includes(text) ? (text as OffsetUnit) : "day";
}

function directionOf(value: unknown): OffsetDirection {
  const text = String(value ?? "").trim().toLowerCase();
  return (DIRECTIONS as readonly string[]).includes(text)
    ? (text as OffsetDirection)
    : "before";
}

function intOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * `recipient_groups_json`, from either shape, with unknown keys separated out.
 *
 * Malformed JSON yields no groups rather than throwing: this runs on a save
 * path, and a default row somebody hand-edited badly must not take the whole
 * certificate-creation flow down with it.
 */
function readGroups(value: ReminderDefaultRow["recipient_groups_json"]): {
  groups: DynamicGroupKey[];
  unknown: string[];
} {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = [];
    }
  }
  const groups: DynamicGroupKey[] = [];
  const unknown: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const key = normaliseGroupKey(entry);
    if (key) {
      if (!groups.includes(key)) groups.push(key);
    } else if (typeof entry === "string" && entry.trim() && !unknown.includes(entry.trim())) {
      unknown.push(entry.trim());
    }
  }
  return { groups, unknown };
}

/**
 * The rows a new record gets.
 *
 * Ordered by `step_order`, which is the ladder's own order and is what the
 * modal's rows are drawn in — the CHRONOLOGICAL ordering belongs to
 * `previewCascade`, because the two are not the same list once somebody adds a
 * custom step at the bottom that fires first.
 *
 * `active = 0` defaults are skipped. That column is how an admin retires a step
 * without deleting the history of the records that already carry it.
 */
export function cascadeFromDefaults(
  defaults: readonly ReminderDefaultRow[] | null | undefined,
  anchorDate: IsoDate,
  timezone: string = DEFAULT_TIMEZONE,
): CascadeRow[] {
  const zone = timezone || DEFAULT_TIMEZONE;
  const rows: CascadeRow[] = [];

  for (const row of defaults ?? []) {
    if (!row) continue;
    /* Absent means active. A default written before the column existed, or by
       an insert that omitted it, is a step somebody configured — treating a
       missing flag as "retired" would silently empty the ladder. */
    if (row.active !== undefined && row.active !== null && !flagIsTrue(row.active)) continue;

    const offset: ReminderOffset = {
      value: intOr(row.offset_value, 0),
      unit: unitOf(row.offset_unit),
      direction: directionOf(row.offset_direction),
    };
    const sendTime = normaliseClockTime(row.send_time ?? DEFAULT_SEND_TIME);
    const occurrenceUtc = reminderOccurrenceUtc(anchorDate, offset, sendTime, zone);
    const { groups, unknown } = readGroups(row.recipient_groups_json);

    rows.push({
      stepKey: String(row.step_key ?? "").trim() || describeOffset(offset),
      stepOrder: intOr(row.step_order, rows.length),
      isEnabled: true,
      offsetValue: offset.value,
      offsetUnit: offset.unit,
      offsetDirection: offset.direction,
      sendTime,
      timezone: zone,
      repeatEnabled: flagIsTrue(row.repeat_enabled),
      repeatIntervalDays: Math.max(
        1,
        intOr(row.repeat_interval_days, DEFAULT_REPEAT_INTERVAL_DAYS),
      ),
      repeatCap: Math.max(1, intOr(row.repeat_cap, DEFAULT_REPEAT_CAP)),
      recipientGroups: groups,
      unknownGroups: unknown,
      status: "pending",
      occurrenceUtc,
      nextSendAt: occurrenceUtc ? occurrenceUtc.toISOString() : null,
    });
  }

  return rows.sort((a, b) => a.stepOrder - b.stepOrder || a.stepKey.localeCompare(b.stepKey));
}

/* ─────────────────────────────────────────────── the expiry date changed ── */

/** A `reminder_rules` row as it exists on the record today. */
export interface ExistingReminderRow {
  id?: string | null;
  step_key?: string | null;
  is_enabled?: unknown;
  offset_value?: number | string | null;
  offset_unit?: string | null;
  offset_direction?: string | null;
  send_time?: string | null;
  timezone?: string | null;
  sends_count?: number | string | null;
  next_send_at?: string | null;
  status?: string | null;
  acknowledged_at?: string | null;
}

export type CascadeAction = "moved" | "unchanged" | "cancelled" | "untouched";

export interface CascadeDecision {
  id: string | null;
  stepKey: string | null;
  action: CascadeAction;
  /** One sentence, written for the activity log the record keeps. */
  reason: string;
  previousSendAt: string | null;
  nextSendAt: string | null;
  status: string;
  occurrenceUtc: Date | null;
}

export interface RecalculateOptions {
  now?: Date;
  /** Fallback zone for a row whose own `timezone` column is empty. */
  timezone?: string;
}

/**
 * What to do with each existing row now the anchor has moved.
 *
 * Returns DECISIONS rather than rewritten rows. The caller writes
 * `next_send_at` and `status` for the rows that changed and leaves the rest
 * alone, and the `reason` on each decision is the sentence the activity log
 * records — §12.9 wants "who changed the expiry date and when", and what it did
 * to the reminders is the half of that a reader actually needs.
 *
 * A row that has ALREADY SENT AT LEAST ONCE is untouched even when its status
 * still reads `pending`. That is the repeat loop mid-flight: its remaining
 * sends are governed by `repeat_interval_days` from the last send, not by the
 * anchor, and re-anchoring it would either duplicate a chase the reader has
 * already had or silently swallow one they are waiting for.
 */
export function recalculateCascade(
  existingRows: readonly ExistingReminderRow[] | null | undefined,
  newAnchorDate: IsoDate,
  options: RecalculateOptions = {},
): CascadeDecision[] {
  const now = isUsableInstant(options.now) ? options.now : new Date();
  const fallbackZone = options.timezone || DEFAULT_TIMEZONE;
  const decisions: CascadeDecision[] = [];

  for (const row of existingRows ?? []) {
    if (!row) continue;

    const id = typeof row.id === "string" ? row.id : null;
    const stepKey = typeof row.step_key === "string" ? row.step_key : null;
    const previousSendAt = typeof row.next_send_at === "string" ? row.next_send_at : null;
    const status = String(row.status ?? "pending").trim().toLowerCase() || "pending";
    const base = { id, stepKey, previousSendAt };

    if (status !== "pending") {
      decisions.push({
        ...base,
        action: "untouched",
        reason:
          status === "sent" || status === "acknowledged"
            ? "Already sent — a delivered reminder is never re-sent or retracted."
            : `Left as ${status}; only pending reminders are recalculated.`,
        nextSendAt: previousSendAt,
        status,
        occurrenceUtc: null,
      });
      continue;
    }

    if (intOr(row.sends_count, 0) > 0) {
      decisions.push({
        ...base,
        action: "untouched",
        reason:
          "Already sent at least once — its remaining sends belong to the repeat loop, not the anchor.",
        nextSendAt: previousSendAt,
        status,
        occurrenceUtc: null,
      });
      continue;
    }

    const zone = row.timezone || fallbackZone;
    const occurrenceUtc = reminderOccurrenceUtc(
      newAnchorDate,
      {
        value: intOr(row.offset_value, 0),
        unit: unitOf(row.offset_unit),
        direction: directionOf(row.offset_direction),
      },
      normaliseClockTime(row.send_time ?? DEFAULT_SEND_TIME),
      zone,
    );

    if (!occurrenceUtc) {
      /* An anchor that will not parse is a fault in the caller, not a reason to
         throw a record's reminders away. Left exactly as it was, and said so. */
      decisions.push({
        ...base,
        action: "unchanged",
        reason: "The new anchor date could not be read, so nothing was moved.",
        nextSendAt: previousSendAt,
        status,
        occurrenceUtc: null,
      });
      continue;
    }

    const nextSendAt = occurrenceUtc.toISOString();

    if (isPastAndWillNotSend(occurrenceUtc, now)) {
      decisions.push({
        ...base,
        action: "cancelled",
        reason: "Superseded — its recalculated date has already passed, so it will not be sent.",
        nextSendAt,
        status: "cancelled",
        occurrenceUtc,
      });
      continue;
    }

    decisions.push({
      ...base,
      action: nextSendAt === previousSendAt ? "unchanged" : "moved",
      reason:
        nextSendAt === previousSendAt
          ? "The new anchor puts this step on the same date and time."
          : "Recalculated from the new anchor date.",
      nextSendAt,
      status: "pending",
      occurrenceUtc,
    });
  }

  return decisions;
}

/* ──────────────────────────────────────────────────── the preview panel ── */

/**
 * A row the preview can read: either a freshly cascaded one or a stored
 * `reminder_rules` row. Both shapes are accepted because the modal shows the
 * preview before the first save and after every later one, and a preview that
 * only worked on one of the two would be missing at exactly the moment it is
 * most useful.
 *
 * `status` and `timezone` are taken from the stored shape alone. They are the
 * two names the two shapes share, and an intersection would narrow `status` to
 * the literal `"pending"` a fresh cascade carries — which would make handing
 * this a row that has already sent a compile error at every call site.
 */
export type PreviewInputRow = Omit<Partial<CascadeRow>, "status" | "timezone"> &
  ExistingReminderRow;

export interface CascadePreviewEntry {
  stepKey: string;
  /** "90 days before", "On the day", "2 weeks after" — the offset in words. */
  label: string;
  occurrenceUtc: Date | null;
  localDate: IsoDate | null;
  localTime: ClockTime | null;
  /** "BST" / "GMT". Shown beside the time because §7.1 requires the zone to be
      visible — an unlabelled 08:00 either side of October means two things. */
  zoneLabel: string | null;
  isPast: boolean;
  isEnabled: boolean;
  willSend: boolean;
  /** The inline warning, in §7.4's own words, or null when there is none. */
  warning: string | null;
}

/** The sentence §7.4 specifies, kept in one place so the modal and any later
    surface show the reader the same words. */
export const PAST_REMINDER_WARNING = "This date has already passed and won't be sent.";
const UNDATED_REMINDER_WARNING = "This reminder has no calculable date and won't be sent.";
const DISABLED_REMINDER_WARNING = "This step is switched off and won't be sent.";

/** The offset in words, for the preview row and for a step with no key. */
export function describeOffset(offset: ReminderOffset): string {
  if (offset.direction === "on") return "On the day";
  const magnitude = Math.abs(Math.trunc(Number(offset.value) || 0));
  const unit = magnitude === 1 ? offset.unit : `${offset.unit}s`;
  return `${magnitude} ${unit} ${offset.direction}`;
}

function occurrenceOf(row: PreviewInputRow): Date | null {
  if (isUsableInstant(row.occurrenceUtc)) return row.occurrenceUtc;
  const stored = row.nextSendAt ?? row.next_send_at;
  if (typeof stored === "string" && stored.trim()) {
    const parsed = new Date(stored);
    if (isUsableInstant(parsed)) return parsed;
  }
  return null;
}

/**
 * The ordered list the modal renders, chronologically.
 *
 * Undated rows sort LAST rather than first. They are the ones carrying a
 * warning, and burying a real upcoming reminder under a broken one would make
 * the panel harder to read at precisely the moment it is telling you something.
 */
export function previewCascade(
  rows: readonly PreviewInputRow[] | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): CascadePreviewEntry[] {
  const entries: CascadePreviewEntry[] = [];

  for (const row of rows ?? []) {
    if (!row) continue;
    const zone = row.timezone || timezone || DEFAULT_TIMEZONE;
    const occurrenceUtc = occurrenceOf(row);
    const local = occurrenceUtc ? wallClockInZone(occurrenceUtc, zone) : null;

    const offset: ReminderOffset = {
      value: intOr(row.offsetValue ?? row.offset_value, 0),
      unit: unitOf(row.offsetUnit ?? row.offset_unit),
      direction: directionOf(row.offsetDirection ?? row.offset_direction),
    };

    const enabledSource = row.isEnabled ?? row.is_enabled;
    const isEnabled = enabledSource === undefined ? true : flagIsTrue(enabledSource);
    const status = String(row.status ?? "pending").trim().toLowerCase();
    const isPast = isPastAndWillNotSend(occurrenceUtc, now);

    /* Order matters: a step with no date is broken whether or not it is also
       switched off, and "won't be sent" for the wrong stated reason sends the
       reader to fix the wrong field. */
    const warning = !occurrenceUtc
      ? UNDATED_REMINDER_WARNING
      : isPast
        ? PAST_REMINDER_WARNING
        : !isEnabled
          ? DISABLED_REMINDER_WARNING
          : null;

    entries.push({
      stepKey: String(row.stepKey ?? row.step_key ?? "").trim() || describeOffset(offset),
      label: describeOffset(offset),
      occurrenceUtc,
      localDate: local ? local.date : null,
      localTime: local ? local.time : null,
      zoneLabel: local ? local.zoneLabel : null,
      isPast,
      isEnabled,
      willSend: Boolean(occurrenceUtc) && !isPast && isEnabled && status === "pending",
      warning,
    });
  }

  return entries.sort((a, b) => {
    const left = a.occurrenceUtc ? a.occurrenceUtc.getTime() : Number.POSITIVE_INFINITY;
    const right = b.occurrenceUtc ? b.occurrenceUtc.getTime() : Number.POSITIVE_INFINITY;
    return left - right || a.stepKey.localeCompare(b.stepKey);
  });
}
