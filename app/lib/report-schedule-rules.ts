/**
 * WHEN A SCHEDULED REPORT RUNS, AND WHAT PERIOD IT COVERS — §32.
 *
 * Importless, so the tests CALL these rather than restating them. Everything is
 * a whole UTC day (`YYYY-MM-DD`): the dispatcher runs once a day, so a schedule
 * is "due" on a day, never at an hour.
 *
 * THE FIRST RUN IS THE NEXT MATCHING DAY STRICTLY AFTER TODAY. A schedule made
 * at 09:00 on a Monday for "every Monday" does not fire an hour later on a run
 * that already happened; it waits a week. "Send now" exists for the impatient.
 */

export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const REPORT_PERIODS = {
  last_7_days: "The last 7 days",
  last_30_days: "The last 30 days",
  month_to_date: "This month so far",
  last_month: "Last calendar month",
} as const;
export type ReportPeriod = keyof typeof REPORT_PERIODS;

export const SCHEDULE_STATES = ["active", "paused"] as const;
export const MAX_RECIPIENTS = 20;

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return iso(new Date(Date.UTC(y, m - 1, d + days)));
}

/** 1 = Monday … 7 = Sunday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = parts(day);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export type CadenceRule = { cadence: string; weekday?: number | null; monthDay?: number | null };

/** The first day strictly after `after` on which this schedule runs, or null if the rule is not valid. */
export function nextRunOn(rule: CadenceRule, after: string): string | null {
  if (rule.cadence === "daily") return addDays(after, 1);
  if (rule.cadence === "weekly") {
    const weekday = Number(rule.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    const gap = ((weekday - weekdayOf(after) + 7) % 7) || 7;
    return addDays(after, gap);
  }
  if (rule.cadence === "monthly") {
    const monthDay = Number(rule.monthDay);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28) return null;
    const [y, m, d] = parts(after);
    const thisMonth = iso(new Date(Date.UTC(y, m - 1, monthDay)));
    return d < monthDay ? thisMonth : iso(new Date(Date.UTC(y, m, monthDay)));
  }
  return null;
}

/**
 * The window a run on `runDay` reports on, as the Reports page's `from`/`to`.
 * Always ends YESTERDAY at the latest: a report sent at dawn about "today"
 * would describe a day that has barely started.
 */
export function periodWindow(period: string, runDay: string): { from: string; to: string } | null {
  const yesterday = addDays(runDay, -1);
  if (period === "last_7_days") return { from: addDays(runDay, -7), to: yesterday };
  if (period === "last_30_days") return { from: addDays(runDay, -30), to: yesterday };
  if (period === "month_to_date") {
    /* On the 1st, "this month so far" is empty; report the whole last month. */
    const [y, m] = parts(yesterday);
    return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: yesterday };
  }
  if (period === "last_month") {
    const [y, m] = parts(runDay);
    return {
      from: iso(new Date(Date.UTC(y, m - 2, 1))),
      to: iso(new Date(Date.UTC(y, m - 1, 0))),
    };
  }
  return null;
}

export type ScheduleInput = {
  name?: unknown;
  period?: unknown;
  cadence?: unknown;
  weekday?: unknown;
  monthDay?: unknown;
  recipients?: unknown;
  state?: unknown;
};

/** Validated fields for a create or an edit, or the reason in words. */
export function validateSchedule(
  input: ScheduleInput,
  existing: { name: string; period: string; cadence: string; weekday: number | null; monthDay: number | null; recipients: string; state: string } | null,
): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  const fields: Record<string, unknown> = {};
  const has = (key: keyof ScheduleInput) => key in input && input[key] !== undefined;
  if (has("name") || !existing) {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (!name) return { ok: false, error: "Give the schedule a name." };
    fields.name = name;
  }
  if (has("period") || !existing) {
    const period = String(input.period ?? "");
    if (!(period in REPORT_PERIODS)) return { ok: false, error: "Choose which period the report covers." };
    fields.period = period;
  }
  if (has("cadence") || !existing) {
    const cadence = String(input.cadence ?? "");
    if (!(REPORT_CADENCES as readonly string[]).includes(cadence)) {
      return { ok: false, error: "Choose daily, weekly or monthly." };
    }
    fields.cadence = cadence;
  }
  if (has("weekday")) fields.weekday = input.weekday === null || input.weekday === "" ? null : Number(input.weekday);
  if (has("monthDay")) fields.monthDay = input.monthDay === null || input.monthDay === "" ? null : Number(input.monthDay);
  if (has("state")) {
    const state = String(input.state);
    if (!(SCHEDULE_STATES as readonly string[]).includes(state)) return { ok: false, error: "A schedule is active or paused." };
    fields.state = state;
  }
  if (has("recipients") || !existing) {
    const list = Array.isArray(input.recipients) ? input.recipients : [];
    const ids = [...new Set(list.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
    if (!ids.length) return { ok: false, error: "Choose at least one person to send it to." };
    if (ids.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
    fields.recipients = JSON.stringify(ids);
  }
  const rule = {
    cadence: String(fields.cadence ?? existing?.cadence ?? ""),
    weekday: ("weekday" in fields ? fields.weekday : existing?.weekday) as number | null,
    monthDay: ("monthDay" in fields ? fields.monthDay : existing?.monthDay) as number | null,
  };
  if (rule.cadence === "weekly" && !(Number.isInteger(rule.weekday) && rule.weekday! >= 1 && rule.weekday! <= 7)) {
    return { ok: false, error: "Choose which day of the week it goes out." };
  }
  if (rule.cadence === "monthly" && !(Number.isInteger(rule.monthDay) && rule.monthDay! >= 1 && rule.monthDay! <= 28)) {
    return { ok: false, error: "Choose a day of the month from 1 to 28." };
  }
  return { ok: true, fields };
}
