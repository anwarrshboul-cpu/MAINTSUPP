/**
 * Reading and writing the website's pages.
 *
 * NO CACHE, for the reason this program has already paid for twice.
 *
 * `theme-repository.ts` shipped with a thirty-second per-isolate cache and
 * authenticated QA against the deployed Preview proved it wrong: a value was
 * changed, the database showed the new state, and the API kept answering with the
 * old one, because the write invalidated one serverless instance while the read
 * landed on another. There is no cross-instance channel in this product.
 *
 * It would matter more here than it did for a colour. A stale read on a public
 * marketing page means an editor publishes a correction, reloads, sees the old
 * wording, and cannot tell whether the save worked. The cost of not caching is one
 * indexed lookup per page view on a table with a handful of rows.
 *
 * A FAILED READ MEANS "NO PAGE", NOT "AN ERROR PAGE".
 *
 * `readPublishedPage` returns null when it cannot answer, and the route turns that
 * into a 404. A 500 on a public URL is a worse answer than "this is not a page
 * here" — it invites a retry, it looks like an outage to a crawler, and the visitor
 * can do nothing with it either way.
 */

import { and, asc, eq } from "drizzle-orm";

import type { getDb } from "../../db";
import { siteBlocks, sitePages } from "../../db/schema";
import { readBlockBody, type BlockBody } from "./cms-blocks.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

export type CmsBlock = {
  id: string;
  kind: string;
  position: number;
  body: BlockBody;
};

export type CmsPage = {
  id: string;
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
  blocks: CmsBlock[];
};

/** Rows the catalogue still understands, in order. See `readBlockBody`. */
async function blocksOf(db: Database, pageId: string): Promise<CmsBlock[]> {
  const rows = await db
    .select({
      id: siteBlocks.id,
      kind: siteBlocks.kind,
      position: siteBlocks.position,
      body: siteBlocks.body,
    })
    .from(siteBlocks)
    .where(eq(siteBlocks.pageId, pageId))
    .orderBy(asc(siteBlocks.position));

  const out: CmsBlock[] = [];
  for (const row of rows) {
    /*
     * A block whose kind or shape the catalogue no longer knows is SKIPPED, not
     * rendered empty and not thrown on. Storage is the past and the catalogue is
     * the present: a block retired in a later release leaves its rows behind, and
     * a public page must still render the rest of itself.
     */
    const body = readBlockBody(row.kind, row.body);
    if (!body) continue;
    out.push({ id: row.id, kind: row.kind, position: row.position, body });
  }
  return out;
}

/**
 * One PUBLISHED page by slug, for the public route. Null for anything else.
 *
 * `published` is compared against 1 rather than for truthiness: it is a plain
 * integer on both dialects (see `db/schema.ts`), and comparing explicitly means a
 * NULL — which the column forbids but a hand-written row could still carry — reads
 * as unpublished. The safe direction for a public page.
 */
export async function readPublishedPage(
  db: Database,
  slug: string,
): Promise<CmsPage | null> {
  try {
    const rows = await db
      .select()
      .from(sitePages)
      .where(and(eq(sitePages.slug, slug), eq(sitePages.published, 1)))
      .limit(1);
    const page = rows[0];
    if (!page) return null;
    return {
      id: page.id,
      slug: page.slug,
      title: page.title,
      metaTitle: page.metaTitle ?? null,
      metaDescription: page.metaDescription ?? null,
      published: true,
      publishedAt: page.publishedAt ?? null,
      updatedByEmail: page.updatedByEmail ?? null,
      updatedAt: page.updatedAt,
      blocks: await blocksOf(db, page.id),
    };
  } catch (error) {
    // See the header: null becomes a 404, which is a better public answer than 500.
    console.error("[cms] could not read the published page", error);
    return null;
  }
}

/** Every page, drafts included, for the console. Newest change first. */
export async function listPages(db: Database): Promise<CmsPage[]> {
  try {
    const rows = await db.select().from(sitePages);
    const out: CmsPage[] = [];
    for (const page of rows) {
      out.push({
        id: page.id,
        slug: page.slug,
        title: page.title,
        metaTitle: page.metaTitle ?? null,
        metaDescription: page.metaDescription ?? null,
        published: page.published === 1,
        publishedAt: page.publishedAt ?? null,
        updatedByEmail: page.updatedByEmail ?? null,
        updatedAt: page.updatedAt,
        blocks: await blocksOf(db, page.id),
      });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  } catch (error) {
    console.error("[cms] could not list the pages", error);
    return [];
  }
}

export type PageInput = {
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  published: boolean;
  blocks: Array<{ kind: string; body: BlockBody }>;
};

/**
 * Create or replace one page and ALL of its blocks.
 *
 * REPLACE RATHER THAN DIFF, and that is a deliberate simplification with a stated
 * cost. The console sends the whole page, so the write is: upsert the row, delete
 * every block, insert the submitted ones. Diffing would preserve block ids across
 * an edit, which matters the day a block carries something a reader can link to —
 * an anchor, a comment thread. It carries nothing like that yet, and a diff that
 * has no consumer is a correctness risk with no payoff.
 *
 * `published_at` is set once, on the first publish, and never cleared. It records
 * when the page first went public, which is a fact about history; unpublishing does
 * not un-happen it.
 *
 * `from` is the address the page has NOW. When it differs from `input.slug` the
 * page MOVES: the same row takes the new address, and the old one stops resolving.
 * This used to look the page up by the new address only, so a slug edit created a
 * second page and left the first one published. The route has already refused a
 * move onto an address another page holds; `site_pages_slug_idx` is the backstop.
 */
export async function writePage(
  db: Database,
  input: PageInput,
  actorEmail: string,
  from: string = input.slug,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const now = new Date().toISOString();
  try {
    const existing = await db
      .select({ id: sitePages.id, publishedAt: sitePages.publishedAt })
      .from(sitePages)
      .where(eq(sitePages.slug, from))
      .limit(1);

    const id = existing[0]?.id ?? `pg_${crypto.randomUUID().replace(/-/g, "")}`;
    const publishedAt =
      existing[0]?.publishedAt ?? (input.published ? now : null);

    if (existing[0]) {
      await db
        .update(sitePages)
        .set({
          slug: input.slug,
          title: input.title,
          metaTitle: input.metaTitle,
          metaDescription: input.metaDescription,
          published: input.published ? 1 : 0,
          publishedAt,
          updatedByEmail: actorEmail,
          updatedAt: now,
        })
        .where(eq(sitePages.id, id));
    } else {
      await db.insert(sitePages).values({
        id,
        slug: input.slug,
        title: input.title,
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        published: input.published ? 1 : 0,
        publishedAt,
        updatedByEmail: actorEmail,
        createdAt: now,
        updatedAt: now,
      });
    }

    await db.delete(siteBlocks).where(eq(siteBlocks.pageId, id));
    let position = 0;
    for (const block of input.blocks) {
      await db.insert(siteBlocks).values({
        id: `bk_${crypto.randomUUID().replace(/-/g, "")}`,
        pageId: id,
        kind: block.kind,
        position,
        body: JSON.stringify(block.body),
        createdAt: now,
        updatedAt: now,
      });
      position += 1;
    }
    return { ok: true, id };
  } catch (error) {
    console.error("[cms] could not write the page", error);
    return { ok: false, reason: "That page could not be saved." };
  }
}

/**
 * Delete one page and its blocks.
 *
 * A REAL DELETE, not an archive, and the difference from the portal is the point.
 * A workspace's records go to a recycle bin because they are a customer's data and
 * a mistaken deletion costs them something irreplaceable. A marketing page is
 * MAINTSUPP's own copy, it is re-creatable by the person who wrote it, and a
 * published URL that is "archived" but still resolving would be worse than gone.
 *
 * Blocks go first, because they reference the page.
 */
export async function deletePage(
  db: Database,
  slug: string,
): Promise<{ ok: boolean }> {
  try {
    const rows = await db
      .select({ id: sitePages.id })
      .from(sitePages)
      .where(eq(sitePages.slug, slug))
      .limit(1);
    const id = rows[0]?.id;
    if (!id) return { ok: false };
    await db.delete(siteBlocks).where(eq(siteBlocks.pageId, id));
    await db.delete(sitePages).where(eq(sitePages.id, id));
    return { ok: true };
  } catch (error) {
    console.error("[cms] could not delete the page", error);
    return { ok: false };
  }
}
