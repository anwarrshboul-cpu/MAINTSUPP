"use client";

/**
 * THE REMINDER ROWS AND THE PREVIEW PANEL — §7 of the calendar/reminder brief.
 *
 * A reminder in this product is not a date. It is an OFFSET from the record's
 * own anchor — a certificate's expiry, a visit's start — plus a send time, a
 * zone, a recipient set and a repeat rule. Storing the offset rather than the
 * date is what makes "the expiry moved to March" a one-field edit instead of
 * six, and it is why §7.4 can promise that changing the expiry recalculates
 * every pending reminder.
 *
 * The cost of storing an offset is that NOBODY CAN SEE WHEN ANYTHING WILL
 * ACTUALLY HAPPEN. "90 days before, 08:00, Europe/London" is not a date, and a
 * reader cannot tell from it that the step is already in the past because the
 * certificate they are recording expired last month. §7.4 calls the preview
 * panel "the single best defence against silent misconfiguration" and it is
 * right: the panel is not decoration beside these rows, it is the thing that
 * makes the rows legible. So it is rendered above them, not below, and it is
 * never collapsed by default.
 *
 * ── NOTHING HERE COMPUTES A DATE ────────────────────────────────────────────
 *
 * Every instant on this screen comes from `reminderOccurrenceUtc` and every
 * warning from `previewCascade`, both in `app/lib/reminders/`. That is a hard
 * rule rather than a preference: the send path selects on `next_send_at`
 * written by the same functions, so a screen that did its own arithmetic would
 * be able to promise a send at 08:00 that the cron makes at 09:00 across the
 * October clock change. One implementation of "when", used by both.
 *
 * ── WHY THE DEFAULT LADDER IS ALSO WRITTEN HERE ─────────────────────────────
 *
 * `reminder_defaults` is the authority and `/api/reminders` reads it. But a NEW
 * record has no id, so there is nothing to GET reminders for, and §14 still
 * requires a new certificate to arrive carrying its six steps — visible and
 * editable BEFORE the first save, because the preview panel is worthless if it
 * only appears after the mistake has been committed. `REMINDER_DEFAULT_LADDER`
 * is that seed. It mirrors `REMINDER_DEFAULTS_SEED` in `db/init.ts`, and
 * `tests/pre-w14-reminder-ui.test.mjs` pins the two together so the copy cannot
 * drift — this repository has already had the bug where a screen kept its own
 * copy of a number the policy owned, and a checked mirror is the only version
 * of that duplication that stays honest.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Icon } from "../../components";
import { formatLongDate } from "../../lib/format-date";
import {
  PAST_REMINDER_WARNING,
  cascadeFromDefaults,
  describeOffset,
  previewCascade,
  type PreviewInputRow,
  type ReminderDefaultRow,
} from "../../lib/reminders/cascade";
import {
  DEFAULT_REPEAT_CAP,
  DEFAULT_REPEAT_INTERVAL_DAYS,
  DEFAULT_SEND_TIME,
  DEFAULT_TIMEZONE,
  normaliseClockTime,
  reminderOccurrenceUtc,
  type OffsetDirection,
  type OffsetUnit,
} from "../../lib/reminders/schedule";
import { RecipientPicker, recipientProblem, type RecipientDraft } from "./recipient-picker";
import type { CalendarItemTypeKey } from "./calendar-item-types";
import "./reminder-rows.css";

/** `reminder_rules.subject_type` — the four the route accepts. */
export type ReminderScope = "certificate" | "visit" | "job" | "note";

/** One editable row. `id` is null until it has been written. */
export type ReminderDraft = {
  /** React identity, stable across every edit including the first save. A row
      keyed by array index loses its recipient picker's open state the moment
      an earlier row is deleted. */
  key: string;
  id: string | null;
  stepKey: string;
  isEnabled: boolean;
  offsetValue: number;
  offsetUnit: OffsetUnit;
  offsetDirection: OffsetDirection;
  sendTime: string;
  timezone: string;
  repeatEnabled: boolean;
  repeatIntervalDays: number;
  repeatCap: number;
  customMessage: string;
  status: string;
  recipients: RecipientDraft[];
};

/**
 * The seed ladder, mirroring `REMINDER_DEFAULTS_SEED` in `db/init.ts`.
 *
 * Shaped as `ReminderDefaultRow` so it goes through `cascadeFromDefaults`
 * exactly as the stored rows do — the offsets, the group keys and the repeat
 * rules are read by one function whether they came from here or from the
 * database, so a new record and an imported one cannot end up with different
 * ladders. See the file header for why the copy exists at all.
 */
export const REMINDER_DEFAULT_LADDER: Record<ReminderScope, readonly ReminderDefaultRow[]> = {
  certificate: [
    { step_key: "d90", step_order: 0, offset_value: 90, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["renewal-owner"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "d60", step_order: 1, offset_value: 60, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["renewal-owner", "internal-team"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "d30", step_order: 2, offset_value: 30, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["renewal-owner", "internal-team", "client-contact"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "d14", step_order: 3, offset_value: 14, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["renewal-owner", "internal-team", "client-contact", "escalation-contact"], repeat_enabled: 1, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "expiry", step_order: 4, offset_value: 0, offset_unit: "day", offset_direction: "on", send_time: "08:00", recipient_groups_json: ["renewal-owner", "internal-team", "client-contact", "escalation-contact"], repeat_enabled: 1, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "overdue", step_order: 5, offset_value: 7, offset_unit: "day", offset_direction: "after", send_time: "08:00", recipient_groups_json: ["renewal-owner", "internal-team", "client-contact", "escalation-contact"], repeat_enabled: 1, repeat_interval_days: 7, repeat_cap: 8 },
  ],
  /* §4's default: "one reminder 24 hours before start at 08:00". */
  visit: [
    { step_key: "day-before", step_order: 0, offset_value: 1, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["assigned-engineer", "site-contact"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
  ],
  /*
   * Jobs are not created by this dialog — `reminderScopeFor` never returns
   * "job" — but the ladder is mirrored in full anyway, because the mirror test
   * compares scope for scope against `db/init.ts` and a partial copy is a copy
   * that has already started to drift. It also means the same editor can be
   * pointed at a job's reminders without a second seed being invented.
   */
  job: [
    { step_key: "day-before", step_order: 0, offset_value: 1, offset_unit: "day", offset_direction: "before", send_time: "08:00", recipient_groups_json: ["assigned-engineer", "site-contact"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "unassigned", step_order: 1, offset_value: 1, offset_unit: "day", offset_direction: "after", send_time: "08:00", recipient_groups_json: ["all-admins"], repeat_enabled: 0, repeat_interval_days: 3, repeat_cap: 10 },
    { step_key: "stale", step_order: 2, offset_value: 14, offset_unit: "day", offset_direction: "after", send_time: "08:00", recipient_groups_json: ["job-owner"], repeat_enabled: 1, repeat_interval_days: 7, repeat_cap: 8 },
  ],
  /* §3: a note's reminders are "optional, none by default". An empty list is
     the correct default, not an oversight — a memo that nags is a memo people
     stop writing. */
  note: [],
};

/** The `subject_type` a calendar item of this kind writes its reminders under. */
export function reminderScopeFor(category: CalendarItemTypeKey): ReminderScope {
  if (category === "Certificate") return "certificate";
  if (category === "Planned visit") return "visit";
  return "note";
}

let draftCounter = 0;
function newDraftKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

/** The rows a record of this kind starts life with. */
export function defaultReminderDrafts(scope: ReminderScope, anchorDate: string): ReminderDraft[] {
  return cascadeFromDefaults(REMINDER_DEFAULT_LADDER[scope], anchorDate, DEFAULT_TIMEZONE).map(
    (row) => ({
      key: newDraftKey(),
      id: null,
      stepKey: row.stepKey,
      isEnabled: row.isEnabled,
      offsetValue: row.offsetValue,
      offsetUnit: row.offsetUnit,
      offsetDirection: row.offsetDirection,
      sendTime: row.sendTime,
      timezone: row.timezone,
      repeatEnabled: row.repeatEnabled,
      repeatIntervalDays: row.repeatIntervalDays,
      repeatCap: row.repeatCap,
      customMessage: "",
      status: "pending",
      recipients: row.recipientGroups.map((groupKey) => ({
        userId: null,
        email: null,
        groupKey,
      })),
    }),
  );
}

/** A blank row, for the "Add a reminder" button. */
export function blankReminderDraft(): ReminderDraft {
  return {
    key: newDraftKey(),
    id: null,
    stepKey: "",
    isEnabled: true,
    offsetValue: 7,
    offsetUnit: "day",
    offsetDirection: "before",
    sendTime: DEFAULT_SEND_TIME,
    timezone: DEFAULT_TIMEZONE,
    repeatEnabled: false,
    repeatIntervalDays: DEFAULT_REPEAT_INTERVAL_DAYS,
    repeatCap: DEFAULT_REPEAT_CAP,
    customMessage: "",
    status: "pending",
    recipients: [],
  };
}

const UNITS: readonly OffsetUnit[] = ["day", "week", "month"];
const DIRECTIONS: readonly OffsetDirection[] = ["before", "after", "on"];

/** One `/api/reminders` row, defensively — it is a network payload. */
function draftFromApi(row: unknown): ReminderDraft | null {
  if (!row || typeof row !== "object") return null;
  const entry = row as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : null;
  if (!id) return null;
  const unit = String(entry.offsetUnit ?? "day");
  const direction = String(entry.offsetDirection ?? "before");
  const recipients = Array.isArray(entry.recipients) ? entry.recipients : [];
  return {
    key: `saved-${id}`,
    id,
    stepKey: typeof entry.stepKey === "string" ? entry.stepKey : "",
    isEnabled: entry.isEnabled !== false,
    offsetValue: Number.isFinite(Number(entry.offsetValue)) ? Number(entry.offsetValue) : 0,
    offsetUnit: (UNITS as readonly string[]).includes(unit) ? (unit as OffsetUnit) : "day",
    offsetDirection: (DIRECTIONS as readonly string[]).includes(direction)
      ? (direction as OffsetDirection)
      : "before",
    sendTime: normaliseClockTime(entry.sendTime),
    timezone: typeof entry.timezone === "string" && entry.timezone ? entry.timezone : DEFAULT_TIMEZONE,
    repeatEnabled: entry.repeatEnabled === true,
    repeatIntervalDays: Math.max(1, Math.trunc(Number(entry.repeatIntervalDays)) || DEFAULT_REPEAT_INTERVAL_DAYS),
    repeatCap: Math.max(1, Math.trunc(Number(entry.repeatCap)) || DEFAULT_REPEAT_CAP),
    customMessage: typeof entry.customMessage === "string" ? entry.customMessage : "",
    status: typeof entry.status === "string" ? entry.status : "pending",
    recipients: recipients
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        userId: typeof item.userId === "string" ? item.userId : null,
        email: typeof item.email === "string" ? item.email : null,
        groupKey: typeof item.groupKey === "string" ? item.groupKey : null,
      }))
      .filter((item) => item.userId || item.email || item.groupKey),
  };
}

/**
 * The rows for one record: read from the route when it has an id, seeded from
 * the ladder when it does not.
 *
 * A saved record that holds ZERO rows is also seeded. That is the certificate
 * created before this feature existed, and offering it an empty list would
 * quietly leave the estate's oldest compliance records — the ones most likely
 * to be expiring — with no cascade at all. Seeding is visible, editable and
 * deletable; an empty list is a silence.
 */
export function useReminderDrafts(options: {
  scope: ReminderScope;
  subjectId: string | null;
  anchorDate: string;
  enabled: boolean;
}): {
  rows: ReminderDraft[];
  setRows: Dispatch<SetStateAction<ReminderDraft[]>>;
  baseline: ReminderDraft[];
  loading: boolean;
  error: string | null;
} {
  const { scope, subjectId, anchorDate, enabled } = options;
  const [rows, setRows] = useState<ReminderDraft[]>([]);
  const [baseline, setBaseline] = useState<ReminderDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * One initialisation per record, tracked by identity rather than by "rows is
   * empty". Re-seeding on an empty list would make the last delete undoable —
   * remove the sixth row and six come straight back.
   */
  const initialisedFor = useRef<string | null>(null);
  /*
   * The anchor is read at LOAD time only, so it is held in a ref rather than
   * being a dependency: re-running the load every time somebody types in the
   * date field would throw away their unsaved edits to the rows.
   *
   * The ref is synced in an effect and never during render. Writing
   * `ref.current` while rendering is a side effect in a function React may
   * call twice — the defect `react-hooks/refs` reports, and one this
   * repository has already had to go back and fix. This effect is declared
   * ABOVE the load effect so it has run before the load reads the ref.
   */
  const anchorRef = useRef(anchorDate);
  useEffect(() => {
    anchorRef.current = anchorDate;
  }, [anchorDate]);

  useEffect(() => {
    if (!enabled) return;
    const identity = `${scope}:${subjectId ?? "new"}`;
    if (initialisedFor.current === identity) return;
    initialisedFor.current = identity;

    if (!subjectId) {
      setRows(defaultReminderDrafts(scope, anchorRef.current));
      setBaseline([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/reminders?subjectType=${encodeURIComponent(scope)}&subjectId=${encodeURIComponent(subjectId)}`,
          { headers: { Accept: "application/json" } },
        );
        const payload = (await response.json().catch(() => null)) as
          | { reminders?: unknown; error?: string }
          | null;
        if (!response.ok) throw new Error(payload?.error || "The reminders could not be read.");
        if (cancelled) return;
        const loaded = (Array.isArray(payload?.reminders) ? payload.reminders : [])
          .map(draftFromApi)
          .filter((row): row is ReminderDraft => row !== null);
        setBaseline(loaded);
        setRows(loaded.length ? loaded : defaultReminderDrafts(scope, anchorRef.current));
      } catch (caught) {
        if (cancelled) return;
        /* NO SEED AFTER A FAILED READ. The record may well hold six rows
           this fetch simply could not see, and offering the ladder here would
           invite somebody to re-create every one of them — a duplicate
           cascade sends every reminder twice. The error says what happened
           and `initialisedFor` is cleared so a retry is possible. */
        setError(caught instanceof Error ? caught.message : "The reminders could not be read.");
        setRows([]);
        setBaseline([]);
        initialisedFor.current = null;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, scope, subjectId]);

  return { rows, setRows, baseline, loading, error };
}

/**
 * The sentence that BLOCKS THE SAVE, or null.
 *
 * §6 requires a malformed address to stop the write, and it stops it here as
 * well as at the route — the route still checks, because a browser is not a
 * validator, but a round trip to be told about a typo is a round trip.
 */
export function reminderDraftsProblem(rows: readonly ReminderDraft[]): string | null {
  for (const row of rows) {
    const problem = recipientProblem(row.recipients);
    if (problem) return `${row.stepKey || describeOffset(offsetOf(row))}: ${problem}`;
  }
  return null;
}

function offsetOf(row: {
  offsetValue: number;
  offsetUnit: OffsetUnit;
  offsetDirection: OffsetDirection;
}) {
  return { value: row.offsetValue, unit: row.offsetUnit, direction: row.offsetDirection };
}

/** Everything the route writes, so two rows can be compared before a PATCH. */
function writeSignature(row: ReminderDraft): string {
  return JSON.stringify([
    row.stepKey,
    row.isEnabled,
    row.offsetValue,
    row.offsetUnit,
    row.offsetDirection,
    row.sendTime,
    row.repeatEnabled,
    row.repeatIntervalDays,
    row.customMessage,
    row.recipients.map((entry) => [entry.userId, entry.email, entry.groupKey]),
  ]);
}

function recipientPayload(row: ReminderDraft) {
  return row.recipients.map((entry) => ({
    userId: entry.userId,
    email: entry.email,
    groupKey: entry.groupKey,
  }));
}

async function reminderRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? { Accept: "application/json" } : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { error: raw.slice(0, 200) };
  }
  if (!response.ok) {
    throw new Error(
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : "That reminder could not be saved.",
    );
  }
  return parsed;
}

/**
 * Write the rows back: one request per changed row, and none for a row nobody
 * touched.
 *
 * The route has no "replace the whole list" verb, and its own note says why —
 * a bulk replace silently discards a row somebody else added while this dialog
 * was open, and for a compliance cascade "silently discarded" means a reminder
 * everybody believes is set and that never fires. So this diffs.
 *
 * Deletes run FIRST. A reader who deleted the 30-day step and added a 45-day
 * one in its place should not be able to hit a uniqueness or ordering surprise
 * because the addition landed while the removal was still in flight.
 */
export async function persistReminderDrafts(options: {
  scope: ReminderScope;
  subjectId: string;
  anchorDate: string;
  rows: readonly ReminderDraft[];
  baseline: readonly ReminderDraft[];
}): Promise<void> {
  const { scope, subjectId, anchorDate, rows, baseline } = options;
  const kept = new Set(rows.map((row) => row.id).filter(Boolean));

  for (const row of baseline) {
    if (row.id && !kept.has(row.id)) {
      await reminderRequest("DELETE", `/api/reminders?id=${encodeURIComponent(row.id)}`);
    }
  }

  const before = new Map(baseline.filter((row) => row.id).map((row) => [row.id, row]));
  for (const row of rows) {
    const body = {
      subjectType: scope,
      subjectId,
      anchorDate,
      stepKey: row.stepKey || describeOffset(offsetOf(row)),
      isEnabled: row.isEnabled,
      offsetValue: row.offsetValue,
      offsetUnit: row.offsetUnit,
      offsetDirection: row.offsetDirection,
      sendTime: row.sendTime,
      timezone: row.timezone,
      repeatEnabled: row.repeatEnabled,
      repeatIntervalDays: row.repeatIntervalDays,
      repeatCap: row.repeatCap,
      customMessage: row.customMessage,
      recipients: recipientPayload(row),
    };
    if (!row.id) {
      await reminderRequest("POST", "/api/reminders", body);
      continue;
    }
    const previous = before.get(row.id);
    /*
     * The anchor is sent on EVERY patch of a surviving row, even one whose own
     * fields are unchanged, because the expiry date may have moved in the same
     * edit and `next_send_at` is derived from it. Skipping the unchanged rows
     * here is what would leave half a cascade pointing at last year's date.
     */
    if (previous && writeSignature(previous) === writeSignature(row) && previous.timezone === row.timezone) {
      await reminderRequest("PATCH", "/api/reminders", { id: row.id, anchorDate });
      continue;
    }
    await reminderRequest("PATCH", "/api/reminders", { id: row.id, ...body });
  }
}

/* ────────────────────────────────────────────────────────────── the UI ── */

/**
 * The quarter-hour ladder, for the send-time field's suggestion list.
 *
 * §7.1 asks for "15-minute steps" AND "free entry of any time permitted",
 * which are only both true if the quarter hours are SUGGESTED rather than
 * enforced. A datalist does exactly that: one click for 08:15, and 08:07 is
 * still typeable. `step` is left at a minute so the browser never marks a
 * legitimate time invalid.
 */
function quarterHours(): string[] {
  const times: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    times.push(
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    );
  }
  return times;
}
const QUARTER_HOURS = quarterHours();

export function ReminderRows({
  scope,
  anchorDate,
  rows,
  onChange,
  disabled = false,
  loading = false,
  loadError = null,
  recordTitle,
  siteName,
}: {
  scope: ReminderScope;
  /** The record's own date. Every row is an offset from this. */
  anchorDate: string;
  rows: readonly ReminderDraft[];
  onChange: (next: ReminderDraft[]) => void;
  disabled?: boolean;
  loading?: boolean;
  loadError?: string | null;
  recordTitle: string;
  siteName: string | null;
}) {
  const timesId = useId();
  /*
   * WHERE FOCUS GOES WHEN A ROW IS DELETED.
   *
   * The delete button unmounts itself. Left alone, focus falls to
   * `document.body` — outside the dialog's scrim, which is where its Escape
   * handler lives — and the whole modal becomes uncloseable from a keyboard
   * until something inside it is clicked. That is the exact defect the focus
   * effect in `manual-event-dialog.tsx` carries a paragraph about, measured
   * again here in a browser after deleting a default step. The Add button is
   * the right catch: it survives the deletion and it is the next thing
   * somebody removing rows is likely to want.
   */
  const addRowRef = useRef<HTMLButtonElement | null>(null);

  const update = useCallback(
    (key: string, patch: Partial<ReminderDraft>) => {
      onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    },
    [onChange, rows],
  );

  return (
    <section className="reminder-rows" aria-label="Reminders">
      <datalist id={timesId}>
        {QUARTER_HOURS.map((time) => (
          <option key={time} value={time} />
        ))}
      </datalist>

      <ReminderPreview
        rows={rows}
        anchorDate={anchorDate}
        scope={scope}
        recordTitle={recordTitle}
        siteName={siteName}
        disabled={disabled}
      />

      <div className="reminder-rows__head">
        <h3>Reminders</h3>
        <p>
          Each one is an offset from this record&rsquo;s date, so moving the date moves them all.
        </p>
      </div>

      {loadError ? (
        <p className="reminder-rows__error" role="alert">
          <Icon name="alert" size={14} />
          <span>{loadError}</span>
        </p>
      ) : null}
      {loading ? <p className="reminder-rows__note">Reading this record&rsquo;s reminders…</p> : null}

      <ul className="reminder-rows__list">
        {rows.map((row) => (
          <li key={row.key} className={`reminder-row${row.isEnabled ? "" : " is-off"}`}>
            <div className="reminder-row__bar">
              <button
                type="button"
                role="switch"
                aria-checked={row.isEnabled}
                aria-label={`${row.isEnabled ? "Disable" : "Enable"} the ${row.stepKey || describeOffset(offsetOf(row))} reminder`}
                className="reminder-row__switch"
                disabled={disabled}
                onClick={() => update(row.key, { isEnabled: !row.isEnabled })}
              />
              <span className="reminder-row__name">
                {row.stepKey || describeOffset(offsetOf(row))}
              </span>
              {row.status && row.status !== "pending" ? (
                /* A sent or acknowledged step is not editable away: it is
                   history, and the reader should see why its date is fixed. */
                <span className="reminder-row__status">{row.status}</span>
              ) : null}
              <button
                type="button"
                className="reminder-row__delete"
                /* §7.4: "any row, including defaults, may be deleted". */
                aria-label={`Delete the ${row.stepKey || describeOffset(offsetOf(row))} reminder`}
                disabled={disabled}
                onClick={() => {
                  onChange(rows.filter((entry) => entry.key !== row.key));
                  /* Before the unmount, not after — see `addRowRef`. */
                  addRowRef.current?.focus();
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>

            <div className="reminder-row__grid">
              <label className="reminder-row__field reminder-row__field--offset">
                <span>Send</span>
                <div className="reminder-row__offset">
                  <input
                    type="number"
                    min={0}
                    max={999}
                    inputMode="numeric"
                    aria-label="How long before or after"
                    /* "On the day" has no magnitude, so the number and the
                       unit are switched off rather than left showing a value
                       that no longer means anything. */
                    disabled={disabled || row.offsetDirection === "on"}
                    value={row.offsetDirection === "on" ? "" : row.offsetValue}
                    onChange={(changed) =>
                      update(row.key, {
                        offsetValue: Math.max(0, Math.trunc(Number(changed.target.value) || 0)),
                      })
                    }
                  />
                  <select
                    aria-label="Days, weeks or months"
                    disabled={disabled || row.offsetDirection === "on"}
                    value={row.offsetUnit}
                    onChange={(changed) =>
                      update(row.key, { offsetUnit: changed.target.value as OffsetUnit })
                    }
                  >
                    <option value="day">days</option>
                    <option value="week">weeks</option>
                    <option value="month">months</option>
                  </select>
                  <select
                    aria-label="Before, after, or on the day"
                    disabled={disabled}
                    value={row.offsetDirection}
                    onChange={(changed) =>
                      update(row.key, {
                        offsetDirection: changed.target.value as OffsetDirection,
                      })
                    }
                  >
                    <option value="before">before</option>
                    <option value="after">after</option>
                    <option value="on">on the day</option>
                  </select>
                </div>
              </label>

              <label className="reminder-row__field reminder-row__field--time">
                <span>At</span>
                <div className="reminder-row__time">
                  <input
                    type="time"
                    list={timesId}
                    disabled={disabled}
                    value={row.sendTime}
                    aria-label="Send time"
                    onChange={(changed) => update(row.key, { sendTime: changed.target.value })}
                    /* Normalised on the way out, not on every keystroke: a
                       half-typed "0" must not be rewritten to 00:00 under the
                       reader's cursor. */
                    onBlur={(left) =>
                      update(row.key, { sendTime: normaliseClockTime(left.target.value) })
                    }
                  />
                  {/*
                    §7.1 wants the zone visible beside the time and read-only.
                    An unlabelled 08:00 either side of the October change means
                    two different instants, and this is the label that stops
                    somebody "fixing" a BST reminder by moving it an hour.
                  */}
                  <span className="reminder-row__zone">{row.timezone || DEFAULT_TIMEZONE}</span>
                </div>
              </label>
            </div>

            <div className="reminder-row__field">
              <span className="reminder-row__label">Recipients</span>
              <RecipientPicker
                value={row.recipients}
                disabled={disabled}
                label={`Recipients for the ${row.stepKey || describeOffset(offsetOf(row))} reminder`}
                onChange={(recipients) => update(row.key, { recipients })}
              />
            </div>

            <label className="reminder-row__field">
              <span>Custom message (optional)</span>
              <textarea
                rows={2}
                maxLength={2000}
                disabled={disabled}
                value={row.customMessage}
                placeholder="Added to the bottom of the email."
                onChange={(changed) => update(row.key, { customMessage: changed.target.value })}
              />
            </label>

            <div className="reminder-row__repeat">
              <label className="reminder-row__check">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={row.repeatEnabled}
                  onChange={(changed) => update(row.key, { repeatEnabled: changed.target.checked })}
                />
                <span>Repeat until acknowledged</span>
              </label>
              {row.repeatEnabled ? (
                <span className="reminder-row__interval">
                  every
                  <input
                    type="number"
                    min={1}
                    max={90}
                    inputMode="numeric"
                    aria-label="Repeat interval in days"
                    disabled={disabled}
                    value={row.repeatIntervalDays}
                    onChange={(changed) =>
                      update(row.key, {
                        repeatIntervalDays: Math.max(
                          1,
                          Math.trunc(Number(changed.target.value) || DEFAULT_REPEAT_INTERVAL_DAYS),
                        ),
                      })
                    }
                  />
                  days, stopping after {row.repeatCap} sends
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {!rows.length && !loading ? (
        <p className="reminder-rows__note">
          {scope === "note"
            ? "No reminders. Notes do not chase anybody unless you add one."
            : "No reminders on this record."}
        </p>
      ) : null}

      <button
        type="button"
        ref={addRowRef}
        className="secondary-button reminder-rows__add"
        disabled={disabled}
        onClick={() => onChange([...rows, blankReminderDraft()])}
      >
        <Icon name="plus" size={14} />
        Add a reminder
      </button>
    </section>
  );
}

/**
 * THE PREVIEW PANEL — §7.4.
 *
 * Every date and time every row will fire at, recalculated on each render
 * because the anchor date and the offsets are both live state. It sits ABOVE
 * the rows: a reader who has just typed an expiry date of last March needs to
 * be told before they scroll past six steps, not after.
 *
 * The list is CHRONOLOGICAL, which `previewCascade` does, and which is
 * deliberately not the order the rows are edited in — a custom row added at
 * the bottom may well be the first thing that fires, and a preview that
 * repeated the editing order would hide that.
 */
function ReminderPreview({
  rows,
  anchorDate,
  scope,
  recordTitle,
  siteName,
  disabled,
}: {
  rows: readonly ReminderDraft[];
  anchorDate: string;
  scope: ReminderScope;
  recordTitle: string;
  siteName: string | null;
  disabled: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const entries = useMemo(() => {
    const inputs: PreviewInputRow[] = rows.map((row) => ({
      stepKey: row.stepKey || describeOffset(offsetOf(row)),
      isEnabled: row.isEnabled,
      offsetValue: row.offsetValue,
      offsetUnit: row.offsetUnit,
      offsetDirection: row.offsetDirection,
      sendTime: row.sendTime,
      timezone: row.timezone || DEFAULT_TIMEZONE,
      status: row.status || "pending",
      /* The instant comes from the shared function, never from arithmetic
         here — see the file header. */
      occurrenceUtc: anchorDate
        ? reminderOccurrenceUtc(anchorDate, offsetOf(row), row.sendTime, row.timezone || DEFAULT_TIMEZONE)
        : null,
    }));
    return previewCascade(inputs, DEFAULT_TIMEZONE);
  }, [rows, anchorDate]);

  const sending = entries.filter((entry) => entry.willSend).length;
  const past = entries.filter((entry) => entry.isPast).length;

  const testSend = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/reminders/test-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subjectType: scope,
          title: recordTitle,
          siteName,
          expiryDate: anchorDate || null,
          customMessage: rows.find((row) => row.customMessage.trim())?.customMessage ?? null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; error?: string }
        | null;
      setTestResult(
        payload?.message || payload?.error || "The test could not be sent.",
      );
    } catch (caught) {
      setTestResult(caught instanceof Error ? caught.message : "The test could not be sent.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="reminder-preview">
      <div className="reminder-preview__head">
        <h3>
          <Icon name="clock" size={15} />
          When these will send
        </h3>
        <button
          type="button"
          className="secondary-button reminder-preview__test"
          disabled={disabled || testing}
          /* §7.4: to the logged-in user only, marked [TEST], never logged as a
             real send. All three of those are the route's business — this
             button's whole job is to say who it goes to. */
          title="Sends one [TEST] copy to your own address. Nobody else is written to."
          onClick={() => void testSend()}
        >
          {testing ? "Sending…" : "Test send to me"}
        </button>
      </div>

      {!anchorDate ? (
        <p className="reminder-preview__empty">
          Choose a date above and every reminder&rsquo;s exact send time appears here.
        </p>
      ) : !entries.length ? (
        <p className="reminder-preview__empty">No reminders are set on this record.</p>
      ) : (
        <>
          <p className="reminder-preview__count">
            {sending === 1 ? "1 reminder will send" : `${sending} reminders will send`}
            {past ? `, ${past} already past` : ""}.
          </p>
          <ol className="reminder-preview__list">
            {entries.map((entry, index) => (
              <li
                key={`${entry.stepKey}-${index}`}
                className={`reminder-preview__item${entry.warning ? " is-warned" : ""}${
                  entry.warning === PAST_REMINDER_WARNING ? " is-past" : ""
                }`}
              >
                <span className="reminder-preview__when">
                  {entry.localDate ? formatLongDate(entry.localDate) : "No date"}
                  {entry.localTime ? (
                    <em>
                      {entry.localTime}
                      {entry.zoneLabel ? ` ${entry.zoneLabel}` : ""}
                    </em>
                  ) : null}
                </span>
                <span className="reminder-preview__step">{entry.stepKey}</span>
                {entry.warning ? (
                  <span
                    className={`reminder-preview__warning${entry.warning === PAST_REMINDER_WARNING ? " is-past" : ""}`}
                  >
                    <Icon name="alert" size={13} />
                    {entry.warning}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      )}

      {testResult ? (
        <p className="reminder-preview__result" role="status">
          {testResult}
        </p>
      ) : null}
    </div>
  );
}
