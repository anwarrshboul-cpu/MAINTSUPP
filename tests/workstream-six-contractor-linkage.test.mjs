import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Workstream 6 — a contractor's jobs survive their being renamed.
 *
 * `maintenance_requests` carries both `contractor`, the free text a person
 * typed, and `contractor_id`, the reference Batch 1B added. Until this suite
 * existed, three things were true at once and none of them was tested:
 *
 *   1. Nothing in the RUNNING application ever wrote `contractor_id`. The only
 *      writers were the boot backfill in `db/init.ts`, memoised once per
 *      isolate, and the monday importer. Assigning a contractor through the
 *      product stored a name and left the reference NULL.
 *   2. The register tallied a contractor's jobs by matching that NAME — so
 *      RENAMING a contractor silently zeroed their whole history. Measured on
 *      a fixture: `assigned 1, urgent 1, spend 250` became `0, 0, 0` on the
 *      next read, with the job's `contractor_id` still pointing at the renamed
 *      row.
 *   3. Clearing a job's contractor text left the reference behind, so the row
 *      said "nobody" and pointed at somebody.
 *
 * The fix is one rule in two places: `app/lib/contractor-reference.ts` derives
 * the reference from the text on every write that mentions the text, and the
 * tally counts a job for a contractor when `contractor_id` names them OR —
 * only where there is no id — the text does. Those two sets are disjoint, so
 * the second half of this file is about proving that nothing is counted twice.
 *
 * WHY THIS SUITE TALKS TO A RUNNING SERVER. The defect is not visible in any
 * single file: it is the disagreement between a write path that does not
 * maintain a column and a read path that does not read it. Both halves have to
 * actually run. The database is opened read-only alongside, because "the tally
 * says 1" and "the row holds this id" are different claims and this suite
 * makes both. Skips cleanly when either is absent, exactly as
 * `batch-1b-canonical-links.test.mjs` does.
 */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
/*
 * Run-scoped, and it has to be.
 *
 * A fixed prefix made this suite pass exactly once. The workspace API has no
 * hard delete for a contractor — `DELETE` archives the row and leaves it in the
 * register — so every run left its fixtures behind, and the SECOND run created
 * a second `…-known`. Two contractors carrying one name is precisely the
 * ambiguity `resolveContractorLink` refuses to guess between, so the link came
 * back null and the suite failed with the product behaving CORRECTLY. Measured:
 * four rows named `ZZQA-W6-LINKAGE-known` after four runs.
 *
 * A per-run suffix keeps each run's register unambiguous. The ambiguity test
 * below still works, because it deliberately creates its pair inside the SAME
 * run and therefore under this same prefix.
 */
const PREFIX = `ZZQA-W6-LINKAGE-${crypto.randomUUID().slice(0, 8)}`;

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
  } catch {
    return null;
  }
}

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

const contractorsOf = async () => (await call("GET", "/api/workspace")).json?.workspace?.contractors ?? [];
const tallyOf = async (id) => {
  const row = (await contractorsOf()).find((entry) => entry.id === id);
  return row && {
    name: row.name,
    assigned: row.assignedJobs,
    completed: row.completedJobs,
    urgent: row.urgentJobs,
    spend: row.spend,
  };
};

/**
 * A job raised through the public shape of the API, so nothing here depends on
 * a seeded row surviving. `location` must be a site this workspace owns, which
 * is why the first store is read rather than named.
 */
async function raiseJob(suffix) {
  const stores = (await call("GET", "/api/workspace")).json?.workspace?.stores ?? [];
  if (!stores.length) return null;
  const created = await call("POST", "/api/maintenance", {
    location: stores[0].name,
    requester: PREFIX,
    contact: "zzqa@example.com",
    description: `${PREFIX}-${suffix} contractor linkage fixture, safe to delete.`,
    category: "Electrical",
    priority: "Urgent",
  });
  return created.status === 201 ? created.json.request.id : null;
}

/* ── The tests ─────────────────────────────────────────────────────────────── */

test("the resolver never guesses, never creates and never leaves the tenant", async () => {
  const source = await read("app/lib/contractor-reference.ts");
  // The rule is db/init.ts's, and it is the whole rule: org, exact, unique.
  assert.match(source, /eq\(contractors\.organisationId, orgId\)/, "organisation-scoped");
  assert.match(
    source,
    /lower\(trim\(\$\{contractors\.name\}\)\) = lower\(trim\(\$\{text\}\)\)/,
    "both sides lowered and trimmed BY THE DATABASE, not by JavaScript",
  );
  assert.match(source, /\.limit\(2\)/, "two rows is enough to know a match is not unique");
  assert.match(source, /rows\.length === 1/, "only an unambiguous match links");
  // Nothing may invent a contractor, and nothing may soften the comparison.
  assert.doesNotMatch(source, /insert\(contractors\)/, "the resolver must never create a contractor");
  assert.doesNotMatch(source, /\blike\b|includes\(|startsWith\(|indexOf\(/i, "no fuzzy or substring matching");
  assert.doesNotMatch(source, /toLowerCase\(\)/, "case folding belongs to SQL, not to JS");
});

test("a rename does not change what a contractor's jobs add up to", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const database = await openDatabase();
  if (!database) {
    t.skip("no development database");
    return;
  }

  const name = `${PREFIX}-rename`;
  const created = await call("POST", "/api/workspace", { entity: "contractor", data: { name } });
  assert.equal(created.status, 200);
  const contractorId = created.json.id;
  const jobId = await raiseJob("rename");
  assert.ok(jobId, "the fixture job was raised");

  try {
    // The one assignment surface. It must set the reference, not only the text.
    const assigned = await call("PATCH", "/api/maintenance", {
      id: jobId,
      fields: { contractor: name, cost: 250 },
    });
    assert.equal(assigned.status, 200);

    const row = database
      .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(row.contractor, name, "the raw text is preserved exactly as typed");
    assert.equal(
      row.contractor_id,
      contractorId,
      "assigning a contractor must write the reference, or nothing downstream can survive a rename",
    );

    const before = await tallyOf(contractorId);
    assert.deepEqual(
      { assigned: before.assigned, completed: before.completed, urgent: before.urgent, spend: before.spend },
      { assigned: 1, completed: 0, urgent: 1, spend: 250 },
    );

    // THE DEFECT THIS FILE EXISTS FOR.
    const renamed = await call("PATCH", "/api/workspace", {
      entity: "contractor",
      id: contractorId,
      data: { name: `${name}-RENAMED` },
    });
    assert.equal(renamed.status, 200);

    const after = await tallyOf(contractorId);
    assert.equal(after.name, `${name}-RENAMED`, "the rename happened");
    assert.deepEqual(
      { assigned: after.assigned, completed: after.completed, urgent: after.urgent, spend: after.spend },
      { assigned: 1, completed: 0, urgent: 1, spend: 250 },
      "renaming a contractor must not zero their history",
    );

    // The text is HISTORY and is never rewritten to the new spelling.
    const afterRow = database
      .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(afterRow.contractor, name, "the job still records the name it was given");
    assert.equal(afterRow.contractor_id, contractorId, "the reference is untouched by a rename");
  } finally {
    database.close();
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [jobId] });
    await call("DELETE", "/api/workspace", { entity: "contractor", id: contractorId });
  }
});

test("a job whose id AND text both name a contractor counts once, not twice", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const name = `${PREFIX}-once`;
  const created = await call("POST", "/api/workspace", { entity: "contractor", data: { name } });
  const contractorId = created.json.id;
  const jobId = await raiseJob("once");
  assert.ok(jobId);

  try {
    await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: name, cost: 100 } });
    const tally = await tallyOf(contractorId);
    /*
     * The row now satisfies BOTH halves of the predicate — `contractor_id` is
     * this contractor and `contractor` is their name. An id-keyed map laid on
     * top of the name-keyed one would count it twice, trading the undercount
     * above for an overcount here. The aggregates are split on
     * `contractor_id IS NULL`, so they cannot both see this row.
     */
    assert.equal(tally.assigned, 1, "one job, counted once");
    assert.equal(tally.spend, 100, "one cost, added once");
  } finally {
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [jobId] });
    await call("DELETE", "/api/workspace", { entity: "contractor", id: contractorId });
  }
});

test("the register refuses to be made ambiguous, and a unique name still counts", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const database = await openDatabase();
  if (!database) {
    t.skip("no development database");
    return;
  }
  /*
   * WHAT THIS TEST USED TO DO, AND WHY IT NO LONGER CAN.
   *
   * It created two contractors carrying one name and proved that the job
   * assigned to that name counted for NEITHER of them — the same answer
   * `resolveContractorLink` gives, and the fix for a real defect: the name
   * fallback is a lookup, both rows answered to the name, and one GBP 999 job
   * was reported on the Contractors page as GBP 1,998.
   *
   * The register now REFUSES to create that pair (`contractorNameConflict`,
   * app/api/workspace/route.ts). A name is not a label in this product — it is
   * the join key on the only assignment surface there is, because a job's
   * contractor is free text and `contractor_id` is derived from it. Measured
   * before the guard: two contractors named the same, one job at GBP 999
   * assigned to that name, `contractor_id` NULL and BOTH tallies reading
   * 0/0/0/0. A thousand pounds attributed to nobody, every request answering
   * 200. So the state this test constructed is now unreachable through the API,
   * and the assertion that it counts for neither cannot be made behaviourally
   * any more.
   *
   * Three things replace it, and between them nothing that was protected has
   * been given up:
   *
   *  1. the refusal itself, asserted below — a stronger guarantee than the
   *     tally rule it replaces, because the bad state never exists;
   *  2. the job assigned to that name now LINKS, because the name is unique
   *     by construction — asserted below;
   *  3. the read-side rule that handles pairs which already exist is asserted
   *     in `workstream-six-contractor-identity.test.mjs`. It is NOT dead code:
   *     the guard is a check-then-insert rather than a mutual exclusion, so two
   *     simultaneous creates can still both land, and legacy pairs are left
   *     editable on purpose rather than being stranded.
   *
   * The genuinely additive case — an unlinked job whose name is UNIQUE — is
   * unchanged below, and is the half this test was always reaching for.
   */
  const name = `${PREFIX}-ambiguous`;
  const first = await call("POST", "/api/workspace", { entity: "contractor", data: { name } });
  assert.equal(first.status, 200);
  const second = await call("POST", "/api/workspace", { entity: "contractor", data: { name } });
  const jobId = await raiseJob("ambiguous");
  assert.ok(jobId);

  try {
    assert.equal(second.status, 409, "a name the register already knows cannot be given twice");
    assert.equal(
      (await contractorsOf()).filter((row) => row.name === name).length,
      1,
      "and exactly one contractor carries it afterwards",
    );

    await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: name, cost: 75 } });
    const row = database
      .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(row.contractor, name, "the text a person typed is kept whatever the register says");
    assert.equal(
      row.contractor_id,
      first.json.id,
      "the name is unambiguous, so it resolves — which is the point of refusing the twin",
    );
    const tally = await tallyOf(first.json.id);
    assert.deepEqual(
      { assigned: tally.assigned, completed: tally.completed, urgent: tally.urgent, spend: tally.spend },
      { assigned: 1, completed: 0, urgent: 1, spend: 75 },
      "and the work reaches the one contractor who did it",
    );

    /*
     * And now the additive half, with nothing ambiguous about it. The job takes
     * the name BEFORE any contractor carries it, so no link can be made; the
     * contractor is created afterwards. That is an unlinked job with a unique
     * name — the ordinary shape of every historical row the backfill could not
     * resolve — and it must still reach its contractor by name alone.
     */
    const soloName = `${PREFIX}-solo`;
    const soloJob = await raiseJob("solo");
    assert.ok(soloJob);
    await call("PATCH", "/api/maintenance", { id: soloJob, fields: { contractor: soloName, cost: 75 } });
    const solo = await call("POST", "/api/workspace", { entity: "contractor", data: { name: soloName } });
    const soloRow = database
      .prepare("SELECT contractor_id FROM maintenance_requests WHERE id = ?")
      .get(soloJob);
    assert.equal(soloRow.contractor_id, null, "the job predates the contractor, so it carries no reference");
    const soloTally = await tallyOf(solo.json.id);
    assert.deepEqual(
      { assigned: soloTally.assigned, completed: soloTally.completed, urgent: soloTally.urgent, spend: soloTally.spend },
      { assigned: 1, completed: 0, urgent: 1, spend: 75 },
      "an unlinked job with a unique name still counts, exactly as it did before",
    );
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [soloJob] });
  } finally {
    database.close();
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [jobId] });
    await call("DELETE", "/api/workspace", { entity: "contractor", id: first.json.id });
    // `second` was refused, so there is no id to archive. Guarded rather than
    // dropped: a DELETE carrying `id: undefined` answers 400 and files nothing,
    // but the cleanup should say what it means.
    if (second.json?.id) {
      await call("DELETE", "/api/workspace", { entity: "contractor", id: second.json.id });
    }
  }
});

test("a name the register does not know creates nothing, and clearing the text clears the link", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const database = await openDatabase();
  if (!database) {
    t.skip("no development database");
    return;
  }
  const name = `${PREFIX}-known`;
  const created = await call("POST", "/api/workspace", { entity: "contractor", data: { name } });
  const contractorId = created.json.id;
  const jobId = await raiseJob("unknown");
  assert.ok(jobId);

  try {
    await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: name } });
    const before = (await contractorsOf()).length;

    // A name nobody carries. The text lands; nothing is invented to hold it.
    const unknown = await call("PATCH", "/api/maintenance", {
      id: jobId,
      fields: { contractor: `${PREFIX}-NOBODY-CARRIES-THIS` },
    });
    assert.equal(unknown.status, 200, "an unrecognised name is not an error — it is a name");
    /*
     * Asked of the NAME, not of the register's size.
     *
     * Comparing a total before and after says "nothing was created by anyone",
     * which is a claim about the whole workspace and not about this write —
     * so the sibling CRUD suite creating one of its own fixtures at the same
     * moment failed this line (104/105 in a parallel run, 6/6 alone). The
     * invariant that actually matters is narrower and is immune to what else
     * is happening: THIS name must not have brought a contractor into being.
     */
    const invented = (await contractorsOf()).filter(
      (row) => row.name === `${PREFIX}-NOBODY-CARRIES-THIS`,
    );
    assert.equal(invented.length, 0, "no contractor may be auto-created from an unknown name");
    void before;

    const stale = database
      .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(stale.contractor, `${PREFIX}-NOBODY-CARRIES-THIS`);
    assert.equal(
      stale.contractor_id,
      null,
      "a reference that contradicts the text beside it is worse than none",
    );

    // Clearing the assignment clears both halves.
    await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: null } });
    const cleared = database
      .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(cleared.contractor, null);
    assert.equal(cleared.contractor_id, null, "a job that names nobody must point at nobody");

    // And a write that never mentions the contractor must not disturb the link.
    await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: name } });
    await call("PATCH", "/api/maintenance", { id: jobId, fields: { priority: "Medium" } });
    const untouched = database
      .prepare("SELECT contractor_id FROM maintenance_requests WHERE id = ?")
      .get(jobId);
    assert.equal(untouched.contractor_id, contractorId, "an unrelated edit leaves the link alone");
  } finally {
    database.close();
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [jobId] });
    await call("DELETE", "/api/workspace", { entity: "contractor", id: contractorId });
  }
});

test("a contractor in another tenant can neither be reached nor linked", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const database = await openDatabase();
  if (!database) {
    t.skip("no development database");
    return;
  }
  /*
   * There is NO composite foreign key on `(organisation_id, contractor_id)`,
   * so the database will not stop a job in one tenant pointing at a contractor
   * in another. Tenancy here is application-enforced, which is exactly why it
   * is asserted rather than assumed.
   */
  const foreign = database
    .prepare(
      `SELECT c.id, c.name FROM contractors c
        WHERE c.organisation_id <> (SELECT organisation_id FROM contractors LIMIT 1)
        LIMIT 1`,
    )
    .get();
  const jobId = await raiseJob("crossorg");
  assert.ok(jobId);

  try {
    if (foreign) {
      const before = database.prepare("SELECT name, active FROM contractors WHERE id = ?").get(foreign.id);
      assert.equal(
        (await call("PATCH", "/api/workspace", { entity: "contractor", id: foreign.id, data: { name: "hijacked" } })).status,
        404,
        "another tenant's contractor is not found, not forbidden — the status must not confirm the id",
      );
      assert.equal(
        (await call("DELETE", "/api/workspace", { entity: "contractor", id: foreign.id })).status,
        404,
      );
      const after = database.prepare("SELECT name, active FROM contractors WHERE id = ?").get(foreign.id);
      assert.deepEqual(after, before, "ZERO mutation across the tenant boundary");

      // The name is not a way in either.
      await call("PATCH", "/api/maintenance", { id: jobId, fields: { contractor: foreign.name } });
      const row = database
        .prepare("SELECT contractor, contractor_id FROM maintenance_requests WHERE id = ?")
        .get(jobId);
      assert.equal(row.contractor, foreign.name, "the text is whatever was typed");
      assert.equal(row.contractor_id, null, "a name only resolves inside the job's own organisation");
    }

    // Whatever the register holds, no link may cross a tenant.
    const leaks = database
      .prepare(
        `SELECT count(*) n FROM maintenance_requests m
           JOIN contractors c ON c.id = m.contractor_id
          WHERE c.organisation_id <> m.organisation_id`,
      )
      .get().n;
    assert.equal(leaks, 0, "no cross-organisation contractor links");
  } finally {
    database.close();
    await call("POST", "/api/board", { boardId: "maintenance", action: "delete_items", requestIds: [jobId] });
  }
});

/*
 * Leave the register as this suite found it.
 *
 * `DELETE /api/workspace {entity:"contractor"}` ARCHIVES — it sets
 * `active:false` and does not remove the row — so the per-test `finally`
 * blocks above, which is all the API can offer, left every fixture behind.
 * Five contractors and four jobs per run, accumulating: after four runs the
 * register held four rows called `…-known`, and since two contractors sharing
 * a name is exactly the ambiguity `resolveContractorLink` refuses to guess
 * between, this suite eventually failed against a product that was behaving
 * correctly.
 *
 * The run-scoped PREFIX means each run can only ever match its own rows, so
 * this deletes by that prefix and can touch nothing else — no other suite's
 * fixtures, and none of the seeded register. Same shape and the same
 * `busy_timeout` as the sibling CRUD suite, for the same reason: the dev
 * server holds this file open and an unqualified write loses the race.
 */
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
     * One transaction, not three statements.
     *
     * `node --test` runs test FILES in parallel, and every HTTP-backed suite in
     * this repository is writing to this one SQLite file through the dev
     * server. Three separate deletes take three separate write locks, and each
     * one is a window in which somebody else's request gets "database is
     * locked" — which the workspace PATCH catch-all turns into a 400. That is
     * how a cleanup here made an unrelated suite (`workstream-five-site-patch`)
     * fail in a parallel batch while passing perfectly alone.
     *
     * Wrapping them takes ONE short lock for the whole cleanup instead. It does
     * not make the shared-file contention go away — nothing in a test can —
     * but it stops this suite being a disproportionate contributor to it.
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

    const left = db
      .prepare("SELECT count(*) n FROM contractors WHERE name LIKE ?")
      .get(`${PREFIX}%`).n;
    assert.equal(left, 0, "this run's contractors are gone");
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
