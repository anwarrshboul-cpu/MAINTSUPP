/**
 * DEMO SITES — 2F. One definition of "this store is not real", and a mechanism
 * that cannot be pointed at a client's actual estate by accident.
 *
 * ── THERE IS NO DEMO FLAG, AND THAT IS THE PROBLEM TO SOLVE ───────────────
 *
 * `sites` has: id, organisationId, legacyClientId, name, type, region,
 * lifecycle, address, manager, slug, code, siteTypeValue, status, city,
 * postcode, country, latitude, longitude, position, active, billable,
 * billingActiveFrom. Not one of those means "demo", and none of them can be
 * repurposed to: `status` and `lifecycle` are reconciled against each other by
 * `reconcileSiteState` and drive the location picker; `billable` is an invoicing
 * fact somebody is going to bill from.
 *
 * ── WHAT I CHOSE, AND WHY NOT A COLUMN ────────────────────────────────────
 *
 * A reserved SITE GROUP with the slug `demo`, plus the naming convention the
 * fixtures already use as a read-only fallback.
 *
 * A column was the obvious answer and it is the wrong one here for three
 * reasons that compound:
 *
 *   • It means a guarded `addColumn` in `db/init.ts`, which runs on the boot
 *     path of every request and is being edited by concurrent work this batch.
 *   • A boolean on the row is invisible. Nobody browsing `sites` in a database
 *     client, and no screen that does not already know to look, would see it —
 *     which is exactly how a real client site ends up flagged and nobody
 *     notices for a month.
 *   • `site_groups` ALREADY EXISTS, is already per-register, already has an
 *     API (`/api/sites/groups`), and already renders. Membership is visible,
 *     deliberate, and reversible by removing the site from the group. Somebody
 *     has to put a store in a group called Demo; nothing does it silently.
 *
 * ── THE STANDING INSTRUCTION THIS IS BUILT AROUND ─────────────────────────
 *
 * A real client site is never marked demo to make a test pass. That is why the
 * fallback below is READ-ONLY and matches only a prefix no real store carries:
 * `ZZ-DEMO`, which is what the twelve Staging fixtures are actually called
 * ("ZZ-DEMO — Manchester Arndale", code `ZZD-S01`). Recognising them costs
 * nobody any data entry; it can never promote a real store, because a real
 * store is not called that.
 *
 * ── WHAT "DEMO" DOES AND DOES NOT MEAN ────────────────────────────────────
 *
 * It is a LABEL AND A FILTER, not a second data model. A demo site is a site:
 * it has jobs, a compliance profile and a register row like any other, and
 * nothing here removes it from a total behind anybody's back. Screens may offer
 * to hide them; the default is to show them with a badge, because a hidden row
 * that still counts is worse than a visible row that is labelled.
 *
 * No database imports — the sites list is a client component.
 */

/** The reserved group slug. Matching is on the slug, never on the label. */
export const DEMO_GROUP_SLUG = "demo";

/**
 * The prefix the Staging fixtures carry.
 *
 * Deliberately hostile to accident: two Zs and a hyphenated word no retailer
 * puts on a store front. Compared case-insensitively against the trimmed name
 * and the code, so "ZZ-DEMO — Leeds Trinity" and "ZZD-S03" are both recognised.
 */
const FIXTURE_NAME_PREFIX = "zz-demo";
const FIXTURE_CODE_PREFIX = "zzd-";

/** The fields this predicate reads. Every caller can supply all of them. */
export type DemoSiteInput = {
  name?: string | null;
  code?: string | null;
  /** Group slugs this site belongs to, if the caller has them. */
  groupSlugs?: readonly string[] | null;
};

/**
 * Is this a demo site?
 *
 * ONE definition, exported so no screen grows its own. Two screens disagreeing
 * about which stores are real is a worse failure than either answer, because
 * the disagreement is what nobody notices.
 *
 * Group membership is authoritative when the caller has it. The name
 * convention is the fallback for callers that do not — the sites list payload
 * does not carry group membership per row — and it exists so the existing
 * fixtures are recognised without a migration.
 */
export function isDemoSite(site: DemoSiteInput): boolean {
  if (site.groupSlugs?.some((slug) => slug.trim().toLowerCase() === DEMO_GROUP_SLUG)) {
    return true;
  }
  const name = (site.name ?? "").trim().toLowerCase();
  if (name.startsWith(FIXTURE_NAME_PREFIX)) return true;
  const code = (site.code ?? "").trim().toLowerCase();
  return code.startsWith(FIXTURE_CODE_PREFIX);
}

/** How a list may treat demo sites. */
export type DemoFilter = "all" | "hide" | "only";

/**
 * Read `?demo=` from a query string.
 *
 * DEFAULTS TO `all`, which is to say: demo sites are SHOWN unless somebody asks
 * otherwise. Defaulting to `hide` would mean a list that silently omits rows,
 * and a total that silently disagrees with the row count is the failure this
 * whole module is trying not to introduce.
 */
export function parseDemoFilter(value: string | null | undefined): DemoFilter {
  return value === "hide" || value === "only" ? value : "all";
}

/** Apply a filter to any rows this predicate can read. */
export function applyDemoFilter<T extends DemoSiteInput>(
  rows: readonly T[],
  filter: DemoFilter,
): T[] {
  if (filter === "all") return [...rows];
  const wanted = filter === "only";
  return rows.filter((row) => isDemoSite(row) === wanted);
}
