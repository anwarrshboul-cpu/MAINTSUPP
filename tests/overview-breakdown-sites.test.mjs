/**
 * SECTIONS D AND E — Job breakdown, and Sites needing attention.
 *
 * Both cards exist because the ones they replace were wrong in ways a reader
 * could see: a donut whose centre disagreed with its own caption, a "+8 more"
 * that read as truncation, a row of unlabelled dots, and a site list whose
 * second entry was a broken foreign key. Each of those is a CONTRACT now, and
 * a contract nobody asserts is a preference somebody will refactor away.
 *
 * TWO KINDS OF TEST, following `tests/overview-components.test.mjs`:
 *
 *   • BEHAVIOURAL — the derivations §5.3 and §6 ask for are pure functions, so
 *     they are sliced out of the shipped `.tsx` by name, stripped of their
 *     types by the compiler the repo already carries, and called. The slice is
 *     real shipped source; a re-implementation could agree with itself while
 *     the product is wrong.
 *
 *   • STRUCTURAL — "the Status block is gone" and "Unassigned is not a row" are
 *     statements about what is NOT rendered, and without a DOM the only way to
 *     hold them is to read the source. When a refactor invalidates one,
 *     RE-POINT it at the contract's new home with the reason written in —
 *     never delete it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/*
 * NORMALISED, BECAUSE THIS IS A WINDOWS CHECKOUT AND LINE ENDINGS ARE PER FILE.
 * `slice` below looks for the literal "\n}\n" to find where a function ends,
 * which a CRLF file does not contain.
 */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the rules they explain; every source check strips them. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BREAKDOWN = "app/(app)/portal/ops/overview-breakdown.tsx";
const SITES = "app/(app)/portal/ops/overview-sites.tsx";
const STYLES = "app/(app)/portal/ops/overview-portfolio.css";
const SHARED = "app/(app)/portal/ops/overview-shared.tsx";

const breakdownSource = await read(BREAKDOWN);
const sitesSource = await read(SITES);
const stylesSource = await read(STYLES);
const sharedSource = await read(SHARED);
const metersSource = await read("app/lib/overview-meters.ts");

const breakdownCode = codeOnly(breakdownSource);
const sitesCode = codeOnly(sitesSource);

/* ── The harness: pure helpers, out of a .tsx, without React ──────────────── */

const ts = (await import("typescript")).default;

/** One function, sliced out by its braces. Exported or not. */
function slice(source, name) {
  const exported = source.indexOf(`export function ${name}(`);
  const at = exported >= 0 ? exported : source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} has moved or is no longer a function declaration; fix this test`);
  const end = source.indexOf("\n}\n", at);
  assert.ok(end > 0, `${name} must end with a brace at column zero`);
  return source.slice(at, end + 2).replace(/^export /, "");
}

const strip = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/*
 * `TIER_SCALE` is READ OUT OF THE SOURCE rather than restated here. It is the
 * whole subject of "all four tiers render, including the empty ones", so a copy
 * in the test would pass happily on the day somebody shortened the real one.
 */
const tierScaleLiteral = /const TIER_SCALE = (\[[^\]]*\]) as const;/.exec(breakdownSource);
assert.ok(tierScaleLiteral, "TIER_SCALE has moved; fix this test rather than deleting it");

/*
 * The colour constants are STUBS, and deliberately: what these functions have
 * to get right is WHICH ramp entry they reach for, not what hex it holds today.
 * The hexes are pinned once, against `ops-tokens.css`, in
 * `tests/overview-foundations.test.mjs`; duplicating them here would give this
 * file a second opinion about the palette. The structural tests below assert
 * that the two modules import these names from `overview-meters.ts`.
 */
const helpers = new Function(
  `const TIER_SCALE = ${tierScaleLiteral[1]};
   const NOT_RECORDED_INK = "grey";
   const SEVERITY_COLOUR = { fresh: "fresh", ageing: "ageing", overdue: "overdue", critical: "critical" };
   const tealScale = (rank) => "teal-" + Math.min(Math.max(rank, 0), 6);
   ${strip(
     [
       slice(metersSource, "sharesOfRecorded"),
       slice(breakdownSource, "withFullTierScale"),
       slice(breakdownSource, "tierUnderuseWarning"),
       slice(breakdownSource, "taxonomyWarning"),
       slice(breakdownSource, "priorityLine"),
       slice(sitesSource, "attentionHeadline"),
       slice(sitesSource, "portfolioSubtitle"),
       slice(sitesSource, "intakeNotice"),
       slice(sitesSource, "complianceReadout"),
     ].join("\n\n"),
   )}
   return { withFullTierScale, tierUnderuseWarning, taxonomyWarning, priorityLine,
            attentionHeadline, portfolioSubtitle, intakeNotice, complianceReadout };`,
)();

const bucket = (key, value, extra = {}) => ({
  key,
  label: `Tier ${key}`,
  value,
  share: 0,
  colour: `payload-${key}`,
  notRecorded: false,
  ...extra,
});

/* ── 1. The card API the page is coding against ───────────────────────────── */

test("both cards are exported with the agreed names", async () => {
  assert.match(
    breakdownSource,
    /export function JobBreakdownCard\(/,
    "overview-page.tsx calls JobBreakdownCard by name",
  );
  assert.match(
    sitesSource,
    /export function SitesAttentionCard\(/,
    "overview-page.tsx calls SitesAttentionCard by name",
  );
});

test("each card still takes the props it was agreed with", async () => {
  const props = (source, component, names) => {
    const at = source.indexOf(`export function ${component}(`);
    const body = source.slice(at, source.indexOf("\n}", at));
    for (const name of names) {
      assert.match(
        body,
        new RegExp(`(^|[\\s{,])${name}[,?:\\s}]`, "m"),
        `${component} must still accept "${name}"`,
      );
    }
  };
  props(breakdownSource, "JobBreakdownCard", [
    "state",
    "measure",
    "filterChips",
    "splitByPriority",
    "onToggleSplit",
    "onToggle",
    "onDrill",
    "onOpenRecords",
  ]);
  props(sitesSource, "SitesAttentionCard", [
    "state",
    "measure",
    "filterChips",
    "onToggle",
    "onDrill",
    "onOpenRecords",
    "onOpenBulkAssign",
    "onNavigateToSites",
    "onNavigateToCompliance",
  ]);
});

/* ── 2. §5.2 and gate 26 — the Status block is gone ───────────────────────── */

test("the Job breakdown card no longer draws a Status block", async () => {
  /*
   * §5.2 deletes the three-way Completed / In progress / Needs attention
   * summary and the per-status bar list outright: "two different groupings of
   * one field on one page is a contradiction a client will notice". At a
   * glance's meters own status now, with a mapping the reader controls.
   */
  assert.doesNotMatch(
    breakdownCode,
    /dimensions\.status/,
    "the status dimension is not read by this card any more — §5.2",
  );
  assert.doesNotMatch(
    breakdownCode,
    /FAMILY_COLOUR|FAMILY_LABEL|JobStatusFamily/,
    "the status-family palette belongs to the Jobs board, not to this card",
  );
  assert.doesNotMatch(
    breakdownCode,
    /title: "Status"|shape: "status"/,
    "there is no Status section in the four dimensions",
  );
});

test("the status detail is still reachable — View all statuses", async () => {
  assert.match(
    breakdownCode,
    /View all statuses/,
    "§5.2 moves the per-status detail behind this action; it may not simply vanish",
  );
  assert.match(
    breakdownCode,
    /onDrill\(\{ group: "status" \}\)/,
    "the same parameter At a glance uses, so the two groupings cannot drift apart",
  );
});

/* ── 3. §5.3 — the four dimensions, in order, all splittable ──────────────── */

test("the four dimensions render in the order §5.3 sets", async () => {
  const order = ["tier", "engineer", "priority", "label"].map((key) => {
    const at = breakdownCode.indexOf(`onToggle("${key}"`);
    assert.ok(at > 0, `the ${key} dimension must cross-filter on its own key`);
    return at;
  });
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(
      order[index] > order[index - 1],
      "Tier level · Engineer required · Priority · Label, in that order — §5.3",
    );
  }
});

test("every dimension carries the Split by priority toggle", async () => {
  const toggles = breakdownCode.match(/onToggleSplit=\{onToggleSplit\}/g) ?? [];
  assert.equal(
    toggles.length,
    4,
    "§5.3 puts the toggle on all four dimensions and gate 30 checks all four",
  );
});

test("a split view becomes ranked bars, because a ring cannot stack", async () => {
  assert.match(
    breakdownCode,
    /const shape = splitByPriority \? \("bars" as const\) : \("donut" as const\)/,
    "gate 30 needs the stacks visible on every breakdown; a donut has nowhere to put them",
  );
  assert.match(
    sharedSource,
    /byPriority: bucket\.byPriority/,
    "the stacks come from the payload's own byPriority, which sums to each bucket's value",
  );
});

/* ── 4. §5.3 — the full tier scale, zeros included ────────────────────────── */

test("withFullTierScale renders all four tiers, including the empty ones", async () => {
  const dimension = {
    key: "tier",
    label: "Tier level",
    recorded: 87,
    total: 101,
    buckets: [
      bucket("3", 63),
      bucket("2", 24),
      { key: "__not_recorded__", label: "Not recorded", value: 14, share: 0, colour: "grey", notRecorded: true },
    ],
    note: "",
    warning: null,
  };
  const full = helpers.withFullTierScale(dimension);
  assert.deepEqual(
    full.buckets.map((entry) => entry.key),
    ["1", "2", "3", "4", "__not_recorded__"],
    "the 1–4 scale is drawn in scale order, with the grey bucket last",
  );
  assert.deepEqual(
    full.buckets.map((entry) => entry.value),
    [0, 24, 63, 0, 14],
    "a tier nobody uses appears AT ZERO — §5.3: the absence has to be visible",
  );
  assert.equal(full.buckets[0].label, "Tier 1");
  assert.equal(full.buckets[0].notRecorded, false, "an empty tier is a recorded category, not a blank");
  assert.equal(full.recorded, 87, "completing the scale never moves the denominator");
});

test("a synthesised tier never borrows a colour a real tier is already using", async () => {
  const dimension = {
    key: "tier",
    label: "Tier level",
    recorded: 10,
    total: 10,
    buckets: [
      { ...bucket("2", 10), colour: "teal-6" },
    ],
    note: "",
    warning: null,
  };
  const full = helpers.withFullTierScale(dimension);
  const colours = full.buckets.map((entry) => entry.colour);
  assert.equal(new Set(colours).size, colours.length, "two swatches the same read as one tier repeated");
});

test("a tier id nobody planned for survives the scale completion", async () => {
  /* §9.9 — a tier added later must appear with no code change. */
  const dimension = {
    key: "tier",
    label: "Tier level",
    recorded: 5,
    total: 5,
    buckets: [bucket("5", 5)],
    note: "",
    warning: null,
  };
  const full = helpers.withFullTierScale(dimension);
  assert.ok(
    full.buckets.some((entry) => entry.key === "5" && entry.value === 5),
    "an unknown tier is kept, never dropped",
  );
  assert.equal(full.buckets.length, 5, "the four of the scale, plus the one that arrived");
});

test("the tier underuse notice fires at 90% and states both numbers", async () => {
  const at100 = {
    label: "Tier level",
    recorded: 195,
    total: 195,
    buckets: [{ ...bucket("2", 195), label: "Tier 2" }],
    note: "",
    warning: null,
  };
  assert.equal(
    helpers.tierUnderuseWarning(at100),
    "195 of 195 recorded jobs are Tier 2. Tier is not currently differentiating work — " +
      "set tiers on new jobs to make this breakdown useful.",
    "§5.3's sentence, with both numbers computed and neither hard-coded",
  );

  const spread = {
    label: "Tier level",
    recorded: 101,
    total: 101,
    buckets: [
      { ...bucket("3", 63), label: "Tier 3" },
      { ...bucket("2", 38), label: "Tier 2" },
    ],
    note: "",
    warning: null,
  };
  assert.equal(helpers.tierUnderuseWarning(spread), null, "62% is a distribution, not a failure to use tiers");

  assert.equal(
    helpers.tierUnderuseWarning({ ...at100, warning: "the aggregate said this" }),
    "the aggregate said this",
    "the payload's own sentence wins; this derivation is the fallback",
  );
});

/* ── 5. §5.3 — the label list, and the taxonomy warning ───────────────────── */

test("the label list expands in place — Show all, never +N more", async () => {
  assert.doesNotMatch(
    breakdownCode,
    /\+\{[^}]*\}\s*more/,
    '§5.3 replaces "+8 more" because it reads as truncation rather than as a control',
  );
  assert.match(
    sharedSource,
    /Show all \{recordedBuckets\.length\} →/,
    "the control lives in BreakdownSection and expands in place",
  );
  assert.match(
    breakdownCode,
    /initialLimit=\{8\}/,
    "top eight, then the control — §5.3",
  );
});

test("the taxonomy warning fires above 25% and links to the Other jobs", async () => {
  const dimension = {
    label: "Label",
    recorded: 81,
    total: 101,
    buckets: [
      { key: "Other", label: "Other", value: 61, share: 0, colour: "teal-0", notRecorded: false },
      { key: "Electrical", label: "Electrical", value: 20, share: 0, colour: "teal-1", notRecorded: false },
    ],
    note: "",
    warning: null,
  };
  const warning = helpers.taxonomyWarning(dimension);
  assert.match(warning, /^61 jobs are labelled Other and 20 have no label — 80% of this period's work is not classified\./);
  assert.match(warning, /Consider adding labels for the recurring faults inside Other\.$/);

  const healthy = {
    ...dimension,
    recorded: 100,
    total: 101,
    buckets: [
      { key: "Other", label: "Other", value: 5, share: 0, colour: "teal-0", notRecorded: false },
      { key: "Electrical", label: "Electrical", value: 95, share: 0, colour: "teal-1", notRecorded: false },
    ],
  };
  assert.equal(helpers.taxonomyWarning(healthy), null, "6% classified as Other is a taxonomy that works");

  assert.match(
    breakdownCode,
    /onDrill\(\{ label: otherKey \}\)/,
    "§5.3 — the warning links to the Other jobs so new labels can be created from the pattern",
  );
});

test("the priority line never invents the previous-period comparison", async () => {
  assert.equal(
    helpers.priorityLine({
      label: "Priority",
      recorded: 101,
      total: 101,
      buckets: [
        { key: "urgent", label: "Urgent", value: 38, share: 0, colour: "urgent", notRecorded: false },
        { key: "medium", label: "Medium", value: 63, share: 0, colour: "medium", notRecorded: false },
      ],
      note: "",
      warning: null,
    }),
    "Urgent is 38% of recorded work this period.",
    "the share is derived; the delta is not, because nothing on the wire carries it — §1.5",
  );
  assert.equal(
    helpers.priorityLine({
      label: "Priority",
      recorded: 1,
      total: 1,
      buckets: [],
      note: "Urgent is 38% of recorded work this period — 12 points above the previous period.",
      warning: null,
    }),
    "Urgent is 38% of recorded work this period — 12 points above the previous period.",
    "when the aggregate can make the comparison, its sentence is the one that prints",
  );
});

/* ── 6. §7 defect 3 and gate 28 — the donut centre ────────────────────────── */

test("the Engineer donut takes its centre from BreakdownSection, and that is the recorded count", async () => {
  /*
   * The defect: the centre read 226 while the caption beneath it read "193 of
   * 226 recorded". The fix is structural — this card cannot choose the centre,
   * because it does not draw the ring.
   */
  assert.doesNotMatch(
    breakdownCode,
    /<Donut|<RankedBars/,
    "every breakdown goes through BreakdownSection; a hand-rolled ring is how the centre drifted",
  );
  assert.match(
    sharedSource,
    /centreValue=\{dimension\.recorded\}/,
    "gate 28 — the centre is the RECORDED count, decided in one place",
  );
  assert.match(sharedSource, /centreLabel="recorded"/, "and it says so beside the figure");
  assert.match(
    breakdownCode,
    /dimension=\{engineer\}/,
    "the engineer dimension is handed over whole rather than re-derived",
  );
});

/* ── 7. §5.3 — priority is a segmented bar on the severity ramp ───────────── */

test("priority draws the shared segmented bar on the severity ramp", async () => {
  assert.match(breakdownCode, /<SegmentedBar/, "§5.3 names a segmented bar for priority");
  assert.match(
    breakdownCode,
    /OVERVIEW_PRIORITY_COLOUR\[bucket\.key\]/,
    "the ramp comes from overview-meters.ts, joined on the bucket key",
  );
  assert.match(
    breakdownCode,
    /from "\.\.\/\.\.\/\.\.\/lib\/overview-meters"/,
    "colours come from the Overview's own vocabulary, never from job-metrics.ts",
  );
});

/* ── 8. §6.1 and gate 31 — real sites only ────────────────────────────────── */

test("Unassigned site is not a row on the Sites card", async () => {
  /*
   * §6.1: "It is a broken foreign key, not a location, and ranking it against
   * real stores distorts the card." It moved to data quality, where it can be
   * repaired rather than ranked.
   */
  assert.doesNotMatch(
    sitesCode,
    /UNASSIGNED_SITE_ID|unassigned/i,
    "no unassigned bucket is drawn as a site — gate 31",
  );
  assert.match(
    sitesCode,
    /jobsWithNoSite/,
    "the jobs with no site are counted in the data-quality row instead",
  );
  assert.match(
    sitesCode,
    /jobs point at no site in the register/,
    "§6.4's sentence, beside a count and an action",
  );
  assert.match(
    sitesCode,
    /actionLabel: "Fix these →",\s*onAction: onOpenBulkAssign/,
    "gate 33 — Fix these opens the bulk assign, which repairs several in one pass",
  );
});

test("the header counts real sites and gives the portfolio context", async () => {
  assert.equal(helpers.attentionHeadline(57, 1), "57 open jobs across 1 site");
  assert.equal(helpers.attentionHeadline(1, 2), "1 open job across 2 sites");
  assert.equal(helpers.portfolioSubtitle(1, 10), "1 of 10 sites has open work.");
  assert.equal(helpers.portfolioSubtitle(3, 10), "3 of 10 sites have open work.");
  assert.equal(
    helpers.portfolioSubtitle(0, 0),
    "No sites are recorded in this workspace yet.",
    "§1.5 — an empty register is not the same statement as zero sites with work",
  );
});

/* ── 9. §6.2 — the age of open work, and the intake warning ───────────────── */

test("the intake warning fires only when nothing open is under 30 days old", async () => {
  const sentence =
    "No open job in this portfolio is under 30 days old. Either no new work has been logged " +
    "recently, or request dates are missing — check intake.";
  assert.equal(
    helpers.intakeNotice({ fresh: 0, ageing: 0, overdue: 7, critical: 2 }, null),
    sentence,
    "§6.2 — two silent zeros in a legend is not a way to report this",
  );
  assert.equal(
    helpers.intakeNotice({ fresh: 9, ageing: 0, overdue: 7, critical: 2 }, null),
    null,
    "fresh work exists, so intake is not the story",
  );
  assert.equal(
    helpers.intakeNotice({ fresh: 0, ageing: 0, overdue: 0, critical: 0 }, null),
    null,
    "no open work at all is not an intake failure",
  );
  assert.equal(
    helpers.intakeNotice({ fresh: 0, ageing: 0, overdue: 1, critical: 0 }, "the aggregate said this"),
    "the aggregate said this",
    "the payload's own sentence wins",
  );
});

test("the ageing bar carries its numbers and a key that names the bands", async () => {
  const showNumbers = sitesCode.match(/showNumbers/g) ?? [];
  assert.ok(
    showNumbers.length >= 2,
    "§6.3 — numbers on the segments, on the portfolio bar and on every site row",
  );
  assert.match(
    sitesCode,
    /SEVERITY_RANGE\[key\]/,
    "§1.3 — colour never carries meaning alone, so the key names the day ranges",
  );
});

/* ── 10. §6.3 and gate 32 — the dot row, and the share ────────────────────── */

test("the dot row is gone", async () => {
  /*
   * `●●●●●●●●● +16  17 urgent` — no key, no scale, two numbers running
   * together. The labelled ageing bar replaces it, and nothing may bring it
   * back.
   */
  /*
   * `sitesCode`, not `sitesSource`: the file's own docblock QUOTES the deleted
   * row while explaining why it went, which is exactly the comment this
   * assertion should not be reading. `codeOnly` is the suite's existing idiom
   * for that — see `tests/ops-rebuild-foundations.test.mjs`, which strips
   * comments before every `doesNotMatch` for the same reason.
   */
  assert.doesNotMatch(sitesCode, /●/, "gate 32 — the unlabelled dots are deleted");
  assert.doesNotMatch(sitesCode, /ops-dots|site\.priorities/, "and so is the markup that drew them");
});

test("share of open work is a percentage, not a count beside a bar", async () => {
  assert.match(
    sitesCode,
    /\{site\.shareOfOpen\}%/,
    'gate 32 — the old row printed "Share of open 26", which reads as a second job count',
  );
  assert.match(
    sitesCode,
    /attentionHeadline\(data\.openTotal, data\.siteCount\)/,
    "§1.4 — the denominator for that percentage is the header, and it is on screen",
  );
});

test("Not set up appears only where the site genuinely has no profile", async () => {
  assert.deepEqual(
    helpers.complianceReadout({ satisfied: 0, applicable: 0, scored: false }),
    { text: "Not set up", colour: "grey", spoken: "no compliance profile is set up" },
    "§6.3 — an absent profile is grey and says so",
  );
  assert.equal(
    helpers.complianceReadout({ satisfied: 0, applicable: 12, scored: true }).text,
    "0 of 12 in date",
    "§1.5 — a scored site with nothing in date is a ZERO, and zero is a fact",
  );
  assert.equal(
    helpers.complianceReadout({ satisfied: 0, applicable: 12, scored: true }).colour,
    "critical",
    "and it is red, not grey",
  );
  assert.equal(
    helpers.complianceReadout({ satisfied: 12, applicable: 12, scored: true }).colour,
    "fresh",
    "a site fully in date takes the good end of the ramp",
  );
  assert.equal(
    helpers.complianceReadout({ satisfied: 1, applicable: 12, scored: true }).text,
    "1 of 12 in date",
    "§6.3's worked example, verbatim",
  );
});

/* ── 11. §6.3 and §6.4 — the rest of the card ─────────────────────────────── */

test("sites without open work collapse into one line, and the register link stays", async () => {
  assert.match(
    sitesCode,
    /no open work →/,
    "§6.3 — nine quiet stores are one line, not nine rows",
  );
  assert.match(
    sitesCode,
    /Open the sites register →/,
    "§6.4 keeps this link; it is the Cost card that had to lose the compliance one",
  );
});

test("View all is rendered only when the list is actually truncated", async () => {
  assert.match(
    sitesCode,
    /truncated \? \(/,
    "§6.4 — a View all beside a complete list is a control that does nothing",
  );
  assert.match(sitesCode, /data\.sites\.length > SITE_ROW_LIMIT/, "and truncation is what it means");
});

test("the three states are three different pictures on both cards", async () => {
  for (const [name, code] of [
    ["Job breakdown", breakdownCode],
    ["Sites needing attention", sitesCode],
  ]) {
    assert.match(code, /state\.error/, `${name} draws its own error state`);
    assert.match(code, /role="alert"/, `${name}'s failure is announced`);
    assert.match(code, /state\.loading \? \(/, `${name} draws a skeleton while loading`);
    assert.match(code, /<EmptyState>/, `${name} draws a named empty state`);
    assert.doesNotMatch(
      code,
      /total=\{data\?\.total \?\? 0\}/,
      `${name} must not print a cohort of 0 while it is loading — §1.5`,
    );
  }
});

/* ── 12. Colour and the stylesheet ────────────────────────────────────────── */

test("neither card carries a colour of its own", async () => {
  for (const [name, source] of [
    [BREAKDOWN, breakdownCode],
    [SITES, sitesCode],
  ]) {
    assert.deepEqual(
      source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
      [],
      `${name} takes every colour from overview-meters.ts — §1.3`,
    );
    assert.doesNotMatch(
      source,
      /categoricalColour|CATEGORICAL_COLOURS|job-metrics/,
      `${name} may not use the retired palette or the board's status colours — §1.3`,
    );
  }
});

test("overview-portfolio.css contains no hex literal and no raw colour of any kind", async () => {
  const css = codeOnly(stylesSource);
  assert.deepEqual(
    css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
    [],
    "colours that come from data arrive as an inline style, never from CSS",
  );
  assert.doesNotMatch(css, /rgba?\(/, "a raw rgb() is a hex by another name and does not follow the theme");
  assert.doesNotMatch(css, /hsla?\(/);
  for (const named of ["white", "black", "red", "green"]) {
    assert.doesNotMatch(
      css,
      new RegExp(`:\\s*${named}\\b`),
      `${named} is a colour with no dark-mode value`,
    );
  }
});

test("overview-portfolio.css uses only the agreed breakpoints", async () => {
  const widths = [...stylesSource.matchAll(/\(min-width:\s*(\d+)px\)|\(max-width:\s*(\d+)px\)/g)].map(
    (match) => Number(match[1] ?? match[2]),
  );
  assert.ok(widths.length > 0, "the stylesheet is responsive");
  for (const width of widths) {
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${width}px is not one of the agreed breakpoints — several stage tests fail on any other`,
    );
  }
});

test("the stylesheet keeps the touch floor and the tabular figures", async () => {
  assert.match(stylesSource, /min-height: 44px/, "§1.8 — tap targets are at least 44px");
  assert.match(
    stylesSource,
    /font-variant-numeric: tabular-nums/,
    "§1.9 — figures do not jitter on refresh",
  );
  assert.match(
    stylesSource,
    /@media \(min-width: 768px\) \{\s*\.ovp-site \{/,
    "§1.8 — the site cards become rows only once there is room, never the other way round",
  );
});
