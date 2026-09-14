/**
 * JOB TYPES — the dimension that says what KIND of work a job is.
 *
 * Reports used to infer Reactive / Planned / Projects from a compliance
 * category, tier 4 and a £1,000 threshold. Those are not business facts, and the
 * owner ruled them out. A job's type is now a real, configurable dimension:
 * `job_type_config` rows per organisation with stable ids, and
 * `maintenance_requests.job_type_id` pointing at one. NULL is "Unclassified",
 * and every job that existed before this is one — nothing was backfilled,
 * because no field on a job ever recorded a type to backfill from.
 *
 * Four layers, the way `tests/compliance-warning-window.test.mjs` reads:
 *
 *   1. the route's own rules (label, colour, order), sliced out and called;
 *   2. the seed, read from the local D1 file: three defaults per organisation
 *      with the ids `jt_<org>_<code>`, and no job carrying a type that is not
 *      one of its own organisation's;
 *   3. the plumbing, by source — who may write, what is never written, and
 *      which door resolves a type against which organisation;
 *   4. against the running estate: create, edit, deactivate, rename and
 *      reorder, with every fixture swept afterwards.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import "./reports-ts-loader.mjs";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const ROUTE = "app/api/job-types/route.ts";

/* ── 1. The route's rules, sliced out and called ──────────────────────────── */

/*
 * The block between `jt:validate:start` and `jt:validate:end` imports nothing,
 * so it transpiles to a data URL and runs on its own — the arrangement
 * `ovt:similarity` in /api/overview/contractor-aliases uses. Slicing rather
 * than importing the route is what keeps this half of the suite free of
 * drizzle, the database and the router.
 */
const rules = await (async () => {
  const source = await read(ROUTE);
  const start = source.indexOf("/* jt:validate:start");
  const end = source.indexOf("/* jt:validate:end */");
  assert.ok(start >= 0 && end > start, "the validation block's markers must survive a refactor");
  return import(asModule(transpile(source.slice(start, end))));
})();

test("a job type's name is trimmed, collapsed, required and capped at 60", () => {
  assert.deepEqual(rules.readJobTypeLabel("  Capital   works "), { ok: true, label: "Capital works" });
  assert.equal(rules.readJobTypeLabel("Reactive").label, "Reactive");
  for (const bad of ["", "   ", "\n\t", 7, null, undefined, {}, []]) {
    assert.equal(rules.readJobTypeLabel(bad).ok, false, `${JSON.stringify(bad)} is not a name`);
  }
  assert.equal(rules.readJobTypeLabel("x".repeat(60)).ok, true, "60 is allowed");
  assert.equal(rules.readJobTypeLabel("x".repeat(61)).ok, false, "61 is refused, never truncated");
  assert.equal(rules.JOB_TYPE_LABEL_LIMIT, 60);
});

test("a colour is #RRGGBB or nothing — anything else is refused, because it is written into style", () => {
  assert.deepEqual(rules.readJobTypeColour("#dc6a0d"), { ok: true, colourHex: "#DC6A0D" });
  for (const clears of [null, undefined, ""]) {
    assert.deepEqual(rules.readJobTypeColour(clears), { ok: true, colourHex: null });
  }
  for (const bad of ["red", "#fff", "#12345g", "rgb(1,2,3)", 16711680, "#DC6A0D; background: url(x)"]) {
    assert.equal(rules.readJobTypeColour(bad).ok, false, `${String(bad)} is not a colour`);
  }
});

test("one ACTIVE type per name, and a retired namesake blocks nothing until it comes back", () => {
  const types = [
    { id: "a", label: "Reactive", active: true },
    { id: "b", label: "Emergency", active: false },
  ];
  assert.equal(rules.jobTypeLabelTaken(types, "reactive", null), true, "case-insensitively");
  assert.equal(rules.jobTypeLabelTaken(types, "  Reactive  ", null), true, "and whitespace-insensitively");
  assert.equal(rules.jobTypeLabelTaken(types, "Reactive", "a"), false, "a type never blocks itself");
  assert.equal(rules.jobTypeLabelTaken(types, "Emergency", null), false, "a retired name is free");
  assert.equal(rules.jobTypeLabelKey("  In   Progress "), "in progress");
});

test("a reorder names ids this organisation holds, once each, and keeps the rest in place", () => {
  const current = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(rules.planJobTypeOrder(current, ["c", "a"]), {
    ok: true,
    order: ["c", "a", "b", "d"],
    // Unnamed types keep their relative order after the ones that were named,
    // so a screen listing only the active types can reorder those safely.
  });
  assert.equal(rules.planJobTypeOrder(current, ["a", "a"]).ok, false, "one type twice is a mistake");
  const foreign = rules.planJobTypeOrder(current, ["a", "jt_another_tenant"]);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 404, "an id this workspace does not hold is the same 404 as an unknown one");
  assert.equal(rules.planJobTypeOrder(current, []).ok, false);
  assert.equal(rules.planJobTypeOrder(current, "a,b").ok, false);
});

/*
 * The browser's two pure helpers, imported directly — `use-job-types.ts` is a
 * hook module, but these two are plain functions and they decide what every
 * picker in the product offers and what it calls a job's type.
 */
const picker = await import("../app/(app)/portal/use-job-types.ts");

test("a picker offers the active types, plus this job's own retired one", () => {
  const types = [
    { id: "a", code: "reactive", label: "Reactive", colourHex: null, sortOrder: 10, active: true },
    { id: "b", code: null, label: "Emergency", colourHex: null, sortOrder: 20, active: false },
  ];
  assert.deepEqual(picker.jobTypeChoices(types, null).map((type) => type.id), ["a"]);
  assert.deepEqual(
    picker.jobTypeChoices(types, "b").map((type) => type.id),
    ["a", "b"],
    "a job filed under a retired type still offers it, so re-saving cannot drop it",
  );
  assert.equal(picker.jobTypeLabel(types, null), "Unclassified", "no type is a state, not a gap");
  assert.equal(picker.jobTypeLabel(types, "b"), "Emergency (deactivated)");
  assert.equal(picker.jobTypeLabel(types, "zz"), "Unknown type", "never silently 'Unclassified'");
  assert.equal(picker.jobTypeLabel(types, "zz", { loaded: false }), "…", "and never that before the list lands");
  assert.equal(picker.JOB_TYPES_CHANGED, "maintsupp:job-types-changed");
});

/* ── 2. The seed, as the local database actually holds it ─────────────────── */

async function openLocalD1() {
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
  return new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
}

test("every active organisation is seeded with the three defaults, at ids that never move", async (t) => {
  const db = await openLocalD1();
  if (!db) {
    t.skip("no local D1 file");
    return;
  }
  try {
    const orgs = db.prepare("SELECT id FROM organisations WHERE status = 'active'").all();
    assert.ok(orgs.length >= 1, "the development estate has at least one active organisation");
    for (const org of orgs) {
      const rows = db
        .prepare("SELECT id, code, label FROM job_type_config WHERE organisation_id = ? AND code IS NOT NULL")
        .all(org.id);
      const byCode = new Map(rows.map((row) => [row.code, row]));
      for (const code of ["reactive", "planned", "project"]) {
        const row = byCode.get(code);
        assert.ok(row, `${org.id} has a ${code} type`);
        assert.equal(
          row.id,
          `jt_${org.id}_${code}`,
          "the id is derived from the organisation and the code, so a seed replay is a no-op and a rename moves nothing",
        );
      }
      assert.equal(byCode.size, 3, "and no fourth coded type: a custom type's code is NULL");
    }

    /* A job's type is its own organisation's, or nothing. The route proves this
       on the way in (`resolveJobTypeWrite`); this is the estate agreeing. */
    const crossed = db
      .prepare(
        `SELECT count(*) AS n
           FROM maintenance_requests r
           LEFT JOIN job_type_config t
             ON t.id = r.job_type_id AND t.organisation_id = r.organisation_id
          WHERE r.job_type_id IS NOT NULL AND t.id IS NULL`,
      )
      .get();
    assert.equal(crossed.n, 0, "no job points at a type from another workspace, or at no type at all");
  } finally {
    db.close();
  }
});

/* ── 3. The plumbing, by source ───────────────────────────────────────────── */

test("reading needs board.view, writing needs settings.edit, and there is no delete", async () => {
  const route = await read(ROUTE);
  const code = codeOnly(route);

  assert.match(code, /export async function GET/);
  assert.match(code, /export async function POST/);
  assert.match(code, /export async function PATCH/);
  assert.doesNotMatch(
    code,
    /export async function DELETE/,
    "a type is deactivated, never deleted — a job filed under it must keep its meaning",
  );
  assert.doesNotMatch(code, /\.delete\(jobTypeConfig\)/, "and nothing here removes a row");

  const get = code.slice(code.indexOf("export async function GET"), code.indexOf("export async function POST"));
  assert.match(get, /scopedDbWithCapability\(request, "board\.view"\)/, "every reader of a job can name its type");
  assert.doesNotMatch(get, /\.insert\(|\.update\(/, "GET writes nothing, not even a seed");

  for (const handler of ["POST", "PATCH"]) {
    const body = code.slice(code.indexOf(`export async function ${handler}`));
    assert.match(
      body.slice(0, 600),
      /scopedDbWithCapability\(request, "settings\.edit"\)/,
      `${handler} is an administrative act`,
    );
  }

  /* Tenant scope on every write, and the actor on every row. */
  const writes = code.match(/\.where\(and\(eq\(jobTypeConfig\.organisationId, scope\.orgId\), eq\(jobTypeConfig\.id, \w+\)\)\)/g) ?? [];
  assert.ok(writes.length >= 2, `every update names the organisation and the id (${writes.length} found)`);
  assert.match(code, /updatedByEmail: writerEmail\(scope\)/);
  assert.match(code, /recordAudit\(\{/);
  for (const action of [
    "job_type.created",
    "job_type.renamed",
    "job_type.deactivated",
    "job_type.reactivated",
    "job_type.reordered",
  ]) {
    assert.ok(route.includes(`"${action}"`), `${action} must be recorded`);
  }
  assert.match(code, /auditActor\(scope\)/);

  /* A code is the stable meaning Reports groups by. It is refused, not ignored. */
  assert.match(code, /if \("code" in body\)/);
  assert.doesNotMatch(code, /patch\.code|set\(\{[^}]*code:/, "no write here may move a type's code");
});

test("a job's type is resolved against the caller's own organisation, on both doors", async () => {
  const route = codeOnly(await read("app/api/maintenance/route.ts"));

  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.match(
    post,
    /resolveJobTypeWrite\(db, orgId, payload\.jobTypeId, null\)/,
    "a create resolves the id it was given; there is no current type to fall back on",
  );
  assert.match(post, /overrides: \{ jobTypeId: jobType\.id \}/);

  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.match(
    patch,
    /resolveJobTypeWrite\(\s*db,\s*orgId,\s*fields\.jobTypeId,\s*before\?\.jobTypeId \?\? null,\s*\)/,
    "an edit passes the job's CURRENT type, which is what lets a deactivated one stay put",
  );
  assert.match(patch, /hasOwnProperty\.call\(fields, "jobTypeId"\)/, "absent is unchanged, null is Unclassified");

  /* The one place the rule lives. */
  const helper = codeOnly(await read("app/lib/job-types.ts"));
  assert.match(helper, /if \(row\.deactivatedAt && row\.id !== current\)/);
  assert.match(helper, /eq\(jobTypeConfig\.organisationId, organisationId\), eq\(jobTypeConfig\.id, value\)/);
});

test("an unattended rule cannot file a job under another tenant's type", async () => {
  /* `siteId`'s arrangement, for `siteId`'s reason: the automation engine calls
     `requestFieldValues` with no reference validation of its own, so the id is
     shape-checked in this module and RESOLVED in the route. */
  const fields = codeOnly(await read("app/lib/request-fields.ts"));
  assert.match(fields, /has\("jobTypeId"\)/, "the shape is checked");
  assert.match(fields, /note\("jobTypeId", "a job type id, or null for Unclassified"\)/);
  const coercion = fields.slice(
    fields.indexOf("export function requestFieldValues"),
    fields.indexOf("export function invalidRequestFields"),
  );
  assert.doesNotMatch(coercion, /jobTypeId/, "requestFieldValues must not coerce it");
  const table = fields.slice(fields.indexOf("export const SYSTEM_FIELD_BY_KEY"));
  assert.doesNotMatch(
    table.slice(0, table.indexOf("} as const")),
    /jobTypeId|jobType:/,
    "and it is not a board column a rule can address",
  );
});

test("a duplicate keeps the original's type, and a new client arrives with the three defaults", async () => {
  const mutations = codeOnly(await read("app/lib/board-mutations.ts"));
  assert.match(mutations, /jobTypeId: source\.jobTypeId,/, "a copy of a job is the same kind of work");

  const context = codeOnly(await read("app/api/context/route.ts"));
  assert.match(context, /await seedJobTypes\(d1, created\.id\);/);
  assert.match(context, /seedBoardStructure, seedJobTypes/, "seeded from db/init, beside the board's own seeds");
});

test("the import matches a Job type column to a type, and never invents one", async () => {
  const parser = codeOnly(await read("app/lib/monday-import.ts"));
  assert.match(parser, /JOB_TYPE_KEY = "__jobType"/, "outside the board's key space, like the item id");
  assert.match(parser, /"job type": JOB_TYPE_KEY/);

  const route = codeOnly(await read("app/api/import/route.ts"));
  assert.match(route, /function jobTypeMatcher/);
  assert.match(route, /legacyJobTypeCode\(wanted\)/, "a file written before a rename still lands on the same type");
  assert.doesNotMatch(route, /insert\(jobTypeConfig\)/, "an import may not create a type");
  assert.match(route, /jobTypes: matchJobType \? summariseJobTypes\(plan, matchJobType\) : null/, "and it reports what it could not match");
  assert.match(
    route,
    /const jobTypeText = \(item\.values\[JOB_TYPE_KEY\] \?\? ""\)\.trim\(\);/,
    "a blank cell says nothing, so a re-import leaves a type somebody set in the portal alone",
  );
  assert.match(route, /found && \(found\.active \|\| found\.id === current\)/, "a retired type is kept, never newly given");
});

test("the board's CSV names the type, and says Unclassified rather than nothing", async () => {
  const csv = codeOnly(await read("app/lib/board-csv.ts"));
  assert.match(csv, /case "jobType":/);
  assert.match(csv, /input\.jobTypeLabels\?\.\[request\.jobTypeId\] \?\? ""/, "the name, never the id");
  assert.match(csv, /: UNCLASSIFIED_LABEL;/);

  const route = codeOnly(await read("app/api/board/csv/route.ts"));
  assert.match(
    route,
    /board\.key === DEFAULT_BOARD_KEY && !columns\.some\(\(entry\) => entry\.key === "jobType"\)/,
    "the Jobs board only, and never twice",
  );
});

test("the Settings card is an administrator's, and tells the page when it has written", async () => {
  const card = await read("app/(app)/portal/admin/job-types-settings.tsx");
  assert.match(card, /useCapability\("settings\.edit"\)/);
  assert.match(card, /if \(canEdit !== true\) return null;/, "hidden, not merely disabled, and hidden while unknown");
  assert.match(card, /announceJobTypesChanged\(\);/);
  assert.match(card, /announceDataChanged\(\);/, "so the Overview and Reports re-read the labels they drew");
  assert.doesNotMatch(codeOnly(card), /method: "DELETE"/, "there is no delete to offer");

  const hook = await read("app/(app)/portal/use-job-types.ts");
  assert.match(hook, /JOB_TYPES_CHANGED = "maintsupp:job-types-changed"/);
  assert.match(hook, /window\.addEventListener\(JOB_TYPES_CHANGED, onChanged\)/);
  assert.match(hook, /fetch\("\/api\/job-types"/);
  /* What a picker offers: active types, plus this job's own retired one. */
  assert.match(hook, /type\.active \|\| \(currentId \? type\.id === currentId : false\)/);

  const shell = await read("app/(app)/portal/portal-app.tsx");
  assert.match(shell, /<JobTypesSettings \/>/, "mounted on the Settings screen");
  assert.match(shell, /jobTypeId: "",/, "a new request starts Unclassified — never guessed");
  assert.match(shell, /<option value="">Unclassified<\/option>/);
  assert.match(shell, /case "jobType":\s*\n\s*return renderJobType\(column\.id, column\.title\);/);
});

/* ── 4. Against the running estate ────────────────────────────────────────── */

const BASE = "http://localhost:5173";
/** Every fixture this file makes carries it, so a sweep can find them all. */
const MARKER = "JTQA-";
/** The one custom type the live test reuses, so runs cannot litter the estate. */
const FIXTURE_TYPE = "JTQA fixture type";

async function serverIsUp() {
  try {
    /* 8s, not the 4s most live files use: measured on this estate the dev
       server answers `/api/context` in 2–6 seconds while the suite is running
       beside it, and a health check that times out first turns a slow server
       into a silently skipped test. */
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
      password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
    }),
  });
  if (!login.ok) return null;
  return (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
}

/** Bin and purge every job this suite has ever left behind. Never anything else. */
async function sweepFixtures(headers) {
  const feed = await (await fetch(`${BASE}/api/maintenance?limit=1000`, { headers })).json();
  const mine = (feed.requests ?? []).filter(
    (row) => `${row.title ?? ""} ${row.description ?? ""}`.includes(MARKER),
  );
  if (!mine.length) return 0;
  await fetch(`${BASE}/api/board?board=maintenance`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "delete_items", requestIds: mine.map((row) => row.id) }),
  });
  const trash = await (await fetch(`${BASE}/api/trash?limit=500`, { headers })).json();
  for (const entry of trash.bin?.entries ?? []) {
    if (!mine.some((row) => row.id === entry.entityId)) continue;
    await fetch(`${BASE}/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE", headers });
  }
  return mine.length;
}

test("LIVE a member may read the types; only settings.edit may change them", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const asClient = { "x-maintsupp-identity": "client@sunnamusk-uk.test.maintsupp.com", accept: "application/json" };
  const read = await fetch(`${BASE}/api/job-types`, { headers: asClient });
  assert.equal(read.status, 200, "a client can see what a job is filed under");
  const payload = await read.json();
  assert.ok(Array.isArray(payload.jobTypes) && payload.jobTypes.length >= 3);
  for (const type of payload.jobTypes) {
    assert.deepEqual(
      Object.keys(type).sort(),
      ["active", "code", "colourHex", "id", "label", "sortOrder"],
      "the wire shape is JobType and nothing else — no organisation id, no timestamps",
    );
  }

  for (const [method, body] of [
    ["POST", { label: `${MARKER} forbidden` }],
    ["PATCH", { id: payload.jobTypes[0].id, label: "Renamed by a client" }],
  ]) {
    const refused = await fetch(`${BASE}/api/job-types`, {
      method,
      headers: { ...asClient, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(refused.status, 403, `${method} is refused for a client`);
  }
  const deleted = await fetch(`${BASE}/api/job-types`, { method: "DELETE", headers: asClient });
  assert.equal(deleted.status, 405, "there is no DELETE handler at all");
});

test("LIVE a type is renamed without moving, deactivated without losing its jobs, and reordered", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const headers = { cookie, accept: "application/json" };
  const json = { ...headers, "content-type": "application/json" };
  const run = `${MARKER}${Date.now().toString(36)}`;

  const listTypes = async () => (await (await fetch(`${BASE}/api/job-types`, { headers })).json()).jobTypes;
  const patchType = async (body) => {
    const response = await fetch(`${BASE}/api/job-types`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const patchJob = async (id, fields) => {
    const response = await fetch(`${BASE}/api/maintenance`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ id, fields }),
    });
    return { status: response.status, body: await response.json() };
  };

  const before = await listTypes();
  const planned = before.find((type) => type.code === "planned");
  assert.ok(planned, "the development workspace carries the seeded defaults");

  /* A site to raise a fixture job against — the create door refuses a name the
     register does not hold, which is the behaviour, not a problem here. */
  const sites = await (await fetch(`${BASE}/api/sites?limit=5`, { headers })).json();
  const siteName = (sites.sites ?? []).map((site) => site.name).find(Boolean);
  if (!siteName) {
    t.skip("no site to raise a fixture job against");
    return;
  }

  const raise = async (jobTypeId, note) => {
    const response = await fetch(`${BASE}/api/maintenance`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        location: siteName,
        requester: `${run} tester`,
        contact: "07000 000000",
        description: `${run} ${note} — a job types test fixture, swept by the test that made it.`,
        category: "Other",
        priority: "Low",
        engineer: "Handyman",
        ...(jobTypeId === undefined ? {} : { jobTypeId }),
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    /* ── create, with a type and without one ─────────────────────────────── */
    const typed = await raise(planned.id, "typed");
    assert.equal(typed.status, 201, JSON.stringify(typed.body));
    assert.equal(typed.body.request.jobTypeId, planned.id, "a create stores the type it was given");

    const unclassified = await raise(undefined, "unclassified");
    assert.equal(unclassified.status, 201);
    assert.equal(
      unclassified.body.request.jobTypeId ?? null,
      null,
      "a door that never asks — the public and intake forms — files Unclassified",
    );

    /* ── another workspace's id is not a capability ──────────────────────── */
    const foreign = await patchJob(typed.body.request.id, {
      jobTypeId: "jt_org_000000000000000000000002_reactive",
    });
    assert.equal(foreign.status, 404, "another tenant's type id is refused");
    assert.match(foreign.body.error, /does not exist in this workspace/);
    const stillTyped = await (
      await fetch(`${BASE}/api/maintenance?id=${typed.body.request.id}`, { headers })
    ).json();
    assert.equal(stillTyped.request.jobTypeId, planned.id, "and nothing was written");

    /* ── a rename keeps the id, the code and every job ───────────────────── */
    const renamed = await patchType({ id: planned.id, label: `${planned.label} ${run}` });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.jobType.id, planned.id, "a rename moves the words, never the row");
    assert.equal(renamed.body.jobType.code, "planned", "and never the code Reports groups by");
    const afterRename = await (
      await fetch(`${BASE}/api/maintenance?id=${typed.body.request.id}`, { headers })
    ).json();
    assert.equal(afterRename.request.jobTypeId, planned.id, "the job still points at the same type");
    const back = await patchType({ id: planned.id, label: planned.label });
    assert.equal(back.body.jobType.label, planned.label, "put back");

    /* ── a custom type, then retired ─────────────────────────────────────── */
    const existing = (await listTypes()).find(
      (type) => type.label.toLowerCase() === FIXTURE_TYPE.toLowerCase(),
    );
    let custom = existing;
    if (custom) {
      /* Reused rather than created afresh: a type can never be deleted, so a
         run that made a new one every time would litter the estate for ever. */
      if (!custom.active) {
        const on = await patchType({ id: custom.id, active: true });
        assert.equal(on.status, 200, JSON.stringify(on.body));
        custom = on.body.jobType;
      }
    } else {
      const created = await fetch(`${BASE}/api/job-types`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ label: FIXTURE_TYPE }),
      });
      const body = await created.json();
      assert.equal(created.status, 201, JSON.stringify(body));
      custom = body.jobType;
      assert.equal(custom.code, null, "a custom type has no code; only the three defaults do");
    }

    const duplicate = await fetch(`${BASE}/api/job-types`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ label: `  ${FIXTURE_TYPE.toUpperCase()} ` }),
    });
    assert.equal(duplicate.status, 409, "one active type per name, case- and space-insensitively");

    const filed = await patchJob(typed.body.request.id, { jobTypeId: custom.id });
    assert.equal(filed.status, 200);
    assert.equal(filed.body.request.jobTypeId, custom.id);

    const off = await patchType({ id: custom.id, active: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.jobType.active, false);
    assert.ok(
      (await listTypes()).some((type) => type.id === custom.id),
      "a deactivated type is still listed — a job filed under it has to be nameable",
    );

    const keptIt = await (
      await fetch(`${BASE}/api/maintenance?id=${typed.body.request.id}`, { headers })
    ).json();
    assert.equal(keptIt.request.jobTypeId, custom.id, "the job keeps the type it was filed under");

    const resaved = await patchJob(typed.body.request.id, { jobTypeId: custom.id, priority: "Medium" });
    assert.equal(resaved.status, 200, "re-saving a job whose type has been retired still works");
    assert.equal(resaved.body.request.jobTypeId, custom.id);

    const newlyRetired = await patchJob(unclassified.body.request.id, { jobTypeId: custom.id });
    assert.equal(newlyRetired.status, 400, "but nothing new may be filed under it");
    assert.match(newlyRetired.body.error, /no longer offered/);

    /* ── clearing, and the round trip ────────────────────────────────────── */
    const cleared = await patchJob(typed.body.request.id, { jobTypeId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.request.jobTypeId ?? null, null, "null is Unclassified");

    /* ── the order is the administrator's, and it comes back ─────────────── */
    const order = (await listTypes()).map((type) => type.id);
    const swapped = [order[1], order[0], ...order.slice(2)];
    const moved = await patchType({ order: swapped });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(
      moved.body.jobTypes.map((type) => type.id),
      swapped,
      "the list comes back in the order it was given",
    );
    const restored = await patchType({ order });
    assert.deepEqual(restored.body.jobTypes.map((type) => type.id), order, "and is put back");

    /* ── what a write may never do ───────────────────────────────────────── */
    const code = await patchType({ id: planned.id, code: "reactive" });
    assert.equal(code.status, 400, "a code never changes");
    const unknown = await patchType({ id: "jt_nothing_like_this", label: "x" });
    assert.equal(unknown.status, 404);
  } finally {
    /* Every job this run raised, binned and purged — by the run marker, never
       by remembered ids, so an interrupted earlier run is cleared too. The
       custom TYPE is left deactivated: there is no delete, by design, and the
       next run reuses it by name. */
    const customNow = (await (await fetch(`${BASE}/api/job-types`, { headers })).json()).jobTypes.find(
      (type) => type.label.toLowerCase() === FIXTURE_TYPE.toLowerCase(),
    );
    if (customNow?.active) {
      await fetch(`${BASE}/api/job-types`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ id: customNow.id, active: false }),
      });
    }
    await sweepFixtures(headers);
  }
});
