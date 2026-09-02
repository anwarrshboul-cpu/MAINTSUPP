import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * Workstream 5 — the site's STATE, its CLOSURE and its PROFILE.
 *
 * Four official criteria are pinned here, and each test name says which:
 *
 *   W05-05  A confirmation before a site is removed from the active roster —
 *           on EVERY path that removes it, not only the one somebody happened
 *           to guard first.
 *   W05-07  `status`, `lifecycle` and `active` are three facts about a site,
 *           not three names for one, and no edit may leave them contradicting
 *           each other.
 *   W05-10  Clicking a site opens a COMPLETE profile — with the right numbers
 *           on it, and at an address that can be reloaded and shared.
 *   W05-01  Coordinates are reachable from a screen, under the capability that
 *           owns the register.
 *
 * TWO KINDS OF ASSERTION, kept apart the way `workstream-five-sites.test.mjs`
 * keeps them:
 *
 *   SOURCE — read the file and prove the rule is encoded there. These need no
 *   server and are what catch a refactor that quietly removes a guard. Every
 *   confirmation assertion is necessarily one of these: `window.confirm` is a
 *   browser dialog and there is no browser in this suite.
 *
 *   BEHAVIOUR — drive the running API and prove the DATA obeys the rule. These
 *   skip when no development server answers, the bargain
 *   `workstream-five-site-patch.test.mjs` already makes.
 *
 * The fixture is created through the product's own POST, is named with the
 * `ZZQA-W5-STATE-` prefix in BOTH its name and its code, and is hard-deleted by
 * exact primary key in `after()` — never by a name substring, which has eaten
 * other suites' fixtures before now.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const DETAIL = "app/(app)/portal/sites/site-detail.tsx";
const MANAGER = "app/(app)/portal/sites/sites-manager.tsx";
const FORM = "app/(app)/portal/sites/site-form.tsx";
const CLOSURE = "app/(app)/portal/sites/site-closure.ts";
const DRAWER = "app/(app)/portal/workspace-data-manager.tsx";
const SITES_ROUTE = "app/api/sites/route.ts";
const WORKSPACE_ROUTE = "app/api/workspace/route.ts";
const STATE = "app/lib/site-state.ts";

/** Source with comments removed, so prose about a defect is not read as code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// W05-05 — SOURCE. One confirmation, on every door.
// ---------------------------------------------------------------------------

test("W05-05 — the closure confirmation names the site, the consequence and what survives", async () => {
  const source = await read(CLOSURE);
  /*
   * The three things the owner required of the sentence. Asserted on the
   * MESSAGE BUILDER rather than on a rendered dialog because there is no
   * browser here — but the builder is the only place either caller gets its
   * words from, so pinning it pins both dialogs.
   */
  assert.match(source, /export function siteClosureMessage\(name: string\)/);
  assert.match(
    code(source),
    /Close \$\{subject\}\?/,
    "the confirmation must name the site it is about to close",
  );
  assert.match(
    code(source),
    /leaves the active site register/,
    "and say that the site leaves the active register",
  );
  assert.match(
    code(source),
    /Nothing is deleted/,
    "and say plainly that nothing is deleted",
  );
  for (const kept of ["jobs", "documents", "compliance records", "assets"]) {
    assert.ok(
      code(source).includes(kept),
      `the confirmation must say ${kept} are kept — that is the half that stops the opposite mistake`,
    );
  }
});

test("W05-05 — both closure paths ask the same question, from the same helper", async () => {
  for (const path of [MANAGER, DRAWER]) {
    const source = await read(path);
    assert.match(
      source,
      /import \{ confirmSiteClosure \} from "\.[^"]*site-closure"/,
      `${path} must use the shared confirmation rather than its own sentence`,
    );
    assert.match(
      code(source),
      /confirmSiteClosure\(/,
      `${path} imports the helper and must actually call it`,
    );
  }

  /*
   * The register's own sentence is gone rather than merely supplemented. It
   * said only "Its jobs and certificates are kept" and never mentioned that the
   * site leaves the active roster, so leaving it in place would mean two
   * different promises about one action.
   */
  assert.doesNotMatch(
    code(await read(MANAGER)),
    /Its jobs and certificates are kept/,
    "the register's old, narrower sentence must not survive beside the shared one",
  );
});

test("W05-05 — cancel returns before anything is written, on both paths", async () => {
  /*
   * The property is "cancel costs nothing", and in a `window.confirm` world it
   * is structural: the guard must be an early return placed BEFORE the call
   * that writes. A guard that runs after the fetch, or that only skips a toast,
   * would satisfy a looser assertion and still close the site.
   */
  const manager = code(await read(MANAGER));
  assert.match(
    manager,
    /if \(!confirmSiteClosure\(site\.name\)\) return;\s*\n\s*try \{/,
    "the register must return before the DELETE call, not after it",
  );

  const drawer = code(await read(DRAWER));
  /*
   * RE-POINTED, CONTRACT UNCHANGED AND NOW CHECKED MORE DIRECTLY.
   *
   * This matched the site guard and `try { await onSave(` as ADJACENT text, and
   * W06-04 put a second guard between them: unticking "Active contractor"
   * writes the same `active: false` the contractor Archive button writes, so
   * that submit now asks its own question before the same `onSave`. The two
   * guards are siblings and the property this pin exists for is unchanged —
   * a declined confirmation RETURNS, and it returns BEFORE anything is written.
   * So it is asserted as that: the guard still ends in `return`, and its return
   * is positioned ahead of the only `onSave` in the handler, which adjacency
   * was only ever a proxy for.
   */
  assert.match(
    drawer,
    /!confirmSiteClosure\(String\(form\.name \?\? stored\.name\)\)\) return; \}/,
    "the drawer's site guard must be an early return, not a skipped toast",
  );
  const siteGuard = drawer.indexOf("!confirmSiteClosure(String(form.name ?? stored.name))) return; }");
  const submitSave = drawer.indexOf("try { await onSave(");
  assert.ok(siteGuard >= 0 && submitSave >= 0, "both halves of the submit handler are still there");
  assert.ok(
    siteGuard < submitSave,
    "the drawer's submit must return before onSave, not inside its catch",
  );
  /*
   * RE-POINTED, CONTRACT UNCHANGED. This matched a TWO-way ternary — a site, or
   * the generic sentence — and W06-04 made it a three-way one: a contractor now
   * has a question of its own (`contractor-closure.ts`) for exactly the reason a
   * site does, that two doors reach one outcome and only one of them used to
   * ask. The `siteName` local went with it, because the name is now resolved by
   * one small helper shared by both branches. What this pin protects is
   * untouched and is still asserted directly, in two halves: a SITE gets
   * `confirmSiteClosure`, and a register with no question of its own still
   * falls through to the generic `window.confirm`.
   */
  assert.match(
    drawer,
    /const agreed = tab === "site" \? confirmSiteClosure\(/,
    "and its Archive button must ask the site question for a site",
  );
  assert.match(
    drawer,
    /: window\.confirm\("Archive this record\?/,
    "while a register with no question of its own still gets the generic sentence",
  );
  assert.match(
    drawer,
    /if \(agreed\) \{ try \{ await onArchive\(/,
    "with the archive call inside the agreement, so declining writes nothing",
  );
});

test("W05-05 — only a real closure is confirmed", async () => {
  /*
   * Asking about something that is not happening is how people learn to click
   * Yes without reading. The drawer confirms when an EXISTING record whose
   * stored lifecycle is not already Closed is being saved as Closed — not on
   * create, and not on a re-save of a site that is closed already.
   */
  const drawer = code(await read(DRAWER));
  assert.match(
    drawer,
    /tab === "site" && editorId && String\(form\.lifecycle \?\? ""\) === SITE_LIFECYCLE_CLOSED/,
    "the drawer must only confirm when an existing site is being closed",
  );
  assert.match(
    drawer,
    /stored && stored\.lifecycle !== SITE_LIFECYCLE_CLOSED/,
    "and must compare against what is STORED, not against the form it is reading",
  );
});

// ---------------------------------------------------------------------------
// W05-07 — SOURCE. Three facts, one reconciliation.
// ---------------------------------------------------------------------------

test("W05-07 — the state rules have exactly one home, and every write path uses it", async () => {
  const state = await read(STATE);
  assert.match(state, /export function reconcileSiteState\(/);
  assert.match(state, /export function siteStateContradiction\(/);
  assert.match(state, /export function normaliseSiteLifecycle\(/);
  /*
   * A pure module on purpose. Two of its callers are client components, so a
   * database import here would either break the build or force the rules to be
   * restated in the browser — which is how the drawer and the route came to
   * disagree in the first place.
   */
  assert.doesNotMatch(
    state,
    /from "(\.\.\/)+db/,
    "site-state.ts must stay free of database imports so client components can use it",
  );

  for (const path of [SITES_ROUTE, WORKSPACE_ROUTE]) {
    const source = await read(path);
    assert.match(
      source,
      /reconcileSiteState/,
      `${path} must reconcile the trio through the shared rule`,
    );
  }
});

test("W05-07 — a lifecycle is one of two words or a refusal, never forty characters of text", async () => {
  /*
   * THE PIN THIS REPLACES AND WHY. `prebatch-workspace-hardening.test.mjs`
   * pinned the two literal objects this branch used to build — `lifecycleState
   * = { status: "closed", active: false }` and `{ status: "active", active:
   * true }`. Those literals are gone because the projection they belonged to is
   * gone; the CONTRACT they were protecting is not, and it is asserted here and
   * behaviourally further down. The contract was never "these two object
   * literals exist" — it was "closing writes all three columns, reopening
   * clears them, and neither flattens 'international' or 'other'".
   *
   * What was missing from that contract, and is added here: the value was never
   * CHECKED. `supplied(data, "lifecycle", (value) => text(value, 40))` stored
   * whatever arrived, so `lifecycle: "closed"` — lower case, matching no branch
   * — was written onto a row whose status stayed 'active'.
   */
  const workspace = code(await read(WORKSPACE_ROUTE));
  assert.match(
    workspace,
    /if \("lifecycle" in data && !normaliseSiteLifecycle\(data\.lifecycle\)\) \{/,
    "an unrecognised lifecycle must be refused, not stored",
  );
  assert.doesNotMatch(
    workspace,
    /supplied\(data, "lifecycle"/,
    "the raw lifecycle text must no longer reach the UPDATE — the reconciliation writes it",
  );
  /* Both verbs, because a route that refuses on edit what it accepts on create
     only moves the bad row's birthday. */
  assert.equal(
    workspace.match(/normaliseSiteLifecycle\(data\.lifecycle\)/g)?.length,
    2,
    "POST and PATCH must both validate the lifecycle",
  );
});

test("W05-07 — the Sites tab no longer restates a list the options registry owns", async () => {
  const drawer = code(await read(DRAWER));
  /*
   * The three literals that were here — `["Kiosk", "Inline", "Office",
   * "Warehouse"]`, `["UK", "Europe", "Other"]` and `["Current", "Closed"]` —
   * bypassed the `option_values` registry that `POST /api/sites` validates the
   * same columns against. The general guard is in
   * `tests/stage-two-sites-units.test.mjs`; this names the three by hand so the
   * failure says which field regressed.
   */
  assert.doesNotMatch(drawer, /\["Kiosk", "Inline", "Office", "Warehouse"\]/);
  assert.doesNotMatch(drawer, /\["UK", "Europe", "Other"\]/);
  assert.doesNotMatch(drawer, /\["Current", "Closed"\]/);
  assert.match(
    drawer,
    /options: SITE_LIFECYCLES\.map\(/,
    "the lifecycle select must read the one shared definition",
  );
  /*
   * RE-POINTED, CONTRACT UNCHANGED. This matched the literal
   * `fetch("/api/options?key=site_type")`, and W06-06/W06-09 gave the drawer two
   * more configured vocabularies to fetch — `contractor_trade` and
   * `contractor_payment_terms` — so the three now go through one reader,
   * `load(key, apply)`, whose URL is built from its argument. The promise this
   * pin exists for is that the Type select reads the CONFIGURED list rather
   * than a literal, and that is what is asserted: the site_type list is
   * requested from the options registry, and the request is a
   * `/api/options?key=` one.
   */
  assert.match(
    drawer,
    /load\("site_type", setSiteTypes\)/,
    "and the type select must read the configured site types",
  );
  assert.match(
    drawer,
    /fetch\(`\/api\/options\?key=\$\{key\}`\)/,
    "from the options registry, through the one reader all three lists share",
  );
});

test("W05-07 — availability is a control, and it is not a second status field", async () => {
  const form = await read(FORM);
  assert.match(
    code(form),
    /active: site \? String\(Boolean\(site\.active\)\) : "true"/,
    "the Sites form must carry `active` so an editor can state eligibility",
  );
  assert.match(
    code(form),
    /checked=\{form\.active === "true"\}/,
    "with a real control bound to it",
  );
  const route = code(await read(SITES_ROUTE));
  assert.match(
    route,
    /"active" in sent \? \{ active: flag\(sent\.active\) \} : \{\}/,
    "and PATCH must draw the same absent-versus-sent line it draws for every other column",
  );
});

// ---------------------------------------------------------------------------
// W05-10 — SOURCE. A complete profile, at an address.
// ---------------------------------------------------------------------------

test("W05-10 — Documents held counts documents, not compliance requirements", async () => {
  const detail = code(await read(DETAIL));
  /*
   * MEASURED BEFORE THE FIX, against the running server: a site whose Documents
   * tab lists 2 files reported "Documents held: 265", because the card rendered
   * `data.compliance.length` — the number of register ENTRIES, Missing and Not
   * required included. Those are the documents the site does not have.
   */
  assert.match(
    detail,
    /Documents held<\/span>\s*\n\s*<strong>\{data\.files\.length\}<\/strong>/,
    "the Documents held card must count the site's actual files",
  );
  assert.match(
    detail,
    /Compliance requirements<\/span>\s*\n\s*<strong>\{data\.compliance\.length\}<\/strong>/,
    "and the compliance figure keeps a card under a label that says what it is",
  );
});

test("W05-10 — the profile shows the fields it was fetching and never rendering", async () => {
  const detail = code(await read(DETAIL));
  assert.match(detail, /data\.groups\.map\(\(group\) => group\.name\)/, "reporting groups");
  assert.match(detail, /label="Region" value=\{site\.region\}/, "region");
  assert.match(detail, /label="Country" value=\{site\.country\}/, "country");
  assert.match(detail, /site\.addressLine2/, "address line 2");
  assert.match(detail, /formatMoney\(site\.annualBudgetPence\)/, "annual budget");
  assert.match(detail, /site\.latitude !== null && site\.longitude !== null/, "coordinates");
  assert.match(detail, /data\.aliases\.join\(", "\)/, "former names");

  /*
   * `groupIds` STAYS. `SiteDetail` hands it to the editor and `PATCH
   * /api/sites` treats a sent list as authoritative — `setSiteGroupMembership`
   * deletes every membership row before re-inserting what it was handed — so
   * anything that replaced it with the named list would silently destroy group
   * membership on the next save from the profile.
   */
  assert.match(
    detail,
    /onEdit\(site, data\.groupIds\)/,
    "the editor must still be handed the id list it needs, not the display names",
  );

  const route = await read(SITES_ROUTE);
  assert.match(route, /groupIds: groups\.map\(\(entry\) => entry\.siteGroupId\)/);
  assert.match(route, /groups: allGroups/, "the detail payload must carry the group names too");
  assert.match(route, /aliases: allAliases/, "and the site's former names");
});

test("W05-10 — the Overview panel does not claim to be a stat grid", async () => {
  const detail = await read(DETAIL);
  /*
   * THE LAYOUT DEFECT, measured in-browser at every width. The panel carried
   * `className="site-stat-grid"`, and `.site-stat-grid > div` (app/globals.css)
   * restyles every direct child as a stat card — `grid-template-columns: 38px
   * 1fr auto`. The wide block of labelled rows was one of those children, so
   * its eight `.detail-row` divs flowed into a three-column grid whose first
   * track is 38px, each then applying its own `minmax(9rem, 14rem) 1fr` inside
   * it. The labels painted on top of each other: "SERVICE CHARGOPENING HOURS",
   * "PARKINGNOTES", with the value track collapsed to 13px at 1440.
   */
  assert.doesNotMatch(
    detail,
    /section="Overview"\s*\n\s*className="site-stat-grid"/,
    "the Overview panel must not restyle its labelled rows as stat cards",
  );
  assert.match(
    detail,
    /className="site-detail__overview"/,
    "it stacks two blocks instead",
  );
  assert.match(
    detail,
    /<div className="site-stat-grid">/,
    "with the stat grid wrapping only the things that are stat cards",
  );

  const css = await read("app/globals.css");
  assert.match(css, /\.site-detail__overview \{/, "and the stacking rule exists");
  /*
   * NO NEW BREAKPOINT. The fix is a two-child stack that is correct at every
   * width, and the stat grid's own responsive rules — already written at the
   * agreed 767 and 1024 — go on applying to the grid because the grid is still
   * a grid. A layout defect answered with a media query would be the width the
   * bug was measured at, hardened into CSS. The project's five permitted widths
   * are enforced for the whole stylesheet by the stage suites; this asserts
   * only that the rule this change adds needs none of them.
   */
  const rule = css.slice(css.indexOf(".site-detail__overview {"));
  assert.doesNotMatch(
    rule.slice(0, rule.indexOf("}") + 1),
    /@media/,
    "the stacking rule must not be conditional on a viewport width",
  );
});

test("W05-10 — the profile is deep-linkable and survives Back", async () => {
  const manager = code(await read(MANAGER));
  /*
   * The three views replace each other out of `useState`, so opening a site
   * used to change nothing about the URL: a reload went back to the register
   * and the profile could not be sent to anybody. A query parameter rather than
   * a path segment, because `portal-app.tsx` reads `location.pathname` on
   * `popstate` to choose its section and would not recognise a deeper path.
   */
  assert.match(manager, /const SITE_PARAM = "site"/);
  assert.match(
    manager,
    /new URLSearchParams\(window\.location\.search\)\.get\(SITE_PARAM\)/,
    "the URL must be what decides whether the detail screen is open",
  );
  assert.match(
    manager,
    /window\.addEventListener\("popstate", sync\)/,
    "Back and Forward must reach the same reader as a fresh load",
  );
  assert.match(
    manager,
    /window\.history\.pushState\(null, "", siteHref\(siteId\)\)/,
    "opening a site must put it in the URL",
  );
  assert.match(
    manager,
    /window\.history\.pushState\(null, "", siteHref\(null\)\)/,
    "and leaving it must take it out again",
  );
  assert.match(
    manager,
    /onClick=\{\(\) => openSite\(site\.id\)\}/,
    "the register row must go through the one function that owns both",
  );
  /* The tab UX is untouched: the seven sections are still local state. */
  assert.match(
    manager,
    /<SiteDetail/,
    "and the detail screen itself is unchanged",
  );
});

// ---------------------------------------------------------------------------
// W05-01 — SOURCE. Coordinates, and what `position` actually is.
// ---------------------------------------------------------------------------

test("W05-01 — coordinates are editable under sites.edit and bounded", async () => {
  const form = code(await read(FORM));
  assert.match(form, /id="latitude"/, "the Sites form must carry latitude");
  assert.match(form, /id="longitude"/, "and longitude");
  assert.match(form, /min=\{-90\}\s*\n\s*max=\{90\}/, "with the real bounds on the control");
  assert.match(form, /min=\{-180\}\s*\n\s*max=\{180\}/);
  assert.match(form, /step="any"/, "and a step that allows a decimal degree");

  const route = await read(SITES_ROUTE);
  /*
   * The capability matters as much as the field. The only previous write path
   * was `app/api/sites/csv/route.ts`, which runs under `data.import` — so the
   * person who owns the site register could not record where a site is, and
   * somebody with permission to bulk-load a spreadsheet could.
   */
  assert.match(
    route,
    /scopedDbWithCapability\(request, "sites\.edit"\)/,
    "the Sites route must remain the sites.edit surface",
  );
  assert.equal(
    code(route).match(/coordinateRefusal\(payload\.latitude, payload\.longitude\)/g)?.length,
    2,
    "both POST and PATCH must check the bounds",
  );

  const state = code(await read(STATE));
  assert.match(state, /latitude < LATITUDE_MIN \|\| latitude > LATITUDE_MAX/);
  assert.match(state, /longitude < LONGITUDE_MIN \|\| longitude > LONGITUDE_MAX/);
});

test("W05-01 — `position` is register row order and is not offered as a field", async () => {
  /*
   * WHAT WAS CONCLUDED, WRITTEN DOWN SO THE NEXT READER DOES NOT RE-OPEN IT.
   *
   * `sites.position` is set once, at creation, by `nextSitePosition` — max + 1
   * over the organisation — and no route, importer or screen ever updates it.
   * Its only readers are the two `orderBy(asc(sites.position), asc(sites.name))`
   * clauses in `app/lib/sites-repository.ts`. It is the register's ROW ORDER,
   * not an attribute of the place: the canonical register even holds duplicate
   * positions across rows, which is meaningless as a site property and harmless
   * as a sort key with a name tiebreak.
   *
   * So it is deliberately NOT on the Sites form. Adding a numeric textbox
   * labelled "Position" would satisfy a checklist and mislead every person who
   * ever saw it. If the register is to be reorderable, that is a drag handle on
   * the list writing a whole ordering, and it belongs with row ordering — not
   * here.
   */
  const repository = await read("app/lib/sites-repository.ts");
  assert.match(
    repository,
    /export async function nextSitePosition\(/,
    "position is still assigned once, at creation",
  );
  assert.match(
    repository,
    /orderBy\(asc\(sites\.position\), asc\(sites\.name\)\)/,
    "and read only as a sort key",
  );
  assert.doesNotMatch(
    code(await read(FORM)),
    /id="position"/,
    "a meaningless numeric textbox must not be added to the site editor to pass a checklist",
  );
  const route = code(await read(SITES_ROUTE));
  assert.doesNotMatch(
    route,
    /position: \["position"\]/,
    "and an edit must not be able to set it either",
  );
});

// ---------------------------------------------------------------------------
// BEHAVIOUR — the running API. Skips without a development server.
// ---------------------------------------------------------------------------

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 3000, 5174, 5175].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * The fixture prefix. It goes in the NAME and the CODE, so a stray row is
 * traceable to this file; cleanup is still by exact primary key, because a
 * substring sweep has repeatedly eaten other suites' fixtures.
 */
const PREFIX = "ZZQA-W5-STATE-";
const RUN = `${PREFIX}${Date.now().toString(36)}`;

async function serverIsUp() {
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/context`, { signal: AbortSignal.timeout(4000) });
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

/**
 * A contended development database, as opposed to a refusal. Suites run in
 * parallel against one SQLite file; a lock arrives as the Drizzle wrapper
 * message at 400. Retried rather than asserted on — a real refusal ("A site
 * name is required.") does not match this and is never retried.
 */
function transientDatabaseFault(body) {
  const message = typeof body?.error === "string" ? body.error : "";
  return /Failed query|database is locked|SQLITE_BUSY|D1_ERROR|no such table/i.test(message);
}

async function call(method, path, body, attempt = 0) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (transientDatabaseFault(parsed) && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    return call(method, path, body, attempt + 1);
  }
  return { status: response.status, body: parsed };
}

let siteId = null;

/**
 * EVERY row this file created, by primary key.
 *
 * `after()` sweeps this list and nothing else. The prefix in the fixture names
 * is for a human reading the register, never for the cleanup: a
 * filename-substring sweep has eaten other suites' fixtures before now.
 */
const createdIds = [];

/** The three state columns as the API serves them. */
async function trio() {
  const { body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`);
  if (!body?.site) return null;
  return {
    status: body.site.status,
    lifecycle: body.site.lifecycle,
    active: Boolean(body.site.active),
  };
}

async function setUp(t) {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return false;
  }
  await signIn();
  if (!cookie) {
    t.skip("the development server would not authenticate");
    return false;
  }
  if (siteId) return true;
  const created = await call("POST", "/api/sites", {
    confirmDuplicate: true,
    data: {
      name: `${RUN} Site`,
      code: RUN.slice(-8).toUpperCase(),
      siteTypeValue: "Inline",
      status: "active",
      addressLine1: "1 Fixture Way",
      city: "Fixtureton",
      postcode: "ZZ1 1ZZ",
      region: "Europe",
      country: "France",
      latitude: 48.8698,
      longitude: 2.3312,
      annualBudget: "1000.00",
      notes: `${RUN} fixture, safe to delete.`,
    },
  });
  if (created.status !== 200 || !created.body?.id) {
    t.skip(`the fixture could not be created: ${JSON.stringify(created.body)}`);
    return false;
  }
  siteId = created.body.id;
  createdIds.push(siteId);
  return true;
}

test("W05-07 — a save that mentions no state moves no state", async (t) => {
  if (!(await setUp(t))) return;
  const before = await trio();
  assert.deepEqual(before, { status: "active", lifecycle: "Current", active: true });

  const { status } = await call("PATCH", "/api/sites", {
    id: siteId,
    data: { notes: `${RUN} touched` },
  });
  assert.equal(status, 200);
  assert.deepEqual(await trio(), before, "a notes-only edit must leave the trio alone");
});

test("W05-07 — {other, Current, false} is valid, reachable and preserved", async (t) => {
  if (!(await setUp(t))) return;
  /*
   * THE STATE THE REGISTER COULD NOT EXPRESS. An internal, warehouse or legacy
   * location is a CURRENT record that is not operationally eligible, and the
   * old projection had only two answers — 'other' meant Closed and inactive.
   * The owner settled that this trio is valid and must be preserved.
   */
  const moved = await call("PATCH", "/api/sites", { id: siteId, data: { status: "other" } });
  assert.equal(moved.status, 200);
  assert.deepEqual(
    await trio(),
    { status: "other", lifecycle: "Current", active: false },
    "moving a current site to 'other' must not close the record",
  );

  // And an unrelated save must not repair, promote or close it.
  await call("PATCH", "/api/sites", { id: siteId, data: { notes: `${RUN} still other` } });
  assert.deepEqual(
    await trio(),
    { status: "other", lifecycle: "Current", active: false },
    "an edit that says nothing about the state must leave it exactly as it stands",
  );
});

test("W05-07 — closing an 'other' record keeps it 'other'", async (t) => {
  if (!(await setUp(t))) return;
  const closed = await call("DELETE", "/api/sites", { id: siteId });
  assert.equal(closed.status, 200);
  assert.deepEqual(
    await trio(),
    { status: "other", lifecycle: "Closed", active: false },
    "closing must not erase the one column recording that a row cannot be vouched for",
  );

  // Reopening through the drawer leaves the classification alone too.
  const reopened = await call("PATCH", "/api/workspace", {
    entity: "site",
    id: siteId,
    data: { lifecycle: "Current" },
  });
  assert.equal(reopened.status, 200);
  assert.deepEqual(
    await trio(),
    { status: "other", lifecycle: "Current", active: false },
    "and reopening must not promote it into the live register",
  );
});

test("W05-07 — the drawer cannot write a contradicting trio", async (t) => {
  if (!(await setUp(t))) return;
  // Put the fixture back on the ordinary path first.
  await call("PATCH", "/api/sites", { id: siteId, data: { status: "active" } });
  assert.deepEqual(await trio(), { status: "active", lifecycle: "Current", active: true });

  /*
   * THE REACHABLE CORRUPTION. `lifecycle` was written from raw request text
   * with no validation, so a lower-case "closed" matched no branch, was stored
   * verbatim, and left a row the register lists as open with a lifecycle column
   * saying it is shut.
   */
  const bad = await call("PATCH", "/api/workspace", {
    entity: "site",
    id: siteId,
    data: { lifecycle: "closed " },
  });
  const after = await trio();
  assert.ok(
    bad.status === 400 || after.lifecycle === "Closed",
    "a lifecycle must be refused or canonicalised — never stored as sent",
  );
  assert.notEqual(after.lifecycle, "closed ", "the raw string must never reach the column");

  for (const nonsense of ["Banana", "", "   "]) {
    const refused = await call("PATCH", "/api/workspace", {
      entity: "site",
      id: siteId,
      data: { lifecycle: nonsense },
    });
    assert.equal(refused.status, 400, `"${nonsense}" is not a lifecycle`);
    assert.match(String(refused.body?.error ?? ""), /lifecycle must be one of/i);
  }

  // Whatever the row is now, it is coherent.
  const settled = await trio();
  assert.ok(
    (settled.status === "closed" && settled.lifecycle === "Closed" && !settled.active) ||
      (settled.status === "active" && settled.lifecycle === "Current" && settled.active),
    `the trio must be coherent, got ${JSON.stringify(settled)}`,
  );
});

test("W05-07 — closing from the drawer writes all three columns", async (t) => {
  if (!(await setUp(t))) return;
  await call("PATCH", "/api/sites", { id: siteId, data: { status: "active" } });
  const closed = await call("PATCH", "/api/workspace", {
    entity: "site",
    id: siteId,
    data: { lifecycle: "Closed" },
  });
  assert.equal(closed.status, 200);
  assert.deepEqual(
    await trio(),
    { status: "closed", lifecycle: "Closed", active: false },
    "the Lifecycle select must close the site everywhere, not just in the lifecycle word",
  );

  const reopened = await call("PATCH", "/api/workspace", {
    entity: "site",
    id: siteId,
    data: { lifecycle: "Current" },
  });
  assert.equal(reopened.status, 200);
  assert.deepEqual(
    await trio(),
    { status: "active", lifecycle: "Current", active: true },
    "and reopening must clear all three",
  );
});

test("W05-07 — eligibility is settable, and a closed record is never eligible", async (t) => {
  if (!(await setUp(t))) return;
  await call("PATCH", "/api/sites", { id: siteId, data: { status: "active" } });

  const off = await call("PATCH", "/api/sites", { id: siteId, data: { active: "false" } });
  assert.equal(off.status, 200);
  assert.equal((await trio()).active, false, "an editor may state that a site is not eligible");

  const on = await call("PATCH", "/api/sites", { id: siteId, data: { active: "true" } });
  assert.equal(on.status, 200);
  assert.equal((await trio()).active, true, "and may state that it is");

  await call("PATCH", "/api/workspace", { entity: "site", id: siteId, data: { lifecycle: "Closed" } });
  const forced = await call("PATCH", "/api/sites", { id: siteId, data: { active: "true" } });
  assert.equal(forced.status, 200);
  assert.equal(
    (await trio()).active,
    false,
    "but a closed record cannot be made eligible — that is what closed means",
  );
  await call("PATCH", "/api/workspace", { entity: "site", id: siteId, data: { lifecycle: "Current" } });
});

test("W05-01 — coordinates round-trip, refuse out of range, and survive an absent key", async (t) => {
  if (!(await setUp(t))) return;

  const set = await call("PATCH", "/api/sites", {
    id: siteId,
    data: { latitude: 51.5074, longitude: -0.1278 },
  });
  assert.equal(set.status, 200);
  let { body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`);
  assert.equal(body.site.latitude, 51.5074);
  assert.equal(body.site.longitude, -0.1278);

  // An absent key preserves; this is the discipline `preserveUnsent` exists for.
  await call("PATCH", "/api/sites", { id: siteId, data: { notes: `${RUN} no coords sent` } });
  ({ body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`));
  assert.equal(body.site.latitude, 51.5074, "an omitted latitude must not be cleared");
  assert.equal(body.site.longitude, -0.1278, "nor an omitted longitude");

  for (const [data, word] of [
    [{ latitude: 91 }, /latitude/i],
    [{ latitude: -90.5 }, /latitude/i],
    [{ longitude: 181 }, /longitude/i],
    [{ longitude: -180.0001 }, /longitude/i],
  ]) {
    const refused = await call("PATCH", "/api/sites", { id: siteId, data });
    assert.equal(refused.status, 400, `${JSON.stringify(data)} must be refused`);
    assert.match(String(refused.body?.error ?? ""), word, "with a message naming the field");
  }
  ({ body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`));
  assert.equal(body.site.latitude, 51.5074, "a refusal must write nothing");

  // An explicit blank still clears, or a user could never remove a wrong pin.
  const cleared = await call("PATCH", "/api/sites", {
    id: siteId,
    data: { latitude: "", longitude: "" },
  });
  assert.equal(cleared.status, 200);
  ({ body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`));
  assert.equal(body.site.latitude, null);
  assert.equal(body.site.longitude, null);

  // And the create verb refuses too, so the bad row has no birthday either.
  const born = await call("POST", "/api/sites", {
    confirmDuplicate: true,
    data: {
      name: `${RUN} Out Of Range`,
      siteTypeValue: "Inline",
      status: "active",
      addressLine1: "2 Fixture Way",
      latitude: 480,
    },
  });
  assert.equal(born.status, 400, "POST must refuse an impossible latitude");
  assert.equal(born.body?.id, undefined, "and must not have created anything");
});

test("W05-07 — a site cannot be CREATED contradicting itself", async (t) => {
  if (!(await setUp(t))) return;
  /*
   * `POST /api/workspace` named `lifecycle` and neither of the other two state
   * columns, so a new row took the schema defaults for them — status 'active'
   * and active true. Creating a site from the Manage-data drawer with Lifecycle
   * set to Closed was two clicks and stored
   * `{ status: 'active', lifecycle: 'Closed', active: true }`: a record the
   * register lists as open and offers in every location picker, filed under
   * Closed by the reporting groups. A route that refuses on edit what it
   * accepts on create only moves the bad row's birthday.
   */
  for (const [lifecycle, expected] of [
    ["Closed", { status: "closed", lifecycle: "Closed" }],
    ["Current", { status: "active", lifecycle: "Current" }],
  ]) {
    const created = await call("POST", "/api/workspace", {
      entity: "site",
      data: {
        name: `${RUN} create ${lifecycle}`,
        address: "1 Create Way",
        type: "Kiosk",
        region: "UK",
        lifecycle,
      },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body?.id, "the fixture must exist before it is asserted on");
    createdIds.push(created.body.id);
    const { body } = await call("GET", `/api/sites?id=${encodeURIComponent(created.body.id)}`);
    assert.equal(body.site.status, expected.status, `created ${lifecycle}: status`);
    assert.equal(body.site.lifecycle, expected.lifecycle, `created ${lifecycle}: lifecycle`);
    assert.equal(
      Boolean(body.site.active),
      lifecycle === "Current",
      `created ${lifecycle}: a closed record is never operationally active`,
    );
  }

  const refused = await call("POST", "/api/workspace", {
    entity: "site",
    data: { name: `${RUN} create bad`, address: "2 Create Way", type: "Kiosk", lifecycle: "banana" },
  });
  assert.equal(refused.status, 400, "an unrecognised lifecycle must be refused on create too");
  assert.match(String(refused.body?.error ?? ""), /lifecycle must be one of/i);
  assert.equal(refused.body?.id, undefined, "and nothing must have been created");
});

test("W05-01 — the CSV importer refuses the coordinate the form refuses", async (t) => {
  if (!(await setUp(t))) return;
  /*
   * The importer was the only write path either column ever had and it checked
   * nothing but `Number.isFinite`, so a rule enforced on the form alone would
   * be the same rule with a hole in it — and the CSV is exactly where an
   * impossible figure comes from, because it is the path where nobody reads the
   * value. DRY RUN throughout: the assertion is about what the importer says it
   * would do, and nothing is written.
   */
  const header = "name,address_line1,latitude,longitude";
  const bad = await call("POST", "/api/sites/csv", {
    dryRun: true,
    csv: `${header}\n${RUN} Bad Coordinate,9 Fixture Way,480,0\n`,
  });
  assert.equal(bad.status, 200, JSON.stringify(bad.body));
  assert.equal(bad.body.created, 0, "an out-of-range row must not be counted as an import");
  assert.equal(bad.body.skipped?.length, 1, "it must be skipped, with a reason");
  assert.match(String(bad.body.skipped[0].reason), /latitude must be between -90 and 90/i);

  const good = await call("POST", "/api/sites/csv", {
    dryRun: true,
    csv: `${header}\n${RUN} Good Coordinate,9 Fixture Way,48.8698,2.3312\n`,
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.skipped?.length, 0, "a real coordinate must still import");
  assert.equal(good.body.created, 1, "and the row is still counted");
});

test("W05-10 — the profile payload carries what the profile renders", async (t) => {
  if (!(await setUp(t))) return;
  const { body } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`);
  assert.ok(Array.isArray(body.groupIds), "groupIds stays, for the editor");
  assert.ok(Array.isArray(body.groups), "and the named groups arrive beside it");
  assert.ok(Array.isArray(body.aliases), "with the site's former names");
  assert.ok(Array.isArray(body.files));
  assert.ok(Array.isArray(body.compliance));
  for (const group of body.groups) {
    assert.ok(
      body.groupIds.includes(group.id),
      "the named groups must be exactly the ones this site belongs to",
    );
    assert.equal(typeof group.name, "string");
  }
  assert.equal(body.site.annualBudgetPence, 100000, "the budget the profile shows is on the payload");
  assert.equal(body.site.region, "Europe");
  assert.equal(body.site.country, "France");
});

test("W05-10 — Documents held and the compliance figure are different numbers", async (t) => {
  if (!(await setUp(t))) return;
  /*
   * The measurement that found the defect, kept as a test. On the canonical
   * register the two differ by two orders of magnitude — 2 files against 265
   * register entries — so a screen rendering one under the other's label is not
   * slightly wrong. Asserted over the WHOLE register rather than the fixture,
   * because the fixture has neither.
   */
  const { body } = await call("GET", "/api/sites");
  const sites = body?.sites ?? [];
  let checked = 0;
  let differed = 0;
  for (const site of sites.slice(0, 6)) {
    const detail = await call("GET", `/api/sites?id=${encodeURIComponent(site.id)}`);
    if (!detail.body?.site) continue;
    checked += 1;
    if (detail.body.files.length !== detail.body.compliance.length) differed += 1;
  }
  assert.ok(checked > 0, "at least one site must be readable");
  assert.ok(
    differed > 0,
    "the two counts must come from different sources — if they never differ the test proves nothing",
  );
});

/**
 * The fixture, removed for good, by exact primary key.
 *
 * A site is ARCHIVED rather than deleted by the product, so the row would
 * otherwise survive its own cleanup and accumulate one per run. Aliases and
 * group memberships go first, then the activity log, then the row. Nothing here
 * matches on a name or a prefix: a substring sweep has eaten other suites'
 * fixtures before now.
 */
after(async () => {
  if (!createdIds.length) return;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return;
  }
  if (!file) return;
  let db;
  try {
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    try {
      db.exec("PRAGMA busy_timeout = 15000");
    } catch {
      // An older binding without the pragma still gets the retry below.
    }
    for (const id of createdIds) {
      for (const statement of [
        "DELETE FROM site_aliases WHERE site_id = ?",
        "DELETE FROM site_group_members WHERE site_id = ?",
        "DELETE FROM activity_log WHERE entity_type = 'site' AND entity_id = ?",
        "DELETE FROM sites WHERE id = ?",
      ]) {
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            db.prepare(statement).run(id);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            // A table this build does not have is not a cleanup failure; a lock is.
            if (!/lock|busy/i.test(String(error?.message ?? error))) {
              lastError = null;
              break;
            }
            const until = Date.now() + 200 * (attempt + 1);
            while (Date.now() < until) {
              // `after()` is synchronous enough that a timer would not be awaited.
            }
          }
        }
        if (lastError) {
          console.warn(
            `fixture cleanup could not run "${statement}" for ${id}: ${lastError.message}`,
          );
        }
      }
      const left = db.prepare("SELECT count(*) AS n FROM sites WHERE id = ?").get(id);
      if (left?.n) console.warn(`fixture site ${id} survived cleanup and must be removed by hand`);
    }
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
