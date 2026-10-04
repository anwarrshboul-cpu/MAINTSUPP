import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * The console's list of the website's own pages must BE the website's pages.
 *
 * It was three long (the copy editor's tabs) while the site had eleven, and the
 * Pages screen said "six". These hold the list level with the route folders, so
 * the next page added to the site cannot go missing from the console.
 */
const { BUILT_IN_SITE_PAGES, OWN_COPY_PATHS, HOME_COPY_PATHS } = await import(
  "../app/lib/site-built-in-pages.ts"
);
const MARKETING = "app/(marketing)";

test("every route folder under the marketing site is a built-in page, and nothing else is", () => {
  /*
   * RE-POINTED when the London pages were added (October 2026), and the rule got
   * wider rather than weaker.
   *
   * This read the TOP-LEVEL folders only, which was the whole site while every
   * page sat directly under `app/(marketing)`. `/london` has sixteen pages
   * beneath it, so a top-level read saw one folder where the site has seventeen
   * addresses — and the console's list, which names all seventeen, could no
   * longer be compared with it. The walk now descends, so a nested page is held
   * to exactly the rule a top-level one always was: on the site means in the
   * console, and nowhere else. `p` is still left out (the CMS's dynamic route),
   * and so is any `[segment]`, which has no fixed address to list.
   */
  const folders = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith("[")) continue;
      if (prefix === "" && entry.name === "p") continue;
      const route = `${prefix}/${entry.name}`;
      if (existsSync(`${dir}/${entry.name}/page.tsx`)) folders.push(route);
      walk(`${dir}/${entry.name}`, route);
    }
  };
  walk(MARKETING, "");
  assert.ok(folders.includes("/london/brent-cross"), "the walk reaches a nested page");
  const listed = BUILT_IN_SITE_PAGES.map((page) => page.path);
  assert.deepEqual([...listed].sort(), ["/", ...folders].sort());
  assert.ok(!listed.includes("/portal"), "the sign-in door is not a page of the website");
});

test("a London page is listed as part of the site build, never as a legal notice", () => {
  /* Before the "build" kind existed, a page with no copy-editor tab fell through
     to "fixed", and the Pages screen would have called a kiosk-installation page
     a legal notice. */
  const london = BUILT_IN_SITE_PAGES.filter((page) => page.path.startsWith("/london"));
  assert.equal(london.length, 17, "the hub and its sixteen pages");
  for (const page of london) assert.equal(page.words, "build", page.path);
  for (const page of BUILT_IN_SITE_PAGES.filter((entry) => !entry.path.startsWith("/london"))) {
    assert.notEqual(page.words, "build", page.path);
  }
  const keys = BUILT_IN_SITE_PAGES.map((page) => page.key);
  assert.equal(new Set(keys).size, keys.length, "every page has a key of its own");
  assert.ok(keys.every((key) => !key.includes("/")), "and no key reads as a path");
});

test("the pages with a copy-editor tab are the copy editor's own pages", () => {
  /* Read from the source: `site-content.ts` imports the marketing copy, which
     node cannot load outside the build. */
  const source = readFileSync("app/lib/site-content.ts", "utf8");
  const block = source.slice(
    source.indexOf("export const CONTENT_PAGES"),
    source.indexOf("const pageSpec"),
  );
  const paths = [...block.matchAll(/\n\s{4}path: "([^"]+)",/g)].map(([, path]) => path);
  assert.ok(paths.length >= 3, "the copy editor's pages were found");
  assert.deepEqual([...OWN_COPY_PATHS].sort(), paths.sort());
});

test("a page said to draw the Home page's copy really reads it", () => {
  for (const path of HOME_COPY_PATHS) {
    const source = readFileSync(`${MARKETING}${path}/page.tsx`, "utf8");
    assert.match(source, /readPublicSiteContent/, `${path} must read the site copy`);
  }
  for (const page of BUILT_IN_SITE_PAGES.filter((entry) => entry.words === "fixed")) {
    const source = readFileSync(`${MARKETING}${page.path}/page.tsx`, "utf8");
    assert.doesNotMatch(source, /readPublicSiteContent/, `${page.path} is listed as a fixed notice`);
  }
  /* The same holds for a page of the site build: it must not be drawing copy the
     console could change while the console says it cannot. */
  for (const page of BUILT_IN_SITE_PAGES.filter((entry) => entry.words === "build")) {
    const source = readFileSync(`${MARKETING}${page.path}/page.tsx`, "utf8");
    assert.doesNotMatch(source, /readPublicSiteContent/, `${page.path} is listed as part of the site build`);
  }
});

test("the Overview and the Pages screen count from this list, not from the copy tabs", () => {
  const overview = readFileSync("app/(app)/admin/platform-overview.tsx", "utf8");
  const panels = readFileSync("app/(app)/admin/platform-overview-panels.tsx", "utf8");
  const pages = readFileSync("app/(app)/admin/site-pages-view.tsx", "utf8");
  assert.match(overview, /const builtIn = BUILT_IN_SITE_PAGES\.length;/);
  assert.match(panels, /websitePageRows\(BUILT_IN_SITE_PAGES,/);
  assert.match(pages, /BUILT_IN_SITE_PAGES\.map\(/);
  assert.doesNotMatch(pages, /six pages/);
});
