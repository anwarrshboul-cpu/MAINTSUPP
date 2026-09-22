/**
 * `GET /api/v1/jobs` — the workspace's jobs, for a machine holding an API token
 * with `jobs:read` (§35). Read-only; there is no write surface in `/api/v1`.
 *
 * The same job shape the portal's own `/api/maintenance` returns (`exposeRequest`
 * strips the same fields), over the same set of rows the Jobs board counts as
 * work (`liveWorkOrderCondition`: not binned, not archived, not a subitem, not a
 * row living on another board), narrowed further by the token creator's site
 * restriction — stricter than the cookie route, which a token must never exceed.
 *
 *   ?id=<job id>            one job, or 404
 *   ?limit=1..200 (50)      page size
 *   ?offset=0..             paging; the answer says whether there is more
 *
 * Newest first, with the id as a tie-break so pages never overlap.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { maintenanceRequests } from "../../../../db/schema";
import { liveWorkOrderCondition } from "../../../lib/dashboard-filters";
import { apiJson, scopedDbWithApiToken } from "../../../lib/integrations/api-auth";
import { exposeRequest } from "../../../lib/request-payload";

export const dynamic = "force-dynamic";

function whole(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value === null || value.trim() === "" ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithApiToken(request, "jobs:read");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.api;
    const url = new URL(request.url);

    const conditions = [liveWorkOrderCondition(orgId)];
    if (siteScope) conditions.push(inArray(maintenanceRequests.siteId, siteScope));

    const id = url.searchParams.get("id");
    if (id !== null) {
      const [row] = await db
        .select()
        .from(maintenanceRequests)
        .where(and(...conditions, eq(maintenanceRequests.id, id.slice(0, 120))))
        .limit(1);
      return row ? apiJson({ job: exposeRequest(row) }) : apiJson({ error: "No such job in this workspace." }, { status: 404 });
    }

    const limit = whole(url.searchParams.get("limit"), 50, 1, 200);
    const offset = whole(url.searchParams.get("offset"), 0, 0, 1_000_000);
    if (limit === null || offset === null) {
      return apiJson({ error: "`limit` is 1 to 200 and `offset` is a whole number from 0." }, { status: 400 });
    }
    const rows = await db
      .select()
      .from(maintenanceRequests)
      .where(and(...conditions))
      .orderBy(desc(maintenanceRequests.createdAt), desc(maintenanceRequests.id))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = rows.length > limit;
    return apiJson({
      jobs: rows.slice(0, limit).map(exposeRequest),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch {
    /* No detail: a database message names tables and columns. */
    return apiJson({ error: "The jobs API is temporarily unavailable." }, { status: 503 });
  }
}
