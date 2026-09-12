/**
 * THE DONUT'S SMALLEST SLICE — one of three hundred is still one.
 *
 * `Donut` in `ov-dash-charts.tsx` draws each slice as an arc of its share minus
 * a segment gap, and `OvArc` refuses to draw anything under 0.05px so that a
 * zero cannot appear on the ring as a dot. Those two rules together had a hole
 * in the middle: on a 150px repeat donut a slice of 1 in 300 is about 1.4px of
 * ring, the 2px gap is taken out of it, and what was left was negative. A
 * category with one job in it drew exactly like a category with none — the same
 * fault `SegmentedRing` next door already solves by drawing a dot.
 *
 * The fix is `ovDisplayFractions`, and what this suite holds is the line
 * between the two kinds of number it creates:
 *
 *   · the GEOMETRY may be adjusted, because a picture has a resolution and a
 *     share below it is a share the picture cannot show;
 *   · the NUMBERS may not. Every percentage, tooltip line, legend figure and
 *     accessible name still divides the real value by the real sum, and this
 *     file pins that by source as well as by arithmetic.
 *
 * The helper is imported from the module's own pure-maths section, sliced and
 * transpiled on its own — the trick `rp-dash-ui.test.mjs` uses — so what is
 * tested is the function the component calls and not a copy of it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const CHARTS = "app/(app)/portal/ops/ov-dash-charts.tsx";
const ts = (await import("typescript")).default;

/** A slice of a module, transpiled on its own and imported from a data: URL. */
async function importSlice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `the slice still starts at "${from}"`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `the slice still ends at "${to}"`);
  const output = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

const chartsSource = await read(CHARTS);
const maths = await importSlice(chartsSource, "/* ── Pure maths", "/* ── Environment hooks");

/** The Reports block's repeat donut: 150px box, radius 66, 2px gaps. */
const RADIUS = 66;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP_PX = 2;
const minShare = (values, gapPx = GAP_PX) =>
  (values.filter((value) => value > 0).length > 1 ? gapPx / CIRCUMFERENCE : 0) +
  maths.OV_MIN_SLICE_MARK_PX / CIRCUMFERENCE;

const sum = (list) => list.reduce((running, value) => running + value, 0);
const close = (actual, expected, within, what) =>
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);

/* ── The arithmetic ───────────────────────────────────────────────────────── */

test("a slice of one in three hundred is still drawn, and still after its gap", () => {
  const values = [1, 299];
  const floor = minShare(values);
  const display = maths.ovDisplayFractions(values, floor);

  assert.ok(display[0] >= floor - 1e-12, `the small slice gets the floor: ${display[0]} < ${floor}`);
  /* What matters is not the share but what survives the gap: the visible arc. */
  const visiblePx = (display[0] - GAP_PX / CIRCUMFERENCE) * CIRCUMFERENCE;
  assert.ok(
    visiblePx >= maths.OV_MIN_SLICE_MARK_PX - 1e-9,
    `after the 2px gap the mark is ${visiblePx.toFixed(2)}px, under the ${maths.OV_MIN_SLICE_MARK_PX}px minimum`,
  );
  /* Without the floor it was 1.4px of ring, and the gap left nothing at all. */
  const truePx = (1 / 300) * CIRCUMFERENCE;
  assert.ok(truePx - GAP_PX < 0.05, "the case is real: the true arc does not survive its own gap");

  close(sum(display), 1, 1e-12, "the ring still closes");
  assert.ok(display[1] < 299 / 300, "the large slice pays for it");
  assert.ok(display[1] > 0.97, "and is still, visibly, almost all of the ring");
});

test("the floor is paid for in proportion, so the big slices keep their ratio", () => {
  const display = maths.ovDisplayFractions([1, 100, 200], 0.05);
  assert.equal(display[0], 0.05, "the slice under the floor is lifted exactly to it");
  close(display[2] / display[1], 2, 1e-9, "200 is still twice 100");
  close(sum(display), 1, 1e-12, "the ring still closes");
});

test("a zero is left at nothing — the floor is for slices that exist", () => {
  assert.deepEqual(maths.ovDisplayFractions([0, 5], minShare([0, 5])), [0, 1]);
  const three = maths.ovDisplayFractions([0, 1, 299], minShare([0, 1, 299]));
  assert.equal(three[0], 0, "an empty category draws nothing");
  assert.ok(three[1] >= minShare([0, 1, 299]) - 1e-12, "and its neighbour of one still marks the ring");
  close(sum(three), 1, 1e-12, "the ring still closes");
});

test("one slice is a closed ring, and no slices are no ring", () => {
  assert.deepEqual(maths.ovDisplayFractions([7], minShare([7])), [1]);
  assert.deepEqual(maths.ovDisplayFractions([], 0.01), []);
  assert.deepEqual(maths.ovDisplayFractions([0, 0], 0.01), [0, 0]);
});

test("lifting one slice can push its neighbour under the floor, and that one is lifted too", () => {
  /*
   * [1, 5, 294] at a floor of 2%: the 1 is under it at once, and shrinking the
   * rest to pay for that leaves the 5 under it as well. A single pass would
   * have drawn the 5 smaller than the 1 it was lifted above.
   */
  const display = maths.ovDisplayFractions([1, 5, 294], 0.02);
  assert.equal(display[0], 0.02);
  assert.equal(display[1], 0.02);
  close(display[2], 0.96, 1e-12, "the rest takes what is left");
  close(sum(display), 1, 1e-12, "the ring still closes");
  assert.ok(display[1] >= display[0], "no slice is ever drawn smaller than a smaller one");
});

test("too many slices for the floor, and the true fractions come back untouched", () => {
  const many = Array.from({ length: 80 }, () => 1);
  const floor = minShare(many);
  assert.ok(many.length * floor > 1, "the case is real: 80 floors do not fit in one turn");
  const display = maths.ovDisplayFractions(many, floor);
  for (const fraction of display) close(fraction, 1 / 80, 1e-12, "a true share");
  close(sum(display), 1, 1e-12, "the ring still closes");
});

test("a slice already above the floor is left exactly where it was", () => {
  const values = [120, 90, 45];
  const display = maths.ovDisplayFractions(values, minShare(values));
  values.forEach((value, index) => {
    close(display[index], value / sum(values), 1e-12, `${value} is drawn at its true share`);
  });
});

test("nonsense in is zero out, and the caller's array is not touched", () => {
  const values = [Number.NaN, -4, 10, Number.POSITIVE_INFINITY];
  const copy = [...values];
  const display = maths.ovDisplayFractions(values, 0.02);
  assert.deepEqual(display, [0, 0, 1, 0], "only the one real value is on the ring");
  assert.deepEqual(values, copy, "the values array is read, never written");
  assert.deepEqual(maths.ovDisplayFractions([1, 1], Number.NaN), [0.5, 0.5], "a nonsense floor is no floor");
  assert.deepEqual(maths.ovDisplayFractions([1, 1], 0), [0.5, 0.5]);
});

test("the floor never changes a percentage", () => {
  /* The numbers the reader sees come from `ovPercent`, which never meets the
     display fractions. 1 of 300 is 0% and drawing it does not make it 1%. */
  assert.equal(maths.ovPercent(1, 300), 0);
  assert.equal(maths.ovPercent(299, 300), 100);
  assert.equal(maths.ovPercent(5, 300), 2);
});

/* ── The line between the picture and the numbers, in the source ──────────── */

const donut = (() => {
  const start = chartsSource.indexOf("export function Donut({");
  const end = chartsSource.indexOf("/* ── 3. The speedometer", start);
  assert.ok(start > 0 && end > start, "the Donut is still one block in ov-dash-charts.tsx");
  return chartsSource.slice(start, end);
})();

test("the ring is swept from display fractions, and only the ring is", () => {
  assert.match(
    donut,
    /const eased = useOvSweep\(\s*ovDisplayFractions\(values, gapTurn \+ OV_MIN_SLICE_MARK_PX \/ circumference\),\s*\);/,
    "the floor is the gap plus the smallest mark, and it feeds the sweep",
  );
  assert.match(donut, /sweep=\{Math\.max\(0, \(eased\[index\] \?\? 0\) - gapTurn\)\}/, "the arc is still the share minus its gap");
  assert.match(donut, /from=\{\(starts\[index\] \?\? 0\) \+ gapTurn \/ 2\}/);
});

test("every number a reader is given is still the real one", () => {
  assert.match(
    donut,
    /const readout = slices\s*\.map\(\(slice, index\) => `\$\{slice\.label\} \$\{write\(values\[index\]\)\} \(\$\{ovPercent\(values\[index\], sum\)\}%\)`\)/,
    "the accessible readout counts values against the real sum",
  );
  assert.match(donut, /aria-label=\{`\$\{ariaLabel\}: \$\{readout \|\| "no data"\}\. \$\{printed\} \$\{caption\}`\}/);
  assert.match(donut, /tipLines\(slices\[activeIndex\], ovFraction\(values\[activeIndex\], sum\)\)/, "a caller's tooltip is handed the true share");
  assert.match(donut, /`\$\{write\(values\[activeIndex\]\)\} of \$\{write\(sum\)\}`/, "x of y is x of y");
  assert.match(donut, /`\$\{ovPercent\(values\[activeIndex\], sum\)\}%`/);
  assert.match(donut, /denominator=\{sum\}/, "the keyboard slices are spoken against the real sum too");
  assert.match(donut, /slices=\{slices\}/, "and carry the caller's own values");
});

test("no sentence the reader hears is built from the drawing", () => {
  /*
   * The one failure this whole change could cause is a percentage computed from
   * the geometry. Every line that prints or speaks a figure is checked for the
   * two names the geometry goes by.
   */
  const speaking = donut
    .split("\n")
    .filter((line) => /aria-label|readout|tipLines|ovPercent|ovFraction|write\(/.test(line));
  assert.ok(speaking.length >= 6, "the lines that speak are still here to check");
  for (const line of speaking) {
    assert.doesNotMatch(line, /\beased\b|ovDisplayFractions|OV_MIN_SLICE_MARK_PX/, `a spoken figure reads the drawing: ${line.trim()}`);
  }
});

test("OvSliceKeys names a slice by its own value and its own share", () => {
  assert.match(
    chartsSource,
    /aria-label=\{`\$\{slice\.label\}: \$\{formatValue\(slice\.value\)\}, \$\{ovPercent\(slice\.value, denominator\)\}%`\}/,
    "the keyboard route speaks the payload's value, never a drawn one",
  );
});

test("an arc of nothing still draws nothing", () => {
  /* The floor is for slices that exist. `OvArc`'s refusal is what stops a zero
     — and the first frame of every sweep — from appearing as a coloured pip. */
  assert.match(chartsSource, /if \(drawn <= 0\.05\) return null;/);
});
