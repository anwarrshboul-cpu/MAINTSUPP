import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Workstream 5 — the Stage 0 address mirror, and the tab contract.
 *
 * TWO DEFECTS THIS FILE EXISTS TO STOP COMING BACK.
 *
 * 1. `sites.address` is DERIVED from `address_line1/2 + city + postcode`, and
 *    both writers rebuilt it from those four on every save. On the canonical
 *    register the four do not always hold what the string holds — the monday
 *    import read "<unit or mall> - <street>, <city> <postcode>", kept the part
 *    before the " - " as `address_line1` and threw the street away — so a
 *    notes-only save deleted the road on Highcross Leicester ("5 Shires Ln")
 *    and Bullring - Birmingham ("Moor St"). The contractor job link builds its
 *    map URL from this column. The same plain join ALSO repeated a postcode the
 *    first line already ended with, on 25 of the 31 rows.
 *
 * 2. Both Sites screens declared `role="tablist"` with `role="tab"` children
 *    and then behaved like seven unrelated buttons: no `aria-controls`, no
 *    element with `role="tabpanel"`, seven tab stops, and arrow keys that did
 *    nothing. Declaring the role without the behaviour is worse than not
 *    declaring it, because the role is a promise about how the thing works.
 *
 * The assertions are kept in the two kinds the sibling W5 files already use:
 * SOURCE assertions, which read the route and prove the rule is encoded there
 * and run anywhere; and REGISTER assertions, which read a database and prove
 * the DATA obeys the rule, and skip when there is no database — the same
 * bargain `batch-1b-canonical-links.test.mjs` makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The development database, or the canonical snapshot named by MAINTSUPP_SQLITE. */
async function openDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
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

/** The same reduction `addressTokens` performs, so the data assertions match the code. */
const words = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

// ---------------------------------------------------------------------------
// SOURCE — the rule is encoded, in every writer, and it is the general rule.
// ---------------------------------------------------------------------------

test("the Stage 0 address is never rebuilt by a plain join again", async () => {
  const files = [
    "app/api/sites/route.ts",
    "app/api/sites/csv/route.ts",
  ];
  for (const path of files) {
    const source = await read(path);
    /*
     * The exact shape of the bug: the four parts filtered and joined straight
     * into `address`. Matched loosely enough that reformatting it does not
     * smuggle it back in, and anchored on `postcode` + `join(", ")` so an
     * unrelated join elsewhere in the file is not caught.
     */
    const naive = /address:\s*\[[^\]]*postcode[^\]]*\]\s*\n?\s*\.filter\(Boolean\)\s*\n?\s*\.join\(", "\)/s;
    assert.ok(
      !naive.test(source),
      `${path} still rebuilds sites.address with a plain join, which is the defect`,
    );
  }
});

test("every writer of sites.address goes through the address helpers", async () => {
  for (const path of ["app/api/sites/route.ts", "app/api/sites/csv/route.ts"]) {
    const source = await read(path);
    const assignments = source.match(/^\s*address:.*$/gm) ?? [];
    assert.ok(assignments.length > 0, `${path} should still write sites.address`);
    for (const line of assignments) {
      /*
       * Either the helper is called inline, or the line names a value the
       * helper produced (`mirror.value`). What is refused is an expression that
       * builds the string itself.
       */
      assert.match(
        line,
        /composeAddress|mirrorAddress|mirror\.value/,
        `${path} writes sites.address without the preserving helper: ${line.trim()}`,
      );
    }
    if (/mirror\.value/.test(source)) {
      assert.match(
        source,
        /const mirror = mirrorAddress\(/,
        `${path} assigns mirror.value without calling mirrorAddress`,
      );
    }
    assert.match(
      source,
      /import\s*\{[^}]*\b(composeAddress|mirrorAddress)\b/s,
      `${path} must import the address helpers rather than re-implementing them`,
    );
  }
});

test("the mirror holds the stored string rather than rebuilding it when a word would be orphaned", async () => {
  const source = await read("app/lib/sites-repository.ts");
  assert.match(source, /export function mirrorAddress\(/, "mirrorAddress must exist");
  const body = source.slice(source.indexOf("export function mirrorAddress("));
  /*
   * The whole of the fix in one line: when a word of the STORED string is in no
   * canonical column, the stored string is written back rather than the rebuild.
   * If this returns `rebuilt` on that branch, the street is deleted again.
   */
  assert.match(
    body,
    /if \(!orphaned\.length\) return \{ value: rebuilt[\s\S]{0,400}?return \{ value: storedValue/,
    "mirrorAddress must return the STORED string on the orphaned branch",
  );
  // And the rule must be general — no row may be named in the logic.
  const logic = body.slice(0, body.indexOf("\n}"));
  for (const row of ["Highcross", "Bullring", "Shires", "Moor St"]) {
    assert.ok(
      !logic.includes(row),
      `mirrorAddress names "${row}" — the rule has to be general, not a list of rows`,
    );
  }
});

test("a part already carried by the line before it is not repeated", async () => {
  const source = await read("app/lib/sites-repository.ts");
  assert.match(source, /export function composeAddress\(/, "composeAddress must exist");
  const body = source.slice(source.indexOf("export function composeAddress("));
  assert.match(
    body.slice(0, body.indexOf("\n}")),
    /containsTokenRun\(written, words\)/,
    "composeAddress must skip a part whose words are already present",
  );
  /*
   * Word runs, not substrings. A substring test would swallow a city of
   * "London" into a line reading "Londonderry".
   */
  assert.match(
    source,
    /function containsTokenRun\(/,
    "the presence test must be the word-run one, not String.includes",
  );
});

// ---------------------------------------------------------------------------
// SOURCE — the tab contract.
// ---------------------------------------------------------------------------

test("the site tab strip implements the pattern it declares", async () => {
  const source = await read("app/(app)/portal/sites/section-tabs.tsx");
  for (const [needle, why] of [
    [/role="tablist"/, "the strip must still be a tablist"],
    [/role="tab"/, "each control must be a tab"],
    [/aria-selected=\{/, "a tab must say whether it is selected"],
    [/aria-controls=\{panelId\(/, "a tab must name the panel it controls"],
    [/tabIndex=\{active === entry \? 0 : -1\}/, "the strip must be ONE tab stop, not seven"],
    [/role="tabpanel"/, "the panel must be a tabpanel"],
    [/aria-labelledby=\{tabId\(/, "the panel must name the tab that labels it"],
    [/"ArrowRight"/, "ArrowRight must move between tabs"],
    [/"ArrowLeft"/, "ArrowLeft must move between tabs"],
    [/"Home"/, "Home must jump to the first tab"],
    [/"End"/, "End must jump to the last tab"],
  ]) {
    assert.match(source, needle, why);
  }
  /*
   * The panel ELEMENT stays mounted even when its content does not: six of
   * seven `aria-controls` would otherwise point at an id that is not on the
   * page, and a reference that resolves to nothing is not a relationship.
   */
  assert.match(
    source,
    /\{active \? children : null\}/,
    "the panel element must stay in the DOM while its content is lazy",
  );
});

test("both Sites screens use the shared tab component rather than hand-rolling the roles", async () => {
  for (const path of [
    "app/(app)/portal/sites/site-form.tsx",
    "app/(app)/portal/sites/site-detail.tsx",
  ]) {
    const source = await read(path);
    assert.match(
      source,
      /import \{[^}]*SectionTabs[^}]*\} from "\.\/section-tabs"/,
      `${path} must use the shared tab component`,
    );
    /*
     * Comments stripped first: both files explain the defect they used to have
     * and quote `role="tablist"` while doing it, and a prose mention is not a
     * second implementation.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join(" ");
    assert.ok(
      !/role="tablist"/.test(code),
      `${path} hand-rolls role="tablist" again — that is how the two strips came to share one defect`,
    );
  }
});

// ---------------------------------------------------------------------------
// SOURCE — the register search box may only read fields the API actually sends.
// ---------------------------------------------------------------------------

test("every field the site search reads is a field the register API returns", async () => {
  const manager = await read("app/(app)/portal/sites/sites-manager.tsx");
  /*
   * The search reads ONE array literal — the list of fields the typed term is
   * matched against. Taking the fields from that array rather than from the
   * whole memo keeps the status and group FILTERS, which read other properties
   * for other reasons, out of the answer.
   */
  const array = manager.match(/return \[\s*site\.[\s\S]{0,400}?\]\s*\.filter\(Boolean\)/);
  assert.ok(array, "the site search should still match the typed term against a list of fields");
  const fields = [...new Set([...array[0].matchAll(/site\.([A-Za-z]+)/g)].map((m) => m[1]))];
  assert.ok(fields.length > 0, "the search should read at least one field");
  /*
   * `SiteRecord` is the shape `/api/sites` returns. A field searched but never
   * sent is a search box that silently matches nothing — which is exactly how
   * aliases came to be advertised as searchable while `/api/sites` carried no
   * alias data at all.
   */
  const record = await read("app/(app)/portal/sites/site-types.ts");
  const declared = record + manager;
  for (const field of fields) {
    assert.ok(
      new RegExp(`\\b${field}\\??:`).test(declared),
      `the search reads site.${field}, which the register record does not declare`,
    );
  }
});

// ---------------------------------------------------------------------------
// REGISTER — the data obeys the rule.
// ---------------------------------------------------------------------------

test("no site's Stage 0 address repeats a segment of itself", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no database");
    return;
  }
  /*
   * The plain join produced "... LONDON E1 1EW, E1 1EW" on 25 of the 31
   * canonical rows and "..., Birmingham, Birmingham, ..." on another. A repeated
   * comma segment is the fingerprint of that bug, and it is a property of the
   * data rather than of any one row, so it holds on any workspace.
   */
  const rows = db.prepare("SELECT name, address FROM sites WHERE address IS NOT NULL").all();
  for (const row of rows) {
    const segments = String(row.address)
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    assert.equal(
      new Set(segments).size,
      segments.length,
      `${row.name} has a repeated segment in its Stage 0 address: ${row.address}`,
    );
  }
  db.close();
});

test("the Stage 0 address still carries the first line of the address", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no database");
    return;
  }
  /*
   * Whatever else the mirror does, it may not drop the first line: every
   * consumer outside the Sites screen reads this column, and the contractor job
   * link builds its map URL from it.
   */
  const rows = db
    .prepare("SELECT name, address, address_line1 FROM sites WHERE address_line1 IS NOT NULL AND address IS NOT NULL")
    .all();
  assert.ok(rows.length > 0, "the register should hold addresses");
  for (const row of rows) {
    const have = words(row.address);
    for (const word of words(row.address_line1)) {
      assert.ok(
        have.includes(word),
        `${row.name}: the Stage 0 address has lost "${word}" from its first line`,
      );
    }
  }
  db.close();
});

test("access data is either absent or in the column that can hold it", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "sites")) {
    t.skip("no database");
    return;
  }
  const columns = db.prepare("PRAGMA table_info(sites)").all().map((c) => c.name);
  if (!columns.includes("access_url")) {
    t.skip("this build has no access columns");
    db.close();
    return;
  }
  /*
   * THE FAILURE MODE THIS GUARDS. The monday board holds an "Access Request"
   * cell for 24 of the 31 sites, and it is free text: permit-portal URLs,
   * two bare email addresses, one phone number, one host with no scheme, and
   * one cell reading "N/A". Importing that faithfully means each value lands in
   * the column that can hold it; importing it carelessly means a URL column
   * full of phone numbers, or an `access_method` invented from the SHAPE of a
   * cell the board never described.
   *
   * So: a URL must be a URL, a contact must not be a URL, and `access_method`
   * may not appear on a row where nothing else did — that combination can only
   * have come from a guess.
   */
  const rows = db
    .prepare(
      `SELECT name, access_method, access_contact, access_url, access_notes FROM sites
        WHERE access_method IS NOT NULL OR access_contact IS NOT NULL
           OR access_url IS NOT NULL OR access_notes IS NOT NULL`,
    )
    .all();
  for (const row of rows) {
    if (row.access_url) {
      assert.match(
        String(row.access_url),
        /^https?:\/\//i,
        `${row.name}: access_url must be an absolute URL, not "${row.access_url}"`,
      );
    }
    if (row.access_contact) {
      assert.ok(
        !/^https?:\/\//i.test(String(row.access_contact)),
        `${row.name}: a URL was filed as access_contact`,
      );
    }
    if (row.access_method) {
      assert.ok(
        row.access_contact || row.access_url || row.access_notes,
        `${row.name}: access_method is set with nothing behind it, so it was inferred rather than imported`,
      );
      /*
       * THE STRONGER RULE, and the one that actually holds the line: a method
       * may only exist where THE CHANNEL IT NAMES is stored, not merely where
       * some channel is. "Contractor portal" beside a phone number and no URL
       * is the same defect as "Contractor portal" beside nothing — a label
       * asserting a route the register cannot take.
       *
       * `access_notes` counts for the portal case ON PURPOSE: one monday cell
       * is a host with no scheme, which cannot go in `access_url` without a
       * scheme being invented, so it is kept verbatim in the notes and the
       * contractor arrival pack prints it as text rather than as a link that
       * would resolve inside the portal.
       */
      const method = String(row.access_method).toLowerCase();
      if (method.includes("portal")) {
        assert.ok(
          row.access_url || /https?:\/\/|\.[a-z]{2,}\//i.test(String(row.access_notes ?? "")),
          `${row.name}: the method names a portal and no portal address is stored`,
        );
      }
      if (method.includes("email")) {
        assert.match(
          String(row.access_contact ?? ""),
          /@/,
          `${row.name}: the method names email and access_contact is not an address`,
        );
      }
      if (method.includes("phone")) {
        assert.ok(
          row.access_contact && !String(row.access_contact).includes("@"),
          `${row.name}: the method names a phone call and access_contact is not a number`,
        );
      }
    }
  }
  db.close();
});

test("a reporting group holds every site once and only sites of its own tenant", async (t) => {
  const db = await openDatabase();
  if (!db || !hasTable(db, "site_group_members")) {
    t.skip("no database");
    return;
  }
  const duplicates = db
    .prepare(
      `SELECT count(*) AS n FROM (
         SELECT site_id, site_group_id FROM site_group_members
          GROUP BY site_id, site_group_id HAVING count(*) > 1)`,
    )
    .get().n;
  assert.equal(duplicates, 0, "a site must not hold the same group membership twice");

  if (hasTable(db, "site_groups")) {
    const crossed = db
      .prepare(
        `SELECT count(*) AS n FROM site_group_members m
           JOIN site_groups g ON g.id = m.site_group_id
          WHERE g.organisation_id <> m.organisation_id`,
      )
      .get().n;
    assert.equal(crossed, 0, "a membership must not point at another tenant's group");
  }
  db.close();
});
