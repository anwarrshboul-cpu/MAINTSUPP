/**
 * Acceptance Correction 1 — the calendar's DATA and its WRITES, re-verified.
 *
 * WHY A SECOND FILE RATHER THAN MORE OF THE FIRST
 *
 * `workstream-four-calendar-model.test.mjs` was written alongside the model and
 * asserts what the model was designed to do. The owner then rejected the work
 * because the Calendar they open — the board's Calendar view TAB — showed them
 * nothing they could use, and "the tests were green" is exactly the sentence
 * that made the rejection possible. This file is the second pair of eyes: it
 * pins the things that were TAKEN ON TRUST the first time and that were checked
 * against the running product on 2026-08-26 before a line of it was written.
 *
 * Three of those checks are worth naming, because each is a bug that has either
 * already shipped once or would have shipped invisibly:
 *
 *   1. `update_cell` IS ON PATCH. `/api/board` splits its actions across POST
 *      and PATCH, and the certificate write is on the PATCH side. Sent as POST
 *      it returns `400 {"error":"Unknown board action."}` — confirmed against
 *      the running route — and the only symptom is a certificate that does not
 *      move. Asserted here from BOTH ends: the route source, and the caller in
 *      portal-app.tsx.
 *
 *   2. THE COLUMN IS LOOKED UP BY ID. `PATCH …{columnId:"patExpiry"}` answers
 *      `404 {"error":"The row or column no longer exists."}` — also confirmed
 *      live. `CalendarWriteTarget` therefore carries `expiryColumnId`, and this
 *      file asserts the target never puts the KEY in the id slot.
 *
 *   3. THE BOARD TAB PASSES A DIFFERENT SHAPE. It hands one board's items and
 *      `complianceRecords: []`, because a board knows nothing about the
 *      compliance register. A job-only calendar is the correct output; a crash
 *      or an empty grid is the defect the owner already reported once.
 *
 * The live round trip behind these assertions, for the record: a Store
 * Documentation row was created, its `patExpiry` cell written through
 * `PATCH /api/board?board=store-documentation`, and `GET /api/workspace` then
 * returned that record with `expiry: "2027-05-05"` and `state: "Compliant"`.
 * The fixture was deleted and purged; nothing was left behind, and no
 * pre-existing record was touched.
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

/* The shipped module, with its three real dependencies substituted in as data:
   URLs — see the sibling file's header for why the ceremony is worth it. */
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

const calendar = await import(
  asModule(
    transpile(modelSource)
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
      .replace(/from ["']\.\/dashboard-meters["']/g, `from "${metersUrl}"`),
  )
);

const TODAY = "2026-08-24"; // a Monday.

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

/*
 * Shaped exactly as `/api/workspace` returned it on 2026-08-26 for a Store
 * Documentation row: the register-only rows carry `itemId: null` and all three
 * provenance fields null, and the derived rows carry the seeded column id.
 */
let certificate = 0;
function derivedCertificate(overrides = {}) {
  certificate += 1;
  return {
    id: `board:MN-9001:pat`,
    siteId: "MN-9001",
    siteName: "Cabot Circus - Bristol",
    kind: "PAT Test",
    state: "Compliant",
    expiry: "2027-05-05",
    fileCount: 0,
    itemId: "MN-9001",
    slotKey: "pat",
    expiryColumnKey: "patExpiry",
    expiryColumnId:
      "seed-org_000000000000000000000001-store-documentation-patExpiry",
    ...overrides,
  };
}

function registerOnlyCertificate(overrides = {}) {
  certificate += 1;
  return {
    id: `compliance-store-aldgate-pat-test-${certificate}`,
    siteId: "store-aldgate",
    siteName: "Aldgate",
    kind: "PAT Test",
    state: "Compliant",
    expiry: "2026-11-24",
    fileCount: 0,
    itemId: null,
    slotKey: null,
    expiryColumnKey: null,
    expiryColumnId: null,
    ...overrides,
  };
}

/*
 * Defaults to the two layers a calendar OPENS with — Due Date and Certificate
 * expiry — because that is the screen the owner is looking at. A test that
 * wants the other three job dates asks for them by name.
 */
const build = (input) =>
  calendar.buildCalendarEvents({
    requests: [],
    complianceRecords: [],
    sourceIds: calendar.DEFAULT_CALENDAR_SOURCE_IDS,
    filters: calendar.EMPTY_CALENDAR_FILTERS,
    today: TODAY,
    ...input,
  });

/* ── 1. The board tab's shape ─────────────────────────────────────────────── */

test("the board tab's input — one board's jobs and no compliance layer — draws a job calendar", () => {
  const events = build({
    requests: [job({ dueAt: "2026-08-26T00:00:00.000Z" })],
    complianceRecords: [],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "job");
  assert.equal(events[0].day, "2026-08-26");
});

test("a missing compliance array is a job calendar, not a crash", () => {
  /*
   * The tab is mounted from the board, which has no register to hand over. A
   * `for…of undefined` here is a blank tab with a console error — which is the
   * failure the owner already reported once, and it must not be reachable by
   * forgetting a prop.
   */
  const events = build({
    requests: [job({ dueAt: "2026-08-26T00:00:00.000Z" })],
    complianceRecords: undefined,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "job");
});

test("a missing jobs array is a compliance calendar, not a crash", () => {
  const events = build({
    requests: undefined,
    complianceRecords: [derivedCertificate({ expiry: "2026-09-02" })],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "compliance");
});

test("a missing filters object constrains nothing", () => {
  const events = build({
    requests: [job({ dueAt: "2026-08-26T00:00:00.000Z" })],
    filters: undefined,
  });
  assert.equal(events.length, 1);
});

test("the facet lists survive the board tab's input too", () => {
  const options = calendar.calendarFilterOptions({
    requests: [job({ category: "Lights" })],
    complianceRecords: [],
  });
  assert.deepEqual(
    options.complianceTypes,
    [],
    "no register means no certificate types to offer",
  );
  assert.deepEqual(
    options.jobTypes.map((option) => option.value),
    ["Lights"],
  );
  const empty = calendar.calendarFilterOptions({
    requests: undefined,
    complianceRecords: undefined,
  });
  for (const facet of Object.keys(empty)) assert.deepEqual(empty[facet], []);
  assert.equal(calendar.calendarFilterCount(calendar.EMPTY_CALENDAR_FILTERS), 0);
  assert.equal(calendar.calendarFilterCount({}), 0);
});

test("`Not required` is absent from the grid AND from the filter that would offer it", () => {
  /*
   * Two of the dev workspace's 120 records were in this state on 2026-08-26. A
   * requirement a store has said does not apply to it can never carry an
   * expiry, so a `complianceTypes` value that matches only those rows is a
   * control that returns nothing whichever way it is set.
   */
  const notRequired = registerOnlyCertificate({
    kind: "Sprinkler",
    state: "Not required",
    expiry: "2026-09-01",
  });
  assert.deepEqual(build({ complianceRecords: [notRequired] }), []);
  const options = calendar.calendarFilterOptions({
    requests: [],
    complianceRecords: [notRequired],
  });
  assert.deepEqual(options.complianceTypes, []);
  assert.deepEqual(options.sites, []);
});

test("a slot with no expiry column can produce no event and refuses the edit in words", () => {
  /*
   * RAMS, the Fire Risk Assessment and the store Drawing. Confirmed live: a
   * Store Documentation row derives twelve records and exactly those three come
   * back with `expiryColumnKey: null` and `expiryColumnId: null`.
   */
  const rams = derivedCertificate({
    id: "board:MN-9001:rams",
    kind: "RAMS",
    slotKey: "rams",
    expiryColumnKey: null,
    expiryColumnId: null,
    expiry: null,
  });
  assert.deepEqual(build({ complianceRecords: [rams] }), []);

  // It cannot reach a grid, but the router must still answer a sentence.
  const target = calendar.calendarWriteTarget({
    key: "compliance:expiry::board:MN-9001:rams",
    kind: "compliance",
    sourceId: "compliance:expiry",
    recordId: "board:MN-9001:rams",
    field: "expiry",
    fieldLabel: "Certificate expiry",
    day: "2026-09-01",
    time: "",
    title: "RAMS renewal",
    subtitle: "Cabot Circus - Bristol",
    timing: "upcoming",
    editable: true,
    record: rams,
  });
  assert.equal(target.path, "none");
  assert.match(target.reason, /does not track an expiry date/);
});

/* ── 2. The write targets, against the shapes the routes actually accept ──── */

const complianceEvent = (record) => ({
  key: `compliance:expiry::${record.id}`,
  kind: "compliance",
  sourceId: "compliance:expiry",
  recordId: record.id,
  field: "expiry",
  fieldLabel: "Certificate expiry",
  day: calendar.calendarDay(record.expiry),
  time: "",
  title: `${record.kind} renewal`,
  subtitle: record.siteName,
  timing: "upcoming",
  editable: true,
  record,
});

test("a board-derived expiry writes the resolved column ID, never the key", () => {
  const record = derivedCertificate();
  const target = calendar.calendarWriteTarget(complianceEvent(record));
  assert.equal(target.path, "board-cell");
  assert.equal(target.boardId, "store-documentation");
  assert.equal(target.requestId, "MN-9001");
  assert.equal(target.columnId, record.expiryColumnId);
  assert.notEqual(
    target.columnId,
    record.expiryColumnKey,
    "`columnId: \"patExpiry\"` answers 404 — the route looks columns up by id",
  );
  assert.equal(target.columnKey, "patExpiry");
  assert.equal(calendar.calendarEditCapability(complianceEvent(record)), "board.edit");
});

test("`update_cell` is on /api/board's PATCH handler and nowhere else", async () => {
  /*
   * The bug that shipped. POST returns `400 Unknown board action`, and the only
   * visible symptom is a certificate that does not move — so the verb is pinned
   * at the route as well as at the caller.
   */
  const route = await read("app/api/board/route.ts");
  const post = route.indexOf("export async function POST");
  const patch = route.indexOf("export async function PATCH");
  const cell = route.indexOf('action === "update_cell"');
  assert.ok(post > -1 && patch > -1 && cell > -1);
  assert.ok(post < patch, "POST is declared before PATCH in this route");
  assert.ok(
    cell > patch,
    "`update_cell` moved out of the PATCH handler — a POSTed cell write 400s",
  );
  assert.equal(
    route.split('action === "update_cell"').length - 1,
    1,
    "one handler owns the cell write",
  );
  /*
   * And the board is read from the query string, not from the body.
   *
   * RE-POINTED — W02-06. `boardIdFrom` became async and takes the scoped
   * database, because a board that can be created at runtime cannot be
   * validated against a literal list. The fact this line exists to hold is
   * where the board comes FROM, and that has not changed: the query string,
   * never the body.
   */
  assert.match(
    route,
    /async function boardIdFrom\(\s*request: Request,[\s\S]{0,200}searchParams\.get\("board"\)/,
  );
});

test("the caller sends the cell write as PATCH, with the board in the URL", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");
  const start = app.indexOf("const changeComplianceDate");
  assert.ok(start > -1, "portal-app still owns the compliance date write");
  const body = app.slice(start, start + 4000);
  const cell = body.indexOf('action: "update_cell"');
  assert.ok(cell > -1, "the board-cell branch still posts update_cell");
  /* The fetch that carries it: its options object must name PATCH, and its URL
     must carry `?board=`, or the write lands on the maintenance board. */
  const fetchAt = body.lastIndexOf("fetch(", cell);
  const call = body.slice(fetchAt, cell);
  assert.match(call, /method:\s*"PATCH"/);
  assert.match(call, /\/api\/board\?board=/);
  assert.match(call, /target\.boardId/);
});

test("a register-only expiry carries back everything the PATCH would otherwise blank", async () => {
  const record = registerOnlyCertificate({ state: "Compliant" });
  const target = calendar.calendarWriteTarget(complianceEvent(record));
  assert.deepEqual(target, {
    path: "workspace-compliance",
    id: record.id,
    siteId: "store-aldgate",
    kind: "PAT Test",
    state: "Compliant",
  });
  assert.equal(
    calendar.calendarEditCapability(complianceEvent(record)),
    "sites.edit",
  );

  /*
   * The route's UPDATE names every one of these columns unconditionally, and
   * derives `notRequired` from `state`. Sending the expiry alone would blank
   * the site and the requirement and silently un-mark a Not-required row —
   * which is why this calendar path sends all four keys and why the statement
   * must stay a full replace.
   *
   * TWO THINGS CHANGED HERE, AND NEITHER WEAKENS THE PIN.
   *
   * 1. The slice ran to the FIRST NEWLINE after `db.update(complianceDocuments)`,
   *    so the whole assertion silently depended on the statement being written
   *    on one line. It now runs to the statement's own terminator, which is what
   *    it was always trying to describe.
   * 2. `expiryDate: optionalText(data.expiry` became `expiryDate` alone, because
   *    the value is now validated into a variable before the write — an omitted
   *    `expiry` is refused with a 400 instead of quietly clearing the stored
   *    date, and "not-a-date" and "2027-13-45" are refused instead of being
   *    stored and then silently skipped by the compliance digest for ever.
   *    The column is still replaced; only where its value is computed moved.
   *
   * The behaviour this file cares about — drag a certificate to a new day and
   * the site, requirement and state survive — is asserted directly against a
   * running server in
   * tests/workstream-seven-official-compliance-contract.test.mjs.
   */
  const route = await read("app/api/workspace/route.ts");
  const update = route.slice(
    route.indexOf('} else if (entity === "compliance") {', route.indexOf("export async function PATCH")),
  );
  const updateAt = update.indexOf("db.update(complianceDocuments)");
  const statement = update.slice(updateAt, update.indexOf(";", updateAt) + 1);
  for (const column of [
    "siteId",
    "kind",
    "status: state",
    "expiryDate",
    'notRequired: state === "Not required"',
  ]) {
    assert.ok(statement.includes(column), `the PATCH still replaces ${column}`);
  }
});

test("all four job dates route to PATCH /api/maintenance and nothing else does", () => {
  for (const field of ["dueAt", "requestedAt", "completedAt", "nextUpdateAt"]) {
    const target = calendar.calendarWriteTarget({
      key: `job:${field}::J-1`,
      kind: "job",
      sourceId: `job:${field}`,
      recordId: "J-1",
      field,
      fieldLabel: field,
      day: "2026-09-01",
      time: "",
      title: "Job 1",
      subtitle: "",
      timing: "upcoming",
      editable: true,
    });
    assert.deepEqual(target, { path: "job", id: "J-1", field });
  }
  const invented = calendar.calendarWriteTarget({
    key: "job:closedAt::J-1",
    kind: "job",
    sourceId: "job:closedAt",
    recordId: "J-1",
    field: "closedAt",
    fieldLabel: "Closed",
    day: "2026-09-01",
    time: "",
    title: "Job 1",
    subtitle: "",
    timing: "upcoming",
    editable: true,
  });
  assert.equal(invented.path, "none");
});

test("a board-derived record whose column has gone says so instead of 404ing", () => {
  const record = derivedCertificate({ expiryColumnId: null });
  const target = calendar.calendarWriteTarget(complianceEvent(record));
  assert.equal(target.path, "none");
  assert.match(target.reason, /Store Documentation board/);
  assert.equal(calendar.calendarEditCapability(complianceEvent(record)), null);
});

test("every `none` reason is a sentence an operator can act on", () => {
  const reasons = [
    calendar.calendarWriteTarget({ kind: "job", editable: false, field: "dueAt", recordId: "J-1" }),
    calendar.calendarWriteTarget({ kind: "compliance", editable: true, field: "expiry", recordId: "C-1" }),
    calendar.calendarWriteTarget(complianceEvent(derivedCertificate({ expiryColumnId: null }))),
    calendar.calendarWriteTarget(
      complianceEvent(derivedCertificate({ expiryColumnKey: null, expiryColumnId: null })),
    ),
  ];
  for (const target of reasons) {
    assert.equal(target.path, "none");
    assert.match(target.reason, /^[A-Z].*\.$/, "a full sentence, not a code");
    assert.doesNotMatch(target.reason, /null|undefined|columnId|404/);
  }
});

/* ── 3. Overdue, against the completion semantics rather than the date ───── */

const timingFor = (request, sourceId) => {
  const events = build({ requests: [request], sourceIds: [sourceId] });
  assert.equal(events.length, 1, `${sourceId} produced no event`);
  return events[0].timing;
};

test("an open job is overdue, due today or upcoming by its due date alone", () => {
  assert.equal(
    timingFor(job({ dueAt: "2026-08-20T00:00:00.000Z" }), "job:dueAt"),
    "overdue",
  );
  assert.equal(
    timingFor(job({ dueAt: "2026-08-24T00:00:00.000Z" }), "job:dueAt"),
    "due-today",
  );
  assert.equal(
    timingFor(job({ dueAt: "2026-08-25T00:00:00.000Z" }), "job:dueAt"),
    "upcoming",
  );
});

test("a completion date on a job whose stage is NOT Completed still resolves it", () => {
  /*
   * The case the brief calls out. `stage` says the job is still in Attention
   * and the status is not a completed one, but somebody has recorded the day
   * the work was done — and `timingOf` in fix-tracker.tsx treats that date as
   * decisive on its own. A red "overdue" chip on a job with a completion date
   * is the calendar arguing with its own record.
   */
  const request = job({
    stage: "Attention",
    status: "Waiting for decisions",
    dueAt: "2026-08-10T00:00:00.000Z",
    completedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(timingFor(request, "job:dueAt"), "resolved");
  assert.equal(timingFor(request, "job:requestedAt"), "resolved");
  assert.equal(
    timingFor({ ...request, nextUpdateAt: "2026-08-11" }, "job:nextUpdateAt"),
    "resolved",
  );
});

test("a stage of Completed with no completion date resolves it too", () => {
  assert.equal(
    timingFor(
      job({ stage: "Completed", status: "Job Scheduled", dueAt: "2026-08-10T00:00:00.000Z" }),
      "job:dueAt",
    ),
    "resolved",
  );
});

test("a status of Job Completed resolves it even when the stage disagrees", () => {
  /*
   * THE ONE DELIBERATE DIVERGENCE FROM `timingOf`, PINNED SO IT IS A DECISION.
   *
   * `timingOf` asks `jobState`, which prefers `stage` and would call this job
   * open and paint it red. This model asks `isClosedRequest`, the union of the
   * two signals, because the monday import files finished work in groups that
   * carry no lifecycle stage — `isClosedRequest`'s own header records 28 such
   * jobs read as open by a stage-only test. The divergence only ever removes a
   * red chip from a job the board itself calls finished; it can never invent
   * lateness. The dev workspace has none of these rows, so this assertion is
   * the only place the difference is visible before the imported estate.
   */
  assert.equal(
    timingFor(
      job({ stage: "Incoming", status: "Job Completed", dueAt: "2026-08-10T00:00:00.000Z" }),
      "job:dueAt",
    ),
    "resolved",
  );
});

test("a completion date is resolved even when it is in the future", () => {
  assert.equal(
    timingFor(job({ completedAt: "2026-12-01T00:00:00.000Z" }), "job:completedAt"),
    "resolved",
  );
});

test("a certificate is overdue only when the register says Expired", () => {
  const expired = derivedCertificate({ state: "Expired", expiry: "2026-08-01" });
  const lapsed = derivedCertificate({ state: "Compliant", expiry: "2026-08-01" });
  assert.equal(build({ complianceRecords: [expired] })[0].timing, "overdue");
  assert.equal(build({ complianceRecords: [lapsed] })[0].timing, "past");
  assert.equal(
    build({ complianceRecords: [derivedCertificate({ expiry: TODAY })] })[0].timing,
    "due-today",
  );
  assert.equal(
    build({ complianceRecords: [derivedCertificate({ expiry: "2027-01-01" })] })[0]
      .timing,
    "upcoming",
  );
});

test("a record with no date produces no event on any layer", () => {
  assert.deepEqual(
    build({
      requests: [job()],
      complianceRecords: [derivedCertificate({ expiry: null })],
    }),
    [],
  );
  assert.deepEqual(
    build({ complianceRecords: [derivedCertificate({ expiry: "not a date" })] }),
    [],
  );
});

test("no event this product can produce carries a time", () => {
  /*
   * The register flattens the board's date decoration through `dateOnlyValue`
   * before the calendar ever sees it — written and re-read live on 2026-08-26,
   * `{"date":"2027-05-06","time":"09:15","icon":""}` came back as
   * `"2027-05-06"` — and a job's ISO instant is an encoding, not a booking.
   */
  const events = build({
    requests: [
      job({ dueAt: "2026-07-29T16:00:00.000Z" }), // a real dev-workspace value
      job({ dueAt: "2026-08-25T04:33:26.755Z" }), // a real staging artefact
    ],
    complianceRecords: [derivedCertificate({ expiry: "2026-09-01" })],
  });
  assert.equal(events.length, 3);
  for (const event of events) assert.equal(event.time, "");
  // The parse itself still reads a decoration correctly where one reaches it.
  assert.equal(
    calendar.calendarTimeOfDay('{"date":"2026-08-21","time":"09:15","icon":""}'),
    "09:15",
  );
  assert.equal(calendar.calendarTimeOfDay("2026-07-29T16:00:00.000Z"), "");
});

/* ── 4. The same answers on both sides of the dateline ────────────────────── */

test("a whole calendar — events, timings, grids and headings — is identical in three timezones", async () => {
  /*
   * The sibling file pins seven scalars. This runs the WHOLE build: two dozen
   * events across a year boundary and a British DST boundary, their timings,
   * their order, the month grid that frames them and the headings above it.
   * The original defect was a day shift that only appeared off UTC, and a
   * seven-value probe is a thin net for that.
   */
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(path.join(tmpdir(), "ac1-calendar-tz-"));
  const write = (name, source) => writeFileSync(path.join(dir, name), source, "utf8");
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

    const today = "2026-08-24";
    const days = [
      "2025-12-31", "2026-01-01", "2026-02-28", "2026-03-01",
      "2026-03-29", "2026-03-30", "2026-08-23", "2026-08-24",
      "2026-10-25", "2026-10-26", "2026-12-31",
    ];

    const requests = days.flatMap((day, index) => [
      {
        id: "J-" + index,
        title: "Job " + index,
        location: "Aldgate",
        siteId: "store-aldgate",
        category: "Lights",
        priority: "Medium",
        stage: index % 3 === 0 ? "Completed" : "Incoming",
        status: index % 4 === 0 ? "Job Completed" : "Job Scheduled",
        contractor: index % 2 ? "Apex Electrical" : "",
        requestedAt: day + "T00:00:00.000Z",
        dueAt: day + "T16:00:00.000Z",
        completedAt: index % 5 === 0 ? day + "T00:00:00.000Z" : null,
        nextUpdateAt: day,
      },
    ]);

    const complianceRecords = days.map((day, index) => ({
      id: "C-" + index,
      siteId: "store-aldgate",
      siteName: "Aldgate",
      kind: "PAT Test",
      state: index % 3 === 0 ? "Expired" : "Compliant",
      expiry: day,
      fileCount: 0,
      itemId: null,
      slotKey: null,
      expiryColumnKey: null,
      expiryColumnId: null,
    }));

    const events = calendar.buildCalendarEvents({
      requests,
      complianceRecords,
      sourceIds: calendar.CALENDAR_DATE_SOURCES.map((s) => s.id),
      filters: calendar.EMPTY_CALENDAR_FILTERS,
      today,
    });

    const out = {
      events: events.map((e) => [e.key, e.day, e.timing, e.time]),
      byDay: [...calendar.groupCalendarEventsByDay(events)].map(
        ([day, list]) => [day, list.length],
      ),
      grids: days.map((day) => calendar.calendarMonthGrid(day).join(",")),
      weeks: days.map((day) => calendar.calendarWeekDays(day).join(",")),
      headings: days.flatMap((day) => [
        calendar.calendarRangeLabel("month", day),
        calendar.calendarRangeLabel("week", day),
        calendar.calendarRangeLabel("day", day),
      ]),
      weekdays: days.map((day) => calendar.calendarWeekdayLabel(day)),
      labels: days.map((day) => calendar.calendarDayLabel(day)),
      shifts: days.map((day) => [
        calendar.shiftCalendarDay(day, 1),
        calendar.shiftCalendarDay(day, -1),
        calendar.shiftCalendarMonth(day, 1),
        calendar.shiftCalendarMonth(day, -1),
      ]),
      today: calendar.todayCalendarDay(new Date("2026-08-24T23:30:00.000Z")),
      todayEarly: calendar.todayCalendarDay(new Date("2026-08-24T00:30:00.000Z")),
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
        maxBuffer: 32 * 1024 * 1024,
      }),
    );

  const utc = run("UTC");
  const west = run("America/Los_Angeles"); // UTC-7/-8
  const east = run("Pacific/Kiritimati"); // UTC+14

  assert.deepEqual(west, utc, "the calendar moved west of Greenwich");
  assert.deepEqual(east, utc, "the calendar moved east of the dateline");

  // And the answers are the right ones, not merely the same wrong one.
  assert.equal(utc.today, "2026-08-24");
  assert.equal(utc.todayEarly, "2026-08-24");
  assert.equal(utc.events.length, 47);
  assert.ok(utc.events.every(([, , , time]) => time === ""));
  assert.ok(
    utc.events.some(([key, day]) => key === "job:dueAt::J-0" && day === "2025-12-31"),
    "a job due on New Year's Eve stays on New Year's Eve",
  );
  assert.equal(utc.grids[0].split(",").length, 42);
});
