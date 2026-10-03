/**
 * THE PAGES THAT SHIP WITH maintsupp.com, as the console lists them.
 *
 * The Overview used to count "built-in pages" from the Website copy editor's own
 * page list, which is three long — Home, Contractor network, All FAQs — because
 * those are the three with an editor tab. The website itself has eleven: the
 * header's five links became pages of their own (services, how it works,
 * pricing, case study, contact), and there are three legal notices. So the
 * console said "3 pages" beside a navigation card listing six, and the Pages
 * screen said "the six pages the website has today". Neither was the site.
 *
 * This list is derived from `SITE_ROUTES` — the one place the site's own
 * addresses are named — so a page added there appears here without a second
 * list to keep in step. `/portal` is left out: it is the sign-in door, not a
 * page of the website. `tests/site-built-in-pages.test.mjs` holds this level
 * with the route folders under `app/(marketing)`.
 */
import { SITE_ROUTES } from "./site-navigation.ts";

/**
 * Where a built-in page's words come from.
 *
 * "copy"  — it has its own tab in Website copy.
 * "home"  — it opens with the Home page's sections, so its headings are the
 *           Home page's copy; the rest of the page is part of the site build.
 * "fixed" — a legal notice, published as written.
 */
export type BuiltInPageWords = "copy" | "home" | "fixed";

export type BuiltInSitePage = {
  key: string;
  label: string;
  path: string;
  words: BuiltInPageWords;
};

/** The pages with a tab of their own in Website copy (`CONTENT_PAGES`). */
export const OWN_COPY_PATHS: readonly string[] = ["/", "/contractors", "/faqs"];

/** The pages that draw the Home page's copy (`readPublicSiteContent`). */
export const HOME_COPY_PATHS: readonly string[] = [
  "/services",
  "/how-it-works",
  "/pricing",
  "/case-study",
  "/contact",
];

const wordsOf = (path: string): BuiltInPageWords =>
  OWN_COPY_PATHS.includes(path) ? "copy" : HOME_COPY_PATHS.includes(path) ? "home" : "fixed";

export const BUILT_IN_SITE_PAGES: readonly BuiltInSitePage[] = SITE_ROUTES.filter(
  (route) => route.path !== "/portal",
).map((route) => ({
  key: route.path === "/" ? "home" : route.path.slice(1),
  label: route.label,
  path: route.path,
  words: wordsOf(route.path),
}));

/** The line under a built-in page's name, in the Overview and on Website pages. */
export const BUILT_IN_WORDS_LABEL: Record<BuiltInPageWords, string> = {
  copy: "Built-in · words in Website copy",
  home: "Built-in · headings from the Home page copy",
  fixed: "Built-in · legal notice",
};
