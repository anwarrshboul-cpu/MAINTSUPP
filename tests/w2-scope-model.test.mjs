/**
 * W2 — THE REGISTER SCOPE MODEL.
 *
 * The owner's requirement is that a section created from the Contractors or
 * Sites template be a real, empty, independent instance of that register, and
 * his constraint on how: "Do not fake isolation client-side. Do not load all
 * canonical Sites then filter client-side. Scoping must be server/database-side
 * — no fetch-all-then-filter-in-React. No display-name-based isolation. No
 * route-string-based isolation. No fallback to maintenance."
 *
 * Every one of those five clauses is a thing that can be true today and quietly
 * stop being true in one edit, and none of them is visible from the outside
 * while the templates are still off — a scope filter dropped from a `where`
 * changes no screen until the day somebody creates an instance, and then it
 * changes every screen at once. So the SQL half of this file pins the source.
 * That is the house convention (~3,100 `assert.match` calls across this suite)
 * and it is the only way to assert "the predicate is in the statement" about
 * code whose behaviour is currently unobservable.
 *
 * The live half proves what IS observable today: the canonical registers read
 * exactly as they did before the column existed, and a section that cannot be
 * resolved is REFUSED rather than answered with the workspace's real estate.
 * It skips cleanly with no server and removes what it makes, by exact key.
 *
 * The isolation tests — two instances, same-named rows, no collision — are
 * gated on the Sites and Contractors templates being choosable. They cannot run
 * while `SECTION_TEMPLATES` holds `available: false`, because the sections API
 * refuses to create an instance of an unavailable template (which is itself
 * correct, and pinned below). They are written now so that turning either flag
 * on runs them rather than leaving them to be remembered.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SECTION_TEMPLATES } from "../app/api/workspace-sections/catalogue.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/* Comments explain the rule; they must never be what satisfies the assertion. */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SCOPED_MODULES = [
  "app/lib/sites-repository.ts",
  "app/lib/contractor-repository.ts",
  "app/lib/contractor-reference.ts",
  "app/api/sites/route.ts",
  "app/api/sites/csv/route.ts",
  "app/api/sites/groups/route.ts",
];

/* ------------------------------------------------------------------ */
/* The model: one column, one predicate, one resolver                 */
/* ------------------------------------------------------------------ */

test("W2 the scope column is `board_id`, the name this schema already uses for it", async () => {
  const schema = await source("db/schema.ts");
  /*
   * Twelve tables already answer "which register does this row belong to" with
   * `board_id`. Sites and Contractors are the two registers whose rows are not
   * board-placed, which is the only reason they never had one. A differently
   * named column for the same fact would be a second vocabulary, and the next
   * reader would have to learn which of the two a given table speaks.
   */
  for (const table of ["sites", "contractors", "site_groups"]) {
    assert.match(
      schema,
      new RegExp(`sqliteTable\\(\\s*"${table}"[\\s\\S]{0,12000}?boardId: text\\("board_id"\\)`),
      `${table} must carry the scope column, and it must be called board_id`,
    );
  }
});

test("W2 the scope column is nullable, so the migration is a no-op for existing rows", async () => {
  const schema = await source("db/schema.ts");
  /*
   * NULL is the canonical register. That is what makes this additive: every row
   * already in `sites`, `contractors` and `site_groups` — the client's real
   * estate included — reads NULL and therefore stays exactly where it was, with
   * no UPDATE touching it. `.notNull()` or a `.default(...)` here would mean a
   * backfill, and a write path that had not been taught the sentinel would then
   * drop a row into a register nothing can see.
   */
  for (const table of ["sites", "contractors", "site_groups"]) {
    const declaration = schema.match(
      new RegExp(`sqliteTable\\(\\s*"${table}"[\\s\\S]{0,12000}?boardId: text\\("board_id"\\)([^,\\n]*)`),
    );
    assert.ok(declaration, `${table} has no board_id declaration to check`);
    assert.equal(
      declaration[1].trim(),
      "",
      `${table}.board_id must be plain nullable TEXT — a default or NOT NULL turns an additive migration into a backfill`,
    );
  }
});

test("W2 the migration adds a column and an index and rewrites nothing", async () => {
  const init = await source("db/init.ts");
  const block = init.slice(
    init.indexOf("async function ensureRegisterScope"),
    init.indexOf("async function ensureStageTwoFoundation"),
  );
  assert.ok(block.length > 0, "ensureRegisterScope must exist in db/init.ts");

  for (const table of ["sites", "contractors", "site_groups"]) {
    assert.match(block, new RegExp(`\\["${table}", "board_id"\\]`), `${table} misses the column add`);
    assert.match(
      block,
      new RegExp(`CREATE INDEX IF NOT EXISTS ${table}_organisation_board_idx`),
      `${table} misses its scope index`,
    );
  }

  /*
   * `db/init.ts` runs on the boot path of every request. An UPDATE here would
   * rewrite the client's live estate on a path nobody reviews; a DROP or a
   * destructive ALTER would be unrecoverable; and a UNIQUE index cannot be
   * created over data that already violates it, so one added here would throw
   * on EVERY request the moment two rows shared a name — which
   * `findDuplicateCandidates` explicitly permits, because two centres in one
   * city genuinely share one.
   */
  for (const forbidden of ["UPDATE ", "DROP ", "UNIQUE INDEX", "DELETE FROM"]) {
    assert.ok(
      !block.includes(forbidden),
      `ensureRegisterScope must not contain "${forbidden}" — it runs on every request's boot path`,
    );
  }

  assert.ok(
    init.indexOf("await ensureRegisterScope(d1);") >
      init.indexOf("await ensureStageTwoFoundation(d1);"),
    "ensureRegisterScope must run AFTER Stage 2 — `site_groups` is created there, and `addColumn` skips a table that does not exist yet, so the group column would silently never be added",
  );
});

test("W2 one function turns a scope into a predicate, and it handles NULL", async () => {
  const module = await source("app/lib/register-scope.ts");
  /*
   * `x = NULL` is never true in either dialect. A hand-rolled `eq(column,
   * scope)` therefore compiles, runs, matches nothing, and reads an instance
   * register as empty while reading the canonical one as everything. This is the
   * one place allowed to make the choice.
   */
  assert.match(
    codeOnly(module),
    /export function registerScopeFilter\([\s\S]{0,400}?isNull\(column\)[\s\S]{0,200}?eq\(column, scope\)/,
    "registerScopeFilter must answer IS NULL for the canonical register and = key for an instance",
  );
  assert.match(
    codeOnly(module),
    /export const CANONICAL_REGISTER: RegisterScope = null;/,
    "the canonical register is NULL — see the module header for why a sentinel would need a backfill",
  );
});

test("W2 the scope is resolved from the session and the database, never from a string", async () => {
  const module = codeOnly(await source("app/lib/register-scope.ts"));

  /* The section is looked up inside the caller's own organisation... */
  assert.match(
    module,
    /\.from\(workspaceSections\)[\s\S]{0,400}?eq\(workspaceSections\.organisationId, organisationId\)/,
    "the section lookup must be organisation-scoped — the org comes from the session, not the request",
  );
  /* ...and the value handed back is the one the DATABASE returned for a board
     row in that organisation, not the string that arrived in the URL. */
  assert.match(
    module,
    /\.from\(boards\)[\s\S]{0,400}?eq\(boards\.organisationId, organisationId\)/,
    "the board must be read back inside the caller's organisation",
  );
  assert.match(
    module,
    /return \{ ok: true, scope: board\.key, sectionKey: section\.key \};/,
    "the scope must be `board.key` as the database returned it — a route string is a lookup key, never the scope",
  );

  /*
   * NO FALLBACK. This is the owner's clause and it is the defect W02-06 closed
   * for boards: `boardIdFrom` used to answer every unknown key with the job
   * board. A section key that names nothing must refuse.
   */
  assert.match(module, /if \(!section\) \{[\s\S]{0,200}?ok: false/, "an unknown section must refuse");
  assert.match(module, /if \(section\.archivedAt\) \{[\s\S]{0,200}?ok: false/, "an archived section must refuse");
  assert.match(module, /if \(!board\) \{[\s\S]{0,200}?ok: false/, "a section whose board is gone must refuse");
  assert.match(
    module,
    /if \(section\.template !== register\)/,
    "a section built from a different template must refuse — a Jobs section has no Sites register",
  );

  /* No display name, no slug, no label, no path segment anywhere in the resolution. */
  for (const name of ["label", "\\.name\\b", "pathname", "slugFromLabel", "startsWith"]) {
    assert.doesNotMatch(
      module,
      new RegExp(name),
      `resolution must not consult ${name} — display-name and route-string isolation are both ruled out by name`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The scope is in the SQL, on every read and every write             */
/* ------------------------------------------------------------------ */

/**
 * The reads that deliberately span every register, each with the reason.
 *
 * Listed by the function that performs them, so a NEW unscoped query fails the
 * test below rather than being absorbed by a loose regex. Every one is wide
 * because a DATABASE INDEX is wide and cannot be narrowed without dropping it,
 * which `db/init.ts` may not do on a path every request awaits.
 */
const DELIBERATELY_ORGANISATION_WIDE = [
  // sites_organisation_slug_idx is (organisation_id, slug).
  "uniqueSlug",
  // site_groups_organisation_slug_idx is (organisation_id, slug).
  "claimedGroupSlugs",
  // site_aliases_organisation_normalised_idx is (organisation_id, normalised).
  "nameConflict",
  /*
   * sites_organisation_code_idx is (organisation_id, code) — and this one was
   * found the hard way, which is why it is worth the extra words.
   *
   * `existingSiteCodes` feeds `generateSiteCode` the codes already TAKEN so it
   * can pick a free one. Scoped, an empty instance offers an empty list, so it
   * re-derived a code the canonical register already held and the insert died
   * on the index — "Another site already uses that code", for a site the
   * operator could not see. Creating a second Sites instance holding a site of
   * the same name failed for a reason that named neither the register nor the
   * name.
   *
   * Two registers may hold a site of the same NAME — that is what instances
   * are for, and the name resolvers are scope-aware. They may not hold the same
   * CODE: the code names the site to a contractor reading a job, so ambiguity
   * there is a real-world failure rather than a data-model one.
   */
  "existingSiteCodes",
];

test("W2 every register read and write carries the scope in its SQL", async () => {
  for (const path of SCOPED_MODULES) {
    const text = codeOnly(await source(path));

    /*
     * Each statement is taken from its verb to its terminator and checked for
     * the predicate. Reading the whole file for one `registerScopeFilter` would
     * pass a file with nine scoped queries and a tenth that leaks.
     */
    const statements = [...text.matchAll(
      /\.(from|update|delete)\((sites|contractors|siteGroups)\)[\s\S]*?(?=\n\s*(?:const|let|return|await|\}|\/\*|export)\s)/g,
    )];
    assert.ok(statements.length > 0, `${path} has no register statements to check`);

    for (const statement of statements) {
      const body = statement[0];
      if (!body.includes(".where(")) continue;
      const scoped =
        body.includes("registerScopeFilter(") ||
        DELIBERATELY_ORGANISATION_WIDE.some((name) => {
          const start = text.lastIndexOf(`function ${name}(`, statement.index);
          if (start < 0) return false;
          /* the statement is inside that function and not past the next one */
          const next = text.indexOf("\nexport async function ", start + 1);
          const end = text.indexOf("\nexport function ", start + 1);
          const boundary = Math.min(...[next, end].filter((n) => n > 0), text.length);
          return statement.index < boundary;
        });
      assert.ok(
        scoped,
        `${path}: a ${statement[1]}(${statement[2]}) statement has a where clause with no registerScopeFilter.\n` +
          "Either scope it, or add its function to DELIBERATELY_ORGANISATION_WIDE with the index that forces it.\n" +
          `--- statement ---\n${body.slice(0, 400)}`,
      );
    }
  }
});

test("W2 every insert into a register names the scope it is landing in", async () => {
  for (const path of ["app/api/sites/route.ts", "app/api/sites/csv/route.ts", "app/api/sites/groups/route.ts"]) {
    const text = codeOnly(await source(path));
    const inserts = [...text.matchAll(/\.insert\((sites|contractors|siteGroups)\)\.values\(\{[\s\S]*?\n\s*\}\)/g)];
    assert.ok(inserts.length > 0, `${path} has no register inserts to check`);
    for (const insert of inserts) {
      assert.match(
        insert[0],
        /boardId: scope,/,
        `${path}: an insert into ${insert[1]} does not set boardId — a row created with no register lands in the canonical one, which is safe but is not what the caller asked for`,
      );
    }
  }
});

test("W2 the register is set after the caller's payload, never from it", async () => {
  /*
   * `sitePayload` is built from request data. If `boardId: scope` were written
   * BEFORE the spread, a crafted `data.boardId` would overwrite it and a caller
   * could choose which register their row landed in — the whole model, defeated
   * by one key in a JSON body.
   */
  for (const path of ["app/api/sites/route.ts", "app/api/sites/csv/route.ts"]) {
    const text = await source(path);
    for (const insert of text.matchAll(/\.insert\(sites\)\.values\(\{[\s\S]*?\n\s*\}\)/g)) {
      const spread = insert[0].indexOf("...payload") >= 0
        ? insert[0].indexOf("...payload")
        : insert[0].indexOf("...values");
      const scoped = insert[0].indexOf("boardId: scope");
      assert.ok(spread >= 0, `${path}: expected a payload spread in the site insert`);
      assert.ok(
        scoped > spread,
        `${path}: boardId must be written AFTER the caller's payload is spread, or a crafted body can choose its own register`,
      );
    }
  }
});

test("W2 omitting the scope selects the canonical register, never every register", async () => {
  /*
   * DEFAULT-DENY BY OMISSION. Every scoped function defaults to
   * `CANONICAL_REGISTER`, so a caller who forgets the argument reads the
   * workspace's own register — which is what every caller written before
   * instances existed means — and never another register's rows. There is no
   * signature anywhere that means "all scopes".
   */
  for (const path of SCOPED_MODULES) {
    const text = codeOnly(await source(path));
    const declarations = [...text.matchAll(/scope: RegisterScope(\s*=\s*[A-Za-z_]+)?/g)];
    for (const declaration of declarations) {
      assert.ok(
        declaration[1] === undefined || declaration[1].includes("CANONICAL_REGISTER"),
        `${path}: a scope parameter defaults to something other than CANONICAL_REGISTER — omission must mean the canonical register`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* The ambiguity holes                                                */
/* ------------------------------------------------------------------ */

test("W2 a site name that two rows answer to resolves to nothing, not to the first one", async () => {
  const repository = codeOnly(await source("app/lib/sites-repository.ts"));
  /*
   * THE DEFECT. `resolveSiteByName` was `rows.find(...)`: the first row whose
   * name, monday name or code matched won and nothing counted the others. There
   * is no unique index on sites(organisation_id, name) to fall back on and
   * `findDuplicateCandidates` only warns, so two sites called "Wood Green"
   * routed inbound work to whichever the ordering returned first — silently,
   * and for ever. `codeConflict`'s own header names the same failure for codes.
   */
  assert.match(
    repository,
    /const direct = rows\.filter\(/,
    "the direct match must COLLECT candidates — `.find` is what made a duplicate register non-deterministic",
  );
  assert.match(
    repository,
    /if \(direct\.length > 1\) \{[\s\S]{0,200}?reason: "ambiguous"/,
    "two direct matches must refuse rather than pick one",
  );
  assert.match(
    repository,
    /if \(aliasRows\.length > 1\) \{[\s\S]{0,200}?reason: "ambiguous"/,
    "two alias matches must refuse rather than pick one",
  );
  assert.match(
    repository,
    /export type SiteMatchReason =[\s\S]{0,600}?"ambiguous"/,
    "the caller must be able to tell an unknown name from a register that cannot decide",
  );
});

test("W2 the site resolver is scoped, so the same name in two registers is not ambiguous", async () => {
  const repository = codeOnly(await source("app/lib/sites-repository.ts"));
  /*
   * The two rows are never in one result set: `listSites` puts the scope in the
   * SQL, so resolving inside an instance sees only that instance's rows. Both
   * registers resolve cleanly — which is the point of an independent instance,
   * and is what makes this safe where a workspace-wide unique index would
   * merely have made it impossible.
   */
  assert.match(
    repository,
    /export async function resolveSiteMatch\([\s\S]{0,900}?listSites\(db, organisationId, \{ includeInactive: true \}, scope\)/,
    "resolveSiteMatch must read the register it was asked about",
  );
  /* The alias tier is scoped by JOINING the site that owns it, because
     `site_aliases` deliberately carries no scope column of its own. */
  assert.match(
    repository,
    /\.from\(siteAliases\)\s*\n\s*\.innerJoin\(sites, eq\(sites\.id, siteAliases\.siteId\)\)[\s\S]{0,400}?registerScopeFilter\(sites\.boardId, scope\)/,
    "the alias tier must be scoped through the site that owns the alias",
  );
});

test("W2 a job resolves its contractor inside one roster", async () => {
  const module = codeOnly(await source("app/lib/contractor-reference.ts"));
  /*
   * THE BLOCKER `SECTION_TEMPLATES` NAMES. The predicate was organisation-wide,
   * so a contractor added to an instance under a name the canonical roster
   * already used made `rows.length` 2 for every canonical job naming that
   * contractor. The answer flipped to `ambiguous` and every one of those jobs
   * silently stopped linking — accepted behaviour regressed by adding a ROW,
   * with no code change and no error anywhere.
   */
  assert.match(
    module,
    /\.from\(contractors\)[\s\S]{0,400}?registerScopeFilter\(contractors\.boardId, scope\)/,
    "resolveContractorLink must search one roster",
  );
  assert.match(
    module,
    /scope: RegisterScope = CANONICAL_REGISTER,\s*\n\s*\): Promise<ContractorLink>/,
    "and default to the canonical roster, so a job on the job board links exactly as it did before",
  );
  /* The count-based guard the backfill in db/init.ts already states. */
  assert.match(module, /\.limit\(2\);/, "two matches must still be distinguishable from one");
  assert.match(module, /reason: rows\.length === 0 \? "unknown" : "ambiguous"/, "and still refuse to guess");
});

test("W2 a contractor name is refused per register, not across the workspace", async () => {
  const module = codeOnly(await source("app/lib/contractor-repository.ts"));
  /*
   * The duplicate-name refusal exists because name is the join key for job
   * attribution. That argument is about ONE roster: once the resolver searches
   * within a register, a name held in a different register cannot make anything
   * ambiguous. Refusing across registers would forbid something that had
   * stopped being dangerous.
   */
  assert.match(
    module,
    /export async function contractorNameHolder\([\s\S]{0,900}?registerScopeFilter\(contractors\.boardId, scope\)/,
    "the name-collision check must be per register",
  );
  assert.match(
    module,
    /sql`lower\(trim\(\$\{contractors\.name\}\)\) = lower\(trim\(\$\{text\}\)\)`/,
    "folded by the DATABASE on both sides, as resolveContractorLink does it — JS and SQL disagree on non-ASCII names",
  );
});

/* ------------------------------------------------------------------ */
/* Against a running server                                           */
/* ------------------------------------------------------------------ */

function call(path, options = {}, identity = ADMIN) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

async function serverIsUp() {
  try {
    return (await call("/api/sites")).ok;
  } catch {
    return false;
  }
}

/*
 * A LIMITATION THIS FILE CANNOT CLEAN UP AFTER, named here so nobody spends an
 * afternoon on it twice.
 *
 * THE PRODUCT HAS NO WAY TO REMOVE A SITE. `DELETE /api/sites` CLOSES one —
 * `status: 'closed'`, deliberately, because jobs point at the record — and
 * there is no purge beside it. So the two sites this file creates inside its
 * fixture instances survive the sweep: `rehome=1` returns them to the
 * workspace's own register, where they stay, and each run adds two more.
 *
 * That predates the register scope and is not caused by it; every live test
 * that has ever created a site has left it behind. It is recorded here because
 * the scope work is what made it visible, and because the fix is a product
 * decision — a way to move a site between registers, or to remove one that
 * nothing references — rather than something a test may invent for itself.
 */

/* Namespaced so a sweep can name them EXACTLY. A substring sweep has eaten
   other lanes' fixtures in this repository before; these are removed by key. */
const PROBE = "section:w2scope-probe";
const ALPHA = "section:w2scope-alpha";
const BETA = "section:w2scope-beta";

async function sweep(keys) {
  for (const key of keys) {
    await call(`/api/workspace-sections?key=${key}`, { method: "DELETE" }).catch(() => {});
    /*
     * `rehome=1`, because the purge now REFUSES a register that still holds
     * sites rather than orphaning them — and a fixture instance holds exactly
     * that by the time this runs. The flag is the confirmed second look the
     * product asks for; without it a failed assertion would leave the section
     * behind and poison the next run, which is how the shared fixture keys in
     * `w2-template-parity` poisoned theirs.
     *
     * The rows come back to the canonical register, so the assertions below
     * also check it is left as it was found.
     */
    await call(
      `/api/workspace-sections?key=${key}&purge=1&rehome=1`,
      { method: "DELETE" },
      SUPER,
    ).catch(() => {});
  }
}

test("live: the canonical register reads exactly as it did before the column existed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  const payload = await (await call("/api/sites")).json();
  assert.ok(Array.isArray(payload.sites), "the canonical list must still answer");
  /*
   * Every row the canonical screen returns carries NULL. That is the whole
   * no-op proof: the migration added a column and moved nothing, so the
   * workspace's own register is the same set of rows it always was.
   */
  const scopes = new Set(payload.sites.map((site) => site.boardId ?? null));
  assert.deepEqual(
    [...scopes],
    payload.sites.length ? [null] : [],
    "the canonical register must contain only unscoped rows",
  );
});

test("live: a section that cannot be resolved is refused, never answered with the estate", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * The silent substitution is the defect. `boardIdFrom` used to answer every
   * unknown board key with the job board and its rows; the equivalent here
   * would be answering an unknown section with the workspace's 31 real sites
   * under an instance's name.
   */
  const unknown = await call(`/api/sites?section=${PROBE}-does-not-exist`);
  assert.equal(unknown.status, 404, "an unknown section must be 404");
  const body = await unknown.json();
  assert.ok(body.error, "and must say so rather than returning rows");
  assert.equal(body.sites, undefined, "no rows may travel with a refusal");

  const groups = await call(`/api/sites/groups?section=${PROBE}-does-not-exist`);
  assert.equal(groups.status, 404, "the groups endpoint must refuse identically");
});

test("live: a section built from another template has no Sites register", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep([PROBE]);
  try {
    const created = await (
      await call("/api/workspace-sections", {
        method: "POST",
        body: JSON.stringify({ key: PROBE, label: "W2 Scope Probe" }),
      })
    ).json();
    assert.equal(created.section?.template, "jobs", "the default template is Jobs");

    /*
     * A Jobs board is a real board in the caller's own organisation, so the
     * organisation check alone would let this through. The TEMPLATE check is
     * what stops a Sites write landing in a Jobs board's scope, where it would
     * be invisible to every screen in the product for ever.
     */
    const refused = await call(`/api/sites?section=${PROBE}`);
    assert.equal(refused.status, 404, "a Jobs section must not open a Sites register");
    assert.match(
      (await refused.json()).error,
      /jobs register/i,
      "and must say which register it actually holds",
    );

    /* Archived is a refusal too — a section nobody can navigate to must not
       stay writable through a URL somebody kept. */
    await call(`/api/workspace-sections?key=${PROBE}`, { method: "DELETE" });
    const archived = await call(`/api/sites?section=${PROBE}`);
    assert.equal(archived.status, 404, "an archived section must refuse");
  } finally {
    await sweep([PROBE]);
  }
});

/* ------------------------------------------------------------------ */
/* The isolation proof — runs when the templates are turned on        */
/* ------------------------------------------------------------------ */

const templateIsAvailable = (key) =>
  SECTION_TEMPLATES.find((entry) => entry.key === key)?.available === true;

/**
 * Two Sites instances, each holding a site of the SAME NAME as the other and as
 * the canonical register.
 *
 * This is the property the whole model exists for and the one the owner named:
 * a scoped list never returns canonical rows, a scoped write lands in its own
 * scope, and a name collision across registers is not ambiguous.
 *
 * It is skipped — never failed — while the Sites template is unavailable,
 * because the sections API correctly refuses to create an instance of a
 * template that is switched off, so there is no instance to test with. The skip
 * message names the flag, so turning it on is what makes this run.
 */
test("live: two Sites instances cannot see each other or the canonical register", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  if (!templateIsAvailable("sites")) {
    t.skip(
      "the Sites template is `available: false` in SECTION_TEMPLATES, so no instance can be created to test with",
    );
    return;
  }
  await sweep([ALPHA, BETA]);
  const NAME = "W2 Scope Shared Name";
  try {
    const [alpha, beta] = await Promise.all(
      [
        [ALPHA, "W2 Scope Alpha"],
        [BETA, "W2 Scope Beta"],
      ].map(async ([key, label]) =>
        (
          await call("/api/workspace-sections", {
            method: "POST",
            body: JSON.stringify({ key, label, template: "sites" }),
          })
        ).json(),
      ),
    );
    assert.equal(alpha.section?.template, "sites");
    assert.notEqual(alpha.section.boardKey, beta.section.boardKey, "two instances, two registers");

    /* EMPTY ON ARRIVAL — nothing copied from the canonical register. */
    const fresh = await (await call(`/api/sites?section=${ALPHA}`)).json();
    assert.deepEqual(fresh.sites, [], "a new Sites instance starts empty");

    /* A write lands in its own scope. */
    for (const key of [ALPHA, BETA]) {
      const created = await call(`/api/sites?section=${key}`, {
        method: "POST",
        body: JSON.stringify({
          data: { name: NAME, addressLine1: "1 Scope Street", city: "London" },
          confirmDuplicate: true,
        }),
      });
      assert.ok(created.ok, `creating a site in ${key} failed: ${created.status}`);
    }

    const [inAlpha, inBeta, canonical] = await Promise.all(
      [`/api/sites?section=${ALPHA}`, `/api/sites?section=${BETA}`, "/api/sites"].map(
        async (path) => (await (await call(path)).json()).sites,
      ),
    );

    assert.equal(inAlpha.length, 1, "alpha holds only its own row");
    assert.equal(inBeta.length, 1, "beta holds only its own row");
    assert.equal(inAlpha[0].boardId, alpha.section.boardKey, "and it carries alpha's board key");
    assert.notEqual(inAlpha[0].id, inBeta[0].id, "two rows, not one shared row");
    assert.ok(
      !canonical.some((site) => site.name === NAME),
      "and neither reached the canonical register",
    );

    /* NOT AMBIGUOUS. Three registers hold a site of this name and each one
       resolves its own cleanly, because the three never appear in one result
       set. A workspace-wide unique index would have made this impossible
       instead of safe. */
    const byId = await (await call(`/api/sites?section=${ALPHA}&id=${inAlpha[0].id}`)).json();
    assert.equal(byId.site?.id, inAlpha[0].id, "alpha's own row reads back inside alpha");
    const crossed = await call(`/api/sites?section=${BETA}&id=${inAlpha[0].id}`);
    assert.equal(crossed.status, 404, "and is Not Found from beta — an id is an address, not a key");
    const fromCanonical = await call(`/api/sites?id=${inAlpha[0].id}`);
    assert.equal(fromCanonical.status, 404, "nor is it reachable from the canonical screen");
  } finally {
    await sweep([ALPHA, BETA]);
  }
});

test("live: two Contractors instances hold the same name without breaking canonical links", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  if (!templateIsAvailable("contractors")) {
    t.skip(
      "the Contractors template is `available: false` in SECTION_TEMPLATES, so no instance can be created to test with",
    );
    return;
  }
  await sweep([ALPHA]);
  try {
    const alpha = await (
      await call("/api/workspace-sections", {
        method: "POST",
        body: JSON.stringify({ key: ALPHA, label: "W2 Scope Alpha", template: "contractors" }),
      })
    ).json();

    const canonical = await (await call("/api/workspace")).json();
    const existing = canonical.workspace?.contractors?.[0];
    assert.ok(existing, "the canonical roster must have somebody to collide with");

    /*
     * The exact blocker `SECTION_TEMPLATES` describes: a contractor added to an
     * instance under a name the canonical roster already uses must not make the
     * canonical jobs ambiguous. Same name, other register, canonical links
     * untouched.
     */
    const created = await call(`/api/workspace?section=${ALPHA}`, {
      method: "POST",
      body: JSON.stringify({ entity: "contractor", data: { name: existing.name, active: true } }),
    });
    assert.ok(created.ok, `the instance must accept a name the canonical roster holds: ${created.status}`);

    const after = await (await call("/api/workspace")).json();
    const same = after.workspace.contractors.find((row) => row.id === existing.id);
    assert.equal(
      same.assignedJobs,
      existing.assignedJobs,
      "no canonical job may lose its link because another register gained a row",
    );
    assert.equal(
      after.workspace.contractors.filter((row) => row.name === existing.name).length,
      1,
      "and the instance's row must not appear on the canonical roster",
    );
  } finally {
    await sweep([ALPHA]);
  }
});
