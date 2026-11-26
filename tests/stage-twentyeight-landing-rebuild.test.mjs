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
  /*
   * RE-POINTED (decision L): THE ORDER IS DATA NOW, so this reads it where it
   * lives instead of counting self-closing tags in `page.tsx`.
   *
   * `app/lib/site-content.ts` declares the fourteen sections and the sequence the
   * site ships in (`HOME_SECTIONS`, in order); `page.tsx` maps each of those keys
   * to the component that draws it and renders whatever order staff have saved.
   * So the contract MOVED rather than went — and it is checked in both halves
   * here: the registry's list and sequence, and that every key has a component.
   * A section could otherwise be dropped from the page by deleting one line of a
   * record, with nothing to say so.
   */
  const registry = await read("app/lib/site-content.ts");
  const declared = registry.slice(
    registry.indexOf("const HOME_SECTIONS"),
    registry.indexOf("export const HOME_SECTION_ORDER"),
  );
  const sections = [...declared.matchAll(/key: "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, [
    "hero",
    "whoWeHelp",
    "services",
    "problem",
    "replaces",
    "how",
    "yourContractors",
    "pricing",
    "caseStudy",
    "founder",
    "portal",
    "faq",
    "finalCta",
    "reportJob",
  ], "fourteen sections, in the V3 order — `finalCta` is two components, a dark band and the form beneath it");
  assert.equal(new Set(sections).size, sections.length, "each exactly once");
  assert.equal(sections.at(-1), "reportJob", "Report a Job is the last thing above the footer");
  const componentFor = page.slice(page.indexOf("const SECTIONS"), page.indexOf("export default"));
  for (const key of sections) {
    assert.match(componentFor, new RegExp(`\\n  ${key}: `), `${key} must name the component that draws it`);
  }
  /* The two components of `finalCta`, still in that order and still one section. */
  assert.match(
    page,
    /finalCta: [^\n]*\n\s*<>\n\s*<TrustStrip \/>\n\s*<FinalCta copy=/,
    "the trust strip is the CTA panel's own heading and is drawn with it",
  );
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
   * WHAT DID NOT CHANGE — UNTIL 2026-11-25. Eight figures were pinned here as
   * named constants in `rates.ts` (the portfolio minimum, the included and
   * additional jobs, onboarding and its cap, the out-of-hours fee, the project
   * percentage and its minimum), each with the sentence that carried it to the
   * reader, because the risk of an edit that strips a qualifier is that it
   * strips the sentence around it too.
   *
   * RE-POINTED, on the owner's decision and not on a refactor. The published
   * plans are withdrawn and all eight figures went with them: every job is
   * priced individually, and `rates.ts` now holds the commercial terms as
   * sentences (`TERMS`). The claim those pins made survives and is held in its
   * new form — what a client is told about money is a named value in
   * `rates.ts`, never typed into the markup; it is now the sentence that is
   * named rather than the number. The eight constants are asserted GONE, so
   * a figure cannot come back by restoring one of them.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const rates = await read("app/(marketing)/_sections/rates.ts");

  /*
   * Comments stripped, exactly as the urgency-chip test does it. The note that
   * records why the qualifier went has to quote it, and a check that fails on
   * its own rationale would push the reasoning out of the file to make the test
   * pass — which is how a rule loses the only record of why it exists.
   */
  const rendered = pricing.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const figure of [
    "PORTFOLIO_MINIMUM",
    "INCLUDED_JOBS",
    "ADDITIONAL_JOB",
    "ONBOARDING_PER_STORE",
    "ONBOARDING_CAP",
    "OUT_OF_HOURS_P1",
    "PROJECT_PERCENT",
    "PROJECT_MINIMUM",
  ]) {
    assert.doesNotMatch(
      rates,
      new RegExp(`export const ${figure}\\b`),
      `${figure} was withdrawn with the published plans`,
    );
    assert.ok(!rendered.includes(figure), `and pricing.tsx no longer prints ${figure}`);
  }
  /* The terms that replaced them are named in `rates.ts` … */
  for (const term of ['perJob: "', 'callOut: "', 'noRepairVisit: "', "managedPlan: `"]) {
    assert.ok(rates.indexOf(term) > 0, `TERMS lost ${term}`);
  }
  /* … and each one still reaches the reader inside its sentence. */
  for (const sentence of [
    /\{TERMS\.perJob\} Nothing is booked until you approve it\./,
    /* The call-out terms are two points on their own card, one after the
       other, rather than a note. */
    /points: \[\s+TERMS\.callOut,\s+TERMS\.noRepairVisit,/,
    /<p className="pkgfine">\s*\{TERMS\.managedPlan\}/,
  ]) {
    assert.match(pricing, sentence, `${sentence} no longer reaches the page`);
  }

  assert.doesNotMatch(rendered, /\+\s*VAT/i, "no rendered string may carry + VAT");
  /*
   * RE-POINTED FROM THE WORD TO THE QUALIFIER, for the same reason as the
   * blanket check in `homepage-v3.test.mjs` — see the longer note there.
   *
   * "+ VAT" was withdrawn because it qualified a published price. What the
   * commercial update adds is the positive statement — the number quoted is
   * the number payable, and the company is not VAT registered — which is the
   * opposite of the claim that was removed and is the one a reader comparing
   * quotes needs. Banning the three letters outright made that sentence
   * unwriteable while catching nothing the qualifier checks miss.
   */
  const flat = rendered.replace(/\s+/g, " ");
  for (const qualifier of [/ex\.?\s*VAT/i, /exclud\w*\s+VAT/i, /plus\s+VAT/i, /subject\s+to\s+VAT/i]) {
    assert.doesNotMatch(flat, qualifier, "nor the same qualifier renamed");
  }
  for (const sentence of flat.match(/[^.]*\bVAT\b[^.]*\./gi) ?? []) {
    assert.match(
      sentence,
      /not currently VAT registered/i,
      "the only permitted mention is the company's registration status",
    );
  }
  /* RE-POINTED 2026-11-25 by one word: "Prices shown" became "Prices quoted",
     because the page shows none and the statement is about the price a
     customer is given. The statement itself, and the rule that it must be on
     the page, are unchanged. */
  assert.match(
    flat,
    /Prices quoted are the total payable\. MAINTSUPP LTD is not currently VAT registered\./,
    "and that statement must actually be on the page",
  );
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

test("no saving is claimed, because there are no two prices to compare", async () => {
  /*
   * RE-POINTED 2026-11-25, on the owner's decision. This held the badge —
   * "Most popular — save £20 per store" — to the arithmetic of the band table,
   * so that it could not come to contradict the cards above it, and it pinned
   * the approved rates at each band because they were quoted to clients.
   *
   * The published plans are withdrawn: there is no band table and there are
   * no two plans, so there is no saving of one against the other. The claim —
   * a saving is arithmetic over the prices on screen, never a typed figure —
   * is held in the only form left to it: NO saving is claimed. And the band
   * table is asserted gone rather than merely unused, because a badge that
   * came back without it would be a typed figure by definition.
   */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pricing = strip(await read("app/(marketing)/_sections/pricing.tsx"));
  const rates = strip(await read("app/(marketing)/_sections/rates.ts"));

  assert.deepEqual(
    [...rates.matchAll(/\b(?:essential|compliance|complete): (?:\d+|null)/g)].map((match) => match[0]),
    [],
    "no band rows are left in rates.ts",
  );
  assert.doesNotMatch(rates, /label: "/, "nor a band to label");
  for (const gone of ["saving", "save £", "Most popular", "band.essential", "pkg__flag"]) {
    assert.ok(!pricing.includes(gone), `pricing.tsx still carries ${gone}`);
  }
  /* The top band used to offer a review in place of a rate. A portfolio is
     still offered a conversation — on the managed plan's own line. */
  assert.match(
    pricing,
    /<Link href="\/contact">Ask us about a managed plan<\/Link>/,
    "a portfolio is still given a way to ask",
  );
});

test("no count is asked for, so no rate can be shown that a reader does not qualify for", async () => {
  /*
   * RE-POINTED 2026-11-25, on the owner's decision. The calculator was the
   * section's one input, and this held every number it produced to be derived
   * from the count: "if any of these stops being derived, the page can show a
   * reader a rate their own store count does not qualify for — which is worse
   * than showing no calculator at all."
   *
   * The decision took the second branch of that sentence. There is no
   * calculator, so what is held is that none of its parts survives on its own
   * to show a figure with nothing behind it.
   */
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pricing = strip(await read("app/(marketing)/_sections/pricing.tsx"));
  const rates = strip(await read("app/(marketing)/_sections/rates.ts"));
  for (const part of ['type="range"', "storeCount", "monthlyFor", "entryBand", "was={", "rateFor"]) {
    assert.ok(!pricing.includes(part), `pricing.tsx still carries ${part}`);
  }
  assert.doesNotMatch(rates, /bandForCount/, "and nothing is left to compute a band from a count");
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
 * Every point the cards make, in order.
 *
 * RE-POINTED THREE TIMES, and THE POINT OF THE LIST IS UNCHANGED: a rename, a
 * regrouping or a card being deleted must not be able to smuggle a dropped
 * line past it.
 *
 * First when the pricing rebuild renamed Coordination to Essential and Total
 * Care to Complete; then when the commercial update folded the standalone
 * Compliance Administration card into Complete. Now (2026-11-25) on the
 * owner's decision to withdraw the published plans altogether. The cards that
 * replaced the two plan cards do not describe a plan: they say how a job is
 * priced, what a call-out costs and what comes with it. So the list is those
 * nine points.
 *
 * Two of the nine are not strings but the shared terms, and are recorded here
 * by the name they are read from — which is itself the thing being pinned: the
 * call-out card must QUOTE the promise, not retype it.
 *
 * What the twelve plan features described — intake and triage, quote control,
 * certificate reminders — has not left the site. It is the Services and How it
 * works sections, which never depended on this table.
 */
const CARD_POINTS = {
  "per-job": [
    "You approve the price before anything is booked",
    "No subscription and no minimum term",
    "No minimum number of sites: one kiosk, one job",
  ],
  "call-out": [
    "TERMS.callOut",
    "TERMS.noRepairVisit",
    "Emergencies in London: the price and the attendance time before you commit.",
  ],
  portal: [
    "Live status for every job",
    "Before and after photographs",
    "Reports and documents in one place",
  ],
};

test("every point the cards make still exists, once, in the one table", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  /* RE-POINTED: the slice ran from the `FEATURES` table to `cardPoints`. The
     table is `CARDS` now and it ends where the component begins. */
  const table = pricing.slice(
    pricing.indexOf("const CARDS"),
    pricing.indexOf("export function Pricing"),
  );
  const cards = [...table.matchAll(/key: "([\w-]+)",[\s\S]*?points: \[([\s\S]*?)\],\n  \},/g)].map(
    ([, key, points]) => ({
      key,
      points: [...points.matchAll(/^\s+(?:"([^"]+)"|(TERMS\.\w+)),$/gm)].map(
        (match) => match[1] ?? match[2],
      ),
    }),
  );

  assert.deepEqual(
    cards.map((card) => card.key),
    Object.keys(CARD_POINTS),
    "the three cards, in order",
  );
  for (const card of cards) {
    assert.deepEqual(card.points, CARD_POINTS[card.key], `${card.key} lost or reordered a point`);
  }
  const all = cards.flatMap((card) => card.points);
  assert.equal(all.length, 9, "a point was added or dropped without this test moving");
  /* No point may be made twice — that is the defect a second card invites. */
  assert.equal(new Set(all).size, all.length);
  /* And nothing still claims a plan key. A row pointing at a plan would
     render nowhere, as it would have for the withdrawn compliance key. */
  assert.doesNotMatch(table, /plan: "/);
});

test("the cards render from that table, and the terms from rates.ts", async () => {
  /*
   * RE-POINTED, and the rule is the one it has always been: ONE copy of the
   * facts, however many places print them.
   *
   * It began as two presentations of one feature table — cards above 768px, a
   * matrix below it. The rebuild deleted the matrix; the commercial update
   * left two cards and a rate card over one band table. On 2026-11-25 the
   * owner withdrew the published plans, and the section is three cards over
   * `CARDS`, with the facts that matter most — the commercial terms — held one
   * level further out, in `rates.ts`, because the FAQ, /pricing and the London
   * pages print them too.
   *
   * So two things are pinned: the cards are drawn from the table rather than
   * typed into the markup, and every term on the section is a reference to
   * `TERMS`, never a second copy of the sentence.
   *
   * The £-literal check gets stricter again as a direct result. It forbade a
   * pound sign followed by a digit; the section now types no pound sign at all.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const uncommented = pricing.replace(/\/\*[\s\S]*?\*\//g, "");

  assert.match(pricing, /\{CARDS\.map\(\(card\) => \(/, "the cards are drawn from the one table");
  assert.match(
    pricing,
    /\{card\.points\.map\(\(point\) => \(/,
    "and so is every bullet on them",
  );
  assert.match(pricing, /<h3>\{card\.title\}<\/h3>/, "a card's heading is its entry's, not typed in the markup");
  assert.match(
    pricing,
    /import \{ TERMS \} from "\.\/rates";/,
    "the terms come from the one module that states them",
  );
  const body = uncommented.slice(uncommented.indexOf("export function Pricing"));
  for (const term of ["perJob", "managedPlan"]) {
    assert.ok(body.includes(`{TERMS.${term}}`), `the section must print TERMS.${term} by reference`);
  }
  /* The call-out terms reach the page as two points of the `CARDS` table, so
     that is where the reference is — and nowhere else in the file, because a
     note repeating the card above it was removed on purpose. */
  const table = uncommented.slice(uncommented.indexOf("const CARDS"), uncommented.indexOf("export function Pricing"));
  for (const term of ["callOut", "noRepairVisit"]) {
    assert.ok(table.includes(`TERMS.${term},`), `the call-out card must list TERMS.${term} by reference`);
    assert.ok(!body.includes(`TERMS.${term}`), `and the markup must not repeat TERMS.${term} beneath it`);
  }
  /* No sentence that `TERMS` states may be typed a second time in this file —
     that is how a card comes to make a promise the FAQ no longer makes. */
  const rates = await read("app/(marketing)/_sections/rates.ts");
  const sentences = [...rates.matchAll(/^\s{2}\w+: "([^"]+)",$/gm)].map((match) => match[1]);
  assert.equal(sentences.length, 3, "the three terms that are plain strings");
  for (const sentence of sentences) {
    assert.ok(!uncommented.includes(sentence), `"${sentence}" is typed here as well as in rates.ts`);
  }

  /* No figure anywhere in the file. */
  assert.doesNotMatch(uncommented, /£/, "no pound sign is typed into the section at all");
});

test("what a card says is stated in words, never in colour alone", async () => {
  /*
   * RE-POINTED from the matrix to the cards, and (2026-11-25) from the plan
   * cards to the three that replaced them.
   *
   * The matrix carried this contract because a tick in a table is a glyph, and
   * a glyph read out by a screen reader is nothing. The rebuild deleted the
   * matrix, so the contract moved to the presentation that replaced it: the
   * card bullet lists. It has not been dropped, and it has not been softened
   * — what a card tells a reader must still be a WORD, not a tint and not a
   * shape.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const uncommented = pricing.replace(/\/\*[\s\S]*?\*\//g, "");

  /* The matrix stays gone. If it comes back, it comes back with this test. */
  assert.doesNotMatch(pricing, /pmx/, "the comparison matrix was deleted, not hidden");
  const css = await read("app/(marketing)/marketing.css");
  assert.doesNotMatch(css, /pmx/, "and so were its styles");

  /* Each bullet is text. The tick beside it is decoration and says so, which
     is what stops a reader being told a card includes a checkmark. */
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

  /*
   * RE-POINTED. This pinned the band that carried no rate, which said "Book a
   * Portfolio Review" in words (`REVIEW`, drawn as `.pkg__talk`) rather than
   * showing an empty price and leaving the reader to infer it. No card has a
   * price line now, so there is no empty one to explain. What is held in its
   * place is the other half of "never in colour alone": no card is set apart
   * from the others by styling. The highlight and the flag that marked one
   * plan as the popular choice are gone, and nothing has replaced them,
   * because the three cards are not a choice.
   */
  for (const mark of ["is-match", "pkg__flag", "pkg__talk", "pkg__price"]) {
    assert.ok(!uncommented.includes(mark), `pricing.tsx still carries ${mark}`);
  }
  assert.match(
    pricing,
    /<article className="pkg" key=\{card\.key\}>/,
    "every card is the same element with the same class",
  );

  /* The block is a real landmark with a real heading. */
  assert.match(pricing, /<section className="section section--tint" id="pricing">/);
  /* RE-POINTED (decision L): the heading is `HOME_COPY.pricing.heading` now. The
     words are checked where they live and the section is checked to draw them. */
  assert.match(pricing, /<h2 className="h2">\{copy\.heading\}<\/h2>/, "and carries its heading");
  /* RE-POINTED 2026-11-25: it was "Simple per-store pricing. No hidden
     markups." — a heading for the published plans, withdrawn with them. */
  assert.match(
    await read("app/(marketing)/_sections/copy.ts"),
    /heading: "Pay per job\. The price is agreed before work starts\."/,
    "which is the shipped heading",
  );
  /*
   * RE-POINTED: the smaller option is no longer a card beside the choice, it
   * is a line of small print under it — and since 2026-11-25 the "smaller
   * option" is the managed plan rather than compliance-only administration.
   *
   * The structural claim is the one that survives and it is unchanged: the
   * offer that is not for every reader must be presented as something OTHER
   * than one more card, so nobody is asked to weigh it against the rest.
   */
  assert.doesNotMatch(pricing, /className="pkgalt"/, "the third card stays deleted");
  assert.doesNotMatch(css, /\.pkgalt/, "and so do its styles");
  assert.match(
    pricing,
    /<p className="pkgfine">/,
    "the managed plan is small print under the three cards",
  );
  assert.match(
    pricing,
    /\{TERMS\.managedPlan\} It adds one named coordinator, planned maintenance and/,
    "and says what it is",
  );
  /*
   * The rate card's landmark furniture — a labelled disclosure, a captioned
   * table, row headers — was pinned here. The rate card is withdrawn with the
   * rates, so there is nothing to label. The pins are kept as a condition
   * rather than deleted: a table that returns to this section returns with a
   * caption and row headers, or this fails.
   */
  if (/<table/.test(uncommented)) {
    assert.match(pricing, /<caption className="vh">/, "a table must be named for a screen reader");
    assert.match(pricing, /<th scope="row">/, "and its rows must be headed");
  } else {
    assert.doesNotMatch(uncommented, /<details|<summary/, "with no table there is no disclosure left to label");
  }
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
    if (!/\.(pkgs?|pkgalt|pkgfoot|pricing)\b/.test(selector)) continue;
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
  assert.ok(!/\bsla:/.test(form), "and the field is gone, so it cannot be rendered again");

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
  /* Re-pointed 2026-10-04 (owner decision): still pinned, now to one of TWO
     server-chosen workspaces — the primary client when the typed site is one of
     its stores, MAINTSUPP's Website Leads otherwise. Never the payload. */
  assert.match(
    route,
    /const primaryOrgId = PRIMARY_ORGANISATION_ID/,
    "the tenant is pinned, never taken from the payload or a cookie",
  );
  assert.match(route, /const orgId = site \? primaryOrgId : WEBSITE_LEADS_WORKSPACE_ID;/);
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
  /* RE-POINTED (decision J): the three in the chrome are now the utility bar,
     the header and the drawer — the frame, which is not editable. The footer's
     copy moved into the navigation staff edit, where it is the shipped label
     and a LOCKED link: it cannot be removed, hidden or pointed away from
     /portal. Both halves are asserted. */
  assert.ok(hits.length >= 3, `expected it in the utility bar, header and drawer; found ${hits.length}`);
  assert.match(chrome, /href="\/portal"/);
  assert.doesNotMatch(chrome, /Client Login/, "the brief names it Portal Login for a reason");
  const navigation = await read("app/lib/site-navigation.ts");
  assert.match(navigation, /\{ id: "ftr-portal", href: "\/portal", label: "Portal Login" \}/);
  assert.doesNotMatch(navigation, /Client Login/);
  const { LOCKED_LINKS } = await import("../app/lib/site-navigation.ts");
  assert.ok(LOCKED_LINKS.some((lock) => lock.id === "ftr-portal" && lock.href === "/portal"), "the footer's door is locked");
});

test("every nav anchor names a section that exists", async () => {
  /* RE-POINTED (decision J): the shared nav list is the SHIPPED navigation in
     `app/lib/site-navigation.ts` now — the fallback, and what an installation
     that never edits it shows. A stored navigation can only use anchors from
     `HOMEPAGE_ANCHORS`, and every one of those must be a section, below. */
  const chrome = await read("app/lib/site-navigation.ts");
  const nav = chrome.slice(chrome.indexOf("const NAV = ["), chrome.indexOf("] as const;"));
  /* RE-POINTED: the brief's four destinations and Contact Us are PAGES now
     (`/services` … `/contact`), each opening with the homepage section it used
     to scroll to. The claim is the same one — every menu entry lands somewhere
     real — so it is checked against the page files; any anchor still in the
     list is checked against the sections, as before. */
  const targets = [...nav.matchAll(/\["#([a-z-]+)"/g)].map((match) => match[1]);
  for (const target of targets) {
    assert.ok(ANCHORS.includes(target), `#${target} has no section`);
  }
  const pages = [...nav.matchAll(/\["\/([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(pages.length + targets.length >= 6, "four destinations from the brief, Contractors and Contact Us");
  assert.ok(pages.includes("contact"), "Contact Us opens /contact");
  for (const page of pages) {
    await read(`app/(marketing)/${page}/page.tsx`);
  }
  const { HOMEPAGE_ANCHORS } = await import("../app/lib/site-navigation.ts");
  for (const anchor of HOMEPAGE_ANCHORS) {
    assert.ok(ANCHORS.includes(anchor.id), `the editor offers #${anchor.id}, which has no section`);
  }

  /* And `#contact` is a real element, not a name in a list. It lives on the
     final CTA's inner wrapper, alongside the section's own `#review`, so both
     the nav item and every existing Book-a-Portfolio-Review link resolve. */
  const cta = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(cta, /id="contact"/, "#contact must exist in the markup");
  assert.match(cta, /<section className="section finalcta" id="review">/, "#review must still resolve");
  /* The footer's own Contact link moves with the nav; the CTA buttons do not. */
  const chromeSrc = await read("app/(marketing)/_sections/chrome.tsx");
  /* RE-POINTED at `SectionLink` — same destination, same position in the
     footer, now resolved against the page it is rendered on.
     RE-POINTED AGAIN (decision J): the entry is in the shipped footer data, and
     the chrome renders every footer entry through `SectionLink`. */
  /* RE-POINTED: the footer's Contact opens the /contact page, like the header. */
  assert.match(chrome, /\{ id: "ftr-contact", href: "\/contact", label: "Contact" \}/);
  assert.match(chromeSrc, /<SectionLink href=\{link\.href\}>\{link\.label\}<\/SectionLink>/);
  /* RE-POINTED: those two buttons book. They jumped to the enquiry panel while
     the hero and the final CTA opened the calendar, so the chrome's only CTA —
     the one on every page — asked a visitor who had decided to book a slot to
     write a message instead. `#review` is still a real section, asserted just
     above, and still reachable; it is no longer what these two do. */
  assert.ok(
    (chromeSrc.match(/href=\{BOOKING_URL\}/g) ?? []).length >= 2,
    "the header and drawer Book a Portfolio Review buttons open the booking link",
  );
  assert.match(
    chromeSrc,
    /import \{ BOOKING_IS_EXTERNAL, BOOKING_URL \} from "\.\/content";/,
    "from the one constant, not a second typed copy",
  );
});

test("the footer carries the legal line verbatim", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  for (const fragment of [
    "MAINTSUPP LTD",
    "company no. 17262302",
    "Registered office: 37th Floor, One Canada Square, London, E14 5AA.",
  ]) {
    assert.ok(
      chrome.replace(/&amp;/g, "&").includes(fragment),
      `the legal line is missing: ${fragment}`,
    );
  }
});

test("the footer no longer names the accountant c/o line", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  assert.ok(!chrome.includes("MJR"), "the C/O MJR line must not appear");
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
