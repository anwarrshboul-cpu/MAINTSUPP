import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { getDb } from "../../db";
/*
 * W2 -- which register a row belongs to. `registerScopeFilter` is the ONLY
 * thing allowed to turn a scope into a predicate, because `= NULL` is never
 * true and a hand-rolled filter therefore reads an instance as empty and the
 * canonical register as everything. See that module's header for the model.
 */
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
  type RegisterScope,
} from "./register-scope";
/*
 * The state vocabulary and the reconciliation rule live in a module with no
 * database imports, because the Sites form and the Manage-data drawer need them
 * too and both are client components. Re-exported below so a server module that
 * already imports this repository does not have to know that.
 */
import {
  SITE_LIFECYCLE_CLOSED,
  SITE_LIFECYCLE_CURRENT,
  SITE_STATUS_CLOSED,
  SITE_STATUS_OTHER,
} from "./site-state";
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
export async function listRetailSites(
  db: Database,
  organisationId: string,
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const rows = await db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .orderBy(asc(sites.position), asc(sites.name));
  return rows.filter(
    (row) =>
      row.active &&
      row.status === "active" &&
      RETAIL_SITE_TYPES.includes(row.siteTypeValue ?? row.type ?? ""),
  );
}

/**
 * Every site in ONE register.
 *
 * W2 -- DEFAULT-DENY BY OMISSION. `scope` is optional in syntax only: leaving
 * it out selects the canonical register (`board_id IS NULL`) and never
 * "every scope". Every caller that predates instances therefore reads exactly
 * the rows it read before -- every existing row carries NULL -- and a caller
 * that forgets the argument on a new path gets the canonical register rather
 * than another register's estate. There is no call anywhere that reads across
 * scopes, and none can be written by forgetting an argument.
 *
 * The scope is in the SQL, not in the `filter` below: `includeInactive` is a
 * presentation choice over rows this register owns, while the scope decides
 * which register we are looking at at all, and that must never be a decision
 * made after the rows have already been fetched.
 */
export async function listSites(
  db: Database,
  organisationId: string,
  options: { includeInactive?: boolean } = {},
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const rows = await db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .orderBy(asc(sites.position), asc(sites.name));
  return options.includeInactive ? rows : rows.filter((row) => row.active);
}

/**
 * One site, BY ID AND BY REGISTER.
 *
 * The scope is in the predicate even though an id is already unique, because
 * this function is what the Sites route uses to decide whether a caller may
 * read or edit a row. Without it, an id belonging to an instance register
 * would be readable -- and PATCHable -- through the canonical screen by
 * anyone who had seen the id once. That is the object-reference hole the
 * organisation predicate beside it closes for tenants; this closes the same
 * hole for registers.
 */
export async function getSite(
  db: Database,
  organisationId: string,
  id: string,
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const [row] = await db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.id, id),
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The two Stage-0 columns a status implies AT CREATION, in one place.
 *
 * `lifecycle` and `active` are the lossy projections of `status`, and the
 * derivation used to know only two answers: 'closed' was Closed/false and
 * EVERYTHING ELSE was Current/true. That is wrong for 'other', which is how the
 * register records a row it cannot vouch for — a legacy or unverified location.
 * The three such rows on the canonical register are stored `status='other'`
 * with `lifecycle='Closed'` and `active=false`, and creating or moving a site
 * to 'other' contradicted them on the spot: the row came back Current and
 * active, and then read as an open location everywhere `active` is filtered on.
 *
 * The test is deliberately "not closed and not other" rather than
 * "is active". `status` also carries the configured 'international', which IS
 * open for business, and keying on 'active' alone would have quietly closed
 * every international site to fix the legacy ones.
 *
 * THIS IS THE CREATE-TIME PROJECTION AND ONLY THAT. It answers from a status
 * and nothing else because at insert there IS nothing else — no stored
 * lifecycle to keep, no eligibility anybody has stated. Closed is the
 * register's own convention for a row it cannot vouch for at the moment it
 * arrives, and the CSV importer has always filed one that way.
 *
 * EVERY EDIT OF AN EXISTING ROW GOES THROUGH `reconcileSiteState` in
 * app/lib/site-state.ts INSTEAD. Once a row exists the three columns are three
 * separate facts — is the record current, is it operationally eligible, how is
 * it classified — and projecting two of them out of the third is exactly how
 * `{ status: 'other', lifecycle: 'Current', active: false }`, which is a valid
 * internal or non-retail record, kept being flattened into a closed one. That
 * module owns the rule; this owns the first row only.
 */
export {
  SITE_LIFECYCLES,
  normaliseSiteLifecycle,
  reconcileSiteState,
  siteLifecycleRefusal,
  siteStateContradiction,
} from "./site-state";

export function stageZeroState(status: string): { active: boolean; lifecycle: string } {
  const open = status !== SITE_STATUS_CLOSED && status !== SITE_STATUS_OTHER;
  return {
    active: open,
    lifecycle: open ? SITE_LIFECYCLE_CURRENT : SITE_LIFECYCLE_CLOSED,
  };
}

/**
 * Every alias in one register.
 *
 * `site_aliases` deliberately carries NO scope column of its own. An alias
 * belongs to a site and a site belongs to a register, so the scope is joined
 * through rather than duplicated -- one fact, one place, and a site that
 * moved register could never leave its aliases behind in the old one.
 *
 * KNOWN LIMITATION, stated rather than hidden: the unique index
 * `site_aliases_organisation_normalised_idx` is on (organisation_id,
 * normalised) and so spans every register in the workspace. Two registers
 * therefore cannot both hold the alias "woodgreen", and the second is
 * REFUSED by `setSiteAliases`/`addSiteAlias` with the conflict reported. That
 * is a refusal, not a mis-route -- resolution below is scoped, so an alias
 * held by another register resolves to nothing rather than to that
 * register's site. Widening the index means dropping it, and `db/init.ts` is
 * additive-only on a path every request awaits, so it is not done here.
 */
export async function listAliases(
  db: Database,
  organisationId: string,
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const rows = await db
    .select({ alias: siteAliases })
    .from(siteAliases)
    .innerJoin(sites, eq(sites.id, siteAliases.siteId))
    .where(
      and(
        eq(siteAliases.organisationId, organisationId),
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    );
  return rows.map((row) => row.alias);
}

/**
 * Why a location string resolved to the site it resolved to — or to nothing.
 *
 * The same vocabulary `ContractorLinkReason` uses in
 * `app/lib/contractor-reference.ts`, and deliberately the same: an unknown name
 * and a register that cannot decide are different facts about the workspace,
 * and a caller filing a job is entitled to be told which one it hit rather than
 * being handed a silent null for both.
 */
export type SiteMatchReason =
  /** Exactly one site in this register answers to that name. */
  | "matched"
  /** The text was blank — there is nothing to resolve. */
  | "cleared"
  /** Nothing in this register answers to it. */
  | "unknown"
  /** Two or more do. Picking either would be a guess, so neither is picked. */
  | "ambiguous";

export type SiteMatch = {
  site: SiteRow | null;
  reason: SiteMatchReason;
  /** How many rows in this register answer to the name. */
  matches: number;
};

/**
 * X11 — resolve any historic name to one site IN ONE REGISTER.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
 *
 * This was `rows.find(...)`: the FIRST row whose name, monday name or code
 * matched won, and nothing anywhere counted the others. `codeConflict`'s own
 * header already names the consequence for codes — "job intake naming that code
 * attaches the work to whichever shop the query happened to return" — and there
 * was no equivalent guard for NAMES at all, because `findDuplicateCandidates`
 * only warns and there is no unique index on (organisation_id, name) to fall
 * back on. Two sites called "Wood Green" therefore routed inbound work to
 * whichever the position/name ordering returned first, silently and for ever.
 *
 * Now every match is collected and TWO IS A REFUSAL. A register that cannot
 * decide resolves nothing, exactly as `resolveContractorLink` refuses to put a
 * company's name against an invoice on a guess, and exactly as the contractor
 * backfill in `db/init.ts` guards itself with `count(*) = 1`.
 *
 * ── WHY A NAME COLLISION ACROSS REGISTERS IS NOT AMBIGUOUS ────────────────
 *
 * Because the two rows are never in the same result set. `listSites` puts the
 * scope in the SQL, so resolving inside an instance sees only that instance's
 * rows and resolving in the canonical register sees only canonical ones. Two
 * registers may each hold a "Wood Green" and both resolve cleanly — which is
 * the entire point of an independent instance, and is what makes this safe
 * where a workspace-wide unique index would merely have made it impossible.
 *
 * Aliases are scoped by JOINING to the site that owns them rather than by a
 * column of their own; see `listAliases` for why, and for the one limitation
 * that leaves.
 */
export async function resolveSiteMatch(
  db: Database,
  organisationId: string,
  candidate: string,
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<SiteMatch> {
  const trimmed = typeof candidate === "string" ? candidate.trim() : "";
  const key = normaliseSiteName(trimmed);
  if (!key) return { site: null, reason: "cleared", matches: 0 };

  /*
   * Scoped in SQL. The name comparison that follows cannot be: `normaliseSiteName`
   * strips punctuation, spacing and diacritics through NFKD, and neither SQLite
   * nor Postgres can express that portably. So the DATABASE decides which
   * register's rows are on the table and JavaScript decides which of those rows
   * the text names — the boundary that matters is the one the database holds.
   */
  const rows = await listSites(db, organisationId, { includeInactive: true }, scope);

  const codeKey = trimmed.toLowerCase();
  const direct = rows.filter(
    (row) =>
      normaliseSiteName(row.name) === key ||
      (row.mondayMaintenanceName && normaliseSiteName(row.mondayMaintenanceName) === key) ||
      (row.mondayComplianceName && normaliseSiteName(row.mondayComplianceName) === key) ||
      (row.code && row.code.trim().toLowerCase() === codeKey),
  );
  if (direct.length === 1) return { site: direct[0], reason: "matched", matches: 1 };
  if (direct.length > 1) {
    return { site: null, reason: "ambiguous", matches: direct.length };
  }

  /*
   * `limit(2)` rather than `limit(1)`, for the reason `resolveContractorLink`
   * gives: one round trip answers both "is there a match" and "is it unique".
   * The unique index makes two rows impossible today; the guard is what keeps
   * that a fact about the data rather than an assumption in the code.
   */
  const aliasRows = await db
    .select({ siteId: siteAliases.siteId })
    .from(siteAliases)
    .innerJoin(sites, eq(sites.id, siteAliases.siteId))
    .where(
      and(
        eq(siteAliases.organisationId, organisationId),
        eq(siteAliases.normalised, key),
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    )
    .limit(2);

  if (aliasRows.length === 0) return { site: null, reason: "unknown", matches: 0 };
  if (aliasRows.length > 1) {
    return { site: null, reason: "ambiguous", matches: aliasRows.length };
  }
  const site = rows.find((row) => row.id === aliasRows[0].siteId) ?? null;
  return site
    ? { site, reason: "matched", matches: 1 }
    : { site: null, reason: "unknown", matches: 0 };
}

/**
 * The site a name resolves to, or null — the shape the existing callers take.
 *
 * Ambiguity comes back as null here, which is the same answer an unknown name
 * gets and is the SAFE one: nothing is routed on a guess. A caller that wants
 * to tell a person WHY nothing resolved calls `resolveSiteMatch` above.
 */
export async function resolveSiteByName(
  db: Database,
  organisationId: string,
  candidate: string,
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<SiteRow | null> {
  return (await resolveSiteMatch(db, organisationId, candidate, scope)).site;
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
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const key = normaliseSiteName(name);
  if (!key) return [];
  /* Within one register only. A site of the same name in a DIFFERENT register
     is not a duplicate — two independent registers holding "Wood Green" is the
     feature, not the fault — and warning about it would train an admin to click
     past the warning that matters. */
  const rows = await listSites(db, organisationId, { includeInactive: true }, scope);
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

/**
 * Every site code in the workspace — DELIBERATELY UNSCOPED, and the only read
 * here that is.
 *
 * A site code is not register data. It is a workspace-level reference printed
 * on work orders, and `sites_organisation_code_idx` is unique on
 * (organisation, code) with no board in it. Narrowing this read to one register
 * therefore breaks the thing it exists for: `generateSiteCode` is handed the
 * codes already TAKEN so it can pick a free one, and an empty instance offers
 * an empty list, so it re-derived a code the canonical register already had and
 * the insert died on the index — "Another site already uses that code", for a
 * site the operator could not see.
 *
 * It took a scope argument briefly, while the register scope was being added,
 * and that is what this note is here to prevent being done again. Two registers
 * may hold a site of the same NAME — that is the point of instances, and the
 * name resolvers are scope-aware for exactly that reason. They cannot hold the
 * same CODE, because the code names the site to a contractor reading a job, and
 * ambiguity there is a real-world failure rather than a data-model one.
 */
export async function existingSiteCodes(db: Database, organisationId: string) {
  const rows = await db
    .select({ code: sites.code })
    .from(sites)
    .where(eq(sites.organisationId, organisationId));
  return rows.map((row) => row.code).filter((code): code is string => Boolean(code));
}

/* Positions are per register: a new site on an instance starts at 0 rather
   than after the canonical register's 31 rows, which would leave a fresh
   instance's first row sorting as though thirty invisible ones preceded it. */
export async function nextSitePosition(
  db: Database,
  organisationId: string,
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const rows = await db
    .select({ position: sites.position })
    .from(sites)
    .where(
      and(
        eq(sites.organisationId, organisationId),
        registerScopeFilter(sites.boardId, scope),
      ),
    );
  return rows.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
}

/**
 * Slugs are unique per organisation, so a repeated name gets a numeric suffix.
 *
 * THE UNIQUE INDEX IS STILL ORGANISATION-WIDE — `sites_organisation_slug_idx`
 * is on (organisation_id, slug) and cannot be narrowed without dropping it,
 * which `db/init.ts` may not do. So the candidates are read organisation-wide
 * on purpose: reading only this register's slugs would hand back a slug the
 * index then rejects, turning a silent suffix into a failed save. The scope
 * argument is accepted and ignored for exactly that reason, and saying so
 * here is cheaper than the next reader assuming it was forgotten.
 */
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
  scope: RegisterScope = CANONICAL_REGISTER,
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
    .where(
      and(
        eq(sites.organisationId, organisationId),
        /* W2 — WITHIN THIS REGISTER. The reason given above is that an alias
           equal to a live site name can never be reached, because
           `resolveSiteMatch` matches site names before aliases. That is a fact
           about ONE register's resolution, so a site of the same name in a
           DIFFERENT register shadows nothing and must not refuse the alias.
           (The `site_aliases` unique key below is still organisation-wide and
           is left that way — see `listAliases` for why it cannot be narrowed.) */
        registerScopeFilter(sites.boardId, scope),
      ),
    );
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
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<{ siteId: string; kind: "site" | "alias" } | null> {
  const key = normaliseSiteName(name);
  if (!key) return null;
  const rows = await listSites(db, organisationId, { includeInactive: true }, scope);
  const site = rows.find((row) => row.id !== excludeId && normaliseSiteName(row.name) === key);
  if (site) return { siteId: site.id, kind: "site" };
  /*
   * The alias half stays ORGANISATION-WIDE, and that is not an oversight.
   * `site_aliases_organisation_normalised_idx` spans the whole workspace, so an
   * alias key held by ANOTHER register would be rejected by the database at
   * insert time. Reporting the conflict up front is the whole reason this
   * function exists — narrowing it to the register would let the rename be
   * accepted here and then half-applied, which is the failure `addSiteAlias`
   * refuses by name in its own header.
   */
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
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<string | null> {
  const key = code.trim().toLowerCase();
  if (!key) return null;
  /*
   * Per register, because `resolveSiteMatch` now reads a code within a register
   * too, so that is exactly the keyspace a duplicate would make ambiguous.
   *
   * NOTE the database index is still organisation-wide
   * (`sites_organisation_code_idx`), so two registers cannot in fact both use
   * "WDGR" and the second write is refused by the index rather than by this
   * check. Refusal is safe; the alternative — narrowing the index — means
   * dropping it, which `db/init.ts` may not do on a boot path.
   */
  const rows = await listSites(db, organisationId, { includeInactive: true }, scope);
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

/**
 * The reporting groups of ONE register, with their membership.
 *
 * `site_groups` carries the scope column itself rather than joining through a
 * site, because a group can legitimately be empty and an empty group joined
 * through its members would belong to no register at all.
 *
 * Membership needs no scope of its own: both ends are already scoped, and
 * `setSiteGroupMembership` below refuses to link across registers, so a
 * member row can only ever join two rows of the same register.
 */
export async function listSiteGroups(
  db: Database,
  organisationId: string,
  scope: RegisterScope = CANONICAL_REGISTER,
) {
  const [groups, members] = await Promise.all([
    db
      .select()
      .from(siteGroups)
      .where(
        and(
          eq(siteGroups.organisationId, organisationId),
          registerScopeFilter(siteGroups.boardId, scope),
        ),
      )
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

/**
 * Every group slug already claimed in this workspace, ACROSS EVERY REGISTER.
 *
 * The one read in this module that deliberately spans registers, and it spans
 * them because the DATABASE does: `site_groups_organisation_slug_idx` is unique
 * on (organisation_id, slug) and cannot be narrowed without dropping it, which
 * `db/init.ts` may not do on a path every request awaits.
 *
 * So a slug is chosen against the whole workspace. Choosing it against one
 * register instead would hand back a slug the index then rejects, turning a
 * silent numeric suffix — which is what a repeated group name is supposed to
 * get — into a failed save with a database error behind it. Reading wide to
 * write narrow is the correct shape here; it is stated rather than left to be
 * mistaken for a missing filter.
 */
export async function claimedGroupSlugs(db: Database, organisationId: string) {
  const rows = await db
    .select({ slug: siteGroups.slug })
    .from(siteGroups)
    .where(eq(siteGroups.organisationId, organisationId));
  return new Set(rows.map((row) => row.slug));
}

/**
 * A site's group membership, replaced.
 *
 * The `owned` read below was already the guard that stops a caller attaching
 * a site to another TENANT's group. The scope predicate makes it the same
 * guard across registers: a group id from the canonical register cannot be
 * attached to an instance's site, because the select that validates the ids
 * never returns it. Ids that do not survive that read are dropped silently,
 * which is the behaviour this function already had for a foreign tenant.
 */
export async function setSiteGroupMembership(
  db: Database,
  organisationId: string,
  siteId: string,
  groupIds: string[],
  scope: RegisterScope = CANONICAL_REGISTER,
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
        registerScopeFilter(siteGroups.boardId, scope),
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
