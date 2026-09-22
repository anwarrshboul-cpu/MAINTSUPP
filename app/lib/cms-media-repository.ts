/**
 * The website media library's rows — decision K. Every function takes the
 * database it is given; none caches. The bytes are the route's business; this
 * file never touches storage.
 *
 * Dialect: plain drizzle and no raw SQL. `status` is TEXT, `byte_size` BIGINT,
 * and no column here is in BOOLEAN_COLUMNS.
 */

import { and, asc, desc, eq, inArray, max } from "drizzle-orm";

import type { getDb } from "../../db";
import { cmsMedia, cmsMediaVersions, siteBlocks, sitePages } from "../../db/schema";
import { mediaIdsIn, mediaUrl, type MediaKind } from "./cms-media.ts";
import { pageState } from "./cms-seo.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

export type MediaVersion = {
  id: string;
  versionNo: number;
  objectKey: string;
  url: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** The web-sized rendition, when the browser made one. */
  display: { url: string; width: number | null; height: number | null } | null;
  uploadedByEmail: string | null;
  createdAt: string;
};

export type MediaItem = {
  id: string;
  kind: MediaKind;
  title: string;
  altText: string | null;
  status: "active" | "archived";
  current: MediaVersion | null;
  versionCount: number;
  createdByEmail: string | null;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string;
};

export type MediaUsage = { slug: string; title: string; state: "draft" | "scheduled" | "live" | "ended" };

type VersionRow = typeof cmsMediaVersions.$inferSelect;
type MediaRow = typeof cmsMedia.$inferSelect;

const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function toVersion(row: VersionRow): MediaVersion {
  return {
    id: row.id,
    versionNo: Number(row.versionNo),
    objectKey: row.objectKey,
    url: mediaUrl(row.objectKey),
    originalName: row.originalName,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationMs: numberOrNull(row.durationMs),
    display: row.displayKey
      ? { url: mediaUrl(row.displayKey), width: numberOrNull(row.displayWidth), height: numberOrNull(row.displayHeight) }
      : null,
    uploadedByEmail: row.uploadedByEmail ?? null,
    createdAt: row.createdAt,
  };
}

function toItem(row: MediaRow, current: VersionRow | null, versionCount: number): MediaItem {
  return {
    id: row.id,
    kind: (row.kind === "video" || row.kind === "document" ? row.kind : "image") as MediaKind,
    title: row.title,
    altText: row.altText ?? null,
    status: row.status === "archived" ? "archived" : "active",
    current: current ? toVersion(current) : null,
    versionCount,
    createdByEmail: row.createdByEmail ?? null,
    createdAt: row.createdAt,
    updatedByEmail: row.updatedByEmail ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Every asset with its current file, newest change first. A library holds hundreds, not millions. */
export async function listMedia(db: Database): Promise<MediaItem[]> {
  const rows = await db.select().from(cmsMedia).orderBy(desc(cmsMedia.updatedAt));
  if (!rows.length) return [];
  const versions = await db.select().from(cmsMediaVersions).where(inArray(cmsMediaVersions.mediaId, rows.map((row) => row.id)));
  const byId = new Map(versions.map((version) => [version.id, version]));
  const counts = new Map<string, number>();
  for (const version of versions) counts.set(version.mediaId, (counts.get(version.mediaId) ?? 0) + 1);
  /* Only media whose current file exists: an asset whose first upload never
     completed has no current version and is not in the library at all. */
  return rows
    .filter((row) => row.currentVersionId && byId.has(row.currentVersionId))
    .map((row) => toItem(row, byId.get(row.currentVersionId as string) ?? null, counts.get(row.id) ?? 0));
}

/** One asset and every file it has had, newest first. */
export async function readMedia(db: Database, id: string): Promise<{ item: MediaItem; versions: MediaVersion[] } | null> {
  const [row] = await db.select().from(cmsMedia).where(eq(cmsMedia.id, id)).limit(1);
  if (!row) return null;
  const versions = await db
    .select()
    .from(cmsMediaVersions)
    .where(eq(cmsMediaVersions.mediaId, id))
    .orderBy(desc(cmsMediaVersions.versionNo));
  const current = versions.find((version) => version.id === row.currentVersionId) ?? null;
  return { item: toItem(row, current, versions.length), versions: versions.map(toVersion) };
}

/** The asset row for a first upload, before its first version exists. */
export async function createMedia(
  db: Database,
  values: { id: string; kind: MediaKind; title: string; altText: string | null; actorEmail: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(cmsMedia).values({
    id: values.id,
    kind: values.kind,
    title: values.title,
    altText: values.altText,
    currentVersionId: null,
    status: "active",
    createdByEmail: values.actorEmail,
    createdAt: now,
    updatedByEmail: values.actorEmail,
    updatedAt: now,
  });
}

/** The number the next version of an asset takes. */
export async function nextVersionNo(db: Database, mediaId: string): Promise<number> {
  const [row] = await db
    .select({ top: max(cmsMediaVersions.versionNo) })
    .from(cmsMediaVersions)
    .where(eq(cmsMediaVersions.mediaId, mediaId));
  return Number(row?.top ?? 0) + 1;
}

/** A new file for an asset, and — in the same breath — the asset now shows it. */
export async function addVersionAndMakeCurrent(
  db: Database,
  version: Omit<VersionRow, "createdAt"> & { createdAt?: string },
  actorEmail: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(cmsMediaVersions).values({ ...version, createdAt: version.createdAt ?? now });
  await db
    .update(cmsMedia)
    .set({ currentVersionId: version.id, updatedByEmail: actorEmail, updatedAt: now })
    .where(eq(cmsMedia.id, version.mediaId));
}

/** The rendition a browser made for a version, once it has been stored and checked. */
export async function setDisplayRendition(
  db: Database,
  versionId: string,
  rendition: { key: string; width: number | null; height: number | null },
): Promise<void> {
  await db
    .update(cmsMediaVersions)
    .set({ displayKey: rendition.key, displayWidth: rendition.width, displayHeight: rendition.height })
    .where(eq(cmsMediaVersions.id, versionId));
}

export async function readVersion(db: Database, versionId: string): Promise<VersionRow | null> {
  const [row] = await db.select().from(cmsMediaVersions).where(eq(cmsMediaVersions.id, versionId)).limit(1);
  return row ?? null;
}

export async function updateMediaMeta(
  db: Database,
  id: string,
  changes: { title?: string; altText?: string | null; status?: "active" | "archived"; currentVersionId?: string },
  actorEmail: string,
): Promise<void> {
  await db
    .update(cmsMedia)
    .set({ ...changes, updatedByEmail: actorEmail, updatedAt: new Date().toISOString() })
    .where(eq(cmsMedia.id, id));
}

/** Every key an asset has ever stored — originals and renditions — for a delete. */
export async function keysOfMedia(db: Database, id: string): Promise<string[]> {
  const versions = await db
    .select({ objectKey: cmsMediaVersions.objectKey, displayKey: cmsMediaVersions.displayKey })
    .from(cmsMediaVersions)
    .where(eq(cmsMediaVersions.mediaId, id))
    .orderBy(asc(cmsMediaVersions.versionNo));
  return versions.flatMap((version) => [version.objectKey, ...(version.displayKey ? [version.displayKey] : [])]);
}

/** The rows of an asset, versions first (they reference it). */
export async function deleteMediaRows(db: Database, id: string): Promise<boolean> {
  await db.delete(cmsMediaVersions).where(eq(cmsMediaVersions.mediaId, id));
  const rows = await db.delete(cmsMedia).where(eq(cmsMedia.id, id)).returning({ id: cmsMedia.id });
  return rows.length > 0;
}

/**
 * WHERE EACH ASSET IS USED — every website page, live or draft, whose blocks
 * name it. What a delete is refused on and what the library shows beside each
 * asset. Read from the blocks themselves (`mediaIdsIn`), so a new block kind
 * that carries a `mediaId` is counted without a change here.
 */
export async function mediaUsage(db: Database, now = Date.now()): Promise<Map<string, MediaUsage[]>> {
  const rows = await db
    .select({
      pageId: siteBlocks.pageId,
      body: siteBlocks.body,
      slug: sitePages.slug,
      title: sitePages.title,
      published: sitePages.published,
      publishAt: sitePages.publishAt,
      unpublishAt: sitePages.unpublishAt,
    })
    .from(siteBlocks)
    .innerJoin(sitePages, eq(siteBlocks.pageId, sitePages.id));
  const usage = new Map<string, Map<string, MediaUsage>>();
  for (const row of rows) {
    for (const id of mediaIdsIn(row.body)) {
      const pages = usage.get(id) ?? new Map<string, MediaUsage>();
      pages.set(row.slug, {
        slug: row.slug,
        title: row.title,
        state: pageState(
          { published: Number(row.published) === 1, publishAt: row.publishAt ?? null, unpublishAt: row.unpublishAt ?? null },
          now,
        ),
      });
      usage.set(id, pages);
    }
  }
  return new Map([...usage].map(([id, pages]) => [id, [...pages.values()]]));
}

/** What a public page needs to draw an asset. */
export type RenderableMedia = {
  id: string;
  kind: MediaKind;
  title: string;
  alt: string | null;
  src: string;
  contentType: string;
  width: number | null;
  height: number | null;
};

/**
 * The assets a page's blocks name, as the page will draw them — archived ones
 * included (archiving never breaks a page), deleted ones absent (the block then
 * draws nothing rather than a broken image). Images prefer their web-sized
 * rendition.
 */
export async function resolveMediaForRender(db: Database, ids: readonly string[]): Promise<Map<string, RenderableMedia>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const media = await db.select().from(cmsMedia).where(inArray(cmsMedia.id, wanted));
  const currentIds = media.map((row) => row.currentVersionId).filter((id): id is string => Boolean(id));
  const versions = currentIds.length
    ? await db.select().from(cmsMediaVersions).where(inArray(cmsMediaVersions.id, currentIds))
    : [];
  const byId = new Map(versions.map((version) => [version.id, version]));
  const out = new Map<string, RenderableMedia>();
  for (const row of media) {
    const version = row.currentVersionId ? byId.get(row.currentVersionId) : undefined;
    if (!version) continue;
    const display = row.kind === "image" && version.displayKey;
    out.set(row.id, {
      id: row.id,
      kind: row.kind as MediaKind,
      title: row.title,
      alt: row.altText ?? null,
      src: mediaUrl(display ? (version.displayKey as string) : version.objectKey),
      contentType: display ? "image/webp" : version.contentType,
      width: numberOrNull(display ? version.displayWidth : version.width) ?? numberOrNull(version.width),
      height: numberOrNull(display ? version.displayHeight : version.height) ?? numberOrNull(version.height),
    });
  }
  return out;
}

/** The kind and state of the assets a page save names — to refuse a missing one. */
export async function mediaKinds(db: Database, ids: readonly string[]): Promise<Map<string, { kind: MediaKind; hasFile: boolean; altText: string | null }>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: cmsMedia.id, kind: cmsMedia.kind, currentVersionId: cmsMedia.currentVersionId, altText: cmsMedia.altText })
    .from(cmsMedia)
    .where(and(inArray(cmsMedia.id, wanted)));
  return new Map(
    rows.map((row) => [row.id, { kind: row.kind as MediaKind, hasFile: Boolean(row.currentVersionId), altText: row.altText ?? null }]),
  );
}
