import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * The contractor register stops guessing what a request meant.
 *
 * FIVE things were wrong on `PATCH /api/workspace { entity: "contractor" }`,
 * and four of them shared one cause: `supplied` fixed the OMITTED key and
 * nothing fixed a key that was SENT carrying nothing.
 *
 *  1. `booleanValue` falls back to TRUE, so `{ "active": null }` did not leave
 *     an archived contractor alone and did not archive them either — it put
 *     them back on the register and back in the assignment dropdown. Measured:
 *     archive, `PATCH { active: null }`, read back `active: true`, HTTP 200.
 *  2. `availability` is NOT NULL behind a four-label select, and
 *     `text(null, 60)` is "", so `{ "availability": null }` wrote an empty
 *     string into a column whose entire job is to say which of four states
 *     this is.
 *  3. `name` is NOT NULL and is the register's only identifier — the workspace
 *     GET tallies jobs by contractor NAME, not by id — and the contractor
 *     branch was the one branch with no `requiredTextRefusal`, so
 *     `{ "name": null }` blanked it and detached every tally with it.
 *  4. A cross-tenant `PATCH` answered 200 `{ ok: true }`. The UPDATE is
 *     organisation-scoped so nothing moved, but the caller was told it worked
 *     and `logChange` then filed the caller's own payload — `"HACKED"`,
 *     `"pwned"` — into THIS organisation's activity feed as a change that had
 *     happened.
 *  5. And one that is not a null at all: after archiving writes
 *     `active: false, availability: 'Inactive'` together, an ORDINARY save
 *     carrying a stale `active: true` put the contractor back. That is not a
 *     hypothetical — `activity_log` has the sequence on
 *     `contractor-test-c6cfce01`, archived on the 26th and resurrected by an
 *     edit on the 29th, and the row still reads `active = true,
 *     availability = 'Inactive'`.
 *
 * Source assertions run everywhere. The behavioural tests need a dev server and
 * skip without one, which is the bargain the rest of this suite already makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `w6contractor-${Date.now().toString(36)}`;

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

async function call(method, orgId, body) {
  const response = await fetch(`${BASE_URL}/api/workspace`, {
    method,
    headers: {
      cookie: `${cookie}; maintsupp_demo_organisation=${orgId}`,
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

const create = (orgId, data) => call("POST", orgId, { entity: "contractor", data });
const patch = (orgId, id, data) => call("PATCH", orgId, { entity: "contractor", id, data });
const archive = (orgId, id) => call("DELETE", orgId, { entity: "contractor", id });

/**
 * One contractor, read straight from the development database.
 *
 * Not through `GET /api/workspace`: that assembles the whole workspace — every
 * site, every compliance row, every job tally — and costs about a second, which
 * called after each of two dozen refusals would dominate the run and tie up the
 * one development server everything else in this suite shares.
 */
function contractorReader() {
  let cache;
  return async function readContractor(orgId, id) {
    if (cache === undefined) {
      cache = null;
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
        const file = (await readdir(directory)).find(
          (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
        );
        if (file) {
          // `fileURLToPath`, not `URL.pathname`: this repo's path has a space
          // in it, and a percent-encoded path opens nothing.
          cache = new DatabaseSync(fileURLToPath(new URL(file, directory)), { readOnly: true });
        }
      } catch {
        cache = null;
      }
    }
    if (!cache) return null;
    try {
      const row = cache
        .prepare(
          `SELECT name, email, phone, whatsapp_number, contact_name, address, notes,
                  day_rate_pence, service_categories, coverage_areas, certifications,
                  insurance_expiry, availability, rating, active
             FROM contractors WHERE id = ? AND organisation_id = ?`,
        )
        .get(id, orgId);
      return row ? { ...row, active: !!row.active } : undefined;
    } catch {
      return null;
    }
  };
}
const readContractor = contractorReader();

/**
 * Every fixture this file created, removed for good.
 *
 * Archiving a contractor only sets `active: false, availability: 'Inactive'` —
 * they are never deleted, which is the product contract — so the rows would
 * otherwise survive their own cleanup and accumulate across runs.
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
    file = (await readdir(directory)).find((entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite");
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
    /*
     * The dev server holds this file open, so an unqualified write loses the
     * race and throws "database is locked". Wait for the writer rather than
     * leave the fixtures behind.
     */
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare(
      "DELETE FROM activity_log WHERE entity_id IN (SELECT id FROM contractors WHERE name LIKE ?)",
    ).run(`${RUN}%`);
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

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

test("a contractor's record state is checked rather than guessed", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /function contractorActiveRefusal\(/, "one guard");
  assert.match(route, /A contractor's active state must be true or false\./);

  /*
   * The member guard and this one have to accept the same set, because that set
   * is defined by what `booleanValue` can read and everything outside it is
   * what falls through to the TRUE fallback. One predicate, used by both.
   */
  assert.match(route, /function readableBoolean\(value: unknown\)/, "one predicate");
  const predicate = route.slice(route.indexOf("function readableBoolean"));
  assert.match(
    predicate.slice(0, 400),
    /typeof value === "boolean"[\s\S]*value === "true"[\s\S]*value === "false"[\s\S]*value === 0[\s\S]*value === 1/,
    "exactly the values `booleanValue` reads",
  );
  assert.match(route, /return readableBoolean\(data\.active\)[\s\S]{0,220}A member's access/, "the member guard uses it");

  // Both verbs. A create is where the row gets its first state.
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  const patchSource = route.slice(route.indexOf("export async function PATCH"));
  assert.match(post, /contractorActiveRefusal\(data\)/, "the create must refuse an unreadable `active`");
  assert.match(patchSource, /contractorActiveRefusal\(data\)/, "and so must the edit");
});

test("the contractor PATCH refuses an explicitly emptied NOT NULL column", async () => {
  const route = await read("app/api/workspace/route.ts");
  const patchSource = route.slice(route.indexOf("export async function PATCH"));
  const branch = patchSource.slice(patchSource.indexOf('entity === "contractor"'));
  const guards = branch.slice(0, branch.indexOf("await db.update(contractors)"));

  assert.match(
    guards,
    /requiredTextRefusal\(data, "name", 140, "A contractor name is required\."\)/,
    "`name` is NOT NULL and is what the job tallies key on",
  );
  /*
   * An ALLOW-LIST, not the non-empty check this used to demand.
   *
   * `requiredTextRefusal` stopped `{ availability: null }` writing `""` into a
   * NOT NULL column, which is what this line was written for. It did not stop
   * `"Bananas"`, a 200-character string or `"<script>alert(1)</script>"` — all
   * of which stored, while the refusal text claimed the value "must be one of
   * the offered states". The four labels lived only in the browser.
   *
   * That mattered beyond tidiness: `contractorResurrectionRefusal` asks whether
   * the resulting availability is still `'Inactive'`, and that question has no
   * force when the answer can be any string. `{ active: true, availability:
   * "inactive" }` — one capital letter away from the archive marker — was
   * accepted and put an archived contractor back on the register.
   * `contractorAvailabilityRefusal` is what makes the empty string, the junk
   * and the archive guard all one closed question.
   */
  assert.match(
    guards,
    /contractorAvailabilityRefusal\(data\)/,
    "`availability` is NOT NULL and is one of four labels, not merely non-empty",
  );

  // Every guard must run before the statement, or a refusal writes first.
  for (const guard of ["badName", "badAvailability", "badActive", "badEmail", "badRate"]) {
    assert.ok(guards.includes(guard), `${guard} must be checked before the UPDATE`);
  }
});

test("a contractor mutation is refused, not silently ignored, across a tenant boundary", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /async function contractorTarget\(/, "one target read");
  assert.match(route, /error: "Contractor not found\." \}, \{ status: 404 \}/);

  // The scoped WHERE is the thing that makes the no-op a no-op. It stays.
  const patchSource = route.slice(route.indexOf("export async function PATCH"));
  const branch = patchSource.slice(patchSource.indexOf('entity === "contractor"'));
  assert.match(
    branch.slice(0, branch.indexOf('} else if (entity === "planned")')),
    /\.where\(and\(eq\(contractors\.id, id\), eq\(contractors\.organisationId, orgId\)\)\)/,
    "the UPDATE stays organisation-scoped",
  );

  // And the archive verb answers for a row it cannot see, before `logChange`.
  // The call, not the comment above it that explains why the call is there.
  const del = route.slice(route.indexOf("export async function DELETE"));
  assert.ok(
    del.indexOf("contractorTarget(db, orgId, id)") < del.indexOf("await logChange("),
    "the archive verb must refuse before it writes an audit entry",
  );
});

test("archiving still writes both state columns, and restoring will not leave them contradicting", async () => {
  const route = await read("app/api/workspace/route.ts");
  // Unchanged. `active` and `availability` are two claims and the archive makes
  // both of them; neither half is a substitute for the other.
  assert.match(
    route,
    /entity === "contractor"\) await db\.update\(contractors\)\.set\(\{ active: false, availability: "Inactive"/,
  );
  assert.match(route, /function contractorResurrectionRefusal\(/, "one guard");
  assert.match(route, /const ARCHIVED_AVAILABILITY = "Inactive";/);

  /*
   * Narrow on purpose: only the transition, and only while the result would
   * still wear the archive's marker. It must NOT fire on a row that is already
   * in that state — those rows exist and making them unsavable strands them.
   */
  const guard = route.slice(route.indexOf("function contractorResurrectionRefusal"));
  assert.match(guard.slice(0, 700), /if \(stored\.active\) return null;/, "no opinion about an already-active row");
  assert.match(guard.slice(0, 700), /booleanValue\(data\.active\) !== true/, "only the false -> true transition");
});

test("a contractor's email is checked, and a blank one is still allowed", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /function contractorEmailRefusal\(/, "one guard");
  assert.match(route, /const CONTRACTOR_EMAIL_SHAPE = /, "one shape");
  assert.match(route, /const INVISIBLE_CHARACTERS =/, "zero-width and bidi characters are not `\\s`");

  const guard = route.slice(route.indexOf("function contractorEmailRefusal"));
  assert.match(
    guard.slice(0, 500),
    /if \(typeof raw !== "string" \|\| raw === ""\) return null;/,
    'the manage form posts `email: ""` for an empty box — that has to stay savable',
  );

  // The shape itself, exercised directly rather than described.
  const shape = new RegExp(
    route.slice(route.indexOf("const CONTRACTOR_EMAIL_SHAPE = /") + "const CONTRACTOR_EMAIL_SHAPE = /".length).split("/;")[0],
  );
  for (const bad of ["@", "a@", "@b", "a@b", "a b@c.com", " "]) {
    assert.equal(shape.test(bad), false, `${JSON.stringify(bad)} is not an address`);
  }
  for (const good of ["ops@uk-safety.example", "Dan.OBrien+jobs@apex-electrical.co.uk"]) {
    assert.equal(shape.test(good), true, `${JSON.stringify(good)} is`);
  }
});

test("a day rate cannot be handed to the driver larger than the column", async () => {
  const route = await read("app/api/workspace/route.ts");
  // `day_rate_pence` is a 4-byte integer on Postgres. SQLite hides that; the
  // deployed database does not, and the catch below returns `error.message`.
  assert.match(route, /const MAX_DAY_RATE_PENCE = 2_147_483_647;/);
  assert.match(route, /function contractorRateRefusal\(/);
  const guard = route.slice(route.indexOf("function contractorRateRefusal"));
  assert.match(
    guard.slice(0, 400),
    /if \(pence === null\) return null;/,
    "an empty box, a negative and a word keep the behaviour they have",
  );
});

// ---------------------------------------------------------------------------
// Behavioural — needs a dev server
// ---------------------------------------------------------------------------

async function ready(t) {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${CANDIDATES.join(", ")}`);
    return false;
  }
  if (!(await signIn())) {
    t.skip(`could not sign in as ${EMAIL} on ${BASE_URL}`);
    return false;
  }
  return true;
}

test("an unreadable `active` cannot put an archived contractor back on the register", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Active`, availability: "Available" });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { active: false })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).active, false);

  // The reported defect, and its whole family. `booleanValue` answered TRUE for
  // every one of these.
  for (const value of [null, "no", "0", [], {}, 2, "yes"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { active: value });
    assert.equal(refused.status, 400, `active: ${JSON.stringify(value)} must be refused`);
    assert.match(refused.body.error, /must be true or false/);
    assert.equal(
      (await readContractor(PRIMARY_ORGANISATION_ID, id)).active,
      false,
      `active: ${JSON.stringify(value)} must not have written anything`,
    );
  }

  // And everything `booleanValue` genuinely reads still works, both ways.
  for (const [value, expected] of [[true, true], ["false", false], [1, true], [0, false], ["true", true], [false, false]]) {
    const ok = await patch(PRIMARY_ORGANISATION_ID, id, { active: value, availability: "Available" });
    assert.equal(ok.status, 200, `active: ${JSON.stringify(value)} is readable`);
    assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).active, expected);
  }

  // The create is guarded too — that is where the row gets its first state.
  const badCreate = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Active Create`, active: null });
  assert.equal(badCreate.status, 400, "a create cannot guess `active` either");
});

test("`availability` and `name` cannot be emptied into their NOT NULL columns", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} NotNull`, availability: "Available" });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  for (const value of [null, "", "   ", 0, []]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { availability: value });
    assert.equal(refused.status, 400, `availability: ${JSON.stringify(value)} must be refused`);
    const row = await readContractor(PRIMARY_ORGANISATION_ID, id);
    assert.equal(row.availability, "Available", "and the column keeps the state it had");
  }
  for (const value of [null, "", "   ", 7]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { name: value });
    assert.equal(refused.status, 400, `name: ${JSON.stringify(value)} must be refused`);
    assert.equal(
      (await readContractor(PRIMARY_ORGANISATION_ID, id)).name,
      `${RUN} NotNull`,
      "the register's only identifier is not blankable",
    );
  }

  // The four the Availability select actually offers all still save.
  for (const value of ["Available", "Limited", "Unavailable", "Inactive"]) {
    assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { availability: value })).status, 200);
    assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).availability, value);
  }
});

test("a stale save cannot undo an archive", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Stale`,
    phone: "+44 7700 900100",
    availability: "Available",
  });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  assert.equal((await archive(PRIMARY_ORGANISATION_ID, id)).status, 200);
  let row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.active, false, "archiving clears the record state");
  assert.equal(row.availability, "Inactive", "and marks it, in the same statement");

  // The payload found in `activity_log`: a whole record, carrying a stale
  // `active: true` beside the availability the archive wrote.
  const stale = await patch(PRIMARY_ORGANISATION_ID, id, {
    name: `${RUN} Stale`,
    phone: "+44 7700 900100",
    availability: "Inactive",
    active: true,
  });
  assert.equal(stale.status, 409, `a stale resurrection must be refused: ${JSON.stringify(stale.body)}`);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).active, false, "and nothing was written");

  // The same request with availability left out is the same request: the stored
  // value is what the result would carry.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { active: true })).status, 409);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).active, false);

  // An edit that does not touch `active` is not this rule's business.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { phone: "+44 7700 900222" })).status, 200);
  row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.phone, "+44 7700 900222");
  assert.equal(row.active, false, "and it stays archived");

  // Restoring somebody deliberately — saying what they are now — still works.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { active: true, availability: "Available" })).status, 200);
  row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.active, true);
  assert.equal(row.availability, "Available");

  /*
   * And an ACTIVE contractor may still be marked 'Inactive' for the week. That
   * is one of the four states the select offers, it is a day-to-day answer, and
   * a rule that forbade it would take a working control away.
   */
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { availability: "Inactive" })).status, 200);
  row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.active, true, "a row already in that pairing stays editable");
  assert.equal(row.availability, "Inactive");
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { notes: "still editable" })).status, 200);
});

test("a contractor's email is refused when it is a string nobody can be reached on", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Email`, email: "dan@example.com" });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  for (const value of ["@", "a@", "@b", " ", "a​b@c.com", "a@b", "a b@c.com"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { email: value });
    assert.equal(refused.status, 400, `email: ${JSON.stringify(value)} must be refused`);
    assert.match(refused.body.error, /working address/);
    assert.equal(
      (await readContractor(PRIMARY_ORGANISATION_ID, id)).email,
      "dan@example.com",
      "and the address that was there is untouched",
    );
    // Not the driver's words, and not the schema's.
    assert.doesNotMatch(JSON.stringify(refused.body), /contractors|organisation_id|SELECT|INSERT|UPDATE|sqlite|postgres/i);
  }

  // Clearing it is not the same as breaking it. Both spellings stay allowed.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { email: "" })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).email, null);
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { email: "ops@apex.co.uk" })).status, 200);
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { email: null })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).email, null);

  // And the create refuses what the edit refuses, or a row could not be saved
  // again after it was made.
  assert.equal((await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Email Create`, email: "@" })).status, 400);
  assert.equal((await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Email Blank`, email: "" })).status, 200);
});

test("a partial contractor PATCH preserves every field it did not mention", async (t) => {
  if (!(await ready(t))) return;

  const full = {
    name: `${RUN} Matrix`,
    contactName: "Dan Matrix",
    email: "dan@zzqa-matrix.example",
    phone: "+44 7700 900100",
    whatsappNumber: "+44 7700 900101",
    address: "12 Matrix Way, Leeds",
    notes: "Keyholder. Call before 7am.",
    dayRate: "320",
    serviceCategories: "Electrical, HVAC",
    coverageAreas: "UK, London",
    certifications: "18th Edition, Public liability verified",
    insuranceExpiry: "2027-03-31",
    availability: "Available",
    rating: "4",
    active: true,
  };
  const made = await create(PRIMARY_ORGANISATION_ID, full);
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  // [key sent, value sent, the ONE column allowed to move]
  const cases = [
    ["name", `${RUN} Matrix renamed`, "name"],
    ["phone", "+44 7700 900222", "phone"],
    ["whatsappNumber", "+44 7700 900333", "whatsapp_number"],
    ["email", "new@zzqa-matrix.example", "email"],
    ["availability", "Limited", "availability"],
    ["active", false, "active"],
    ["insuranceExpiry", "2028-01-15", "insurance_expiry"],
    ["serviceCategories", "Plumbing", "service_categories"],
    ["coverageAreas", "Midlands", "coverage_areas"],
    ["notes", "Different note entirely.", "notes"],
    ["contactName", "Sam Matrix", "contact_name"],
    ["address", "99 Other Road, Leeds", "address"],
    ["dayRate", "450", "day_rate_pence"],
    ["rating", "2", "rating"],
  ];

  for (const [key, value, column] of cases) {
    const before = await readContractor(PRIMARY_ORGANISATION_ID, id);
    const result = await patch(PRIMARY_ORGANISATION_ID, id, { [key]: value });
    assert.equal(result.status, 200, `PATCH { ${key} } failed: ${JSON.stringify(result.body)}`);
    const after = await readContractor(PRIMARY_ORGANISATION_ID, id);

    const moved = Object.keys(before).filter((name) => before[name] !== after[name]);
    assert.deepEqual(
      moved,
      [column],
      `PATCH { ${key} } moved ${JSON.stringify(moved)}; only ${column} was sent`,
    );

    // Put it back, so the next case starts from the same row. `active` takes
    // its availability with it — restoring an archived row is a decision.
    const restore = { [key]: full[key], ...(key === "active" ? { availability: full.availability } : {}) };
    assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, restore)).status, 200);
  }

  // A PATCH that mentions nothing at all is a no-op, not a blanking.
  const before = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, {})).status, 200);
  assert.deepEqual(await readContractor(PRIMARY_ORGANISATION_ID, id), before);
});

test("a contractor belonging to another organisation is refused, and not touched", async (t) => {
  if (!(await ready(t))) return;

  // The subject lives in the demo tenant. The owner is a super admin of both,
  // so this exercises the guard on the WRITE rather than the sign-in.
  const made = await create(DEMO_ORGANISATION_ID, {
    name: `${RUN} Foreign`,
    email: "foreign@example.com",
    availability: "Limited",
    active: true,
  });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;
  const before = await readContractor(DEMO_ORGANISATION_ID, id);
  assert.ok(before, "the fixture must exist before anything destructive runs");

  const foreignPatch = await patch(PRIMARY_ORGANISATION_ID, id, {
    name: "HACKED",
    notes: "pwned",
    active: false,
    availability: "Unavailable",
  });
  assert.equal(foreignPatch.status, 404, "another tenant's contractor does not exist to this caller");
  const foreignArchive = await archive(PRIMARY_ORGANISATION_ID, id);
  assert.equal(foreignArchive.status, 404, "nor can it be archived");

  assert.deepEqual(await readContractor(DEMO_ORGANISATION_ID, id), before, "and nothing moved");

  /*
   * The half that was invisible. The scoped WHERE always made this a nought-row
   * no-op — but the route answered 200 and `logChange` then filed the caller's
   * own payload into THIS organisation's activity feed as a change that had
   * happened. An audit trail that records edits that did not occur is worse
   * than one that records nothing.
   */
  const activity = await call("GET", PRIMARY_ORGANISATION_ID);
  const invented = (activity.body.workspace?.activity ?? []).filter((entry) => entry.entityId === id);
  assert.equal(invented.length, 0, `no activity may be logged for a refused mutation: ${JSON.stringify(invented)}`);

  // An id that exists nowhere answers the same way, so the reply never tells a
  // caller which ids live inside a tenant they cannot read.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, "contractor-does-not-exist", { name: "x" })).status, 404);
  assert.equal((await archive(PRIMARY_ORGANISATION_ID, "contractor-does-not-exist")).status, 404);
});

test("an unauthenticated caller cannot create, edit or archive a contractor", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Anon`, availability: "Available" });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  for (const [method, body] of [
    ["POST", { entity: "contractor", data: { name: `${RUN} Anon Create` } }],
    ["PATCH", { entity: "contractor", id, data: { name: "hijacked", active: false } }],
    ["DELETE", { entity: "contractor", id }],
  ]) {
    const response = await fetch(`${BASE_URL}/api/workspace`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401, `${method} with no session must be a refusal, not a 500`);
    const parsed = await response.json();
    assert.doesNotMatch(
      JSON.stringify(parsed),
      /contractors|organisation_id|SELECT|INSERT|UPDATE|sqlite|postgres|at Object\./i,
      "and it must not describe the database",
    );
  }
  const row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.name, `${RUN} Anon`);
  assert.equal(row.active, true);
});

test("a refusal on a contractor path never describes the database", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Leak`, availability: "Available" });
  assert.equal(made.status, 200, `fixture creation failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  const probes = [
    { dayRate: 1e308 },
    { dayRate: 9e15 },
    { dayRate: 30_000_000 },
    { name: null },
    { availability: null },
    { active: null },
    { email: "@" },
    { serviceCategories: { a: 1 } },
    { insuranceExpiry: "not-a-date" },
    { rating: "abc" },
  ];
  for (const data of probes) {
    const result = await patch(PRIMARY_ORGANISATION_ID, id, data);
    assert.notEqual(result.status, 500, `${JSON.stringify(data)} must not be a server error`);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /SELECT |INSERT |UPDATE |D1_ERROR|SQLITE|sqlite3|constraint failed|out of range|\bat [A-Za-z]+ \(/i,
      `${JSON.stringify(data)} leaked the driver: ${JSON.stringify(result.body)}`,
    );
  }

  // The overflow specifically: `day_rate_pence` is a 4-byte integer on Postgres
  // and the deployed database would have raised this itself.
  const overflow = await patch(PRIMARY_ORGANISATION_ID, id, { dayRate: 30_000_000 });
  assert.equal(overflow.status, 400);
  assert.match(overflow.body.error, /day rate/i);
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { dayRate: "320" })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).day_rate_pence, 32000);
});

test("a contractor is created from a name alone, in the actor's organisation only", async (t) => {
  if (!(await ready(t))) return;

  assert.equal((await create(PRIMARY_ORGANISATION_ID, {})).status, 400, "a name is the one required field");

  const minimal = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Minimal` });
  assert.equal(minimal.status, 200, `omitting every optional must be allowed: ${JSON.stringify(minimal.body)}`);
  const row = await readContractor(PRIMARY_ORGANISATION_ID, minimal.body.id);
  assert.equal(row.availability, "Available", "the NOT NULL columns take their defaults");
  assert.equal(row.service_categories, "[]");
  assert.equal(row.active, true);

  // It is in the payload the register reads, not just in the table.
  const listed = await call("GET", PRIMARY_ORGANISATION_ID);
  assert.ok(
    listed.body.workspace.contractors.some((entry) => entry.id === minimal.body.id),
    "a new contractor must appear in GET /api/workspace",
  );

  /*
   * The organisation is the actor's, whatever the body says. The insert names
   * `organisationId: orgId` explicitly and never spreads `data`, so neither
   * spelling of the key reaches the column — asserted because the alternative
   * is a row filed in a tenant the caller chose for themselves.
   */
  const injected = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Injected`,
    organisationId: DEMO_ORGANISATION_ID,
    organisation_id: DEMO_ORGANISATION_ID,
    id: "contractor-chosen-by-the-caller",
  });
  assert.equal(injected.status, 200);
  assert.ok(await readContractor(PRIMARY_ORGANISATION_ID, injected.body.id), "the row is in the actor's organisation");
  assert.equal(await readContractor(DEMO_ORGANISATION_ID, injected.body.id), undefined, "and not in the named one");
  assert.notEqual(injected.body.id, "contractor-chosen-by-the-caller", "nor is the id the caller's to choose");
});
