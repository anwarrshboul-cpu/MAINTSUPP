/**
 * RESOLVING A NAME TO A SITE — one implementation, and no database.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 *
 * Board rows carry no `site_id`. The monday export has store names and nothing
 * else, so every screen that wants to say "this Store Documentation row is that
 * site" has to go through the name. Three places already needed to: the
 * compliance register, the sites importer, and the public job form. A fourth is
 * arriving — the canonical submission service — and four hand-rolled name
 * matchers is four subtly different answers to "is 'Woodgreen' the same place as
 * 'Wood Green - High Road'?".
 *
 * The rule is the same one `siteIdByBoardName` has always applied and it is
 * repeated here because it is the whole design: THERE IS NO FUZZY MATCHING. A
 * name either normalises to one this site answers to, or the row keeps its own
 * identity. Guessing would attach one store's fire alarm certificate to another
 * store's row, which is worse than not linking at all. "Solihull" and
 * "Touchwood - Solihull" therefore do NOT link until somebody records the board
 * name on the site.
 *
 * ── WHY IT IMPORTS NOTHING ────────────────────────────────────────────────
 *
 * Deliberately no `db/schema`, no drizzle, no `getDb`. `sites-repository.ts`
 * held `normaliseSiteName` and pulls the schema in with it, so a client
 * component could not ask "does this name already exist?" without dragging the
 * whole ORM into the browser bundle. The repository already splits this way for
 * the same reason — see the note above its `site-state` import, "the Sites form
 * and the Manage-data drawer need them too and both are client components" —
 * and this is that split applied to the resolver.
 *
 * `sites-repository.ts` re-exports `normaliseSiteName`, so every existing
 * importer and every existing test pin keeps working and nothing had to be
 * edited in another agent's files to make this move.
 */

/**
 * Site names arrive from two monday boards that never agreed with each other:
 * "Wood Green - High Road" against "Woodgreen", "Brent Cross - Shopping Centre"
 * against "Brentcross". Normalisation strips everything that differs between
 * the two conventions so either spelling resolves to the same key.
 *
 * MOVED HERE FROM `sites-repository.ts`, unchanged to the character. The
 * en/em-dash class matters: monday exports carry U+2013 where a person typed a
 * hyphen, and a resolver that treated those as different characters would fail
 * on exactly the store names most likely to have been retyped by hand.
 */
export function normaliseSiteName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * The columns a site is recognised by.
 *
 * All three name columns, because they can and do disagree: `name` is what the
 * portal calls the place, and the two `monday*Name` columns are what each of
 * the two source boards called it. A site linked by its maintenance name and
 * not its compliance name is a site whose jobs find it and whose certificates
 * do not.
 */
export type SiteNameRow = {
  id: string;
  name: string;
  mondayComplianceName: string | null;
  mondayMaintenanceName: string | null;
};

/** A row from `site_aliases`, which stores the key already normalised. */
export type SiteAliasRow = { siteId: string; normalised: string };

/**
 * Every normalised key one site answers to.
 *
 * Exported because a caller that is checking ONE site — "has this name already
 * been recorded against this store?" — should not have to build an index over
 * the whole estate to find out.
 */
export function siteNameKeys(site: SiteNameRow): string[] {
  const keys: string[] = [];
  for (const value of [site.name, site.mondayComplianceName, site.mondayMaintenanceName]) {
    const key = value ? normaliseSiteName(value) : "";
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * `normalised name → siteId`, over an organisation's sites and their aliases.
 *
 * FIRST WRITER WINS, and that is not an accident. Two sites can normalise to
 * the same key — Staging holds same-named fixtures on purpose, and the alias
 * table is free to record a name another site also uses. Last-writer-wins would
 * make the link depend on the order rows came back from the database, which is
 * to say it would change between two reads of the same estate. Deterministic
 * and occasionally unhelpful beats non-deterministic.
 *
 * Was `siteIdByBoardName` in `compliance-register.ts`; the behaviour is
 * unchanged, including the order the three name columns are offered in.
 */
export function buildSiteNameIndex(
  siteRows: readonly SiteNameRow[],
  aliasRows: readonly SiteAliasRow[],
): Map<string, string> {
  const byName = new Map<string, string>();
  const remember = (value: string | null | undefined, siteId: string) => {
    const key = value ? normaliseSiteName(value) : "";
    if (key && !byName.has(key)) byName.set(key, siteId);
  };
  for (const site of siteRows) {
    remember(site.name, site.id);
    remember(site.mondayComplianceName, site.id);
    remember(site.mondayMaintenanceName, site.id);
  }
  /* Aliases are stored normalised, but they are put through the normaliser
     again rather than trusted. A row written before the normaliser last changed
     — or by a script that reimplemented it, and `db/monday-export` has one —
     would otherwise be the one key in the index built by different rules. */
  for (const alias of aliasRows) remember(alias.normalised, alias.siteId);
  return byName;
}

/**
 * One lookup against an index, for a name that has NOT been normalised yet.
 *
 * The normalisation happens here rather than at the call site because every
 * bug this module exists to prevent is a caller that forgot to do it, and a
 * caller that has already normalised gets the same answer — the function is
 * idempotent on its own output.
 */
export function resolveSiteIdByName(
  index: ReadonlyMap<string, string>,
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const key = normaliseSiteName(name);
  return key ? (index.get(key) ?? null) : null;
}

/** Both directions of the board-row ↔ site link, for one organisation. */
export type BoardSiteLink = {
  /** Board item id → site id, `null` where the name matched nothing. */
  siteIdByItemId: Map<string, string | null>;
  /** Site id → the FIRST board item that claimed it. */
  itemIdBySiteId: Map<string, string>;
};

/**
 * `boardItemId → siteId` and its inverse, for one organisation's board rows.
 *
 * Moved out of `compliance-register.ts` unchanged. The inverse keeps the first
 * board row that resolved to a site for the same reason the index keeps the
 * first name: a store with two rows on the register — and the board's own
 * "+ New store" button has produced duplicates — must not have its
 * "Not required" overrides land on a different one of them on each read.
 */
export function linkBoardRowsToSites(
  boardNames: ReadonlyArray<{ id: string; name: string }>,
  siteRows: readonly SiteNameRow[],
  aliasRows: readonly SiteAliasRow[],
): BoardSiteLink {
  const linkByName = buildSiteNameIndex(siteRows, aliasRows);
  const siteIdByItemId = new Map<string, string | null>(
    boardNames.map((row) => [row.id, resolveSiteIdByName(linkByName, row.name)]),
  );
  const itemIdBySiteId = new Map<string, string>();
  for (const [itemId, siteId] of siteIdByItemId) {
    if (siteId && !itemIdBySiteId.has(siteId)) itemIdBySiteId.set(siteId, itemId);
  }
  return { siteIdByItemId, itemIdBySiteId };
}
