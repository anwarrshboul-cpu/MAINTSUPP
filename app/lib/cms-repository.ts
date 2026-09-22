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
import { siteBlocks, sitePages, siteRedirects } from "../../db/schema";
import { readBlockBody, type BlockBody } from "./cms-blocks.ts";
import { pageIsLive, pageState, resolveRedirect } from "./cms-seo.ts";

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
  /* The publishing window, indexing and canonical — see `app/lib/cms-seo.ts`. */
  publishAt: string | null;
  unpublishAt: string | null;
  robots: "index" | "noindex";
  canonicalUrl: string | null;
  /* Where the page stands NOW: draft, scheduled, live or ended. Read-time. */
  state: "draft" | "scheduled" | "live" | "ended";
  blocks: CmsBlock[];
};

type PageRow = typeof sitePages.$inferSelect;

/** One row as the product speaks of it, with its state decided at `now`. */
function toPage(page: PageRow, blocks: CmsBlock[], now = Date.now()): CmsPage {
  const published = page.published === 1;
  const span = { publishAt: page.publishAt ?? null, unpublishAt: page.unpublishAt ?? null };
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    metaTitle: page.metaTitle ?? null,
    metaDescription: page.metaDescription ?? null,
    published,
    publishedAt: page.publishedAt ?? null,
    updatedByEmail: page.updatedByEmail ?? null,
    updatedAt: page.updatedAt,
    ...span,
    robots: page.robots === "noindex" ? "noindex" : "index",
    canonicalUrl: page.canonicalUrl ?? null,
    state: pageState({ published, ...span }, now),
    blocks,
  };
}

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
  now: number = Date.now(),
): Promise<CmsPage | null> {
  try {
    const rows = await db
      .select()
      .from(sitePages)
      .where(and(eq(sitePages.slug, slug), eq(sitePages.published, 1)))
      .limit(1);
    const page = rows[0];
    if (!page) return null;
    /* Published is not enough: the page must be inside its publishing window
       NOW. Outside it, it is the same "not here" as a draft. */
    const read = toPage(page, [], now);
    if (!pageIsLive(read, now)) return null;
    return { ...read, blocks: await blocksOf(db, page.id) };
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
    const now = Date.now();
    const out: CmsPage[] = [];
    for (const page of rows) {
      out.push(toPage(page, await blocksOf(db, page.id), now));
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
  /* Optional, so a restore of a version recorded before these existed still
     writes: absent means no window, indexed, and the page's own address. */
  publishAt?: string | null;
  unpublishAt?: string | null;
  robots?: "index" | "noindex";
  canonicalUrl?: string | null;
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
          ...lifecycleColumns(input),
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
        ...lifecycleColumns(input),
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

function lifecycleColumns(input: PageInput) {
  return {
    publishAt: input.publishAt ?? null,
    unpublishAt: input.unpublishAt ?? null,
    robots: input.robots === "noindex" ? "noindex" : "index",
    canonicalUrl: input.canonicalUrl ?? null,
  };
}

/**
 * ANY page by slug, draft or scheduled included — for a platform-staff
 * PREVIEW only. The public route never calls this without that check.
 */
export async function readPageForPreview(
  db: Database,
  slug: string,
  /* The instant its `state` is judged at — taken, like `readPublishedPage`'s,
     so a caller (and a test) can name it. The page itself passes nothing. */
  now = Date.now(),
): Promise<CmsPage | null> {
  try {
    const rows = await db.select().from(sitePages).where(eq(sitePages.slug, slug)).limit(1);
    const page = rows[0];
    return page ? toPage(page, await blocksOf(db, page.id), now) : null;
  } catch (error) {
    console.error("[cms] could not read the page for preview", error);
    return null;
  }
}

/**
 * Every page without its blocks — what `/sitemap-pages.xml` needs, and no
 * more. A failed read is an empty list: the sitemap then lists no CMS pages,
 * which a crawler reads as "nothing new", never as "these pages are gone".
 */
export async function listPagesForSitemap(db: Database): Promise<CmsPage[]> {
  try {
    const now = Date.now();
    return (await db.select().from(sitePages)).map((page) => toPage(page, [], now));
  } catch (error) {
    console.error("[cms] could not list the pages for the sitemap", error);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

export type CmsRedirect = {
  from: string;
  to: string;
  kind: "moved" | "manual";
  createdByEmail: string | null;
  createdAt: string;
};

/** Every redirect, newest first. The table holds a handful of rows. */
export async function listRedirects(db: Database): Promise<CmsRedirect[]> {
  try {
    const rows = await db.select().from(siteRedirects);
    return rows
      .map((row) => ({
        from: row.fromPath,
        to: row.toTarget,
        kind: row.kind === "moved" ? ("moved" as const) : ("manual" as const),
        createdByEmail: row.createdByEmail ?? null,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch (error) {
    console.error("[cms] could not list the redirects", error);
    return [];
  }
}

/** The redirects as a lookup, for `resolveRedirect` / `planRedirect`. */
export async function redirectMap(db: Database): Promise<Map<string, string>> {
  return new Map((await listRedirects(db)).map((row) => [row.from, row.to]));
}

/**
 * Where an old CMS address leads now, or null. A failed read is "no redirect":
 * the route then answers 404, as it would for any address that is not a page.
 */
export async function redirectTargetFor(db: Database, slug: string): Promise<string | null> {
  try {
    return resolveRedirect(await redirectMap(db), `/p/${slug}`);
  } catch (error) {
    console.error("[cms] could not resolve a redirect", error);
    return null;
  }
}

/**
 * Store `from → target` (the caller has already planned and collapsed it),
 * replacing any redirect from the same address, and re-point every redirect
 * that led TO `from` so no chain is left behind.
 */
export async function saveRedirect(
  db: Database,
  from: string,
  target: string,
  kind: "moved" | "manual",
  actorEmail: string,
): Promise<void> {
  await db.delete(siteRedirects).where(eq(siteRedirects.fromPath, from));
  await db.insert(siteRedirects).values({
    id: `rd_${crypto.randomUUID().replace(/-/g, "")}`,
    fromPath: from,
    toTarget: target,
    kind,
    createdByEmail: actorEmail,
    createdAt: new Date().toISOString(),
  });
  await db.update(siteRedirects).set({ toTarget: target }).where(eq(siteRedirects.toTarget, from));
}

/** Remove the redirect from one address. True when there was one. */
export async function deleteRedirect(db: Database, from: string): Promise<boolean> {
  const rows = await db
    .delete(siteRedirects)
    .where(eq(siteRedirects.fromPath, from))
    .returning({ id: siteRedirects.id });
  return rows.length > 0;
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
