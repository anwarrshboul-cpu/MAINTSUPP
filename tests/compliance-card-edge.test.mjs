/**
 * THE STATE-TINTED LEFT EDGE, AND WHY ITS GEOMETRY IS PINNED.
 *
 * Every operations card carries a coloured left edge: the site's completion
 * band on the Compliance register (`COMPLETION_BANDS` — red under 50%, through
 * amber and orange, to green), the availability or insurance state on a
 * Contractors row, urgency on a Sites row. It is set as an inline `--ops-edge`
 * and drawn by a pseudo-element.
 *
 * That pseudo-element used to be a BOX OF ITS OWN: 3px wide, with its own 12px
 * corner radii. A 12px corner does not fit in a 3px box — CSS scales
 * overlapping radii down by the ratio the box can hold, here 3/12 — so the
 * strip drew a 3px curve against the card's 12px one and stood outside it at
 * both left corners. Measured in Chromium before the fix: 24 to 37 painted
 * accent pixels outside the card's rounded outline per corner, up to 2.9 CSS px
 * clear of it, at 320 / 390 / 768 / 1024 / 1440 in both themes. On the
 * Compliance register the sticky header hid the middle of the strip, so what
 * shipped read as two red slivers at the corners plus a bar beside the coverage
 * line — the screenshot that opened this batch.
 *
 * The fix is geometric rather than cosmetic: the pseudo-element covers the
 * card's whole BORDER box and inherits its radius, and the accent is an INSET
 * shadow, which an engine clips to that rounded outline. Nothing about it can
 * be outside the card whatever the radius becomes.
 *
 * This file pins the shape of that fix, and pins the ABSENCE of the shape it
 * replaced — a narrow strip carrying corner radii of its own is the bug, and it
 * is the kind of rule somebody re-adds while "restoring" the edge.
 *
 * The browser proof (corner crops and a pixel count at five widths in both
 * themes) is not here: `playwright` is not one of this repository's
 * dependencies and the suite runs under plain `node --test`. It lives in the
 * batch's scratchpad script instead.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const OPS_CSS = "app/(app)/portal/ops/ops.css";
const RESP_CSS = "app/(app)/portal/ops/compliance-responsibility.css";
const PAGE = "app/(app)/portal/ops/compliance-page.tsx";

const ops = await read(OPS_CSS);
const resp = await read(RESP_CSS);

/** One rule's declarations, by selector, so a pin cannot match across rules. */
function block(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} is still a top-level rule`);
  const start = css.indexOf("{", at);
  const end = css.indexOf("}", start);
  assert.ok(end > start, `${selector} is a closed rule`);
  return css.slice(start + 1, end);
}

/* ── The card ─────────────────────────────────────────────────────────────── */

test("a group card is positioned, rounded, and still never clips its sticky header", () => {
  const group = block(ops, ".ops-group");
  assert.match(group, /position: relative;/, "the edge is placed against the card");
  assert.match(group, /border-radius: 12px;/);
  assert.doesNotMatch(
    group,
    /overflow:\s*(hidden|clip|auto|scroll)/,
    "`overflow` on the group makes it the scroll container for its own sticky header, which then stops sticking",
  );
});

test("the group is isolated, so the edge's z-index means nothing outside the card", () => {
  const group = block(ops, ".ops-group");
  assert.match(
    group,
    /isolation: isolate;/,
    "without a stacking context the edge's z-index 3 would also cross the responsibility queue's sticky bulk bar (z-index 2)",
  );
  /* The number the edge has to beat, and the reason it needs one at all. */
  const head = block(ops, ".ops-group__head");
  assert.match(head, /position: sticky;/);
  assert.match(head, /z-index: 2;/);
});

test("the edge is clipped to the card's own outline, not a strip with its own corners", () => {
  const edge = block(ops, ".ops-group::before");
  assert.match(edge, /inset: -1px;/, "the pseudo-element covers the BORDER box: -1px out from the padding box it is placed against");
  assert.match(edge, /border-radius: inherit;/, "so its outline is the card's, at any radius");
  assert.match(
    edge,
    /box-shadow: inset 3px 0 0 var\(--ops-edge, var\(--accent-fg\)\);/,
    "an inset shadow is clipped to that outline; a background on a 3px box was not",
  );
  assert.match(edge, /pointer-events: none;/, "the header underneath stays clickable through the edge");
  assert.match(edge, /z-index: 3;/, "over the sticky header, so the edge is one continuous line");
  assert.doesNotMatch(edge, /width:/, "the edge has no width of its own any more — the shadow's offset is its width");
  assert.doesNotMatch(edge, /background/, "and no background to paint past the corners");
});

test("a row's edge is the same geometry, and is deliberately not isolated", () => {
  const edge = block(ops, ".ops-row::before");
  assert.match(edge, /inset: -1px;/);
  assert.match(edge, /border-radius: inherit;/);
  assert.match(edge, /box-shadow: inset 3px 0 0 var\(--ops-edge, var\(--line\)\);/);
  assert.match(edge, /pointer-events: none;/);
  assert.doesNotMatch(edge, /width:/);

  const row = block(ops, ".ops-row");
  assert.match(row, /position: relative;/);
  assert.doesNotMatch(
    row,
    /isolation/,
    "a row's actions menu (.ops-menu__list, z-index 30) opens over the rows below it; isolating the row would trap it",
  );
  const menu = block(ops, ".ops-menu__list");
  assert.match(menu, /z-index: 30;/, "the number that has to escape the row");
});

test("no rule anywhere re-introduces a narrow strip carrying its own corner radius", () => {
  /*
   * The defect's exact shape. Any pseudo-element narrower than the radius it
   * declares will be scaled down by the engine and drawn against a curve it
   * does not match, which is the whole fault — so this looks for the pairing
   * rather than for the old declarations.
   */
  for (const [selector, body] of ops.matchAll(/\n([^{}\n][^{}]*)\{([^}]*)\}/g)) {
    const width = /\bwidth:\s*([0-9.]+)px/.exec(body);
    const radius = /border(-top-left|-bottom-left|-top-right|-bottom-right)?-radius:\s*([0-9.]+)px/.exec(body);
    if (!width || !radius) continue;
    assert.ok(
      Number(width[1]) >= Number(radius[2]),
      `${selector.trim()} declares width ${width[1]}px with a ${radius[2]}px corner: the radius will be scaled down and the box will not follow the card it sits on`,
    );
  }
});

/* ── The line that sat on the edge ────────────────────────────────────────── */

test("the coverage sentence is indented like the header above it, not laid on the edge", () => {
  const coverage = block(resp, ".resp-group__coverage");
  const padding = /padding:\s*([^;]+);/.exec(coverage);
  assert.ok(padding, ".resp-group__coverage still declares its padding");
  const [top, right, bottom, left] = padding[1].trim().split(/\s+/);
  assert.equal(top, "0", "the header above it provides the space over the line");
  assert.ok(bottom, "the line keeps its space off the card's bottom edge");

  const head = /padding:\s*([^;]+);/.exec(block(ops, ".ops-group__head"));
  assert.ok(head, ".ops-group__head still declares its padding");
  const headParts = head[1].trim().split(/\s+/);
  assert.equal(left, headParts[3], "the sentence starts where the store name starts");
  assert.equal(right, headParts[1], "and ends where the header ends");
  assert.notEqual(left, "0", "zero is what put the line on top of the tinted edge");
});

/* ── Colour is never the only carrier ─────────────────────────────────────── */

test("the card says its state in words as well as in the edge's colour", async () => {
  const page = await read(PAGE);
  assert.match(page, /\["--ops-edge" as string\]: tone/, "the edge is the completion band, set from the data");
  assert.match(
    page,
    /completionBand\(group\.completion\.percent\)/,
    "and the band is the shared one, so a store that is amber here is amber on Sites",
  );
  assert.match(
    page,
    /`\$\{group\.completion\.percent\}% complete`/,
    "the same fact in words: a reader who cannot see the colour still reads the percentage",
  );
  assert.match(page, /group\.coverage\.label/, "and an unscored store says why it has no percentage");

  /*
   * The BAND'S NAME, not just its colour. "Largely outstanding" is the only
   * thing the red edge says that the percentage does not, so it is spoken
   * rather than left to the eye. Pinned as a contract — a visually hidden
   * element carrying `band.label` — rather than as one spelling of it.
   */
  const spoken = page.split("\n").find((line) => line.includes("band.label"));
  assert.ok(
    spoken && /visually-hidden/.test(spoken),
    "the completion band's name is on the card for assistive tech, not carried by the edge's colour alone",
  );
});
