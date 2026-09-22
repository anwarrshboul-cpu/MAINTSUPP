/**
 * The built-in pages' copy, read and written — decision L.
 *
 * The same four operations as `site-navigation-repository.ts`, against the same
 * shape of row, and deliberately written the same way: every function takes the
 * database it is given and none of them caches, so the editor and the version
 * history always see the truth. The PUBLIC read is cached, in
 * `site-content-public.ts`, and a save drops that cache on the instance that
 * took it.
 *
 * Dialect: plain drizzle, no raw SQL. `revision` is an INTEGER and every boolean
 * in the content (a hidden section) lives inside the JSON document, so nothing
 * here depends on `BOOLEAN_COLUMNS`. The conditional write is
 * `UPDATE … WHERE revision = ? RETURNING` and the first write
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` — the two shapes
 * `config-versions.ts` and `cms-repository.ts` already run on both databases.
 */

import { and, eq, sql } from "drizzle-orm";

import type { getDb } from "../../db";
import { siteContent } from "../../db/schema";
import { canonicalJson } from "./config-versions-model.ts";
import { EMPTY_SITE_CONTENT, normaliseSiteContent, type SiteContent } from "./site-content.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

/** The one row's key. */
export const CONTENT_ROW_ID = "public";

export type StoredContent = {
  /** False when no row exists: every page is exactly what it shipped as. */
  stored: boolean;
  content: SiteContent;
  revision: number | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

/** The overrides in force. Throws when the database cannot answer — the caller decides what that means. */
export async function readStoredContent(db: Database): Promise<StoredContent> {
  const [row] = await db.select().from(siteContent).where(eq(siteContent.id, CONTENT_ROW_ID)).limit(1);
  if (!row) {
    return { stored: false, content: EMPTY_SITE_CONTENT, revision: null, updatedAt: null, updatedByEmail: null };
  }
  return {
    stored: true,
    content: normaliseSiteContent(row.document),
    revision: Number(row.revision),
    updatedAt: row.updatedAt,
    updatedByEmail: row.updatedByEmail ?? null,
  };
}

/**
 * Store a VALIDATED document.
 *
 *   expectedRevision: number — the editor opened revision N, and the save lands
 *     only if the row is still at N (someone else's save in between → conflict);
 *   expectedRevision: null — the editor opened the shipped copy (no row), and the
 *     save lands only if nobody has created the row since;
 *   expectedRevision: undefined — unconditional (a restore, which names a version
 *     rather than a revision).
 */
export async function writeContent(
  db: Database,
  content: SiteContent,
  options: { expectedRevision?: number | null; actorEmail: string },
): Promise<{ ok: true; revision: number } | { ok: false; conflict: true }> {
  const document = canonicalJson(content);
  const now = new Date().toISOString();
  const actor = options.actorEmail.toLowerCase();

  const update = (revision: number | undefined) =>
    db
      .update(siteContent)
      .set({ document, revision: sql`${siteContent.revision} + 1`, updatedByEmail: actor, updatedAt: now })
      .where(
        revision === undefined
          ? eq(siteContent.id, CONTENT_ROW_ID)
          : and(eq(siteContent.id, CONTENT_ROW_ID), eq(siteContent.revision, revision)),
      )
      .returning({ revision: siteContent.revision });
  const insert = () =>
    db
      .insert(siteContent)
      .values({ id: CONTENT_ROW_ID, document, revision: 1, updatedByEmail: actor, updatedAt: now })
      .onConflictDoNothing()
      .returning({ revision: siteContent.revision });

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
 * Back to the shipped pages: the row goes, so `copy.ts` is in force again —
 * including any later change to it. What was there is kept in the version
 * history, so a reset is undone by restoring the version before it.
 */
export async function resetContent(db: Database): Promise<boolean> {
  const rows = await db.delete(siteContent).where(eq(siteContent.id, CONTENT_ROW_ID)).returning({ id: siteContent.id });
  return rows.length > 0;
}
