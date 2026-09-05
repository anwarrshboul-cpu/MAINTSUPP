/**
 * WORKING DAYS ARE COUNTED FROM THE DAY AFTER THE REQUEST.
 *
 * Module 4 §4.2: "counted from the day after the request to the day of
 * completion inclusive". The product counted from the request day itself until
 * 2026-09-05, which made every SLA figure one working day larger than the
 * agreement describes.
 *
 * The three cases the owner named are pinned here because each one isolates a
 * different way the arithmetic can be wrong:
 *
 *   · Monday → Tuesday      catches an off-by-one at the start.
 *   · Friday → Monday       catches a weekend being counted.
 *   · across a bank holiday catches the calendar not being consulted, which is
 *                           invisible in any week that has no holiday in it.
 *
 * The fourth case is the one nobody asks for and that changes a client-facing
 * number the most: SAME DAY. Raised and closed on Monday is now ZERO working
 * days, not one. It is asserted below so that the consequence is recorded
 * rather than discovered.
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

/* `period.ts` imports only types, so it loads on its own. */
const period = await import(asModule(transpile(await read("app/lib/reporting/period.ts"))));

/*
 * The holiday calendar, taken from the rows `db/init.ts` actually seeds rather
 * than from a list retyped here. A test that invents its own bank holidays
 * proves the arithmetic and not the wiring.
 */
const initSource = await read("db/init.ts");
const seeded = new Set(
  [...initSource.matchAll(/\["(\d{4}-\d{2}-\d{2})",\s*"[^"]+"\]/g)].map((m) => m[1]),
);

test("the calendar under test is the one the database seeds", () => {
  assert.ok(seeded.size >= 40, `expected the seeded bank holidays, found ${seeded.size}`);
  for (const date of ["2026-12-25", "2026-12-28", "2027-03-26", "2027-03-29"]) {
    assert.ok(seeded.has(date), `${date} must be in the seeded calendar`);
  }
});

/* ── the three named cases ─────────────────────────────────────────────── */

test("request Monday, completion Tuesday — one working day", () => {
  // 2026-09-07 is a Monday; 2026-09-08 the Tuesday after it.
  assert.equal(new Date("2026-09-07T00:00:00Z").getUTCDay(), 1, "the fixture must be a Monday");
  assert.equal(
    period.workingDaysAfterRequest("2026-09-07", "2026-09-08", seeded),
    1,
    "only the Tuesday counts — the day it was reported is not a day it was owed",
  );
});

test("request Friday, completion Monday — one working day", () => {
  // 2026-09-11 Friday, 2026-09-14 the Monday after. Saturday and Sunday are not
  // working days, and the Friday is the request day.
  assert.equal(new Date("2026-09-11T00:00:00Z").getUTCDay(), 5, "the fixture must be a Friday");
  assert.equal(
    period.workingDaysAfterRequest("2026-09-11", "2026-09-14", seeded),
    1,
    "the weekend is not worked and the Friday is the request day",
  );
});

test("a request before a bank holiday excludes the weekend AND the holiday", () => {
  /*
   * Christmas 2026. 25 December is a Friday and a holiday; 26 and 27 are the
   * weekend; 28 December is the substitute Monday for Boxing Day and is also a
   * holiday. So from a request on Thursday 24 December to completion on
   * Tuesday 29 December, the only working day is the 29th itself.
   */
  assert.equal(new Date("2026-12-24T00:00:00Z").getUTCDay(), 4, "24 Dec 2026 is a Thursday");
  assert.ok(seeded.has("2026-12-25") && seeded.has("2026-12-28"), "both holidays are seeded");

  assert.equal(
    period.workingDaysAfterRequest("2026-12-24", "2026-12-29", seeded),
    1,
    "25th holiday, 26th–27th weekend, 28th substitute holiday — only the 29th is worked",
  );

  // The contrast that proves the calendar is actually consulted: with no
  // calendar the same range counts the two holidays as ordinary weekdays.
  assert.equal(
    period.workingDaysAfterRequest("2026-12-24", "2026-12-29"),
    3,
    "without the calendar the 25th and 28th are counted, which is the old wrong answer",
  );
});

/* ── the consequences worth recording ─────────────────────────────────── */

test("same-day work is zero working days, not one", () => {
  assert.equal(
    period.workingDaysAfterRequest("2026-09-07", "2026-09-07", seeded),
    0,
    "fixed inside the day it was reported — against a two-day target, zero is honest",
  );
});

test("every span is exactly one day shorter than the old inclusive rule", () => {
  /*
   * The old rule and the new one differ by precisely the request day, so the
   * two agree whenever that day was a weekend or a holiday and differ by one
   * otherwise. Asserting the relationship rather than a list of numbers is what
   * makes this a statement about the RULE.
   */
  const cases = [
    ["2026-09-07", "2026-09-11"], // Mon → Fri
    ["2026-09-11", "2026-09-14"], // Fri → Mon
    ["2026-12-24", "2026-12-31"], // across Christmas
    ["2027-03-25", "2027-03-30"], // across Easter 2027
  ];
  for (const [from, to] of cases) {
    const inclusive = period.workingDaysInclusive(from, to, seeded);
    const after = period.workingDaysAfterRequest(from, to, seeded);
    const requestDayCounts =
      ![0, 6].includes(new Date(`${from}T00:00:00Z`).getUTCDay()) && !seeded.has(from);
    assert.equal(
      after,
      inclusive - (requestDayCounts ? 1 : 0),
      `${from} → ${to}: the difference must be the request day and nothing else`,
    );
  }
});

test("a completion before the request is zero, not negative", () => {
  assert.equal(period.workingDaysAfterRequest("2026-09-11", "2026-09-07", seeded), 0);
});

test("Easter 2027 comes out of the seeded calendar", () => {
  // Good Friday 26 March, Easter Monday 29 March. Request Thursday 25 March,
  // completion Tuesday 30 March: only the 30th is worked.
  assert.equal(
    period.workingDaysAfterRequest("2027-03-25", "2027-03-30", seeded),
    1,
    "Good Friday, the weekend and Easter Monday are all excluded",
  );
});

/* ── the rule is applied where it matters ─────────────────────────────── */

test("the SLA engine measures elapsed with the new rule and holds with the old one", async () => {
  const sla = await read("app/lib/reporting/sla.ts");
  assert.match(
    sla,
    /const elapsed = workingDaysAfterRequest\(job\.requestedOn, job\.completedOn, holidays\)/,
    "a completed job's elapsed time starts the day after the request",
  );
  assert.match(
    sla,
    /const elapsed = workingDaysAfterRequest\(job\.requestedOn, end, holidays\)/,
    "and so does an open job's, or the two disagree about the same three days",
  );
  /*
   * A hold's own span stays INCLUSIVE. Every day a hold covers is a day the
   * clock was stopped, including its first — this is the asymmetry that would
   * be silently wrong if somebody "tidied" both to one helper.
   */
  const hold = sla.slice(sla.indexOf("export function holdWorkingDays"));
  assert.match(
    hold.slice(0, 900),
    /return workingDaysInclusive\(start, end, holidays\)/,
    "a hold from Monday to Wednesday removes three days, not two",
  );
});

test("a finalised document is never recomputed, so no historical figure moves", async () => {
  /*
   * The whole safety of this change rests here. Every SLA figure is now one day
   * lower, so if a finalised document were recomputed on read its numbers would
   * change after the fact — the one outcome that must not happen.
   */
  const documents = await read("app/lib/reporting/documents.ts");
  assert.match(
    documents,
    /if \(status === "Finalised" \|\| status === "Voided"\) \{\s*const snapshot = await readSnapshot/,
    "the status branch must come BEFORE any recomputation",
  );
  assert.ok(
    !/catch[\s\S]{0,200}computeReport/.test(documents),
    "and an unreadable snapshot must not fall back to today's numbers",
  );
});
