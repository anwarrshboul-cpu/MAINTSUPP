/**
 * The copy every built-in page draws — read through a cache, never the reason a
 * page fails. Decision L.
 *
 * `app/(marketing)/page.tsx`, `/contractors` and `/faqs` call
 * `readPublicSiteContent()` once per render. On a warm instance that is a memory
 * read; once per `PUBLIC_CONTENT_TTL_MS` it is one indexed primary-key lookup of
 * one row. The cache is `site-navigation-cache.ts` — the same TTL, timeout,
 * backoff and generation rules decision J measured, reused rather than copied.
 *
 * DELIBERATELY NOT `ensureDatabase()`, for the reason
 * `site-navigation-public.ts` gives at length: that runs the migration check on
 * the first request of every instance, seconds against Postgres, and no marketing
 * page has ever paid it. A table that is not there yet — a database that has
 * never booted — is simply the site as it ships, which is also what a timeout, a
 * refusal and a malformed document resolve to. There is no state of the world in
 * which reading this can empty a page.
 */

import { getDb } from "../../db";
import { resolveMediaForRender, type RenderableMedia } from "./cms-media-repository.ts";
import { createNavigationCache } from "./site-navigation-cache.ts";
import { readStoredContent } from "./site-content-repository.ts";
import {
  EMPTY_SITE_CONTENT,
  contentMediaIds,
  resolveSiteContent,
  type ResolvedSiteContent,
  type SiteContent,
} from "./site-content.ts";

/** How stale a visitor's copy may be on an instance that did not take the save. Stated on the editor. */
export const PUBLIC_CONTENT_TTL_MS = 30_000;
/** The longest a page waits for the copy before drawing the last it had (or the shipped words). */
export const PUBLIC_CONTENT_TIMEOUT_MS = 2_500;
/** After a failed read, how long before the database is asked again. */
export const PUBLIC_CONTENT_BACKOFF_MS = 15_000;

type Loaded = { content: SiteContent; media: Map<string, RenderableMedia> };

const cache = createNavigationCache<Loaded>({
  load: async () => {
    const db = await getDb();
    const { content } = await readStoredContent(db);
    /*
     * The photograph is resolved HERE rather than stored with the copy, so that
     * replacing a file in the library shows on the page — decision K's promise —
     * and so that a deleted one draws the shipped plates instead of a broken
     * image. One extra query, and only when a hero image has been chosen.
     */
    const ids = contentMediaIds(content);
    return { content, media: ids.length ? await resolveMediaForRender(db, ids) : new Map() };
  },
  fallback: () => ({ content: EMPTY_SITE_CONTENT, media: new Map() }),
  ttlMs: PUBLIC_CONTENT_TTL_MS,
  timeoutMs: PUBLIC_CONTENT_TIMEOUT_MS,
  backoffMs: PUBLIC_CONTENT_BACKOFF_MS,
  onError: (error) => {
    console.error(
      "[site-content] the pages' copy could not be read; drawing the last this instance had, or the words the site ships with:",
      error instanceof Error ? error.message : "error",
    );
  },
});

/** A photograph chosen from the media library, as the page draws it. */
export type PublicMedia = { src: string; alt: string; width: number | null; height: number | null };

export type PublicSiteContent = ResolvedSiteContent & {
  /** The hero's library photograph, or null: no override, or the asset is gone. */
  heroImage: PublicMedia | null;
};

/** Every built-in page's content for one render, resolved. */
export async function readPublicSiteContent(): Promise<PublicSiteContent> {
  try {
    const { value } = await cache.read();
    const resolved = resolveSiteContent(value.content);
    const asset = resolved.home.heroImage ? value.media.get(resolved.home.heroImage) : undefined;
    return {
      ...resolved,
      /* An image and nothing else, with alt text the save route insisted on: a
         video or a missing asset leaves the shipped plates in place. */
      heroImage:
        asset && asset.kind === "image" && asset.alt
          ? { src: asset.src, alt: asset.alt, width: asset.width, height: asset.height }
          : null,
    };
  } catch {
    return { ...resolveSiteContent(null), heroImage: null };
  }
}

/** Called by the save that changed the copy. */
export function invalidatePublicSiteContent(): void {
  cache.invalidate();
}
