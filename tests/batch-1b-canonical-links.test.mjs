import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Batch 1B — a job may say it has no site, and who did the work is a reference.
 *
 * Two columns and one rule. `site_id` stops being NOT NULL, so a job whose store
 * nobody can identify records that rather than naming one anyway; `contractor_id`
 * arrives beside the legacy text, which is never touched. The rule is that
 * nothing is guessed: an exact name or an explicit alias links, and everything
 * else stays empty.
 *
 * The nullability is dialect-split and the tests say so rather than pretending
 * otherwise — an existing SQLite database cannot be relaxed in place, so it
 * keeps its sentinels and the writers ask which shape they are on.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The development database, opened directly — the same bargain the sibling suites make. */
async function openDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
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

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

test("no writer falls back to an arbitrary site", async () => {
  const route = await read("app/api/import/route.ts");
  /*
   * The importer took the first row of `sites` and stamped it on every job it
   * could not match — and when there were no sites at all it wrote the empty
   * string, which NOT NULL accepts without complaint. Both are gone.
   */
  assert.doesNotMatch(
    route,
    /const anySite\s*=|anySite\?\.id/,
    "the arbitrary first-site fallback must be gone",
  );
  assert.doesNotMatch(
    route,
    /siteId = matchedSiteId \?\? .*\?\? ""/,
    "an unmatched row must not be written as an empty string",
  );
  assert.match(route, /const siteId = matchedSiteId \?\? unassignedSiteId\(\)/, "no match means no site");
  assert.match(route, /kind: "site_unmatched"/, "and the store it named is written down");
  assert.match(route, /blankSites/, "a row naming no store at all is counted too");

  const board = await read("app/lib/board-mutations.ts");
  assert.doesNotMatch(board, /siteId: "site-unassigned"/, "the board must not mint the sentinel");
  assert.match(board, /siteId: unassignedSiteId\(\)/);
});

test("the public form no longer invents a site for what it cannot match", async () => {
  const route = await read("app/api/report-job/route.ts");
  /*
   * D7. "Unmatched website reports" was a row in `sites`, created on demand,
   * which then appeared in the register, the portfolio filter, spend-by-site and
   * every site-joined report.
   */
  /*
   * Checked as a WRITE rather than as a phrase: the comment above the resolver
   * names the row it used to create, and should keep naming it.
   */
  assert.doesNotMatch(
    route,
    /\.insert\(sites\)/,
    "the standing intake site must not be created",
  );
  assert.doesNotMatch(
    route,
    /const intakeId\s*=|return intakeId/,
    "nor resolved to by id",
  );
  assert.match(route, /const siteId = site\?\.id \?\? unassignedSiteId\(\)/, "no match means no site");
  assert.match(route, /siteAliases/, "and a renamed store still resolves by its former name");
});

test("a job's site can be reassigned, but never by an unattended rule", async () => {
  const fields = await read("app/lib/request-fields.ts");
  /*
   * The automation engine calls `requestFieldValues` with no reference
   * validation of its own, so `siteId` is shape-checked here and resolved in the
   * route — the same split `parentId` already uses, and for the same reason.
   */
  assert.match(fields, /has\("siteId"\)/, "the shape is checked");
  assert.doesNotMatch(fields, /site: \{ field: "siteId"/, "but it is not a board field");
  // The declaration itself, not the comment above it that explains the omission.
  const table = fields.slice(fields.indexOf("export const SYSTEM_FIELD_BY_KEY"));
  assert.doesNotMatch(
    table.slice(0, table.indexOf("} as const")),
    /siteId|site:/,
    "SYSTEM_FIELD_BY_KEY must not carry it — that would hand the automation engine a cross-tenant write",
  );

  const route = await read("app/api/maintenance/route.ts");
  assert.match(route, /values\.siteId = nextSiteId/, "the route can set it");
  assert.match(
    route,
    /eq\(sites\.id, nextSiteId\), eq\(sites\.organisationId, orgId\)/,
    "against a site this organisation owns",
  );
});

test("the canonical columns are provisioned by the thing that actually runs", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /ensureCanonicalSiteLink/, "one stage, called from initialize");
  assert.match(
    init,
    /ADD COLUMN|addColumn\(\s*d1,\s*"maintenance_requests",\s*"contractor_id"/,
    "contractor_id is additive",
  );
  assert.match(
    init,
    /CREATE INDEX IF NOT EXISTS maintenance_contractor_idx ON maintenance_requests \(organisation_id, contractor_id\)/,
  );

  // The name must match the declaration byte for byte: CREATE INDEX IF NOT
  // EXISTS matches on name, so a different one silently adds a second index.
  const schema = await read("db/schema.ts");
  assert.match(schema, /index\("maintenance_contractor_idx"\)/);
  assert.match(schema, /contractorId: text\("contractor_id"\)/);
  assert.match(schema, /siteId: text\("site_id"\),/, "site_id is nullable in the declaration");

  /*
   * The destructive half does not run because the code shipped. `db/init.ts` is
   * on the boot path of every isolate and a preview points at a shared staging
   * database, so relaxing a column and nulling rows there must be somebody's
   * decision rather than a deploy's side effect.
   */
  assert.match(init, /BATCH_1B_APPLY/, "the Postgres nullability step is behind an explicit flag");
});

test("the contractor backfill links only what the register answers unambiguously", async () => {
  const init = await read("db/init.ts");
  const backfill = init.slice(init.indexOf("SET contractor_id"));
  assert.match(backfill, /lower\(trim\(c\.name\)\) = lower\(trim\(maintenance_requests\.contractor\)\)/, "trim and case fold, nothing more");
  assert.match(backfill, /count\(\*\).*\) = 1/s, "exactly one candidate, or no link");
  assert.match(backfill, /c\.organisation_id = maintenance_requests\.organisation_id/, "within the job's own organisation");
  assert.match(backfill, /contractor_id IS NULL/, "idempotent — never overwrites");
  assert.doesNotMatch(init, /INSERT INTO contractors/i, "and never creates a contractor from job text");
});

// ---------------------------------------------------------------------------
// Behavioural — needs a dev server
// ---------------------------------------------------------------------------

test("the current data carries only links the register could justify", async (t) => {
  const db = await openDatabase();
  if (!db) {
    t.skip("no development database");
    return;
  }
  const n = (sql) => db.prepare(sql).get().n;

  // Nothing points at a contractor that is not there, or one in another tenant.
  assert.equal(
    n("SELECT count(*) n FROM maintenance_requests m WHERE m.contractor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contractors c WHERE c.id = m.contractor_id)"),
    0,
    "no invalid contractor links",
  );
  assert.equal(
    n("SELECT count(*) n FROM maintenance_requests m JOIN contractors c ON c.id = m.contractor_id WHERE c.organisation_id <> m.organisation_id"),
    0,
    "no cross-organisation contractor links",
  );
  assert.equal(
    n("SELECT count(*) n FROM maintenance_requests m JOIN sites s ON s.id = m.site_id WHERE s.organisation_id <> m.organisation_id"),
    0,
    "no cross-organisation site links",
  );

  /*
   * Every linked job's stored name still resolves to the contractor it was
   * linked to. This is the assertion that would fail if the backfill had ever
   * guessed: a link whose text no longer matches its target is one nobody can
   * justify from the data.
   */
  assert.equal(
    n(`SELECT count(*) n FROM maintenance_requests m JOIN contractors c ON c.id = m.contractor_id
        WHERE lower(trim(c.name)) <> lower(trim(coalesce(m.contractor, '')))`),
    0,
    "every contractor link matches the name the job carries",
  );

  // The legacy text is the record of who was named, and it is never cleared.
  assert.equal(
    n("SELECT count(*) n FROM maintenance_requests WHERE contractor_id IS NOT NULL AND (contractor IS NULL OR trim(contractor) = '')"),
    0,
    "a canonical link never replaces the text it came from",
  );
});
