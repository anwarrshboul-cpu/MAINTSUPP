/**
 * A BOARD, CONFINED TO THE MEMBER'S SITES.
 *
 * `memberships.site_scope` confines a member to named stores, and the Sites,
 * Compliance, dashboard, search and document reads all honour it. `/api/board`
 * did not: it built the whole board — every job's placement, cells, file
 * previews and the Location column's list of stores — for anyone with
 * `board.view`, so a member confined to three stores was sent the other
 * stores' jobs in full.
 *
 * Applied to the finished payload rather than threaded through its dozen
 * queries, because the payload is built once and every part of it is keyed by
 * the job it belongs to: a job's site decides whether its placement, its cells,
 * its file counts and its "not required" slots travel, and the Location
 * options decide which stores the member can be offered. Groups and columns
 * describe the board, not a job, and are sent as they are.
 *
 * The rule is `withinMemberScope`'s: a job whose site is outside the scope — or
 * that names no site, because nothing proves it is one of theirs — is left out.
 * An UNRESTRICTED member (`siteScope` null: every member today) gets the payload
 * back untouched, the same object, byte for byte.
 */

import { and, eq, inArray } from "drizzle-orm";
import { maintenanceRequests } from "../../db/schema";
import { memberSiteSet, withinMemberScope } from "./member-site-scope";
import { chunkIds } from "./sql-batching";
import type { ScopedDatabase } from "./tenant-db";

/* The board payload's job-keyed parts, as `boardPayload` builds them. */
type ConfinablePayload = {
  items: Array<{ requestId: string }>;
  cells: Array<{ requestId: string }>;
  fileCounts: Array<{ requestId: string }>;
  notRequired: Array<{ itemId: string }>;
  options: Array<{ id: string; columnKey: string }>;
  requests: Array<{ id: string; siteId?: string | null }>;
};

/* The Location column's options are the site register, one per store, each
   id built as `site-option-<site id>` in `boardPayload`. */
const SITE_OPTION_PREFIX = "site-option-";

export async function confineBoardPayload<T extends ConfinablePayload>(
  db: ScopedDatabase["db"],
  orgId: string,
  payload: T,
  siteScope: readonly string[] | null,
): Promise<T> {
  const allowed = memberSiteSet(siteScope);
  if (!allowed) return payload;

  /* Each placed job's site — from the rows when the payload carries them, and
     looked up otherwise (`?compact=1` omits the rows, not the placements). */
  const placed = [...new Set(payload.items.map((item) => item.requestId))];
  const siteOf = new Map<string, string | null>();
  for (const row of payload.requests) siteOf.set(row.id, row.siteId ?? null);
  for (const chunk of chunkIds(placed.filter((id) => !siteOf.has(id)))) {
    const rows = await db
      .select({ id: maintenanceRequests.id, siteId: maintenanceRequests.siteId })
      .from(maintenanceRequests)
      .where(and(eq(maintenanceRequests.organisationId, orgId), inArray(maintenanceRequests.id, chunk)));
    for (const row of rows) siteOf.set(row.id, row.siteId);
  }
  const kept = new Set(placed.filter((id) => withinMemberScope(allowed, siteOf.get(id))));

  return {
    ...payload,
    items: payload.items.filter((item) => kept.has(item.requestId)),
    cells: payload.cells.filter((cell) => kept.has(cell.requestId)),
    fileCounts: payload.fileCounts.filter((entry) => kept.has(entry.requestId)),
    notRequired: payload.notRequired.filter((slot) => kept.has(slot.itemId)),
    requests: payload.requests.filter((row) => kept.has(row.id)),
    options: payload.options.filter(
      (option) =>
        option.columnKey !== "storeLocation" ||
        (option.id.startsWith(SITE_OPTION_PREFIX) &&
          withinMemberScope(allowed, option.id.slice(SITE_OPTION_PREFIX.length))),
    ),
  };
}
