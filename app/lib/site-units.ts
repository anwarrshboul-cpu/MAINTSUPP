/**
 * EVERY SITE HAS EXACTLY ONE ASSET OF ITS OWN — the store unit.
 *
 * The owner's rule (2026-10-06): "the assets should be exactly the same number
 * [as the sites] and the locations in the site, so they are connected and
 * synchronised based on the sites". So the register carries one asset per site,
 * `site-unit-<siteId>`, whose name, category, location, status and order come
 * from the site:
 *
 *   name      "<site name> — <type>"           e.g. "Westfield Stratford — Kiosk"
 *   category  the site type (Kiosk, Inline, Office, Warehouse …)
 *   location  the site's address — for Sunnamusk, monday's Store Address, which
 *             names the unit itself ("Kiosk K29 First Floor Level …")
 *   status    Active while the site is open, Inactive once it is closed
 *   position  the site's own position, so the Assets page follows the Sites order
 *
 * ── AN EDIT ON THE ASSET IS KEPT ──────────────────────────────────────────
 *
 * `units.site_mirror` records what was last copied. A field is copied again only
 * while the asset still holds the copied value; once somebody has typed their
 * own location on the asset, a later change of address on the site does not
 * overwrite it. Everything else on the asset (model, supplier, photos, service
 * history …) is never touched here.
 *
 * ── ONE FUNCTION, CALLED FROM EVERY PATH THAT WRITES A SITE ──────────────
 *
 * The Sites screen, the Manage-data drawer, the CSV import, the monday Store
 * Documentation sync and the Sites/Assets arrange endpoint all finish by calling
 * `reconcileSiteUnits`. It reads the organisation's sites and site units once
 * (tens of rows) and writes only what differs, so it is cheap to call after
 * every write. A binned site unit is not recreated: its row still exists, so
 * the insert conflicts and nothing happens.
 */

import { and, eq, like } from "drizzle-orm";
import type { getDb } from "../../db";
import { sites, units } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

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

function parseMirror(raw: string | null | undefined): Partial<SiteUnitMirror> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Partial<SiteUnitMirror>) : {};
  } catch {
    return {};
  }
}

const MIRRORED = ["name", "category", "locationInSite", "status", "position"] as const;

/**
 * Bring every site's own unit in line with its site. Returns what it did.
 *
 * `siteIds` narrows the work to those sites; omitted, the whole organisation.
 */
export async function reconcileSiteUnits(
  db: Database,
  organisationId: string,
  siteIds?: string[],
): Promise<{ created: number; updated: number }> {
  const siteRows = await db
    .select({
      id: sites.id,
      name: sites.name,
      type: sites.type,
      siteTypeValue: sites.siteTypeValue,
      address: sites.address,
      addressLine1: sites.addressLine1,
      status: sites.status,
      active: sites.active,
      position: sites.position,
    })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  const wanted = siteIds ? new Set(siteIds) : null;
  const targets = siteRows.filter((row) => !wanted || wanted.has(row.id));
  if (!targets.length) return { created: 0, updated: 0 };

  const unitRows = await db
    .select({
      id: units.id,
      siteId: units.siteId,
      name: units.name,
      category: units.category,
      locationInSite: units.locationInSite,
      status: units.status,
      position: units.position,
      siteMirror: units.siteMirror,
    })
    .from(units)
    .where(and(eq(units.organisationId, organisationId), like(units.id, `${SITE_UNIT_PREFIX}%`)));
  const byId = new Map(unitRows.map((row) => [row.id, row]));

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  for (const site of targets) {
    const id = siteUnitId(site.id);
    const next = siteUnitValues(site);
    const existing = byId.get(id);
    if (!existing) {
      await db
        .insert(units)
        .values({
          id,
          organisationId,
          siteId: site.id,
          name: next.name,
          category: next.category,
          kind: "equipment",
          status: next.status,
          locationInSite: next.locationInSite,
          position: next.position,
          notes: "The store unit itself. Name, type, location and status follow the site.",
          siteMirror: JSON.stringify(next),
        })
        .onConflictDoNothing();
      created += 1;
      continue;
    }
    if (existing.siteId !== site.id) continue;
    const mirror = parseMirror(existing.siteMirror);
    const patch: Record<string, unknown> = {};
    for (const field of MIRRORED) {
      const current = existing[field] ?? null;
      const copied = field in mirror ? (mirror[field] ?? null) : current;
      /* Somebody edited this field on the asset itself: leave it. */
      if (current !== copied) continue;
      if (current !== (next[field] ?? null)) patch[field] = next[field];
    }
    const mirrorChanged = MIRRORED.some((field) => (mirror[field] ?? null) !== (next[field] ?? null));
    if (Object.keys(patch).length || mirrorChanged) {
      await db
        .update(units)
        .set({
          ...(patch as Partial<typeof units.$inferInsert>),
          siteMirror: JSON.stringify(next),
          ...(Object.keys(patch).length ? { updatedAt: now } : {}),
        })
        .where(and(eq(units.id, id), eq(units.organisationId, organisationId)));
      if (Object.keys(patch).length) updated += 1;
    }
  }
  return { created, updated };
}

/**
 * The same, never throwing: a site write has already succeeded by the time this
 * runs, and failing that request because the asset could not follow would tell
 * the user their site was not saved when it was. The next write, or the Assets
 * page loading, finishes the job.
 */
export async function reconcileSiteUnitsQuietly(
  db: Database,
  organisationId: string,
  siteIds?: string[],
) {
  try {
    return await reconcileSiteUnits(db, organisationId, siteIds);
  } catch (error) {
    console.error("site units could not be reconciled", error);
    return { created: 0, updated: 0 };
  }
}
