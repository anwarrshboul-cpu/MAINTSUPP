/**
 * The pure half of `site-units.ts` and `store-register-sync.ts`: what a site's
 * own asset says, and which Store Documentation row is a placeholder. No
 * database, no imports — so the rules can be checked on their own.
 */

export const SITE_UNIT_PREFIX = "site-unit-";

export function siteUnitId(siteId: string) {
  return `${SITE_UNIT_PREFIX}${siteId}`;
}

export function isSiteUnitId(id: string | null | undefined) {
  return typeof id === "string" && id.startsWith(SITE_UNIT_PREFIX);
}

type SiteShape = {
  id: string;
  name: string;
  type: string | null;
  siteTypeValue: string | null;
  address: string | null;
  addressLine1: string | null;
  status: string | null;
  active: boolean | null;
  position: number | null;
};

export type SiteUnitMirror = {
  name: string;
  category: string;
  locationInSite: string | null;
  status: string;
  position: number;
};

/** True for a site that is not trading: closed, or a legacy "other" row that is inactive. */
export function siteIsClosed(site: { status?: string | null; active?: boolean | null }) {
  return site.status === "closed" || site.active === false;
}

/** What the site's own unit should say, from the site alone. */
export function siteUnitValues(site: SiteShape): SiteUnitMirror {
  const type = (site.siteTypeValue || site.type || "").trim() || "Store";
  const location = (site.addressLine1 || site.address || "").trim();
  return {
    name: `${site.name.trim()} — ${type}`,
    category: type,
    locationInSite: location || null,
    status: siteIsClosed(site) ? "Inactive" : "Active",
    position: site.position ?? 0,
  };
}

/** A generated monday placeholder name ("Item 5") with nothing else filled in. */
export function isPlaceholderStore(store: { name: string; address: string }) {
  return /^item\s*\d+$/i.test(store.name.trim()) && !store.address.trim();
}
