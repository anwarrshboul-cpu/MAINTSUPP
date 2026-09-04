/**
 * W2C — THE MANAGEMENT SURFACE AGGREGATES, AND STAYS SCOPED WHILE IT DOES.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * "Manage dashboard data → Contractors" listed the canonical roster and nothing
 * else. Read off the deployed Preview's Postgres while this was being written,
 * the organisation held five contractors:
 *
 *   contractor-test-c6cfce01              "test"              board_id NULL
 *   contractor-test-a-a3db51df            "Test a"            board_id NULL
 *   contractor-tester-87253bdd            "tester"            board_id NULL
 *   contractor-test-223bd7fa              "test"              board_id sec-75ae0103d9eb
 *   contractor-test-new-section-80bead63  "test new section"  board_id sec-75ae0103d9eb
 *
 * The screen showed the first three. The last two — real records, created by
 * the owner inside a custom Contractors section — were absent, and nothing on
 * the screen said anything was missing. Sites had the identical hole.
 *
 * Those five rows also settle the design question in the owner's own data:
 * there are TWO contractors called "test" in one organisation, one canonical
 * and one in a section. They are different records. A screen that deduplicates
 * by display name shows one of them and loses the other; a screen that decides
 * which register a record belongs to by looking at its name gets it wrong for
 * both. Identity and provenance are the only things that tell them apart.
 *
 * ── WHAT THIS FILE HOLDS ──────────────────────────────────────────────────
 *
 * The source half pins the four properties that are invisible from outside
 * until somebody creates a section, and would each break silently:
 *
 *   1. the aggregate is ONE server-side query bounded to this organisation's
 *      own instances — not an N+1 per section, and not a fetch-all-then-filter;
 *   2. provenance is derived from the row's `board_id` and never from its name;
 *   3. a mutation carries the RECORD ID and the SECTION KEY, and the label on
 *      screen is never what routes it;
 *   4. aggregating for display does not merge the registers: the writes stay
 *      scoped and the assignment pickers keep reading the canonical snapshot.
 *
 * The live half proves the whole thing end to end against a running server:
 * two Contractors instances holding a record of the SAME NAME, one Sites
 * instance, the aggregate listing all of them with the right labels, an edit
 * that moves one record and no other, and a canonical register that is exactly
 * as long afterwards as it was before.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SECTION_TEMPLATES } from "../app/api/workspace-sections/catalogue.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/* Comments explain the rule; they must never be what satisfies the assertion. */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SCOPE = "app/lib/register-scope.ts";
const CONTRACTORS = "app/api/contractors/route.ts";
const SITES = "app/api/sites/route.ts";
const WORKSPACE = "app/api/workspace/route.ts";
const MANAGER = "app/(app)/portal/workspace-data-manager.tsx";

/* ------------------------------------------------------------------ */
/* 1. One query, bounded server-side                                  */
/* ------------------------------------------------------------------ */

test("W2C the plural predicate spells the canonical register IS NULL, and an empty list matches nothing", async () => {
  const inspected = codeOnly(await source(SCOPE));
  /*
   * `inArray(column, [null, 'sec-abc'])` compiles, runs, and silently drops
   * every canonical row, because SQL `IN` compares with `=` and `x = NULL` is
   * never true. That is the single-scope trap made worse by length, so the
   * plural form has to spell the canonical register `IS NULL` as well.
   */
  const plural = inspected.slice(
    inspected.indexOf("export function registerScopesFilter("),
    inspected.indexOf("export type RegisterTemplate"),
  );
  assert.ok(plural.length > 0, "registerScopesFilter must exist in the scope module");
  assert.match(
    plural,
    /or\(isNull\(column\), inArray\(column, keys\)\)/,
    "the canonical register must be IS NULL even inside the union — `IN (NULL)` matches nothing",
  );
  /*
   * DEFAULT-DENY, restated for the plural case. `and(...[])` is TRUE, so an
   * organisation with no instances asking for "every instance" would otherwise
   * match every row the query's other filters did not exclude.
   */
  assert.match(
    plural,
    /if \(!canonical && keys\.length === 0\) return sql`1 = 0`;/,
    "an empty scope list must match nothing, never everything",
  );
  /* One entry point: the singular function forwards, so the statement scan in
     tests/w2-scope-model.test.mjs still sees `registerScopeFilter(` on every
     register statement and cannot be slipped past by a wider read. */
  assert.match(
    inspected,
    /export function registerScopeFilter\([\s\S]{0,300}?if \(Array\.isArray\(scope\)\) return registerScopesFilter\(column, scope\);/,
    "the plural form must be reached through registerScopeFilter, which is the one place a scope becomes a predicate",
  );
});

test("W2C the aggregate reads are one statement over a list of scopes, not a query per section", async () => {
  for (const [path, fn, table] of [
    ["app/lib/contractor-repository.ts", "listContractorsInRegisters", "contractors"],
    ["app/lib/sites-repository.ts", "listSitesInRegisters", "sites"],
  ]) {
    const inspected = codeOnly(await source(path));
    const body = inspected.slice(inspected.indexOf(`export async function ${fn}(`));
    const listing = body.slice(0, body.indexOf("\nexport ", 1));
    assert.ok(listing.length > 0, `${fn} must exist in ${path}`);
    assert.equal(
      (listing.match(/await db/g) ?? []).length,
      1,
      `${fn} must be a single statement — a read per section is the N+1 the performance boundary rules out`,
    );
    assert.match(
      listing,
      new RegExp(`registerScopeFilter\\(${table}\\.boardId, scopes\\)`),
      `${fn} must put the scope list in the SQL — filtering in memory is the fetch-all-then-filter the owner ruled out`,
    );
    /*
     * NO DEFAULT. `listSites` and `listContractors` default their scope to
     * CANONICAL_REGISTER, and that default is what makes omission safe. The
     * plural read must not have one: naming the registers is compulsory, which
     * is the same rule said the other way round, and it is why widening the
     * singular function's parameter was rejected — it would have left the
     * default in place but stopped the suite being able to see it.
     */
    assert.doesNotMatch(
      listing.slice(0, listing.indexOf(") {")),
      /scopes: RegisterScope\[\]\s*=/,
      `${fn} must not default its scope list — an aggregate must always name the registers it covers`,
    );
  }
});

test("W2C both aggregate endpoints refuse `section` and `registers` together", async () => {
  /*
   * A request carrying both has not decided what it is asking for, and
   * answering it by preferring one is the silent substitution this whole model
   * exists to remove — the same shape as `boardIdFrom` answering every unknown
   * key with the job board.
   */
  for (const path of [CONTRACTORS, SITES]) {
    const route = codeOnly(await source(path));
    assert.match(
      route,
      /registersRequest\(url\)/,
      `${path} must read the aggregate request through the shared parser`,
    );
    assert.match(
      route,
      /aggregate[\s\S]{0,40}?\{\s*\n?\s*return Response\.json\(/,
      `${path} must refuse a request that names a section AND asks for the aggregate`,
    );
  }
  const parser = codeOnly(await source(SCOPE));
  assert.match(
    parser,
    /return raw === "custom" \|\| raw === "all" \? raw : null;/,
    "an unrecognised `registers` value must NOT be an aggregate request — a typo may never widen a read",
  );
});

/* ------------------------------------------------------------------ */
/* 2. Provenance comes from the scope id, never from a name           */
/* ------------------------------------------------------------------ */

test("W2C every aggregated record is stamped from its own board_id", async () => {
  const contractors = codeOnly(await source(CONTRACTORS));
  assert.match(
    contractors,
    /register: provenance\(contractor\.id, contractor\.boardId\)/,
    "a contractor's provenance must come from its stored register, not from its name",
  );
  const sites = codeOnly(await source(SITES));
  assert.match(
    sites,
    /register: provenance\(row\.id, row\.boardId\)/,
    "and a site's from its own",
  );

  const inspected = codeOnly(await source(SCOPE));
  const reader = inspected.slice(inspected.indexOf("export function registerProvenanceReader("));
  const body = reader.slice(0, reader.indexOf("\nexport ", 1));
  assert.match(
    body,
    /const byScope = new Map\(instances\.map\(\(instance\) => \[instance\.scopeId, instance\]\)\);/,
    "the lookup is keyed by scope id — a Map, not a scan per record",
  );
  assert.match(
    body,
    /sectionKey: instance\?\.sectionKey \?\? null/,
    "the section key travels with the record, because that is what a mutation must carry",
  );
  /*
   * An unrecognised scope is a CUSTOM record with no section, never a canonical
   * one. Reporting an orphan as canonical would invite an edit through the
   * canonical door — the row carries a board key and is not in that register.
   */
  assert.match(
    body,
    /scopeType: "section",/,
    "a row carrying a board key is never reported as canonical",
  );
});

test("W2C the screen prints the section's current name and never derives one", async () => {
  const manager = codeOnly(await source(MANAGER));
  assert.match(
    manager,
    /return `\(Custom · \$\{provenance\.sectionDisplayName \?\? "register not listed"\}\)`;/,
    "the badge is the server's own display name — the label follows a rename because the server re-reads it",
  );
  assert.match(
    manager,
    /return value\.isCustom === true \? \(value as RecordProvenance\) : null;/,
    "a record is custom because the server said so, not because of anything about its name",
  );
  /* Canonical records get NO badge: the workspace's own register is the
     unmarked default, and badging every row makes the exception invisible. */
  assert.match(
    manager,
    /const from = recordProvenance\(record\);/,
    "the list asks each record where it came from",
  );
  assert.match(
    manager,
    /\{from \? \(/,
    "and only a custom record is labelled",
  );
});

/* ------------------------------------------------------------------ */
/* 3. Mutations carry the id AND the register                         */
/* ------------------------------------------------------------------ */

test("W2C a write from the management surface names the register by key, not by label", async () => {
  const manager = codeOnly(await source(MANAGER));
  const scoped = manager.slice(manager.indexOf("const scopedWrite = async ("));
  const body = scoped.slice(0, scoped.indexOf("\n  };") + 5);
  assert.ok(body.length > 0, "the manager must have a scoped write");

  assert.match(
    body,
    /`\/api\/workspace\?section=\$\{encodeURIComponent\(register\.sectionKey\)\}`/,
    "the request must carry the section KEY the server stamped on the record",
  );
  assert.match(
    body,
    /JSON\.stringify\(method === "DELETE" \? \{ entity, id \} : \{ entity, id, data \}\)/,
    "and the record's id — the two together are what make the write unambiguous",
  );
  /*
   * A MISSING KEY IS A REFUSAL, NOT AN OMISSION. An absent `section` means the
   * canonical register to `/api/workspace`, so sending the request anyway would
   * edit a canonical record while the operator was looking at a custom one.
   */
  assert.match(
    body,
    /if \(!register\.sectionKey\) \{\s*\n\s*throw new Error\(/,
    "a record with no resolvable register must refuse rather than fall back to canonical",
  );
  assert.doesNotMatch(
    body,
    /sectionDisplayName/,
    "the display name may not appear in a request — a label is not a security boundary",
  );
});

test("W2C the site verbs in /api/workspace carry the register on create, edit and archive", async () => {
  /*
   * The contractor verbs were taught the register when instances arrived; the
   * site verbs were not, and the consequence was not only that a custom site
   * could not be created here. `PATCH` and `DELETE` matched on `id` and
   * `organisation_id` alone, so a site belonging to a Sites instance was
   * editable and archivable through the canonical door by anybody holding its
   * id — the hole `getSite` has carried the scope in its predicate to close
   * since the model was written.
   */
  const route = codeOnly(await source(WORKSPACE));
  assert.match(
    route,
    /async function siteScope\(/,
    "the site verbs need a register resolver of their own, as the contractor verbs have",
  );
  assert.match(
    route,
    /\.insert\(sites\)\.values\(\{ id, organisationId: orgId, boardId: scoped\.scope,/,
    "a site created here lands in the register the caller named, and the scope is written from the resolver rather than from the body",
  );

  const patch = route.slice(route.indexOf("export async function PATCH"), route.indexOf("export async function DELETE"));
  assert.match(
    patch,
    /const editScope = await siteScope\(db, orgId, request\);/,
    "the edit resolves the register before it writes",
  );
  assert.match(
    patch,
    /registerScopeFilter\(sites\.boardId, editScope\.scope\)/,
    "and the register is in the UPDATE, not only in the read that decided to proceed",
  );

  const remove = route.slice(route.indexOf("export async function DELETE"));
  assert.match(
    remove,
    /const archiveScope = await siteScope\(db, orgId, request\);/,
    "and the archive does the same",
  );
  assert.match(
    remove,
    /registerScopeFilter\(sites\.boardId, archiveScope\.scope\)/,
    "with the register in the UPDATE there too",
  );
  /*
   * A site the named register does not hold is a 404 rather than an UPDATE that
   * matches nothing and answers 200 — the failure `contractorTarget` was added
   * for, where the caller and the activity log were both told an edit happened
   * to a row nothing touched.
   */
  assert.match(
    route,
    /async function siteInRegister\([\s\S]{0,900}?error: "Site not found\." \}, \{ status: 404 \}\)/,
    "a site outside the named register is Not Found, in the tenancy refusal's own words",
  );
});

/* ------------------------------------------------------------------ */
/* 4. Aggregating for display does not merge the registers            */
/* ------------------------------------------------------------------ */

test("W2C the aggregate feeds the list only — the assignment pickers stay canonical", async () => {
  const manager = codeOnly(await source(MANAGER));
  /*
   * `fieldsFor` builds the site select every other tab assigns through:
   * Compliance, Units and Planned all point a record at a site. A picker is an
   * ASSIGNMENT surface rather than an inventory, and offering another
   * register's site there would attach a job to a site the job's own register
   * does not hold. So the aggregate is merged into the displayed LIST and
   * nowhere else.
   */
  assert.match(
    manager,
    /const siteOptions = workspace\.stores\.map\(/,
    "the site picker must keep reading the canonical snapshot",
  );
  const merge = manager.slice(manager.indexOf("const records = useMemo("));
  const memo = merge.slice(0, merge.indexOf("}, [query, tab, workspace, customRecords]);"));
  assert.ok(memo.length > 0, "the list memo must exist");
  assert.match(
    memo,
    /tab === "contractor"\s*\n?\s*\? customRecords\.contractor\s*\n?\s*: tab === "site"/,
    "only the Sites and Contractors tabs aggregate — nothing else on this screen has instances",
  );
  /*
   * NO DEDUPLICATION BY NAME. Two registers may each hold a "John Ltd", and the
   * owner's own workspace already has two contractors called "test". The merge
   * is a concatenation ordered for reading; nothing removes a row because
   * another row prints the same words.
   */
  assert.match(
    memo,
    /\[\.\.\.recordsFor\(tab, workspace\), \.\.\.extra\]\.sort\(/,
    "the union is a concatenation, re-ordered for reading",
  );
  assert.doesNotMatch(
    memo,
    /new Set\(|\.name ===|dedup/i,
    "nothing may be dropped for sharing a name — two registers may legitimately hold one",
  );
});

test("W2C a custom record is asked the same closure questions a canonical one is asked", async () => {
  /*
   * Both confirmations compare the FORM against what is STORED, and both used
   * to look only in the snapshot. With custom records on the list that lookup
   * misses them, `stored` comes back undefined and both guards fall silent —
   * closing a custom site or unticking a custom contractor's Active box would
   * go straight through with no question, which is W05-05 and W06-04
   * reappearing on the rows they never covered.
   */
  const manager = codeOnly(await source(MANAGER));
  assert.match(
    manager,
    /const storedRecordFor = \(entity: "site" \| "contractor"\) => \{/,
    "the stored-record lookup must span both halves of the list",
  );
  assert.match(
    manager,
    /const custom = entity === "site" \? customRecords\.site : customRecords\.contractor;/,
    "and it must actually consult the custom half",
  );
  assert.match(
    manager,
    /const stored = storedRecordFor\("site"\);/,
    "the site closure guard reads it",
  );
  assert.match(
    manager,
    /const stored = storedRecordFor\("contractor"\);/,
    "and so does the contractor roster guard",
  );
});

test("W2C a list that could not load its other registers says so", async () => {
  /*
   * The defect being fixed is a list that was silently short. Falling back to
   * the canonical rows without a word would reproduce it one layer in.
   */
  const manager = codeOnly(await source(MANAGER));
  assert.match(
    manager,
    /setAggregateProblem\(\s*\n?\s*"Records held in this workspace's other registers could not be loaded/,
    "a failed aggregate must be stated, not swallowed",
  );
  assert.match(
    manager,
    /\{aggregateProblem && \(tab === "site" \|\| tab === "contractor"\) \? \(/,
    "and stated on the tabs where the rows would have been",
  );
});

/* ------------------------------------------------------------------ */
/* Against a running server                                           */
/* ------------------------------------------------------------------ */

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * Run-unique, because nothing here can be fully cleaned up.
 *
 * The product has no hard delete for a site or a contractor — `DELETE` closes
 * or archives the row, deliberately, because jobs point at it — and the section
 * purge RE-HOMES an instance's rows into the canonical register rather than
 * orphaning them. So every fixture this file makes survives its own teardown,
 * archived, in the workspace's own register. A fixed name would therefore be
 * found again by the next run and fail an assertion about isolation that was
 * never about the leftovers.
 *
 * Cleanup is BY EXACT ID for records and BY EXACT KEY for sections. A
 * substring sweep has eaten other lanes' fixtures in this repository before.
 */
const RUN = Math.random().toString(36).slice(2, 7);
const SHARED_NAME = `ZZQA-W2C Shared ${RUN}`;
const ALPHA = `section:w2c-alpha-${RUN}`;
const BETA = `section:w2c-beta-${RUN}`;
const PLACE = `section:w2c-sites-${RUN}`;
const madeContractors = [];
const madeSites = [];
const madeSections = [];

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  cookie = "";
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        /*
         * THIRTY SECONDS, and measured rather than guessed. Sign-in is PBKDF2
         * over a real session row, and on a dev box with several workstreams
         * sharing one Miniflare it took 11.3s. At the eight seconds the other
         * live files use, this whole file skipped and reported "no development
         * server" against a server that was answering 200 — a false skip, which
         * is worse than a failure because it looks like a pass.
         */
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) continue;
      BASE_URL = candidate;
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((raw) => raw.split(";")[0])
        .join("; ");
      if (cookie) return cookie;
    } catch {
      // Next candidate.
    }
  }
  return cookie;
}

async function call(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: cookie ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

async function makeSection(key, label, template) {
  const created = await call("POST", "/api/workspace-sections", { key, label, template });
  if (created.status === 200 || created.status === 201) madeSections.push(key);
  return created;
}

async function teardown() {
  /*
   * Records first, by PRIMARY KEY, and archived rather than removed — the
   * product has no hard delete for a contractor. Then the sections, purged with
   * `rehome=1`, which is the confirmed second look the purge asks for and the
   * only alternative to orphaning the rows behind a board that no longer
   * exists.
   */
  for (const { id, section } of madeContractors) {
    await call("DELETE", `/api/workspace?section=${encodeURIComponent(section)}`, {
      entity: "contractor",
      id,
    }).catch(() => {});
  }
  for (const { id, section } of madeSites) {
    await call("DELETE", `/api/workspace?section=${encodeURIComponent(section)}`, {
      entity: "site",
      id,
    }).catch(() => {});
  }
  for (const key of madeSections) {
    await call("DELETE", `/api/workspace-sections?key=${encodeURIComponent(key)}`).catch(() => {});
    await call(
      "DELETE",
      `/api/workspace-sections?key=${encodeURIComponent(key)}&purge=1&rehome=1`,
    ).catch(() => {});
  }
  madeContractors.length = 0;
  madeSites.length = 0;
  madeSections.length = 0;
}

const templateIsAvailable = (key) =>
  SECTION_TEMPLATES.find((entry) => entry.key === key)?.available === true;

test("live: the management aggregate lists custom records the canonical snapshot cannot see", async (t) => {
  if (!(await signIn())) {
    t.skip(`no development server at ${CANDIDATES.join(", ")}`);
    return;
  }
  if (!templateIsAvailable("contractors") || !templateIsAvailable("sites")) {
    t.skip("the Contractors or Sites template is unavailable, so no instance can be created");
    return;
  }

  /* THE CANONICAL REGISTERS, BEFORE. Re-read at the end and required to be
     unchanged: aggregating for display must not move a single row. */
  const before = await call("GET", "/api/workspace");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const canonicalContractorsBefore = before.body?.workspace?.contractors ?? [];
  const canonicalSitesBefore = before.body?.workspace?.stores ?? [];

  try {
    const alpha = await makeSection(ALPHA, `ZZQA W2C Alpha ${RUN}`, "contractors");
    const beta = await makeSection(BETA, `ZZQA W2C Beta ${RUN}`, "contractors");
    const place = await makeSection(PLACE, `ZZQA W2C Places ${RUN}`, "sites");
    assert.equal(alpha.body.section?.template, "contractors", JSON.stringify(alpha.body));
    assert.equal(beta.body.section?.template, "contractors", JSON.stringify(beta.body));
    assert.equal(place.body.section?.template, "sites", JSON.stringify(place.body));
    assert.notEqual(
      alpha.body.section.boardKey,
      beta.body.section.boardKey,
      "two instances, two registers",
    );

    /*
     * THE ACCEPTANCE CASE, in the owner's own shape: one NAME, two REGISTERS,
     * two records. The canonical roster is left alone; the duplicate that
     * matters is the one across the two instances.
     */
    for (const key of [ALPHA, BETA]) {
      const made = await call(
        "POST",
        `/api/workspace?section=${encodeURIComponent(key)}`,
        { entity: "contractor", data: { name: SHARED_NAME, availability: "Available", active: true } },
      );
      assert.equal(made.status, 200, `creating in ${key}: ${JSON.stringify(made.body)}`);
      madeContractors.push({ id: made.body.id, section: key });
    }
    assert.equal(madeContractors.length, 2, "two records, one name");
    assert.notEqual(
      madeContractors[0].id,
      madeContractors[1].id,
      "two independent records, not one shared row",
    );

    const madeSite = await call(
      "POST",
      `/api/workspace?section=${encodeURIComponent(PLACE)}`,
      { entity: "site", data: { name: `${SHARED_NAME} Depot`, address: "1 Aggregate Way" } },
    );
    assert.equal(madeSite.status, 200, JSON.stringify(madeSite.body));
    madeSites.push({ id: madeSite.body.id, section: PLACE });

    /* ── THE SCREEN'S OWN READ ─────────────────────────────────────────── */

    const aggregate = await call("GET", "/api/contractors?registers=custom&archived=all");
    assert.equal(aggregate.status, 200, JSON.stringify(aggregate.body));
    const rows = aggregate.body.contractors ?? [];
    const mine = rows.filter((row) => row.name === SHARED_NAME);
    assert.equal(
      mine.length,
      2,
      "both same-named records are listed — nothing is deduplicated by display name",
    );
    assert.deepEqual(
      new Set(mine.map((row) => row.id)),
      new Set(madeContractors.map((entry) => entry.id)),
      "and they are the two records that were created, by identity",
    );

    /* PROVENANCE: derived from the scope, labelled from the section. */
    const byId = new Map(mine.map((row) => [row.id, row.register]));
    for (const { id, section } of madeContractors) {
      const stamp = byId.get(id);
      assert.ok(stamp, `record ${id} must carry a register block`);
      assert.equal(stamp.recordId, id, "the block names the record it is on");
      assert.equal(stamp.isCustom, true, "a record in a section is custom");
      assert.equal(stamp.scopeType, "section", "and its scope is a section's register");
      assert.equal(stamp.sectionKey, section, "the key a mutation must carry is the record's own");
      assert.ok(stamp.scopeId, "and the scope id is the board key the row holds");
    }
    assert.notEqual(
      byId.get(madeContractors[0].id).sectionKey,
      byId.get(madeContractors[1].id).sectionKey,
      "two identically named records, two different registers — which is the whole point",
    );
    assert.equal(
      byId.get(madeContractors[0].id).sectionDisplayName,
      `ZZQA W2C Alpha ${RUN}`,
      "the label is the section's display name, read live",
    );

    /* A RENAME MOVES THE LABEL AND NOT THE ROW. */
    const renamed = await call("PATCH", "/api/workspace-sections", {
      key: ALPHA,
      label: `ZZQA W2C Alpha ${RUN} renamed`,
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const afterRename = await call("GET", "/api/contractors?registers=custom&archived=all");
    const relabelled = (afterRename.body.contractors ?? []).find(
      (row) => row.id === madeContractors[0].id,
    );
    assert.equal(
      relabelled.register.sectionDisplayName,
      `ZZQA W2C Alpha ${RUN} renamed`,
      "the badge follows the section's CURRENT name",
    );
    assert.equal(
      relabelled.register.scopeId,
      byId.get(madeContractors[0].id).scopeId,
      "and the record has not moved register — renaming a section leaves boards.key alone",
    );

    /* THE SITES HALF, the same way. */
    const sites = await call("GET", "/api/sites?registers=custom");
    assert.equal(sites.status, 200, JSON.stringify(sites.body));
    const depot = (sites.body.sites ?? []).find((row) => row.name === `${SHARED_NAME} Depot`);
    assert.ok(depot, "a site created inside a Sites section appears on the aggregate");
    assert.equal(depot.register.isCustom, true, "and is marked custom");
    assert.equal(depot.register.sectionKey, PLACE, "carrying the key that routes a write back");
    assert.equal(depot.register.scopeId, place.body.section.boardKey, "and its own board key");

    /* ── MUTATION STAYS SCOPED ─────────────────────────────────────────── */

    const target = madeContractors[0];
    const other = madeContractors[1];
    const edit = await call(
      "PATCH",
      `/api/workspace?section=${encodeURIComponent(target.section)}`,
      {
        entity: "contractor",
        id: target.id,
        data: { name: `${SHARED_NAME} edited`, availability: "Available", active: true },
      },
    );
    assert.equal(edit.status, 200, JSON.stringify(edit.body));

    const afterEdit = await call("GET", "/api/contractors?registers=custom&archived=all");
    const edited = (afterEdit.body.contractors ?? []).find((row) => row.id === target.id);
    const untouched = (afterEdit.body.contractors ?? []).find((row) => row.id === other.id);
    assert.equal(edited.name, `${SHARED_NAME} edited`, "the record that was named is the one that changed");
    assert.equal(untouched.name, SHARED_NAME, "and its same-named twin in the other register did not");
    assert.equal(edited.register.sectionKey, target.section, "nor did it change register");

    /* THE WRONG REGISTER CANNOT REACH IT. An id is an address, not a key. */
    const crossed = await call(
      "PATCH",
      `/api/workspace?section=${encodeURIComponent(other.section)}`,
      { entity: "contractor", id: target.id, data: { name: `${SHARED_NAME} hijacked` } },
    );
    assert.equal(crossed.status, 404, "editing across registers must be Not Found");

    const fromCanonical = await call("PATCH", "/api/workspace", {
      entity: "contractor",
      id: target.id,
      data: { name: `${SHARED_NAME} hijacked` },
    });
    assert.equal(fromCanonical.status, 404, "and so must editing a custom record from the canonical door");

    const siteCrossed = await call("PATCH", "/api/workspace", {
      entity: "site",
      id: depot.id,
      data: { name: `${SHARED_NAME} hijacked`, address: "1 Aggregate Way" },
    });
    assert.equal(
      siteCrossed.status,
      404,
      "a custom site is not editable through the canonical door either — this was the open hole",
    );

    /* ── BOTH REQUESTS AT ONCE IS A REFUSAL ────────────────────────────── */

    const both = await call("GET", `/api/contractors?registers=custom&section=${encodeURIComponent(ALPHA)}`);
    assert.equal(both.status, 400, "one register or the aggregate, not both");
    const bothSites = await call("GET", `/api/sites?registers=all&section=${encodeURIComponent(PLACE)}`);
    assert.equal(bothSites.status, 400, "and the same on Sites");

    /* ── THE CANONICAL REGISTERS ARE EXACTLY AS THEY WERE ──────────────── */

    const after = await call("GET", "/api/workspace");
    assert.equal(after.status, 200);
    const canonicalContractorsAfter = after.body?.workspace?.contractors ?? [];
    const canonicalSitesAfter = after.body?.workspace?.stores ?? [];

    /*
     * BY IDENTITY, NOT BY COUNT, and that is not a weakening.
     *
     * The dev database is shared: several workstreams run against one Miniflare
     * D1 at once, and any of them can add or archive a row inside the seconds
     * this test takes. A count comparison therefore fails for somebody else's
     * fixture and passes for a leak of the same size, which is the wrong test
     * in both directions.
     *
     * The property is: nothing this test made reached the canonical registers,
     * and nothing that was already there left them. Both are stated about the
     * ids, which no other run can move.
     */
    const contractorIdsAfter = new Set(canonicalContractorsAfter.map((row) => row.id));
    for (const row of canonicalContractorsBefore) {
      assert.ok(
        contractorIdsAfter.has(row.id),
        `canonical contractor ${row.id} left the workspace's own roster during this test`,
      );
    }
    const siteIdsAfter = new Set(canonicalSitesAfter.map((row) => row.id));
    for (const row of canonicalSitesBefore) {
      assert.ok(
        siteIdsAfter.has(row.id),
        `canonical site ${row.id} left the workspace's own register during this test`,
      );
    }
    for (const { id } of madeContractors) {
      assert.ok(
        !contractorIdsAfter.has(id),
        `${id} was created in a section and must not be on the canonical roster`,
      );
    }
    for (const { id } of madeSites) {
      assert.ok(
        !siteIdsAfter.has(id),
        `${id} was created in a section and must not be in the canonical register`,
      );
    }
    assert.ok(
      !canonicalContractorsAfter.some((row) => String(row.name).startsWith(SHARED_NAME)),
      "and no row wearing the fixture's name arrived by any other route",
    );
    assert.ok(
      !canonicalSitesAfter.some((row) => String(row.name).startsWith(SHARED_NAME)),
      "on either register",
    );
  } finally {
    await teardown();
  }
});

test("live: `registers=all` is the union, and a workspace with no instances still reads canonical", async (t) => {
  if (!(await signIn())) {
    t.skip(`no development server at ${CANDIDATES.join(", ")}`);
    return;
  }
  /*
   * `all` exists so the union can be asked for whole rather than hand-rolled at
   * a call site. It must always contain at least the canonical roster, which is
   * the register that existed before instances did — and every row of it must
   * carry a provenance block, so nothing on the screen has to guess.
   */
  const snapshot = await call("GET", "/api/workspace");
  const canonical = snapshot.body?.workspace?.contractors ?? [];
  const union = await call("GET", "/api/contractors?registers=all&archived=all");
  assert.equal(union.status, 200, JSON.stringify(union.body));
  const rows = union.body.contractors ?? [];
  assert.ok(
    rows.length >= canonical.length,
    "the union must contain at least the canonical roster",
  );
  for (const row of rows) {
    assert.ok(row.register, `${row.id} must carry a register block`);
    assert.equal(row.register.recordId, row.id, "and it must be about that record");
    assert.equal(
      row.register.isCustom,
      row.register.scopeType === "section",
      "custom and section-scoped are the same statement",
    );
  }
  const canonicalIds = new Set(canonical.map((row) => row.id));
  for (const row of rows.filter((entry) => canonicalIds.has(entry.id))) {
    assert.equal(
      row.register.isCustom,
      false,
      "a record the snapshot returned is canonical, and must not be badged",
    );
    assert.equal(row.register.scopeId, null, "the canonical register is NULL, as the model says");
  }
});
