/**
 * A CMS page, served to the public — Master Specification §6–9.
 *
 * WHY IT LIVES UNDER `/p/` AND INSIDE THE MARKETING GROUP.
 *
 * Inside `app/(marketing)` because that group's layout IS the website: the header,
 * the utility bar, the footer, the cookie notice and `marketing.css`. A CMS page
 * outside it would either have none of that chrome or would need a duplicate of it,
 * and `tests/stage-thirteen-css-split.test.mjs` exists precisely to stop a second
 * copy of the marketing stylesheet appearing.
 *
 * Under a `/p/` prefix, rather than at the site root, because a root-level dynamic
 * segment would sit in front of every future static route: add `/pricing` one day
 * and this page has already claimed the URL. A prefix keeps the site's own
 * namespace free and makes the collision list finite — `cleanSlug`'s
 * `RESERVED_SLUGS` covers it.
 *
 * WHERE THE SITEMAP LISTS THESE.
 *
 * `public/sitemap.xml` is a committed artifact generated at build time, and its
 * `lastmod` for each route comes from `git log` over that route's source files —
 * a database-driven URL has no source file and no commit. So CMS pages are listed
 * in a SECOND sitemap, `/sitemap-pages.xml` (app/sitemap-pages.xml/route.ts),
 * read live with each page's own `updated_at` as its date, and `robots.txt`
 * names both. Only live, indexable pages appear there.
 *
 * WHAT ELSE THIS ROUTE DECIDES, in order:
 *   1. `?preview=1` from signed-in MAINTSUPP platform staff shows the page in
 *      ANY state — draft, scheduled, ended — marked noindex, with a banner.
 *      Everyone else asking for a preview gets exactly what the public gets.
 *   2. A LIVE page (published and inside its window — `pageIsLive`) renders.
 *   3. Otherwise a redirect stored for this old address answers 308.
 *   4. Otherwise 404 — a draft and a never-existing page are the same answer.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";

import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { cleanSlug } from "../../../lib/cms-blocks.ts";
import { PREVIEW_REQUEST_HEADER } from "../../../lib/cms-seo.ts";
import {
  readPageForPreview,
  readPublishedPage,
  redirectTargetFor,
  type CmsPage,
} from "../../../lib/cms-repository.ts";
import { mediaIdsIn } from "../../../lib/cms-media.ts";
import { resolveMediaForRender, type RenderableMedia } from "../../../lib/cms-media-repository.ts";
import { scopedDb } from "../../../lib/tenant-db";
import { Breadcrumbs } from "../../_components/breadcrumbs";
import { CmsBlocks } from "../../_cms/blocks.tsx";

/*
 * Rendered per request, not prebuilt.
 *
 * The alternative — `generateStaticParams` plus revalidation — would mean a
 * published correction waits for a revalidation window, and an editor who reloads
 * and sees the old wording cannot tell whether the save worked. That is the exact
 * failure `cms-repository.ts` refuses to cache for, and buying it back at the route
 * level would be worse: the stale copy would be public, not merely in the console.
 */
export const dynamic = "force-dynamic";

/**
 * One read, used by both `generateMetadata` and the page.
 *
 * Next calls the two separately, so this is two queries per request against a table
 * with a handful of rows and an indexed lookup. Deduplicating it would mean a
 * module-level cache, which is the thing this feature has already decided twice not
 * to have. Stated rather than silently accepted.
 */
async function load(slugValue: string, preview = false): Promise<CmsPage | null> {
  const slug = cleanSlug(slugValue);
  if (!slug) return null;
  try {
    await ensureDatabase();
    return preview
      ? await readPageForPreview(await getDb(), slug)
      : await readPublishedPage(await getDb(), slug);
  } catch {
    /* A page that cannot be read is a page that is not here. See the header of
       `cms-repository.ts`: a 404 is a better public answer than a 500. */
    return null;
  }
}

/**
 * The media library assets this page's blocks name (decision K), resolved once.
 * A failure is an empty map: the image blocks then draw nothing, and the rest of
 * the page renders — a missing picture is a better answer than a 500.
 */
async function mediaFor(page: CmsPage): Promise<Map<string, RenderableMedia>> {
  const ids = page.blocks.flatMap((block) => mediaIdsIn(block.body));
  if (!ids.length) return new Map();
  try {
    return await resolveMediaForRender(await getDb(), ids);
  } catch {
    return new Map();
  }
}

/** Where an old address now leads, or null — a failure to tell is "nowhere" (404). */
async function leadsTo(slugValue: string): Promise<string | null> {
  const slug = cleanSlug(slugValue);
  if (!slug) return null;
  try {
    return await redirectTargetFor(await getDb(), slug);
  } catch {
    return null;
  }
}

/**
 * Whether this request may see a PREVIEW: `?preview=1` AND signed-in MAINTSUPP
 * platform staff — the same two conditions `/api/site-pages` gates on, decided
 * the way `requirePlatformAdmin` decides it. Anything else, including a failure
 * to decide, is "no": a preview request from anyone else is an ordinary one.
 */
async function wantsPreview(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const incoming = await headers();
  /* The query, or the header `proxy.ts` copies it into: vinext's first render
     pass hands a page `{}` for `searchParams` (see `proxy.ts`), and a 404 thrown
     there is final. Either one only ASKS — the staff check below decides. */
  const asked = (await searchParams).preview === "1" || incoming.get(PREVIEW_REQUEST_HEADER) === "1";
  if (!asked) return false;
  try {
    const scope = await scopedDb(new Request("https://maintsupp.local/", { headers: incoming }));
    return scope.platformAdmin === true && scope.authenticated;
  } catch {
    return false;
  }
}

/**
 * Per-page SEO, which is the whole reason this is `generateMetadata` and not a
 * static `metadata` export.
 *
 * `alternates.canonical` is declared EXPLICITLY, and that matters more than it
 * looks. `app/layout.tsx` sets a root `alternates: { canonical: "/" }`, so any page
 * that declares none inherits it and tells a crawler it is the homepage. Four of
 * the existing static marketing pages do exactly that today. A page whose address
 * is its identity cannot afford it.
 *
 * `title` is `absolute` for the same reason `/contractors` is: the root template is
 * `%s | MAINTSUPP`, so an editor who types "… | MAINTSUPP" into the meta title
 * would otherwise ship it twice.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { slug } = await params;
  const preview = await wantsPreview(searchParams);
  const page = await load(slug, preview);
  if (!page) {
    return {
      title: { absolute: "Page not found | MAINTSUPP" },
      robots: { index: false, follow: false },
    };
  }
  const title = page.metaTitle ?? `${page.title} | MAINTSUPP`;
  /* The page's own address unless an editor set a same-site override
     (`cleanCanonical` refuses any other host). */
  const canonical = page.canonicalUrl ?? `https://maintsupp.com/p/${page.slug}`;
  return {
    title: { absolute: title },
    ...(page.metaDescription ? { description: page.metaDescription } : {}),
    alternates: { canonical },
    /* A preview is never for a crawler; a 'noindex' page stays reachable by link
       but out of search results — `follow` stays on so its links still count. */
    ...(preview
      ? { robots: { index: false, follow: false } }
      : page.robots === "noindex"
        ? { robots: { index: false, follow: true } }
        : {}),
    openGraph: {
      title,
      ...(page.metaDescription ? { description: page.metaDescription } : {}),
      url: canonical,
      type: "article",
    },
  };
}

export default async function CmsPageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const preview = await wantsPreview(searchParams);
  const page = await load(slug, preview);
  /* An old address that was moved or redirected leads on — permanently, 308,
     so a search engine carries the page's standing to the new address. A live
     page at this address always wins over a redirect from it. */
  if (!page) {
    const target = await leadsTo(slug);
    if (target) permanentRedirect(target);
  }
  /* A draft, a retired slug and a slug that was never a page are all the same
     answer to a visitor. Anything else would let an outsider distinguish "this
     exists but is not published" from "this does not exist". */
  if (!page) notFound();
  const media = await mediaFor(page);

  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow">
        {/* Styled inline from the marketing tokens (`.m-root`): one banner only
            staff ever see does not earn a rule in the shared marketing.css. */}
        {preview && (
          <p
            className="m-cms-preview"
            role="status"
            style={{
              margin: "0 0 24px",
              padding: "10px 14px",
              background: "var(--tint)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              fontSize: 14,
            }}
          >
            {`Preview — ${page.state === "live" ? "this page is live" : `this page is not public (${page.state})`}. Only MAINTSUPP platform staff can see this view.`}
          </p>
        )}
        <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: page.title, path: `/p/${page.slug}` }]} />
        <h1>{page.title}</h1>
        <CmsBlocks blocks={page.blocks} media={media} />
      </div>
    </main>
  );
}
