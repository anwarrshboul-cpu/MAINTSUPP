/**
 * Homepage V3 — the owner's thirteen highlights, written down so they run.
 *
 * WHY A SEPARATE FILE, AGAIN. `stage-eleven-marketing` holds the porting rules,
 * `stage-twentyeight-landing-rebuild` the rebuild's audit and
 * `landing-positioning-v2` the v2 edit. Each of those was re-pointed where V3
 * invalidated one of its pins, and the reason is written into the pin. What is
 * here is what V3 ADDS: three sections that did not exist, a qualifier
 * withdrawn from every price, a form moved to the bottom of the page, and the
 * two things that must not have moved with it.
 *
 * THE ONE THING THIS FILE IS REALLY FOR. Nine of the thirteen are copy, and
 * copy is the easiest kind of requirement to satisfy once and lose in the next
 * edit — a sentence goes, a section is "tidied" into another, a price picks its
 * qualifier back up because somebody assumed the old comment was still true. So
 * the assertions below are about the CONTRACT rather than the wording wherever
 * the two can be told apart: that the FAQ is shared and not copied, that no
 * second price table exists, that the intake path is still the shared uploader.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const SECTIONS_DIR = "app/(marketing)/_sections";

/** Every source file the marketing site is built from, as [name, source]. */
async function marketingSources() {
  const out = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.(tsx?|css)$/.test(entry.name)) out.push([next, await read(next)]);
    }
  };
  await walk("app/(marketing)");
  return out;
}

/** Comments removed — JSX, block and line — so a rule cannot fail on the note
 *  that records why it exists. Used wherever a check is about what RENDERS. */
const rendered = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ── 2. "+ VAT" is withdrawn from the whole site ─────────────────────────── */

test("no file the marketing site renders carries + VAT, or a synonym for it", async () => {
  /*
   * THE REVERSE OF A SHIPPED REQUIREMENT, which is why it is checked across the
   * tree rather than in the one file that used to carry it. "Every price
   * carries + VAT" was a rule of the previous brief, enforced by a test and
   * recorded in a comment above the pricing component; V3 withdraws it. The
   * inverted assertion lives in `stage-twentyeight-landing-rebuild` beside the
   * one it replaces. This one is the blanket: not the pricing section, not the
   * stylesheet, not a footnote in `content.ts`, not a new section written later
   * by somebody working from the old comment.
   */
  for (const [name, source] of await marketingSources()) {
    const body = name.endsWith(".css")
      ? source.replace(/\/\*[\s\S]*?\*\//g, "")
      : rendered(source);
    assert.doesNotMatch(body, /\bVAT\b/i, `${name} still mentions VAT`);
    for (const synonym of [/ex\.?\s*VAT/i, /exclud\w*\s+VAT/i, /plus\s+VAT/i]) {
      assert.doesNotMatch(body, synonym, `${name} carries the same qualifier renamed`);
    }
  }
});

/* ── 3. Twenty-one stores ────────────────────────────────────────────────── */

test("the portfolio is 21 stores, and the old +20 notation is gone from the tree", async () => {
  /*
   * `landing-positioning-v2` pins the four places the count is claimed. This is
   * the sweep that catches a fifth: a section written later, or a sentence in
   * `content.ts`, still carrying the "+20" the site shipped with. Two claims
   * about one portfolio is the failure being prevented, and it does not care
   * which file the second one is in.
   */
  const claims = [];
  for (const [name, source] of await marketingSources()) {
    if (/\+\s?20 stores/.test(rendered(source))) claims.push(name);
  }
  assert.deepEqual(claims, [], "the +20 notation was replaced by an exact count");

  const hero = await read(`${SECTIONS_DIR}/hero.tsx`);
  assert.match(rendered(hero), /21 stores currently coordinated/, "the hero states the count");
});

/* ── 4. Your contractors or ours ─────────────────────────────────────────── */

test("the page answers 'do we have to change contractors' in a section of its own", async () => {
  const source = await read(`${SECTIONS_DIR}/contractor-choice.tsx`);

  assert.match(source, /<section className="section" id="your-contractors">/);
  assert.match(source, /Your contractors or ours/, "the eyebrow names the question being answered");

  /* BOTH routes, and neither one is a plan. The danger in a two-card section
     beside a pricing section is that it becomes a second price table; these
     cards carry no figure and no button for exactly that reason. */
  const routes = [...source.matchAll(/^\s{4}title: "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(routes, ["Your contractors", "Our vetted network"], "two routes, one process");
  assert.doesNotMatch(rendered(source), /£/, "no price may be typed outside the pricing section");

  /* The one claim a reader is actually worried about: keeping their own trades
     costs them nothing and locks them into nothing. */
  assert.match(source, /Your agreed rates, unchanged/);
  assert.match(source, /No transfer, no notice period, no exclusivity/);

  /* And the mix is stated, not left to be inferred from two cards side by side
     — a reader who infers "pick one at sign-up" has read the opposite of the
     position. */
  assert.match(source, /Most portfolios run a mix/);
});

test("the FAQ answer and the contractors section say the same thing", async () => {
  /*
   * The FAQ answered this before the section existed, on another page. Two
   * answers to one question is how a site comes to contradict itself, so they
   * are pinned as a pair: both must carry the position, and the FAQ must no
   * longer stop at the half of it that only says "yes, you may keep yours".
   */
  const content = await read(`${SECTIONS_DIR}/content.ts`);
  const answer = content.slice(content.indexOf("Can we keep our current contractors?"));
  const first = answer.slice(0, answer.indexOf("\n  }"));
  assert.match(first, /your contractors or ours/i, "the FAQ uses the section's own framing");
  assert.match(first, /most portfolios run a mix/i, "and states the normal case");
});

/* ── 5. What this replaces ───────────────────────────────────────────────── */

test("what this replaces names things, and does not re-run the comparison table", async () => {
  const source = await read(`${SECTIONS_DIR}/what-this-replaces.tsx`);
  assert.match(source, /<section className="section" id="replaces">/);

  /* PAIRS, STORED AS PAIRS — the rule `problem.tsx` follows for the same
     reason. Two arrays would let "what goes" and "what replaces it" slip
     against each other by one row and nothing would notice. */
  const pairs = [...source.matchAll(/gone:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(pairs.length, 6, "six things replaced");
  assert.equal(new Set(pairs).size, pairs.length, "and none of them twice");
  assert.equal(
    [...source.matchAll(/instead:\s*$|instead:\s*"/gm)].length,
    pairs.length,
    "every `gone` has an `instead` on the same object",
  );

  /*
   * IT MUST NOT BECOME THE PROBLEM SECTION AGAIN. `Problem` is a before/after
   * of symptoms; this is a list of artefacts, roles and licences. If a row here
   * ever reproduces one of that table's five "before" lines, one of the two
   * sections has drifted into the other and the reader is being told the same
   * thing twice under two headings.
   */
  const problem = await read(`${SECTIONS_DIR}/problem.tsx`);
  const before = [...problem.matchAll(/before: "([^"]+)"/g)].map((m) => m[1]);
  for (const line of before) {
    assert.ok(!source.includes(line), `"${line}" belongs to the comparison table, not here`);
  }

  /* And no saving is claimed. "Replaces a part-time facilities hire" is a
     statement about the work; a figure beside it would be a statement about
     somebody's payroll that Maintsupp cannot see. */
  assert.doesNotMatch(rendered(source), /£/, "no figure may be invented here");
});

/* ── 6. Pricing, with no conflicting old pricing left behind ─────────────── */

test("there is exactly one price table on the marketing site", async () => {
  /*
   * THE DEFECT THIS CLOSES, and it was live. The FAQ answered "What does it
   * cost?" with "We do not publish fixed fees" — written when the site
   * published none — while the pricing section published a per-store rate for
   * three plans across three bands. A reader who read both was told the page
   * they were looking at did not exist.
   *
   * The rule is not "no prices in the FAQ". It is that `pricing.tsx` is the
   * only file allowed to state one, because a second copy anywhere is a second
   * thing to keep true, and the one that goes stale is never the one somebody
   * is looking at.
   */
  const offenders = [];
  for (const [name, source] of await marketingSources()) {
    if (name.endsWith("pricing.tsx") || name.endsWith(".css")) continue;
    const figures = [...rendered(source).matchAll(/£\d/g)];
    if (figures.length) offenders.push(`${name} (${figures.length})`);
  }
  assert.deepEqual(offenders, [], "only pricing.tsx may quote a figure");

  const content = await read(`${SECTIONS_DIR}/content.ts`);
  assert.doesNotMatch(
    rendered(content),
    /do not publish fixed fees/,
    "the FAQ must not deny the prices the page publishes",
  );
  const cost = content.slice(content.indexOf('"q": "What does it cost?"'));
  assert.match(
    cost.slice(0, cost.indexOf("\n  }")),
    /rates are published on this page/,
    "it must point at the one place the rates live",
  );
});

/* ── 7. The FAQ, shared rather than copied ───────────────────────────────── */

test("the homepage FAQ and /faqs render the same array, and neither owns a copy", async () => {
  const section = await read(`${SECTIONS_DIR}/faq.tsx`);
  const page = await read("app/(marketing)/faqs/page.tsx");

  for (const [name, source] of [["the homepage section", section], ["/faqs", page]]) {
    assert.match(source, /from "\.\.?\/(?:_sections\/)?content"/, `${name} must read content.ts`);
    assert.match(source, /faq\.map\(/, `${name} must render the shared array`);
  }
  /* No second copy of a question, under any name. `faq-items.ts` was exactly
     that and `stage-eleven-marketing` keeps it deleted; this catches the same
     mistake made inline. */
  assert.doesNotMatch(section, /"q":/, "the questions live in content.ts and nowhere else");
  assert.doesNotMatch(section, /\bq:\s*"/, "not even one, not even as an example");

  /* <details>, not a re-built accordion. This is the section a reader reaches
     after a page of argument — the one place where a component failing to
     hydrate would silently hide the content — so the open/closed behaviour is
     the element's and needs no JavaScript at all. */
  assert.match(section, /<details className="faq__item"/);
  assert.match(section, /<summary className="faq__q">/);
  /* Comments stripped: the note above the markup has to name `aria-expanded`
     to say what the old accordion carried and this one does not. */
  assert.doesNotMatch(
    rendered(section),
    /useState|onClick|aria-expanded/,
    "the element does this natively",
  );

  /* And it is reachable by name from the footer, since the top nav stays five
     items — see the note beside the footer list. */
  const chrome = await read(`${SECTIONS_DIR}/chrome.tsx`);
  assert.match(chrome, /href="#faq"/, "the footer links the section");
  assert.match(chrome, /href="\/faqs"/, "and the standalone page keeps its link");
});

/* ── 8, 9. Report a Job at the bottom, submitting exactly as it did ──────── */

test("Report a Job is last, and moving it changed nothing about how it submits", async () => {
  const page = await read("app/(marketing)/page.tsx");
  const order = [...page.slice(page.indexOf("HomePage")).matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map(
    (m) => m[1],
  );
  assert.equal(order.at(-1), "ReportJob", "it is the last section above the footer");

  /*
   * THE CANONICAL INTAKE PIPELINE, PINNED HERE TOO — deliberately duplicating
   * `client-upload-single-path` and `submission-title`.
   *
   * Those two tests exist because both defects have SHIPPED, one of them twice,
   * and the second silently lost every photograph a member of the public
   * attached from a phone. A section move is exactly the kind of edit under
   * which an import gets "cleaned up" on the way past. The cost of asserting it
   * in a third place is nothing; the cost of not noticing is a form that looks
   * like it worked.
   */
  const form = await read(`${SECTIONS_DIR}/report-job.tsx`);
  assert.match(
    form,
    /import \{ uploadEvidenceFile \} from "\.\.\/\.\.\/lib\/client-upload"/,
    "the shared uploader owns the 1 MiB ceiling, the multipart fallback and the thumbnails",
  );
  assert.match(form, /await uploadEvidenceFile\(\{/, "and it must actually be used");
  assert.doesNotMatch(form, /fetch\("\/api\/files"/, "nothing may post to /api/files directly");

  assert.match(
    form,
    /import \{ submissionTitle \} from "\.\.\/\.\.\/lib\/submission-title"/,
    "one rule decides what a row is called",
  );
  assert.match(form, /const title = \[category, summary\]/, "and this page composes it that way");
  assert.doesNotMatch(
    form,
    /\(\?<=/,
    "no lookbehind: it is a parse-time SyntaxError on WebKit before Safari 16.4, and this is the page the public reports a fault on",
  );

  assert.match(form, /fetch\("\/api\/report-job"/, "the public route, unchanged");
  assert.match(form, /id="report"/, "and the anchor travels with the section");
});

/* ── 10. The slider ──────────────────────────────────────────────────────── */

test("the pricing calculator opens at five stores", async () => {
  const pricing = await read(`${SECTIONS_DIR}/pricing.tsx`);
  assert.match(pricing, /useState\(5\)/, "five, not eight");
  /* The range is unchanged around it: a reader with fewer than five drags left
     rather than finding the control starts below their portfolio. */
  assert.match(pricing, /const SLIDER_MIN = 1;/);
  assert.match(pricing, /const SLIDER_MAX = 40;/);
  /* Five is the number the page already claims to serve from. */
  const who = await read(`${SECTIONS_DIR}/who-we-help.tsx`);
  assert.match(who, /Typically 5–50 locations/, "the calculator opens on the bottom of that range");
});

/* ── 11. Anchors ─────────────────────────────────────────────────────────── */

test("every in-page link on the homepage lands on an id the homepage renders", async () => {
  /*
   * An anchor with no target does not error. It silently does nothing, which is
   * the worst possible behaviour for navigation — and V3 added three sections
   * and three links to them, which is precisely when this goes wrong.
   *
   * The homepage's surface is the layout's chrome plus the sections `page.tsx`
   * renders, so that is what is read here: ids and hrefs from the same set.
   */
  const files = ["app/(marketing)/page.tsx"];
  for (const entry of await readdir(path.join(root, SECTIONS_DIR))) {
    if (entry.endsWith(".tsx")) files.push(`${SECTIONS_DIR}/${entry}`);
  }

  const ids = new Set();
  const hrefs = new Map();
  for (const file of files) {
    const source = await read(file);
    for (const [, id] of source.matchAll(/\sid="([^"{}]+)"/g)) ids.add(id);
    for (const [, href] of rendered(source).matchAll(/href="#([^"{}]+)"/g)) {
      if (!hrefs.has(href)) hrefs.set(href, file);
    }
  }

  const dead = [...hrefs].filter(([href]) => !ids.has(href));
  assert.deepEqual(dead, [], "an in-page link points at nothing");

  /* The three V3 sections are actually linked from somewhere, or they are
     reachable only by scrolling past everything above them. */
  for (const anchor of ["replaces", "your-contractors", "faq"]) {
    assert.ok(ids.has(anchor), `#${anchor} must exist`);
    assert.ok(hrefs.has(anchor), `#${anchor} must be linked from somewhere`);
  }
});

/* ── 12. Responsive, within the breakpoints the file is allowed ──────────── */

test("the V3 sections add no breakpoint, and use only ones the project allows", async () => {
  /*
   * TWO CEILINGS AT ONCE. `stage-eleven-marketing` caps this stylesheet at 30
   * distinct breakpoints and it stood at 28 before V3 — two left, and three new
   * sections could easily have spent both. CLAUDE.md caps the PROJECT at
   * 640/767/768/1024/1280, because several stage tests fail on any other width.
   * The V3 sections satisfy both by spending nothing: they lay out on 640, 768
   * and 1024, which are already in this file and are three of the five allowed.
   *
   * They stack to one column below the first of those, so 320, 375 and 414 all
   * take the single-column path and no grid floor can exceed the track.
   */
  const css = await read("app/(marketing)/marketing.css");
  const widths = new Set(
    (css.match(/@media[^{]*?\((?:min|max)-width:\s*(\d+)px\)/g) ?? []).map((query) =>
      Number(query.match(/(\d+)px/)[1]),
    ),
  );
  assert.equal(widths.size, 28, `${widths.size} breakpoints — V3 was written to add none`);

  /*
   * EXPLICIT COLUMNS, NOT `auto-fit`, AND THE REASON IS MEASURED. `.wrap` is
   * 1320px capped with `clamp(20px,4vw,40px)` of gutter, so a 1440px window
   * gives 1240px of track — enough for FOUR `minmax(240px,1fr)` columns, which
   * lays six cards out 4 + 2. Raising the floor to 300px caps it at three and
   * then overflows a 320px phone, whose track is 280px. Stated columns say
   * 3 / 2 / 1 exactly and cannot do either.
   */
  assert.match(css, /\.replaces\{[^}]*grid-template-columns:minmax\(0,1fr\)\}/, "one column first");
  assert.match(css, /@media \(min-width: 640px\)\{\.replaces\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(css, /@media \(min-width: 1024px\)\{\.replaces\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\}/);
  assert.match(css, /\.choice\{[^}]*grid-template-columns:minmax\(0,1fr\)/, "one column first");
  assert.match(css, /@media \(min-width: 768px\)\{\.choice\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  /* `minmax(0,1fr)` and not `1fr`: a grid item's automatic minimum is its
     content, so a long unbroken string in one card would push the column wider
     than its share and take the page sideways with it. */
  const v3Tracks = [...css.matchAll(/\.(?:replaces|choice)\{[^}]*?grid-template-columns:([^;}]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(v3Tracks.length >= 5, `expected the five track declarations, found ${v3Tracks.length}`);
  for (const track of v3Tracks) {
    assert.ok(
      track.includes("minmax(0,1fr)"),
      `"${track}" does not floor at 0 — a bare 1fr can widen the page`,
    );
  }
  assert.match(css, /\.wrap\{[^}]*padding-inline:clamp\(20px,4vw,40px\)/);

  /* Both new blocks read the scale rather than typing their own steps — the
     rule `stage-twentyeight-landing-rebuild` holds the rest of the page to. */
  for (const rule of [
    /\.replaces\{[^}]*gap:var\(--gap-card\)[^}]*margin-top:var\(--gap-block\)/,
    /\.replaces__card\{[^}]*padding:var\(--gap-pad\)/,
    /\.choice\{[^}]*gap:var\(--gap-card\)[^}]*margin-top:var\(--gap-block\)/,
    /\.choice__card\{[^}]*padding:var\(--gap-pad\)/,
    /\.faq__list\{margin-top:var\(--gap-block\)/,
  ]) {
    assert.match(css, rule, `${rule} no longer reads the spacing scale`);
  }

  /* A <summary> is not an <a>, a <button> or a <label>, so the blanket
     coarse-pointer rule does not reach it. The FAQ row states its own floor. */
  assert.match(css, /\.faq__q\{[^}]*min-height:44px/, "the FAQ row is a 44px tap target");
  /* And it loses the default disclosure triangle in all three engines, or one
     of them draws two arrows on the row. */
  assert.match(css, /\.faq__q\{[^}]*list-style:none\}/);
  assert.match(css, /\.faq__q::-webkit-details-marker\{display:none\}/);
  assert.match(css, /\.faq__item\[open\] > \.faq__q \.ic\{transform:rotate\(180deg\)\}/);
});

/* ── 13. The portal's dark default must not reach a light site ───────────── */

test("the marketing site pins its own colour scheme, hard enough to win", async () => {
  /*
   * THE LEAK, AND WHY A NORMAL RULE DOES NOT CLOSE IT.
   *
   * The portal defaults to dark. Its boot script stamps `data-theme` on <html>
   * and <body> and writes `documentElement.style.colorScheme` — an INLINE
   * style, which outranks every normal declaration in an author stylesheet. The
   * dashboard's stylesheets are not the problem and never were: the marketing
   * layout does not load them. The DOCUMENT is. <html> and <body> survive a
   * client-side navigation, so a reader who opens /portal and clicks back to
   * the site arrives with `color-scheme:dark` still on the root, and every form
   * control, scrollbar and unpainted surface on a light page follows it.
   *
   * `!important` in the author stylesheet is the one declaration that beats a
   * normal inline style. That is why it is here and why it may not be "tidied
   * away": without it this rule loses silently, and it loses only for the
   * readers who have signed in — which is nobody who tests the page.
   */
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /:root\{color-scheme:light!important\}/, "and it must be important to win");
  assert.match(
    css,
    /theme-boot/,
    "the reason names the file that does the stamping, or the next person deletes the !important",
  );

  /* The other half of the separation, unchanged: the marketing layout loads its
     own stylesheet and none of the dashboard's. */
  const layout = await read("app/(marketing)/layout.tsx");
  const imports = layout.split("\n").filter((line) => /^\s*import\s/.test(line)).join("\n");
  assert.match(imports, /marketing\.css/);
  assert.doesNotMatch(imports, /globals\.css/);
  assert.doesNotMatch(imports, /brand-overrides\.css/);
  /* And nothing in the marketing tree reads the portal's theme attribute — a
     stylesheet that selected on it would be inheriting the default by another
     route. */
  assert.doesNotMatch(css, /\[data-theme/, "the marketing site has one skin");
});
