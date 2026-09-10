/**
 * Stage 28 — the landing page rebuild, checked against the brief's own audit.
 *
 * The brief ends with a six-point audit to run before finishing. This file is
 * that audit, written down so it runs on every commit rather than once. Its
 * source assertions read the components; its live assertions drive a real
 * browser and skip when nothing is listening on the dev server.
 *
 * WHY A SEPARATE FILE. `stage-eleven-marketing` covers the porting rules that
 * predate the rebuild — no iframe, copy ported not rewritten, legal pages
 * reachable. Those are still true and still worth holding. What is here is the
 * new contract: ten sections, four validated behaviours and the anchors that
 * tie them together.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* ── 1. Fourteen sections, each exactly once ─────────────────────────────── */

/**
 * EVERY SECTION ON THE PAGE, BY THE ANCHOR IT OWNS, IN DOM ORDER.
 *
 * RE-POINTED FOR HOMEPAGE V3, and corrected on the way. Two things were wrong
 * with the old list beyond being short by three: `founder` was missing
 * altogether — the section has carried `id="founder"` since the v2 edit added
 * it — and `report` sat second, where the section had not been since that same
 * edit. Both were invisible because the only test that reads this list in DOM
 * order is the live one, which needs Chrome at a macOS path and skips
 * everywhere else. The list is the page's real order now, so the source test
 * that uses it as the set of legal nav targets is checking something true.
 *
 * V3 adds `replaces`, `your-contractors` and `faq`, and moves `report` to the
 * end — directly above the footer, which is the owner's instruction and the
 * reason the last three entries read the way they do.
 */
const ANCHORS = [
  "hero",
  "sectors",
  "services",
  "problem",
  "replaces",
  "how",
  "your-contractors",
  "pricing",
  "case-study",
  "founder",
  "portal",
  "faq",
  "trust",
  "review",
  /* Not a section of its own — a second name for the one above. `#contact` is
     on the final CTA's inner wrapper so that "Contact Us" in the nav lands on
     the page's only form that asks who you are, without renaming the anchor the
     "Book a Portfolio Review" buttons have always used. It is out of DOM order
     here for that reason: the live test below drops it before comparing. */
  "contact",
  "report",
];

/** The same list without the alias, which is what the DOM actually contains. */
const SECTION_IDS = ANCHORS.filter((id) => id !== "contact");

test("the page is fourteen sections, in the V3 order, each exactly once", async () => {
  /*
   * Was eleven. Homepage V3 adds three sections and moves one:
   *
   *   WhatThisReplaces  after Problem
   *   ContractorChoice  after HowItWorks
   *   Faq               after Portal
   *   ReportJob         from fourth to LAST, above the footer
   *
   * The order is asserted, not just the count, and that matters more after this
   * edit than before it: the sequence IS the argument — who it is for, what it
   * covers, what it replaces, how it runs, whose contractors, what it costs —
   * and a count alone would pass just as happily with the eleven-field form
   * back in the middle of it.
   */
  const page = await read("app/(marketing)/page.tsx");
  const rendered = [...page.slice(page.indexOf("HomePage")).matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(rendered, [
    "Hero",
    "WhoWeHelp",
    "Services",
    "Problem",
    "WhatThisReplaces",
    "HowItWorks",
    "ContractorChoice",
    "Pricing",
    "CaseStudy",
    "Founder",
    "Portal",
    "Faq",
    "TrustStrip",
    "FinalCta",
    "ReportJob",
  ], "fourteen sections; one of them is two components — a dark band and the form beneath it");
  assert.equal(new Set(rendered).size, rendered.length, "each exactly once");
  assert.equal(rendered.at(-1), "ReportJob", "Report a Job is the last thing above the footer");
});

/* ── 2. Copy rules ───────────────────────────────────────────────────────── */

test("the forbidden claims appear nowhere on the marketing site", async () => {
  /*
   * The brief lists six phrases that must never be used, and the reason is not
   * squeamishness: Maintsupp does not employ engineers, so "our engineers" is a
   * statement a client could hold them to. Checked across every section, the
   * legal pages and the shared copy — a rule enforced in one file is a rule
   * that moves to another file.
   */
  const forbidden = [
    /\bour engineers\b/i,
    /\bour nationwide team\b/i,
    /24\/7 coverage/i,
    /guaranteed same-day fix/i,
    /100% first-time fix/i,
    /\bwe certify\b/i,
  ];
  const dir = path.join(root, "app/(marketing)");
  const offenders = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|ts)$/.test(entry.name)) {
        const source = readFileSync(full);
        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            offenders.push(`${path.relative(root, full)} — ${pattern}`);
          }
        }
      }
    }
  };
  const { readFileSync } = await import("node:fs");
  walk(dir);
  assert.deepEqual(offenders, [], "the brief forbids these phrases");
});

test("no price is shown + VAT", async () => {
  /*
   * THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACES.
   *
   * It was "every price is shown + VAT", and the comment above the pricing
   * component said in as many words that carrying "+ VAT" was "a rule of the
   * brief and not a detail". Homepage V3 withdraws it: the owner's instruction
   * is that "+ VAT" appears nowhere on the marketing site. Five places carried
   * it — the shared price line, the compliance setup footnote, a whole matrix
   * row that said "+ VAT on top" three times, and two of the portfolio notes.
   *
   * IT IS A REMOVAL, NOT A SUBSTITUTION, which is why the second loop below
   * exists: "excluding VAT", "ex VAT" and "+VAT" are the same qualifier wearing
   * a different hat, and putting one of them back would satisfy a naive check
   * for the exact string while defeating the instruction.
   *
   * WHAT DID NOT CHANGE. Four figures are still pinned, for the same reason:
   * they are the money a client is quoted outside the per-store rate, and the
   * risk of an edit that strips a qualifier is that it strips the sentence
   * around it too.
   *
   * RE-POINTED at the approved portfolio terms. The old four (£295/month
   * minimum, £65 each additional job, £125 per incident, £25/store setup) were
   * replaced wholesale by the pricing rebuild: the minimum is £300, additional-
   * job pricing is gone entirely in favour of two coordinated jobs per store
   * per month, and onboarding is £75/store capped at £1,200. They are pinned as
   * the CONSTANTS now rather than as strings, because the markup interpolates
   * them — a figure typed into a sentence is the defect the next test forbids.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");

  for (const figure of [
    "const PORTFOLIO_MINIMUM = 300",
    "const ONBOARDING_PER_STORE = 75",
    "const ONBOARDING_CAP = 1200",
    "const OUT_OF_HOURS_P1 = 125",
  ]) {
    assert.ok(pricing.indexOf(figure) > 0, `${figure} is missing`);
  }
  /* And each one still reaches the reader inside its sentence. */
  for (const sentence of [
    /Portfolio minimum £\{PORTFOLIO_MINIMUM\}\/month/,
    /Onboarding and asset capture £\{ONBOARDING_PER_STORE\}\/store, capped at £/,
    /out-of-hours P1 incidents \(£\{OUT_OF_HOURS_P1\} each\)/,
  ]) {
    assert.match(pricing, sentence, `${sentence} no longer reaches the page`);
  }

  /*
   * Comments stripped, exactly as the urgency-chip test does it. The note that
   * records why the qualifier went has to quote it, and a check that fails on
   * its own rationale would push the reasoning out of the file to make the test
   * pass — which is how a rule loses the only record of why it exists.
   */
  const rendered = pricing.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(rendered, /\+\s*VAT/i, "no rendered string may carry + VAT");
  assert.doesNotMatch(rendered, /\bVAT\b/i, "and none may mention VAT at all");
  for (const substitute of [/ex\.?\s*VAT/i, /exclud\w* VAT/i, /plus VAT/i, /VAT on top/i]) {
    assert.doesNotMatch(rendered, substitute, `${substitute} is the same rule renamed`);
  }

  /* And nowhere else on the marketing site either — the qualifier was never
     only in this file's gift, and marketing.css quoted the sentence too. */
  const css = await read("app/(marketing)/marketing.css");
  assert.doesNotMatch(
    css.replace(/\/\*[\s\S]*?\*\//g, ""),
    /VAT/i,
    "the stylesheet must not carry it either",
  );
});

test("the Total Care saving is derived from the prices above it", async () => {
  /*
   * "Most popular — save £20 per store" is true at both numbered bands, and it
   * is computed rather than typed so it cannot come to contradict the cards.
   * The arithmetic is checked here against the same table the component uses.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  /*
   * RE-POINTED to the approved rates and the new plan names. The CLAIM is
   * unchanged and is the reason this test exists: the badge is arithmetic over
   * the table, never a typed figure.
   *
   * What changed under it: the plans are Essential / Compliance Administration
   * / Complete, there are FOUR bands, and the top one carries no rate at all —
   * 51+ is "Book a Portfolio Review", so its entries are `null` and it is
   * excluded from the arithmetic rather than given an invented number.
   */
  const bands = [...pricing.matchAll(
    /essential: (\d+), compliance: (\d+), complete: (\d+)/g,
  )].map(([, essential, compliance, complete]) => ({
    essential: Number(essential),
    compliance: Number(compliance),
    complete: Number(complete),
  }));

  /* The approved figures, pinned because they are quoted to clients. */
  assert.deepEqual(bands, [
    { essential: 55, compliance: 50, complete: 85 },
    { essential: 50, compliance: 48, complete: 78 },
    { essential: 45, compliance: 45, complete: 70 },
  ]);

  /* The badge claims a saving per band; each band's cards must produce it. It
     is £20 at all three numbered bands, which is a property of the approved
     rates rather than a coincidence worth hiding. */
  assert.deepEqual(
    bands.map((band) => band.essential + band.compliance - band.complete),
    [20, 20, 20],
  );

  /* The fourth band exists and carries no rate. A figure here would be a price
     for a portfolio nobody has scoped. */
  assert.match(pricing, /label: "51\+ stores"/, "the top band is published as a band");
  assert.match(
    pricing,
    /essential: null,[\s\S]{0,40}complete: null,/,
    "and carries no rate — it offers a review instead",
  );
  assert.match(pricing, /Book a Portfolio Review/, "which is what it offers");

  assert.match(pricing, /save £\{saving\} per store/, "the badge must read the computed figure");
  assert.match(
    pricing,
    /band\.essential \+ band\.compliance - band\.complete/,
    "and must derive it from the band on screen rather than a typed number",
  );
  /* The badge cannot render in the band that has no numbers to subtract. */
  assert.match(pricing, /saving !== null && \(/, "no saving is claimed where there are no rates");
});

test("the store count drives the band, the rate and the monthly total", async () => {
  /*
   * The calculator is the section's one input. If any of these stops being
   * derived, the page can show a reader a rate their own store count does not
   * qualify for — which is worse than showing no calculator at all.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  assert.match(pricing, /type="range"/, "there is a real slider, not a band picker alone");
  assert.match(pricing, /function bandForCount/, "the band is computed from the count");
  /* RE-POINTED: the multiplication moved into `monthlyFor`, which also has to
     answer `null` in the band that carries no rate. The claim — the total is
     rate x count and never a typed figure — is unchanged. */
  assert.match(
    pricing,
    /rate === null \? null : rate \* storeCount/,
    "the monthly total is rate x count, not a typed figure, and absent without a rate",
  );
  /* The struck-through price is the entry band's, so it cannot contradict it. */
  assert.match(pricing, /was=\{entryBand\[plan\.key\]\}/);
  assert.match(pricing, /was > amount/, "and only shows once the reader is past that band");
});

/*
 * The phone presentation of the same section.
 *
 * Three plan cards stacked ran to 2294px at 390 and 2510px at 320 — more than
 * the whole desktop section — and answered no comparison question, because a
 * reader had to hold one card's feature list in their head while scrolling to
 * the next. Below 768px the section renders a comparison matrix instead.
 *
 * The danger in a second presentation is a second copy of the facts, so these
 * tests hold the opposite: one data table, two renderings, and nothing that
 * only one of them knows.
 */

/**
 * Every feature the cards listed before the matrix existed, in order.
 *
 * RE-POINTED: the plan keys are `essential` / `compliance` / `complete` since
 * the pricing rebuild renamed Coordination to Essential and Total Care to
 * Complete. THE FEATURES THEMSELVES DID NOT MOVE, which is the whole point of
 * this list — a rename must not be able to smuggle a dropped feature past it.
 */
const CARD_FEATURES = {
  essential: [
    "Intake & triage",
    "Contractor assignment",
    "Quote control",
    "Attendance chasing",
    "Photo-verified close-out",
    "Monthly report",
  ],
  compliance: [
    "Certificate register",
    "90/60/30-day reminders",
    "Provider booking",
    "Certificate chasing",
    "Remedial tracking",
    "Traffic-light compliance dashboard",
  ],
  complete: ["Quarterly portfolio review"],
};

test("every feature the cards listed still exists, once, in the shared table", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  /* RE-POINTED: the slice used to end at the `planHas` helper the matrix
     needed. With the matrix gone the table ends where `cardPoints` begins. */
  const table = pricing.slice(
    pricing.indexOf("const FEATURES"),
    pricing.indexOf("function cardPoints"),
  );
  const rows = [...table.matchAll(/\{ label: "([^"]+)", plan: "(\w+)" \}/g)].map(
    ([, label, plan]) => ({ label, plan }),
  );

  for (const [plan, labels] of Object.entries(CARD_FEATURES)) {
    assert.deepEqual(
      rows.filter((row) => row.plan === plan).map((row) => row.label),
      labels,
      `${plan} lost or reordered a feature`,
    );
  }
  assert.equal(rows.length, 13, "a feature was added or dropped without this test moving");

  /* No label may be typed twice — that is the defect a second presentation
     invites, and it is what would let the card and the matrix disagree. */
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length);
});

test("every presentation renders from that table, not from copies of it", async () => {
  /*
   * RE-POINTED, and STRENGTHENED rather than weakened.
   *
   * There used to be two presentations — cards above 768px, a nineteen-row
   * matrix below it — and the risk this test existed for was the second copy
   * of the facts. The rebuild deleted the matrix, so the risk it guarded is
   * now carried by the THREE cards: Essential, Compliance Administration and
   * Complete, where Complete's list is a roll-up of the other two. That is the
   * same defect in a smaller space, so the same rule applies to it.
   *
   * The £-literal check below gets stricter as a direct result: with no
   * footnote figures typed into the markup at all, the expected list is empty.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");

  /* Every card's bullets are derived, including Complete's summary lines. */
  assert.match(pricing, /cardPoints\(plan\)\.map\(/, "the card must render derived points");
  assert.match(
    pricing,
    /cardPoints\(COMPLIANCE_PLAN\)\.map\(/,
    "the smaller option is not exempt — a typed list there drifts just as easily",
  );
  assert.match(
    pricing,
    /`Everything in \$\{titleOf\(key\)\}`/,
    "Complete's roll-up wording must be built from the plan titles, not typed",
  );
  assert.match(
    pricing,
    /FEATURES\.filter\(\(feature\) => feature\.plan === plan\.key\)/,
    "and each card's own bullets must be selected out of the one table",
  );
  /* Prices in every card come from the band on screen. */
  assert.match(pricing, /const rateFor = \(plan: Plan\) => band\[plan\.key\]/);
  assert.match(
    pricing,
    /<Price amount=\{rateFor\(COMPLIANCE_PLAN\)\}/,
    "including the smaller option's",
  );

  /* One price table. No £ figure may be typed into the markup at all — that
     is how a card comes to quote a price the band no longer charges. */
  const body = pricing
    .slice(pricing.indexOf("export function Pricing"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...body.matchAll(/£(\d[\d,]*)/g)].map((m) => m[0]);
  assert.deepEqual(
    literals,
    [],
    `every figure must be interpolated from a constant; found ${literals.join(", ")}`,
  );
});

test("availability is stated in words, never in colour alone", async () => {
  /*
   * RE-POINTED from the matrix to the cards.
   *
   * The matrix carried this contract because a tick in a table is a glyph, and
   * a glyph read out by a screen reader is nothing. The rebuild deleted the
   * matrix, so the contract moves to the presentation that replaced it: the
   * card bullet lists. It has not been dropped, and it has not been softened
   * — what a plan includes must still be a WORD, not a tint and not a shape.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");

  /* The matrix stays gone. If it comes back, it comes back with this test. */
  assert.doesNotMatch(pricing, /pmx/, "the comparison matrix was deleted, not hidden");
  const css = await read("app/(marketing)/marketing.css");
  assert.doesNotMatch(css, /pmx/, "and so were its styles");

  /* Each bullet is text. The tick beside it is decoration and says so, which
     is what stops a reader being told a plan includes a checkmark. */
  assert.match(
    pricing,
    /<Tick \/>[\s\S]{0,40}?<span>\{point\}<\/span>/,
    "a card bullet is a glyph followed by its own words",
  );
  assert.match(
    pricing,
    /function Tick\(\)[\s\S]{0,400}?aria-hidden="true"/,
    "and the glyph is hidden from assistive technology rather than named twice",
  );

  /* The band that includes no rate says so in words too, rather than showing
     an empty price and leaving the reader to infer it. */
  assert.match(pricing, /const REVIEW = "Book a Portfolio Review"/);
  assert.match(
    pricing,
    /className="pkg__talk"/,
    "the review offer renders as its own labelled price line",
  );

  /* The block is a real landmark with a real heading, and the smaller option
     is beside the choice rather than inside it — the structural half of what
     the table's <caption> and row headers used to provide. */
  assert.match(pricing, /<section className="section section--tint" id="pricing">/);
  assert.match(pricing, /<h2 className="h2">Simple per-store pricing/, "and carries its heading");
  assert.match(pricing, /<aside className="pkgalt"/, "the smaller option is beside the choice, not in it");
  assert.match(
    pricing,
    /<h3>\{COMPLIANCE_PLAN\.title\}<\/h3>/,
    "with a heading of its own, read off the plan rather than typed twice",
  );
  assert.match(pricing, /title: "Compliance Administration"/, "which is what it is called");
});

test("the pricing section fits its column, and the page never scrolls sideways", async () => {
  /*
   * RE-POINTED from the matrix's scroll box to the section that replaced it.
   *
   * THE CLAIM IS UNCHANGED AND IS THE REASON THIS TEST EXISTS: at 320px the
   * pricing block must not push the document sideways. The matrix solved that
   * with `overflow-x:auto` plus `contain:paint` on its own box, because a
   * 340px-min table inside a 320px page reaches the document without it.
   *
   * With the matrix deleted there is no fixed-width child left to contain, so
   * the rule is enforced at its source instead: nothing in the pricing block
   * may declare a min-width or a fixed width that exceeds the narrowest
   * supported viewport. That is a stronger statement than the old one — it
   * forbids the condition rather than mitigating it.
   *
   * Measured in Chromium at 320/375/414/1440 on this build: document
   * scrollWidth equals innerWidth at every one, and no element inside
   * #pricing has a right edge past the viewport.
   */
  const css = await read("app/(marketing)/marketing.css");

  /* The card grid tracks the column it is given; it never demands a width. */
  assert.match(
    css,
    /\.pkgs\{display:grid;gap:16px;grid-template-columns:repeat\(auto-fit,minmax\(238px,1fr\)\)/,
    "the grid is auto-fit with a minmax floor, so one card per row is reachable",
  );

  /*
   * minmax()'s floor is not a min-width: a single 238px track still shrinks
   * with its container below 238px. A declared `min-width` would not, and a
   * declared fixed `width` in px would not either. Neither may appear on any
   * rule that styles this section — that is the condition the matrix's
   * `contain:paint` existed to mitigate.
   *
   * Rules are read out of the stylesheet with comments stripped, and every one
   * whose selector names a pricing class is checked.
   */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [];
  for (const [, selector, body] of bare.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (!/\.(pkgs?|pkgalt|pkgfoot|pricing)/.test(selector)) continue;
    const bad = [...body.matchAll(/(?:^|;)\s*(min-width|width):\s*(\d+)px/g)];
    for (const [, prop, value] of bad) {
      offenders.push(`${selector.trim()} { ${prop}:${value}px }`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `nothing in the pricing block may demand a width; found ${offenders.join(" / ")}`,
  );

  /* The two main cards go to one column on a phone and two abreast above 640,
     which is the swap the matrix used to perform at 767. */
  assert.match(
    css,
    /@media\s*\(min-width:640px\)\{\.pkgs--two\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/,
    "two abreast where there is room, one where there is not",
  );
});

test("pricing copy does not hyphenate", async () => {
  /*
   * `hyphens:auto` was tried in the pricing block and removed after QA on the
   * deployed preview: cells that carry a sentence rather than a label rendered
   * "Reactive re-pairs, run end to end" and "Certificates tracked be-fore they
   * expire" at 430 and below, which reads as a typo in a pricing table.
   *
   * RE-POINTED from the matrix's cells to the whole pricing block, because the
   * matrix that carried those cells is gone and the reason the rule exists is
   * not specific to a table — it is specific to this copy, which is full of
   * compound labels ("Photo-verified close-out", "90/60/30-day reminders").
   * Scoped to the block rather than the file on purpose: `.comparetable__text`
   * in section 3 sets `hyphens:auto` deliberately and is not in scope here.
   *
   * `overflow-wrap` stays and covers the only thing hyphenation was needed for
   * — stopping a long word overflowing its column.
   */
  const css = await read("app/(marketing)/marketing.css");
  const block = css.slice(
    css.indexOf(".pkgs{"),
    css.indexOf("/* ------------------------------------------------------------ calculator"),
  );
  assert.ok(block.length > 400, "the pricing block was not located");
  assert.doesNotMatch(block, /hyphens:/, "no rule in the pricing block may hyphenate");

  /* And the long-word case is still handled. */
  assert.match(css, /overflow-wrap:(anywhere|break-word)/);
});

test("the page's vertical rhythm is a scale, not thirty typed numbers", async () => {
  const css = await read("app/(marketing)/marketing.css");
  /* Both ends of the scale, pinned. The desktop values are the ones that
     took 615px off 1440 and 489px off 1024: the section band came down from
     7.2vw/108px to 5vw/76px, and the block and step gaps from 30/26 to 26/22.
     They are held here because the next person to "just nudge one section"
     should have to change the scale instead. */
  assert.match(css, /--section-y:clamp\(50px,5vw,76px\)/, "the desktop section band");
  assert.match(css, /--gap-block:26px;--gap-step:22px;--gap-card:14px;--gap-pad:22px/);
  assert.match(
    css,
    /--section-y:clamp\(40px,8vw,56px\);--gap-block:20px;--gap-step:18px;--gap-card:10px;--gap-pad:16px/,
    "the phone step sizes must narrow together, in one place",
  );
  /* Dead space, not a gap: a trailing paragraph's bottom margin sat against
     the section's own padding at every width. */
  assert.match(css, /\.section > \.wrap > \*:last-child\{margin-bottom:0\}/);
  /* The blocks that used to carry their own 26/30px must read the scale. */
  for (const rule of [
    /\.whogrid\{[^}]*margin-top:var\(--gap-block\)/,
    /* Was `.offergrid`. The five services are one ruled register now, not a
       card grid, but the block it sits in still has to read the scale. */
    /\.svclist\{[^}]*margin-top:var\(--gap-block\)/,
    /\.pricing__plans\{margin-top:var\(--gap-step\)\}/,
    /\.pkgfoot\{[^}]*margin-top:var\(--gap-step\)/,
    /\.whocard__body\{padding:calc\(var\(--gap-pad\) - 2px\)/,
  ]) {
    assert.match(css, rule, `${rule} no longer reads the spacing scale`);
  }
});

test("What we offer still carries all five services, word for word", async () => {
  /*
   * THE RISK THIS CLOSES. "What we offer" was five cards in an auto-fit grid;
   * it is now one ruled register, because five cards laid out four-plus-one and
   * padded the four short ones out to the height of the long one. A layout edit
   * like that is exactly the kind of change under which a sentence quietly goes
   * missing — the Compliance body is the longest on the page, and shortening it
   * is the easiest way to make any grid look tidier.
   *
   * So the copy is pinned here in full, not by title and not by prefix. These
   * are claims about who does the inspections; they may be re-laid-out freely
   * and may not be trimmed, summarised or reworded without editing this list.
   */
  const source = await read("app/(marketing)/_sections/services.tsx");
  const services = [
    [
      "Reactive Maintenance Coordination",
      "Intake, triage, contractor assignment, quote control, attendance chasing and verified close-out.",
    ],
    [
      "Planned Maintenance (PPM)",
      "Recurring service schedules, work orders, attendance monitoring and follow-up actions.",
    ],
    [
      "Compliance Administration",
      "Certificate register, due-date reminders, provider booking, document chasing and remedial tracking. Inspections and certificates are carried out by competent certified providers.",
    ],
    [
      "Projects & Store Works",
      "Kiosk moves, refreshes, signage and multi-trade works, each separately scoped and quoted.",
    ],
    [
      "Reporting & Visibility",
      "Monthly KPI, spend, ageing and compliance reporting across the portfolio.",
    ],
  ];
  for (const [title, body] of services) {
    assert.ok(source.includes(`title: "${title}"`), `the ${title} service is gone`);
    assert.ok(source.includes(`body: "${body}"`), `the ${title} body has been altered or trimmed`);
  }
  assert.equal(
    [...source.matchAll(/^\s{4}title: "/gm)].length,
    services.length,
    "five services, no more and no fewer — a sixth would need a row here too",
  );

  /*
   * And the semantics the register is built on. `list-style:none` costs a <ul>
   * its list role in Safari, so the explicit role is what keeps "list, 5 items"
   * being announced; the headings are what keep the five services reachable by
   * heading navigation, which the cards' <h3>s used to provide.
   */
  assert.match(source, /<ul className="svclist reveal" role="list">/);
  assert.match(source, /<h3 className="svclist__term">/);
  assert.match(source, /<p className="svclist__def">\{service\.body\}<\/p>/);
});

/* ── 3. The Report a Job form ────────────────────────────────────────────── */

test("the form asks the brief's eleven questions, in order", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const order = [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
    "rjDesc",
    "rjUpload",
    "rjAccess",
  ];
  const positions = order.map((id) => ({ id, at: form.indexOf(`id="${id}"`) }));
  for (const { id, at } of positions) assert.ok(at > 0, `${id} is missing from the form`);
  const sorted = [...positions].sort((a, b) => a.at - b.at).map((entry) => entry.id);
  assert.deepEqual(sorted, order, "the fields must appear in the brief's order");
});

test("the required fields are validated, and the access window stays optional", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const checks = form.slice(form.indexOf("const CHECKS"), form.indexOf("type FieldValue"));
  for (const id of [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
    /*
     * The description joined them: the approved reference marks it required,
     * because a coordinator triaging "P1, Electrical, Oxford Street" with no
     * sentence has to ring the store back before choosing a trade.
     */
    "rjDesc",
  ]) {
    assert.match(checks, new RegExp(`"${id}"`), `${id} must be required`);
  }
  /* The access window is the one field a reporter may genuinely not know. */
  assert.doesNotMatch(checks, /"rjAccess"/, "the access window stays optional");
});

test("evidence is required, and checked outside CHECKS because it is not a field", async () => {
  /*
   * The files live in component state, not in a form control, so the rule
   * cannot sit in CHECKS with the others — but it must run in the same pass,
   * or somebody missing both a description and a photograph is told about one,
   * fixes it, and is then told about the other.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /if \(picked\.length === 0\) \{\s*found\.rjUpload =/);
  assert.match(form, /Add at least one photo or video/);
  assert.match(form, /\{filesError \|\| errors\.rjUpload\}/, "and it is shown in the upload block");
});

test("the urgency chips promise no response time", async () => {
  /*
   * THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACES.
   *
   * The chips used to print "Within 4 hrs", "Next working day" and so on,
   * added under an earlier brief. The v2 positioning brief withdraws them: no
   * response-time or SLA commitment may appear anywhere on the page, and its
   * audit tests for absence rather than merely forbidding new ones.
   *
   * The P-codes stay. A code classifies how bad the fault is — something the
   * reporter can answer and triage needs. A response time is a promise about
   * what happens next, and that is the part that was withdrawn.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");

  for (const code of ["P1", "P2", "P3", "P4"]) {
    assert.match(form, new RegExp(`code: "${code}"`), `${code} is still offered`);
  }
  assert.match(form, /P1 — Critical, site unsafe or cannot trade/);

  assert.ok(!form.includes("chip__sla"), "the SLA line is no longer rendered");
  assert.ok(!/sla:/.test(form), "and the field is gone, so it cannot be rendered again");

  /* Comments stripped: the note recording why the promises went quotes them,
     and a check that fails on its own rationale would push the reasoning out
     of the file to make the test pass. */
  const rendered = form.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const promise of ["Within 4 hrs", "Next working day", "5 working days"]) {
    assert.ok(!rendered.includes(promise), `response time still present: ${promise}`);
  }
});

test("every invalid field is reported at once, not one at a time", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(
    form,
    /const \[errors, setErrors\] = useState<Record<string, string>>\(\{\}\)/,
    "a map, not a single field — the brief asks for an error on every one",
  );
  assert.match(form, /const found: Record<string, string> = \{\};/);
  assert.match(form, /if \(message\) found\[name\] = message;/, "collect, do not return early");
  assert.match(form, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(form, /focus\(\{ preventScroll: true \}\)/, "scroll first, then focus");
});

test("the form posts to a route a logged-out visitor may actually use", async () => {
  /*
   * THE BUG THIS REPLACES. The form posted to `/api/maintenance`, which
   * requires the `board.edit` capability. Every visitor to a marketing page is
   * logged out by definition, so every submission came back
   * `401 Your session has ended. Sign in to continue.` — the form has never
   * once worked, and the failure looked like a session problem rather than a
   * missing endpoint.
   *
   * The fix is NOT to loosen `/api/maintenance`: that would make every board in
   * every tenant writable by anyone who could guess a payload. It is a separate
   * public route with its tenant pinned.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /fetch\("\/api\/report-job"/, "the public route, not the operator one");
  assert.doesNotMatch(
    form,
    /fetch\("\/api\/maintenance"/,
    "/api/maintenance requires board.edit and a visitor has none",
  );

  const route = await read("app/api/report-job/route.ts");
  assert.match(route, /allowAnonymous: true/, "a visitor has no session");
  assert.match(
    route,
    /const orgId = PRIMARY_ORGANISATION_ID/,
    "the tenant is pinned, never taken from the payload or a cookie",
  );
  assert.doesNotMatch(
    route,
    /payload\.(organisationId|orgId|tenant)/,
    "no request may steer a job into another workspace",
  );
  /*
   * RE-POINTED, and the canonicalisation got STRICTER on the way.
   *
   * `configuredValue` matched a submitted string against an option's stable
   * VALUE and nothing else, while this form shows LABELS — so renaming
   * "Urgent" made every subsequent report fall back to the workspace default
   * and buy itself the 120-hour clock. The route now hands the raw answer to
   * `createSubmission`, which resolves it through `canonicalSubmissionOption`:
   * value first, then the current label, then the default. The claim is
   * unchanged — an arbitrary string may not invent a board value or a shorter
   * SLA — and it is now true of a renamed label as well.
   */
  assert.match(
    route,
    /priority: payload\.priority/,
    "the raw answer must go through the service, never straight into a column",
  );
  const service = await read("app/lib/submission-service.ts");
  assert.match(
    service,
    /canonicalOptionValue\(options, text, fallback\)/,
    "canonicalise, do not trust",
  );
  assert.match(route, /source: "Website form"/, "a coordinator must see where this came from");
  assert.match(route, /uploadToken/, "and the reporter must be able to attach the photographs");
});

test("the description reports its own error like every other field", async () => {
  /*
   * Making the description required without giving it an error slot is worse
   * than leaving it optional: the submit is blocked, nine other fields light up
   * red, and the one actually stopping the form says nothing.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /id="rjDesc-err"/, "the description needs somewhere to put its message");
  assert.match(
    form,
    /className=\{fieldClass\("rjDesc"\)\}/,
    "and the red outline every other field gets",
  );
});

test("the priority and engineer values the form sends exist on the board", async () => {
  /*
   * THE BUG THIS REPLACES. The old form sent `"High"` for a trading-impaired
   * fault and `"HVAC"` / `"Plumber"` / `"Specialist"` for three of its five
   * categories. None of those four are in the board's option sets, and
   * `configuredValue` silently substitutes the default rather than refusing —
   * so the second-most-urgent report a store can make arrived at the bottom of
   * the pile, and nobody could see why.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const spec = await read("db/monday-board-spec.ts");

  const priorities = new Set(
    [...spec.slice(spec.indexOf("priority: [")).slice(0, 200).matchAll(/opt\("([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  const engineers = new Set(
    [
      ...spec
        .slice(spec.indexOf("engineer_required: ["))
        .slice(0, 260)
        .matchAll(/opt\("([^"]+)"/g),
    ].map((match) => match[1]),
  );
  assert.ok(priorities.size >= 3 && engineers.size >= 4, "board spec moved; fix this test");

  for (const [, value] of form.matchAll(/priority: "([^"]+)"/g)) {
    assert.ok(priorities.has(value), `priority "${value}" is not on the board`);
  }
  for (const [, value] of form.matchAll(/engineer: "([^"]+)"/g)) {
    assert.ok(engineers.has(value), `engineer "${value}" is not on the board`);
  }
});

/* ── 4. Chrome ───────────────────────────────────────────────────────────── */

test("Portal Login is the name everywhere, and it points at the portal", async () => {
  /*
   * Read with the explanations stripped. The comment beside the header link
   * says why it is not called "Client Login", so a raw search finds the phrase
   * being ruled out and fails on the sentence that rules it out.
   */
  const chrome = (await read("app/(marketing)/_sections/chrome.tsx"))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const hits = [...chrome.matchAll(/Portal Login/g)];
  assert.ok(hits.length >= 3, `expected it in the utility bar, header and footer; found ${hits.length}`);
  assert.match(chrome, /href="\/portal"/);
  assert.doesNotMatch(chrome, /Client Login/, "the brief names it Portal Login for a reason");
});

test("every nav anchor names a section that exists", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  const nav = chrome.slice(chrome.indexOf("const NAV = ["), chrome.indexOf("] as const;"));
  const targets = [...nav.matchAll(/\["#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 5, "four in-page destinations from the brief, plus Contact Us");
  assert.ok(targets.includes("contact"), "Contact Us points at #contact");
  for (const target of targets) {
    assert.ok(ANCHORS.includes(target), `#${target} has no section`);
  }

  /* And `#contact` is a real element, not a name in a list. It lives on the
     final CTA's inner wrapper, alongside the section's own `#review`, so both
     the nav item and every existing Book-a-Portfolio-Review link resolve. */
  const cta = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(cta, /id="contact"/, "#contact must exist in the markup");
  assert.match(cta, /<section className="section finalcta" id="review">/, "#review must still resolve");
  /* The footer's own Contact link moves with the nav; the CTA buttons do not. */
  const chromeSrc = await read("app/(marketing)/_sections/chrome.tsx");
  assert.match(chromeSrc, /<li><a href="#contact">Contact<\/a><\/li>/);
  assert.ok(
    (chromeSrc.match(/href="#review"/g) ?? []).length >= 2,
    "the header and drawer Book a Portfolio Review buttons still point at #review",
  );
});

test("the footer carries the legal line verbatim", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  for (const fragment of [
    "Maintsupp is a trading name of Maintauk Ltd",
    "company no. 17262302",
    "C/O MJR Accounting & Tax Services",
    "One Canada Square, London, E14 5AA",
  ]) {
    assert.ok(
      chrome.replace(/&amp;/g, "&").includes(fragment),
      `the legal line is missing: ${fragment}`,
    );
  }
});

/* ── 5. Live, in a real browser ──────────────────────────────────────────── */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function openBrowser(width, height) {
  const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-stage28-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9343",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
  ]);
  chrome.on("error", () => undefined);

  let socketUrl = null;
  for (let attempt = 0; attempt < 60 && !socketUrl; attempt += 1) {
    try {
      socketUrl = (await (await fetch("http://127.0.0.1:9343/json/version")).json())
        .webSocketDebuggerUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!socketUrl) {
    chrome.kill();
    return null;
  }

  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });
  const consoleErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(String(message.params.args?.[0]?.value ?? "error"));
    }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push("uncaught exception");
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: width < 768 },
    sessionId,
  );

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  await send("Page.navigate", { url: `${BASE_URL}/` }, sessionId);
  for (let attempt = 0; attempt < 140; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await evaluate(`Boolean(document.querySelector("#rjForm"))`)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  return {
    evaluate,
    consoleErrors,
    close() {
      socket.close();
      chrome.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the profile is a temp dir; a locked file is not worth failing over */
      }
    },
  };
}

test("live: the fourteen sections are on the page, once each, with no duplicate heading", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    const found = await browser.evaluate(`(() => {
      const main = document.querySelector("main#top");
      const ids = [...main.querySelectorAll(":scope > section")].map(s => s.id);
      const h2 = [...main.querySelectorAll("h2")].map(h => h.textContent.trim());
      return { ids, h1: main.querySelectorAll("h1").length, dupes: h2.filter((h,i) => h2.indexOf(h) !== i) };
    })()`);
    /* `SECTION_IDS`, not `ANCHORS`: `#contact` is an alias carried on the final
       CTA's inner wrapper, so it is a legal nav target but never a <section>
       child of <main>. Comparing against the full list asserted a section that
       has never existed — which nothing caught, because this test needs Chrome
       at a macOS path and skips everywhere else. */
    assert.deepEqual(found.ids, SECTION_IDS, "the sections, in the page's order");
    assert.equal(found.h1, 1, "one h1 on the page");
    assert.deepEqual(found.dupes, [], "a repeated heading means a section is drawn twice");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: an empty Report a Job cannot be submitted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    await browser.evaluate(
      `document.querySelector("#rjForm button[type=submit]").click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const state = await browser.evaluate(`(() => {
      const form = document.querySelector("#rjForm");
      const shown = [...form.querySelectorAll(".field__err")].filter(p => !p.hidden && p.textContent.trim());
      const invalid = [...form.querySelectorAll(".is-invalid")];
      const red = invalid.map(el => {
        const control = el.tagName === "FIELDSET"
          ? el.querySelector(".chipgroup label")
          : el.querySelector("input,select,textarea");
        return control ? getComputedStyle(control).borderColor : null;
      });
      return { shown: shown.length, invalid: invalid.length, red: [...new Set(red)] };
    })()`);

    assert.equal(state.shown, 8, "an inline message on every one of the eight");
    assert.equal(state.invalid, 8, "and a red outline on every one");
    assert.equal(state.red.length, 1, `every invalid control takes the same red; got ${state.red}`);
    assert.match(state.red[0], /^rgb\(/, "the outline must be a real computed colour");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: every in-page anchor lands on something, at both widths", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const browser = await openBrowser(width, height);
    if (!browser) {
      t.skip("Chrome is not available");
      return;
    }
    try {
      const result = await browser.evaluate(`(() => {
        const hrefs = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href"));
        return {
          missing: [...new Set(hrefs)].filter(h => h !== "#" && !document.querySelector(h)),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
        };
      })()`);
      assert.deepEqual(result.missing, [], `dead anchors at ${width}px`);
      assert.equal(result.overflow, 0, `${width}px scrolls sideways by ${result.overflow}px`);
      assert.equal(result.brokenImages, 0, `broken images at ${width}px`);
    } finally {
      browser.close();
    }
  }
});
