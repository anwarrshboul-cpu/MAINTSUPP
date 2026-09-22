/**
 * Phase 4 — the website CMS.
 *
 * What these assertions are actually for, because a CMS is a feature where the
 * plausible-looking version and the real one are hard to tell apart:
 *
 *   1. the two tables are installation-wide, additive, and in the half of the boot
 *      path that runs once;
 *   2. nothing an editor types can become markup or a scheme a browser will follow;
 *   3. the copy rules that three source-text tests enforce today do not quietly
 *      stop applying the moment copy lives in a database;
 *   4. the console reads the block catalogue from the SERVER rather than keeping a
 *      copy of it — the mistake Phase 6 paid for;
 *   5. the gaps are named rather than implied.
 *
 * Comments are stripped before any ABSENCE assertion. Three times in this program a
 * test passed or failed on its own explanatory prose rather than on code.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BLOCK_CATALOGUE,
  BLOCK_KINDS,
  CMS_OMISSIONS,
  CONTENT_RULES,
  claimViolation,
  cleanHref,
  cleanSlug,
  readBlockBody,
  RESERVED_SLUGS,
  validateBlock,
} from "../app/lib/cms-blocks.ts";
import { PLATFORM_SECTIONS, platformSection } from "../app/lib/platform-sections.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const decommented = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/* ------------------------------------------------------------------ */
/* The migration                                                       */
/* ------------------------------------------------------------------ */

test("the two tables are created once, in applyMigrations, and never repaired", async () => {
  const init = await read("db/init.ts");

  assert.match(init, /async function ensureSitePages\(d1: D1DatabaseLike\)/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS site_pages \(/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS site_blocks \(/);

  /*
   * IN `applyMigrations`, NOT `repairInvariants`, and the difference is not
   * stylistic. `repairInvariants` runs on EVERY cold start regardless of the
   * fingerprint, so anything in it is paid for ever; `applyMigrations` runs only
   * when the fingerprint has moved. Four guarded DDL statements have work to do
   * exactly once, so they belong in the half that stops running.
   *
   * The inverse mistake is the one CLAUDE.md warns about: a repair placed here
   * stops running the day the fingerprint settles.
   */
  /* Each body from its own declaration to the NEXT declaration, whatever the file's
     order happens to be. Slicing between two named functions in an assumed order is
     how this assertion first compared against an empty string: `applyMigrations` is
     defined after `repairInvariants` here, not before it. */
  const bodyOf = (name) => {
    const start = init.indexOf(`async function ${name}`);
    assert.ok(start > -1, `${name} is gone`);
    const end = init.indexOf("\nasync function", start + 10);
    return init.slice(start, end === -1 ? undefined : end);
  };
  const migrations = bodyOf("applyMigrations");
  const repairs = bodyOf("repairInvariants");
  assert.match(migrations, /await ensureSitePages\(d1\);/);
  assert.doesNotMatch(
    decommented(repairs),
    /ensureSitePages/,
    "a one-time table creation must not run on every cold start",
  );
});

test("the CMS tables are installation-wide, and say why", async () => {
  const init = await read("db/init.ts");
  const stage = init.slice(
    init.indexOf("async function ensureSitePages"),
    init.indexOf("async function ensureThemeTokens"),
  );

  /*
   * NO `organisation_id`, deliberately. Every other content table in this schema
   * carries one because every other one holds a CUSTOMER's data. These hold
   * MAINTSUPP's own marketing site: there is one maintsupp.com, its pages are the
   * same for every visitor, and a visitor has no account to scope by.
   *
   * This is the assertion to change if that decision is ever revisited — and
   * revisiting it means answering the question the absence avoids: whose homepage
   * is this?
   */
  assert.doesNotMatch(
    decommented(stage),
    /organisation_id/,
    "site_pages and site_blocks are MAINTSUPP's own site, not a tenant's",
  );

  assert.match(stage, /CREATE UNIQUE INDEX IF NOT EXISTS site_pages_slug_idx ON site_pages\(slug\)/);
  assert.match(stage, /CREATE INDEX IF NOT EXISTS site_blocks_page_idx ON site_blocks\(page_id, position\)/);

  /* No seed. An empty `site_pages` is a correct installation: the six static
     marketing routes are the site today, and owner decision D5 is that the live
     homepage is not converted in this phase. The same argument
     `ensurePortalModuleSettings` makes, and `portal-module-registry` asserts. */
  assert.doesNotMatch(decommented(stage), /INSERT/, "the first slice seeds nothing");
});

test("published is a plain integer, because the shim matches by bare column name", async () => {
  const init = await read("db/init.ts");
  const shim = await read("db/sqlite-to-postgres.ts");
  const schema = await read("db/schema.ts");

  assert.match(init, /published INTEGER NOT NULL DEFAULT 0/);

  /*
   * `BOOLEAN_COLUMNS` is keyed by BARE COLUMN NAME across the whole schema, so a
   * column called `visible`, `active` or `archived` would be rewritten into a
   * Postgres boolean wherever it appeared. `published` is not in that map, so an
   * integer means the same thing on both dialects with nothing to translate — the
   * choice `portal_module_settings.enabled` already made.
   *
   * If a later change adds `published` to that map, this fails, and it should:
   * `cms-repository.ts` compares the column against the literal 1.
   */
  const booleans = shim.slice(shim.indexOf("BOOLEAN_COLUMNS"), shim.indexOf("TIMESTAMP_COLUMN"));
  assert.doesNotMatch(booleans, /"published"/, "published must stay an integer on both dialects");

  /* The drizzle mirror agrees: an integer column, NOT `{ mode: "boolean" }`, which
     would ask the shim to translate a column it must not translate. */
  assert.match(schema, /published: integer\("published"\)/);
  assert.doesNotMatch(
    schema.slice(schema.indexOf("export const sitePages")),
    /published:[^,\n]*mode: "boolean"/,
    "asking for a boolean here would contradict BOOLEAN_COLUMNS",
  );
});

/* ------------------------------------------------------------------ */
/* What may be stored                                                  */
/* ------------------------------------------------------------------ */

test("a link is allowed by shape, not refused by blocklist", () => {
  /*
   * An allowlist of exactly two shapes — a same-site path, or an https:// URL. That
   * is the whole point: `javascript:`, `data:`, `vbscript:` and whatever is invented
   * next are refused because they are not on the list, rather than because somebody
   * remembered to add them.
   */
  assert.equal(cleanHref("/contractors"), "/contractors");
  assert.equal(cleanHref("https://maintsupp.com/faqs"), "https://maintsupp.com/faqs");

  for (const hostile of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "http://maintsupp.com",
    "//evil.example",
    "mailto:someone@example.com",
    "",
    "   ",
  ]) {
    assert.equal(cleanHref(hostile), null, `${hostile} must not become an href`);
  }

  /* A protocol-relative URL reads like a path and points somewhere else entirely. */
  assert.equal(cleanHref("//maintsupp.com"), null);
});

test("a slug cannot collide with a route the site already answers", () => {
  assert.equal(cleanSlug("How-We-Work"), "how-we-work");
  assert.equal(cleanSlug("our-approach"), "our-approach");

  for (const taken of RESERVED_SLUGS) {
    assert.equal(cleanSlug(taken), null, `${taken} already means something`);
  }
  /* `p` itself is reserved, so `/p/p` cannot exist. */
  assert.ok(RESERVED_SLUGS.includes("p"));
  /* Every static marketing route is reserved. `/p/terms` would not collide
     technically — the prefix keeps them apart — but two pages called "terms" on
     one site is a support call. */
  for (const route of ["contractors", "cookies", "faqs", "privacy", "terms"]) {
    assert.ok(RESERVED_SLUGS.includes(route), `${route} is a real page already`);
  }

  for (const malformed of ["a--b", "-x", "x-", "Ünicode", "with space", "a/b", "a_b", ""]) {
    assert.equal(cleanSlug(malformed), null, `${malformed} is not a URL segment`);
  }
});

test("validation builds a new body, so an unknown key cannot ride along", () => {
  const checked = validateBlock("heading", {
    title: "How we work",
    eyebrow: "The service",
    /* Not in the catalogue. It must not reach storage, whatever it is. */
    onClick: "alert(1)",
    dangerouslySetInnerHTML: { __html: "<script>x</script>" },
  });
  assert.ok(checked.ok);
  assert.deepEqual(Object.keys(checked.body).sort(), ["eyebrow", "title"]);
});

test("a required field refuses the block; an optional one is dropped", () => {
  const missing = validateBlock("heading", { eyebrow: "Only an eyebrow" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /title is required/);

  const dropped = validateBlock("heading", { title: "A title", eyebrow: "   " });
  assert.ok(dropped.ok);
  assert.equal("eyebrow" in dropped.body, false, "an empty optional field is absent, not empty");

  /* A CTA with no destination is not a CTA. The message names the shape rather
     than saying "invalid", because an editor has to be able to fix it. */
  const noHref = validateBlock("cta", { title: "Talk to us", buttonLabel: "Book", buttonHref: "javascript:x" });
  assert.equal(noHref.ok, false);
  assert.match(noHref.reason, /path beginning "\/" or an https:\/\/ address/);
});

test("a stored row this build no longer understands is skipped, not thrown on", () => {
  assert.equal(readBlockBody("heading", '{"title":"Kept"}').title, "Kept");
  assert.equal(readBlockBody("heading", "{not json"), null);
  assert.equal(readBlockBody("retiredBlockKind", '{"title":"x"}'), null);
  /* A row that no longer satisfies its own catalogue entry. Storage is the past;
     the catalogue is the present. */
  assert.equal(readBlockBody("cta", '{"title":"x"}'), null);
});

test("every catalogue entry has a renderer, and every renderer an entry", async () => {
  const blocks = await read("app/(marketing)/_cms/blocks.tsx");
  for (const kind of BLOCK_KINDS) {
    assert.match(blocks, new RegExp(`case "${kind}":`), `${kind} has no renderer`);
  }
  const cases = [...blocks.matchAll(/case "([a-zA-Z]+)":/g)].map((match) => match[1]);
  assert.deepEqual(
    cases.sort(),
    [...BLOCK_KINDS].sort(),
    "a renderer with no catalogue entry can never be reached, and a catalogue entry with no renderer draws nothing",
  );
  /* RE-POINTED 5 → 7 (decision K): `image` and `video` arrived with the media
     library, each drawing its asset with its own element (`<img>`, `<video>`) —
     distinct renderers, which is the rule this count protects. */
  assert.equal(BLOCK_CATALOGUE.length, 7, "seven blocks, each earning a distinct renderer");
});

/* ------------------------------------------------------------------ */
/* The copy rules a database would otherwise switch off                */
/* ------------------------------------------------------------------ */

test("the claims rules survive the move from source text into rows", async () => {
  /*
   * THE POINT OF THIS TEST.
   *
   * Three test files enforce the owner's copy rules by reading SOURCE TEXT:
   * `stage-twentyeight-landing-rebuild` walks `app/(marketing)` for six forbidden
   * phrases, and `homepage-v3` walks it twice more — for a VAT qualifier and for a
   * currency symbol followed by a digit outside `pricing.tsx`.
   *
   * A CMS moves copy out of source. On the day the first page is published, all
   * three go blind on exactly the surface they protect — not relaxed, not
   * reconsidered, silently unenforced. So they are applied to stored content
   * instead, and this asserts that they are.
   */
  for (const copy of [
    "We send our engineers within the hour.",
    "Our nationwide team covers every postcode.",
    "24/7 coverage at every site.",
    "A guaranteed same-day fix.",
    "We deliver a 100% first-time fix rate.",
    "We certify every installation.",
  ]) {
    assert.ok(claimViolation(copy), `${copy} is one of the six the brief forbids`);
  }

  for (const copy of [
    "95 per site + VAT.",
    "Prices ex VAT.",
    "Figures excluding VAT.",
    "Charged plus VAT.",
    "VAT extra on callouts.",
    "Our prices are subject to VAT.",
  ]) {
    assert.ok(claimViolation(copy), `${copy} claims a VAT status this company does not have`);
  }

  /* The one permitted mention, and it must survive being wrapped across lines the
     way the source test allows it to be. */
  /* The company's approved legal name since #63 (same company number 17262302). */
  assert.equal(claimViolation("MAINTSUPP LTD is not currently VAT registered."), null);
  assert.equal(claimViolation("MAINTSUPP LTD is not currently\n  VAT registered."), null);
  assert.doesNotMatch(
    CONTENT_RULES.map((rule) => rule.reason).join(" "),
    /Maintauk/,
    "every refusal names the company by its current legal name",
  );

  /* A price. `_sections/rates.ts` is the single source for every figure on the
     site and checks its own invariant at module load; a number typed into a page
     could not be reconciled with it, and nothing would notice them disagreeing. */
  assert.ok(claimViolation("From £295 a month."));
  assert.ok(claimViolation("£ 95 per site."));

  /* Ordinary copy passes. The rule is `our engineers`, not `engineers` — a page may
     still say whose engineers it coordinates. */
  assert.equal(claimViolation("We coordinate the engineers your landlord already uses."), null);
  assert.equal(claimViolation("One point of contact for every site you run."), null);
});

test("a forbidden phrase refuses the block, at any depth the catalogue allows", () => {
  const flat = validateBlock("richText", { paragraphs: ["Our engineers attend within the hour."] });
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /our engineers/);

  /* Nested inside a question-and-answer pair, which is the depth a naive check
     would miss. */
  const nested = validateBlock("faq", {
    pairs: [{ question: "What does it cost?", answer: "From £95 + VAT." }],
  });
  assert.equal(nested.ok, false);

  const clean = validateBlock("faq", {
    pairs: [{ question: "Who attends?", answer: "An approved contractor, with photographs." }],
  });
  assert.ok(clean.ok);
});

test("the page's own title and meta fields go through the same rules", async () => {
  const route = await read("app/api/site-pages/route.ts");
  assert.match(route, /claimViolation\(/);
  /* `validateBlock` cannot reach them — they are columns on the page, not fields in
     a block — and a forbidden phrase in a meta description is the worst place for
     one: it is what a search result shows, and nothing on the page would reveal it. */
  assert.match(route, /input\.title, input\.metaTitle, input\.metaDescription/);
});

test("each content rule carries its reason, not just its pattern", () => {
  assert.ok(CONTENT_RULES.length >= 13);
  for (const rule of CONTENT_RULES) {
    assert.ok(rule.pattern instanceof RegExp);
    assert.ok(
      rule.reason && rule.reason.length > 20,
      "a refusal an editor cannot act on is a bug report addressed to nobody",
    );
  }
});

/* ------------------------------------------------------------------ */
/* Reading and writing                                                 */
/* ------------------------------------------------------------------ */

test("the repository holds no cache, for the reason already paid for twice", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  const body = decommented(repository);

  /*
   * `theme-repository.ts` shipped with a thirty-second per-isolate cache and
   * authenticated Preview QA proved it wrong: the write invalidated one serverless
   * instance while the read landed on another. There is no cross-instance channel
   * in this product. It would matter more here — a stale read on a public page
   * means an editor publishes a correction, reloads, and sees the old wording.
   */
  assert.doesNotMatch(body, /cacheUntil|CACHE_MS|let cached|cache =/, "no cache on this path");
  assert.doesNotMatch(body, /Date\.now\(\) [<>]/, "no time-based staleness either");
});

test("a published page is decided by the column, compared against 1", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  /* Explicitly against 1 rather than for truthiness: it is a plain integer on both
     dialects, and comparing explicitly means a NULL — which the column forbids but a
     hand-written row could carry — reads as unpublished. The safe direction. */
  assert.match(repository, /eq\(sitePages\.published, 1\)/);
  /* RE-POINTED when the CMS gained a publishing window: the two row readers
     became one `toPage`, which decides `published` once, still explicitly
     against 1, and derives the page's state from it. */
  assert.match(repository, /const published = page\.published === 1;/);
});

test("a failed read is a 404, not a 500", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  const page = await read("app/(marketing)/p/[slug]/page.tsx");

  /* `readPublishedPage` returns null when it cannot answer and the route turns that
     into `notFound()`. A 500 on a public URL invites a retry, looks like an outage
     to a crawler, and the visitor can do nothing with it either way. */
  assert.match(repository, /could not read the published page[\s\S]{0,80}return null;/);
  assert.match(page, /if \(!page\) notFound\(\);/);
});

test("a write replaces the page and all of its blocks, in one call", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  assert.match(repository, /await db\.delete\(siteBlocks\)\.where\(eq\(siteBlocks\.pageId, id\)\)/);
  /* `published_at` is set once and never cleared: it records when the page first
     went public, which is a fact about history. Unpublishing does not un-happen it. */
  assert.match(repository, /existing\[0\]\?\.publishedAt \?\? \(input\.published \? now : null\)/);
});

test("deleting a marketing page is a real delete, and says why", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  /* A workspace's records go to a recycle bin because they are a customer's data. A
     marketing page is MAINTSUPP's own copy, re-creatable by whoever wrote it, and a
     published URL that is "archived" but still resolving would be worse than gone. */
  assert.match(repository, /export async function deletePage/);
  assert.match(repository, /await db\.delete\(sitePages\)\.where\(eq\(sitePages\.id, id\)\)/);
  assert.doesNotMatch(
    decommented(repository).slice(decommented(repository).indexOf("export async function deletePage")),
    /archived|archivedAt/,
    "this path does not pretend to archive",
  );
});

/* ------------------------------------------------------------------ */
/* Authority                                                           */
/* ------------------------------------------------------------------ */

test("all three methods answer to platform staff, and GET is gated too", async () => {
  const route = await read("app/api/site-pages/route.ts");

  assert.match(route, /scope\.platformAdmin !== true/);
  assert.match(route, /if \(!scope\.authenticated\) return null;/);
  for (const method of ["GET", "PUT", "DELETE"]) {
    const slice = route.slice(route.indexOf(`export async function ${method}(`));
    assert.match(
      slice.slice(0, 400),
      /const scope = await platformScope\(request\);\s*\n\s*if \(!scope\) return forbidden\(\);/,
      `${method} must be gated before it does anything`,
    );
  }

  /*
   * ⚠️ AND THE REFUSAL MUST BE BUILT PER CALL, NOT SHARED.
   *
   * This route shipped with a module-level `const` holding a `Response.json(…)`,
   * returned from all three methods. A `Response` body is a stream that can be
   * consumed once, so the first refusal in a serverless instance answered 403 and
   * every one after it in the same instance became a 500 — measured on a deployed
   * Preview with a real signed-in non-platform-admin: GET 403, PUT 500, DELETE 500.
   *
   * The authorization was right and the answer was wrong, which is the worse
   * combination: a 500 is what a client retries, and it makes an ordinary refusal
   * look like an outage. No other route in `app/api/` shares a Response instance,
   * which is why nothing caught it and why no SOURCE test could — the pin that all
   * three methods are gated identically passed, because they are.
   */
  assert.doesNotMatch(
    decommented(route),
    /^const\s+[A-Z_]+\s*=\s*Response\.json\(/m,
    "a module-level Response is consumed once; build the refusal per call",
  );
  assert.match(route, /function forbidden\(\) \{/);
  assert.equal(
    (route.match(/return forbidden\(\);/g) ?? []).length,
    3,
    "all three methods must refuse through the fresh-response helper",
  );

  /*
   * NOT a capability, and the route says why at length. Every capability in this
   * product is per-workspace; `can()` returns true for `super_admin` before it
   * reads anything, so it cannot tell platform staff from a client's Owner. An
   * Owner editing maintsupp.com is not a thing this product should express.
   */
  assert.doesNotMatch(
    decommented(route),
    /scopedDbWithCapability|can\(/,
    "a per-workspace capability is the wrong instrument for one shared website",
  );
});

test("a write is audited, with the slug as the entity", async () => {
  const route = await read("app/api/site-pages/route.ts");
  for (const action of [
    "site_page.created",
    "site_page.updated",
    "site_page.published",
    "site_page.deleted",
  ]) {
    assert.ok(route.includes(`"${action}"`), `${action} must reach the audit trail`);
  }
  /* The slug rather than the row id: a reader of the trail wants to know which page
     changed, and the slug is how anybody refers to it. */
  assert.match(route, /entityType: "site_page",\s*\n\s*entityId: slug,/);
});

test("every block is validated before any of it is written", async () => {
  const route = await read("app/api/site-pages/route.ts");
  const put = route.slice(route.indexOf("export async function PUT"), route.indexOf("export async function DELETE"));
  /* A partial save leaves an editor looking at a page that is neither what they had
     nor what they asked for, with no way to tell which half landed. The same reason
     `/api/theme` validates a whole batch first. */
  assert.ok(
    put.indexOf("validateBlock") < put.indexOf("writePage"),
    "validation must finish before the write starts",
  );
  assert.match(put, /A page may have at most 40 blocks/);
});

/* ------------------------------------------------------------------ */
/* The public page                                                     */
/* ------------------------------------------------------------------ */

test("the renderer is a server component and interpolates no HTML", async () => {
  const blocks = await read("app/(marketing)/_cms/blocks.tsx");

  /* The FIRST LINE, not the first 200 characters: the header comment explains that
     this file is deliberately not a client component, and an absence assertion over
     the prose would fail on the sentence describing the absence. */
  assert.doesNotMatch(
    blocks.split("\n")[0],
    /"use client"/,
    "a block has no interactivity, and a client block could not read the database",
  );
  /*
   * NO `dangerouslySetInnerHTML` ANYWHERE ON THIS PATH. It is why
   * `app/lib/cms-blocks.ts` is a shape validator and not a sanitiser: every stored
   * value reaches the DOM as a text child or a plain attribute, so React escapes
   * it. The day that stops being true, the validator is no longer sufficient.
   */
  for (const file of [
    "app/(marketing)/_cms/blocks.tsx",
    "app/(marketing)/p/[slug]/page.tsx",
    "app/(app)/admin/site-pages-view.tsx",
  ]) {
    assert.doesNotMatch(
      decommented(await read(file)),
      /dangerouslySetInnerHTML/,
      `${file} must not interpolate stored content as markup`,
    );
  }
});

test("the block library is NOT in _sections, and the reason is measurable", async () => {
  /*
   * `tests/stage-twelve-images.test.mjs` deep-equals the exact list of files in
   * `_sections/` that render a photograph, and `tests/stage-eleven-marketing.test.mjs`
   * fails any file there but `workflow.tsx` that names three workflow stages. A CMS
   * block library in that directory would break the first the day it renders an
   * image and the second the day somebody writes a stage name into a page.
   *
   * Asserted rather than trusted to a comment, because the pressure to "put it with
   * the other sections" will come back.
   */
  const { readdir } = await import("node:fs/promises");
  const sections = await readdir(path.join(root, "app/(marketing)/_sections"));
  assert.equal(sections.includes("blocks.tsx"), false);
  const cms = await readdir(path.join(root, "app/(marketing)/_cms"));
  assert.ok(cms.includes("blocks.tsx"));
});

test("the public page declares its own canonical, because the root declares one", async () => {
  const page = await read("app/(marketing)/p/[slug]/page.tsx");
  const layout = await read("app/layout.tsx");

  /* `app/layout.tsx` sets a root `alternates: { canonical: "/" }`, so a page that
     declares none inherits it and tells a crawler it is the homepage. Four of the
     existing static marketing pages do exactly that today; a page whose address is
     its identity cannot afford to. */
  assert.match(layout, /alternates: \{\s*\n\s*canonical: "\/",/);
  /* RE-POINTED when a page gained a canonical OVERRIDE: the page's own address
     is now the fallback of a same-site override (`cleanCanonical` refuses any
     other host), and is still what a page with none declares — never the
     root's "/". */
  assert.match(page, /const canonical = page\.canonicalUrl \?\? `https:\/\/maintsupp\.com\/p\/\$\{page\.slug\}`;/);
  assert.match(page, /alternates: \{ canonical \}/);

  /* `absolute`, for the reason `/contractors` records: the root template is
     `%s | MAINTSUPP`, so a meta title carrying the suffix would ship it twice. */
  assert.match(page, /title: \{ absolute: title \}/);
  assert.match(page, /export async function generateMetadata/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
});

test("a draft is indistinguishable from a page that never existed", async () => {
  const repository = await read("app/lib/cms-repository.ts");
  const page = await read("app/(marketing)/p/[slug]/page.tsx");

  /* `readPublishedPage` filters on `published` in the query, so a draft never
     reaches the route at all. Anything softer would let an outsider tell "this
     exists but is not published" from "this does not exist". */
  assert.match(repository, /eq\(sitePages\.slug, slug\), eq\(sitePages\.published, 1\)/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
});

test("a CMS page is not in the static sitemap, and the test that walks it knows", async () => {
  const sitemapTest = await read("tests/sitemap-lastmod.test.mjs");
  const sitemap = await read("public/sitemap.xml");

  /* The on-disk walk used to claim every `page.tsx` under `app/(marketing)`, which
     was right while all of them had fixed addresses. `[slug]` begins with neither
     `_` nor `(`, so it descended and demanded the literal "/p/[slug]" in the file.
     Re-pointed, with the reason written into that test. */
  assert.match(sitemapTest, /RE-POINTED when the website CMS added/);
  assert.match(sitemapTest, /dynamicRoutes/);
  assert.doesNotMatch(sitemap, /\/p\//, "no CMS page is listed in the build artifact");

  /* RE-POINTED when CMS pages gained a sitemap of their own. They are listed in
     `/sitemap-pages.xml`, read live, and robots.txt names it beside the static
     one — the static file keeps its git-derived dates and never lists a /p/
     address. Where a published page IS listed is stated in the console. */
  assert.match(await read("public/robots.txt"), /^Sitemap: https:\/\/maintsupp\.com\/sitemap-pages\.xml$/m);
  assert.ok(
    CMS_OMISSIONS.some((omission) => /sitemap-pages\.xml/.test(omission) && /sitemap\.xml/.test(omission)),
    "the console must say which sitemap a published page is in",
  );
});

/* ------------------------------------------------------------------ */
/* The console                                                         */
/* ------------------------------------------------------------------ */

test("the console lists the screen because the screen has an API", async () => {
  const section = platformSection("pages");
  assert.ok(section, "pages must be in the catalogue");
  assert.equal(section.label, "Website pages");
  /* SEVEN once the website CMS and the enquiries inbox are both merged: each
     phase added one entry, and each phase's own test said six while it was the
     only one landed. `platform-admin-shell.test.mjs` compares against its own
     ENTRIES list rather than a literal, so it needed no change.
     Re-pointed 7 → 8 when the contractor applications inbox arrived with its own
     API (`/api/contractor-applications/inbox`) — the same rule kept once more.
     Re-pointed 8 → 9 for Backups (§39), which arrived with `/api/admin/backups`.
     Re-pointed 9 → 10 for Website navigation (decision J), which arrived with
     `/api/site-navigation`.
     Re-pointed 10 → 11 for Website media (decision K), which arrived with
     `/api/cms-media` and its upload route. */
  assert.equal(PLATFORM_SECTIONS.length, 11);

  /* `capability: null` is the honest answer and the first entry to need it. The
     other five name the capability their own API enforces so the two cannot drift;
     this API enforces none, because every capability here is per-workspace and this
     site is not in a workspace. */
  assert.equal(section.capability, null);

  /*
   * EXACTLY TWO entries may be null, and they are named rather than counted.
   *
   * This loop used to exclude only `pages`, which was right while it was the sole
   * nullable entry. The enquiries inbox is the second, for a related but distinct
   * reason that `platform-sections.ts` states separately: its rows carry a
   * customer's `organisation_id` and belong to the platform anyway. Naming both
   * keeps the assertion strict — a third nullable entry has to be added here
   * deliberately, which is the point of the rule.
   *
   * And a third was: `applications`, the contractor applications inbox, for the
   * leads entry's own reason — an anonymous application used to be filed under a
   * client's workspace, and the rows belong to the platform either way.
   *
   * And a fourth: `backups` (§39), which is not in any workspace at all — it
   * describes the deployment's database, storage and migrations, so no
   * per-workspace capability could be right about it.
   *
   * And a fifth: `navigation` (decision J), for the pages entry's own reason —
   * it is MAINTSUPP's website, so no workspace capability can reach it.
   *
   * And a sixth: `media` (decision K), the same reason again — the website's own
   * files, in a bucket of their own, belonging to no workspace.
   */
  const nullable = PLATFORM_SECTIONS.filter((entry) => entry.capability === null).map((entry) => entry.key);
  assert.deepEqual(
    nullable.sort(),
    ["applications", "backups", "leads", "media", "navigation", "pages"],
    "only the six platform-owned surfaces answer to no capability",
  );
  for (const other of PLATFORM_SECTIONS.filter((entry) => !nullable.includes(entry.key))) {
    assert.ok(other.capability, `${other.key} answers to a capability and must keep naming it`);
  }

  /* The rule this entry keeps rather than bends. */
  const sections = await read("app/lib/platform-sections.ts");
  /* Quoted from that file, not from this phase's own paraphrase of it. */
  assert.match(sections, /a rail entry leading to an empty\n \* screen is the/);
  for (const absent of ["branding", "theme", "integrations", "billing", "settings"]) {
    assert.equal(platformSection(absent), null, `${absent} still has no platform API`);
  }
});

test("the editor renders from the server's catalogue, not a copy of it", async () => {
  const view = await read("app/(app)/admin/site-pages-view.tsx");
  const route = await read("app/api/site-pages/route.ts");

  /*
   * The lesson Phase 6 paid for: a picker whose options are typed into the panel is
   * a list that stops agreeing with what the server will accept, and the
   * disagreement shows up as a save that fails for no visible reason.
   *
   * So the route sends `BLOCK_CATALOGUE` and the view renders an input per rule.
   * A block added to `cms-blocks.ts` appears with its fields and its ceilings, with
   * no edit to the view.
   */
  assert.match(route, /catalogue: BLOCK_CATALOGUE/);
  assert.match(view, /data\?\.catalogue \?\? \[\]/);
  const body = decommented(view);
  for (const kind of BLOCK_KINDS) {
    assert.doesNotMatch(
      body,
      new RegExp(`"${kind}"`),
      `the view must not name the ${kind} block — it renders whatever the server sends`,
    );
  }
});

test("the console prints the server's own list of gaps", async () => {
  const view = await read("app/(app)/admin/site-pages-view.tsx");
  const route = await read("app/api/site-pages/route.ts");

  assert.match(route, /omissions: CMS_OMISSIONS/);
  assert.match(view, /data\.omissions\.map/);
  /* Printed, never restated. A second copy of this list is how one of them becomes
     stale and starts claiming something untrue. */
  for (const omission of CMS_OMISSIONS) {
    assert.doesNotMatch(view, new RegExp(omission.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(CMS_OMISSIONS.length >= 5, "every known gap is named");
});

test("the console reuses the admin kit rather than restating it", async () => {
  const view = await read("app/(app)/admin/site-pages-view.tsx");
  const css = decommented(await read("app/(app)/admin/site-pages.css"));

  for (const shared of ["admin-console", "admin-toolbar", "admin-field", "admin-notice", "admin-table"]) {
    assert.ok(view.includes(shared), `the view must use the kit's ${shared}`);
    assert.doesNotMatch(
      css,
      new RegExp(`^\\.${shared}\\s*\\{`, "m"),
      `views/admin-console.css owns .${shared}; a second definition is drift`,
    );
  }
  assert.match(view, /useAdminResource|adminWrite/);
});

test("the CMS stylesheets spend no literal and open no breakpoint", async () => {
  const globals = await read("app/globals.css");
  const adminCss = await read("app/(app)/admin/site-pages.css");
  const marketing = await read("app/(marketing)/marketing.css");

  const adminBody = adminCss.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(adminBody), "no hex literal — use the tokens");
  assert.ok(!/\b(?:rgba?|hsla?)\(/.test(adminBody), "no colour function either");
  for (const token of new Set([...adminCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) {
    assert.ok(globals.includes(`${token}:`), `${token} is not defined in globals.css`);
  }
  assert.equal(
    [...adminBody.matchAll(/@media[^{]*?(\d+)px/g)].length,
    0,
    "the block editor is one column that already narrows",
  );

  /*
   * THE MARKETING SIDE IS THE TIGHT ONE. Four separate tests cap the distinct
   * breakpoint count in `marketing.css` — the strictest at 28 — and the file stands
   * at 25, so five remain for the whole future of the site. A block library that
   * spent them on itself would be taking them from pages still to be designed.
   */
  const widths = new Set([...marketing.matchAll(/@media[^{]*?(\d+)px/g)].map((m) => m[1]));
  assert.ok(widths.size <= 28, `${widths.size} breakpoints in marketing.css`);
  const cms = marketing.slice(marketing.indexOf("CMS BLOCKS"));
  assert.ok(cms.length > 400, "the CMS block styles must be in the marketing stylesheet");
  assert.equal([...cms.matchAll(/@media/g)].length, 0, "the CMS blocks open no breakpoint of their own");

  /* And they reuse the site's classes rather than inventing a parallel system. */
  const blocks = await read("app/(marketing)/_cms/blocks.tsx");
  for (const shared of ["m-eyebrow", "m-lead", "m-prose", "btn btn--primary"]) {
    assert.ok(blocks.includes(shared), `the renderer must reuse .${shared}`);
  }
});

test("a CMS page cannot carry a price, so the one-price rule still holds", async () => {
  /*
   * `tests/homepage-v3.test.mjs` walks every marketing source for a currency symbol
   * followed by a digit and allows it only in `pricing.tsx`. None of the files this
   * phase adds may carry one — and, more importantly, neither may a database row,
   * which is what `CONTENT_RULES` is for.
   */
  for (const file of [
    "app/(marketing)/_cms/blocks.tsx",
    "app/(marketing)/p/[slug]/page.tsx",
    "app/(marketing)/marketing.css",
  ]) {
    const body = decommented(await read(file));
    assert.doesNotMatch(body, /£\s*\d/, `${file} must not name a price`);
  }
  assert.ok(CONTENT_RULES.some((rule) => rule.pattern.source.includes("£")));
});
