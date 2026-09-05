/**
 * W11 — MANUAL CALENDAR ITEMS.
 *
 * "We must also be able to add and adjust additional calendar items manually",
 * with one condition attached that outranks the feature itself: a manual item
 * must never masquerade as a Job.
 *
 * That condition is what most of this file is about, and it is asserted
 * STRUCTURALLY rather than visually. A screenshot proves a chip is teal today;
 * what has to hold is that a manual item cannot become a job — it is a row in
 * its own table, with its own entity, its own icon, its own write path and its
 * own entry in the KEY row, and nothing counts it as work. Colour is the last
 * and weakest of those, which is why the legend's own comment says a key that
 * reads "the teal ones are manual" stops being true the moment somebody picks a
 * different teal.
 *
 * The span and drop arithmetic is exercised against DATES, by calling the
 * shipped model — a multi-day item dragged by its middle day is where an
 * off-by-one in this feature would live, and no source pin can see one.
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
/*
 * The record-type vocabulary — Note / Planned visit / Certificate — which
 * `calendar-model.ts` reads to colour a manual chip and to decide that an
 * expired certificate is overdue while a note in the past is merely past. Pure
 * and importing nothing itself, so it transpiles on its own like the rest.
 */
const itemTypesUrl = asModule(
  transpile(await read("app/(app)/portal/calendar-item-types.ts")),
);

const metersUrl = asModule(
  transpile(await read("app/(app)/portal/dashboard-meters.ts")),
);

const calendar = await import(
  asModule(
    transpile(await read("app/(app)/portal/calendar-model.ts"))
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
      .replace(/from ["']\.\/dashboard-meters["']/g, `from "${metersUrl}"`)
      .replace(/from ["']\.\/calendar-item-types["']/g, `from "${itemTypesUrl}"`),
  )
);

/** Comments are prose and may say anything; the source pins read code only. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TODAY = "2026-08-24";
const MANUAL_ONLY = ["manual:item"];

let sequence = 0;
function item(overrides = {}) {
  sequence += 1;
  return {
    id: `cal-${sequence}`,
    title: `Item ${sequence}`,
    notes: null,
    siteId: null,
    startsOn: "2026-08-26",
    endsOn: null,
    allDay: true,
    category: "Manual",
    colour: null,
    createdByEmail: "owner@maintsupp.com",
    archived: false,
    ...overrides,
  };
}

const build = (input) =>
  calendar.buildCalendarEvents({
    requests: [],
    complianceRecords: [],
    manualItems: [],
    sourceIds: MANUAL_ONLY,
    filters: calendar.EMPTY_CALENDAR_FILTERS,
    today: TODAY,
    ...input,
  });

/* ── It is a third kind, not a job wearing a flag ────────────────────────── */

test("W11 a manual item is its own entity, table and write path", async () => {
  const model = codeOnly(await read("app/(app)/portal/calendar-model.ts"));
  assert.match(
    model,
    /export type CalendarEntity = "job" \| "compliance" \| "manual";/,
    "three kinds, so nothing has to be told apart by a flag",
  );

  /*
   * A TABLE OF ITS OWN. The alternative — a `maintenance_requests` row with a
   * kind — is the one this must not be: that table is counted by the Overview
   * meters, the SLA report, the Fix Tracker, the contractor figures, every
   * board view and the CSV export, and every one of them would have to learn
   * about the flag on the same day for the counts to stay true.
   */
  const schema = await read("db/schema.ts");
  assert.match(schema, /export const calendarEvents = sqliteTable\(\s*"calendar_events"/);

  const route = await read("app/api/maintenance/calendar/route.ts");
  const routeCode = codeOnly(route);
  assert.doesNotMatch(
    routeCode,
    /maintenanceRequests/,
    "the manual write path must not touch the jobs table",
  );
  for (const verb of ["export async function GET", "export async function POST", "export async function PATCH", "export async function DELETE"]) {
    assert.match(routeCode, new RegExp(verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("W11 every read and write is scoped to one organisation", async () => {
  const route = codeOnly(await read("app/api/maintenance/calendar/route.ts"));

  /*
   * THE TENANT FILTER IS IN THE WHERE, NEVER A CHECK ON THE ROW AFTERWARDS.
   * Counted rather than eyeballed: one `organisationId` predicate per statement
   * that touches the table, so a statement added without one fails here. The
   * table has no foreign key on `site_id` and no RLS is the enforcement layer
   * (CLAUDE.md: RLS is defence in depth), so this predicate is the isolation.
   */
  const statements = [...route.matchAll(/\.(select|insert|update)\(/g)].length;
  const scoped = [...route.matchAll(/eq\(calendarEvents\.organisationId, orgId\)/g)].length;
  assert.ok(statements > 0, "the route reads and writes the table");
  assert.ok(
    scoped >= statements - 1,
    `every statement must name the organisation — ${statements} statements, ${scoped} filters`,
  );

  /* The insert takes the org from the scope, never from the body. */
  assert.match(route, /organisationId: orgId,/);
  assert.doesNotMatch(route, /organisationId: (?:data|body)\./);
});

test("W11 writing is gated on a capability, and it is not the purge one", async () => {
  const route = await read("app/api/maintenance/calendar/route.ts");
  assert.match(
    route,
    /const WRITE_CAPABILITY = "board\.edit" as const;/,
    "planning data, the same system a job's own dates belong to",
  );
  /*
   * THREE WRITE VERBS, THREE GUARDS. A route where one of the four handlers
   * forgot the guard is a route with a hole in it, and the hole is invisible
   * until somebody without the capability finds it.
   */
  assert.equal(
    [...route.matchAll(/scopedDbWithCapability\(request, WRITE_CAPABILITY\)/g)].length,
    3,
    "POST, PATCH and DELETE each ask",
  );
  assert.match(codeOnly(route), /const \{ db, orgId \} = await scopedDb\(request\);/, "and GET is scoped too");

  /*
   * NOT `data.delete`. That capability is the PERMANENT purge and is withheld
   * from `admin` deliberately; requiring it here would mean an admin could add
   * a calendar item and never be able to take it off the calendar.
   */
  assert.doesNotMatch(route, /"data\.delete"/);
  assert.equal(calendar.calendarEditCapability(build({ manualItems: [item()] })[0]), "board.edit");
});

test("W11 removing is soft, and the row keeps what it said", async () => {
  const route = codeOnly(await read("app/api/maintenance/calendar/route.ts"));
  /*
   * Nothing in this product hard-deletes a row somebody typed, and a calendar
   * item is the easiest thing on the screen to remove by accident: a small
   * chip, a control beside the one that opens it, and no other copy of what it
   * said.
   */
  assert.doesNotMatch(route, /db\s*\.?\s*\n?\s*\.delete\(/, "DELETE must not delete");
  assert.match(route, /deletedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(route, /deletedBy: actor\.email \|\| null/);
  assert.match(route, /changes\.deletedAt = null;/, "and restore is a real path");
});

/* ── The span, against dates ─────────────────────────────────────────────── */

test("W11 a single-day item draws one mark and a range draws one per day", () => {
  const single = build({ manualItems: [item({ startsOn: "2026-08-26", endsOn: null })] });
  assert.equal(single.length, 1);
  assert.equal(single[0].day, "2026-08-26");
  assert.equal(single[0].kind, "manual");

  const range = build({
    manualItems: [item({ startsOn: "2026-08-26", endsOn: "2026-08-28" })],
  });
  assert.deepEqual(
    range.map((event) => event.day),
    ["2026-08-26", "2026-08-27", "2026-08-28"],
    "inclusive of both ends — three days means three days",
  );
  assert.equal(new Set(range.map((event) => event.key)).size, 3, "distinct keys");
  assert.deepEqual(
    range.map((event) => event.fieldLabel),
    ["Day 1 of 3", "Day 2 of 3", "Day 3 of 3"],
    "each mark says where in the run it is",
  );
  for (const event of range) {
    assert.match(
      event.subtitle,
      /26 August 2026 — 28 August 2026/,
      "and names the whole span, in the shared long-date format",
    );
  }
});

test("W11 the span is capped, so a typo cannot ask the grid for ten thousand chips", () => {
  const days = calendar.manualItemDays({ startsOn: "2026-01-01", endsOn: "2126-01-01" });
  assert.equal(days.length, calendar.MAX_MANUAL_SPAN_DAYS);
  assert.equal(days[0], "2026-01-01");

  /* An end before the start is read as one day rather than as nothing: the
     route refuses to STORE one, and a reader of a row that predates that rule
     should still see their item. */
  assert.deepEqual(
    calendar.manualItemDays({ startsOn: "2026-08-26", endsOn: "2026-08-20" }),
    ["2026-08-26"],
  );
  assert.deepEqual(calendar.manualItemDays({ startsOn: "", endsOn: null }), []);
});

test("W11 an archived item is off the calendar", () => {
  assert.deepEqual(build({ manualItems: [item({ archived: true })] }), []);
});

/* ── Dragging one ────────────────────────────────────────────────────────── */

test("W11 dragging any day of a range moves the whole item and keeps its length", () => {
  const events = build({
    manualItems: [item({ id: "cal-span", startsOn: "2026-08-26", endsOn: "2026-08-28" })],
  });

  /*
   * THE MIDDLE DAY IS THE INTERESTING ONE. Dropping day 2 of a three-day item
   * on the 20th means the item STARTS on the 19th — anything else moves the
   * block somewhere the person watching it did not put it. This is the whole
   * reason `calendarWriteTarget` takes the drop day.
   */
  assert.deepEqual(calendar.calendarWriteTarget(events[1], "2026-09-20"), {
    path: "manual",
    id: "cal-span",
    startsOn: "2026-09-19",
  });
  assert.deepEqual(calendar.calendarWriteTarget(events[0], "2026-09-20"), {
    path: "manual",
    id: "cal-span",
    startsOn: "2026-09-20",
  });
  assert.deepEqual(calendar.calendarWriteTarget(events[2], "2026-09-20"), {
    path: "manual",
    id: "cal-span",
    startsOn: "2026-09-18",
  });

  /* With no drop day the mark's own day is used, which is a no-op move —
     the honest answer for a caller that asked where this event writes to. */
  assert.equal(calendar.calendarWriteTarget(events[1]).startsOn, "2026-08-26");
});

test("W11 the move sends the start alone, so the route can keep the length", async () => {
  const client = await read("app/(app)/portal/manual-event-client.ts");
  assert.match(
    codeOnly(client),
    /export async function moveManualEvent\([\s\S]{0,200}updateManualEvent\(id, \{ startsOn \}\)/,
    "a move is the start and nothing else",
  );
  const route = codeOnly(await read("app/api/maintenance/calendar/route.ts"));
  assert.match(
    route,
    /if \(movingStart && !settingEnd\) \{[\s\S]{0,400}shiftDay\(existing\.endsOn, daysBetween\(existing\.startsOn, startsOn\)\)/,
    "and the route moves the end by the same number of days",
  );
});

/* ── It cannot be mistaken for a job ─────────────────────────────────────── */

test("W11 a manual item is never a job, and never overdue", () => {
  const past = build({ manualItems: [item({ startsOn: "2026-01-01" })] });
  assert.equal(past[0].timing, "past", "a note in the past is history, not lateness");
  assert.equal(build({ manualItems: [item({ startsOn: TODAY })] })[0].timing, "due-today");
  assert.equal(
    build({ manualItems: [item({ startsOn: "2027-01-01" })] })[0].timing,
    "upcoming",
  );

  /*
   * NEVER RED. Painting a reader's own annotation in the same visual class as a
   * lapsed fire alarm certificate would teach them that red means nothing.
   */
  for (const start of ["2020-01-01", "2026-01-01", TODAY, "2030-01-01"]) {
    for (const event of build({ manualItems: [item({ startsOn: start })] })) {
      assert.notEqual(event.timing, "overdue");
      assert.notEqual(event.timing, "resolved");
    }
  }

  // And it carries no job: nothing downstream can read one off it.
  assert.equal(past[0].request, undefined);
  assert.equal(past[0].record, undefined);
  assert.ok(past[0].manual, "it carries its own record instead");
});

test("W11 the reader is told which kind it is, in words and in shape", async () => {
  const views = await read("app/(app)/portal/calendar-views.tsx");
  assert.match(
    views,
    /const KIND_ICON: Record<CalendarEvent\["kind"\], IconName> = \{[\s\S]{0,800}manual: "edit",/,
    "a pen, not a spanner",
  );

  const controls = await read("app/(app)/portal/calendar-controls.tsx");
  assert.match(controls, /manual: "Manual items",/, "the picker names it");
  assert.match(
    controls,
    /const ENTITY_ORDER: readonly CalendarEntity\[\] = \["job", "compliance", "manual"\];/,
  );
  /* The KEY row, which is where a reader learns what the marks mean. */
  assert.match(
    codeOnly(controls),
    /style=\{manual\}[\s\S]{0,200}Manual/,
    "the legend has a fourth entry with its own swatch and glyph",
  );

  const panel = codeOnly(await read("app/(app)/portal/calendar-surface.tsx"));
  /*
   * RE-POINTED, not weakened. This used to pin the literal `"Manual"`, and the
   * contract it was protecting is the one in this test's name: a manual item
   * announces itself IN WORDS, so it is never told apart by colour alone.
   *
   * That contract now holds more strongly than the literal did. Since the
   * record-type vocabulary arrived, a manual chip says which kind it is —
   * "Note", "Planned visit", "Certificate / compliance" — because "Manual" had
   * become the one word on this calendar describing how a row got here rather
   * than what it says. `calendarItemType` is what supplies the word, and its
   * documented default means an item saved before types existed still gets
   * one rather than falling through to an empty label.
   */
  assert.match(
    panel,
    /event\.kind === "manual"\s*\?\s*calendarItemType\(event\.manual\?\.category\)\.label/,
    "and every chip and agenda row is labelled out loud, now with its own type",
  );
  assert.match(
    panel,
    /import \{ calendarItemType \} from "\.\/calendar-item-types"/,
    "from the one module that decides what a category means",
  );
});

test("W11 a manual chip opens its own editor and never the compliance drawer", async () => {
  const panel = codeOnly(await read("app/(app)/portal/calendar-surface.tsx"));
  /*
   * The defect this closes: `openEvent` ended in `onOpenCompliance(recordId)`,
   * so without a branch a manual chip would hand a `cal-…` id to the compliance
   * register and open an empty drawer for a record that is not one.
   */
  assert.match(
    panel,
    /if \(event\.kind === "manual"\) \{[\s\S]{0,200}setManualEditing\(event\.manual\)[\s\S]{0,60}return;/,
  );
});

/* ── Filters ─────────────────────────────────────────────────────────────── */

test("W11 only the site facet applies, and an item with no site survives it", () => {
  const filters = {
    ...calendar.EMPTY_CALENDAR_FILTERS,
    sites: ["store-aldgate"],
  };
  assert.equal(build({ manualItems: [item({ siteId: "store-aldgate" })], filters }).length, 1);
  assert.equal(build({ manualItems: [item({ siteId: "store-hq" })], filters }).length, 0);
  /*
   * An item with NO site is kept. It is not "some other site's" item — it
   * belongs to nobody's — so hiding it would make a site-filtered calendar
   * quietly lose the reader's general notes.
   */
  assert.equal(build({ manualItems: [item({ siteId: null })], filters }).length, 1);

  /*
   * A JOB FACET LEAVES THEM ALONE, which is the rule `CalendarFilters` already
   * states: a facet describing something only a job has must not empty a layer
   * that has no such property, or picking "Urgent" reads as "there are no
   * manual items".
   */
  for (const facet of ["statuses", "priorities", "contractors", "jobTypes", "complianceTypes"]) {
    assert.equal(
      build({
        manualItems: [item()],
        filters: { ...calendar.EMPTY_CALENDAR_FILTERS, [facet]: ["anything"] },
      }).length,
      1,
      `${facet} must not hide a manual item`,
    );
  }
});

/* ── Sorting ─────────────────────────────────────────────────────────────── */

test("W11 within a day, notes sort after the work and the certificates", () => {
  const events = calendar.buildCalendarEvents({
    requests: [],
    complianceRecords: [
      {
        id: "C-1",
        siteId: "store-aldgate",
        siteName: "Aldgate",
        kind: "PAT Test",
        state: "Compliant",
        expiry: TODAY,
        fileCount: 1,
        itemId: "9001",
        slotKey: "pat",
        expiryColumnKey: "patExpiry",
        expiryColumnId: "col",
      },
    ],
    manualItems: [item({ startsOn: TODAY, title: "AAA sorts first alphabetically" })],
    sourceIds: ["compliance:expiry", "manual:item"],
    filters: calendar.EMPTY_CALENDAR_FILTERS,
    today: TODAY,
  });
  /*
   * The manual item's title sorts before the certificate's alphabetically, and
   * it still comes last — so this is the KIND order and not the title order.
   * They are the reader's own annotations; the derived layers are the product's
   * answer about work and compliance, and a note at the top of a day would read
   * as the most important thing on it.
   */
  assert.deepEqual(events.map((event) => event.kind), ["compliance", "manual"]);
});
