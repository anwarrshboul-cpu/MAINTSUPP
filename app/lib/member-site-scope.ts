/**
 * THE MEMBER'S SITE RESTRICTION, AS ONE PREDICATE.
 *
 * `memberships.site_scope`, parsed by `parseSiteScope` into
 * `ScopedDatabase.siteScope`, confines a member to a list of sites; `null`
 * means every site in the organisation. The dashboard endpoints fold it in
 * through `resolveDashboardPortfolio`. The Sites view and the Compliance
 * register did not, so a member confined to three stores was sent the whole
 * organisation's site list, and the Sites page's "Portfolio compliance" tile
 * scored every requirement the organisation holds — aggregate leakage, which is
 * leakage. Those reads go through here now, so the tile, the list and the
 * register describe the same authorised set of sites as the Compliance
 * dashboard block does.
 *
 * A Set built once per request and a pure test per row, not a SQL filter:
 * every caller already holds the rows (the register is read whole), and an
 * `IN` list over a member's sites would spend that list's length out of D1's
 * bound-variable budget on every read.
 */

export type MemberSiteSet = ReadonlySet<string> | null;

/** The member's authorised sites, or `null` when the member sees every site. */
export function memberSiteSet(siteScope: readonly string[] | null | undefined): MemberSiteSet {
  return siteScope ? new Set(siteScope) : null;
}

/**
 * Whether a row belonging to `siteId` is inside the member's scope.
 *
 * A row with no site — a register row standing on a board item that names no
 * store — is OUTSIDE a restricted scope. Nothing proves it belongs to one of
 * the member's sites, and the dashboard's own filter (`siteIds.includes`)
 * already drops it for the same reason.
 */
export function withinMemberScope(allowed: MemberSiteSet, siteId: string | null | undefined): boolean {
  if (!allowed) return true;
  return typeof siteId === "string" && allowed.has(siteId);
}
