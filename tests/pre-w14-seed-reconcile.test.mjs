/**
 * THE SEED DATASET, THE EXPECTED VALUES, AND THE TWO PURGE GUARDS.
 *
 * Module 3 exists to fill every section of the product with realistic data so
 * the numbers can be verified — WITHOUT touching the 744 real jobs and the 31
 * real Sunnamusk stores. Three things in this suite carry that weight:
 *
 *  1. ISOLATION. Every seeded email is `@example.com`, every seeded store is
 *     `ZZ-DEMO — …`, every seeded id is `zzdemo-…`, every row carries
 *     `is_seed = 1` and a batch id, and a purge is refused unless TWO
 *     independent checks both say this is not production. The specification
 *     asked for a second D1 database as the primary boundary; the owner ruled
 *     that out — see the headers of `app/lib/seed/*.ts` — so these layers are
 *     the boundary and are held to the standard of one.
 *
 *  2. THE BOUNDARY MATRIX. §3.3's nineteen offsets and their counts, asserted
 *     at every edge: 91 against 90, 61 against 60, 31 against 30, 15 against
 *     14, and 0 against −1. §4.3 calls this the single highest-value assertion
 *     in the harness, and the reason is worth restating: an error of one day at
 *     90 puts every reminder in the system a day out with no screen looking
 *     wrong. The matrix appears three times — in `dataset.ts`, restated as
 *     bands in `expected.ts`, and again below — and three copies that agree are
 *     the only evidence that the arithmetic between them is right.
 *
 *  3. INDEPENDENCE. `expected.ts` must never import the application's own
 *     counting. If it does, the harness passes and means nothing. There is a
 *     test below whose entire job is to say so.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
const load = async (file) => import(asModule(transpile(await read(file))));

/**
 * Comments stripped, for the pins that are about what the CODE does.
 *
 * Several assertions below say "this construct must not appear". Every one of
 * them is about executable text: a header that explains why `Math.random` is
 * absent must not be read as a use of it, or the file cannot document its own
 * reasoning without failing the test that protects it.
 */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Comment prose, unwrapped, so a pin can match a sentence a line break split. */
const proseOnly = (source) => source.replace(/\n\s*\*\s?/g, " ");

/*
 * All three seed modules are pure and import nothing at runtime, which is what
 * lets each be loaded on its own with no stubbing at all. `expected.ts` imports
 * only TYPES from `dataset.ts`, and a type import is erased by the transpiler.
 */
const dataset = await load("app/lib/seed/dataset.ts");
const expected = await load("app/lib/seed/expected.ts");
const guards = await load("app/lib/seed/guards.ts");

/* The application's own band ladder, for the one cross-check that needs it. */
const appCalendar = await load("app/(app)/portal/calendar-item-types.ts");

/* A fixed day to build against. Nothing below depends on the real clock. */
const TODAY = "2026-09-05";
const built = dataset.buildSeedDataset(TODAY);
const values = expected.computeExpectedValues(built, TODAY);

/* ------------------------------------------------------- 1. determinism -- */

test("two runs of the generator produce byte-identical output", () => {
  /*
   * §7: "npm run seed produces byte-identical data on two consecutive runs."
   * Non-reproducible test data makes a bug report useless — the reader cannot
   * tell whether the number moved because the code changed or because the dice
   * did.
   */
  const first = JSON.stringify(dataset.buildSeedDataset(TODAY));
  const second = JSON.stringify(dataset.buildSeedDataset(TODAY));
  assert.equal(first, second, "the same day must produce the same bytes");

  /* And the expected values with it, or the harness moves under the dashboard. */
  assert.equal(
    JSON.stringify(expected.computeExpectedValues(dataset.buildSeedDataset(TODAY), TODAY)),
    JSON.stringify(values),
  );
});

test("a different day produces different data, and still the same shape", () => {
  const other = dataset.buildSeedDataset("2026-11-30");
  assert.notEqual(JSON.stringify(other), JSON.stringify(built), "dates are relative to today");
  assert.equal(other.certificates.length, built.certificates.length);
  assert.equal(other.jobs.length, built.jobs.length);
  assert.notEqual(other.seedBatchId, built.seedBatchId, "each run is identifiable");
});

test("nothing in the seed modules reaches for Math.random", async () => {
  for (const file of [
    "app/lib/seed/dataset.ts",
    "app/lib/seed/expected.ts",
    "app/lib/seed/guards.ts",
  ]) {
    assert.doesNotMatch(
      codeOnly(await read(file)),
      /Math\.random/,
      `${file} must draw from the seeded PRNG — one Math.random anywhere makes the whole dataset unreproducible`,
    );
  }
});

test("no date is hardcoded into a fixture", async () => {
  /*
   * Seed data with a fixed expiry stops being a boundary test the day after it
   * is written. The two dates §3.4 names literally — 29 February 2028 and the
   * October clock change — are computed, so a four-digit year must not appear
   * in a date literal anywhere in the generator.
   */
  const source = (await read("app/lib/seed/dataset.ts"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /["'`]\d{4}-\d{2}-\d{2}["'`]/, "no literal calendar date");

  /* And the computed ones resolve where §3.4 said they would. */
  assert.equal(dataset.nextLeapDay("2026-09-05"), "2028-02-29");
  assert.equal(dataset.nextLeapDay("2028-02-29"), "2028-02-29", "today itself still counts");
  assert.equal(dataset.nextLeapDay("2028-03-01"), "2032-02-29", "and it never looks backwards");
  assert.equal(dataset.nextOctoberClockChange("2026-09-05"), "2026-10-25");
  assert.equal(dataset.nextOctoberClockChange("2026-10-26"), "2027-10-31");
});

/* --------------------------------------------------------- 2. isolation -- */

test("every seeded email address ends @example.com", () => {
  /*
   * Scanned over the WHOLE dataset rather than field by field, because §7 asks
   * for exactly that — "no seeded email address resolves outside @example.com,
   * verified by a query over all recipient tables" — and a field-by-field check
   * only covers the fields somebody remembered.
   */
  const addresses = JSON.stringify(built).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
  assert.ok(addresses.length >= 40, `expected a populated address book, found ${addresses.length}`);
  for (const address of addresses) {
    assert.ok(
      address.endsWith("@example.com"),
      `${address} is not @example.com — example.com is reserved and cannot receive mail, which is the entire protection`,
    );
  }
});

test("every seeded store name starts ZZ-DEMO", () => {
  assert.equal(built.stores.length, 12, "§3.2 asks for 12");
  for (const store of built.stores) {
    assert.ok(
      store.name.startsWith("ZZ-DEMO"),
      `${store.name} must sort to the bottom of every list and be greppable in every export`,
    );
  }
  /* The mix §3.2 asks for: 8 stores, 2 kiosks, 2 concessions. */
  const byType = {};
  for (const store of built.stores) byType[store.type] = (byType[store.type] ?? 0) + 1;
  assert.deepEqual(byType, { Store: 8, Kiosk: 2, Concession: 2 });
});

test("every seeded row carries is_seed and a batch id, and a zzdemo- id", () => {
  const collections = [
    built.stores,
    built.users,
    built.contacts,
    built.contractors,
    built.certificates,
    built.jobs,
    built.notes,
    built.plannedVisits,
    built.attachments,
  ];
  let rows = 0;
  for (const collection of collections) {
    for (const row of collection) {
      rows += 1;
      assert.equal(row.isSeed, 1, `${row.id} must be purgeable by flag`);
      assert.equal(row.seedBatchId, built.seedBatchId, `${row.id} must name its batch`);
      assert.ok(
        row.id.startsWith("zzdemo-"),
        `${row.id} must be purgeable by id prefix too — the third net, for a table whose seed columns somebody forgot`,
      );
    }
  }
  assert.equal(rows, 12 + 8 + 20 + 6 + 60 + 180 + 25 + 30 + 40);
});

test("no seeded row borrows a real job reference", async () => {
  /*
   * The one live fixture this work was told to leave alone is an `MN-` job
   * reference. It is a real record, it is forbidden as a QA fixture, and a
   * seeded row that reused its number would put demo data under a real one —
   * the exact contamination this module exists to prevent. Nothing seeded uses
   * that reference shape at all: certificates are `ZZD-nnnn` and jobs are
   * `zzdemo-job-nnn`, so the check is that no `MN-` reference appears anywhere.
   */
  assert.doesNotMatch(JSON.stringify(built), /\bMN-\d+/i);
  for (const file of [
    "app/lib/seed/dataset.ts",
    "app/lib/seed/expected.ts",
    "app/lib/seed/guards.ts",
  ]) {
    assert.doesNotMatch(await read(file), /\bMN-\d+/i, `${file} names a real job reference`);
  }
});

/* --------------------------------------------- 3. the boundary matrix -- */

/**
 * §3.3, transcribed a THIRD time and independently of both modules.
 *
 * If this table, `CERTIFICATE_BOUNDARY_MATRIX` in `dataset.ts` and the band
 * ladder in `expected.ts` ever disagree, one of the three has been edited
 * without the other two and the disagreement is the finding.
 */
const SPEC_MATRIX = [
  [200, 3, "Grey"],
  [91, 2, "Grey"],
  [90, 3, "Yellow"],
  [75, 3, "Yellow"],
  [61, 2, "Yellow"],
  [60, 3, "Orange"],
  [45, 3, "Orange"],
  [31, 2, "Orange"],
  [30, 3, "Red"],
  [22, 3, "Red"],
  [15, 2, "Red"],
  [14, 3, "Dark red"],
  [7, 3, "Dark red"],
  [1, 2, "Dark red"],
  [0, 3, "Dark red"],
  [-1, 3, "Expired"],
  [-14, 3, "Expired"],
  [-60, 2, "Expired"],
  [-120, 2, "Superseded"],
];

test("the generator's copy of the matrix is the specification's", () => {
  assert.deepEqual(
    built.boundaryMatrix.map((row) => [row.offsetDays, row.count, row.expectedColour]),
    SPEC_MATRIX,
  );
  assert.equal(
    SPEC_MATRIX.reduce((total, row) => total + row[1], 0),
    50,
    "the matrix is 50 certificates; §3.2 says 60, and the ten undated rows make up the difference without moving a band",
  );
});

test("the boundary matrix produces exactly the counts in §3.3", () => {
  /*
   * Counted from the OFFSET RE-DERIVED FROM THE STORED DATE, not from the
   * offset the generator recorded. That is the whole point: if `addDays` is a
   * day out, reading the intended offset back would cancel the error out and
   * this would still pass.
   */
  for (const [offsetDays, count] of SPEC_MATRIX) {
    assert.equal(
      values.certificates_by_offset[String(offsetDays)],
      count,
      `${offsetDays >= 0 ? "+" : ""}${offsetDays} days must hold exactly ${count} certificates`,
    );
  }
  assert.equal(values.certificates_by_offset.undated, 10, "and ten with no expiry at all");
  assert.equal(
    Object.values(values.certificates_by_offset).reduce((total, value) => total + value, 0),
    60,
    "§3.2's volume, reached without disturbing a single band",
  );
});

test("each certificate lands in the colour band §3.3 gives its offset", () => {
  const bandForColour = {
    Grey: "valid",
    Yellow: "d90",
    Orange: "d60",
    Red: "d30",
    "Dark red": "d14",
    Expired: "expired",
    Superseded: "superseded",
  };
  for (const [offsetDays, , colour] of SPEC_MATRIX) {
    const superseded = colour === "Superseded";
    assert.equal(
      expected.certificateBand(offsetDays, superseded),
      bandForColour[colour],
      `${offsetDays} days must be ${colour}`,
    );
  }
});

test("the edges land on 90, 60, 30, 14 and 0 and not a day either side", () => {
  /*
   * The five pairs the whole module is built around. Each is asserted with its
   * neighbour so a shifted comparison cannot pass one and fail nothing.
   */
  const band = (days) => expected.certificateBand(days, false);

  assert.equal(band(91), "valid", "+91 is one day OUTSIDE the 90 window");
  assert.equal(band(90), "d90", "+90 is inside it — the 90-day reminder fires today");

  assert.equal(band(61), "d90", "+61 is one day outside the 60 window");
  assert.equal(band(60), "d60", "+60 is inside it");

  assert.equal(band(31), "d60", "+31 is one day outside the 30 window");
  assert.equal(band(30), "d30", "+30 is inside it");

  assert.equal(band(15), "d30", "+15 is one day outside the 14 window");
  assert.equal(band(14), "d14", "+14 is inside it, and the repeat starts");

  assert.equal(band(0), "d14", "expiring today has NOT expired");
  assert.equal(band(-1), "expired", "one day past is expired");

  /* And the two ends. */
  assert.equal(band(200), "valid");
  assert.equal(band(-120), "expired", "by date alone");
  assert.equal(expected.certificateBand(-120, true), "superseded", "but the row says otherwise");
});

test("the harness's ladder agrees with the application's, band for band", () => {
  /*
   * The reconciliation, in miniature. `expected.ts` transcribes §3.3 and
   * `certificateExpiryBand()` is what the calendar actually paints with; they
   * were written apart, and this is where they are made to meet.
   */
  const appLabel = {
    valid: "Valid",
    d90: "90-day window",
    d60: "60-day window",
    d30: "30-day window",
    d14: "Urgent",
    expired: "Expired",
  };
  for (const [offsetDays, , colour] of SPEC_MATRIX) {
    if (colour === "Superseded") continue;
    const ours = expected.certificateBand(offsetDays, false);
    assert.equal(
      appCalendar.certificateExpiryBand(offsetDays).label,
      appLabel[ours],
      `the app and the harness disagree at ${offsetDays} days`,
    );
  }

  /*
   * ONE DOCUMENTED DIVERGENCE, asserted rather than hidden. The application has
   * no superseded band, because `certificateExpiryBand` is given a number of
   * days and supersession is a fact about `renewal_status`. A screen that wants
   * §3.3's seventh state has to read the row, not the date — which is recorded
   * here so the next reader finds it as a known gap and not as a bug.
   */
  assert.equal(appCalendar.certificateExpiryBand(-120).label, "Expired");
  assert.equal(expected.certificateBand(-120, true), "superseded");
});

test("the band counts hold at every awkward day of the year", () => {
  /*
   * Month ends, a leap day, new year, and the day the clocks go back — the days
   * where a naive local-time subtraction returns 0.958333 of a day and rounds a
   * 90 into an 89.
   */
  for (const day of [
    "2026-09-05",
    "2026-10-25",
    "2026-10-31",
    "2026-12-31",
    "2027-01-01",
    "2027-02-28",
    "2028-02-29",
    "2028-12-31",
  ]) {
    const built = dataset.buildSeedDataset(day);
    const values = expected.computeExpectedValues(built, day);
    for (const [offsetDays, count] of SPEC_MATRIX) {
      assert.equal(
        values.certificates_by_offset[String(offsetDays)],
        count,
        `${day}: ${offsetDays} days should hold ${count}`,
      );
    }
    assert.deepEqual(values.certificates_by_window, {
      valid: 5,
      d90: 8,
      d60: 8,
      d30: 8,
      d14: 11,
      expired: 8,
      superseded: 2,
      undated: 10,
    });
  }
});

/* ------------------------------------------------- 4. the expected values -- */

test("the §4.1 totals are what §3.2 asked for", () => {
  assert.deepEqual(values.totals, {
    stores: 12,
    users: 8,
    contacts: 20,
    contractors: 6,
    jobs: 180,
    certificates: 60,
    notes: 25,
    planned_visits: 30,
    attachments: 40,
    jobs_open: 155,
    jobs_completed: 11,
    jobs_overdue: 6,
    jobs_unscheduled: 8,
    jobs_unassigned: 5,
    jobs_unmapped_status: 3,
  });
});

test("three stores are missing a mandatory certificate, and only three", () => {
  /* §3.3's deliberate gaps, which prove the coverage detection fires at all. */
  assert.equal(values.coverage_gaps.length, 3);
  const stores = new Set(values.coverage_gaps.map((gap) => gap.store_id));
  assert.equal(stores.size, 3, "three different stores, so one store's data cannot mask two");
  for (const gap of values.coverage_gaps) {
    assert.ok(built.mandatoryCertificateTypes.includes(gap.missing_type));
  }
});

test("the reminder ladder is pending, due or sent — and never two of them", () => {
  const reminders = values.reminders;
  assert.equal(reminders.cascade_certificates, 48, "50 dated, less the 2 whose cascade is cancelled");

  assert.deepEqual(reminders.by_step, { 90: 5, 60: 13, 30: 21, 14: 29, expiry: 37, overdue: 43 });
  assert.deepEqual(reminders.due_today_by_step, {
    90: 3,
    60: 3,
    30: 3,
    14: 3,
    expiry: 3,
    /* Nothing sits at exactly −7, so no overdue escalation is due today. */
    overdue: 0,
  });
  assert.deepEqual(reminders.sent_by_step, { 90: 40, 60: 32, 30: 24, 14: 16, expiry: 8, overdue: 5 });

  assert.equal(reminders.pending_total, 148);
  assert.equal(reminders.due_today, 15, "§3.3's five 'fires today' rows, three certificates each");
  assert.equal(reminders.sent_total, 125);
  assert.equal(
    reminders.pending_total + reminders.due_today + reminders.sent_total,
    48 * built.reminderSteps.length,
    "every step of every cascading certificate is in exactly one state",
  );

  /* §3.3's own words, as numbers: 2 escalations at −14, the cap reached at −60. */
  assert.equal(reminders.overdue_escalations_total, 3 * 2 + 2 * 8);
  assert.equal(reminders.overdue_cap_reached, 2);
});

test("the SLA buckets are measured, or honestly excluded", () => {
  assert.deepEqual(values.sla, {
    breached: 6,
    approaching: 4,
    within: 145,
    excluded: 25,
    excluded_by_reason: { "unmapped-status": 3, closed: 22 },
  });
  assert.equal(
    values.sla.breached + values.sla.approaching + values.sla.within + values.sla.excluded,
    180,
    "every job is in exactly one bucket — a job that is in none is a job nobody is reporting on",
  );
  assert.equal(
    values.sla.breached,
    values.totals.jobs_overdue,
    "the overdue overlay and the SLA table are two views of one measurement",
  );
});

test("the cost total is carried in pence, because money is an integer here", () => {
  const pence = built.certificates.reduce((total, row) => total + row.costPence, 0);
  assert.equal(values.cost_totals.certificates_pence, pence);
  assert.equal(values.cost_totals.certificates_gbp, pence / 100);
  assert.ok(Number.isInteger(pence), "a fractional penny is a rounding bug wearing a total");
});

/* ------------------------------------------ 5. §4.3 cross-section checks -- */

test("the per-store totals sum to the portfolio total, with no double-counting", () => {
  const stores = Object.values(values.certificates_by_store);
  assert.equal(stores.length, 12, "every store appears, including one with a gap");
  assert.equal(
    stores.reduce((total, store) => total + store.total, 0),
    values.totals.certificates,
  );
  assert.equal(
    stores.reduce((total, store) => total + store.expired, 0),
    values.certificates_by_window.expired,
    "a store's expired count must derive only from its own certificates",
  );
});

test("every band and every offset accounts for all 60 certificates", () => {
  const sum = (record) => Object.values(record).reduce((total, value) => total + value, 0);
  assert.equal(sum(values.certificates_by_window), 60);
  assert.equal(sum(values.certificates_by_offset), 60);
});

test("the status breakdown accounts for all 180 jobs", () => {
  const sum = Object.values(values.jobs_by_status).reduce((total, value) => total + value, 0);
  assert.equal(sum, 180);
  for (const entry of built.jobStatusCatalogue.mapped) {
    assert.ok(
      (values.jobs_by_status[entry.label] ?? 0) >= 5,
      `§3.4 asks for at least 5 jobs in each mapped status; ${entry.label} has ${values.jobs_by_status[entry.label] ?? 0}`,
    );
  }
});

/* --------------------------------------------------- 6. §3.4 job coverage -- */

test("every §3.4 edge case is seeded, in the stated number", () => {
  const counts = {};
  for (const job of built.jobs) {
    for (const tag of job.edgeCases) counts[tag] = (counts[tag] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    unscheduled: 8,
    "sla-breached": 6,
    "sla-quarter-remaining": 4,
    unassigned: 5,
    stale: 5,
    "unmapped-status": 3,
    "same-week-split": 4,
    "month-boundary": 3,
    "leap-day": 2,
    "clock-change": 2,
  });
});

test("the four quarter-window jobs sit on exactly 25%, not near it", () => {
  const quarter = built.jobs.filter((job) => job.edgeCases.includes("sla-quarter-remaining"));
  assert.equal(quarter.length, 4);
  for (const job of quarter) {
    const window = dataset.daysBetween(job.raisedAt, job.dueAt);
    const remaining = dataset.daysBetween(TODAY, job.dueAt);
    assert.equal(remaining * 4, window, `${job.id} is at ${remaining}/${window}, not a quarter`);
  }
});

test("the connector-line, month-boundary and date-arithmetic jobs are where they claim", () => {
  const of = (tag) => built.jobs.filter((job) => job.edgeCases.includes(tag));

  /* Scheduled date and deadline on different days of the SAME week. */
  const isoWeekStart = (iso) => {
    const day = new Date(`${iso}T00:00:00.000Z`).getUTCDay();
    const back = (day + 6) % 7;
    return new Date(Date.parse(`${iso}T00:00:00.000Z`) - back * 86400000)
      .toISOString()
      .slice(0, 10);
  };
  for (const job of of("same-week-split")) {
    assert.notEqual(job.scheduledDate, job.dueAt, "the connector needs two different days");
    assert.equal(isoWeekStart(job.scheduledDate), isoWeekStart(job.dueAt), "in one week");
  }

  for (const job of of("month-boundary")) {
    assert.notEqual(job.raisedAt.slice(0, 7), job.dueAt.slice(0, 7), "the span must cross a month");
  }

  for (const job of of("leap-day")) {
    assert.match(job.scheduledDate, /-02-29$/, "a date that does not exist three years in four");
  }
  for (const job of of("clock-change")) {
    const change = dataset.nextOctoberClockChange(TODAY);
    assert.equal(Math.abs(dataset.daysBetween(change, job.scheduledDate)), 1, "either side of it");
  }
});

test("the three unmapped statuses are genuinely absent from job_status_map", async () => {
  /*
   * Pinned against `db/init.ts` itself. §3.4 asks for three jobs whose status
   * is DELIBERATELY not in the map, and the fixture is only worth anything if
   * the map really does not hold them. If somebody later adds "Parked —
   * landlord approval" to `JOB_STATUS_MAP_SEED`, this is the test that says the
   * fixture has quietly stopped testing the fallback.
   */
  const source = await read("db/init.ts");
  const start = source.indexOf("const JOB_STATUS_MAP_SEED");
  assert.notEqual(start, -1, "JOB_STATUS_MAP_SEED must still be where the harness looks");
  const block = source.slice(start, source.indexOf("];", start));

  const mapped = [...block.matchAll(/\{ label: "([^"]+)"[^}]*?open: (\d)/g)].map((match) => ({
    label: match[1],
    countsAsOpen: match[2] === "1",
  }));
  /*
   * RE-POINTED from "exactly twelve" to "a subset whose meanings agree", and
   * the reason is a real one rather than a convenience.
   *
   * The seed originally held Module 2 §4.2's twelve labels. Reading the live
   * board afterwards showed seven more in use on 86 jobs — "Pending Approval"
   * on 59 — so those were seeded too, and `JOB_STATUS_MAP_SEED` is now
   * nineteen. The harness does not need to seed a job in every one of them.
   *
   * What it must never do is disagree about what a status MEANS: if
   * `dataset.ts` thinks "On hold" counts as open and the application thinks it
   * does not, `jobs_open` moves and the reconciliation is checking one bug
   * against another. So the assertion is now: every status the harness uses
   * exists in the map, and carries the same `countsAsOpen` there. Nothing is
   * weakened — the drift this test was written to catch still fails it.
   */
  assert.ok(mapped.length >= 12, "the default map must still hold at least §4.2's twelve");

  const meaning = new Map(mapped.map((entry) => [entry.label, entry.countsAsOpen]));
  for (const entry of built.jobStatusCatalogue.mapped) {
    assert.ok(
      meaning.has(entry.label),
      `the harness seeds "${entry.label}" but db/init.ts does not map it — a job seeded under an unmapped status silently joins the fallback fixtures`,
    );
    assert.equal(
      entry.countsAsOpen,
      meaning.get(entry.label),
      `the harness and the application disagree about whether "${entry.label}" is open; a drift here silently moves jobs_open`,
    );
  }

  const labels = new Set(mapped.map((entry) => entry.label));
  for (const status of built.jobStatusCatalogue.unmapped) {
    assert.equal(labels.has(status), false, `${status} must NOT be in the map`);
  }
  for (const job of built.jobs.filter((job) => job.edgeCases.includes("unmapped-status"))) {
    assert.equal(job.statusIsMapped, false);
    assert.ok(built.jobStatusCatalogue.unmapped.includes(job.status));
  }
});

/* ------------------------------------------------- 7. harness independence -- */

test("expected.ts imports nothing at runtime, and says why in capitals", async () => {
  /*
   * THE TEST THAT PROTECTS THE WHOLE HARNESS. §4: "If the dashboard computes a
   * number and you check it using the same code that produced it, you have
   * tested nothing." A later tidy-up that replaces one of those loops with the
   * application's own helper would leave every assertion above passing and
   * meaning nothing, so the import list is pinned rather than trusted.
   */
  const source = await read("app/lib/seed/expected.ts");
  const runtimeImports =
    codeOnly(source).match(/^\s*import\s+(?!type\b)[^\n]*from\s+["'][^"']+["']/gm) ?? [];
  assert.deepEqual(
    runtimeImports,
    [],
    "expected.ts must not import anything at runtime — least of all app/lib/reporting or app/lib/reminders",
  );
  assert.doesNotMatch(source, /from\s+["'][^"']*lib\/(reporting|reminders)/);
  assert.match(source, /DO NOT IMPORT ANY APPLICATION MODULE INTO THIS FILE/);

  /* And it must not read the offset it is supposed to be re-deriving. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /\.matrixOffsetDays/,
    "reading the intended offset back off the row would cancel out an error in the generator's date arithmetic",
  );
  assert.doesNotMatch(code, /\.statusIsMapped/, "the label is looked up, not believed");
});

/* -------------------------------------------------------- 8. the guards -- */

const PREVIEW_VARS = { ENVIRONMENT: "preview" };
const PREVIEW_DB = {
  name: "maintsupp_staging",
  host: "aws-0-eu-west-2.pooler.supabase.com",
  schema: "portal",
  adapter: "postgres",
};

test("a purge is allowed only when BOTH checks pass", () => {
  const decision = guards.assertPurgeAllowed({ vars: PREVIEW_VARS, database: PREVIEW_DB });
  assert.equal(decision.allowed, true, decision.reason);
  assert.equal(decision.checks.length, 2, "two checks, always both evaluated");
  assert.ok(decision.checks.every((check) => check.passed));
});

test("a purge is refused when the environment says production", () => {
  for (const marker of ["production", "prod", "Live", "PRODUCTION"]) {
    const decision = guards.assertPurgeAllowed({
      vars: { ENVIRONMENT: marker },
      database: PREVIEW_DB,
    });
    assert.equal(decision.allowed, false, `${marker} must refuse`);
    assert.deepEqual(decision.refusedBy, ["environment"], "and name which check refused");
    assert.match(decision.reason, /\[environment\]/);
  }
});

test("a purge is refused when the database says production", () => {
  for (const identity of [
    { ...PREVIEW_DB, name: "maintsupp_prod" },
    { ...PREVIEW_DB, host: "db.production.maintsupp.internal" },
    { ...PREVIEW_DB, name: "maintsupp_live" },
  ]) {
    const decision = guards.assertPurgeAllowed({ vars: PREVIEW_VARS, database: identity });
    assert.equal(decision.allowed, false, `${identity.name}@${identity.host} must refuse`);
    assert.deepEqual(decision.refusedBy, ["database"]);
  }
});

test("neither check can rescue the other — that is why there are two", () => {
  /*
   * §5: "two independent checks, because one will eventually be misconfigured."
   * The realistic accident is a preview deployment whose connection string was
   * copied from production and never changed: the platform variable looks
   * right, and the database is the client's.
   */
  const copiedConnectionString = guards.assertPurgeAllowed({
    vars: { ENVIRONMENT: "preview" },
    database: { ...PREVIEW_DB, name: "maintsupp_prod" },
  });
  assert.equal(copiedConnectionString.allowed, false);
  assert.deepEqual(copiedConnectionString.refusedBy, ["database"]);

  /* And the mirror: a staging database reached from a production deployment. */
  const wrongDeployment = guards.assertPurgeAllowed({
    vars: { ENVIRONMENT: "production" },
    database: PREVIEW_DB,
  });
  assert.equal(wrongDeployment.allowed, false);
  assert.deepEqual(wrongDeployment.refusedBy, ["environment"]);

  /* Both wrong at once reports both, so it is not fixed twice. */
  const both = guards.assertPurgeAllowed({
    vars: { ENVIRONMENT: "production" },
    database: { ...PREVIEW_DB, name: "maintsupp_prod" },
  });
  assert.equal(both.allowed, false);
  assert.deepEqual(both.refusedBy, ["environment", "database"]);
});

test("silence is refused: an unset marker and an unnamed database both fail closed", () => {
  const noMarker = guards.assertPurgeAllowed({ vars: {}, database: PREVIEW_DB });
  assert.equal(noMarker.allowed, false);
  assert.deepEqual(noMarker.refusedBy, ["environment"]);
  assert.match(noMarker.reason, /has not said it is safe/);

  const noDatabase = guards.assertPurgeAllowed({ vars: PREVIEW_VARS });
  assert.equal(noDatabase.allowed, false);
  assert.deepEqual(noDatabase.refusedBy, ["database"]);

  /* An opaque Supabase reference names nothing, so it is treated as production. */
  const opaque = guards.assertPurgeAllowed({
    vars: PREVIEW_VARS,
    database: { name: "postgres", host: "abcdefgh.pooler.supabase.com", adapter: "postgres" },
  });
  assert.equal(opaque.allowed, false);
  assert.deepEqual(opaque.refusedBy, ["database"]);
});

test("NODE_ENV is not the deployment marker, because every build sets it", () => {
  /*
   * Every built bundle in this repository runs with NODE_ENV=production,
   * preview included. Reading it here would refuse every legitimate purge and
   * teach whoever hit that to add an override that also covers the real case.
   */
  const decision = guards.assertPurgeAllowed({
    vars: { NODE_ENV: "production", ENVIRONMENT: "preview" },
    database: PREVIEW_DB,
  });
  assert.equal(decision.allowed, true, decision.reason ?? "");
});

test("VERCEL_ENV stands in when ENVIRONMENT is unset, and the local D1 passes", () => {
  const vercel = guards.assertPurgeAllowed({
    vars: { VERCEL_ENV: "preview" },
    database: PREVIEW_DB,
  });
  assert.equal(vercel.allowed, true, vercel.reason ?? "");

  /* Miniflare's sqlite file. No deployed instance uses this adapter. */
  const local = guards.assertPurgeAllowed({
    vars: { ENVIRONMENT: "development" },
    database: { name: "DB", adapter: "d1-sqlite" },
  });
  assert.equal(local.allowed, true, local.reason ?? "");
});

/* ---------------------------------------------------- 9. the kill switch -- */

test("an unset EMAIL_MODE fails the seed run rather than defaulting", () => {
  /*
   * §2.1: a build that reads EMAIL_MODE as unset must FAIL, not fall back to
   * live. Enforced here, at the seed entry point, where there is no lead to
   * lose — see the note in guards.ts about how this relates to
   * app/lib/notifications.ts, which defaults to `sink` for a documented reason.
   */
  for (const mode of [undefined, null, "", "   "]) {
    const decision = guards.assertEmailModeSafe(mode);
    assert.equal(decision.safe, false, `${JSON.stringify(mode)} must refuse`);
    assert.match(decision.reason, /unset/);
  }
});

test("live is never safe to seed against, and a typo is not a fourth mode", () => {
  assert.equal(guards.assertEmailModeSafe("live").safe, false);
  assert.equal(guards.assertEmailModeSafe("LIVE").safe, false, "case must not smuggle it through");
  assert.equal(guards.assertEmailModeSafe("sinc").safe, false, "a typo reads as unset downstream");
  assert.equal(guards.assertEmailModeSafe("sink").safe, true);
  assert.equal(guards.assertEmailModeSafe("log").safe, true);
  assert.equal(guards.assertEmailModeSafe(" SINK ").mode, "sink", "trimmed and lowered like the app does");
});

test("the divergence from §2.1 is written down where somebody will find it", async () => {
  /*
   * `emailMode()` in notifications.ts defaults to `sink` and does not fail. That
   * satisfies the INTENT of §2.1 — an unset variable can never mean live — and
   * contradicts its letter. The gap is deliberate and documented; this asserts
   * the documentation still exists, so the next reader is not left to discover
   * it from a stack trace.
   */
  const notifications = await read("app/lib/notifications.ts");
  assert.match(notifications, /return "sink";/, "the safe default is still the default");

  const guardSource = await read("app/lib/seed/guards.ts");
  assert.match(guardSource, /app\/lib\/notifications\.ts/);
  assert.match(guardSource, /DEFAULTS TO `sink`/);
});

test("the deviation from Module 3 §1 is recorded in every file it affects", async () => {
  /*
   * The owner ruled out the second D1 database and the second R2 bucket that
   * §1/§1.1 asks for. A deviation that is not written down is indistinguishable
   * from a mistake six months later, so each module carries it.
   */
  for (const file of [
    "app/lib/seed/dataset.ts",
    "app/lib/seed/expected.ts",
    "app/lib/seed/guards.ts",
  ]) {
    if (file.endsWith("expected.ts")) continue; /* it is downstream of the choice */
    const prose = proseOnly(await read(file));
    assert.match(prose, /DEVIATION FROM MODULE 3/, `${file} must say what it did not do, and why`);
    assert.match(prose, /introduce D1\/R2/i, `${file} must quote the instruction it followed`);
  }
});
