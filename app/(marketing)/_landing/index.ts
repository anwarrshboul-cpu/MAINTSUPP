import { PLACE_PAGES } from "./places.ts";
import { SERVICE_PAGES } from "./services.ts";
import type { LandingPage } from "./types.ts";

/**
 * Every London page, hub first, then the nine services, the three priority
 * centres and the four areas — the order the sitemap and the footer use.
 */
export const LANDING_PAGES: readonly LandingPage[] = [
  ...PLACE_PAGES.filter((page) => page.kind === "hub"),
  ...SERVICE_PAGES,
  ...PLACE_PAGES.filter((page) => page.kind === "centre"),
  ...PLACE_PAGES.filter((page) => page.kind === "area"),
];

const BY_PATH = new Map(LANDING_PAGES.map((page) => [page.path, page]));

/**
 * The page a route file draws. Throws on a path nothing defines: a route file
 * naming a page that does not exist is a build-time mistake, and a build that
 * fails is a better place to find it than a blank page in production.
 */
export function landingPage(path: string): LandingPage {
  const page = BY_PATH.get(path);
  if (!page) throw new Error(`No London page is defined for ${path}`);
  return page;
}

export type { LandingPage } from "./types.ts";
