import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * WORKSTREAM 5/6 — the relationships, and the two screens that draw them.
 *
 * Four criteria meet in one file because they are one edge seen from two ends
 * and one register mounted on one page:
 *
 *   W05-09  a site connects to Jobs, Compliance, Documents, Assets AND
 *           CONTRACTORS. The first four already worked; the fifth did not exist
 *           in any form — no table, no key on `contractors`, no tab, and
 *           `'contractors' in GET /api/sites?id=` was false.
 *   W06-10  a contractor connects to their assigned jobs, their SITES, their
 *           DOCUMENTS and their performance. Jobs and performance worked. Sites
 *           did not exist. Documents existed as plumbing nothing reached.
 *   W06-08  the documents half of that: `attachments.contractor_id`, its index,
 *           its anchor validator and `GET /api/files?contractorId=` all shipped
 *           with W07-07, and NOT ONE of `uploadEvidenceFile`'s call sites ever
 *           sent a `contractorId`. A contractor's insurance certificate could be
 *           filed by an API client and by no person.
 *   W06-11  the shared configurable register, mounted on the Contractors page.
 *
 * ── THE RULE THIS FILE EXISTS TO HOLD ────────────────────────────────────
 *
 * A CONTRACTOR–SITE LINK IS RECORDED, NEVER INFERRED. Every contractor in this
 * workspace holds `coverage_areas = ["UK"]` and every site is `region = 'UK'`,
 * so a "matching" rule over that pairs all of them with all of them: a cross
 * join wearing a filter's clothes. Two tests below assert the absence — no
 * source in the relation's path reads `coverage_areas`, and linking is a row in
 * `contractor_sites` and nothing else.
 *
 * Source assertions run everywhere. The behavioural half needs a dev server and
 * SKIPS without one, which is the bargain the rest of this suite already makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Comments are where the reasoning lives; assertions about CODE ignore them. */
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 5176, 5177, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * The marker every fixture carries.
 *
 * Prefixed and unique per run, so a row left behind is traceable to the run
 * that made it. Cleanup below is nevertheless BY EXACT PRIMARY KEY and never by
 * substring: this repository's notes record a filename sweep repeatedly eating
 * other agents' fixtures, and the local database is shared.
 */
const RUN = `ZZQA-W56-REL-${Date.now().toString(36)}`;

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/registers?register=contractors`, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        BASE_URL = candidate;
        return true;
      }
    } catch {
      // Next candidate.
    }
  }
  return false;
}

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = response.ok
      ? (response.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ")
      : "";
  } catch {
    cookie = "";
  }
  return cookie;
}

async function call(method, path, body) {
  await signIn();
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

/**
 * A FIXTURE call, retried once on a 503.
 *
 * Only for setting fixtures up and tearing them down — never for the request a
 * test is actually asserting about, which must be believed the first time it
 * answers. The local D1 file is held open by the dev server and is routinely
 * shared with a second agent's work, so an insert can lose a lock and come back
 * as `Failed query: insert into "attachments" …` behind a 503. That is
 * contention on a development database, not a product behaviour, and a fixture
 * that vanishes because of it turns a real result into a red herring.
 */
async function fixtureCall(method, path, body) {
  let answer = await call(method, path, body);
  for (let attempt = 0; attempt < 2 && answer.status === 503; attempt += 1) {
    answer = await call(method, path, body);
  }
  return answer;
}

/**
 * The same call made by somebody else, through the testing identity switcher.
 *
 * No session cookie: a live session outranks the header, so sending both would
 * test the owner twice. `admin@demo-client-ltd…` holds `sites.edit` in the
 * OTHER organisation, which is what makes it the right caller for the
 * cross-tenant test — it is refused by the organisation filter rather than by
 * the capability check, which is the thing being proved.
 */
async function callAs(identity, method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-maintsupp-identity": identity,
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

const OTHER_ADMIN_IDENTITY = "admin@demo-client-ltd.test.maintsupp.com";

/** Upload one small document through the product's own route. */
async function uploadOnce({ name, title, anchors, replaces }) {
  await signIn();
  const form = new FormData();
  form.set("file", new File([`${RUN} body`], name, { type: "text/plain" }));
  form.set("kind", "general");
  if (title) form.set("title", title);
  if (replaces) form.set("replaces", replaces);
  for (const [key, value] of Object.entries(anchors ?? {})) {
    if (value) form.set(key, value);
  }
  const response = await fetch(`${BASE_URL}/api/files`, {
    method: "POST",
    headers: { cookie: cookie ?? "" },
    body: form,
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

/** The same upload, retried on a 503 — see `fixtureCall` for why. */
async function uploadDocument(options) {
  let answer = await uploadOnce(options);
  for (let attempt = 0; attempt < 2 && answer.status === 503; attempt += 1) {
    answer = await uploadOnce(options);
  }
  return answer;
}

/* ── Fixtures, and the cleanup that must leave nothing ─────────────────────── */

/** Contractors this file created. The only contractor rows it may delete. */
const createdContractors = [];
/** Link rows this file created, by primary key. */
const createdLinks = [];
/** Documents this file created, by primary key. */
const createdDocuments = [];
/** Register columns this file created. */
const createdColumns = [];

async function openDevDatabase(readOnly) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
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
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    const db = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly });
    // The dev server holds this file open, so an unqualified write loses the
    // race and throws "database is locked". Wait for the writer.
    if (!readOnly) db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

after(async () => {
  if (
    !createdContractors.length &&
    !createdLinks.length &&
    !createdDocuments.length &&
    !createdColumns.length
  ) {
    return;
  }

  /*
   * Documents go through the product's own destroy verb, because they own bytes
   * in the bucket as well as a row. Everything else is deleted by primary key.
   *
   * IN REVERSE, so the HEAD of a lineage goes first. `DELETE /api/files/[id]`
   * destroys the whole lineage when handed the current version and only that
   * row when handed a superseded one — so deleting v1 and then v2 is two
   * requests where deleting v2 is one, and it leaves a window in which a head
   * points at a root that is already gone.
   *
   * Retried, and NOT asserted here. A cleanup loop that throws on its first
   * disappointment abandons every row after it, which is how one flaky delete
   * becomes a dozen orphans in a shared database. Everything is attempted; the
   * assertions come afterwards, once nothing is left to attempt.
   */
  for (const id of [...createdDocuments].reverse()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await fixtureCall("DELETE", `/api/files/${encodeURIComponent(id)}?purge=1`);
      if (answer.status === 200 || answer.status === 404) break;
    }
  }

  const db = await openDevDatabase(false);
  assert.ok(db, "fixture cleanup could not open the development database");
  try {
    for (const id of createdLinks) {
      db.prepare("DELETE FROM contractor_sites WHERE id = ?").run(id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }
    for (const id of createdColumns) {
      db.prepare("DELETE FROM register_columns WHERE id = ?").run(id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }
    for (const id of createdContractors) {
      // A contractor cannot be deleted while a link still points at it, so the
      // links above go first. Both are this file's own rows.
      db.prepare("DELETE FROM contractor_sites WHERE contractor_id = ?").run(id);
      db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }

    /*
     * A DOCUMENT THE PRODUCT'S OWN VERB COULD NOT DESTROY IS REMOVED HERE.
     *
     * `DELETE /api/files/[id]` is the right way to destroy one — it takes the
     * bytes and the lineage with it — but it goes through a dev server this
     * suite shares, and a lock it loses must not leave a row behind. The row is
     * this file's own, by primary key; the object it points at is a few bytes
     * of `ZZQA-W56-REL` placeholder text.
     */
    for (const id of [...createdDocuments].reverse()) {
      db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
      db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
    }

    /*
     * ASSERTED, not warned about, and only once every deletion has been
     * attempted. A sweep that "probably worked" is how a shared development
     * database fills up with other people's fixtures, and this file's whole
     * cleanup contract is that it leaves nothing behind. The failures are
     * COLLECTED rather than thrown one at a time, so a single survivor does not
     * hide the other nine.
     */
    const residue = [];
    const check = (kind, table, ids) => {
      for (const id of ids) {
        const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
        if (row) residue.push(`${kind} ${id}`);
      }
    };
    check("link", "contractor_sites", createdLinks);
    check("contractor", "contractors", createdContractors);
    check("register column", "register_columns", createdColumns);
    check("document", "attachments", createdDocuments);
    assert.deepEqual(residue, [], `fixtures survived cleanup: ${residue.join(", ")}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE — the shape of the thing, checked without a server
   ═══════════════════════════════════════════════════════════════════════════ */

test("W05-09/W06-10 the contractor-site relation is a table, with the tenant in its key", async () => {
  const schema = await read("db/schema.ts");
  assert.match(schema, /export const contractorSites = sqliteTable\(\s*"contractor_sites"/);
  /*
   * The organisation is IN the unique key, so one pair can never span tenants
   * and can never be created twice. Both facts come from the same index.
   */
  assert.match(
    schema,
    /uniqueIndex\("contractor_sites_pair_idx"\)\.on\(\s*table\.organisationId,\s*table\.contractorId,\s*table\.siteId,\s*\)/,
    "the pair index must carry the organisation",
  );
  assert.match(schema, /index\("contractor_sites_site_idx"\)\.on\(table\.siteId\)/);
  assert.match(schema, /index\("contractor_sites_contractor_idx"\)\.on\(table\.contractorId\)/);

  const init = await read("db/init.ts");
  assert.match(init, /CREATE TABLE IF NOT EXISTS contractor_sites/);
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS contractor_sites_pair_idx/,
    "the uniqueness is the database's, not the route's",
  );
});

test("W05-09/W06-10 nothing in the relation's path reads coverage_areas", async () => {
  /*
   * THE INFERENCE THAT WOULD HAVE LOOKED LIKE AN ANSWER.
   *
   * Every contractor on this workspace holds `["UK"]` and every site is
   * `region = 'UK'`, so a coverage match connects all 19 to all 13 and
   * discriminates nothing. It is worse than no answer, because it is a
   * confident one. Asserted as an ABSENCE across every file that could
   * plausibly have done it.
   */
  for (const path of [
    "app/api/contractor-sites/route.ts",
    "app/(app)/portal/sites/site-contractors.tsx",
    "app/(app)/portal/contractor-profile.tsx",
  ]) {
    const code = codeOnly(await read(path));
    assert.doesNotMatch(code, /coverageAreas/, `${path} must not read coverage areas`);
    assert.doesNotMatch(code, /coverage_areas/, `${path} must not read coverage areas`);
  }
});

test("W05-09/W06-10 both ids are checked against this tenant BEFORE any write", async () => {
  const route = codeOnly(await read("app/api/contractor-sites/route.ts"));

  // Each lookup filters on the organisation inside the WHERE, so another
  // tenant's id and an id that never existed are the same answer.
  assert.match(route, /eq\(sites\.organisationId, orgId\)/);
  assert.match(route, /eq\(contractors\.organisationId, orgId\)/);
  assert.match(route, /Site not found\./);
  assert.match(route, /Contractor not found\./);

  // And the checks come BEFORE the insert, not after it: a foreign key proves a
  // row exists, not that the caller may see it.
  const post = route.slice(route.indexOf("export async function POST("));
  const contractorCheck = post.indexOf("contractorRefusal(db, orgId, contractorId)");
  const siteCheck = post.indexOf("siteRefusal(db, orgId, siteId)");
  const insert = post.indexOf(".insert(contractorSites)");
  assert.ok(contractorCheck > 0 && siteCheck > 0 && insert > 0, "all three were found");
  assert.ok(contractorCheck < insert, "the contractor is checked before the insert");
  assert.ok(siteCheck < insert, "the site is checked before the insert");
});

test("W05-09/W06-10 writing a link needs sites.edit; reading it needs only membership", async () => {
  const route = codeOnly(await read("app/api/contractor-sites/route.ts"));
  assert.match(route, /scopedDb\(request\)/, "the read is open to any member");
  assert.equal(
    (route.match(/scopedDbWithCapability\(request, "sites\.edit"\)/g) ?? []).length,
    2,
    "both writes are gated on sites.edit",
  );
  /*
   * Stated in the answer rather than inferred from the role: a role whose
   * `sites.edit` was revoked in Roles is still called "Admin", and a screen
   * that decided by name would draw controls the server refuses.
   */
  assert.match(route, /const canEdit = can\(subject, "sites\.edit"\)/);
  assert.match(route, /const canManageDocuments = can\(subject, "board\.edit"\)/);
});

test("W05-09 the site profile has a Contractors tab that lists, links and unlinks", async () => {
  const detail = await read("app/(app)/portal/sites/site-detail.tsx");
  assert.match(
    detail,
    /"Assets",\n\s*"Contractors",\n\s*"Documents",/,
    "Contractors is one of the profile's tabs",
  );
  assert.match(detail, /<SiteContractors siteId=\{site\.id\} siteName=\{site\.name\} \/>/);

  const section = await read("app/(app)/portal/sites/site-contractors.tsx");
  assert.match(section, /\/api\/contractor-sites\?siteId=/, "it reads the site's links");
  assert.match(section, /method: "POST"/, "it can link");
  assert.match(section, /method: "DELETE"/, "it can unlink");
  /*
   * The picker offers only what is NOT linked, because the server removed the
   * rest — a contractor already on the list is a choice whose only outcome is
   * "already linked", which is a dead end the reader cannot see coming.
   */
  assert.match(section, /data\.candidates\.map/);
  // Controls are gated on the capability the SERVER resolved.
  assert.match(section, /data\.canEdit &&/);
  // And a refusal is shown in the server's own words.
  assert.match(section, /caught instanceof Error \? caught\.message/);
});

test("W06-10 the contractor profile answers all four questions on one screen", async () => {
  const profile = await read("app/(app)/portal/contractor-profile.tsx");
  for (const heading of ["Performance", "Sites", "Documents", "Assigned jobs"]) {
    assert.match(profile, new RegExp(`<h3>${heading}</h3>`), `${heading} is missing`);
  }
  assert.match(profile, /\/api\/contractor-sites\?contractorId=/);
  assert.match(profile, /\/api\/files\?contractorId=/);

  /*
   * ATTRIBUTION IS NOT RECOMPUTED HERE. The rule lives in
   * `app/lib/contractor-attribution.ts` and the page applies it once; a panel
   * with a second copy would be a second answer to "whose job was that", which
   * is the exact failure W06-12 found in `ContractorScorecard`.
   */
  const code = codeOnly(profile);
  assert.doesNotMatch(code, /attributeContractorWork/, "the profile must be handed its jobs");
  assert.doesNotMatch(code, /contractorId === /, "and must not re-derive attribution");

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /jobs=\{openContractor\.jobs\}/, "the page hands over the attributed jobs");
});

test("W06-08 uploading from a contractor goes through uploadEvidenceFile, with the anchor", async () => {
  const profile = await read("app/(app)/portal/contractor-profile.tsx");
  /*
   * `uploadEvidenceFile` owns the ~1 MiB direct-path ceiling — above which the
   * Workers form parser answers a bare-text 413 with no JSON `error` — the
   * multipart fallback past `DIRECT_UPLOAD_LIMIT`, and the thumbnail. A
   * hand-rolled `fetch("/api/files")` silently loses all three.
   */
  assert.match(profile, /import \{ uploadEvidenceFile \} from "\.\.\/\.\.\/lib\/client-upload"/);
  assert.match(
    profile,
    /await uploadEvidenceFile\(\{[\s\S]*?contractorId: contractor\.id,/,
    "the upload must carry the contractor anchor",
  );
  const code = codeOnly(profile);
  assert.doesNotMatch(
    code,
    /fetch\("\/api\/files",\s*\{\s*method: "POST"/,
    "a hand-rolled upload loses the ceiling, the fallback and the thumbnail",
  );
});

test("W06-08 the document name comes from documentName and nowhere else", async () => {
  const profile = await read("app/(app)/portal/contractor-profile.tsx");
  assert.match(profile, /import \{ documentName \} from "\.\/views\/document-register"/);
  assert.match(profile, /documentName\(\{ title: document\.title, name: document\.originalName \}\)/);
  const code = codeOnly(profile);
  assert.doesNotMatch(
    code,
    /<a[^>]*>\{document\.originalName\}<\/a>/,
    "printing originalName is how a renamed certificate loses its name",
  );
});

test("W06-08 PATCH /api/files/[id] can file and unfile a contractor, and refuses to orphan", async () => {
  const route = codeOnly(await read("app/api/files/[id]/route.ts"));
  const patch = route.slice(route.indexOf("export async function PATCH("));
  assert.match(patch, /"contractorId" in payload/, "PATCH semantics: absent means unchanged");
  assert.match(patch, /values\.contractorId = next \|\| null/);
  /*
   * Both refusals, and both BEFORE the update. `anchorRefusal` is the rule that
   * a document belongs to SOMETHING; `anchorReferencesRefusal` is the rule that
   * the id names a row in this tenant.
   */
  assert.match(patch, /const unanchored = anchorRefusal\(anchors\);/);
  assert.match(patch, /await anchorReferencesRefusal\(db, orgId, anchors\)/);
  const refusal = patch.indexOf("anchorRefusal(anchors)");
  const update = patch.indexOf(".update(attachments)");
  assert.ok(refusal > 0 && update > 0 && refusal < update, "refusals come before the write");

  /*
   * THE JOB ANCHOR IS STILL WRITE-ONCE. W07-02's pin holds that the metadata
   * PATCH may not move a document between jobs, tenants, lineages or objects;
   * W06-08 opens exactly one field and no more.
   */
  for (const forbidden of ["requestId", "siteId", "unitId", "organisationId", "objectKey"]) {
    assert.doesNotMatch(
      patch,
      new RegExp(`values\\.${forbidden}\\s*=`),
      `the metadata PATCH must never write ${forbidden}`,
    );
  }
});

test("W06-08 the Documents register carries a contractor column and a contractor filter", async () => {
  const register = await read("app/(app)/portal/views/document-register.ts");
  assert.match(register, /export function documentContractorLabel\(/);
  assert.match(register, /export const UNLINKED_CONTRACTOR_LABEL = "Not linked to a contractor"/);
  assert.match(register, /export function withContractorNames</);
  assert.match(register, /contractor: string;/, "the filter is one of the set");
  assert.match(
    register,
    /if \(filters\.contractor && documentContractorLabel\(file\) !== filters\.contractor\)/,
    "and it narrows the register",
  );
  assert.match(register, /contractors: \[\.\.\.contractorNames\]/, "its options are derived");

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /<th>Contractor<\/th>/, "the table has the column");
  assert.match(app, /<td>\{documentContractorLabel\(file\)\}<\/td>/, "and reads it through the label");
  assert.match(app, /id="document-contractor-filter"/, "and the filter bar has the control");
  assert.match(app, /contractorId: file\.contractorId \?\? null/, "the loader carries the anchor");
  assert.match(app, /withContractorNames\(named, workspace\?\.contractors \?\? \[\]\)/);
  // Eleven columns now, so the empty row must span all of them or the table
  // draws a short rule across a page that is trying to explain itself.
  assert.match(app, /colSpan=\{11\}/);
});

test("W06-08 documentCount is rendered, not merely computed", async () => {
  /*
   * IT WAS COMPUTED, TYPED AND UNIT-TESTED, AND SHOWN NOWHERE.
   * `app/api/workspace/route.ts` builds it per contractor and
   * `WorkspaceContractor` names it; no screen read it, so "does this contractor
   * have their insurance on file" was a question the product could answer and
   * never did.
   */
  const workspace = await read("app/api/workspace/route.ts");
  assert.match(workspace, /documentCount: documentsByContractor\.get\(contractor\.id\) \?\? 0/);

  /*
   * THE COUNT ITSELF, on the register, so a reader can see which contractors
   * hold nothing without opening each one. An em dash where it is ABSENT and a
   * zero where it is zero — the field is optional because `mock-data.ts` builds
   * records with no storage behind them, and printing 0 for "not known" invents
   * an answer.
   */
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /key: "documents",\n\s*title: "Documents",/);
  assert.match(
    app,
    /contractor\.documentCount === undefined \? "—" : contractor\.documentCount/,
    "absent is not zero",
  );

  const profile = await read("app/(app)/portal/contractor-profile.tsx");
  assert.match(profile, /Documents held/, "the profile shows the figure too");
  assert.match(
    profile,
    /\{documents \? documents\.length : "—"\}/,
    "and there it counts the rows it just listed rather than a number it cannot check",
  );
});

test("W06-11 the Contractors register mounts the shared engine, through the one reader", async () => {
  const grid = await read("app/(app)/portal/contractor-register.tsx");
  assert.match(grid, /from "\.\/register\/register-client"/, "the shared mount surface");
  /*
   * THE ONE READER, AND ONLY ONE CALL SITE. A native column's value lives on
   * the contractor row and a custom column's lives in `snap.values`; a grid
   * that reaches into `values` for both renders all 25 native columns BLANK,
   * which reads as missing data rather than as a bug.
   */
  assert.equal(
    (codeOnly(grid).match(/registerCellValue\(/g) ?? []).length,
    1,
    "every cell must come through one call to registerCellValue",
  );
  assert.match(
    grid,
    /registerCellValue\(\s*column,\s*row as unknown as Record<string, unknown>,\s*snap\.values,\s*row\.id,\s*\)/,
    "and it must be handed BOTH sources",
  );

  // Gated on what the server resolved, never on a role name.
  assert.match(grid, /snap\.canConfigure/);
  assert.match(grid, /snap\.canEditValues/);
  const code = codeOnly(grid);
  assert.doesNotMatch(code, /role === "owner"|role === "admin"/, "no role-name gate");

  // The five verbs the criterion asks for.
  assert.match(grid, /addRegisterColumn\("contractors", title, newType\)/, "add");
  assert.match(grid, /renameRegisterColumn\(column\.id, title\)/, "rename");
  assert.match(grid, /setRegisterColumnHidden\(column\.id, /, "hide and show");
  assert.match(grid, /resizeRegisterColumn\(drag\.id, settled\.width\)/, "resize");
  /*
   * Reorder sends the WHOLE order, computed by `orderAfterMove` over the FULL
   * column list. A pair of indices cannot express this: a list cannot hold two
   * columns in one place, so the invalid state is unrepresentable rather than
   * validated.
   */
  assert.match(grid, /orderAfterMove\(snap\.columns, column\.key, index \+ delta\)/);
  assert.match(grid, /reorderRegisterColumns\("contractors", order\)/);

  // A refusal is shown in the server's own words.
  assert.match(grid, /caught instanceof RegisterError\s*\?\s*caught\.message/);

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /<ContractorRegister/, "and the page mounts it");
});

test("W06-11 the superseded twelfth-column comment was rewritten, not left contradicting the code", async () => {
  /*
   * The old table's `<thead>` carried a comment arguing against a twelfth
   * column. The reasoning was right about a HARD-CODED column and does not
   * survive a register the reader configures, so it had to be replaced rather
   * than left standing beside code that does the opposite.
   */
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.doesNotMatch(
    app,
    /A twelfth column was the wrong answer/,
    "the superseded argument must not remain",
  );
  assert.match(
    app,
    /THE REGISTER IS MOUNTED HERE, and the fixed table is gone/,
    "and its replacement has to say what changed",
  );
  // The half of the old argument that DOES survive: the archived flag rides
  // with the name rather than taking a column of its own.
  assert.match(app, /contractor-archived-chip/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   BEHAVIOUR — against the running product
   ═══════════════════════════════════════════════════════════════════════════ */

/** Create a contractor for this run and remember its id for cleanup. */
async function makeContractor(suffix) {
  const created = await fixtureCall("POST", "/api/workspace", {
    entity: "contractor",
    data: { name: `${RUN} ${suffix}` },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  assert.ok(id, `no id came back: ${JSON.stringify(created.body)}`);
  /* Remembered before anything else can fail, so cleanup never loses a row. */
  createdContractors.push(id);
  return id;
}

/** A site that already exists in the primary tenant. Never created, never edited. */
const HOST_SITE = "store-aldgate";

test("W05-09/W06-10 a link is created once, read from both ends, and removed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Linkable");

  const linked = await call("POST", "/api/contractor-sites", {
    contractorId,
    siteId: HOST_SITE,
  });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  createdLinks.push(linked.body.link.id);

  // FROM THE SITE. This is the fifth connection W05-09 asks for.
  const fromSite = await call("GET", `/api/contractor-sites?siteId=${HOST_SITE}`);
  assert.equal(fromSite.status, 200);
  const onSite = fromSite.body.links.find((row) => row.contractor.id === contractorId);
  assert.ok(onSite, "the site does not list the contractor it is linked to");
  assert.equal(onSite.contractor.name, `${RUN} Linkable`);
  // And the picker no longer offers what is already linked.
  assert.ok(
    !fromSite.body.candidates.some((row) => row.id === contractorId),
    "a linked contractor must not still be offered as a candidate",
  );

  // FROM THE CONTRACTOR. This is the Sites leg of W06-10.
  const fromContractor = await call(
    "GET",
    `/api/contractor-sites?contractorId=${encodeURIComponent(contractorId)}`,
  );
  assert.equal(fromContractor.status, 200);
  assert.deepEqual(
    fromContractor.body.links.map((row) => row.site.id),
    [HOST_SITE],
    "the contractor does not list the site it is linked to",
  );

  const removed = await call(
    "DELETE",
    `/api/contractor-sites?id=${encodeURIComponent(linked.body.link.id)}`,
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const after = await call(
    "GET",
    `/api/contractor-sites?contractorId=${encodeURIComponent(contractorId)}`,
  );
  assert.deepEqual(after.body.links, [], "the link survived its own removal");

  // Removing it twice is a 404 and not a 500 — there is nothing left to remove.
  const again = await call(
    "DELETE",
    `/api/contractor-sites?id=${encodeURIComponent(linked.body.link.id)}`,
  );
  assert.equal(again.status, 404);
  assert.equal(again.body.error, "That link does not exist.");
});

test("W05-09/W06-10 a repeat link neither duplicates nor fails", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Repeat");

  const first = await call("POST", "/api/contractor-sites", {
    contractorId,
    siteId: HOST_SITE,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  createdLinks.push(first.body.link.id);

  /*
   * A double-tap on a phone, a retried request and two coordinators pressing
   * Link in the same second must all produce ONE row and no error. The unique
   * index is what makes that safe rather than a race.
   */
  const second = await call("POST", "/api/contractor-sites", {
    contractorId,
    siteId: HOST_SITE,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.unchanged, true);
  assert.equal(second.body.link.id, first.body.link.id, "a repeat must not mint a second row");

  const listed = await call(
    "GET",
    `/api/contractor-sites?contractorId=${encodeURIComponent(contractorId)}`,
  );
  assert.equal(listed.body.links.length, 1, "two rows exist for one pair");

  // And the database agrees, not just the API's own read.
  const db = await openDevDatabase(true);
  if (db) {
    try {
      const { n } = db
        .prepare(
          "SELECT count(*) AS n FROM contractor_sites WHERE organisation_id = ? AND contractor_id = ? AND site_id = ?",
        )
        .get(PRIMARY_ORGANISATION_ID, contractorId, HOST_SITE);
      assert.equal(Number(n), 1, "the pair index did not hold");
    } finally {
      db.close();
    }
  }
});

test("W05-09/W06-10 a foreign or unknown id is 404 and writes nothing", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Guarded");

  const noSuchContractor = await call("POST", "/api/contractor-sites", {
    contractorId: `${RUN}-does-not-exist`,
    siteId: HOST_SITE,
  });
  assert.equal(noSuchContractor.status, 404);
  assert.equal(noSuchContractor.body.error, "Contractor not found.");

  const noSuchSite = await call("POST", "/api/contractor-sites", {
    contractorId,
    siteId: `${RUN}-no-site`,
  });
  assert.equal(noSuchSite.status, 404);
  assert.equal(noSuchSite.body.error, "Site not found.");

  /*
   * AND A CAPABLE STRANGER IS STILL A STRANGER. `admin@demo-client-ltd…` holds
   * `sites.edit` in the OTHER organisation, so the capability check waves them
   * through and the organisation filter is what refuses — which is the thing
   * being proved. 404 rather than 403, in the same words, because telling those
   * apart tells a caller which ids exist inside a tenant they may not read.
   */
  const stranger = await callAs(OTHER_ADMIN_IDENTITY, "POST", "/api/contractor-sites", {
    contractorId,
    siteId: HOST_SITE,
  });
  assert.equal(stranger.status, 404, JSON.stringify(stranger.body));
  assert.equal(stranger.body.error, "Contractor not found.");

  // Nothing was written by any of the three.
  const db = await openDevDatabase(true);
  if (db) {
    try {
      const { n } = db
        .prepare("SELECT count(*) AS n FROM contractor_sites WHERE contractor_id = ?")
        .get(contractorId);
      assert.equal(Number(n), 0, "a refused link still created a row");
    } finally {
      db.close();
    }
  }
});

test("W05-09 the site's candidate list is the register, never a coverage match", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Coverage");

  /*
   * The fixture is created with NO coverage areas at all. If anything in this
   * path inferred a relationship from `coverage_areas`, a contractor with none
   * would be missing from the candidates for a UK site — and a contractor with
   * `["UK"]` would arrive pre-linked. Neither happens: the candidate list is
   * every contractor in the tenant that is not already linked, and the links
   * list is empty until somebody records one.
   */
  const before = await call("GET", `/api/contractor-sites?siteId=${HOST_SITE}`);
  assert.equal(before.status, 200);
  assert.ok(
    before.body.candidates.some((row) => row.id === contractorId),
    "a contractor with no coverage recorded must still be linkable",
  );
  assert.ok(
    !before.body.links.some((row) => row.contractor.id === contractorId),
    "nothing may arrive pre-linked",
  );

  // And the search narrows by NAME, which is the only thing it claims to match.
  const searched = await call(
    "GET",
    `/api/contractor-sites?siteId=${HOST_SITE}&q=${encodeURIComponent(`${RUN} Coverage`)}`,
  );
  assert.equal(searched.status, 200);
  assert.deepEqual(
    searched.body.candidates.map((row) => row.id),
    [contractorId],
    "the search must match the name and nothing else",
  );
});

test("W06-08/W06-10 a document is filed against a contractor and survives a new version", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Documented");

  const uploaded = await uploadDocument({
    name: `${RUN}-certificate.txt`,
    title: `${RUN} certificate`,
    anchors: { contractorId },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const documentId = uploaded.body.file.id;
  createdDocuments.push(documentId);
  assert.equal(uploaded.body.file.contractorId, contractorId);

  // Reachable FROM the contractor, which is the leg W06-10 asks for.
  const listed = await call(
    "GET",
    `/api/files?contractorId=${encodeURIComponent(contractorId)}`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.files.map((file) => file.id),
    [documentId],
  );

  /*
   * A NEW VERSION IS THE SAME DOCUMENT. `root_document_id` / `version_no` /
   * `is_current`, with a unique partial index on `coalesce(root, id) WHERE
   * is_current`. The replacement inherits its predecessor's anchors, so the
   * contractor link has to survive — the replacement form does not re-send
   * relationships nobody asked it to change.
   */
  const versioned = await uploadDocument({
    name: `${RUN}-certificate-v2.txt`,
    // Deliberately NO anchors and no title: the replacement form does not
    // re-send relationships nobody asked it to change, which is exactly the
    // case `effectiveAnchors` exists for.
    replaces: documentId,
  });
  assert.equal(versioned.status, 201, JSON.stringify(versioned.body));
  createdDocuments.push(versioned.body.file.id);
  assert.equal(versioned.body.file.versionNo, 2);
  assert.equal(
    versioned.body.file.contractorId,
    contractorId,
    "the contractor link did not survive versioning",
  );

  // And the contractor still holds exactly ONE document, not two.
  const afterVersion = await call(
    "GET",
    `/api/files?contractorId=${encodeURIComponent(contractorId)}`,
  );
  assert.deepEqual(
    afterVersion.body.files.map((file) => file.id),
    [versioned.body.file.id],
    "a replaced certificate must count once, as the document it is",
  );

  // The workspace payload's per-contractor count agrees with that list.
  const workspace = await call("GET", "/api/workspace");
  const row = workspace.body.workspace.contractors.find((entry) => entry.id === contractorId);
  assert.ok(row, "the contractor is not in the workspace payload");
  assert.equal(row.documentCount, 1, "documentCount must count documents, not versions");
});

test("W06-08 an anchor can be set and cleared after upload, and never orphans a document", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const contractorId = await makeContractor("Anchoring");

  // Filed against a SITE only, so there is something to fall back on.
  const anchored = await uploadDocument({
    name: `${RUN}-method-statement.txt`,
    title: `${RUN} method statement`,
    anchors: { siteId: HOST_SITE },
  });
  assert.equal(anchored.status, 201, JSON.stringify(anchored.body));
  const withSite = anchored.body.file.id;
  createdDocuments.push(withSite);
  assert.equal(anchored.body.file.contractorId, null);

  const filed = await call("PATCH", `/api/files/${withSite}`, { contractorId });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.file.contractorId, contractorId);

  // A foreign or unknown contractor is 404, in the shared wording.
  const bad = await call("PATCH", `/api/files/${withSite}`, {
    contractorId: `${RUN}-nobody`,
  });
  assert.equal(bad.status, 404);
  assert.equal(bad.body.error, "Contractor not found.");

  // Unfiling is allowed while the site anchor remains.
  const unfiled = await call("PATCH", `/api/files/${withSite}`, { contractorId: null });
  assert.equal(unfiled.status, 200, JSON.stringify(unfiled.body));
  assert.equal(unfiled.body.file.contractorId, null);

  /*
   * AND NOTHING MAY FLOAT FREE. A document whose only anchor is the contractor
   * cannot be unfiled — "a document must be filed against a work order, a site,
   * a unit or a contractor" is not suspended by editing.
   */
  const onlyContractor = await uploadDocument({
    name: `${RUN}-insurance.txt`,
    title: `${RUN} insurance`,
    anchors: { contractorId },
  });
  assert.equal(onlyContractor.status, 201, JSON.stringify(onlyContractor.body));
  createdDocuments.push(onlyContractor.body.file.id);

  const orphan = await call("PATCH", `/api/files/${onlyContractor.body.file.id}`, {
    contractorId: null,
  });
  assert.equal(orphan.status, 400, JSON.stringify(orphan.body));
  assert.equal(
    orphan.body.error,
    "A document must be filed against a work order, a site, a unit or a contractor.",
  );
});

test("W06-11 the Contractors register persists its columns and refuses a native delete", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }

  const snapshot = await call("GET", "/api/registers?register=contractors");
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.equal(snapshot.body.register, "contractors");
  assert.ok(
    snapshot.body.columns.some((column) => column.native && column.nativeField === "name"),
    "the contractor's own name must be a native column",
  );

  // ADDING a column of somebody's own — W05-08's ask, on this register.
  const added = await call("POST", "/api/registers", {
    register: "contractors",
    title: `${RUN} Preferred contact hour`,
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const column = added.body.column;
  createdColumns.push(column.id);
  assert.equal(column.native, false);
  assert.equal(column.nativeField, null);

  /*
   * PERSISTENCE ACROSS RELOAD is not a client concern: the column is a row, so
   * a second GET is what a reloaded page would do. Asserted that way rather
   * than by driving a browser, because a browser test would prove the fetch and
   * not the storage.
   */
  const reloaded = await call("GET", "/api/registers?register=contractors");
  const persisted = reloaded.body.columns.find((entry) => entry.id === column.id);
  assert.ok(persisted, "the added column did not survive a reload");
  assert.equal(persisted.title, `${RUN} Preferred contact hour`);

  // A NATIVE COLUMN CANNOT BE DELETED, and the refusal is an instruction.
  const native = reloaded.body.columns.find((entry) => entry.nativeField === "name");
  const refused = await call("DELETE", `/api/registers?id=${encodeURIComponent(native.id)}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Native columns cannot be deleted. Hide it instead.");

  // And the custom one can, which is the difference.
  const deleted = await call("DELETE", `/api/registers?id=${encodeURIComponent(column.id)}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
});
