/**
 * The London pages' library pictures — read through a cache, never the reason a
 * page fails. `page-pictures.ts` says what the rule is; this file is the wiring.
 *
 * Every London page calls `readPagePicture(path)` once per render. On a warm
 * instance that is a memory read; once per `PAGE_PICTURES_TTL_MS` it is two
 * small queries — the images' titles, then the files of the few that name a
 * page. The cache is `site-navigation-cache.ts`: the same TTL, timeout, backoff
 * and generation rules decision J measured, reused rather than copied, exactly
 * as `site-content-public.ts` reuses them for the built-in pages' copy.
 *
 * DELIBERATELY NOT `ensureDatabase()`, for the reason `site-navigation-public.ts`
 * gives at length: that runs the migration check on the first request of every
 * instance, and no marketing page has ever paid it. A table that is not there, a
 * timeout, a refusal and an empty library all resolve to the same thing — no
 * library picture — and the page then draws the photograph it ships with. There
 * is no state of the world in which reading this can empty a page.
 *
 * NO INVALIDATION HOOK, ON PURPOSE. A picture uploaded or retitled in the
 * library reaches every visitor within one TTL window, which is the honest bound
 * on an instance that did not take the save anyway. Wiring the media routes to
 * this cache would save thirty seconds on one instance and couple the library to
 * a page family it otherwise knows nothing about.
 */

import { getDb } from "../../db";
import { listImageTitles, resolveMediaForRender } from "./cms-media-repository.ts";
import { choosePagePictures, drawablePagePictures, type PagePicture } from "./page-pictures.ts";
import { createNavigationCache } from "./site-navigation-cache.ts";

/** How stale a visitor's picture may be after a change in the library. */
export const PAGE_PICTURES_TTL_MS = 30_000;
/** The longest a page waits for the library before drawing its shipped photograph. */
export const PAGE_PICTURES_TIMEOUT_MS = 2_500;
/** After a failed read, how long before the database is asked again. */
export const PAGE_PICTURES_BACKOFF_MS = 15_000;

const cache = createNavigationCache<Map<string, PagePicture>>({
  load: async () => {
    const db = await getDb();
    const chosen = choosePagePictures(await listImageTitles(db));
    if (!chosen.size) return new Map();
    return drawablePagePictures(chosen, await resolveMediaForRender(db, [...chosen.values()]));
  },
  fallback: () => new Map(),
  ttlMs: PAGE_PICTURES_TTL_MS,
  timeoutMs: PAGE_PICTURES_TIMEOUT_MS,
  backoffMs: PAGE_PICTURES_BACKOFF_MS,
  onError: (error) => {
    console.error(
      "[page-pictures] the library pictures could not be read; the London pages draw the photographs they ship with:",
      error instanceof Error ? error.message : "error",
    );
  },
});

/** The library picture for one page address, or null: none chosen, none drawable, or the read failed. */
export async function readPagePicture(path: string): Promise<PagePicture | null> {
  try {
    const { value } = await cache.read();
    return value.get(path) ?? null;
  } catch {
    return null;
  }
}
