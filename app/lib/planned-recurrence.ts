/**
 * PLANNED-MAINTENANCE RECURRENCE — the calendar arithmetic and the decision
 * whether a schedule's next visit is due to become a job. §25.
 *
 * Importless on purpose: every rule here is a pure function of a schedule and
 * a date, so the tests CALL it rather than re-stating it, and the generator
 * (`planned-generation.ts`) and the workspace route that saves a schedule both
 * ask the same functions the same questions.
 *
 * THE OWNER'S DECISION Q4 (2026-09-21), which is the whole specification:
 *
 *   · CALENDAR-DRIVEN. The next visit is generated on time even if the previous
 *     one is still open. A late job does not push the calendar.
 *   · ONE OCCURRENCE AT A TIME, created at (next due − lead time). No long
 *     pre-generated series.
 *   · DUPLICATES PREVENTED by a stable (schedule, due date) uniqueness rule —
 *     the `planned_occurrences_once_idx` index, not a SELECT-then-INSERT.
 *   · EXPLICIT PER-SCHEDULE OPT-IN. `generation_state` is `paused` or `active`,
 *     and every schedule that existed before this shipped defaults to paused:
 *     nothing starts generating because a deploy happened.
 *
 * WHY AN ANCHOR. "Monthly from 31 January" must visit on 28 February and then
 * on 31 March — not on the 28th for ever after. Stepping from the last visit
 * loses the day at the first short month; stepping from the ANCHOR (the date
 * the schedule was set to repeat from) and clamping each occurrence to its
 * month's length keeps it. `recurrence_anchor` is written whenever the
 * schedule's repeat pattern is (re)defined.
 */

export const PLANNED_FREQUENCIES = [
  "One-off",
  "Daily",
  "Weekly",
  "Fortnightly",
  "Monthly",
  "Quarterly",
  "Biannual",
  "Annual",
  "Custom",
] as const;

export const GENERATION_STATES = ["paused", "active"] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];

export const DEFAULT_LEAD_DAYS = 14;
export const MAX_LEAD_DAYS = 365;
export const MAX_INTERVAL_DAYS = 3650;

/** Statuses on which a schedule never generates, whatever its switch says. */
export const STOPPED_STATUSES = ["Cancelled", "On hold"] as const;

export type RecurrenceStep = { days: number } | { months: number };

const STEPS: Record<string, RecurrenceStep> = {
  Daily: { days: 1 },
  Weekly: { days: 7 },
  Fortnightly: { days: 14 },
  Monthly: { months: 1 },
  Quarterly: { months: 3 },
  Biannual: { months: 6 },
  Annual: { months: 12 },
};

/**
 * How one schedule repeats, or `null` when it does not.
 *
 * `One-off` does not repeat. `Custom` repeats every `intervalDays` days and is
 * `null` without a usable interval. Any other text — the column has been free
 * text since it was created — is not a frequency the generator understands,
 * and is `null` too; the save path refuses to switch such a schedule on.
 */
export function recurrenceStep(
  frequency: string | null | undefined,
  intervalDays?: number | null,
): RecurrenceStep | null {
  if (frequency === "Custom") {
    const days = Number(intervalDays);
    return Number.isInteger(days) && days >= 1 && days <= MAX_INTERVAL_DAYS ? { days } : null;
  }
  return (frequency && STEPS[frequency]) || null;
}

/** `YYYY-MM-DD` from a stored date or timestamp, or `null` when it is not one. */
export function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Today in UTC, as `YYYY-MM-DD`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The `k`-th occurrence counted from the anchor (k = 0 is the anchor itself). */
export function occurrence(anchor: string, step: RecurrenceStep, k: number): string {
  if ("days" in step) return addDays(anchor, step.days * k);
  const [y, m, d] = parts(anchor);
  const monthIndex = m - 1 + step.months * k;
  const year = y + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** A lower bound for `k` so the searches below start near the answer. */
function estimate(anchor: string, step: RecurrenceStep, day: string): number {
  if ("days" in step) {
    const [ay, am, ad] = parts(anchor);
    const [dy, dm, dd] = parts(day);
    const span = (Date.UTC(dy, dm - 1, dd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
    return Math.max(0, Math.floor(span / step.days) - 1);
  }
  const [ay, am] = parts(anchor);
  const [dy, dm] = parts(day);
  return Math.max(0, Math.floor(((dy - ay) * 12 + (dm - am)) / step.months) - 1);
}

/** The first occurrence on or after `day`. */
export function firstOccurrenceOnOrAfter(anchor: string, step: RecurrenceStep, day: string): string {
  for (let k = estimate(anchor, step, day); ; k += 1) {
    const candidate = occurrence(anchor, step, k);
    if (candidate >= day) return candidate;
  }
}

/** The first occurrence strictly after `day`. */
export function nextOccurrenceAfter(anchor: string, step: RecurrenceStep, day: string): string {
  for (let k = estimate(anchor, step, day); ; k += 1) {
    const candidate = occurrence(anchor, step, k);
    if (candidate > day) return candidate;
  }
}

/** What the generator needs to know about one schedule. */
export type RecurringSchedule = {
  generationState: string | null;
  status: string | null;
  frequency: string | null;
  intervalDays: number | null;
  nextDueAt: string | null;
  leadDays: number | null;
  recurrenceAnchor: string | null;
  lastGeneratedDueAt: string | null;
};

export type GenerationPlan =
  | { generate: true; dueDate: string; opensOn: string }
  | {
      generate: false;
      reason: "paused" | "stopped" | "no-date" | "unknown-frequency" | "already-generated" | "not-yet";
      opensOn?: string;
    };

/**
 * Whether this schedule's next visit becomes a job today.
 *
 * Only ever the ONE visit in `next_due_at`. The generator advances that column
 * after it creates the job, so the following visit is considered on a later
 * run, when its own lead window opens.
 */
export function planGeneration(schedule: RecurringSchedule, today: string): GenerationPlan {
  if (schedule.generationState !== "active") return { generate: false, reason: "paused" };
  if (schedule.status && (STOPPED_STATUSES as readonly string[]).includes(schedule.status)) {
    return { generate: false, reason: "stopped" };
  }
  const due = isoDay(schedule.nextDueAt);
  if (!due) return { generate: false, reason: "no-date" };
  if (schedule.frequency !== "One-off" && !recurrenceStep(schedule.frequency, schedule.intervalDays)) {
    return { generate: false, reason: "unknown-frequency" };
  }
  if (isoDay(schedule.lastGeneratedDueAt) === due) {
    return { generate: false, reason: "already-generated" };
  }
  const lead = clampLeadDays(schedule.leadDays);
  const opensOn = addDays(due, -lead);
  if (today < opensOn) return { generate: false, reason: "not-yet", opensOn };
  return { generate: true, dueDate: due, opensOn };
}

/**
 * Where `next_due_at` moves once the visit due on `generatedDue` exists.
 *
 * CALENDAR-DRIVEN: the next occurrence after the one just generated, counted
 * from the anchor — never from when the job was done. A one-off stays where it
 * is; `last_generated_due_at` is what stops it generating twice.
 *
 * NO BACK-FILL. If the next occurrence is already in the past — the generator
 * was down for longer than a whole period — the calendar moves forward to the
 * first occurrence today or later, and the missed visits are NOT created in a
 * burst. One occurrence at a time, including when catching up.
 */
export function advanceAfterGeneration(
  schedule: Pick<RecurringSchedule, "frequency" | "intervalDays" | "recurrenceAnchor">,
  generatedDue: string,
  today: string,
): string {
  const step = recurrenceStep(schedule.frequency, schedule.intervalDays);
  if (!step) return generatedDue;
  const anchor = isoDay(schedule.recurrenceAnchor) ?? generatedDue;
  const next = nextOccurrenceAfter(anchor, step, generatedDue);
  return next >= today ? next : firstOccurrenceOnOrAfter(anchor, step, today);
}

export function clampLeadDays(value: unknown): number {
  const lead = Number(value);
  if (!Number.isFinite(lead)) return DEFAULT_LEAD_DAYS;
  return Math.min(MAX_LEAD_DAYS, Math.max(0, Math.round(lead)));
}

/** The recurrence columns a save may carry. */
export type RecurrenceInput = {
  generationState?: unknown;
  leadDays?: unknown;
  intervalDays?: unknown;
  frequency?: unknown;
  nextDueAt?: unknown;
};

export type RecurrenceFields = {
  generationState?: GenerationState;
  leadDays?: number;
  intervalDays?: number | null;
  recurrenceAnchor?: string | null;
  nextDueAt?: string;
};

/**
 * The recurrence columns to write when a schedule is created or edited.
 *
 * `existing` is null on create. Only what the save touches is returned, so a
 * PATCH that changes the title leaves every recurrence column alone.
 *
 *   · Switching ON needs a real date, and a frequency the generator
 *     understands (or One-off). Refused with words otherwise — a switch that
 *     reports itself on and never generates is the failure this prevents.
 *   · The ANCHOR is re-taken from `next_due_at` whenever the pattern is
 *     (re)defined: switched on, or its frequency, interval or date edited.
 *   · Switching a RECURRING schedule on with a date in the past rolls the date
 *     forward to the first occurrence today or later — so enabling a schedule
 *     last touched a year ago creates one job for the coming visit, not twelve
 *     for the ones nobody wanted.
 */
export function recurrenceOnSave(
  input: RecurrenceInput,
  existing: {
    generationState: string | null;
    frequency: string | null;
    intervalDays: number | null;
    nextDueAt: string | null;
    recurrenceAnchor: string | null;
  } | null,
  today: string,
): { ok: true; fields: RecurrenceFields } | { ok: false; error: string } {
  const fields: RecurrenceFields = {};
  const has = (key: keyof RecurrenceInput) => key in input && input[key] !== undefined;

  if (has("generationState")) {
    const state = String(input.generationState);
    if (!(GENERATION_STATES as readonly string[]).includes(state)) {
      return { ok: false, error: "Auto-create must be either paused or active." };
    }
    fields.generationState = state as GenerationState;
  } else if (!existing) {
    fields.generationState = "paused";
  }
  if (has("leadDays")) fields.leadDays = clampLeadDays(input.leadDays);
  if (has("intervalDays")) {
    const raw = input.intervalDays;
    if (raw === null || raw === "") {
      fields.intervalDays = null;
    } else {
      const days = Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > MAX_INTERVAL_DAYS) {
        return { ok: false, error: `A custom interval must be a whole number of days between 1 and ${MAX_INTERVAL_DAYS}.` };
      }
      fields.intervalDays = days;
    }
  }

  const state = fields.generationState ?? existing?.generationState ?? "paused";
  const frequency = has("frequency") ? String(input.frequency ?? "") : existing?.frequency ?? "";
  const intervalDays = "intervalDays" in fields ? fields.intervalDays ?? null : existing?.intervalDays ?? null;
  const rawDue = has("nextDueAt") ? input.nextDueAt : existing?.nextDueAt;

  const switchedOn = state === "active" && existing?.generationState !== "active";
  /*
   * CHANGED, NOT MERELY SENT. The editor posts every field on every save, so
   * "the request carried a date" says nothing. Re-taking the anchor on an
   * unchanged save would move it to wherever the calendar has stepped to —
   * 28 February, after a clamp — and a schedule on the 31st would drift to
   * the 28th for ever. Only a value that differs from what is stored counts.
   */
  const frequencyChanged = has("frequency") && frequency !== (existing?.frequency ?? "");
  const intervalChanged = "intervalDays" in fields && intervalDays !== (existing?.intervalDays ?? null);
  const dueChanged = has("nextDueAt") && isoDay(rawDue) !== isoDay(existing?.nextDueAt);
  const patternChanged = !existing || switchedOn || frequencyChanged || intervalChanged || dueChanged;

  if (state === "active") {
    const due = isoDay(rawDue);
    if (!due) return { ok: false, error: "Auto-create needs a next due date." };
    const step = recurrenceStep(frequency, intervalDays);
    if (frequency !== "One-off" && !step) {
      return {
        ok: false,
        error:
          frequency === "Custom"
            ? "A custom schedule needs an interval in days before it can auto-create jobs."
            : `Auto-create needs a frequency it can repeat on (${PLANNED_FREQUENCIES.join(", ")}).`,
      };
    }
    if (patternChanged) {
      fields.recurrenceAnchor = due;
      if (switchedOn && step && due < today) {
        fields.nextDueAt = firstOccurrenceOnOrAfter(due, step, today);
      }
    }
  } else if (patternChanged && isoDay(rawDue)) {
    /* A paused schedule keeps a truthful anchor too, so switching it on later
       does not step from a date nobody recognises. */
    fields.recurrenceAnchor = isoDay(rawDue);
  }
  return { ok: true, fields };
}
