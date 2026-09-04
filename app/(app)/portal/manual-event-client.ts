"use client";

/**
 * W11 — the browser's half of the manual calendar items.
 *
 * Every call `/api/maintenance/calendar` accepts, typed, and nothing else. A
 * screen that hand-rolls its own `fetch("/api/maintenance/calendar")` is a
 * screen that will eventually forget one of the three rules below, so the whole
 * surface goes through this.
 *
 *   THE SERVER'S OWN SENTENCE IS SHOWN. "The end date cannot be before the
 *   start date." is an instruction; replacing it with wording of our own would
 *   leave somebody guessing at a rule the server already stated. Same decision,
 *   for the same reason, as `RegisterError` in `register/register-client.ts`.
 *
 *   A MOVE SENDS ONLY THE START. The route moves `ends_on` by the same number
 *   of days, so a three-day item stays three days long — see `nextRange` there.
 *   Sending both dates means "these are the dates", which is a resize, and the
 *   two must not be spelled the same way by accident.
 *
 *   OMITTED IS NOT CLEARED. `updateManualEvent` sends only the fields it is
 *   given, so `{}` changes nothing and `{ notes: null }` clears the note. The
 *   Sites write paths were bitten four times by the opposite convention.
 *
 * There is no React here on purpose: the dialog, the drag and the panel each
 * want their own component, and what they share is this.
 */

import type { ManualCalendarItem } from "./calendar-model";

const ENDPOINT = "/api/maintenance/calendar";

/** Thrown with the server's own sentence in it. See the header. */
export class ManualEventError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ManualEventError";
    this.status = status;
  }
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /*
     * A body that is not JSON is a proxy page or a stack trace, and the first
     * 200 characters of one is more useful to whoever is reading the toast than
     * "Unexpected token < in JSON". The same shape `readJson` uses next door.
     */
    parsed = { error: raw.slice(0, 200) };
  }
  if (!response.ok) {
    throw new ManualEventError(
      response.status,
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : "That calendar item could not be saved.",
    );
  }
  return parsed;
}

/** Every live manual item of this workspace, oldest start first. */
export async function fetchManualEvents(options: {
  archived?: boolean;
  deleted?: boolean;
} = {}): Promise<ManualCalendarItem[]> {
  const query = new URLSearchParams();
  if (options.archived) query.set("archived", "include");
  if (options.deleted) query.set("deleted", "include");
  const suffix = query.toString();
  const body = await send("GET", suffix ? `${ENDPOINT}?${suffix}` : ENDPOINT);
  return Array.isArray(body.events) ? (body.events as ManualCalendarItem[]) : [];
}

export type ManualEventDraft = {
  title: string;
  notes?: string | null;
  siteId?: string | null;
  startsOn: string;
  endsOn?: string | null;
  category?: string;
  colour?: string | null;
};

export async function createManualEvent(
  draft: ManualEventDraft,
): Promise<ManualCalendarItem | null> {
  const body = await send("POST", ENDPOINT, { data: draft });
  return (body.event as ManualCalendarItem | null) ?? null;
}

/**
 * Change one item. Only the keys present are written.
 *
 * `Partial<ManualEventDraft>` and not the draft type, because the whole point
 * is that a caller may send one field: the drag sends `startsOn` alone, the
 * archive control sends `archived` alone, and the dialog sends the lot.
 */
export async function updateManualEvent(
  id: string,
  data: Partial<ManualEventDraft> & { archived?: boolean },
): Promise<ManualCalendarItem | null> {
  const body = await send("PATCH", ENDPOINT, { id, data });
  return (body.event as ManualCalendarItem | null) ?? null;
}

/**
 * MOVE — the drag's write, and the only call that should ever make it.
 *
 * Named rather than left to `updateManualEvent(id, { startsOn })` so the
 * distinction between a MOVE and a RESIZE is visible at the call site: this
 * sends the start alone on purpose, and the route reads that as "keep the
 * length". A caller that meant to change the end sends both through
 * `updateManualEvent` and gets exactly what it asked for.
 */
export async function moveManualEvent(
  id: string,
  startsOn: string,
): Promise<ManualCalendarItem | null> {
  return updateManualEvent(id, { startsOn });
}

/**
 * Remove — soft, and reversible through `restoreManualEvent`.
 *
 * The route stamps `deleted_at` and `deleted_by` rather than deleting the row.
 * A calendar item is the easiest thing on the screen to remove by accident: a
 * small chip, a control beside the one that opens it, and no other copy of what
 * it said.
 */
export async function deleteManualEvent(id: string): Promise<void> {
  await send("DELETE", `${ENDPOINT}?id=${encodeURIComponent(id)}`);
}

export async function restoreManualEvent(
  id: string,
): Promise<ManualCalendarItem | null> {
  const body = await send("PATCH", ENDPOINT, { id, restore: true });
  return (body.event as ManualCalendarItem | null) ?? null;
}
