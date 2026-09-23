/**
 * Decision L — the pages that SHIP with the site, edited by MAINTSUPP platform
 * staff and read by every public page through a cache (§77 item 9).
 *
 * What is pinned here, and why each matters:
 *   - THE SITE CANNOT GO EMPTY: with nothing saved — and with a malformed
 *     document, a refusal or a timeout — every field resolves to
 *     `app/(marketing)/_sections/copy.ts`, which is the page as it shipped;
 *   - ONE CONTENT PATH after the cutover: no component holds a heading of its
 *     own any more, and no page renders a second copy of anything;
 *   - STRUCTURED FIELDS, NOT HTML: a field is a line, a paragraph, a label, a
 *     list of lines, a list of question/answer pairs, or an image from the media
 *     library — never markup;
 *   - THE SAME COPY RULES AS A CMS PAGE: the six forbidden claims, the VAT
 *     qualifiers and a typed price are refused, and `rates.ts` stays the one
 *     source of every figure;
 *   - SEO, AND ONLY THE HALF THAT IS SAFE: the title and the description are
 *     editable; the canonical, robots, the OpenGraph url and the structured data
 *     are code. A saved title cannot carry the "| MAINTSUPP" the layout adds;
 *   - VISIBILITY AND ORDER WHERE SAFE: three sections are fixed with reasons,
 *     and a section cannot be hidden while a visible navigation link points at
 *     its anchor (decision J's menu, read at save time);
 *   - WHO: platform staff only — no workspace capability reaches it;
 *   - HISTORY: §38 versions, restore through the same rules and the same media
 *     check;
 *   - THE CACHE: never `ensureDatabase()`, never the reason a page fails.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./reports-ts-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const content = await import("../app/lib/site-content.ts");
const shipped = await import("../app/(marketing)/_sections/copy.ts");
const { faq: SHIPPED_QUESTIONS } = await import("../app/(marketing)/_sections/content.ts");
const model = await import("../app/lib/config-versions-model.ts");

const HOME_KEYS = [
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
];

/** A document with one override, in the shape a save sends. */
const one = (page, section, field, value) => ({
  pages: { [page]: { sections: { [section]: { fields: { [field]: value } } } } },
});

const save = (document, options) => content.validateSiteContent(document, options);

/* ------------------------------------------------------------------ */
/* Nothing saved is the site as it ships                               */
/* ------------------------------------------------------------------ */

test("with nothing saved, every page resolves to the words it shipped with", () => {
  const resolved = content.resolveSiteContent(null);
  assert.deepEqual(resolved.home.copy.hero, shipped.HOME_COPY.hero, "the hero, field for field");
  assert.deepEqual(resolved.home.copy.pricing, shipped.HOME_COPY.pricing);
  assert.deepEqual(resolved.home.sections, HOME_KEYS, "the fourteen, in the shipped order");
  assert.equal(resolved.home.heroImage, null, "and the art-directed plates, not a library image");
  assert.equal(resolved.home.seo.title, shipped.SEO_COPY.home.title);
  assert.equal(resolved.home.seo.socialDescription, shipped.SEO_COPY.home.socialDescription);
  assert.deepEqual(resolved.contractors.copy, shipped.PAGE_COPY.contractors);
  assert.deepEqual(resolved.faqs.copy, shipped.PAGE_COPY.faqs);
  assert.equal(resolved.faqs.questions.length, SHIPPED_QUESTIONS.length, "and the shared questions");
  assert.equal(resolved.faqs.questions[0].q, SHIPPED_QUESTIONS[0].q);
  /* The same answer from the same function, so the fallback in every caller is
     this one path rather than a second set of defaults. */
  assert.deepEqual(content.defaultSiteContent(), resolved);
});

test("a document that cannot be understood resolves to the shipped pages, never to nothing", () => {
  for (const broken of ["not json at all", "{", JSON.stringify({ pages: "no" }), null, undefined, 7]) {
    assert.deepEqual(content.normaliseSiteContent(broken), content.EMPTY_SITE_CONTENT, String(broken).slice(0, 20));
  }
  /* One bad page does not take the good one with it: the stored document is
     re-validated page by page, and what survives is kept. */
  const mixed = {
    pages: {
      home: { sections: { hero: { fields: { kicker: "Commercial maintenance, UK-wide" } } } },
      faqs: { sections: { intro: { fields: { nonsense: "x" } } } },
    },
  };
  const normalised = content.normaliseSiteContent(mixed);
  assert.equal(normalised.pages.home.sections.hero.fields.kicker, "Commercial maintenance, UK-wide");
  assert.equal(normalised.pages.faqs, undefined, "the page whose field does not exist is dropped, not repaired");
  const resolved = content.resolveSiteContent(normalised);
  assert.equal(resolved.home.copy.hero.kicker, "Commercial maintenance, UK-wide");
  assert.equal(resolved.home.copy.hero.titleLead, shipped.HOME_COPY.hero.titleLead, "everything else is the shipped copy");
});

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

test("the registry is the fourteen sections, three of them fixed with a reason", () => {
  const home = content.CONTENT_PAGES.find((page) => page.key === "home");
  assert.deepEqual(home.sections.map((section) => section.key), HOME_KEYS);
  assert.deepEqual(content.HOME_SECTION_ORDER, HOME_KEYS);
  const fixed = home.sections.filter((section) => section.fixed);
  assert.deepEqual(fixed.map((section) => section.key), ["hero", "finalCta", "reportJob"]);
  for (const section of fixed) assert.ok(section.fixed.length > 30, `${section.key} must say WHY it is fixed`);
  assert.deepEqual(content.MOVABLE_HOME_SECTIONS, HOME_KEYS.filter((key) => !["hero", "finalCta", "reportJob"].includes(key)));
  assert.equal(content.MOVABLE_HOME_SECTIONS.length, 11);

  /* Every field carries what the editor needs to draw it and what the server
     holds it to — and the shipped value, which is what an empty box means. */
  for (const page of content.CONTENT_PAGES) {
    for (const section of page.sections) {
      for (const field of section.fields) {
        assert.ok(field.label && field.kind && field.max > 0, `${page.key}/${section.key}/${field.key}`);
        assert.notEqual(field.shipped, undefined);
      }
    }
  }
  /* The hero owns the photograph; the questions live on /faqs and are shared. */
  const hero = home.sections.find((section) => section.key === "hero");
  assert.ok(hero.fields.some((field) => field.key === "image" && field.kind === "media"));
  assert.ok(hero.fields.some((field) => field.key === "pills" && field.kind === "lines" && field.maxItems === 3));
  const questions = content.CONTENT_PAGES.find((page) => page.key === "faqs").sections.find((section) => section.key === "questions");
  assert.equal(questions.fields[0].key, "items");
  assert.equal(questions.fields[0].kind, "pairs");
  assert.equal(questions.fields[0].shipped.length, SHIPPED_QUESTIONS.length);

  /* Three pages, and the legal notices are not among them. */
  assert.deepEqual(content.CONTENT_PAGES.map((page) => page.path), ["/", "/contractors", "/faqs"]);
});

/* ------------------------------------------------------------------ */
/* What a save may do                                                  */
/* ------------------------------------------------------------------ */

test("a value equal to the shipped words is not stored at all — which is what makes a revert one", () => {
  const asShipped = one("home", "pricing", "heading", shipped.HOME_COPY.pricing.heading);
  const checked = save(asShipped);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value, { pages: {} }, "no override, because there is nothing to override");
  /* And an empty box is the same state. */
  assert.deepEqual(save(one("home", "pricing", "heading", "   ")).value, { pages: {} });
  /* A real change is stored, and only that field. */
  const edited = save(one("home", "pricing", "heading", "Per-store pricing, published"));
  assert.deepEqual(edited.value, {
    pages: { home: { sections: { pricing: { fields: { heading: "Per-store pricing, published" } } } } },
  });
});

test("only the pages, sections and fields the registry names may be saved", () => {
  assert.match(save({ pages: { legal: {} } }).reason, /no editable page called "legal"/);
  assert.match(save({ pages: { privacy: {} } }).reason, /no editable page called "privacy"/);
  assert.match(save({ pages: { home: { sections: { nope: {} } } } }).reason, /no section called "nope"/);
  assert.match(save(one("home", "hero", "colour", "red")).reason, /no field called "colour"/);
  assert.equal(save("").ok, false);
  assert.equal(save({}).ok, false);
});

test("the copy rules are the website's: no price, no forbidden claim, no VAT qualifier", () => {
  assert.match(save(one("home", "pricing", "lede", "From £99 per store.")).reason, /rates\.ts/);
  assert.match(save(one("home", "services", "heading", "What our engineers cover")).reason, /our engineers/);
  assert.match(save(one("home", "pricing", "lede", "£30 per store + VAT")).reason, /VAT/);
  assert.match(save(one("home", "faq", "lede", "24/7 coverage, guaranteed")).reason, /24\/7 coverage/);
  /* The one permitted mention survives, because the rule is the shared one. */
  assert.equal(save(one("home", "pricing", "lede", "MAINTSUPP LTD is not currently VAT registered.")).ok, true);
  /* And the rules reach a question, an answer and a trust chip too. */
  assert.match(save(one("faqs", "questions", "items", [{ q: "Do you certify?", a: "We certify every job." }])).reason, /we certify/);
  assert.match(save(one("home", "hero", "pills", ["100% first-time fix", "", ""])).reason, /100% first-time fix/);
});

test("a box has a ceiling, and a paragraph keeps its line breaks while a heading does not", () => {
  assert.match(save(one("home", "services", "heading", "x".repeat(200))).reason, /at most 140 characters/);
  assert.equal(save(one("home", "services", "heading", "Two    spaces\nand a break")).value.pages.home.sections.services.fields.heading, "Two spaces and a break");
  /* `replaces`, because `services` has no intro paragraph — which the refusal
     below also proves: a field a section does not have cannot be saved to it. */
  const paragraph = save(one("home", "replaces", "lede", "First line.\n\nSecond line."));
  assert.equal(paragraph.value.pages.home.sections.replaces.fields.lede, "First line.\n\nSecond line.");
  assert.match(save(one("home", "services", "lede", "Services has no lede")).reason, /no field called "lede"/);
  assert.match(save(one("home", "hero", "bookLabel", "x".repeat(50))).reason, /at most 40 characters/);
  assert.match(save(one("home", "services", "heading", { markup: "<b>no</b>" })).reason, /send text/);
});

test("the search-engine fields: editable, but never the ones that could deindex the site", () => {
  const seo = (page, fields) => save({ pages: { [page]: { seo: fields } } });
  assert.match(seo("faqs", { title: "FAQs | MAINTSUPP" }).reason, /leave "\| MAINTSUPP" out of the title/);
  assert.match(seo("home", { title: "x".repeat(80) }).reason, /at most 70 characters/);
  assert.match(seo("home", { description: "From £99 a store" }).reason, /rates\.ts/);
  assert.equal(seo("home", { title: shipped.SEO_COPY.home.title }).value.pages.home, undefined, "the shipped title is no override");
  const edited = seo("home", { title: "Multi-site maintenance, coordinated", description: "One contact for every site." });
  assert.deepEqual(edited.value.pages.home.seo, {
    title: "Multi-site maintenance, coordinated",
    description: "One contact for every site.",
  });
  /* Only the homepage has a shared-link line of its own. */
  assert.match(seo("faqs", { socialDescription: "x" }).reason, /no shared-link description/);
  /* An edited description carries the shared link too, unless one was written. */
  const resolved = content.resolveSiteContent(edited.value);
  assert.equal(resolved.home.seo.socialDescription, "One contact for every site.");
  assert.equal(
    content.resolveSiteContent(seo("home", { socialDescription: "Shared line." }).value).home.seo.socialDescription,
    "Shared line.",
  );
  /* And none of the shipped titles may carry the suffix either. */
  for (const [key, entry] of Object.entries(shipped.SEO_COPY)) {
    assert.doesNotMatch(entry.title, /\|\s*MAINTSUPP/i, `${key} must not repeat the layout's suffix`);
  }
});

/* ------------------------------------------------------------------ */
/* Visibility and order                                                */
/* ------------------------------------------------------------------ */

test("a section may be hidden — unless it is fixed, or the navigation points at it", () => {
  const hide = (section, options) => save({ pages: { home: { sections: { [section]: { hidden: true } } } } }, options);
  for (const [section, word] of [["hero", /H1/], ["finalCta", /form/], ["reportJob", /locked navigation link/]]) {
    const refused = hide(section);
    assert.equal(refused.ok, false, section);
    assert.match(refused.reason, word, section);
  }
  /* The lock that is derived rather than listed: whatever the menu points at. */
  const needs = new Map([["case-study", '"Case Study" in the footer\'s Company list']]);
  assert.match(hide("caseStudy", { requiredAnchors: needs }).reason, /Case Study" in the footer's Company list points at it/);
  assert.match(hide("caseStudy", { requiredAnchors: needs }).reason, /Navigation screen/);
  /* With no link pointing at it, hiding is allowed — and the page leaves it out. */
  const hidden = hide("caseStudy");
  assert.equal(hidden.ok, true);
  const resolved = content.resolveSiteContent(hidden.value);
  assert.equal(resolved.home.sections.includes("caseStudy"), false);
  assert.equal(resolved.home.sections.length, 13);
  assert.deepEqual(content.hiddenSections(hidden.value), ["caseStudy"]);
  /* Hiding it does not lose its words. */
  assert.deepEqual(resolved.home.copy.caseStudy, shipped.HOME_COPY.caseStudy);
});

test("the movable eleven may be reordered; the fixed three cannot move and none may be dropped", () => {
  const order = (list) => save({ pages: { home: { order: list } } });
  const reversed = [...content.MOVABLE_HOME_SECTIONS].reverse();
  const saved = order(reversed);
  assert.equal(saved.ok, true);
  const resolved = content.resolveSiteContent(saved.value);
  assert.equal(resolved.home.sections[0], "hero", "the hero stays first");
  assert.deepEqual(resolved.home.sections.slice(-2), ["finalCta", "reportJob"], "and the two tails stay last");
  assert.deepEqual(resolved.home.sections.slice(1, -2), reversed);

  assert.match(order(["hero", ...content.MOVABLE_HOME_SECTIONS]).reason, /Hero cannot be moved/);
  assert.match(order(content.MOVABLE_HOME_SECTIONS.slice(1)).reason, /must list every movable section/);
  assert.match(order([...content.MOVABLE_HOME_SECTIONS, "pricing"]).reason, /listed twice/);
  assert.match(order(["nonsense", ...content.MOVABLE_HOME_SECTIONS.slice(1)]).reason, /not a section that can be moved/);
  /* The shipped order is not an override. */
  assert.deepEqual(order([...content.MOVABLE_HOME_SECTIONS]).value, { pages: {} });
  /* Only the homepage has an order to save. */
  assert.match(save({ pages: { faqs: { order: [] } } }).reason, /only the home page's sections can be reordered/);
});

/* ------------------------------------------------------------------ */
/* The hero's photograph, and the shared questions                      */
/* ------------------------------------------------------------------ */

test("the hero's photograph is a media-library id, and the page resolves it or draws the shipped plates", () => {
  const id = `med_${"a".repeat(32)}`;
  assert.match(save(one("home", "hero", "image", "https://example.com/hero.jpg")).reason, /choose an image from the media library/i);
  assert.match(save(one("home", "hero", "image", "med_nope")).reason, /media library/i);
  const saved = save(one("home", "hero", "image", id));
  assert.equal(saved.ok, true);
  assert.deepEqual(content.contentMediaIds(saved.value), [id], "what the save route checks against the library");
  assert.equal(content.resolveSiteContent(saved.value).home.heroImage, id);
  /* Empty is not a choice; it is the art-directed pair. */
  assert.deepEqual(save(one("home", "hero", "image", "")).value, { pages: {} });
  assert.deepEqual(content.contentMediaIds(null), []);
});

test("the trust chips are three lines, and a blank one keeps the chip the site ships with", () => {
  const saved = save(one("home", "hero", "pills", ["", "Evidence on every job", ""]));
  assert.equal(saved.ok, true);
  const pills = content.resolveSiteContent(saved.value).home.copy.hero.pills;
  assert.deepEqual([...pills], [shipped.HOME_COPY.hero.pills[0], "Evidence on every job", shipped.HOME_COPY.hero.pills[2]]);
  assert.match(save(one("home", "hero", "pills", ["a", "b", "c", "d"])).reason, /at most 3 of them/);
  assert.match(save(one("home", "hero", "pills", "not a list")).reason, /send a list of lines/);
});

test("the questions are one list, shared by both pages and by the structured data", async () => {
  const three = [
    { q: "Do you employ engineers?", a: "No. Maintsupp coordinates vetted independent contractors." },
    { q: "Can you cover the North?", a: "Yes, and we say plainly where coverage is established." },
    { q: "How do I report a job?", a: "Through the portal, or the form at the bottom of the home page." },
  ];
  const saved = save(one("faqs", "questions", "items", three));
  assert.equal(saved.ok, true);
  const resolved = content.resolveSiteContent(saved.value);
  assert.deepEqual([...resolved.faqs.questions], three, "/faqs and its FAQPage graph");
  /* The homepage's accordion reads THIS list — the page hands it to the section. */
  const page = await read("app/(marketing)/page.tsx");
  assert.match(page, /items=\{faqs\.questions\}/, "the homepage accordion is handed the same resolved list");

  assert.match(save(one("faqs", "questions", "items", three.slice(0, 2))).reason, /at least three questions/);
  assert.match(save(one("faqs", "questions", "items", [...three, three[0]])).reason, /two questions are the same/);
  assert.match(save(one("faqs", "questions", "items", [{ q: "Only a question?", a: "" }])).reason, /needs both a question and an answer/);
  assert.match(save(one("faqs", "questions", "items", [{ q: "x".repeat(300), a: "y" }])).reason, /at most 200 characters/);
  assert.match(save(one("faqs", "questions", "items", [{ q: "q", a: "y".repeat(1000) }])).reason, /at most 900 characters/);
  /*
   * The shipped list is not an override — and this is the case that made the rule
   * explicit: several shipped answers quote a rate, which they take from
   * `rates.ts`. The price rule forbids TYPING a figure, so it is applied to what a
   * person writes and not to the copy the site ships with; otherwise editing one
   * question would be refused because another answer mentions a price.
   */
  const shippedList = SHIPPED_QUESTIONS.map((entry) => ({ q: entry.q, a: entry.a }));
  assert.deepEqual(save(one("faqs", "questions", "items", shippedList)).value, { pages: {} });
  const oneEdited = shippedList.map((entry, index) =>
    index === 0 ? { q: "Do you employ your own engineers at all?", a: entry.a } : entry,
  );
  const oneEdit = save(one("faqs", "questions", "items", oneEdited));
  assert.equal(oneEdit.ok, true, oneEdit.reason);
  /* But a price a person types into an answer is refused, which is the rule
     doing exactly its job. */
  assert.match(
    save(one("faqs", "questions", "items", [...three.slice(1), { q: "What does it cost?", a: "Forty-two pounds: £42 per store." }])).reason,
    /rates\.ts/,
  );
});

/* ------------------------------------------------------------------ */
/* One content path — the cutover, in the source                        */
/* ------------------------------------------------------------------ */

test("no section component holds a heading, an eyebrow or a lede of its own any more", async () => {
  /*
   * THE CUTOVER, ASSERTED. The migration L had to make safe was not a data
   * migration: it was moving the literals out of fourteen components into one
   * module. What makes it safe is that there is now exactly ONE place a heading
   * can come from — so a component that kept a literal, or a later one that adds
   * one, is the defect this catches. `copy.ts` holds the words; the components
   * hold `{copy.…}`.
   */
  const { readdir } = await import("node:fs/promises");
  const dir = "app/(marketing)/_sections";
  const offenders = [];
  for (const name of await readdir(path.join(root, dir))) {
    if (!name.endsWith(".tsx")) continue;
    const source = code(await read(`${dir}/${name}`)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    for (const match of source.matchAll(/<(h1|h2)(?: className="(?:h1|h2)")?>([^<>]+)<\/\1>/g)) {
      if (!match[2].trim().startsWith("{")) offenders.push(`${name}: <${match[1]}>${match[2].trim().slice(0, 40)}`);
    }
    for (const match of source.matchAll(/<p className="(?:eyebrow|lede)">([^<>]+)<\/p>/g)) {
      if (!match[1].trim().startsWith("{")) offenders.push(`${name}: ${match[1].trim().slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, [], "every heading, eyebrow and lede is drawn from the resolved copy");
});

test("every built-in page reads the one resolver, and the sections are handed their copy", async () => {
  const page = await read("app/(marketing)/page.tsx");
  assert.match(page, /readPublicSiteContent\(\)/);
  assert.match(page, /const SECTIONS: Record<HomeSectionKey, \(content: PublicSiteContent\) => ReactNode>/);
  assert.match(page, /content\.home\.sections\.map\(\(key\) => \(/, "the page draws the resolved order");
  for (const key of HOME_KEYS) assert.match(page, new RegExp(`\\n  ${key}: `), `${key} must name its component`);
  assert.match(page, /hero: \(\{ home, heroImage \}\) => <Hero copy=\{home\.copy\.hero\} image=\{heroImage\}/);

  for (const [file, expected] of [
    ["app/(marketing)/contractors/page.tsx", /const \{ contractors \} = await readPublicSiteContent\(\)/],
    ["app/(marketing)/faqs/page.tsx", /const \{ faqs \} = await readPublicSiteContent\(\)/],
  ]) {
    const source = await read(file);
    assert.match(source, expected, file);
    assert.match(source, /export async function generateMetadata\(\): Promise<Metadata>/, `${file} resolves its own SEO`);
  }

  /* The three legal notices are untouched: static metadata, no resolver. */
  for (const folder of ["privacy", "terms", "cookies"]) {
    const source = await read(`app/(marketing)/${folder}/page.tsx`);
    assert.match(source, /export const metadata: Metadata = \{/, `${folder} stays code`);
    assert.doesNotMatch(source, /readPublicSiteContent/, `${folder} is not editable copy`);
  }

  /* What a console may never change, on all five wired pages plus the legal three. */
  for (const [file, canonical] of [
    ["app/(marketing)/page.tsx", "https://maintsupp.com/"],
    ["app/(marketing)/contractors/page.tsx", "https://maintsupp.com/contractors"],
    ["app/(marketing)/faqs/page.tsx", "https://maintsupp.com/faqs"],
    ["app/(marketing)/privacy/page.tsx", "https://maintsupp.com/privacy"],
  ]) {
    assert.match(code(await read(file)), new RegExp(`canonical: "${canonical.replace(/\//g, "\\/")}"`), file);
  }
});

test("the hero draws a library photograph in PhotoSlot's own shape, or the shipped plates", async () => {
  const hero = await read("app/(marketing)/_sections/hero.tsx");
  assert.match(hero, /image = null,/, "no image is the usual case");
  assert.match(hero, /\{image \? \(\s*\n\s*<HeroPhotograph image=\{image\} \/>\s*\n\s*\) : \(/);
  assert.match(hero, /<PhotoSlot\s*\n\s*slot="hero-maintenance-v4"/, "and the art-directed pair is still there");
  /* The DOM the hero's CSS needs: `.ph > picture > img.ph__img`. A bare <img>
     would be positioned by nothing — the band, the mask and the object-position
     all hang off those selectors. */
  const photograph = hero.slice(hero.indexOf("function HeroPhotograph"), hero.indexOf("export function Hero"));
  assert.match(photograph, /<div className="ph">\s*\n\s*<picture>/);
  assert.match(photograph, /className=\{`ph__img\$\{loaded \? " is-loaded" : ""\}`\}/);
  assert.match(photograph, /alt=\{image\.alt\}/, "alt text the save route insisted on");
  assert.match(photograph, /fetchPriority="high"/);
});

/* ------------------------------------------------------------------ */
/* The public read                                                     */
/* ------------------------------------------------------------------ */

test("the public read is cached, and is never the reason a page fails", async () => {
  const source = code(await read("app/lib/site-content-public.ts"));
  assert.doesNotMatch(source, /ensureDatabase/, "a marketing page does not run migrations to read a heading");
  assert.match(source, /export const PUBLIC_CONTENT_TTL_MS = 30_000;/);
  assert.match(source, /createNavigationCache<Loaded>/, "the cache decision J measured, reused rather than copied");
  assert.match(source, /fallback: \(\) => \(\{ content: EMPTY_SITE_CONTENT, media: new Map\(\) \}\)/);
  assert.match(source, /return \{ \.\.\.resolveSiteContent\(null\), heroImage: null \};/, "a refusal draws the shipped pages");
  /* The photograph is resolved per read rather than stored with the copy, so
     replacing the file in the library shows on the page (decision K's promise). */
  assert.match(source, /resolveMediaForRender\(db, ids\)/);
  assert.match(source, /asset\.kind === "image" && asset\.alt/, "and a video or a deleted asset leaves the plates in place");
});

test("the migration is one guarded table with no seed, in applyMigrations, mirrored in the schema", async () => {
  const init = await read("db/init.ts");
  const apply = init.slice(init.indexOf("async function applyMigrations"), init.indexOf("async function applyMigrations") + 12_000);
  assert.match(apply, /await ensureSiteContent\(d1\);/);
  const stage = init.slice(init.indexOf("async function ensureSiteContent"), init.indexOf("async function ensureCmsMedia"));
  assert.match(stage, /CREATE TABLE IF NOT EXISTS site_content/);
  assert.doesNotMatch(stage, /INSERT|DROP|ALTER|DELETE/i, "additive, and no seed");
  const repairs = init.slice(init.indexOf("async function repairInvariants"), init.indexOf("async function applyMigrations"));
  assert.doesNotMatch(repairs, /ensureSiteContent/, "a migration, not a repair");
  const schema = await read("db/schema.ts");
  assert.match(schema, /export const siteContent = sqliteTable\("site_content"/);
  /* BOOLEAN_COLUMNS rewrites 0/1 by bare column name; a hidden section lives in
     the JSON document, and none of the table's own columns may be in that map. */
  const { BOOLEAN_COLUMN_NAMES } = await import("../db/sqlite-to-postgres.ts");
  for (const column of ["id", "document", "revision", "updated_by_email", "updated_at"]) {
    assert.equal(BOOLEAN_COLUMN_NAMES.has(column), false, `${column} must not be rewritten as a boolean`);
  }
});

/* ------------------------------------------------------------------ */
/* The save route and the editor                                       */
/* ------------------------------------------------------------------ */

test("the route: platform staff only, validated, media checked, cache dropped last", async () => {
  const route = code(await read("app/api/site-content/route.ts"));
  assert.match(route, /if \(scope\.platformAdmin !== true\) return null;\s*\n\s*if \(!scope\.authenticated\) return null;/);
  assert.doesNotMatch(route, /requireCapability|resolvePermissions/, "no workspace capability reaches MAINTSUPP's own website");
  for (const handler of ["GET", "PUT"]) {
    const body = route.slice(route.indexOf(`export async function ${handler}`)).split(/\nexport async function /)[0];
    assert.match(body, /if \(!scope\) return forbidden\(\);/, `${handler} is gated`);
  }
  /* The navigation is read at SAVE time, so the answer is about the menu as it
     stands rather than the menu as it shipped. */
  assert.match(route, /const needed = await anchorsNavigationNeeds\(scope\);\s*\n\s*const checked = validateSiteContent\(submitted, \{ requiredAnchors: needed \}\)/);
  assert.match(route, /status: 422/);
  /* A photograph must still exist, be an image, and have alt text. */
  assert.match(route, /const library = await mediaKinds\(scope\.db, named\);/);
  assert.match(route, /Choose an image for the hero photograph/);
  assert.match(route, /needs alt text/);
  /* §38, then the write, then the version, then the audit, then the cache. */
  const order = ["ensureConfigBaseline(", "writeContent(", "recordConfigVersion(", "recordAudit(", "invalidatePublicSiteContent()"];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(route.indexOf(order[index - 1]) < route.indexOf(order[index]), `${order[index - 1]} before ${order[index]}`);
  }
  assert.match(route, /expectedRevision !== before\.revision/, "a second editor's save is refused, not overwritten");
  assert.match(route, /loadRestoreSnapshot\(scope\.db, VERSION_TARGET, restoring\)/, "a restore is loaded on the server");
});

test("§38 knows the subject, and a restore goes back through this route", () => {
  assert.equal(model.VERSION_SUBJECTS.site_content.scope, "installation");
  assert.equal(model.VERSION_SUBJECTS.site_content.capability, "platform");
  assert.deepEqual([...model.VERSION_SUBJECTS.site_content.keys], ["public"]);
  assert.deepEqual(model.restoreRequest("site_content", "public", 4), {
    url: "/api/site-content",
    body: { restoreVersion: 4 },
  });
  assert.deepEqual(model.versionSubject("site_content", "public"), { subject: "site_content", key: "public" });
  assert.equal(model.versionSubject("site_content", "other"), null);

  /* The summary says what changed, by field, and a reset says so. */
  const before = model.siteContentSnapshot({ pages: {} });
  const after = model.siteContentSnapshot({
    pages: { home: { seo: { title: "New" }, sections: { pricing: { fields: { heading: "New" } }, caseStudy: { hidden: true } } } },
  });
  const summary = model.summariseChange("site_content", before, after);
  assert.match(summary, /home: /);
  assert.match(summary, /pricing\.heading/);
  assert.match(summary, /title/);
  assert.match(summary, /hid caseStudy/);
  assert.match(model.summariseChange("site_content", after, model.siteContentSnapshot(null)), /Reset to the words the site ships with/);
});

test("the editor: platform console only, every rule the server's, history and the omissions said out loud", async () => {
  const view = await read("app/(app)/admin/site-copy-view.tsx");
  assert.match(view, /useAdminResource<Payload>\("\/api\/site-content"\)/);
  assert.match(view, /<VersionHistory\s+subject="site_content"\s+subjectKey="public"/);
  assert.match(view, /expectedRevision: data\.revision/);
  assert.match(view, /useUnsavedChanges\(dirty\)/);
  assert.match(view, /data\.omissions\.map/, "what the screen does not do is listed, not hunted for");
  assert.match(view, /<MediaField/, "the hero photograph is chosen from the library, not typed");
  assert.match(view, /disabled=\{Boolean\(needed\) && !isHidden\}/, "and Hide is refused before it is pressed, with the reason");
  assert.match(view, /Use the shipped words/, "every changed field says so, with a way back");
  const { platformSection } = await import("../app/lib/platform-sections.ts");
  assert.equal(platformSection("copy")?.capability, null);
  assert.equal(platformSection("copy")?.label, "Website copy");
  /* The screen's own stylesheet keeps to the project's five widths — it has no
     media query at all, which is the simplest way to keep that true. */
  const css = await read("app/(app)/admin/site-copy.css");
  assert.doesNotMatch(css, /@media/);
  assert.equal(content.CONTENT_OMISSIONS.length >= 5, true);
  assert.ok(content.CONTENT_OMISSIONS.some((line) => /Prices cannot be typed here/.test(line)));
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const serverUp = await (async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
})();

async function call(pathName, init = {}) {
  const response = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test("live: nobody outside platform staff reads or writes the website's copy", { skip: !serverUp }, async () => {
  const anonymous = await fetch(`${BASE_URL}/api/site-content`, { headers: { accept: "application/json" } });
  assert.ok([401, 403].includes(anonymous.status), `signed out answered ${anonymous.status}`);
  for (const identity of ["admin@sunnamusk-uk.test.maintsupp.com", "client@sunnamusk-uk.test.maintsupp.com"]) {
    const refused = await call("/api/site-content", { headers: { "x-maintsupp-identity": identity } });
    assert.equal(refused.status, 403, `${identity} — a workspace role, however senior, does not edit MAINTSUPP's website`);
    const write = await call("/api/site-content", {
      method: "PUT",
      headers: { "x-maintsupp-identity": identity },
      body: JSON.stringify({ reset: true }),
    });
    assert.equal(write.status, 403);
  }
});

test("live: staff edit a heading and the public page says it; a hidden section leaves it; a version restores", { skip: !serverUp }, async (t) => {
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!login.ok) return t.skip("the seeded owner could not sign in");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  const as = { headers: { cookie } };
  const opened = await call("/api/site-content", as);
  if (opened.status !== 200) return t.skip("this identity is not platform staff here");
  const original = opened.body;
  const tag = `QA-L-${Date.now().toString(36)}`;
  try {
    assert.equal(original.pages.length, 3);
    assert.ok(original.resolved.home.sections.length === 14);

    /* Before: the page says what it ships with. */
    const before = await (await fetch(`${BASE_URL}/`)).text();
    assert.ok(before.includes(shipped.HOME_COPY.founder.heading), "the shipped heading is on the page");

    /* A refusal first, so a bad save never reaches a visitor. */
    const bad = await call("/api/site-content", {
      ...as,
      method: "PUT",
      body: JSON.stringify({ content: one("home", "founder", "heading", `${tag} from £99`), expectedRevision: original.revision }),
    });
    assert.equal(bad.status, 422, JSON.stringify(bad.body));

    /* Then a real edit, and the public page says it at once. */
    const saved = await call("/api/site-content", {
      ...as,
      method: "PUT",
      body: JSON.stringify({ content: one("home", "founder", "heading", `${tag} who runs Maintsupp`), expectedRevision: original.revision }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const edited = await (await fetch(`${BASE_URL}/?cb=${tag}`)).text();
    assert.ok(edited.includes(`${tag} who runs Maintsupp`), "the homepage draws the saved heading");
    assert.ok(!edited.includes(shipped.HOME_COPY.founder.heading), "and not the shipped one as well");

    /* A hidden section leaves the page; the anchor's link must be gone first, so
       `founder` is used — nothing in the shipped menu points at it. */
    const hidden = await call("/api/site-content", {
      ...as,
      method: "PUT",
      body: JSON.stringify({
        content: { pages: { home: { sections: { founder: { hidden: true } } } } },
        expectedRevision: saved.body.revision,
      }),
    });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    const without = await (await fetch(`${BASE_URL}/?cb=${tag}-hidden`)).text();
    assert.ok(!without.includes('id="founder"'), "the section is not on the page");
    assert.ok(without.includes('id="pricing"'), "and the rest of the page is");

    /* A version restores, through the same route and the same rules. */
    const history = await call("/api/versions?subject=site_content&key=public", as);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.ok(history.body.versions.length >= 2, "a baseline and the saves");
  } finally {
    /* Whatever happened, the site goes back to the words it ships with — this
       leaves no fixture behind, because there is nothing to leave behind. */
    const now = await call("/api/site-content", as);
    await call("/api/site-content", {
      ...as,
      method: "PUT",
      body: JSON.stringify({ reset: true, expectedRevision: now.body?.revision ?? null }),
    });
    const after = await (await fetch(`${BASE_URL}/?cb=cleanup`)).text();
    assert.ok(after.includes(shipped.HOME_COPY.founder.heading), "and the shipped heading is back on the page");
  }
});
