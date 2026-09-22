/**
 * /sitemap-pages.xml — the website pages written in the console, for crawlers.
 *
 * WHY A SECOND SITEMAP rather than CMS pages inside `/sitemap.xml`:
 * `public/sitemap.xml` is a committed artifact regenerated at build time, and
 * each `lastmod` in it is the date of the last COMMIT to that route's source
 * (scripts/generate-sitemap.mjs; `tests/sitemap-lastmod.test.mjs` pins it). A
 * console page has no source file and no commit, and a build that read the
 * database to fill one in would be stale the moment someone pressed Publish.
 * So this sitemap is read live, `robots.txt` names both, and the static one is
 * untouched.
 *
 * What it lists is decided by `sitemapEntries` in `app/lib/cms-seo.ts`: pages
 * LIVE now (published and inside their window), not 'noindex', and canonical to
 * their own address — each with the date its public page last changed.
 */

import { getDb } from "../../db";
import { ensureDatabase } from "../../db/init";
import { listPagesForSitemap } from "../lib/cms-repository.ts";
import { sitemapEntries, sitemapXml } from "../lib/cms-seo.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  let pages: Awaited<ReturnType<typeof listPagesForSitemap>> = [];
  try {
    await ensureDatabase();
    pages = await listPagesForSitemap(await getDb());
  } catch (error) {
    /* An empty sitemap, not a 500: a crawler that is refused a sitemap keeps
       retrying it, one that reads an empty one simply learns nothing new. */
    console.error("[cms] the pages sitemap could not be read", error);
  }
  return new Response(sitemapXml(sitemapEntries(pages)), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      /* Read fresh every time: a page published, ended or moved in the
         console is right here on the next fetch, not after a cache expires. */
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}
