/**
 * Every marketing page declares its own address, and says its own name once.
 *
 * WHY THIS FILE EXISTS RATHER THAN A ONE-OFF FIX.
 *
 * Two defects were live on four of the six marketing pages, and **nothing tested
 * for either**, which is why both survived a homepage rebuild, a commercial update
 * and a canonical-host migration:
 *
 *   1. `/faqs`, `/privacy`, `/terms` and `/cookies` declared no `alternates`, so
 *      each inherited the root `alternates: { canonical: "/" }` from
 *      `app/layout.tsx` — resolved against `metadataBase` — and emitted
 *      `<link rel="canonical" href="https://maintsupp.com/">`. Four distinct pages
 *      told every crawler they were the homepage, while `public/sitemap.xml`
 *      submitted all six URLs for indexing. The sitemap and the pages actively
 *      contradicted each other.
 *   2. The same four typed `" | MAINTSUPP"` into their own `title` while the root
 *      template is `%s | MAINTSUPP`, so the rendered title was
 *      "FAQs | MAINTSUPP | MAINTSUPP". `contractors/page.tsx` carries a comment
 *      recording exactly this cause and its fix; these four never applied it.
 *
 * A fix without a test would leave the next page free to repeat both. So this walks
 * the route tree rather than naming files: a page added tomorrow is covered on the
 * day it is added, which is the property the four defects prove was missing.
 *
 * It deliberately does NOT assert what any particular title says. That is copy, it
 * belongs to whoever writes it, and a test that pinned it would fail on an
 * improvement. What is asserted is the two mechanical rules that a page cannot get
 * right by accident and cannot see itself getting wrong.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * A file's CODE, with comments removed.
 *
 * Load-bearing, not tidiness. Every page fixed here carries a doc comment that
 * QUOTES the defect — `alternates: { canonical: "/" }` — to explain why declaring
 * one matters. A regex over the raw source finds that first and reads the value the
 * comment exists to warn about, so the test reported four correctly-fixed pages as
 * still broken. Read the code; the prose is not the declaration.
 */
const code = async (file) =>
  (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The canonical a page declares, or null. From code, never from a comment. */
async function declaredCanonical(file) {
  const match = (await code(file)).match(/canonical:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/** The one host. Anything else here is a bug in the fix, not in the site. */
const ORIGIN = "https://maintsupp.com";

/**
 * Every static marketing page, as a route and the file behind it.
 *
 * Walked, not listed, for the reason in the header. A dynamic segment is collected
 * separately: its canonical is built per request in `generateMetadata`, so a source
 * grep cannot read it and this file must not pretend to.
 */
async function marketingPages() {
  const pages = [];
  const dynamic = [];
  const walk = async (dir, prefix) => {
    for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (item.name === "page.tsx") {
        (prefix.includes("[") ? dynamic : pages).push({
          route: prefix || "/",
          file: `${dir}/page.tsx`,
        });
      }
      if (
        item.isDirectory() &&
        !item.name.startsWith("_") &&
        !item.name.startsWith("(")
      ) {
        await walk(`${dir}/${item.name}`, `${prefix}/${item.name}`);
      }
    }
  };
  await walk("app/(marketing)", "");
  return { pages, dynamic };
}

test("the root declares a canonical, which is why every page must too", async () => {
  /*
   * This is the mechanism the whole file is about, asserted first so a reader knows
   * why the rest is necessary. If the root ever stops declaring one, inheriting it
   * stops being a hazard — and this assertion is where that change should be
   * noticed and the rest reconsidered.
   */
  const layout = await read("app/layout.tsx");
  assert.match(
    layout,
    /alternates: \{\s*\n\s*canonical: "\/",/,
    "the root canonical is what a page with no alternates inherits",
  );
  assert.match(layout, new RegExp(`metadataBase: new URL\\("${ORIGIN}"\\)`));
  assert.match(
    layout,
    /template: "%s \| MAINTSUPP"/,
    "the title template is what a page must not repeat",
  );
});

test("every marketing page declares its own canonical, and it is its own address", async () => {
  const { pages } = await marketingPages();
  assert.ok(pages.length >= 6, `only ${pages.length} marketing pages found`);

  const offenders = [];
  for (const { route, file } of pages) {
    const declared = await declaredCanonical(file);
    if (!declared) {
      offenders.push(`${file} declares no canonical, so it inherits "${ORIGIN}/"`);
      continue;
    }
    const expected = route === "/" ? `${ORIGIN}/` : `${ORIGIN}${route}`;
    if (declared !== expected) {
      offenders.push(`${file} says ${declared}, but it is served at ${expected}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a page that does not name its own address tells a crawler it is some other page",
  );
});

test("no marketing page repeats the suffix the root template already adds", async () => {
  const { pages } = await marketingPages();

  const offenders = [];
  for (const { file } of pages) {
    /* Comments stripped for the reason `code` gives: every page fixed here quotes
       its own former doubled title in the comment explaining the fix. */
    const source = await code(file);
    /*
     * Only a BARE `title: "..."` is checked. `title: { absolute: "..." }` opts out
     * of the template deliberately — `/contractors` does exactly that because it
     * wants a shape the template does not give — so a suffix inside an `absolute`
     * is correct and must not be flagged.
     */
    for (const match of source.matchAll(/(?<!absolute:\s*)\btitle:\s*"([^"]*)"/g)) {
      if (/\|\s*MAINTSUPP/i.test(match[1])) {
        offenders.push(`${file} — title: "${match[1]}" plus the template gives "… | MAINTSUPP | MAINTSUPP"`);
      }
    }
  }
  assert.deepEqual(offenders, [], "the root template supplies the suffix; a page must not");
});

test("the four pages this fixed are fixed, and named so a regression is obvious", async () => {
  /*
   * The walk above is the rule. This is the record: these four were the defect, and
   * naming them means a revert shows up as this test failing by name rather than as
   * a count changing somewhere.
   */
  for (const [folder, route, title] of [
    ["faqs", "/faqs", "FAQs"],
    ["privacy", "/privacy", "Privacy notice"],
    ["terms", "/terms", "Terms"],
    ["cookies", "/cookies", "Cookies"],
  ]) {
    const source = await read(`app/(marketing)/${folder}/page.tsx`);
    assert.match(
      source,
      new RegExp(`canonical: "${ORIGIN}${route}"`),
      `/${folder} must name its own address`,
    );
    /*
     * RE-POINTED FOR /faqs ONLY (decision L), and the rule got stronger rather
     * than weaker.
     *
     * `/faqs` is editable copy now: its title and description come from
     * `SEO_COPY.faqs` in `app/(marketing)/_sections/copy.ts` through
     * `generateMetadata`, so the literal moved out of the page file. The two
     * things this test exists to stop are both still stopped — the page still
     * declares its own canonical (asserted above, in code, unchanged), and the
     * suffix still cannot be doubled: the shipped title is checked in copy.ts, and
     * `validateSiteContent` REFUSES a saved title containing "| MAINTSUPP", which
     * is a guarantee the old literal never gave. The three legal notices are not
     * editable at all and keep their literals here.
     */
    const named = folder === "faqs" ? await read("app/(marketing)/_sections/copy.ts") : source;
    assert.match(
      named,
      new RegExp(`title: "${title}",`),
      `/${folder} must say its name once and let the template add the suffix`,
    );
    if (folder === "faqs") {
      const rules = await read("app/lib/site-content.ts");
      assert.match(
        rules,
        /\/\\\|\\s\*MAINTSUPP\/i\.test\(cleaned\)/,
        "and a saved title carrying the suffix is refused",
      );
    }
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, ""),
      /\|\s*MAINTSUPP/,
      `/${folder} must not carry the suffix — comments stripped, since they quote the old value`,
    );
  }
});

test("the sitemap and the pages now agree about what each page is", async () => {
  /*
   * THE DEFECT IN ONE SENTENCE: the sitemap submitted six URLs for indexing while
   * four of them carried a canonical pointing at a seventh thing — the homepage.
   * A canonical is a stronger signal than a sitemap entry, so the practical effect
   * was asking Google to index four pages and then telling it not to.
   */
  const sitemap = await read("public/sitemap.xml");
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(listed.length >= 6, `the sitemap lists ${listed.length} URLs`);

  const { pages } = await marketingPages();
  const byRoute = new Map(pages.map((page) => [page.route, page.file]));
  for (const loc of listed) {
    const route = new URL(loc).pathname;
    const file = byRoute.get(route === "/" ? "/" : route.replace(/\/$/, ""));
    assert.ok(file, `${loc} is in the sitemap but has no page`);
    const declared = await declaredCanonical(file);
    assert.ok(declared, `${file} is submitted for indexing but declares no canonical`);
    assert.equal(
      declared.replace(/\/$/, ""),
      loc.replace(/\/$/, ""),
      `${file} is submitted as ${loc} but calls itself ${declared}`,
    );
  }
});

test("a dynamic marketing route is not checked here, and the reason is stated", async () => {
  /*
   * A database-driven page builds its canonical in `generateMetadata` from the row,
   * so there is no literal in the source for the walk above to read. Asserting the
   * absence of a literal would be asserting nothing; its canonical is covered by
   * the test that owns that route instead.
   *
   * On this branch there is no dynamic marketing route at all. When one arrives —
   * the website CMS adds `/p/[slug]` — this is where a reader should look to see
   * why it is excluded, and `tests/website-cms.test.mjs` is where its canonical is
   * asserted.
   */
  const { dynamic } = await marketingPages();
  for (const { file } of dynamic) {
    const source = await read(file);
    assert.match(
      source,
      /generateMetadata/,
      `${file} is a dynamic route, so it must build its canonical per request`,
    );
  }
});
