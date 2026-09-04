/**
 * The calendar's model.
 *
 * The portal's Calendar drew its grid with `new Date(value)` and LOCAL getters
 * over values this product stores as UTC midnight, so west of Greenwich every
 * job landed a day early — and the bug was invisible to anyone running the
 * tests in UTC. That is the reason this file exists and the reason it does two
 * different kinds of checking:
 *
 *   1. It CALLS the shipped module. `calendar-model.ts` is pure TypeScript with
 *      no React in it, exactly as `dashboard-meters.ts` is, so it transpiles
 *      and imports for real — the same trick `stage-twentythree-period.test.mjs`
 *      uses. These are calls into the code that ships, not into a
 *      re-implementation that could agree with itself while the screen is
 *      wrong. Every day assertion is then run a second time with TZ pinned to a
 *      negative offset, because that is where the original defect lived.
 *
 *   2. It reads the SOURCE for the local getters. A model that returns the
 *      right answer today because the machine happens to be in UTC would pass
 *      every behavioural assertion above. Banning `.getFullYear()`,
 *      `.getMonth()` and `.getDate()` outright is the check that survives the
 *      next person adding a helper.
 *
 * It also pins the provenance fields `/api/workspace` now carries, because a
 * certificate expiry edited on the calendar has to reach the same board cell
 * the Store Documentation board writes or the next register read silently
 * throws the edit away.
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
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/*
 * A data: URL cannot resolve a relative specifier, so each dependency is turned
 * into its own data: URL and substituted into its importer before that importer
 * is loaded. calendar-model.ts has three real runtime dependencies — the shared
 * en-GB formatter, `dateOnlyValue`, and `isClosedRequest` — and it calls all
 * three rather than restating what a date or a finished job is, which is the
 * point and is why this ceremony is worth it.
 */
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

const modelSource = await read("app/(app)/portal/calendar-model.ts");

/*
 * The same file with its prose removed. The comments in calendar-model.ts quote
 * the very things these assertions ban — `getDate()`, "09:00" — precisely
 * because they explain why the code does not do them, and a source check that
 * cannot tell an explanation from an instruction is a source check that will be
 * deleted the first time it fires wrongly.
 */
const modelCode = modelSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const formatters = await import(formatDateUrl);

const calendar = await import(
  asModule(
    transpile(modelSource)
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
      .replace(/from ["']\.\/dashboard-meters["']/g, `from "${metersUrl}"`),
  )
);

const TODAY = "2026-08-24"; // a Monday, deliberately, so week maths is visible.

let sequence = 0;
function job(overrides = {}) {
  sequence += 1;
  return {
    id: `J-${sequence}`,
    source: "Manual",
    title: `Job ${sequence}`,
    description: "",
    location: "Aldgate",
    siteId: "store-aldgate",
    requester: "",
    contact: "",
    category: "Lights",
    engineer: "",
    tier: 2,
    priority: "Medium",
    stage: "Incoming",
    status: "Pending Approval",
    contractor: "Apex Electrical",
    assignee: null,
    requestedAt: "2026-08-01T00:00:00.000Z",
    dueAt: null,
    completedAt: null,
    nextUpdateAt: null,
    cost: null,
    attachmentCount: 0,
    commentCount: 0,
    ...overrides,
  };
}

let certificate = 0;
function compliance(overrides = {}) {
  certificate += 1;
  return {
    id: `C-${certificate}`,
    siteId: "store-aldgate",
    siteName: "Aldgate",
    kind: "PAT Test",
    state: "Compliant",
    expiry: "2026-09-10",
    fileCount: 1,
    itemId: "9001",
    slotKey: "pat",
    expiryColumnKey: "patExpiry",
    ...overrides,
  };
}

const build = (input) =>
  calendar.buildCalendarEvents({
    requests: [],
    complianceRecords: [],
    sourceIds: calendar.DEFAULT_CALENDAR_SOURCE_IDS,
    filters: calendar.EMPTY_CALENDAR_FILTERS,
    today: TODAY,
    ...input,
  });

/**
 * THE EXPIRY MARK ON ITS OWN — and why several tests below now name it.
 *
 * W10 added a second compliance source, `compliance:reminder`, which draws the
 * four advance warnings (90/60/30/14 days) derived from the same expiry. It is
 * on by default, because the owner asked to be warned in advance rather than on
 * the day, so ONE dated certificate now produces FIVE marks on a default
 * calendar.
 *
 * Every test that had written `build({ complianceRecords: [one] })` and then
 * read `events[0]` or asserted `events.length === 1` was, without ever saying
 * so, asserting something about the EXPIRY mark. The pins are re-pointed at
 * that source by name rather than loosened: each one still asserts exactly what
 * it always did — the timing rule, the sort order, the facet semantics, the
 * write target — and now says which mark it is asserting it about. The
 * reminders get pins of their own in
 * `tests/w10-compliance-reminders.test.mjs`.
 */
const EXPIRY_ONLY = ["compliance:expiry"];

/* ── 1. A day is a day, in every timezone ────────────────────────────────── */

test("a UTC-midnight instant is the day it says, not the day before", () => {
  assert.equal(calendar.calendarDay("2026-08-24T00:00:00.000Z"), "2026-08-24");
  assert.equal(calendar.calendarDay("2026-08-24"), "2026-08-24");
  assert.equal(calendar.calendarDay("2026-08-24T23:30:00.000Z"), "2026-08-24");
  // The board's own date-metadata JSON, which `dateOnlyValue` already reads.
  assert.equal(
    calendar.calendarDay('{"date":"2026-08-24","time":"09:15","icon":""}'),
    "2026-08-24",
  );
});

test("an absent or unreadable value is no day at all, never a guess", () => {
  for (const value of [null, undefined, "", "   ", "not a date", "24/08/2026", "{"]) {
    assert.equal(
      calendar.calendarDay(value),
      "",
      `${JSON.stringify(value)} must not become a day`,
    );
  }
  // And no day means no event, rather than an event on some invented day.
  assert.equal(build({ requests: [job({ dueAt: null })] }).length, 0);
  assert.equal(build({ requests: [job({ dueAt: "not a date" })] }).length, 0);
});

test("the module never asks a Date for a LOCAL calendar field", () => {
  /*
   * This is the original defect, and it is the one assertion a green suite in
   * UTC cannot make on its own. `.getUTCDate()` is fine and is what the module
   * uses; `.getDate()` is what moved every job a day west of Greenwich.
   */
  const localGetters =
    /\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds|TimezoneOffset)\s*\(/g;
  const found = modelCode.match(localGetters);
  assert.equal(
    found,
    null,
    `local date getters in calendar-model.ts: ${found?.join(", ")}`,
  );
  assert.match(modelCode, /getUTCFullYear\(\)/, "it must read UTC fields instead");
  assert.match(
    modelCode,
    /dateOnlyValue/,
    "and normalise through the one shared normaliser rather than a tenth copy",
  );
});

test("todayCalendarDay matches the board's own definition of today", async () => {
  // 23:45Z is still today in UTC and already tomorrow nowhere that matters here.
  assert.equal(
    calendar.todayCalendarDay(new Date("2026-08-24T23:45:00.000Z")),
    "2026-08-24",
  );
  const boardFormat = await read("app/(app)/portal/board-format.ts");
  assert.match(
    boardFormat,
    /now\.getUTCFullYear\(\)/,
    "todayBoardDate reads UTC fields",
  );
  assert.match(
    modelSource,
    /now\.getUTCFullYear\(\)/,
    "and so must todayCalendarDay, or the two calendars highlight different days",
  );
});

/* ── 2. The grid ─────────────────────────────────────────────────────────── */

const utcWeekday = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

test("a week starts on Monday", () => {
  assert.equal(calendar.startOfCalendarWeek("2026-08-24"), "2026-08-24");
  // Sunday belongs to the week that began six days earlier, not the next one.
  assert.equal(calendar.startOfCalendarWeek("2026-08-23"), "2026-08-17");
  assert.equal(calendar.startOfCalendarWeek("2026-08-30"), "2026-08-24");

  const days = calendar.calendarWeekDays("2026-08-27");
  assert.equal(days.length, 7);
  assert.deepEqual(days, [
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
    "2026-08-29",
    "2026-08-30",
  ]);
  assert.equal(utcWeekday(days[0]), 1, "the first cell is a Monday");
});

test("a month grid is always six rows of seven, Monday first", () => {
  for (const anchor of [
    "2026-08-24",
    "2026-02-01", // 28 days starting on a Sunday — the shortest possible month
    "2026-01-15",
    "2024-02-29", // a leap day
    "2026-11-30",
  ]) {
    const grid = calendar.calendarMonthGrid(anchor);
    assert.equal(grid.length, 42, `${anchor} did not produce 42 cells`);
    assert.equal(utcWeekday(grid[0]), 1, `${anchor} did not start on a Monday`);
    assert.equal(
      grid.includes(`${anchor.slice(0, 7)}-01`),
      true,
      `${anchor}'s own first day is missing from its grid`,
    );
    // Every cell is one day after the last — no gaps, no repeats, no DST hole.
    for (let index = 1; index < grid.length; index += 1) {
      assert.equal(
        calendar.shiftCalendarDay(grid[index - 1], 1),
        grid[index],
        `${anchor}: cell ${index} is not the day after cell ${index - 1}`,
      );
    }
  }
});

test("February is where a month step has to clamp rather than overflow", () => {
  assert.equal(calendar.shiftCalendarMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(calendar.shiftCalendarMonth("2024-03-31", -1), "2024-02-29");
  assert.equal(calendar.shiftCalendarMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(calendar.shiftCalendarMonth("2026-12-01", 1), "2027-01-01");
  assert.equal(calendar.startOfCalendarMonth("2026-08-24"), "2026-08-01");
  assert.equal(calendar.isSameCalendarMonth("2026-08-01", "2026-08-31"), true);
  assert.equal(calendar.isSameCalendarMonth("2026-08-31", "2026-09-01"), false);
});

test("the headings read in en-GB and never lose the changing half of a range", () => {
  assert.equal(calendar.calendarRangeLabel("month", "2026-08-24"), "August 2026");
  assert.equal(
    calendar.calendarRangeLabel("day", "2026-08-24"),
    "Monday 24 August 2026",
  );
  assert.equal(calendar.calendarRangeLabel("week", "2026-08-24"), "24 – 30 Aug 2026");
  /*
   * A week that straddles a month keeps both months, and the year is printed
   * once, on the right. The month word itself comes from the shared en-GB
   * formatter — CLDR abbreviates September as "Sept" — so it is taken from
   * there rather than typed out here, which is the whole point of there being
   * one formatter.
   */
  assert.equal(
    calendar.calendarRangeLabel("week", "2026-08-31"),
    `31 Aug – ${formatters.formatShortDate("2026-09-06")}`,
  );
  // A week that straddles a year keeps both years.
  assert.equal(
    calendar.calendarRangeLabel("week", "2025-12-31"),
    `${formatters.formatShortDate("2025-12-29")} – ${formatters.formatShortDate("2026-01-04")}`,
  );
  assert.match(calendar.calendarRangeLabel("week", "2025-12-31"), /2025 – .*2026$/);
  assert.equal(
    calendar.calendarRangeLabel("week", "2026-08-24").match(/2026/g).length,
    1,
    "a week inside one month prints its year once",
  );
  assert.equal(calendar.calendarDayLabel("2026-08-24"), "24 August 2026");
  assert.equal(calendar.calendarWeekdayLabel("2026-08-24"), "Mon");
  assert.equal(calendar.calendarWeekdayLabel("2026-08-23"), "Sun");
});

/* ── 3. Times that are real, and times that are not ──────────────────────── */

test("only a time somebody chose is a time; a stored instant's clock is not", () => {
  assert.equal(calendar.calendarTimeOfDay("2026-08-24"), "");
  /*
   * `optionalIsoDate` turns every `YYYY-MM-DD` the UI sends into exactly this
   * string, so treating it as "due at 00:00" would put a time on every date
   * anybody has ever typed into this product.
   */
  assert.equal(calendar.calendarTimeOfDay("2026-08-24T00:00:00.000Z"), "");
  /*
   * And this is a real value from Staging: the instant a seeded row was
   * created, landing in `due_at`. Nobody scheduled a job for 04:33, so the
   * calendar must not claim they did.
   */
  assert.equal(calendar.calendarTimeOfDay("2026-08-25T04:33:26.755Z"), "");
  assert.equal(calendar.calendarTimeOfDay("2026-08-24T14:05:00.000Z"), "");
  assert.equal(calendar.calendarTimeOfDay(null), "");
  assert.equal(calendar.calendarTimeOfDay("not a date"), "");

  // The board's date decoration is the one seam a chosen time arrives through.
  assert.equal(
    calendar.calendarTimeOfDay('{"date":"2026-08-24","time":"09:15"}'),
    "09:15",
  );
  // Which is exactly how the compliance cells store it today — with no time.
  assert.equal(
    calendar.calendarTimeOfDay('{"date":"2026-08-21","time":"","icon":""}'),
    "",
  );
  assert.doesNotMatch(
    modelCode,
    /["'`]\d{2}:\d{2}["'`]/,
    "no default hour may be invented — no literal clock in the code at all",
  );

  for (const dueAt of [
    "2026-08-25",
    "2026-08-25T00:00:00.000Z",
    "2026-08-25T04:33:26.755Z",
  ]) {
    const events = build({ requests: [job({ dueAt })] });
    assert.equal(events.length, 1);
    assert.equal(events[0].day, "2026-08-25");
    assert.equal(events[0].time, "", `${dueAt} must not surface a clock`);
  }
});

/* ── 4. Timing ───────────────────────────────────────────────────────────── */

test("a finished job with a due date long past is resolved, not overdue", () => {
  /*
   * The rule is `timingOf` in views/fix-tracker.tsx: finished work is never
   * late, whatever its dates say. 187 of the board's completed jobs carry no
   * completion date, which is why the stage counts as well as the date.
   */
  const byStage = build({
    requests: [job({ dueAt: "2026-01-05", stage: "Completed", completedAt: null })],
  });
  assert.equal(byStage[0].timing, "resolved");

  const byDate = build({
    requests: [job({ dueAt: "2026-01-05", completedAt: "2026-01-06T00:00:00.000Z" })],
  });
  assert.equal(byDate[0].timing, "resolved");

  // Still open, and the day is behind us: that one really is overdue.
  const open = build({ requests: [job({ dueAt: "2026-01-05" })] });
  assert.equal(open[0].timing, "overdue");

  assert.equal(build({ requests: [job({ dueAt: TODAY })] })[0].timing, "due-today");
  assert.equal(
    build({ requests: [job({ dueAt: "2026-09-01" })] })[0].timing,
    "upcoming",
  );
});

test("a completion date is a record of the past and can never be overdue", () => {
  const events = build({
    requests: [
      job({
        completedAt: "2026-01-05T00:00:00.000Z",
        stage: "Incoming",
        status: "Pending Approval",
      }),
    ],
    sourceIds: ["job:completedAt"],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].timing, "resolved");
});

test("a certificate is overdue when the register says Expired, and past otherwise", () => {
  const expired = build({
    complianceRecords: [compliance({ state: "Expired", expiry: "2026-06-01" })],
    sourceIds: EXPIRY_ONLY,
  });
  assert.equal(expired[0].timing, "overdue");

  const lapsedButNotFlagged = build({
    complianceRecords: [compliance({ state: "Compliant", expiry: "2026-06-01" })],
    sourceIds: EXPIRY_ONLY,
  });
  assert.equal(lapsedButNotFlagged[0].timing, "past");

  assert.equal(
    build({ complianceRecords: [compliance({ expiry: TODAY })], sourceIds: EXPIRY_ONLY })[0]
      .timing,
    "due-today",
  );
  assert.equal(
    build({ complianceRecords: [compliance({ expiry: "2026-12-01" })], sourceIds: EXPIRY_ONLY })[0]
      .timing,
    "upcoming",
  );
});

test("a requirement that does not apply to a store puts nothing on the calendar", () => {
  const events = build({
    complianceRecords: [
      compliance({ state: "Not required", expiry: "2026-09-10" }),
      compliance({ state: "Not required", expiry: null }),
    ],
  });
  assert.equal(events.length, 0, "`Not required` must produce no event");

  // And it is not offered as a filter value either, since it can never match.
  const options = calendar.calendarFilterOptions({
    requests: [],
    complianceRecords: [
      compliance({ kind: "Sprinkler", state: "Not required" }),
      compliance({ kind: "PAT Test", state: "Compliant" }),
    ],
  });
  assert.deepEqual(
    options.complianceTypes.map((option) => option.value),
    ["PAT Test"],
  );
});

/* ── 5. Sources ──────────────────────────────────────────────────────────── */

test("seven sources, four of them on by default", () => {
  /*
   * RE-POINTED, NOT RELAXED. This was five and two. W10 added
   * `compliance:reminder` — the four advance warnings, derived from the same
   * expiry and stored nowhere — because the owner asked for a certificate to
   * appear 90, 60, 30 and 14 days before it lapses as well as on the day.
   *
   * It is on by DEFAULT and that is the substance of the requirement rather
   * than a convenience: a warning nobody switched on is a warning nobody gets.
   *
   * W11 then added `manual:item`, the hand-added notes, which is on by default
   * for the sharper version of the same reason: an item somebody TYPED onto
   * this calendar and then could not see would be the worst possible outcome of
   * the feature.
   *
   * The list is still exhaustive and still in picker order, so an eighth source
   * appearing without a decision still fails here.
   */
  assert.deepEqual(
    calendar.CALENDAR_DATE_SOURCES.map((source) => source.id),
    [
      "job:dueAt",
      "job:requestedAt",
      "job:completedAt",
      "job:nextUpdateAt",
      "compliance:expiry",
      "compliance:reminder",
      "manual:item",
    ],
  );
  assert.deepEqual(
    [...calendar.DEFAULT_CALENDAR_SOURCE_IDS],
    ["job:dueAt", "compliance:expiry", "compliance:reminder", "manual:item"],
  );
  assert.equal(calendar.calendarDateSource("job:dueAt").label, "Due Date");
  assert.equal(
    calendar.calendarDateSource("compliance:expiry").label,
    "Certificate expiry",
  );
  assert.equal(calendar.calendarDateSource("job:invented"), null);
  for (const source of calendar.CALENDAR_DATE_SOURCES) {
    assert.ok(source.description.length > 0, `${source.id} needs a sentence`);
  }
});

test("one job can appear on five layers without colliding with itself", () => {
  const events = build({
    requests: [
      job({
        id: "J-many",
        requestedAt: "2026-08-20T00:00:00.000Z",
        dueAt: "2026-08-26",
        completedAt: "2026-08-27T00:00:00.000Z",
        nextUpdateAt: "2026-08-25",
      }),
    ],
    sourceIds: calendar.CALENDAR_DATE_SOURCES.map((source) => source.id),
  });
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((event) => event.key)).size, 4);
  assert.deepEqual(
    events.map((event) => event.day),
    ["2026-08-20", "2026-08-25", "2026-08-26", "2026-08-27"],
    "events come back sorted by day",
  );
});

test("events are sorted by day, then jobs before certificates, then title", () => {
  const events = build({
    requests: [job({ title: "Zebra", dueAt: TODAY }), job({ title: "Apple", dueAt: TODAY })],
    complianceRecords: [compliance({ kind: "PAT Test", expiry: TODAY })],
    sourceIds: [...calendar.DEFAULT_CALENDAR_SOURCE_IDS.filter((id) => id !== "compliance:reminder")],
  });
  /* "renewal" on the certificate title: the date on a certificate is the day it
     stops being valid, and the work it implies is booking the renewal. */
  assert.deepEqual(
    events.map((event) => `${event.kind}:${event.title}`),
    ["job:Apple", "job:Zebra", "compliance:PAT Test renewal"],
  );

  const byDay = calendar.groupCalendarEventsByDay(events);
  assert.deepEqual([...byDay.keys()], [TODAY]);
  assert.equal(byDay.get(TODAY).length, 3);
});

/* ── 6. Filters ──────────────────────────────────────────────────────────── */

test("an empty facet constrains nothing", () => {
  const events = build({
    requests: [job({ dueAt: TODAY })],
    complianceRecords: [compliance({ expiry: TODAY })],
    sourceIds: ["job:dueAt", ...EXPIRY_ONLY],
  });
  assert.equal(events.length, 2);
  assert.equal(calendar.calendarFilterCount(calendar.EMPTY_CALENDAR_FILTERS), 0);
  assert.equal(
    calendar.calendarFilterCount({
      ...calendar.EMPTY_CALENDAR_FILTERS,
      sites: ["a", "b"],
      priorities: ["Urgent"],
    }),
    3,
    "the badge counts chosen values, not facets",
  );
});

test("a job facet narrows jobs and leaves certificates alone", () => {
  /*
   * Picking "Urgent" must not empty the compliance layer. No certificate has a
   * priority, and a grid that answers "nothing expires" to that question is
   * worse than one that answers nothing at all.
   */
  const filters = {
    ...calendar.EMPTY_CALENDAR_FILTERS,
    priorities: ["Urgent"],
    statuses: ["Booked"],
    contractors: ["Someone Else"],
    jobTypes: ["Glass"],
  };
  const events = build({
    requests: [job({ dueAt: TODAY, priority: "Medium" })],
    complianceRecords: [compliance({ expiry: TODAY })],
    filters,
    sourceIds: ["job:dueAt", ...EXPIRY_ONLY],
  });
  assert.deepEqual(events.map((event) => event.kind), ["compliance"]);

  // And the mirror: a compliance facet must not empty the job layer. The
  // reminders obey the same facet, so this narrows to the expiry mark and
  // `w10-compliance-reminders.test.mjs` pins that they do.
  const mirrored = build({
    requests: [job({ dueAt: TODAY })],
    complianceRecords: [compliance({ expiry: TODAY, kind: "PAT Test" })],
    filters: { ...calendar.EMPTY_CALENDAR_FILTERS, complianceTypes: ["Sprinkler"] },
    sourceIds: ["job:dueAt", ...EXPIRY_ONLY],
  });
  assert.deepEqual(mirrored.map((event) => event.kind), ["job"]);
});

test("site is the one facet both layers share", () => {
  const filters = {
    ...calendar.EMPTY_CALENDAR_FILTERS,
    sites: ["store-elephant"],
  };
  const events = build({
    requests: [job({ dueAt: TODAY, siteId: "store-aldgate" })],
    complianceRecords: [compliance({ expiry: TODAY, siteId: "store-aldgate" })],
    filters,
  });
  assert.equal(events.length, 0, "site narrows jobs AND certificates");
});

test("blank contractor is a value somebody can choose", () => {
  const options = calendar.calendarFilterOptions({
    requests: [
      job({ contractor: null }),
      job({ contractor: "   " }),
      job({ contractor: "Apex Electrical" }),
    ],
    complianceRecords: [],
  });
  const blank = options.contractors.find((option) => option.value === "");
  assert.ok(blank, "there must be a sentinel option for jobs with no contractor");
  assert.equal(blank.label, "No contractor");
  assert.equal(blank.count, 2, "null and whitespace are the same absence");
  assert.equal(
    options.contractors[options.contractors.length - 1].value,
    "",
    "and it sorts last rather than at the top under a blank label",
  );

  const events = build({
    requests: [
      job({ dueAt: TODAY, contractor: null, title: "Unassigned" }),
      job({ dueAt: TODAY, contractor: "Apex Electrical", title: "Assigned" }),
    ],
    filters: { ...calendar.EMPTY_CALENDAR_FILTERS, contractors: [""] },
  });
  assert.deepEqual(events.map((event) => event.title), ["Unassigned"]);
});

test("a site keeps its id as the value and gets the best name available", () => {
  const options = calendar.calendarFilterOptions({
    requests: [
      job({ siteId: "store-aldgate", location: "Aldgate typed by hand" }),
      // A legacy row whose site id is a bare board item id, which several are.
      job({ siteId: "9001", location: "Elephant & Castle" }),
      job({ siteId: "", location: "" }),
    ],
    complianceRecords: [compliance({ siteId: "store-aldgate", siteName: "Aldgate" })],
  });
  const values = options.sites.map((option) => option.value);
  assert.equal(values.includes("store-aldgate"), true);
  assert.equal(values.includes("9001"), true, "an odd site id must not be dropped");
  assert.equal(values.includes(""), true, "nor must a missing one");
  const aldgate = options.sites.find((option) => option.value === "store-aldgate");
  assert.equal(aldgate.label, "Aldgate", "the register's name beats free text");
  assert.equal(aldgate.count, 2, "a site is counted across both layers");
});

test("facet options are counted from the data, so nothing offered returns nothing", () => {
  const options = calendar.calendarFilterOptions({
    requests: [
      job({ status: "Booked", priority: "Urgent", category: "Glass" }),
      job({ status: "Booked", priority: "Medium", category: "Locks" }),
    ],
    complianceRecords: [compliance({ kind: "Fire Alarm" })],
  });
  assert.deepEqual(
    options.statuses.map((option) => [option.value, option.count]),
    [["Booked", 2]],
  );
  assert.deepEqual(
    options.jobTypes.map((option) => option.value),
    ["Glass", "Locks"],
    "job type is the board's Label column, alphabetical",
  );
  assert.deepEqual(
    options.complianceTypes.map((option) => option.value),
    ["Fire Alarm"],
  );
});

test("job type is the board's own category, never inferred from the words", () => {
  assert.match(
    modelSource,
    /jobTypes,\s*request\.category/,
    "jobTypes must read `category`, which is monday's Label column",
  );
  assert.doesNotMatch(
    modelSource,
    /request\.(title|description)\s*\.\s*(includes|match|toLowerCase)/,
    "nothing may guess a job's type from its text",
  );
});

/* ── 7. Where an edit goes ───────────────────────────────────────────────── */

/**
 * The single event a fixture is expected to produce, and there must be exactly
 * one.
 *
 * `sourceIds` DEFAULTS TO THE EXPIRY MARK for the compliance cases below.
 * Every one of them names one record and asks where its date is written, which
 * has only ever been a question about the expiry: the four advance warnings
 * W10 derives from it carry no column of their own and `calendarWriteTarget`
 * refuses them by design. Leaving this on the default source set would have
 * turned "exactly one" into "exactly five" and the pin would have been read as
 * broken rather than as re-pointed. The job cases pass their own source and are
 * untouched.
 */
const onlyEvent = (input) => {
  const events = build({ sourceIds: EXPIRY_ONLY, ...input });
  assert.equal(events.length, 1);
  return events[0];
};

test("a job date is written through PATCH /api/maintenance", () => {
  for (const [sourceId, field, overrides] of [
    ["job:dueAt", "dueAt", { dueAt: TODAY }],
    ["job:requestedAt", "requestedAt", { requestedAt: TODAY }],
    ["job:completedAt", "completedAt", { completedAt: TODAY }],
    ["job:nextUpdateAt", "nextUpdateAt", { nextUpdateAt: TODAY }],
  ]) {
    const event = onlyEvent({
      requests: [job({ id: `J-${field}`, requestedAt: null, ...overrides })],
      sourceIds: [sourceId],
    });
    assert.deepEqual(calendar.calendarWriteTarget(event), {
      path: "job",
      id: `J-${field}`,
      field,
    });
    assert.equal(calendar.calendarEditCapability(event), "board.edit");
  }
});

test("a board-derived expiry goes back to the board cell it was read from", () => {
  /*
   * Writing the register copy instead would be overwritten on the next read:
   * `readComplianceRegister` recomputes state from the board cell every time.
   */
  const event = onlyEvent({
    complianceRecords: [
      compliance({
        itemId: "9001",
        slotKey: "pat",
        expiryColumnKey: "patExpiry",
        expiryColumnId: "col-pat-expiry",
      }),
    ],
  });
  assert.deepEqual(calendar.calendarWriteTarget(event), {
    path: "board-cell",
    boardId: "store-documentation",
    requestId: "9001",
    columnId: "col-pat-expiry",
    columnKey: "patExpiry",
  });
  assert.equal(calendar.calendarEditCapability(event), "board.edit");
});

test("a board-derived expiry with no live column refuses rather than 404s", () => {
  /*
   * `update_cell` looks a column up by ID scoped to a board; a key comes back
   * 404 and reads to the operator as an outage. A workspace that never seeded
   * Store Documentation, or one where the column was deleted, has the slot but
   * no column — so `/api/workspace` sends `expiryColumnId: null` and the answer
   * is a sentence, not a request that cannot succeed.
   */
  const event = onlyEvent({
    complianceRecords: [
      compliance({
        itemId: "9001",
        slotKey: "pat",
        expiryColumnKey: "patExpiry",
        expiryColumnId: null,
      }),
    ],
  });
  const target = calendar.calendarWriteTarget(event);
  assert.equal(target.path, "none");
  assert.match(target.reason, /Store Documentation board/);
  assert.equal(calendar.calendarEditCapability(event), null);
});

test("a register-only expiry goes through PATCH /api/workspace", () => {
  const event = onlyEvent({
    complianceRecords: [
      compliance({
        id: "compliance-elephant-pli",
        itemId: null,
        slotKey: null,
        expiryColumnKey: null,
      }),
    ],
  });
  /*
   * `siteId`, `kind` and `state` ride along because that PATCH REPLACES all of
   * them in one statement — sending the expiry alone would blank a certificate's
   * site and requirement name.
   */
  assert.deepEqual(calendar.calendarWriteTarget(event), {
    path: "workspace-compliance",
    id: "compliance-elephant-pli",
    siteId: "store-aldgate",
    kind: "PAT Test",
    state: "Compliant",
  });
  assert.equal(calendar.calendarEditCapability(event), "sites.edit");
});

test("a board slot with no expiry column has nowhere to write and says so", () => {
  const event = onlyEvent({
    complianceRecords: [
      compliance({ kind: "RAMS", itemId: "9001", slotKey: "rams", expiryColumnKey: null }),
    ],
  });
  const target = calendar.calendarWriteTarget(event);
  assert.equal(target.path, "none");
  assert.ok(target.reason.length > 0, "a read-only date must explain itself");
  assert.equal(calendar.calendarEditCapability(event), null);
});

test("the three slots that can never carry a date are still the same three", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const dateless = [...spec.matchAll(/label:\s*"([^"]+)",\s*\n\s*fileColumn:[^\n]*\n\s*expiryColumn:\s*null/g)]
    .map((match) => match[1]);
  assert.deepEqual(dateless, ["RAMS", "Fire Risk Assessment", "Drawing"]);
});

/* ── 8. The provenance the route now carries ─────────────────────────────── */

test("WorkspaceComplianceRecord carries where the record came from", async () => {
  const data = await read("app/lib/workspace-data.ts");
  assert.match(data, /itemId\?: string \| null;/, "the board row id");
  assert.match(data, /slotKey\?: string \| null;/, "the slot key");
  assert.match(data, /expiryColumnKey\?: string \| null;/, "and the date column");
  assert.match(
    data,
    /expiryColumnId\?: string \| null;/,
    "and that column's id, because update_cell 404s on a key",
  );
  // Optional, so every existing consumer of the register is untouched.
  assert.doesNotMatch(data, /\n  itemId: string \| null;/);
});

test("/api/workspace populates them from the one slot table", async () => {
  const route = await read("app/api/workspace/route.ts");
  assert.match(
    route,
    /import \{ storeDocumentationCertificates \} from "\.\.\/\.\.\/\.\.\/db\/monday-board-spec";/,
    "the slot table is imported, not restated",
  );
  assert.match(route, /itemId: entry\.itemId,/);
  assert.match(route, /slotKey: entry\.slotKey,/);
  assert.match(
    route,
    /const expiryColumnKey = entry\.slotKey/,
    "the expiry column is resolved from the slot key",
  );
  assert.match(
    route,
    /expiryColumnBySlot = new Map\(\s*storeDocumentationCertificates\.map/,
    "and resolved through that table rather than a second copy of it",
  );
  /*
   * And the id from the board itself. Resolved here rather than in the browser,
   * which would otherwise have to fetch the whole Store Documentation board —
   * rows, cells and all — to learn one string.
   */
  assert.match(
    route,
    /columnIdByKey = new Map\(/,
    "the column id is resolved server-side",
  );
  assert.match(
    route,
    /eq\(maintenanceBoardColumns\.boardId, STORE_DOCUMENTATION_BOARD_ID\)/,
    "scoped to the Store Documentation board",
  );
  assert.match(
    route,
    /isNull\(maintenanceBoardColumns\.deletedAt\)/,
    "a deleted column must not be offered as a write target",
  );
  assert.match(route, /expiryColumnId: expiryColumnKey/);
});

test("the model is pure — no React, no client directive, no clock of its own", () => {
  // The directive, not the words: the header explains why there is not one.
  assert.doesNotMatch(modelSource, /^\s*"use client";/m);
  assert.doesNotMatch(modelSource, /from "react"/);
  assert.doesNotMatch(
    modelSource,
    /buildCalendarEvents[\s\S]{0,400}new Date\(\)/,
    "`today` is injected so one instant classifies the whole grid",
  );
});

/* ── 9. The same answers west of Greenwich ───────────────────────────────── */

test("every day answer is identical with the clock set to Los Angeles", async () => {
  /*
   * The original bug was invisible in UTC and wrong for every user in the
   * Americas. Re-running the day maths in a child process with TZ pinned is
   * what makes this suite able to see it.
   */
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  /*
   * Real files in a temp directory rather than a data: URL on the command line:
   * the transpiled model is ~25kB and Windows refuses a `node -e` argument that
   * long (ENAMETOOLONG). Same modules, resolved as siblings.
   */
  const dir = mkdtempSync(path.join(tmpdir(), "calendar-tz-"));
  const write = (name, source) => {
    writeFileSync(path.join(dir, name), source, "utf8");
    return `./${name}`;
  };
  write("format-date.mjs", transpile(await read("app/lib/format-date.ts")));
  write(
    "expiry-status.mjs",
    transpile(await read("app/lib/expiry-status.ts")).replace(
      /from ["']\.\/format-date["']/g,
      'from "./format-date.mjs"',
    ),
  );
  write(
    "dashboard-meters.mjs",
    transpile(await read("app/(app)/portal/dashboard-meters.ts")),
  );
  write(
    "calendar-model.mjs",
    transpile(modelSource)
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, 'from "./format-date.mjs"')
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, 'from "./expiry-status.mjs"')
      .replace(/from ["']\.\/dashboard-meters["']/g, 'from "./dashboard-meters.mjs"'),
  );
  const probe = path.join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `
    import * as calendar from "./calendar-model.mjs";
    const out = {
      day: calendar.calendarDay("2026-08-24T00:00:00.000Z"),
      today: calendar.todayCalendarDay(new Date("2026-08-24T04:00:00.000Z")),
      week: calendar.startOfCalendarWeek("2026-08-23"),
      grid: calendar.calendarMonthGrid("2026-08-24").length,
      first: calendar.calendarMonthGrid("2026-08-24")[0],
      time: calendar.calendarTimeOfDay("2026-08-24T00:00:00.000Z"),
      label: calendar.calendarDayLabel("2026-08-24"),
    };
    process.stdout.write(JSON.stringify(out));
  `,
    "utf8",
  );

  const run = (timeZone) =>
    JSON.parse(
      execFileSync(process.execPath, [probe], {
        env: { ...process.env, TZ: timeZone },
        encoding: "utf8",
      }),
    );

  const utc = run("UTC");
  const west = run("America/Los_Angeles");
  const east = run("Pacific/Kiritimati"); // UTC+14, the other extreme
  assert.deepEqual(west, utc, "the calendar moved a day west of Greenwich");
  assert.deepEqual(east, utc, "the calendar moved a day east of the dateline");
  assert.equal(utc.day, "2026-08-24");
  assert.equal(utc.today, "2026-08-24");
  assert.equal(utc.grid, 42);
  assert.equal(utc.time, "");
});
