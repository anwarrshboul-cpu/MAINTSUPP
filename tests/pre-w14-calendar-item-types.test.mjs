/**
 * THE THREE RECORD TYPES, and the day arithmetic underneath them.
 *
 * `calendar_events.category` has always existed and nothing ever wrote it, so
 * a note, a booked visit and a certificate expiry were one undifferentiated
 * teal chip. This suite pins the vocabulary that fixed that, and — far more
 * importantly — it pins the EXPIRY BANDS at their exact edges.
 *
 * The boundary cases are the point. 91/90, 61/60, 31/30, 15/14 and 1/0/−1 are
 * where every off-by-one in this kind of date arithmetic actually lives, and an
 * error of one day at 90 means every reminder in the system is a day out
 * without a single test going red. Testing "roughly 60 days is orange" would
 * catch none of it.
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

/* Pure and importing nothing, which is what lets it be loaded on its own. */
const types = await import(
  asModule(transpile(await read("app/(app)/portal/calendar-item-types.ts")))
);

/* ------------------------------------------------------- the vocabulary */

test("there are exactly three types, and the keys are what the column stores", () => {
  assert.deepEqual(
    types.CALENDAR_ITEM_TYPES.map((type) => type.key),
    ["Note", "Planned visit", "Certificate"],
    "the brief's three, cheapest first so the common case is one tap away",
  );
  for (const type of types.CALENDAR_ITEM_TYPES) {
    assert.ok(type.label && type.description, `${type.key} must say what it is`);
    assert.match(type.colour, /^#[0-9a-f]{6}$/i, "the route validates #RRGGBB");
    assert.ok(type.key.length <= 60, "the route truncates category at 60 characters");
  }
});

test("an unknown category is drawn as a Note, never dropped", () => {
  /*
   * Every item saved before this existed carries 'Manual'. A calendar that
   * hides a record because it does not recognise its label is worse than one
   * that draws it plainly, and the raw value is still on the row either way.
   */
  for (const unknown of ["Manual", "", null, undefined, "Something a later version writes"]) {
    assert.equal(types.calendarItemType(unknown).key, "Note", `${String(unknown)} reads as a Note`);
    assert.equal(types.isKnownCalendarItemType(unknown), false);
  }
  assert.equal(types.isKnownCalendarItemType("Certificate"), true);
  assert.equal(types.calendarItemType("Planned visit").key, "Planned visit");
});

test("a certificate has one date, and its label says which date that is", () => {
  const certificate = types.calendarItemType("Certificate");
  assert.equal(
    certificate.endDateLabel,
    null,
    "offering an end date beside an expiry invites a range that means nothing",
  );
  assert.match(certificate.dateLabel, /expires/i, "or somebody enters the issue date");
  assert.ok(types.calendarItemType("Note").endDateLabel, "a note may span days");
});

/* ------------------------------------------------- the boundaries, exactly */

test("the expiry bands land on 90, 60, 30 and 14 and not a day either side", () => {
  const band = (days) => types.certificateExpiryBand(days).label;

  /* The ladder is the same one the compliance reminders already fire on. */
  assert.equal(band(200), "Valid");
  assert.equal(band(91), "Valid", "91 is one day OUTSIDE the 90 window");
  assert.equal(band(90), "90-day window", "90 is inside it");

  assert.equal(band(75), "90-day window");
  assert.equal(band(61), "90-day window", "61 is one day outside the 60 window");
  assert.equal(band(60), "60-day window", "60 is inside it");

  assert.equal(band(45), "60-day window");
  assert.equal(band(31), "60-day window", "31 is one day outside the 30 window");
  assert.equal(band(30), "30-day window", "30 is inside it");

  assert.equal(band(22), "30-day window");
  assert.equal(band(15), "30-day window", "15 is one day outside the 14 window");
  assert.equal(band(14), "Urgent", "14 is inside it");

  assert.equal(band(7), "Urgent");
  assert.equal(band(1), "Urgent");
  assert.equal(band(0), "Urgent", "expiring today has not expired");
  assert.equal(band(-1), "Expired", "one day past is expired");
  assert.equal(band(-120), "Expired");
});

test("every band is readable with no colour at all", () => {
  /*
   * Colour is never the only signal. Each band carries a word and a badge, so
   * the state survives greyscale, a colour-blind reader, and a printed page.
   */
  const seen = new Set();
  for (const days of [200, 90, 60, 30, 14, 0, -1]) {
    const band = types.certificateExpiryBand(days);
    assert.ok(band.label, `${days} needs a word`);
    assert.ok(band.badge, `${days} needs a badge`);
    assert.match(band.colour, /^#[0-9a-f]{6}$/i);
    seen.add(band.colour);
  }
  assert.equal(seen.size, 6, "six distinct colours for six distinct states");
  assert.equal(types.certificateExpiryBand(-1).badge, "EXPIRED");
  assert.equal(types.certificateExpiryBand(90).badge, "90d");
});

test("only a certificate is coloured by its date", () => {
  const colour = types.calendarItemTypeColour;
  /* A note and a visit take the swatch on the row, or their type's default. */
  assert.equal(colour("Note", null, null), types.calendarItemType("Note").colour);
  assert.equal(colour("Planned visit", null, null), types.calendarItemType("Planned visit").colour);
  assert.equal(colour("Note", "#123456", 3), "#123456", "a chosen colour wins");

  /* A certificate's band overrides even a chosen colour: how close an expiry
     is, is a fact about the record and not a preference. */
  assert.equal(
    colour("Certificate", "#123456", -1),
    types.certificateExpiryBand(-1).colour,
  );
  assert.equal(
    colour("Certificate", null, 90),
    types.certificateExpiryBand(90).colour,
  );
  /* With no date to measure against, it falls back rather than guessing. */
  assert.equal(
    colour("Certificate", "#123456", null),
    "#123456",
    "an unreadable date must not be reported as expiring today",
  );
});

/* ----------------------------------------- the model reads them correctly */

/*
 * The model, with each of its four relative imports pointed at a transpiled
 * sibling — the same stubbing the other calendar suites do, hoisted here so
 * the URLs are built once and the substitution list reads as a list.
 */
const typesUrl = asModule(
  transpile(await read("app/(app)/portal/calendar-item-types.ts")),
);
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

const model = await import(
  asModule(
    transpile(await read("app/(app)/portal/calendar-model.ts"))
      .replace(/from ["']\.\.\/\.\.\/lib\/format-date["']/g, `from "${formatDateUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`)
      .replace(/from ["']\.\/dashboard-meters["']/g, `from "${metersUrl}"`)
      .replace(/from ["']\.\/calendar-item-types["']/g, `from "${typesUrl}"`),
  )
);

test("the day difference is whole days, in UTC, both directions", () => {
  /*
   * This is the number the bands are cut on. A fractional day here would move
   * every boundary above by one, so it is measured rather than assumed.
   */
  assert.equal(model.calendarDaysBetween("2026-08-24", "2026-08-24"), 0);
  assert.equal(model.calendarDaysBetween("2026-08-24", "2026-11-22"), 90);
  assert.equal(model.calendarDaysBetween("2026-08-24", "2026-08-23"), -1);
  /* Across the October clock change, which is where a local-time subtraction
     returns 0.958333 and rounds a 90 into an 89. */
  assert.equal(model.calendarDaysBetween("2026-10-24", "2026-11-01"), 8);
  /* And across a leap day. */
  assert.equal(model.calendarDaysBetween("2028-02-28", "2028-03-01"), 2);
  assert.equal(model.calendarDaysBetween("not a date", "2026-08-24"), null);
  assert.equal(model.calendarDaysBetween("2026-08-24", ""), null);
});

const TODAY = "2026-08-24";

function manual(overrides = {}) {
  return {
    id: `manual-${overrides.id ?? "1"}`,
    title: "A thing",
    notes: null,
    siteId: null,
    startsOn: TODAY,
    endsOn: null,
    allDay: true,
    category: "Note",
    colour: null,
    createdByEmail: null,
    archived: false,
    ...overrides,
  };
}

const eventsFor = (items) =>
  model
    .buildCalendarEvents({
      requests: [],
      complianceRecords: [],
      manualItems: items,
      sourceIds: model.CALENDAR_DATE_SOURCES.map((source) => source.id),
      filters: {},
      today: TODAY,
    })
    .filter((event) => event.kind === "manual");

test("a note in the past is past; a certificate in the past is overdue", () => {
  /*
   * The original rule — a manual item is never overdue — was written when
   * every manual item was somebody's annotation, and it still holds for those.
   * A certificate records the day cover RUNS OUT, and calling one of those
   * "past" would be the calendar agreeing that a lapsed certificate is settled.
   */
  const yesterday = "2026-08-23";
  const [note] = eventsFor([manual({ id: "n", category: "Note", startsOn: yesterday })]);
  assert.equal(note.timing, "past");

  const [visit] = eventsFor([
    manual({ id: "v", category: "Planned visit", startsOn: yesterday }),
  ]);
  assert.equal(visit.timing, "past", "a visit that happened is not a debt");

  const [cert] = eventsFor([
    manual({ id: "c", category: "Certificate", startsOn: yesterday }),
  ]);
  assert.equal(cert.timing, "overdue");
  assert.equal(cert.badge, "EXPIRED");
});

test("a certificate chip carries its band's colour and a days-remaining badge", () => {
  const cases = [
    [200, "Valid", null],
    [91, "Valid", "91d"],
    [90, "90-day window", "90d"],
    [61, "90-day window", "61d"],
    [60, "60-day window", "60d"],
    [31, "60-day window", "31d"],
    [30, "30-day window", "30d"],
    [15, "30-day window", "15d"],
    [14, "Urgent", "14d"],
    [0, "Urgent", "0d"],
    [-1, "Expired", "EXPIRED"],
  ];
  for (const [days, label, badge] of cases) {
    const startsOn = model.shiftCalendarDay(TODAY, days);
    const [event] = eventsFor([manual({ id: `d${days}`, category: "Certificate", startsOn })]);
    assert.ok(event, `${days} days out must still render — never silently dropped`);
    assert.equal(
      event.colourToken,
      types.certificateExpiryBand(days).colour,
      `${days} days out belongs to the ${label} band`,
    );
    if (badge) assert.equal(event.badge, badge, `${days} days out is badged ${badge}`);
  }
});

test("a note keeps the reader's own colour and carries no expiry badge", () => {
  const [chosen] = eventsFor([manual({ id: "p", category: "Note", colour: "#123456" })]);
  assert.equal(chosen.colourToken, "#123456");
  assert.equal(chosen.badge, null, "nothing is expiring, so nothing counts down");

  /* An item saved before types existed has no colour of its own; the chip must
     fall through to whatever the reader chose for manual items. */
  const [legacy] = eventsFor([manual({ id: "l", category: "Manual", colour: null })]);
  assert.equal(legacy.colourToken, types.calendarItemType("Note").colour);
  assert.equal(legacy.timing, "due-today", "and it is still drawn");
});

test("every calendar surface gets the chooser, because there is only one of it", async () => {
  /*
   * PARITY BY CONSTRUCTION rather than by inspection.
   *
   * `ManualEventDialog` is mounted in exactly one place — inside
   * `OperationsCalendarPanel` — and that panel is mounted in exactly two: the
   * board's Calendar view tab, which every register including a custom
   * workspace section and Store Documentation renders, and the Planned page.
   * So the type chooser cannot be present on one calendar and missing from
   * another, and a second mount appearing here is the thing that would break
   * that. This is worth an assertion rather than a browser click precisely
   * because it is the kind of parity that is expensive to check by hand and
   * cheap to lose in a refactor.
   */
  const { readdir } = await import("node:fs/promises");
  const dialogMounts = [];
  const panelMounts = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(next);
      } else if (entry.name.endsWith(".tsx")) {
        const code = (await read(next))
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/<ManualEventDialog/.test(code)) dialogMounts.push(next);
        if (/<OperationsCalendarPanel/.test(code)) panelMounts.push(next);
      }
    }
  }
  await walk("app");

  assert.deepEqual(
    dialogMounts,
    ["app/(app)/portal/calendar-surface.tsx"],
    "the dialog must be mounted once, inside the shared panel",
  );
  assert.deepEqual(
    panelMounts.sort(),
    ["app/(app)/portal/board-view-pane.tsx", "app/(app)/portal/portal-app.tsx"],
    "the panel is the board's Calendar tab and the Planned page — a third mount would be a second calendar",
  );
});
