/**
 * The website media library — decision K (§77 item 12).
 *
 * WHO: MAINTSUPP platform staff with a real session, as for every website
 * surface. GET is gated too: the library lists files no page has published yet.
 * Uploading is `./upload/route.ts`; reading a file is the public `/media/...`
 * route. Nothing here gives a workspace role anything.
 *
 *   GET                 the library: every asset, where each is used, the storage state
 *   GET ?id=            one asset, every file it has had, and where it is used
 *   PATCH {id, title?, altText?, status?, currentVersion?}
 *                       rename, describe, archive / unarchive, or put an earlier file back
 *   DELETE ?id=         permanently — refused while any website page uses it
 *
 * DELETE IS REAL AND GUARDED. An asset a page uses — live OR draft — is refused
 * with the pages named, so a published page can never lose an image to a tidy-up
 * (archive it instead: archived assets keep working where they are used). An
 * unused asset is deleted for good: every file it ever had is removed from the
 * bucket FIRST, and its rows only once that succeeded, so a delete that could not
 * reach storage leaves the asset intact rather than orphaning its bytes.
 */

import { ensureDatabase } from "../../../db/init";
import { auditActor, recordAudit } from "../../lib/audit";
import { CMS_MEDIA_ACCEPT, MEDIA_OMISSIONS, MEDIA_RULES, cleanMediaMeta, isMediaId, isVersionId } from "../../lib/cms-media.ts";
import {
  deleteMediaRows,
  keysOfMedia,
  listMedia,
  mediaUsage,
  readMedia,
  updateMediaMeta,
} from "../../lib/cms-media-repository.ts";
import { cmsBucket, mediaStorageStatus } from "../../lib/cms-media-storage.ts";
import { MAX_STANDARD_FILE_SIZE, MAX_VIDEO_FILE_SIZE } from "../../lib/upload-policy.ts";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

function forbidden() {
  return Response.json({ error: "The website is administered by MAINTSUPP platform staff." }, { status: 403 });
}

function unavailable(error: unknown) {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[/api/cms-media]", error instanceof Error ? error.message.slice(0, 300) : "error");
  return Response.json({ error: "The media library is temporarily unavailable." }, { status: 503 });
}

async function platformScope(request: Request) {
  const scope = await scopedDb(request);
  if (scope.platformAdmin !== true) return null;
  if (!scope.authenticated) return null;
  return scope;
}

type Scope = NonNullable<Awaited<ReturnType<typeof platformScope>>>;

async function libraryPayload(scope: Scope) {
  const [items, usage, storage] = await Promise.all([
    listMedia(scope.db),
    mediaUsage(scope.db),
    cmsBucket().then(mediaStorageStatus),
  ]);
  return {
    canEdit: true,
    items: items.map((item) => ({ ...item, usage: usage.get(item.id) ?? [] })),
    storage,
    accept: CMS_MEDIA_ACCEPT,
    rules: { ...MEDIA_RULES, maxVideoBytes: MAX_VIDEO_FILE_SIZE, maxFileBytes: MAX_STANDARD_FILE_SIZE },
    omissions: MEDIA_OMISSIONS,
  };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    const id = new URL(request.url).searchParams.get("id");
    if (id !== null) {
      if (!isMediaId(id)) return Response.json({ error: "Name an asset." }, { status: 400 });
      const found = await readMedia(scope.db, id);
      if (!found) return Response.json({ error: "There is no such asset." }, { status: 404 });
      const usage = (await mediaUsage(scope.db)).get(id) ?? [];
      return Response.json({ ...found, usage });
    }
    return Response.json(await libraryPayload(scope));
  } catch (error) {
    return unavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || !isMediaId(payload.id)) {
      return Response.json({ error: "Name the asset to change." }, { status: 400 });
    }
    const found = await readMedia(scope.db, payload.id);
    if (!found) return Response.json({ error: "There is no such asset." }, { status: 404 });

    const meta = cleanMediaMeta({
      ...("title" in payload ? { title: payload.title } : {}),
      ...("altText" in payload ? { altText: payload.altText } : {}),
    });
    if (!meta.ok) return Response.json({ error: meta.reason }, { status: 400 });
    const changes: { title?: string; altText?: string | null; status?: "active" | "archived"; currentVersionId?: string } = {};
    if (meta.title !== undefined) changes.title = meta.title;
    if (meta.altText !== undefined) changes.altText = meta.altText;
    if ("status" in payload) {
      if (payload.status !== "active" && payload.status !== "archived") {
        return Response.json({ error: "status is active or archived." }, { status: 400 });
      }
      changes.status = payload.status;
    }
    /* PUTTING AN EARLIER FILE BACK — the undo of a replacement. The file is one
       this asset already had; nothing is uploaded and nothing is removed. */
    if ("currentVersion" in payload) {
      const version = found.versions.find((entry) => entry.id === payload.currentVersion);
      if (!isVersionId(payload.currentVersion) || !version) {
        return Response.json({ error: "That file is not one of this asset's versions." }, { status: 400 });
      }
      changes.currentVersionId = version.id;
    }
    if (!Object.keys(changes).length) return Response.json({ error: "Nothing to change." }, { status: 400 });

    const actorEmail = scope.identityEmail.toLowerCase();
    await updateMediaMeta(scope.db, found.item.id, changes, actorEmail);
    const said: string[] = [];
    if (changes.title !== undefined && changes.title !== found.item.title) said.push(`renamed it "${changes.title}"`);
    if (changes.altText !== undefined && changes.altText !== found.item.altText) said.push(changes.altText ? "changed its alt text" : "removed its alt text");
    if (changes.status && changes.status !== found.item.status) said.push(changes.status === "archived" ? "archived it" : "restored it from the archive");
    if (changes.currentVersionId && changes.currentVersionId !== found.item.current?.id) {
      said.push(`made version ${found.versions.find((entry) => entry.id === changes.currentVersionId)?.versionNo} current again`);
    }
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: changes.status === "archived" ? "cms_media.archived" : changes.currentVersionId ? "cms_media.version_restored" : "cms_media.updated",
      entityType: "cms_media",
      entityId: found.item.id,
      summary: `Website media "${found.item.title}": ${said.length ? said.join(", ") : "saved with no change"}.`,
      detail: { mediaId: found.item.id, ...changes },
      request,
    });
    const saved = await readMedia(scope.db, found.item.id);
    return Response.json({ ...saved, usage: (await mediaUsage(scope.db)).get(found.item.id) ?? [] });
  } catch (error) {
    return unavailable(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const scope = await platformScope(request);
    if (!scope) return forbidden();
    const id = new URL(request.url).searchParams.get("id");
    if (!isMediaId(id)) return Response.json({ error: "Name the asset to delete." }, { status: 400 });
    const found = await readMedia(scope.db, id);
    if (!found) return Response.json({ error: "There is no such asset." }, { status: 404 });

    const used = (await mediaUsage(scope.db)).get(id) ?? [];
    if (used.length) {
      return Response.json(
        {
          error: `"${found.item.title}" is used on ${used.length} website page${used.length === 1 ? "" : "s"} (${used
            .map((page) => `/p/${page.slug}${page.state === "live" ? "" : `, ${page.state}`}`)
            .join("; ")}). Remove it from ${used.length === 1 ? "that page" : "those pages"} first, or archive it instead.`,
          usage: used,
        },
        { status: 409 },
      );
    }

    const storage = await cmsBucket();
    const keys = await keysOfMedia(scope.db, id);
    if (keys.length) {
      if (!storage) return Response.json({ error: "Website media storage is not configured, so the files cannot be removed." }, { status: 503 });
      /* Bytes first; rows only once storage has let them go. */
      await storage.delete(keys);
    }
    await deleteMediaRows(scope.db, id);
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "cms_media.deleted",
      entityType: "cms_media",
      entityId: id,
      summary: `Deleted the website media "${found.item.title}" and its ${keys.length} stored file${keys.length === 1 ? "" : "s"}. This is permanent.`,
      detail: { mediaId: id, files: keys.length, versions: found.versions.length },
      request,
    });
    return Response.json(await libraryPayload(scope));
  } catch (error) {
    return unavailable(error);
  }
}
