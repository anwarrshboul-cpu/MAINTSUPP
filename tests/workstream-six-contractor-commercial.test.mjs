import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * WORKSTREAM 5/6 — the contractor's commercial record, and the register that
 * shows it.
 *
 * W06-06, W06-07, W06-08 (the fields half), W06-09 and W06-04, plus W05-08's
 * mounting of the shared register on the Sites page. Five things were true
 * before this pass and none of them is now:
 *
 *  1. TEN COLUMNS EXISTED WITH NO WRITER. `postcode`, four cost columns, the
 *     two payment fields and the three insurance fields were on `contractors`
 *     and reachable from nothing: `PATCH /api/workspace { entity: "contractor" }`
 *     did not name one of them, so the register could DISPLAY them and no
 *     screen or API call could ever fill one in.
 *  2. `dayRatePence` WAS UNWRITABLE UNDER ITS OWN NAME. `GET` returns
 *     `dayRatePence`, `CONTRACTOR_NATIVE_COLUMNS` publishes that as the
 *     column's `nativeField`, and the PATCH accepted only `dayRate` in pounds
 *     — so the one field whose read name and write name disagreed was the one
 *     a register cell would have written back through.
 *  3. `insurance_expiry` WAS NOT A DATE. `optionalText(data.insuranceExpiry, 40)`
 *     on both create and edit, so `2027-13-45` stored happily — while
 *     `compliance` on the same route already ran `isRealCalendarDate` and
 *     refused the identical string. And `Date.UTC(2027, 12, 45)` does not
 *     throw: it rolls forward into February 2028, so the typo acquires a real
 *     expiry three months from the one anybody meant.
 *  4. AN EXPIRY NOBODY SAW. `insurance_expiry` appeared in one edit box and
 *     nowhere else — no column, no chip, no alert — so cover could lapse and
 *     the only way to find out was to open the record and read a date.
 *  5. UNTICKING "ACTIVE CONTRACTOR" ASKED NOTHING. It writes the same
 *     `active: false` the Archive button writes, and `assignableContractors`
 *     filters on `active` alone, so one unticked box removed a contractor from
 *     every assignment select with no dialog and no undo.
 *
 * Source assertions run everywhere. The behavioural tests need a dev server and
 * skip without one, which is the bargain the rest of this suite already makes.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Comments removed, so a pin cannot be satisfied — or tripped — by prose. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * Comments AND string literals removed — what is left is identifiers.
 *
 * The security pin below has to tell two things apart that a plain grep cannot:
 * a FIELD named after a payment credential, which must never exist, and the
 * sentence under the Finance reference box that says "Never record bank, sort
 * code, IBAN or card details here", which must. The first is an identifier and
 * the second is a string, so the pin is run over identifiers.
 */
const identifiers = (source) =>
  code(source)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";
const DEMO_ORGANISATION_ID = "org_000000000000000000000002";

// Found rather than assumed — vite takes the first free port from 5173 up.
const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [3000, 5173, 5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];

const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * The marker every fixture carries.
 *
 * The prefix is agreed across this wave; the suffix makes a row traceable to
 * one run. Nothing in this file EVER sweeps by it — see `after` — because a
 * substring sweep in this suite has repeatedly eaten another agent's fixtures.
 * It exists so a row that somehow escapes the cleanup can be identified by a
 * human, not so a DELETE can find it.
 */
const RUN = `ZZQA-W6-COMMERCIAL-${Date.now().toString(36)}`;

/** Every primary key this file created, and the only thing `after` deletes. */
const createdContractors = new Set();
const createdColumns = new Map();

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

async function callPath(path, method, orgId, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
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

const call = (method, orgId, body) => callPath("/api/workspace", method, orgId, body);

async function create(orgId, data) {
  const result = await call("POST", orgId, { entity: "contractor", data });
  if (result.status === 200 && typeof result.body.id === "string") {
    // Recorded the moment it exists, so a test that fails halfway still leaves
    // its id behind for the cleanup.
    createdContractors.add(result.body.id);
  }
  return result;
}

const patch = (orgId, id, data) => call("PATCH", orgId, { entity: "contractor", id, data });

/**
 * One contractor, read straight from the development database.
 *
 * Not through `GET /api/workspace`: that assembles the whole workspace — every
 * site, every compliance row, every job tally — and costs about a second, which
 * called after each of two dozen refusals would dominate the run and tie up the
 * one development server everything else in this suite shares.
 */
function openDatabase(readOnly) {
  let handle;
  return async function connect() {
    if (handle !== undefined) return handle;
    handle = null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
      const file = (await readdir(directory)).find(
        (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
      );
      if (file) {
        // `fileURLToPath`, not `URL.pathname`: this repo's path has a space in
        // it, and a percent-encoded path opens nothing.
        handle = new DatabaseSync(fileURLToPath(new URL(file, directory)), readOnly ? { readOnly: true } : {});
        if (!readOnly) {
          // The dev server holds this file open, so an unqualified write loses
          // the race and throws "database is locked".
          handle.exec("PRAGMA busy_timeout = 10000");
        }
      }
    } catch {
      handle = null;
    }
    return handle;
  };
}

const reader = openDatabase(true);

async function readContractor(orgId, id) {
  const db = await reader();
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT name, address, postcode, notes, day_rate_pence, hourly_rate_pence,
              call_out_cost_pence, other_cost_pence, other_cost_label,
              payment_terms, finance_reference, insurer_name, policy_number,
              insurance_notes, insurance_expiry, service_categories,
              certifications, availability, active
         FROM contractors WHERE id = ? AND organisation_id = ?`,
    )
    .get(id, orgId);
  return row ? { ...row, active: !!row.active } : undefined;
}

async function readCertifications(orgId, contractorId) {
  const db = await reader();
  if (!db) return null;
  return db
    .prepare(
      `SELECT id, name, reference, issued_on, expires_on, position
         FROM contractor_certifications
        WHERE contractor_id = ? AND organisation_id = ?
        ORDER BY position`,
    )
    .all(contractorId, orgId);
}

/**
 * Every fixture this file created, removed for good — BY EXACT PRIMARY KEY.
 *
 * Never `LIKE 'ZZQA-%'` and never a name match of any kind. This suite's
 * history is that a filename- or name-substring sweep eventually eats another
 * agent's fixtures, and a cleanup that can do that is more dangerous than the
 * rows it removes. Only ids this run put in the two sets above are touched.
 *
 * A contractor is never deleted by the product — archiving sets
 * `active: false, availability: 'Inactive'` — so the rows would otherwise
 * survive their own cleanup and accumulate across runs. Under the register's
 * name guard that is worse than untidy: next run's fixtures would collide with
 * this run's and be refused, and the suite would fail against a product
 * behaving correctly.
 *
 * THE RESIDUE IS ASSERTED, not warned about. A cleanup that quietly failed
 * would leave the next run to discover it.
 */
after(async () => {
  if (!createdContractors.size && !createdColumns.size) return;
  const db = await openDatabase(false)();
  assert.ok(db, "the development database must be reachable to clean up fixtures");
  for (const id of createdContractors) {
    db.prepare("DELETE FROM contractor_certifications WHERE contractor_id = ?").run(id);
    db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
    db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
  }
  for (const [id, key] of createdColumns) {
    db.prepare("DELETE FROM register_values WHERE column_key = ?").run(key);
    db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
    db.prepare("DELETE FROM register_columns WHERE id = ?").run(id);
  }
  for (const id of createdContractors) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM contractors WHERE id = ?").get(id).n,
      0,
      `fixture contractor ${id} survived cleanup`,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM contractor_certifications WHERE contractor_id = ?").get(id).n,
      0,
      `certifications for ${id} survived cleanup`,
    );
  }
  for (const id of createdColumns.keys()) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM register_columns WHERE id = ?").get(id).n,
      0,
      `fixture register column ${id} survived cleanup`,
    );
  }
  db.close();
});

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

/**
 * THE SECURITY PIN. This one is not about a feature working.
 *
 * The owner-approved payment model is TERMS plus an EXTERNAL accounting
 * reference, and it is approved precisely because the alternative — a bank
 * account number, a sort code, an IBAN or a card detail on a maintenance
 * portal's contractor table — is a breach waiting for its first misconfigured
 * backup. The accounting system that already holds those is built for them.
 *
 * So this asserts the ABSENCE, across the schema, the migration, the route that
 * writes the record, the type it travels as and the form that edits it.
 * Comments are stripped first: the files above say in prose that they hold no
 * bank details, and a pin that tripped on its own explanation would be deleted
 * by the next person rather than obeyed.
 */
test("W06-09: no bank, sort code, IBAN or card field exists anywhere on a contractor", async () => {
  const forbidden = [
    /\bIBAN\b/i,
    /sort_?code/i,
    /account_?number/i,
    /bank_?(account|details|name)/i,
    /card_?number/i,
    /\bcvv\b|\bcvc\b/i,
    /routing_?number/i,
  ];
  /*
   * TWO PASSES, because a column name IS a string.
   *
   * The schema and the migration name their columns in string literals —
   * `text("finance_reference")`, `finance_reference TEXT` — so those two are
   * scanned whole, comments aside. They carry no user-facing prose, so nothing
   * legitimate can trip the patterns.
   *
   * The route, the type and the form are scanned as IDENTIFIERS, because the
   * form deliberately CONTAINS the words: the hint under the Finance reference
   * box tells whoever is typing never to put bank, sort code, IBAN or card
   * details in it. A pin that refused that sentence would be a pin that deleted
   * the warning.
   */
  for (const path of ["db/schema.ts", "db/init.ts"]) {
    const source = code(await read(path));
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} must hold no payment credential (${pattern})`);
    }
  }
  for (const path of [
    "app/api/workspace/route.ts",
    "app/lib/workspace-data.ts",
    "app/(app)/portal/workspace-data-manager.tsx",
  ]) {
    const source = identifiers(await read(path));
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} must name no payment credential (${pattern})`);
    }
  }

  // And the approved pair IS there, on all four surfaces.
  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /paymentTerms: optionalText\(data\.paymentTerms, 60\)/, "terms are written on create");
  assert.match(route, /financeReference: optionalText\(data\.financeReference, 80\)/, "and the reference");
  assert.match(route, /supplied\(data, "paymentTerms"/, "and both are partial-PATCH safe");
  assert.match(route, /supplied\(data, "financeReference"/);
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(form, /key: "paymentTerms"[\s\S]{0,120}type: "select"/, "terms are a controlled select");
  assert.match(form, /key: "financeReference"/);
  assert.match(
    form,
    /Never record bank, sort code, IBAN or card details here\./,
    "and the form says so where somebody typing would read it",
  );
});

test("W06-09: payment terms come from the option set, not from a literal", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /function contractorPaymentTermsRefusal\(/);
  assert.match(
    route,
    /listOptionValues\(db, orgId, "contractor_payment_terms"\)/,
    "validated against whatever Settings configures, not a hardcoded list",
  );
  const init = await read("db/init.ts");
  assert.match(init, /contractor_payment_terms: \[/, "and the set is seeded");
  for (const term of ["On completion", "7 days", "14 days", "30 days", "60 days", "Other"]) {
    assert.match(init, new RegExp(`"${term}"`), `${term} is one of the seeded terms`);
  }
});

test("W06-07: every agreed cost is integer pence, under one ceiling", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  // The bound is REUSED rather than restated — four 4-byte integer columns, one
  // ceiling, so a second one cannot drift out of step with the first.
  assert.match(route, /const MAX_DAY_RATE_PENCE = 2_147_483_647;/);
  assert.match(route, /function contractorCostRefusal\(/);
  const costs = route.slice(route.indexOf("const CONTRACTOR_COSTS"), route.indexOf("function wholePence"));
  for (const column of [
    "dayRatePence",
    "hourlyRatePence",
    "callOutCostPence",
    "otherCostPence",
  ]) {
    assert.match(costs, new RegExp(`column: "${column}"`), `${column} is one of the four`);
  }
  // Pounds is scaled, pence is only rounded. Scaling both is the bug that
  // multiplied a site's service charge by a hundred on every read-edit-save.
  assert.match(route, /function wholePence\(/);
  assert.match(route, /return Math\.round\(parsed\);/);
  assert.match(
    route,
    /if \(cost\.pounds in data\) return ratePence\(data\[cost\.pounds\]\);/,
    "pounds wins when both spellings arrive, as it does on sites",
  );

  // Nothing sums an agreed rate. This is the invariant the reports pass proved
  // and it has to survive four more rate columns arriving.
  for (const path of ["app/lib/contractor-attribution.ts"]) {
    assert.doesNotMatch(
      code(await read(path)),
      /dayRatePence|callOutCostPence|hourlyRatePence|otherCostPence/,
      `${path} computes spend from job cost alone`,
    );
  }
});

test("W06-07: the other cost carries its own label, and never borrows notes", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /otherCostLabel: optionalText\(data\.otherCostLabel, 80\)/, "written on create");
  assert.match(route, /supplied\(data, "otherCostLabel"/, "and on edit");
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(form, /key: "otherCostLabel", label: "Other cost is for"/);
  // The Notes box keeps its own purpose. A label buried in prose is a label no
  // column, filter or report can read.
  assert.match(form, /key: "notes", label: "Notes", type: "textarea"/);
});

test("W06-06: a postcode is optional, and non-UK formats are not refused", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(route, /function contractorPostcodeRefusal\(/);
  const shape = /const CONTRACTOR_POSTCODE_SHAPE = (\/.*\/);/.exec(route);
  assert.ok(shape, "the shape is a named constant, so this test can run it");
  const pattern = new RegExp(shape[1].slice(1, shape[1].lastIndexOf("/")));
  for (const good of ["SW1A 1AA", "EC1A1BB", "75008", "1012 AB", "K1A 0B1", "100-0001", "10115"]) {
    assert.equal(pattern.test(good), true, `${JSON.stringify(good)} is a postal code somewhere`);
  }
  for (const bad of ["<script>", "dan@example.com", "12 High Street, London, SW1A 1AA, UK"]) {
    assert.equal(pattern.test(bad), false, `${JSON.stringify(bad)} is not`);
  }
  assert.match(route, /supplied\(data, "postcode", contractorPostcode\)/, "partial-PATCH safe");
});

test("W06-06: trades are folded onto the contractor_trade set, and nothing is dropped", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /async function contractorTradeValues\(/);
  assert.match(route, /listOptionValues\(db, orgId, "contractor_trade"\)/);
  const fold = route.slice(route.indexOf("async function contractorTradeValues"));
  assert.match(
    fold.slice(0, 1400),
    /entry\.toLowerCase\(\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/,
    "case and spacing are folded, which is what stops three Electricals",
  );
  assert.match(
    fold.slice(0, 1400),
    /canonical\.get\(folded\) \?\? entry/,
    "and an unlisted value is KEPT as typed rather than refused or dropped",
  );

  // The eleven the public application form offers, seeded verbatim so an
  // applicant and the register mean the same thing by "Glazing".
  const applications = await read("app/api/contractor-applications/route.ts");
  const init = await read("db/init.ts");
  const trades = /const TRADES = \[([\s\S]*?)\] as const;/.exec(applications);
  assert.ok(trades, "the form's list is still a named constant");
  const offered = [...trades[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(offered.length, 11, "eleven trades on the form");
  const seeded = init.slice(init.indexOf("contractor_trade: ["));
  for (const trade of offered) {
    assert.match(seeded.slice(0, 1200), new RegExp(`"${trade.replace(/[&]/g, "&")}"`),
      `"${trade}" is in the seeded option set`);
  }

  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(form, /key: "serviceCategories",[\s\S]{0,80}type: "multiselect"/, "a controlled list, not a comma box");
  assert.match(
    form,
    /label: `\$\{entry\} \(not configured\)`/,
    "and a stored value the set no longer offers is still shown and still ticked",
  );
});

test("W06-08: an insurance expiry has to be a date, on create and on edit", async () => {
  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /function contractorExpiryRefusal\(/);
  assert.match(route, /isRealCalendarDate\(raw\)/, "the same check compliance already ran");
  // Both paths, or the create becomes a way to make a row the edit refuses.
  const branches = route.split('entity === "contractor"');
  assert.equal(branches.length >= 3, true, "a create branch and an edit branch");
  for (const branch of branches.slice(1, 3)) {
    assert.match(
      branch.slice(0, 4000),
      /contractorExpiryRefusal\(\s*data,\s*"insuranceExpiry"/,
      "insuranceExpiry is validated here",
    );
  }
  // And what is stored is normalised, so every reader sees one shape.
  assert.match(route, /supplied\(data, "insuranceExpiry", contractorDate\)/);
  assert.match(route, /insuranceExpiry: contractorDate\(data\.insuranceExpiry\)/);
});

test("W06-08: certification status is derived, never stored", async () => {
  const schema = await read("db/schema.ts");
  const table = schema.slice(
    schema.indexOf('contractorCertifications = sqliteTable'),
    schema.indexOf('contractorCertifications = sqliteTable') + 1600,
  );
  assert.match(table, /expiresOn: text\("expires_on"\)/, "each certificate carries its own expiry");
  assert.doesNotMatch(
    code(table),
    /status: text\(/,
    "and no status column: a verdict written down stops being true the day after",
  );

  const route = code(await read("app/api/workspace/route.ts"));
  assert.match(route, /expiryStatus\(row\.expiresOn, classifiedAt\)/, "classified on read");
  assert.match(route, /expiryStatus\(contractor\.insuranceExpiry, classifiedAt\)/);
  assert.match(
    route,
    /const classifiedAt = new Date\(\);/,
    "one instant for the whole payload, so two certificates expiring the same day cannot land in two buckets",
  );
  // `expiryStatus` is the platform's one classifier, at its one threshold.
  const classifier = await read("app/lib/expiry-status.ts");
  assert.match(classifier, /export const EXPIRY_DUE_SOON_DAYS = 60;/);

  // The legacy names array is still read, so a contractor with no rows in the
  // new table behaves exactly as they did before it existed.
  assert.match(route, /certifications: parseStringArray\(contractor\.certifications\)/);
  assert.match(route, /certificationEntries: certificationsByContractor\.get\(contractor\.id\) \?\? \[\]/);
});

test("W06-08: an expiry is visible, not merely stored", async () => {
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  // The list line, which is the only place a coordinator scanning the register
  // would ever see it.
  assert.match(form, /function contractorExpiryWarning\(/);
  assert.match(form, /" · Insurance expired"/);
  assert.match(form, /" · Insurance due soon"/);
  assert.match(
    form,
    /\$\{record\.assignedJobs \?\? 0\} jobs\$\{contractorExpiryWarning\(record\)\}/,
    "and it is on the contractor's own subtitle",
  );
  // The editor's chip, derived live from the date in the box beside it.
  assert.match(form, /const status = expiryStatus\(entry\.expiresOn \|\| null\);/);
  assert.match(form, /workspace-expiry-chip is-\$\{status\.state\}/);
  const css = await read("app/brand-overrides.css");
  for (const state of ["is-expired", "is-due-soon", "is-valid"]) {
    assert.match(css, new RegExp(`\\.workspace-expiry-chip\\.${state}`), `${state} is styled`);
  }
});

/**
 * W06-04 — the confirmation, and the two doors it has to guard.
 *
 * A contractor is never hard-deleted; there is no purge verb on this route and
 * there must not be one. "Remove a contractor" means take them off the active
 * roster, and BOTH ways of doing that now ask the same question.
 */
test("W06-04: taking a contractor off the roster names them and says what survives", async () => {
  const closure = await read("app/(app)/portal/contractor-closure.ts");
  assert.match(closure, /export function contractorRosterExitMessage\(name: string\)/);
  assert.match(closure, /const subject = name\.trim\(\) \|\| "this contractor";/, "the dialog names them");
  assert.match(closure, /Take \$\{subject\} off the active contractor roster\?/);
  assert.match(closure, /stop being offered when assigning work/, "the consequence");
  assert.match(closure, /jobs, documents, performance history and audit/, "and what is kept");
  assert.match(closure, /Nothing is deleted/);
  // The transition, never the state: re-saving somebody already archived, and
  // creating one with the box cleared, both go straight through.
  assert.match(closure, /export function leavesContractorRoster\(/);
  assert.match(closure, /return Boolean\(stored\?\.active\) && !nextActive;/);

  // No hard delete anywhere near a contractor. Archiving is the whole verb.
  const route = code(await read("app/api/workspace/route.ts"));
  assert.doesNotMatch(route, /db\.delete\(contractors\)/, "contractors are never deleted");
  assert.match(
    route,
    /entity === "contractor"\) await db\.update\(contractors\)\.set\(\{ active: false, availability: "Inactive"/,
    "archiving is an update, and it is the only removal there is",
  );
});

test("W06-04: both doors onto the roster call the same confirmation", async () => {
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(form, /import \{ confirmContractorRosterExit, leavesContractorRoster \} from "\.\/contractor-closure";/);
  // Door one: the tick box, which used to ask nothing at all.
  assert.match(
    form,
    /leavesContractorRoster\(stored, Boolean\(form\.active\)\) && !confirmContractorRosterExit\(/,
    "unticking Active confirms before the save",
  );
  // Door two: the Archive button, which used to ask a generic question that
  // named nothing.
  assert.match(
    form,
    /tab === "contractor" \? confirmContractorRosterExit\(/,
    "and Archive asks the same question",
  );
  /*
   * And the generic sentence is the ELSE of that branch, which is what proves a
   * contractor can never reach it. Asserted as structure rather than as an
   * absence: the words "Archive this record?" are still correct for the four
   * registers that have only one door onto the same outcome.
   */
  assert.match(
    form,
    /tab === "contractor" \? confirmContractorRosterExit\([^;]*?\) : window\.confirm\("Archive this record\?/,
    "the generic sentence is only what everything that is not a contractor gets",
  );

  // CANCEL COSTS NOTHING: both callers `return` before the request.
  const submit = form.slice(form.indexOf("if (tab === \"contractor\" && editorId)"));
  assert.match(
    submit.slice(0, 260),
    /\)\) return; \}/,
    "a declined confirmation returns before onSave, so no request is made",
  );

  /*
   * AND AVAILABILITY DOES NOT PROMPT. It is the day-to-day answer to "can they
   * take work this week" and removes nobody from anything —
   * `assignableContractors` deliberately ignores it. Prompting on it would be
   * the fastest way to teach people to click through the dialog that matters.
   */
  const guard = form.slice(
    form.indexOf("if (tab === \"contractor\" && editorId)"),
    form.indexOf("try { await onSave(tab, editorId, form);"),
  );
  assert.doesNotMatch(guard, /availability/i, "an availability change is not a roster exit");
});

/**
 * W05-08 — the shared register, mounted rather than reimplemented.
 */
test("W05-08: the Sites page mounts the shared register", async () => {
  const manager = await read("app/(app)/portal/sites/sites-manager.tsx");
  assert.match(manager, /import \{ RegisterGrid \} from "\.\.\/register\/register-grid";/);
  assert.match(manager, /<RegisterGrid\s+register="sites"/);
  // Both views read the FILTERED rows, so the search box and the two filters
  // mean the same thing in either one.
  assert.match(manager, /rows=\{visible as unknown as/);
  assert.match(manager, /role="radiogroup" aria-label="Register view"/, "one setting with two values");
});

test("W05-08: every cell goes through registerCellValue, from the right store", async () => {
  const grid = await read("app/(app)/portal/register/register-grid.tsx");
  /*
   * THE RULE THIS PIN EXISTS FOR. A native column's value is on the ENTITY ROW
   * and a custom column's is in `snapshot.values`. They are drawn side by side
   * and look identical, so a grid that reads `values` for everything renders
   * all forty native site columns BLANK — which looks like missing data rather
   * than like a bug. `registerCellValue` is the only function allowed to decide
   * which store to read, and it needs BOTH.
   */
  assert.match(
    grid,
    /registerCellValue\(column, row, snapshot\.values, row\.id\)/,
    "the entity row and the values map, both, on every cell",
  );
  assert.doesNotMatch(
    code(grid).replace(/registerCellValue\([^)]*\)/g, ""),
    /snapshot\.values\[/,
    "and nothing else reaches into the values map on its own",
  );
  // A native cell is never written from here: it belongs to the entity's own
  // API, where its validation and its audit line already live.
  assert.match(grid, /column\.native \|\| !canEditValues/);
  assert.match(grid, /writeRegisterCell\(register, column, row\.id, next === "" \? null : next\)/);
});

test("W05-08: the register is configured through the snapshot's own capabilities", async () => {
  const grid = await read("app/(app)/portal/register/register-grid.tsx");
  assert.match(grid, /const canConfigure = Boolean\(snapshot\?\.canConfigure\);/);
  assert.match(grid, /const canEditValues = Boolean\(snapshot\?\.canEditValues\);/);
  // Never a role. Roles are resolved to capabilities on the server and a second
  // opinion here would be a permission model that disagrees with itself.
  assert.doesNotMatch(code(grid), /"Super Admin"|"Admin"|"Client"|actor\.role/);
  // The whole order, every time — a pair of indices cannot express two columns
  // in one place.
  assert.match(grid, /reorderRegisterColumns\(register, orderAfterMove\(columns, column\.key, at \+ by\)\)/);
  // The server's own sentence, verbatim.
  assert.match(grid, /caught instanceof RegisterError\s*\?\s*caught\.message/);
  assert.match(grid, /role="alert"/);
  // Add, rename, hide, the hidden list, resize.
  for (const call of [
    "addRegisterColumn",
    "renameRegisterColumn",
    "setRegisterColumnHidden",
    "resizeRegisterColumn",
    "removeRegisterColumn",
    "hiddenColumns",
  ]) {
    assert.match(grid, new RegExp(`\\b${call}\\b`), `${call} is reachable from the grid`);
  }
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

test("W06-06/07/08/09: every new field round-trips through create and read", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Full`,
    availability: "Available",
    postcode: "sw1a  1aa",
    callOutCost: "85.50",
    hourlyRate: "65",
    otherCost: "12",
    otherCostLabel: "Standby",
    dayRate: "320",
    paymentTerms: "30 days",
    financeReference: "XERO-4471",
    insurerName: "Aviva",
    policyNumber: "PL-99",
    insuranceNotes: "Public liability, GBP 5m",
    insuranceExpiry: "2027-03-01",
    serviceCategories: "Glazing, Signage",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const row = await readContractor(PRIMARY_ORGANISATION_ID, made.body.id);
  assert.ok(row, "the development database must be readable for this test");

  // Money is INTEGER PENCE in the column, whatever the box said.
  assert.equal(row.day_rate_pence, 32000);
  assert.equal(row.hourly_rate_pence, 6500);
  assert.equal(row.call_out_cost_pence, 8550);
  assert.equal(row.other_cost_pence, 1200);
  assert.equal(row.other_cost_label, "Standby");
  // Whitespace collapses; the case is left exactly as typed.
  assert.equal(row.postcode, "sw1a 1aa");
  assert.equal(row.payment_terms, "30 days");
  assert.equal(row.finance_reference, "XERO-4471");
  assert.equal(row.insurer_name, "Aviva");
  assert.equal(row.policy_number, "PL-99");
  assert.equal(row.insurance_notes, "Public liability, GBP 5m");
  assert.equal(row.insurance_expiry, "2027-03-01");
});

test("W06-06/07/09: an absent key preserves, an empty string clears", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Sparse`,
    availability: "Available",
    postcode: "EC1A 1BB",
    callOutCost: "40",
    hourlyRate: "55",
    otherCost: "9",
    otherCostLabel: "Parking",
    dayRate: "300",
    paymentTerms: "14 days",
    financeReference: "SAGE-7",
    insurerName: "Zurich",
    policyNumber: "ZP-2",
    insuranceNotes: "Employers liability too",
    insuranceExpiry: "2027-06-30",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  /*
   * THE PARTIAL-PATCH CONTRACT. `supplied` fixes the omitted key; a key sent
   * carrying nothing is a deliberate erasure. Both halves are asserted here
   * because the bug this replaces — every branch building its `set` from
   * `text(data.x)` unconditionally — blanked every field a request did not
   * mention, so `{ active: false }` erased a contractor's whole record.
   */
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { notes: "untouched" })).status, 200);
  const preserved = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.ok(preserved);
  for (const [column, value] of [
    ["postcode", "EC1A 1BB"],
    ["call_out_cost_pence", 4000],
    ["hourly_rate_pence", 5500],
    ["other_cost_pence", 900],
    ["other_cost_label", "Parking"],
    ["day_rate_pence", 30000],
    ["payment_terms", "14 days"],
    ["finance_reference", "SAGE-7"],
    ["insurer_name", "Zurich"],
    ["policy_number", "ZP-2"],
    ["insurance_notes", "Employers liability too"],
    ["insurance_expiry", "2027-06-30"],
  ]) {
    assert.equal(preserved[column], value, `${column} survived a PATCH that never mentioned it`);
  }

  const cleared = await patch(PRIMARY_ORGANISATION_ID, id, {
    postcode: "",
    callOutCost: "",
    hourlyRate: "",
    otherCost: "",
    otherCostLabel: "",
    paymentTerms: "",
    financeReference: "",
    insurerName: "",
    policyNumber: "",
    insuranceNotes: "",
    insuranceExpiry: "",
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const empty = await readContractor(PRIMARY_ORGANISATION_ID, id);
  for (const column of [
    "postcode",
    "call_out_cost_pence",
    "hourly_rate_pence",
    "other_cost_pence",
    "other_cost_label",
    "payment_terms",
    "finance_reference",
    "insurer_name",
    "policy_number",
    "insurance_notes",
    "insurance_expiry",
  ]) {
    assert.equal(empty[column], null, `an explicit "" clears ${column}`);
  }
});

test("W06-07: costs are pence, negatives and overflows are refused, and dayRatePence writes", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Rates`, availability: "Available" });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  /*
   * THE WRITE-KEY ASYMMETRY, closed. `GET` returns `dayRatePence` and the
   * register publishes it as the column's `nativeField`, so it is the key a
   * register cell writes back through — and the PATCH used to accept only
   * `dayRate`, in pounds. Both work now, and they mean different UNITS.
   */
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { dayRatePence: 45000 })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).day_rate_pence, 45000);
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { dayRate: "320" })).status, 200);
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).day_rate_pence, 32000);
  // Pounds wins when a caller sends both, exactly as it does on sites.
  assert.equal(
    (await patch(PRIMARY_ORGANISATION_ID, id, { dayRate: "100", dayRatePence: 999 })).status,
    200,
  );
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).day_rate_pence, 10000);

  for (const [body, expected] of [
    [{ callOutCost: -5 }, /call-out cost cannot be negative/i],
    [{ hourlyRatePence: -1 }, /hourly rate cannot be negative/i],
    [{ otherCost: -0.5 }, /other cost cannot be negative/i],
    [{ dayRatePence: -1 }, /day rate cannot be negative/i],
    [{ hourlyRatePence: 3_000_000_000 }, /hourly rate is larger than this workspace can record/i],
    [{ callOutCost: 30_000_000 }, /call-out cost is larger than this workspace can record/i],
  ]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, body);
    assert.equal(refused.status, 400, `${JSON.stringify(body)} must be refused`);
    assert.match(refused.body.error, expected);
    // A refusal writes nothing.
    assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).day_rate_pence, 10000);
  }

  // And no refusal describes the database.
  const leak = await patch(PRIMARY_ORGANISATION_ID, id, { otherCost: 1e308 });
  assert.notEqual(leak.status, 500);
  assert.doesNotMatch(
    JSON.stringify(leak.body),
    /SELECT |INSERT |UPDATE |D1_ERROR|SQLITE|sqlite3|constraint failed|out of range|\bat [A-Za-z]+ \(/i,
    `the driver leaked: ${JSON.stringify(leak.body)}`,
  );
});

test("W06-06: a postcode accepts UK and non-UK, refuses junk, and is optional", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, { name: `${RUN} Postcode`, availability: "Available" });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  // Optional: a contractor with no postcode is created and read back fine.
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).postcode, null);

  for (const [sent, stored] of [
    ["SW1A 1AA", "SW1A 1AA"],
    ["  M1   4WB  ", "M1 4WB"],
    ["75008", "75008"],
    ["1012 AB", "1012 AB"],
    ["K1A 0B1", "K1A 0B1"],
    ["100-0001", "100-0001"],
  ]) {
    const ok = await patch(PRIMARY_ORGANISATION_ID, id, { postcode: sent });
    assert.equal(ok.status, 200, `${JSON.stringify(sent)} must be accepted: ${JSON.stringify(ok.body)}`);
    assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).postcode, stored);
  }

  for (const bad of ["<script>alert(1)</script>", "dan@example.com", "12 High Street, London"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { postcode: bad });
    assert.equal(refused.status, 400, `${JSON.stringify(bad)} must be refused`);
    assert.match(refused.body.error, /postcode/i);
  }
  // The last accepted value survived every refusal.
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).postcode, "100-0001");
});

test("W06-06: trades fold onto the option set and unlisted values survive", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Trades`,
    availability: "Available",
    // Three spellings of one trade, plus one the set has never heard of.
    serviceCategories: "electrical & LIGHTING,  Electrical & Lighting , Glazing, Scaffolding",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  const stored = JSON.parse((await readContractor(PRIMARY_ORGANISATION_ID, id)).service_categories);
  assert.deepEqual(
    stored,
    ["Electrical & lighting", "Glazing", "Scaffolding"],
    "three spellings become one canonical trade, and the unlisted one is kept as typed",
  );

  // And the same on edit, which is where a legacy record would otherwise be
  // rewritten or refused.
  assert.equal(
    (await patch(PRIMARY_ORGANISATION_ID, id, { serviceCategories: "  glazing , Scaffolding" })).status,
    200,
  );
  assert.deepEqual(
    JSON.parse((await readContractor(PRIMARY_ORGANISATION_ID, id)).service_categories),
    ["Glazing", "Scaffolding"],
  );
});

test("W06-09: a payment term outside the configured set is refused, and nothing is written", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Terms`,
    availability: "Available",
    paymentTerms: "On completion",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;
  assert.equal((await readContractor(PRIMARY_ORGANISATION_ID, id)).payment_terms, "On completion");

  const refused = await patch(PRIMARY_ORGANISATION_ID, id, {
    paymentTerms: "Net 30",
    notes: "this must not land either",
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a configured payment term/i);
  const after = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(after.payment_terms, "On completion", "the refusal wrote nothing");
  assert.notEqual(after.notes, "this must not land either");

  // A create carrying an unlisted term is refused too, so the edit cannot end
  // up stricter than the create.
  const badCreate = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} BadTerms`,
    availability: "Available",
    paymentTerms: "Whenever",
  });
  assert.equal(badCreate.status, 400);
});

test("W06-08: an insurance expiry of 2027-13-45 is refused on both paths", async (t) => {
  if (!(await ready(t))) return;

  const badCreate = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} BadDate`,
    availability: "Available",
    insuranceExpiry: "2027-13-45",
  });
  assert.equal(badCreate.status, 400, "a create must refuse it too");
  assert.match(badCreate.body.error, /calendar date/i);

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Expiry`,
    availability: "Available",
    insuranceExpiry: "2027-02-28",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  for (const bad of ["2027-13-45", "2027-02-30", "not-a-date"]) {
    const refused = await patch(PRIMARY_ORGANISATION_ID, id, { insuranceExpiry: bad });
    assert.equal(refused.status, 400, `${bad} must be refused`);
    assert.match(refused.body.error, /calendar date/i);
  }
  assert.equal(
    (await readContractor(PRIMARY_ORGANISATION_ID, id)).insurance_expiry,
    "2027-02-28",
    "and the good date is still there",
  );
});

test("W06-08: certifications are rows with dates, and their status is derived", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Certs`,
    availability: "Available",
    // The legacy names array stays exactly where it is, and is still read.
    certifications: "Old paper ticket",
    certificationEntries: [
      { name: "Gas Safe", reference: "GS-1", issuedOn: "2024-01-05", expiresOn: "2019-01-01" },
      { name: "IPAF", expiresOn: "2099-01-01" },
    ],
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  const rows = await readCertifications(PRIMARY_ORGANISATION_ID, id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Gas Safe");
  assert.equal(rows[0].reference, "GS-1");
  assert.equal(rows[0].issued_on, "2024-01-05");
  assert.equal(rows[1].name, "IPAF");
  assert.equal(rows[1].reference, null, "not every ticket has a reference");
  assert.equal(
    JSON.parse((await readContractor(PRIMARY_ORGANISATION_ID, id)).certifications)[0],
    "Old paper ticket",
    "the legacy array is untouched",
  );

  // A nonsense date is refused, and refuses the whole request.
  const refused = await patch(PRIMARY_ORGANISATION_ID, id, {
    certificationEntries: [{ name: "Asbestos", expiresOn: "2027-13-45" }],
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /calendar date/i);
  assert.equal((await readCertifications(PRIMARY_ORGANISATION_ID, id)).length, 2, "nothing was written");

  /*
   * THE DERIVED STATUS, read off the payload rather than out of a column: there
   * is no status column, and there must not be one. Two dates chosen so the
   * verdict cannot drift with the calendar — one long past, one far future.
   */
  const snapshot = await callPath("/api/workspace", "GET", PRIMARY_ORGANISATION_ID);
  assert.equal(snapshot.status, 200);
  const contractor = snapshot.body.workspace.contractors.find((entry) => entry.id === id);
  assert.ok(contractor, "the contractor is on the payload");
  const byName = Object.fromEntries(contractor.certificationEntries.map((entry) => [entry.name, entry]));
  assert.equal(byName["Gas Safe"].expiryState, "expired");
  assert.equal(byName["Gas Safe"].expiryLabel, "Expired");
  assert.equal(byName.IPAF.expiryState, "valid");
  assert.equal(contractor.insuranceState, "not-recorded", "no date on file is an open finding, not a pass");

  // An id carried back is an UPDATE, not a delete and a re-create.
  const keptId = rows[1].id;
  assert.equal(
    (await patch(PRIMARY_ORGANISATION_ID, id, {
      certificationEntries: [{ id: keptId, name: "IPAF", expiresOn: "2098-06-01" }],
    })).status,
    200,
  );
  const after = await readCertifications(PRIMARY_ORGANISATION_ID, id);
  assert.equal(after.length, 1, "the row the payload no longer names is removed");
  assert.equal(after[0].id, keptId, "and the one it kept kept its identity");
  assert.equal(after[0].expires_on, "2098-06-01");

  // An absent key changes nothing; an explicit empty list clears.
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { notes: "x" })).status, 200);
  assert.equal((await readCertifications(PRIMARY_ORGANISATION_ID, id)).length, 1, "absent preserves");
  assert.equal((await patch(PRIMARY_ORGANISATION_ID, id, { certificationEntries: [] })).status, 200);
  assert.equal((await readCertifications(PRIMARY_ORGANISATION_ID, id)).length, 0, "an empty list clears");
});

test("W06-06/07/09: another organisation's contractor is not found, and is not written", async (t) => {
  if (!(await ready(t))) return;

  const made = await create(PRIMARY_ORGANISATION_ID, {
    name: `${RUN} Tenancy`,
    availability: "Available",
    financeReference: "MINE-1",
  });
  assert.equal(made.status, 200, `create failed: ${JSON.stringify(made.body)}`);
  const id = made.body.id;

  /*
   * 404, not 403, and refused BEFORE any mutation. A 403 would be an existence
   * oracle — contractor ids carry a slug of the company name — and the 200 this
   * replaces filed the caller's own payload into the other organisation's
   * activity feed as a change that had never happened.
   */
  const foreign = await patch(DEMO_ORGANISATION_ID, id, {
    financeReference: "STOLEN",
    postcode: "SW1A 1AA",
    paymentTerms: "60 days",
  });
  assert.equal(foreign.status, 404);
  assert.match(foreign.body.error, /not found/i);
  const row = await readContractor(PRIMARY_ORGANISATION_ID, id);
  assert.equal(row.finance_reference, "MINE-1", "nothing crossed the tenant boundary");
  assert.equal(row.postcode, null);
  assert.equal(row.payment_terms, null);
});

test("W05-08: the sites register configures, persists, and refuses to delete a native column", async (t) => {
  if (!(await ready(t))) return;

  const before = await callPath("/api/registers?register=sites", "GET", PRIMARY_ORGANISATION_ID);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const originalOrder = before.body.columns.map((column) => column.key);
  assert.ok(before.body.columns.length >= 40, "the site register seeds its native columns");
  assert.equal(typeof before.body.canConfigure, "boolean");
  assert.equal(typeof before.body.canEditValues, "boolean");

  /*
   * A NATIVE COLUMN CANNOT BE DELETED, and the refusal is an instruction rather
   * than a status code — which is why the grid shows `error.message` verbatim
   * instead of inventing its own wording.
   */
  const native = before.body.columns.find((column) => column.native);
  const refused = await callPath(
    `/api/registers?id=${encodeURIComponent(native.id)}`,
    "DELETE",
    PRIMARY_ORGANISATION_ID,
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Native columns cannot be deleted. Hide it instead.");
  const stillThere = await callPath("/api/registers?register=sites", "GET", PRIMARY_ORGANISATION_ID);
  assert.ok(
    stillThere.body.columns.some((column) => column.id === native.id),
    "and the column is still there",
  );

  // Add a column of our own, then configure it every way the grid can.
  const added = await callPath("/api/registers", "POST", PRIMARY_ORGANISATION_ID, {
    register: "sites",
    title: `${RUN} Column`,
    type: "text",
  });
  // RECORDED BEFORE IT IS ASSERTED ON. A column created and then failed on is
  // still a column this run has to clean up, and an assertion above the
  // bookkeeping leaves it behind.
  const column = added.body?.column;
  if (column?.id) createdColumns.set(column.id, column.key);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(column.native, false);

  assert.equal(
    (await callPath("/api/registers", "PATCH", PRIMARY_ORGANISATION_ID, {
      id: column.id,
      title: `${RUN} Renamed`,
    })).status,
    200,
  );
  assert.equal(
    (await callPath("/api/registers", "PATCH", PRIMARY_ORGANISATION_ID, {
      id: column.id,
      width: 240,
    })).status,
    200,
  );
  assert.equal(
    (await callPath("/api/registers", "PATCH", PRIMARY_ORGANISATION_ID, {
      id: column.id,
      hidden: true,
    })).status,
    200,
  );

  // PERSISTENCE IS THE SERVER'S: a fresh GET, not a local copy.
  const reloaded = await callPath("/api/registers?register=sites", "GET", PRIMARY_ORGANISATION_ID);
  const mine = reloaded.body.columns.find((entry) => entry.id === column.id);
  assert.equal(mine.title, `${RUN} Renamed`, "the rename survived a reload");
  assert.equal(mine.width, 240, "and the width");
  assert.equal(mine.hidden, true, "and the hide");

  // Reorder sends the WHOLE order, and is put back exactly as it was so this
  // test leaves the shared register configured the way it found it.
  const moved = await callPath("/api/registers", "PATCH", PRIMARY_ORGANISATION_ID, {
    register: "sites",
    order: [column.key, ...originalOrder],
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.columns[0].key, column.key, "the whole order is what moves a column");
  const restored = await callPath("/api/registers", "PATCH", PRIMARY_ORGANISATION_ID, {
    register: "sites",
    order: [...originalOrder, column.key],
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(
    restored.body.columns.map((entry) => entry.key).slice(0, originalOrder.length),
    originalOrder,
    "the register is left exactly as this test found it",
  );

  // A CUSTOM column may be removed, and the removal is soft — its cells survive.
  assert.equal(
    (await callPath(`/api/registers?id=${encodeURIComponent(column.id)}`, "DELETE", PRIMARY_ORGANISATION_ID)).status,
    200,
  );
});
