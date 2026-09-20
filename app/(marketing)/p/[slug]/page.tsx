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
 * WHY THE SITEMAP DOES NOT LIST THESE, AND WHY THAT IS SAID OUT LOUD.
 *
 * `public/sitemap.xml` is a committed artifact generated at build time, and its
 * `lastmod` for each route comes from `git log` over that route's source files.
 * A database-driven URL has no source file and no commit, so it has no date to put
 * there. Emitting one anyway would mean either a fabricated `lastmod` or a build
 * that reads the production database — both worse than the honest gap, which
 * `CMS_OMISSIONS` states in the console so the person publishing a page can see it.
 * A dynamic `sitemap.xml` is its own piece of work.
 *
 * `tests/sitemap-lastmod.test.mjs` had to be re-pointed for this route to exist at
 * all; the reason is written into that test rather than only here.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { cleanSlug } from "../../../lib/cms-blocks.ts";
import { readPublishedPage, type CmsPage } from "../../../lib/cms-repository.ts";
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
async function load(slugValue: string): Promise<CmsPage | null> {
  const slug = cleanSlug(slugValue);
  if (!slug) return null;
  try {
    await ensureDatabase();
    return await readPublishedPage(await getDb(), slug);
  } catch {
    /* A page that cannot be read is a page that is not here. See the header of
       `cms-repository.ts`: a 404 is a better public answer than a 500. */
    return null;
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
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await load(slug);
  if (!page) {
    return {
      title: { absolute: "Page not found | MAINTSUPP" },
      robots: { index: false, follow: false },
    };
  }
  const title = page.metaTitle ?? `${page.title} | MAINTSUPP`;
  return {
    title: { absolute: title },
    ...(page.metaDescription ? { description: page.metaDescription } : {}),
    alternates: { canonical: `https://maintsupp.com/p/${page.slug}` },
    openGraph: {
      title,
      ...(page.metaDescription ? { description: page.metaDescription } : {}),
      url: `https://maintsupp.com/p/${page.slug}`,
      type: "article",
    },
  };
}

export default async function CmsPageRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await load(slug);
  /* A draft, a retired slug and a slug that was never a page are all the same
     answer to a visitor. Anything else would let an outsider distinguish "this
     exists but is not published" from "this does not exist". */
  if (!page) notFound();

  return (
    <main className="m-section">
      <div className="m-shell m-shell--narrow">
        <Breadcrumbs items={[{ name: "Home", path: "/" }, { name: page.title, path: `/p/${page.slug}` }]} />
        <h1>{page.title}</h1>
        <CmsBlocks blocks={page.blocks} />
      </div>
    </main>
  );
}
