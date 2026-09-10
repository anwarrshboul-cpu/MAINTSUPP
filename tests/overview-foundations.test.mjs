/**
 * The Overview's foundations — §1 of the dashboard master prompt.
 *
 * Three things are checked here that nothing else can check, because each is a
 * contract between two files that a compiler cannot see:
 *
 *   1. the meter ramp exists in TWO places — `app/lib/overview-meters.ts`, where
 *      a `<div>` gets its inline colour from data, and
 *      `app/(app)/portal/ops/ops-tokens.css`, where a rule gets it from a token
 *      — because CSS cannot import TypeScript. A duplicate nobody checks is how
 *      this page came to have two answers for one question in the first place;
 *   2. the percentage rule is arithmetic, and arithmetic can be tested rather
 *      than reviewed;
 *   3. `other` is a permanent catch-all, which is what makes "a status added
 *      later reconciles with no code change" true by construction.
 *
 * `overview-meters.ts` is loaded NATIVELY rather than transpiled, which is only
 * possible because its one runtime import names `./job-metrics.ts` with the
 * extension — node's ESM resolver does not add one. `job-metrics.ts` carries
 * the same specifier on its own import for the same reason, and
 * `tests/ops-rebuild-foundations.test.mjs` imports it natively too. The inverse
 * rule applies to any module a suite transpiles to a `data:` URL: from there a
 * relative specifier cannot resolve at all.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/*
 * Comments out, before anything slices on a selector.
 *
 * `ops-tokens.css` explains its own dark selector in prose, so the header
 * contains the literal string `:root:not([data-theme="light"])` a long way
 * above the rule that uses it. Slicing the raw file found the sentence rather
 * than the selector and handed every assertion below an empty string — which
 * failed, correctly, but for a reason that had nothing to do with the colours.
 */
const codeOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const meters = await import("../app/lib/overview-meters.ts");

/* ── The duplicated ramp ──────────────────────────────────────────────────── */

test("the meter ramp is the same eight colours in the module and in the stylesheet", async () => {
  const css = codeOnly(await read("app/(app)/portal/ops/ops-tokens.css"));
  /*
   * The LIGHT block only. `:root` carries the brief's literal values and the
   * dark block deliberately lifts each one — same hue, more lightness — so that
   * `#0B6E63` is not invisible on a #182830 card. Comparing the dark block
   * against the TypeScript would fail for the reason the dark block exists.
   */
  const light = css.slice(css.indexOf(":root {"), css.indexOf(':root:not([data-theme="light"])'));
  assert.ok(light.length > 400, "the light token block was found");

  const cssVariable = {
    completed: "--ms-meter-completed",
    scheduled: "--ms-meter-scheduled",
    in_progress: "--ms-meter-in-progress",
    waiting_approval: "--ms-meter-waiting-approval",
    waiting_parts: "--ms-meter-waiting-parts",
    waiting_payment: "--ms-meter-waiting-payment",
    needs_attention: "--ms-meter-needs-attention",
    other: "--ms-meter-other",
  };

  for (const key of meters.METER_KEYS) {
    const declared = new RegExp(`${cssVariable[key]}:\\s*(#[0-9a-fA-F]{6})`).exec(light);
    assert.ok(declared, `${cssVariable[key]} is declared on :root`);
    assert.equal(
      declared[1].toLowerCase(),
      meters.METER_SEED_COLOUR[key].toLowerCase(),
      `${key}: the stylesheet and overview-meters.ts must agree`,
    );
  }
});

test("the severity ramp is the same four colours in both places", async () => {
  const css = codeOnly(await read("app/(app)/portal/ops/ops-tokens.css"));
  const light = css.slice(css.indexOf(":root {"), css.indexOf(':root:not([data-theme="light"])'));
  for (const key of meters.SEVERITY_KEYS) {
    const declared = new RegExp(`--ms-sev-${key}:\\s*(#[0-9a-fA-F]{6})`).exec(light);
    assert.ok(declared, `--ms-sev-${key} is declared`);
    assert.equal(declared[1].toLowerCase(), meters.SEVERITY_COLOUR[key].toLowerCase());
  }
});

test("no ramp colour is defined only inside a theme block", async () => {
  /*
   * `app/globals.css` records this failure at its head: a colour declared only
   * under `[data-theme]` applies in one state and vanishes in the other, and it
   * shipped headings at 1.03:1 on the settings page. Dark is the DEFAULT here,
   * so the failure mode is the light theme silently losing a ramp.
   */
  const css = codeOnly(await read("app/(app)/portal/ops/ops-tokens.css"));
  const split = css.indexOf(':root:not([data-theme="light"])');
  const light = css.slice(0, split);
  const dark = css.slice(split);
  const names = [...dark.matchAll(/(--ms-[a-z0-9-]+):/g)].map((match) => match[1]);
  assert.ok(names.length >= 20, "the dark block redefines the ramps");
  for (const name of new Set(names)) {
    assert.ok(light.includes(`${name}:`), `${name} must also be declared on bare :root`);
  }
});

test("the operations token sheet uses only the agreed breakpoints", async () => {
  const css = codeOnly(await read("app/(app)/portal/ops/ops-tokens.css"));
  const widths = [...css.matchAll(/\(min-width:\s*(\d+)px\)|\(max-width:\s*(\d+)px\)/g)].map(
    (match) => Number(match[1] ?? match[2]),
  );
  for (const width of widths) {
    assert.ok([640, 767, 768, 1024, 1280].includes(width), `${width}px is not an agreed breakpoint`);
  }
});

/* ── The percentage rule (§1.4) ───────────────────────────────────────────── */

test("shares of recorded sum to exactly 100 after rounding", () => {
  const cases = [
    [1, 1, 1],
    [110, 45, 38],
    [7, 7, 7, 7, 7, 7, 7],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [999, 1],
    [1],
  ];
  for (const values of cases) {
    const shares = meters.sharesOfRecorded(values);
    assert.equal(
      shares.reduce((sum, share) => sum + share, 0),
      100,
      `${values.join("+")} must sum to 100, got ${shares.join("+")}`,
    );
  }
});

test("the rounding correction lands on the largest slice, not the smallest", () => {
  /*
   * A one-point correction on a 2% slice is a 50% error on that number; the
   * same point on a 57% slice is invisible. Three equal thirds round to 33
   * apiece and leave one point over, so the first-largest takes it.
   */
  const shares = meters.sharesOfRecorded([2, 96, 2]);
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 100);
  assert.deepEqual([shares[0], shares[2]], [2, 2], "the small slices are untouched");
});

test("an empty denominator yields zeros rather than NaN", () => {
  assert.deepEqual(meters.sharesOfRecorded([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(meters.sharesOfRecorded([]), []);
});

test("coverage never rounds a gap up to 100 per cent", () => {
  /* 999 of 1000 is 99.9%, and printing "100% recorded" over a missing row is
     precisely the conflation §1.4 exists to stop. */
  assert.match(meters.coverageSentence("Engineer required", 999, 1000), /\(99%\)/);
  assert.match(meters.coverageSentence("Engineer required", 1000, 1000), /\(100%\)/);
  assert.match(meters.coverageSentence("Engineer required", 193, 226), /193 of 226 recorded \(85%\)/);
});

/* ── The catch-all invariant (§2.1) ───────────────────────────────────────── */

test("a status nobody has mapped resolves to other, and other is the catch-all", () => {
  const assignments = new Map([
    ["job completed", "completed"],
    ["pending approval", "waiting_approval"],
  ]);
  assert.equal(meters.meterForStatus(assignments, "Job Completed"), "completed");
  /* Normalised on both sides: a spreadsheet round trip must not split a status. */
  assert.equal(meters.meterForStatus(assignments, "  pending   Approval "), "waiting_approval");
  /* The whole point — a status invented tomorrow. */
  assert.equal(meters.meterForStatus(assignments, "Awaiting drone survey"), "other");
  assert.equal(meters.meterForStatus(assignments, ""), "other");
  assert.equal(meters.meterForStatus(assignments, null), "other");
  /* A row pointing at a meter that no longer exists is not a hole either. */
  assert.equal(meters.meterForStatus(new Map([["x", "retired_meter"]]), "x"), "other");
  assert.equal(meters.CATCH_ALL_METER, "other");
});

test("the eight meters are in workflow order and the seed marks exactly one catch-all", () => {
  assert.deepEqual(
    [...meters.METER_KEYS],
    [
      "completed",
      "scheduled",
      "in_progress",
      "waiting_approval",
      "waiting_parts",
      "waiting_payment",
      "needs_attention",
      "other",
    ],
    "the segmented bar reads left to right as one progression — §1.3",
  );
  const seed = meters.seedMeterDefinitions();
  assert.equal(seed.length, 8);
  assert.equal(seed.filter((meter) => meter.isCatchAll).length, 1);
  assert.equal(seed.find((meter) => meter.isCatchAll)?.key, "other");
});

test("the four waiting meters are the ones Where work is stuck reads", () => {
  assert.deepEqual(
    [...meters.WAITING_METERS],
    ["waiting_approval", "waiting_parts", "waiting_payment", "needs_attention"],
  );
});

/* ── Ageing and wording ───────────────────────────────────────────────────── */

test("severity bands break on the stated boundaries, inclusive", () => {
  assert.equal(meters.severityBand(0), "fresh");
  assert.equal(meters.severityBand(14), "fresh");
  assert.equal(meters.severityBand(15), "ageing");
  assert.equal(meters.severityBand(30), "ageing");
  assert.equal(meters.severityBand(31), "overdue");
  assert.equal(meters.severityBand(60), "overdue");
  assert.equal(meters.severityBand(61), "critical");
  assert.equal(meters.severityBand(3650), "critical");
});

test("cohort wording follows the axis, not just the figure", () => {
  assert.equal(meters.cohortWording("requested", 226), "226 jobs requested in this period");
  assert.equal(meters.cohortWording("completed", 226), "226 jobs completed in this period");
  assert.equal(meters.cohortWording("requested", 1), "1 job requested in this period");
});

test("the exclusion footnote names the field that is missing", () => {
  assert.equal(
    meters.excludedWording("requested", 14),
    "14 jobs excluded — no request date recorded",
  );
  assert.equal(
    meters.excludedWording("completed", 1),
    "1 job excluded — no completion date recorded",
  );
});

test("the teal scale is one hue, darkest first, and clamps rather than throwing", () => {
  assert.equal(meters.tealScale(0), "#075E63");
  assert.notEqual(meters.tealScale(0), meters.tealScale(1));
  assert.equal(meters.tealScale(99), meters.tealScale(6), "past the end it clamps");
  assert.equal(meters.tealScale(-1), meters.tealScale(6));
  assert.equal(meters.tealScale(Number.NaN), meters.tealScale(6));
});

test("the Overview retires the hashed categorical palette", async () => {
  /*
   * §1.3: "Retire the current arbitrary palette (gold, cyan, pink, purple,
   * assorted blues) from the whole page — it carries no meaning and matches
   * nothing in the brand." Three of those eight also collided with the semantic
   * family, priority and ageing colours used on the same page, so a reader was
   * invited to learn a colour that meant one thing in the legend and another
   * six inches away.
   *
   * `job-metrics.ts` keeps `CATEGORICAL_COLOURS` because Compliance and Sites
   * still use it; what must not happen is the Overview importing it again.
   */
  const source = await read("app/lib/overview-meters.ts");
  for (const hex of ["#F5D547", "#22D3EE", "#EC4899", "#A78BFA", "#C4B04A"]) {
    assert.ok(!source.toUpperCase().includes(hex), `${hex} must not appear in the Overview ramp`);
  }
});
