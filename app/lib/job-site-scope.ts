/**
 * THE MEMBER'S SITES, ON THE WAY IN.
 *
 * `memberships.site_scope` confines a member to named stores. #83 made every
 * job-level READ honour it (`memberSiteCondition`, `confineBoardPayload`) and
 * both upload doors (`uploadOutsideSiteScope`). The WRITE doors did not: a
 * member confined to one store who held `board.edit` could not see another
 * store's jobs, but could still edit their cells, move them, archive them,
 * comment on them, issue a contractor link for them, bin them, restore them,
 * re-file them at another store, or raise a new job there — by id, through the
 * API, with nothing on screen to point at.
 *
 * This module is that rule on the write path. It is NOT a second rule:
 * every answer below comes from `memberSiteSet` and `withinMemberScope`, so a
 * job with no site is outside a restricted scope here exactly as it is on the
 * board, in the calendar and in the document register.
 *
 * WHAT A REFUSAL LOOKS LIKE — and why there are two shapes:
 *
 *   · A RECORD outside the scope is answered with the route's own not-found,
 *     byte for byte. A member cannot read it, so the write door must not
 *     confirm it exists either; "not yours" and "not there" read the same.
 *     The same goes for a SITE a caller names and may not reach — each route
 *     already has an answer for a site that does not exist, and that is the
 *     answer.
 *   · A change that would reach OTHER stores' jobs as a side effect of
 *     something the member can see — clearing a column, deleting a group that
 *     still holds another store's jobs, emptying the whole bin, importing a
 *     register — is a 403 that says so (`beyondMemberScope`), the answer
 *     `/api/integrations/webhooks` already gives a restricted member for a
 *     workspace-wide webhook. There is no single record to pretend is missing.
 *   · A NEW record with no site would be one the member could never see again
 *     (`withinMemberScope(allowed, null)` is false), so a restricted member's
 *     create must name one of their stores (`SITE_REQUIRED`).
 *
 * THE UNRESTRICTED MEMBER — `siteScope` null, which is every member on Staging
 * and Production today — never reaches a query here: every helper returns
 * before its first statement, and `jobsWithinMemberScope` hands back the very
 * array it was given.
 */

import { and, eq, inArray } from "drizzle-orm";
import { maintenanceRequests } from "../../db/schema";
import { memberSiteSet, withinMemberScope } from "./member-site-scope";
import { chunkIds } from "./sql-batching";
import type { ScopedDatabase } from "./tenant-db";

type Db = ScopedDatabase["db"];
type SiteScope = readonly string[] | null | undefined;

/**
 * Of the jobs named, those at the member's sites — in the order named.
 *
 * An id that does not resolve in this organisation is dropped with the ones
 * outside the scope, so a caller treats both exactly as it already treats a
 * foreign or invented id. Unrestricted: the SAME array back, no query.
 */
export async function jobsWithinMemberScope(
  db: Db,
  orgId: string,
  siteScope: SiteScope,
  ids: string[],
): Promise<string[]> {
  const allowed = memberSiteSet(siteScope);
  if (!allowed) return ids;
  const siteOf = new Map<string, string | null>();
  for (const chunk of chunkIds([...new Set(ids.filter(Boolean))])) {
    const rows = await db
      .select({ id: maintenanceRequests.id, siteId: maintenanceRequests.siteId })
      .from(maintenanceRequests)
      .where(and(eq(maintenanceRequests.organisationId, orgId), inArray(maintenanceRequests.id, chunk)));
    for (const row of rows) siteOf.set(row.id, row.siteId);
  }
  return ids.filter((id) => siteOf.has(id) && withinMemberScope(allowed, siteOf.get(id)));
}

/** Whether one job is at the member's sites. Unrestricted: true, no query. */
export async function jobWithinMemberScope(
  db: Db,
  orgId: string,
  siteScope: SiteScope,
  id: string,
): Promise<boolean> {
  if (!siteScope) return true;
  return (await jobsWithinMemberScope(db, orgId, siteScope, [id])).length > 0;
}

/**
 * Whether any of these jobs stands outside the member's sites — for a change
 * that reaches every job in a group or a column at once. An id that does not
 * resolve counts as outside: nothing proves it is one of theirs.
 */
export async function anyJobOutsideMemberScope(
  db: Db,
  orgId: string,
  siteScope: SiteScope,
  ids: readonly string[],
): Promise<boolean> {
  if (!siteScope) return false;
  const unique = [...new Set(ids)];
  if (!unique.length) return false;
  return (await jobsWithinMemberScope(db, orgId, siteScope, unique)).length !== unique.length;
}

/**
 * Whether a site the caller NAMES — a new job's store, the store a job or an
 * event is being moved to — is outside the member's scope. No site at all is
 * outside a restricted scope, as everywhere else.
 */
export function siteOutsideMemberScope(siteScope: SiteScope, siteId: string | null | undefined): boolean {
  return !withinMemberScope(memberSiteSet(siteScope), siteId);
}

/** What a restricted member is told when a new record names no store. */
export const SITE_REQUIRED =
  "Your access is limited to some sites, so this has to name one of them.";

/** 403 for a create, or a move, that names no store at all. */
export function siteRequired(): Response {
  return Response.json({ error: SITE_REQUIRED, outsideSiteScope: true }, { status: 403 });
}

/**
 * 403 for a change that would reach other stores' jobs as a side effect.
 * `reach` finishes the sentence "Your access is limited to some sites, and …".
 */
export function beyondMemberScope(reach: string): Response {
  return Response.json(
    { error: `Your access is limited to some sites, and ${reach}.`, outsideSiteScope: true },
    { status: 403 },
  );
}
