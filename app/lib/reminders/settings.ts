/**
 * QUIET HOURS — where the setting lives, and why not in a table of its own.
 *
 * `workspace_settings.settings` is already a per-organisation JSON blob that
 * the workspace route reads and writes, and quiet hours are exactly the shape
 * of thing it holds: one small object, read on a path that already reads it,
 * changed rarely, and never queried across organisations. A `reminder_settings`
 * table would have been a second migration, a second write path and a second
 * place to look, to store four fields.
 *
 * The blob is namespaced under `reminders` so this cannot collide with whatever
 * else the workspace stores there now or later.
 *
 * ── OFF BY DEFAULT, AND THAT IS DELIBERATE ─────────────────────────────────
 *
 * An organisation that has never opened the setting has no `reminders` key, and
 * `readQuietHours` returns `{ enabled: false }`. Every send then goes at the
 * time the operator typed. The opposite default — quiet hours on until somebody
 * turns them off — would silently move everybody's reminders on the strength of
 * a row that was never written, which is a change nobody asked for arriving as
 * a side effect of an upgrade.
 *
 * ── DEFERRED, NEVER DROPPED ────────────────────────────────────────────────
 *
 * Worth stating here because this is the file an operator's setting passes
 * through: quiet hours move a send to the next permitted slot. They never
 * cancel one. `deferPastQuietHours` in `schedule.ts` is what enforces that, and
 * §7.4 of the specification is explicit about it — a compliance reminder that
 * was suppressed rather than delayed is a reminder that did not happen.
 */

import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../../db/schema";
import type { QuietHoursSettings } from "./schedule";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per driver; the schema import is what types this query. */
type Db = any;

/** The key this feature owns inside the shared settings blob. */
export const REMINDER_SETTINGS_KEY = "reminders";

export type ReminderSettings = {
  quietHours: QuietHoursSettings;
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  quietHours: { enabled: false },
};

function readBlob(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    /*
     * A blob that will not parse is treated as absent rather than fatal. This
     * is read on the dispatch path, and a malformed settings row must not stop
     * every reminder in the estate — the safe reading is "no quiet hours
     * configured", which sends at the time the operator chose.
     */
    return {};
  }
}

function clock(value: unknown, fallback: string): string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

export function reminderSettingsFromBlob(raw: unknown): ReminderSettings {
  const blob = readBlob(raw);
  const section = blob[REMINDER_SETTINGS_KEY];
  if (!section || typeof section !== "object") return DEFAULT_REMINDER_SETTINGS;
  const quiet = (section as Record<string, unknown>).quietHours;
  if (!quiet || typeof quiet !== "object") return DEFAULT_REMINDER_SETTINGS;
  const q = quiet as Record<string, unknown>;
  return {
    quietHours: {
      enabled: q.enabled === true,
      startTime: clock(q.startTime, "07:00"),
      endTime: clock(q.endTime, "19:00"),
      suppressWeekends: q.suppressWeekends === true,
      timezone: typeof q.timezone === "string" && q.timezone ? q.timezone : "Europe/London",
    },
  };
}

export async function readReminderSettings(
  db: Db,
  organisationId: string,
): Promise<ReminderSettings> {
  const [row] = await db
    .select({ settings: workspaceSettings.settings })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.organisationId, organisationId))
    .limit(1);
  return reminderSettingsFromBlob(row?.settings);
}

/**
 * Merge the reminder section back into the blob without disturbing the rest.
 *
 * Read-modify-write on a shared JSON column is a lost-update risk, and it is
 * accepted here for a reason worth recording: this is an admin setting changed
 * by one person a handful of times a year, on the same blob the workspace route
 * has always written the same way. Introducing a different concurrency
 * discipline for one key would make this the odd one out without making the
 * column safe.
 */
export function mergeReminderSettings(raw: unknown, next: ReminderSettings): string {
  const blob = readBlob(raw);
  blob[REMINDER_SETTINGS_KEY] = next;
  return JSON.stringify(blob);
}
