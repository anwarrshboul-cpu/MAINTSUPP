/**
 * MODULE 4 — the bank-holiday calendar, the number, and the waiver gate.
 *
 * Three pieces of Module 4 that all have the same property: they decide a
 * number or a permission that a client will read on a document, and they are
 * pure, so they can be checked exactly rather than approximately.
 *
 * WHAT THE CONTRAST TESTS ARE FOR. Almost every assertion about working days
 * below is written twice — once with the calendar and once without — and the
 * pair is the point. A holiday-aware count that is never compared against the
 * plain weekday count would pass just as happily if the calendar were being
 * dropped on the floor somewhere between `bankHolidayCalendar` and the loop
 * inside `workingDaysInclusive`, because the plain answer looks perfectly
 * reasonable on its own. The DIFFERENCE is the only thing that proves the set
 * arrived. So the Christmas range is asserted at 7 with the calendar and 10
 * without, and the same again through `computeSlaOutcome`, where the two
 * answers are Within and Outside — the same job, judged differently, entirely
 * because of the calendar.
 *
 * The dates are the ones with substitute days in them on purpose. 25 December
 * 2026 is a Friday, so Boxing Day falls on the Saturday and the holiday moves
 * to Monday the 28th; an implementation that derived holidays arithmetically
 * rather than reading them would miss that Monday and be a day out for every
 * job open over that Christmas. Easter 2027 is here for the same reason: its
 * date cannot be looked up in a rule, only in a table.
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

/* ------------------------------------------------------------- the modules */

/*
 * Each module is transpiled and its relative specifiers pointed at a
 * transpiled sibling — the same device the calendar suites use. `contract.ts`
 * and `inputs.ts` never appear because every import of them is `import type`,
 * which the transpiler removes outright.
 */
const periodFileText = await read("app/lib/reporting/period.ts");
const periodSource = transpile(periodFileText);
const periodUrl = asModule(periodSource);

const bankHolidaysSource = transpile(await read("app/lib/reporting/bank-holidays.ts"));
const bankHolidaysUrl = asModule(
  bankHolidaysSource.replace(/from ["']\.\/period["']/g, `from "${periodUrl}"`),
);

const metersUrl = asModule(transpile(await read("app/(app)/portal/dashboard-meters.ts")));
const jobClassificationUrl = asModule(
  transpile(await read("app/lib/reporting/job-classification.ts")).replace(
    /from ["']\.\.\/\.\.\/\(app\)\/portal\/dashboard-meters["']/g,
    `from "${metersUrl}"`,
  ),
);

const slaSource = transpile(await read("app/lib/reporting/sla.ts"));
const slaUrl = asModule(
  slaSource
    .replace(/from ["']\.\/period["']/g, `from "${periodUrl}"`)
    .replace(/from ["']\.\/job-classification["']/g, `from "${jobClassificationUrl}"`),
);

const period = await import(periodUrl);
const holidays = await import(bankHolidaysUrl);
const sla = await import(slaUrl);
const numbering = await import(
  asModule(transpile(await read("app/lib/reporting/numbering.ts")))
);
const waivers = await import(
  asModule(transpile(await read("app/lib/reporting/waivers.ts")))
);

/* ------------------------------------------------------- the calendar rows */

/*
 * Shaped exactly as `bank_holidays` returns them on the raw path, snake_case
 * key included, because that is the shape the builder has to survive. These
 * dates are transcribed from the seed in `db/init.ts` and the test below reads
 * that file to prove they still agree — a calendar the tests believe in and the
 * database does not is worse than no test at all.
 */
const SEEDED_ROWS = [
  { holiday_date: "2026-12-25", jurisdiction: "england-and-wales", title: "Christmas Day" },
  { holiday_date: "2026-12-28", jurisdiction: "england-and-wales", title: "Boxing Day (substitute day)" },
  { holiday_date: "2027-01-01", jurisdiction: "england-and-wales", title: "New Year's Day" },
  { holiday_date: "2027-03-26", jurisdiction: "england-and-wales", title: "Good Friday" },
  { holiday_date: "2027-03-29", jurisdiction: "england-and-wales", title: "Easter Monday" },
];

const CALENDAR = holidays.bankHolidayCalendar(SEEDED_ROWS);
const NO_CALENDAR = holidays.EMPTY_BANK_HOLIDAY_CALENDAR;

test("the dates this suite counts on are the ones db/init.ts actually seeds", async () => {
  /*
   * Read, never written. The seed is another agent's file; this only checks
   * that the four dates every assertion below depends on are present in it,
   * so a re-seed that quietly dropped the substitute days would fail here
   * rather than silently make every working-day count a day too generous.
   */
  const init = await read("db/init.ts");
  for (const [date, title] of [
    ["2026-12-25", "Christmas Day"],
    ["2026-12-28", "Boxing Day (substitute day)"],
    ["2027-01-01", "New Year's Day"],
    ["2027-03-26", "Good Friday"],
    ["2027-03-29", "Easter Monday"],
  ]) {
    assert.ok(
      init.includes(`["${date}", "${title}"]`),
      `${date} (${title}) must still be seeded into bank_holidays`,
    );
  }
  assert.match(init, /CREATE TABLE IF NOT EXISTS bank_holidays/);
});

/* ----------------------------------------------------- building the set */

test("the calendar is built from rows in either shape, and filtered by jurisdiction", () => {
  assert.equal(CALENDAR.size, 5);
  assert.equal(holidays.isBankHoliday("2026-12-28", CALENDAR), true);
  assert.equal(holidays.isBankHoliday("2026-12-29", CALENDAR), false);

  /* drizzle returns camelCase, the raw path snake_case. Both are real. */
  const camel = holidays.bankHolidayCalendar([{ holidayDate: "2026-12-25" }]);
  assert.equal(camel.has("2026-12-25"), true, "a builder blind to one key empties the calendar silently");

  /* Scotland's rows must not reach an England & Wales report. */
  const mixed = holidays.bankHolidayCalendar([
    { holiday_date: "2026-12-25", jurisdiction: "england-and-wales" },
    { holiday_date: "2027-01-04", jurisdiction: "scotland" },
  ]);
  assert.deepEqual([...mixed], ["2026-12-25"]);
  assert.equal(holidays.bankHolidayCalendar(null).size, 0);

  /* An unreadable date is dropped rather than guessed at — one working day too
     many is arguable; an invented holiday is not. */
  assert.equal(holidays.bankHolidayCalendar([{ holiday_date: "not a date" }]).size, 0);
});

/* ----------------------------------------------- Christmas 2026, both ways */

test("Christmas 2026: the substitute Monday is a real holiday, and it is counted", () => {
  /* The premise the substitute day rests on, asserted rather than assumed. */
  assert.equal(new Date(Date.UTC(2026, 11, 25)).getUTCDay(), 5, "25 Dec 2026 is a Friday");
  assert.equal(new Date(Date.UTC(2026, 11, 28)).getUTCDay(), 1, "28 Dec 2026 is a Monday");

  assert.equal(holidays.isWorkingDay("2026-12-24", CALENDAR), true);
  assert.equal(holidays.isWorkingDay("2026-12-25", CALENDAR), false, "Christmas Day");
  assert.equal(holidays.isWorkingDay("2026-12-26", CALENDAR), false, "a Saturday either way");
  assert.equal(holidays.isWorkingDay("2026-12-28", CALENDAR), false, "the Boxing Day substitute");
  assert.equal(
    holidays.isWorkingDay("2026-12-28", NO_CALENDAR),
    true,
    "without the table it is just a Monday — which is the bug the table fixes",
  );
});

test("a range spanning Christmas 2026 loses exactly its holidays, and nothing else", () => {
  /*
   * Monday 21 December to Friday 1 January. Ten weekdays in the range; three of
   * them are bank holidays (25 Dec, the 28 Dec substitute, 1 Jan).
   */
  const start = "2026-12-21";
  const end = "2027-01-01";
  assert.equal(period.workingDaysInclusive(start, end), 10, "weekdays alone");
  assert.equal(
    period.workingDaysInclusive(start, end, NO_CALENDAR),
    10,
    "an empty calendar is the same answer, not a different one",
  );
  assert.equal(period.workingDaysInclusive(start, end, CALENDAR), 7, "less Christmas, the substitute and New Year");

  /* The same function re-exported from bank-holidays.ts — one implementation,
     two import sites, and this is what proves they are the same one. */
  assert.equal(holidays.workingDaysInclusive(start, end, CALENDAR), 7);
});

test("one holiday in the range means exactly one working day fewer", () => {
  /*
   * The narrowest possible statement of the contrast. Monday 28 December to
   * Thursday 31 December is four weekdays; the substitute Monday is the only
   * holiday in it, so the calendar must remove one and only one.
   */
  const plain = period.workingDaysInclusive("2026-12-28", "2026-12-31");
  const withCalendar = period.workingDaysInclusive("2026-12-28", "2026-12-31", CALENDAR);
  assert.equal(plain, 4);
  assert.equal(withCalendar, 3);
  assert.equal(plain - withCalendar, 1, "the empty set returns one MORE — the wiring is live");
});

/* ---------------------------------------------------------- Easter 2027 */

test("Easter 2027 comes out of the table, because it cannot come out of a rule", () => {
  assert.equal(holidays.isWorkingDay("2027-03-26", CALENDAR), false, "Good Friday");
  assert.equal(holidays.isWorkingDay("2027-03-29", CALENDAR), false, "Easter Monday");
  assert.equal(holidays.isWorkingDay("2027-03-25", CALENDAR), true, "Maundy Thursday is a working day");

  /* Monday 22 March to Friday 2 April: ten weekdays, two of them holidays. */
  assert.equal(period.workingDaysInclusive("2027-03-22", "2027-04-02"), 10);
  assert.equal(period.workingDaysInclusive("2027-03-22", "2027-04-02", CALENDAR), 8);

  /* And the one-day contrast again, over Good Friday alone. */
  assert.equal(period.workingDaysInclusive("2027-03-22", "2027-03-26"), 5);
  assert.equal(period.workingDaysInclusive("2027-03-22", "2027-03-26", CALENDAR), 4);
});

test("the calendar changes nothing about the arithmetic it was bolted onto", () => {
  /* The four cases w9-report-engine.test.mjs already pins, re-asserted here
     with a calendar in hand: a third argument must not move an existing answer
     when no holiday falls in the range. */
  assert.equal(period.workingDaysInclusive("2026-03-02", "2026-03-06", CALENDAR), 5);
  assert.equal(period.workingDaysInclusive("2026-03-02", "2026-03-08", CALENDAR), 5);
  assert.equal(period.workingDaysInclusive("2026-03-07", "2026-03-08", CALENDAR), 0);
  assert.equal(period.workingDaysInclusive("2026-03-06", "2026-03-02", CALENDAR), 0, "backwards is still zero");
});

/* ------------------------------------------------- the calendar reaches SLA */

const RULES = [
  { id: "r1", classification: "Plumbing", targetWorkingDays: 5, active: true, version: 1, note: null },
];

function job(overrides = {}) {
  return {
    id: "job-1",
    reference: "REQ-1",
    title: "Leak",
    description: "Leak",
    siteId: "site-1",
    siteName: "Store 1",
    recordedSiteName: "Store 1",
    status: "Completed",
    stage: "Completed",
    priority: "P2",
    tier: 2,
    classification: "Plumbing",
    jobType: "Reactive",
    contractor: null,
    contractorId: null,
    contractorRegisterName: null,
    assignee: null,
    requester: null,
    requestedOn: "2026-12-21",
    targetOn: null,
    completedOn: "2026-12-31",
    costPence: null,
    costInvalid: false,
    approvedQuotePence: null,
    invoice: null,
    approvedBy: null,
    notes: null,
    blockedReason: null,
    nextUpdateOn: null,
    ...overrides,
  };
}

const hold = (overrides = {}) => ({
  id: "hold-1",
  requestId: "job-1",
  startAt: "2026-12-22",
  endAt: "2026-12-23",
  reason: "Awaiting parts",
  category: "Parts",
  approved: true,
  approvedBy: "owner@example.com",
  approvedAt: "2026-12-22",
  note: null,
  ...overrides,
});

test("computeSlaOutcome measures elapsed and held against the SAME calendar", () => {
  /*
   * Requested Monday 21 December, completed Thursday 31 December, with an
   * approved hold on the 22nd and 23rd. Neither hold day is a holiday, so the
   * hold is two days either way — which is what makes the elapsed figure the
   * only thing the calendar moves, and the comparison honest.
   *
   * RE-POINTED for the working-day rule confirmed on 2026-09-05: elapsed now
   * counts FROM THE DAY AFTER the request (Module 4 §4.2), so every elapsed
   * figure here is one lower. The HOLD is unchanged at two days, which is the
   * point worth keeping — the two measurements follow different rules on
   * purpose, and this test is where that would show if somebody unified them.
   *
   *   without the calendar: elapsed 8, held 2, adjusted 6 — target 5 -> Outside
   *   with the calendar:    elapsed 6, held 2, adjusted 4 — target 5 -> Within
   */
  const plain = sla.computeSlaOutcome(job(), [hold()], RULES);
  assert.equal(plain.elapsedWorkingDays, 8);
  assert.equal(plain.approvedHoldDays, 2);
  assert.equal(plain.adjustedWorkingDays, 6);
  assert.equal(plain.result, "Outside");

  const measured = sla.computeSlaOutcome(job(), [hold()], RULES, CALENDAR);
  assert.equal(measured.elapsedWorkingDays, 6, "Christmas Day and the substitute Monday come out");
  assert.equal(measured.approvedHoldDays, 2, "the hold spans no holiday, so it is unchanged");
  assert.equal(measured.adjustedWorkingDays, 4);
  assert.equal(measured.result, "Within", "the same job, judged differently, only because of the calendar");

  /* All three are still returned, on both paths. §10 requires elapsed, held and
     adjusted to be stored and shown; a calendar that quietly nulled one of them
     would pass every count assertion above. */
  for (const row of [plain, measured]) {
    assert.equal(typeof row.elapsedWorkingDays, "number");
    assert.equal(typeof row.approvedHoldDays, "number");
    assert.equal(typeof row.adjustedWorkingDays, "number");
    assert.equal(row.adjustedWorkingDays, row.elapsedWorkingDays - row.approvedHoldDays);
  }
});

test("a hold that spans a bank holiday does not discount a day nobody worked", () => {
  /*
   * A hold running 23 to 29 December covers five weekdays but only three
   * working days. Subtracting five would hand the job a discount for two days
   * the calendar had already excused — the double count that makes an adjusted
   * figure smaller than the time the job was actually open.
   */
  const long = hold({ startAt: "2026-12-23", endAt: "2026-12-29" });
  assert.equal(sla.holdWorkingDays(long, "2026-12-21", "2026-12-31"), 5);
  assert.equal(sla.holdWorkingDays(long, "2026-12-21", "2026-12-31", CALENDAR), 3);
  assert.equal(sla.approvedHoldDays([long], "2026-12-21", "2026-12-31", CALENDAR), 3);

  /* Overlapping holds still count a shared day once, with the calendar on. */
  const second = hold({ id: "hold-2", startAt: "2026-12-24", endAt: "2026-12-30" });
  assert.equal(sla.approvedHoldDays([long, second], "2026-12-21", "2026-12-31", CALENDAR), 4);
});

test("an open job's days past target use the calendar too", () => {
  const open = job({ status: "In progress", stage: "In progress", completedOn: null });
  const plain = sla.openJobDaysPastTarget(open, [], RULES, "2026-12-31");
  const measured = sla.openJobDaysPastTarget(open, [], RULES, "2026-12-31", CALENDAR);
  /*
   * One lower on both paths, for the same reason as the completed job above:
   * an OPEN job's age is measured by the same rule, or "3 days past target" on
   * the open list and "outside SLA by 3 days" once it closes would not be the
   * same three days.
   */
  assert.equal(plain.workingDaysOpen, 8);
  assert.equal(plain.daysPastTarget, 3);
  assert.equal(measured.workingDaysOpen, 6);
  assert.equal(measured.daysPastTarget, 1, "or the open list and the closed table disagree by two days");
});

test("sla.ts and period.ts stay importable without the calendar module", () => {
  /*
   * `w9-report-engine.test.mjs` stages a FIXED list of modules into a mirrored
   * temporary directory and rewrites every relative specifier to `.mjs`. A
   * value import of `./bank-holidays` from either of these files would resolve
   * to a file that was never staged and take that entire suite down. The type
   * import is erased, which is why this works; this assertion is what stops it
   * quietly becoming a value import later.
   */
  assert.equal(/["']\.\/bank-holidays["']/.test(slaSource), false, "sla.ts must import the type only");
  assert.equal(/\bfrom\s*["']\./.test(periodSource), false, "period.ts must stay a leaf module");
});

test("period.ts records the decision instead of contradicting it", () => {
  /*
   * The header used to state that there was no bank-holiday calendar in this
   * product. The calendar now exists, so the file must say what changed and
   * when rather than arguing with the function underneath it — and the original
   * reasoning has to survive, because it is the condition the change had to
   * meet.
   */
  const source = periodFileText;
  assert.equal(
    /There is no bank-holiday calendar anywhere in this product/.test(source),
    false,
    "the old claim must be gone — the file cannot contradict its own third parameter",
  );
  assert.match(source, /5 SEPTEMBER 2026|5 September 2026/, "the decision needs its date");
  assert.match(source, /Module 4 §4\.2|§4\.2/, "and the thing that sanctioned it");
  assert.match(source, /no agreement supports/, "the original reasoning is kept, not deleted");
  assert.match(source, /bank-holidays\.ts/, "and it points at where the dates now live");
});

/* ------------------------------------------------------------- numbering */

test("MS-YYYY-NNN, zero padded to three digits", () => {
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 1), "MS-2026-001");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 7), "MS-2026-007");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 42), "MS-2026-042");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 138), "MS-2026-138");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 999), "MS-2026-999");

  /* The prefix comes from settings, so it is not hardcoded here either. */
  assert.equal(numbering.formatDocumentNumber("ACME", 2027, 3), "ACME-2027-003");
  assert.equal(numbering.formatDocumentNumber("", 2027, 3), "MS-2027-003", "an empty prefix falls back");
});

test("past 999 the number widens rather than wrapping or truncating", () => {
  /*
   * Both alternatives to widening reissue 001 — one by wrapping to it, one by
   * truncating onto it — and reuse is the thing §10 forbids outright. A
   * four-digit number is merely unusual.
   */
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 1000), "MS-2026-1000");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 1001), "MS-2026-1001");
  assert.equal(numbering.formatDocumentNumber("MS", 2026, 12345), "MS-2026-12345");
});

test("a number reads back apart, and a non-canonical one does not", () => {
  assert.deepEqual(numbering.parseDocumentNumber("MS-2026-042"), {
    prefix: "MS",
    year: 2026,
    sequence: 42,
  });
  assert.deepEqual(numbering.parseDocumentNumber("MS-2026-1000"), {
    prefix: "MS",
    year: 2026,
    sequence: 1000,
  });
  /* Round trip, at both widths. */
  for (const sequence of [1, 42, 999, 1000, 12345]) {
    const rendered = numbering.formatDocumentNumber("MS", 2026, sequence);
    assert.equal(numbering.parseDocumentNumber(rendered).sequence, sequence);
  }
  assert.equal(numbering.parseDocumentNumber("MS-2026-0001"), null, "this product never writes that");
  assert.equal(numbering.parseDocumentNumber("MS-26-001"), null);
  assert.equal(numbering.parseDocumentNumber("MS-2026-01"), null);
  assert.equal(numbering.parseDocumentNumber("MS-00042"), null, "the old format is not this one");
  assert.equal(numbering.parseDocumentNumber(null), null);
});

test("a voided number is never handed back", () => {
  /*
   * THE FAILURE THIS EXISTS TO PREVENT, spelled out.
   *
   * MS-2026-004 is finalised and then voided. It is now the highest number ever
   * issued and there is no live document holding it. The obvious allocator —
   * `max(number on a live document) + 1` — returns 004 again, and the next
   * invoice goes to a client who has already seen that reference against
   * different money. A forward-only counter cannot do that: it was advanced
   * when the number was consumed, and voiding does not wind it back.
   */
  const issued = ["MS-2026-001", "MS-2026-002", "MS-2026-003", "MS-2026-004"];
  const voided = "MS-2026-004";
  const live = issued.filter((number) => number !== voided);

  const naive =
    Math.max(...live.map((number) => numbering.parseDocumentNumber(number).sequence)) + 1;
  assert.equal(naive, 4, "max(live) + 1 really does reissue the voided number — this is the trap");

  const next = numbering.nextSequenceForYear(2026, 4, 2026);
  assert.deepEqual(next, { year: 2026, sequence: 5 });
  assert.equal(numbering.formatDocumentNumber("MS", next.year, next.sequence), "MS-2026-005");
  assert.notEqual(
    numbering.formatDocumentNumber("MS", next.year, next.sequence),
    voided,
    "the voided number stays spent, and the gap is the evidence",
  );

  /* And it holds however many are voided in a row. */
  let sequence = 4;
  for (let i = 0; i < 5; i += 1) {
    const step = numbering.nextSequenceForYear(2026, sequence, 2026);
    assert.equal(step.sequence, sequence + 1, "the counter only ever moves forward");
    sequence = step.sequence;
  }
  assert.equal(numbering.formatDocumentNumber("MS", 2026, sequence), "MS-2026-009");
});

test("the sequence restarts at 001 in a new year, and never in an older one", () => {
  assert.deepEqual(numbering.nextSequenceForYear(2026, 137, 2027), { year: 2027, sequence: 1 });
  assert.equal(numbering.formatDocumentNumber("MS", 2027, 1), "MS-2027-001");

  /* Within the year, it increments and nothing else. */
  assert.deepEqual(numbering.nextSequenceForYear(2027, 1, 2027), { year: 2027, sequence: 2 });

  /* A backdated document or a clock that steps back must NOT send the counter
     through numbers it has already spent. */
  assert.deepEqual(
    numbering.nextSequenceForYear(2027, 12, 2026),
    { year: 2027, sequence: 13 },
    "an earlier year does not reset — that would reissue 2026's numbers",
  );

  /* A brand new counter starts at one, not zero. */
  assert.deepEqual(numbering.nextSequenceForYear(2026, 0, 2026), { year: 2026, sequence: 1 });
});

test("a number is assigned at finalisation and at no other moment", () => {
  assert.equal(numbering.canAssignNumber("Finalised"), true);
  for (const status of [
    "Draft",
    "In review",
    "Ready for Review",
    "Approved",
    "Voided",
    "",
    null,
    undefined,
    "finalised",
  ]) {
    assert.equal(
      numbering.canAssignNumber(status),
      false,
      `${String(status)} must not consume a number`,
    );
  }
  /* Approved is the pointed one: §7 calls an approved document "not yet
     numbered", and it can still be sent back for review. */
  assert.equal(numbering.NUMBER_ASSIGNED_AT, "Finalised");
});

/* ---------------------------------------------------------------- waivers */

const ERRORS = [
  { code: "job.completed_without_date", severity: "error", subjectId: "job-1" },
  { code: "cost.without_job", severity: "blocking", subjectId: "cost-9" },
];
const NOISE = [
  { code: "site.name_inconsistent", severity: "warning", subjectId: "site-3" },
  { code: "tier.label_differs", severity: "info", subjectId: null },
];

test("only an error blocks, and 'blocking' is the same word as 'error'", () => {
  assert.equal(waivers.issueSeverity("error"), "error");
  assert.equal(
    waivers.issueSeverity("blocking"),
    "error",
    "contract.ts spells it 'blocking'; a gate that only looked for 'error' would let it through",
  );
  assert.equal(waivers.issueSeverity("warning"), "warning");
  assert.equal(waivers.issueSeverity("something new"), "info", "unknown must not block by accident");

  assert.equal(waivers.blocksFinalise(NOISE, []), false, "forty-eight warnings block nothing");
  assert.equal(waivers.blocksFinalise([...NOISE, ...ERRORS], []), true);

  /* The badge counts errors, not the total. */
  assert.equal(waivers.unwaivedBlockingIssues([...NOISE, ...ERRORS], []).length, 2);
});

test("a live waiver clears its error; a revoked one puts it straight back", () => {
  const waiver = {
    id: "w1",
    issueCode: "job.completed_without_date",
    subjectId: "job-1",
    reason: "Completion date confirmed by the contractor by email.",
    waivedByEmail: "owner@example.com",
    waivedAt: "2026-09-05T09:12:00.000Z",
    revokedAt: null,
  };

  /* One of the two errors waived: still blocked. */
  assert.equal(waivers.blocksFinalise(ERRORS, [waiver]), true);
  assert.deepEqual(
    waivers.unwaivedBlockingIssues(ERRORS, [waiver]).map((issue) => issue.code),
    ["cost.without_job"],
  );

  /* Both waived: not blocked. */
  const second = { ...waiver, id: "w2", issueCode: "cost.without_job", subjectId: "cost-9" };
  assert.equal(waivers.blocksFinalise(ERRORS, [waiver, second]), false);

  /* Revoked, and the block returns immediately. */
  const revoked = { ...second, revokedAt: "2026-09-06T10:00:00.000Z", revokedByEmail: "a@b.c" };
  assert.equal(waivers.blocksFinalise(ERRORS, [waiver, revoked]), true);

  /* A waiver for a different record does not travel. */
  const wrongSubject = { ...waiver, subjectId: "job-2" };
  assert.equal(waivers.blocksFinalise(ERRORS, [wrongSubject, second]), true);

  /* A waiver with no subject is the blanket form and covers every one. */
  const blanket = { ...waiver, subjectId: null };
  assert.deepEqual(
    waivers.unwaivedBlockingIssues(ERRORS, [blanket, second]).map((issue) => issue.code),
    [],
  );
});

test("a waiver with no typed reason is refused, whitespace included", () => {
  /*
   * §10: "waiving one requires a typed reason". A space bar pressed to get past
   * a required field is the same act as leaving it blank, and it is the likelier
   * of the two once the field is known to be mandatory.
   */
  for (const reason of ["", " ", "   ", "\t", "\n  \t ", null, undefined]) {
    const result = waivers.waiverRequiresReason({ reason });
    assert.equal(result.ok, false, `${JSON.stringify(reason)} is not a reason`);
    assert.match(result.error, /reason/i);
  }
  const ok = waivers.waiverRequiresReason({ reason: "  Confirmed by client.  " });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, "Confirmed by client.", "stored trimmed, so it prints as it reads");
});

test("the reason is printed in the report, not merely stored", () => {
  /*
   * The client is the one who needs to know an error was set aside, and they
   * never see the register. A waiver that exists only in a table is an override
   * with no audience.
   */
  const notes = waivers.waiverNotesForReport([
    {
      issueCode: "cost.without_job",
      subjectId: "cost-9",
      reason: "Visit-level cost agreed with the client on 3 September.",
      waivedByEmail: "owner@example.com",
      waivedAt: "2026-09-05T09:12:00.000Z",
    },
    {
      issueCode: "job.completed_without_date",
      subjectId: null,
      reason: "Dates reconciled against the contractor's own sheet.",
      waivedByEmail: null,
      waivedAt: null,
      revokedAt: null,
    },
    {
      issueCode: "duplicate.invoice_line",
      subjectId: "line-4",
      reason: "Raised in error and withdrawn.",
      waivedByEmail: "someone@example.com",
      waivedAt: "2026-09-05T09:20:00.000Z",
      revokedAt: "2026-09-06T08:00:00.000Z",
    },
  ]);

  assert.equal(notes.length, 2, "the revoked one excused nothing, so it is not printed as though it had");
  assert.match(notes[0], /cost\.without_job/);
  assert.match(notes[0], /cost-9/);
  assert.match(notes[0], /Visit-level cost agreed with the client on 3 September\./, "the reason itself");
  assert.match(notes[0], /owner@example\.com/, "who");
  assert.match(notes[0], /2026-09-05/, "and when");

  /* Missing attribution degrades; it never drops the note. */
  assert.match(notes[1], /Dates reconciled against the contractor's own sheet\./);
  assert.match(notes[1], /unrecorded/);
  assert.equal(notes.some((note) => /duplicate\.invoice_line/.test(note)), false);
});
