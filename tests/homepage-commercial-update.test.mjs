/**
 * The commercial update, as a test — §10 of the brief, executable.
 *
 * The brief that drove this change ends with an audit checklist: ten things a
 * person is told to confirm before publishing. Every one of them is a property
 * of the page rather than an opinion about it, so every one of them is here
 * instead of in somebody's memory.
 *
 * WHY A NEW FILE RATHER THAN MORE OF `homepage-v3`. That suite holds the
 * structural contracts of the page — one price table, no VAT qualifier, the
 * FAQ shared rather than copied, every anchor resolving. Those are rules about
 * the SHAPE of the site and they outlive any particular price list. This file
 * holds the COMMERCIAL facts: the rates, the bands, the allowances, the
 * destinations. They will change again, and when they do it should be obvious
 * which file to edit and which to leave alone.
 *
 * THE TERMS ARE QUOTED HERE ON PURPOSE. This paragraph used to read "the
 * figures are computed, not copied": the page printed rates, and the
 * expectations were derived from `rates.ts` so this file could not drift from
 * it. RE-POINTED 2026-11-25, on the owner's decision: the published monthly
 * plans are withdrawn and the page prints no figure at all — every job is
 * priced individually (`rates.ts` records the decision). What a client is told
 * is now four sentences (`TERMS`) and one count (the size of portfolio the
 * managed plan starts at). Those are typed below, once, for the reason the
 * approved rate table was: they are what a client is told, and a test that
 * derived them from the code could never catch the code being wrong.
 * Everything else still derives — from `TERMS`, never from a second copy. The
 * other typed exceptions are unchanged: the three destination addresses and
 * the forbidden list, which has only grown.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const SECTIONS = "app/(marketing)/_sections";

/** Source with comments removed, so a note explaining a withdrawal is not the thing. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every TypeScript source the marketing site is built from, as [name, source]. */
async function marketingSources() {
  const out = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.tsx?$/.test(entry.name)) out.push([next, await read(next)]);
    }
  };
  await walk("app/(marketing)");
  return out;
}

/* `rates.ts` imports nothing, so it transpiles and loads on its own. */
const rates = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(await read(`${SECTIONS}/rates.ts`), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

/**
 * React splits a static string from the interpolation beside it with an empty
 * comment, so "£300" arrives as "£<!-- -->300". Every check below reads the
 * text a person sees, not the markup that produced it.
 */
const asText = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

async function page(pathname = "/") {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(response.status, 200, `${pathname} did not render`);
  return asText(await response.text());
}

async function serverIsUp() {
  try {
    return (await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(20_000) })).ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* §1 — the commercial terms (the rate card is withdrawn)              */
/* ------------------------------------------------------------------ */

/*
 * RE-POINTED 2026-11-25, ON THE OWNER'S DECISION AND NOT ON A REFACTOR.
 *
 * Six tests stood here and held the approved rate card: the rates at each
 * band, the £20 rule between the two plans, the £325 minimum against the entry
 * rate, the slider's floor, `bandForCount`, and the brief's table of monthly
 * totals. All six protected ONE contract — that what a client is quoted is the
 * approved thing, and that every place it is printed agrees.
 *
 * The owner withdrew the published monthly plans (decided 2026-11-19, released
 * 2026-11-25; the header of `rates.ts` records it). Every job is now priced
 * individually, so the page prints no rate, no band and no total. The contract
 * did not go away; its subject changed. What a client is quoted is now four
 * sentences, and the same two failures are still possible: a sentence that is
 * not the approved one, and two places that word it differently. The tests
 * below hold those, one for one:
 *
 *   the approved rates           → the approved terms, word for word
 *   Complete is £20 below …      → the call-out promise keeps its condition
 *   the minimum × the entry rate → the managed plan's size and its sentence
 *   the selector's floor         → there is no selector to describe a portfolio
 *   bandForCount                 → `rates.ts` exports no rate machinery at all
 *   the brief's monthly totals   → no rate, band or total reaches the source
 */

test("the approved terms, exactly as they are quoted to clients", () => {
  /*
   * The one place in this file that types the terms. Everything else derives
   * from `TERMS`, and deriving these too would be a test asserting that a
   * sentence equals itself.
   */
  assert.deepEqual(
    { ...rates.TERMS },
    {
      perJob: "Every job is priced individually, and you have the price before any work is booked.",
      callOut: "No call-out charge when we carry out the repair.",
      noRepairVisit: "A visit with no repair to follow is priced before anyone attends.",
      managedPlan: "A managed monthly plan is available on request for portfolios of five sites and above.",
    },
  );
});

test("the call-out promise keeps its condition, everywhere it is made", async () => {
  /*
   * The owner chose the form on 2026-11-25: no call-out charge WHEN THE REPAIR
   * IS CARRIED OUT, and a visit with no repair to follow is priced before
   * anyone attends. An unconditional "no call-out fee" is a different and more
   * expensive promise — the contractor who attends and repairs nothing is still
   * paid — and it is one edit away wherever the sentence is shortened to fit a
   * heading.
   *
   * Two things are held. Where the term is QUOTED from `TERMS`, its other half
   * is quoted in the same file the same number of times. Where it is RESTATED
   * in running copy — a card title, a lede, a meta description, none of which
   * can take a capitalised sentence — the condition is still attached.
   */
  let quoted = 0;
  for (const [name, source] of await marketingSources()) {
    const body = code(source).replace(/\s+/g, " ");
    const first = (body.match(/TERMS\.callOut\b/g) ?? []).length;
    const second = (body.match(/TERMS\.noRepairVisit\b/g) ?? []).length;
    assert.equal(first, second, `${name} quotes one half of the call-out terms without the other`);
    quoted += first;

    for (const [claim] of body.matchAll(/no call-out (?:charge|fee)s?[^.`"<]*/gi)) {
      assert.match(
        claim,
        /(?:when we carry out|with) the repair/i,
        `${name} makes the promise unconditional: "${claim}"`,
      );
    }
  }
  assert.ok(
    quoted >= 5,
    "the pricing card, the cost FAQ, /pricing and both sets of London pages all quote it",
  );
});

test("the managed plan's size and the sentence that states it cannot contradict each other", async () => {
  /*
   * Was §10.3: £325 had to equal 5 × £65, or the calculator's readout and the
   * footnote beneath it said different things about the same portfolio. The
   * figures are withdrawn. The one number with a commercial meaning still
   * stated on the site is the size of portfolio the managed plan starts at, and
   * the same defect is still available: a count typed into a sentence, beside
   * a constant that comes to say something else.
   */
  assert.equal(rates.MANAGED_PLAN_MINIMUM_SITES, 5);
  assert.equal(rates.inWords(rates.MANAGED_PLAN_MINIMUM_SITES), "five");
  assert.match(
    await read(`${SECTIONS}/rates.ts`),
    /managedPlan: `A managed monthly plan is available on request for portfolios of \$\{inWords\(MANAGED_PLAN_MINIMUM_SITES\)\} sites and above\.`/,
    "the sentence interpolates the constant, so the two cannot drift",
  );
  /* And nobody else types the count: every other mention is that sentence, or
     the constant put into words. */
  for (const [name, source] of await marketingSources()) {
    if (name.endsWith("/rates.ts")) continue;
    assert.doesNotMatch(
      code(source),
      /\b(?:five|5)(?: or more)? (?:sites|stores)\b/i,
      `${name} types the managed plan's size instead of reading it from rates.ts`,
    );
  }
});

test("the section has no selector, so it cannot describe a portfolio at all", async () => {
  /* Was §10.2: the slider's floor had to be the five-site minimum. With no
     published plan there is nothing for a reader to size, and a control that
     asks "how many stores?" on a page that sells one job would be the old page
     back. The stronger form of "the floor is five" is that there is no floor,
     because there is no control. */
  const pricing = code(await read(`${SECTIONS}/pricing.tsx`));
  for (const control of ['type="range"', "<input", "<select", "<button", "useState", "storeCount", "switcher"]) {
    assert.ok(!pricing.includes(control), `pricing.tsx still carries ${control}`);
  }
});

test("rates.ts exports the terms and one count, and no rate machinery", async () => {
  /* Was the `bandForCount` table. The function, the bands it chose between and
     every constant that carried a price are gone; listing the module's whole
     surface is what stops one of them coming back unnoticed. */
  assert.deepEqual(Object.keys(rates).sort(), ["MANAGED_PLAN_MINIMUM_SITES", "TERMS", "inWords"]);
  const source = code(await read(`${SECTIONS}/rates.ts`));
  assert.doesNotMatch(source, /£/, "no currency sign");
  assert.deepEqual(
    [...source.matchAll(/export const (\w+) = \d/g)].map((match) => match[1]),
    ["MANAGED_PLAN_MINIMUM_SITES"],
    "one exported number, and it is a count of sites rather than a price",
  );
});

/**
 * The words the withdrawn plans were priced in, by their distinguishing phrase.
 *
 * Narrow on purpose. "per store" alone is not here ("a WhatsApp group per
 * store" is a sentence the page still needs), and neither is "coordinated
 * jobs" (the London pages say where jobs have been coordinated). Each entry is
 * a phrase that only a published plan, its rate card or its terms ever used.
 */
const WITHDRAWN_PLAN_WORDS = [
  "per store per month",
  "per store / month",
  "per-store pricing",
  "per-store rates",
  "Portfolio minimum",
  "coordination fee",
  "coordinated jobs per store",
  "monthly coordination plan",
  "rate card",
  "initial term",
  "Onboarding and asset capture",
  "out-of-hours fee",
  "published on this page",
  "published on the pricing page",
  "no markup on trades",
  "never mark up",
  "Most popular",
  "Bespoke",
];

test("no rate, band or total reaches the source the page is built from", async () => {
  /*
   * Was §1.4's table of monthly totals, checked against rate × count. There is
   * no arithmetic left to check, so what is held is its absence, across every
   * file a visitor's page is built from and not only the two the older
   * withdrawn-strings test reads: the London pages and `/pricing` quoted the
   * plans as well. (`homepage-v3` separately refuses a pound sign followed by
   * a digit across the same tree.)
   */
  for (const [name, source] of await marketingSources()) {
    const body = code(source).replace(/\s+/g, " ");
    for (const gone of WITHDRAWN_PLAN_WORDS) {
      assert.ok(!body.includes(gone), `${name} still says "${gone}"`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* §1.7 — what must no longer be on the page                           */
/* ------------------------------------------------------------------ */

/**
 * The withdrawn strings, quoted from §1.7 of the brief — and, since
 * 2026-11-25, every figure the page printed after it.
 *
 * "£55" and "21 stores" were excluded from the first list deliberately: £55 was
 * forbidden only "as a headline tier price" and was the compliance-only rate,
 * and "21 stores" was forbidden in the pricing totals but kept in the hero chip
 * and the case study. "£65" and "save £20 per store" were then REMOVED from
 * the list on 2026-10-08, when the owner raised Essential by 5 at every band
 * and they became live prices.
 *
 * ALL OF THOSE EXCEPTIONS ENDED ON 2026-11-25. The owner withdrew the
 * published plans, so there is no live price for an exception to protect: the
 * rates at every band, the minimum, the onboarding, out-of-hours and project
 * figures and the saving badge are all in the list now. ("21 stores" is still
 * not: it is a description of a portfolio, not a price.)
 */
const WITHDRAWN = [
  "£85",
  "£90",
  "£275",
  "£125",
  "2 coordinated jobs",
  "3 coordinated jobs",
  "1–5 stores",
  "1–4 stores",
  "waived on a 12-month term",
  "Waived on a 12-month term",
  "£375 at 5 stores",
  /* Withdrawn 2026-11-25 with the published plans. */
  "£65",
  "£61",
  "£57",
  "£100",
  "£92",
  "£84",
  "£55",
  "£51",
  "£47",
  "£325",
  "£75",
  "£1,200",
  "£95",
  "£350",
  "save £",
  "Essential from",
  "Complete from",
  "See the full rate card",
  "What if we only have three or four sites?",
];

test("none of the withdrawn pricing strings survives in the source", async () => {
  const pricing = code(await read(`${SECTIONS}/pricing.tsx`));
  const content = code(await read(`${SECTIONS}/content.ts`));
  for (const withdrawn of WITHDRAWN) {
    assert.ok(!pricing.includes(withdrawn), `pricing.tsx still says "${withdrawn}"`);
    assert.ok(!content.includes(withdrawn), `content.ts still says "${withdrawn}"`);
  }
});

/* ------------------------------------------------------------------ */
/* §1.2–1.6 — the shape of the section                                 */
/* ------------------------------------------------------------------ */

test("three cards, none of them a plan, and the managed plan is small print beneath them", async () => {
  /*
   * RE-POINTED 2026-11-25. This was §10.5 — "two cards, and compliance-only is
   * small print beneath them" — and what it protected was the SHAPE of the
   * decision: a reader chooses between exactly the things the business sells,
   * and anything else is a sentence rather than another card.
   *
   * The business now sells one thing, a job at a price agreed first, so the
   * cards are no longer a choice at all: they are the three things every job
   * gets. The shape is held the same way. The cards are these three, in this
   * order; and the one offer that is not for everybody, the managed plan, is
   * small print quoting `TERMS` rather than a fourth card.
   */
  const pricing = await read(`${SECTIONS}/pricing.tsx`);
  const body = code(pricing);
  const cards = [...body.matchAll(/^\s{4}key: "([\w-]+)",\n\s{4}title: "([^"]+)",$/gm)].map(
    (match) => [match[1], match[2]],
  );
  assert.deepEqual(
    cards,
    [
      ["per-job", "Priced per job"],
      ["call-out", "No call-out charge with the repair"],
      ["portal", "Portal included"],
    ],
    "exactly three cards, in this order",
  );
  for (const plan of ['key: "essential"', 'key: "complete"', "COMPLIANCE_PLAN", 'className="pkgalt"', "is-match", "pkg__flag"]) {
    assert.ok(!body.includes(plan), `the withdrawn plan furniture is back: ${plan}`);
  }
  assert.match(
    pricing,
    /<p className="pkgfine">\s*\{TERMS\.managedPlan\}/,
    "the managed plan survives as small print, in the shared words",
  );
});

test("§4.2's question is in the source, not only on a running server", async () => {
  /* The live half of this file skips without a dev server, so a question pinned
     only there is a question nothing protects in CI. */
  const content = await read(`${SECTIONS}/content.ts`);
  /*
   * RE-POINTED TWICE, both times on the owner's decision and not on a rewording.
   *
   * §4.2 added "What if we only have three or four sites?" to turn a small
   * operator away from the monthly plan in plain words. October 2026 kept that
   * refusal and changed the alternative it offered, when one-off jobs began.
   * On 2026-11-25 the published plans were withdrawn altogether. There is no
   * plan left for a reader to be too small for, so the entry now carries the
   * question a single shop actually asks — "Is there a minimum number of
   * sites?" — and the answer is no.
   *
   * What §4.2 existed to protect is still asserted, in its new form: the page
   * says in plain words who the offer is for; it states the one size limit
   * that remains, the managed plan's, from the constant rather than a typed
   * number; and it never sends the one-off job away.
   */
  assert.match(content, /"q": "Is there a minimum number of sites\?"/);
  assert.doesNotMatch(
    code(content),
    /What if we only have three or four sites\?/,
    "the question it replaced is gone, not kept beside it",
  );
  assert.match(content, /No\. One shop or one kiosk with one job is enough/);
  assert.match(content, /each job is priced before work starts/);
  assert.match(content, /The only thing with a minimum is the managed monthly plan/);
  assert.doesNotMatch(
    code(content),
    /the monthly plan is not for you yet/,
    "nobody is turned away from a plan the page no longer sells",
  );
  assert.doesNotMatch(
    content,
    /better served calling trades directly/,
    "the answer must not turn away the one-off job the business now takes",
  );
  const costAt = content.indexOf('"q": "What does it cost?"');
  const newAt = content.indexOf('"q": "Is there a minimum number of sites?"');
  assert.ok(costAt > 0, "the cost answer is still there");
  assert.ok(newAt > costAt, "and the new one sits after it");
  /* Immediately after: nothing between the two entries but the closing brace
     and the opening of the next. */
  assert.ok(
    content.slice(costAt, newAt).split('"q": "').length === 2,
    "immediately after — no other question was inserted between them",
  );

  /*
   * §4.1's answer used to interpolate two counts so that the sentence did not
   * become a second typed copy of a number. The same rule now covers whole
   * sentences: the cost answer QUOTES all four terms, so the FAQ, the pricing
   * cards, /pricing and the London pages cannot word the offer four ways.
   */
  const cost = code(content.slice(costAt, newAt));
  for (const term of ["perJob", "callOut", "noRepairVisit", "managedPlan"]) {
    assert.ok(
      cost.includes(`\${TERMS.${term}}`),
      `the cost answer must quote TERMS.${term}, never restate it`,
    );
  }
  assert.match(
    content,
    /portfolios of \$\{inWords\(MANAGED_PLAN_MINIMUM_SITES\)\} sites and above/,
    "and the minimum in the answer beneath it is the constant, in words",
  );
  assert.equal(rates.inWords(rates.MANAGED_PLAN_MINIMUM_SITES), "five");
});

test("there is no rate card left to disclose, and none can come back half-built", async () => {
  /*
   * RE-POINTED 2026-11-25. §1.5 and §10.10 put the full rate card behind the
   * page's own `<details>` and made its table scroll inside its own box rather
   * than widening the document. The rate card is withdrawn with the rates, so
   * the first half of the claim is now its absence.
   *
   * The second half is kept as a condition rather than dropped. The stylesheet
   * rules were left in place, unused, when the markup went; if a table ever
   * returns to this section it has to return scrolling in its own box, and the
   * two assertions that guaranteed that are still here waiting for it.
   */
  const pricing = code(await read(`${SECTIONS}/pricing.tsx`));
  for (const gone of ["<details", "<summary", "<table", "ratecard"]) {
    assert.ok(!pricing.includes(gone), `pricing.tsx still carries ${gone}`);
  }
  assert.ok(!pricing.includes("useState"), "and a section with nothing to open needs no state");

  const css = await read("app/(marketing)/marketing.css");
  if (css.includes(".ratecard{")) {
    assert.match(css, /\.ratecard__scroll\{overflow-x:auto/, "the table scrolls, the page does not");
    const block = css.slice(css.indexOf(".ratecard{"), css.indexOf(".ratecard__note"));
    assert.doesNotMatch(block, /min-width:\s*\d+px/, "nothing in it may force the page wide");
  }
});

test("every note the offer depends on is on the page, and none of the plan's", async () => {
  /*
   * RE-POINTED 2026-11-25. The brief's twelve footnotes were the terms of the
   * monthly plan: its minimum, its included jobs, its onboarding and
   * out-of-hours fees, its term. The plan is no longer published, so its terms
   * are no longer printed. The five notes that replaced them are the terms of
   * a single job, and they are held the same way and for the same reason — a
   * note is where an edit strips a qualifier and takes the sentence with it.
   * (The call-out terms are not among them on purpose: they are the second
   * card, directly above the list, and are pinned there.)
   *
   * Two of them carried over. Office hours are the same hours under a plainer
   * label, and the VAT statement is the same statement with one word changed:
   * "Prices shown" became "Prices quoted", because the page shows none.
   */
  const pricing = await read(`${SECTIONS}/pricing.tsx`);
  const notes = pricing
    .slice(pricing.indexOf('<ul className="pricing__notes">'))
    .replace(/\s+/g, " ");
  for (const fragment of [
    "{TERMS.perJob} Nothing is booked until you approve it.",
    "projects are scoped and quoted separately",
    'To get a price, <Link href="/#report">report the job</Link> with a photograph',
    "Office hours Mon–Fri, 8:30am–5:30pm. Emergencies in London, 24 hours.",
    "Prices quoted are the total payable. MAINTSUPP LTD is not currently VAT registered.",
  ]) {
    assert.ok(notes.includes(fragment), `the notes lost "${fragment}"`);
  }
  /* The plan's own terms, by their distinguishing clause — and the two that
     were already withdrawn before them. */
  for (const gone of [
    "coordinates portfolios of five sites and above",
    "coordinated jobs per store per month",
    "exceeds its allowance for two consecutive quarters",
    "Onboarding and asset capture",
    "Out-of-hours and P1 escalation",
    "Sites added mid-term are charged pro-rata",
    "Three-month initial term, then 30 days",
    "Contractor invoices are separate",
    "Final quote confirmed at your free portfolio review",
    "Compliance pricing assumes a standard retail asset profile",
    "out-of-hours P1 incidents",
  ]) {
    assert.ok(!code(pricing).includes(gone), `"${gone}" was withdrawn with the plan, not kept`);
  }
});

/* ------------------------------------------------------------------ */
/* §2, §3, §9 — booking, the form, the nav                             */
/* ------------------------------------------------------------------ */

test("the booking link is one constant, and never a dead calendar", async () => {
  /* §10.7. Two typed copies of a booking URL is one that can be changed and one
     that cannot, and the one left behind sends people to a dead calendar.

     The constant was pinned to `https://cal.com/maintsupp/portfolio-review`,
     which 404s — the pin held the typo in place, because it asserted that the
     string had not changed and nothing about whether it could be booked. The
     slug on the account is `portfolio-review-30-minutes`; that is what is
     pinned now, and the deployment can override it without a release. */
  const content = await read(`${SECTIONS}/content.ts`);
  assert.match(
    content,
    /export const BOOKING_URL =\s*process\.env\.NEXT_PUBLIC_BOOKING_URL\?\.trim\(\) \|\|\s*"https:\/\/cal\.com\/maintsupp\/portfolio-review-30-minutes";/,
    "the verified event, overridable by the deployment",
  );
  assert.ok(
    !code(content).includes("cal.com/maintsupp/portfolio-review\""),
    "not the slug that 404s",
  );
  for (const file of ["hero.tsx", "final-cta.tsx"]) {
    const source = await read(`${SECTIONS}/${file}`);
    assert.match(
      source,
      /import \{ BOOKING_IS_EXTERNAL, BOOKING_URL \} from "\.\/content";/,
      `${file} imports it`,
    );
    assert.match(
      code(source),
      /href=\{BOOKING_URL\}[\s\S]{0,160}?target=\{BOOKING_IS_EXTERNAL \? "_blank" : undefined\}[\s\S]{0,120}?rel=\{BOOKING_IS_EXTERNAL \? "noopener noreferrer" : undefined\}/,
      `${file} opens an external calendar in a new tab, safely, and an anchor in this one`,
    );
    assert.ok(
      !code(source).includes("https://cal.com"),
      `${file} must not type the URL a second time`,
    );
  }
});

test("the enquiry form takes a portfolio of any size, smallest first, and still takes the enquiry", async () => {
  /*
   * RE-POINTED 2026-11-25. §3 and §10.6 made the form's options the pricing
   * bands, plus "Fewer than 5" as "the honest way to say no". Both halves went
   * with the published plans: there are no bands left to match, and nobody is
   * under a floor.
   *
   * What the test protected is still held. The options are not invented: the
   * four larger ranges are the ones a portfolio lead has always arrived in,
   * and the one boundary with a commercial meaning — where the managed plan
   * starts — is exactly where the new smallest range ends. And the option that
   * gets a note is still an option that submits.
   */
  const form = await read(`${SECTIONS}/final-cta.tsx`);
  /* Sliced to the END OF THE DECLARATION, not to a byte count — a comment or a
     longer label above it must not be able to truncate what is compared. */
  const from = form.indexOf("const SITE_RANGES = [");
  const ranges = form.slice(from, form.indexOf("] as const;", from));
  assert.match(ranges, /^const SITE_RANGES = \[SMALLEST_RANGE, "/, "the smallest size is offered first");
  const larger = [...ranges.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    larger,
    ["5–10", "11–25", "26–50", "51+"],
    "the four larger ranges are unchanged, so a portfolio lead still arrives in the same words",
  );
  assert.doesNotMatch(code(form), /UNDER_MINIMUM|Fewer than 5/, "nobody is under a minimum any more");

  /* The smallest range ends where the managed plan begins, read from the one
     place that states it. */
  const floor = rates.MANAGED_PLAN_MINIMUM_SITES;
  assert.ok(form.includes(`const SMALLEST_RANGE = "1–${floor - 1}";`), "it stops one short of the managed plan");
  assert.ok(larger[0].startsWith(`${floor}–`), "and the next range starts at it");

  /* It says yes, points at the quicker form, and still takes the enquiry. */
  assert.match(form, /sites === SMALLEST_RANGE/);
  assert.match(form, /One site is enough\./);
  /* A link to `/#report`, not `#report` and not "on this page": this form is
     also the whole of /contact, where the report form is not on the page. */
  assert.match(form, /<Link href="\/#report">Report a Job<\/Link> is the quickest way/);
  assert.match(form, /className="field__note" aria-live="polite"/, "and says so out loud");
  assert.doesNotMatch(
    code(form),
    /coordinates portfolios of five sites and above/,
    "the refusal it replaced is gone",
  );
  assert.doesNotMatch(
    code(form),
    /sites === SMALLEST_RANGE[\s\S]{0,200}?(return|setError|disabled)/,
    "choosing it must not block the submit",
  );
});

test("the nav carries Contractors, and it is a route rather than an anchor", async () => {
  const chrome = await read(`${SECTIONS}/chrome.tsx`);
  /* RE-POINTED (decision J): the header's links became data that platform
     staff edit, and the list that ships — the fallback when nothing is stored
     or the database cannot answer — moved to `app/lib/site-navigation.ts`,
     because a server module cannot read a value out of a "use client" file.
     The claim is unchanged: Contractors is in the shipped nav, as a route. */
  const navigation = await read("app/lib/site-navigation.ts");
  assert.match(navigation, /\["\/contractors", "Contractors"\]/);
  assert.match(chrome, /const isAnchor = \(href: string\) => href\.startsWith\("#"\);/);
  /*
   * RE-POINTED: one component now decides `<a>` versus `<Link>`, and the rule
   * it applies is the one this test was asserting at each call site.
   *
   * These pinned the desktop nav rendering a route through `next/link` and the
   * drawer handing a route `setOpen(false)` rather than the deferred-hash
   * handler. Both were spelled out inline at nineteen call sites, and all
   * nineteen were also emitting section hashes that are dead on every page
   * except the homepage. `SectionLink` resolves the href for the current page
   * and then picks the element, so the claim is checked once, where it is now
   * made — and checked more strictly: the anchor handler must reach ONLY the
   * in-page branch, which the old per-site pins could not express.
   */
  assert.match(chrome, /<SectionLink className="nav__link" href=\{href\}>/, "the nav renders through it");
  const link = chrome.slice(chrome.indexOf("function SectionLink"));
  assert.match(link.slice(0, 1400), /const resolved = sectionHref\(href\);/);
  assert.match(
    link.slice(0, 1400),
    /if \(isAnchor\(resolved\)\) \{[\s\S]*?<a className=\{className\} href=\{resolved\} onClick=\{onAnchorClick\}/,
    "a hash on this page is a plain anchor and keeps the deferred-hash handler",
  );
  assert.match(
    link.slice(0, 1400),
    /<Link className=\{className\} href=\{resolved\} onClick=\{onNavigate\}/,
    "anything that is a route goes through next/link and never sees onAnchorClick",
  );
});

/* ------------------------------------------------------------------ */
/* §5, §6, §7, §8 — the strip, the destinations, the domain, the mock  */
/* ------------------------------------------------------------------ */

test("the trust strip makes no claim it cannot evidence", async () => {
  /* §5. Searched against the ICO's own public register by name on 15 September
     2026 for "Maintauk", "MAINTAUK LTD" and "Maintsupp": no entries. On a site
     selling compliance administration this is the worst place for an
     unverifiable claim. */
  const cta = await read(`${SECTIONS}/final-cta.tsx`);
  const claims = code(cta.slice(cta.indexOf("const CLAIMS = ["), cta.indexOf("export function TrustStrip")));
  assert.ok(!claims.includes("ICO registered"));
  assert.ok(!claims.includes("Data protection"));
  assert.equal((claims.match(/title: "/g) ?? []).length, 3);
});

test("each form goes where the brief sends it, with the subject it asks for", async () => {
  /* §6 and §10.8. The three addresses are typed here on purpose: they are what
     a client's mail lands in, and deriving them from the code would make this
     a test that the code equals itself. */
  const notifications = await read("app/lib/notifications.ts");
  assert.match(notifications, /source\.NOTIFY_OPS \?\? "operations@maintsupp\.com"/);
  /* Re-pointed 2026-10-03 (owner's decision): the contact inbox is the address
     the website prints, info@, where it was anwar@. Still three inboxes, still
     no shared fallback — the assertions below are unchanged. */
  assert.match(notifications, /source\.NOTIFY_SALES \?\? "info@maintsupp\.com"/);
  assert.match(notifications, /source\.NOTIFY_FROM \?\? "MAINTSUPP <admin@maintsupp\.com>"/);
  /* And an inbox may name several people, comma-separated. */
  assert.match(notifications, /to: splitRecipients\(to\),/);
  const { splitRecipients } = await import("../app/lib/notifications.ts").catch(() => ({}));
  if (splitRecipients) {
    assert.deepEqual(splitRecipients("info@maintsupp.com, anwar@maintsupp.com;"), [
      "info@maintsupp.com",
      "anwar@maintsupp.com",
    ]);
    assert.deepEqual(splitRecipients("info@maintsupp.com"), ["info@maintsupp.com"]);
  }
  assert.match(notifications, /source\.NOTIFY_CONTRACTORS \?\? "admin@maintsupp\.com"/);
  /*
   * NO SHARED FALLBACK. `opsInbox` used to fall back to `salesInbox`, so a
   * broken shutter and a portfolio enquiry landed in the same place and the
   * urgent one waited behind the other. Each default is its own address.
   */
  assert.doesNotMatch(notifications, /NOTIFY_OPS \?\? salesInbox/);

  assert.match(notifications, /subject: `\[LEAD\] /, "the enquiry subject is filterable");
  assert.match(notifications, /\[JOB\] \$\{job\.site/, "so is the job subject");
  const contractor = await read("app/api/contractor-applications/route.ts");
  assert.match(contractor, /const \{ contractorInbox \} = notificationTargets\(\);/);
  assert.match(contractor, /subject: `\[CONTRACTOR\] \$\{company\}`/);
});

test("the duplicate Vercel hostname redirects, and Preview deployments do not", async () => {
  /*
   * §7. `maintsupp-portal.vercel.app` is an alias of the SAME production
   * deployment that serves maintsupp.com, so every page was reachable at two
   * addresses with no canonical between them.
   *
   * THE EXACT-MATCH RULE IS THE LOAD-BEARING PART. Preview deployments are
   * `maintsupp-portal-<hash>-maintsupp.vercel.app`; a suffix match would bounce
   * every one of them to production and make Preview QA — which is how this
   * project verifies every release — impossible.
   */
  const worker = await read("worker/index.ts");
  assert.match(worker, /const DUPLICATE_HOST = "maintsupp-portal\.vercel\.app";/);
  /*
   * AND THE PRE-DEPLOY HARNESS MUST NOT PROBE THAT HOST.
   *
   * `vercel/local-check.mjs` drives the BUILT function in-process against real
   * Postgres and sets `host:` on every probe. It was set to
   * `maintsupp-portal.vercel.app` — the very hostname this redirect now
   * catches — so every probe would have answered 301 with a zero-byte body
   * while the script, which exits 0 regardless, printed a tidy table and
   * reported success. A verification harness that silently stops verifying is
   * worse than none, so the two are pinned against each other here.
   */
  const check = await read("vercel/local-check.mjs");
  const host = /const HOST = "([^"]+)";/.exec(check);
  assert.ok(host, "local-check must declare the host it probes");
  assert.notEqual(host[1], "maintsupp-portal.vercel.app", "the harness must not probe the redirected host");
  assert.equal(host[1], "maintsupp.com", "it probes the canonical host");
  /* RE-POINTED from www to the apex. Production moved to the apex and this pin was
     not followed, so it has been failing against correct code ever since. Measured
     on the live project: `maintsupp.com` carries no redirect and
     `www.maintsupp.com` 308s to it, so the apex is the host the worker should
     canonicalise ON to. Corroborated by `public/sitemap.xml`, which is apex-only
     and whose own test refuses any `://www.` entry. */
  assert.match(worker, /const CANONICAL_ORIGIN = "https:\/\/maintsupp\.com";/);
  assert.match(worker, /url\.hostname === DUPLICATE_HOST/, "an exact host match, never a suffix");
  /* Comments stripped: the note above the constant has to name the mistake it
     is warning against, and a check that fails on its own rationale pushes the
     reasoning out of the file to make the test pass. */
  assert.doesNotMatch(
    code(worker),
    /endsWith\("\.vercel\.app"\)/,
    "a suffix match would break Preview QA",
  );
  assert.match(worker, /status: 301/);
  assert.match(
    worker,
    /Location: `\$\{CANONICAL_ORIGIN\}\$\{url\.pathname\}\$\{url\.search\}`/,
    "the path is kept, so a deep link is not thrown away",
  );

  /* And a preview is not a second copy of the site for a crawler to index. */
  assert.match(worker, /function isUnindexableDeployment/);
  assert.match(worker, /target !== "" && target !== "production"/, "only a known non-production env");
  assert.match(worker, /headers\.set\("X-Robots-Tag", "noindex, nofollow"\)/);
});

test("the homepage canonical is the address the brief names", async () => {
  /* §7.3. Recorded with its caveat: `maintsupp.com` currently 307s to the
     apex, so this canonical names a host that redirects. That is a Vercel
     domain setting rather than a code change, and it is flagged in the release
     notes rather than guessed at here. */
  const homepage = await read("app/(marketing)/page.tsx");
  /* RE-POINTED from www to the apex, for the same reason and with the same
     evidence as the worker pin above. A canonical naming a host that 308s asks the
     crawler to index an address that immediately redirects. */
  assert.match(homepage, /alternates: \{ canonical: "https:\/\/maintsupp\.com\/" \}/);
});

test("the portal mock captions an address that exists", async () => {
  /* §8. `portal.maintsupp.com` is not a host this product has ever been served
     from, and Portal Login goes to `/portal` on this domain. Caption only —
     the screenshots and the section are untouched. */
  const portal = await read(`${SECTIONS}/portal.tsx`);
  assert.match(portal, /maintsupp\.com\/dashboard\/\{current\.url\}/);
  assert.ok(!code(portal).includes("portal.maintsupp.com"));
});

/* ------------------------------------------------------------------ */
/* 2026-11-25 — pay per job: the doors a first-time customer uses      */
/* ------------------------------------------------------------------ */

test("the Report a Job form is open to a first-time customer", async () => {
  /*
   * Until 2026-11-25 the note under this form read "For existing Maintsupp
   * clients. Not a client yet? Book a free portfolio review below." The route
   * behind it (`/api/report-job`) has always been public, so the note was the
   * only thing turning a new customer away — and it was turning away exactly
   * the reader the pay-per-job offer is written for, at the moment they had a
   * job in hand.
   *
   * Three places have to agree for the door to be open, and each is pinned:
   * the note under the form, the FAQ that says who may report a job, and the
   * two places that send a reader here to get a price.
   */
  const form = code(await read(`${SECTIONS}/report-job.tsx`));
  assert.ok(form.includes("No account needed."), "the form says so");
  assert.match(
    form.replace(/\s+/g, " "),
    /we confirm the price and the time with you before any work starts/,
    "and says what happens next, in the offer's own terms",
  );
  assert.doesNotMatch(form, /For existing Maintsupp clients|Not a client yet/, "the refusal is gone");

  const content = await read(`${SECTIONS}/content.ts`);
  assert.match(content, /No account is needed for a first job\./, "the FAQ agrees");

  assert.match(
    await read(`${SECTIONS}/pricing.tsx`),
    /To get a price, <Link href="\/#report">report the job<\/Link>/,
    "the pricing section sends a reader to it",
  );
  const pricingPage = await read("app/(marketing)/pricing/page.tsx");
  assert.match(
    pricingPage,
    /<Link className="btn btn--primary btn--lg" href="\/#report">\s*Report a Job\s*<\/Link>/,
    "/pricing opens on it",
  );
  assert.match(
    pricingPage,
    /primary=\{\{ href: "\/#report", label: "Report a Job" \}\}/,
    "and closes on it",
  );
  /* `/#report`, never a bare `#report`, from anything that also renders off
     the homepage: on /pricing and /contact a bare hash lands nowhere. */
  for (const file of [`${SECTIONS}/pricing.tsx`, `${SECTIONS}/final-cta.tsx`, "app/(marketing)/pricing/page.tsx"]) {
    assert.doesNotMatch(code(await read(file)), /href="#report"/, `${file} links to a hash its own page may not have`);
  }
});

test("/pricing explains pay-per-job in the shared terms, and types no figure", async () => {
  /*
   * /pricing was the long form of the rate card: "Clear per-store pricing,
   * with no markup on trades", a description quoting the entry rates, and
   * three cards headed "How billing works". It is the long form of the new
   * offer now, and it is held to the same two rules as the section it draws:
   * the commercial terms are quoted from `TERMS`, and no figure is typed.
   */
  const source = await read("app/(marketing)/pricing/page.tsx");
  const body = code(source);
  const title = /const TITLE = "([^"]+)";/.exec(source)?.[1] ?? "";
  const description = /const DESCRIPTION = "([^"]+)";/.exec(source)?.[1] ?? "";
  assert.match(title, /Pay Per Job/, "the title says what kind of pricing this is");
  /* Fifty, not sixty: the layout appends " | MAINTSUPP" to every page title,
     and a search result cuts the whole line at about sixty. */
  assert.ok(title.length <= 50, `the title is ${title.length} characters before the layout's suffix`);
  assert.ok(description.length > 0 && description.length <= 160, `the description is ${description.length} characters`);
  assert.match(description, /No subscription\./);

  assert.match(body, /import \{ TERMS \} from "\.\.\/_sections\/rates";/);
  assert.match(
    body,
    /body: `\$\{TERMS\.callOut\} \$\{TERMS\.noRepairVisit\}`/,
    "the call-out card is the shared promise, with its other half",
  );
  assert.doesNotMatch(body, /ENTRY_BAND|£/, "no rate is derived here and no figure is typed");
  for (const gone of ["Clear per-store pricing", "How billing works", "One coordination fee", "before they sign"]) {
    assert.ok(!body.includes(gone), `/pricing still says "${gone}"`);
  }

  /*
   * THE QUESTIONS ARE LOOKED UP BY THEIR TEXT, which is a quiet way to lose
   * one: the page filters the shared FAQ list by `q`, and a question renamed
   * in `content.ts` simply stops appearing here, with no error anywhere. One
   * was renamed in this very change ("What if we only have three or four
   * sites?"), so every question the page asks for is checked to exist.
   */
  const from = body.indexOf("const PRICING_QUESTIONS = [");
  const wanted = [...body.slice(from, body.indexOf("];", from)).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(wanted.length >= 4, "the page still asks for its pricing questions");
  const content = await read(`${SECTIONS}/content.ts`);
  for (const question of wanted) {
    assert.ok(content.includes(`"q": "${question}"`), `/pricing asks for a question the FAQ no longer has: "${question}"`);
  }
  assert.ok(wanted.includes("Is there a minimum number of sites?"), "including the one that replaced the three-or-four-sites question");
});

test("the London pages send a reader to how pricing works, not to a plan's rates", async () => {
  /* The landing pages linked to /pricing as "Pricing for monthly plans" and
     told a reader the per-store rates were "published on the pricing page".
     Neither is true any longer; the label is pinned so the link cannot go on
     promising a table that is not there. (The sentences themselves are covered
     above: the withdrawn words are refused across the whole tree.) */
  for (const file of ["app/(marketing)/_landing/services.ts", "app/(marketing)/_landing/places.ts"]) {
    const source = code(await read(file));
    assert.match(source, /\{ href: "\/pricing", label: "How pricing works" \}/, `${file} labels the link for what the page is`);
    assert.doesNotMatch(source, /Pricing for monthly plans/, `${file} still promises plan pricing`);
    assert.match(source, /import \{[^}]*\bTERMS\b[^}]*\} from "\.\.\/_sections\/rates\.ts";/, `${file} reads the terms rather than typing them`);
  }
});

/* ------------------------------------------------------------------ */
/* Live — the page a reader actually gets                              */
/* ------------------------------------------------------------------ */

test("live: the terms agree across the page, and no figure is printed", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /*
   * RE-POINTED 2026-11-25. This fetched the homepage and found every rate,
   * total and footnote figure on it. There are none to find, so it holds the
   * two things that took their place: every term reaches a reader in the
   * approved words, and no price does.
   */
  const html = await page("/");
  for (const [key, sentence] of Object.entries(rates.TERMS)) {
    assert.ok(html.includes(sentence), `TERMS.${key} reaches the page`);
  }
  /* The call-out promise is on its card and in the FAQ answer. */
  assert.ok(html.split(rates.TERMS.callOut).length - 1 >= 2, "and the call-out promise is made in both places");
  assert.ok(html.split(rates.TERMS.noRepairVisit).length - 1 >= 2, "each time with its other half");
  assert.doesNotMatch(html, /£\s?\d/, "no figure is printed anywhere on the page");
  for (const gone of WITHDRAWN_PLAN_WORDS) {
    assert.ok(!html.includes(gone), `the page still says "${gone}"`);
  }
});

test("live: the cost FAQ gives the same terms the cards do", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /* §10.4's hardest case, unchanged in kind: the FAQ is the one place the
     offer could drift unnoticed, because it is prose. It is quoted from
     `TERMS`, and this is the proof. */
  for (const where of ["/", "/faqs", "/pricing"]) {
    const html = await page(where);
    for (const [key, sentence] of Object.entries(rates.TERMS)) {
      assert.ok(html.includes(sentence), `${where}: TERMS.${key}`);
    }
    assert.ok(html.includes("Is there a minimum number of sites?"), `${where}: the question that replaced it`);
    assert.ok(
      html.includes(`portfolios of ${rates.inWords(rates.MANAGED_PLAN_MINIMUM_SITES)} sites and above`),
      `${where}: the managed plan's size, in words`,
    );
    assert.ok(
      !html.includes("What if we only have three or four sites?"),
      `${where}: the withdrawn question is gone`,
    );
  }
});

test("live: none of the withdrawn strings reaches a reader", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /* §10.1, against the rendered page rather than the source — which is where a
     figure assembled from two interpolations would show up and a source scan
     would not. */
  const html = await page("/");
  for (const withdrawn of WITHDRAWN) {
    assert.ok(!html.includes(withdrawn), `the page still says "${withdrawn}"`);
  }
  assert.ok(!html.includes("ICO registered"), "and makes no ICO claim");
  assert.ok(!html.includes("portal.maintsupp.com"), "nor names a host that does not exist");
  assert.ok(!html.includes("Book My Portfolio Review"), "nor offers a submit that cannot book");
});

/*
 * The destination this page is SUPPOSED to offer, read from the one place that
 * decides it.
 *
 * This used to be a second typed copy of the slug, and it went stale the moment
 * the booking URL was corrected: the constant became
 * `portfolio-review-30-minutes` and this test still demanded the old
 * `portfolio-review`, so it failed while the product was right. A copy of a
 * value cannot check that value. It reads `BOOKING_URL` from `content.ts`
 * instead — including the deployment's override, which is how the URL is meant
 * to be changed — so it now asks the only question worth asking: does every
 * booking link on the page go where the configuration says?
 */
async function bookingDestination() {
  const override = process.env.NEXT_PUBLIC_BOOKING_URL?.trim();
  if (override) return override;
  const content = await read(`${SECTIONS}/content.ts`);
  const [, url] =
    content.match(/export const BOOKING_URL =[\s\S]*?\|\|\s*"([^"]+)";/) ?? [];
  assert.ok(url, "content.ts must still declare a default BOOKING_URL");
  return url;
}

test("live: the page offers the booking link and the enquiry form both", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const html = await page("/");
  const expected = await bookingDestination();

  /* Every calendar link on the page, whatever it points at — so a second,
     stale URL left behind somewhere fails this rather than hiding behind the
     one that is correct. */
  const calendarLinks = [...html.matchAll(/href="(https:\/\/cal\.com\/[^"]*)"[^>]*/g)];
  assert.ok(calendarLinks.length >= 2, "the hero and the final panel both book");
  for (const [tag, href] of calendarLinks) {
    assert.equal(href, expected, "every booking link is the configured destination");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
  }
  assert.ok(html.includes("Send My Enquiry"), "the form is still there, honestly labelled");
  assert.ok(html.includes('href="/contractors"'), "and the nav carries Contractors");
});
