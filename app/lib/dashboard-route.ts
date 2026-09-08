/**
 * The four lines every `/api/dashboard/*` handler would otherwise repeat.
 *
 * Boot the database, resolve the organisation-scoped handle through the
 * capability the Jobs board is gated on, parse the filter state out of the URL
 * with the SAME parser the browser serialises it with, and turn the two failure
 * modes this product distinguishes into the two answers it distinguishes them
 * with — 401 for a session that has ended, 503 for a database that has not.
 *
 * `board.view` rather than a new capability: these endpoints aggregate the job
 * board and nothing else, so anyone who may read the board may read a count of
 * it, and inventing a second capability for the same rows would be a permission
 * an administrator has to keep in step by hand.
 */

import { ensureDatabase } from "../../db/init";
import { anonymousRefusal, scopedDbWithCapability, type ScopedDatabase } from "./tenant-db";
import {
  parseFilters,
  resolveWindow,
  type DashboardFilters,
  type PeriodWindow,
} from "./dashboard-filters";

export type DashboardScope = {
  scope: ScopedDatabase;
  filters: DashboardFilters;
  window: PeriodWindow;
  /**
   * ONE instant for the whole response.
   *
   * `new Date()` called again inside a loop drifts, and on a payload that
   * classifies jobs into day-width ageing bands that drift can put two jobs
   * raised in the same minute in two different bands. Every function that needs
   * "now" is handed this one.
   */
  now: Date;
  url: URL;
};

export async function dashboardScope(
  request: Request,
): Promise<{ ok: true; value: DashboardScope } | { ok: false; response: Response }> {
  await ensureDatabase();
  const guard = await scopedDbWithCapability(request, "board.view");
  if (guard.denied) return { ok: false, response: guard.denied };
  const url = new URL(request.url);
  const filters = parseFilters(url);
  const now = new Date();
  return {
    ok: true,
    value: {
      scope: guard.scope,
      filters,
      window: resolveWindow(filters.period, filters.from, filters.to, now),
      now,
      url,
    },
  };
}

/**
 * The catch every handler ends with. A dead session is not an outage.
 *
 * The message is deliberately not `error.message`. Drizzle's wrapper message is
 * the whole failing statement, and returning it verbatim published the schema —
 * table and column names — to whoever opened the page, including an
 * unauthenticated visitor on a shared link. `/api/sites` was found doing exactly
 * that. Raw text is development-only, as it is there.
 */
export function dashboardFailure(error: unknown): Response {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const message = error instanceof Error ? error.message : "Unexpected error";
  /*
   * LOGGED, BECAUSE THE READER OF THIS RESPONSE CANNOT BE TOLD.
   *
   * The message below is deliberately generic — a database error can name a
   * column, a table or a constraint, and none of that belongs in a browser. But
   * the version of this function that only returned that sentence made the
   * Production outage of 2026-09-08 undiagnosable: two cards said "temporarily
   * unavailable" for hours and the runtime logs held nothing at all, because
   * this was the only place the error ever reached.
   *
   * `cause` is printed separately and matters more than `message`. Drizzle
   * wraps a driver failure as `Failed query: <sql> params: <params>` and hangs
   * the real error — the missing column, the pooler refusal, the constraint —
   * off `cause`, so a log line that prints only `message` prints the SQL and
   * omits the reason it failed.
   */
  console.error("[dashboard] request failed:", error);
  if (error instanceof Error && error.cause) {
    console.error("[dashboard] cause:", error.cause);
  }
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development"
          ? `Preview database error: ${message}`
          : "The dashboard is temporarily unavailable.",
    },
    { status: 503 },
  );
}

/** The window, as the shape every payload echoes back so a card can label itself. */
export function windowPayload(window: PeriodWindow) {
  return {
    key: window.key,
    label: window.label,
    start: window.start,
    endExclusive: window.endExclusive,
    days: window.days,
    hasPrevious: window.previous !== null,
  };
}
