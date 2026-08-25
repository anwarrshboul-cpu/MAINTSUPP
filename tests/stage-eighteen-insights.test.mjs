import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("insight panels use the site's own palette", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  // The brand hues, unchanged — this is the palette of the whole site.
  for (const hex of ["#12b4a8", "#f0a91f", "#e2445c", "#3899e8"]) {
    assert.ok(source.includes(hex), `${hex} must come from the site palette`);
  }
  // No invented colours: every hex must be a brand hue or a step of the one
  // validated teal ramp.
  const allowed = new Set([
    "#12b4a8", "#f0a91f", "#e2445c", "#3899e8", "#5c82af", "#6f8793",
    "#8fe3dc", "#4fcfc4", "#0a7d74", "#ffffff",
  ]);
  for (const [, hex] of source.matchAll(/(#[0-9a-f]{6})/gi)) {
    assert.ok(allowed.has(hex.toLowerCase()), `${hex} is not in the site palette`);
  }
});

test("ordered data uses one hue, not assorted brand colours", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  // Age buckets and the spend matrix are ordered, so the reader should see the
  // order in the colour. The ramp is monotone light→dark in a single hue and
  // passes the ordinal checks on the dark surface.
  assert.match(source, /TEAL_RAMP = \["#8fe3dc", "#4fcfc4", "#12b4a8", "#0a7d74"\]/);
  assert.match(source, /background: TEAL_RAMP\[index\]/, "age buckets take the ramp");
  assert.match(source, /return TEAL_RAMP\[3\]/, "the matrix takes the ramp");
});

test("the low-chroma grey never identifies a series", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  // #6f8793 measures 0.033 chroma — it reads as grey and cannot do identity work.
  assert.match(source, /De-emphasis only/);
  const uses = [...source.matchAll(/MUTED/g)].length;
  assert.ok(uses <= 3, "MUTED should appear as a declaration and a de-emphasis fill only");
});

test("no chart relies on colour alone", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  // Two-series charts carry a legend; every bar and cell carries its value.
  assert.match(source, /insight-note/, "two-series charts must carry a legend");
  assert.match(source, /Reactive<\/p>|>\s*Reactive/, "series must be named, not just coloured");
  assert.match(source, /insight-columns__value/, "columns must carry their value");
});

test("every panel has an empty state, and it tells the truth", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  const panels = [...source.matchAll(/export function (\w+)\(/g)]
    .map((match) => match[1])
    .filter((name) => name !== "InsightPanel" && name !== "classifySpend");
  const empties = [...source.matchAll(/empty=\{\{/g)].length;
  assert.equal(
    empties,
    panels.length,
    `each of the ${panels.length} panels needs an empty state; found ${empties}`,
  );

  // "Everything is closed" and "there are no jobs" are different situations. One
  // message for both congratulates an empty account on its throughput.
  assert.match(source, /const noJobsAtAll = requests\.length === 0;/);
  assert.match(source, /stores\.length \? "Nothing outstanding" : "No sites yet"/);
});

test("the spend split is classified in exactly one place", async () => {
  // The Reports page shows the same split twice — four tiles and a six-month
  // trend. Two copies of the rule would drift and the page would contradict
  // itself.
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(insights, /export function classifySpend/);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /classifySpend\(request\)/);
  assert.ok(
    !/category\.toLowerCase\(\)\.includes\("compliance"\) \|\| request\.tier >= 4\) planned/.test(
      portal,
    ),
    "the page must not keep its own copy of the rule",
  );
});

test("SLA is judged against the target that applied at the time", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  const fn = source.slice(source.indexOf("export function SlaPerformance"));
  // Recomputing from today's settings would silently re-judge historic work
  // every time someone edits a target.
  assert.match(fn.slice(0, 2600), /if \(!request\.dueAt \|\| !request\.completedAt\) continue;/);
  /*
   * "Closed" is the canonical partition (audit S2), the same predicate as the
   * Completed tile and the board meters — a monday-imported "Job Completed"
   * row carries no completion date, and judging closed-ness by the date had
   * this card and the tile above it disagreeing on the same page. Open work is
   * still not a miss: `measured` requires both stamps, so an undated closure
   * is neither met nor missed.
   */
  assert.match(fn.slice(0, 2600), /requests\.filter\(isClosedRequest\)/);
});

test("panels take the clock as a prop rather than reading it in render", async () => {
  const source = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.ok(
    !/=\s*Date\.now\(\)/.test(source) && !/new Date\(\)/.test(source),
    "reading the clock during render is impure and makes results unstable",
  );
  assert.match(source, /now: number;/);
});

test("a wide panel cannot force the page to scroll sideways", async () => {
  const css = await read("app/brand-overrides.css");
  const panel = css.slice(css.indexOf(".insight-panel {"));
  // A grid item's default `min-width: auto` refuses to shrink below its content.
  assert.match(panel.slice(0, 700), /min-width: 0;/);
  assert.match(css, /\.insight-table-wrap \{[\s\S]{0,140}overflow-x: auto/);
});

test("the KPI strip is sized against its container, not the viewport", async () => {
  const css = await read("app/brand-overrides.css");
  // `calc(100vw - 56px)` ignored the page's own padding, so the strip was ~3px
  // wider than the space it sits in and the page scrolled at 390px.
  assert.ok(
    !/grid-auto-columns: calc\(100vw - 56px\)/.test(css),
    "the viewport-based card width must be gone",
  );
});
