/**
 * GET /api/dashboard/performance — §4's Performance over time.
 *
 * ── §4.1: THE ROOT CAUSE OF "The dashboard is temporarily unavailable." ────
 *
 * Diagnosed, not bypassed. The card failed on Production and on no other
 * estate, and once `dashboardFailure` was made to log `error.cause` the reason
 * was:
 *
 *     function pg_catalog.btrim(date) does not exist
 *     select count(*) from "maintenance_requests" where (… trim("due_at") …)
 *
 * `btrim` is what Postgres compiles `trim()` to. The SQL applied a STRING
 * function to a DATE column. `db/init.ts` declares `due_at`, `completed_at` and
 * `target_completion_date` as TEXT, so Staging and every local Miniflare file
 * have them as text and the statement ran; Production predates that
 * declaration and holds real Postgres `date` columns, where `trim(date)` does
 * not exist. Nothing on Staging could ever have shown it.
 *
 * What still guards against it: `dateText()` in `dashboard-aggregates.ts` is
 * the one canonical cast, `dashboard-filters.ts` keeps the identical
 * expression, `tests/ops-rebuild-foundations.test.mjs` pins the two renderings
 * character-for-character, and `tests/performance-legacy-date-types.test.mjs`
 * renders the predicate through the real Postgres dialect and asserts that no
 * bare `trim`/`substr`/`length`/`lower` ever reaches one of those columns.
 *
 * ── AND ONE MORE COLUMN THAN THAT REPAIR KNEW ABOUT ───────────────────────
 *
 * Measured while rebuilding this card: `requested_at`, `updated_at` and
 * `item_activity.created_at` are `timestamp with time zone` on Supabase, and
 * `select substr(requested_at, 1, 10) from portal.maintenance_requests` fails
 * there with `42883 function substr(timestamp with time zone, integer,
 * integer) does not exist` — the same class of fault, one column further on.
 * Every text operation in `overview-aggregates.ts` therefore goes through
 * `dateText()`, including on the two columns that look like plain text locally.
 *
 * ── AND THE CARD NOW DEGRADES PROPERLY ────────────────────────────────────
 *
 * A query failure is a 503 carrying a sentence (`dashboardFailure`), an empty
 * result is a 200 whose samples are zero and whose medians are null, and the
 * two cannot be mistaken for each other. §4.3's sub-3-sample buckets are null
 * medians with a real `sample`, which is a gap and not a zero.
 */

import { loadPerformance } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { PerformancePayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, now, url } = resolved.value;
    const split = url.searchParams.get("split") === "priority";
    const payload: PerformancePayload = {
      period: windowPayload(window),
      ...(await loadPerformance(scope.db, scope.orgId, filters, window, now, split)),
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
