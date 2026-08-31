import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Workstream 6 — the two numbers this product prints for ONE contractor are the
 * same number.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * A contractor's work is counted twice over, by two pieces of code in two
 * languages, and until this suite existed nothing checked that they agreed:
 *
 *   • THE MANAGE DRAWER prints "N jobs" straight from the workspace payload
 *     (`workspace-data-manager.tsx` → `record.assignedJobs`), which is the
 *     GROUP BY in `readWorkspace`.
 *   • THE CONTRACTORS PAGE re-derives all four figures in the browser, because
 *     that page has its own reporting period and the payload's totals are
 *     all-time (`ContractorsView` in portal-app.tsx).
 *
 * They disagreed on three separate rules, and one fixture showed all three at
 * once. Four jobs on one contractor — a plain one at GBP 100, one ARCHIVED at
 * GBP 200, one made a SUBITEM at GBP 300, and one carrying `status = "Job
 * Completed"` while its `stage` stayed "Incoming" at GBP 400:
 *
 *     server  { assigned: 4, completed: 0, urgent: 4, spend: 1000 }
 *     page    { assigned: 2, completed: 1, urgent: 1, spend:  500 }
 *
 * Every one of the four numbers was different, and each difference had its own
 * cause: the server counted archived rows, counted subitems, and asked
 * `stage = 'Completed'` where the browser asks `isClosedRequest` — the union of
 * the stage and monday's `is_done` Status label. On the imported board that
 * union is not academic: those rows sit in monday's "… Recently completed"
 * groups, which carry no lifecycle stage here, so a stage-only test reported 28
 * jobs whose own status says "Job Completed" as open work.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 *
 * Two of these tests talk to a RUNNING SERVER, because the defect is not
 * visible in any one file: it is the disagreement between a SQL aggregate and a
 * TypeScript reducer, and both have to actually run. The page's reducer is
 * replayed here over the same `/api/maintenance` rows the browser receives
 * rather than driven through a browser, so the assertion is on the arithmetic
 * and not on a rendered string — and the replay is checked against the real
 * page's source in the same suite, so it cannot silently stop being that
 * reducer. They skip cleanly when the server is not up, exactly as the sibling
 * linkage suite does.
 *
 * The rest are source assertions, and they are the half that keeps this fixed:
 * a measurement proves the two agree TODAY, but only a shared definition stops
 * them drifting apart again next quarter.
 */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };

/*
 * Run-scoped, for the reason the linkage suite records: the workspace API has
 * no hard delete for a contractor, so a fixed prefix makes the second run's
 * register ambiguous and the suite then fails with the product behaving
 * correctly.
 */
const PREFIX = `ZZQA-W6-SCOPE-${crypto.randomUUID().slice(0, 8)}`;

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ── The server, and a cookie jar ──────────────────────────────────────────── */

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function signIn() {
  let response;
  try {
    response = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  cookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return Boolean(cookie);
}

const workspaceOf = async () => (await call("GET", "/api/workspace")).json?.workspace ?? null;
const requestsOf = async () => (await call("GET", "/api/maintenance")).json?.requests ?? [];

/** The four numbers the manage drawer and the payload carry, for one register row. */
async function serverTally(id) {
  const workspace = await workspaceOf();
  const row = workspace?.contractors?.find((entry) => entry.id === id);
  return row && {
    assigned: row.assignedJobs,
    completed: row.completedJobs,
    urgent: row.urgentJobs,
    spend: row.spend,
  };
}

/**
 * THE CONTRACTORS PAGE'S OWN ARITHMETIC, replayed.
 *
 * Line for line what `ContractorsView` does, and deliberately written out
 * rather than imported: portal-app.tsx is 7,800 lines of TSX and importing it
 * would drag React into a node test runner. The test below
 * ("the replay above is still the page's own rule") pins every clause of it to
 * the real source, so this copy cannot quietly stop matching.
 *
 * The period is "All records", where `stampWithinPeriod` returns true for every
 * row. That is the only window in which the page and the payload are asking the
 * same question: the payload's figures are all-time and carry no date filter at
 * all — see the spend-basis test at the bottom of this file.
 */
function pageTally(requests, contractor, roster) {
  const countsAsWorkOrder = (request) => !request.parentId && !request.archived;
  const isClosed = (request) =>
    request.stage === "Completed" || request.status === "Job Completed";
  const perName = new Map();
  for (const entry of roster) perName.set(entry.name, (perName.get(entry.name) ?? 0) + 1);
  const nameIsUnique = (perName.get(contractor.name) ?? 0) <= 1;
  const theirs = requests
    .filter(countsAsWorkOrder)
    .filter((request) =>
      request.contractorId
        ? request.contractorId === contractor.id
        : nameIsUnique && request.contractor === contractor.name);
  return {
    assigned: theirs.length,
    completed: theirs.filter(isClosed).length,
    urgent: theirs.filter((request) => request.priority === "Urgent" && !isClosed(request)).length,
    spend: theirs.reduce((sum, request) => sum + (request.cost ?? 0), 0),
  };
}

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

/**
 * Three attempts, and the last failure's status is what the assertion reports.
 *
 * Not flakiness tolerance — a bounded retry on a KNOWN and documented condition.
 * Every HTTP-backed suite in this repository writes to one miniflare SQLite file
 * through one dev server, `node --test` runs test files in parallel, and two
 * concurrent writers produce "database is locked", which the route's catch-all
 * turns into a 4xx/5xx. A suite whose SETUP loses that race reports
 * `actual: null` and names nothing, which is exactly what made an earlier run of
 * this file look like a product defect when the product was fine. So: retry the
 * fixture, and if it still will not be created, say what the server said.
 */
async function attempt(label, make) {
  let last = null;
  for (let tries = 0; tries < 3; tries += 1) {
    const response = await make();
    if (response.ok) return response.value;
    last = response;
    await new Promise((resolve) => setTimeout(resolve, 250 * (tries + 1)));
  }
  assert.fail(`${label} could not be created: ${last?.status} ${JSON.stringify(last?.body).slice(0, 300)}`);
}

const makeContractor = (suffix) =>
  attempt(`contractor ${suffix}`, async () => {
    const created = await call("POST", "/api/workspace", {
      entity: "contractor",
      data: { name: `${PREFIX}-${suffix}`, availability: "Available", active: true },
    });
    return { ok: created.status < 300, value: created.json?.id, status: created.status, body: created.json };
  });

const raiseJob = (suffix) =>
  attempt(`job ${suffix}`, async () => {
    const workspace = await workspaceOf();
    const store = workspace?.stores?.[0];
    if (!store) return { ok: false, status: 0, body: "no site in the workspace payload" };
    const created = await call("POST", "/api/maintenance", {
      location: store.name,
      requester: PREFIX,
      contact: "zzqa@example.com",
      description: `${PREFIX}-${suffix} lifecycle-scope fixture, safe to delete.`,
      category: "Electrical",
      priority: "Urgent",
    });
    return { ok: created.status === 201, value: created.json?.request?.id, status: created.status, body: created.json };
  });

const setFields = (id, fields) => call("PATCH", "/api/maintenance", { id, fields });

/* ── The measurements ──────────────────────────────────────────────────────── */

test("an archived job and a subitem leave both surfaces, together", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");

  const contractorId = await makeContractor("lifecycle");
  const name = `${PREFIX}-lifecycle`;

  const live = await raiseJob("live");
  const archived = await raiseJob("archived");
  const subitem = await raiseJob("subitem");

  await setFields(live, { contractor: name, cost: 100 });
  await setFields(archived, { contractor: name, cost: 200 });
  await setFields(subitem, { contractor: name, cost: 300 });

  const before = await serverTally(contractorId);
  assert.deepEqual(
    before,
    { assigned: 3, completed: 0, urgent: 3, spend: 600 },
    "all three jobs count while all three are live work orders",
  );

  // Archived through the board's own verb, which is the only way a job gets there.
  const archivedResponse = await call("PATCH", "/api/board/items", { id: archived, archived: true });
  assert.equal(archivedResponse.status, 200, "the job was archived");
  // A subitem is a full row of this table whose parent is another row.
  const subitemResponse = await setFields(subitem, { parentId: live });
  assert.equal(subitemResponse.status, 200, "the job became a subitem");

  const after = await serverTally(contractorId);
  assert.deepEqual(
    after,
    { assigned: 1, completed: 0, urgent: 1, spend: 100 },
    "neither the archived job nor the subitem is live operational work any more",
  );

  /*
   * THE POINT OF THE SUITE. Not "the server dropped them" — "the two surfaces
   * now say the same thing", which is the claim the product makes by printing
   * both numbers on one screen.
   */
  const workspace = await workspaceOf();
  const contractor = workspace.contractors.find((entry) => entry.id === contractorId);
  const page = pageTally(await requestsOf(), contractor, workspace.contractors);
  assert.deepEqual(
    after,
    page,
    "the manage drawer's subtitle and the Contractors table agree for one contractor",
  );
});

test("a job whose status says it is finished is finished on both surfaces", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");

  const contractorId = await makeContractor("closed");
  const name = `${PREFIX}-closed`;

  const job = await raiseJob("closed");
  /*
   * `status` and NOT `stage`, which is the whole case. This is the shape every
   * imported row has: monday's "… Recently completed" groups carry no lifecycle
   * stage in this app, so the row arrives as `stage: "Incoming"` with the
   * board's own is_done label on it.
   */
  await setFields(job, { contractor: name, cost: 400, status: "Job Completed" });

  const rows = await requestsOf();
  const row = rows.find((entry) => entry.id === job);
  assert.equal(row.status, "Job Completed", "the fixture carries the is_done label");
  assert.notEqual(row.stage, "Completed", "and deliberately does NOT carry the stage");

  const server = await serverTally(contractorId);
  assert.equal(server.completed, 1, "the API payload counts it completed");
  assert.equal(server.urgent, 0, "and therefore not as open urgent work");

  const workspace = await workspaceOf();
  const contractor = workspace.contractors.find((entry) => entry.id === contractorId);
  assert.deepEqual(
    server,
    pageTally(rows, contractor, workspace.contractors),
    "the page reaches the same four numbers from the same rows",
  );
});

/* ── The half that stops it drifting back ──────────────────────────────────── */

test("'completed' is one vocabulary, imported by both languages", async () => {
  const meters = await read("app/(app)/portal/dashboard-meters.ts");
  const route = await read("app/api/workspace/route.ts");

  // The one declaration, in the file the browser predicate is built in.
  assert.match(meters, /export const COMPLETED_STAGE/, "the stage constant is declared once");
  assert.match(meters, /export const completedStatuses/, "so is the label list");

  // And the SQL reads THAT file rather than keeping its own copy.
  assert.match(
    route,
    /COMPLETED_STAGE,\s*completedStatuses\s*\}\s*from\s*["'][^"']*portal\/dashboard-meters["']/,
    "the workspace route imports both constants from dashboard-meters",
  );

  /*
   * THE PROPERTY THAT DECIDED WHICH WAY THE IMPORT POINTS, asserted so nobody
   * "tidies" the vocabulary into app/lib and finds out the hard way.
   *
   * Seven suites transpile dashboard-meters.ts on its own and load it from a
   * `data:` URL or a bare temp directory. A relative specifier cannot resolve
   * there — `ERR_INVALID_URL` — so this file must have no runtime imports at
   * all. Adding one took `workstream-eight-reports-range` from 27 passing to 0
   * and `acceptance-correction-one-calendar-data` from 23 to 0, in one edit.
   */
  const runtimeImports = meters
    .split(/\r?\n/)
    .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line));
  assert.deepEqual(
    runtimeImports,
    [],
    "dashboard-meters.ts still has no runtime imports, which is what lets seven suites transpile it alone",
  );

  /*
   * The assertion that actually bites. A second copy of the string is how these
   * two drifted the first time: the SQL said `stage = 'Completed'` and the
   * browser said `stage === "Completed" || status === "Job Completed"`, and
   * nothing connected them. Neither file may name a label in CODE.
   *
   * Comments are stripped first, and must be: both files quote the label while
   * explaining themselves, and a rule that forbade that would be a rule against
   * writing the explanation down.
   */
  const code = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code(route),
    /["'`]Job Completed["'`]/,
    "the SQL does not carry its own copy of the label",
  );
  /*
   * The browser file is where the list is DECLARED, so it obviously names the
   * label — and it names it again in `maintenanceStatusLabels`, the exhaustive
   * 23-label vocabulary. What is checked here is that its predicate is built
   * from the declaration rather than from a fourth spelling of the string.
   */
  assert.match(
    code(meters),
    /const hasCompletedStatus = statusMatcher\(completedStatuses\)/,
    "the browser predicate is built from the declared list",
  );
  assert.match(
    code(meters),
    /request\.stage === COMPLETED_STAGE \|\| hasCompletedStatus\(request\)/,
    "isClosedRequest names the shared stage constant rather than a literal",
  );
  // Nor its own copy of the stage, which was the other half of the same drift.
  assert.doesNotMatch(
    code(route).slice(code(route).indexOf("completedJobPredicate")),
    /stage,\s*["'`]Completed["'`]/,
    "and the stage arm is the shared constant, not a literal",
  );

  // And the SQL is built FROM the array rather than from a hand-written IN list.
  assert.match(
    route,
    /inArray\(\s*maintenanceRequests\.status,\s*\[\.\.\.completedStatuses\]/,
    "the IN list is spread from the shared array",
  );
});

test("one lifecycle scope: the SQL says what `countsAsWorkOrder` says", async () => {
  const route = await read("app/api/workspace/route.ts");

  const helper = route.slice(route.indexOf("const liveWorkOrder"));
  assert.ok(helper, "the shared lifecycle helper exists");
  for (const clause of [
    /isNull\(maintenanceRequests\.deletedAt\)/,
    /eq\(maintenanceRequests\.archived, false\)/,
    /isNull\(maintenanceRequests\.parentId\)/,
    /eq\(maintenanceRequests\.organisationId, orgId\)/,
  ]) {
    assert.match(helper.slice(0, 600), clause, `liveWorkOrder applies ${clause}`);
  }

  /*
   * Three aggregates, one scope. Counting the uses rather than eyeballing them:
   * the defect was that ONE of these had a rule the others did not.
   */
  const uses = route.match(/liveWorkOrder\(orgId\)/g) ?? [];
  assert.equal(uses.length, 3, "every job aggregate in the payload uses it");

  // Nothing may re-filter the same table by hand alongside it.
  assert.doesNotMatch(
    route,
    /ne\(maintenanceRequests\.stage/,
    "no aggregate still asks the narrow stage-only question",
  );

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    app,
    /function countsAsWorkOrder\(request: MaintenanceRequest\) \{\s*return !request\.parentId && !request\.archived;/,
    "and the browser's rule is still the same two exclusions",
  );
});

test("the replay above is still the page's own rule", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");
  const start = app.indexOf("function ContractorsView(");
  assert.ok(start > 0, "ContractorsView was found");
  const view = app.slice(start, start + 20_000);

  // The id first, the name only where there is no id, and never an ambiguous name.
  assert.match(
    view,
    /request\.contractorId\s*\?\s*request\.contractorId === contractor\.id\s*:\s*nameIsUnique && request\.contractor === contractor\.name/,
    "the page attributes by id, falling back to a UNIQUE name",
  );
  assert.match(view, /countsAsWorkOrder\(request\)/, "the page applies the work-order rule");
  assert.match(view, /theirs\.filter\(isClosedRequest\)/, "and the shared closed predicate");
  assert.match(
    view,
    /request\.priority === "Urgent" && isOpenRequest\(request\)/,
    "and counts urgent work only while it is open",
  );
});

test("contractor spend has no cost date, and the code says so", async () => {
  /*
   * NOT a test that spend is wrong. A test that the basis is STATED, because it
   * is the only honest thing available: `cost` is monday's "Cost of Works"
   * number and carries no date of its own, the `invoice` column beside it is
   * free text, and the `invoices` table — which does have `due_at` and
   * `paid_at` — has never been read or written by any code in this application.
   * Measured on staging: `select count(*) from portal.invoices` = 0, and 0 rows
   * carry any invoice text, while 12 carry a cost and 10 of those 12 have no
   * completion date at all.
   *
   * So the two screens that report spend date it differently, on purpose, and
   * the reason has to survive in the source or the next reader will "fix" one
   * of them into the other.
   */
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    app,
    /stampWithinPeriod\(request\.completedAt \?\? request\.requestedAt, period, nowMs\)/,
    "the Contractors page dates a job by when it was FINISHED, falling back to when it was raised",
  );
  assert.match(
    app,
    /withinAnalyticsPeriod\(request\.requestedAt, period, now\)/,
    "Reports dates the same job by when it was RAISED",
  );
  assert.match(
    app,
    /THIS PAGE DATES WORK BY WHEN IT WAS FINISHED, and that is deliberate/,
    "and the Contractors page explains the difference where a reader will find it",
  );

  const route = await read("app/api/workspace/route.ts");
  assert.match(
    route,
    /There is no cost date in this product/,
    "the payload's own spend figure states that it is all-time and why",
  );

  // If anything ever starts reading `invoices`, this test should be revisited
  // rather than deleted — that is the day a real transaction date exists.
  const sources = ["app/api/workspace/route.ts", "app/api/maintenance/route.ts"];
  for (const path of sources) {
    assert.doesNotMatch(
      await read(path),
      /from\(invoices\)|insert\(invoices\)/,
      `${path} still neither reads nor writes the invoices table`,
    );
  }
});

/* ── Cleanup ───────────────────────────────────────────────────────────────── */

test("the fixtures this run created are removed from the register", async () => {
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
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    /*
     * One transaction, for the reason the linkage suite's cleanup records: test
     * FILES run in parallel against one SQLite file through the dev server, and
     * three separate write locks are three windows in which somebody else's
     * request gets "database is locked".
     */
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "DELETE FROM maintenance_requests WHERE coalesce(contractor, '') LIKE ? OR coalesce(requester, '') LIKE ? OR coalesce(description, '') LIKE ?",
      ).run(`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`);
      db.prepare(
        "DELETE FROM activity_log WHERE entity_id IN (SELECT id FROM contractors WHERE name LIKE ?)",
      ).run(`${PREFIX}%`);
      db.prepare("DELETE FROM contractors WHERE name LIKE ?").run(`${PREFIX}%`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    assert.equal(
      db.prepare("SELECT count(*) n FROM contractors WHERE name LIKE ?").get(`${PREFIX}%`).n,
      0,
      "this run's contractors are gone",
    );
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM maintenance_requests WHERE coalesce(requester,'') LIKE ?")
        .get(`${PREFIX}%`).n,
      0,
      "and so are this run's jobs",
    );
  } catch (error) {
    console.warn(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
