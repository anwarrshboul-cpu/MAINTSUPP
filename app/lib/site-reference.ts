import { siteIdIsNullable } from "../../db/init";

/**
 * What to store when a job has no site.
 *
 * The honest answer is NULL, and on Postgres that is what this returns.
 *
 * An existing SQLite database cannot say it. `site_id` is NOT NULL there and
 * there is no way to relax it in place — no `ALTER COLUMN ... DROP NOT NULL`,
 * `PRAGMA writable_schema` refused by both the translator and the driver, and
 * the only remaining move would be rebuilding a 52-column table on the
 * bootstrap path of a deployment holding real client data. So that path keeps
 * the sentinel it already had, and writers ask this rather than assume, because
 * a NULL written there raises `NOT NULL constraint failed` and takes the
 * request down.
 *
 * What does NOT vary by dialect is the part that matters: no writer invents a
 * site. The arbitrary first row is gone, the standing "Unmatched website
 * reports" row is no longer created, and the empty string is never stored.
 * Either a job names a store the register knows, or it is recorded as having
 * none — in the strongest way the database underneath can express.
 */
export const UNASSIGNED_SITE_ID = "site-unassigned";

export function unassignedSiteId(): string | null {
  return siteIdIsNullable() ? null : UNASSIGNED_SITE_ID;
}

/**
 * Whether a stored `site_id` means "no site".
 *
 * Read paths need both shapes for as long as both exist. A database migrated on
 * Postgres holds NULL; one running on SQLite holds the sentinel; and a Postgres
 * database that has not yet run the data step can still hold rows written
 * before it. Anything that groups, filters or counts by site has to treat all
 * three the same way, or an unattached job becomes a bucket of its own with a
 * sentinel for a name.
 */
export function isUnassignedSite(siteId: string | null | undefined): boolean {
  if (!siteId) return true;
  const value = siteId.trim();
  if (!value) return true;
  return value === UNASSIGNED_SITE_ID || value.startsWith("site-website-intake-");
}

/**
 * The canonical site id a row should be read as, or null when it has none.
 *
 * One place to strip the sentinels, so a caller can key on the result without
 * repeating the three shapes above.
 */
export function canonicalSiteId(siteId: string | null | undefined): string | null {
  return isUnassignedSite(siteId) ? null : (siteId as string);
}
