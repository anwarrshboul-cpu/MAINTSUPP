/**
 * The public navigation's one row, read and written — decision J.
 *
 * Every function here takes the database it is given; none of them caches.
 * The editor and the version history read through here and always see the
 * truth. The PUBLIC read is cached, in `site-navigation-public.ts`, and a save
 * through the API drops that cache on the instance that made it.
 *
 * Dialect: plain drizzle, no raw SQL. `revision` is an INTEGER and there is no
 * boolean column (a link's `hidden` lives inside the JSON document), so nothing
 * here depends on `BOOLEAN_COLUMNS`. The conditional write uses
 * `UPDATE … WHERE revision = ? RETURNING`, and the first write
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` — the same two shapes
 * `config-versions.ts` and `cms-repository.ts` already run on both databases.
 */

import { and, eq, sql } from "drizzle-orm";

import type { getDb } from "../../db";
import { siteNavigation, sitePages } from "../../db/schema";
import { canonicalJson } from "./config-versions-model.ts";
import { defaultNavigation, normaliseNavigation, type SiteNavigation } from "./site-navigation.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

/** The one row's key. */
export const NAVIGATION_ROW_ID = "public";

export type StoredNavigation = {
  /** False when no row exists: the navigation is the built-in one. */
  stored: boolean;
  navigation: SiteNavigation;
  /** The row's revision, or null when there is no row. */
  revision: number | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

/** The navigation in force. Throws when the database cannot answer — the caller decides what that means. */
export async function readStoredNavigation(db: Database): Promise<StoredNavigation> {
  const [row] = await db
    .select()
    .from(siteNavigation)
    .where(eq(siteNavigation.id, NAVIGATION_ROW_ID))
    .limit(1);
  if (!row) {
    return { stored: false, navigation: defaultNavigation(), revision: null, updatedAt: null, updatedByEmail: null };
  }
  return {
    stored: true,
    navigation: normaliseNavigation(row.document),
    revision: Number(row.revision),
    updatedAt: row.updatedAt,
    updatedByEmail: row.updatedByEmail ?? null,
  };
}

/**
 * Store a VALIDATED navigation.
 *
 *   expectedRevision: number — the editor opened revision N; the save lands
 *     only if the row is still at N (someone else's save in between → conflict);
 *   expectedRevision: null — the editor opened the built-in navigation (no
 *     row); the save lands only if nobody has created the row since;
 *   expectedRevision: undefined — unconditional (a restore, which names a
 *     version rather than a revision).
 */
export async function writeNavigation(
  db: Database,
  navigation: SiteNavigation,
  options: { expectedRevision?: number | null; actorEmail: string },
): Promise<{ ok: true; revision: number } | { ok: false; conflict: true }> {
  const document = canonicalJson(navigation);
  const now = new Date().toISOString();
  const actor = options.actorEmail.toLowerCase();

  const update = (revision: number | undefined) =>
    db
      .update(siteNavigation)
      .set({ document, revision: sql`${siteNavigation.revision} + 1`, updatedByEmail: actor, updatedAt: now })
      .where(
        revision === undefined
          ? eq(siteNavigation.id, NAVIGATION_ROW_ID)
          : and(eq(siteNavigation.id, NAVIGATION_ROW_ID), eq(siteNavigation.revision, revision)),
      )
      .returning({ revision: siteNavigation.revision });
  const insert = () =>
    db
      .insert(siteNavigation)
      .values({ id: NAVIGATION_ROW_ID, document, revision: 1, updatedByEmail: actor, updatedAt: now })
      .onConflictDoNothing()
      .returning({ revision: siteNavigation.revision });

  if (typeof options.expectedRevision === "number") {
    const [row] = await update(options.expectedRevision);
    return row ? { ok: true, revision: Number(row.revision) } : { ok: false, conflict: true };
  }
  if (options.expectedRevision === null) {
    const [row] = await insert();
    return row ? { ok: true, revision: Number(row.revision) } : { ok: false, conflict: true };
  }
  const [updated] = await update(undefined);
  if (updated) return { ok: true, revision: Number(updated.revision) };
  const [inserted] = await insert();
  if (inserted) return { ok: true, revision: Number(inserted.revision) };
  /* Created by someone else between the two statements: write over it once. */
  const [retried] = await update(undefined);
  return retried ? { ok: true, revision: Number(retried.revision) } : { ok: false, conflict: true };
}

/**
 * Back to the built-in navigation: the row goes, so the code's navigation is in
 * force again — including any later change to it. The state before is kept in
 * the version history, so a reset is undone by restoring the version before it.
 */
export async function resetNavigation(db: Database): Promise<boolean> {
  const rows = await db
    .delete(siteNavigation)
    .where(eq(siteNavigation.id, NAVIGATION_ROW_ID))
    .returning({ id: siteNavigation.id });
  return rows.length > 0;
}

export type CmsPageWindow = {
  slug: string;
  published: boolean;
  publishAt: string | null;
  unpublishAt: string | null;
};

/**
 * Every website page's slug and publishing state — what the public render needs
 * to leave out a link to a page that is not live. No titles, no bodies.
 */
export async function cmsPageWindows(db: Database): Promise<CmsPageWindow[]> {
  const rows = await db
    .select({
      slug: sitePages.slug,
      published: sitePages.published,
      publishAt: sitePages.publishAt,
      unpublishAt: sitePages.unpublishAt,
    })
    .from(sitePages);
  return rows.map((row) => ({
    slug: row.slug,
    /* Compared with 1, not for truthiness — see `readPublishedPage`. */
    published: Number(row.published) === 1,
    publishAt: row.publishAt ?? null,
    unpublishAt: row.unpublishAt ?? null,
  }));
}
