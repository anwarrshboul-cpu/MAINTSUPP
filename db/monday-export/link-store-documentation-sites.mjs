/**
 * Links a `sites` row to its Store Documentation board row, by alias.
 *
 * WHY THIS EXISTS
 *
 * The compliance register is derived from the Store Documentation UK board (see
 * app/lib/compliance-register.ts). A board row is matched to a site through
 * `normaliseSiteName` — the same resolver the sites importer uses, which strips
 * everything that is not a letter or a digit. That matches most of the estate
 * on its own:
 *
 *   Aldgate ↔ Aldgate                     Woodgreen ↔ Wood Green
 *   Westfield Stratford ↔ …               Brentcross ↔ Brent Cross
 *   Bluewater ↔ Bluewater                 HQ - The Loom ↔ HQ — The Loom
 *   The Oracle Centre - Reading ↔ The Oracle Centre — Reading
 *
 * Three do not, because the two systems word them differently rather than
 * punctuate them differently:
 *
 *   sites "Bristol Cabot Circus"  ↔ board "Cabot Circus - Bristol"   (reordered)
 *   sites "Sheffield Meadowhall"  ↔ board "Meadowhall"               (qualified)
 *   sites "Solihull"              ↔ board "Touchwood - Solihull"     (qualified)
 *
 * Unlinked, each of those three appears on /dashboard/compliance twice: once as
 * the board row with monday's real certificates, and once as the seeded site
 * row with the sample data. The register cannot guess between them at read
 * time — guessing would eventually attach one store's fire alarm certificate to
 * another store's row — so the link is recorded once, here, deliberately, and
 * read back as data.
 *
 * WHAT IT WRITES
 *
 * One `site_aliases` row per link: `{site_id, alias: <board row name>,
 * normalised, source: 'store-documentation-board'}`. That is the table
 * `resolveSiteByName` already consults and the one the register reads.
 *
 * Nothing else is touched. No site row is updated, no compliance row is
 * created, nothing is deleted. Removing a link is a single DELETE of the alias
 * row this printed.
 *
 * HOW IT DECIDES
 *
 * Only two rules, both requiring a UNIQUE answer or the pair is skipped:
 *
 *  1. Same words, different order — the normalised token SETS are equal.
 *     "Bristol Cabot Circus" = {bristol, cabot, circus} = "Cabot Circus - Bristol".
 *  2. One name qualifies the other — one token set is a strict subset of the
 *     other AND exactly one board row on the whole board satisfies it.
 *     {solihull} ⊂ {touchwood, solihull}, and no other row mentions Solihull.
 *
 * A site that already resolves by `normaliseSiteName` is left alone; so is any
 * pair with more than one candidate on either side. Both are reported.
 *
 * SAFETY
 *
 *  - Dry run by default. `--commit` is required to write anything.
 *  - Idempotent: an existing alias for the same site and name is left as it is,
 *    so a second run reports "nothing to do".
 *  - INSERT only. It cannot modify or remove an existing alias.
 *
 * Usage, from the repo root:
 *
 *   node db/monday-export/link-store-documentation-sites.mjs
 *   node db/monday-export/link-store-documentation-sites.mjs --commit
 *
 * Optional: --db <path to the miniflare sqlite file>
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};

const BOARD_ID = "store-documentation";
const ALIAS_SOURCE = "store-documentation-board";

function defaultDatabase() {
  const dir = path.join(
    ROOT,
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  );
  const file = readdirSync(dir).find((name) => name.endsWith(".sqlite"));
  if (!file) throw new Error(`No .sqlite file under ${dir}`);
  return path.join(dir, file);
}

/** Exactly `normaliseSiteName` from app/lib/sites-repository.ts. */
function normaliseSiteName(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Lower-case word tokens, punctuation dropped. "HQ - The Loom" → [hq,the,loom] */
function tokens(value) {
  return new Set(
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[‐-―]/g, " ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

const sameSet = (left, right) =>
  left.size === right.size && [...left].every((value) => right.has(value));

const subsetOf = (small, large) =>
  small.size < large.size && [...small].every((value) => large.has(value));

const databasePath = flag("--db") ?? defaultDatabase();
const db = new DatabaseSync(databasePath, { readOnly: !COMMIT });

const siteRows = db
  .prepare(
    `SELECT id, organisation_id, name, monday_compliance_name, monday_maintenance_name
       FROM sites`,
  )
  .all();

const boardRows = db
  .prepare(
    `SELECT r.id AS id, r.title AS title, gi.organisation_id AS organisation_id
       FROM maintenance_group_items gi
       JOIN maintenance_requests r ON r.id = gi.request_id
      WHERE gi.board_id = ?
        AND r.deleted_at IS NULL`,
  )
  .all(BOARD_ID);

const aliasRows = db
  .prepare(`SELECT site_id, normalised FROM site_aliases`)
  .all();

console.log(`database   ${databasePath}`);
console.log(`mode       ${COMMIT ? "COMMIT — alias rows will be inserted" : "dry run (default)"}`);
console.log(`sites      ${siteRows.length}`);
console.log(`board rows ${boardRows.length}`);
console.log("");

/** Everything a site already resolves by, exactly as the register reads it. */
function resolvedNames(site) {
  const keys = new Set([normaliseSiteName(site.name)]);
  if (site.monday_compliance_name) keys.add(normaliseSiteName(site.monday_compliance_name));
  if (site.monday_maintenance_name) keys.add(normaliseSiteName(site.monday_maintenance_name));
  for (const alias of aliasRows) {
    if (alias.site_id === site.id) keys.add(alias.normalised);
  }
  return keys;
}

const boardByNormalised = new Map(
  boardRows.map((row) => [normaliseSiteName(row.title), row]),
);
const takenBoardIds = new Set();
for (const site of siteRows) {
  for (const key of resolvedNames(site)) {
    const match = boardByNormalised.get(key);
    if (match) takenBoardIds.add(match.id);
  }
}

const planned = [];
const skipped = [];

for (const site of siteRows) {
  const keys = resolvedNames(site);
  if ([...keys].some((key) => boardByNormalised.has(key))) {
    skipped.push(`${site.name} — already resolves to a board row`);
    continue;
  }

  const siteTokens = tokens(site.name);
  const candidates = boardRows.filter((row) => {
    if (takenBoardIds.has(row.id)) return false;
    if (row.organisation_id !== site.organisation_id) return false;
    const rowTokens = tokens(row.title);
    return (
      sameSet(siteTokens, rowTokens) ||
      subsetOf(siteTokens, rowTokens) ||
      subsetOf(rowTokens, siteTokens)
    );
  });

  if (candidates.length === 0) {
    skipped.push(`${site.name} — no board row shares its words`);
    continue;
  }
  if (candidates.length > 1) {
    skipped.push(
      `${site.name} — ambiguous, ${candidates.length} candidates: ${candidates
        .map((row) => `${row.id} ${row.title}`)
        .join(" | ")}`,
    );
    continue;
  }

  const match = candidates[0];
  const normalised = normaliseSiteName(match.title);
  const already = aliasRows.some(
    (alias) => alias.site_id === site.id && alias.normalised === normalised,
  );
  if (already) {
    skipped.push(`${site.name} — alias for "${match.title}" already recorded`);
    continue;
  }

  takenBoardIds.add(match.id);
  planned.push({ site, match, normalised });
}

for (const line of skipped) console.log(`  skip   ${line}`);
if (skipped.length) console.log("");

if (planned.length === 0) {
  console.log("Nothing to do.");
} else {
  for (const { site, match } of planned) {
    console.log(`  link   ${site.id.padEnd(18)} "${site.name}"  →  ${match.id} "${match.title}"`);
  }
  console.log("");

  if (!COMMIT) {
    console.log(`${planned.length} alias row(s) would be inserted. Re-run with --commit to write.`);
  } else {
    const insert = db.prepare(
      `INSERT INTO site_aliases (id, organisation_id, site_id, alias, normalised, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const { site, match, normalised } of planned) {
      insert.run(
        `alias-${site.id}-${normalised}`.slice(0, 120),
        site.organisation_id,
        site.id,
        match.title,
        normalised,
        ALIAS_SOURCE,
      );
    }
    console.log(`${planned.length} alias row(s) inserted.`);
    console.log(
      `Undo:  DELETE FROM site_aliases WHERE source = '${ALIAS_SOURCE}';`,
    );
  }
}

db.close();
