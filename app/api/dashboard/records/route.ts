/**
 * GET /api/dashboard/records — the rows behind a footnote or a data-quality line.
 *
 * §1.5 requires every "Fix these →" to work. Most of them are expressible as a
 * Jobs-list filter and go there. The few that are not — "no request date
 * recorded", "a cost but no contractor named", "held in a waiting status" —
 * have no vocabulary on the board's filter bar, and inventing one on a busier
 * screen would be the larger change. So the Overview answers them itself.
 *
 * The page is capped and the REAL total travels beside it, so a panel showing
 * 200 of 431 says so instead of implying it is showing everything.
 */

import { isRecordsQuery, loadRecords, RECORDS_PAGE } from "../../../lib/overview-aggregates";
import {
  dashboardFailure,
  dashboardScope,
  windowPayload,
} from "../../../lib/dashboard-route";
import type { RecordsPayload } from "../../../(app)/portal/ops/overview-contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const resolved = await dashboardScope(request);
    if (!resolved.ok) return resolved.response;
    const { scope, filters, window, url } = resolved.value;

    const requested = (url.searchParams.get("query") ?? "").trim();
    if (!isRecordsQuery(requested)) {
      /*
       * A 400 rather than a silent default. An unknown key is a caller bug, and
       * answering it with somebody else's list is how a "Fix these" link comes
       * to open the wrong rows.
       */
      return Response.json(
        { error: "Unknown records query.", limit: RECORDS_PAGE },
        { status: 400 },
      );
    }

    const payload: RecordsPayload = {
      period: windowPayload(window),
      ...(await loadRecords(scope.db, scope.orgId, filters, window, requested)),
    };
    return Response.json(payload);
  } catch (error) {
    return dashboardFailure(error);
  }
}
