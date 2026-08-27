import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  importAnomalies,
  siteAliases,
  siteGroupMembers,
  siteGroups,
  sites,
} from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export type SiteRow = typeof sites.$inferSelect;

/**
 * Site names arrive from two monday boards that never agreed with each other:
 * "Wood Green - High Road" against "Woodgreen", "Brent Cross - Shopping Centre"
 * against "Brentcross". Normalisation strips everything that differs between
 * the two conventions so either spelling resolves to the same key.
 */
export function normaliseSiteName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function toSlug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * X12 — monday exports carry stray leading quotes on addresses, e.g.
 * `"UNIT 5, THE WHITECHAPEL...`. The quote is removed and the change is
 * returned so the caller can log it. Nothing is corrected silently.
 */
export function cleanAddress(value: string) {
  const cleaned = value.replace(/^["'\s]+/, "").replace(/["'\s]+$/, "").trim();
  return { value: cleaned, changed: cleaned !== value.trim() ? true : cleaned !== value };
}

/**
 * X13 — placeholder rows that must never become sites. `Item 5` and
 * `Mall of Netherlands` are empty rows in the monday Europe group. Matching is
 * on shape rather than a fixed blocklist so new placeholders are caught too.
 */
export function junkReason(name: string, address: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "The row has no site name.";
  if (/^item\s*\d+$/i.test(trimmed)) return "The name is an unedited monday placeholder.";
  if (!address.trim()) return "The row has no address.";
  return null;
}

export async function listSites(
  db: Database,
  organisationId: string,
  options: { includeInactive?: boolean } = {},
) {
  const rows = await db
    .select()
    .from(sites)
    .where(eq(sites.organisationId, organisationId))
    .orderBy(asc(sites.position), asc(sites.name));
  return options.includeInactive ? rows : rows.filter((row) => row.active);
}

export async function getSite(db: Database, organisationId: string, id: string) {
  const [row] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, id), eq(sites.organisationId, organisationId)))
    .limit(1);
  return row ?? null;
}

export async function listAliases(db: Database, organisationId: string) {
  return db
    .select()
    .from(siteAliases)
    .where(eq(siteAliases.organisationId, organisationId));
}

/**
 * X11 — resolve any historic name to one canonical site. Checks the canonical
 * name, both monday board columns and every recorded alias. Returns null rather
 * than guessing, so U9 can route an unmatched name to manual review.
 */
export async function resolveSiteByName(
  db: Database,
  organisationId: string,
  candidate: string,
): Promise<SiteRow | null> {
  const key = normaliseSiteName(candidate);
  if (!key) return null;

  const rows = await listSites(db, organisationId, { includeInactive: true });
  const direct = rows.find(
    (row) =>
      normaliseSiteName(row.name) === key ||
      (row.mondayMaintenanceName && normaliseSiteName(row.mondayMaintenanceName) === key) ||
      (row.mondayComplianceName && normaliseSiteName(row.mondayComplianceName) === key) ||
      (row.code && row.code.toLowerCase() === candidate.trim().toLowerCase()),
  );
  if (direct) return direct;

  const [alias] = await db
    .select()
    .from(siteAliases)
    .where(
      and(
        eq(siteAliases.organisationId, organisationId),
        eq(siteAliases.normalised, key),
      ),
    )
    .limit(1);
  if (!alias) return null;
  return rows.find((row) => row.id === alias.siteId) ?? null;
}

/**
 * X6 — duplicate warning. Returns the sites an admin should look at before
 * saving. This warns; it never blocks, because two genuinely different sites
 * can share a shopping-centre name.
 */
export async function findDuplicateCandidates(
  db: Database,
  organisationId: string,
  name: string,
  excludeId?: string,
) {
  const key = normaliseSiteName(name);
  if (!key) return [];
  const rows = await listSites(db, organisationId, { includeInactive: true });
  return rows
    .filter((row) => row.id !== excludeId)
    .filter((row) => {
      const rowKey = normaliseSiteName(row.name);
      return rowKey === key || rowKey.includes(key) || key.includes(rowKey);
    })
    .map((row) => ({ id: row.id, name: row.name, status: row.status }));
}

/**
 * Site codes are generated rather than typed, because the business has no
 * existing convention. The stem is drawn from the site's own name so a code is
 * recognisable on a work order — Brighton becomes BRHT, Cabot Circus CBTC —
 * rather than an opaque sequence number. Codes are stored, not derived at read
 * time, so renaming a site later never silently changes its code; an admin can
 * overwrite the generated value at any point.
 */
export function generateSiteCode(name: string, taken: Iterable<string>) {
  const used = new Set([...taken].map((code) => code.toUpperCase()));
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const candidates: string[] = [];
  if (words.length >= 2) {
    // Initials of the first words read best for two-word names.
    candidates.push(words.map((word) => word[0]).join("").slice(0, 4));
  }
  const first = words[0] ?? "SITE";
  // Consonant skeleton keeps the word recognisable when vowels are dropped.
  const skeleton = (first[0] + first.slice(1).replace(/[AEIOU]/g, "")).slice(0, 4);
  candidates.push(skeleton.padEnd(3, first.slice(1, 2) || "X"));
  candidates.push(first.slice(0, 4));
  candidates.push("SITE");

  for (const candidate of candidates) {
    const stem = candidate.replace(/[^A-Z0-9]/g, "");
    if (stem.length >= 2 && !used.has(stem)) return stem;
  }

  const stem = (candidates[0] || "SITE").replace(/[^A-Z0-9]/g, "").slice(0, 4) || "SITE";
  let suffix = 2;
  while (used.has(`${stem}${suffix}`)) suffix += 1;
  return `${stem}${suffix}`;
}

export async function existingSiteCodes(db: Database, organisationId: string) {
  const rows = await db
    .select({ code: sites.code })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  return rows.map((row) => row.code).filter((code): code is string => Boolean(code));
}

export async function nextSitePosition(db: Database, organisationId: string) {
  const rows = await db
    .select({ position: sites.position })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  return rows.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
}

/** Slugs are unique per organisation, so a repeated name gets a numeric suffix. */
export async function uniqueSlug(
  db: Database,
  organisationId: string,
  name: string,
  excludeId?: string,
) {
  const base = toSlug(name) || "site";
  const rows = await db
    .select({ id: sites.id, slug: sites.slug })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  const taken = new Set(
    rows.filter((row) => row.id !== excludeId && row.slug).map((row) => row.slug as string),
  );
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export type AliasWrite =
  | { ok: true; created: boolean; normalised: string }
  | { ok: false; reason: "empty" | "self" | "taken"; conflictSiteId?: string };

/**
 * Record ONE alias without disturbing the ones already recorded.
 *
 * `setSiteAliases` below is a replace: it clears every alias the site has and
 * writes the list it was handed. That is right for the alias editor, which
 * sends the whole list, and fatal for a rename, which knows only the name being
 * retired. Renaming a store twice must leave BOTH earlier spellings resolving;
 * a replace leaves only the last.
 *
 * Nothing is written silently. A normalised key already claimed by a DIFFERENT
 * site is refused and reported rather than dropped by `onConflictDoNothing` —
 * that swallow is how a rename could report success while the retired name went
 * on resolving to somebody else's store.
 */
export async function addSiteAlias(
  db: Database,
  organisationId: string,
  siteId: string,
  alias: string,
  source = "rename",
): Promise<AliasWrite> {
  const trimmed = alias.trim();
  const normalised = normaliseSiteName(trimmed);
  if (!trimmed || !normalised) return { ok: false, reason: "empty" };

  /*
   * An alias equal to a LIVE site name can never be reached: `resolveSiteByName`
   * matches site names before aliases. If it names THIS site it is dead weight;
   * if it names another it is a false claim that goes live the moment that site
   * is renamed away. There is no unique index on sites(organisation_id, name) to
   * catch either, so it is checked here.
   */
  const named = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  const collides = named.find((row) => normaliseSiteName(row.name) === normalised);
  if (collides) {
    return collides.id === siteId
      ? { ok: false, reason: "self" }
      : { ok: false, reason: "taken", conflictSiteId: collides.id };
  }

  const [held] = await db
    .select({ siteId: siteAliases.siteId })
    .from(siteAliases)
    .where(
      and(eq(siteAliases.organisationId, organisationId), eq(siteAliases.normalised, normalised)),
    )
    .limit(1);
  if (held) {
    // Idempotent: renaming back and away again must not throw.
    return held.siteId === siteId
      ? { ok: true, created: false, normalised }
      : { ok: false, reason: "taken", conflictSiteId: held.siteId };
  }

  await db.insert(siteAliases).values({
    id: `alias-${siteId}-${normalised}`.slice(0, 120),
    organisationId,
    siteId,
    alias: trimmed,
    normalised,
    source,
  });
  return { ok: true, created: true, normalised };
}

/**
 * The other half of a rename. Adopting a name back means it must stop being an
 * alias of the SAME site, or the register claims one string is both a site's
 * current name and a historic spelling of it. Only this site's own rows are
 * touched; another site's claim is a conflict the caller refuses beforehand.
 */
export async function releaseSiteAlias(
  db: Database,
  organisationId: string,
  siteId: string,
  name: string,
) {
  const normalised = normaliseSiteName(name);
  if (!normalised) return;
  await db
    .delete(siteAliases)
    .where(
      and(
        eq(siteAliases.organisationId, organisationId),
        eq(siteAliases.siteId, siteId),
        eq(siteAliases.normalised, normalised),
      ),
    );
}

/**
 * Who, if anyone, already answers to this name — a site or an alias.
 *
 * `findDuplicateCandidates` looks only at site names and only warns. An alias
 * pointing at another site is a hard conflict: the unique index would reject
 * the rename's own alias insert, so the rename has to be refused up front
 * rather than half-applied.
 */
export async function nameConflict(
  db: Database,
  organisationId: string,
  name: string,
  excludeId: string,
): Promise<{ siteId: string; kind: "site" | "alias" } | null> {
  const key = normaliseSiteName(name);
  if (!key) return null;
  const rows = await listSites(db, organisationId, { includeInactive: true });
  const site = rows.find((row) => row.id !== excludeId && normaliseSiteName(row.name) === key);
  if (site) return { siteId: site.id, kind: "site" };
  const [alias] = await db
    .select({ siteId: siteAliases.siteId })
    .from(siteAliases)
    .where(and(eq(siteAliases.organisationId, organisationId), eq(siteAliases.normalised, key)))
    .limit(1);
  if (alias && alias.siteId !== excludeId) return { siteId: alias.siteId, kind: "alias" };
  return null;
}

export async function setSiteAliases(
  db: Database,
  organisationId: string,
  siteId: string,
  aliases: string[],
  source = "manual",
) {
  /*
   * Scoped to the source it is replacing. This used to clear EVERY alias the
   * site had, so saving the alias editor — which sends only the hand-typed list
   * — erased the names the site had been renamed away from, and every job filed
   * under an old spelling stopped resolving. A rename is history; it is not the
   * editor's to overwrite.
   */
  await db
    .delete(siteAliases)
    .where(
      and(
        eq(siteAliases.organisationId, organisationId),
        eq(siteAliases.siteId, siteId),
        eq(siteAliases.source, source),
      ),
    );
  const seen = new Set<string>();
  for (const alias of aliases) {
    const trimmed = alias.trim();
    const normalised = normaliseSiteName(trimmed);
    if (!trimmed || !normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    await db
      .insert(siteAliases)
      .values({
        id: `alias-${siteId}-${normalised}`.slice(0, 120),
        organisationId,
        siteId,
        alias: trimmed,
        normalised,
        source,
      })
      .onConflictDoNothing();
  }
}

export async function listSiteGroups(db: Database, organisationId: string) {
  const [groups, members] = await Promise.all([
    db
      .select()
      .from(siteGroups)
      .where(eq(siteGroups.organisationId, organisationId))
      .orderBy(asc(siteGroups.position), asc(siteGroups.name)),
    db
      .select()
      .from(siteGroupMembers)
      .where(eq(siteGroupMembers.organisationId, organisationId)),
  ]);
  return groups.map((group) => ({
    ...group,
    siteIds: members.filter((member) => member.siteGroupId === group.id).map((m) => m.siteId),
  }));
}

export async function setSiteGroupMembership(
  db: Database,
  organisationId: string,
  siteId: string,
  groupIds: string[],
) {
  await db
    .delete(siteGroupMembers)
    .where(
      and(
        eq(siteGroupMembers.organisationId, organisationId),
        eq(siteGroupMembers.siteId, siteId),
      ),
    );
  if (!groupIds.length) return;
  const owned = await db
    .select({ id: siteGroups.id })
    .from(siteGroups)
    .where(
      and(
        eq(siteGroups.organisationId, organisationId),
        inArray(siteGroups.id, groupIds),
      ),
    );
  for (const group of owned) {
    await db
      .insert(siteGroupMembers)
      .values({
        id: `sgm-${group.id}-${siteId}`.slice(0, 120),
        organisationId,
        siteGroupId: group.id,
        siteId,
      })
      .onConflictDoNothing();
  }
}

export async function recordAnomaly(
  db: Database,
  organisationId: string,
  entry: {
    batchId: string;
    entityType: string;
    entityId?: string | null;
    sourceName?: string | null;
    kind: string;
    field?: string | null;
    originalValue?: string | null;
    appliedValue?: string | null;
    detail?: string | null;
  },
) {
  await db.insert(importAnomalies).values({
    id: `anom-${entry.batchId}-${Math.random().toString(36).slice(2, 10)}`,
    organisationId,
    batchId: entry.batchId,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    sourceName: entry.sourceName ?? null,
    kind: entry.kind,
    field: entry.field ?? null,
    originalValue: entry.originalValue ?? null,
    appliedValue: entry.appliedValue ?? null,
    detail: entry.detail ?? null,
  });
}

export async function listAnomalies(
  db: Database,
  organisationId: string,
  batchId?: string,
) {
  const clause = batchId
    ? and(
        eq(importAnomalies.organisationId, organisationId),
        eq(importAnomalies.batchId, batchId),
      )
    : eq(importAnomalies.organisationId, organisationId);
  return db.select().from(importAnomalies).where(clause);
}
