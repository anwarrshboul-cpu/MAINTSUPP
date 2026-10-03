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
  const folders = readdirSync(MARKETING, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && entry.name !== "p")
    .filter((entry) => existsSync(`${MARKETING}/${entry.name}/page.tsx`))
    .map((entry) => `/${entry.name}`);
  const listed = BUILT_IN_SITE_PAGES.map((page) => page.path);
  assert.deepEqual([...listed].sort(), ["/", ...folders].sort());
  assert.ok(!listed.includes("/portal"), "the sign-in door is not a page of the website");
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
