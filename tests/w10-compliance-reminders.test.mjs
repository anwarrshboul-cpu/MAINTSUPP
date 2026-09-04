/**
 * W10 — THE ADVANCE RENEWAL WARNINGS, AND THE RULE THAT THEY ARE NOT ROWS.
 *
 * The owner asked for a certificate to appear on the calendar 90, 60, 30 and 14
 * days before it lapses as well as on the day itself, with three conditions
 * attached: no duplicates, the marks move when the expiry moves, and they go
 * away when the document does.
 *
 * Every one of those three is a property of DERIVATION rather than a feature to
 * be built on top of stored reminder rows, which is why this file asserts them
 * by changing a record and re-deriving rather than by inspecting a table. A
 * persisted reminder would need a reconciler to run on a board date edit, a new
 * document version, a binned row and a slot marked Not required — four events,
 * one of which is a nightly job — and its failure mode is a calendar reminding
 * somebody about a certificate that was renewed last month.
 *
 * It CALLS the shipped module, the way `workstream-four-calendar-model.test.mjs`
 * does: `calendar-model.ts` is pure TypeScript, so it transpiles and imports for
 * real and these are assertions about the code that ships.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));
const expiryUrl = asModule(
  transpile(await read("app/lib/expiry-status.ts")).replace(
    /from ["']\.\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);
const metersUrl = asModule(
  transpile(await read("app/(app)/portal/dashboard-meters.ts")),
);

const calendar = await import(
  asModule(
    transpile(await read("app/(app)/portal/calendar-model.ts"))
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
      .replace(/from ["']\.\/dashboard-meters["']/g, `from "${metersUrl}"`),
  )
);

const TODAY = "2026-08-24";
const REMINDERS = ["compliance:reminder"];
const BOTH = ["compliance:expiry", "compliance:reminder"];

let sequence = 0;
function certificate(overrides = {}) {
  sequence += 1;
  return {
    id: `C-${sequence}`,
    siteId: "store-aldgate",
    siteName: "Aldgate",
    kind: "PAT Test",
    state: "Compliant",
    expiry: "2027-01-10",
    fileCount: 1,
    itemId: "9001",
    slotKey: "pat",
    expiryColumnKey: "patExpiry",
    expiryColumnId: "col-pat-expiry",
    ...overrides,
  };
}

const build = (input) =>
  calendar.buildCalendarEvents({
    requests: [],
    complianceRecords: [],
    sourceIds: BOTH,
    filters: calendar.EMPTY_CALENDAR_FILTERS,
    today: TODAY,
    ...input,
  });

/* ── The thresholds ──────────────────────────────────────────────────────── */

test("W10 the four thresholds are 90, 60, 30 and 14 days before the expiry", () => {
  assert.deepEqual([...calendar.COMPLIANCE_REMINDER_DAYS], [90, 60, 30, 14]);

  /*
   * The dates themselves, counted across a month boundary and a leap-year
   * February so the arithmetic is exercised rather than restated. 2028 is a
   * leap year: 90 days before 2028-05-01 is 2028-02-01 only if the 29th exists.
   */
  assert.deepEqual(calendar.complianceReminderDays("2028-05-01"), [
    { day: "2028-02-01", daysBefore: 90 },
    { day: "2028-03-02", daysBefore: 60 },
    { day: "2028-04-01", daysBefore: 30 },
    { day: "2028-04-17", daysBefore: 14 },
  ]);

  // The board's own date-decoration JSON, which the register flattens before
  // this ever sees it — but the parse is shared, so it is checked here too.
  assert.equal(
    calendar.complianceReminderDays('{"date":"2027-01-10","time":"09:15","icon":""}')[0].day,
    "2026-10-12",
  );
});

test("W10 a record with no usable date produces no reminders at all", () => {
  for (const value of [null, undefined, "", "   ", "not a date", "10/01/2027"]) {
    assert.deepEqual(
      calendar.complianceReminderDays(value),
      [],
      `${JSON.stringify(value)} must not become a reminder`,
    );
  }
  assert.deepEqual(build({ complianceRecords: [certificate({ expiry: null })] }), []);
});

/* ── What lands on the calendar ──────────────────────────────────────────── */

test("W10 one dated certificate draws its expiry and four warnings, and no more", () => {
  const events = build({ complianceRecords: [certificate({ expiry: "2027-01-10" })] });
  assert.equal(events.length, 5, "the expiry and exactly four warnings");

  /*
   * NO DUPLICATES, asserted on the KEY rather than on the count. Four reminders
   * for one record share a source id and a record id, so without the threshold
   * in the key React calls them duplicates and the grid draws four chips it
   * cannot tell apart. The keys are what make them distinct records to the
   * renderer, so the keys are what this checks.
   */
  assert.equal(new Set(events.map((event) => event.key)).size, 5, "five distinct keys");
  assert.deepEqual(
    events.map((event) => event.day),
    ["2026-10-12", "2026-11-11", "2026-12-11", "2026-12-27", "2027-01-10"],
    "sorted by day, warnings first and the lapse last",
  );
  assert.deepEqual(
    events.map((event) => event.fieldLabel),
    [
      "90-day reminder",
      "60-day reminder",
      "30-day reminder",
      "14-day reminder",
      "Certificate expiry",
    ],
    "each mark says which of the five it is",
  );

  // All of them are the Compliance kind, so the KEY row's existing vocabulary
  // covers them and nothing new had to be invented for a reader to learn.
  assert.deepEqual([...new Set(events.map((event) => event.kind))], ["compliance"]);
  for (const event of events) {
    assert.equal(event.recordId, events[0].recordId, "all five name the same record");
    assert.ok(event.title.endsWith(" renewal"), "the work implied is a renewal");
  }
});

test("W10 a reminder carries no time of day, because nothing recorded one", () => {
  const events = build({
    complianceRecords: [certificate({ expiry: "2027-01-10" })],
    sourceIds: REMINDERS,
  });
  assert.equal(events.length, 4);
  for (const event of events) assert.equal(event.time, "");
});

test("W10 the subtitle names the store and the date being warned about", () => {
  const events = build({
    complianceRecords: [certificate({ siteName: "Aldgate", expiry: "2027-01-10" })],
    sourceIds: REMINDERS,
  });
  for (const event of events) {
    assert.match(event.subtitle, /^Aldgate · expires /);
    /*
     * The date in the sentence is derived from the mark's own day plus its
     * offset, so it cannot contradict the mark it is printed on. Every one of
     * the four therefore names the SAME expiry.
     */
    assert.equal(event.subtitle, events[0].subtitle);
  }
});

/* ── The three conditions the owner attached ─────────────────────────────── */

test("W10 moving the expiry moves all four warnings with it, with nothing left behind", () => {
  const before = build({ complianceRecords: [certificate({ id: "C-x", expiry: "2027-01-10" })] });
  const after = build({ complianceRecords: [certificate({ id: "C-x", expiry: "2027-03-10" })] });

  assert.deepEqual(
    before.map((event) => event.day),
    ["2026-10-12", "2026-11-11", "2026-12-11", "2026-12-27", "2027-01-10"],
  );
  assert.deepEqual(
    after.map((event) => event.day),
    ["2026-12-10", "2027-01-09", "2027-02-08", "2027-02-24", "2027-03-10"],
  );

  /*
   * NOTHING IS LEFT BEHIND, which is the assertion a stored-reminder design
   * could not make cheaply: not one of the old days survives the move, because
   * there was never a row to survive. The count is unchanged too — a move
   * cannot accumulate reminders.
   */
  assert.equal(after.length, before.length);
  const stale = after.filter((event) => before.some((old) => old.day === event.day));
  assert.deepEqual(stale, [], "no warning from the old date is still on the calendar");
});

test("W10 a certificate that leaves the register takes its warnings with it", () => {
  /*
   * The three ways a document stops counting, and all three go through the
   * record rather than through anything reminder-specific:
   *
   *  · REPLACED — a new version supersedes the old, `liveAttachmentRows()` in
   *    app/lib/attachment-counts.ts counts only `is_current`, and the register
   *    re-derives the expiry from the board cell. Modelled here as the record
   *    arriving with the new date, which the test above covers.
   *  · REMOVED or ARCHIVED — the row leaves the board read, so the register
   *    emits nothing for it and there is no record to derive from.
   *  · NOT REQUIRED — an admin says the slot does not apply to this store.
   */
  assert.deepEqual(build({ complianceRecords: [] }), [], "no record, no marks");
  assert.deepEqual(
    build({ complianceRecords: [certificate({ state: "Not required" })] }),
    [],
    "a requirement that does not apply is not warned about four times",
  );
});

test("W10 a warning is never red; the lapse itself is", () => {
  const events = build({
    complianceRecords: [certificate({ state: "Expired", expiry: "2026-08-01" })],
  });
  assert.equal(events.length, 5);
  const overdue = events.filter((event) => event.timing === "overdue");
  assert.deepEqual(
    overdue.map((event) => event.fieldLabel),
    ["Certificate expiry"],
    "one red mark for one lapsed certificate, not five across the last quarter",
  );
  for (const event of events) {
    if (event.fieldLabel === "Certificate expiry") continue;
    assert.equal(event.timing, "past", "an elapsed warning is history, not lateness");
  }

  // A warning that lands on today is due today; one ahead of us is upcoming.
  const soon = build({
    complianceRecords: [certificate({ expiry: calendar.shiftCalendarDay(TODAY, 30) })],
    sourceIds: REMINDERS,
  });
  const byLabel = new Map(soon.map((event) => [event.fieldLabel, event]));
  assert.equal(byLabel.get("30-day reminder").timing, "due-today");
  assert.equal(byLabel.get("14-day reminder").timing, "upcoming");
  assert.equal(byLabel.get("60-day reminder").timing, "past");
});

/* ── A warning may not write ─────────────────────────────────────────────── */

test("W10 a reminder has no write path, so a drag cannot move it", () => {
  const events = build({
    complianceRecords: [certificate({ expiry: "2027-01-10" })],
    sourceIds: REMINDERS,
  });
  for (const event of events) {
    assert.equal(event.editable, false, `${event.fieldLabel} must not offer an edit`);
    const target = calendar.calendarWriteTarget(event);
    assert.equal(
      target.path,
      "none",
      "a projection of a date has no column of its own to write to",
    );
    assert.ok(target.reason.length > 0, "and it says so rather than failing silently");
    assert.equal(calendar.calendarEditCapability(event), null);
  }

  /*
   * WHILE THE EXPIRY STILL WRITES BACK TO THE BOARD CELL. This is the pairing
   * that matters: the canonical record is editable and the projection is not,
   * so "updating an event must update the CANONICAL record, not a calendar-only
   * copy" holds by construction rather than by a check in the drag handler.
   */
  const [expiry] = build({
    complianceRecords: [certificate({ expiry: "2027-01-10" })],
    sourceIds: ["compliance:expiry"],
  });
  assert.deepEqual(calendar.calendarWriteTarget(expiry), {
    path: "board-cell",
    boardId: "store-documentation",
    requestId: "9001",
    columnId: "col-pat-expiry",
    columnKey: "patExpiry",
  });
});

/* ── The source, and the filters ─────────────────────────────────────────── */

test("W10 the warnings are a source of their own and can be switched off", () => {
  const source = calendar.calendarDateSource("compliance:reminder");
  assert.ok(source, "the picker knows about them");
  assert.equal(source.entity, "compliance", "they read as Compliance in the KEY row");
  assert.equal(source.editable, false);
  assert.equal(source.defaultOn, true, "the owner asked to be warned in advance");
  assert.match(source.description, /90/);

  // Off: the expiry survives alone.
  const expiryOnly = build({
    complianceRecords: [certificate()],
    sourceIds: ["compliance:expiry"],
  });
  assert.equal(expiryOnly.length, 1);
  assert.equal(expiryOnly[0].fieldLabel, "Certificate expiry");

  // And the reverse — the two sources are independent, not nested.
  const remindersOnly = build({ complianceRecords: [certificate()], sourceIds: REMINDERS });
  assert.equal(remindersOnly.length, 4);
  assert.ok(remindersOnly.every((event) => event.fieldLabel.endsWith("-day reminder")));
});

test("W10 a warning obeys the same filters its certificate does", () => {
  const filters = {
    ...calendar.EMPTY_CALENDAR_FILTERS,
    complianceTypes: ["Sprinkler"],
  };
  assert.deepEqual(
    build({ complianceRecords: [certificate({ kind: "PAT Test" })], filters }),
    [],
    "filtering out the certificate filters out its four warnings",
  );
  assert.equal(
    build({ complianceRecords: [certificate({ kind: "Sprinkler" })], filters }).length,
    5,
    "and keeping it keeps them",
  );

  /*
   * A JOB FACET STILL LEAVES THEM ALONE. `compliancePasses` is the one
   * predicate, so this is the existing rule holding for a new kind of mark
   * rather than a second implementation of it.
   */
  assert.equal(
    build({
      complianceRecords: [certificate()],
      filters: { ...calendar.EMPTY_CALENDAR_FILTERS, priorities: ["Urgent"] },
    }).length,
    5,
  );
});

/* ── Nothing is persisted ────────────────────────────────────────────────── */

test("W10 no reminder is stored anywhere, and the source says so", async () => {
  const model = await read("app/(app)/portal/calendar-model.ts");

  /*
   * A SOURCE PIN, and it is the one assertion here that a behavioural test
   * cannot make: "there is no reminder table" is a statement about what does
   * NOT exist. If somebody later adds one, `complianceReminderDays` will still
   * pass every test above while a second, stale set of marks appears beside the
   * derived ones — so the derivation is pinned as the only producer.
   */
  assert.match(
    model,
    /export function complianceReminderDays\(/,
    "the reminders are computed from the expiry",
  );
  assert.doesNotMatch(
    model,
    /fetch\([^)]*reminder/i,
    "nothing fetches reminders — they are derived, not read",
  );

  const schema = await read("db/schema.ts");
  assert.doesNotMatch(
    schema,
    /complianceReminders?\s*=\s*sqliteTable/,
    "no reminder table: an expiry that moves would leave stored rows behind",
  );
});
