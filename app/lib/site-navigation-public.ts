/**
 * The navigation every public page draws — read through a cache, never the
 * reason a page fails. Decision J.
 *
 * `app/(marketing)/layout.tsx` calls `readPublicNavigation()` once per render.
 * On a warm instance that is a memory read; once per `PUBLIC_NAVIGATION_TTL_MS`
 * it is one indexed primary-key lookup (plus one small read of the website
 * pages' publishing states, only when the menu links to one). See
 * `site-navigation-cache.ts` for the rules.
 *
 * DELIBERATELY NOT `ensureDatabase()`. That runs the migration check on the
 * first request of every instance — seconds against Postgres on a cold start —
 * and the marketing pages have never paid it. A marketing page is not going to
 * start paying it for its menu: the read goes straight to the table, and a
 * table that is not there yet (a database that has never booted) is simply the
 * built-in navigation.
 */

import { getDb } from "../../db";
import { pageIsLive } from "./cms-seo.ts";
import { createNavigationCache } from "./site-navigation-cache.ts";
import { cmsPageWindows, readStoredNavigation, type CmsPageWindow } from "./site-navigation-repository.ts";
import {
  defaultNavigation,
  namesCmsPages,
  publicNavigation,
  type PublicNavigation,
  type SiteNavigation,
} from "./site-navigation.ts";

/** How stale a visitor's menu may be on an instance that did not take the save. Stated on the editor. */
export const PUBLIC_NAVIGATION_TTL_MS = 30_000;
/** The longest a page waits for the menu before drawing the last one it had (or the built-in one). */
export const PUBLIC_NAVIGATION_TIMEOUT_MS = 2_500;
/** After a failed read, how long before the database is asked again. */
export const PUBLIC_NAVIGATION_BACKOFF_MS = 15_000;

type Loaded = { navigation: SiteNavigation; pages: CmsPageWindow[] | null };

const cache = createNavigationCache<Loaded>({
  load: async () => {
    const db = await getDb();
    const stored = await readStoredNavigation(db);
    return {
      navigation: stored.navigation,
      pages: namesCmsPages(stored.navigation) ? await cmsPageWindows(db) : [],
    };
  },
  /* No page states are known, so a CMS link is left out — the built-in
     navigation has none anyway. */
  fallback: () => ({ navigation: defaultNavigation(), pages: null }),
  ttlMs: PUBLIC_NAVIGATION_TTL_MS,
  timeoutMs: PUBLIC_NAVIGATION_TIMEOUT_MS,
  backoffMs: PUBLIC_NAVIGATION_BACKOFF_MS,
  onError: (error) => {
    console.error(
      "[site-navigation] the public navigation could not be read; drawing the last one this instance had, or the built-in one:",
      error instanceof Error ? error.message : "error",
    );
  },
});

/**
 * The menu for one render. Whether a linked website page is live is decided
 * NOW, from the cached publishing windows — so a scheduled page's link appears
 * when the page does, not a cache window later.
 */
export async function readPublicNavigation(now: number = Date.now()): Promise<PublicNavigation> {
  try {
    const { value } = await cache.read();
    const live = value.pages
      ? new Set(value.pages.filter((page) => pageIsLive(page, now)).map((page) => page.slug))
      : null;
    return publicNavigation(value.navigation, live);
  } catch {
    return publicNavigation(defaultNavigation(), null);
  }
}

/** Called by the save that changed the navigation (and by a website page's save, whose state a link may depend on). */
export function invalidatePublicNavigation(): void {
  cache.invalidate();
}
