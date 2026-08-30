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

/**
 * The site types a person is choosing between when they say where a job is.
 *
 * The register holds every real operational location the client has — closed
 * stores, so historical jobs keep a real site rather than losing one; the
 * office; the two warehouses. All of those are canonical, and none of them is
 * an answer to "which shop is this job at". Existing in `sites` and appearing
 * in a location picker are deliberately different things.
 */
const RETAIL_SITE_TYPES = ["Inline", "Kiosk"];

/**
 * The sites a location picker may offer: open, and somewhere a customer walks
 * into.
 *
 * One definition, used by the board's Location column and by the public form,
 * because two definitions is how a dropdown comes to disagree with the register
 * behind it. Closed stores are excluded by `status`, the office and warehouses
 * by type, and anything the register cannot vouch for carries status 'other'
 * and is excluded with them — a legacy row must never become a suggestion.
 */
export async function listRetailSites(db: Database, organisationId: string) {
  const rows = await db
    .select()
    .from(sites)
    .where(eq(sites.organisationId, organisationId))
    .orderBy(asc(sites.position), asc(sites.name));
  return rows.filter(
    (row) =>
      row.active &&
      row.status === "active" &&
      RETAIL_SITE_TYPES.includes(row.siteTypeValue ?? row.type ?? ""),
  );
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

/**
 * Whether another site in this organisation already answers to this code.
 *
 * A DUPLICATE CODE IS NOT COSMETIC, which is why this refuses rather than
 * warns the way `findDuplicateCandidates` does for names. `resolveSiteByName`
 * treats a code as an identity — it matches `row.code` case-insensitively and
 * returns the FIRST row it finds — so two sites carrying the same code make
 * that lookup non-deterministic, and job intake naming that code attaches the
 * work to whichever shop the query happened to return. Silently sending an
 * engineer to the wrong store is the precise failure the canonical register
 * exists to prevent.
 *
 * Two sites may legitimately share a NAME (two centres in one city), and that
 * stays a confirmable warning. Nothing legitimately shares a code.
 *
 * The comparison is the same case-insensitive trim `resolveSiteByName` uses,
 * so this guards exactly the keyspace that resolution reads. Closed sites are
 * included — a closed store still owns its code, and reissuing it would make
 * historical jobs ambiguous.
 */
export async function codeConflict(
  db: Database,
  organisationId: string,
  code: string,
  excludeId: string,
): Promise<string | null> {
  const key = code.trim().toLowerCase();
  if (!key) return null;
  const rows = await listSites(db, organisationId, { includeInactive: true });
  const clash = rows.find(
    (row) => row.id !== excludeId && (row.code ?? "").trim().toLowerCase() === key,
  );
  return clash ? clash.id : null;
}

/**
 * The alias editor's replace — and what it could NOT record.
 *
 * THE BUG THIS FIXES. The insert below carried `onConflictDoNothing`, and
 * `site_aliases` is uniquely indexed on (organisation_id, normalised). So an
 * alias already claimed by ANOTHER site was dropped in silence and the route
 * answered `{ok:true}`: the editor showed the name as saved, the register went
 * on resolving it to somebody else's store, and nothing anywhere said so. That
 * is the swallow `addSiteAlias` refuses by name in its own header; this is the
 * other half of the same rule, for the path that sends a whole list.
 *
 * The conflicting names are returned rather than thrown, because the rest of
 * the list is legitimate and a save that half-worked must still say which half.
 * A key this site already holds under a different `source` is NOT a conflict —
 * it resolves here either way — so only another site's claim is reported.
 */
export async function setSiteAliases(
  db: Database,
  organisationId: string,
  siteId: string,
  aliases: string[],
  source = "manual",
): Promise<{ refused: Array<{ alias: string; conflictSiteId: string }> }> {
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
  /*
   * Read AFTER the delete above, so a key this site had just given up is free
   * again and renaming a list back to an earlier version does not report a
   * conflict with itself.
   */
  const held = await db
    .select({ siteId: siteAliases.siteId, normalised: siteAliases.normalised })
    .from(siteAliases)
    .where(eq(siteAliases.organisationId, organisationId));
  const holder = new Map(held.map((row) => [row.normalised, row.siteId]));

  const refused: Array<{ alias: string; conflictSiteId: string }> = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    const trimmed = alias.trim();
    const normalised = normaliseSiteName(trimmed);
    if (!trimmed || !normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    const claimed = holder.get(normalised);
    if (claimed && claimed !== siteId) {
      refused.push({ alias: trimmed, conflictSiteId: claimed });
      continue;
    }
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
      // Kept as the last line of defence against a concurrent writer. The check
      // above is what makes the refusal REPORTABLE rather than invisible.
      .onConflictDoNothing();
  }
  return { refused };
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

/**
 * The canonical address columns, and the Stage 0 string that mirrors them.
 *
 * `sites.address` is the Stage 0 column every reader outside the Sites screen
 * still uses — the contractor job link prints it and builds the map URL from
 * it (`app/(public)/j/[token]/contractor-job-view.tsx`), the compliance
 * register reports it, the workspace API returns it. It is DERIVED from
 * `address_line1/2 + city + postcode`, and both writers rebuilt it from those
 * four on every save.
 *
 * THE BUG THAT RULE HAD. A derived column may only be rebuilt when the columns
 * it derives from actually hold everything it held. On the canonical register
 * they do not: the monday import read `"<unit or mall> - <street>, <city>
 * <postcode>"`, took the part before the " - " as `address_line1` and threw the
 * street away, so on two sites the street survives ONLY in `address`:
 *
 *   Highcross Leicester   address_line1 "Kiosk 13 Highcross Shopping Centre
 *                         Leicester", line2 NULL — "5 Shires Ln" lives only in
 *                         `address`
 *   Bullring - Birmingham address_line1 "Site A, Upper Mall West, Bullring,
 *                         Birmingham", line2 NULL — "Moor St" likewise
 *
 * A notes-only save rebuilt `address` without the street, and the engineer sent
 * to the job got a shopping centre instead of a road. Those two rows are the
 * symptom; the fault is that a REBUILD COULD DESTROY WHAT THE CANONICAL FIELDS
 * NEVER RECEIVED. `mirrorAddress` below is the general rule, expressed once and
 * used by every writer.
 */
export type AddressParts = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
  region?: string | null;
};

/**
 * An address reduced to comparable words: lower case, accents folded, every
 * run of punctuation or space a separator. Word level rather than segment
 * level on purpose — "Leicester LE1 4AN" is ONE comma segment holding TWO
 * canonical values, so a segment comparison calls it unaccounted for and a
 * word comparison sees both halves.
 */
export function addressTokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Whether `needle`'s words already appear, in order and adjacent, in `hay`. */
function containsTokenRun(hay: readonly string[], needle: readonly string[]) {
  if (!needle.length) return true;
  for (let start = 0; start + needle.length <= hay.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (hay[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The four canonical columns joined into the Stage 0 string — WITHOUT REPEATING
 * A PART THE STRING ALREADY CARRIES.
 *
 * The plain join repeated itself on 25 of the 31 canonical sites. Their
 * `address_line1` is the whole imported address, postcode and all, and
 * `postcode` holds that same postcode again, so the join produced
 * "UNIT 5, THE WHITECHAPEL TECHNOLOGY CENTRE, 75 WHITECHAPEL ROAD, LONDON
 * E1 1EW, E1 1EW" — the first edit of almost any site degraded the string the
 * contractor's map link is built from. Bullring repeated "Birmingham" the same
 * way.
 *
 * A part is skipped only when its words are ALREADY PRESENT, adjacent and in
 * order, in what has been built so far, so nothing is dropped: the content is
 * in the string, earlier. Word-run matching rather than substring, or a city of
 * "London" would be swallowed by a line reading "Londonderry".
 *
 * Order is never changed. Parts are visited line1, line2, city, postcode as
 * they always were; a part is either appended in its place or already there.
 */
export function composeAddress(parts: AddressParts) {
  const segments: string[] = [];
  let written: string[] = [];
  for (const part of [parts.addressLine1, parts.addressLine2, parts.city, parts.postcode]) {
    const value = typeof part === "string" ? part.trim() : "";
    if (!value) continue;
    const words = addressTokens(value);
    if (words.length && containsTokenRun(written, words)) continue;
    segments.push(value);
    written = written.concat(words);
  }
  return segments.join(", ").slice(0, 300);
}

/**
 * What to store in `address` on a save — and when NOT to touch it at all.
 *
 * THE RULE: a derived column may be rebuilt only when the rebuild is LOSSLESS.
 * If the stored string contains a word that the rebuilt string does not, and
 * that the canonical address columns never held — before the edit or after it —
 * then the canonical columns are incomplete, the rebuild would be the only place
 * that word ever existed, and the stored string is kept instead.
 *
 * WHY "BEFORE THE EDIT OR AFTER IT" IS THE WHOLE OF THE TEST, and why it is not
 * simply "anything the rebuild drops". A save that legitimately CHANGES an
 * address drops words on purpose: correcting a postcode from "LE1 4AN" to
 * "LE1 4AB" drops "4an", clearing `address_line2` drops all of it. In both the
 * dropped word was in a canonical column beforehand, so the register is losing
 * nothing it was not told to lose, and the mirror must follow. Only a word that
 * NO canonical column has ever carried is orphaned, and only that holds the
 * mirror. So an ordinary edit still updates `address`, and a fix that refused
 * to ever rebuild would be the same bug pointing the other way.
 *
 * `country` and `region` count as canonical even though the mirror never
 * carried them: a stored address ending "United Kingdom" is not losing that
 * fact when the mirror drops it, only its copy of it.
 *
 * HOLDING IS DELIBERATELY SELF-LIMITING. It fires only while the canonical
 * columns are missing something, it is reported to the caller and written into
 * the audit line rather than happening in silence, and the moment the orphaned
 * text is put where it belongs — `address_line2` is NULL on both affected rows
 * — the rebuild is lossless again and the mirror tracks every edit as before.
 * The escape hatch is therefore correct data entry, not a flag.
 *
 * `heldFor` is the orphaned words, so the caller can say WHY it held.
 */
export function mirrorAddress(
  stored: string | null | undefined,
  before: AddressParts,
  after: AddressParts,
): { value: string; heldFor: string[] } {
  const rebuilt = composeAddress(after);
  const storedValue = typeof stored === "string" ? stored : "";
  if (!storedValue.trim()) return { value: rebuilt, heldFor: [] };

  const accounted = new Set(
    [before, after].flatMap((parts) =>
      [
        parts.addressLine1,
        parts.addressLine2,
        parts.city,
        parts.postcode,
        parts.country,
        parts.region,
      ].flatMap((value) => addressTokens(value)),
    ),
  );
  for (const word of addressTokens(rebuilt)) accounted.add(word);

  const orphaned = [...new Set(addressTokens(storedValue))].filter(
    (word) => !accounted.has(word),
  );
  if (!orphaned.length) return { value: rebuilt, heldFor: [] };
  // Byte-identical to what is stored, so holding writes the column back
  // unchanged rather than trimming or re-slicing it.
  return { value: storedValue, heldFor: orphaned };
}
