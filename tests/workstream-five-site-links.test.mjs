import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Workstream 5 — what a job is allowed to say about where it happened.
 *
 * The register is one half of the workstream; the other half is the rule that
 * connects a job to it. Stated once, so every writer can be held to it:
 *
 *   KNOWN    an exact name, either monday name, or the site code  -> that site
 *   ALIAS    a recorded historic spelling                          -> that site
 *   UNKNOWN  anything else                                         -> no site
 *   CROSS-ORG a name that exists only in another tenant            -> no site
 *
 * There is no fifth outcome. No fuzzy match, no arbitrary first site, no site
 * created on the fly to receive the job, and no empty string written into a
 * NOT NULL column so the insert stops complaining.
 *
 * Split from `workstream-five-sites.test.mjs` because that file is about the
 * register's own shape and this one is about the edge between the register and
 * everything that references it.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

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

function hasTable(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name),
  );
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

// ---------------------------------------------------------------------------
// SOURCE — the four outcomes, and nothing else.
// ---------------------------------------------------------------------------

test("resolution is scoped to one organisation at every step", async () => {
  const repository = await read("app/lib/sites-repository.ts");
  /*
   * RE-POINTED, W2. The matching moved out of `resolveSiteByName` — now a
   * one-line wrapper — into `resolveSiteMatch`, which was extracted so a caller
   * can be told WHY nothing resolved. The rule this test protects is unchanged
   * and the slice follows it to its new home rather than widening to the file.
   */
  const resolve = repository.slice(
    repository.indexOf("export async function resolveSiteMatch"),
    repository.indexOf("export async function findDuplicateCandidates"),
  );
  /*
   * Both halves of the lookup are tenant-filtered. The site list comes from
   * `listSites(db, organisationId, …)` and the alias query names the
   * organisation in its WHERE clause — so a name that exists only in another
   * tenant is indistinguishable from a name that exists nowhere, which is the
   * whole point.
   */
  assert.match(resolve, /listSites\(db, organisationId,/, "the candidate set is one tenant's sites");
  assert.match(
    resolve,
    /eq\(siteAliases\.organisationId, organisationId\)/,
    "the alias lookup must be tenant-filtered too",
  );
  /*
   * RE-POINTED, W2, and the rule is now stated on BOTH axes it has to hold on.
   *
   * The alias tier used to be a bare `siteAliases` select filtered on the
   * organisation, and this line proved that whatever it found was reduced back
   * to a site already in the tenant's candidate set. The select now joins
   * `sites` itself, which is what makes the tier REGISTER-scoped too — an alias
   * belonging to another register resolves to nothing rather than to that
   * register's site — so the join predicate is pinned as well as the reduction.
   */
  assert.match(
    resolve,
    /\.innerJoin\(sites, eq\(sites\.id, siteAliases\.siteId\)\)/,
    "the alias tier must reach its site, so tenant and register both apply to it",
  );
  assert.match(resolve, /eq\(sites\.organisationId, organisationId\)/,
    "and the joined site must be this tenant's");
  assert.match(resolve, /rows\.find\(\(row\) => row\.id === aliasRows\[0\]\.siteId\) \?\? null/,
    "an alias may only resolve to a site already in this tenant's candidate set");
});

test("a job with no site records that, in the strongest form the database allows", async () => {
  const reference = await read("app/lib/site-reference.ts");
  assert.match(reference, /export const UNASSIGNED_SITE_ID = "site-unassigned"/);
  assert.match(reference, /export function isUnassignedSite/);
  assert.match(reference, /export function canonicalSiteId/);
  // All three shapes of "no site" read the same way, or an unattached job
  // becomes a bucket of its own with a sentinel for a name.
  assert.match(reference, /value === UNASSIGNED_SITE_ID \|\| value\.startsWith\("site-website-intake-"\)/);
});

test("the public form does not mint a site for a name it cannot match", async () => {
  const route = await read("app/api/report-job/route.ts");
  assert.doesNotMatch(route, /insert\(sites\)/, "no site is created from a public submission");
  assert.match(route, /unassignedSiteId\(\)|isUnassignedSite|canonicalSiteId/, "it records having no site instead");
});

test("no board or import writer falls back to an arbitrary site", async () => {
  for (const path of ["app/lib/board-mutations.ts", "app/api/import/route.ts"]) {
    const source = await read(path).catch(() => null);
    if (source === null) continue;
    assert.doesNotMatch(source, /siteId: "site-unassigned"/, `${path} must not mint the sentinel by hand`);
    assert.doesNotMatch(source, /const anySite\s*=/, `${path} must not take the first site it finds`);
    assert.doesNotMatch(
      source,
      /siteId = matchedSiteId \?\? .*\?\? ""/,
      `${path} must not write the empty string for an unmatched row`,
    );
  }
});

test("a rename keeps the name the site used to have", async () => {
  /*
   * Every job, compliance row and import that recorded the old spelling has to
   * keep resolving, so the previous name survives as an alias. Both PATCH
   * branches do it — the name-only rename branch AND the full-payload branch,
   * which used to record nothing unless the caller happened to send an
   * `aliases` array.
   */
  const route = await read("app/api/sites/route.ts");
  const patch = route.slice(route.indexOf("export async function PATCH"));
  /* RE-POINTED, W2: `addSiteAlias` gained a trailing register argument, so the
     call now ends `"rename", scope)`. The count — BOTH paths, never one — is
     the rule and is unchanged; the pattern follows the new signature rather
     than being loosened to `addSiteAlias(`, which a single path called twice
     would also satisfy. */
  const additions = patch.match(/addSiteAlias\(db, orgId, id, existing\.name, "rename", scope\)/g) ?? [];
  assert.equal(additions.length, 2, "both rename paths must record the former name");
  const releases = patch.match(/releaseSiteAlias\(db, orgId, id,/g) ?? [];
  assert.equal(
    releases.length,
    2,
    "renaming back to a former name must retire that alias, or one string is both",
  );
});

test("a name another site already answers to is refused, not silently dropped", async () => {
  const route = await read("app/api/sites/route.ts");
  assert.match(route, /conflict\?\.kind === "alias"/, "an alias conflict is a hard 409, not a warning");
  assert.match(route, /aliasConflicts/, "an alias the save could not record must be reported back");

  const repository = await read("app/lib/sites-repository.ts");
  const setter = repository.slice(repository.indexOf("export async function setSiteAliases"));
  assert.match(
    setter.slice(0, 2000),
    /refused\.push\(\{ alias: trimmed, conflictSiteId: claimed \}\)/,
    "a refused alias must be collected rather than swallowed",
  );
});

// ---------------------------------------------------------------------------
// DATA — the links that exist must all be justifiable.
// ---------------------------------------------------------------------------

test("no job points at a site that is missing or belongs to another tenant", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "maintenance_requests") || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }
  /*
   * `site_id` has no enforced foreign key at runtime — SQLite runs with
   * `foreign_keys` off — so nothing but these assertions stands between a job
   * and a site it has no business naming.
   *
   * The sentinels are excluded because they MEAN "no site": 'site-unassigned'
   * on a SQLite database that cannot hold NULL, and the historic
   * 'site-website-intake-…' row. See app/lib/site-reference.ts.
   */
  const real = `m.site_id IS NOT NULL AND m.site_id <> '' AND m.site_id <> 'site-unassigned'
                AND m.site_id NOT LIKE 'site-website-intake-%'`;

  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM maintenance_requests m
        WHERE ${real} AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = m.site_id)`,
    ),
    0,
    "every site link must reach a site that exists",
  );
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM maintenance_requests m JOIN sites s ON s.id = m.site_id
        WHERE s.organisation_id <> m.organisation_id`,
    ),
    0,
    "a job must never be linked to another tenant's site",
  );
  db.close();
});

test("nothing that references a site crosses an organisation boundary", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no development database");
    return;
  }
  /*
   * The same rule for every table that carries both a `site_id` and an
   * `organisation_id`. Discovered from the schema rather than listed, so a
   * table added later is covered without this test being edited.
   */
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((name) => name !== "sites")
    .filter((name) => {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
      return cols.includes("site_id") && cols.includes("organisation_id");
    });

  assert.ok(tables.length > 0, "at least one table should reference a site");
  for (const table of tables) {
    assert.equal(
      count(
        db,
        `SELECT count(*) n FROM ${table} t JOIN sites s ON s.id = t.site_id
          WHERE s.organisation_id <> t.organisation_id`,
      ),
      0,
      `${table} must not reference a site from another organisation`,
    );
  }
  db.close();
});

test("a site group only ever contains sites from its own organisation", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "site_group_members") || !hasTable(db, "site_groups")) {
    t.skip("no development database");
    return;
  }
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_group_members m
         JOIN site_groups g ON g.id = m.site_group_id
        WHERE g.organisation_id <> m.organisation_id`,
    ),
    0,
    "a membership row must agree with its group's organisation",
  );
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_group_members m
         JOIN sites s ON s.id = m.site_id
        WHERE s.organisation_id <> m.organisation_id`,
    ),
    0,
    "a membership row must agree with its site's organisation",
  );
  assert.equal(
    count(
      db,
      `SELECT count(*) n FROM site_group_members m
        WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = m.site_id)
           OR NOT EXISTS (SELECT 1 FROM site_groups g WHERE g.id = m.site_group_id)`,
    ),
    0,
    "a membership row must reach both a real site and a real group",
  );
  db.close();
});
