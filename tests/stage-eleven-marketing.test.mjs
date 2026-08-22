import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const exists = async (file) => {
  try {
    await access(path.join(root, file));
    return true;
  } catch {
    return false;
  }
};

test("the iframe homepage is gone", async () => {
  assert.equal(await exists("app/page.tsx"), false, "the iframe wrapper must be deleted");
  assert.equal(
    await exists("public/landing.html"),
    false,
    "the 195KB standalone landing page must be deleted",
  );
  assert.equal(await exists("app/(marketing)/page.tsx"), true);
});

test("no iframe remains anywhere in the app", async () => {
  for (const file of [
    "app/(marketing)/page.tsx",
    "app/(marketing)/layout.tsx",
    "app/brand-overrides.css",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /<iframe/i, `${file} must not contain an iframe`);
    assert.doesNotMatch(source, /landing-shell/, `${file} must not keep the iframe styling`);
  }
});

test("marketing copy was ported, not rewritten", async () => {
  const content = await read("app/(marketing)/_sections/content.ts");
  // Distinctive phrases from the original landing.html.
  for (const phrase of [
    "coordination and control layer",
    "Roller shutter jammed or off track",
    "Fixed-wire testing and certification",
  ]) {
    assert.ok(content.includes(phrase), `original copy missing: "${phrase}"`);
  }
  assert.match(content, /Ported verbatim/, "the provenance must be recorded");
});

/**
 * TEN SECTIONS, AND ONLY TEN.
 *
 * This asserted nine components by name and nothing else, so it would have gone
 * on passing with six more sections underneath them — which is how the page got
 * to sixteen and explained its own process four times. The rebuild's contract is
 * a closed list, so the check is now closed too: these ten, in this order,
 * each exactly once, and no eleventh.
 *
 * `TrustStrip` and `FinalCta` are the two halves of section 10 — a dark
 * full-bleed band and the form beneath it — which is why the list of components
 * is eleven long and the list of SECTIONS is ten.
 */
/*
 * The v2 positioning order. Report a Job moved from second to fourth — the page
 * now says who it is for and what it covers before asking for eleven fields —
 * and "Who runs Maintsupp" was added between the case study and the portal.
 */
const SECTIONS = [
  "Hero",
  "WhoWeHelp",
  "Services",
  "ReportJob",
  "Problem",
  "HowItWorks",
  "Pricing",
  "CaseStudy",
  "Founder",
  "Portal",
  "TrustStrip",
  "FinalCta",
];

test("the eleven sections render on the homepage, in order, each exactly once", async () => {
  const page = await read("app/(marketing)/page.tsx");
  const body = page.slice(page.indexOf("export default function HomePage"));

  const rendered = [...body.matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map((match) => match[1]);
  assert.deepEqual(rendered, SECTIONS, "the page must render exactly these, in this order");

  for (const section of SECTIONS) {
    const count = rendered.filter((name) => name === section).length;
    assert.equal(count, 1, `${section} renders ${count} times`);
  }
});

test("the sections the rebuild removed are gone from the repo, not just unrendered", async () => {
  /*
   * A component nobody renders is worse than a deleted one: it keeps passing
   * greps, keeps importing assets that then look used, and invites somebody to
   * put it back without knowing why it left.
   */
  const dir = path.join(root, "app/(marketing)/_sections");
  const files = await readdir(dir);
  for (const gone of [
    "proof.tsx",       // stat tiles + the "We Report / We Coordinate" row
    "trades.tsx",      // second photo grid of the same trades
    "evidence.tsx",    // the chat/timeline retelling of the workflow
    "packages.tsx",    // four tiers with no prices
    "calculator.tsx",  // in-house cost slider
    "sectors.tsx",     // five photo tiles + detail panel
    "trust.tsx",       // testimonial carousel
    "faq-section.tsx", // accordion; /faqs carries the questions and the schema
    "faq-items.ts",
  ]) {
    assert.ok(!files.includes(gone), `${gone} should have been deleted`);
  }
});

test("the workflow is explained once, not three times", async () => {
  // The original sin was explaining the seven-stage workflow three times over.
  // The stages now live in the stepper's own module rather than content.ts, so
  // what this checks is that exactly one component renders them.
  const dir = path.join(root, "app/(marketing)/_sections");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".tsx"));
  const consumers = [];
  for (const file of files) {
    const source = await readFile(path.join(dir, file), "utf8");
    // A component that renders the stepper has both the stage list and its
    // markup; a passing mention of one stage name is not enough to count.
    if (/wf__stage/.test(source) && /Triage/.test(source)) consumers.push(file);
  }
  assert.deepEqual(
    consumers,
    ["workflow.tsx"],
    `the seven stages must be rendered by exactly one component. Found: ${consumers.join(", ") || "none"}`,
  );

  /*
   * And the three sections that used to retell it are gone.
   *
   * This used to name `evidence.tsx` and check it did not mention triage — a
   * check against one of the four copies. The stronger statement is that no
   * OTHER section walks the reader through the stages at all, whatever it is
   * called, so the count is taken across every section file.
   */
  const retellers = [];
  for (const file of files) {
    if (file === "workflow.tsx") continue;
    const source = await readFile(path.join(dir, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const stages = ["Triage", "Approve", "Assign", "Attend", "Verify"].filter((stage) =>
      new RegExp(`["'>\\s]${stage}\\b`).test(code),
    );
    if (stages.length >= 3) retellers.push(`${file} (${stages.join(", ")})`);
  }
  assert.deepEqual(retellers, [], "another section is walking through the stages again");
});

test("the logo links to the homepage", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  assert.match(
    chrome,
    /className="logo" href="\/"/,
    'the logo must be a link to "/", not a #top scroll anchor',
  );
  assert.doesNotMatch(chrome, /href="#top"/);
});

test("the legal pages exist and are linked", async () => {
  for (const page of ["privacy", "terms", "cookies", "faqs"]) {
    assert.equal(
      await exists(`app/(marketing)/${page}/page.tsx`),
      true,
      `/${page} must exist`,
    );
  }
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  for (const page of ["privacy", "terms", "cookies"]) {
    assert.match(chrome, new RegExp(`href="/${page}"`), `/${page} must be in the footer`);
  }
});

test("the consent checkbox links to a privacy notice that exists", async () => {
  const form = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(form, /href="\/privacy"/);
  /* The wording changed with the rebuilt panel — "I accept the…" became
     "I agree to Maintsupp contacting me about this enquiry, as described in
     the…". What matters is that the checkbox states what is being agreed to
     and links the notice, not the verb. */
  assert.match(form, /I agree to Maintsupp contacting me/);
  assert.match(
    form,
    /Please accept the privacy notice/,
    "consent must be enforced, not decorative",
  );
});

test("the privacy notice is marked as needing review", async () => {
  const privacy = await read("app/(marketing)/privacy/page.tsx");
  assert.match(privacy, /REQUIRES OWNER REVIEW/);
  assert.match(privacy, /\[TO CONFIRM/, "retention periods must not be invented");
  // It must describe what the platform actually does.
  for (const topic of ["contractor job link", "Cloudflare", "Resend", "lawful basis"]) {
    assert.match(privacy, new RegExp(topic, "i"), `the notice must cover ${topic}`);
  }
});

test("dashboard CSS is imported only by the app layout", async () => {
  // Compare against imports only — the marketing layout's comment explains why
  // it does not load globals.css, and a naive match would trip on that.
  const importsOf = (source) =>
    source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .join("\n");

  const rootLayout = importsOf(await read("app/layout.tsx"));
  assert.doesNotMatch(rootLayout, /globals\.css/, "the root layout must not load dashboard CSS");
  assert.doesNotMatch(rootLayout, /brand-overrides\.css/);

  const appLayout = importsOf(await read("app/(app)/layout.tsx"));
  assert.match(appLayout, /globals\.css/);

  const marketingLayout = importsOf(await read("app/(marketing)/layout.tsx"));
  assert.doesNotMatch(marketingLayout, /globals\.css/);
  assert.match(marketingLayout, /marketing\.css/);
});

test("the lead form protects a part-completed draft", async () => {
  const form = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(form, /sessionStorage/, "a mis-tap on a phone must not lose the answers");
  assert.match(form, /removeItem\(DRAFT_KEY\)/, "the draft must be cleared on submit");
  /* The step indicator is gone with the steps: the brief replaces the
     three-step wizard with one panel of eight questions, so there is no
     progress to indicate. The draft protection it sat beside is kept, which is
     what the rest of this test is about. */
  assert.doesNotMatch(form, /stepform__bar/, "there are no steps left to indicate");
  assert.match(form, /Book My Portfolio Review/, "the brief's button label");
});

test("the marketing CSS keeps its accessibility floors", async () => {
  /*
   * This test used to insist on four breakpoints and mobile-first min-width
   * only. That was the right call for the interim design — but the owner
   * supplied the original landing page and asked for it exactly, and its design
   * system is built on its own breakpoint set, max-width queries included.
   * Reversing that would have meant redesigning the page rather than porting
   * it, so the breakpoint rule was dropped on purpose.
   *
   * What survives is what actually protects users on a phone, plus a ceiling so
   * the breakpoint set cannot quietly sprawl further than the one we accepted.
   */
  const css = await read("app/(marketing)/marketing.css");

  const widths = new Set(
    (css.match(/@media[^{]*?\((?:min|max)-width:\s*(\d+)px\)/g) ?? []).map((query) =>
      Number(query.match(/(\d+)px/)[1]),
    ),
  );
  assert.ok(widths.size > 0, "the site must be responsive");
  assert.ok(
    widths.size <= 30,
    `${widths.size} distinct breakpoints — the ported set was 25, so this has grown; consolidate before adding more`,
  );

  // Inputs below 16px make iOS zoom on focus, which throws the layout sideways.
  assert.match(css, /font-size:\s*16px/, "inputs below 16px trigger iOS zoom");
  // Touch targets.
  assert.match(css, /min-height:\s*4[48]px/, "tap targets must be at least 44px");
  assert.match(
    css,
    /@media\(pointer:coarse\)\{a,button,label\{min-height:44px\}\}/,
    "the blanket 44px rule for coarse pointers must stay",
  );
  // Animation must be defeatable.
  assert.match(css, /prefers-reduced-motion/, "reduced motion must be honoured");
  assert.match(css, /\.reveal\{opacity:1;transform:none\}/,
    "reveal-on-scroll must not hide content when motion is reduced");
});

test("structured data survived the FAQ section being removed", async () => {
  const page = await read("app/(marketing)/page.tsx");
  assert.match(page, /"@type": "Organization"/);
  assert.match(page, /17262302/, "the company number belongs in the Organization data");

  /*
   * `FAQPage` is deliberately NOT on the homepage any more.
   *
   * The accordion it described is gone, and FAQ structured data has to describe
   * questions the reader can see — Google's own requirement, and a block
   * pointing at content that is not on the page is the kind of thing that
   * earns a manual action rather than a rich result.
   */
  assert.doesNotMatch(
    page,
    /"@type": "FAQPage"/,
    "the homepage has no FAQ section, so it must not claim FAQ markup",
  );

  // It has to still exist somewhere, and it does: on the page that renders the
  // questions. Checked as a real pairing rather than a grep for the word.
  const faqs = await read("app/(marketing)/faqs/page.tsx");
  assert.match(faqs, /"@type": "FAQPage"/, "the FAQ page carries the schema");
  assert.match(faqs, /mainEntity: faq\.map/, "built from the array it renders, so they cannot drift");
  assert.match(faqs, /faq\.map\(\(entry\) => \(/, "and the questions are actually rendered");
});
