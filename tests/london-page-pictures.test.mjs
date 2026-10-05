/**
 * A London page's picture can be changed from the console (October 2026).
 *
 * The owner asked to put new pictures on the London pages himself, through the
 * website, without a release. The media library is where the site's pictures
 * already live, so the rule is one sentence: an image in the library whose TITLE
 * is a London page's address, and which has ALT TEXT, is that page's picture.
 *
 * Pinned here:
 *   - WHAT COUNTS AS A PAGE ADDRESS in a title, and what is just a title;
 *   - WHICH IMAGE WINS when two carry the same address;
 *   - NO ALT TEXT, NO PICTURE — the page keeps the photograph it ships with;
 *   - THE READ IS CACHED AND CANNOT FAIL A PAGE: the navigation's cache, no
 *     `ensureDatabase`, and every failure answers "no library picture";
 *   - THE PAGE DRAWS IT in the box the approved photograph fills, and the rule
 *     is printed on the library screen where the title is typed.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const pictures = await import("../app/lib/page-pictures.ts");
const { LANDING_PAGES } = await import("../app/(marketing)/_landing/index.ts");

test("a title names a page when it is that page's address, however it was typed", () => {
  const same = "/london/brent-cross";
  for (const title of [
    "/london/brent-cross",
    "  /london/brent-cross  ",
    "/London/Brent-Cross",
    "/london/brent-cross/",
    "https://maintsupp.com/london/brent-cross",
    "https://www.maintsupp.com/london/brent-cross?utm_source=x#top",
  ]) {
    assert.equal(pictures.pagePathFromTitle(title), same, title);
  }
  assert.equal(pictures.pagePathFromTitle("/london"), "/london");
  assert.equal(pictures.pagePathFromTitle("https://maintsupp.com/london/"), "/london");
});

test("every other title is an ordinary title", () => {
  for (const title of [
    "Brent Cross kiosk at night",
    "london/brent-cross",
    "/london/brent cross",
    "/london/brent-cross/extra",
    "/london/../admin",
    "/services",
    "/",
    "https://example.com/london/brent-cross",
    "/london/Brent_Cross",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(pictures.pagePathFromTitle(title), null, String(title));
  }
});

test("every London page has an address a title can name", () => {
  assert.ok(LANDING_PAGES.length >= 17);
  for (const page of LANDING_PAGES) {
    assert.equal(pictures.pagePathFromTitle(page.path), page.path, page.path);
  }
});

test("two images, one address: the library beats the archive, then the newest wins", () => {
  const row = (id, title, status, updatedAt, hasFile = true) => ({ id, title, status, updatedAt, hasFile });
  const chosen = pictures.choosePagePictures([
    row("med_old", "/london/brent-cross", "active", "2026-10-01T09:00:00.000Z"),
    row("med_new", "/london/brent-cross", "active", "2026-10-05T09:00:00.000Z"),
    row("med_archived_newest", "/london/brent-cross", "archived", "2026-10-06T09:00:00.000Z"),
    row("med_only_archived", "/london/east-london", "archived", "2026-10-02T09:00:00.000Z"),
    row("med_no_file", "/london/west-london", "active", "2026-10-05T09:00:00.000Z", false),
    row("med_plain", "A photograph of a shutter", "active", "2026-10-05T09:00:00.000Z"),
  ]);
  assert.equal(chosen.get("/london/brent-cross"), "med_new");
  /* Archiving does not take a picture off a page: the library's own promise. */
  assert.equal(chosen.get("/london/east-london"), "med_only_archived");
  /* An upload that never completed has nothing to draw. */
  assert.equal(chosen.has("/london/west-london"), false);
  assert.equal(chosen.size, 2);
});

test("no alt text, no picture; a video titled like a page is not a picture either", () => {
  const chosen = new Map([
    ["/london/brent-cross", "med_a"],
    ["/london/east-london", "med_b"],
    ["/london/west-london", "med_c"],
    ["/london/south-london", "med_d"],
    ["/london/north-london", "med_gone"],
  ]);
  const media = new Map([
    ["med_a", { kind: "image", alt: "  A technician at the base of a kiosk  ", src: "/media/med_a/mv_1/display.webp", width: 1536, height: 1024 }],
    ["med_b", { kind: "image", alt: null, src: "/media/med_b/mv_1/display.webp", width: 1536, height: 1024 }],
    ["med_c", { kind: "image", alt: "   ", src: "/media/med_c/mv_1/display.webp", width: null, height: null }],
    ["med_d", { kind: "video", alt: "A film", src: "/media/med_d/mv_1/film.mp4", width: null, height: null }],
  ]);
  const drawable = pictures.drawablePagePictures(chosen, media);
  assert.deepEqual([...drawable.keys()], ["/london/brent-cross"]);
  assert.deepEqual(drawable.get("/london/brent-cross"), {
    src: "/media/med_a/mv_1/display.webp",
    alt: "A technician at the base of a kiosk",
    width: 1536,
    height: 1024,
  });
});

test("the read is the navigation's cache, never ensureDatabase, and every failure is 'no library picture'", async () => {
  const source = await read("app/lib/page-pictures-public.ts");
  const body = code(source);
  assert.match(body, /createNavigationCache<Map<string, PagePicture>>/);
  assert.match(body, /fallback: \(\) => new Map\(\)/);
  assert.match(body, /listImageTitles\(db\)/);
  assert.match(body, /resolveMediaForRender\(db, \[\.\.\.chosen\.values\(\)\]\)/);
  /* The second query is skipped when no title names a page — the usual case. */
  assert.match(body, /if \(!chosen\.size\) return new Map\(\);/);
  assert.doesNotMatch(body, /ensureDatabase/);
  /* The public function cannot throw: a page awaits it in its render. */
  assert.match(body, /export async function readPagePicture\(path: string\): Promise<PagePicture \| null> \{\s*try \{[\s\S]*?\} catch \{\s*return null;\s*\}/);
});

test("the repository hands over titles and state only, for images only", async () => {
  const body = code(await read("app/lib/cms-media-repository.ts"));
  const start = body.indexOf("export async function listImageTitles");
  assert.ok(start > 0);
  const fn = body.slice(start, body.indexOf("export async function", start + 10));
  assert.match(fn, /\.where\(eq\(cmsMedia\.kind, "image"\)\)/);
  assert.match(fn, /hasFile: Boolean\(row\.currentVersionId\)/);
  assert.doesNotMatch(fn, /objectKey|displayKey/);
});

test("the page draws a library picture in the approved photograph's box, and falls back to it", async () => {
  const body = code(await read("app/(marketing)/_landing/landing-page.tsx"));
  assert.match(body, /export async function LandingPage\(\{ page \}: \{ page: Page \}\) \{\s*const picture = await readPagePicture\(page\.path\);/);
  assert.match(body, /picture \? \(\s*<LibraryPicture picture=\{picture\} \/>\s*\) : \(\s*<ApprovedPhoto/);
  /* The same class and the same <picture> wrapper `page-parts.css` positions. */
  assert.match(body, /<picture>\s*<img\s+className="pagehero__photo"\s+src=\{picture\.src\}\s+alt=\{picture\.alt\}/);
  const css = await read("app/(marketing)/_components/page-parts.css");
  assert.match(css, /\.pagehero__media picture[^{]*\{position:absolute;inset:0\}/);
});

test("the rule is printed on the library screen, where the title is typed", async () => {
  const view = await read("app/(app)/admin/site-media-view.tsx");
  assert.match(view, /use the page&apos;s address as the title/);
  assert.match(view, /\/london\/brent-cross/);
  assert.match(view, /give it alt text/);
});
