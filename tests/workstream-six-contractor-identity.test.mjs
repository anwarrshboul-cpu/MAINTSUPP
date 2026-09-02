import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * Workstream 6 closure — WHO a contractor is, and WHO may be assigned work.
 *
 * ── 1. A NAME IS THE JOIN KEY, NOT A LABEL ────────────────────────────────
 *
 * There is no picker for a job's contractor. `portal-app.tsx` edits that column
 * as free TEXT, `PATCH /api/maintenance { fields: { contractor: "<name>" } }`
 * is the entire assignment verb, and `contractor_id` is then DERIVED from that
 * text by `resolveContractorLink`, which links only where EXACTLY ONE
 * contractor in the organisation carries the name. Both tallies apply the same
 * rule from the other side: an ambiguous name attributes to NEITHER.
 *
 * So the product had already decided that a name identifies at most one
 * contractor. It just never said so on the way in, and the cost was measured:
 * two contractors created with one name (two 200s, no complaint), one job
 * assigned to that name at GBP 999, `contractor_id` NULL, and BOTH rows reading
 * `assigned 0, completed 0, urgent 0, spend 0`. A thousand pounds of assigned
 * work attributed to nobody, silently.
 *
 * `contractorNameConflict` refuses that second row. It is deliberately narrow:
 * the comparison is the resolver's exactly (organisation-scoped, `lower(trim())`
 * in SQL, `active` not consulted), and it fires only on the TRANSITION into
 * ambiguity, so a whole-record save carrying the row's own unchanged name is
 * not a rename and two rows that ALREADY share a name stay editable rather than
 * stranded.
 *
 * WHAT IS DELIBERATELY NOT CONSTRAINED: the email. Nothing in the product
 * resolves a contractor by it — no link, no tally, no dedup — it is null on
 * most rows, the monday board this register was built from carries no
 * contractor email at all, and one office address across several trades
 * ("info@") is an ordinary arrangement. A rule there would be an invented
 * restriction with no product behind it. Two contractors may share an email.
 *
 * ── 2. WHO IS OFFERED WHEN ASSIGNING WORK ─────────────────────────────────
 *
 * The membership rule is `active` alone, and the product states it in a
 * user-facing string — the Active checkbox's own hint: "On the register, and
 * offered when assigning work … Availability above is a separate, day-to-day
 * state". `availability` is written, validated and displayed, and filtered on
 * NOWHERE. The one selector belongs to PLANNED maintenance, whose `nextDueAt`
 * is routinely months away, so somebody who is Unavailable this week is a
 * legitimate choice for March.
 *
 * The bug that rule did have: archiving a contractor correctly takes them off
 * the list, while a planned task already assigned to them keeps pointing at
 * them — as it must, since the API validates the reference on id and
 * organisation and deliberately not `active`, and refusing it would make that
 * task unsavable for ever. The select was rendering a value its options did not
 * contain, `selectedIndex` went to -1, and the Contractor field showed BLANK on
 * a task that was assigned.
 *
 * Behavioural tests need a dev server and skip without one. Source assertions
 * run everywhere — the same bargain the sibling W6 suites make.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 5176, 5177, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/*
 * Run-scoped, for the reason the linkage suite's prefix is: the workspace API
 * has no hard delete for a contractor, so a fixed name would collide with its
 * own leftovers on the second run — and with THIS guard in place the collision
 * would be a 409, which is the product behaving correctly failing a test.
 */
const RUN = `ZZQA-W6-IDENTITY-${Date.now().toString(36)}`;

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

async function ready(t) {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return false;
  }
  if (!(await signIn())) {
    t.skip("could not sign in");
    return false;
  }
  return true;
}

async function call(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
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

const create = (data) => call("POST", "/api/workspace", { entity: "contractor", data });
const patch = (id, data) => call("PATCH", "/api/workspace", { entity: "contractor", id, data });
const archive = (id) => call("DELETE", "/api/workspace", { entity: "contractor", id });
const workspace = async () => (await call("GET", "/api/workspace")).body?.workspace ?? {};

// ---------------------------------------------------------------------------
// Behaviour — the name
// ---------------------------------------------------------------------------

test("a name the register already knows cannot be given to a second contractor", async (t) => {
  if (!(await ready(t))) return;

  const name = `${RUN} Alpha`;
  const first = await create({ name, availability: "Available" });
  assert.equal(first.status, 200, `fixture creation failed: ${JSON.stringify(first.body)}`);

  for (const [label, attempt] of [
    ["the same name", name],
    ["a different case", name.toUpperCase()],
    ["padding around it", `   ${name}   `],
  ]) {
    const refused = await create({ name: attempt, availability: "Available" });
    assert.equal(refused.status, 409, `${label} must be refused, not stored`);
    /*
     * The refusal has to be readable by the person who typed the name, and has
     * to say nothing about how the register is stored. A driver message, a
     * table name or the word "constraint" reaching a coordinator is the leak
     * this whole family of guards exists to stop.
     */
    assert.match(String(refused.body.error), /already called that/i);
    assert.doesNotMatch(
      String(refused.body.error),
      /sqlite|postgres|constraint|d1_error|drizzle|\bselect\b|\binsert\b|\bupdate\b|organisation_id/i,
      "a refusal must not describe the database",
    );
  }

  // An EMAIL does not make a taken name available: the resolver never sees it.
  assert.equal((await create({ name, email: "someone-else@example.com" })).status, 409);

  const carrying = (await workspace()).contractors.filter((row) => row.name === name);
  assert.equal(carrying.length, 1, "exactly one contractor carries the name");
});

test("an archived contractor still holds their name", async (t) => {
  if (!(await ready(t))) return;

  const name = `${RUN} Retired`;
  const made = await create({ name, availability: "Available" });
  assert.equal(made.status, 200);
  assert.equal((await archive(made.body.id)).status, 200);

  /*
   * `active` is not part of the comparison, exactly as it is not part of
   * `resolveContractorLink`'s. An archived contractor's historical jobs are
   * still resolved by name, so a second row carrying it would make those jobs
   * ambiguous and drop them from the register too.
   */
  assert.equal((await create({ name })).status, 409, "archiving does not release the name");
});

test("two contractors may share an email, because nothing resolves them by it", async (t) => {
  if (!(await ready(t))) return;

  const shared = `info-${RUN.toLowerCase().replace(/[^a-z0-9]/g, "")}@apexgroup.co.uk`;
  const one = await create({ name: `${RUN} Trade One`, email: shared });
  const two = await create({ name: `${RUN} Trade Two`, email: shared });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200, "one office address across several trades is not an error");

  const rows = (await workspace()).contractors.filter((row) => row.email === shared);
  assert.equal(rows.length, 2, "and both are stored");
});

test("a whole-record save is not a rename, so a pair that exists stays editable", async (t) => {
  if (!(await ready(t))) return;

  const name = `${RUN} Echo`;
  const made = await create({ name, availability: "Available", phone: "+44 7700 900100" });
  assert.equal(made.status, 200);

  /*
   * THE FAILURE MODE THIS GUARDS AGAINST. The manage form posts the WHOLE
   * record on every save, so every ordinary edit arrives carrying the name the
   * row already has. A rule that asked "does anybody carry this name" without
   * asking "is that anybody THIS row" would answer 409 to every save of every
   * contractor in the register.
   */
  const echoed = await patch(made.body.id, {
    name,
    availability: "Limited",
    phone: "+44 7700 900222",
  });
  assert.equal(echoed.status, 200, `an unchanged name is not a rename: ${JSON.stringify(echoed.body)}`);

  const row = (await workspace()).contractors.find((item) => item.id === made.body.id);
  assert.equal(row.availability, "Limited", "and the rest of the save landed");
  assert.equal(row.phone, "+44 7700 900222");
});

test("a rename onto a taken name is refused; a cross-tenant id is still not found", async (t) => {
  if (!(await ready(t))) return;

  const taken = await create({ name: `${RUN} Taken` });
  const mover = await create({ name: `${RUN} Mover` });
  assert.equal(taken.status, 200);
  assert.equal(mover.status, 200);

  assert.equal((await patch(mover.body.id, { name: `${RUN} Taken` })).status, 409);
  assert.equal(
    (await patch(mover.body.id, { name: `${RUN} Mover Renamed` })).status,
    200,
    "a free name is still free",
  );
  // A write that never mentions the name is not this rule's business.
  assert.equal((await patch(mover.body.id, { notes: "untouched by the name rule" })).status, 200);

  /*
   * The 409 must never overtake the 404. Answering "that name is taken" for an
   * id the caller may not see would confirm the id AND leak a fact about the
   * actor's own register through a request about somebody else's.
   */
  assert.equal(
    (await patch("contractor-does-not-exist", { name: `${RUN} Taken` })).status,
    404,
    "the tenancy answer comes first",
  );
});

// ---------------------------------------------------------------------------
// Behaviour — who is offered when assigning work
// ---------------------------------------------------------------------------

test("availability never removes a contractor from the assignment list; archiving does", async (t) => {
  if (!(await ready(t))) return;

  const made = {};
  for (const availability of ["Available", "Limited", "Unavailable", "Inactive"]) {
    const row = await create({ name: `${RUN} ${availability}`, availability });
    assert.equal(row.status, 200, `fixture failed: ${JSON.stringify(row.body)}`);
    made[availability] = row.body.id;
  }
  const archived = await create({ name: `${RUN} Archived`, availability: "Available" });
  assert.equal((await archive(archived.body.id)).status, 200);

  // The exact predicate the select is built from — see `fieldsFor`.
  const offered = new Set(
    (await workspace()).contractors.filter((row) => row.active).map((row) => row.id),
  );

  for (const availability of ["Available", "Limited", "Unavailable", "Inactive"]) {
    assert.ok(
      offered.has(made[availability]),
      `availability "${availability}" is a day-to-day state and must not remove somebody from a schedule`,
    );
  }
  assert.ok(!offered.has(archived.body.id), "an archived contractor is off the register");
});

test("archiving a contractor keeps their planned work, and the form can still show them", async (t) => {
  if (!(await ready(t))) return;

  const snapshot = await workspace();
  const site = snapshot.stores?.[0];
  if (!site) {
    t.skip("no site to schedule against");
    return;
  }
  const made = await create({ name: `${RUN} Scheduled`, availability: "Available" });
  assert.equal(made.status, 200);
  const task = await call("POST", "/api/workspace", {
    entity: "planned",
    data: {
      siteId: site.id,
      contractorId: made.body.id,
      title: `${RUN} scheduled visit`,
      category: "Planned maintenance",
      frequency: "Annual",
      nextDueAt: "2026-12-01",
    },
  });
  assert.equal(task.status, 200, `fixture failed: ${JSON.stringify(task.body)}`);

  try {
    assert.equal((await archive(made.body.id)).status, 200);

    const after = await workspace();
    const row = after.planned.find((item) => item.id === task.body.id);
    assert.equal(row.contractorId, made.body.id, "the task keeps pointing at who is doing it");
    assert.equal(row.contractorName, `${RUN} Scheduled`, "and the payload can still name them");

    /*
     * The membership rule correctly excludes them, which is exactly why the
     * select has to carry the current value as well — otherwise it renders a
     * value its options do not contain and shows BLANK on an assigned task.
     */
    const offered = after.contractors.filter((item) => item.active).map((item) => item.id);
    assert.ok(!offered.includes(row.contractorId), "and is not offered for anything new");

    // And the API must not have become the thing that strands the task.
    const resave = await call("PATCH", "/api/workspace", {
      entity: "planned",
      id: task.body.id,
      data: {
        siteId: site.id,
        contractorId: made.body.id,
        title: `${RUN} scheduled visit`,
        category: "Planned maintenance",
        frequency: "Annual",
        nextDueAt: "2026-12-01",
        status: "Scheduled",
        reminderDays: "30",
      },
    });
    assert.equal(resave.status, 200, "a task assigned to an archived contractor is still savable");
  } finally {
    await call("DELETE", "/api/workspace", { entity: "planned", id: task.body.id });
  }
});

// ---------------------------------------------------------------------------
// Source — the rules that have no behaviour left to observe
// ---------------------------------------------------------------------------

test("the name rule is the resolver's rule, not a second opinion", async () => {
  const api = await read("app/api/workspace/route.ts");
  const guard = api.slice(api.indexOf("async function contractorNameConflict"));
  const body = guard.slice(0, guard.indexOf("\n}\n"));

  assert.match(body, /eq\(contractors\.organisationId, orgId\)/, "organisation-scoped");
  assert.match(
    body,
    /lower\(trim\(\$\{contractors\.name\}\)\) = lower\(trim\(\$\{name\}\)\)/,
    "both sides folded BY THE DATABASE, exactly as app/lib/contractor-reference.ts does",
  );
  assert.match(body, /status: 409/, "a state conflict, not a validation error");
  // `active` must NOT appear: an archived contractor still answers to their name.
  assert.doesNotMatch(body, /contractors\.active/, "archiving does not release a name");
  // And it must be able to say "this row already carries it", or every save 409s.
  assert.match(body, /if \(selfId\)/, "the transition, not the state");

  // Wired into BOTH write paths, and the PATCH one after the tenancy answer.
  assert.match(api, /const badName = await contractorNameConflict\(db, orgId, name, null\)/, "create");
  assert.match(
    api,
    /const badRename = await contractorNameConflict\(db, orgId, text\(data\.name, 140\), id\)/,
    "update",
  );
  const patchBranch = api.slice(api.lastIndexOf('} else if (entity === "contractor") {'));
  assert.ok(
    patchBranch.indexOf("await contractorTarget(db, orgId, id)") <
      patchBranch.indexOf("contractorNameConflict"),
    "the 404 is decided before any 409 about a name",
  );
});

test("the read-side ambiguity rule survives on both surfaces", async () => {
  /*
   * NOT dead code, and this is the assertion that says why.
   *
   * `contractorNameConflict` is a check-then-insert, not a mutual exclusion, so
   * two simultaneous creates can still both land; and it is transition-only on
   * purpose, so pairs that already exist stay editable rather than stranded.
   * Both surfaces therefore still have to answer "which contractor does this
   * name mean" with "neither" rather than with "both" — the defect that
   * reported a single GBP 999 job as GBP 1,998 on the Contractors page.
   *
   * The linkage suite used to prove this behaviourally by creating the pair.
   * It cannot any more: the register refuses. This is what replaces it.
   */
  const api = await read("app/api/workspace/route.ts");
  assert.match(api, /const contractorsPerName = new Map<string, number>\(\)/);
  assert.match(
    api,
    /\.filter\(\(row\) => \(contractorsPerName\.get\(row\.contractor\) \?\? 0\) <= 1\)/,
    "the server attributes an unlinked job only where the name is unique",
  );

  /*
   * THE BROWSER'S HALF MOVED, AND THIS PIN MOVED WITH IT — it is not weaker.
   *
   * The rule was written out by hand in `ContractorsView`, and W06-12 then
   * found the ORIGINAL name-only version still running in `ContractorScorecard`
   * on the Reports page: one rule, two hand-written copies, one of them fixed.
   * It now lives once, in `app/lib/contractor-attribution.ts`, and the register
   * page, the Reports scorecard and the Dashboard's contractor cost panel all
   * call it. Asserting it where it is DEFINED plus asserting the page is a
   * caller covers strictly more surfaces than the single pin did.
   */
  const rule = await read("app/lib/contractor-attribution.ts");
  assert.match(rule, /const nameIsUnique = \(rosterPerName\.get\(contractor\.name\) \?\? 0\) <= 1;/);
  assert.match(
    rule,
    /nameIsUnique && request\.contractor === contractor\.name/,
    "and the browser applies the same rule to the same question",
  );

  const page = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    page,
    /attributeContractorWork\(scopedRequests, roster\)/,
    "the Contractors page reaches its figures through that one rule",
  );
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.equal(
    (insights.match(/attributeContractorWork\(requests, contractors\)/g) ?? []).length,
    2,
    "and so do both reporting panels, which is the copy that had been missed",
  );
});

test("the assignment select offers the active, and keeps whoever is already assigned", async () => {
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");

  // Membership is `active` alone — the rule the Active checkbox's hint states.
  assert.match(
    form,
    /const assignableContractors = workspace\.contractors\.filter\(\(item\) => item\.active\);/,
  );
  const hint = form.slice(form.indexOf('label: "Active contractor"'));
  assert.match(
    hint.slice(0, 600),
    /offered when assigning work/i,
    "the checkbox says out loud that it is the membership rule",
  );

  /*
   * And availability is NOT a filter. It is written, validated and displayed,
   * and gating a schedule whose next due date is months away on whether
   * somebody can take work THIS WEEK would be the wrong question.
   */
  const options = form.slice(form.indexOf("const assignableContractors"));
  const block = options.slice(0, options.indexOf("if (tab === \"site\")"));
  assert.doesNotMatch(
    block,
    /availability/,
    "availability must not decide who may be assigned planned work",
  );

  // The current value stays selectable even when the rule no longer offers it.
  assert.match(block, /assignedElsewhere/, "an archived assignee is kept as an option");
  assert.match(block, /\(archived\)/, "and is labelled, so it does not read as an ordinary choice");
  /*
   * RE-POINTED, CONTRACT UNCHANGED. This matched the whole call on one line —
   * `fieldsFor(tab, workspace, typeof form?.contractorId === "string" ? …)` —
   * and W05-07 gave `fieldsFor` a FOURTH argument (the configured site types,
   * so the Sites tab stops restating a list `option_values` owns). The call is
   * now spread over several lines and carries one more parameter; the promise
   * this pin exists for is unchanged and is asserted directly: the open
   * record's own contractor id must still be what reaches the third argument,
   * because that is what keeps an archived assignee selectable instead of
   * blanking a select that is bound to them.
   */
  assert.match(
    form,
    /fieldsFor\(\s*tab,\s*workspace,\s*typeof form\?\.contractorId === "string" \? form\.contractorId : null,/,
    "the open record's own contractor is what makes that possible",
  );
});

/**
 * Every fixture this file created, removed for good.
 *
 * Archiving only sets `active:false, availability:'Inactive'` — a contractor is
 * never deleted, which is the product contract — so the rows would otherwise
 * survive their own cleanup and accumulate. Under the name guard that is worse
 * than untidy: the next run's fixtures would collide with this run's and be
 * refused, and the suite would fail against a product behaving correctly.
 */
after(async () => {
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
    // The dev server holds this file open; wait for the writer rather than
    // leave the fixtures behind. Same bargain as the sibling suites.
    db.exec("PRAGMA busy_timeout = 10000");
    // The activity rows go first, while the ids they name can still be found.
    db.prepare(
      "DELETE FROM activity_log WHERE entity_id IN (SELECT id FROM planned_maintenance WHERE title LIKE ?)",
    ).run(`${RUN}%`);
    db.prepare(
      "DELETE FROM activity_log WHERE entity_id IN (SELECT id FROM contractors WHERE name LIKE ?)",
    ).run(`${RUN}%`);
    db.prepare("DELETE FROM planned_maintenance WHERE title LIKE ?").run(`${RUN}%`);
    db.prepare("DELETE FROM contractors WHERE name LIKE ?").run(`${RUN}%`);
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
