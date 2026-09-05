/**
 * WHEN a reminder fires. Resolved against a real timezone database, never a table.
 *
 * ── THE ONE REQUIREMENT THAT SHAPES EVERYTHING ─────────────────────────────
 *
 * "An 08:00 reminder still sends at 08:00 local after the October clock
 * change" is an acceptance criterion, and it is not a formatting problem. It
 * is a storage problem. A reminder's meaning is a LOCAL WALL CLOCK — the
 * renewal owner wants an email at breakfast — but the row that the hourly cron
 * selects on (`reminder_rules.next_send_at`) is an INSTANT, and the two are not
 * the same thing across a clock change. 08:00 Europe/London is 07:00Z in BST
 * and 08:00Z in GMT. A cascade whose 90-day step falls in September and whose
 * 14-day step falls in November needs two DIFFERENT UTC offsets to mean one
 * thing to the person reading the email.
 *
 * So the wall clock is the input, the instant is the output, and this file is
 * the only place the conversion happens.
 *
 * ── WHY NOT A DST TABLE ────────────────────────────────────────────────────
 *
 * The obvious implementation is "British Summer Time runs from the last Sunday
 * in March to the last Sunday in October", and it is obviously correct until
 * the year Parliament moves it — which has happened, and which nobody would
 * notice here until a client's certificate reminder went out an hour early for
 * seven months. It is also wrong for every other zone, and `reminder_rules`
 * carries a `timezone` column precisely because a second client will not be in
 * London.
 *
 * Instead the offset is MEASURED from the platform's own IANA database with
 * `Intl.DateTimeFormat`, using the standard probe: format the instant into the
 * target zone, read the wall clock back, and take the difference between that
 * wall clock read as if it were UTC and the instant itself. That difference IS
 * the zone's offset at that instant, whatever the rule, whatever the year.
 *
 * The reverse direction — wall clock to instant — is what actually needs care,
 * because it is not a function. Twice a year a local time is ambiguous (the
 * hour repeated when the clocks go back) or non-existent (the hour skipped when
 * they go forward). `zonedWallClockToUtc` resolves both explicitly rather than
 * letting whichever answer the arithmetic happens to converge on decide:
 *
 *   · AMBIGUOUS -> the EARLIER of the two instants. A reminder that could fire
 *     at either 01:30 BST or 01:30 GMT fires at the first one. Choosing "later"
 *     would mean the one day a year a reminder is quietly an hour late.
 *   · NON-EXISTENT -> shifted FORWARD by the gap, so 01:30 on a spring Sunday
 *     becomes 02:30. Never dropped. A reminder that silently does not exist is
 *     the worst outcome available, and this is the same rule Temporal calls
 *     "compatible" disambiguation.
 *
 * ── EVERYTHING HERE IS PURE ────────────────────────────────────────────────
 *
 * No database, no fetch, no clock of its own. `now` is a parameter everywhere
 * it is needed, because "is this reminder in the past" is a question a test has
 * to be able to ask about a fixed moment, and because the cron and the modal's
 * preview panel must answer it identically.
 */

/** `YYYY-MM-DD`, the shape the anchor columns store. */
export type IsoDate = string;

/** `HH:MM`, 24-hour, the shape `reminder_rules.send_time` stores. */
export type ClockTime = string;

export type OffsetUnit = "day" | "week" | "month";
export type OffsetDirection = "before" | "after" | "on";

export interface ReminderOffset {
  value: number;
  unit: OffsetUnit;
  direction: OffsetDirection;
}

/**
 * The zone every column defaults to, and the only one the product currently
 * uses. Named rather than inlined so the eventual second client is one
 * argument away rather than a search-and-replace.
 */
export const DEFAULT_TIMEZONE = "Europe/London";

/** `reminder_rules.send_time` default, and the whole cascade's default. */
export const DEFAULT_SEND_TIME: ClockTime = "08:00";

/** `reminder_rules.repeat_interval_days` / `repeat_cap` defaults, from §7.1. */
export const DEFAULT_REPEAT_INTERVAL_DAYS = 3;
export const DEFAULT_REPEAT_CAP = 10;

/**
 * The spec's quiet window (§7.4): sends outside 07:00–19:00 local are
 * suppressed. Half-open, `[start, end)` — 07:00 sends, 19:00 does not.
 *
 * The convention has to be stated somewhere or the answer at exactly 19:00
 * depends on which comparison a future reader writes, and a reminder that
 * behaves differently on the boundary minute is a support ticket nobody can
 * reproduce. Half-open is chosen because it is the same convention the expiry
 * bands and every other range in this codebase use.
 */
export const QUIET_HOURS_WINDOW = { start: "07:00", end: "19:00" } as const;

export interface QuietHoursSettings {
  /**
   * Quiet hours are an ADMIN SETTING and default to off. An absent or disabled
   * settings object suppresses nothing — silently deferring everybody's sends
   * because a settings row had not been written yet would be a worse default
   * than sending at the time the operator actually typed in.
   */
  enabled?: boolean;
  startTime?: ClockTime;
  endTime?: ClockTime;
  suppressWeekends?: boolean;
  timezone?: string;
}

/** A local wall clock, as read out of a zone at a given instant. */
export interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the ZONE, which is the only weekday that
      means anything to "and optionally at weekends". */
  weekday: number;
  date: IsoDate;
  time: ClockTime;
  /** "BST" / "GMT" — carried so the preview panel can show the reader which
      side of the clock change a step lands on, rather than making them work it
      out from an offset. */
  zoneLabel: string;
}

/* ────────────────────────────────────────────── reading a zone with Intl ── */

const WALL_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const ZONE_LABEL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Formatters are expensive to construct and this runs once per reminder row on
 * a cron pass over the whole estate, so they are memoised per zone. Safe to
 * cache because an `Intl.DateTimeFormat` is immutable and the cache is keyed on
 * the only thing that varies.
 *
 * `hourCycle: "h23"` is deliberate. Under the h24 convention midnight formats
 * as "24:00" against the PREVIOUS day, which would put every midnight send a
 * day early. `wallClockAt` still normalises a 24 back, so the guard survives an
 * ICU build that ignores the request.
 */
function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = WALL_CLOCK_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    WALL_CLOCK_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function zoneLabelFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = ZONE_LABEL_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" });
    ZONE_LABEL_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Whether a `Date` is usable at all. `new Date("nonsense")` is a Date. */
export function isUsableInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * The local wall clock in `timeZone` at `instant`.
 *
 * This is the measurement everything else is built on, which is why it reads
 * the zone rather than doing arithmetic on the instant: there is no amount of
 * adding and subtracting that knows when a government moved its clocks.
 */
export function wallClockInZone(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): ZonedWallClock | null {
  if (!isUsableInstant(instant)) return null;

  const parts = wallClockFormatter(timeZone).formatToParts(instant);
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : Number.NaN;
  };

  let year = read("year");
  let month = read("month");
  let day = read("day");
  let hour = read("hour");
  const minute = read("minute");
  const second = read("second");

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  if (hour === 24) {
    /* h24's "24:00" belongs to the start of the FOLLOWING day, so rolling the
       date forward is the correction, not clamping the hour on its own. */
    const rolled = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
    hour = 0;
  }

  const zoneLabelPart = zoneLabelFormatter(timeZone)
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName");

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    time: `${pad2(hour)}:${pad2(minute)}`,
    zoneLabel: zoneLabelPart?.value ?? timeZone,
  };
}

/**
 * The zone's UTC offset, in milliseconds, AT a given instant.
 *
 * Positive east of Greenwich, so BST is +3_600_000 and GMT is 0. Derived by
 * reading the wall clock back and treating it as if it were UTC: the gap
 * between "what the clock says there" and "what the clock says here" is the
 * offset by definition.
 */
export function zoneOffsetMs(instant: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  const local = wallClockInZone(instant, timeZone);
  if (!local) return 0;
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  /* Truncated to the second because the formatter has no finer resolution;
     without this a sub-second instant would report an offset a few hundred
     milliseconds off and the equality tests below would never settle. */
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/* ─────────────────────────────────────────────────────── parsing the text ── */

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/**
 * `YYYY-MM-DD`, validated by ROUND TRIP rather than by regex alone.
 *
 * `Date.UTC(2026, 1, 31)` cheerfully returns the 3rd of March, so a regex that
 * accepts "2026-02-31" would silently anchor a certificate's whole cascade to a
 * day the reader never typed. Rebuilding the date and comparing is what makes
 * an impossible date an error instead of a surprise.
 */
export function parseIsoDate(value: unknown): DateParts | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  if (
    rebuilt.getUTCFullYear() !== year ||
    rebuilt.getUTCMonth() + 1 !== month ||
    rebuilt.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/**
 * `HH:MM`, or `HH:MM:SS` from a datetime-local input that appended seconds.
 *
 * The picker is on 15-minute steps but §7.1 says "free entry of any time
 * permitted", so nothing here rounds — a person who types 08:07 gets 08:07.
 */
export function parseClockTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** `send_time` as stored, or the 08:00 default when the column holds rubbish. */
export function normaliseClockTime(value: unknown): ClockTime {
  const parsed = parseClockTime(value);
  return parsed ? `${pad2(parsed.hour)}:${pad2(parsed.minute)}` : DEFAULT_SEND_TIME;
}

function minutesOfDay(value: unknown, fallback: ClockTime): number {
  const parsed = parseClockTime(value) ?? parseClockTime(fallback);
  return parsed ? parsed.hour * 60 + parsed.minute : 0;
}

/* ──────────────────────────────────────────────── wall clock -> instant ── */

/**
 * Far enough either side of the target to be certain of landing on the other
 * side of at most one transition, and close enough not to step over two. Two
 * days clears every offset in the IANA database (the largest is 14 hours) with
 * room, and no jurisdiction has ever changed its clocks twice inside 96 hours.
 */
const TRANSITION_PROBE_MS = 2 * 86_400_000;

/**
 * The UTC instant at which `date` `time` reads on the wall in `timeZone`.
 *
 * The naive instant — the wall clock read as if it were UTC — is off by exactly
 * the zone's offset, but which offset is the question the clock change makes
 * hard. So both candidate offsets are probed, both candidate instants are
 * tested for whether they actually render back as the requested wall clock, and
 * the ambiguous / non-existent cases are decided explicitly:
 *
 *   both valid   -> ambiguous, take the EARLIER
 *   one valid    -> the ordinary case, and the only one that happens 363 days
 *                   a year, where the two probes agree and both reduce to it
 *   neither      -> the spring gap, shift forward by taking the pre-transition
 *                   offset, which is always the smaller of the two
 */
export function zonedWallClockToUtc(
  date: IsoDate,
  time: ClockTime = DEFAULT_SEND_TIME,
  timeZone: string = DEFAULT_TIMEZONE,
): Date | null {
  const parts = parseIsoDate(date);
  const clock = parseClockTime(time);
  if (!parts || !clock) return null;

  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, clock.hour, clock.minute, 0);
  const before = zoneOffsetMs(new Date(naive - TRANSITION_PROBE_MS), timeZone);
  const after = zoneOffsetMs(new Date(naive + TRANSITION_PROBE_MS), timeZone);

  const fromBefore = naive - before;
  const fromAfter = naive - after;
  const beforeHolds = zoneOffsetMs(new Date(fromBefore), timeZone) === before;
  const afterHolds = zoneOffsetMs(new Date(fromAfter), timeZone) === after;

  if (beforeHolds && afterHolds) return new Date(Math.min(fromBefore, fromAfter));
  if (beforeHolds) return new Date(fromBefore);
  if (afterHolds) return new Date(fromAfter);
  return new Date(naive - Math.min(before, after));
}

/* ───────────────────────────────────────────────── anchor date arithmetic ── */

/**
 * The anchor date moved by an offset, still as a calendar date.
 *
 * Done in UTC-midnight milliseconds ON PURPOSE. Adding 90 days to a LOCAL
 * instant crosses a clock change and lands on 23:00 the day before, which
 * rounds a 90-day step into an 89-day one — the exact failure the calendar's
 * `calendarDaysBetween` already guards against. UTC has no transitions, so day
 * arithmetic there is exact, and the local time is reapplied afterwards by
 * `zonedWallClockToUtc`.
 *
 * `direction: "on"` ignores the value entirely: "on the expiry date" is a
 * statement about the anchor, not an offset of zero that a stray value could
 * contradict.
 *
 * A negative value is taken by MAGNITUDE. `offset_direction` carries the sign
 * in this schema, and letting a `-5` silently invert a "before" into an "after"
 * would move a reminder past the expiry it was supposed to prevent.
 */
export function shiftIsoDate(
  date: IsoDate,
  offset: ReminderOffset | null | undefined,
): IsoDate | null {
  const parts = parseIsoDate(date);
  if (!parts) return null;
  if (!offset || offset.direction === "on") {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  const sign = offset.direction === "before" ? -1 : 1;
  const magnitude = Math.abs(Math.trunc(Number(offset.value) || 0));

  if (offset.unit === "month") {
    /*
     * Clamped to the last day of the target month: three months before 31 May
     * is 28 February, not 3 March. Rolling into the following month would put
     * a compliance reminder on the wrong side of the month a reader is
     * thinking in, and for a February anchor it drifts further every year.
     */
    const monthIndex = parts.month - 1 + sign * magnitude;
    const year = parts.year + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(parts.day, lastDay);
    return `${year}-${pad2(month + 1)}-${pad2(day)}`;
  }

  const days = offset.unit === "week" ? magnitude * 7 : magnitude;
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + sign * days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * The instant one reminder step fires at.
 *
 * The whole engine in one line of composition: move the anchor by the offset as
 * a CALENDAR date, then pin the local send time onto it in the row's own zone.
 * Doing it the other way round — instant arithmetic on a UTC timestamp — is
 * what produces the 07:00 email in November.
 */
export function reminderOccurrenceUtc(
  anchorDate: IsoDate,
  offset: ReminderOffset | null | undefined,
  sendTime: ClockTime = DEFAULT_SEND_TIME,
  timezone: string = DEFAULT_TIMEZONE,
): Date | null {
  const shifted = shiftIsoDate(anchorDate, offset);
  if (!shifted) return null;
  return zonedWallClockToUtc(shifted, normaliseClockTime(sendTime), timezone || DEFAULT_TIMEZONE);
}

/* ────────────────────────────────────────────────────────── quiet hours ── */

/**
 * Whether `instant` falls in the suppressed window.
 *
 * "Quiet hours" names the period sends are NOT allowed, so this returns true
 * when the reminder must be held — outside 07:00–19:00 local, or at a weekend
 * when the admin has asked for that.
 */
export function isWithinQuietHours(
  instant: Date,
  settings: QuietHoursSettings | null | undefined,
): boolean {
  if (!settings || settings.enabled !== true) return false;
  const local = wallClockInZone(instant, settings.timezone || DEFAULT_TIMEZONE);
  if (!local) return false;

  if (settings.suppressWeekends === true && (local.weekday === 0 || local.weekday === 6)) {
    return true;
  }

  const start = minutesOfDay(settings.startTime, QUIET_HOURS_WINDOW.start);
  const end = minutesOfDay(settings.endTime, QUIET_HOURS_WINDOW.end);
  const at = local.hour * 60 + local.minute;
  return at < start || at >= end;
}

/**
 * The next permitted slot at or after `instant`. NEVER a cancellation.
 *
 * §7.4 is explicit that quiet hours defer rather than drop, and the distinction
 * matters more than it sounds: a 22:00 reminder that is merely skipped is a
 * compliance certificate nobody was told about, and the failure is invisible
 * because the row still says "sent" or, worse, still says "pending" forever.
 *
 * The target is always the window's OPENING time — 07:00 by default — rather
 * than the row's own send time, because the row's send time is what was
 * suppressed. Weekends are handled by re-asking the same question of each
 * following day rather than by counting: that way a future setting which
 * suppresses, say, bank holidays needs no change here.
 *
 * A window that never opens (start >= end, a misconfiguration) exhausts the
 * guard and returns the instant UNCHANGED. Sending at the operator's original
 * time is a smaller failure than a settings typo silently swallowing every
 * reminder in the system.
 */
export function deferPastQuietHours(
  instant: Date,
  settings: QuietHoursSettings | null | undefined,
): Date {
  if (!isUsableInstant(instant)) return instant;
  if (!isWithinQuietHours(instant, settings)) return instant;

  const timeZone = settings?.timezone || DEFAULT_TIMEZONE;
  const opening = normaliseClockTime(settings?.startTime ?? QUIET_HOURS_WINDOW.start);
  const local = wallClockInZone(instant, timeZone);
  if (!local) return instant;

  const openingMinutes = minutesOfDay(opening, QUIET_HOURS_WINDOW.start);
  const atMinutes = local.hour * 60 + local.minute;

  /* Before the window opens, today still has a slot; at or past it, the next
     one is tomorrow. A weekend-suppressed day is rejected by the loop below
     rather than special-cased here. */
  let date: IsoDate | null =
    atMinutes < openingMinutes
      ? local.date
      : shiftIsoDate(local.date, { value: 1, unit: "day", direction: "after" });

  for (let guard = 0; guard < 10 && date; guard += 1) {
    const candidate = zonedWallClockToUtc(date, opening, timeZone);
    if (candidate && !isWithinQuietHours(candidate, settings)) return candidate;
    date = shiftIsoDate(date, { value: 1, unit: "day", direction: "after" });
  }
  return instant;
}

/* ─────────────────────────────────────────────────────────── idempotency ── */

/**
 * The `reminder_dispatch.occurrence_date` half of `UNIQUE(reminder_id,
 * occurrence_date)`.
 *
 * GRANULARITY IS THE LOCAL CALENDAR DAY, and the choice has consequences worth
 * stating rather than discovering.
 *
 * What it buys: the cron double-firing is harmless, and harmless for free. Two
 * overlapping hourly invocations, a retry after a timeout, a replay of the same
 * hour when the clocks go back and 01:00 happens twice — every one of them
 * computes the same key for the same rule and the second insert is refused by
 * the database, not by an application check that races itself.
 *
 * What it costs: one rule can send AT MOST ONCE PER LOCAL DAY. A repeat is
 * therefore floored at one day in `nextRepeatOccurrence`, and a hypothetical
 * "chase every 4 hours" cannot be expressed — it would collapse to one send and
 * look like a bug. The spec's intervals are 3 days and 7 days, so nothing in
 * scope is constrained by this, but a future hourly escalation would need a
 * finer key and a matching migration.
 *
 * The LOCAL date, not the UTC one, because a 00:30 send in BST is 23:30Z the
 * previous day and the pair "the reminder for Tuesday" / "the row that proves
 * it went" must agree with what the reader saw in the email.
 */
export function occurrenceKey(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string | null {
  const local = wallClockInZone(instant, timeZone || DEFAULT_TIMEZONE);
  return local ? local.date : null;
}

/* ───────────────────────────────────────────────────────────── repeating ── */

/**
 * A `reminder_rules` row as the Worker reads it back.
 *
 * Snake case because that is what the column names are and this is fed straight
 * from a `SELECT *`. The booleans are typed `unknown` deliberately: the same
 * row arrives as SQLite `0/1` locally and as a Postgres boolean deployed —
 * `BOOLEAN_COLUMNS` in `db/sqlite-to-postgres.ts` translates the write, not the
 * read — so anything here that tested `=== 1` would be correct on exactly one
 * of the two databases.
 */
export interface ReminderRuleRow {
  id?: string;
  step_key?: string | null;
  is_enabled?: unknown;
  offset_value?: number | string | null;
  offset_unit?: string | null;
  offset_direction?: string | null;
  send_time?: string | null;
  timezone?: string | null;
  repeat_enabled?: unknown;
  repeat_interval_days?: number | string | null;
  repeat_cap?: number | string | null;
  sends_count?: number | string | null;
  next_send_at?: string | null;
  status?: string | null;
  acknowledged_at?: string | null;
}

/** Both dialects' idea of true, and nothing else's. */
export function flagIsTrue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return text === "1" || text === "true" || text === "t" || text === "yes";
  }
  return false;
}

function intOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function isSet(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

/** The statuses at which a rule is finished and nothing further is scheduled. */
export const TERMINAL_REMINDER_STATUSES = ["acknowledged", "cancelled", "superseded"] as const;

/**
 * When the repeat loop fires next, or null when it must stop.
 *
 * Four independent stops, checked in the order a reader would want them
 * explained, and the FIRST of them is the one the acceptance criteria name:
 * acknowledgement stops the loop IMMEDIATELY, before the cap or the interval
 * are even consulted. Somebody has said "I have this" and the system continuing
 * to email them every three days is precisely how a compliance alert becomes
 * something people filter to a folder.
 *
 * The next occurrence keeps the row's LOCAL send time rather than adding
 * `interval × 86400000` milliseconds to the last send. Three days after 08:00
 * on 24 October is 08:00 on 27 October — which is a different number of elapsed
 * hours, because the clocks changed in between, and the milliseconds answer
 * would be an email at 07:00.
 */
export function nextRepeatOccurrence(
  rule: ReminderRuleRow,
  lastSentInstant: Date,
): Date | null {
  if (!rule || !isUsableInstant(lastSentInstant)) return null;
  if (!flagIsTrue(rule.repeat_enabled)) return null;
  if (isSet(rule.acknowledged_at)) return null;

  const status = String(rule.status ?? "pending").trim().toLowerCase();
  if ((TERMINAL_REMINDER_STATUSES as readonly string[]).includes(status)) return null;

  const cap = intOr(rule.repeat_cap, DEFAULT_REPEAT_CAP);
  const sends = intOr(rule.sends_count, 0);
  if (sends >= cap) return null;

  /* Floored at a day because `occurrenceKey` is a local date; see its header.
     A stored 0 would otherwise schedule the same key forever and every send
     after the first would be refused by the unique index without explanation. */
  const interval = Math.max(1, intOr(rule.repeat_interval_days, DEFAULT_REPEAT_INTERVAL_DAYS));
  const timeZone = rule.timezone || DEFAULT_TIMEZONE;
  const local = wallClockInZone(lastSentInstant, timeZone);
  if (!local) return null;

  const nextDate = shiftIsoDate(local.date, { value: interval, unit: "day", direction: "after" });
  if (!nextDate) return null;

  /* The row's configured time wins; the time it actually went out is the
     fallback, so a row whose `send_time` was corrupted still repeats on a
     sensible clock instead of jumping to 08:00 without being asked. */
  const sendTime = parseClockTime(rule.send_time) ? normaliseClockTime(rule.send_time) : local.time;
  return zonedWallClockToUtc(nextDate, sendTime, timeZone);
}

/* ────────────────────────────────────────────────────────── past and gone ── */

/**
 * §7.4: "a row whose calculated date is in the past … is never sent."
 *
 * The modal shows the warning and the cron must agree with it, so both ask this
 * one function rather than each writing its own comparison — a preview that
 * says "won't be sent" beside a cron that sends anyway is worse than either
 * behaviour on its own.
 *
 * An UNCOMPUTABLE date answers true. It will not be sent either, and returning
 * false would let the cron treat a row it cannot schedule as due right now,
 * which is the one way this could turn into a burst of stale email.
 */
export function isPastAndWillNotSend(occurrenceUtc: Date | null | undefined, now: Date): boolean {
  if (!isUsableInstant(occurrenceUtc)) return true;
  if (!isUsableInstant(now)) return false;
  return occurrenceUtc.getTime() < now.getTime();
}
