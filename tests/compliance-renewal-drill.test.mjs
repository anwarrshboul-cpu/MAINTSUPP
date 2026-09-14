/**
 * A RENEWAL SLICE OPENS EXACTLY THE REQUIREMENTS IT COUNTED.
 *
 * The "Who's renewing" donut groups a renewal two different ways: by the
 * CONTRACTOR RECORD when one is linked, and by the normalised responsibility
 * TEXT when none is. Four of its slices could be drilled with the dimensions
 * that already existed — `contractor=<id>`, or `who=<text>&contractor=__none__`.
 * The fifth could not.
 *
 * "Other" is the folded tail, and a mixed tail is an OR ACROSS those two
 * dimensions: "these three contractors, or these two roles". Every dimension in
 * this filter is OR-within and AND-across, so the tail had to go out as
 * `contractor: [...ids, "__none__"]` — and `__none__` matches EVERY unlinked
 * renewal in scope, not the tail's two. On a register whose top five already
 * held forty unlinked renewals, a slice reading "Other 5" opened forty-six
 * rows: the list wider than the figure, which is the one contract this whole
 * block is built on.
 *
 * The fix is a dimension of the donut's own grouping key (`renewal=`), and the
 * register recomputes that key per row with `renewalGroupKey` — the same
 * function the donut grouped by, so the two cannot disagree. This suite holds
 * the arithmetic, and holds that the old lossy filter has not come back.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const ts = (await import("typescript")).default;

const VIEW = "app/lib/compliance-view.ts";
const DASH = "app/lib/compliance-dash.ts";
const viewSource = await read(VIEW);
const dashSource = await read(DASH);

/** `renewalGroupKey` on its own — the module reaches the database, this does not. */
const { renewalGroupKey } = await (async () => {
  const from = viewSource.indexOf("/** Trim, lower-case, collapse whitespace");
  assert.ok(from > 0, "the shared label normalisation is still declared here");
  const anchor = viewSource.indexOf("return raw ?", from);
  assert.ok(anchor > from, "renewalGroupKey still ends with the text-or-empty return");
  const close = viewSource.indexOf("\n}", anchor);
  assert.ok(close > anchor, "the function still closes");
  const output = ts.transpileModule(viewSource.slice(from, close + 2), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
})();

/* ── The key ──────────────────────────────────────────────────────────────── */

test("a linked renewal is keyed by the contractor record, not by its name", () => {
  assert.equal(
    renewalGroupKey({ providerContractorId: "c-1", responsibility: "Fire safety partner" }),
    "contractor:c-1",
  );
  /* Two contractors sharing a name stay two slices, and a rename keeps its own. */
  assert.notEqual(
    renewalGroupKey({ providerContractorId: "c-1", responsibility: "X" }),
    renewalGroupKey({ providerContractorId: "c-2", responsibility: "X" }),
  );
});

test("an unlinked renewal is keyed by its normalised responsibility", () => {
  const expected = "text:fire safety partner";
  for (const spelling of ["Fire safety partner", "  fire   Safety  Partner ", "FIRE SAFETY PARTNER"]) {
    assert.equal(renewalGroupKey({ providerContractorId: null, responsibility: spelling }), expected);
  }
});

test("a requirement with neither is the Unassigned slice, and gets no group key", () => {
  /* An empty key is one no group is ever built with, so a group filter can
     never sweep an unassigned requirement up. That is what keeps "Other"
     honest at the bottom of the donut as well as the top. */
  for (const row of [
    { providerContractorId: null, responsibility: "" },
    { providerContractorId: null, responsibility: "   " },
    { providerContractorId: undefined, responsibility: "" },
  ]) {
    assert.equal(renewalGroupKey(row), "");
  }
});

/* ── The arithmetic the defect was about ──────────────────────────────────── */

/** The matcher's rule for this dimension, as `filterComplianceRows` applies it. */
const matches = (keys, row) => keys.length === 0 || keys.includes(renewalGroupKey(row));

test("a mixed Other tail opens exactly the requirements it counted", () => {
  /*
   * The measured shape of the defect: a tail of five — three linked
   * contractors and two unlinked roles — sitting beside forty unlinked
   * renewals that belong to the top five slices, plus one requirement nobody
   * is chasing at all.
   */
  const rows = [
    ...Array.from({ length: 40 }, () => ({ providerContractorId: null, responsibility: "Fire safety partner" })),
    ...Array.from({ length: 3 }, (_, index) => ({ providerContractorId: `c-tail-${index}`, responsibility: "Anything" })),
    ...Array.from({ length: 2 }, () => ({ providerContractorId: null, responsibility: "Site manager" })),
    { providerContractorId: null, responsibility: "" },
  ];
  const tailKeys = ["contractor:c-tail-0", "contractor:c-tail-1", "contractor:c-tail-2", "text:site manager"];

  const opened = rows.filter((row) => matches(tailKeys, row));
  assert.equal(opened.length, 5, "the slice says 5, so the register opens 5");
  assert.ok(!opened.some((row) => !row.responsibility), "the unassigned requirement is not swept up");
  assert.ok(
    !opened.some((row) => row.responsibility === "Fire safety partner"),
    "and neither are the forty unlinked renewals that belong to another slice",
  );

  /* The old filter, restated, so the size of what this fixes stays legible. */
  const oldProviders = new Set(["c-tail-0", "c-tail-1", "c-tail-2", "__none__"]);
  const oldOpened = rows.filter(
    (row) =>
      (row.providerContractorId && oldProviders.has(row.providerContractorId)) ||
      (oldProviders.has("__none__") && !row.providerContractorId),
  );
  assert.equal(oldOpened.length, 46, "the case is real: the old filter opened the whole unlinked population");
});

test("a tail that is all linked, or all unlinked, is exact too", () => {
  const rows = [
    { providerContractorId: "c-a", responsibility: "" },
    { providerContractorId: "c-b", responsibility: "" },
    { providerContractorId: null, responsibility: "Landlord" },
    { providerContractorId: null, responsibility: "Landlord" },
    { providerContractorId: null, responsibility: "Centre team" },
  ];
  assert.equal(rows.filter((row) => matches(["contractor:c-a", "contractor:c-b"], row)).length, 2);
  assert.equal(rows.filter((row) => matches(["text:landlord"], row)).length, 2);
  assert.equal(rows.filter((row) => matches(["text:centre team"], row)).length, 1);
});

test("no keys is no narrowing — the dimension is absent, not empty", () => {
  const rows = [
    { providerContractorId: "c-a", responsibility: "" },
    { providerContractorId: null, responsibility: "Landlord" },
  ];
  assert.equal(rows.filter((row) => matches([], row)).length, 2);
});

/* ── The wiring, pinned by source ─────────────────────────────────────────── */

test("every slice drills by the key it was grouped by", () => {
  assert.match(
    dashSource,
    /const sliceFilter = \(key: string\) => \(\{ \.\.\.renewalState, renewal: \[key\] \}\);/,
    "a named slice sends its own group key",
  );
  assert.match(
    dashSource,
    /filter: \{ \.\.\.renewalState, renewal: tail\.map\(\(\[key\]\) => key\) \}/,
    "and the folded tail sends every key it folded",
  );
});

test("the lossy filter has not come back", () => {
  /*
   * The exact shape of the defect: the contractor dimension carrying the
   * "none linked" token alongside real ids. That token on its own is still
   * correct — the "Unassigned" slice uses it, and it means what it says there.
   */
  assert.doesNotMatch(
    dashSource,
    /contractor: \[\.\.\.contractorIds, NO_PROVIDER\]/,
    "a tail drilled through the contractor dimension matches every unlinked renewal in scope",
  );
  assert.match(
    dashSource,
    /filter: \{ \.\.\.renewalState, who: \[NO_RESPONSIBILITY\], contractor: \[NO_PROVIDER\] \}/,
    "the Unassigned slice still says exactly that, and is still a legitimate use of the token",
  );
});

test("the register parses the dimension and applies it beside the others", () => {
  assert.match(viewSource, /renewalGroups: list\(params, "renewal"\)/, "`?renewal=` is parsed");
  assert.match(viewSource, /const renewalGroups = new Set\(filters\.renewalGroups \?\? \[\]\);/);
  assert.match(
    viewSource,
    /if \(renewalGroups\.size && !renewalGroups\.has\(renewalGroupKey\(row\)\)\) return false;/,
    "and applied with the same key builder the donut groups by",
  );
  assert.match(viewSource, /renewalGroups\?: string\[\];/, "the filter type carries it");
});

test("the chip row and the register's key list both know the dimension", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  const dash = await read("app/(app)/portal/ops/cp-dash.tsx");
  assert.match(page, /"renewal",\n\] as const;/, "FILTER_KEYS clears it with the rest");
  assert.match(page, /const renewalKeys = params\.getAll\("renewal"\);/, "and it is shown as a chip");
  assert.match(page, /key: "renewal",/);
  assert.match(
    dash,
    /"contractor", "renewal"\] as const;/,
    "a portfolio change drops it like every other register narrowing",
  );
});
