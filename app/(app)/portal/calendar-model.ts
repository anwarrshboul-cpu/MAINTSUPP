/**
 * The calendar, as maths rather than as a component.
 *
 * WHY THIS FILE EXISTS
 *
 * The portal's Calendar was a React view that did its own date arithmetic with
 * `new Date(value)` and LOCAL getters. Every value this product stores for a
 * day is either a bare `YYYY-MM-DD` or an ISO instant pinned to UTC midnight
 * (see `optionalIsoDate` in app/lib/request-fields.ts), so parsing one and
 * asking it for `getDate()` moves the whole calendar a day earlier for anybody
 * west of Greenwich: a job due on the 1st drew on the 31st, and the month grid
 * that framed it disagreed with the board's own grid two screens away. The rest
 * of the codebase settled that question long ago — `dateOnlyValue` in
 * app/lib/expiry-status.ts normalises the value, `boardCalendarDays` and
 * `todayBoardDate` in board-format.ts do every grid sum through `Date.UTC` —
 * and this module is the calendar joining them rather than inventing a tenth
 * answer.
 *
 * It is pure TypeScript on purpose. No React, no "use client", no clock of its
 * own that a test cannot pin: `today` is passed into `buildCalendarEvents` the
 * same way `expiryStatus` takes it, so one instant classifies a whole month
 * instead of drifting across the loop. That is what lets the day maths, the
 * overdue rule and the write routing be asserted by `node --test` against the
 * shipped source instead of against a re-implementation that could agree with
 * itself while the screen is wrong.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not write anything. `calendarWriteTarget` names the endpoint a given
 * event's date belongs to and `calendarEditCapability` names the permission
 * that endpoint enforces, and the caller performs the request and refreshes.
 * Routing a date edit is a decision about provenance — a certificate expiry
 * derived from the Store Documentation board must go back to the same board
 * cell the board itself writes, or the next read overwrites the edit — and that
 * decision belongs beside the model that knows the provenance, not inside a
 * click handler.
 */

import { formatLongDate, formatMonthYear, formatShortDate } from "../../lib/format-date";
import { dateOnlyValue } from "../../lib/expiry-status";
import type { MaintenanceRequest } from "../../lib/types";
import type { WorkspaceComplianceRecord } from "../../lib/workspace-data";
import { isClosedRequest } from "./dashboard-meters";

/* ── Days ─────────────────────────────────────────────────────────────────── */

/** Always `YYYY-MM-DD`. Never an instant, never a `Date`. */
export type CalendarDay = string;

/**
 * W11 — "manual" IS A THIRD KIND, NOT A FLAG ON ONE OF THE OTHER TWO.
 *
 * The owner asked to add calendar items by hand, and the one thing that must
 * not happen is a manual note reading as a Job. A third entity is what makes
 * that structural rather than a matter of styling: it has its own icon, its own
 * colour, its own entry in the KEY row, its own row in `calendar_events` and its
 * own write path, so there is nowhere for the two to be confused. See the note
 * beside `calendarEvents` in `db/schema.ts` for why it is a table of its own.
 */
export type CalendarEntity = "job" | "compliance" | "manual";

const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/*
 * en-GB weekday names, indexed Monday-first to match the grid.
 *
 * A constant rather than an `Intl` weekday formatter because every other name
 * on this screen comes from app/lib/format-date.ts and that module offers no
 * weekday form. Adding a private `Intl.DateTimeFormat` here is the exact thing
 * that file exists to stop, and the seven English abbreviations are not a
 * locale decision anybody is going to revisit.
 */
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

/** Milliseconds at UTC midnight on a `YYYY-MM-DD`, or NaN when unreadable. */
function dayEpoch(day: CalendarDay): number {
  if (!DAY_PATTERN.test(day)) return Number.NaN;
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

/** The `YYYY-MM-DD` for a UTC instant. UTC fields only — see the header. */
function dayFromEpoch(epoch: number): CalendarDay {
  if (!Number.isFinite(epoch)) return "";
  const when = new Date(epoch);
  return [
    when.getUTCFullYear(),
    pad(when.getUTCMonth() + 1),
    pad(when.getUTCDate()),
  ].join("-");
}

/**
 * The calendar day inside anything this product stores as a date.
 *
 * Delegates to `dateOnlyValue`, which already knows the three shapes a date can
 * arrive in — a bare `YYYY-MM-DD`, a full ISO instant, and the board's
 * serialised date-metadata JSON — and returns "" for everything else. "" means
 * "no day recorded" everywhere below, and a record with no day produces no
 * event rather than an event on some invented day.
 *
 * `2026-08-24T00:00:00.000Z` is `2026-08-24` in every timezone on earth here,
 * because the string is sliced and never handed to a local getter.
 */
export function calendarDay(value: string | null | undefined): CalendarDay {
  return dateOnlyValue(value);
}

/** Today, read from `now`'s UTC calendar fields — matching `todayBoardDate`. */
export function todayCalendarDay(now: Date = new Date()): CalendarDay {
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
  ].join("-");
}

/**
 * `HH:MM` when somebody actually CHOSE a time, "" otherwise — which today is
 * every event this product can produce.
 *
 * NOTHING THIS PRODUCT STORES CARRIES A CHOSEN TIME, AND THE TIMESTAMP IS NOT
 * ONE EITHER.
 *
 * The board's date column can carry a decoration — `{"date":"2026-08-21",
 * "time":"09:15","icon":""}` — and that `time` is the one shape that is a thing
 * a person typed rather than a byproduct. It is parsed here because a raw cell
 * value can reach this function from a board caller, but it does NOT reach the
 * calendar: `readComplianceRegister` puts every Store Documentation cell through
 * `dateOnlyValue` before it becomes `WorkspaceComplianceRecord.expiry`
 * (app/lib/store-documentation-register.ts, `expiry: dateOnlyValue(...) || null`),
 * so the decoration is already flattened to `YYYY-MM-DD` by the time an event is
 * built. Written and re-read on 2026-08-26: a cell set to
 * `{"date":"2027-05-06","time":"09:15","icon":""}` came back from
 * `GET /api/workspace` as the bare string `"2027-05-06"`.
 *
 * So `event.time` is "" for every event this calendar can currently produce, and
 * that is the correct answer rather than a gap to be filled. The parse stays as
 * the honest reading of a value that does carry one, not as a promise that the
 * calendar will ever see it.
 *
 * The clock component of a stored ISO instant is not a chosen time either. Two
 * shapes reach the job date fields and neither is a decision:
 *   - `2026-08-24T00:00:00.000Z` is this product's ENCODING of a date-only
 *     value. `optionalIsoDate` in app/lib/request-fields.ts turns every
 *     `YYYY-MM-DD` the UI sends into precisely that, so reading it as "due at
 *     midnight" would put a time on every date anybody has ever typed.
 *   - `2026-08-25T04:33:26.755Z` is a seeding and import artifact — the instant
 *     a row was created, carried into a date field. Nobody scheduled a job for
 *     04:33, and staging is full of them. Printing that hour beside the job
 *     would be the calendar inventing a commitment out of a row's creation
 *     time, which is worse than showing no time: an operator can act on it.
 *
 * The dev workspace's own job dates make the point: `2026-07-29T16:00:00.000Z`,
 * `2026-07-29T13:30:00.000Z`, `2026-07-30T17:00:00.000Z`. Round hours, and every
 * one of them a seed value rather than an appointment somebody booked.
 *
 * So an instant yields "" whatever its clock says. Callers render `time` when it
 * is non-empty and render NOTHING when it is empty — no "all day" chip, no
 * placeholder — because a marker on every row that says the data is ordinary is
 * not information.
 *
 * Nothing here invents a default hour either. A calendar that shows a job at
 * 09:00 because it had nowhere else to put it is lying about the data.
 */
export function calendarTimeOfDay(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return typeof parsed.time === "string" && TIME_PATTERN.test(parsed.time)
        ? parsed.time
        : "";
    } catch {
      return "";
    }
  }

  // A bare day, and every instant, carry no chosen time. See above.
  return "";
}

/**
 * Whole days from `from` to `to`. Negative when `to` is in the past.
 *
 * Through `dayEpoch`, like every other sum in this file: both operands are UTC
 * midnight, so the division is exact and no clock change can make a difference
 * of one day come out as 0.958333. That matters more here than anywhere else
 * on the calendar — this is the number the 90 / 60 / 30 / 14 expiry bands are
 * cut on, and a fractional day would move every one of those boundaries by
 * one.
 *
 * `NaN` in gives `null` out rather than a number, because "we could not read
 * that date" and "it expires today" must not be the same answer.
 */
export function calendarDaysBetween(
  from: CalendarDay,
  to: CalendarDay,
): number | null {
  const start = dayEpoch(from);
  const end = dayEpoch(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

export function shiftCalendarDay(day: CalendarDay, days: number): CalendarDay {
  const epoch = dayEpoch(day);
  if (!Number.isFinite(epoch)) return "";
  return dayFromEpoch(epoch + days * MS_PER_DAY);
}

/**
 * The same day-of-month `months` away, clamped to the target month's length.
 *
 * Clamped rather than overflowed: stepping back from 31 March must land on 28
 * February, not on 3 March. `Date.UTC(year, month, 0)` is the last day of the
 * target month.
 */
export function shiftCalendarMonth(day: CalendarDay, months: number): CalendarDay {
  if (!DAY_PATTERN.test(day)) return "";
  const [year, month, date] = day.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return dayFromEpoch(
    Date.UTC(year, month - 1 + months, Math.min(date, lastDay)),
  );
}

export function startOfCalendarMonth(day: CalendarDay): CalendarDay {
  if (!DAY_PATTERN.test(day)) return "";
  return `${day.slice(0, 7)}-01`;
}

/**
 * The Monday of the week containing `day`.
 *
 * Monday-first because this is a UK facilities product and the working week
 * starts on Monday — the board's own mobile calendar takes `weekStartsOn` as an
 * argument, and every caller in the portal passes 1.
 */
export function startOfCalendarWeek(day: CalendarDay): CalendarDay {
  const epoch = dayEpoch(day);
  if (!Number.isFinite(epoch)) return "";
  // getUTCDay is 0 for Sunday; (weekday + 6) % 7 is days since Monday.
  const sinceMonday = (new Date(epoch).getUTCDay() + 6) % 7;
  return dayFromEpoch(epoch - sinceMonday * MS_PER_DAY);
}

/**
 * Forty-two days, Monday-first, always six rows.
 *
 * Fixed at six rows rather than the four-to-six a month actually spans, because
 * a grid that changes height as you page through the year makes everything
 * below it jump. `boardCalendarDays` pads with nulls and lets its caller vary
 * the row count; a full-page calendar wants the stable frame instead, so the
 * leading and trailing days are real days from the neighbouring months and
 * `isSameCalendarMonth` is what dims them.
 */
export function calendarMonthGrid(day: CalendarDay): CalendarDay[] {
  const start = startOfCalendarWeek(startOfCalendarMonth(day));
  if (!start) return [];
  const epoch = dayEpoch(start);
  return Array.from({ length: 42 }, (_, index) =>
    dayFromEpoch(epoch + index * MS_PER_DAY),
  );
}

export function calendarWeekDays(day: CalendarDay): CalendarDay[] {
  const start = startOfCalendarWeek(day);
  if (!start) return [];
  const epoch = dayEpoch(start);
  return Array.from({ length: 7 }, (_, index) =>
    dayFromEpoch(epoch + index * MS_PER_DAY),
  );
}

export function isSameCalendarMonth(a: CalendarDay, b: CalendarDay): boolean {
  if (!DAY_PATTERN.test(a) || !DAY_PATTERN.test(b)) return false;
  return a.slice(0, 7) === b.slice(0, 7);
}

/** `24 August 2026` — en-GB, formatted in UTC by the shared formatter. */
export function calendarDayLabel(day: CalendarDay): string {
  return formatLongDate(day, { fallback: "" });
}

/** `Mon`. */
export function calendarWeekdayLabel(day: CalendarDay): string {
  const epoch = dayEpoch(day);
  if (!Number.isFinite(epoch)) return "";
  return WEEKDAY_SHORT[(new Date(epoch).getUTCDay() + 6) % 7];
}

export type CalendarViewMode = "month" | "week" | "day";

/**
 * The heading above the grid: `August 2026`, `18 – 24 Aug 2026`, or
 * `Monday 24 August 2026`.
 *
 * A week that straddles a month or a year prints the part that changes on both
 * sides — `31 Aug – 6 Sep 2026`, `29 Dec 2025 – 4 Jan 2026` — because a heading
 * that says "29 – 4 Jan 2026" is worse than no heading.
 */
export function calendarRangeLabel(
  mode: CalendarViewMode,
  anchor: CalendarDay,
): string {
  if (!DAY_PATTERN.test(anchor)) return "";

  if (mode === "month") return formatMonthYear(anchor, { fallback: "" });

  if (mode === "day") {
    return `${WEEKDAY_LONG[(new Date(dayEpoch(anchor)).getUTCDay() + 6) % 7]} ${calendarDayLabel(anchor)}`;
  }

  const days = calendarWeekDays(anchor);
  const first = days[0];
  const last = days[6];
  const end = formatShortDate(last, { fallback: "" });
  if (first.slice(0, 7) === last.slice(0, 7)) {
    return `${Number(first.slice(8, 10))} – ${end}`;
  }
  if (first.slice(0, 4) === last.slice(0, 4)) {
    // Same year: the year is printed once, on the right.
    const startShort = formatShortDate(first, { fallback: "" });
    return `${startShort.slice(0, startShort.lastIndexOf(" "))} – ${end}`;
  }
  return `${formatShortDate(first, { fallback: "" })} – ${end}`;
}

/* ── Date sources ─────────────────────────────────────────────────────────── */

export type CalendarDateSource = {
  /** `job:dueAt`, `compliance:expiry` — stable, and what preferences store. */
  id: string;
  entity: CalendarEntity;
  /** The field on the record, e.g. `dueAt` or `expiry`. */
  field: string;
  /** The board's own name for the column, so the picker matches the grid. */
  label: string;
  /** One plain sentence for the picker. */
  description: string;
  /** On before anybody chooses. Only the two dates a calendar is opened for. */
  defaultOn: boolean;
  /** Whether an authorised user may change this date from the calendar. */
  editable: boolean;
};

/**
 * Every date this product can put on a calendar, and nothing else.
 *
 * Four job dates and one certificate expiry. They are the real, writable date
 * columns — `requestedAt`, `dueAt`, `completedAt` and `nextUpdateAt` on
 * `maintenance_requests`, all four reachable through
 * `PATCH /api/maintenance {id, fields}`, and the Store Documentation expiry
 * columns behind the compliance register. Nothing here is inferred from a title
 * or a description: a calendar built on guesses is a calendar nobody can act
 * on.
 *
 * `defaultOn` is true for exactly two of them. A calendar that opens with all
 * five layers on shows four marks per job and reads as noise; a coordinator
 * opens this screen to see what is due and what is about to lapse, and the rest
 * are there to be switched on deliberately.
 */
export const CALENDAR_DATE_SOURCES: readonly CalendarDateSource[] = [
  {
    /*
     * THE PRIMARY ANCHOR, and the one this calendar was missing.
     *
     * Module 2 §3 is a table of which job date drives which mark, and its first
     * row is "Scheduled / booked date — primary anchor, this is what appears by
     * default". Until `scheduled_date` existed the calendar had no column for
     * it, so a job that had actually been BOOKED for a day drew no chip on that
     * day; the four marks it did draw were a due date, a raised date, a
     * completion and a promised update — none of which is "somebody is coming
     * on Tuesday".
     *
     * `defaultOn` because a coordinator opens this screen to see what is
     * booked. It joins Due Date and Certificate expiry as the third layer that
     * is on before anybody chooses, which is the point of the whole module.
     */
    id: "job:scheduledDate",
    entity: "job",
    field: "scheduledDate",
    label: "Scheduled visit",
    description: "When somebody is booked to attend.",
    defaultOn: true,
    editable: true,
  },
  {
    id: "job:dueAt",
    entity: "job",
    field: "dueAt",
    label: "Due Date",
    description: "When the job is due to be finished.",
    defaultOn: true,
    editable: true,
  },
  {
    id: "job:requestedAt",
    entity: "job",
    field: "requestedAt",
    label: "Date Requested",
    description: "When the job was first raised.",
    defaultOn: false,
    editable: true,
  },
  {
    id: "job:completedAt",
    entity: "job",
    field: "completedAt",
    label: "Date Completed",
    description: "When the work was recorded as finished.",
    defaultOn: false,
    editable: true,
  },
  {
    id: "job:nextUpdateAt",
    entity: "job",
    field: "nextUpdateAt",
    label: "Next Update",
    description: "When the next update back to the requester is promised.",
    defaultOn: false,
    editable: true,
  },
  {
    id: "compliance:expiry",
    entity: "compliance",
    field: "expiry",
    label: "Certificate expiry",
    description: "When a store certificate lapses and must be renewed.",
    defaultOn: true,
    editable: true,
  },
  /*
   * W10 — THE ADVANCE WARNINGS, AND WHY THEY ARE A SOURCE RATHER THAN ROWS.
   *
   * The owner asked for a certificate to appear on the calendar 90, 60, 30 and
   * 14 days before it lapses as well as on the day itself. Every one of those
   * marks is `expiry - n days` and nothing else, so they are DERIVED on read
   * from the same record the expiry mark comes from. Nothing is stored.
   *
   * That is not a shortcut, it is the whole requirement. "If an expiry date
   * changes, the reminders move with it. If a document is replaced, removed or
   * archived, the calendar updates accordingly." Persisted reminder rows would
   * have to be re-derived on every one of those events — a date edited on the
   * board, a certificate replaced by a new version, a row binned, a slot marked
   * Not required — by a reconciler that would have to be written, scheduled and
   * kept correct, and whose failure mode is a calendar quietly reminding
   * somebody about a certificate that was renewed last month. Derivation cannot
   * drift, cannot duplicate and cannot be left behind.
   *
   * A SOURCE OF ITS OWN, so it can be turned off. Five marks per dated
   * certificate is a real increase in ink, and the picker is where this
   * product already lets a reader say which dates they want to see. It is
   * `defaultOn` because the owner asked for the warnings, and it is one press
   * to switch off.
   *
   * NOT EDITABLE, and this is load-bearing rather than a limitation. A reminder
   * is a projection of the expiry; there is no column behind it to write to.
   * `calendarWriteTarget` refuses any event whose source is not editable, so a
   * drag on a reminder cannot silently write 90 days before an expiry into the
   * expiry cell — which is exactly what "must update the CANONICAL record, not
   * a calendar-only copy" rules out. Moving the EXPIRY moves all four reminders
   * with it, which is the operation somebody actually wants.
   */
  {
    id: "compliance:reminder",
    entity: "compliance",
    field: "expiry",
    label: "Renewal reminders",
    description: "90, 60, 30 and 14 days before a certificate lapses.",
    defaultOn: true,
    editable: false,
  },
  /*
   * W11 — the manual items. On by default, because an item somebody typed onto
   * this calendar by hand and then could not see would be the worst outcome of
   * the feature; and editable, because "add and ADJUST" was the request.
   *
   * `field: "startsOn"` is the column a drag writes — see `nextRange` in
   * `app/api/maintenance/calendar/route.ts`, where moving the start moves the
   * end with it so a three-day item stays three days long.
   */
  {
    id: "manual:item",
    entity: "manual",
    field: "startsOn",
    label: "Manual items",
    description: "Notes and dates added to this calendar by hand.",
    defaultOn: true,
    editable: true,
  },
];

/**
 * How far ahead a lapse is announced, in days.
 *
 * Four thresholds, and the spacing is the renewal round trip rather than a
 * round number. None of these certificates can be renewed in-house: each needs
 * a third party booked, quoted, raised on a purchase order and got to site (see
 * `EXPIRY_DUE_SOON_DAYS` in `app/lib/expiry-status.ts`, which is 60 for the
 * same reason). So 90 is "start now", 60 is the register turning amber, 30 is
 * "this is late", and 14 is "it will lapse".
 *
 * Descending, and read in that order everywhere, so the derived marks come out
 * in the order somebody would meet them.
 */
export const COMPLIANCE_REMINDER_DAYS: readonly number[] = [90, 60, 30, 14];

/**
 * The days a certificate expiring on `expiry` is announced on.
 *
 * Pure and exported so the thresholds can be tested against dates rather than
 * inferred from a rendered calendar. Returns `[]` for anything that is not a
 * calendar day, which is the same answer `calendarDay` gives the expiry mark —
 * a record with no date produces no marks of any kind.
 *
 * ONE DAY PER THRESHOLD, AND THEY CANNOT COLLIDE. The four offsets are distinct
 * and `shiftCalendarDay` is injective, so four thresholds produce four
 * different days; there is no de-duplication step here because there is nothing
 * to de-duplicate. The expiry itself is not in this list — it is the other
 * source's mark, and emitting it here as well is how one certificate would come
 * to be drawn twice on one day.
 */
export function complianceReminderDays(
  expiry: string | null | undefined,
): { day: CalendarDay; daysBefore: number }[] {
  const day = calendarDay(expiry);
  if (!day) return [];
  return COMPLIANCE_REMINDER_DAYS.map((daysBefore) => ({
    day: shiftCalendarDay(day, -daysBefore),
    daysBefore,
  }));
}

export const DEFAULT_CALENDAR_SOURCE_IDS: readonly string[] =
  CALENDAR_DATE_SOURCES.filter((source) => source.defaultOn).map(
    (source) => source.id,
  );

const SOURCE_BY_ID = new Map(
  CALENDAR_DATE_SOURCES.map((source) => [source.id, source]),
);

/** The source with this id, or null. Unknown ids are ignored, never thrown on. */
export function calendarDateSource(id: string): CalendarDateSource | null {
  return SOURCE_BY_ID.get(id) ?? null;
}

/** The job fields a source may name, narrowed for the write target. */
type JobDateField =
  | "scheduledDate"
  | "dueAt"
  | "requestedAt"
  | "completedAt"
  | "nextUpdateAt";

const JOB_DATE_FIELDS: readonly JobDateField[] = [
  "scheduledDate",
  "dueAt",
  "requestedAt",
  "completedAt",
  "nextUpdateAt",
];

function jobDateValue(
  request: MaintenanceRequest,
  field: JobDateField,
): string | null {
  /*
   * `scheduled_date` is a plain calendar DAY (`2026-09-20`) while the other
   * four are instants. `calendarDay` takes the leading ten characters of
   * either, so both shapes land on the day they name and neither consults a
   * timezone to find out which — the same rule `optionalIsoDay` applies on the
   * way in.
   */
  return request[field] ?? null;
}

/**
 * Every date on a job that the CURRENTLY SELECTED sources would draw.
 *
 * For the page's own date range, which is applied to records before events are
 * built. The range was written when Due Date was the only source this screen
 * had; now that it draws four, a job whose Next Update falls inside the window
 * belongs in it even when its due date does not, and the range needs to be able
 * to ask that question without reaching into the field names itself.
 *
 * Values, not days: the caller compares them against a millisecond window.
 */
export function calendarJobDateValues(
  request: MaintenanceRequest,
  sourceIds: readonly string[],
): Array<string | null> {
  const selected = new Set(sourceIds ?? []);
  return JOB_DATE_FIELDS.filter((field) => selected.has(`job:${field}`)).map(
    (field) => jobDateValue(request, field),
  );
}

/* ── Events ───────────────────────────────────────────────────────────────── */

/**
 * Where an event sits relative to today.
 *
 * `overdue` and `due-today` are calls to action; `upcoming` is a plan;
 * `resolved` is finished work and `past` is a lapsed date on something that was
 * never a job. They are separate words because they are separate colours and,
 * more importantly, separate meanings — a completed job in last month's grid
 * must not be red.
 */
export type CalendarTiming =
  | "overdue"
  | "due-today"
  | "upcoming"
  | "resolved"
  | "past";

/**
 * A manual calendar item, as `GET /api/maintenance/calendar` returns it.
 *
 * Declared here rather than imported from the route so the model stays free of
 * server code — `calendar-model.ts` is transpiled and imported by tests with no
 * bundler, and pulling in a route would drag drizzle and the schema behind it.
 * The route's `ManualCalendarEventPayload` is the same shape; a test pins that
 * the two agree.
 */
import {
  calendarItemType,
  calendarItemTypeColour,
  certificateExpiryBand,
} from "./calendar-item-types";

export type ManualCalendarItem = {
  id: string;
  title: string;
  notes: string | null;
  siteId: string | null;
  /** `YYYY-MM-DD`. */
  startsOn: string;
  /** `YYYY-MM-DD`, or null for a single-day item. */
  endsOn: string | null;
  allDay: boolean;
  category: string;
  colour: string | null;
  createdByEmail: string | null;
  archived: boolean;
};

export type CalendarEvent = {
  /**
   * The chip's colour when the RECORD decides it rather than its kind.
   *
   * Set only for manual items, which since the type vocabulary arrived carry
   * a colour of their own: a Planned visit is navy, a Note is teal, and a
   * Certificate takes the band its expiry falls in. `calendarChipStyle`
   * prefers this and falls back to the reader's per-kind colour setting, so an
   * older item with no colour still honours whatever they chose for "manual".
   */
  colourToken?: string | null;
  /**
   * A short word or count printed on the chip beside the icon — "90d", "14d",
   * "EXPIRED". Present so an expiry state is readable in greyscale and by a
   * colour-blind reader, which the band colour alone cannot do.
   */
  badge?: string | null;
  /**
   * `${sourceId}::${recordId}`.
   *
   * Keyed by the SOURCE as well as the record, because one job can legitimately
   * appear five times in the same grid — raised, due, updated, completed — and
   * keying by record id alone would collapse them into one another or make
   * React call them duplicates.
   */
  key: string;
  kind: CalendarEntity;
  sourceId: string;
  recordId: string;
  field: string;
  /** `Due Date`, `Certificate expiry` — the source's label, on the event. */
  fieldLabel: string;
  day: CalendarDay;
  /**
   * `HH:MM` only where somebody chose one on a board date decoration, and ""
   * everywhere else — which is every row this product currently holds. Render
   * it when it is there and render nothing when it is not; see
   * `calendarTimeOfDay`.
   */
  time: string;
  title: string;
  subtitle: string;
  timing: CalendarTiming;
  /**
   * The SOURCE is editable. Whether THIS user may edit it is a capability
   * question the caller answers with `calendarEditCapability`.
   */
  editable: boolean;
  request?: MaintenanceRequest;
  record?: WorkspaceComplianceRecord;
  /**
   * The manual item behind this mark, and the day WITHIN it that this mark is.
   *
   * A multi-day item is drawn on every day it covers, so a drag has to know
   * which of those days was picked up: dropping the middle day of a three-day
   * item on the 20th means the item starts on the 19th, not the 20th.
   * `spanOffset` is that answer, in days from `item.startsOn`, and
   * `calendarWriteTarget` turns it into the start date to send.
   */
  manual?: ManualCalendarItem;
  spanOffset?: number;
};

/**
 * How many days of one manual item this calendar will draw.
 *
 * A ceiling rather than a policy: nothing in the product creates a year-long
 * item, but `endsOn` is a date somebody types, and a typo of "2126" would ask
 * the grid for thirty-six thousand chips and take the page down. Past the
 * ceiling the item is drawn for its first `MAX_MANUAL_SPAN_DAYS` days and the
 * subtitle still names the real end date, so nothing is hidden — the reader
 * sees a long item and the true dates, not a hung tab.
 */
export const MAX_MANUAL_SPAN_DAYS = 366;

/**
 * Every day one manual item covers, inclusive, capped.
 *
 * Exported and pure so the span arithmetic is tested against dates. An item
 * with no valid start covers nothing; an `endsOn` before the start is treated
 * as a single day, which is the same defensive reading the route refuses to
 * store in the first place.
 */
export function manualItemDays(item: {
  startsOn: string;
  endsOn: string | null;
}): CalendarDay[] {
  const start = calendarDay(item.startsOn);
  if (!start) return [];
  const end = calendarDay(item.endsOn) || start;
  if (end <= start) return [start];
  const days: CalendarDay[] = [];
  for (let index = 0; index < MAX_MANUAL_SPAN_DAYS; index += 1) {
    const day = shiftCalendarDay(start, index);
    days.push(day);
    if (day >= end) break;
  }
  return days;
}

/**
 * Timing for a job date.
 *
 * The rule is `timingOf` in views/fix-tracker.tsx: finished work is never late,
 * whatever its dates say. 187 of the board's 673 completed jobs carry no
 * completion date, so `completedAt` alone cannot decide it — the stage is the
 * fact and the date is the paperwork, which is why a second signal is consulted.
 *
 * ONE DELIBERATE DIFFERENCE FROM `timingOf`, AND IT ONLY EVER REMOVES RED.
 *
 * `timingOf` asks `jobState`, which reads `stage` when there is one and only
 * falls back to the status text when there is not. This asks `isClosedRequest`
 * (dashboard-meters.ts), which is the UNION: `stage === "Completed"` OR the
 * status label is "Job Completed". The two disagree on exactly one population —
 * a row whose Status column says "Job Completed" while its stage says something
 * else — and the monday import produces that population in bulk, because the
 * imported rows sit in "… Recently completed" groups that carry no lifecycle
 * stage. `isClosedRequest`'s own header records the measurement: a stage-only
 * test read 28 such jobs as open work.
 *
 * On those rows `timingOf` would paint a red "overdue" chip on a job the board
 * itself says is finished. The union cannot do that, and it cannot invent
 * lateness either — every difference is in the direction of `resolved`. The
 * dev workspace has 0 of these rows (29 jobs, checked 2026-08-26), so the
 * divergence is invisible there and visible on the imported estate, which is
 * the wrong way round for a rule to be verified by eye.
 */
function jobTiming(
  request: MaintenanceRequest,
  sourceId: string,
  day: CalendarDay,
  today: CalendarDay,
): CalendarTiming {
  /*
   * A completion date is a record of the past. It cannot be overdue, cannot be
   * "due today", and is resolved by definition — including on a job somebody
   * has since reopened.
   */
  if (sourceId === "job:completedAt") return "resolved";

  const done = isClosedRequest(request) || Boolean(calendarDay(request.completedAt));
  if (done) return "resolved";

  if (day < today) return "overdue";
  if (day === today) return "due-today";
  return "upcoming";
}

/**
 * Timing for a certificate expiry.
 *
 * `state` is the register's own verdict and it is recomputed from the date on
 * every read (see app/lib/compliance-register.ts), so `Expired` and "the date
 * is behind us" agree — but the state is what the rest of the product colours
 * by, so it leads. An expiry that has passed without the register calling it
 * expired is `past`, not `overdue`: it is a date gone by on a document nobody
 * is being asked to chase today.
 */
function complianceTiming(
  record: WorkspaceComplianceRecord,
  day: CalendarDay,
  today: CalendarDay,
): CalendarTiming {
  if (record.state === "Expired") return "overdue";
  if (day < today) return "past";
  if (day === today) return "due-today";
  return "upcoming";
}

/**
 * Timing for one of the four advance warnings.
 *
 * DELIBERATELY NEVER `overdue`, and this is the difference from the expiry rule
 * above rather than an oversight. A certificate that has lapsed already carries
 * one red mark — its expiry — and its four reminder days are all behind it, so
 * taking the record's state here would paint FIVE red marks across the previous
 * three months for a single lapsed certificate. On the owner's estate that is
 * the difference between a calendar you can read and a wall of alerts.
 *
 * A warning that has gone by is `past`: it is a day something should have been
 * started on, not a thing that is itself late. What is late is the certificate,
 * and the calendar says so once, on the day it lapsed.
 */
function reminderTiming(day: CalendarDay, today: CalendarDay): CalendarTiming {
  if (day < today) return "past";
  if (day === today) return "due-today";
  return "upcoming";
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

/**
 * The six facets, each an allow-list.
 *
 * INTERSECTION SEMANTICS, AND WHY A JOB FACET DOES NOT HIDE A CERTIFICATE.
 *
 * An empty array is NO CONSTRAINT; a non-empty array means the record's value
 * must be one of them. Facets combine with AND.
 *
 * Four of the six describe things only a job has — status, priority,
 * contractor, job type — and one describes only a certificate. If those applied
 * across the whole calendar, picking "Urgent" would empty the compliance layer,
 * because no certificate has a priority, and the operator would read that as
 * "nothing expires" rather than "that filter does not apply here". So a job
 * facet narrows jobs and leaves certificates alone, and `complianceTypes`
 * narrows certificates and leaves jobs alone. `sites` is the one facet both
 * entities genuinely share, and it is the one facet that applies to both.
 *
 * The alternative — hiding the inapplicable facets whenever the other layer is
 * on — was rejected because the controls would appear and disappear as sources
 * are toggled.
 */
export type CalendarFilters = {
  sites: string[];
  statuses: string[];
  priorities: string[];
  contractors: string[];
  jobTypes: string[];
  complianceTypes: string[];
};

export const EMPTY_CALENDAR_FILTERS: CalendarFilters = {
  sites: [],
  statuses: [],
  priorities: [],
  contractors: [],
  jobTypes: [],
  complianceTypes: [],
};

const FILTER_FACETS: readonly (keyof CalendarFilters)[] = [
  "sites",
  "statuses",
  "priorities",
  "contractors",
  "jobTypes",
  "complianceTypes",
];

/**
 * How many values are selected in total — the number on the "Filters" badge.
 *
 * Values, not facets: two sites and one priority is three constraints a person
 * can see, and a badge reading "2" beside three chosen values invites the
 * "why is this row missing" question this screen exists to avoid.
 */
export function calendarFilterCount(filters: CalendarFilters): number {
  return FILTER_FACETS.reduce(
    (total, facet) => total + (filters?.[facet]?.length ?? 0),
    0,
  );
}

/**
 * The sentinel for "this job has no contractor".
 *
 * Blank has to be SELECTABLE — "what is due this week that nobody is booked
 * for" is the question the calendar gets asked most — and an empty string is
 * the one value no contractor's name can collide with.
 */
const NO_CONTRACTOR = "";
const NO_CONTRACTOR_LABEL = "No contractor";

export type CalendarFilterOption = { value: string; label: string; count: number };
export type CalendarFilterOptions = Record<
  keyof CalendarFilters,
  CalendarFilterOption[]
>;

function tally(
  into: Map<string, CalendarFilterOption>,
  value: string,
  label: string,
) {
  const existing = into.get(value);
  if (existing) {
    existing.count += 1;
    // A later record may name the site where an earlier one only had an id.
    if (!existing.label && label) existing.label = label;
    return;
  }
  into.set(value, { value, label: label || value, count: 1 });
}

/*
 * Alphabetical by label, with the blank sentinel last.
 *
 * `localeCompare` is deliberately not used: this list is also asserted by
 * tests and read back from stored preferences, and an ordering that depends on
 * the machine's ICU data is one that can differ between the server render and
 * the browser.
 */
function byLabel(a: CalendarFilterOption, b: CalendarFilterOption) {
  if (a.value === NO_CONTRACTOR) return 1;
  if (b.value === NO_CONTRACTOR) return -1;
  if (a.label === b.label) return a.value < b.value ? -1 : 1;
  return a.label < b.label ? -1 : 1;
}

const drain = (source: Map<string, CalendarFilterOption>) =>
  [...source.values()].sort(byLabel);

/**
 * Every value present in the data, with how many records carry it.
 *
 * Built from the records rather than from an option table, so a facet never
 * offers a value that would return nothing, and never omits a legacy value some
 * imported row still holds. Site ids are used verbatim, whatever shape they are
 * in — several stores on this estate exist only as a board item id — so an odd
 * id becomes an option labelled by whatever name the record carries instead of
 * dropping the record out of the calendar silently.
 *
 * `Not required` certificates are excluded entirely: the register marks a
 * requirement that does not apply to a store, it can never carry an expiry, and
 * a filter value that can never match anything on the grid is a broken control.
 */
export function calendarFilterOptions(input: {
  requests: MaintenanceRequest[];
  complianceRecords: WorkspaceComplianceRecord[];
  /*
   * Manual items tally into the SITE facet too — optional, because the board's
   * Calendar tab is a second caller with no manual layer at all.
   *
   * Without them the filter could hide what it was asked to show: an item on a
   * site that happens to carry no jobs and no compliance requirement produced
   * no option, so there was no way to filter to the one thing on that site.
   * `matchesManualFilters` has always filtered manual items by site; it was the
   * list of offerable sites that was short.
   *
   * Site only. A manual item has no status, priority, contractor or job type,
   * and inventing facet values for it would offer filters that select nothing.
   */
  manualItems?: ManualCalendarItem[];
}): CalendarFilterOptions {
  /*
   * See `buildCalendarEvents` for why both arrays are coerced rather than
   * trusted: the board's Calendar tab is a second caller with a different
   * shape, and it hands over one board's items with no compliance layer at all.
   */
  const requests = input.requests ?? [];
  const complianceRecords = input.complianceRecords ?? [];
  const manualItems = input.manualItems ?? [];
  const sites = new Map<string, CalendarFilterOption>();
  const statuses = new Map<string, CalendarFilterOption>();
  const priorities = new Map<string, CalendarFilterOption>();
  const contractors = new Map<string, CalendarFilterOption>();
  const jobTypes = new Map<string, CalendarFilterOption>();
  const complianceTypes = new Map<string, CalendarFilterOption>();

  /*
   * The register names sites; the board rows only carry the free-text location
   * a coordinator typed. Naming the site from the register first means one
   * label per site id across both layers instead of "Aldgate" on a certificate
   * and "Aldgate " on the job beside it.
   */
  const siteNameById = new Map<string, string>();
  for (const record of complianceRecords) {
    if (record.siteId && record.siteName && !siteNameById.has(record.siteId)) {
      siteNameById.set(record.siteId, record.siteName);
    }
  }

  for (const request of requests) {
    const siteId = request.siteId ?? "";
    tally(sites, siteId, siteNameById.get(siteId) || request.location || siteId);
    if (request.status) tally(statuses, request.status, request.status);
    if (request.priority) tally(priorities, request.priority, request.priority);
    const contractor = (request.contractor ?? "").trim();
    tally(
      contractors,
      contractor || NO_CONTRACTOR,
      contractor || NO_CONTRACTOR_LABEL,
    );
    if (request.category) tally(jobTypes, request.category, request.category);
  }

  for (const record of complianceRecords) {
    if (record.state === "Not required") continue;
    const siteId = record.siteId ?? "";
    tally(sites, siteId, record.siteName || siteId);
    if (record.kind) tally(complianceTypes, record.kind, record.kind);
  }

  /*
   * After the two loops above, so a site the register or a job already named
   * keeps that name: `tally` counts an existing key rather than relabelling it,
   * and a manual item carries no site NAME of its own — only an id.
   */
  for (const item of manualItems) {
    if (!item.siteId) continue;
    tally(sites, item.siteId, siteNameById.get(item.siteId) || item.siteId);
  }

  return {
    sites: drain(sites),
    statuses: drain(statuses),
    priorities: drain(priorities),
    contractors: drain(contractors),
    jobTypes: drain(jobTypes),
    complianceTypes: drain(complianceTypes),
  };
}

/** An empty facet constrains nothing; a filled one is an allow-list. */
function allows(selected: string[] | undefined, value: string) {
  if (!selected || selected.length === 0) return true;
  return selected.includes(value);
}

function jobPasses(request: MaintenanceRequest, filters: CalendarFilters) {
  if (!allows(filters.sites, request.siteId ?? "")) return false;
  if (!allows(filters.statuses, request.status ?? "")) return false;
  if (!allows(filters.priorities, request.priority ?? "")) return false;
  if (!allows(filters.contractors, (request.contractor ?? "").trim())) return false;
  if (!allows(filters.jobTypes, request.category ?? "")) return false;
  // statuses/priorities/contractors/jobTypes stop here — see CalendarFilters.
  return true;
}

/**
 * Which facets a manual item answers to.
 *
 * ONLY `sites`, and for the reason the header of `CalendarFilters` gives: a
 * facet that describes something only a job has must not empty a layer that has
 * no such property, or picking "Urgent" reads as "there are no manual items"
 * rather than "that filter does not apply here". A manual item has a site or it
 * does not, and that is the one facet it shares.
 *
 * An item with NO site is kept when a site filter is on. It is not "some other
 * site's" item — it belongs to nobody's, so hiding it would make a
 * site-filtered calendar quietly lose the reader's general notes.
 */
function manualPasses(item: ManualCalendarItem, filters: CalendarFilters) {
  if (!filters.sites?.length) return true;
  if (!item.siteId) return true;
  return filters.sites.includes(item.siteId);
}

function compliancePasses(
  record: WorkspaceComplianceRecord,
  filters: CalendarFilters,
) {
  if (!allows(filters.sites, record.siteId ?? "")) return false;
  if (!allows(filters.complianceTypes, record.kind ?? "")) return false;
  return true;
}

/* ── Building the grid's contents ─────────────────────────────────────────── */

/** Jobs before certificates on the same day, then alphabetical by title. */
/**
 * Jobs, then certificates, then manual items, within one day.
 *
 * Manual items sort LAST deliberately. They are the reader's own annotations
 * and the two derived layers are the product's answer about work and
 * compliance; a note pushed to the top of a day would read as the most
 * important thing on it, which is a claim nobody made when they typed it.
 */
const KIND_ORDER: Record<CalendarEntity, number> = { job: 0, compliance: 1, manual: 2 };

function compareEvents(a: CalendarEvent, b: CalendarEvent) {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  // Last resort so the order is total: two identical titles still have one order.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Every event the chosen sources and filters put on the calendar.
 *
 * `today` is passed in rather than read here, so one instant classifies the
 * whole grid and a test can pin the date. A record with no value for a selected
 * source produces NO event — there is no such thing as a job with an implied
 * due date, and inventing one puts work in front of somebody that nobody
 * scheduled.
 *
 * TWO CALLERS, TWO SHAPES, AND THE SECOND ONE HAS NO COMPLIANCE LAYER.
 *
 * The portal page hands over the whole workspace. The board's Calendar TAB
 * hands over one board's items and `complianceRecords: []`, because a board
 * knows nothing about the compliance register — and that is a legitimate call
 * that must produce a job-only calendar rather than an empty one or a crash.
 * Both arrays are coerced instead of trusted: the tab is exactly the surface
 * whose absence the owner reported, and a `for…of undefined` there is a blank
 * screen with a console error, which is the failure this correction exists to
 * stop happening twice. The types still say the fields are required; the
 * coercion is for the moment a caller is mid-load, not a licence to omit them.
 */
export function buildCalendarEvents(input: {
  requests: MaintenanceRequest[];
  complianceRecords: WorkspaceComplianceRecord[];
  /** W11 — the hand-added items. Absent is an empty list, never a crash. */
  manualItems?: ManualCalendarItem[];
  sourceIds: readonly string[];
  filters: CalendarFilters;
  today: CalendarDay;
}): CalendarEvent[] {
  const { sourceIds, today } = input;
  const requests = input.requests ?? [];
  const complianceRecords = input.complianceRecords ?? [];
  const manualItems = input.manualItems ?? [];
  const filters = input.filters ?? EMPTY_CALENDAR_FILTERS;
  const selected = new Set(sourceIds ?? []);
  const events: CalendarEvent[] = [];

  const jobSources = JOB_DATE_FIELDS.map((field) =>
    calendarDateSource(`job:${field}`),
  ).filter(
    (source): source is CalendarDateSource =>
      source !== null && selected.has(source.id),
  );

  if (jobSources.length > 0) {
    for (const request of requests) {
      if (!jobPasses(request, filters)) continue;
      const subtitle = [request.location, request.status]
        .map((part) => (part ?? "").trim())
        .filter(Boolean)
        .join(" · ");

      for (const source of jobSources) {
        const raw = jobDateValue(request, source.field as JobDateField);
        const day = calendarDay(raw);
        if (!day) continue;
        events.push({
          key: `${source.id}::${request.id}`,
          kind: "job",
          sourceId: source.id,
          recordId: request.id,
          field: source.field,
          fieldLabel: source.label,
          day,
          time: calendarTimeOfDay(raw),
          title: request.title || request.id,
          subtitle,
          timing: jobTiming(request, source.id, day, today),
          editable: source.editable,
          request,
        });
      }
    }
  }

  const expirySource = calendarDateSource("compliance:expiry");
  if (expirySource && selected.has(expirySource.id)) {
    for (const record of complianceRecords) {
      // A requirement that does not apply to this store has no date to show.
      if (record.state === "Not required") continue;
      if (!compliancePasses(record, filters)) continue;
      const day = calendarDay(record.expiry);
      if (!day) continue;
      events.push({
        key: `${expirySource.id}::${record.id}`,
        kind: "compliance",
        sourceId: expirySource.id,
        recordId: record.id,
        field: expirySource.field,
        fieldLabel: expirySource.label,
        day,
        time: calendarTimeOfDay(record.expiry),
        /*
         * "PAT Test renewal", not "PAT Test".
         *
         * The date on a certificate is the day it STOPS being valid, and the
         * work it implies is booking the renewal — which is a multi-week round
         * trip through a third party (see EXPIRY_DUE_SOON_DAYS). A grid cell
         * reading "PAT Test" says a certificate exists; one reading "PAT Test
         * renewal" says something has to be arranged. The heading above this
         * screen has always promised renewals, and this is the word that keeps
         * that promise.
         */
        title: `${record.kind} renewal`,
        subtitle: record.siteName,
        timing: complianceTiming(record, day, today),
        editable: expirySource.editable,
        record,
      });
    }
  }

  /*
   * W10 — THE ADVANCE WARNINGS.
   *
   * A SEPARATE PASS OVER THE SAME RECORDS, not a nested loop inside the expiry
   * pass, because the two are independent sources: a reader may want the
   * warnings without the lapse dates or the other way round, and the picker
   * already offers each of them separately. Nesting would have tied the
   * reminders to the expiry source being on, which is a coupling nothing asked
   * for and nobody could see the cause of.
   *
   * The same record, the same filters and the same "Not required has no date"
   * rule, so a certificate that is off the calendar is off it four more times
   * as well.
   */
  const reminderSource = calendarDateSource("compliance:reminder");
  if (reminderSource && selected.has(reminderSource.id)) {
    for (const record of complianceRecords) {
      if (record.state === "Not required") continue;
      if (!compliancePasses(record, filters)) continue;
      for (const { day, daysBefore } of complianceReminderDays(record.expiry)) {
        events.push({
          /*
           * The threshold is IN THE KEY. Without it four reminders for one
           * certificate share `compliance:reminder::<id>` — React calls them
           * duplicates, `groupCalendarEventsByDay` keeps all four anyway, and
           * the grid draws four chips it cannot tell apart. The same reason
           * `key` carries the source id in the first place.
           */
          key: `${reminderSource.id}:${daysBefore}::${record.id}`,
          kind: "compliance",
          sourceId: reminderSource.id,
          recordId: record.id,
          field: reminderSource.field,
          /*
           * "60-day reminder", not "Certificate expiry". The chip's title says
           * WHICH certificate and the meta line says WHAT this mark is, so a
           * reader can tell a warning from the lapse itself without opening
           * anything — which matters most in the month view, where the same
           * certificate may appear twice.
           */
          fieldLabel: `${daysBefore}-day reminder`,
          day,
          /*
           * No time of day. The expiry mark carries whatever time the board
           * decoration recorded, because that is a real value on a real cell; a
           * reminder is a day this product computed, and giving it 09:00 would
           * be inventing a fact about a record.
           */
          time: "",
          title: `${record.kind} renewal`,
          /*
           * The store AND the date being warned about, because a warning three
           * months early is unreadable without the thing it is warning about.
           */
          subtitle: `${record.siteName} · expires ${formatCalendarDayShort(day, daysBefore)}`,
          timing: reminderTiming(day, today),
          /*
           * FALSE, from the source. A reminder has no column behind it, so
           * `calendarWriteTarget` refuses it and neither a drag nor the date
           * dialog can write through it. Moving the EXPIRY moves all four.
           */
          editable: reminderSource.editable,
          record,
        });
      }
    }
  }

  /*
   * W11 — THE MANUAL ITEMS.
   *
   * One mark per DAY the item covers, so a three-day item reads as three days
   * on the grid rather than as a note on its first morning. The item itself is
   * one row; these are its appearances, and the write path is told which
   * appearance was dragged through `spanOffset`.
   *
   * ARCHIVED ITEMS ARE NOT DRAWN. The API's default read already drops them —
   * this is the second guard, for a caller that asked for
   * `?archived=include` in order to show a management list and then handed the
   * same array to the grid.
   */
  const manualSource = calendarDateSource("manual:item");
  if (manualSource && selected.has(manualSource.id)) {
    for (const item of manualItems) {
      if (item.archived) continue;
      if (!manualPasses(item, filters)) continue;
      const days = manualItemDays(item);
      const last = days.length > 0 ? days[days.length - 1] : "";
      /*
       * Computed once per item rather than per day. `startsOn` IS the expiry
       * date for this type — see the note on `dateLabel` in the vocabulary —
       * and the distance is measured from `today` in whole days so the bands
       * land exactly on 90, 60, 30 and 14 rather than on a fraction either
       * side of them.
       */
      const certificate = calendarItemType(item.category).key === "Certificate";
      const daysToExpiry = certificate ? calendarDaysBetween(today, item.startsOn) : null;
      for (const [offset, day] of days.entries()) {
        events.push({
          /* The DAY is in the key, because one item legitimately appears on
             several days and they must not collapse into one another. */
          key: `${manualSource.id}:${day}::${item.id}`,
          kind: "manual",
          sourceId: manualSource.id,
          recordId: item.id,
          field: manualSource.field,
          fieldLabel:
            days.length > 1
              ? `Day ${offset + 1} of ${days.length}`
              : manualSource.label,
          day,
          /* Days, not appointments. `all_day` defaults true and nothing in this
             product writes a time onto a manual item yet. */
          time: "",
          title: item.title,
          subtitle:
            days.length > 1
              ? `${calendarDayLabel(days[0])} — ${calendarDayLabel(last)}`
              : (item.notes ?? "").trim().slice(0, 120),
          /*
           * A NOTE IS NEVER OVERDUE. A CERTIFICATE CAN BE.
           *
           * The first half of that sentence is the original rule and it still
           * holds: nothing is chasing a reader's own annotation, and painting
           * it red would put it in the same visual class as a lapsed fire
           * alarm certificate.
           *
           * The second half is what the type vocabulary changed. A manual item
           * whose category is `Certificate` records a date something EXPIRES
           * on, and one of those in the past is exactly the lapsed certificate
           * the old rule was protecting notes from being confused with. Saying
           * "past" about it would be the calendar quietly agreeing that an
           * expired certificate is settled.
           */
          timing:
            certificate && day < today
              ? "overdue"
              : day < today
                ? "past"
                : day === today
                  ? "due-today"
                  : "upcoming",
          /*
           * The record's own colour, and for a certificate the band its expiry
           * falls in — 90 / 60 / 30 / 14, the same ladder the compliance
           * reminders already fire on.
           */
          colourToken: calendarItemTypeColour(item.category, item.colour, daysToExpiry),
          badge: certificate && daysToExpiry !== null
            ? certificateExpiryBand(daysToExpiry).badge
            : null,
          editable: manualSource.editable,
          manual: item,
          spanOffset: offset,
        });
      }
    }
  }

  return events.sort(compareEvents);
}

/**
 * "expires 12 Mar 2027", built from the reminder day and its offset.
 *
 * Derived rather than read off `record.expiry` so the sentence cannot
 * contradict the mark it is printed on: the day IS `expiry - daysBefore`, so
 * adding the offset back is the expiry by construction. Reading the record
 * would be a second source for the same fact and would be wrong the moment a
 * caller passed a record and a day that did not correspond.
 */
function formatCalendarDayShort(day: CalendarDay, daysBefore: number): string {
  return calendarDayLabel(shiftCalendarDay(day, daysBefore));
}

/**
 * The same events, bucketed by day and still in order inside each bucket.
 *
 * A Map rather than an object so the insertion order is the sorted order — a
 * plain object would reorder nothing here (the keys are not integer-like), but
 * relying on that is relying on a detail of key coercion.
 */
export function groupCalendarEventsByDay(
  events: readonly CalendarEvent[],
): Map<CalendarDay, CalendarEvent[]> {
  const byDay = new Map<CalendarDay, CalendarEvent[]>();
  for (const event of events) {
    const bucket = byDay.get(event.day);
    if (bucket) bucket.push(event);
    else byDay.set(event.day, [event]);
  }
  return byDay;
}

/* ── Where a date edit has to go ──────────────────────────────────────────── */

/**
 * The endpoint that owns this event's date.
 *
 * THREE PATHS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   `job` — one of the four date fields on `maintenance_requests`, set with
 *     `PATCH /api/maintenance { id, fields: { dueAt: "2026-09-01" } }`. The
 *     route runs `requestFieldValues`, which puts a bare `YYYY-MM-DD` through
 *     `optionalIsoDate`; `null` or `""` clears the date.
 *
 *   `board-cell` — a certificate expiry the compliance register DERIVED from a
 *     Store Documentation board row. The register recomputes state from that
 *     board cell on every read, so writing the register copy instead would be
 *     overwritten by the next refresh and the operator would watch their edit
 *     vanish. It goes back to the cell it came from:
 *
 *       PATCH /api/board?board=store-documentation
 *       { action: "update_cell", requestId, columnId, value: "YYYY-MM-DD" }
 *
 *     Three details, each of which has its own way of failing quietly, and all
 *     three were re-checked against the running route on 2026-08-26:
 *
 *       - PATCH, NOT POST. `/api/board` splits its actions across two handlers
 *         and `update_cell` is on the PATCH one; POSTed, the same body comes
 *         back `400 {"error":"Unknown board action."}`. That shipped once, and
 *         the only thing that caught it was a real certificate not moving.
 *       - The board comes from the QUERY STRING. `boardIdFrom` reads
 *         `?board=`, and with it absent the write lands on the maintenance
 *         board instead — hence `boardId` on the target, which the caller must
 *         put in the URL and not in the body.
 *       - `columnId`, NOT a key. The route looks the column up by its
 *         `maintenance_board_columns.id`; sending `patExpiry` answers
 *         `404 {"error":"The row or column no longer exists."}`, which reads to
 *         an operator as an outage. `record.expiryColumnId` is that id,
 *         resolved server-side by `/api/workspace`.
 *
 *     `requestId` is the board ITEM id, which for this board is a store row.
 *     Round-tripped end to end: writing `2027-05-05` into the `patExpiry` cell
 *     of a Store Documentation row made the next `GET /api/workspace` return
 *     that record with `expiry: "2027-05-05"` and `state: "Compliant"`.
 *
 *   `workspace-compliance` — a register-only requirement, with no board row
 *     behind it. `PATCH /api/workspace { entity: "compliance", id, data }`, and
 *     `data` is a FULL REPLACE of siteId, kind, state and expiry: the caller
 *     must send the other three back unchanged or it will blank them. `state`
 *     carries twice — the route stores it as `status` AND derives
 *     `notRequired: state === "Not required"` from it — so dropping it does not
 *     merely lose a word, it silently un-marks a requirement a store has said
 *     does not apply to it. That is why the target carries all three rather
 *     than leaving the caller to remember.
 *
 *     This is the live path on a workspace whose Store Documentation board is
 *     empty: on 2026-08-26 all 120 records on the dev workspace were
 *     register-only, because that board had no rows to derive any from.
 *
 * `none` carries a reason so the UI can say why a date is read-only instead of
 * showing a control that fails. The honest case is a slot the board tracks no
 * expiry for — RAMS, the Fire Risk Assessment and the store Drawing have
 * `expiryColumn: null` in `storeDocumentationCertificates` — which can never
 * produce a dated event in the first place, so this is a guard rather than a
 * path anybody reaches.
 */
/**
 * The job date columns a calendar mark can be written back to.
 *
 * Exported and named because four files declared this union inline and a fifth
 * value had to be added to all of them at once. A union spelled out in four
 * places is a union that will be five in three of them.
 */
export type CalendarJobDateField =
  | "scheduledDate"
  | "dueAt"
  | "requestedAt"
  | "completedAt"
  | "nextUpdateAt";

export type CalendarWriteTarget =
  | {
      path: "job";
      id: string;
      /*
       * `scheduledDate` joins the four when the hybrid visit model arrived, and
       * it is the one a drag most often means: moving a booked visit to another
       * day writes the JOB's scheduled date, which is what
       * `planned-visit.ts:visitScheduleTarget` decides and what stops the
       * calendar and the job record disagreeing about when somebody is coming.
       */
      field: CalendarJobDateField;
    }
  /**
   * W11 — a manual item moved.
   *
   * `startsOn` is the item's NEW START, already corrected for which day of a
   * multi-day item was dragged. The caller sends exactly this and nothing else,
   * and the route moves `ends_on` by the same number of days so the item keeps
   * its length — see `nextRange` in `app/api/maintenance/calendar/route.ts`.
   * Computing the start HERE rather than in the drag handler is what stops two
   * callers inventing two different answers to "which day did they pick up".
   */
  | { path: "manual"; id: string; startsOn: string }
  | {
      path: "board-cell";
      /** Always the Store Documentation board — `update_cell` reads it from `?board=`. */
      boardId: "store-documentation";
      /** The board ITEM id, which for a derived record is `record.itemId`. */
      requestId: string;
      /** The column's DB id. `update_cell` answers 404 for a column key. */
      columnId: string;
      /** Carried for the audit line and for a readable error, not for the write. */
      columnKey: string;
    }
  | {
      path: "workspace-compliance";
      id: string;
      /*
       * `PATCH /api/workspace {entity:"compliance"}` REPLACES siteId, kind,
       * status, expiryDate and notRequired in one statement. Sending only the
       * new expiry would blank the other three, so the caller has to send them
       * back unchanged and they travel on the target rather than being fetched
       * again by whoever performs the write.
       */
      siteId: string;
      kind: string;
      state: string;
    }
  | { path: "none"; reason: string };

export function calendarWriteTarget(
  event: CalendarEvent,
  /**
   * The day the mark was dropped on. Only a manual item needs it — a job or a
   * certificate is one mark on one day, so the new date IS the drop day and the
   * caller passes it to the endpoint itself. A multi-day manual item is drawn
   * on several days, so the target has to say which START that drop implies,
   * and it cannot without knowing where the mark landed.
   */
  droppedOn?: CalendarDay,
): CalendarWriteTarget {
  if (!event.editable) {
    return { path: "none", reason: "This date cannot be changed here." };
  }

  if (event.kind === "manual") {
    const item = event.manual;
    if (!item) {
      return { path: "none", reason: "This calendar item is no longer here." };
    }
    const landing = droppedOn || event.day;
    /*
     * The dragged mark is `spanOffset` days into the item, so the item starts
     * that many days before wherever the mark was dropped. Dropping the third
     * day of a three-day item on the 20th starts it on the 18th, which is what
     * a person watching the whole block move expects.
     */
    return {
      path: "manual",
      id: event.recordId,
      startsOn: shiftCalendarDay(landing, -(event.spanOffset ?? 0)),
    };
  }

  if (event.kind === "job") {
    const field = event.field as JobDateField;
    if (!JOB_DATE_FIELDS.includes(field)) {
      return { path: "none", reason: "This job date has no editable column." };
    }
    return { path: "job", id: event.recordId, field };
  }

  const record = event.record;
  if (!record) {
    return { path: "none", reason: "This certificate is no longer in the register." };
  }

  // Board-derived: the expiry lives in a board cell and must go back to it.
  if (record.itemId && record.expiryColumnKey) {
    if (!record.expiryColumnId) {
      /*
       * The slot tracks an expiry but this workspace's board has no live column
       * for it — never seeded, or the column was deleted. Refusing here is the
       * honest answer: posting a key where `update_cell` wants an id would come
       * back 404 and read to the operator as an outage rather than as a board
       * that cannot hold the date.
       */
      return {
        path: "none",
        reason:
          "This certificate's expiry column is not on the Store Documentation board, so the date cannot be changed here.",
      };
    }
    return {
      path: "board-cell",
      boardId: "store-documentation",
      requestId: record.itemId,
      columnId: record.expiryColumnId,
      columnKey: record.expiryColumnKey,
    };
  }

  // Register-only: no board row behind it, so the register row IS the record.
  if (!record.itemId) {
    return {
      path: "workspace-compliance",
      id: event.recordId,
      siteId: record.siteId,
      kind: record.kind,
      state: record.state,
    };
  }

  return {
    path: "none",
    reason: "This document does not track an expiry date.",
  };
}

/**
 * The capability the write path enforces, or null when there is no write path.
 *
 * Two different permissions, because they are two different systems: the board
 * and the job fields are `board.edit`, and the compliance register is
 * `sites.edit`. A user may hold one and not the other, so the calendar has to
 * ask per event rather than once per screen.
 */
export function calendarEditCapability(
  event: CalendarEvent,
): "board.edit" | "sites.edit" | null {
  const target = calendarWriteTarget(event);
  if (target.path === "job" || target.path === "board-cell") return "board.edit";
  /* W11 — a manual item is planning data, the same system a job's own dates
     belong to, so it takes the same capability. See the note on
     `WRITE_CAPABILITY` in `app/api/maintenance/calendar/route.ts`. */
  if (target.path === "manual") return "board.edit";
  if (target.path === "workspace-compliance") return "sites.edit";
  return null;
}
