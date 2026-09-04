/**
 * THE FIVE JOB METERS ON THE DASHBOARD OVERVIEW.
 *
 * The owner asked for five Main Table columns — Tier Level, Engineer Required,
 * Priority, Label and Status — to be readable as distributions without opening
 * the board.
 *
 * The invariant worth a test is not "the bars look right". It is that NOTHING
 * IS EVER DROPPED: a meter is a claim about every job in the window, and the
 * way that claim goes wrong is silent. A value the option set has never heard
 * of gets skipped, the remaining bars still fill the track, and nothing on
 * screen says four jobs went missing. So every assertion below is ultimately
 * the same assertion — the segments account for every row.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = async (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

/*
 * Two halves, on purpose.
 *
 * The behavioural half at the bottom imports the module and runs it — Node
 * strips the types natively here, so there is no build step in the way. Those
 * are the tests that would actually catch a job going missing from a bar.
 *
 * The source-reading half here pins the things a passing behavioural test
 * cannot see: that the five columns are the five the owner named and in the
 * board's order, that each names the option set it colours from, and that the
 * surprising `label -> category` mapping still carries the note explaining it.
 * A future edit could satisfy every assertion below by accident only by leaving
 * the contract intact.
 */
const SERIES = "app/(app)/portal/views/overview-series.ts";

test("the five meters are exactly the five columns the owner named, in board order", async () => {
  const source = await read(SERIES);
  const block = source.slice(
    source.indexOf("export const JOB_METER_COLUMNS"),
    source.indexOf("] as const;", source.indexOf("export const JOB_METER_COLUMNS")),
  );
  assert.ok(block.length > 0, "JOB_METER_COLUMNS must exist");

  const titles = [...block.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(titles, [
    "Tier Level",
    "Engineer Required",
    "Priority",
    "Label",
    "Status",
  ]);

  /*
   * Each meter names the option set it takes its colours from. These are the
   * keys /api/options actually serves — checked against the live route on
   * 2026-09-04, which returned tier_level(4), engineer_required(4), priority(3),
   * maintenance_label(16) and maintenance_status(23).
   */
  const sets = [...block.matchAll(/optionSetKey: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sets, [
    "tier_level",
    "engineer_required",
    "priority",
    "maintenance_label",
    "maintenance_status",
  ]);
});

test("the Label column reads request.category, and says why", async () => {
  const source = await read(SERIES);
  const fn = source.slice(
    source.indexOf("export function jobColumnValue"),
    source.indexOf("/** One configured option"),
  );
  assert.ok(fn.length > 0, "jobColumnValue must exist");

  /*
   * This is the mapping that would make a meter lie confidently if it were
   * wrong. There is no `label` field on a maintenance request — the board
   * column titled "Label" is stored as `category` — so the pin is on the pair,
   * not on the presence of the word.
   */
  assert.match(fn, /case "label":[\s\S]{0,200}return request\.category;/);
  assert.match(fn, /case "tier":[\s\S]{0,80}return request\.tier;/);
  assert.match(fn, /case "engineer":[\s\S]{0,80}return request\.engineer;/);
  assert.match(fn, /case "priority":[\s\S]{0,80}return request\.priority;/);
  assert.match(fn, /case "status":[\s\S]{0,80}return request\.status;/);
  assert.ok(
    /Not a typo/.test(fn),
    "the surprising mapping must carry the note that explains it",
  );
});

test("a tier of zero is absence, not a Tier 0 category", async () => {
  const source = await read(SERIES);
  const fn = source.slice(
    source.indexOf("function meterValueText"),
    source.indexOf("export function buildJobMeters"),
  );
  assert.ok(fn.length > 0, "meterValueText must exist");
  /*
   * `tier` is `INTEGER NOT NULL DEFAULT 2` on maintenance_requests and the
   * option set starts at 1, so a non-positive tier is a row nobody has set —
   * it belongs in the not-recorded bucket, not in a bar of its own.
   */
  assert.match(fn, /raw > 0/);
  assert.ok(
    fn.includes("UNUSABLE_TRADE_VALUES"),
    "blank-ish text must be folded by the same rule tradeLabel already uses, not a second one",
  );
});

test("every segment is accounted for: nothing may be dropped or double-counted", async () => {
  const source = await read(SERIES);
  const fn = source.slice(source.indexOf("export function buildJobMeters"));

  // Absence gets a named segment rather than being omitted.
  assert.ok(
    fn.includes("METER_UNRECORDED_LABEL"),
    "the not-recorded bucket must be a labelled segment",
  );
  // An unconfigured value keeps its own segment rather than being skipped.
  assert.match(
    fn,
    /unknown: !option/,
    "a value the option set does not know must be marked, not discarded",
  );
  assert.ok(
    !/\.filter\(/.test(fn),
    "buildJobMeters must not filter rows out — every job lands in a segment",
  );
  /*
   * The share denominator is the WHOLE window, not the recorded subset. Using
   * `recorded` would make a meter with four unrecorded jobs draw a full track
   * from eleven, which is the exact misreading this module exists to prevent.
   */
  assert.match(fn, /const denominator = total \|\| 1;/);
  assert.ok(
    !/share: count \/ recorded/.test(fn),
    "share must be of the whole window, so a partly-unrecorded column cannot draw a full bar",
  );
});

test("meters take their colours from the configured options, never an invented palette", async () => {
  const source = await read(SERIES);
  const fn = source.slice(source.indexOf("export function buildJobMeters"));
  assert.match(fn, /color: option\?\.colourHex \?\? METER_UNKNOWN_COLOR/);
  assert.match(fn, /textColor: option\?\.textColour \?\? "#ffffff"/);
  /*
   * The board paints these five columns with the administrator's own colours.
   * A meter with its own palette would be the same data in different colours
   * one click away, which teaches a reader to trust neither.
   */
  assert.ok(
    !/palette\[/.test(fn),
    "the meters must not fall back to tradeBreakdown's rotating palette",
  );
});

test("ties break on the administrator's ordering, not on row arrival order", async () => {
  const source = await read(SERIES);
  const fn = source.slice(source.indexOf("export function buildJobMeters"));
  assert.match(fn, /if \(right\.count !== left\.count\) return right\.count - left\.count;/);
  assert.ok(
    fn.includes("position ?? Number.MAX_SAFE_INTEGER"),
    "equal counts must fall back to the configured position",
  );
});

/* ── Behavioural half ─────────────────────────────────────────────────────
 *
 * Node strips types natively here, so the module is imported and run rather
 * than only read. These are the assertions that would actually catch a job
 * going missing from a bar.
 */

const job = (over = {}) => ({
  tier: 2,
  engineer: "Plummer",
  priority: "Medium",
  category: "Plumbing",
  status: "Pending Approval",
  ...over,
});

const OPTIONS = {
  tier: [
    { value: "1", label: "Tier 1", colourHex: "#e2445c", textColour: "#fff", position: 0 },
    { value: "2", label: "Tier 2", colourHex: "#fdab3d", textColour: "#fff", position: 1 },
    { value: "3", label: "Tier 3", colourHex: "#579bfc", textColour: "#fff", position: 2 },
  ],
  priority: [
    { value: "Urgent", label: "Urgent", colourHex: "#e2445c", textColour: "#fff", position: 0 },
    { value: "Medium", label: "Medium", colourHex: "#fdab3d", textColour: "#fff", position: 1 },
    { value: "Low", label: "Low", colourHex: "#00c875", textColour: "#fff", position: 2 },
  ],
};

test("every job lands in exactly one segment of every meter", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  const rows = [
    job({ tier: 1, priority: "Urgent" }),
    job({ tier: 2, priority: "Medium" }),
    job({ tier: 3, priority: "Low" }),
    job({ tier: 0, priority: "" }),          // never set
    job({ tier: 2, priority: "Screaming" }), // not a configured option
  ];
  for (const meter of buildJobMeters(rows, OPTIONS)) {
    const summed = meter.segments.reduce((total, segment) => total + segment.count, 0);
    assert.equal(
      summed,
      rows.length,
      `${meter.title}: segments summed to ${summed}, not ${rows.length}`,
    );
    assert.equal(meter.total, rows.length);
    assert.equal(meter.recorded + meter.unrecorded, meter.total);
    const share = meter.segments.reduce((total, segment) => total + segment.share, 0);
    assert.ok(Math.abs(share - 1) < 1e-9, `${meter.title}: shares summed to ${share}`);
  }
});

test("an unset tier is Not recorded, and a tier of 3 is not", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  const [tier] = buildJobMeters(
    [job({ tier: 0 }), job({ tier: 3 }), job({ tier: 3 })],
    OPTIONS,
  );
  const unrecorded = tier.segments.find((segment) => segment.value === "");
  assert.equal(tier.unrecorded, 1);
  assert.equal(unrecorded.label, "Not recorded");
  assert.equal(unrecorded.count, 1);
  const three = tier.segments.find((segment) => segment.value === "3");
  assert.equal(three.count, 2);
  assert.equal(three.label, "Tier 3");
  assert.equal(three.color, "#579bfc", "the configured colour, not an invented one");
});

test("a value the option set has never heard of keeps its own marked segment", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  const meters = buildJobMeters([job({ priority: "Screaming" })], OPTIONS);
  const priority = meters.find((meter) => meter.key === "priority");
  const segment = priority.segments.find((entry) => entry.value === "Screaming");
  assert.ok(segment, "the unconfigured value must survive as its own segment");
  assert.equal(segment.unknown, true, "and must be marked as unconfigured");
  assert.equal(segment.count, 1);
  assert.equal(priority.unrecorded, 0, "an unknown value is not the same as a missing one");
});

test("the Label meter counts request.category", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  const meters = buildJobMeters(
    [job({ category: "Refrigeration" }), job({ category: "Refrigeration" }), job({ category: "HVAC" })],
    {},
  );
  const label = meters.find((meter) => meter.key === "label");
  assert.deepEqual(
    label.segments.map((segment) => [segment.label, segment.count]),
    [["Refrigeration", 2], ["HVAC", 1]],
  );
});

test("equal counts fall back to the administrator's ordering", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  // One each: Low(position 2) arrives first, Urgent(position 0) last.
  const meters = buildJobMeters(
    [job({ priority: "Low" }), job({ priority: "Medium" }), job({ priority: "Urgent" })],
    OPTIONS,
  );
  const priority = meters.find((meter) => meter.key === "priority");
  assert.deepEqual(
    priority.segments.map((segment) => segment.value),
    ["Urgent", "Medium", "Low"],
    "ties must order by configured position, not by the order rows arrived",
  );
});

test("no jobs at all produces five empty meters rather than a crash or a full bar", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  const meters = buildJobMeters([], OPTIONS);
  assert.equal(meters.length, 5);
  for (const meter of meters) {
    assert.equal(meter.total, 0);
    assert.deepEqual(meter.segments, [], `${meter.title} must draw nothing`);
  }
});

test("the tier bridge stays spelled the same as board-sort's tierDigits", async () => {
  /*
   * `maintenance_requests.tier` stores 1-4; the tier_level option set stores
   * "Tier 1".."Tier 4". live-board.tsx calls the mapping between them "the one
   * bridge" and implements it with `tierDigits` from board-sort.ts.
   *
   * overview-series.ts carries a second copy, deliberately: it must remain
   * importable by `node --test`, which resolves no extensionless specifiers,
   * and board-sort.ts reaches board-ordering and board-format behind them.
   * A second copy is only acceptable while it cannot drift, so this pins the
   * two spellings to each other — if either regex changes, this goes red.
   */
  const sort = await read("app/(app)/portal/board-sort.ts");
  const series = await read(SERIES);

  const canonical = sort.match(/export const tierDigits = \(value: string\) =>\s*value\.replace\((\/[^/]+\/[a-z]*), ""\)/);
  assert.ok(canonical, "board-sort.ts must still export tierDigits");

  const copies = [...series.matchAll(/replace\((\/[^/]+\/[a-z]*), ""\)/g)].map((m) => m[1]);
  assert.ok(copies.length >= 2, "the meters must carry the tier bridge");
  for (const copy of copies) {
    assert.equal(
      copy,
      canonical[1],
      `the meter's tier regex ${copy} has drifted from board-sort's ${canonical[1]}`,
    );
  }
  assert.ok(
    series.includes("THE TIER BRIDGE"),
    "the duplication must keep the note explaining why it is not an import",
  );
});

test("a tier of 3 resolves to the configured 'Tier 3' option, label and colour", async () => {
  const { buildJobMeters } = await import("../app/(app)/portal/views/overview-series.ts");
  /*
   * The real /api/options shape, checked on 2026-09-04: the VALUE is "Tier 3",
   * not "3". Before the bridge this segment drew grey and captioned itself "3".
   */
  const tierOptions = [
    { value: "Tier 1", label: "Tier 1", colourHex: "#e2445c", textColour: "#fff", position: 0 },
    { value: "Tier 2", label: "Tier 2", colourHex: "#fdab3d", textColour: "#fff", position: 1 },
    { value: "Tier 3", label: "Tier 3", colourHex: "#579bfc", textColour: "#fff", position: 2 },
  ];
  const [tier] = buildJobMeters(
    [job({ tier: 3 }), job({ tier: 3 }), job({ tier: 1 })],
    { tier: tierOptions },
  );
  const three = tier.segments.find((segment) => segment.value === "3");
  assert.equal(three.count, 2);
  assert.equal(three.label, "Tier 3", "the configured label, not the bare digit");
  assert.equal(three.color, "#579bfc", "and the configured colour, not the grey fallback");
  assert.equal(three.unknown, false, "a tier that maps to an option is not unconfigured");
});
