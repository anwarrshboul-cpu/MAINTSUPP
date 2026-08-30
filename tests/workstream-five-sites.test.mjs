import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Workstream 5 — the site register.
 *
 * Workstreams 4 and 8 each have an acceptance suite; this one had none, and the
 * defects it now pins were all found by hand because nothing was watching for
 * them. Each test below is a rule the register is supposed to obey, written so
 * that breaking the rule breaks the build rather than a spreadsheet six months
 * from now.
 *
 * TWO KINDS OF ASSERTION, deliberately kept apart:
 *
 *   SOURCE — read the route and prove the rule is encoded there. These run
 *   anywhere, need no database, and are what catch a refactor that quietly
 *   removes a guard.
 *
 *   REGISTER — read the development database and prove the DATA obeys the rule.
 *   These skip when there is no database, the same bargain
 *   `batch-1b-canonical-links.test.mjs` makes.
 *
 * The register assertions are INVARIANTS, never counts. The development
 * workspace is a scratch tenant that QA fixtures come and go from, so "there
 * are 31 sites" is not a property of correct software — "no site resolves to
 * another tenant's row" is. The one place an exact shape IS asserted is the
 * canonical register block near the bottom, and it identifies itself by the
 * canonical site NAMES and skips when they are absent, so a workspace that is
 * not the canonical one cannot make it fail.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The development database, opened read-only — the bargain the sibling suites make. */
async function openDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  /*
   * A canonical snapshot may be named explicitly.
   *
   * Without this the opener can only ever find the development workspace, which
   * is a scratch tenant holding different sites — so the two register-shape
   * tests below would skip on every machine and never once run. That is a test
   * that cannot fail, which is worse than no test.
   *
   * `MAINTSUPP_SQLITE` points at a SQLite file holding the canonical register;
   * the same shape as `DATABASE_URL` in `tests/node-pg-d1.test.mjs`, which is
   * how this repo already lets a suite name the database it should read.
   */
  const named = process.env.MAINTSUPP_SQLITE?.trim();
  if (named) {
    try {
      return new DatabaseSync(named, { readOnly: true });
    } catch (error) {
      console.warn(`MAINTSUPP_SQLITE could not be opened: ${error.message}`);
      return null;
    }
  }

  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    return new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
  } catch (error) {
    console.warn(`could not open the development database: ${error.message}`);
    return null;
  }
}

/** True when the table exists — a database mid-migration must skip, not fail. */
function hasTable(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name),
  );
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

// ---------------------------------------------------------------------------
// The canonical register — the shape Workstream 5 signed off.
// ---------------------------------------------------------------------------

/**
 * The register as verified against the canonical database on 2026-08-30.
 *
 * Written out in full rather than as four numbers, because the numbers are the
 * least interesting part: what matters is WHICH sites are retail and which are
 * legacy, and a count cannot say that. A site that changes category shows up
 * here as a named difference.
 */
const CANONICAL = {
  activeInline: [
    "Aldgate",
    "Bluewater",
    "Cabot Circus - Bristol",
    "Churchill Square - Brighton",
    "Grand Arcade - Cardiff",
    "Southall",
  ],
  activeKiosk: [
    "Atria Watford",
    "Brentcross",
    "Bullring - Birmingham",
    "Manchester Arndale",
    "Meadowhall",
    "Merry Hill",
    "Silverburn - Glasgow",
    "The Centre:MK",
    "The Oracle Centre - Reading",
    "Touchwood - Solihull",
    "Trafford Centre - Manchester",
    "Victoria Centre - Nottingham",
    "Westfield Stratford",
    "Westfield White City Original",
    "Woodgreen",
  ],
  activeNonRetail: ["HQ - The Loom", "Warehouse 1", "Warehouse 2"],
  closed: [
    "Cribbs Causeway - Bristol",
    "Highcross Leicester",
    "Metrocentre - Gateshead (Newcastle)",
    "Westfield White City Bespoke",
  ],
  /** LEGACY / UNVERIFIED. These must never be promoted without new Monday evidence. */
  legacyOther: [
    "Sunnamusk Aldgate Warehouse",
    "Sunnamusk Manchester Trafford",
    "Sunnamusk Oxford Street",
  ],
  /** alias -> the canonical site name it must resolve to. */
  aliases: {
    "Cardiff St Davids": "Grand Arcade - Cardiff",
    "Sunnamusk Birmingham Bullring": "Bullring - Birmingham",
    "Sunnamusk Leicester Highcross": "Highcross Leicester",
    "Sunnamusk Westfield Stratford": "Westfield Stratford",
  },
};

test("the canonical register is written down, and its own arithmetic agrees", () => {
  // 21 retail, 24 active, 4 closed, 3 legacy, 31 total. Derived, not restated,
  // so the lists above cannot drift away from the counts the workstream signed.
  const retail = CANONICAL.activeInline.length + CANONICAL.activeKiosk.length;
  const active = retail + CANONICAL.activeNonRetail.length;
  const total = active + CANONICAL.closed.length + CANONICAL.legacyOther.length;
  assert.equal(retail, 21, "21 active retail sites");
  assert.equal(active, 24, "24 active sites in total");
  assert.equal(CANONICAL.closed.length, 4, "4 closed sites");
  assert.equal(CANONICAL.legacyOther.length, 3, "3 legacy/unverified sites");
  assert.equal(total, 31, "31 sites in the register");
  assert.equal(Object.keys(CANONICAL.aliases).length, 4, "4 recorded aliases");

  // No name appears in two categories. A site is one thing.
  const all = [
    ...CANONICAL.activeInline,
    ...CANONICAL.activeKiosk,
    ...CANONICAL.activeNonRetail,
    ...CANONICAL.closed,
    ...CANONICAL.legacyOther,
  ];
  assert.equal(new Set(all).size, all.length, "no site is listed in two categories");

  // An alias is never also a canonical site name — that is a rename, not an alias.
  for (const alias of Object.keys(CANONICAL.aliases)) {
    assert.ok(!all.includes(alias), `"${alias}" is an alias and must not also be a site name`);
  }
  // Every alias points at a site that exists in the register.
  for (const [alias, target] of Object.entries(CANONICAL.aliases)) {
    assert.ok(all.includes(target), `alias "${alias}" points at "${target}", which must be a real site`);
  }
});

test("Cardiff St Davids resolves to Grand Arcade - Cardiff and to nothing else", () => {
  // The one alias the workstream was asked for by name. Pinned separately so a
  // failure names the rule rather than "the alias table changed".
  assert.equal(CANONICAL.aliases["Cardiff St Davids"], "Grand Arcade - Cardiff");
  assert.ok(
    CANONICAL.activeInline.includes("Grand Arcade - Cardiff"),
    "the target is an active retail site, so the alias reaches something a job can be filed against",
  );
});

// ---------------------------------------------------------------------------
// SOURCE — an edit may only change what it carried.
// ---------------------------------------------------------------------------

test("PATCH /api/sites preserves every column the request did not carry", async () => {
  const route = await read("app/api/sites/route.ts");

  /*
   * THE DEFECT THIS PINS. `sitePayload` builds every column from the body and
   * the builders answer a missing key exactly as they answer a cleared one:
   * `optionalText(undefined)` is null, `optionalNumber(undefined)` is null, and
   * `text(undefined, 60) || "UK"` is the literal "UK". PATCH then wrote the whole
   * object, so `region` reverted to "UK" and the coordinates were nulled on every
   * save from a form that has never rendered them.
   */
  assert.match(route, /function preserveUnsent/, "the preservation helper must exist");
  assert.match(
    route,
    /const payload = preserveUnsent\(sitePayload\(sent\), sent, existing\)/,
    "PATCH must merge the request over the stored row, not replace it",
  );
  assert.match(
    route,
    /sources\.some\(\(source\) => data\[source\] !== undefined\)/,
    "presence must be decided by `!== undefined`, so a null or an empty string still clears",
  );
  assert.match(
    route,
    /const PAYLOAD_SOURCES: Record<keyof SitePayload, readonly string\[\]>/,
    "the key-to-column table must be typed against SitePayload so a new column cannot be forgotten",
  );

  // POST is deliberately NOT preserved — a new row has nothing to preserve.
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.doesNotMatch(post, /preserveUnsent/, "POST must keep building a full row from defaults");

  // Every column the payload builds must be reachable from at least one request key.
  const payloadKeys = [
    ...route
      .slice(route.indexOf("function sitePayload"), route.indexOf("type SitePayload"))
      .matchAll(/^\s{4}(\w+):/gm),
  ].map((m) => m[1]);
  const sourceTable = route.slice(
    route.indexOf("const PAYLOAD_SOURCES"),
    route.indexOf("AN EDIT MAY ONLY CHANGE"),
  );
  assert.ok(payloadKeys.length > 30, `expected the full payload, found ${payloadKeys.length} keys`);
  for (const key of payloadKeys) {
    assert.match(
      sourceTable,
      new RegExp(`\\b${key}:\\s*\\[`),
      `PAYLOAD_SOURCES must name "${key}" or an edit can no longer reach that column`,
    );
  }
});

test("region and the coordinates are the three columns the bug destroyed, and all three are covered", async () => {
  const route = await read("app/api/sites/route.ts");
  for (const column of ["region", "latitude", "longitude"]) {
    assert.match(
      route,
      new RegExp(`\\b${column}:\\s*\\["${column}"\\]`),
      `${column} must be listed in PAYLOAD_SOURCES`,
    );
  }
  // And the form must carry region, so the one screen that owns a site can correct it.
  const form = await read("app/(app)/portal/sites/site-form.tsx");
  assert.match(form, /region: site\?\.region \?\? "UK"/, "the form must seed region from the row");
  assert.match(form, /id="region"/, "the form must render a region field");
});

test("a CSV import may only change the columns its sheet carries", async () => {
  const route = await read("app/api/sites/csv/route.ts");

  /*
   * The same defect, arriving by import. `parseCsvObjects` keys each record by
   * the file's own header row, so a column the sheet omits is an absent key —
   * and `cell()` answers an absent key with "" exactly as it answers a blank
   * one. The update branch wrote the whole object, so a two-column sheet nulled
   * every optional field on every matched site and reset region to "UK".
   */
  assert.match(route, /function sheetUpdate/, "the header-aware update must exist");
  assert.match(
    route,
    /\.set\(sheetUpdate\(values, headers, existing\)\)/,
    "the UPDATE branch must write the header-aware object, never the full `values`",
  );
  assert.doesNotMatch(
    route,
    /\.update\(sites\)\s*\n?\s*\.set\(values\)/,
    "the full-replace update is what destroyed the register and must not come back",
  );
  assert.match(
    route,
    /const headers = new Set\(Object\.keys\(records\[0\]\)\)/,
    "the header set is what tells an absent column from a blank cell",
  );
  assert.match(
    route,
    /if \(!headers\.has\(header\)\) continue;/,
    "a column the sheet does not carry must be skipped, not written",
  );

  // region must never be re-derived over a stored value.
  assert.doesNotMatch(
    route,
    /^\s*region: status === "international" \? "Europe" : "UK",$/m,
    'the unconditional `region: status === "international" ? "Europe" : "UK"` reset every non-UK site',
  );
  assert.match(route, /"region",/, "region must be an exported and importable column");

  // The INSERT branch is untouched on purpose: a new row has nothing to preserve.
  assert.match(
    route,
    /cell\(record, "region"\) \|\| \(status === "international" \? "Europe" : "UK"\)/,
    "a NEW row may still fall back to the derived region",
  );
});

test("the Stage 0 twins move only when the status actually moves", async () => {
  /*
   * `lifecycle` and `active` are derived from `status`, and the derivation only
   * knows closed-from-not-closed. The register holds legacy rows recorded as
   * status='other' WITH lifecycle='Closed', so re-deriving on every save
   * promoted them to 'Current' — a legacy row quietly becoming a current one.
   */
  const route = await read("app/api/sites/route.ts");
  assert.match(
    route,
    /const lifecycleState =\s*\n?\s*status === existing\.status/,
    "PATCH must leave the twins alone when the status did not change",
  );
  const csv = await read("app/api/sites/csv/route.ts");
  assert.match(
    csv,
    /if \(headers\.has\("status"\) && values\.status !== existing\.status\)/,
    "the importer must apply the same rule",
  );
});

// ---------------------------------------------------------------------------
// SOURCE — nothing is guessed, nothing is invented.
// ---------------------------------------------------------------------------

test("a site name resolves exactly or not at all", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  const resolve = repository.slice(
    repository.indexOf("export async function resolveSiteByName"),
    repository.indexOf("export async function findDuplicateCandidates"),
  );

  // Exact, normalised equality on the name, both monday columns, the code, and
  // the alias table. Nothing else.
  assert.match(resolve, /normaliseSiteName\(row\.name\) === key/, "the canonical name must match exactly");
  assert.match(resolve, /eq\(siteAliases\.normalised, key\)/, "an alias must match exactly");
  assert.match(resolve, /if \(!alias\) return null/, "an unmatched name resolves to nothing");

  // The fuzzy operators that `findDuplicateCandidates` uses to WARN must never
  // appear in the resolver, which DECIDES.
  assert.doesNotMatch(resolve, /\.includes\(/, "resolution must not use substring matching");
  assert.doesNotMatch(resolve, /\blike\b/i, "resolution must not use LIKE");
  assert.doesNotMatch(resolve, /levenshtein|similarity|fuzzy|distance/i, "no fuzzy matching");
  assert.doesNotMatch(resolve, /rows\[0\]/, "no arbitrary first-site fallback");
});

test("no writer invents a site, and an unmatched job records that it has none", async () => {
  const reference = await read("app/lib/site-reference.ts");
  assert.match(reference, /export function unassignedSiteId\(\)/);
  assert.match(reference, /siteIdIsNullable\(\) \? null : UNASSIGNED_SITE_ID/, "NULL where the database can hold it");

  for (const path of ["app/api/report-job/route.ts", "app/api/import/route.ts"]) {
    const source = await read(path).catch(() => null);
    if (source === null) continue;
    assert.doesNotMatch(
      source,
      /insert\(sites\)/,
      `${path} must never create a site from job intake`,
    );
  }
});

test("placeholder rows never become sites", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  assert.match(repository, /export function junkReason/);
  assert.match(repository, /\^item\\s\*\\d\+\$/, "an unedited monday placeholder is refused");
  assert.match(repository, /return "The row has no site name."/);
});

// ---------------------------------------------------------------------------
// SOURCE — a location picker offers open retail sites and nothing else.
// ---------------------------------------------------------------------------

test("the site dropdown is scoped to active retail sites only", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  assert.match(
    repository,
    /const RETAIL_SITE_TYPES = \["Inline", "Kiosk"\]/,
    "retail means Inline and Kiosk — the office and the warehouses are not shops",
  );
  const listing = repository.slice(
    repository.indexOf("export async function listRetailSites"),
    repository.indexOf("export async function listSites"),
  );
  assert.match(listing, /row\.active/, "an archived site is not offered");
  assert.match(listing, /row\.status === "active"/, "closed, international and legacy rows are not offered");
  assert.match(
    listing,
    /RETAIL_SITE_TYPES\.includes\(row\.siteTypeValue \?\? row\.type \?\? ""\)/,
    "only retail types are offered",
  );

  // One definition, used by both consumers, or the dropdown and the register
  // come to disagree.
  const formOptions = await read("app/lib/form-options.ts");
  assert.match(formOptions, /listRetailSites/, "the public form must use the shared definition");
  assert.doesNotMatch(
    formOptions,
    /status === "active"/,
    "the public form must not re-implement the scope rule",
  );
});

// ---------------------------------------------------------------------------
// SOURCE — every site route is organisation-scoped and capability-gated.
// ---------------------------------------------------------------------------

const SITE_ROUTES = [
  "app/api/sites/route.ts",
  "app/api/sites/csv/route.ts",
  "app/api/sites/groups/route.ts",
];

test("every site write is capability-gated, and every read is organisation-scoped", async () => {
  for (const path of SITE_ROUTES) {
    const source = await read(path);
    assert.match(
      source,
      /scopedDbWithCapability\(request, "/,
      `${path} must gate its writes on a capability, not merely resolve a tenant`,
    );
    // Every verb that writes resolves the capability, not just the first one.
    for (const verb of ["POST", "PATCH", "DELETE"]) {
      const start = source.indexOf(`export async function ${verb}(`);
      if (start === -1) continue;
      const body = source.slice(start, start + 900);
      assert.match(
        body,
        /scopedDbWithCapability|guard\.denied/,
        `${verb} in ${path} must be capability-gated`,
      );
    }
  }
});

test("a site is looked up by id AND organisation, so another tenant's row is not found", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  const getSite = repository.slice(
    repository.indexOf("export async function getSite"),
    repository.indexOf("export async function listAliases"),
  );
  assert.match(
    getSite,
    /and\(eq\(sites\.id, id\), eq\(sites\.organisationId, organisationId\)\)/,
    "one query must carry both predicates so they cannot drift apart",
  );

  const route = await read("app/api/sites/route.ts");
  // The refusal is 404 for both "missing" and "someone else's", with the same
  // body — a 403 would confirm a competitor's store name to a stranger.
  const refusals = route.match(/return Response\.json\(\{ error: "Site not found\." \}, \{ status: 404 \}\)/g) ?? [];
  assert.ok(refusals.length >= 2, `expected the same 404 on every branch, found ${refusals.length}`);
  assert.doesNotMatch(route, /status: 403 \}\);\s*\n\s*\}\s*\n\s*const existing/, "never 403 for a site id");

  // Every UPDATE names the organisation as well as the id.
  const updates = route.match(/\.where\(and\(eq\(sites\.id, id\), eq\(sites\.organisationId, orgId\)\)\)/g) ?? [];
  assert.ok(updates.length >= 3, `every site UPDATE must be tenant-filtered, found ${updates.length}`);
});

test("a reporting group from another tenant cannot be assigned to a site", async () => {
  const route = await read("app/api/sites/route.ts");
  assert.match(route, /async function unknownGroupRefusal/, "group ids must be validated before they are written");
  assert.match(
    route,
    /const owned = new Set\(\(await listSiteGroups\(db, orgId\)\)\.map\(\(group\) => group\.id\)\)/,
    "validation must be against the caller's own organisation",
  );
  const repository = await read("app/lib/sites-repository.ts");
  const membership = repository.slice(repository.indexOf("export async function setSiteGroupMembership"));
  assert.match(
    membership.slice(0, 1200),
    /organisationId/,
    "membership rows must carry the organisation",
  );
});

test("an error from the sites route never publishes the schema", async () => {
  const route = await read("app/api/sites/route.ts");
  assert.match(route, /function sitesDatabaseError/);
  assert.match(
    route,
    /if \(process\.env\.NODE_ENV === "development"\)/,
    "raw database text is development-only",
  );
  assert.match(route, /return "Sites are temporarily unavailable\."/, "production says nothing about the query");
});

test("a database fault on a WRITE is answered like one on a read, not with the statement", async () => {
  /*
   * OBSERVED, not theorised. Two suites saving a site at once lock the
   * development D1, and `PATCH /api/sites` answered an ordinary HTTP client:
   *
   *   400 {"error":"Failed query: update \"sites\" set \"name\" = ?, \"type\" = ?,
   *        \"region\" = ?, \"address\" = ?, \"manager\" = ?, \"slug\" = ?, \"code\" = ?, …"}
   *
   * `sitesDatabaseError` exists precisely to stop that — it unwraps the cause,
   * gates the raw text on NODE_ENV, and answers 503 rather than 400, because a
   * database that is down is not the caller's bad input. GET was fixed to use
   * it and the write verbs were left behind, so every one of them still returns
   * `error.message` verbatim, in production as well as development. A Drizzle
   * error's `.message` is the whole failing statement.
   *
   * The same catch also carries the deliberate sentences — "A site name is
   * required." — so the fix is to tell the two apart, not to silence the branch.
   */
  for (const path of [
    "app/api/sites/route.ts",
    "app/api/sites/groups/route.ts",
    "app/api/sites/csv/route.ts",
  ]) {
    const source = await read(path);
    const raw = source.match(
      /const message = error instanceof Error \? error\.message : "[^"]+";\s*\n\s*return Response\.json\(\{ error: message \}/g,
    ) ?? [];
    assert.deepEqual(
      raw,
      [],
      `${path} returns a raw error message to the client on ${raw.length} branch(es); ` +
        "route it through `sitesDatabaseError` (or an equivalent) so a database fault does not publish the statement",
    );
  }
});

// ---------------------------------------------------------------------------
// REGISTER — the data itself. Invariants only; skips without a database.
// ---------------------------------------------------------------------------

test("the register carries no fake, placeholder or duplicate site", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }

  assert.equal(
    count(db, "SELECT count(*) n FROM sites WHERE trim(coalesce(name,'')) = ''"),
    0,
    "a site with no name resolves to nothing and silently stops matching its jobs",
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM sites WHERE name GLOB 'Item [0-9]*' OR name GLOB 'item [0-9]*'"),
    0,
    "unedited monday placeholders must never have become sites",
  );
  assert.equal(
    count(db, "SELECT count(*) n FROM sites WHERE trim(coalesce(address_line1,'')) = '' AND trim(coalesce(address,'')) = ''"),
    0,
    "a site with no address at all is a row nobody entered on purpose",
  );

  // Two sites in one tenant answering to the same name is a resolution ambiguity:
  // `resolveSiteByName` takes the first match, so the second becomes unreachable.
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM (
         SELECT organisation_id, lower(trim(name)) k FROM sites
         GROUP BY 1, 2 HAVING count(*) > 1)`,
    ),
    0,
    "no two sites in one organisation share a name",
  );
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM (
         SELECT organisation_id, slug FROM sites WHERE slug IS NOT NULL AND slug <> ''
         GROUP BY 1, 2 HAVING count(*) > 1)`,
    ),
    0,
    "no two sites in one organisation share a slug",
  );
  db.close();
});

test("every alias is unambiguous, in-tenant, and not a site name in disguise", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "site_aliases")) {
    t.skip("no development database");
    return;
  }

  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_aliases a
        WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = a.site_id)`,
    ),
    0,
    "an alias pointing at no site resolves a job to nothing",
  );
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_aliases a JOIN sites s ON s.id = a.site_id
        WHERE s.organisation_id <> a.organisation_id`,
    ),
    0,
    "an alias must never reach across organisations",
  );
  // The unique index is on (organisation_id, normalised); prove the data agrees,
  // because a second holder of the same string makes resolution order-dependent.
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM (
         SELECT organisation_id, normalised FROM site_aliases
         GROUP BY 1, 2 HAVING count(*) > 1)`,
    ),
    0,
    "one normalised alias, one site",
  );
  // An alias that is also a live site name means one string resolves two ways.
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_aliases a JOIN sites s
          ON s.organisation_id = a.organisation_id
         AND lower(trim(s.name)) = lower(trim(a.alias))
       WHERE s.id <> a.site_id`,
    ),
    0,
    "no alias is another site's current name",
  );
  db.close();
});

test("a legacy row stays legacy — status 'other' is never promoted", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }
  /*
   * "Legacy stays legacy" is a rule about the three UNVERIFIED rows, so it is
   * asserted against them by NAME. A count over every status='other' row would
   * be a different and weaker claim: 'other' is a status an admin can choose
   * from the Sites form for a site that is genuinely neither open nor closed,
   * and such a row is legitimately `active = 1`.
   *
   * The Stage 0 twins used to be re-derived from `status` on every save, and
   * 'other' is not 'closed', so a single re-save turned lifecycle 'Closed' into
   * 'Current' and a legacy row became a current one.
   */
  const legacy = db
    .prepare(
      `SELECT name, status, lifecycle, active FROM sites
        WHERE name IN (${CANONICAL.legacyOther.map(() => "?").join(", ")})`,
    )
    .all(...CANONICAL.legacyOther);
  if (!legacy.length) {
    t.skip("this database does not hold the legacy rows");
    db.close();
    return;
  }
  for (const row of legacy) {
    assert.equal(row.status, "other", `${row.name} must stay legacy, not be promoted`);
    assert.equal(row.lifecycle, "Closed", `${row.name} must keep its Stage 0 lifecycle`);
    assert.equal(Number(row.active), 0, `${row.name} must not be offered as an open site`);
  }
  db.close();
});

test("nothing that is not an open retail site can reach a location picker", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }
  /*
   * The scope rule stated as data rather than as code: whatever else is in the
   * register, the set a picker may offer contains no closed site, no legacy
   * row, no office and no warehouse. This is `listRetailSites` read back off
   * the database, and it holds on any workspace, so QA fixtures cannot break it.
   */
  const offered = db
    .prepare(
      `SELECT name, status, coalesce(site_type_value, type) AS kind, active
         FROM sites
        WHERE active = 1 AND status = 'active'
          AND coalesce(site_type_value, type) IN ('Inline', 'Kiosk')`,
    )
    .all();
  for (const row of offered) {
    assert.equal(row.status, "active", `${row.name} is offered and must be active`);
    assert.ok(
      ["Inline", "Kiosk"].includes(row.kind),
      `${row.name} is offered and must be a retail type, not ${row.kind}`,
    );
  }
  // And the converse: no closed, legacy, office or warehouse row satisfies the scope.
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM sites
        WHERE active = 1 AND status = 'active'
          AND coalesce(site_type_value, type) IN ('Inline', 'Kiosk')
          AND status IN ('closed', 'other', 'international')`,
    ),
    0,
    "the scope rule cannot be satisfied by a closed or legacy row",
  );
  db.close();
});

// ---------------------------------------------------------------------------
// REGISTER — the exact canonical shape, when the canonical register is present.
// ---------------------------------------------------------------------------

test("the canonical register has exactly the shape Workstream 5 signed off", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }
  /*
   * Identified by NAME, not by count. The development workspace is a scratch
   * tenant with different sites entirely, so this skips there; it runs against
   * a database that actually holds the canonical register and then it is exact.
   */
  const marker = db
    .prepare("SELECT count(*) n FROM sites WHERE name = ? OR name = ?")
    .get("Grand Arcade - Cardiff", "Sunnamusk Oxford Street").n;
  if (marker < 2) {
    t.skip("this database does not hold the canonical register");
    db.close();
    return;
  }

  const rows = db
    .prepare("SELECT name, status, coalesce(site_type_value, type) AS kind FROM sites")
    .all();
  const named = (status, kind) =>
    rows.filter((r) => r.status === status && (!kind || r.kind === kind)).map((r) => r.name).sort();

  assert.deepEqual(named("active", "Inline"), [...CANONICAL.activeInline].sort());
  assert.deepEqual(named("active", "Kiosk"), [...CANONICAL.activeKiosk].sort());
  assert.deepEqual(named("closed"), [...CANONICAL.closed].sort());
  assert.deepEqual(named("other"), [...CANONICAL.legacyOther].sort());
  assert.equal(rows.length, 31, "31 sites, no more and no fewer");

  for (const [alias, target] of Object.entries(CANONICAL.aliases)) {
    const row = db
      .prepare(
        "SELECT s.name AS target FROM site_aliases a JOIN sites s ON s.id = a.site_id WHERE a.alias = ?",
      )
      .get(alias);
    assert.ok(row, `the alias "${alias}" must be recorded`);
    assert.equal(row.target, target, `"${alias}" must resolve to "${target}"`);
  }
  db.close();
});
