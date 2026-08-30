import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * A partial save of a site stops emptying the record it was meant to edit.
 *
 * WHY THIS FILE EXISTS AND WHY IT BUILDS ITS OWN FIXTURE. Every site in the
 * canonical register has `region = 'UK'` and no coordinates. Those are exactly
 * the three columns the bug destroyed — `region` reverted to the literal "UK"
 * and `latitude`/`longitude` were nulled — so on the real data the bug and the
 * fix are indistinguishable. A test written against the register would have
 * passed before the fix and after it, and proved nothing.
 *
 * So the fixture below is deliberately un-British: region 'Europe', a French
 * address, and real coordinates. Every column it can hold is populated, because
 * the failure mode is a column quietly becoming null and you cannot see that in
 * a column that was already null.
 *
 * BOTH DIRECTIONS ARE ASSERTED. An omitted key must PRESERVE what is stored; a
 * key sent as "" or null must still CLEAR it. A fix that refuses to ever clear
 * a field is not a fix, it is the same bug pointing the other way — a user who
 * cannot delete a postcode is as badly served as one whose postcode is deleted
 * for them.
 *
 * Needs a dev server and skips without one, the bargain
 * `member-partial-patch.test.mjs` already makes. Its fixture is hard-deleted in
 * `after()`, because a site is archived rather than deleted by the product and
 * would otherwise survive its own cleanup.
 */

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/** A marker every fixture carries, so a stray row is traceable to this run. */
const RUN = `w5patch-${Date.now().toString(36)}`;
const SITE_NAME = `${RUN} QA Site`;

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
 * A transient fault from the development database, as opposed to a refusal.
 *
 * `node --test tests/*.test.mjs` runs FILES in parallel, and every behavioural
 * suite in this repo drives the one development server, whose D1 is a single
 * SQLite file. Two suites writing at once produce a lock failure, and the site
 * route answers it with the Drizzle wrapper message — `Failed query: update
 * "sites" set …` — at status 400.
 *
 * Retried rather than asserted on, because the property under test is what a
 * SAVE does to a row, not how the server behaves under contention. A real
 * refusal ("A site name is required.") does not match this and is never
 * retried, so nothing this file is meant to catch is hidden.
 *
 * That the raw statement is visible here at all is its own defect and is
 * asserted separately in `workstream-five-sites.test.mjs` — the write verbs
 * return `error.message` verbatim while GET routes it through
 * `sitesDatabaseError`, which is the helper that exists to stop exactly this.
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

/**
 * The fixture, as sent to POST /api/sites.
 *
 * `serviceCharge` and `annualBudget` are POUNDS here because that is what the
 * form sends and what the route multiplies by 100. Read back, they are pence.
 */
const FIXTURE = {
  code: `${RUN.slice(-3).toUpperCase()}`,
  siteTypeValue: "Kiosk",
  status: "active",
  addressLine1: "1 Rue de la Paix",
  addressLine2: "Etage 2",
  city: "Paris",
  postcode: "75002",
  country: "France",
  region: "Europe",
  latitude: 48.8698,
  longitude: 2.3312,
  managerName: "QA Manager",
  managerPhone: "0700000001",
  managerEmail: "qa@example.com",
  landlord: "QA Landlord",
  managingAgent: "QA Agent",
  outOfHoursContact: "0700000002",
  accessContact: "qa-access@example.com",
  accessUrl: "https://example.com/qa",
  accessNotes: "QA access notes",
  openingHours: "09:00-18:00",
  deliveryRestrictions: "No deliveries before 10",
  parkingNotes: "Underground bay 4",
  keyAlarmNotes: "Alarm code with security",
  leaseStart: "2024-01-01",
  leaseEnd: "2030-12-31",
  breakClause: "Year 5",
  rentReview: "Year 3",
  serviceCharge: "1234.56",
  annualBudget: "9876.54",
  mondayMaintenanceName: `${RUN} Maint`,
  mondayComplianceName: `${RUN} Comp`,
  notes: "QA notes",
};

/** The stored columns a save must not silently move. */
const WATCHED = [
  "name", "code", "siteTypeValue", "type", "status", "lifecycle", "active",
  "region", "country", "latitude", "longitude",
  "addressLine1", "addressLine2", "city", "postcode",
  "serviceChargePence", "annualBudgetPence",
  "managerName", "managerPhone", "managerEmail", "landlord", "managingAgent",
  "outOfHoursContact", "accessContact", "accessUrl", "accessNotes",
  "openingHours", "deliveryRestrictions", "parkingNotes", "keyAlarmNotes",
  "leaseStart", "leaseEnd", "breakClause", "rentReview",
  "mondayMaintenanceName", "mondayComplianceName", "notes",
];

let siteId = null;

async function snapshot() {
  const { body } = await call("GET", `/api/sites?id=${siteId}`);
  if (!body?.site) return null;
  return Object.fromEntries(WATCHED.map((key) => [key, body.site[key]]));
}

function movedColumns(before, after) {
  return WATCHED.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** Put the fixture back to its full state between scenarios. */
async function restore() {
  await call("PATCH", "/api/sites", { id: siteId, data: { name: SITE_NAME, ...FIXTURE } });
}

async function setUp(t) {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return false;
  }
  await signIn();
  if (!cookie) {
    t.skip("could not sign in to the development server");
    return false;
  }
  if (siteId) return true;
  const created = await call("POST", "/api/sites", {
    data: { name: SITE_NAME, ...FIXTURE },
    confirmDuplicate: true,
  });
  if (created.status !== 200 || !created.body?.id) {
    t.skip(`could not create the fixture site: ${JSON.stringify(created.body).slice(0, 160)}`);
    return false;
  }
  siteId = created.body.id;
  return true;
}

test("the fixture is stored exactly as it was sent", async (t) => {
  if (!(await setUp(t))) return;
  const site = await snapshot();
  assert.ok(site, "the fixture must be readable");
  assert.equal(site.region, "Europe", "a region that is not the default is what makes this test able to fail");
  assert.equal(site.latitude, 48.8698);
  assert.equal(site.longitude, 2.3312);
  assert.equal(site.country, "France");
  assert.equal(site.serviceChargePence, 123456, "pounds in, pence stored");
  assert.equal(site.annualBudgetPence, 987654);
});

test("a PATCH carrying one field moves that field and nothing else", async (t) => {
  if (!(await setUp(t))) return;
  await restore();
  const before = await snapshot();
  const response = await call("PATCH", "/api/sites", { id: siteId, data: { notes: "edited" } });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 200));
  const after = await snapshot();
  assert.deepEqual(movedColumns(before, after), ["notes"], "only `notes` may have moved");
  assert.equal(after.notes, "edited");
});

test("a PATCH carrying nothing at all moves nothing at all", async (t) => {
  if (!(await setUp(t))) return;
  await restore();
  const before = await snapshot();
  const response = await call("PATCH", "/api/sites", { id: siteId, data: {} });
  assert.equal(response.status, 200);
  const after = await snapshot();
  assert.deepEqual(movedColumns(before, after), [], "an empty edit is a no-op");
});

test("region and the coordinates survive an edit that does not mention them", async (t) => {
  if (!(await setUp(t))) return;
  await restore();
  /*
   * The bug, stated as a test. `region` came back as the literal "UK" and the
   * coordinates came back null, because `text(undefined, 60) || "UK"` and
   * `optionalNumber(undefined)` cannot tell an absent key from a cleared one.
   */
  const response = await call("PATCH", "/api/sites", { id: siteId, data: { name: SITE_NAME } });
  assert.equal(response.status, 200);
  const after = await snapshot();
  assert.equal(after.region, "Europe", "region must not revert to the default");
  assert.equal(after.latitude, 48.8698, "latitude must not be nulled");
  assert.equal(after.longitude, 2.3312, "longitude must not be nulled");
  assert.equal(after.country, "France", "country must not revert to United Kingdom");
  assert.equal(after.code, FIXTURE.code, "the site code must survive");
});

test("a save that sends the whole Sites form unchanged changes nothing", async (t) => {
  if (!(await setUp(t))) return;
  await restore();
  /*
   * The payload the real screen sends — `initialState()` in
   * app/(app)/portal/sites/site-form.tsx, built from the row itself. It has 33
   * keys and latitude/longitude are NOT among them, which is why opening a site
   * and pressing Save used to erase its coordinates.
   */
  const { body } = await call("GET", `/api/sites?id=${siteId}`);
  const site = body.site;
  const form = {
    name: site.name ?? "",
    code: site.code ?? "",
    siteTypeValue: site.siteTypeValue ?? site.type ?? "",
    status: site.status ?? "",
    addressLine1: site.addressLine1 ?? "",
    addressLine2: site.addressLine2 ?? "",
    city: site.city ?? "",
    postcode: site.postcode ?? "",
    country: site.country ?? "United Kingdom",
    region: site.region ?? "UK",
    managerName: site.managerName ?? "",
    managerPhone: site.managerPhone ?? "",
    managerEmail: site.managerEmail ?? "",
    landlord: site.landlord ?? "",
    managingAgent: site.managingAgent ?? "",
    outOfHoursContact: site.outOfHoursContact ?? "",
    accessMethod: site.accessMethod ?? "",
    accessContact: site.accessContact ?? "",
    accessUrl: site.accessUrl ?? "",
    accessNotes: site.accessNotes ?? "",
    openingHours: site.openingHours ?? "",
    deliveryRestrictions: site.deliveryRestrictions ?? "",
    parkingNotes: site.parkingNotes ?? "",
    keyAlarmNotes: site.keyAlarmNotes ?? "",
    leaseStart: site.leaseStart ?? "",
    leaseEnd: site.leaseEnd ?? "",
    breakClause: site.breakClause ?? "",
    rentReview: site.rentReview ?? "",
    serviceCharge:
      site.serviceChargePence == null ? "" : (site.serviceChargePence / 100).toFixed(2),
    annualBudget:
      site.annualBudgetPence == null ? "" : (site.annualBudgetPence / 100).toFixed(2),
    mondayMaintenanceName: site.mondayMaintenanceName ?? "",
    mondayComplianceName: site.mondayComplianceName ?? "",
    notes: site.notes ?? "",
  };
  assert.ok(!("latitude" in form), "the form does not carry latitude — that is the point");
  assert.ok(!("longitude" in form), "nor longitude");

  const before = await snapshot();
  const response = await call("PATCH", "/api/sites", {
    id: siteId,
    data: { ...form, groupIds: [] },
    confirmDuplicate: false,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 200));
  const after = await snapshot();
  assert.deepEqual(movedColumns(before, after), [], "opening a site and pressing Save is a no-op");
});

test("a field sent empty is still cleared — the fix does not over-correct", async (t) => {
  if (!(await setUp(t))) return;

  /*
   * The other direction. If an omitted key preserves, the temptation is to make
   * a blank key preserve too, and then a user can never delete a postcode. Each
   * case below sends the field EXPLICITLY, and each must take effect.
   */
  const cases = [
    ["an empty string clears a text column", { postcode: "" }, "postcode", null],
    ["null clears a text column", { notes: null }, "notes", null],
    ["an empty string clears a number column", { latitude: "" }, "latitude", null],
    ["an empty string clears the second number column", { longitude: "" }, "longitude", null],
    ["an empty string clears the site code", { code: "" }, "code", null],
    ["an empty string clears a money column", { serviceCharge: "" }, "serviceChargePence", null],
    ["a new value replaces a stored one", { city: "Lyon" }, "city", "Lyon"],
  ];

  for (const [label, data, column, expected] of cases) {
    await restore();
    const response = await call("PATCH", "/api/sites", { id: siteId, data });
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body).slice(0, 160)}`);
    const after = await snapshot();
    assert.deepEqual(after[column], expected, label);
  }
  await restore();
});

test("closing and reopening a site touches only the three state columns", async (t) => {
  if (!(await setUp(t))) return;
  await restore();

  const before = await snapshot();
  const closed = await call("DELETE", "/api/sites", { id: siteId });
  assert.equal(closed.status, 200);
  const afterClose = await snapshot();
  assert.deepEqual(
    movedColumns(before, afterClose).sort(),
    ["active", "lifecycle", "status"],
    "archiving must not touch anything but the state trio",
  );
  assert.equal(afterClose.status, "closed");
  assert.equal(afterClose.lifecycle, "Closed");
  assert.equal(afterClose.active, false);
  assert.equal(afterClose.region, "Europe", "archiving must not reset the region");
  assert.equal(afterClose.latitude, 48.8698, "archiving must not null the coordinates");

  const reopened = await call("PATCH", "/api/sites", { id: siteId, data: { status: "active" } });
  assert.equal(reopened.status, 200);
  const afterReopen = await snapshot();
  assert.deepEqual(
    movedColumns(afterClose, afterReopen).sort(),
    ["active", "lifecycle", "status"],
    "reopening must not touch anything but the state trio",
  );
  assert.equal(afterReopen.active, true);
});

test("assigning and clearing reporting groups does not touch the site row", async (t) => {
  if (!(await setUp(t))) return;
  await restore();
  const { body } = await call("GET", "/api/sites");
  const groups = body?.groups ?? [];
  if (!groups.length) {
    t.skip("this workspace has no reporting groups");
    return;
  }
  const before = await snapshot();
  const assigned = await call("PATCH", "/api/sites", {
    id: siteId,
    data: { groupIds: [groups[0].id] },
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(movedColumns(before, await snapshot()), [], "a group assignment is not a site edit");

  const detail = await call("GET", `/api/sites?id=${siteId}`);
  assert.deepEqual(detail.body.groupIds, [groups[0].id], "the membership must have been recorded");

  const cleared = await call("PATCH", "/api/sites", { id: siteId, data: { groupIds: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(movedColumns(before, await snapshot()), [], "clearing them is not a site edit either");
  const after = await call("GET", `/api/sites?id=${siteId}`);
  assert.deepEqual(after.body.groupIds, [], "and the membership must be gone");
});

test("a CSV import changes the columns its sheet carries and no others", async (t) => {
  if (!(await setUp(t))) return;
  await restore();

  const sheet = (headers, cells) => `${headers}\n${SITE_NAME},1 Rue de la Paix,${cells}\n`;
  const importCsv = (csv) => call("POST", "/api/sites/csv", { csv, dryRun: false });

  // A dry run must never write.
  const before = await snapshot();
  const dry = await call("POST", "/api/sites/csv", {
    csv: sheet("name,address_line1,notes", "changed by the dry run"),
    dryRun: true,
  });
  assert.equal(dry.status, 200);
  assert.deepEqual(movedColumns(before, await snapshot()), [], "a dry run must not write");

  // An ABSENT column preserves.
  const narrow = await importCsv(sheet("name,address_line1,notes", "changed by csv"));
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body).slice(0, 200));
  assert.equal(narrow.body.updated, 1, "the sheet must have matched the fixture");
  const afterNarrow = await snapshot();
  assert.deepEqual(movedColumns(before, afterNarrow), ["notes"], "a narrow sheet edits only its own columns");
  assert.equal(afterNarrow.region, "Europe", "region must survive a sheet that does not carry it");
  assert.equal(afterNarrow.latitude, 48.8698, "and so must the coordinates");
  assert.equal(afterNarrow.code, FIXTURE.code, "and so must the site code");

  // A PRESENT-BUT-BLANK column still clears.
  await restore();
  const blank = await importCsv(sheet("name,address_line1,postcode", ""));
  assert.equal(blank.status, 200);
  const afterBlank = await snapshot();
  assert.equal(afterBlank.postcode, null, "a blank cell in a column the sheet carries still clears it");
  assert.equal(afterBlank.region, "Europe", "without disturbing a column the sheet does not carry");

  // A region column that IS carried is honoured in both directions.
  await restore();
  await importCsv(sheet("name,address_line1,region", "UK"));
  assert.equal((await snapshot()).region, "UK", "a sheet that states a region sets it");
  await restore();
  assert.equal((await snapshot()).region, "Europe", "and the fixture restores");
});

/**
 * The fixture, removed for good.
 *
 * A site is ARCHIVED rather than deleted by the product — that is the contract,
 * because jobs and compliance rows reference it — so the row would otherwise
 * survive its own cleanup and accumulate one per run. Aliases and group
 * memberships go first, then the activity log, then the row.
 */
after(async () => {
  if (!siteId) return;
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
    // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in it,
    // and a percent-encoded path opens nothing.
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    /*
     * THE LOCK IS THE WHOLE PROBLEM. The development server holds this file
     * open, and `node --test tests/*.test.mjs` runs suites in parallel, so a
     * bare DELETE here answers "database is locked" and — with the per-statement
     * catch below — fails SILENTLY. Measured: five fixture sites survived five
     * full-suite runs while the isolated run cleaned up perfectly, because only
     * the parallel runs were contended.
     *
     * `busy_timeout` makes SQLite wait for the writer instead of giving up, and
     * the retry covers the case where it waits and still loses. A cleanup that
     * can quietly do nothing is worse than no cleanup, because nobody looks.
     */
    try {
      db.exec("PRAGMA busy_timeout = 15000");
    } catch {
      // An older binding without the pragma still gets the retry below.
    }
    for (const statement of [
      "DELETE FROM site_aliases WHERE site_id = ?",
      "DELETE FROM site_group_members WHERE site_id = ?",
      "DELETE FROM activity_log WHERE entity_type = 'site' AND entity_id = ?",
      "DELETE FROM sites WHERE id = ?",
    ]) {
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          db.prepare(statement).run(siteId);
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
          `fixture cleanup could not run "${statement}" for ${siteId}: ${lastError.message}`,
        );
      }
    }
    const left = db.prepare("SELECT count(*) AS n FROM sites WHERE id = ?").get(siteId);
    if (left?.n) console.warn(`fixture site ${siteId} survived cleanup and must be removed by hand`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
